import { afterEach, describe, expect, test, vi } from "vitest";
import {
  decryptSecret,
  encryptSecret,
  fromBase64Url,
  randomAlphanumeric,
  secretHint,
  toBase64Url,
  verifyPkceS256,
} from "../lib/crypto";
import { resolveFlag, rolloutBucket } from "../lib/flags";
import { redact } from "../lib/logger";
import { CREDIT_COSTS, FEATURE_KEYS, PLANS } from "../lib/plans";

describe("BYOK encryption", () => {
  afterEach(() => vi.unstubAllEnvs());

  test("round-trips with AES-GCM and binds ciphertexts to their AAD", async () => {
    vi.stubEnv("AI_KEY_ENCRYPTION_SECRET", "test-encryption-secret-0123456789");
    const blob = await encryptSecret("sk-provider-secret-value", { aad: "user1:openai" });
    expect(blob.startsWith("v1.")).toBe(true);
    expect(blob).not.toContain("sk-provider");
    expect(await decryptSecret(blob, { aad: "user1:openai" })).toBe("sk-provider-secret-value");
    await expect(decryptSecret(blob, { aad: "user2:openai" })).rejects.toThrow();
    const again = await encryptSecret("sk-provider-secret-value", { aad: "user1:openai" });
    expect(again).not.toBe(blob); // random IV
    vi.stubEnv("AI_KEY_ENCRYPTION_SECRET", "a-completely-different-secret-xyz");
    await expect(decryptSecret(blob, { aad: "user1:openai" })).rejects.toThrow();
  });

  test("refuses to run without a configured secret", async () => {
    vi.stubEnv("AI_KEY_ENCRYPTION_SECRET", "");
    await expect(encryptSecret("x")).rejects.toThrow(/AI_KEY_ENCRYPTION_SECRET/);
    expect(secretHint("sk-abcdefghijklmnop")).toBe("mnop");
    expect(secretHint("short")).toBe("");
  });
});

describe("crypto helpers", () => {
  test("base64url and PKCE S256 (RFC 7636 appendix B vector)", async () => {
    const bytes = new Uint8Array([0, 255, 128, 64]);
    expect(fromBase64Url(toBase64Url(bytes))).toEqual(bytes);
    expect(
      await verifyPkceS256(
        "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk",
        "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
      ),
    ).toBe(true);
    expect(
      await verifyPkceS256(
        "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXX",
        "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
      ),
    ).toBe(false);
    expect(await verifyPkceS256("short", "x")).toBe(false);
    expect(randomAlphanumeric(12)).toMatch(/^[a-z0-9]{12}$/);
  });

  test("logger redaction removes secrets", () => {
    expect(
      redact({
        password: "hunter2",
        nested: { apiKey: "k", ok: "visible" },
        token: "t",
        list: [{ secret: 1 }],
      }),
    ).toEqual({
      password: "[redacted]",
      nested: { apiKey: "[redacted]", ok: "visible" },
      token: "[redacted]",
      list: [{ secret: "[redacted]" }],
    });
  });
});

describe("plans and flags", () => {
  test("plans.json is resolved with ALL_TRUE features", () => {
    expect(PLANS.pro.features["ai.agent"]).toBe(true);
    expect(PLANS.free.features["ai.agent"]).toBe(false);
    expect(PLANS.selfhost.features.workflows).toBe(true);
    expect(PLANS.pro.limits.creditsPerMonth).toBe(600);
    expect(PLANS.selfhost.limits.designs).toBeNull();
    expect(FEATURE_KEYS).toContain("teams");
    expect(CREDIT_COSTS["ai.image"]).toBe(3);
  });

  test("flag resolution honors users, plans and rollouts", () => {
    const base = { key: "feature.ai.images", enabled: true };
    expect(resolveFlag(null, {})).toBeUndefined();
    expect(resolveFlag(base, { userId: "u", plan: "free" })).toBe(true);
    expect(resolveFlag({ ...base, plans: ["pro"] }, { plan: "free" })).toBeUndefined();
    expect(resolveFlag({ ...base, enabled: false, plans: ["pro"] }, { plan: "pro" })).toBe(false);
    expect(resolveFlag({ ...base, userIds: ["u1"] }, { userId: "u1" })).toBe(true);
    expect(resolveFlag({ ...base, userIds: ["u1"] }, { userId: "u2" })).toBeUndefined();
    const inBucket = rolloutBucket("user-x", base.key) < 50;
    expect(resolveFlag({ ...base, rollout: 50 }, { userId: "user-x" })).toBe(
      inBucket ? true : undefined,
    );
    expect(rolloutBucket("user-x", base.key)).toBe(rolloutBucket("user-x", base.key));
  });
});
