import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { type MutationCtx, mutation, query } from "../_generated/server";
import { writeAudit } from "../lib/audit";
import { assertFeature, assertLimit, getWorkspacePlan, hasFeature } from "../lib/entitlements";
import { errors } from "../lib/errors";
import { getMembership, requireMember, requireUser } from "../lib/guards";
import { PLANS } from "../lib/plans";
import { rateLimiter } from "../lib/rateLimits";

const COLOR = /^#[0-9a-fA-F]{6}$/;

function validateName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length < 1 || trimmed.length > 60)
    throw errors.invalid("Name must be 1-60 characters.", "name");
  return trimmed;
}

function validateIcon(icon: string | undefined): void {
  if (icon !== undefined && (icon.length === 0 || icon.length > 32)) {
    throw errors.invalid("Icon must be 1-32 characters.", "icon");
  }
}

function view(
  workspace: Doc<"workspaces">,
  membership: Doc<"memberships">,
  defaultId?: Id<"workspaces">,
) {
  return {
    id: workspace._id,
    name: workspace.name,
    kind: workspace.kind,
    icon: workspace.icon ?? null,
    color: workspace.color ?? null,
    ownerId: workspace.ownerId,
    role: membership.role,
    isDefault: defaultId === workspace._id,
    joinedAt: membership.createdAt,
    createdAt: workspace.createdAt,
  };
}

/** Workspaces the signed-in user belongs to (personal first, then by name). */
export const list = query({
  args: {},
  handler: async (ctx) => {
    const user = await requireUser(ctx);
    const memberships = await ctx.db
      .query("memberships")
      .withIndex("by_user", (q) => q.eq("userId", user.userId))
      .collect();
    const out = [];
    for (const m of memberships) {
      const ws = await ctx.db.get("workspaces", m.workspaceId);
      if (ws) out.push(view(ws, m, user.profile?.defaultWorkspaceId));
    }
    out.sort((a, b) =>
      a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "personal" ? -1 : 1,
    );
    return out;
  },
});

export const get = query({
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, args) => {
    const access = await requireMember(ctx, args.workspaceId, "viewer");
    const plan = await getWorkspacePlan(ctx, args.workspaceId);
    const memberCount = (
      await ctx.db
        .query("memberships")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
        .collect()
    ).length;
    return {
      ...view(access.workspace, access.membership),
      plan,
      planName: PLANS[plan].name,
      memberCount,
      teamsEnabled: await hasFeature(ctx, access.workspace.ownerId, "teams"),
    };
  },
});

/** Create a team workspace (Pro / self-host). The creator becomes its owner. */
export const create = mutation({
  args: { name: v.string(), icon: v.optional(v.string()), color: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx, { verified: true });
    const name = validateName(args.name);
    validateIcon(args.icon);
    if (args.color && !COLOR.test(args.color))
      throw errors.invalid("Color must be #RRGGBB.", "color");
    await assertFeature(ctx, user, "teams");
    await assertLimit(ctx, user, "workspaces");
    const limited = await rateLimiter.limit(ctx, "workspaceCreate", { key: user.userId });
    if (!limited.ok) throw errors.rateLimited(limited.retryAfter, "workspaceCreate");
    const now = Date.now();
    const workspaceId = await ctx.db.insert("workspaces", {
      name,
      kind: "team",
      ownerId: user.userId,
      ...(args.icon ? { icon: args.icon } : {}),
      ...(args.color ? { color: args.color.toLowerCase() } : {}),
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("memberships", {
      workspaceId,
      userId: user.userId,
      role: "owner",
      createdAt: now,
      updatedAt: now,
    });
    await writeAudit(ctx, { action: "workspace.created", actorId: user.userId, workspaceId });
    return workspaceId;
  },
});

export const update = mutation({
  args: {
    workspaceId: v.id("workspaces"),
    name: v.optional(v.string()),
    icon: v.optional(v.union(v.string(), v.null())),
    color: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, args) => {
    const access = await requireMember(ctx, args.workspaceId, "admin");
    const patch: Partial<Doc<"workspaces">> = { updatedAt: Date.now() };
    if (args.name !== undefined) patch.name = validateName(args.name);
    if (args.icon !== undefined) {
      validateIcon(args.icon ?? undefined);
      patch.icon = args.icon ?? undefined;
    }
    if (args.color !== undefined) {
      if (args.color !== null && !COLOR.test(args.color))
        throw errors.invalid("Color must be #RRGGBB.", "color");
      patch.color = args.color?.toLowerCase() ?? undefined;
    }
    await ctx.db.patch("workspaces", args.workspaceId, patch);
    await writeAudit(ctx, {
      action: "workspace.updated",
      actorId: access.userId,
      workspaceId: args.workspaceId,
      data: { fields: Object.keys(patch).filter((k) => k !== "updatedAt") },
    });
    return null;
  },
});

/**
 * Delete a team workspace (owner only). Access is revoked immediately; designs and other workspace
 * data are purged in the background through the registered cleanup hooks.
 */
export const remove = mutation({
  args: { workspaceId: v.id("workspaces"), confirmName: v.string() },
  handler: async (ctx, args) => {
    const access = await requireMember(ctx, args.workspaceId, "owner");
    if (access.workspace.kind === "personal") {
      throw errors.forbidden(
        "Your personal workspace cannot be deleted. Delete your account instead.",
      );
    }
    if (args.confirmName.trim() !== access.workspace.name) {
      throw errors.invalid("Type the workspace name to confirm.", "confirmName");
    }
    const members = await ctx.db
      .query("memberships")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
      .collect();
    for (const m of members) {
      await ctx.db.delete("memberships", m._id);
      await resetDefaultIfNeeded(ctx, m.userId, args.workspaceId);
    }
    await writeAudit(ctx, {
      action: "workspace.deleted",
      actorId: access.userId,
      workspaceId: args.workspaceId,
      data: { name: access.workspace.name, members: members.length },
    });
    await ctx.scheduler.runAfter(0, internal.accounts.cleanup.purgeWorkspace, {
      workspaceId: args.workspaceId,
    });
    return null;
  },
});

/** When a user loses access to their default workspace, fall back to their personal one. */
export async function resetDefaultIfNeeded(
  ctx: MutationCtx,
  userId: string,
  workspaceId: Id<"workspaces">,
): Promise<void> {
  const profile = await ctx.db
    .query("profiles")
    .withIndex("by_userId", (q) => q.eq("userId", userId))
    .unique();
  if (!profile || profile.defaultWorkspaceId !== workspaceId) return;
  const personal = (
    await ctx.db
      .query("workspaces")
      .withIndex("by_owner", (q) => q.eq("ownerId", userId))
      .collect()
  ).find((w) => w.kind === "personal");
  await ctx.db.patch("profiles", profile._id, {
    defaultWorkspaceId: personal?._id,
    updatedAt: Date.now(),
  });
}

export const setDefault = mutation({
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, args) => {
    const access = await requireMember(ctx, args.workspaceId, "viewer");
    const user = await requireUser(ctx);
    if (user.profile) {
      await ctx.db.patch("profiles", user.profile._id, {
        defaultWorkspaceId: access.workspace._id,
        updatedAt: Date.now(),
      });
    }
    return null;
  },
});

/** Hand ownership to another member (owner only). The previous owner becomes an admin. */
export const transferOwnership = mutation({
  args: { workspaceId: v.id("workspaces"), userId: v.string() },
  handler: async (ctx, args) => {
    const access = await requireMember(ctx, args.workspaceId, "owner");
    if (access.workspace.kind === "personal")
      throw errors.forbidden("Personal workspaces cannot change owner.");
    if (args.userId === access.userId)
      throw errors.invalid("You already own this workspace.", "userId");
    const target = await getMembership(ctx, args.workspaceId, args.userId);
    if (!target) throw errors.notFound("Member");
    const now = Date.now();
    await ctx.db.patch("memberships", target._id, { role: "owner", updatedAt: now });
    await ctx.db.patch("memberships", access.membership._id, { role: "admin", updatedAt: now });
    await ctx.db.patch("workspaces", args.workspaceId, { ownerId: args.userId, updatedAt: now });
    await writeAudit(ctx, {
      action: "workspace.ownershipTransferred",
      actorId: access.userId,
      workspaceId: args.workspaceId,
      targetType: "user",
      targetId: args.userId,
    });
    return null;
  },
});
