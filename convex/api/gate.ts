import { v } from "convex/values";
import { internal } from "../_generated/api";
import { internalMutation } from "../_generated/server";
import {
  API_RATE,
  apiRateLimiter,
  IDEMPOTENCY_TAKEOVER_MS,
  IDEMPOTENCY_TTL_MS,
} from "../lib/api_limits";
import { hasFeature } from "../lib/entitlements";

// Admission control for the Agent API: plan features, per-key rate limit and idempotency records. Called
// by the HTTP layer (convex/routes/api.ts, convex/routes/mcp.ts) right after API-key verification.

export type AdmitResult =
  | { ok: true }
  | { ok: false; code: "FEATURE_UNAVAILABLE"; feature: "agentApi" | "mcp" }
  | { ok: false; code: "RATE_LIMITED"; retryAfterMs: number };

/**
 * Check that the key owner's plan includes the Agent API (and MCP for the MCP endpoint) and take `cost`
 * tokens from the key's bucket. Plans can change after a key was created, so this runs on every request.
 */
export const admit = internalMutation({
  args: {
    keyId: v.id("apiKeys"),
    userId: v.string(),
    surface: v.union(v.literal("rest"), v.literal("mcp")),
    cost: v.number(),
  },
  handler: async (ctx, args): Promise<AdmitResult> => {
    if (!(await hasFeature(ctx, args.userId, "agentApi"))) {
      return { ok: false, code: "FEATURE_UNAVAILABLE", feature: "agentApi" };
    }
    if (args.surface === "mcp" && !(await hasFeature(ctx, args.userId, "mcp"))) {
      return { ok: false, code: "FEATURE_UNAVAILABLE", feature: "mcp" };
    }
    const count = Math.max(1, Math.min(API_RATE.burst, Math.round(args.cost)));
    const limited = await apiRateLimiter.limit(ctx, "apiKeyRequests", { key: args.keyId, count });
    if (!limited.ok) {
      return {
        ok: false,
        code: "RATE_LIMITED",
        retryAfterMs: Math.max(1, Math.ceil(limited.retryAfter)),
      };
    }
    return { ok: true };
  },
});

export type IdempotencyBegin =
  | { state: "new" }
  | { state: "replay"; status: number; body: string }
  | { state: "in_progress" }
  | { state: "mismatch" };

/** Claim an idempotency key for a request, or return the stored response of an earlier identical request. */
export const beginIdempotent = internalMutation({
  args: { keyId: v.id("apiKeys"), key: v.string(), fingerprint: v.string() },
  handler: async (ctx, args): Promise<IdempotencyBegin> => {
    const now = Date.now();
    const row = await ctx.db
      .query("apiIdempotency")
      .withIndex("by_key", (q) => q.eq("keyId", args.keyId).eq("key", args.key))
      .unique();
    if (row && row.expiresAt > now) {
      if (row.fingerprint !== args.fingerprint) return { state: "mismatch" };
      if (row.state === "done" && row.status !== undefined && row.body !== undefined) {
        return { state: "replay", status: row.status, body: row.body };
      }
      if (now - row.updatedAt < IDEMPOTENCY_TAKEOVER_MS) return { state: "in_progress" };
      await ctx.db.patch("apiIdempotency", row._id, { updatedAt: now });
      return { state: "new" };
    }
    if (row) await ctx.db.delete("apiIdempotency", row._id);
    await ctx.db.insert("apiIdempotency", {
      keyId: args.keyId,
      key: args.key,
      fingerprint: args.fingerprint,
      state: "pending",
      createdAt: now,
      updatedAt: now,
      expiresAt: now + IDEMPOTENCY_TTL_MS,
    });
    return { state: "new" };
  },
});

/** Store the response of a claimed request (status < 500), or release the claim so a retry runs again. */
export const finishIdempotent = internalMutation({
  args: {
    keyId: v.id("apiKeys"),
    key: v.string(),
    fingerprint: v.string(),
    response: v.optional(v.object({ status: v.number(), body: v.string() })),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("apiIdempotency")
      .withIndex("by_key", (q) => q.eq("keyId", args.keyId).eq("key", args.key))
      .unique();
    if (!row || row.fingerprint !== args.fingerprint || row.state === "done") return null;
    if (!args.response) {
      await ctx.db.delete("apiIdempotency", row._id);
      return null;
    }
    await ctx.db.patch("apiIdempotency", row._id, {
      state: "done",
      status: args.response.status,
      body: args.response.body,
      updatedAt: Date.now(),
    });
    return null;
  },
});

/** Cron: drop expired idempotency records. */
export const purgeIdempotency = internalMutation({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db
      .query("apiIdempotency")
      .withIndex("by_expires", (q) => q.lt("expiresAt", Date.now()))
      .take(500);
    for (const row of rows) await ctx.db.delete("apiIdempotency", row._id);
    // Keep draining in bounded batches until the backlog is gone.
    if (rows.length === 500)
      await ctx.scheduler.runAfter(0, internal.api.gate.purgeIdempotency, {});
    return { deleted: rows.length };
  },
});
