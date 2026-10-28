import {
  API_BASE_PATH,
  compilePath,
  matchPath,
  ROUTES,
  type RouteDef,
  type RouteId,
} from "@desyn/sdk/contract";
import { buildOpenApi } from "@desyn/sdk/openapi";
import type { HttpRouter } from "convex/server";
import { internal } from "../_generated/api";
import { type ActionCtx, httpAction } from "../_generated/server";
import { type HandlerOutput, handlerFor } from "../lib/api_handlers";
import {
  type ApiCaller,
  ApiError,
  admitCaller,
  apiPathOf,
  authenticate,
  CORS_HEADERS,
  errorResponse,
  jsonResponse,
  newRequestId,
  parseWith,
  queryObject,
  readJson,
  requireScopes,
  toErrorPayload,
} from "../lib/api_http";
import { IDEMPOTENCY_MAX_BODY, MAX_REQUEST_BYTES } from "../lib/api_limits";
import { sha256Hex } from "../lib/crypto";
import { convexSiteUrl } from "../lib/env";
import { createLogger } from "../lib/logger";

// Agent API v1 (REST) at /api/v1/*. The route table, validation schemas and OpenAPI document come from
// @desyn/sdk/contract; handlers live in lib/api_handlers.ts and call convex/api/* with the verified principal.

const COMPILED = (ROUTES as readonly RouteDef[]).map((route) => ({
  route,
  matcher: compilePath(route.path),
}));

let openApiCache: string | null = null;
function openApiJson(): string {
  if (!openApiCache) {
    const site = convexSiteUrl();
    openApiCache = JSON.stringify(
      buildOpenApi({
        servers: [
          { url: "https://api.desyn.app", description: "desyn.app" },
          ...(site && !site.includes("api.desyn.app")
            ? [{ url: site, description: "This installation" }]
            : []),
        ],
      }),
    );
  }
  return openApiCache;
}

const IDEMPOTENCY_KEY = /^[\x21-\x7e]{1,255}$/;

function serialize(
  out: HandlerOutput,
  status: number,
): { status: number; body: string; headers: Record<string, string> } {
  if (out instanceof Response) throw new Error("binary responses are not serialized");
  return {
    status: out.status ?? status,
    body: JSON.stringify(out.body),
    headers: out.headers ?? {},
  };
}

/**
 * Serve one REST request. With `caller` the request was already authenticated (the MCP endpoint calls the
 * API in-process for its tools): the key is not verified again, but scopes, plan and rate limit still apply.
 */
export async function dispatchApi(
  ctx: ActionCtx,
  req: Request,
  opts: { caller?: ApiCaller } = {},
): Promise<Response> {
  const requestId = newRequestId();
  const started = Date.now();
  const url = new URL(req.url);
  const method = req.method.toUpperCase();
  const log = createLogger(ctx, { fn: "api", method, path: url.pathname, requestId });
  let routeId: RouteId | "openapi" | "index" | null = null;
  let response: Response;
  try {
    if (method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
    const path = apiPathOf(url);
    if (path === null) throw new ApiError("NOT_FOUND", "No such endpoint.");
    if (path === "/openapi.json" && method === "GET") {
      routeId = "openapi";
      return new Response(openApiJson(), {
        status: 200,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "public, max-age=300",
          ...CORS_HEADERS,
        },
      });
    }
    if (path === "/" && method === "GET") {
      routeId = "index";
      return jsonResponse(200, {
        name: "Desyn Agent API",
        version: "v1",
        openapi: `${API_BASE_PATH}/openapi.json`,
        docs: "https://docs.desyn.app/developers/api",
        mcp: "/mcp",
      });
    }
    const allowed: string[] = [];
    let found: { route: RouteDef; params: Record<string, string> } | null = null;
    for (const { route, matcher } of COMPILED) {
      const params = matchPath(matcher, path);
      if (!params) continue;
      if (route.method === method) {
        found = { route, params };
        break;
      }
      allowed.push(route.method);
    }
    if (!found) {
      if (allowed.length > 0) {
        throw new ApiError(
          "METHOD_NOT_ALLOWED",
          `Use ${allowed.join(" or ")} for this endpoint.`,
          {},
          {
            allow: [...allowed, "OPTIONS"].join(", "),
          },
        );
      }
      throw new ApiError("NOT_FOUND", "No such endpoint.");
    }
    const { route } = found;
    routeId = route.id as RouteId;
    const caller = opts.caller
      ? await admitCaller(ctx, opts.caller, route.cost ?? 1)
      : await authenticate(ctx, req, { surface: "rest", cost: route.cost ?? 1 });
    requireScopes(caller, route.scopes);
    const params = (
      route.params ? parseWith(route.params, found.params, "path") : found.params
    ) as Record<string, string>;
    const query = route.query ? parseWith(route.query, queryObject(url), "query") : {};
    const { raw, value } =
      method === "GET" || method === "DELETE"
        ? { raw: "", value: undefined }
        : await readJson(req, MAX_REQUEST_BYTES);
    const body = route.body ? parseWith(route.body, value ?? {}, "body") : undefined;

    const idempotencyKey = route.idempotent ? req.headers.get("idempotency-key") : null;
    if (idempotencyKey !== null && !IDEMPOTENCY_KEY.test(idempotencyKey)) {
      throw new ApiError(
        "INVALID_ARGUMENT",
        "Idempotency-Key must be 1-255 printable ASCII characters.",
        {
          field: "Idempotency-Key",
        },
      );
    }
    const fingerprint = idempotencyKey ? await sha256Hex(`${method} ${path}\n${raw}`) : "";
    if (idempotencyKey) {
      const begun = await ctx.runMutation(internal.api.gate.beginIdempotent, {
        keyId: caller.keyId,
        key: idempotencyKey,
        fingerprint,
      });
      if (begun.state === "replay") {
        return new Response(begun.body, {
          status: begun.status,
          headers: {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "no-store",
            "idempotent-replayed": "true",
            "x-request-id": requestId,
            ...CORS_HEADERS,
          },
        });
      }
      if (begun.state === "in_progress") {
        throw new ApiError(
          "IDEMPOTENCY_IN_PROGRESS",
          "A request with this Idempotency-Key is still running.",
          {},
          {
            "retry-after": "1",
          },
        );
      }
      if (begun.state === "mismatch") {
        throw new ApiError(
          "IDEMPOTENCY_KEY_REUSED",
          "This Idempotency-Key was used for a different request. Use a new key per request.",
        );
      }
    }

    let out: HandlerOutput;
    try {
      out = await handlerFor(routeId)({
        ctx,
        caller,
        params,
        query,
        body,
        idempotencyKey,
        requestId,
        req,
      });
    } catch (err) {
      if (idempotencyKey) {
        const payload = toErrorPayload(err);
        const status = errorResponse(payload, requestId).status;
        // Deterministic client errors are stored and replayed; transient failures release the key.
        const store = status < 500 && status !== 409 && status !== 429;
        await ctx.runMutation(internal.api.gate.finishIdempotent, {
          keyId: caller.keyId,
          key: idempotencyKey,
          fingerprint,
          ...(store
            ? {
                response: {
                  status,
                  body: JSON.stringify({
                    error: { code: payload.code, message: payload.message, ...payload.extra },
                  }),
                },
              }
            : {}),
        });
      }
      throw err;
    }
    if (out instanceof Response) {
      // Binary and streamed bodies are never stored: release the claim so a retry runs again instead of
      // answering IDEMPOTENCY_IN_PROGRESS until the takeover window passes.
      if (idempotencyKey) {
        await ctx.runMutation(internal.api.gate.finishIdempotent, {
          keyId: caller.keyId,
          key: idempotencyKey,
          fingerprint,
        });
      }
      for (const [k, v] of Object.entries(CORS_HEADERS)) out.headers.set(k, v);
      out.headers.set("x-request-id", requestId);
      response = out;
    } else {
      const s = serialize(out, route.status);
      if (idempotencyKey) {
        await ctx.runMutation(internal.api.gate.finishIdempotent, {
          keyId: caller.keyId,
          key: idempotencyKey,
          fingerprint,
          ...(s.body.length <= IDEMPOTENCY_MAX_BODY
            ? { response: { status: s.status, body: s.body } }
            : {}),
        });
      }
      response = new Response(s.body, {
        status: s.status,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
          "x-request-id": requestId,
          ...CORS_HEADERS,
          ...s.headers,
        },
      });
    }
  } catch (err) {
    const payload = toErrorPayload(err);
    response = errorResponse(payload, requestId);
    // 501 NOT_CONFIGURED is an expected state of an installation, not a failure.
    if (response.status >= 500 && response.status !== 501) {
      log.error("api request failed", {
        route: routeId,
        code: payload.code,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  log.info("api request", { route: routeId, status: response.status, ms: Date.now() - started });
  if (response.status >= 500 && response.status !== 501) await log.flush();
  return response;
}

const handler = httpAction(async (ctx, req) => await dispatchApi(ctx, req));

export function registerApiRoutes(http: HttpRouter): void {
  for (const method of ["GET", "POST", "PATCH", "DELETE", "OPTIONS"] as const) {
    http.route({ pathPrefix: `${API_BASE_PATH}/`, method, handler });
  }
  http.route({ path: API_BASE_PATH, method: "GET", handler });
}
