import { v } from "convex/values";
import { internalQuery, type QueryCtx, query } from "../_generated/server";
import { readCounter } from "../accounts/counters";
import { STALE_RESERVATION_MS } from "../lib/credits";
import { integrationStatus } from "../lib/env";
import { requireAdmin } from "../lib/guards";
import { periodOf } from "../lib/usage";

const SCAN_CAP = 5000;

/** Which integrations are configured (booleans only, never values). */
export const status = query({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);
    return integrationStatus();
  },
});

/** Instance usage overview for the admin console. Sums are capped at 5000 rows (`truncated`). */
export const usageOverview = query({
  args: { period: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const period = args.period ?? periodOf();
    const balances = await ctx.db
      .query("creditBalances")
      .withIndex("by_period", (q) => q.eq("period", period))
      .take(SCAN_CAP);
    const sumMetric = async (
      metric: "exports" | "aiRequests" | "storageBytes" | "designs",
      p: string,
    ) => {
      const rows = await ctx.db
        .query("usage")
        .withIndex("by_metric_period", (q) => q.eq("metric", metric).eq("period", p))
        .take(SCAN_CAP);
      return {
        total: rows.reduce((acc, r) => acc + r.value, 0),
        truncated: rows.length === SCAN_CAP,
      };
    };
    const [exports, aiRequests, storageBytes, designs] = await Promise.all([
      sumMetric("exports", period),
      sumMetric("aiRequests", period),
      sumMetric("storageBytes", "total"),
      sumMetric("designs", "total"),
    ]);
    const profiles = await ctx.db.query("profiles").withIndex("by_createdAt").take(SCAN_CAP);
    const pro = profiles.filter((p) => (p.planOverride ?? p.plan) === "pro").length;
    return {
      period,
      users: await readCounter(ctx, "users"),
      proUsers: pro,
      credits: {
        used: balances.reduce((acc, b) => acc + b.used, 0),
        reserved: balances.reduce((acc, b) => acc + b.reserved, 0),
        overage: balances.reduce((acc, b) => acc + b.overage, 0),
        activeUsers: balances.filter((b) => b.used > 0).length,
        truncated: balances.length === SCAN_CAP,
      },
      exports,
      aiRequests,
      storageBytes,
      designs,
    };
  },
});

async function healthSnapshot(ctx: QueryCtx) {
  const now = Date.now();
  const queuedMail = await ctx.db
    .query("mailLog")
    .withIndex("by_status", (q) => q.eq("status", "queued"))
    .take(1000);
  const failedMail = await ctx.db
    .query("mailLog")
    .withIndex("by_status", (q) => q.eq("status", "failed"))
    .take(1000);
  const staleReservations = await ctx.db
    .query("creditReservations")
    .withIndex("by_status_createdAt", (q) =>
      q.eq("status", "reserved").lt("createdAt", now - STALE_RESERVATION_MS),
    )
    .take(1000);
  const logBacklog = await ctx.db.query("logQueue").take(1000);
  return {
    ok: true,
    time: now,
    mail: { queued: queuedMail.length, failed: failedMail.length },
    staleReservations: staleReservations.length,
    logBacklog: logBacklog.length,
  };
}

/** Operational health details (admins). The public /healthz route exposes only liveness. */
export const health = query({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);
    return { ...(await healthSnapshot(ctx)), integrations: integrationStatus() };
  },
});

/** Liveness probe used by /healthz: proves the function runtime can read the database. */
export const ping = internalQuery({
  args: {},
  handler: async (ctx) => {
    await ctx.db.query("systemCounters").first();
    return { ok: true, time: Date.now() };
  },
});
