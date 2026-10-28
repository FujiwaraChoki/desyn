import { beforeEach, describe, expect, it } from "vitest";
import {
  AI_TASKS,
  CLAUDE_HAIKU,
  CLAUDE_OPUS,
  CLAUDE_SONNET,
  clearModelCatalogCache,
  directMirror,
  formatModelRef,
  HAIKU,
  listModels,
  missingPinnedModels,
  modelEnvDefaults,
  modelsForTask,
  normalizeFalModels,
  normalizeOpenRouterModels,
  OPUS,
  parseModelRef,
  resolveModel,
  SONNET,
  TASKS,
  taskEnvName,
  textPricing,
} from "../src/models";
import {
  createProviders,
  describeProviderConfig,
  envProviderConfigs,
  PROVIDER_IDS,
  PROVIDERS,
  resolveProviderConfig,
  testProvider,
  validateProviderConfig,
} from "../src/providers";
import { fakeFetch, json } from "./helpers";

describe("provider registry", () => {
  it("defines every provider with kinds, schema, fields and probes", () => {
    for (const id of PROVIDER_IDS) {
      const def = PROVIDERS[id];
      expect(def.id).toBe(id);
      expect(def.kinds.length).toBeGreaterThan(0);
      expect(def.fields.length).toBeGreaterThan(0);
      expect(typeof def.create).toBe("function");
    }
    expect(PROVIDERS.openrouter.env).toEqual({ apiKey: "OPENROUTER_API_KEY" });
    expect(PROVIDERS.fal.env).toEqual({ apiKey: "FAL_AI_API_KEY" });
    expect(PROVIDERS.ollama.env).toEqual({ baseURL: "OLLAMA_BASE_URL" });
  });

  it("reads server config from env names only", () => {
    const env = {
      OPENROUTER_API_KEY: "test-openrouter-key",
      FAL_AI_API_KEY: "test-fal-key-123",
      OLLAMA_BASE_URL: "http://localhost:11434/api",
      OTHER: "x",
    };
    expect(envProviderConfigs(env)).toEqual({
      openrouter: { apiKey: "test-openrouter-key" },
      fal: { apiKey: "test-fal-key-123" },
      ollama: { baseURL: "http://localhost:11434/api" },
    });
    expect(envProviderConfigs({})).toEqual({});
  });

  it("resolves precedence local > user > workspace > env and billing", () => {
    const settings = {
      env: { openrouter: { apiKey: "env-key-12345" }, ollama: { baseURL: "http://srv:11434/api" } },
      workspace: { openrouter: { apiKey: "ws-key-123456" } },
      user: { anthropic: { apiKey: "sk-ant-user-key-1" } },
      local: {
        ollama: { baseURL: "http://127.0.0.1:11434/api" },
        openai: { apiKey: "should-be-ignored" },
      },
    };
    expect(resolveProviderConfig("openrouter", settings)).toMatchObject({
      source: "workspace",
      billing: "byok",
    });
    expect(resolveProviderConfig("anthropic", settings)).toMatchObject({
      source: "user",
      billing: "byok",
    });
    expect(resolveProviderConfig("ollama", settings)).toMatchObject({
      source: "local",
      billing: "local",
      config: { baseURL: "http://127.0.0.1:11434/api" },
    });
    // Cloud providers cannot be configured in local mode.
    expect(resolveProviderConfig("openai", settings)).toBeUndefined();
    expect(resolveProviderConfig("openrouter", { env: settings.env })).toMatchObject({
      source: "env",
      billing: "platform",
    });
    // Invalid configs are skipped.
    expect(
      resolveProviderConfig("openrouter", {
        user: { openrouter: { apiKey: "x" } },
        env: settings.env,
      })?.source,
    ).toBe("env");
  });

  it("validates forms with readable errors and redacts descriptions", () => {
    expect(validateProviderConfig("openai-compatible", { apiKey: "k" }).ok).toBe(false);
    expect(
      validateProviderConfig("openai-compatible", { baseURL: "http://127.0.0.1:1234/v1" }).ok,
    ).toBe(true);
    expect(validateProviderConfig("openrouter", { apiKey: "short" }).errors[0]?.field).toBe(
      "apiKey",
    );
    expect(
      describeProviderConfig({ apiKey: "sk-or-v1-0123456789abcdef", baseURL: "https://x" }),
    ).toEqual({ apiKey: "sk-or-v1-[redacted]cdef", baseURL: "https://x" });
  });

  it("creates provider instances lazily and reports unsupported kinds", () => {
    const providers = createProviders({ env: { openrouter: { apiKey: "test-key-123456" } } });
    expect(providers.isConfigured("openrouter")).toBe(true);
    expect(providers.isConfigured("fal")).toBe(false);
    expect(providers.configured("text")).toEqual(["openrouter"]);
    const model = providers.languageModel({ provider: "openrouter", model: SONNET });
    expect(model.modelId).toBe(SONNET);
    expect(() => providers.speechModel({ provider: "openrouter", model: "x" })).toThrow(
      /no speech models/,
    );
    expect(() => providers.languageModel({ provider: "anthropic", model: "x" })).toThrow(
      /not configured/,
    );
  });

  it("probes connectivity without generating content", async () => {
    const { fetch, requests } = fakeFetch({
      "openrouter.ai/api/v1/key": () => json({ data: { label: "k" } }),
      "127.0.0.1:11434/api/tags": () => json({ models: [{ name: "llama3.2" }, { name: "qwen3" }] }),
      "api.anthropic.com": () => new Response("", { status: 401 }),
      "queue.fal.run": () => new Response("", { status: 404 }),
    });
    const ok = await testProvider("openrouter", { apiKey: "test-key-123456" }, { fetch });
    expect(ok.ok).toBe(true);
    expect((requests[0]?.init?.headers as Record<string, string> | undefined)?.authorization).toBe(
      "Bearer test-key-123456",
    );
    const local = await testProvider("ollama", {}, { fetch });
    expect(local).toMatchObject({ ok: true, models: ["llama3.2", "qwen3"] });
    const bad = await testProvider("anthropic", { apiKey: "sk-ant-wrong-key" }, { fetch });
    expect(bad).toMatchObject({ ok: false, status: 401 });
    expect(bad.message).toMatch(/rejected/);
    const fal = await testProvider("fal", { apiKey: "fal-key-12345678" }, { fetch });
    expect(fal.ok).toBe(true);
    const invalid = await testProvider("openrouter", { apiKey: "x" }, { fetch });
    expect(invalid.ok).toBe(false);
  });
});

describe("model routing", () => {
  it("pins the verified OpenRouter slugs and fal endpoints", () => {
    expect(SONNET).toBe("anthropic/claude-sonnet-5.5");
    expect(OPUS).toBe("anthropic/claude-opus-5.5");
    expect(HAIKU).toBe("anthropic/claude-haiku-5.5");
    // Claude tasks: the Anthropic API first, the same model through OpenRouter next.
    expect(TASKS.agent.default).toEqual({ provider: "anthropic", model: CLAUDE_SONNET });
    expect(TASKS.agent.fallbacks[0]).toEqual({ provider: "openrouter", model: SONNET });
    expect(TASKS.plan.default.model).toBe(CLAUDE_OPUS);
    expect(TASKS.critique.fallbacks[0]?.model).toBe(OPUS);
    expect(TASKS.copy.default.model).toBe(CLAUDE_HAIKU);
    expect(TASKS.copy.fallbacks[0]?.model).toBe(HAIKU);
    expect(TASKS.bgRemove.default).toEqual({ provider: "fal", model: "fal-ai/birefnet/v2" });
    for (const task of AI_TASKS) expect(TASKS[task].fallbacks.length).toBeGreaterThan(0);
  });

  it("resolves user > workspace > env > default > fallback, skipping unavailable providers", () => {
    const prefs = {
      user: { agent: { provider: "anthropic" as const, model: "claude-x" } },
      workspace: { agent: { provider: "openai" as const, model: "gpt-x" } },
      env: { agent: { provider: "ollama" as const, model: "qwen3" } },
    };
    expect(resolveModel("agent", prefs)).toMatchObject({ provider: "anthropic", source: "user" });
    expect(resolveModel("agent", prefs, { isAvailable: (p) => p !== "anthropic" })).toMatchObject({
      provider: "openai",
      source: "workspace",
    });
    expect(
      resolveModel("agent", prefs, { isAvailable: (p) => p === "ollama" || p === "openrouter" }),
    ).toMatchObject({ provider: "ollama", source: "env" });
    expect(resolveModel("agent", {}, { isAvailable: (p) => p === "openrouter" })).toMatchObject({
      provider: "openrouter",
      model: SONNET,
      source: "fallback",
    });
    expect(
      resolveModel("agent", {}, { isAvailable: (p) => p === "openrouter" || p === "anthropic" }),
    ).toMatchObject({ provider: "anthropic", model: CLAUDE_SONNET, source: "default" });
    expect(resolveModel("trace", {}, { isAvailable: (p) => p === "builtin" })).toMatchObject({
      provider: "builtin",
      source: "fallback",
    });
    expect(resolveModel("image", {}, { isAvailable: () => false })).toMatchObject({
      provider: "fal",
      source: "default",
    });
  });

  it("parses env overrides and refs", () => {
    expect(taskEnvName("imageText")).toBe("DESYN_AI_MODEL_IMAGE_TEXT");
    expect(
      modelEnvDefaults({
        DESYN_AI_MODEL_AGENT: "ollama:qwen3:32b",
        DESYN_AI_MODEL_IMAGE: "nope:x",
        DESYN_AI_MODEL_COPY: "openrouter:",
      }),
    ).toEqual({
      agent: { provider: "ollama", model: "qwen3:32b" },
    });
    expect(parseModelRef(formatModelRef({ provider: "fal", model: "fal-ai/x/y" }))).toEqual({
      provider: "fal",
      model: "fal-ai/x/y",
    });
  });

  it("normalizes catalogs and finds models per task", () => {
    const or = normalizeOpenRouterModels([
      {
        id: SONNET,
        name: "Sonnet",
        context_length: 1_000_000,
        architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
        pricing: { prompt: "0.000002", completion: "0.00001" },
      },
      {
        id: "x/text-only",
        architecture: { input_modalities: ["text"], output_modalities: ["text"] },
      },
    ]);
    expect(or[0]).toMatchObject({ provider: "openrouter", pricing: { input: 2, output: 10 } });
    expect(or[0]?.tasks).toContain("vision");
    expect(or[1]?.tasks).not.toContain("vision");
    const fal = normalizeFalModels([
      {
        endpoint_id: "fal-ai/birefnet/v2",
        metadata: { category: "image-to-image", status: "active", tags: ["background removal"] },
      },
      {
        endpoint_id: "ideogram/v4.5",
        metadata: { category: "text-to-image", status: "active", tags: ["typography"] },
      },
      {
        endpoint_id: "fal-ai/recraft/v4.1/text-to-vector",
        metadata: { category: "text-to-image" },
      },
      { endpoint_id: "old/model", metadata: { category: "text-to-image", status: "deprecated" } },
      { endpoint_id: "x/train", metadata: { category: "training" } },
    ]);
    expect(fal.map((m) => m.id)).toEqual([
      "fal-ai/birefnet/v2",
      "ideogram/v4.5",
      "fal-ai/recraft/v4.1/text-to-vector",
    ]);
    expect(fal[0]?.tasks).toContain("bgRemove");
    expect(fal[1]?.tasks).toEqual(["image", "imageText"]);
    expect(fal[2]?.tasks).toEqual(["vector"]);
    const catalog = { fetchedAt: 0, models: [...or, ...fal], errors: [] };
    expect(modelsForTask(catalog, "agent")[0]?.id).toBe(SONNET);
    expect(textPricing(SONNET, catalog)).toEqual({ input: 2, output: 10 });
    expect(textPricing(HAIKU)).toEqual({ input: 0.1, output: 0.5 });
  });

  describe("listModels", () => {
    beforeEach(() => clearModelCatalogCache());

    it("fetches both catalogs, pages fal, caches, and keeps stale data on failure", async () => {
      let falCalls = 0;
      let failOpenRouter = false;
      const { fetch, requests } = fakeFetch({
        "openrouter.ai/api/v1/embeddings/models": () =>
          json({ data: [{ id: "google/gemini-embedding-2", name: "Gemini Embedding 2" }] }),
        "openrouter.ai/api/v1/models": () =>
          failOpenRouter
            ? new Response("", { status: 500 })
            : json({
                data: [
                  {
                    id: SONNET,
                    architecture: {
                      input_modalities: ["text", "image"],
                      output_modalities: ["text"],
                    },
                  },
                ],
              }),
        "api.fal.ai/v1/models": (url) => {
          falCalls++;
          const u = new URL(url);
          if (u.searchParams.get("category") === "text-to-image" && !u.searchParams.get("cursor")) {
            return json({
              models: [{ endpoint_id: "ideogram/v4.5", metadata: { category: "text-to-image" } }],
              has_more: true,
              next_cursor: "c2",
            });
          }
          if (u.searchParams.get("cursor") === "c2")
            return json({
              models: [
                {
                  endpoint_id: "blackforestlabs/flux-3/text-to-image",
                  metadata: { category: "text-to-image" },
                },
              ],
              has_more: false,
            });
          return json({ models: [], has_more: false });
        },
      });
      const first = await listModels({ fetch });
      expect(first.errors).toEqual([]);
      expect(first.models.map((m) => m.id)).toEqual(
        expect.arrayContaining([
          SONNET,
          "google/gemini-embedding-2",
          "ideogram/v4.5",
          "blackforestlabs/flux-3/text-to-image",
        ]),
      );
      expect(first.models.find((m) => m.id === "google/gemini-embedding-2")?.tasks).toEqual([
        "embedding",
      ]);
      const callsAfterFirst = requests.length;
      await listModels({ fetch });
      expect(requests.length).toBe(callsAfterFirst); // cached
      failOpenRouter = true;
      const refreshed = await listModels({
        fetch,
        refresh: true,
        sources: ["openrouter"],
        retries: 0,
      });
      expect(refreshed.errors[0]?.source).toBe("openrouter");
      expect(refreshed.models.some((m) => m.id === SONNET)).toBe(true); // stale fallback
      expect(falCalls).toBeGreaterThan(5);
      expect(missingPinnedModels(first).some((m) => m.model === "fal-ai/birefnet/v2")).toBe(true);
    });
  });
});

describe("direct provider catalog", () => {
  it("lists OpenRouter's Anthropic, OpenAI and Google text models under their own API ids", () => {
    const mirrored = directMirror([
      {
        provider: "openrouter",
        id: "anthropic/claude-sonnet-5.5",
        label: "Claude Sonnet 5.5",
        kinds: ["text"],
        tasks: ["agent"],
        pricing: { input: 2, output: 10 },
      },
      {
        provider: "openrouter",
        id: "openai/gpt-5.5",
        label: "GPT-5.5",
        kinds: ["text"],
        tasks: ["agent"],
      },
      {
        provider: "openrouter",
        id: "google/gemini-3-pro:thinking",
        label: "Gemini 3 Pro",
        kinds: ["text"],
        tasks: ["agent"],
      },
      {
        provider: "openrouter",
        id: "meta-llama/llama-5",
        label: "Llama 5",
        kinds: ["text"],
        tasks: ["agent"],
      },
    ]);
    expect(mirrored.map((m) => `${m.provider}:${m.id}`)).toEqual([
      "anthropic:claude-sonnet-5-5",
      "openai:gpt-5.5",
      "google:gemini-3-pro",
    ]);
    expect(mirrored[0]?.pricing).toEqual({ input: 2, output: 10 });
  });
});
