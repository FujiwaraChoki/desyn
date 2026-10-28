import type { HttpRouter } from "convex/server";
import { internal } from "../_generated/api";
import { httpAction } from "../_generated/server";
import { authComponent, createAuth } from "../auth";
import { clientIpFrom } from "../lib/env";
import { createLogger } from "../lib/logger";

const JSON_HEADERS = { "content-type": "application/json", "cache-control": "no-store" };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

/**
 * POST /auth/native/token  { code, codeVerifier, redirectUri, deviceName? }
 *   200 { tokenType: "bearer", sessionToken, expiresAt, user: { id, email, name, emailVerified } }
 *   400 { error: "invalid_request" | "invalid_grant" | "slow_down" }
 * See convex/accounts/nativeAuth.ts for the full flow.
 */
const nativeToken = httpAction(async (ctx, request) => {
  const log = createLogger(ctx, { route: "/auth/native/token" });
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return json({ error: "invalid_request" }, 400);
  }
  const { code, codeVerifier, redirectUri, deviceName } = body;
  if (
    typeof code !== "string" ||
    typeof codeVerifier !== "string" ||
    typeof redirectUri !== "string"
  ) {
    return json({ error: "invalid_request" }, 400);
  }
  const result = await ctx.runMutation(internal.accounts.nativeAuth.consumeCode, {
    code,
    codeVerifier,
    redirectUri,
  });
  if (!result.ok) {
    log.warn("native token exchange rejected", { error: result.error });
    await log.flush();
    return json({ error: result.error }, result.error === "slow_down" ? 429 : 400);
  }
  const user = await authComponent.getAnyUserById(ctx, result.userId);
  if (!user) return json({ error: "invalid_grant" }, 400);
  const auth = createAuth(ctx);
  const authContext = await auth.$context;
  const userAgent = [
    request.headers.get("user-agent"),
    typeof deviceName === "string" ? deviceName : null,
  ]
    .filter(Boolean)
    .join(" · ")
    .slice(0, 300);
  const ipAddress = clientIpFrom(request.headers);
  const session = await authContext.internalAdapter.createSession(result.userId, false, {
    ...(userAgent ? { userAgent } : {}),
    ...(ipAddress ? { ipAddress } : {}),
  });
  if (!session) return json({ error: "server_error" }, 500);
  await ctx.runMutation(internal.accounts.nativeAuth.recordSession, {
    userId: result.userId,
    client: result.client,
    ...(typeof deviceName === "string" ? { deviceName } : {}),
  });
  log.info("native session created", { client: result.client });
  await log.flush();
  return json({
    tokenType: "bearer",
    sessionToken: session.token,
    expiresAt: new Date(session.expiresAt).getTime(),
    user: { id: user._id, email: user.email, name: user.name, emailVerified: user.emailVerified },
  });
});

export function registerAuthRoutes(http: HttpRouter): void {
  // Better Auth endpoints under /api/auth/* (the web app proxies them from its own origin). CORS is
  // limited to the trusted origins configured in convex/auth.ts.
  authComponent.registerRoutes(http, createAuth, { cors: true });
  http.route({ path: "/auth/native/token", method: "POST", handler: nativeToken });
}
