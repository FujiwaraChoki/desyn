import { v } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
  query,
} from "../_generated/server";
import { enqueueEmail } from "../emails/queue";
import { writeAudit } from "../lib/audit";
import { ensureBalance } from "../lib/credits";
import { planForProfile } from "../lib/entitlements";
import { appUrl, edition, env, isHosted } from "../lib/env";
import { errors } from "../lib/errors";
import { getProfile, requireUser } from "../lib/guards";
import { createLogger } from "../lib/logger";
import { PLANS, type PlanId } from "../lib/plans";
import { capture } from "../lib/posthog";
import { subscriptionStatusValidator } from "../lib/validators";
import { grantsPro, type NormalizedSubscription } from "./normalize";

export function billingAvailable(): boolean {
  return isHosted() && env.has("STRIPE_SECRET_KEY");
}

/** Billing state for the settings UI. Self-host returns `{ enabled: false }` and the UI hides billing. */
export const status = query({
  args: {},
  handler: async (ctx) => {
    const user = await requireUser(ctx);
    const plan = planForProfile(user.profile);
    const base = {
      edition: edition(),
      plan,
      planName: PLANS[plan].name,
      overridden: Boolean(user.profile?.planOverride),
    };
    if (!isHosted()) return { ...base, enabled: false as const };
    const subscription = await currentSubscription(ctx, user.userId);
    return {
      ...base,
      enabled: billingAvailable(),
      prices: {
        monthly: { amount: PLANS.pro.priceMonthly, available: env.has("STRIPE_PRICE_PRO_MONTHLY") },
        yearly: {
          amount: PLANS.pro.priceYearly ?? null,
          available: env.has("STRIPE_PRICE_PRO_YEARLY"),
        },
      },
      hasCustomer: Boolean(user.profile?.stripeCustomerId),
      subscription: subscription
        ? {
            status: subscription.status,
            interval: subscription.interval ?? null,
            currentPeriodEnd: subscription.currentPeriodEnd ?? null,
            cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
            canceledAt: subscription.canceledAt ?? null,
          }
        : null,
    };
  },
});

async function currentSubscription(
  ctx: QueryCtx | MutationCtx,
  userId: string,
): Promise<Doc<"subscriptions"> | null> {
  const subs = await ctx.db
    .query("subscriptions")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .collect();
  if (subs.length === 0) return null;
  // Prefer a subscription that grants Pro, then the most recently updated.
  subs.sort(
    (a, b) =>
      Number(grantsPro(b.status)) - Number(grantsPro(a.status)) || b.updatedAt - a.updatedAt,
  );
  return subs[0] ?? null;
}

/** Context for creating a Checkout/Portal session. Called from actions (identity is forwarded). */
export const checkoutContext = internalQuery({
  args: {},
  handler: async (ctx) => {
    const user = await requireUser(ctx, { verified: true });
    const subscription = await currentSubscription(ctx, user.userId);
    return {
      userId: user.userId,
      email: user.email,
      name: user.name,
      stripeCustomerId: user.profile?.stripeCustomerId ?? null,
      hasActiveSubscription: subscription ? grantsPro(subscription.status) : false,
    };
  },
});

/** Store the Stripe customer id on the profile (first writer wins). Returns the id to use. */
export const linkCustomer = internalMutation({
  args: { userId: v.string(), customerId: v.string() },
  handler: async (ctx, args): Promise<string> => {
    const profile = await getProfile(ctx, args.userId);
    if (!profile) throw errors.notFound("Profile");
    if (profile.stripeCustomerId) return profile.stripeCustomerId;
    await ctx.db.patch("profiles", profile._id, {
      stripeCustomerId: args.customerId,
      updatedAt: Date.now(),
    });
    return args.customerId;
  },
});

export const recordCheckoutStarted = internalMutation({
  args: { userId: v.string(), interval: v.union(v.literal("month"), v.literal("year")) },
  handler: async (ctx, args) => {
    await writeAudit(ctx, {
      action: "billing.checkoutStarted",
      actorId: args.userId,
      data: { interval: args.interval },
    });
  },
});

async function findProfileForSubscription(ctx: MutationCtx, sub: NormalizedSubscription) {
  if (sub.userId) {
    const byId = await getProfile(ctx, sub.userId);
    if (byId) return byId;
  }
  return await ctx.db
    .query("profiles")
    .withIndex("by_stripeCustomerId", (q) => q.eq("stripeCustomerId", sub.customerId))
    .first();
}

/** Billing-derived plan from all of the user's subscriptions. */
async function derivedPlan(ctx: MutationCtx, userId: string): Promise<PlanId> {
  const subs = await ctx.db
    .query("subscriptions")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .collect();
  return subs.some((s) => grantsPro(s.status)) ? "pro" : "free";
}

/**
 * Whether an incoming subscription state is older than the stored one. Stripe `created` has
 * one-second resolution and delivery order is not guaranteed, so `customer.subscription.created`
 * (status `incomplete`) and the `updated` event that activates it often share a timestamp. On a
 * tie, a subscription never goes back to `incomplete` from a state it can only reach afterwards.
 */
export function isStaleUpdate(
  existing: Pick<Doc<"subscriptions">, "lastEventCreated" | "status">,
  incoming: NormalizedSubscription["status"],
  eventCreated: number,
): boolean {
  if (existing.lastEventCreated > eventCreated) return true;
  if (existing.lastEventCreated < eventCreated) return false;
  return incoming === "incomplete" && existing.status !== "incomplete";
}

/**
 * Upsert a subscription mirror and recompute the user's plan. Ignores updates older than the last
 * applied event for that subscription (Stripe does not guarantee delivery order).
 */
export async function applySubscriptionChange(
  ctx: MutationCtx,
  sub: NormalizedSubscription,
  eventCreated: number,
  eventId: string,
): Promise<"applied" | "stale" | "unknown_customer"> {
  const profile = await findProfileForSubscription(ctx, sub);
  if (!profile) return "unknown_customer";
  const now = Date.now();
  const existing = await ctx.db
    .query("subscriptions")
    .withIndex("by_subscriptionId", (q) => q.eq("stripeSubscriptionId", sub.id))
    .unique();
  if (existing && isStaleUpdate(existing, sub.status, eventCreated)) return "stale";
  const fields = {
    userId: profile.userId,
    stripeCustomerId: sub.customerId,
    stripeSubscriptionId: sub.id,
    status: sub.status,
    priceId: sub.priceId,
    interval: sub.interval,
    currentPeriodStart: sub.currentPeriodStart,
    currentPeriodEnd: sub.currentPeriodEnd,
    cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
    canceledAt: sub.canceledAt,
    lastEventCreated: eventCreated,
    updatedAt: now,
  };
  if (existing) await ctx.db.replace("subscriptions", existing._id, fields);
  else await ctx.db.insert("subscriptions", fields);

  if (!profile.stripeCustomerId) {
    await ctx.db.patch("profiles", profile._id, {
      stripeCustomerId: sub.customerId,
      updatedAt: now,
    });
  }
  const nextPlan = await derivedPlan(ctx, profile.userId);
  if (nextPlan !== profile.plan) {
    const previous = profile.plan;
    await ctx.db.patch("profiles", profile._id, { plan: nextPlan, updatedAt: now });
    await ensureBalance(ctx, profile.userId);
    await writeAudit(ctx, {
      action: "billing.planChanged",
      actorId: profile.userId,
      targetType: "user",
      targetId: profile.userId,
      data: { from: previous, to: nextPlan, subscription: sub.id, status: sub.status },
    });
    await enqueueEmail(ctx, {
      to: profile.email,
      template: "planChanged",
      data: {
        name: profile.name,
        fromPlan: PLANS[previous].name,
        toPlan: PLANS[nextPlan].name,
        effectiveAt: now,
        url: `${appUrl()}/settings/billing`,
      },
      userId: profile.userId,
      idempotencyKey: `plan:${profile.userId}:${eventId}`,
    });
    await capture(ctx, {
      distinctId: profile.userId,
      event: "plan changed",
      properties: { from: previous, to: nextPlan, interval: sub.interval ?? null },
    });
    const log = createLogger(ctx, { fn: "billing.applySubscription" });
    log.info("plan changed", { userId: profile.userId, from: previous, to: nextPlan });
    await log.flush();
  }
  return "applied";
}

/** Used by the sync action after fetching a subscription from the Stripe API. */
export const applySubscription = internalMutation({
  args: {
    subscription: v.object({
      id: v.string(),
      customerId: v.string(),
      status: subscriptionStatusValidator,
      priceId: v.optional(v.string()),
      interval: v.optional(v.union(v.literal("month"), v.literal("year"))),
      currentPeriodStart: v.optional(v.number()),
      currentPeriodEnd: v.optional(v.number()),
      cancelAtPeriodEnd: v.boolean(),
      canceledAt: v.optional(v.number()),
      userId: v.optional(v.string()),
    }),
    eventCreated: v.number(),
    eventId: v.string(),
  },
  handler: async (ctx, args) => {
    return await applySubscriptionChange(ctx, args.subscription, args.eventCreated, args.eventId);
  },
});
