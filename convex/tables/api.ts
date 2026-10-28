import { defineTable } from "convex/server";
import { v } from "convex/values";

// Agent API (REST v1 + MCP) tables. Owned by the api agent.

export const apiTables = {
  /**
   * Idempotency records for POST requests with an `Idempotency-Key` header, per API key. The first request
   * stores its response; retries with the same key and request fingerprint replay it for 24 hours.
   */
  apiIdempotency: defineTable({
    keyId: v.id("apiKeys"),
    /** The client's Idempotency-Key header value. */
    key: v.string(),
    /** sha256 of method, path and body: the same key with a different request is rejected. */
    fingerprint: v.string(),
    state: v.union(v.literal("pending"), v.literal("done")),
    status: v.optional(v.number()),
    /** Stored JSON response body. */
    body: v.optional(v.string()),
    createdAt: v.number(),
    /** Pending records older than the takeover window are treated as abandoned. */
    updatedAt: v.number(),
    expiresAt: v.number(),
  })
    .index("by_key", ["keyId", "key"])
    .index("by_expires", ["expiresAt"]),
};
