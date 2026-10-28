"use node";

import { DAY, MINUTE, RateLimiter } from "@convex-dev/rate-limiter";
import { stockFromEnv } from "@desyn/ai";
import { v } from "convex/values";
import { components } from "../_generated/api";
import { action } from "../_generated/server";
import { env } from "../lib/env";
import { errors } from "../lib/errors";

// Stock photo search for the editors' Photos panels (desktop and web): Unsplash / Pexels through the server keys
// (UNSPLASH_ACCESS_KEY, PEXELS_API_KEY), so clients never hold them. Results carry the attribution each source
// requires; `track` reports an Unsplash download when a photo is used, as its API guidelines require.

const limiter = new RateLimiter(components.rateLimiter, {
  stockSearchPerMinute: { kind: "token bucket", rate: 60, period: MINUTE, capacity: 30 },
  stockSearchPerDay: { kind: "fixed window", rate: 2_000, period: DAY },
});

const PAGE_SIZE_MAX = 30;
const PAGES_MAX = 3;

async function signedInUser(ctx: {
  auth: { getUserIdentity(): Promise<{ subject: string } | null> };
}) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw errors.unauthenticated();
  return identity.subject;
}

/**
 * Searches stock photos. `page` (1..3) pages through the merged results of every configured source.
 * Returns `{ photos, hasMore }`; NOT_CONFIGURED when no source key is set.
 */
export const search = action({
  args: {
    query: v.string(),
    page: v.optional(v.number()),
    count: v.optional(v.number()),
    orientation: v.optional(
      v.union(v.literal("landscape"), v.literal("portrait"), v.literal("square")),
    ),
    color: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await signedInUser(ctx);
    const query = args.query.trim().slice(0, 120);
    if (!query) throw errors.invalid("Enter something to search for.", "query");
    for (const name of ["stockSearchPerMinute", "stockSearchPerDay"] as const) {
      const r = await limiter.limit(ctx, name, { key: userId });
      if (!r.ok) throw errors.rateLimited(r.retryAfter, "stock");
    }
    const stock = stockFromEnv(process.env as Record<string, string | undefined>);
    if (!stock) throw errors.notConfigured("Stock photo search");
    const size = Math.max(1, Math.min(PAGE_SIZE_MAX, Math.round(args.count ?? 24)));
    const page = Math.max(1, Math.min(PAGES_MAX, Math.round(args.page ?? 1)));
    // The sources page by count: ask for everything up to this page and return the tail.
    const all = await stock.search({
      query,
      count: size * page,
      ...(args.orientation ? { orientation: args.orientation } : {}),
      ...(args.color && /^#?[0-9a-f]{6}$/i.test(args.color) ? { color: args.color } : {}),
    });
    const photos = all.slice(size * (page - 1), size * page);
    return { photos, hasMore: page < PAGES_MAX && all.length >= size * page };
  },
});

/** Reports an Unsplash download (photo used in a design). Other sources need no tracking. */
export const track = action({
  args: { id: v.string(), downloadLocation: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const userId = await signedInUser(ctx);
    const key = env.get("UNSPLASH_ACCESS_KEY");
    if (!key || !args.id.startsWith("unsplash:") || !args.downloadLocation)
      return { tracked: false };
    let url: URL;
    try {
      url = new URL(args.downloadLocation);
    } catch {
      throw errors.invalid("Invalid download location.", "downloadLocation");
    }
    // Only this photo's own download endpoint: the server key must not reach any other Unsplash API.
    const photoId = args.id.slice("unsplash:".length);
    if (
      url.protocol !== "https:" ||
      url.hostname !== "api.unsplash.com" ||
      url.port !== "" ||
      url.username !== "" ||
      url.password !== "" ||
      url.pathname !== `/photos/${encodeURIComponent(photoId)}/download`
    ) {
      throw errors.invalid("Invalid download location.", "downloadLocation");
    }
    const r = await limiter.limit(ctx, "stockSearchPerMinute", { key: userId });
    if (!r.ok) throw errors.rateLimited(r.retryAfter, "stock");
    const res = await fetch(url, {
      headers: { authorization: `Client-ID ${key}`, "accept-version": "v1" },
    });
    return { tracked: res.ok };
  },
});
