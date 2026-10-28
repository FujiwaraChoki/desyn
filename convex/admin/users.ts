import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { components } from "../_generated/api";
import type { Doc } from "../_generated/dataModel";
import { mutation, query } from "../_generated/server";
import { writeAudit } from "../lib/audit";
import { adjustCredits, ensureBalance, getBalance } from "../lib/credits";
import { planForProfile } from "../lib/entitlements";
import { errors } from "../lib/errors";
import { getProfile, isAdminProfile, requireAdmin } from "../lib/guards";
import { PLANS } from "../lib/plans";
import { getUsage } from "../lib/usage";
import { planIdValidator, systemRoleValidator } from "../lib/validators";

function row(profile: Doc<"profiles">) {
  const plan = planForProfile(profile);
  return {
    userId: profile.userId,
    email: profile.email,
    name: profile.name,
    image: profile.image ?? null,
    plan,
    planName: PLANS[plan].name,
    billingPlan: profile.plan,
    planOverride: profile.planOverride ?? null,
    role: profile.role,
    isAdmin: isAdminProfile(profile),
    disabled: profile.disabled ?? false,
    hasStripeCustomer: Boolean(profile.stripeCustomerId),
    createdAt: profile.createdAt,
    lastSeenAt: profile.lastSeenAt ?? null,
  };
}

/** Users, newest first, or by email prefix when `search` is set. */
export const list = query({
  args: { search: v.optional(v.string()), paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const search = args.search?.trim().toLowerCase();
    const page = search
      ? await ctx.db
          .query("profiles")
          .withIndex("by_email", (q) => q.gte("email", search).lt("email", `${search}￿`))
          .paginate(args.paginationOpts)
      : await ctx.db
          .query("profiles")
          .withIndex("by_createdAt")
          .order("desc")
          .paginate(args.paginationOpts);
    return { ...page, page: page.page.map(row) };
  },
});

export const get = query({
  args: { userId: v.string() },
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const profile = await getProfile(ctx, args.userId);
    if (!profile) throw errors.notFound("User");
    const [designs, storageBytes, exports, aiRequests, credits] = await Promise.all([
      getUsage(ctx, args.userId, "designs"),
      getUsage(ctx, args.userId, "storageBytes"),
      getUsage(ctx, args.userId, "exports"),
      getUsage(ctx, args.userId, "aiRequests"),
      getBalance(ctx, args.userId),
    ]);
    const memberships = await ctx.db
      .query("memberships")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .collect();
    const subscriptions = await ctx.db
      .query("subscriptions")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .collect();
    return {
      ...row(profile),
      usage: { designs, storageBytes, exports, aiRequests },
      credits,
      workspaces: memberships.length,
      subscriptions: subscriptions.map((s) => ({
        status: s.status,
        interval: s.interval ?? null,
        currentPeriodEnd: s.currentPeriodEnd ?? null,
        cancelAtPeriodEnd: s.cancelAtPeriodEnd,
      })),
    };
  },
});

/** Override a user's plan (null clears the override and returns to the billing-derived plan). */
export const setPlanOverride = mutation({
  args: { userId: v.string(), plan: v.union(planIdValidator, v.null()) },
  handler: async (ctx, args) => {
    const admin = await requireAdmin(ctx);
    const profile = await getProfile(ctx, args.userId);
    if (!profile) throw errors.notFound("User");
    await ctx.db.patch("profiles", profile._id, {
      planOverride: args.plan ?? undefined,
      updatedAt: Date.now(),
    });
    await ensureBalance(ctx, args.userId);
    await writeAudit(ctx, {
      action: "admin.planOverride",
      actorId: admin.userId,
      targetType: "user",
      targetId: args.userId,
      data: { from: profile.planOverride ?? null, to: args.plan },
    });
    return null;
  },
});

export const setRole = mutation({
  args: { userId: v.string(), role: systemRoleValidator },
  handler: async (ctx, args) => {
    const admin = await requireAdmin(ctx);
    const profile = await getProfile(ctx, args.userId);
    if (!profile) throw errors.notFound("User");
    if (profile.role === args.role) return null;
    if (args.role === "user" && profile.role === "admin") {
      const admins = await ctx.db
        .query("profiles")
        .withIndex("by_role", (q) => q.eq("role", "admin"))
        .take(2);
      if (admins.length <= 1) throw errors.conflict("At least one admin must remain.");
    }
    await ctx.db.patch("profiles", profile._id, { role: args.role, updatedAt: Date.now() });
    await writeAudit(ctx, {
      action: "admin.roleChanged",
      actorId: admin.userId,
      targetType: "user",
      targetId: args.userId,
      data: { from: profile.role, to: args.role },
    });
    return null;
  },
});

/** Disable or re-enable an account. Disabling signs the user out everywhere. */
export const setDisabled = mutation({
  args: { userId: v.string(), disabled: v.boolean() },
  handler: async (ctx, args) => {
    const admin = await requireAdmin(ctx);
    if (args.userId === admin.userId)
      throw errors.forbidden("You cannot disable your own account.");
    const profile = await getProfile(ctx, args.userId);
    if (!profile) throw errors.notFound("User");
    await ctx.db.patch("profiles", profile._id, { disabled: args.disabled, updatedAt: Date.now() });
    if (args.disabled) {
      await ctx.runMutation(components.betterAuth.adapter.deleteMany, {
        input: { model: "session", where: [{ field: "userId", value: args.userId }] },
        paginationOpts: { cursor: null, numItems: 500 },
      });
    }
    await writeAudit(ctx, {
      action: "admin.userDisabled",
      actorId: admin.userId,
      targetType: "user",
      targetId: args.userId,
      data: { disabled: args.disabled },
    });
    return null;
  },
});

export const adjustUserCredits = mutation({
  args: { userId: v.string(), delta: v.number(), note: v.string() },
  handler: async (ctx, args) => {
    const admin = await requireAdmin(ctx);
    if (!Number.isFinite(args.delta) || args.delta === 0 || Math.abs(args.delta) > 1_000_000) {
      throw errors.invalid("Delta must be a non-zero number.", "delta");
    }
    const note = args.note.trim();
    if (!note) throw errors.invalid("Add a note explaining the adjustment.", "note");
    const balance = await adjustCredits(ctx, { userId: args.userId, delta: args.delta, note });
    await writeAudit(ctx, {
      action: "admin.creditsAdjusted",
      actorId: admin.userId,
      targetType: "user",
      targetId: args.userId,
      data: { delta: args.delta, note },
    });
    return balance;
  },
});
