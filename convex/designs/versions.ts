import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  type ActionCtx,
  action,
  internalMutation,
  internalQuery,
  mutation,
  type QueryCtx,
  query,
} from "../_generated/server";
import {
  getDesignOrThrow,
  requireDesignPermission,
  requireDesignWriter,
  shareArg,
} from "../lib/designs_access";
import { getSeqDoc } from "../lib/designs_commit";
import { assertWorkspaceFeature, getWorkspacePlan } from "../lib/entitlements";
import { errors } from "../lib/errors";
import { getProfile } from "../lib/guards";
import { PLANS } from "../lib/plans";
import { scheduleBlobDeletion } from "./maintenance";

// versions.* : named versions (snapshots at a seq) and restore through a diff transaction.

const DAY_MS = 24 * 60 * 60_000;

/**
 * Oldest createdAt the workspace plan lets users see and restore (`versionHistoryDays`; null = unlimited).
 * Older versions are kept, not deleted, so an upgrade brings them back.
 */
async function versionWindow(
  ctx: QueryCtx,
  workspaceId: Id<"workspaces">,
): Promise<{ days: number; since: number } | null> {
  const days = PLANS[await getWorkspacePlan(ctx, workspaceId)].limits.versionHistoryDays;
  return days === null ? null : { days, since: Date.now() - days * DAY_MS };
}

function cleanVersionName(name: string): string {
  const trimmed = name.trim().replace(/\s+/g, " ");
  if (trimmed.length === 0 || trimmed.length > 100) {
    throw errors.invalid("Version names must be 1 to 100 characters.", "name");
  }
  return trimmed;
}

/** Save the current state as a named version (snapshot written in the background; status pending -> ready). */
export const create = mutation({
  args: { designId: v.id("designs"), name: v.string() },
  handler: async (ctx, args): Promise<Id<"versions">> => {
    const design = await getDesignOrThrow(ctx, args.designId);
    const access = await requireDesignWriter(ctx, design, "edit");
    await assertWorkspaceFeature(ctx, design.workspaceId, "versionHistory");
    const seqDoc = await getSeqDoc(ctx, design._id);
    const versionId = await ctx.db.insert("versions", {
      designId: design._id,
      name: cleanVersionName(args.name),
      seq: seqDoc.seq,
      status: "pending",
      pageCount: design.pageCount,
      createdBy: access.userId,
      auto: false,
      createdAt: Date.now(),
    });
    await ctx.scheduler.runAfter(0, internal.designs.snapshotNode.run, {
      designId: design._id,
      reason: "version",
      versionId,
      seq: seqDoc.seq,
    });
    return versionId;
  },
});

export const list = query({
  args: { designId: v.id("designs"), share: shareArg },
  handler: async (ctx, args) => {
    const design = await getDesignOrThrow(ctx, args.designId);
    await requireDesignPermission(ctx, design, "view", { share: args.share });
    const window = await versionWindow(ctx, design.workspaceId);
    const rows = await ctx.db
      .query("versions")
      .withIndex("by_design_created", (q) =>
        window
          ? q.eq("designId", design._id).gte("createdAt", window.since)
          : q.eq("designId", design._id),
      )
      .order("desc")
      .take(200);
    const names = new Map<string, string | null>();
    const out = [];
    for (const row of rows) {
      if (!names.has(row.createdBy)) {
        names.set(row.createdBy, (await getProfile(ctx, row.createdBy))?.name ?? null);
      }
      out.push({
        id: row._id,
        name: row.name,
        seq: row.seq,
        status: row.status,
        auto: row.auto,
        pageCount: row.pageCount,
        createdBy: row.createdBy,
        createdByName: names.get(row.createdBy) ?? null,
        createdAt: row.createdAt,
        error: row.error ?? null,
      });
    }
    return out;
  },
});

export const rename = mutation({
  args: { versionId: v.id("versions"), name: v.string() },
  handler: async (ctx, args) => {
    const version = await ctx.db.get("versions", args.versionId);
    if (!version) throw errors.notFound("Version");
    const design = await getDesignOrThrow(ctx, version.designId);
    await requireDesignWriter(ctx, design, "edit");
    await ctx.db.patch("versions", version._id, { name: cleanVersionName(args.name), auto: false });
    return null;
  },
});

export const remove = mutation({
  args: { versionId: v.id("versions") },
  handler: async (ctx, args) => {
    const version = await ctx.db.get("versions", args.versionId);
    if (!version) throw errors.notFound("Version");
    const design = await getDesignOrThrow(ctx, version.designId);
    await requireDesignWriter(ctx, design, "manage");
    await ctx.db.delete("versions", version._id);
    const others = await ctx.db
      .query("versions")
      .withIndex("by_design_seq", (q) => q.eq("designId", design._id).eq("seq", version.seq))
      .first();
    if (!others) {
      const snapshot = await ctx.db
        .query("designSnapshots")
        .withIndex("by_design_seq", (q) => q.eq("designId", design._id).eq("seq", version.seq))
        .first();
      // Keep the snapshot when it is the design's latest (it anchors replay of the log).
      if (snapshot && snapshot.reason === "version" && design.snapshot?.seq !== snapshot.seq) {
        await ctx.db.delete("designSnapshots", snapshot._id);
        await scheduleBlobDeletion(ctx, [snapshot.key]);
      }
    }
    return null;
  },
});

/** Internal: an automatic restore point (used before restoring a version). */
export const createAuto = internalMutation({
  args: { designId: v.id("designs"), seq: v.number(), name: v.string(), userId: v.string() },
  handler: async (ctx, args): Promise<Id<"versions">> => {
    const design = await ctx.db.get("designs", args.designId);
    if (!design) throw errors.notFound("Design");
    return await ctx.db.insert("versions", {
      designId: design._id,
      name: args.name,
      seq: args.seq,
      status: "pending",
      pageCount: design.pageCount,
      createdBy: args.userId,
      auto: true,
      createdAt: Date.now(),
    });
  },
});

export const forAction = internalQuery({
  args: {
    versionId: v.id("versions"),
    need: v.union(v.literal("view"), v.literal("edit")),
    share: shareArg,
  },
  handler: async (ctx, args) => {
    const version = await ctx.db.get("versions", args.versionId);
    if (!version) throw errors.notFound("Version");
    const design = await getDesignOrThrow(ctx, version.designId);
    const access = await requireDesignPermission(ctx, design, args.need, { share: args.share });
    if (args.need === "edit") {
      if (!access.userId) throw errors.unauthenticated();
      await assertWorkspaceFeature(ctx, design.workspaceId, "versionHistory");
    }
    const window = await versionWindow(ctx, design.workspaceId);
    if (window && version.createdAt < window.since) {
      throw errors.limit(
        "versionHistoryDays",
        window.days,
        Math.floor((Date.now() - version.createdAt) / DAY_MS),
      );
    }
    return {
      designId: design._id,
      userId: access.userId,
      name: version.name,
      status: version.status,
      snapshotKey: version.snapshotKey ?? null,
    };
  },
});

export async function restoreVersionHandler(
  ctx: ActionCtx,
  versionId: Id<"versions">,
): Promise<{ seq: number }> {
  const info = await ctx.runQuery(internal.designs.versions.forAction, { versionId, need: "edit" });
  if (info.status !== "ready" || !info.snapshotKey || !info.userId) {
    throw errors.conflict("This version is still being saved. Try again in a moment.");
  }
  return await ctx.runAction(internal.designs.snapshotNode.restore, {
    designId: info.designId,
    versionId,
    snapshotKey: info.snapshotKey,
    name: info.name,
    userId: info.userId,
  });
}

/** Restore a version (same as designs.restoreVersion). */
export const restore = action({
  args: { versionId: v.id("versions") },
  handler: async (ctx, args): Promise<{ seq: number }> =>
    await restoreVersionHandler(ctx, args.versionId),
});

/** The design JSON at a version, for previews. */
export const get = action({
  args: { versionId: v.id("versions"), share: shareArg },
  handler: async (ctx, args): Promise<{ design: string; name: string }> => {
    const info = await ctx.runQuery(internal.designs.versions.forAction, {
      versionId: args.versionId,
      need: "view",
      share: args.share,
    });
    if (info.status !== "ready" || !info.snapshotKey) {
      throw errors.conflict("This version is still being saved. Try again in a moment.");
    }
    const design: string = await ctx.runAction(internal.designs.snapshotNode.versionJson, {
      snapshotKey: info.snapshotKey,
    });
    return { design, name: info.name };
  },
});
