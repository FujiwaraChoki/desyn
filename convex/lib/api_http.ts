import {
  API_BASE_PATH,
  type ApiErrorCode,
  type ApiScope,
  ERROR_STATUS,
  type Schema,
  type SchemaOutput,
  validate,
} from "@desyn/sdk/contract";
import { ConvexError } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import type { Principal } from "./api_principal";
import { apiKeyFromHeaders } from "./apiKeys";
import { randomAlphanumeric } from "./crypto";
import { clientIpFrom } from "./env";
import type { ErrorData } from "./errors";

// HTTP plumbing shared by the REST API (routes/api.ts) and the MCP endpoint (routes/mcp.ts): errors in the
// `{ error: { code, message, … } }` format, CORS, API-key authentication and admission (plan features +
// rate limit).

export class ApiError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    message: string,
    readonly extra: Record<string, unknown> = {},
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
  }
}

export const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, PATCH, DELETE, OPTIONS",
  "access-control-allow-headers":
    "authorization, content-type, x-api-key, idempotency-key, last-event-id, accept, mcp-protocol-version, mcp-session-id",
  "access-control-expose-headers":
    "retry-after, x-request-id, idempotent-replayed, x-desyn-seq, mcp-session-id, mcp-protocol-version, ratelimit-policy",
  "access-control-max-age": "600",
};

export function newRequestId(): string {
  return `req_${randomAlphanumeric(16)}`;
}

export function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...CORS_HEADERS,
      ...headers,
    },
  });
}

export interface ErrorPayload {
  code: ApiErrorCode;
  message: string;
  extra: Record<string, unknown>;
  headers: Record<string, string>;
}

const KNOWN_CODES = new Set<string>(Object.keys(ERROR_STATUS));

/** Normalize anything thrown by handlers or Convex functions into an API error. */
export function toErrorPayload(err: unknown): ErrorPayload {
  if (err instanceof ApiError) {
    return { code: err.code, message: err.message, extra: err.extra, headers: err.headers };
  }
  if (err instanceof ConvexError) {
    let data = err.data as unknown;
    if (typeof data === "string") {
      try {
        data = JSON.parse(data);
      } catch {
        data = { code: "INTERNAL", message: data };
      }
    }
    const { code, message, ...extra } = (data ?? {}) as Partial<ErrorData>;
    if (typeof code === "string" && KNOWN_CODES.has(code)) {
      const headers: Record<string, string> = {};
      if (code === "RATE_LIMITED" && typeof extra.retryAfterMs === "number") {
        headers["retry-after"] = String(Math.max(1, Math.ceil(extra.retryAfterMs / 1000)));
      }
      return {
        code: code as ApiErrorCode,
        message: typeof message === "string" ? message : code,
        extra,
        headers,
      };
    }
  }
  return {
    code: "INTERNAL",
    message: "Something went wrong on our side. Retrying with backoff is safe.",
    extra: {},
    headers: {},
  };
}

export function errorResponse(payload: ErrorPayload, requestId: string): Response {
  return jsonResponse(
    ERROR_STATUS[payload.code],
    { error: { code: payload.code, message: payload.message, requestId, ...payload.extra } },
    { "x-request-id": requestId, ...payload.headers },
  );
}

/** An authenticated API key: the member it acts as and its effective scopes. */
export interface ApiCaller {
  keyId: Id<"apiKeys">;
  principal: Principal;
  role: string;
  scopes: ApiScope[];
}

const UNAUTHENTICATED_HEADERS = { "www-authenticate": 'Bearer realm="desyn"' };

/**
 * Verify the API key of a request (Authorization: Bearer dsk_… or x-api-key) and admit it: the owner's plan
 * must include the Agent API (and MCP for that surface) and the key's rate limit must allow `cost` tokens.
 */
export async function authenticate(
  ctx: ActionCtx,
  req: Request,
  opts: { surface: "rest" | "mcp"; cost: number },
): Promise<ApiCaller> {
  const secret = apiKeyFromHeaders(req.headers);
  if (!secret) {
    const sent = req.headers.has("authorization") || req.headers.has("x-api-key");
    throw new ApiError(
      "UNAUTHENTICATED",
      sent
        ? "The API key is malformed. Keys look like dsk_ followed by 43 characters."
        : "Send an API key as Authorization: Bearer dsk_… or x-api-key.",
      {},
      UNAUTHENTICATED_HEADERS,
    );
  }
  const ip = clientIpFrom(req.headers);
  const verified = await ctx.runMutation(internal.accounts.apiKeys.verify, {
    secret,
    ...(ip ? { ip } : {}),
  });
  if (!verified) {
    throw new ApiError(
      "UNAUTHENTICATED",
      "The API key is invalid, expired or revoked.",
      {},
      UNAUTHENTICATED_HEADERS,
    );
  }
  return await admitCaller(
    ctx,
    {
      keyId: verified.keyId,
      principal: { userId: verified.userId, workspaceId: verified.workspaceId },
      role: verified.role,
      scopes: verified.scopes as ApiScope[],
    },
    opts.cost,
    opts.surface,
  );
}

/** Plan features and the key's rate limit, for an already verified key. */
export async function admitCaller(
  ctx: ActionCtx,
  caller: ApiCaller,
  cost: number,
  surface: "rest" | "mcp" = "rest",
): Promise<ApiCaller> {
  const admitted = await ctx.runMutation(internal.api.gate.admit, {
    keyId: caller.keyId,
    userId: caller.principal.userId,
    surface,
    cost,
  });
  if (!admitted.ok) {
    if (admitted.code === "RATE_LIMITED") {
      throw new ApiError(
        "RATE_LIMITED",
        "Too many requests for this API key. Slow down and retry after the delay.",
        { retryAfterMs: admitted.retryAfterMs, scope: "apiKey" },
        { "retry-after": String(Math.max(1, Math.ceil(admitted.retryAfterMs / 1000))) },
      );
    }
    throw new ApiError(
      "FEATURE_UNAVAILABLE",
      admitted.feature === "mcp"
        ? "The MCP server is not included in this plan."
        : "The Agent API is not included in this plan.",
      { feature: admitted.feature },
    );
  }
  return caller;
}

export function requireScopes(caller: ApiCaller, required: readonly ApiScope[]): void {
  const missing = required.filter((s) => !caller.scopes.includes(s));
  if (missing.length > 0) {
    throw new ApiError(
      "INSUFFICIENT_SCOPE",
      `This API key lacks the ${missing.join(", ")} scope${missing.length > 1 ? "s" : ""} (or the member lost the editor role).`,
      { required: [...required] },
    );
  }
}

/** Path below /api/v1 ("" for the base). */
export function apiPathOf(url: URL): string | null {
  if (url.pathname === API_BASE_PATH) return "/";
  if (!url.pathname.startsWith(`${API_BASE_PATH}/`)) return null;
  return url.pathname.slice(API_BASE_PATH.length) || "/";
}

/** Read a JSON body with a size limit. Empty bodies are `undefined`. */
export async function readJson(
  req: Request,
  maxBytes: number,
): Promise<{ raw: string; value: unknown }> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > maxBytes) {
    throw new ApiError("PAYLOAD_TOO_LARGE", `Request bodies can be at most ${maxBytes} bytes.`);
  }
  const raw = await req.text();
  if (new TextEncoder().encode(raw).length > maxBytes) {
    throw new ApiError("PAYLOAD_TOO_LARGE", `Request bodies can be at most ${maxBytes} bytes.`);
  }
  if (raw.trim() === "") return { raw, value: undefined };
  const type = req.headers.get("content-type") ?? "";
  if (type && !/^application\/(?:[\w.+-]+\+)?json\b/i.test(type)) {
    throw new ApiError("UNSUPPORTED_MEDIA_TYPE", "Send request bodies as application/json.");
  }
  try {
    return { raw, value: JSON.parse(raw) };
  } catch {
    throw new ApiError("INVALID_ARGUMENT", "The request body is not valid JSON.");
  }
}

/** Parse a value with a contract schema; failures become INVALID_ARGUMENT with issue paths. */
export function parseWith<T extends Schema>(
  schema: T,
  value: unknown,
  where: "body" | "query" | "path",
): SchemaOutput<T> {
  const result = validate(schema, value);
  if (!result.success) {
    const first = result.issues[0];
    const field = first ? [where, ...first.path].join(".") : where;
    throw new ApiError(
      "INVALID_ARGUMENT",
      first ? `Invalid ${field}: ${first.message}` : `Invalid ${where}.`,
      { field, issues: result.issues },
    );
  }
  return result.data;
}

/** Query string to a plain object (repeated keys keep the last value). */
export function queryObject(url: URL): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of url.searchParams) out[k] = v;
  return out;
}
