import { defineTable } from "convex/server";
import { v } from "convex/values";

// Designs, their materialized node state, the canonical transaction log and everything hanging off a design
// (versions, snapshots, shares, asset references, export jobs). Owned by the designs agent.
//
// Design content (nodes, transactions, assets/styles/meta maps) is stored as JSON strings: Convex rejects
// object keys that start with "$" (ColorRef `{ "$var": … }`) or contain non-ASCII characters, both of which
// are legal in a Design (DOCUMENT_MODEL §2).

export const designStateValidator = v.union(
  v.literal("active"),
  v.literal("archived"),
  v.literal("trashed"),
  /** Being built by a chunked import / duplicate; hidden from every listing until finished. */
  v.literal("creating"),
);

export const sharePermissionValidator = v.union(
  v.literal("view"),
  v.literal("comment"),
  v.literal("edit"),
);

export const exportFormatValidator = v.union(
  v.literal("png"),
  v.literal("jpeg"),
  v.literal("webp"),
  v.literal("svg"),
  v.literal("pdf"),
  v.literal("pptx"),
  v.literal("gif"),
  v.literal("mp4"),
);

export const exportStatusValidator = v.union(
  v.literal("queued"),
  v.literal("rendering"),
  v.literal("ready"),
  v.literal("failed"),
  v.literal("expired"),
);

export const designsTables = {
  designs: defineTable({
    workspaceId: v.id("workspaces"),
    /** Better Auth user id of the creator. */
    ownerId: v.string(),
    folderId: v.optional(v.id("folders")),
    /** The `Design.id` (12 chars [a-z0-9]) used inside the document and by clients. */
    key: v.string(),
    kind: v.string(),
    name: v.string(),
    state: designStateValidator,
    pageCount: v.number(),
    /** Size of the first page in design px (dashboard cards). */
    width: v.number(),
    height: v.number(),
    thumbnailKey: v.optional(v.string()),
    thumbnailSeq: v.optional(v.number()),
    /** Latest snapshot (blob ref, see lib/designs_blob.ts) and the seq it captures. */
    snapshot: v.optional(v.object({ key: v.string(), seq: v.number() })),
    archivedAt: v.optional(v.number()),
    deletedAt: v.optional(v.number()),
    templateId: v.optional(v.id("templates")),
    brandKitId: v.optional(v.string()),
    /** Number of active (not revoked, not expired at creation) share links. */
    shareCount: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_key", ["key"])
    .index("by_workspace_state_updated", ["workspaceId", "state", "updatedAt"])
    .index("by_workspace_folder_state_updated", ["workspaceId", "folderId", "state", "updatedAt"])
    .index("by_workspace_owner_state_updated", ["workspaceId", "ownerId", "state", "updatedAt"])
    .index("by_state_deletedAt", ["state", "deletedAt"])
    .searchIndex("search_name", {
      searchField: "name",
      filterFields: ["workspaceId", "state"],
    }),

  /**
   * One small document per design holding the sequence counter. Every commit reads and writes only this
   * document plus the nodes it touches, so commits on different designs never contend.
   */
  designSeq: defineTable({
    designId: v.id("designs"),
    seq: v.number(),
    nodeCount: v.number(),
    /** Sum of node JSON sizes in bytes. */
    bytes: v.number(),
    lastCommitAt: v.number(),
    lastActor: v.optional(v.string()),
    /** When the scheduled auto snapshot runs (absent: none scheduled). */
    snapshotAt: v.optional(v.number()),
    /** When the scheduled thumbnail render runs (absent: none scheduled). */
    thumbnailAt: v.optional(v.number()),
  }).index("by_design", ["designId"]),

  /** Design-level fields of the document that are not nodes (JSON strings). Written only when they change. */
  designState: defineTable({
    designId: v.id("designs"),
    assets: v.string(),
    styles: v.string(),
    meta: v.string(),
    brandKitId: v.optional(v.string()),
  }).index("by_design", ["designId"]),

  /** Materialized node state: one document per `Node`. */
  nodes: defineTable({
    designId: v.id("designs"),
    nodeId: v.string(),
    /** Page containing the node (the page itself for pages, null for the root). */
    pageId: v.union(v.string(), v.null()),
    parentId: v.union(v.string(), v.null()),
    /** JSON of the Node. */
    data: v.string(),
    bytes: v.number(),
  })
    .index("by_design_node", ["designId", "nodeId"])
    .index("by_design_parent", ["designId", "parentId"])
    .index("by_design_page", ["designId", "pageId"]),

  /** Canonical transaction log. `tx` is the JSON of the accepted Transaction with `ops` = the applied ops. */
  designOps: defineTable({
    designId: v.id("designs"),
    seq: v.number(),
    txId: v.string(),
    tx: v.string(),
    /** JSON of the dropped list `{ index, reason }[]` returned to the committing client (idempotent replays). */
    dropped: v.string(),
    actor: v.optional(v.string()),
    source: v.string(),
    label: v.string(),
    ts: v.number(),
    bytes: v.number(),
  })
    .index("by_design_seq", ["designId", "seq"])
    .index("by_design_txId", ["designId", "txId"])
    .index("by_ts", ["ts"]),

  /** Compressed full-design snapshots (auto every 200 tx / 5 min of activity, on demand, and for versions). */
  designSnapshots: defineTable({
    designId: v.id("designs"),
    seq: v.number(),
    key: v.string(),
    bytes: v.number(),
    compression: v.union(v.literal("zstd"), v.literal("gzip")),
    reason: v.union(v.literal("auto"), v.literal("manual"), v.literal("version")),
    createdAt: v.number(),
  })
    .index("by_design_seq", ["designId", "seq"])
    .index("by_createdAt", ["createdAt"]),

  /** Version history entries (named by users or automatic restore points). */
  versions: defineTable({
    designId: v.id("designs"),
    name: v.string(),
    seq: v.number(),
    status: v.union(v.literal("pending"), v.literal("ready"), v.literal("failed")),
    snapshotKey: v.optional(v.string()),
    pageCount: v.number(),
    createdBy: v.string(),
    auto: v.boolean(),
    error: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_design_created", ["designId", "createdAt"])
    .index("by_design_seq", ["designId", "seq"]),

  /** Share links. Tokens are capability URLs shown to design managers. */
  shares: defineTable({
    designId: v.id("designs"),
    workspaceId: v.id("workspaces"),
    token: v.string(),
    permission: sharePermissionValidator,
    passwordHash: v.optional(v.string()),
    passwordSalt: v.optional(v.string()),
    expiresAt: v.optional(v.number()),
    label: v.optional(v.string()),
    createdBy: v.string(),
    revokedAt: v.optional(v.number()),
    lastUsedAt: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_token", ["token"])
    .index("by_design", ["designId"]),

  /**
   * Short-lived unlocks of password-protected share links (designs.unlockShare). Clients pass the grant
   * (`sg_...`) where they used to pass the password, so the password itself is only ever checked by the
   * rate-limited unlock mutation. Only the SHA-256 of the grant is stored.
   */
  shareGrants: defineTable({
    shareId: v.id("shares"),
    grantHash: v.string(),
    expiresAt: v.number(),
    createdAt: v.number(),
  })
    .index("by_hash", ["grantHash"])
    .index("by_share", ["shareId"]),

  /** Signed-in users who opened a design through a share link ("shared with me"). */
  shareAccess: defineTable({
    userId: v.string(),
    designId: v.id("designs"),
    shareId: v.id("shares"),
    permission: sharePermissionValidator,
    lastOpenedAt: v.number(),
  })
    .index("by_user_lastOpened", ["userId", "lastOpenedAt"])
    .index("by_user_design", ["userId", "designId"])
    .index("by_design", ["designId"])
    .index("by_share", ["shareId"]),

  /** Which uploaded assets a design references (via `AssetRef.id` == `assets.refId`). */
  designAssets: defineTable({
    designId: v.id("designs"),
    assetId: v.id("assets"),
    ref: v.string(),
  })
    .index("by_design", ["designId"])
    .index("by_design_ref", ["designId", "ref"])
    .index("by_asset", ["assetId"]),

  /** Export jobs rendered by the worker. */
  exports: defineTable({
    designId: v.id("designs"),
    workspaceId: v.id("workspaces"),
    userId: v.string(),
    format: exportFormatValidator,
    pages: v.union(v.literal("all"), v.array(v.string())),
    scale: v.number(),
    quality: v.optional(v.number()),
    background: v.optional(v.string()),
    pdf: v.optional(v.object({ bleed: v.boolean(), cropMarks: v.boolean(), cmyk: v.boolean() })),
    /** Additive (editor export dialog): gif / mp4 frame rate and PDF image resolution for the worker. */
    fps: v.optional(v.number()),
    dpi: v.optional(v.number()),
    status: exportStatusValidator,
    files: v.array(
      v.object({
        key: v.string(),
        pageId: v.optional(v.string()),
        fileName: v.string(),
        contentType: v.string(),
        bytes: v.number(),
      }),
    ),
    seq: v.optional(v.number()),
    notify: v.boolean(),
    attempts: v.number(),
    error: v.optional(v.string()),
    createdAt: v.number(),
    startedAt: v.optional(v.number()),
    finishedAt: v.optional(v.number()),
    expiresAt: v.optional(v.number()),
  })
    .index("by_design_created", ["designId", "createdAt"])
    .index("by_user_created", ["userId", "createdAt"])
    .index("by_status_created", ["status", "createdAt"])
    .index("by_status_expires", ["status", "expiresAt"]),
};
