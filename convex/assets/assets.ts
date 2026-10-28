import { newId } from "@desyn/schema";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { paginationOptsValidator } from "convex/server";
import { type Infer, v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import {
  type ActionCtx,
  action,
  internalAction,
  internalMutation,
  internalQuery,
  type MutationCtx,
  mutation,
  type QueryCtx,
  query,
} from "../_generated/server";
import { getDesignOrThrow, requireDesignPermission, shareArg } from "../lib/designs_access";
import { resolveDesignAssetUrls, signAssetKey, signedUrlExpiry } from "../lib/designs_assets";
import {
  MAX_NAME_LENGTH,
  MAX_SVG_BYTES,
  PENDING_UPLOAD_TTL_MS,
  UPLOAD_URL_TTL_S,
} from "../lib/designs_limits";
import { presignUrl, s3Config, s3Request } from "../lib/designs_s3";
import {
  type AssetKind,
  type InspectResult,
  inspectUpload,
  kindForMime,
  needsFullContent,
  normalizeMime,
  safeFileName,
  UploadValidationError,
} from "../lib/designs_upload";
import { assertFeature, assertUploadAllowed } from "../lib/entitlements";
import { appError, errors } from "../lib/errors";
import { getMembership, requireMember, requireUser } from "../lib/guards";
import { createLogger } from "../lib/logger";
import { incrementUsage } from "../lib/usage";
import { assetKindValidator, assetSourceValidator } from "../tables/assets";

// assets.* : uploads to S3 through presigned PUT URLs, verification + dedupe on finalize, signed GET URLs,
// listing, rename and delete. Bytes never pass through Convex except for server-produced files (`ingest`).

type DbCtx = QueryCtx | MutationCtx;
const HEAD_BYTES = 512 * 1024;
const MAX_FULL_BYTES = MAX_SVG_BYTES;

function requireS3() {
  const cfg = s3Config();
  if (!cfg) throw errors.notConfigured("File storage (S3)");
  return cfg;
}

function cleanAssetName(name: string): string {
  const trimmed = name.trim().replace(/\s+/g, " ").slice(0, MAX_NAME_LENGTH);
  return trimmed || "Untitled";
}

/**
 * Read access to an asset: members of its workspace; system (template library) assets for anyone signed in.
 * `opts.userId` is a trusted caller-verified user (Agent API after API-key verification).
 */
export async function requireAssetAccess(
  ctx: DbCtx,
  asset: Doc<"assets">,
  minRole: "viewer" | "editor",
  opts: { userId?: string } = {},
): Promise<string> {
  const userId = opts.userId ?? (await requireUser(ctx)).userId;
  if (asset.workspaceId === undefined) {
    if (minRole === "editor") throw errors.forbidden("Library assets cannot be changed.");
    return userId;
  }
  await requireMember(ctx, asset.workspaceId, minRole, { userId });
  return userId;
}

export function assetView(asset: Doc<"assets">, url: string | null) {
  return {
    id: asset._id,
    refId: asset.refId,
    workspaceId: asset.workspaceId ?? null,
    kind: asset.kind,
    name: asset.name,
    mime: asset.mime,
    bytes: asset.bytes,
    width: asset.width ?? null,
    height: asset.height ?? null,
    durationMs: asset.durationMs ?? null,
    hash: asset.hash ?? null,
    status: asset.status,
    source: asset.source,
    storageKey: asset.storageKey,
    family: asset.family ?? null,
    weight: asset.weight ?? null,
    style: asset.style ?? null,
    attribution: asset.attribution ?? null,
    ai: asset.ai ?? null,
    url,
    createdAt: asset.createdAt,
    updatedAt: asset.updatedAt,
  };
}

export function urlFor(asset: Doc<"assets">, now = Date.now()): string | null {
  const cfg = s3Config();
  if (!cfg || asset.purgedAt || asset.status === "pending" || asset.status === "failed")
    return null;
  return signAssetKey(cfg, asset.storageKey, now);
}

// --- upload ---------------------------------------------------------------------------------------------

const fontFields = {
  family: v.optional(v.string()),
  weight: v.optional(v.number()),
  style: v.optional(v.union(v.literal("normal"), v.literal("italic"))),
};

const requestUploadArgs = {
  workspaceId: v.id("workspaces"),
  name: v.string(),
  mime: v.string(),
  bytes: v.number(),
  sha256: v.optional(v.string()),
  /** For application/json uploads: a Lottie animation or plain data. */
  declaredKind: v.optional(v.union(v.literal("lottie"), v.literal("data"))),
  source: v.optional(v.union(v.literal("upload"), v.literal("brand"))),
  ...fontFields,
};
const requestUploadValidator = v.object(requestUploadArgs);

/**
 * Start an upload (see `requestUpload`). `opts.userId` is a trusted caller-verified user (Agent API after
 * API-key verification).
 */
export async function requestUploadFor(
  ctx: MutationCtx,
  args: Infer<typeof requestUploadValidator>,
  opts: { userId?: string } = {},
) {
  const member = await requireMember(ctx, args.workspaceId, "editor", opts);
  const cfg = requireS3();
  const mime = normalizeMime(args.mime);
  const kind = kindForMime(mime, args.declaredKind);
  if (!kind)
    throw errors.invalid(`Files of type ${args.mime || "unknown"} cannot be uploaded.`, "mime");
  if (!Number.isInteger(args.bytes) || args.bytes <= 0) {
    throw errors.invalid("The file size must be a positive number of bytes.", "bytes");
  }
  if (kind === "font") await assertFeature(ctx, member.userId, "fonts.custom");
  if (needsFullContent(kind) && args.bytes > MAX_FULL_BYTES) {
    throw errors.invalid("SVG and JSON files can be at most 5 MB.", "bytes");
  }
  await assertUploadAllowed(ctx, member.userId, args.bytes);

  const hash = args.sha256?.toLowerCase();
  if (hash !== undefined && !/^[0-9a-f]{64}$/.test(hash)) {
    throw errors.invalid("sha256 must be 64 hex characters.", "sha256");
  }
  if (hash) {
    const existing = await ctx.db
      .query("assets")
      .withIndex("by_workspace_hash", (q) => q.eq("workspaceId", args.workspaceId).eq("hash", hash))
      .filter((q) => q.eq(q.field("status"), "ready"))
      .first();
    if (existing) {
      return { assetId: existing._id, refId: existing.refId, deduplicated: true, upload: null };
    }
  }

  const now = Date.now();
  const refId = newId();
  const storageKey = `uploads/${args.workspaceId}/${refId}/${safeFileName(args.name)}`;
  const assetId = await ctx.db.insert("assets", {
    workspaceId: args.workspaceId,
    ownerId: member.userId,
    refId,
    kind,
    name: cleanAssetName(args.name),
    mime,
    bytes: args.bytes,
    storageKey,
    status: "pending",
    source: args.source ?? "upload",
    ...(kind === "font" && args.family ? { family: args.family.slice(0, 100) } : {}),
    ...(kind === "font" && args.weight ? { weight: args.weight } : {}),
    ...(kind === "font" && args.style ? { style: args.style } : {}),
    uploadExpiresAt: now + UPLOAD_URL_TTL_S * 1000,
    createdAt: now,
    updatedAt: now,
  });
  const headers = { "content-type": mime, "content-length": String(args.bytes) };
  const url = presignUrl(cfg, storageKey, {
    method: "PUT",
    expiresIn: UPLOAD_URL_TTL_S,
    signedHeaders: headers,
  });
  return {
    assetId,
    refId,
    deduplicated: false,
    upload: { url, method: "PUT" as const, headers, expiresAt: now + UPLOAD_URL_TTL_S * 1000 },
  };
}

/**
 * Start an upload. Returns a presigned PUT URL that only accepts exactly this content type and length.
 * With `sha256` (hex of the bytes) an existing identical file in the workspace is reused (no upload).
 */
export const requestUpload = mutation({
  args: requestUploadArgs,
  handler: async (ctx, args) => await requestUploadFor(ctx, args),
});

export const forFinalize = internalQuery({
  /** `userId`: trusted caller-verified user (Agent API); otherwise the signed-in user. */
  args: { assetId: v.id("assets"), userId: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const asset = await ctx.db.get("assets", args.assetId);
    if (!asset || asset.workspaceId === undefined) throw errors.notFound("Asset");
    const userId = args.userId ?? (await requireUser(ctx)).userId;
    await requireMember(ctx, asset.workspaceId, "editor", { userId });
    return asset;
  },
});

interface ObjectRead {
  hash: string;
  bytes: number;
  head: Uint8Array;
  full?: Uint8Array;
}

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

/** Stream an object once: sha256 of everything, the first 512 KiB, and the full bytes when asked. */
async function readObject(key: string, needFull: boolean): Promise<ObjectRead> {
  const cfg = requireS3();
  const res = await s3Request(cfg, { method: "GET", key });
  if (!res.ok || !res.body) throw new Error(`S3 GET failed with status ${res.status}`);
  const hasher = sha256.create();
  const reader = res.body.getReader();
  const headChunks: Uint8Array[] = [];
  const fullChunks: Uint8Array[] = [];
  let headBytes = 0;
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    hasher.update(value);
    total += value.length;
    if (headBytes < HEAD_BYTES) {
      const slice = value.subarray(0, HEAD_BYTES - headBytes);
      headChunks.push(slice);
      headBytes += slice.length;
    }
    if (needFull) {
      if (total > MAX_FULL_BYTES)
        throw new UploadValidationError("The file is too large to process.");
      fullChunks.push(value);
    }
  }
  return {
    hash: bytesToHex(hasher.digest()),
    bytes: total,
    head: concat(headChunks, headBytes),
    ...(needFull ? { full: concat(fullChunks, total) } : {}),
  };
}

/** Key for rewritten (sanitized) bytes: next to the upload key, outside what its presigned PUT covers. */
export function sanitizedKey(uploadKey: string): string {
  const slash = uploadKey.lastIndexOf("/");
  return `${uploadKey.slice(0, slash)}/clean/${uploadKey.slice(slash + 1)}`;
}

async function deleteObject(key: string): Promise<void> {
  const cfg = s3Config();
  if (!cfg) return;
  await s3Request(cfg, { method: "DELETE", key });
}

const finalizeArgs = {
  assetId: v.id("assets"),
  /** Client-probed metadata for media the server cannot measure (video / audio duration, video size). */
  media: v.optional(
    v.object({
      width: v.optional(v.number()),
      height: v.optional(v.number()),
      durationMs: v.optional(v.number()),
    }),
  ),
};
const finalizeValidator = v.object(finalizeArgs);

/**
 * Finish an upload (see `finalize`). `opts.userId` is a trusted caller-verified user (Agent API after API-key
 * verification).
 */
export async function finalizeUpload(
  ctx: ActionCtx,
  args: Infer<typeof finalizeValidator>,
  opts: { userId?: string } = {},
): Promise<{ assetId: Id<"assets">; refId: string; deduplicated: boolean }> {
  const asset: Doc<"assets"> = await ctx.runQuery(internal.assets.assets.forFinalize, {
    assetId: args.assetId,
    ...(opts.userId ? { userId: opts.userId } : {}),
  });
  if (asset.status === "ready")
    return { assetId: asset._id, refId: asset.refId, deduplicated: false };
  if (asset.status !== "pending") throw errors.conflict("This upload can no longer be finalized.");
  const cfg = requireS3();
  const log = createLogger(ctx, { fn: "assets.finalize", assetId: asset._id });
  try {
    const head = await s3Request(cfg, { method: "HEAD", key: asset.storageKey });
    if (head.status === 404) throw errors.invalid("The file has not been uploaded yet.", "assetId");
    if (!head.ok) throw new Error(`S3 HEAD failed with status ${head.status}`);
    const length = Number(head.headers.get("content-length") ?? "-1");
    const type = normalizeMime(head.headers.get("content-type") ?? "");
    if (length !== asset.bytes || type !== asset.mime) {
      throw new UploadValidationError(
        "The uploaded file does not match the requested size or type.",
      );
    }
    const read = await readObject(asset.storageKey, needsFullContent(asset.kind as AssetKind));
    if (read.bytes !== asset.bytes)
      throw new UploadValidationError("The uploaded file is incomplete.");
    const inspected = inspectUpload(asset.kind as AssetKind, asset.mime, read.head, read.full);
    let hash = read.hash;
    let bytes = read.bytes;
    let storageKey: string | undefined;
    if (inspected.rewritten) {
      // The presigned PUT stays valid until it expires, so the sanitized file must not live at the key
      // it covers: a client could otherwise overwrite it with the original (same length) markup.
      storageKey = sanitizedKey(asset.storageKey);
      const put = await s3Request(cfg, {
        method: "PUT",
        key: storageKey,
        body: inspected.rewritten,
        headers: { "content-type": asset.mime },
      });
      if (!put.ok) throw new Error(`S3 PUT failed with status ${put.status}`);
      hash = bytesToHex(sha256(inspected.rewritten));
      bytes = inspected.rewritten.length;
      await deleteObject(asset.storageKey);
      // Remove anything uploaded to the original key after this point, once the PUT URL has expired.
      await ctx.scheduler.runAfter(
        Math.max(0, (asset.uploadExpiresAt ?? 0) - Date.now()) + 60_000,
        internal.assets.assets.deleteObjects,
        { keys: [asset.storageKey] },
      );
    }
    const media =
      asset.kind === "video" || asset.kind === "audio" || asset.kind === "lottie"
        ? args.media
        : undefined;
    const width = inspected.width ?? (media?.width && media.width > 0 ? media.width : undefined);
    const height =
      inspected.height ?? (media?.height && media.height > 0 ? media.height : undefined);
    const result = await ctx.runMutation(internal.assets.assets.markReady, {
      assetId: asset._id,
      hash,
      bytes,
      sanitized: Boolean(inspected.rewritten),
      ...(storageKey ? { storageKey } : {}),
      ...(width !== undefined ? { width } : {}),
      ...(height !== undefined ? { height } : {}),
      ...(media?.durationMs && media.durationMs > 0
        ? { durationMs: Math.round(media.durationMs) }
        : {}),
    });
    if (result.discardKey) await deleteObject(result.discardKey);
    return { assetId: result.assetId, refId: result.refId, deduplicated: result.deduplicated };
  } catch (err) {
    if (err instanceof UploadValidationError) {
      await ctx.runMutation(internal.assets.assets.markFailed, {
        assetId: asset._id,
        error: err.message,
      });
      await deleteObject(asset.storageKey);
      throw errors.invalid(err.message, "file");
    }
    log.error("finalize failed", { error: err instanceof Error ? err.message : String(err) });
    throw err;
  } finally {
    await log.flush();
  }
}

/**
 * Finish an upload: verify the object (HEAD: size + type), hash and sniff it, sanitize SVG, dedupe by hash
 * within the workspace and count storage. Returns the (possibly deduplicated) asset.
 */
export const finalize = action({
  args: finalizeArgs,
  handler: async (
    ctx,
    args,
  ): Promise<{ assetId: Id<"assets">; refId: string; deduplicated: boolean }> =>
    await finalizeUpload(ctx, args),
});

export const markReady = internalMutation({
  args: {
    assetId: v.id("assets"),
    hash: v.string(),
    bytes: v.number(),
    sanitized: v.boolean(),
    /** New object key when the bytes were rewritten (sanitized SVG). */
    storageKey: v.optional(v.string()),
    width: v.optional(v.number()),
    height: v.optional(v.number()),
    durationMs: v.optional(v.number()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    assetId: Id<"assets">;
    refId: string;
    deduplicated: boolean;
    discardKey: string | null;
  }> => {
    const asset = await ctx.db.get("assets", args.assetId);
    if (!asset) throw errors.notFound("Asset");
    if (asset.status === "ready")
      return { assetId: asset._id, refId: asset.refId, deduplicated: false, discardKey: null };
    const now = Date.now();
    const duplicate = await ctx.db
      .query("assets")
      .withIndex("by_workspace_hash", (q) =>
        q.eq("workspaceId", asset.workspaceId).eq("hash", args.hash),
      )
      .filter((q) => q.and(q.eq(q.field("status"), "ready"), q.neq(q.field("_id"), asset._id)))
      .first();
    if (duplicate) {
      await ctx.db.patch("assets", asset._id, {
        status: "deleted",
        hash: args.hash,
        deletedAt: now,
        purgedAt: now,
        updatedAt: now,
        error: "duplicate",
      });
      return {
        assetId: duplicate._id,
        refId: duplicate.refId,
        deduplicated: true,
        discardKey: args.storageKey ?? asset.storageKey,
      };
    }
    await ctx.db.patch("assets", asset._id, {
      status: "ready",
      hash: args.hash,
      bytes: args.bytes,
      sanitized: args.sanitized,
      ...(args.storageKey ? { storageKey: args.storageKey } : {}),
      ...(args.width !== undefined ? { width: args.width } : {}),
      ...(args.height !== undefined ? { height: args.height } : {}),
      ...(args.durationMs !== undefined ? { durationMs: args.durationMs } : {}),
      uploadExpiresAt: undefined,
      readyAt: now,
      updatedAt: now,
    });
    await incrementUsage(ctx, asset.ownerId, "storageBytes", args.bytes);
    await incrementUsage(ctx, asset.ownerId, "uploads", 1);
    return { assetId: asset._id, refId: asset.refId, deduplicated: false, discardKey: null };
  },
});

export const markFailed = internalMutation({
  args: { assetId: v.id("assets"), error: v.string() },
  handler: async (ctx, args) => {
    const asset = await ctx.db.get("assets", args.assetId);
    if (asset?.status !== "pending") return null;
    const now = Date.now();
    await ctx.db.patch("assets", asset._id, {
      status: "failed",
      error: args.error.slice(0, 300),
      purgedAt: now,
      updatedAt: now,
    });
    return null;
  },
});

/**
 * Store server-produced bytes (AI generations, stock downloads, brand extraction) as a ready asset.
 * For trusted backend callers; the bytes go through the same validation as uploads.
 */
export const ingest = internalAction({
  args: {
    workspaceId: v.id("workspaces"),
    userId: v.string(),
    name: v.string(),
    mime: v.string(),
    data: v.bytes(),
    source: assetSourceValidator,
    declaredKind: v.optional(v.union(v.literal("lottie"), v.literal("data"))),
    ai: v.optional(
      v.object({
        provider: v.string(),
        model: v.string(),
        prompt: v.string(),
        seed: v.optional(v.number()),
      }),
    ),
    attribution: v.optional(
      v.object({
        author: v.optional(v.string()),
        license: v.optional(v.string()),
        url: v.optional(v.string()),
      }),
    ),
  },
  handler: async (
    ctx: ActionCtx,
    args,
  ): Promise<{
    assetId: Id<"assets">;
    refId: string;
    storageKey: string;
    width: number | null;
    height: number | null;
    deduplicated: boolean;
  }> => {
    const cfg = requireS3();
    const mime = normalizeMime(args.mime);
    const kind = kindForMime(mime, args.declaredKind);
    if (!kind) throw errors.invalid(`Files of type ${args.mime} are not supported.`, "mime");
    let bytes = new Uint8Array(args.data);
    let inspected: InspectResult;
    try {
      inspected = inspectUpload(
        kind,
        mime,
        bytes.subarray(0, HEAD_BYTES),
        needsFullContent(kind) ? bytes : undefined,
      );
    } catch (err) {
      if (err instanceof UploadValidationError) throw errors.invalid(err.message, "data");
      throw err;
    }
    if (inspected.rewritten) bytes = new Uint8Array(inspected.rewritten);
    const hash = bytesToHex(sha256(bytes));
    const existing: Doc<"assets"> | null = await ctx.runQuery(
      internal.assets.assets.findReadyByHash,
      {
        workspaceId: args.workspaceId,
        hash,
      },
    );
    if (existing) {
      return {
        assetId: existing._id,
        refId: existing.refId,
        storageKey: existing.storageKey,
        width: existing.width ?? null,
        height: existing.height ?? null,
        deduplicated: true,
      };
    }
    const refId = newId();
    const storageKey = `${args.source === "ai" ? "generated" : "uploads"}/${args.workspaceId}/${refId}/${safeFileName(args.name)}`;
    const put = await s3Request(cfg, {
      method: "PUT",
      key: storageKey,
      body: bytes,
      headers: { "content-type": mime },
    });
    if (!put.ok) throw new Error(`S3 PUT failed with status ${put.status}`);
    const assetId: Id<"assets"> = await ctx.runMutation(internal.assets.assets.insertReady, {
      workspaceId: args.workspaceId,
      userId: args.userId,
      refId,
      kind,
      name: cleanAssetName(args.name),
      mime,
      bytes: bytes.length,
      hash,
      storageKey,
      source: args.source,
      ...(inspected.width !== undefined ? { width: inspected.width } : {}),
      ...(inspected.height !== undefined ? { height: inspected.height } : {}),
      ...(args.ai ? { ai: args.ai } : {}),
      ...(args.attribution ? { attribution: args.attribution } : {}),
      sanitized: Boolean(inspected.rewritten),
    });
    return {
      assetId,
      refId,
      storageKey,
      width: inspected.width ?? null,
      height: inspected.height ?? null,
      deduplicated: false,
    };
  },
});

export const findReadyByHash = internalQuery({
  args: { workspaceId: v.id("workspaces"), hash: v.string() },
  handler: async (ctx, args) =>
    await ctx.db
      .query("assets")
      .withIndex("by_workspace_hash", (q) =>
        q.eq("workspaceId", args.workspaceId).eq("hash", args.hash),
      )
      .filter((q) => q.eq(q.field("status"), "ready"))
      .first(),
});

export const insertReady = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    userId: v.string(),
    refId: v.string(),
    kind: assetKindValidator,
    name: v.string(),
    mime: v.string(),
    bytes: v.number(),
    hash: v.string(),
    storageKey: v.string(),
    source: assetSourceValidator,
    width: v.optional(v.number()),
    height: v.optional(v.number()),
    sanitized: v.boolean(),
    ai: v.optional(
      v.object({
        provider: v.string(),
        model: v.string(),
        prompt: v.string(),
        seed: v.optional(v.number()),
      }),
    ),
    attribution: v.optional(
      v.object({
        author: v.optional(v.string()),
        license: v.optional(v.string()),
        url: v.optional(v.string()),
      }),
    ),
  },
  handler: async (ctx, args): Promise<Id<"assets">> => {
    const membership = await getMembership(ctx, args.workspaceId, args.userId);
    if (!membership) throw errors.forbidden("The user is not a member of this workspace.");
    const now = Date.now();
    const { userId, ...fields } = args;
    const id = await ctx.db.insert("assets", {
      ...fields,
      ownerId: userId,
      status: "ready",
      createdAt: now,
      updatedAt: now,
      readyAt: now,
    });
    await incrementUsage(ctx, userId, "storageBytes", args.bytes);
    return id;
  },
});

// --- read -----------------------------------------------------------------------------------------------

export const get = query({
  args: { assetId: v.id("assets") },
  handler: async (ctx, args) => {
    const asset = await ctx.db.get("assets", args.assetId);
    if (!asset) throw errors.notFound("Asset");
    await requireAssetAccess(ctx, asset, "viewer");
    return assetView(asset, urlFor(asset));
  },
});

/**
 * Signed GET URL. URLs are signed at the start of the current hour and stay valid for two hours, so they
 * are identical (cacheable) within the hour; refetch after `expiresAt`. Public base URLs never expire.
 */
export const getUrl = query({
  args: { assetId: v.id("assets") },
  handler: async (ctx, args): Promise<{ url: string; expiresAt: number | null }> => {
    const asset = await ctx.db.get("assets", args.assetId);
    if (!asset) throw errors.notFound("Asset");
    await requireAssetAccess(ctx, asset, "viewer");
    const url = urlFor(asset);
    if (!url) throw appError("NOT_FOUND", "This file is not available.");
    return { url, expiresAt: s3Config()?.publicBaseUrl ? null : signedUrlExpiry() };
  },
});

export const getUrls = query({
  args: { assetIds: v.array(v.id("assets")) },
  handler: async (ctx, args) => {
    if (args.assetIds.length > 100)
      throw errors.invalid("At most 100 assets per call.", "assetIds");
    const user = await requireUser(ctx);
    const allowed = new Map<string, boolean>();
    const urls: Record<string, string> = {};
    const now = Date.now();
    for (const id of args.assetIds) {
      const asset = await ctx.db.get("assets", id);
      if (!asset) continue;
      if (asset.workspaceId !== undefined) {
        let ok = allowed.get(asset.workspaceId);
        if (ok === undefined) {
          ok = (await getMembership(ctx, asset.workspaceId, user.userId)) !== null;
          allowed.set(asset.workspaceId, ok);
        }
        if (!ok) continue;
      }
      const url = urlFor(asset, now);
      if (url) urls[id] = url;
    }
    return { urls, expiresAt: s3Config()?.publicBaseUrl ? null : signedUrlExpiry(now) };
  },
});

/** URLs for the AssetRefs of a design (keyed by AssetRef.id), for anyone who can view the design. */
export const designUrls = query({
  args: { designId: v.id("designs"), refs: v.optional(v.array(v.string())), share: shareArg },
  handler: async (ctx, args) => {
    const design = await getDesignOrThrow(ctx, args.designId);
    await requireDesignPermission(ctx, design, "view", { share: args.share });
    const urls = await resolveDesignAssetUrls(ctx, design, args.refs);
    return { urls, expiresAt: s3Config()?.publicBaseUrl ? null : signedUrlExpiry() };
  },
});

export const list = query({
  args: {
    workspaceId: v.id("workspaces"),
    kind: v.optional(assetKindValidator),
    search: v.optional(v.string()),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    await requireMember(ctx, args.workspaceId, "viewer");
    const search = args.search?.trim();
    const page = search
      ? await ctx.db
          .query("assets")
          .withSearchIndex("search_name", (q) =>
            q.search("name", search).eq("workspaceId", args.workspaceId).eq("status", "ready"),
          )
          .paginate(args.paginationOpts)
      : args.kind
        ? await ctx.db
            .query("assets")
            .withIndex("by_workspace_kind_status_created", (q) =>
              q
                .eq("workspaceId", args.workspaceId)
                .eq("kind", args.kind as AssetKind)
                .eq("status", "ready"),
            )
            .order("desc")
            .paginate(args.paginationOpts)
        : await ctx.db
            .query("assets")
            .withIndex("by_workspace_status_created", (q) =>
              q.eq("workspaceId", args.workspaceId).eq("status", "ready"),
            )
            .order("desc")
            .paginate(args.paginationOpts);
    const now = Date.now();
    return {
      ...page,
      page: page.page
        .filter((a) => !args.kind || a.kind === args.kind)
        .map((a) => assetView(a, urlFor(a, now))),
    };
  },
});

// --- write ----------------------------------------------------------------------------------------------

export const rename = mutation({
  args: { assetId: v.id("assets"), name: v.string() },
  handler: async (ctx, args) => {
    const asset = await ctx.db.get("assets", args.assetId);
    if (!asset || asset.status === "deleted") throw errors.notFound("Asset");
    await requireAssetAccess(ctx, asset, "editor");
    await ctx.db.patch("assets", asset._id, {
      name: cleanAssetName(args.name),
      updatedAt: Date.now(),
    });
    return null;
  },
});

/**
 * Delete an asset from the library. Designs that already use it keep working: the bytes are removed by the
 * cleanup job only once no design references the file any more.
 */
const remove = mutation({
  args: { assetId: v.id("assets") },
  handler: async (ctx, args) => {
    const asset = await ctx.db.get("assets", args.assetId);
    if (!asset || asset.status === "deleted") return null;
    await requireAssetAccess(ctx, asset, "editor");
    const now = Date.now();
    await ctx.db.patch("assets", asset._id, { status: "deleted", deletedAt: now, updatedAt: now });
    if (asset.status === "ready")
      await incrementUsage(ctx, asset.ownerId, "storageBytes", -asset.bytes);
    return null;
  },
});

export { remove as delete };

// --- cleanup (cron) -------------------------------------------------------------------------------------

/** Failed uploads are kept this long (for support / client error display) before their rows are dropped. */
const FAILED_ROW_TTL_MS = 7 * 24 * 60 * 60_000;

/**
 * Cron: expire abandoned uploads, and remove the bytes of deleted assets that no design references and no
 * other asset row shares. Purged rows (bytes gone) are dropped on the next run: left in place they would sit
 * at the front of the `deleted` queue and starve every newer deletion.
 */
export const cleanup = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const keys: string[] = [];
    let removed = 0;
    const failed = await ctx.db
      .query("assets")
      .withIndex("by_status_updated", (q) =>
        q.eq("status", "failed").lt("updatedAt", now - FAILED_ROW_TTL_MS),
      )
      .take(100);
    for (const asset of failed) {
      await ctx.db.delete("assets", asset._id);
      removed++;
    }
    const pending = await ctx.db
      .query("assets")
      .withIndex("by_status_updated", (q) =>
        q.eq("status", "pending").lt("updatedAt", now - PENDING_UPLOAD_TTL_MS),
      )
      .take(100);
    for (const asset of pending) {
      await ctx.db.patch("assets", asset._id, {
        status: "failed",
        error: "upload expired",
        purgedAt: now,
        updatedAt: now,
      });
      keys.push(asset.storageKey);
    }
    let purged = 0;
    const deleted = await ctx.db
      .query("assets")
      .withIndex("by_status_updated", (q) =>
        q.eq("status", "deleted").lt("updatedAt", now - 60 * 60_000),
      )
      .take(100);
    for (const asset of deleted) {
      if (asset.purgedAt) {
        // Stale links can only come from refs to an upload that was later merged into a duplicate.
        for (const link of await ctx.db
          .query("designAssets")
          .withIndex("by_asset", (q) => q.eq("assetId", asset._id))
          .take(100)) {
          await ctx.db.delete("designAssets", link._id);
        }
        await ctx.db.delete("assets", asset._id);
        removed++;
        continue;
      }
      const referenced = await ctx.db
        .query("designAssets")
        .withIndex("by_asset", (q) => q.eq("assetId", asset._id))
        .first();
      if (referenced) {
        // Still used by a design: check again later (moves the row to the back of the queue).
        await ctx.db.patch("assets", asset._id, { updatedAt: now });
        continue;
      }
      const shared = await ctx.db
        .query("assets")
        .withIndex("by_storageKey", (q) => q.eq("storageKey", asset.storageKey))
        .filter((q) =>
          q.and(q.neq(q.field("_id"), asset._id), q.eq(q.field("purgedAt"), undefined)),
        )
        .first();
      if (!shared) keys.push(asset.storageKey);
      await ctx.db.patch("assets", asset._id, { purgedAt: now, updatedAt: now });
      purged++;
    }
    if (keys.length > 0)
      await ctx.scheduler.runAfter(0, internal.assets.assets.deleteObjects, { keys });
    return { expired: pending.length, purged, removed };
  },
});

export const deleteObjects = internalAction({
  args: { keys: v.array(v.string()) },
  handler: async (ctx, args) => {
    const log = createLogger(ctx, { fn: "assets.deleteObjects" });
    for (const key of args.keys) {
      try {
        await deleteObject(key);
      } catch (err) {
        log.warn("object delete failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    await log.flush();
    return null;
  },
});
