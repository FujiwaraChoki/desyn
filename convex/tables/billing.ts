import { defineTable } from "convex/server";
import { v } from "convex/values";
import {
  billingIntervalValidator,
  creditReasonValidator,
  subscriptionStatusValidator,
  usageMetricValidator,
} from "../lib/validators";

export const billingTables = {
  /** Mirror of the user's Stripe subscription (hosted edition only). */
  subscriptions: defineTable({
    userId: v.string(),
    stripeCustomerId: v.string(),
    stripeSubscriptionId: v.string(),
    status: subscriptionStatusValidator,
    priceId: v.optional(v.string()),
    interval: v.optional(billingIntervalValidator),
    currentPeriodStart: v.optional(v.number()),
    currentPeriodEnd: v.optional(v.number()),
    cancelAtPeriodEnd: v.boolean(),
    canceledAt: v.optional(v.number()),
    /** `created` (seconds) of the newest Stripe event applied, used to ignore out-of-order deliveries. */
    lastEventCreated: v.number(),
    updatedAt: v.number(),
  })
    .index("by_user", ["userId"])
    .index("by_subscriptionId", ["stripeSubscriptionId"])
    .index("by_customer", ["stripeCustomerId"]),

  /** Processed Stripe webhook events (idempotency). */
  stripeEvents: defineTable({
    eventId: v.string(),
    type: v.string(),
    created: v.number(),
    status: v.union(v.literal("processed"), v.literal("ignored"), v.literal("failed")),
    error: v.optional(v.string()),
    processedAt: v.number(),
  })
    .index("by_eventId", ["eventId"])
    .index("by_processedAt", ["processedAt"]),

  /** Credit pool per user per period ("YYYY-MM", UTC). */
  creditBalances: defineTable({
    userId: v.string(),
    period: v.string(),
    plan: v.string(),
    /** Credits granted for the period. `null` means unlimited (self-host). */
    granted: v.union(v.number(), v.null()),
    /** Credits charged against the pool. */
    used: v.number(),
    /** Credits held by in-flight reservations. */
    reserved: v.number(),
    /** Credits consumed past the pool under fair-use throttling. Recorded, never billed. */
    overage: v.number(),
    updatedAt: v.number(),
  })
    .index("by_user_period", ["userId", "period"])
    .index("by_period", ["period"]),

  /** Append-only credits ledger. */
  credits: defineTable({
    userId: v.string(),
    period: v.string(),
    delta: v.number(),
    reason: creditReasonValidator,
    refId: v.optional(v.string()),
    kind: v.optional(v.string()),
    note: v.optional(v.string()),
    /** Remaining pool after this entry (granted - used), null when unlimited. */
    balanceAfter: v.union(v.number(), v.null()),
    createdAt: v.number(),
  })
    .index("by_user_createdAt", ["userId", "createdAt"])
    .index("by_refId", ["refId"])
    .index("by_createdAt", ["createdAt"]),

  /** Reservation state machine keyed by the caller's refId (idempotency key). */
  creditReservations: defineTable({
    refId: v.string(),
    userId: v.string(),
    period: v.string(),
    kind: v.string(),
    amount: v.number(),
    /** Amount actually charged to the pool on commit (<= committed cost; the rest is overage). */
    charged: v.optional(v.number()),
    /** Final cost on commit. */
    cost: v.optional(v.number()),
    byok: v.boolean(),
    status: v.union(v.literal("reserved"), v.literal("committed"), v.literal("refunded")),
    createdAt: v.number(),
    settledAt: v.optional(v.number()),
  })
    .index("by_refId", ["refId"])
    .index("by_user_status", ["userId", "status"])
    .index("by_status_createdAt", ["status", "createdAt"]),

  /** Usage counters. Monthly counters use period "YYYY-MM", gauges use period "total". */
  usage: defineTable({
    userId: v.string(),
    metric: usageMetricValidator,
    period: v.string(),
    value: v.number(),
    updatedAt: v.number(),
  })
    .index("by_user_metric_period", ["userId", "metric", "period"])
    .index("by_user", ["userId"])
    .index("by_metric_period", ["metric", "period"]),
};
