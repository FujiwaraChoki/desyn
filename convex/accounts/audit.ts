import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import { internalMutation, query } from "../_generated/server";
import { requireMember, requireUser } from "../lib/guards";

export const AUDIT_RETENTION_MS = 365 * 24 * 60 * 60 * 1000;

function view(e: Doc<"audit">) {
  return {
    id: e._id,
    action: e.action,
    actorId: e.actorId ?? null,
    workspaceId: e.workspaceId ?? null,
    targetType: e.targetType ?? null,
    targetId: e.targetId ?? null,
    data: e.data ?? null,
    createdAt: e.createdAt,
  };
}

/** Security log of the signed-in user's own actions, newest first. */
export const mine = query({
  args: { paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const page = await ctx.db
      .query("audit")
      .withIndex("by_actor_createdAt", (q) => q.eq("actorId", user.userId))
      .order("desc")
      .paginate(args.paginationOpts);
    return { ...page, page: page.page.map(view) };
  },
});

/** Workspace activity log (admins). */
export const forWorkspace = query({
  args: { workspaceId: v.id("workspaces"), paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    await requireMember(ctx, args.workspaceId, "admin");
    const page = await ctx.db
      .query("audit")
      .withIndex("by_workspace_createdAt", (q) => q.eq("workspaceId", args.workspaceId))
      .order("desc")
      .paginate(args.paginationOpts);
    return { ...page, page: page.page.map(view) };
  },
});

/** Cron: delete audit entries older than a year, in batches. */
export const purgeOld = internalMutation({
  args: {},
  handler: async (ctx) => {
    const cutoff = Date.now() - AUDIT_RETENTION_MS;
    const rows = await ctx.db
      .query("audit")
      .withIndex("by_createdAt", (q) => q.lt("createdAt", cutoff))
      .take(1000);
    for (const row of rows) await ctx.db.delete("audit", row._id);
    return rows.length;
  },
});
