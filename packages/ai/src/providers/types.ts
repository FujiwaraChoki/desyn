import type {
  EmbeddingModelV4,
  Experimental_VideoModelV4,
  ImageModelV4,
  LanguageModelV4,
  SpeechModelV4,
  TranscriptionModelV4,
} from "@ai-sdk/provider";
import type { z } from "zod";
import type { FetchLike } from "../util/async";
import type { FalTransport } from "./fal";

export const PROVIDER_IDS = [
  "openrouter",
  "fal",
  "ollama",
  "openai-compatible",
  "anthropic",
  "openai",
  "google",
  "mistral",
  "groq",
  "replicate",
] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export const PROVIDER_KINDS = [
  "text",
  "image",
  "video",
  "speech",
  "transcription",
  "embedding",
] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

/** One shape for every provider; each definition's zod schema decides which fields are required. */
export interface ProviderConfig {
  apiKey?: string;
  baseURL?: string;
  /** Display / routing name for OpenAI-compatible servers (LM Studio, vLLM, llama.cpp, LocalAI…). */
  name?: string;
  headers?: Record<string, string>;
  /** fal only: route requests through an app proxy that injects the server key. */
  proxyUrl?: string;
}

/** Field metadata for settings forms (the zod schema stays the validator). */
export interface ConfigField {
  key: keyof ProviderConfig;
  label: string;
  type: "secret" | "url" | "text";
  required: boolean;
  placeholder?: string;
  help?: string;
}

export interface ProviderInstance {
  id: ProviderId;
  languageModel?(modelId: string): LanguageModelV4;
  imageModel?(modelId: string): ImageModelV4;
  embeddingModel?(modelId: string): EmbeddingModelV4;
  speechModel?(modelId: string): SpeechModelV4;
  transcriptionModel?(modelId: string): TranscriptionModelV4;
  videoModel?(modelId: string): Experimental_VideoModelV4;
  /** fal queue transport for specialised endpoints. */
  fal?: FalTransport;
}

export interface ProviderTestResult {
  ok: boolean;
  /** HTTP status of the probe request, when one was made. */
  status?: number;
  latencyMs: number;
  message: string;
  /** Model ids reported by the provider (local servers, OpenAI-compatible APIs). */
  models?: string[];
}

export interface ProviderRuntimeOptions {
  fetch?: FetchLike;
}

export interface ProviderDefinition {
  id: ProviderId;
  label: string;
  description: string;
  kinds: readonly ProviderKind[];
  /** Validator for UI forms and stored settings. */
  configSchema: z.ZodType<ProviderConfig>;
  fields: readonly ConfigField[];
  /** Default API base URL (also used by connectivity tests). */
  defaultBaseURL: string;
  /** Server environment variable names that configure this provider for everyone (platform billing). */
  env?: { apiKey?: string; baseURL?: string };
  /** Talks to a server on the user's machine / network (Ollama, LM Studio…): usable in "local" mode. */
  local: boolean;
  /** Users may bring their own key for it. */
  byok: boolean;
  docsUrl: string;
  create(config: ProviderConfig, options?: ProviderRuntimeOptions): ProviderInstance;
  test(
    config: ProviderConfig,
    options?: ProviderRuntimeOptions & { signal?: AbortSignal },
  ): Promise<ProviderTestResult>;
}

/** Where a resolved provider configuration came from. */
export type ConfigSource = "env" | "workspace" | "user" | "local";
/** Who pays: platform credits (server keys), the user's own key, or a local model. */
export type Billing = "platform" | "byok" | "local";

export type ProviderConfigs = Partial<Record<ProviderId, ProviderConfig>>;

export interface ProviderSettings {
  /** Server keys from the environment (see `envProviderConfigs`). */
  env?: ProviderConfigs;
  /** Workspace BYOK keys (decrypted server-side). */
  workspace?: ProviderConfigs;
  /** User BYOK keys (decrypted server-side) or browser-held keys in "local keys" mode. */
  user?: ProviderConfigs;
  /** Local-only providers configured in the browser (Ollama / OpenAI-compatible on localhost). */
  local?: ProviderConfigs;
}
