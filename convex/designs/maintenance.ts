import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { internalAction, internalMutation, type MutationCtx } from "../_generated/server";
import { deleteBlob, deleteLocalBlobs } from "../lib/designs_blob";
import { OPS_RETENTION_MS, TRASH_RETENTION_MS } from "../lib/designs_limits";
import { createLogger } from "../lib/logger";
import { incrementUsage } from "../lib/usage";

// Background maintenance for designs: permanent deletion (trash purge, workspace deletion), log compaction,
// and the cleanup hooks registered with accounts/cleanup.ts.

type Done = { done: boolean };

/** Schedule deletion of blobs (Convex storage blobs are removed right away, S3 ones by an action). */
export async function scheduleBlobDeletion(ctx: MutationCtx, refs: string[]): Promise<void> {
  if (refs.length === 0) return;
  const remote = await deleteLocalBlobs(ctx, refs);
  if (remote.length > 0)
    await ctx.scheduler.runAfter(0, internal.designs.maintenance.deleteBlobs, { refs: remote });
}

/**
 * Permanently delete a design: the design row goes immediately (it disappears from every list and link),
 * dependent rows are removed in bounded batches by `purgeStep`.
 */
export async function startPurge(ctx: MutationCtx, design: Doc<"designs">): Promise<void> {
  const blobs = design.thumbnailKey ? [design.thumbnailKey] : [];
  if (design.state !== "trashed" && design.state !== "creating") {
    await incrementUsage(ctx, design.ownerId, "designs", -1);
  }
  await ctx.db.delete("designs", design._id);
  await scheduleBlobDeletion(ctx, blobs);
  await ctx.scheduler.runAfter(0, internal.designs.maintenance.purgeStep, { designId: design._id });
}

const BATCH = 200;

/** Delete one bounded batch of rows that belong to a deleted design. Returns true when nothing is left. */
async function purgeBatch(ctx: MutationCtx, designId: Id<"designs">): Promise<boolean> {
  const nodes = await ctx.db
    .query("nodes")
    .withIndex("by_design_node", (q) => q.eq("designId", designId))
    .take(BATCH * 2);
  for (const row of nodes) await ctx.db.delete("nodes", row._id);
  if (nodes.length > 0) return false;

  // Log entries can be large; keep batches small.
  const ops = await ctx.db
    .query("designOps")
    .withIndex("by_design_seq", (q) => q.eq("designId", designId))
    .take(20);
  for (const row of ops) await ctx.db.delete("designOps", row._id);
  if (ops.length > 0) return false;

  const snapshots = await ctx.db
    .query("designSnapshots")
    .withIndex("by_design_seq", (q) => q.eq("designId", designId))
    .take(BATCH);
  await scheduleBlobDeletion(
    ctx,
    snapshots.map((s) => s.key),
  );
  for (const row of snapshots) await ctx.db.delete("designSnapshots", row._id);
  if (snapshots.length > 0) return false;

  const exportsRows = await ctx.db
    .query("exports")
    .withIndex("by_design_created", (q) => q.eq("designId", designId))
    .take(BATCH);
  await scheduleBlobDeletion(
    ctx,
    exportsRows.flatMap((e) => e.files.map((f) => f.key)),
  );
  for (const row of exportsRows) await ctx.db.delete("exports", row._id);
  if (exportsRows.length > 0) return false;

  let deleted = 0;
  for (const row of await ctx.db
    .query("versions")
    .withIndex("by_design_created", (q) => q.eq("designId", designId))
    .take(BATCH)) {
    await ctx.db.delete("versions", row._id);
    deleted++;
  }
  for (const row of await ctx.db
    .query("shares")
    .withIndex("by_design", (q) => q.eq("designId", designId))
    .take(BATCH)) {
    await ctx.db.delete("shares", row._id);
    deleted++;
  }
  for (const row of await ctx.db
    .query("shareAccess")
    .withIndex("by_design", (q) => q.eq("designId", designId))
    .take(BATCH)) {
    await ctx.db.delete("shareAccess", row._id);
    deleted++;
  }
  for (const row of await ctx.db
    .query("designAssets")
    .withIndex("by_design", (q) => q.eq("designId", designId))
    .take(BATCH)) {
    await ctx.db.delete("designAssets", row._id);
    deleted++;
  }
  for (const row of await ctx.db
    .query("comments")
    .withIndex("by_design_root_activity", (q) => q.eq("designId", designId))
    .take(BATCH)) {
    await ctx.db.delete("comments", row._id);
    deleted++;
  }
  for (const row of await ctx.db
    .query("presence")
    .withIndex("by_design_expires", (q) => q.eq("designId", designId))
    .take(BATCH)) {
    await ctx.db.delete("presence", row._id);
    deleted++;
  }
  for (const row of await ctx.db
    .query("favorites")
    .withIndex("by_target", (q) => q.eq("targetType", "design").eq("targetId", designId))
    .take(BATCH)) {
    await ctx.db.delete("favorites", row._id);
    deleted++;
  }
  if (deleted > 0) return false;

  for (const row of await ctx.db
    .query("designSeq")
    .withIndex("by_design", (q) => q.eq("designId", designId))
    .collect()) {
    await ctx.db.delete("designSeq", row._id);
  }
  for (const row of await ctx.db
    .query("designState")
    .withIndex("by_design", (q) => q.eq("designId", designId))
    .collect()) {
    await ctx.db.delete("designState", row._id);
  }
  return true;
}

export const purgeStep = internalMutation({
  args: { designId: v.id("designs") },
  handler: async (ctx, args): Promise<Done> => {
    const done = await purgeBatch(ctx, args.designId);
    if (!done) await ctx.scheduler.runAfter(0, internal.designs.maintenance.purgeStep, args);
    return { done };
  },
});

export const deleteBlobs = internalAction({
  args: { refs: v.array(v.string()) },
  handler: async (ctx, args) => {
    const log = createLogger(ctx, { fn: "designs.deleteBlobs" });
    for (const ref of args.refs) {
      try {
        await deleteBlob(ctx, ref);
      } catch (err) {
        log.warn("blob delete failed", { error: err instanceof Error ? err.message : String(err) });
      }
    }
    await log.flush();
    return null;
  },
});

/** Cron: purge designs that have been in the trash longer than the retention window. */
export const purgeTrash = internalMutation({
  args: {},
  handler: async (ctx) => {
    const cutoff = Date.now() - TRASH_RETENTION_MS;
    const expired = await ctx.db
      .query("designs")
      .withIndex("by_state_deletedAt", (q) => q.eq("state", "trashed").lt("deletedAt", cutoff))
      .take(50);
    for (const design of expired) await startPurge(ctx, design);
    if (expired.length === 50)
      await ctx.scheduler.runAfter(0, internal.designs.maintenance.purgeTrash, {});
    return { purged: expired.length };
  },
});

/**
 * Cron: trim transactions older than the retention window that are covered by the design's latest snapshot.
 * Designs whose old transactions are not covered yet get a snapshot scheduled, so the next run can trim them.
 */
export const compactOps = internalMutation({
  args: {},
  handler: async (ctx) => {
    const cutoff = Date.now() - OPS_RETENTION_MS;
    const rows = await ctx.db
      .query("designOps")
      .withIndex("by_ts", (q) => q.lt("ts", cutoff))
      .take(500);
    const designs = new Map<string, Doc<"designs"> | null>();
    const needsSnapshot = new Set<Id<"designs">>();
    let trimmed = 0;
    for (const row of rows) {
      let design = designs.get(row.designId);
      if (design === undefined) {
        design = await ctx.db.get("designs", row.designId);
        designs.set(row.designId, design);
      }
      if (!design) continue; // a purge is removing it
      if (design.snapshot && row.seq <= design.snapshot.seq) {
        await ctx.db.delete("designOps", row._id);
        trimmed++;
      } else needsSnapshot.add(design._id);
    }
    for (const designId of needsSnapshot) {
      await ctx.scheduler.runAfter(0, internal.designs.snapshotNode.run, {
        designId,
        reason: "auto",
      });
    }
    return { trimmed, snapshots: needsSnapshot.size };
  },
});

// --- cleanup hooks (registered in accounts/cleanup.ts) -----------------------------------------------------

/** Workspace deletion: purge designs, retire assets, delete brand kits. Called until done. */
export const workspaceCleanup = internalMutation({
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, args): Promise<Done> => {
    const designs = await ctx.db
      .query("designs")
      .withIndex("by_workspace_state_updated", (q) => q.eq("workspaceId", args.workspaceId))
      .take(10);
    for (const design of designs) await startPurge(ctx, design);
    if (designs.length > 0) return { done: false };

    const now = Date.now();
    const assets = await ctx.db
      .query("assets")
      .withIndex("by_workspace_status_created", (q) => q.eq("workspaceId", args.workspaceId))
      .take(BATCH);
    let changed = 0;
    for (const asset of assets) {
      if (asset.status === "deleted") continue;
      await ctx.db.patch("assets", asset._id, {
        status: "deleted",
        deletedAt: now,
        updatedAt: now,
      });
      if (asset.status === "ready")
        await incrementUsage(ctx, asset.ownerId, "storageBytes", -asset.bytes);
      changed++;
    }
    if (changed > 0) return { done: false };

    const kits = await ctx.db
      .query("brandKits")
      .withIndex("by_workspace_updated", (q) => q.eq("workspaceId", args.workspaceId))
      .take(BATCH);
    for (const kit of kits) {
      await ctx.db.delete("brandKits", kit._id);
      await incrementUsage(ctx, kit.createdBy, "brandKits", -1);
    }
    return { done: kits.length === 0 };
  },
});

/** Folder deletion: designs inside deleted folders move to the workspace root. */
export const folderCleanup = internalMutation({
  args: { workspaceId: v.id("workspaces"), folderIds: v.array(v.id("folders")) },
  handler: async (ctx, args): Promise<Done> => {
    let moved = 0;
    for (const folderId of args.folderIds) {
      const rows = await ctx.db
        .query("designs")
        .withIndex("by_workspace_folder_state_updated", (q) =>
          q.eq("workspaceId", args.workspaceId).eq("folderId", folderId),
        )
        .take(BATCH - moved);
      for (const row of rows) await ctx.db.patch("designs", row._id, { folderId: undefined });
      moved += rows.length;
      if (moved >= BATCH) return { done: false };
    }
    return { done: moved === 0 };
  },
});

/** User deletion: personal rows (favorites, shared-with-me entries, presence). */
export const userCleanup = internalMutation({
  args: { userId: v.string() },
  handler: async (ctx, args): Promise<Done> => {
    let deleted = 0;
    for (const type of ["template", "design"] as const) {
      for (const row of await ctx.db
        .query("favorites")
        .withIndex("by_user_type_created", (q) =>
          q.eq("userId", args.userId).eq("targetType", type),
        )
        .take(BATCH)) {
        await ctx.db.delete("favorites", row._id);
        deleted++;
      }
    }
    for (const row of await ctx.db
      .query("shareAccess")
      .withIndex("by_user_lastOpened", (q) => q.eq("userId", args.userId))
      .take(BATCH)) {
      await ctx.db.delete("shareAccess", row._id);
      deleted++;
    }
    return { done: deleted === 0 };
  },
});

/** Remove a design that failed to finish chunked creation. */
export const abortShell = internalMutation({
  args: { designId: v.id("designs") },
  handler: async (ctx, args) => {
    const design = await ctx.db.get("designs", args.designId);
    if (design && design.state === "creating") await startPurge(ctx, design);
    return null;
  },
});
