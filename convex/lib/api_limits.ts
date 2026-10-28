import { MINUTE, RateLimiter } from "@convex-dev/rate-limiter";
import { components } from "../_generated/api";

// Agent API limits (REST v1 + MCP). Rate limiting is a token bucket per API key; heavier endpoints cost more
// tokens (route `cost`). AI spending is limited separately by credits and the fair-use caps in plans.json.

export const API_RATE = { requestsPerMinute: 600, burst: 120 } as const;

export const apiRateLimiter = new RateLimiter(components.rateLimiter, {
  apiKeyRequests: {
    kind: "token bucket",
    rate: API_RATE.requestsPerMinute,
    period: MINUTE,
    capacity: API_RATE.burst,
  },
});

/** Idempotency records live this long. */
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60_000;
/** A pending record older than this belongs to a request that died; a retry may take it over. */
export const IDEMPOTENCY_TAKEOVER_MS = 2 * 60_000;
/** Responses larger than this are not stored (the record is dropped and retries run again). */
export const IDEMPOTENCY_MAX_BODY = 512_000;

/** Request bodies above this are rejected with 413 (uploads go to S3 directly). */
export const MAX_REQUEST_BYTES = 4 * 1024 * 1024;
/** Documents above this many nodes are refused by describe / preview (the worker would time out). */
export const MAX_RENDER_NODES = 50_000;
