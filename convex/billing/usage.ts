import { v } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import { internalMutation, type MutationCtx, type QueryCtx, query } from "../_generated/server";
import { getBalance } from "../lib/credits";
import { getPlan } from "../lib/entitlements";
import { requireUser } from "../lib/guards";
import { FAIR_USE, PLANS } from "../lib/plans";
import { getUsage, incrementUsage, periodOf, setGauge } from "../lib/usage";
import { usageMetricValidator } from "../lib/validators";

const MB = 1024 * 1024;

function meter(used: number, limit: number | null) {
  return {
    used,
    limit,
    /** 0..1, or null when unlimited. */
    ratio: limit === null ? null : limit === 0 ? 1 : Math.min(1, used / limit),
  };
}

/**
 * Usage dashboard data for a user: counters vs. plan limits, credits and fair-use caps. Shared by `summary`
 * and the Agent API (which passes the user id it verified from an API key).
 */
export async function usageSummaryFor(
  ctx: QueryCtx | MutationCtx,
  user: { userId: string; profile?: Doc<"profiles"> | null },
) {
  const planId = await getPlan(ctx, user);
  const plan = PLANS[planId];
  const period = periodOf();
  const [designs, storageBytes, exports, aiRequests, brandKits, uploads, credits] =
    await Promise.all([
      getUsage(ctx, user.userId, "designs"),
      getUsage(ctx, user.userId, "storageBytes"),
      getUsage(ctx, user.userId, "exports", period),
      getUsage(ctx, user.userId, "aiRequests", period),
      getUsage(ctx, user.userId, "brandKits"),
      getUsage(ctx, user.userId, "uploads", period),
      getBalance(ctx, user.userId),
    ]);
  const ownedWorkspaces = (
    await ctx.db
      .query("workspaces")
      .withIndex("by_owner", (q) => q.eq("ownerId", user.userId))
      .collect()
  ).length;
  const storageLimitBytes = plan.limits.storageMb === null ? null : plan.limits.storageMb * MB;
  return {
    period,
    plan: planId,
    planName: plan.name,
    meters: {
      designs: meter(designs, plan.limits.designs),
      storageBytes: meter(storageBytes, storageLimitBytes),
      exports: meter(exports, plan.limits.exportsPerMonth),
      brandKits: meter(brandKits, plan.limits.brandKits),
      workspaces: meter(ownedWorkspaces, plan.limits.workspaces),
      aiRequests: meter(aiRequests, null),
      uploads: meter(uploads, null),
    },
    limits: plan.limits,
    credits,
    fairUse:
      planId === "selfhost"
        ? null
        : {
            perMinuteAiRequests: FAIR_USE.perMinuteAiRequests,
            perDayAiRequests: FAIR_USE.perDayAiRequests,
            maxConcurrentRuns: FAIR_USE.maxConcurrentRuns,
            byokBypassesCredits: FAIR_USE.byokBypassesCredits,
            noOverageCharges: FAIR_USE.noOverageCharges,
          },
  };
}

/** Usage dashboard data for settings: counters vs. plan limits, credits and fair-use caps. */
export const summary = query({
  args: {},
  handler: async (ctx) => await usageSummaryFor(ctx, await requireUser(ctx)),
});

/** Internal counter API for owners that cannot import lib/usage directly (e.g. from actions). */
export const increment = internalMutation({
  args: { userId: v.string(), metric: usageMetricValidator, delta: v.number() },
  handler: async (ctx, args) => await incrementUsage(ctx, args.userId, args.metric, args.delta),
});

export const setGaugeValue = internalMutation({
  args: { userId: v.string(), metric: usageMetricValidator, value: v.number() },
  handler: async (ctx, args) => {
    await setGauge(ctx, args.userId, args.metric, args.value);
  },
});
