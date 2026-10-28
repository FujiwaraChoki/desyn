import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import { isAllowedRedirectUri } from "../accounts/nativeAuth";
import { randomToken, sha256Bytes, toBase64Url } from "../lib/crypto";
import { createUser, errorData, setupTest } from "./harness.helpers";

async function pkce() {
  const verifier = randomToken(48);
  const challenge = toBase64Url(await sha256Bytes(verifier));
  return { verifier, challenge };
}

function exchange(t: ReturnType<typeof setupTest>, body: unknown) {
  return t.fetch("/auth/native/token", {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": "DesynDesktop/1.0" },
    body: JSON.stringify(body),
  });
}

describe("native sign-in (authorization code + PKCE)", () => {
  beforeEach(() => {
    vi.stubEnv("BETTER_AUTH_SECRET", "test-better-auth-secret-at-least-32-chars");
    vi.stubEnv("APP_URL", "http://localhost:4104");
    vi.stubEnv("CONVEX_SITE_URL", "http://127.0.0.1:3211");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  test("redirect URI allowlist", () => {
    expect(isAllowedRedirectUri("desyn://auth/callback")).toBe(true);
    expect(isAllowedRedirectUri("http://127.0.0.1:53682/callback")).toBe(true);
    expect(isAllowedRedirectUri("http://localhost:8080/cb")).toBe(true);
    expect(isAllowedRedirectUri("http://127.0.0.1/callback")).toBe(false);
    expect(isAllowedRedirectUri("https://evil.example/callback")).toBe(false);
    expect(isAllowedRedirectUri("desyn://other")).toBe(false);
  });

  test("code exchange creates a separate bearer session usable against the auth API", async () => {
    const t = setupTest();
    const u = await createUser(t, { email: "native@example.com" });
    const { verifier, challenge } = await pkce();
    const { code } = await u.as.mutation(api.accounts.nativeAuth.createCode, {
      client: "desktop",
      redirectUri: "desyn://auth/callback",
      codeChallenge: challenge,
      codeChallengeMethod: "S256",
    });

    // Wrong verifier burns the code.
    const bad = await exchange(t, {
      code,
      codeVerifier: (await pkce()).verifier,
      redirectUri: "desyn://auth/callback",
    });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: "invalid_grant" });
    const replay = await exchange(t, {
      code,
      codeVerifier: verifier,
      redirectUri: "desyn://auth/callback",
    });
    expect(replay.status).toBe(400);

    const second = await pkce();
    const fresh = await u.as.mutation(api.accounts.nativeAuth.createCode, {
      client: "ios",
      redirectUri: "desyn://auth/callback",
      codeChallenge: second.challenge,
      codeChallengeMethod: "S256",
    });
    const mismatch = await exchange(t, {
      code: fresh.code,
      codeVerifier: second.verifier,
      redirectUri: "http://127.0.0.1:9/cb",
    });
    expect(mismatch.status).toBe(400);

    const third = await pkce();
    const good = await u.as.mutation(api.accounts.nativeAuth.createCode, {
      client: "ios",
      redirectUri: "desyn://auth/callback",
      codeChallenge: third.challenge,
      codeChallengeMethod: "S256",
    });
    const ok = await exchange(t, {
      code: good.code,
      codeVerifier: third.verifier,
      redirectUri: "desyn://auth/callback",
      deviceName: "iPhone",
    });
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as {
      tokenType: string;
      sessionToken: string;
      expiresAt: number;
      user: { id: string; email: string };
    };
    expect(body).toMatchObject({
      tokenType: "bearer",
      user: { id: u.userId, email: "native@example.com" },
    });
    expect(body.expiresAt).toBeGreaterThan(Date.now());

    const session = await t.fetch("/api/auth/get-session", {
      headers: { authorization: `Bearer ${body.sessionToken}` },
    });
    expect(((await session.json()) as { user: { id: string } }).user.id).toBe(u.userId);
    const jwt = await t.fetch("/api/auth/convex/token", {
      headers: { authorization: `Bearer ${body.sessionToken}` },
    });
    expect(jwt.status).toBe(200);

    // The new session is listed (and revocable) for the user.
    const sessions = await u.as.query(api.accounts.sessions.list, {});
    expect(sessions).toHaveLength(2);
    expect(sessions.find((s) => s.current)?.id).toBe(u.sessionId);
    const nativeSession = sessions.find((s) => !s.current);
    expect(nativeSession?.userAgent).toContain("iPhone");
    expect(await u.as.mutation(api.accounts.sessions.revokeOthers, {})).toEqual({ revoked: 1 });
    const after = await t.fetch("/api/auth/get-session", {
      headers: { authorization: `Bearer ${body.sessionToken}` },
    });
    expect(await after.json()).toBeNull();
  });

  test("codes expire and inputs are validated", async () => {
    vi.useFakeTimers();
    const t = setupTest();
    const u = await createUser(t);
    const { verifier, challenge } = await pkce();
    expect(
      (
        await errorData(
          u.as.mutation(api.accounts.nativeAuth.createCode, {
            client: "desktop",
            redirectUri: "https://evil.example/cb",
            codeChallenge: challenge,
            codeChallengeMethod: "S256",
          }),
        )
      ).code,
    ).toBe("INVALID_ARGUMENT");
    const { code } = await u.as.mutation(api.accounts.nativeAuth.createCode, {
      client: "desktop",
      redirectUri: "http://127.0.0.1:53682/callback",
      codeChallenge: challenge,
      codeChallengeMethod: "S256",
    });
    vi.setSystemTime(Date.now() + 6 * 60 * 1000);
    const res = await exchange(t, {
      code,
      codeVerifier: verifier,
      redirectUri: "http://127.0.0.1:53682/callback",
    });
    expect(await res.json()).toEqual({ error: "invalid_grant" });
    expect((await exchange(t, { code: 5 })).status).toBe(400);
  });
});
