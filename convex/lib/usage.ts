import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { UsageMetric } from "./validators";

type DbCtx = QueryCtx | MutationCtx;

/** Metrics that reset every period ("YYYY-MM"); the others are gauges stored under period "total". */
export const MONTHLY_METRICS: ReadonlySet<UsageMetric> = new Set([
  "exports",
  "aiRequests",
  "uploads",
]);
export const GAUGE_PERIOD = "total";

/** Billing/usage period for a timestamp: calendar month in UTC, "YYYY-MM". */
export function periodOf(ts: number = Date.now()): string {
  const d = new Date(ts);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Start (inclusive) and end (exclusive) of a "YYYY-MM" period in ms. */
export function periodBounds(period: string): { start: number; end: number } {
  const [y, m] = period.split("-").map(Number);
  if (!y || !m) throw new Error(`Invalid period ${period}`);
  return { start: Date.UTC(y, m - 1, 1), end: Date.UTC(y, m, 1) };
}

export function previousPeriod(period: string): string {
  const { start } = periodBounds(period);
  return periodOf(start - 1);
}

function periodFor(metric: UsageMetric, ts?: number): string {
  return MONTHLY_METRICS.has(metric) ? periodOf(ts) : GAUGE_PERIOD;
}

export async function getUsage(
  ctx: DbCtx,
  userId: string,
  metric: UsageMetric,
  period?: string,
): Promise<number> {
  const p = period ?? periodFor(metric);
  const row = await ctx.db
    .query("usage")
    .withIndex("by_user_metric_period", (q) =>
      q.eq("userId", userId).eq("metric", metric).eq("period", p),
    )
    .unique();
  return row?.value ?? 0;
}

/**
 * Add `delta` (may be negative) to a counter. Gauges never go below zero. Returns the new value.
 * Other owners call this when they create/delete designs, upload/delete assets, finish exports.
 */
export async function incrementUsage(
  ctx: MutationCtx,
  userId: string,
  metric: UsageMetric,
  delta: number,
  opts: { ts?: number } = {},
): Promise<number> {
  const period = periodFor(metric, opts.ts);
  const row = await ctx.db
    .query("usage")
    .withIndex("by_user_metric_period", (q) =>
      q.eq("userId", userId).eq("metric", metric).eq("period", period),
    )
    .unique();
  const next = Math.max(0, (row?.value ?? 0) + delta);
  const now = Date.now();
  if (row) await ctx.db.patch("usage", row._id, { value: next, updatedAt: now });
  else await ctx.db.insert("usage", { userId, metric, period, value: next, updatedAt: now });
  return next;
}

/** Overwrite a gauge (used by reconciliation jobs that recount from source tables). */
export async function setGauge(
  ctx: MutationCtx,
  userId: string,
  metric: UsageMetric,
  value: number,
): Promise<void> {
  if (MONTHLY_METRICS.has(metric)) throw new Error(`${metric} is a monthly counter, not a gauge`);
  const row = await ctx.db
    .query("usage")
    .withIndex("by_user_metric_period", (q) =>
      q.eq("userId", userId).eq("metric", metric).eq("period", GAUGE_PERIOD),
    )
    .unique();
  const now = Date.now();
  const next = Math.max(0, value);
  if (row) await ctx.db.patch("usage", row._id, { value: next, updatedAt: now });
  else
    await ctx.db.insert("usage", {
      userId,
      metric,
      period: GAUGE_PERIOD,
      value: next,
      updatedAt: now,
    });
}
