import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import { BlockedDestinationError, guardedFetch, isNonPublicAddress } from "../lib/ai_net";
import { encryptSecret } from "../lib/crypto";
import { designWithHeadline, providerHook, resetProviderHook, scriptedModel } from "./ai.helpers";
import {
  createUser,
  errorData,
  setupTest,
  type TestConvex,
  type TestUser,
} from "./harness.helpers";

// BYOK: keys are validated with the provider, stored encrypted (AES-GCM bound to user + provider), decrypted
// only inside run actions, bypass credits when the whole run is on the user's keys, and user-supplied base
// URLs are SSRF-guarded on the hosted edition.

vi.mock("../lib/ai_providers", async (orig) =>
  (await import("./ai.helpers")).mockProvidersModule(await orig()),
);

const SECRET = "test-encryption-secret-0123456789";
const { byokAad, decryptUserConfigs } =
  await vi.importActual<typeof import("../lib/ai_providers")>("../lib/ai_providers");
const drain = (t: TestConvex) => t.finishAllScheduledFunctions(vi.runOnlyPendingTimers);

async function makePro(t: TestConvex, userId: string) {
  await t.run(async (ctx) => {
    const profile = await ctx.db
      .query("profiles")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .unique();
    if (profile) await ctx.db.patch("profiles", profile._id, { plan: "pro" });
  });
}

async function storeKey(t: TestConvex, user: TestUser, provider: string, key: string) {
  const ciphertext = await encryptSecret(key, {
    aad: byokAad(user.userId, provider),
    secret: SECRET,
  });
  await t.mutation(internal.accounts.profiles.setByokKey, {
    userId: user.userId,
    provider,
    ciphertext,
    last4: key.slice(-4),
  });
}

/** fetch answering the OpenRouter key probe: 200 for the good key, 401 otherwise. */
function probeFetch(goodKey: string) {
  const calls: string[] = [];
  const fn = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push(url);
    const auth = new Headers(input instanceof Request ? input.headers : init?.headers).get(
      "authorization",
    );
    if (url === "https://openrouter.ai/api/v1/key") {
      return auth === `Bearer ${goodKey}`
        ? Response.json({ data: { label: "test" } })
        : new Response("unauthorized", { status: 401 });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  return { fn, calls };
}

beforeEach(() => {
  vi.stubEnv("DESYN_EDITION", "selfhost");
  vi.stubEnv("MAIL_TRANSPORT", "log");
  vi.stubEnv("AI_KEY_ENCRYPTION_SECRET", SECRET);
  resetProviderHook();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("BYOK keys", () => {
  test("saveByokKey validates with the provider, stores only ciphertext and the hint", async () => {
    const t = setupTest();
    const user = await createUser(t);
    const probe = probeFetch("sk-or-good-key-123456");
    vi.stubGlobal("fetch", probe.fn);
    const bad = await errorData(
      user.as.action(api.ai.settings.saveByokKey, {
        provider: "openrouter",
        apiKey: "sk-or-wrong-key-0000",
      }),
    );
    expect(bad).toMatchObject({ code: "INVALID_ARGUMENT", field: "apiKey" });
    const saved = await user.as.action(api.ai.settings.saveByokKey, {
      provider: "openrouter",
      apiKey: "sk-or-good-key-123456",
      label: "Personal",
    });
    expect(saved).toEqual({ provider: "openrouter", last4: "3456" });
    const settings = await t.query(internal.accounts.profiles.getAiSettings, {
      userId: user.userId,
    });
    const entry = settings?.byok?.openrouter;
    expect(entry?.ciphertext).toMatch(/^v1\./);
    expect(JSON.stringify(settings)).not.toContain("good-key");
    const view = await user.as.query(api.ai.prefs.get, {});
    expect(view.providers.find((p) => p.id === "openrouter")).toMatchObject({
      available: true,
      billing: "byok",
      key: { last4: "3456", label: "Personal" },
    });
    // The stored key is used by the server-side connectivity test.
    const tested = await user.as.action(api.ai.settings.testProvider, { provider: "openrouter" });
    expect(tested.ok).toBe(true);
    expect(tested.message).toContain("your key");
    const alias = await user.as.action(api.ai.providers.test, { provider: "fal" });
    expect(alias).toMatchObject({ ok: false });
  });

  test("hosted: BYOK needs the plan feature and refuses private base URLs", async () => {
    const t = setupTest();
    vi.stubEnv("DESYN_EDITION", "hosted");
    const free = await createUser(t);
    const gated = await errorData(
      free.as.action(api.ai.settings.saveByokKey, {
        provider: "openai",
        apiKey: "sk-test-123456789",
      }),
    );
    expect(gated).toMatchObject({ code: "FEATURE_UNAVAILABLE", feature: "ai.byok" });
    const pro = await createUser(t);
    await makePro(t, pro.userId);
    for (const baseUrl of [
      "http://127.0.0.1:11434",
      "https://10.0.0.5/v1",
      "https://169.254.169.254/latest",
    ]) {
      const err = await errorData(
        pro.as.action(api.ai.settings.saveByokKey, {
          provider: "openai-compatible",
          apiKey: "sk-test-123456789",
          baseUrl,
        }),
      );
      expect(err).toMatchObject({ code: "INVALID_ARGUMENT", field: "baseUrl" });
    }
  });

  test("decryption: user keys win unless preferByok is off; unreadable keys are reported", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "server-openrouter-key");
    const userId = "user-123";
    const ciphertext = await encryptSecret("sk-user-openrouter-1", {
      aad: byokAad(userId, "openrouter"),
      secret: SECRET,
    });
    const foreign = await encryptSecret("sk-someone-else-1234", {
      aad: byokAad("other-user", "anthropic"),
      secret: SECRET,
    });
    const settings = {
      byok: {
        openrouter: { ciphertext, updatedAt: 1 },
        anthropic: { ciphertext: foreign, updatedAt: 1 },
      },
    };
    const on = await decryptUserConfigs({
      userId,
      settings,
      byokAllowed: true,
      localAllowed: true,
    });
    expect(on.configs.openrouter).toEqual({ apiKey: "sk-user-openrouter-1" });
    expect(on.failed).toEqual(["anthropic"]); // bound to another user: AAD mismatch
    const off = await decryptUserConfigs({
      userId,
      settings: { ...settings, preferByok: false },
      byokAllowed: true,
      localAllowed: true,
    });
    expect(off.configs.openrouter).toBeUndefined();
    const notAllowed = await decryptUserConfigs({
      userId,
      settings,
      byokAllowed: false,
      localAllowed: false,
    });
    expect(notAllowed.configs).toEqual({});
    const local = await decryptUserConfigs({
      userId,
      settings: { ...settings, keyMode: "local" },
      byokAllowed: true,
      localAllowed: true,
    });
    expect(local.configs).toEqual({});
  });

  test("a run on the user's own keys is routed as BYOK and charges no credits", async () => {
    const t = setupTest();
    vi.stubEnv("DESYN_EDITION", "hosted");
    const user = await createUser(t);
    await makePro(t, user.userId);
    // No server keys at all: only the user's OpenRouter key makes the agent routable.
    const blocked = await designWithHeadline(user);
    expect(
      (
        await errorData(
          user.as.mutation(api.ai.agent.startRun, { designId: blocked.designId, goal: "Go" }),
        )
      ).code,
    ).toBe("NOT_CONFIGURED");
    await storeKey(t, user, "openrouter", "sk-user-openrouter-1");
    providerHook.byok = true;
    providerHook.model = scriptedModel([
      { calls: [{ name: "read_design", input: {} }] },
      { calls: [{ name: "finish", input: { summary: "Done on your key." } }] },
    ]);
    vi.useFakeTimers();
    const { runId } = await user.as.mutation(api.ai.agent.startRun, {
      designId: blocked.designId,
      goal: "Go",
    });
    await drain(t);
    const run = await user.as.query(api.ai.agent.getRun, { runId });
    expect(run).toMatchObject({
      status: "completed",
      billing: "byok",
      costCredits: 0,
      creditsCharged: 0,
    });
    const balance = await user.as.query(api.billing.credits.balance, {});
    expect(balance).toMatchObject({ used: 0, reserved: 0 });
    // The action received the encrypted settings and decrypted them itself.
    const input = providerHook.inputs[0];
    expect(input?.byokAllowed).toBe(true);
    const real = await decryptUserConfigs(input as NonNullable<typeof input>);
    expect(real.configs.openrouter?.apiKey).toBe("sk-user-openrouter-1");
  });

  test("per-task model choice is validated and persisted", async () => {
    const t = setupTest();
    const user = await createUser(t);
    await user.as.mutation(api.ai.prefs.setTaskModel, {
      task: "copy",
      model: "openrouter:anthropic/claude-haiku-4.5",
    });
    let view = await user.as.query(api.ai.prefs.get, {});
    expect(view.tasks.find((x) => x.task === "copy")).toMatchObject({
      choice: "openrouter:anthropic/claude-haiku-4.5",
    });
    expect(
      (
        await errorData(
          user.as.mutation(api.ai.prefs.setTaskModel, { task: "image", model: "anthropic:claude" }),
        )
      ).code,
    ).toBe("INVALID_ARGUMENT"); // Anthropic has no image models
    expect(
      (await errorData(user.as.mutation(api.ai.prefs.setTaskModel, { task: "nope", model: null })))
        .code,
    ).toBe("INVALID_ARGUMENT");
    await user.as.mutation(api.ai.prefs.setTaskModel, { task: "copy", model: null });
    view = await user.as.query(api.ai.prefs.get, {});
    expect(view.tasks.find((x) => x.task === "copy")?.choice).toBeNull();
  });
});

describe("SSRF guard", () => {
  test("classifies private, loopback, link-local, mapped and reserved addresses", () => {
    for (const ip of [
      "127.0.0.1",
      "10.1.2.3",
      "172.16.0.1",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "0.0.0.0",
      "224.0.0.1",
      "::1",
      "::",
      "fe80::1",
      "fd00::1",
      "::ffff:127.0.0.1",
      "::ffff:7f00:1",
      "64:ff9b::a00:1",
      "2001:db8::1",
      "::ffff:0:a00:1", // IPv4-translated 10.0.0.1
      "2002:a9fe:a9fe::1", // 6to4 of 169.254.169.254
      "2002:7f00:1::", // 6to4 of 127.0.0.1
      "2001:0:4136:e378::1", // Teredo
      "64:ff9b:1::a00:1", // local-use NAT64
      "100::1", // discard
      "not-an-ip",
    ]) {
      expect(isNonPublicAddress(ip), ip).toBe(true);
    }
    for (const ip of [
      "1.1.1.1",
      "8.8.8.8",
      "172.32.0.1",
      "2606:4700:4700::1111",
      "::ffff:8.8.8.8",
      "2002:808:808::1", // 6to4 of 8.8.8.8
      "2001:4860:4860::8888",
    ]) {
      expect(isNonPublicAddress(ip), ip).toBe(false);
    }
  });

  test("redirects are re-checked, and credentials never follow them to another origin", async () => {
    const seen: { url: string; method: string; auth: string | null; key: string | null }[] = [];
    const base = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      seen.push({
        url,
        method: init?.method ?? "GET",
        auth: headers.get("authorization"),
        key: headers.get("x-api-key"),
      });
      if (url === "https://1.1.1.1/v1/start")
        return new Response(null, { status: 302, headers: { location: "/v1/next" } });
      if (url === "https://1.1.1.1/v1/next")
        return new Response(null, { status: 307, headers: { location: "https://8.8.8.8/out" } });
      if (url === "https://8.8.8.8/out")
        return new Response(null, {
          status: 302,
          headers: { location: "http://169.254.169.254/" },
        });
      return new Response("ok");
    }) as typeof fetch;
    const guarded = guardedFetch({ enabled: true, base });
    await expect(
      guarded("https://1.1.1.1/v1/start", {
        method: "POST",
        headers: { authorization: "Bearer secret", "x-api-key": "k", "content-type": "text/plain" },
        body: "hi",
      }),
    ).rejects.toBeInstanceOf(BlockedDestinationError);
    // Same-origin hop keeps the key (302 after POST becomes GET); the cross-origin hop drops it.
    expect(seen).toEqual([
      { url: "https://1.1.1.1/v1/start", method: "POST", auth: "Bearer secret", key: "k" },
      { url: "https://1.1.1.1/v1/next", method: "GET", auth: "Bearer secret", key: "k" },
      { url: "https://8.8.8.8/out", method: "GET", auth: null, key: null },
    ]);
    await expect(guarded("http://127.0.0.1:3210/")).rejects.toBeInstanceOf(BlockedDestinationError);
    // URLs with credentials never leave (refused by the Request constructor already).
    await expect(guarded("http://user:pw@1.1.1.1/")).rejects.toThrow();
    expect((await guarded("https://8.8.4.4/fine")).status).toBe(200);
  });
});
