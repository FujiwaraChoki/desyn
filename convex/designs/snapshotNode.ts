"use node";

import { diffOps } from "@desyn/doc-ops";
import { type Design, newId } from "@desyn/schema";
import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { type ActionCtx, internalAction } from "../_generated/server";
import { deleteBlob, getBlob, putBlob } from "../lib/designs_blob";
import { compressJson, decompressToString } from "../lib/designs_compress";
import {
  chunkOps,
  firstPageSize,
  initialHistory,
  pageCountOf,
  pageIds,
  utf8Length,
} from "../lib/designs_doc";
import { MAX_TX_BYTES } from "../lib/designs_limits";
import { materializeDesign } from "../lib/designs_materialize";
import type { CommitResult } from "../lib/designs_wire";
import { createLogger } from "../lib/logger";

// Node actions that need the whole design: snapshots (zstd via node:zlib), version restore / preview, and
// duplication of designs too large for a single mutation.

const reasonValidator = v.union(v.literal("auto"), v.literal("manual"), v.literal("version"));
const TX_CHUNK_BYTES = MAX_TX_BYTES - 4_000;

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Compress and store a design state, then record it. Returns the stored snapshot ref. */
async function storeSnapshot(
  ctx: ActionCtx,
  args: {
    designId: Id<"designs">;
    design: Design;
    seq: number;
    reason: "auto" | "manual" | "version";
    versionId?: Id<"versions">;
  },
): Promise<string> {
  const packed = compressJson(JSON.stringify(args.design));
  const key = await putBlob(
    ctx,
    `snapshots/${args.designId}/${args.seq}.json.${packed.ext}`,
    packed.bytes,
    packed.contentType,
  );
  const recorded = await ctx.runMutation(internal.designs.internal.recordSnapshot, {
    designId: args.designId,
    seq: args.seq,
    key,
    bytes: packed.bytes.length,
    compression: packed.compression,
    reason: args.reason,
    ...(args.versionId ? { versionId: args.versionId } : {}),
  });
  for (const ref of recorded.discard) {
    try {
      await deleteBlob(ctx, ref);
    } catch {
      // Orphaned blobs are harmless; the next prune retries.
    }
  }
  return recorded.key;
}

/**
 * Write a snapshot at `seq` (default: latest). Auto/manual snapshots are skipped when the latest snapshot is
 * already current (returns null). Version snapshots always resolve their version (ready or failed).
 */
export const run = internalAction({
  args: {
    designId: v.id("designs"),
    reason: reasonValidator,
    versionId: v.optional(v.id("versions")),
    seq: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<{ seq: number; key: string } | null> => {
    const log = createLogger(ctx, {
      fn: "designs.snapshot",
      designId: args.designId,
      reason: args.reason,
    });
    try {
      const m = await materializeDesign(ctx, args.designId, {
        ...(args.seq !== undefined ? { seq: args.seq } : {}),
        decode: decompressToString,
      });
      if (!m) return null;
      if (args.reason !== "version" && m.latestSnapshotSeq === m.seq) {
        await ctx.runMutation(internal.designs.internal.clearSnapshotSchedule, {
          designId: args.designId,
        });
        return null;
      }
      if (m.dropped > 0)
        log.warn("snapshot replay dropped operations", { dropped: m.dropped, seq: m.seq });
      const key = await storeSnapshot(ctx, {
        designId: args.designId,
        design: m.design,
        seq: m.seq,
        reason: args.reason,
        ...(args.versionId ? { versionId: args.versionId } : {}),
      });
      log.info("snapshot written", { seq: m.seq });
      return { seq: m.seq, key };
    } catch (err) {
      log.error("snapshot failed", { error: message(err) });
      await ctx.runMutation(internal.designs.internal.snapshotFailed, {
        designId: args.designId,
        ...(args.versionId ? { versionId: args.versionId } : {}),
        error: message(err),
      });
      if (args.reason === "manual") throw err;
      return null;
    } finally {
      await log.flush();
    }
  },
});

async function loadVersionDesign(ctx: ActionCtx, snapshotKey: string): Promise<Design> {
  const bytes = await getBlob(ctx, snapshotKey);
  if (!bytes) throw new Error("The version snapshot is missing.");
  return JSON.parse(decompressToString(bytes)) as Design;
}

/** JSON of the design as it was at a version (preview). */
export const versionJson = internalAction({
  args: { snapshotKey: v.string() },
  handler: async (ctx, args): Promise<string> =>
    JSON.stringify(await loadVersionDesign(ctx, args.snapshotKey)),
});

/**
 * Restore a version: save a restore point of the current state, then commit the diff current -> version
 * (split into several transactions when large; they share an actor.runId so clients undo them together).
 */
export const restore = internalAction({
  args: {
    designId: v.id("designs"),
    versionId: v.id("versions"),
    snapshotKey: v.string(),
    name: v.string(),
    userId: v.string(),
  },
  handler: async (ctx, args): Promise<{ seq: number }> => {
    const log = createLogger(ctx, { fn: "designs.restoreVersion", designId: args.designId });
    try {
      const target = await loadVersionDesign(ctx, args.snapshotKey);
      const current = await materializeDesign(ctx, args.designId, { decode: decompressToString });
      if (!current) throw new Error("The design no longer exists.");
      const restorePoint: Id<"versions"> = await ctx.runMutation(
        internal.designs.versions.createAuto,
        {
          designId: args.designId,
          seq: current.seq,
          name: `Before restoring "${args.name}"`.slice(0, 200),
          userId: args.userId,
        },
      );
      await storeSnapshot(ctx, {
        designId: args.designId,
        design: current.design,
        seq: current.seq,
        reason: "version",
        versionId: restorePoint,
      });

      const ops = diffOps(current.design, { ...target, id: current.design.id });
      let seq = current.seq;
      const runId = `restore-${args.versionId}`.slice(0, 64);
      for (const chunk of chunkOps(ops, TX_CHUNK_BYTES)) {
        const result: CommitResult = await ctx.runMutation(internal.designs.designs.commitAs, {
          designId: args.designId,
          userId: args.userId,
          baseSeq: seq,
          tx: JSON.stringify({
            id: newId(),
            label: `Restore version "${args.name}"`.slice(0, 200),
            ops: chunk,
            source: "system",
            actor: { runId },
            ts: Date.now(),
          }),
        });
        seq = result.seq;
      }
      log.info("version restored", { seq, ops: ops.length });
      return { seq };
    } finally {
      await log.flush();
    }
  },
});

/**
 * Fill a design shell (state "creating", see internal.beginShell) with a whole document in chunks: the
 * initial history from the empty base, then the node documents, then design-level state (which activates it).
 */
async function fillShell(
  ctx: ActionCtx,
  args: {
    targetId: Id<"designs">;
    design: Design;
    userId: string;
    sourceWorkspaceId: Id<"workspaces">;
    label: string;
    source: "system" | "import";
  },
): Promise<number> {
  const { chunks, result } = initialHistory(args.design, TX_CHUNK_BYTES);
  const now = Date.now();
  for (const chunk of chunks) {
    await ctx.runMutation(internal.designs.internal.appendShell, {
      designId: args.targetId,
      tx: JSON.stringify({
        id: newId(),
        label: args.label,
        ops: chunk.applied,
        source: args.source,
        actor: { userId: args.userId },
        ts: now,
      }),
      nodes: [],
    });
  }
  const pages = pageIds(result);
  let batch: { data: string; pageId: string | null }[] = [];
  let bytes = 0;
  for (const node of Object.values(result.nodes)) {
    const data = JSON.stringify(node);
    batch.push({ data, pageId: pages.get(node.id) ?? null });
    bytes += utf8Length(data);
    if (batch.length >= 500 || bytes >= 2_000_000) {
      await ctx.runMutation(internal.designs.internal.appendShell, {
        designId: args.targetId,
        nodes: batch,
      });
      batch = [];
      bytes = 0;
    }
  }
  if (batch.length > 0) {
    await ctx.runMutation(internal.designs.internal.appendShell, {
      designId: args.targetId,
      nodes: batch,
    });
  }
  const size = firstPageSize(result);
  await ctx.runMutation(internal.designs.internal.finishShell, {
    designId: args.targetId,
    assets: JSON.stringify(result.assets),
    styles: JSON.stringify(result.styles),
    meta: JSON.stringify(result.meta),
    ...(result.brandKitId !== undefined ? { brandKitId: result.brandKitId } : {}),
    pageCount: pageCountOf(result),
    width: size.width,
    height: size.height,
    sourceWorkspaceId: args.sourceWorkspaceId,
    userId: args.userId,
  });
  return Object.keys(result.nodes).length;
}

/** Build a large duplicate from the source's snapshot + log and insert it in chunks. */
export const duplicateLarge = internalAction({
  args: {
    sourceId: v.id("designs"),
    targetId: v.id("designs"),
    targetKey: v.string(),
    targetName: v.string(),
    sourceWorkspaceId: v.id("workspaces"),
    userId: v.string(),
  },
  handler: async (ctx, args) => {
    const log = createLogger(ctx, { fn: "designs.duplicateLarge", designId: args.sourceId });
    try {
      const m = await materializeDesign(ctx, args.sourceId, { decode: decompressToString });
      if (!m) throw new Error("The source design no longer exists.");
      const nodes = await fillShell(ctx, {
        targetId: args.targetId,
        design: { ...m.design, id: args.targetKey, name: args.targetName },
        userId: args.userId,
        sourceWorkspaceId: args.sourceWorkspaceId,
        label: "Duplicate design",
        source: "system",
      });
      log.info("large duplicate finished", { nodes });
    } catch (err) {
      log.error("large duplicate failed", { error: message(err) });
      await ctx.runMutation(internal.designs.maintenance.abortShell, { designId: args.targetId });
    } finally {
      await log.flush();
    }
    return null;
  },
});

/** Insert an imported document too large for one mutation (validated and cleaned by importDesign). */
export const importLarge = internalAction({
  args: {
    targetId: v.id("designs"),
    workspaceId: v.id("workspaces"),
    userId: v.string(),
    /** JSON of the cleaned Design (fresh key, sanitized markup, no URLs / foreign storage keys). */
    design: v.string(),
  },
  handler: async (ctx, args) => {
    const log = createLogger(ctx, { fn: "designs.importLarge", designId: args.targetId });
    try {
      const nodes = await fillShell(ctx, {
        targetId: args.targetId,
        design: JSON.parse(args.design) as Design,
        userId: args.userId,
        sourceWorkspaceId: args.workspaceId,
        label: "Import design",
        source: "import",
      });
      log.info("large import finished", { nodes });
    } catch (err) {
      log.error("large import failed", { error: message(err) });
      await ctx.runMutation(internal.designs.maintenance.abortShell, { designId: args.targetId });
    } finally {
      await log.flush();
    }
    return null;
  },
});
