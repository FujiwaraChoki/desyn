import type { AssetRef, Design, DesignStyles, Node } from "@desyn/schema";
import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
} from "../_generated/server";
import { requireDesignPermission } from "../lib/designs_access";
import { resolveDesignAssetUrls } from "../lib/designs_assets";
import { blobUrl } from "../lib/designs_blob";
import { findAssetForWorkspace, getSeqDoc, linkDesignAsset } from "../lib/designs_commit";
import { utf8Length } from "../lib/designs_doc";
import { OPS_RETENTION_MS } from "../lib/designs_limits";
import { errors } from "../lib/errors";
import { incrementUsage } from "../lib/usage";

// Internal queries / mutations used by the designs actions (snapshots, versions, thumbnails, chunked
// creation) and helpers shared by the public design modules.

type DbCtx = QueryCtx | MutationCtx;

/** Read the whole materialized design (bounded designs only; large ones go through snapshots). */
export async function readFullDesign(ctx: DbCtx, design: Doc<"designs">): Promise<Design> {
  const nodes: Record<string, Node> = {};
  const docs = await ctx.db
    .query("nodes")
    .withIndex("by_design_node", (q) => q.eq("designId", design._id))
    .collect();
  for (const doc of docs) nodes[doc.nodeId] = JSON.parse(doc.data) as Node;
  const state = await ctx.db
    .query("designState")
    .withIndex("by_design", (q) => q.eq("designId", design._id))
    .unique();
  const out: Design = {
    schema: 1,
    id: design.key,
    name: design.name,
    kind: design.kind as Design["kind"],
    nodes,
    assets: state ? (JSON.parse(state.assets) as Record<string, AssetRef>) : {},
    styles: state
      ? (JSON.parse(state.styles) as DesignStyles)
      : { colors: {}, text: {}, effects: {}, variables: {} },
    meta: state ? (JSON.parse(state.meta) as Design["meta"]) : {},
  };
  if (state?.brandKitId !== undefined) out.brandKitId = state.brandKitId;
  return out;
}

/**
 * Give `toWorkspace` its own asset rows (same refId and storage key) for assets a copied design references,
 * so its URLs resolve there. The copy counts toward the new owner's storage.
 */
export async function copyAssetRowsToWorkspace(
  ctx: MutationCtx,
  refs: string[],
  fromWorkspace: Id<"workspaces">,
  toWorkspace: Id<"workspaces">,
  userId: string,
): Promise<void> {
  const now = Date.now();
  for (const ref of refs) {
    const existing = await ctx.db
      .query("assets")
      .withIndex("by_workspace_refId", (q) => q.eq("workspaceId", toWorkspace).eq("refId", ref))
      .first();
    if (existing) continue;
    const source = await findAssetForWorkspace(ctx, fromWorkspace, ref);
    if (!source || source.workspaceId === undefined || source.status !== "ready") continue;
    const { _id, _creationTime, ...fields } = source;
    await ctx.db.insert("assets", {
      ...fields,
      workspaceId: toWorkspace,
      ownerId: userId,
      createdAt: now,
      updatedAt: now,
    });
    await incrementUsage(ctx, userId, "storageBytes", source.bytes);
  }
}

/** Access check for actions (auth propagates from the action into this query). */
export const checkAccess = internalQuery({
  args: {
    designId: v.id("designs"),
    need: v.union(v.literal("view"), v.literal("comment"), v.literal("edit"), v.literal("manage")),
    userId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const design = await ctx.db.get("designs", args.designId);
    if (!design || design.state === "creating") throw errors.notFound("Design");
    const access = await requireDesignPermission(ctx, design, args.need, {
      ...(args.userId ? { userId: args.userId } : {}),
    });
    return {
      userId: access.userId,
      permission: access.permission,
      workspaceId: design.workspaceId,
      name: design.name,
    };
  },
});

/** Where to start rebuilding a design at `maxSeq` (default: latest). */
export const snapshotBase = internalQuery({
  args: { designId: v.id("designs"), maxSeq: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const design = await ctx.db.get("designs", args.designId);
    if (!design) return null;
    const seqDoc = await ctx.db
      .query("designSeq")
      .withIndex("by_design", (q) => q.eq("designId", design._id))
      .unique();
    if (!seqDoc) return null;
    const target = Math.min(args.maxSeq ?? seqDoc.seq, seqDoc.seq);
    const snapshot = await ctx.db
      .query("designSnapshots")
      .withIndex("by_design_seq", (q) => q.eq("designId", design._id).lte("seq", target))
      .order("desc")
      .first();
    return {
      key: design.key,
      kind: design.kind,
      workspaceId: design.workspaceId,
      state: design.state,
      seq: seqDoc.seq,
      target,
      nodeCount: seqDoc.nodeCount,
      latestSnapshotSeq: design.snapshot?.seq ?? null,
      snapshot: snapshot ? { key: snapshot.key, seq: snapshot.seq } : null,
    };
  },
});

/** Accepted transactions with after < seq <= upTo, stopping after ~maxBytes. */
export const opsRange = internalQuery({
  args: {
    designId: v.id("designs"),
    after: v.number(),
    upTo: v.number(),
    maxBytes: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = args.maxBytes ?? 4_000_000;
    const out: { seq: number; tx: string }[] = [];
    let bytes = 0;
    const rows = ctx.db
      .query("designOps")
      .withIndex("by_design_seq", (q) =>
        q.eq("designId", args.designId).gt("seq", args.after).lte("seq", args.upTo),
      );
    for await (const row of rows) {
      out.push({ seq: row.seq, tx: row.tx });
      bytes += row.bytes;
      if (bytes >= limit) break;
    }
    return out;
  },
});

/** Record a written snapshot; prunes old auto snapshots and compacts the log behind it. */
export const recordSnapshot = internalMutation({
  args: {
    designId: v.id("designs"),
    seq: v.number(),
    key: v.string(),
    bytes: v.number(),
    compression: v.union(v.literal("zstd"), v.literal("gzip")),
    reason: v.union(v.literal("auto"), v.literal("manual"), v.literal("version")),
    versionId: v.optional(v.id("versions")),
  },
  handler: async (ctx, args): Promise<{ key: string; discard: string[] }> => {
    const design = await ctx.db.get("designs", args.designId);
    if (!design) return { key: args.key, discard: [args.key] };
    const discard: string[] = [];
    const now = Date.now();
    const same = await ctx.db
      .query("designSnapshots")
      .withIndex("by_design_seq", (q) => q.eq("designId", design._id).eq("seq", args.seq))
      .first();
    let key = args.key;
    if (same) {
      key = same.key;
      if (same.key !== args.key) discard.push(args.key);
      if (args.reason === "version" && same.reason === "auto") {
        await ctx.db.patch("designSnapshots", same._id, { reason: "version" });
      }
    } else {
      await ctx.db.insert("designSnapshots", {
        designId: design._id,
        seq: args.seq,
        key,
        bytes: args.bytes,
        compression: args.compression,
        reason: args.reason,
        createdAt: now,
      });
    }
    if (!design.snapshot || args.seq > design.snapshot.seq) {
      await ctx.db.patch("designs", design._id, { snapshot: { key, seq: args.seq } });
    }
    if (args.versionId) {
      const version = await ctx.db.get("versions", args.versionId);
      if (version)
        await ctx.db.patch("versions", version._id, { status: "ready", snapshotKey: key });
    }
    const seqDoc = await getSeqDoc(ctx, design._id);
    if (
      args.reason === "auto" &&
      seqDoc.snapshotAt !== undefined &&
      seqDoc.snapshotAt <= now + 1_000
    ) {
      await ctx.db.patch("designSeq", seqDoc._id, { snapshotAt: undefined });
    }

    // Older auto snapshots outside the retention window are no longer needed (versions keep their own).
    const cutoff = now - OPS_RETENTION_MS;
    const older = await ctx.db
      .query("designSnapshots")
      .withIndex("by_design_seq", (q) => q.eq("designId", design._id).lt("seq", args.seq))
      .take(50);
    const latestSeq = Math.max(args.seq, design.snapshot?.seq ?? 0);
    for (const row of older) {
      if (row.reason !== "auto" || row.createdAt >= cutoff || row.seq === latestSeq) continue;
      discard.push(row.key);
      await ctx.db.delete("designSnapshots", row._id);
    }
    // Compact the log: transactions covered by this snapshot and older than the retention window.
    const covered = await ctx.db
      .query("designOps")
      .withIndex("by_design_seq", (q) => q.eq("designId", design._id).lte("seq", args.seq))
      .take(500);
    for (const row of covered) {
      if (row.ts < cutoff) await ctx.db.delete("designOps", row._id);
    }
    return { key, discard };
  },
});

/** A snapshot attempt failed: unblock scheduling and mark the version. */
export const snapshotFailed = internalMutation({
  args: { designId: v.id("designs"), versionId: v.optional(v.id("versions")), error: v.string() },
  handler: async (ctx, args) => {
    const seqDoc = await ctx.db
      .query("designSeq")
      .withIndex("by_design", (q) => q.eq("designId", args.designId))
      .unique();
    if (seqDoc?.snapshotAt !== undefined)
      await ctx.db.patch("designSeq", seqDoc._id, { snapshotAt: undefined });
    if (args.versionId) {
      const version = await ctx.db.get("versions", args.versionId);
      if (version) {
        await ctx.db.patch("versions", version._id, {
          status: "failed",
          error: args.error.slice(0, 500),
        });
      }
    }
    return null;
  },
});

/** Clear the snapshot schedule when there was nothing new to capture. */
export const clearSnapshotSchedule = internalMutation({
  args: { designId: v.id("designs") },
  handler: async (ctx, args) => {
    const seqDoc = await ctx.db
      .query("designSeq")
      .withIndex("by_design", (q) => q.eq("designId", args.designId))
      .unique();
    if (seqDoc?.snapshotAt !== undefined && seqDoc.snapshotAt <= Date.now() + 1_000) {
      await ctx.db.patch("designSeq", seqDoc._id, { snapshotAt: undefined });
    }
    return null;
  },
});

/** URLs the render worker needs for a design's assets. */
export const assetUrls = internalQuery({
  args: { designId: v.id("designs") },
  handler: async (ctx, args): Promise<Record<string, string>> => {
    const design = await ctx.db.get("designs", args.designId);
    if (!design) return {};
    return await resolveDesignAssetUrls(ctx, design);
  },
});

// --- thumbnails -------------------------------------------------------------------------------------------

export const beginThumbnail = internalMutation({
  args: { designId: v.id("designs") },
  handler: async (ctx, args) => {
    const design = await ctx.db.get("designs", args.designId);
    if (!design || design.state === "creating") return null;
    const seqDoc = await getSeqDoc(ctx, design._id);
    if (seqDoc.thumbnailAt !== undefined)
      await ctx.db.patch("designSeq", seqDoc._id, { thumbnailAt: undefined });
    return { seq: seqDoc.seq, thumbnailSeq: design.thumbnailSeq ?? null };
  },
});

export const setThumbnail = internalMutation({
  args: { designId: v.id("designs"), key: v.string(), seq: v.number() },
  handler: async (ctx, args): Promise<{ discard: string | null }> => {
    const design = await ctx.db.get("designs", args.designId);
    if (!design) return { discard: args.key };
    if (design.thumbnailSeq !== undefined && design.thumbnailSeq > args.seq)
      return { discard: args.key };
    await ctx.db.patch("designs", design._id, { thumbnailKey: args.key, thumbnailSeq: args.seq });
    return {
      discard: design.thumbnailKey && design.thumbnailKey !== args.key ? design.thumbnailKey : null,
    };
  },
});

// --- chunked creation (large duplicates) ----------------------------------------------------------------

export const beginShell = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    ownerId: v.string(),
    folderId: v.optional(v.id("folders")),
    key: v.string(),
    name: v.string(),
    kind: v.string(),
    templateId: v.optional(v.id("templates")),
  },
  handler: async (ctx, args): Promise<Id<"designs">> => {
    const now = Date.now();
    const designId = await ctx.db.insert("designs", {
      workspaceId: args.workspaceId,
      ownerId: args.ownerId,
      ...(args.folderId ? { folderId: args.folderId } : {}),
      key: args.key,
      kind: args.kind,
      name: args.name,
      state: "creating",
      pageCount: 0,
      width: 0,
      height: 0,
      ...(args.templateId ? { templateId: args.templateId } : {}),
      shareCount: 0,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("designSeq", {
      designId,
      seq: 0,
      nodeCount: 0,
      bytes: 0,
      lastCommitAt: now,
    });
    await ctx.db.insert("designState", {
      designId,
      assets: "{}",
      styles: '{"colors":{},"text":{},"effects":{},"variables":{}}',
      meta: "{}",
    });
    return designId;
  },
});

/** Append one history transaction and/or a batch of nodes to a design being created. */
export const appendShell = internalMutation({
  args: {
    designId: v.id("designs"),
    /** JSON of an accepted Transaction (ops = applied ops). */
    tx: v.optional(v.string()),
    nodes: v.array(v.object({ data: v.string(), pageId: v.union(v.string(), v.null()) })),
  },
  handler: async (ctx, args) => {
    const design = await ctx.db.get("designs", args.designId);
    if (design?.state !== "creating") throw errors.conflict("The design is not being created.");
    const seqDoc = await getSeqDoc(ctx, design._id);
    let seq = seqDoc.seq;
    if (args.tx) {
      const tx = JSON.parse(args.tx) as {
        id: string;
        label: string;
        source: string;
        actor?: { userId?: string };
      };
      seq++;
      await ctx.db.insert("designOps", {
        designId: design._id,
        seq,
        txId: tx.id,
        tx: args.tx,
        dropped: "[]",
        ...(tx.actor?.userId ? { actor: tx.actor.userId } : {}),
        source: tx.source,
        label: tx.label,
        ts: Date.now(),
        bytes: utf8Length(args.tx),
      });
    }
    let bytes = 0;
    for (const n of args.nodes) {
      const node = JSON.parse(n.data) as Node;
      const size = utf8Length(n.data);
      bytes += size;
      await ctx.db.insert("nodes", {
        designId: design._id,
        nodeId: node.id,
        pageId: n.pageId,
        parentId: node.parent,
        data: n.data,
        bytes: size,
      });
    }
    await ctx.db.patch("designSeq", seqDoc._id, {
      seq,
      nodeCount: seqDoc.nodeCount + args.nodes.length,
      bytes: seqDoc.bytes + bytes,
    });
    return null;
  },
});

export const finishShell = internalMutation({
  args: {
    designId: v.id("designs"),
    assets: v.string(),
    styles: v.string(),
    meta: v.string(),
    brandKitId: v.optional(v.string()),
    pageCount: v.number(),
    width: v.number(),
    height: v.number(),
    sourceWorkspaceId: v.id("workspaces"),
    userId: v.string(),
  },
  handler: async (ctx, args) => {
    const design = await ctx.db.get("designs", args.designId);
    if (design?.state !== "creating") throw errors.conflict("The design is not being created.");
    const state = await ctx.db
      .query("designState")
      .withIndex("by_design", (q) => q.eq("designId", design._id))
      .unique();
    if (state) {
      await ctx.db.patch("designState", state._id, {
        assets: args.assets,
        styles: args.styles,
        meta: args.meta,
        ...(args.brandKitId !== undefined ? { brandKitId: args.brandKitId } : {}),
      });
    }
    const refs = Object.keys(JSON.parse(args.assets) as Record<string, unknown>);
    if (args.sourceWorkspaceId !== design.workspaceId) {
      await copyAssetRowsToWorkspace(
        ctx,
        refs,
        args.sourceWorkspaceId,
        design.workspaceId,
        args.userId,
      );
    }
    for (const ref of refs) await linkDesignAsset(ctx, design, ref);
    await ctx.db.patch("designs", design._id, {
      state: "active",
      pageCount: args.pageCount,
      width: args.width,
      height: args.height,
      ...(args.brandKitId !== undefined ? { brandKitId: args.brandKitId } : {}),
      updatedAt: Date.now(),
    });
    await incrementUsage(ctx, design.ownerId, "designs", 1);
    return null;
  },
});

/** Link-preview metadata for a share token (routes/og.ts). Password-protected links reveal nothing. */
export const ogMeta = internalQuery({
  args: { token: v.string() },
  handler: async (ctx, args) => {
    const share = await ctx.db
      .query("shares")
      .withIndex("by_token", (q) => q.eq("token", args.token))
      .unique();
    if (!share || share.revokedAt) return null;
    if (share.expiresAt !== undefined && share.expiresAt <= Date.now()) return null;
    const design = await ctx.db.get("designs", share.designId);
    if (!design || design.state === "trashed" || design.state === "creating") return null;
    if (share.passwordHash) return { protected: true as const };
    const workspace = await ctx.db.get("workspaces", design.workspaceId);
    return {
      protected: false as const,
      name: design.name,
      kind: design.kind,
      pageCount: design.pageCount,
      width: design.width,
      height: design.height,
      permission: share.permission,
      workspaceName: workspace?.name ?? null,
      thumbnailUrl: design.thumbnailKey ? await blobUrl(ctx, design.thumbnailKey) : null,
      updatedAt: design.updatedAt,
    };
  },
});
