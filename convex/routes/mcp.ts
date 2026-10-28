import { DesynClient, type FetchLike } from "@desyn/sdk";
import { API_BASE_PATH } from "@desyn/sdk/contract";
import { createMcpServer, handleStreamableHttp } from "@desyn/sdk/mcp";
import type { HttpRouter } from "convex/server";
import { type ActionCtx, httpAction } from "../_generated/server";
import {
  ApiError,
  authenticate,
  CORS_HEADERS,
  errorResponse,
  newRequestId,
  requireScopes,
  toErrorPayload,
} from "../lib/api_http";
import { MAX_REQUEST_BYTES } from "../lib/api_limits";
import { apiKeyFromHeaders } from "../lib/apiKeys";
import { appUrl, env, siteUrl } from "../lib/env";
import { createLogger } from "../lib/logger";
import { dispatchApi } from "./api";

// MCP server at /mcp (Streamable HTTP, stateless). Authenticated with an API key that carries the `mcp`
// scope; every tool call runs the REST API in-process with the same key, so tool scopes, plan limits and the
// key's rate limit apply exactly as for REST calls.

/** Browser origins allowed to call /mcp (requests without Origin, e.g. from agents, are always allowed). */
function allowedOrigins(): string[] {
  const out = new Set<string>();
  for (const url of [appUrl(), siteUrl()]) {
    try {
      out.add(new URL(url).origin);
    } catch {
      // Unset or malformed URLs simply add nothing.
    }
  }
  for (const o of (env.get("MCP_ALLOWED_ORIGINS") ?? "").split(",")) {
    const trimmed = o.trim();
    if (trimmed) out.add(trimmed);
  }
  return [...out];
}

async function serveMcp(ctx: ActionCtx, req: Request): Promise<Response> {
  const requestId = newRequestId();
  const started = Date.now();
  const log = createLogger(ctx, { fn: "mcp", method: req.method, requestId });
  let response: Response;
  try {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
    const declared = Number(req.headers.get("content-length") ?? "0");
    if (declared > MAX_REQUEST_BYTES + 512_000) {
      throw new ApiError("PAYLOAD_TOO_LARGE", "MCP messages can be at most 4.5 MB.");
    }
    // Origin first (DNS-rebinding protection per the MCP transport spec): a disallowed browser origin is
    // refused before the key is verified or its rate-limit bucket is charged.
    const origin = req.headers.get("origin");
    const origins = allowedOrigins();
    if (origin && !origins.includes(origin)) {
      throw new ApiError("FORBIDDEN", `Origin ${origin} is not allowed to call the MCP server.`);
    }
    const caller = await authenticate(ctx, req, { surface: "mcp", cost: 1 });
    requireScopes(caller, ["mcp"]);
    const apiBase = `${new URL(req.url).origin}${API_BASE_PATH}`;
    // Tool calls go to the REST dispatcher in-process; other URLs (presigned storage uploads) use the network.
    const fetchImpl: FetchLike = async (input, init) => {
      const request = new Request(input, init);
      if (request.url.startsWith(`${apiBase}/`)) return await dispatchApi(ctx, request, { caller });
      return await fetch(request);
    };
    // In-process calls skip verification (the caller is passed along); the key only fills the header.
    const client = new DesynClient({
      apiKey: apiKeyFromHeaders(req.headers) ?? "",
      baseUrl: apiBase,
      fetch: fetchImpl,
      maxRetries: 0,
    });
    const server = createMcpServer({ client });
    response = await handleStreamableHttp(server, req, { allowedOrigins: origins });
    for (const [k, v] of Object.entries(CORS_HEADERS)) response.headers.set(k, v);
    response.headers.set("x-request-id", requestId);
  } catch (err) {
    const payload = toErrorPayload(err);
    response = errorResponse(payload, requestId);
    // 501 NOT_CONFIGURED is an expected state of an installation, not a failure.
    if (response.status >= 500 && response.status !== 501) {
      log.error("mcp request failed", { error: err instanceof Error ? err.message : String(err) });
    }
  }
  log.info("mcp request", { status: response.status, ms: Date.now() - started });
  if (response.status >= 500 && response.status !== 501) await log.flush();
  return response;
}

const handler = httpAction(async (ctx, req) => await serveMcp(ctx, req));

export function registerMcpRoutes(http: HttpRouter): void {
  for (const method of ["POST", "GET", "DELETE", "OPTIONS"] as const) {
    http.route({ path: "/mcp", method, handler });
  }
}
