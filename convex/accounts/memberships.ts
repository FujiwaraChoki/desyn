import { v } from "convex/values";
import { mutation, query } from "../_generated/server";
import { writeAudit } from "../lib/audit";
import { errors } from "../lib/errors";
import { getMembership, getProfile, requireMember } from "../lib/guards";
import { canManageRole, roleRank } from "../lib/roles";
import { assignableRoleValidator } from "../lib/validators";
import { resetDefaultIfNeeded } from "./workspaces";

/** Members of a workspace with display info, most privileged first. */
export const list = query({
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, args) => {
    const access = await requireMember(ctx, args.workspaceId, "viewer");
    const rows = await ctx.db
      .query("memberships")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
      .collect();
    const out = [];
    for (const m of rows) {
      const profile = await getProfile(ctx, m.userId);
      out.push({
        userId: m.userId,
        role: m.role,
        name: profile?.name ?? "Former member",
        email: profile?.email ?? null,
        image: profile?.image ?? null,
        isYou: m.userId === access.userId,
        joinedAt: m.createdAt,
      });
    }
    out.sort((a, b) => roleRank(b.role) - roleRank(a.role) || a.name.localeCompare(b.name));
    return out;
  },
});

export const setRole = mutation({
  args: { workspaceId: v.id("workspaces"), userId: v.string(), role: assignableRoleValidator },
  handler: async (ctx, args) => {
    const access = await requireMember(ctx, args.workspaceId, "admin");
    if (args.userId === access.userId) throw errors.forbidden("You cannot change your own role.");
    const target = await getMembership(ctx, args.workspaceId, args.userId);
    if (!target) throw errors.notFound("Member");
    if (!canManageRole(access.role, args.role, target.role)) {
      throw errors.forbidden("You cannot assign that role.");
    }
    if (target.role === args.role) return null;
    await ctx.db.patch("memberships", target._id, { role: args.role, updatedAt: Date.now() });
    await writeAudit(ctx, {
      action: "member.roleChanged",
      actorId: access.userId,
      workspaceId: args.workspaceId,
      targetType: "user",
      targetId: args.userId,
      data: { from: target.role, to: args.role },
    });
    return null;
  },
});

export const remove = mutation({
  args: { workspaceId: v.id("workspaces"), userId: v.string() },
  handler: async (ctx, args) => {
    const access = await requireMember(ctx, args.workspaceId, "admin");
    if (args.userId === access.userId)
      throw errors.invalid("Use leave to remove yourself.", "userId");
    const target = await getMembership(ctx, args.workspaceId, args.userId);
    if (!target) throw errors.notFound("Member");
    // Same rule as role changes: owners manage everyone but the owner, admins manage below admin.
    if (!canManageRole(access.role, "viewer", target.role)) {
      throw errors.forbidden("You cannot remove this member.");
    }
    await ctx.db.delete("memberships", target._id);
    await resetDefaultIfNeeded(ctx, args.userId, args.workspaceId);
    await writeAudit(ctx, {
      action: "member.removed",
      actorId: access.userId,
      workspaceId: args.workspaceId,
      targetType: "user",
      targetId: args.userId,
      data: { role: target.role },
    });
    return null;
  },
});

export const leave = mutation({
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, args) => {
    const access = await requireMember(ctx, args.workspaceId, "viewer");
    if (access.role === "owner") {
      throw errors.forbidden("Transfer ownership before leaving, or delete the workspace.");
    }
    await ctx.db.delete("memberships", access.membership._id);
    await resetDefaultIfNeeded(ctx, access.userId, args.workspaceId);
    await writeAudit(ctx, {
      action: "member.left",
      actorId: access.userId,
      workspaceId: args.workspaceId,
    });
    return null;
  },
});
