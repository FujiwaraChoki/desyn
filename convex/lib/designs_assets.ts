import type { AssetRef } from "@desyn/schema";
import type { Doc } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { findAssetForWorkspace } from "./designs_commit";
import { SIGNED_URL_WINDOW_S } from "./designs_limits";
import { presignUrl, publicObjectUrl, type S3Config, s3Config, windowStart } from "./designs_s3";

// Signed URLs for assets. A design may only resolve storage keys that belong to its workspace's asset rows
// or to the shared template library, so an editor cannot mint URLs for another workspace's files by writing
// a foreign storageKey into an AssetRef.

type DbCtx = QueryCtx | MutationCtx;

/** Storage prefix of the shared template library (readable by every design). */
export const TEMPLATE_PREFIX = "templates/";

export function signAssetKey(cfg: S3Config, key: string, now = Date.now()): string {
  return (
    publicObjectUrl(cfg, key) ??
    presignUrl(cfg, key, {
      method: "GET",
      date: windowStart(now, SIGNED_URL_WINDOW_S),
      expiresIn: SIGNED_URL_WINDOW_S * 2,
    })
  );
}

/** Expiry of URLs signed now (they are signed at the window start and valid for two windows). */
export function signedUrlExpiry(now = Date.now()): number {
  return windowStart(now, SIGNED_URL_WINDOW_S).getTime() + SIGNED_URL_WINDOW_S * 2 * 1000;
}

/** A template-library storage key without empty, "." or ".." segments or backslashes. */
export function isLibraryKey(key: string): boolean {
  if (!key.startsWith(TEMPLATE_PREFIX) || key.includes("\\")) return false;
  return key.split("/").every((seg) => seg !== "" && seg !== "." && seg !== "..");
}

/** Resolve URLs for the AssetRefs of a design (all of them, or only `refs`). Unresolvable refs are omitted. */
export async function resolveDesignAssetUrls(
  ctx: DbCtx,
  design: Doc<"designs">,
  refs?: string[],
): Promise<Record<string, string>> {
  const cfg = s3Config();
  if (!cfg) return {};
  const state = await ctx.db
    .query("designState")
    .withIndex("by_design", (q) => q.eq("designId", design._id))
    .unique();
  if (!state) return {};
  const assets = JSON.parse(state.assets) as Record<string, AssetRef>;
  const wanted = refs ? new Set(refs) : null;
  const now = Date.now();
  const out: Record<string, string> = {};
  for (const [ref, asset] of Object.entries(assets)) {
    if (wanted && !wanted.has(ref)) continue;
    const key = asset.storageKey;
    if (!key) continue;
    if (key.startsWith(TEMPLATE_PREFIX)) {
      // The prefix alone grants access, so keys that could resolve elsewhere ("templates/../uploads/…"
      // after URL normalization by a CDN or proxy) are never signed.
      if (isLibraryKey(key)) out[ref] = signAssetKey(cfg, key, now);
      continue;
    }
    const row = await findAssetForWorkspace(ctx, design.workspaceId, ref);
    if (
      row &&
      row.storageKey === key &&
      row.status !== "failed" &&
      row.status !== "pending" &&
      !row.purgedAt
    ) {
      out[ref] = signAssetKey(cfg, key, now);
    }
  }
  return out;
}
