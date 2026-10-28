import { v } from "convex/values";
import { internal } from "../_generated/api";
import { internalMutation, type MutationCtx } from "../_generated/server";
import { enqueueEmail } from "../emails/queue";
import { appUrl } from "../lib/env";
import { createLogger, type Logger } from "../lib/logger";
import { PLANS } from "../lib/plans";
import { normalizeInvoice, normalizeSubscription } from "./normalize";
import { applySubscriptionChange } from "./subscription";

// Stripe webhook processing. The HTTP route (routes/stripe.ts) verifies the signature, then calls
// `processEvent` with the parsed event. Every event id is processed at most once.

export const HANDLED_EVENTS = [
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "customer.subscription.paused",
  "customer.subscription.resumed",
  "invoice.paid",
  "invoice.payment_failed",
] as const;

type Outcome = "processed" | "ignored" | "duplicate";

async function profileByCustomer(ctx: MutationCtx, customerId: string) {
  return await ctx.db
    .query("profiles")
    .withIndex("by_stripeCustomerId", (q) => q.eq("stripeCustomerId", customerId))
    .first();
}

async function handle(
  ctx: MutationCtx,
  event: { id: string; type: string; created: number; object: unknown },
  log: Logger,
): Promise<{ status: "processed" | "ignored"; note?: string }> {
  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.object as Record<string, unknown>;
      const userId =
        typeof session.client_reference_id === "string" ? session.client_reference_id : null;
      const customerId = typeof session.customer === "string" ? session.customer : null;
      const subscriptionId = typeof session.subscription === "string" ? session.subscription : null;
      if (userId && customerId) {
        const profile = await ctx.db
          .query("profiles")
          .withIndex("by_userId", (q) => q.eq("userId", userId))
          .unique();
        if (profile && !profile.stripeCustomerId) {
          await ctx.db.patch("profiles", profile._id, {
            stripeCustomerId: customerId,
            updatedAt: Date.now(),
          });
        }
      }
      // The subscription events usually arrive on their own; syncing here covers lost/late delivery.
      if (subscriptionId) {
        await ctx.scheduler.runAfter(0, internal.billing.stripeActions.syncSubscription, {
          subscriptionId,
          eventId: event.id,
        });
      }
      return { status: "processed" };
    }
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
    case "customer.subscription.paused":
    case "customer.subscription.resumed": {
      const sub = normalizeSubscription(event.object);
      if (!sub) return { status: "ignored", note: "unparseable subscription" };
      const result = await applySubscriptionChange(ctx, sub, event.created, event.id);
      if (result === "unknown_customer") {
        log.warn("subscription for unknown customer", { customer: sub.customerId });
        return { status: "ignored", note: "unknown customer" };
      }
      return {
        status: result === "stale" ? "ignored" : "processed",
        ...(result === "stale" ? { note: "stale" } : {}),
      };
    }
    case "invoice.paid": {
      const invoice = normalizeInvoice(event.object);
      if (!invoice) return { status: "ignored", note: "unparseable invoice" };
      if (invoice.amountPaid <= 0) return { status: "ignored", note: "zero amount" };
      const profile = await profileByCustomer(ctx, invoice.customerId);
      if (!profile) return { status: "ignored", note: "unknown customer" };
      await enqueueEmail(ctx, {
        to: profile.email,
        template: "receipt",
        data: {
          name: profile.name,
          planName: PLANS.pro.name,
          amount: invoice.amountPaid,
          currency: invoice.currency,
          ...(invoice.interval ? { interval: invoice.interval } : {}),
          ...(invoice.hostedInvoiceUrl ? { invoiceUrl: invoice.hostedInvoiceUrl } : {}),
          ...(invoice.periodEnd ? { periodEnd: invoice.periodEnd } : {}),
          url: `${appUrl()}/settings/billing`,
        },
        userId: profile.userId,
        idempotencyKey: `receipt:${invoice.id}`,
      });
      return { status: "processed" };
    }
    case "invoice.payment_failed": {
      const invoice = normalizeInvoice(event.object);
      if (!invoice) return { status: "ignored", note: "unparseable invoice" };
      const profile = await profileByCustomer(ctx, invoice.customerId);
      if (!profile) return { status: "ignored", note: "unknown customer" };
      await enqueueEmail(ctx, {
        to: profile.email,
        template: "paymentFailed",
        data: {
          name: profile.name,
          url: `${appUrl()}/settings/billing`,
          amount: invoice.amountDue,
          currency: invoice.currency,
        },
        userId: profile.userId,
        idempotencyKey: `payment_failed:${invoice.id}:${invoice.attemptCount}`,
      });
      return { status: "processed" };
    }
    default:
      return { status: "ignored", note: "unhandled type" };
  }
}

export const processEvent = internalMutation({
  args: {
    id: v.string(),
    type: v.string(),
    created: v.number(),
    object: v.any(),
  },
  handler: async (ctx, args): Promise<{ outcome: Outcome; note?: string }> => {
    const seen = await ctx.db
      .query("stripeEvents")
      .withIndex("by_eventId", (q) => q.eq("eventId", args.id))
      .unique();
    if (seen) return { outcome: "duplicate" };
    const log = createLogger(ctx, { fn: "billing.webhook", eventId: args.id, type: args.type });
    const result = await handle(ctx, args, log);
    await ctx.db.insert("stripeEvents", {
      eventId: args.id,
      type: args.type,
      created: args.created,
      status: result.status,
      ...(result.note ? { error: result.note } : {}),
      processedAt: Date.now(),
    });
    log.info("stripe event", { status: result.status, note: result.note });
    await log.flush();
    return { outcome: result.status, ...(result.note ? { note: result.note } : {}) };
  },
});

/** Cron: forget processed event ids after 60 days (Stripe stops retrying after 3 days). */
export const purgeOldEvents = internalMutation({
  args: {},
  handler: async (ctx) => {
    const cutoff = Date.now() - 60 * 24 * 60 * 60 * 1000;
    const old = await ctx.db
      .query("stripeEvents")
      .withIndex("by_processedAt", (q) => q.lt("processedAt", cutoff))
      .take(500);
    for (const row of old) await ctx.db.delete("stripeEvents", row._id);
    return old.length;
  },
});
