import type { Id } from "../_generated/dataModel";
import type { ActionCtx, MutationCtx, QueryCtx } from "../_generated/server";
import { SIGNED_URL_WINDOW_S } from "./designs_limits";
import {
  attachmentDisposition,
  presignUrl,
  publicObjectUrl,
  s3Config,
  s3Request,
  windowStart,
} from "./designs_s3";

// Blob storage for server-produced files (snapshots, thumbnails, exports, template thumbnails).
// S3 when configured (the production path; keys are readable and grouped by prefix), otherwise Convex file
// storage so a self-host without S3 (and the offline test suite) still gets snapshots, versions and exports.
// A blob ref is "s3:<key>" or "cs:<storageId>"; refs are what tables store.

export type BlobRef = string;

export function isS3Ref(ref: BlobRef): boolean {
  return ref.startsWith("s3:");
}

function s3Key(ref: BlobRef): string {
  return ref.slice(3);
}

function storageId(ref: BlobRef): Id<"_storage"> {
  return ref.slice(3) as Id<"_storage">;
}

export async function putBlob(
  ctx: ActionCtx,
  key: string,
  bytes: Uint8Array,
  contentType: string,
): Promise<BlobRef> {
  const cfg = s3Config();
  if (cfg) {
    const res = await s3Request(cfg, {
      method: "PUT",
      key,
      body: bytes,
      headers: { "content-type": contentType },
    });
    if (!res.ok) throw new Error(`S3 PUT failed with status ${res.status}`);
    return `s3:${key}`;
  }
  const id = await ctx.storage.store(new Blob([bytes as BlobPart], { type: contentType }));
  return `cs:${id}`;
}

export async function getBlob(ctx: ActionCtx, ref: BlobRef): Promise<Uint8Array | null> {
  if (isS3Ref(ref)) {
    const cfg = s3Config();
    if (!cfg) throw new Error("S3 is not configured but a stored blob lives in S3");
    const res = await s3Request(cfg, { method: "GET", key: s3Key(ref) });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`S3 GET failed with status ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }
  const blob = await ctx.storage.get(storageId(ref));
  return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
}

/** Delete a blob from an action. Missing blobs are ignored. */
export async function deleteBlob(ctx: ActionCtx, ref: BlobRef): Promise<void> {
  if (isS3Ref(ref)) {
    const cfg = s3Config();
    if (!cfg) return;
    const res = await s3Request(cfg, { method: "DELETE", key: s3Key(ref) });
    if (!res.ok && res.status !== 404)
      throw new Error(`S3 DELETE failed with status ${res.status}`);
    return;
  }
  try {
    await ctx.storage.delete(storageId(ref));
  } catch {
    // Already deleted.
  }
}

/** Delete Convex-storage blobs directly; returns the S3 refs that still need an action. */
export async function deleteLocalBlobs(ctx: MutationCtx, refs: BlobRef[]): Promise<BlobRef[]> {
  const remote: BlobRef[] = [];
  for (const ref of refs) {
    if (isS3Ref(ref)) remote.push(ref);
    else {
      try {
        await ctx.storage.delete(storageId(ref));
      } catch {
        // Already deleted.
      }
    }
  }
  return remote;
}

export interface BlobUrlOptions {
  /** Download file name (adds Content-Disposition: attachment for S3 URLs). */
  fileName?: string;
  /** Validity for S3 URLs in seconds; URLs are signed at the start of the current window. */
  ttlSeconds?: number;
  now?: number;
}

/** A URL clients can fetch the blob from, or null when it cannot be resolved. */
export async function blobUrl(
  ctx: QueryCtx | MutationCtx | ActionCtx,
  ref: BlobRef,
  opts: BlobUrlOptions = {},
): Promise<string | null> {
  if (isS3Ref(ref)) {
    const cfg = s3Config();
    if (!cfg) return null;
    const key = s3Key(ref);
    if (!opts.fileName) {
      const pub = publicObjectUrl(cfg, key);
      if (pub) return pub;
    }
    return presignUrl(cfg, key, {
      method: "GET",
      date: windowStart(opts.now ?? Date.now(), SIGNED_URL_WINDOW_S),
      // Signed at the window start and valid for two windows: always >= one full window left.
      expiresIn: opts.ttlSeconds ?? SIGNED_URL_WINDOW_S * 2,
      ...(opts.fileName
        ? { query: { "response-content-disposition": attachmentDisposition(opts.fileName) } }
        : {}),
    });
  }
  return await ctx.storage.getUrl(storageId(ref));
}
