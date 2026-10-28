"use node";

import { v } from "convex/values";
import Stripe from "stripe";
import { internal } from "../_generated/api";
import { type ActionCtx, action, internalAction } from "../_generated/server";
import { attributionMetadata } from "../lib/billing_attribution";
import { appUrl, env, isHosted } from "../lib/env";
import { errors } from "../lib/errors";
import { createLogger } from "../lib/logger";
import { rateLimiter } from "../lib/rateLimits";
import { normalizeSubscription } from "./normalize";

let client: Stripe | null = null;

function stripe(): Stripe {
  if (!isHosted()) throw errors.billingDisabled();
  const key = env.get("STRIPE_SECRET_KEY");
  if (!key) throw errors.notConfigured("Stripe");
  client ??= new Stripe(key, { maxNetworkRetries: 2, appInfo: { name: "Desyn" } });
  return client;
}

/** Only same-origin relative paths are accepted for redirects back into the app. */
export function safeReturnPath(path: string | undefined, fallback: string): string {
  if (!path?.startsWith("/") || path.startsWith("//") || path.includes("\\")) return fallback;
  return path;
}

function withQuery(path: string, query: string): string {
  return `${path}${path.includes("?") ? "&" : "?"}${query}`;
}

async function ensureCustomer(
  ctx: ActionCtx,
  context: { userId: string; email: string; name: string; stripeCustomerId: string | null },
): Promise<string> {
  if (context.stripeCustomerId) return context.stripeCustomerId;
  const customer = await stripe().customers.create(
    { email: context.email, name: context.name, metadata: { userId: context.userId } },
    { idempotencyKey: `desyn-customer-${context.userId}` },
  );
  return await ctx.runMutation(internal.billing.subscription.linkCustomer, {
    userId: context.userId,
    customerId: customer.id,
  });
}

/**
 * Start a Stripe Checkout session for Desyn Pro. If the user already has an active subscription the
 * Customer Portal is returned instead (`kind: "portal"`).
 */
export const createCheckout = action({
  args: {
    interval: v.union(v.literal("month"), v.literal("year")),
    returnPath: v.optional(v.string()),
    /** DataFast revenue attribution ids from the visitor's cookies (web app; optional). */
    attribution: v.optional(
      v.object({
        datafastVisitorId: v.optional(v.string()),
        datafastSessionId: v.optional(v.string()),
      }),
    ),
  },
  handler: async (ctx, args): Promise<{ url: string; kind: "checkout" | "portal" }> => {
    const context = await ctx.runQuery(internal.billing.subscription.checkoutContext, {});
    const limited = await rateLimiter.limit(ctx, "checkout", { key: context.userId });
    if (!limited.ok) throw errors.rateLimited(limited.retryAfter, "checkout");
    const returnPath = safeReturnPath(args.returnPath, "/settings/billing");
    const customerId = await ensureCustomer(ctx, context);
    if (context.hasActiveSubscription) {
      const portal = await stripe().billingPortal.sessions.create({
        customer: customerId,
        return_url: `${appUrl()}${returnPath}`,
      });
      return { url: portal.url, kind: "portal" };
    }
    const price = env.get(
      args.interval === "year" ? "STRIPE_PRICE_PRO_YEARLY" : "STRIPE_PRICE_PRO_MONTHLY",
    );
    if (!price) throw errors.notConfigured(`The ${args.interval}ly Pro price`);
    const session = await stripe().checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      client_reference_id: context.userId,
      line_items: [{ price, quantity: 1 }],
      allow_promotion_codes: true,
      billing_address_collection: "auto",
      customer_update: { address: "auto", name: "auto" },
      subscription_data: { metadata: { userId: context.userId } },
      metadata: { userId: context.userId, ...attributionMetadata(args.attribution) },
      success_url: `${appUrl()}${withQuery(returnPath, "checkout=success&session_id={CHECKOUT_SESSION_ID}")}`,
      cancel_url: `${appUrl()}${withQuery(returnPath, "checkout=canceled")}`,
    });
    if (!session.url) throw errors.notConfigured("Stripe Checkout");
    await ctx.runMutation(internal.billing.subscription.recordCheckoutStarted, {
      userId: context.userId,
      interval: args.interval,
    });
    return { url: session.url, kind: "checkout" };
  },
});

/** Open the Stripe Customer Portal (payment method, invoices, cancel / switch interval). */
export const createPortal = action({
  args: { returnPath: v.optional(v.string()) },
  handler: async (ctx, args): Promise<{ url: string }> => {
    const context = await ctx.runQuery(internal.billing.subscription.checkoutContext, {});
    const customerId = await ensureCustomer(ctx, context);
    const portal = await stripe().billingPortal.sessions.create({
      customer: customerId,
      return_url: `${appUrl()}${safeReturnPath(args.returnPath, "/settings/billing")}`,
    });
    return { url: portal.url };
  },
});

/** Fetch a subscription from Stripe and apply it (used after checkout completion). */
export const syncSubscription = internalAction({
  args: { subscriptionId: v.string(), eventId: v.string() },
  handler: async (ctx, args): Promise<void> => {
    const log = createLogger(ctx, {
      fn: "billing.syncSubscription",
      subscriptionId: args.subscriptionId,
    });
    const raw = await stripe().subscriptions.retrieve(args.subscriptionId);
    const sub = normalizeSubscription(raw);
    if (!sub) {
      log.warn("could not normalize subscription");
    } else {
      // A fetched object is the newest state, so it is applied with the current time as its version.
      const result = await ctx.runMutation(internal.billing.subscription.applySubscription, {
        subscription: sub,
        eventCreated: Math.floor(Date.now() / 1000),
        eventId: `sync:${args.eventId}`,
      });
      log.info("subscription synced", { result });
    }
    await log.flush();
  },
});

/** Cancel subscriptions immediately (account deletion). Missing subscriptions are ignored. */
export const cancelSubscriptions = internalAction({
  args: { subscriptionIds: v.array(v.string()) },
  handler: async (ctx, args): Promise<void> => {
    if (!isHosted() || !env.has("STRIPE_SECRET_KEY")) return;
    const log = createLogger(ctx, { fn: "billing.cancelSubscriptions" });
    for (const id of args.subscriptionIds) {
      try {
        await stripe().subscriptions.cancel(id, { prorate: false });
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code !== "resource_missing") {
          log.error("subscription cancel failed", { subscriptionId: id, error: String(err) });
        }
      }
    }
    await log.flush();
  },
});
