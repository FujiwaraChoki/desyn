import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { internal } from "../_generated/api";
import { internalMutation, mutation, query } from "../_generated/server";
import {
  commitCredits,
  ensureBalance,
  getBalance,
  grantForPlan,
  refundCredits,
  reserveCredits,
  STALE_RESERVATION_MS,
} from "../lib/credits";
import { getPlan } from "../lib/entitlements";
import { requireUser } from "../lib/guards";
import { createLogger } from "../lib/logger";
import { periodBounds, periodOf } from "../lib/usage";

/** Current period balance for the signed-in user. */
export const balance = query({
  args: {},
  handler: async (ctx) => {
    const user = await requireUser(ctx);
    return await getBalance(ctx, user.userId);
  },
});

/** Ledger entries, newest first. */
export const history = query({
  args: { paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const page = await ctx.db
      .query("credits")
      .withIndex("by_user_createdAt", (q) => q.eq("userId", user.userId))
      .order("desc")
      .paginate(args.paginationOpts);
    return {
      ...page,
      page: page.page.map((e) => ({
        id: e._id,
        period: e.period,
        delta: e.delta,
        reason: e.reason,
        kind: e.kind ?? null,
        refId: e.refId ?? null,
        note: e.note ?? null,
        balanceAfter: e.balanceAfter,
        createdAt: e.createdAt,
      })),
    };
  },
});

/** Opens the current period for the user (idempotent). Clients may call this on app start. */
export const ensureCurrentPeriod = mutation({
  args: {},
  handler: async (ctx) => {
    const user = await requireUser(ctx);
    await ensureBalance(ctx, user.userId);
    return await getBalance(ctx, user.userId);
  },
});

// --- internal API for the AI backend (also importable as plain functions from lib/credits.ts) ---

export const reserve = internalMutation({
  args: {
    userId: v.string(),
    kind: v.string(),
    refId: v.string(),
    cost: v.optional(v.number()),
    byok: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => await reserveCredits(ctx, args),
});

export const commit = internalMutation({
  args: { refId: v.string(), cost: v.optional(v.number()) },
  handler: async (ctx, args) => await commitCredits(ctx, args),
});

export const refund = internalMutation({
  args: { refId: v.string(), reason: v.optional(v.string()) },
  handler: async (ctx, args) => await refundCredits(ctx, args),
});

// --- crons -------------------------------------------------------------------------------------

/** Release reservations abandoned by crashed runs so balances and concurrency caps recover. */
export const releaseStaleReservations = internalMutation({
  args: {},
  handler: async (ctx) => {
    const cutoff = Date.now() - STALE_RESERVATION_MS;
    const stale = await ctx.db
      .query("creditReservations")
      .withIndex("by_status_createdAt", (q) => q.eq("status", "reserved").lt("createdAt", cutoff))
      .take(200);
    for (const r of stale)
      await refundCredits(ctx, { refId: r.refId, reason: "stale reservation" });
    if (stale.length === 200) {
      await ctx.scheduler.runAfter(0, internal.billing.credits.releaseStaleReservations, {});
    }
    return stale.length;
  },
});

const ROLLOVER_BATCH = 200;

/**
 * Open the new period for every user whose plan grants monthly credits. Periods also open lazily
 * on first use; this keeps balances and the ledger tidy at the start of each month.
 */
export const rollover = internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())), period: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const period = args.period ?? periodOf();
    const page = await ctx.db
      .query("profiles")
      .withIndex("by_createdAt")
      .paginate({ cursor: args.cursor ?? null, numItems: ROLLOVER_BATCH });
    let opened = 0;
    for (const profile of page.page) {
      if (profile.disabled) continue;
      const plan = await getPlan(ctx, profile.userId);
      const grant = grantForPlan(plan);
      if (grant === null || grant <= 0) continue;
      const existing = await ctx.db
        .query("creditBalances")
        .withIndex("by_user_period", (q) => q.eq("userId", profile.userId).eq("period", period))
        .unique();
      if (existing) continue;
      // Open the period this run was started for, even if a continuation runs past midnight.
      await ensureBalance(ctx, profile.userId, periodBounds(period).start);
      opened++;
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.billing.credits.rollover, {
        cursor: page.continueCursor,
        period,
      });
    } else {
      const log = createLogger(ctx, { fn: "billing.rollover" });
      log.info("credit rollover complete", { period });
      await log.flush();
    }
    return { opened, done: page.isDone };
  },
});
