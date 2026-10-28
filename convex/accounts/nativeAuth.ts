import { v } from "convex/values";
import { internalMutation, mutation } from "../_generated/server";
import { writeAudit } from "../lib/audit";
import { randomToken, sha256Hex, verifyPkceS256 } from "../lib/crypto";
import { env } from "../lib/env";
import { errors } from "../lib/errors";
import { requireUser } from "../lib/guards";
import { rateLimiter } from "../lib/rateLimits";
import { nativeClientValidator } from "../lib/validators";

// Native (desktop / iOS / CLI) sign-in: an OAuth-style authorization code + PKCE exchange.
//  1. The app creates a PKCE verifier and opens the system browser at
//     `${APP_URL}/native/authorize?client=desktop&redirect_uri=…&code_challenge=…&state=…`.
//  2. That web page (signed in through any web method) calls `accounts.nativeAuth.createCode`,
//     then redirects to `${redirect_uri}?code=…&state=…`.
//  3. The app POSTs `{ code, codeVerifier, redirectUri }` to `${CONVEX_SITE_URL}/auth/native/token`
//     and receives its own Better Auth session token (a separate, revocable session).
//  4. The app sends `Authorization: Bearer <sessionToken>` to `${CONVEX_SITE_URL}/api/auth/convex/token`
//     to get the short-lived Convex JWT for the Convex client (refresh when it expires).

export const CODE_TTL_MS = 5 * 60 * 1000;
const NATIVE_SCHEME_REDIRECTS = ["desyn://auth/callback"];

/** Allowed redirect URIs: the app scheme, loopback (RFC 8252 §7.3) and NATIVE_REDIRECT_URIS. */
export function isAllowedRedirectUri(uri: string): boolean {
  if (NATIVE_SCHEME_REDIRECTS.includes(uri)) return true;
  const extra = (env.get("NATIVE_REDIRECT_URIS") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (extra.includes(uri)) return true;
  try {
    const url = new URL(uri);
    const loopback =
      url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
    return (
      url.protocol === "http:" &&
      loopback &&
      url.port !== "" &&
      !url.username &&
      !url.password &&
      !url.hash
    );
  } catch {
    return false;
  }
}

/** Issue a one-time authorization code for a native client (called by the web authorize page). */
export const createCode = mutation({
  args: {
    client: nativeClientValidator,
    redirectUri: v.string(),
    codeChallenge: v.string(),
    codeChallengeMethod: v.literal("S256"),
  },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx, { verified: true });
    if (!isAllowedRedirectUri(args.redirectUri))
      throw errors.invalid("Redirect URI is not allowed.", "redirectUri");
    if (!/^[A-Za-z0-9_-]{43}$/.test(args.codeChallenge)) {
      throw errors.invalid("code_challenge must be a base64url SHA-256 digest.", "codeChallenge");
    }
    const limited = await rateLimiter.limit(ctx, "nativeAuthCode", { key: user.userId });
    if (!limited.ok) throw errors.rateLimited(limited.retryAfter, "nativeAuthCode");
    const code = randomToken(32);
    const now = Date.now();
    await ctx.db.insert("nativeAuthCodes", {
      codeHash: await sha256Hex(code),
      userId: user.userId,
      client: args.client,
      redirectUri: args.redirectUri,
      codeChallenge: args.codeChallenge,
      expiresAt: now + CODE_TTL_MS,
      createdAt: now,
    });
    await writeAudit(ctx, {
      action: "native.codeIssued",
      actorId: user.userId,
      data: { client: args.client },
    });
    return { code, expiresAt: now + CODE_TTL_MS };
  },
});

/**
 * Consume a code (internal; used by the /auth/native/token HTTP route). Single use: a replayed code
 * fails. Returns the user id on success or an OAuth-style error string.
 */
export const consumeCode = internalMutation({
  args: { code: v.string(), codeVerifier: v.string(), redirectUri: v.string() },
  handler: async (
    ctx,
    args,
  ): Promise<{ ok: true; userId: string; client: string } | { ok: false; error: string }> => {
    const global = await rateLimiter.limit(ctx, "nativeTokenExchange");
    if (!global.ok) return { ok: false, error: "slow_down" };
    if (args.code.length > 200 || args.codeVerifier.length > 200)
      return { ok: false, error: "invalid_request" };
    const codeHash = await sha256Hex(args.code);
    const row = await ctx.db
      .query("nativeAuthCodes")
      .withIndex("by_codeHash", (q) => q.eq("codeHash", codeHash))
      .unique();
    if (!row || row.usedAt !== undefined) return { ok: false, error: "invalid_grant" };
    await ctx.db.patch("nativeAuthCodes", row._id, { usedAt: Date.now() });
    if (row.expiresAt <= Date.now()) return { ok: false, error: "invalid_grant" };
    if (row.redirectUri !== args.redirectUri) return { ok: false, error: "invalid_grant" };
    if (!(await verifyPkceS256(args.codeVerifier, row.codeChallenge)))
      return { ok: false, error: "invalid_grant" };
    return { ok: true, userId: row.userId, client: row.client };
  },
});

export const recordSession = internalMutation({
  args: { userId: v.string(), client: v.string(), deviceName: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await writeAudit(ctx, {
      action: "native.sessionCreated",
      actorId: args.userId,
      data: {
        client: args.client,
        ...(args.deviceName ? { deviceName: args.deviceName.slice(0, 80) } : {}),
      },
    });
  },
});

/** Cron: drop expired or used codes. */
export const purgeExpired = internalMutation({
  args: {},
  handler: async (ctx) => {
    const cutoff = Date.now() - CODE_TTL_MS;
    const rows = await ctx.db
      .query("nativeAuthCodes")
      .withIndex("by_expiresAt", (q) => q.lt("expiresAt", cutoff))
      .take(500);
    for (const row of rows) await ctx.db.delete("nativeAuthCodes", row._id);
    return rows.length;
  },
});
