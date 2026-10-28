// Provider configuration sources and resolution. Server keys come from the environment (platform billing);
// users and workspaces can bring their own keys (decrypted server-side, or kept only in the browser in
// "local keys" mode); local providers (Ollama, LM Studio) are configured in the browser.
import type {
  EmbeddingModelV4,
  Experimental_VideoModelV4,
  ImageModelV4,
  LanguageModelV4,
  SpeechModelV4,
  TranscriptionModelV4,
} from "@ai-sdk/provider";
import { redactKey } from "../byok";
import { AiError } from "../errors";
import type { FetchLike } from "../util/async";
import { getProviderDefinition, PROVIDERS } from "./builtin";
import type { FalTransport } from "./fal";
import {
  type Billing,
  type ConfigSource,
  PROVIDER_IDS,
  type ProviderConfig,
  type ProviderConfigs,
  type ProviderId,
  type ProviderInstance,
  type ProviderKind,
  type ProviderSettings,
  type ProviderTestResult,
} from "./types";

export type EnvRecord = Record<string, string | undefined>;

/** Reads `process.env` when it exists (Node, Convex Node actions); `{}` in browsers. */
export function processEnv(): EnvRecord {
  const env = (globalThis as { process?: { env?: EnvRecord } }).process?.env;
  return env ?? {};
}

/**
 * Server configuration from environment variable names (values are never logged):
 * `OPENROUTER_API_KEY`, `FAL_AI_API_KEY`, `OLLAMA_BASE_URL`.
 */
export function envProviderConfigs(env: EnvRecord = processEnv()): ProviderConfigs {
  const out: ProviderConfigs = {};
  for (const id of PROVIDER_IDS) {
    const def = PROVIDERS[id];
    if (!def.env) continue;
    const apiKey = def.env.apiKey ? env[def.env.apiKey]?.trim() : undefined;
    const baseURL = def.env.baseURL ? env[def.env.baseURL]?.trim() : undefined;
    if (def.env.apiKey && !apiKey) continue;
    if (!def.env.apiKey && !baseURL) continue;
    const config: ProviderConfig = {};
    if (apiKey) config.apiKey = apiKey;
    if (baseURL) config.baseURL = baseURL;
    out[id] = config;
  }
  return out;
}

export interface ResolvedProviderConfig {
  provider: ProviderId;
  config: ProviderConfig;
  source: ConfigSource;
  billing: Billing;
}

const PRECEDENCE: readonly ConfigSource[] = ["local", "user", "workspace", "env"];

function billingFor(provider: ProviderId, source: ConfigSource): Billing {
  if (PROVIDERS[provider].local && (source === "local" || source === "user")) return "local";
  if (source === "env") return "platform";
  return source === "local" ? "local" : "byok";
}

/** Highest-precedence valid configuration for a provider: local > user > workspace > env. */
export function resolveProviderConfig(
  provider: ProviderId,
  settings: ProviderSettings,
): ResolvedProviderConfig | undefined {
  const def = getProviderDefinition(provider);
  for (const source of PRECEDENCE) {
    const config = settings[source]?.[provider];
    if (!config) continue;
    if (source === "local" && !def.local) continue; // only local servers may be configured in local mode
    if (!def.configSchema.safeParse(config).success) continue;
    return { provider, config, source, billing: billingFor(provider, source) };
  }
  return undefined;
}

export interface ConfigValidation {
  ok: boolean;
  errors: { field: string; message: string }[];
}

/** Validates a provider form before saving (messages are safe to show). */
export function validateProviderConfig(provider: ProviderId, config: unknown): ConfigValidation {
  const parsed = getProviderDefinition(provider).configSchema.safeParse(config);
  if (parsed.success) return { ok: true, errors: [] };
  return {
    ok: false,
    errors: parsed.error.issues.map((i) => ({
      field: i.path.join(".") || "config",
      message: i.message,
    })),
  };
}

/** Runs the provider's connectivity probe (no content is generated, nothing is billed). */
export async function testProvider(
  provider: ProviderId,
  config: ProviderConfig,
  options: { fetch?: FetchLike; signal?: AbortSignal } = {},
): Promise<ProviderTestResult> {
  const validation = validateProviderConfig(provider, config);
  if (!validation.ok) {
    return {
      ok: false,
      latencyMs: 0,
      message: validation.errors.map((e) => `${e.field}: ${e.message}`).join("; "),
    };
  }
  return getProviderDefinition(provider).test(config, options);
}

/** Safe description of a configuration for logs and settings UIs. */
export function describeProviderConfig(config: ProviderConfig): Record<string, string> {
  const out: Record<string, string> = {};
  if (config.apiKey) out.apiKey = redactKey(config.apiKey);
  if (config.baseURL) out.baseURL = config.baseURL;
  if (config.name) out.name = config.name;
  if (config.proxyUrl) out.proxyUrl = config.proxyUrl;
  return out;
}

export interface ModelRef {
  provider: ProviderId;
  model: string;
}

/**
 * Resolved provider access for one run: instances are created lazily and cached. The same object is used by
 * routing (to know what is configured), the agent (language models) and media (image/video/speech/fal).
 */
export class AiProviders {
  private readonly instances = new Map<ProviderId, ProviderInstance>();

  constructor(
    readonly settings: ProviderSettings,
    private readonly options: { fetch?: FetchLike; falTransport?: FalTransport } = {},
  ) {}

  resolve(provider: ProviderId): ResolvedProviderConfig | undefined {
    return resolveProviderConfig(provider, this.settings);
  }

  isConfigured(provider: ProviderId): boolean {
    return this.resolve(provider) !== undefined;
  }

  /** Configured providers that support `kind`. */
  configured(kind?: ProviderKind): ProviderId[] {
    return PROVIDER_IDS.filter(
      (id) => this.isConfigured(id) && (kind === undefined || PROVIDERS[id].kinds.includes(kind)),
    );
  }

  billing(provider: ProviderId): Billing | undefined {
    return this.resolve(provider)?.billing;
  }

  instance(provider: ProviderId): ProviderInstance {
    const cached = this.instances.get(provider);
    if (cached) return cached;
    const resolved = this.resolve(provider);
    if (!resolved) {
      throw new AiError(
        "provider-not-configured",
        `${PROVIDERS[provider].label} is not configured. Add a key in Settings › AI providers.`,
        { provider },
      );
    }
    const created = PROVIDERS[provider].create(
      resolved.config,
      this.options.fetch ? { fetch: this.options.fetch } : {},
    );
    if (provider === "fal" && this.options.falTransport) created.fal = this.options.falTransport;
    this.instances.set(provider, created);
    return created;
  }

  private factory<K extends keyof ProviderInstance>(ref: ModelRef, key: K, kind: string) {
    const instance = this.instance(ref.provider);
    const fn = instance[key];
    if (typeof fn !== "function") {
      throw new AiError("unsupported", `${PROVIDERS[ref.provider].label} has no ${kind} models`, {
        provider: ref.provider,
      });
    }
    return fn as unknown as (id: string) => unknown;
  }

  languageModel(ref: ModelRef): LanguageModelV4 {
    return this.factory(ref, "languageModel", "text")(ref.model) as LanguageModelV4;
  }

  imageModel(ref: ModelRef): ImageModelV4 {
    return this.factory(ref, "imageModel", "image")(ref.model) as ImageModelV4;
  }

  embeddingModel(ref: ModelRef): EmbeddingModelV4 {
    return this.factory(ref, "embeddingModel", "embedding")(ref.model) as EmbeddingModelV4;
  }

  speechModel(ref: ModelRef): SpeechModelV4 {
    return this.factory(ref, "speechModel", "speech")(ref.model) as SpeechModelV4;
  }

  transcriptionModel(ref: ModelRef): TranscriptionModelV4 {
    return this.factory(
      ref,
      "transcriptionModel",
      "transcription",
    )(ref.model) as TranscriptionModelV4;
  }

  videoModel(ref: ModelRef): Experimental_VideoModelV4 {
    return this.factory(ref, "videoModel", "video")(ref.model) as Experimental_VideoModelV4;
  }

  fal(): FalTransport {
    const transport = this.instance("fal").fal;
    if (!transport) throw new AiError("provider-not-configured", "fal is not configured");
    return transport;
  }
}

export function createProviders(
  settings: ProviderSettings,
  options: { fetch?: FetchLike; falTransport?: FalTransport } = {},
): AiProviders {
  return new AiProviders(settings, options);
}
