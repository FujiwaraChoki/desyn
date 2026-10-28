import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { type MutationCtx, mutation } from "../_generated/server";
import { scheduleBlobDeletion } from "../designs/maintenance";
import { getDesignOrThrow, requireDesignWriter } from "../lib/designs_access";
import { getSeqDoc } from "../lib/designs_commit";
import { hasFeature } from "../lib/entitlements";

// Autosaved versions for the editor's version history (packages/editor src/collab/versions/autosave.tsx).
// Editing clients call `autosave` every few minutes while their user edits; the server decides whether a new
// automatic version is due, so several open clients never create duplicates. Autosaves are ordinary `versions`
// rows with `auto: true` (snapshot written by `designs.snapshotNode.run`, like named versions).

/** Name of autosaved versions (the UI shows the time next to it). */
export const AUTOSAVE_NAME = "Autosave";
/** At most one autosave per design in this window (any version counts, named ones included). */
export const AUTOSAVE_MIN_INTERVAL_MS = 10 * 60_000;
/** Autosaves kept per design; older ones are pruned (named versions and restore points are never pruned). */
export const AUTOSAVE_KEEP = 60;
const PRUNE_PER_CALL = 5;

async function pruneAutosaves(ctx: MutationCtx, design: Doc<"designs">): Promise<void> {
  const rows = await ctx.db
    .query("versions")
    .withIndex("by_design_created", (q) => q.eq("designId", design._id))
    .order("desc")
    .take(400);
  const autosaves = rows.filter((r) => r.auto && r.name === AUTOSAVE_NAME);
  const stale = autosaves.slice(AUTOSAVE_KEEP, AUTOSAVE_KEEP + PRUNE_PER_CALL);
  for (const version of stale) {
    await ctx.db.delete("versions", version._id);
    const shared = await ctx.db
      .query("versions")
      .withIndex("by_design_seq", (q) => q.eq("designId", design._id).eq("seq", version.seq))
      .first();
    if (shared) continue;
    const snapshot = await ctx.db
      .query("designSnapshots")
      .withIndex("by_design_seq", (q) => q.eq("designId", design._id).eq("seq", version.seq))
      .first();
    // Same rule as versions.remove: keep the design's latest snapshot (it anchors log replay).
    if (snapshot && snapshot.reason === "version" && design.snapshot?.seq !== snapshot.seq) {
      await ctx.db.delete("designSnapshots", snapshot._id);
      await scheduleBlobDeletion(ctx, [snapshot.key]);
    }
  }
}

export const autosave = mutation({
  args: { designId: v.id("designs") },
  handler: async (
    ctx,
    args,
  ): Promise<{
    versionId: Id<"versions"> | null;
    skipped: "unchanged" | "recent" | "unavailable" | null;
  }> => {
    const design = await getDesignOrThrow(ctx, args.designId);
    const access = await requireDesignWriter(ctx, design, "edit");
    const workspace = await ctx.db.get("workspaces", design.workspaceId);
    if (!workspace || !(await hasFeature(ctx, workspace.ownerId, "versionHistory"))) {
      return { versionId: null, skipped: "unavailable" };
    }
    if (design.state !== "active") return { versionId: null, skipped: "unavailable" };
    const seqDoc = await getSeqDoc(ctx, design._id);
    const latest = await ctx.db
      .query("versions")
      .withIndex("by_design_created", (q) => q.eq("designId", design._id))
      .order("desc")
      .first();
    if (latest && latest.seq >= seqDoc.seq) return { versionId: null, skipped: "unchanged" };
    const now = Date.now();
    if (latest && now - latest.createdAt < AUTOSAVE_MIN_INTERVAL_MS) {
      return { versionId: null, skipped: "recent" };
    }
    if (seqDoc.seq === 0) return { versionId: null, skipped: "unchanged" };
    const versionId = await ctx.db.insert("versions", {
      designId: design._id,
      name: AUTOSAVE_NAME,
      seq: seqDoc.seq,
      status: "pending",
      pageCount: design.pageCount,
      createdBy: access.userId,
      auto: true,
      createdAt: now,
    });
    await ctx.scheduler.runAfter(0, internal.designs.snapshotNode.run, {
      designId: design._id,
      reason: "version",
      versionId,
      seq: seqDoc.seq,
    });
    await pruneAutosaves(ctx, design);
    return { versionId, skipped: null };
  },
});
