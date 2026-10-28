import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import { apiKeyFromHeaders, generateApiKey, hashApiKey, looksLikeApiKey } from "../lib/apiKeys";
import { sha256Hex } from "../lib/crypto";
import { createUser, errorData, setupTest } from "./harness.helpers";

describe("api key format and hashing", () => {
  test("keys are random, prefixed and hashed with sha256", async () => {
    const a = generateApiKey();
    const b = generateApiKey();
    expect(a.secret).not.toBe(b.secret);
    expect(looksLikeApiKey(a.secret)).toBe(true);
    expect(a.prefix).toBe(a.secret.slice(0, 12));
    expect(await hashApiKey(a.secret)).toBe(await sha256Hex(a.secret));
    expect(await hashApiKey(a.secret)).toMatch(/^[0-9a-f]{64}$/);
    // Known vector: sha256("abc").
    expect(await sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  test("keys are read from Authorization or x-api-key headers", () => {
    const { secret } = generateApiKey();
    expect(apiKeyFromHeaders(new Headers({ authorization: `Bearer ${secret}` }))).toBe(secret);
    expect(apiKeyFromHeaders(new Headers({ "x-api-key": secret }))).toBe(secret);
    expect(apiKeyFromHeaders(new Headers({ authorization: "Bearer not-a-key" }))).toBeNull();
  });
});

describe("api keys", () => {
  beforeEach(() => vi.stubEnv("DESYN_EDITION", "selfhost"));
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  test("create returns the secret once, stores only the hash, verifies and revokes", async () => {
    const t = setupTest();
    const u = await createUser(t);
    const [ws] = await u.as.query(api.accounts.workspaces.list, {});
    if (!ws) throw new Error("workspace");
    const created = await u.as.mutation(api.accounts.apiKeys.create, {
      workspaceId: ws.id,
      name: "CI bot",
      scopes: ["designs:read", "designs:write", "designs:read"],
    });
    expect(looksLikeApiKey(created.secret)).toBe(true);
    const stored = await t.run(async (ctx) => ctx.db.get("apiKeys", created.id));
    expect(stored?.hash).toBe(await hashApiKey(created.secret));
    expect(JSON.stringify(stored)).not.toContain(created.secret);
    expect(stored?.scopes).toEqual(["designs:read", "designs:write"]);

    const listed = await u.as.query(api.accounts.apiKeys.list, {});
    expect(listed).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain(created.secret);

    const verified = await t.mutation(internal.accounts.apiKeys.verify, {
      secret: created.secret,
      ip: "203.0.113.9",
    });
    expect(verified).toMatchObject({
      userId: u.userId,
      workspaceId: ws.id,
      role: "owner",
      scopes: ["designs:read", "designs:write"],
    });
    expect((await u.as.query(api.accounts.apiKeys.list, {}))[0]?.lastUsedAt).toBeTypeOf("number");
    expect(
      await t.mutation(internal.accounts.apiKeys.verify, { secret: generateApiKey().secret }),
    ).toBeNull();
    expect(await t.mutation(internal.accounts.apiKeys.verify, { secret: "garbage" })).toBeNull();

    const other = await createUser(t);
    expect(
      (await errorData(other.as.mutation(api.accounts.apiKeys.revoke, { keyId: created.id }))).code,
    ).toBe("NOT_FOUND");
    await u.as.mutation(api.accounts.apiKeys.revoke, { keyId: created.id });
    expect(
      await t.mutation(internal.accounts.apiKeys.verify, { secret: created.secret }),
    ).toBeNull();
  });

  test("expired keys fail and hosted Free users cannot create keys", async () => {
    vi.useFakeTimers();
    const t = setupTest();
    const u = await createUser(t);
    const [ws] = await u.as.query(api.accounts.workspaces.list, {});
    if (!ws) throw new Error("workspace");
    const key = await u.as.mutation(api.accounts.apiKeys.create, {
      workspaceId: ws.id,
      name: "short",
      scopes: ["ai:run"],
      expiresInDays: 1,
    });
    vi.setSystemTime(Date.now() + 2 * 86_400_000);
    expect(await t.mutation(internal.accounts.apiKeys.verify, { secret: key.secret })).toBeNull();

    vi.stubEnv("DESYN_EDITION", "hosted");
    const err = await errorData(
      u.as.mutation(api.accounts.apiKeys.create, {
        workspaceId: ws.id,
        name: "x",
        scopes: ["ai:run"],
      }),
    );
    expect(err).toMatchObject({ code: "FEATURE_UNAVAILABLE", feature: "agentApi" });
  });
});
