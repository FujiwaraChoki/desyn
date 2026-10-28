import { AiRunEventListSchema, AiRunSchema, type Schema, validate } from "@desyn/sdk/contract";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  designWithHeadline,
  fakeFal,
  pngDataUri,
  providerHook,
  resetProviderHook,
  scriptedModel,
  scriptedTextModel,
  tinyPng,
} from "./ai.helpers";
import { apiUser, call, NETWORK_ENV, stubNetwork } from "./api.helpers";
import { loadAll } from "./designs.helpers";
import { createUser, errorData, setupTest, type TestConvex } from "./harness.helpers";

// Generative media: results are stored as workspace assets in S3 (an in-memory S3 behind fetch), recorded
// with provenance, attached to the design, and billed through the ledger (refunded on failure). Plus the
// Agent API seam (convex/ai/api.ts) driven through the real REST dispatcher.

vi.mock("../lib/ai_providers", async (orig) =>
  (await import("./ai.helpers")).mockProvidersModule(await orig()),
);

const drain = (t: TestConvex) => t.finishAllScheduledFunctions(vi.runOnlyPendingTimers);

function expectSchema(schema: Schema, value: unknown) {
  const result = validate(schema, value);
  if (!result.success) throw new Error(`contract mismatch: ${JSON.stringify(result.issues)}`);
}

async function makePro(t: TestConvex, userId: string) {
  await t.run(async (ctx) => {
    const profile = await ctx.db
      .query("profiles")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .unique();
    if (profile) await ctx.db.patch("profiles", profile._id, { plan: "pro" });
  });
}

let net: ReturnType<typeof stubNetwork>;

beforeEach(() => {
  vi.stubEnv("DESYN_EDITION", "selfhost");
  vi.stubEnv("MAIL_TRANSPORT", "log");
  vi.stubEnv("OPENROUTER_API_KEY", "test-openrouter-key");
  vi.stubEnv("FAL_AI_API_KEY", "test-fal-key");
  for (const [k, v] of Object.entries(NETWORK_ENV)) vi.stubEnv(k, v);
  net = stubNetwork();
  vi.stubGlobal("fetch", net.fetch);
  resetProviderHook();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function sourceAsset(
  t: TestConvex,
  workspaceId: Id<"workspaces">,
  userId: string,
): Promise<Id<"assets">> {
  const bytes = tinyPng(64, 32);
  const stored = await t.action(internal.assets.assets.ingest, {
    workspaceId,
    userId,
    name: "photo.png",
    mime: "image/png",
    data: bytes.buffer.slice(0) as ArrayBuffer,
    source: "upload",
  });
  return stored.assetId;
}

describe("media actions", () => {
  test("generateImage stores the result in S3 with provenance and attaches it to the design", async () => {
    const t = setupTest();
    const user = await createUser(t);
    const { designId } = await designWithHeadline(user);
    const fal = fakeFal({
      "blackforestlabs/flux-3/text-to-image": () => ({
        images: [{ url: pngDataUri(48, 27), content_type: "image/png" }],
        seed: 42,
      }),
    });
    providerHook.fal = fal.transport;
    const res = await user.as.action(api.ai.media.generateImage, {
      prompt: "a calm desert at dawn",
      width: 1600,
      height: 900,
      style: "photo",
      designId,
    });
    expect(res.assets).toHaveLength(1);
    const asset = res.assets[0];
    expect(asset).toMatchObject({
      mime: "image/png",
      width: 48,
      height: 27,
      provider: "fal",
      costCredits: 3,
    });
    expect(asset?.url).toMatch(/^http:\/\/s3\.test\/desyn\/generated\//);
    expect([...net.s3.objects.keys()].some((k) => k.startsWith("generated/"))).toBe(true);
    expect(fal.calls[0]?.input).toMatchObject({ aspect_ratio: "16:9" });

    const prov = await t.run(async (ctx) => await ctx.db.query("aiAssets").collect());
    expect(prov).toHaveLength(1);
    expect(prov[0]).toMatchObject({
      task: "image",
      provider: "fal",
      model: "blackforestlabs/flux-3/text-to-image",
      seed: 42,
      billing: "platform",
      costCredits: 3,
    });
    const stored = await t.run(
      async (ctx) => await ctx.db.get("assets", asset?.assetId as Id<"assets">),
    );
    expect(stored).toMatchObject({ source: "ai", status: "ready" });
    expect(stored?.ai?.model).toBe("blackforestlabs/flux-3/text-to-image");

    const { design } = await loadAll(user.as, designId);
    expect(design.assets[asset?.refId as string]).toMatchObject({ kind: "image", source: "ai" });
    const run = await user.as.query(api.ai.agent.getRun, { runId: res.runId });
    expect(run).toMatchObject({ kind: "asset", status: "completed", costCredits: 3 });
    expect(run.result?.assetId).toBe(asset?.assetId);
  });

  test("background removal reads the source from S3 and records it as the source", async () => {
    const t = setupTest();
    const user = await createUser(t);
    const { workspaceId } = await designWithHeadline(user);
    const source = await sourceAsset(t, workspaceId, user.userId);
    const fal = fakeFal({
      "fal-ai/birefnet/v2": (input) => {
        expect(String(input.image_url)).toMatch(/^data:image\/png;base64,/);
        return { image: { url: pngDataUri(64, 32), content_type: "image/png" } };
      },
    });
    providerHook.fal = fal.transport;
    const res = await user.as.action(api.ai.media.removeBackground, { assetId: source });
    expect(res.assets[0]).toMatchObject({ width: 64, height: 32, costCredits: 1 });
    const prov = await t.run(async (ctx) => await ctx.db.query("aiAssets").collect());
    expect(prov[0]?.sourceAssetIds).toEqual([source]);
    // Without a design the asset lands in the user's workspace only.
    expect(res.assets[0]?.assetId).toBeDefined();
  });

  test("a failed generation is refunded and reported without provider details", async () => {
    const t = setupTest();
    vi.stubEnv("DESYN_EDITION", "hosted");
    const user = await createUser(t);
    await makePro(t, user.userId);
    const fal = fakeFal({
      "blackforestlabs/flux-3/text-to-image": () => {
        throw new Error("upstream 503 with internal detail");
      },
      "google/nano-banana-2.1": () => {
        throw new Error("upstream 503 again");
      },
    });
    providerHook.fal = fal.transport;
    const err = await errorData(user.as.action(api.ai.media.generateImage, { prompt: "a cat" }));
    expect(err.code).toBe("INTERNAL");
    expect(String(err.message)).not.toContain("internal detail");
    const balance = await user.as.query(api.billing.credits.balance, {});
    expect(balance).toMatchObject({ reserved: 0, used: 0 });
    const runs = await t.run(async (ctx) => await ctx.db.query("aiRuns").collect());
    expect(runs[0]).toMatchObject({ status: "failed", kind: "asset" });
  });

  test("gating: plan features, prompts, sources and moderation", async () => {
    const t = setupTest();
    vi.stubEnv("DESYN_EDITION", "hosted");
    const free = await createUser(t);
    expect(
      (await errorData(free.as.action(api.ai.media.generateImage, { prompt: "x" }))).code,
    ).toBe("FEATURE_UNAVAILABLE");
    const pro = await createUser(t);
    await makePro(t, pro.userId);
    expect((await errorData(pro.as.action(api.ai.media.generateImage, { prompt: " " }))).code).toBe(
      "INVALID_ARGUMENT",
    );
    providerHook.fal = fakeFal({}).transport;
    const blocked = await errorData(
      pro.as.action(api.ai.media.generateImage, { prompt: "nude teen" }),
    );
    expect(blocked.code).toBe("INVALID_ARGUMENT");
    const other = await createUser(t);
    const { workspaceId } = await designWithHeadline(other);
    const foreign = await sourceAsset(t, workspaceId, other.userId);
    expect((await errorData(pro.as.action(api.ai.media.upscale, { assetId: foreign }))).code).toBe(
      "NOT_FOUND",
    );
  });
});

describe("Agent API seam (convex/ai/api.ts)", () => {
  test("agent run through REST: start, events, completion", async () => {
    const t = setupTest();
    const u = await apiUser(t);
    const created = await call(t, "POST", "designs", { key: u.key, body: { name: "API target" } });
    const designId = created.json.id as string;
    providerHook.model = scriptedModel([
      { calls: [{ name: "read_design", input: {} }] },
      { calls: [{ name: "finish", input: { summary: "All good." } }] },
    ]);
    vi.useFakeTimers();
    const started = await call(t, "POST", `designs/${designId}/agent-runs`, {
      key: u.key,
      body: { goal: "Review the layout", mode: "critique" },
      headers: { "idempotency-key": "run-1" },
    });
    expect(started.status).toBe(202);
    expectSchema(AiRunSchema, started.json);
    expect(started.json).toMatchObject({ status: "queued", kind: "agent", mode: "critique" });
    await drain(t);
    const run = await call(t, "GET", `agent-runs/${started.json.id}`, { key: u.key });
    expect(run.json).toMatchObject({ status: "completed", result: { summary: "All good." } });
    const events = await call(t, "GET", `agent-runs/${started.json.id}/events?after=-1`, {
      key: u.key,
    });
    expectSchema(AiRunEventListSchema, events.json);
    expect(events.json.done).toBe(true);
    expect(events.json.items.at(-1)).toMatchObject({ type: "done", status: "completed" });
    // Idempotent start returns the same run.
    const again = await call(t, "POST", `designs/${designId}/agent-runs`, {
      key: u.key,
      body: { goal: "Review the layout", mode: "critique" },
      headers: { "idempotency-key": "run-1" },
    });
    expect(again.json.id).toBe(started.json.id);
    // Other workspaces cannot see it.
    const other = await apiUser(t);
    expect((await call(t, "GET", `agent-runs/${started.json.id}`, { key: other.key })).status).toBe(
      404,
    );
  });

  test("asset generation through REST runs asynchronously", async () => {
    const t = setupTest();
    const u = await apiUser(t);
    // SVG generation is an LLM call (generateText) with a validate / repair loop.
    providerHook.model = scriptedTextModel([
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="6" fill="#ffb02e"/></svg>',
    ]);
    vi.useFakeTimers();
    const res = await call(t, "POST", "assets/generate", {
      key: u.key,
      body: { task: "svg", prompt: "a sun icon" },
    });
    expect(res.status).toBe(202);
    expectSchema(AiRunSchema, res.json);
    expect(res.json).toMatchObject({ kind: "asset", status: "queued" });
    await drain(t);
    const run = await call(t, "GET", `agent-runs/${res.json.id}`, { key: u.key });
    expect(run.json.status).toBe("completed");
    expect(run.json.result.assetId).toBeTruthy();
    const asset = await call(t, "GET", `assets/${run.json.result.assetId}`, { key: u.key });
    expect(asset.json).toMatchObject({ kind: "svg", mime: "image/svg+xml" });
  });

  test("models: NOT_CONFIGURED without providers, options with the defaults otherwise", async () => {
    const t = setupTest();
    const u = await apiUser(t);
    vi.stubEnv("OPENROUTER_API_KEY", "");
    vi.stubEnv("FAL_AI_API_KEY", "");
    expect((await call(t, "GET", "ai/models", { key: u.key })).status).toBe(501);
    vi.stubEnv("OPENROUTER_API_KEY", "test-openrouter-key");
    // Catalog endpoints answer with a small catalog.
    vi.stubGlobal("fetch", async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("openrouter.ai/api/v1/models"))
        return Response.json({
          data: [
            {
              id: "anthropic/claude-sonnet-5.5",
              name: "Claude Sonnet 5.5",
              architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
              pricing: { prompt: "0.000003", completion: "0.000015" },
            },
            { id: "acme/tiny", name: "Tiny", architecture: { output_modalities: ["text"] } },
          ],
        });
      if (url.includes("openrouter.ai/api/v1/embeddings")) return Response.json({ data: [] });
      if (url.includes("api.fal.ai/v1/models"))
        return Response.json({ models: [], has_more: false });
      return net.fetch(input);
    });
    const res = await call(t, "GET", "ai/models?task=agent", { key: u.key });
    expect(res.status).toBe(200);
    const agent = res.json.tasks.agent as {
      id: string;
      default: boolean;
      available: boolean;
      source: string;
    }[];
    expect(agent[0]).toMatchObject({
      id: "openrouter:anthropic/claude-sonnet-5.5",
      default: true,
      available: true,
      source: "server",
    });
    expect(agent.some((m) => m.id === "openrouter:acme/tiny")).toBe(true);
    // The catalog is cached (the empty fal answer is remembered as a failure so readers back off).
    const catalogRows = await t.run(async (ctx) => await ctx.db.query("aiModelCatalog").collect());
    expect(catalogRows.map((r) => [r.source, r.count]).sort()).toEqual([
      ["fal", 0],
      // two OpenRouter models plus Claude Sonnet 5.5 listed again under the Anthropic API
      ["openrouter", 3],
    ]);
  });

  test("workflows and validation errors map to HTTP statuses", async () => {
    const t = setupTest();
    const u = await apiUser(t);
    const created = await call(t, "POST", "designs", { key: u.key, body: { name: "Source" } });
    const bad = await call(t, "POST", "workflows", {
      key: u.key,
      body: { type: "localize", designId: created.json.id, input: { locales: [] } },
    });
    expect(bad.status).toBe(400);
    expect(bad.json.error.code).toBe("INVALID_ARGUMENT");
    const missing = await call(t, "POST", "workflows", {
      key: u.key,
      body: { type: "resize", designId: "notanid", input: { presets: ["instagram-story"] } },
    });
    expect(missing.status).toBe(404);
  });
});
