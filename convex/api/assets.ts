import type { AssetRef } from "@desyn/schema";
import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import {
  internalAction,
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
} from "../_generated/server";
import {
  assetView,
  finalizeUpload,
  requestUploadFor,
  requireAssetAccess,
  urlFor,
} from "../assets/assets";
import { idOf, principalValidator } from "../lib/api_principal";
import { signedUrlExpiry } from "../lib/designs_assets";
import { MAX_NAME_LENGTH } from "../lib/designs_limits";
import { s3Config } from "../lib/designs_s3";
import { errors } from "../lib/errors";
import { requireMember } from "../lib/guards";
import { incrementUsage } from "../lib/usage";
import { assetKindValidator } from "../tables/assets";

// Agent API: asset library (two-step uploads through presigned PUT URLs, list, get, rename, delete).

type DbCtx = QueryCtx | MutationCtx;

/** The AssetRef a design uses for this asset (DOCUMENT_MODEL §2); `url` is never persisted. */
function assetRefOf(asset: Doc<"assets">): AssetRef {
  return {
    id: asset.refId,
    kind: asset.kind,
    storageKey: asset.storageKey,
    mime: asset.mime,
    bytes: asset.bytes,
    ...(asset.width !== undefined ? { width: asset.width } : {}),
    ...(asset.height !== undefined ? { height: asset.height } : {}),
    ...(asset.durationMs !== undefined ? { durationMs: asset.durationMs } : {}),
    ...(asset.hash !== undefined ? { hash: asset.hash } : {}),
    name: asset.name,
    source: asset.source,
    ...(asset.attribution ? { attribution: asset.attribution } : {}),
    ...(asset.ai ? { ai: asset.ai } : {}),
    ...(asset.family !== undefined ? { family: asset.family } : {}),
    ...(asset.weight !== undefined ? { weight: asset.weight } : {}),
    ...(asset.style !== undefined ? { style: asset.style } : {}),
  };
}

export function apiAssetView(asset: Doc<"assets">, now = Date.now()) {
  const view = assetView(asset, urlFor(asset, now));
  return {
    id: view.id,
    refId: view.refId,
    kind: view.kind,
    name: view.name,
    mime: view.mime,
    bytes: view.bytes,
    width: view.width,
    height: view.height,
    durationMs: view.durationMs,
    hash: view.hash,
    status: view.status,
    source: view.source,
    url: view.url,
    urlExpiresAt: view.url ? (s3Config()?.publicBaseUrl ? null : signedUrlExpiry(now)) : null,
    assetRef: assetRefOf(asset),
    createdAt: view.createdAt,
    updatedAt: view.updatedAt,
  };
}

/** An asset of the principal's workspace (other workspaces' assets are NOT_FOUND for this key). */
async function assetOf(
  ctx: DbCtx,
  workspaceId: Id<"workspaces">,
  raw: string,
): Promise<Doc<"assets">> {
  const asset = await ctx.db.get("assets", idOf(ctx, "assets", raw, "Asset"));
  if (!asset || asset.workspaceId !== workspaceId || asset.status === "deleted") {
    throw errors.notFound("Asset");
  }
  return asset;
}

export const list = internalQuery({
  args: {
    principal: principalValidator,
    kind: v.optional(assetKindValidator),
    search: v.optional(v.string()),
    numItems: v.number(),
    cursor: v.union(v.string(), v.null()),
  },
  handler: async (ctx, args) => {
    const workspaceId = args.principal.workspaceId;
    await requireMember(ctx, workspaceId, "viewer", { userId: args.principal.userId });
    const opts = { numItems: args.numItems, cursor: args.cursor };
    const search = args.search?.trim();
    const page = search
      ? await ctx.db
          .query("assets")
          .withSearchIndex("search_name", (q) =>
            q.search("name", search).eq("workspaceId", workspaceId).eq("status", "ready"),
          )
          .paginate(opts)
      : args.kind
        ? await ctx.db
            .query("assets")
            .withIndex("by_workspace_kind_status_created", (q) =>
              q
                .eq("workspaceId", workspaceId)
                .eq("kind", args.kind as Doc<"assets">["kind"])
                .eq("status", "ready"),
            )
            .order("desc")
            .paginate(opts)
        : await ctx.db
            .query("assets")
            .withIndex("by_workspace_status_created", (q) =>
              q.eq("workspaceId", workspaceId).eq("status", "ready"),
            )
            .order("desc")
            .paginate(opts);
    const now = Date.now();
    return {
      items: page.page
        .filter((a) => !args.kind || a.kind === args.kind)
        .map((a) => apiAssetView(a, now)),
      nextCursor: page.isDone ? null : page.continueCursor,
    };
  },
});

export const get = internalQuery({
  args: { principal: principalValidator, assetId: v.string() },
  handler: async (ctx, args) => {
    const asset = await assetOf(ctx, args.principal.workspaceId, args.assetId);
    await requireAssetAccess(ctx, asset, "viewer", { userId: args.principal.userId });
    return apiAssetView(asset);
  },
});

/** Find a ready asset by API id or by `AssetRef.id` (refId) within the workspace. */
export async function findWorkspaceAsset(
  ctx: DbCtx,
  workspaceId: Id<"workspaces">,
  ref: string,
): Promise<Doc<"assets"> | null> {
  const id = ctx.db.normalizeId("assets", ref);
  if (id) {
    const asset = await ctx.db.get("assets", id);
    if (asset?.workspaceId === workspaceId && asset.status === "ready") return asset;
  }
  if (!/^[a-z0-9]{12}$/.test(ref)) return null;
  return await ctx.db
    .query("assets")
    .withIndex("by_workspace_refId", (q) => q.eq("workspaceId", workspaceId).eq("refId", ref))
    .filter((q) => q.eq(q.field("status"), "ready"))
    .first();
}

export const requestUpload = internalMutation({
  args: {
    principal: principalValidator,
    name: v.string(),
    mime: v.string(),
    bytes: v.number(),
    sha256: v.optional(v.string()),
    declaredKind: v.optional(v.union(v.literal("lottie"), v.literal("data"))),
    source: v.optional(v.union(v.literal("upload"), v.literal("brand"))),
    family: v.optional(v.string()),
    weight: v.optional(v.number()),
    style: v.optional(v.union(v.literal("normal"), v.literal("italic"))),
  },
  handler: async (ctx, args) => {
    const { principal, ...rest } = args;
    return await requestUploadFor(
      ctx,
      { ...rest, workspaceId: principal.workspaceId },
      { userId: principal.userId },
    );
  },
});

/** Assets of the workspace by id (internal; used after finalize, which may return a deduplicated asset). */
export const byId = internalQuery({
  args: { principal: principalValidator, assetId: v.id("assets") },
  handler: async (ctx, args) => {
    const asset = await ctx.db.get("assets", args.assetId);
    if (!asset || asset.workspaceId !== args.principal.workspaceId) throw errors.notFound("Asset");
    return apiAssetView(asset);
  },
});

/** Resolve an asset id of the principal's workspace (any status), for finalize. */
export const ownAssetId = internalQuery({
  args: { principal: principalValidator, assetId: v.string() },
  handler: async (ctx, args): Promise<Id<"assets">> => {
    const id = idOf(ctx, "assets", args.assetId, "Asset");
    const asset = await ctx.db.get("assets", id);
    if (!asset || asset.workspaceId !== args.principal.workspaceId) throw errors.notFound("Asset");
    return id;
  },
});

export const finalize = internalAction({
  args: {
    principal: principalValidator,
    assetId: v.id("assets"),
    media: v.optional(
      v.object({
        width: v.optional(v.number()),
        height: v.optional(v.number()),
        durationMs: v.optional(v.number()),
      }),
    ),
  },
  handler: async (ctx, args): Promise<{ assetId: Id<"assets"> }> => {
    const result = await finalizeUpload(
      ctx,
      { assetId: args.assetId, ...(args.media ? { media: args.media } : {}) },
      { userId: args.principal.userId },
    );
    return { assetId: result.assetId };
  },
});

export const rename = internalMutation({
  args: { principal: principalValidator, assetId: v.string(), name: v.string() },
  handler: async (ctx, args) => {
    const asset = await assetOf(ctx, args.principal.workspaceId, args.assetId);
    await requireAssetAccess(ctx, asset, "editor", { userId: args.principal.userId });
    const name = args.name.trim().replace(/\s+/g, " ").slice(0, MAX_NAME_LENGTH);
    if (!name) throw errors.invalid("The name cannot be empty.", "name");
    await ctx.db.patch("assets", asset._id, { name, updatedAt: Date.now() });
    const updated = await ctx.db.get("assets", asset._id);
    if (!updated) throw errors.notFound("Asset");
    return apiAssetView(updated);
  },
});

/** Library delete (same semantics as assets.delete: referenced bytes stay until unused). */
export const remove = internalMutation({
  args: { principal: principalValidator, assetId: v.string() },
  handler: async (ctx, args): Promise<{ deleted: true }> => {
    const asset = await assetOf(ctx, args.principal.workspaceId, args.assetId);
    await requireAssetAccess(ctx, asset, "editor", { userId: args.principal.userId });
    const now = Date.now();
    await ctx.db.patch("assets", asset._id, { status: "deleted", deletedAt: now, updatedAt: now });
    if (asset.status === "ready") {
      await incrementUsage(ctx, asset.ownerId, "storageBytes", -asset.bytes);
    }
    return { deleted: true };
  },
});
