import { defineTable } from "convex/server";
import { v } from "convex/values";

// Uploaded / generated files. Bytes live in S3 (`storageKey`); this table holds metadata. Owned by the designs agent.

export const assetKindValidator = v.union(
  v.literal("image"),
  v.literal("svg"),
  v.literal("font"),
  v.literal("video"),
  v.literal("audio"),
  v.literal("lottie"),
  v.literal("data"),
);

export const assetStatusValidator = v.union(
  v.literal("pending"),
  v.literal("ready"),
  v.literal("failed"),
  v.literal("deleted"),
);

export const assetSourceValidator = v.union(
  v.literal("upload"),
  v.literal("ai"),
  v.literal("stock"),
  v.literal("template"),
  v.literal("brand"),
);

export const assetsTables = {
  assets: defineTable({
    /** Absent for system assets (template library), which any design may reference. */
    workspaceId: v.optional(v.id("workspaces")),
    ownerId: v.string(),
    /**
     * Id used as `AssetRef.id` inside designs (12 chars [a-z0-9]). Unique per workspace; a design copied to
     * another workspace gets asset rows with the same refId (and storage key) there.
     */
    refId: v.string(),
    kind: assetKindValidator,
    name: v.string(),
    mime: v.string(),
    bytes: v.number(),
    width: v.optional(v.number()),
    height: v.optional(v.number()),
    durationMs: v.optional(v.number()),
    /** sha256 hex of the stored bytes (verified on finalize). */
    hash: v.optional(v.string()),
    storageKey: v.string(),
    status: assetStatusValidator,
    source: assetSourceValidator,
    attribution: v.optional(
      v.object({
        author: v.optional(v.string()),
        license: v.optional(v.string()),
        url: v.optional(v.string()),
      }),
    ),
    ai: v.optional(
      v.object({
        provider: v.string(),
        model: v.string(),
        prompt: v.string(),
        seed: v.optional(v.number()),
      }),
    ),
    family: v.optional(v.string()),
    weight: v.optional(v.number()),
    style: v.optional(v.union(v.literal("normal"), v.literal("italic"))),
    /** Whether the SVG sanitizer rewrote the upload. */
    sanitized: v.optional(v.boolean()),
    /** Set when the object bytes were removed from S3 (after delete + no remaining references). */
    purgedAt: v.optional(v.number()),
    error: v.optional(v.string()),
    uploadExpiresAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
    readyAt: v.optional(v.number()),
    deletedAt: v.optional(v.number()),
  })
    .index("by_workspace_refId", ["workspaceId", "refId"])
    .index("by_storageKey", ["storageKey"])
    .index("by_workspace_status_created", ["workspaceId", "status", "createdAt"])
    .index("by_workspace_kind_status_created", ["workspaceId", "kind", "status", "createdAt"])
    .index("by_workspace_hash", ["workspaceId", "hash"])
    .index("by_status_updated", ["status", "updatedAt"])
    .searchIndex("search_name", { searchField: "name", filterFields: ["workspaceId", "status"] }),
};
