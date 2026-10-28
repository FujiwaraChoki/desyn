// Built-in provider definitions: factory (AI SDK provider instance), config schema + form fields, and a cheap
// authenticated connectivity probe for each provider. Probes never generate content (no cost).
import { createAnthropic } from "@ai-sdk/anthropic";
import { createFal } from "@ai-sdk/fal";
import { createGoogle } from "@ai-sdk/google";
import { createGroq } from "@ai-sdk/groq";
import { createMistral } from "@ai-sdk/mistral";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createReplicate } from "@ai-sdk/replicate";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { createOllama } from "ollama-ai-provider-v2";
import { z } from "zod";
import { redactSecrets } from "../byok";
import { errorMessage } from "../errors";
import { defaultFetch, type FetchLike, redactUrl } from "../util/async";
import { createFalTransport } from "./fal";
import type {
  ConfigField,
  ProviderConfig,
  ProviderDefinition,
  ProviderId,
  ProviderRuntimeOptions,
  ProviderTestResult,
} from "./types";

const headersSchema = z.record(z.string(), z.string()).optional();
const urlSchema = z.url({ protocol: /^https?$/ });

const cloudSchema = z.object({
  apiKey: z.string().trim().min(8, "API key looks too short"),
  baseURL: urlSchema.optional(),
  headers: headersSchema,
});

const apiKeyField = (placeholder: string, help?: string): ConfigField => ({
  key: "apiKey",
  label: "API key",
  type: "secret",
  required: true,
  placeholder,
  ...(help ? { help } : {}),
});
const baseUrlField = (placeholder: string, required = false): ConfigField => ({
  key: "baseURL",
  label: required ? "Base URL" : "Base URL (optional override)",
  type: "url",
  required,
  placeholder,
});

/** Strips trailing slashes. */
function trimUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

function base(config: ProviderConfig, fallback: string): string {
  return trimUrl(config.baseURL ?? fallback);
}

function fetchOption(options?: ProviderRuntimeOptions): { fetch?: typeof fetch } {
  return options?.fetch ? { fetch: options.fetch as typeof fetch } : {};
}

interface ProbeSpec {
  url: string;
  headers?: Record<string, string>;
  /** Extracts model ids from a successful JSON body. */
  models?: (body: unknown) => string[];
  /** Statuses that prove the credentials were accepted (default: 2xx only). */
  acceptStatus?: (status: number) => boolean;
}

async function probe(
  spec: ProbeSpec,
  options: ProviderRuntimeOptions & { signal?: AbortSignal } = {},
): Promise<ProviderTestResult> {
  const doFetch: FetchLike = options.fetch ?? defaultFetch();
  const started = Date.now();
  try {
    const init: RequestInit = { headers: { accept: "application/json", ...spec.headers } };
    if (options.signal) init.signal = options.signal;
    const res = await doFetch(spec.url, init);
    const latencyMs = Date.now() - started;
    const accepted = spec.acceptStatus ? spec.acceptStatus(res.status) : res.ok;
    if (!accepted) {
      const auth = res.status === 401 || res.status === 403;
      return {
        ok: false,
        status: res.status,
        latencyMs,
        message: auth
          ? "The key was rejected. Check that it is correct and active."
          : `The provider answered ${res.status} for ${redactUrl(spec.url)}.`,
      };
    }
    let models: string[] | undefined;
    if (spec.models && res.ok) {
      try {
        models = spec.models(await res.json());
      } catch {
        models = undefined;
      }
    }
    return {
      ok: true,
      status: res.status,
      latencyMs,
      message: models ? `Connected. ${models.length} models available.` : "Connected.",
      ...(models ? { models } : {}),
    };
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - started,
      message: `Could not reach ${redactUrl(spec.url)}: ${redactSecrets(errorMessage(error))}`,
    };
  }
}

const dataIds = (body: unknown): string[] => {
  const data = (body as { data?: { id?: unknown }[] })?.data;
  return Array.isArray(data) ? data.flatMap((m) => (typeof m.id === "string" ? [m.id] : [])) : [];
};

const bearer = (key: string | undefined): Record<string, string> =>
  key ? { authorization: `Bearer ${key}` } : {};

const openrouter: ProviderDefinition = {
  id: "openrouter",
  label: "OpenRouter",
  description:
    "Hundreds of text and vision models behind one key. Default for the agent, copy and SVG.",
  kinds: ["text", "embedding", "image"],
  configSchema: cloudSchema,
  fields: [apiKeyField("sk-or-v1-…"), baseUrlField("https://openrouter.ai/api/v1")],
  defaultBaseURL: "https://openrouter.ai/api/v1",
  env: { apiKey: "OPENROUTER_API_KEY" },
  local: false,
  byok: true,
  docsUrl: "https://openrouter.ai/docs",
  create(config, options) {
    const p = createOpenRouter({
      apiKey: config.apiKey,
      baseURL: base(config, openrouter.defaultBaseURL),
      compatibility: "strict",
      appName: "Desyn",
      appUrl: "https://desyn.app",
      ...(config.headers ? { headers: config.headers } : {}),
      ...fetchOption(options),
    });
    return {
      id: "openrouter",
      languageModel: (id) => p.chat(id),
      embeddingModel: (id) => p.embeddingModel(id),
      imageModel: (id) => p.imageModel(id),
    };
  },
  test(config, options) {
    // /key returns the key's limits and usage and fails with 401 for invalid keys.
    return probe(
      { url: `${base(config, openrouter.defaultBaseURL)}/key`, headers: bearer(config.apiKey) },
      options,
    );
  },
};

const fal: ProviderDefinition = {
  id: "fal",
  label: "fal",
  description: "Image, vector, editing, upscaling, video and speech models.",
  kinds: ["image", "video", "speech", "transcription"],
  configSchema: z
    .object({
      apiKey: z.string().trim().min(8).optional(),
      proxyUrl: z.string().trim().min(1).optional(),
      headers: headersSchema,
    })
    .refine((c) => c.apiKey || c.proxyUrl, { message: "Enter an API key" }),
  fields: [apiKeyField("key_id:key_secret", "From fal.ai › Dashboard › Keys.")],
  defaultBaseURL: "https://fal.run",
  env: { apiKey: "FAL_AI_API_KEY" },
  local: false,
  byok: true,
  docsUrl: "https://docs.fal.ai",
  create(config, options) {
    // The key is passed explicitly: createFal would otherwise read FAL_API_KEY / FAL_KEY.
    const p = createFal({
      apiKey: config.apiKey ?? "",
      ...(config.headers ? { headers: config.headers } : {}),
      ...fetchOption(options),
    });
    return {
      id: "fal",
      imageModel: (id) => p.image(id),
      videoModel: (id) => p.video(id),
      speechModel: (id) => p.speech(id),
      transcriptionModel: (id) => p.transcription(id),
      fal: createFalTransport({
        ...(config.apiKey ? { apiKey: config.apiKey } : {}),
        ...(config.proxyUrl ? { proxyUrl: config.proxyUrl } : {}),
        ...(options?.fetch ? { fetch: options.fetch } : {}),
      }),
    };
  },
  test(config, options) {
    // Status of a request id that cannot exist: 401/403 for a bad key, 404 (or 400) once authenticated.
    // This costs nothing, unlike submitting a job.
    return probe(
      {
        url: "https://queue.fal.run/fal-ai/birefnet/v2/requests/00000000-0000-4000-8000-000000000000/status",
        headers: config.apiKey ? { authorization: `Key ${config.apiKey}` } : {},
        acceptStatus: (s) => s !== 401 && s !== 403 && s < 500,
      },
      options,
    );
  },
};

const ollama: ProviderDefinition = {
  id: "ollama",
  label: "Ollama",
  description: "Run open models on your own machine. Nothing leaves your computer.",
  kinds: ["text", "embedding"],
  configSchema: z.object({ baseURL: urlSchema.optional(), headers: headersSchema }),
  fields: [baseUrlField("http://127.0.0.1:11434/api")],
  defaultBaseURL: "http://127.0.0.1:11434/api",
  env: { baseURL: "OLLAMA_BASE_URL" },
  local: true,
  byok: false,
  docsUrl: "https://github.com/ollama/ollama/blob/main/docs/api.md",
  create(config, options) {
    const p = createOllama({
      baseURL: base(config, ollama.defaultBaseURL),
      ...(config.headers ? { headers: config.headers } : {}),
      ...fetchOption(options),
    });
    return {
      id: "ollama",
      languageModel: (id) => p.chat(id),
      embeddingModel: (id) => p.embedding(id),
    };
  },
  test(config, options) {
    return probe(
      {
        url: `${base(config, ollama.defaultBaseURL)}/tags`,
        ...(config.headers ? { headers: config.headers } : {}),
        models: (body) => {
          const models = (body as { models?: { name?: unknown }[] })?.models;
          return Array.isArray(models)
            ? models.flatMap((m) => (typeof m.name === "string" ? [m.name] : []))
            : [];
        },
      },
      options,
    );
  },
};

const openaiCompatible: ProviderDefinition = {
  id: "openai-compatible",
  label: "OpenAI-compatible server",
  description: "LM Studio, vLLM, llama.cpp, LocalAI or any server that speaks the OpenAI API.",
  kinds: ["text", "embedding", "image"],
  configSchema: z.object({
    baseURL: urlSchema,
    apiKey: z.string().trim().optional(),
    name: z
      .string()
      .trim()
      .regex(/^[a-z0-9-]{1,40}$/, "lowercase letters, digits and dashes")
      .optional(),
    headers: headersSchema,
  }),
  fields: [
    baseUrlField("http://127.0.0.1:1234/v1", true),
    { key: "apiKey", label: "API key (optional)", type: "secret", required: false },
    { key: "name", label: "Name", type: "text", required: false, placeholder: "lmstudio" },
  ],
  defaultBaseURL: "http://127.0.0.1:1234/v1",
  local: true,
  byok: true,
  docsUrl: "https://ai-sdk.dev/providers/openai-compatible-providers",
  create(config, options) {
    const p = createOpenAICompatible({
      name: config.name ?? "openai-compatible",
      baseURL: base(config, openaiCompatible.defaultBaseURL),
      ...(config.apiKey ? { apiKey: config.apiKey } : {}),
      ...(config.headers ? { headers: config.headers } : {}),
      includeUsage: true,
      ...fetchOption(options),
    });
    return {
      id: "openai-compatible",
      languageModel: (id) => p.chatModel(id),
      embeddingModel: (id) => p.embeddingModel(id),
      imageModel: (id) => p.imageModel(id),
    };
  },
  test(config, options) {
    return probe(
      {
        url: `${base(config, openaiCompatible.defaultBaseURL)}/models`,
        headers: { ...bearer(config.apiKey), ...config.headers },
        models: dataIds,
      },
      options,
    );
  },
};

const anthropic: ProviderDefinition = {
  id: "anthropic",
  label: "Anthropic",
  description: "Claude models straight from the Anthropic API.",
  kinds: ["text"],
  configSchema: cloudSchema,
  fields: [apiKeyField("sk-ant-…"), baseUrlField("https://api.anthropic.com/v1")],
  defaultBaseURL: "https://api.anthropic.com/v1",
  env: { apiKey: "ANTHROPIC_API_KEY" },
  local: false,
  byok: true,
  docsUrl: "https://docs.anthropic.com",
  create(config, options) {
    const p = createAnthropic({
      apiKey: config.apiKey,
      baseURL: base(config, anthropic.defaultBaseURL),
      ...(config.headers ? { headers: config.headers } : {}),
      ...fetchOption(options),
    });
    return { id: "anthropic", languageModel: (id) => p.languageModel(id) };
  },
  test(config, options) {
    return probe(
      {
        url: `${base(config, anthropic.defaultBaseURL)}/models`,
        headers: { "x-api-key": config.apiKey ?? "", "anthropic-version": "2023-06-01" },
        models: dataIds,
      },
      options,
    );
  },
};

const openai: ProviderDefinition = {
  id: "openai",
  label: "OpenAI",
  description: "GPT, image, speech and embedding models from the OpenAI API.",
  kinds: ["text", "image", "speech", "transcription", "embedding"],
  configSchema: cloudSchema,
  fields: [apiKeyField("sk-…"), baseUrlField("https://api.openai.com/v1")],
  defaultBaseURL: "https://api.openai.com/v1",
  env: { apiKey: "OPENAI_API_KEY" },
  local: false,
  byok: true,
  docsUrl: "https://platform.openai.com/docs",
  create(config, options) {
    const p = createOpenAI({
      apiKey: config.apiKey,
      baseURL: base(config, openai.defaultBaseURL),
      ...(config.headers ? { headers: config.headers } : {}),
      ...fetchOption(options),
    });
    return {
      id: "openai",
      languageModel: (id) => p.languageModel(id),
      imageModel: (id) => p.image(id),
      speechModel: (id) => p.speech(id),
      transcriptionModel: (id) => p.transcription(id),
      embeddingModel: (id) => p.embeddingModel(id),
    };
  },
  test(config, options) {
    return probe(
      {
        url: `${base(config, openai.defaultBaseURL)}/models`,
        headers: bearer(config.apiKey),
        models: dataIds,
      },
      options,
    );
  },
};

const google: ProviderDefinition = {
  id: "google",
  label: "Google Gemini",
  description: "Gemini text, image (Nano Banana), speech, video and embedding models.",
  kinds: ["text", "image", "video", "speech", "embedding"],
  configSchema: cloudSchema,
  fields: [apiKeyField("AIza…"), baseUrlField("https://generativelanguage.googleapis.com/v1beta")],
  defaultBaseURL: "https://generativelanguage.googleapis.com/v1beta",
  env: { apiKey: "GOOGLE_GENERATIVE_AI_API_KEY" },
  local: false,
  byok: true,
  docsUrl: "https://ai.google.dev/gemini-api/docs",
  create(config, options) {
    const p = createGoogle({
      apiKey: config.apiKey,
      baseURL: base(config, google.defaultBaseURL),
      ...(config.headers ? { headers: config.headers } : {}),
      ...fetchOption(options),
    });
    return {
      id: "google",
      languageModel: (id) => p.languageModel(id),
      imageModel: (id) => p.image(id),
      videoModel: (id) => p.video(id),
      speechModel: (id) => p.speech(id),
      embeddingModel: (id) => p.embeddingModel(id),
    };
  },
  test(config, options) {
    // The key goes in a header, never in the query string, so it cannot leak into logs.
    return probe(
      {
        url: `${base(config, google.defaultBaseURL)}/models?pageSize=200`,
        headers: { "x-goog-api-key": config.apiKey ?? "" },
        models: (body) => {
          const models = (body as { models?: { name?: unknown }[] })?.models;
          return Array.isArray(models)
            ? models.flatMap((m) =>
                typeof m.name === "string" ? [m.name.replace(/^models\//, "")] : [],
              )
            : [];
        },
      },
      options,
    );
  },
};

const mistral: ProviderDefinition = {
  id: "mistral",
  label: "Mistral",
  description: "Mistral text and embedding models with your own key.",
  kinds: ["text", "embedding", "speech", "transcription"],
  configSchema: cloudSchema,
  fields: [apiKeyField("…"), baseUrlField("https://api.mistral.ai/v1")],
  defaultBaseURL: "https://api.mistral.ai/v1",
  local: false,
  byok: true,
  docsUrl: "https://docs.mistral.ai",
  create(config, options) {
    const p = createMistral({
      apiKey: config.apiKey,
      baseURL: base(config, mistral.defaultBaseURL),
      ...(config.headers ? { headers: config.headers } : {}),
      ...fetchOption(options),
    });
    return {
      id: "mistral",
      languageModel: (id) => p.languageModel(id),
      embeddingModel: (id) => p.embedding(id),
      speechModel: (id) => p.speech(id),
      transcriptionModel: (id) => p.transcription(id),
    };
  },
  test(config, options) {
    return probe(
      {
        url: `${base(config, mistral.defaultBaseURL)}/models`,
        headers: bearer(config.apiKey),
        models: dataIds,
      },
      options,
    );
  },
};

const groq: ProviderDefinition = {
  id: "groq",
  label: "Groq",
  description: "Very fast open models and Whisper transcription with your own key.",
  kinds: ["text", "transcription"],
  configSchema: cloudSchema,
  fields: [apiKeyField("gsk_…"), baseUrlField("https://api.groq.com/openai/v1")],
  defaultBaseURL: "https://api.groq.com/openai/v1",
  local: false,
  byok: true,
  docsUrl: "https://console.groq.com/docs",
  create(config, options) {
    const p = createGroq({
      apiKey: config.apiKey,
      baseURL: base(config, groq.defaultBaseURL),
      ...(config.headers ? { headers: config.headers } : {}),
      ...fetchOption(options),
    });
    return {
      id: "groq",
      languageModel: (id) => p.languageModel(id),
      transcriptionModel: (id) => p.transcription(id),
    };
  },
  test(config, options) {
    return probe(
      {
        url: `${base(config, groq.defaultBaseURL)}/models`,
        headers: bearer(config.apiKey),
        models: dataIds,
      },
      options,
    );
  },
};

const replicate: ProviderDefinition = {
  id: "replicate",
  label: "Replicate",
  description: "Image and video models hosted on Replicate with your own token.",
  kinds: ["image", "video"],
  configSchema: cloudSchema,
  fields: [apiKeyField("r8_…"), baseUrlField("https://api.replicate.com/v1")],
  defaultBaseURL: "https://api.replicate.com/v1",
  local: false,
  byok: true,
  docsUrl: "https://replicate.com/docs",
  create(config, options) {
    const p = createReplicate({
      apiToken: config.apiKey,
      baseURL: base(config, replicate.defaultBaseURL),
      ...(config.headers ? { headers: config.headers } : {}),
      ...fetchOption(options),
    });
    return { id: "replicate", imageModel: (id) => p.image(id), videoModel: (id) => p.video(id) };
  },
  test(config, options) {
    return probe(
      { url: `${base(config, replicate.defaultBaseURL)}/account`, headers: bearer(config.apiKey) },
      options,
    );
  },
};

export const PROVIDERS: Readonly<Record<ProviderId, ProviderDefinition>> = {
  openrouter,
  fal,
  ollama,
  "openai-compatible": openaiCompatible,
  anthropic,
  openai,
  google,
  mistral,
  groq,
  replicate,
};

export function getProviderDefinition(id: ProviderId): ProviderDefinition {
  return PROVIDERS[id];
}

export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === "string" && Object.hasOwn(PROVIDERS, value);
}
