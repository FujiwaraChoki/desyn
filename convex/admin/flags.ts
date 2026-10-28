import { v } from "convex/values";
import { mutation, query } from "../_generated/server";
import { writeAudit } from "../lib/audit";
import { errors } from "../lib/errors";
import { requireAdmin } from "../lib/guards";
import { FEATURE_KEYS } from "../lib/plans";

const KEY = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,99}$/;

/** All runtime flags, plus the list of plan feature keys that `feature.<key>` flags can override. */
export const list = query({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);
    const flags = await ctx.db.query("featureFlags").collect();
    return {
      flags: flags
        .map((f) => ({
          key: f.key,
          enabled: f.enabled,
          plans: f.plans ?? null,
          userIds: f.userIds ?? null,
          rollout: f.rollout ?? null,
          value: f.value ?? null,
          description: f.description ?? null,
          updatedBy: f.updatedBy ?? null,
          updatedAt: f.updatedAt,
        }))
        .sort((a, b) => a.key.localeCompare(b.key)),
      featureKeys: FEATURE_KEYS,
    };
  },
});

export const set = mutation({
  args: {
    key: v.string(),
    enabled: v.boolean(),
    plans: v.optional(v.array(v.string())),
    userIds: v.optional(v.array(v.string())),
    rollout: v.optional(v.number()),
    value: v.optional(v.any()),
    description: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const admin = await requireAdmin(ctx);
    if (!KEY.test(args.key))
      throw errors.invalid("Flag keys use letters, digits and . _ : -", "key");
    if (args.rollout !== undefined && (args.rollout < 0 || args.rollout > 100)) {
      throw errors.invalid("Rollout must be 0-100.", "rollout");
    }
    if ((args.userIds?.length ?? 0) > 1000)
      throw errors.invalid("At most 1000 user ids.", "userIds");
    const existing = await ctx.db
      .query("featureFlags")
      .withIndex("by_key", (q) => q.eq("key", args.key))
      .unique();
    const doc = {
      key: args.key,
      enabled: args.enabled,
      plans: args.plans,
      userIds: args.userIds,
      rollout: args.rollout,
      value: args.value,
      description: args.description?.slice(0, 300),
      updatedBy: admin.userId,
      updatedAt: Date.now(),
    };
    if (existing) await ctx.db.replace("featureFlags", existing._id, doc);
    else await ctx.db.insert("featureFlags", doc);
    await writeAudit(ctx, {
      action: "admin.flagChanged",
      actorId: admin.userId,
      targetType: "flag",
      targetId: args.key,
      data: { enabled: args.enabled, plans: args.plans ?? null, rollout: args.rollout ?? null },
    });
    return null;
  },
});

export const remove = mutation({
  args: { key: v.string() },
  handler: async (ctx, args) => {
    const admin = await requireAdmin(ctx);
    const existing = await ctx.db
      .query("featureFlags")
      .withIndex("by_key", (q) => q.eq("key", args.key))
      .unique();
    if (!existing) return null;
    await ctx.db.delete("featureFlags", existing._id);
    await writeAudit(ctx, {
      action: "admin.flagChanged",
      actorId: admin.userId,
      targetType: "flag",
      targetId: args.key,
      data: { removed: true },
    });
    return null;
  },
});
