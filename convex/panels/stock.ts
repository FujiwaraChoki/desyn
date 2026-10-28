import { MINUTE, RateLimiter } from "@convex-dev/rate-limiter";
import { v } from "convex/values";
import { api, components, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { action, internalQuery } from "../_generated/server";
import type { assetView } from "../assets/assets";
import { assertUploadAllowed } from "../lib/entitlements";
import { errors } from "../lib/errors";
import { requireMember } from "../lib/guards";

// "Use this photo" for the editor's Photos panel: copies a stock photo found with `stock/photos:search` into the
// workspace library (S3, with the source's attribution) and reports the Unsplash download as its API
// guidelines require. Bytes are fetched only from the providers' image CDNs, so the action cannot be used to
// make the server fetch arbitrary URLs.

const limiter = new RateLimiter(components.rateLimiter, {
  panelsStockUsePerMinute: { kind: "token bucket", rate: 30, period: MINUTE, capacity: 15 },
});

/** Image CDNs of the stock sources (`url` of `stock/photos:search` results). */
const ALLOWED_HOSTS: Record<"unsplash" | "pexels", string> = {
  unsplash: "images.unsplash.com",
  pexels: "images.pexels.com",
};
const MAX_BYTES = 30 * 1024 * 1024;

type AssetView = ReturnType<typeof assetView>;
const IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/webp", "image/avif"]);

export const photoValidator = v.object({
  id: v.string(),
  url: v.string(),
  description: v.optional(v.string()),
  author: v.string(),
  authorUrl: v.optional(v.string()),
  sourceUrl: v.optional(v.string()),
  downloadLocation: v.optional(v.string()),
});

/** The provider of a result id (`unsplash:<id>` / `pexels:<id>`), or null. */
export function providerOf(id: string): "unsplash" | "pexels" | null {
  if (/^unsplash:[A-Za-z0-9_-]{1,64}$/.test(id)) return "unsplash";
  if (/^pexels:\d{1,20}$/.test(id)) return "pexels";
  return null;
}

/** Validates a photo URL against the provider's CDN (https, default port, no credentials). */
export function checkPhotoUrl(provider: "unsplash" | "pexels", raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw errors.invalid("Invalid photo URL.", "photo.url");
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== ALLOWED_HOSTS[provider] ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== ""
  ) {
    throw errors.invalid("Invalid photo URL.", "photo.url");
  }
  return url;
}

/** Pages of the photo / photographer on the provider's own site (attribution links shown to users). */
const SITE_HOSTS: Record<"unsplash" | "pexels", string[]> = {
  unsplash: ["unsplash.com", "www.unsplash.com"],
  pexels: ["pexels.com", "www.pexels.com"],
};

/**
 * Attribution link for the stored asset: only https pages on the provider's site, so a crafted request can
 * never plant a `javascript:` or phishing link that clients later render next to the photo.
 */
export function attributionUrl(
  provider: "unsplash" | "pexels",
  raw: string | undefined,
): string | undefined {
  if (!raw) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (
    url.protocol !== "https:" ||
    !SITE_HOSTS[provider].includes(url.hostname) ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== ""
  ) {
    return undefined;
  }
  const out = url.toString();
  return out.length <= 500 ? out : undefined;
}

const FETCH_TIMEOUT_MS = 20_000;

/** Reads a response body, stopping as soon as it exceeds `max` bytes (the header may be missing or lie). */
async function readCapped(res: Response, max: number): Promise<Uint8Array> {
  const reader = res.body?.getReader();
  if (!reader) return new Uint8Array(await res.arrayBuffer());
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      throw errors.invalid("The photo is too large.", "photo.url");
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

function sniff(bytes: Uint8Array): string | null {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47)
    return "image/png";
  if (bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50)
    return "image/webp";
  if (bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70)
    return "image/avif";
  return null;
}

function fileName(description: string | undefined, provider: string, id: string): string {
  const base = (description ?? "")
    .replace(/[^\p{L}\p{N} _-]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
  return `${base || `${provider} photo`} ${id.split(":")[1] ?? ""}`.trim();
}

/** Editor membership + upload limits for the acting user (actions have no db access). */
export const checkUse = internalQuery({
  args: { workspaceId: v.id("workspaces"), bytes: v.number() },
  handler: async (ctx, args) => {
    const { userId } = await requireMember(ctx, args.workspaceId, "editor");
    await assertUploadAllowed(ctx, userId, args.bytes);
    return userId;
  },
});

export const use = action({
  args: { workspaceId: v.id("workspaces"), photo: photoValidator },
  handler: async (ctx, args): Promise<{ asset: AssetView }> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw errors.unauthenticated();
    const provider = providerOf(args.photo.id);
    if (!provider) throw errors.invalid("Unknown stock photo.", "photo.id");
    const url = checkPhotoUrl(provider, args.photo.url);
    // Membership first (cheap), so outsiders never make the server fetch anything.
    const userId: string = await ctx.runQuery(internal.panels.stock.checkUse, {
      workspaceId: args.workspaceId,
      bytes: 0,
    });
    const r = await limiter.limit(ctx, "panelsStockUsePerMinute", { key: userId });
    if (!r.ok) throw errors.rateLimited(r.retryAfter, "stock");

    // A slow or stalled CDN must not hold the action until the platform kills it.
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), FETCH_TIMEOUT_MS);
    let bytes: Uint8Array;
    try {
      let res: Response;
      try {
        res = await fetch(url, { redirect: "error", signal: abort.signal });
      } catch {
        throw errors.invalid("The photo could not be downloaded. Try again.", "photo.url");
      }
      if (!res.ok)
        throw errors.invalid(`The photo could not be downloaded (${res.status}).`, "photo.url");
      const declared = Number(res.headers.get("content-length") ?? 0);
      if (declared > MAX_BYTES) throw errors.invalid("The photo is too large.", "photo.url");
      bytes = await readCapped(res, MAX_BYTES);
    } finally {
      clearTimeout(timer);
    }
    const mime = sniff(bytes);
    if (!mime || !IMAGE_MIMES.has(mime))
      throw errors.invalid("The download is not an image.", "photo.url");
    await ctx.runQuery(internal.panels.stock.checkUse, {
      workspaceId: args.workspaceId,
      bytes: bytes.length,
    });

    const sourceUrl = attributionUrl(provider, args.photo.sourceUrl);
    const stored: { assetId: Id<"assets"> } = await ctx.runAction(internal.assets.assets.ingest, {
      workspaceId: args.workspaceId,
      userId,
      name: fileName(args.photo.description, provider, args.photo.id),
      mime,
      data: bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer,
      source: "stock",
      attribution: {
        author: args.photo.author.slice(0, 200),
        license: provider === "unsplash" ? "Unsplash License" : "Pexels License",
        ...(sourceUrl ? { url: sourceUrl } : {}),
      },
    });
    // Unsplash asks to be told when a photo is used; `stock/photos:track` validates the endpoint.
    if (provider === "unsplash" && args.photo.downloadLocation) {
      await ctx
        .runAction(api.stock.photos.track, {
          id: args.photo.id,
          downloadLocation: args.photo.downloadLocation,
        })
        .catch(() => undefined);
    }
    const asset: AssetView = await ctx.runQuery(api.assets.assets.get, { assetId: stored.assetId });
    return { asset };
  },
});
