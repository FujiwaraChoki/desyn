// Per-task model routing. Defaults follow docs/SPEC.md §7; users and workspaces override per task in settings,
// self-hosters override with environment variables, and the live catalogs (OpenRouter + fal) are fetched at
// runtime (`listModels`) so the settings UI can offer every current model.
//
// Pinned ids below were verified against the live catalogs on 2026-10-20:
// - OpenRouter: GET https://openrouter.ai/api/v1/models (public, no key) — "anthropic/claude-sonnet-5.5",
//   "anthropic/claude-opus-5.5", "anthropic/claude-haiku-5.5" (+ predecessors used as fallbacks);
//   embeddings from GET https://openrouter.ai/api/v1/embeddings/models — "google/gemini-embedding-2",
//   "openai/text-embedding-3-small".
// - fal: GET https://api.fal.ai/v1/models (public catalog, `endpoint_id` + `category`) and each endpoint's input
//   schema from https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=<id>; the input adapters in
//   media/fal-endpoints.ts follow those schemas exactly.

import { isProviderId } from "./providers/builtin";
import type { AiProviders, ModelRef } from "./providers/config";
import type { ProviderId, ProviderKind } from "./providers/types";
import { type FetchLike, fetchJson, TtlCache } from "./util/async";

export const MODELS_VERIFIED_AT = "2026-10-20";
export const MODEL_SOURCES = {
  openrouter: "https://openrouter.ai/api/v1/models",
  openrouterEmbeddings: "https://openrouter.ai/api/v1/embeddings/models",
  falCatalog: "https://api.fal.ai/v1/models",
  falSchema: "https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=",
} as const;

export const AI_TASKS = [
  "agent",
  "plan",
  "critique",
  "vision",
  "svg",
  "copy",
  "translate",
  "image",
  "imageText",
  "vector",
  "bgRemove",
  "inpaint",
  "outpaint",
  "upscale",
  "mockup",
  "trace",
  "video",
  "speech",
  "embedding",
] as const;
export type AiTask = (typeof AI_TASKS)[number];

/** Built-in, provider-free implementations (e.g. the posterize tracer) are addressed as provider "builtin". */
export const BUILTIN_PROVIDER = "builtin";
export type TaskProvider = ProviderId | typeof BUILTIN_PROVIDER;

export interface TaskModelRef {
  provider: TaskProvider;
  model: string;
}

export interface TaskInfo {
  task: AiTask;
  label: string;
  description: string;
  kind: ProviderKind;
  /** Needs image input (vision) for text tasks. */
  vision?: boolean;
  default: TaskModelRef;
  /** Tried in order when the default (or an override) is unavailable. */
  fallbacks: TaskModelRef[];
}

const or = (model: string): TaskModelRef => ({ provider: "openrouter", model });
const an = (model: string): TaskModelRef => ({ provider: "anthropic", model });
const falm = (model: string): TaskModelRef => ({ provider: "fal", model });

/** OpenRouter slugs of the Claude models (the OpenRouter route). */
export const SONNET = "anthropic/claude-sonnet-5.5";
export const OPUS = "anthropic/claude-opus-5.5";
export const HAIKU = "anthropic/claude-haiku-5.5";

/** The same models on the Anthropic API (the default route when ANTHROPIC_API_KEY is set). */
export const CLAUDE_SONNET = "claude-sonnet-5-5";
export const CLAUDE_OPUS = "claude-opus-5-5";
export const CLAUDE_HAIKU = "claude-haiku-5-5";

/**
 * A Claude model on the Anthropic API first, then the same model through OpenRouter, then the previous
 * generation on both: whichever provider is configured (and up) serves the task.
 */
function claude(
  primary: string,
  primaryOr: string,
  previous: string,
  previousOr: string,
): Pick<TaskInfo, "default" | "fallbacks"> {
  return { default: an(primary), fallbacks: [or(primaryOr), an(previous), or(previousOr)] };
}

export const TASKS: Readonly<Record<AiTask, TaskInfo>> = {
  agent: {
    task: "agent",
    label: "Agent, edit and chat",
    description: "Runs the design agent loop: reads the canvas, plans and edits layers.",
    kind: "text",
    vision: true,
    ...claude(CLAUDE_SONNET, SONNET, "claude-sonnet-5", "anthropic/claude-sonnet-5"),
  },
  plan: {
    task: "plan",
    label: "Campaign planning",
    description: "Plans multi-design campaigns and complete designs before building.",
    kind: "text",
    ...claude(CLAUDE_OPUS, OPUS, "claude-opus-5", "anthropic/claude-opus-5"),
  },
  critique: {
    task: "critique",
    label: "Layout critique",
    description: "Reviews rendered designs for hierarchy, spacing, contrast and polish.",
    kind: "text",
    vision: true,
    ...claude(CLAUDE_OPUS, OPUS, "claude-opus-5", "anthropic/claude-opus-5"),
  },
  vision: {
    task: "vision",
    label: "Vision review",
    description: "Looks at previews and images (alt text, image kind, visual checks).",
    kind: "text",
    vision: true,
    ...claude(CLAUDE_SONNET, SONNET, "claude-sonnet-5", "anthropic/claude-sonnet-5"),
  },
  svg: {
    task: "svg",
    label: "SVG generation",
    description: "Writes vector icons, illustrations and patterns as SVG markup.",
    kind: "text",
    ...claude(CLAUDE_SONNET, SONNET, "claude-sonnet-5", "anthropic/claude-sonnet-5"),
  },
  copy: {
    task: "copy",
    label: "Copywriting",
    description: "Headlines, body copy and rewrites.",
    kind: "text",
    ...claude(CLAUDE_HAIKU, HAIKU, "claude-haiku-4-5", "anthropic/claude-haiku-4.5"),
  },
  translate: {
    task: "translate",
    label: "Translation",
    description: "Translates design text with length awareness.",
    kind: "text",
    ...claude(CLAUDE_HAIKU, HAIKU, "claude-haiku-4-5", "anthropic/claude-haiku-4.5"),
  },
  image: {
    task: "image",
    label: "Image generation",
    description: "Photos and illustrations from a prompt.",
    kind: "image",
    default: falm("blackforestlabs/flux-3/text-to-image"),
    fallbacks: [falm("google/nano-banana-2.1")],
  },
  imageText: {
    task: "imageText",
    label: "Images with text",
    description: "Images that must render legible words (signage, packaging, posters).",
    kind: "image",
    default: falm("ideogram/v4.5"),
    fallbacks: [falm("google/nano-banana-2.1")],
  },
  vector: {
    task: "vector",
    label: "Vector illustration",
    description: "Flat vector art returned as SVG.",
    kind: "image",
    default: falm("fal-ai/recraft/v4.1/text-to-vector"),
    fallbacks: [falm("fal-ai/recraft/v4/text-to-vector")],
  },
  bgRemove: {
    task: "bgRemove",
    label: "Background removal",
    description: "Cuts out the subject with a transparent background.",
    kind: "image",
    default: falm("fal-ai/birefnet/v2"),
    fallbacks: [falm("fal-ai/bria/background/remove")],
  },
  inpaint: {
    task: "inpaint",
    label: "Inpaint",
    description: "Replaces a masked region of an image.",
    kind: "image",
    default: falm("fal-ai/flux-pro/v1/fill"),
    fallbacks: [falm("fal-ai/bria/genfill")],
  },
  outpaint: {
    task: "outpaint",
    label: "Expand image",
    description: "Extends an image beyond its edges to a new size.",
    kind: "image",
    default: falm("fal-ai/flux-2-pro/outpaint"),
    fallbacks: [falm("fal-ai/bria/expand")],
  },
  upscale: {
    task: "upscale",
    label: "Upscale",
    description: "Increases resolution with detail recovery.",
    kind: "image",
    default: falm("fal-ai/seedvr/upscale/image"),
    fallbacks: [falm("topaz/upscale/image/precision")],
  },
  mockup: {
    task: "mockup",
    label: "Mockups",
    description: "Places a design into a realistic scene (device, print, packaging).",
    kind: "image",
    default: falm("google/nano-banana-2.1/edit"),
    fallbacks: [falm("bytedance/seedream/v5/pro/edit")],
  },
  trace: {
    task: "trace",
    label: "Trace to vector",
    description: "Converts a raster image into editable vector paths.",
    kind: "image",
    default: falm("fal-ai/recraft/vectorize"),
    fallbacks: [{ provider: BUILTIN_PROVIDER, model: "posterize-trace" }],
  },
  video: {
    task: "video",
    label: "Video",
    description: "Short clips from an image or a prompt.",
    kind: "video",
    default: falm("alibaba/wan-3.0-prime/image-to-video"),
    fallbacks: [falm("bytedance/seedance-2.5/us/image-to-video")],
  },
  speech: {
    task: "speech",
    label: "Voiceover",
    description: "Text to speech for videos and presentations.",
    kind: "speech",
    default: falm("elevenlabs/tts/eleven-v4"),
    fallbacks: [falm("fal-ai/minimax/speech-2.8-hd")],
  },
  embedding: {
    task: "embedding",
    label: "Embeddings",
    description: "Semantic search over templates and assets.",
    kind: "embedding",
    default: or("google/gemini-embedding-2"),
    fallbacks: [or("openai/text-embedding-3-small")],
  },
};

/** Approximate list prices (USD per million tokens) of pinned text models, from the OpenRouter catalog. */
export const PINNED_TEXT_PRICING: Readonly<Record<string, { input: number; output: number }>> = {
  [SONNET]: { input: 2, output: 10 },
  [OPUS]: { input: 4, output: 20 },
  [HAIKU]: { input: 0.1, output: 0.5 },
  "anthropic/claude-sonnet-5": { input: 2, output: 10 },
  "anthropic/claude-opus-5": { input: 5, output: 25 },
  "anthropic/claude-haiku-4.5": { input: 1, output: 5 },
  // Anthropic API ids (same models, same list prices)
  [CLAUDE_SONNET]: { input: 2, output: 10 },
  [CLAUDE_OPUS]: { input: 4, output: 20 },
  [CLAUDE_HAIKU]: { input: 0.1, output: 0.5 },
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-opus-5": { input: 5, output: 25 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};

export type TaskOverrides = Partial<Record<AiTask, TaskModelRef>>;

/** Model preferences in precedence order (user > workspace > env); each layer is optional. */
export interface ModelPrefs {
  user?: TaskOverrides;
  workspace?: TaskOverrides;
  env?: TaskOverrides;
}

export type ModelSource = "user" | "workspace" | "env" | "default" | "fallback";

export interface ResolvedModel extends TaskModelRef {
  task: AiTask;
  source: ModelSource;
}

export interface ResolveOptions {
  /** Whether a provider can be used right now (configured key / reachable local server). */
  isAvailable?: (provider: TaskProvider) => boolean;
}

function parseRef(value: string): TaskModelRef | undefined {
  const at = value.indexOf(":");
  if (at <= 0) return undefined;
  const provider = value.slice(0, at).trim();
  const model = value.slice(at + 1).trim();
  if (!model) return undefined;
  if (provider === BUILTIN_PROVIDER || isProviderId(provider)) {
    return { provider: provider as TaskProvider, model };
  }
  return undefined;
}

/** Env name for a task override, e.g. `DESYN_AI_MODEL_IMAGE_TEXT` for "imageText". */
export function taskEnvName(task: AiTask): string {
  return `DESYN_AI_MODEL_${task.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase()}`;
}

/**
 * Self-host overrides from env: `DESYN_AI_MODEL_<TASK>="<provider>:<model id>"`, e.g.
 * `DESYN_AI_MODEL_AGENT="ollama:qwen3:32b"` (the first ":" separates the provider).
 */
export function modelEnvDefaults(env: Record<string, string | undefined>): TaskOverrides {
  const out: TaskOverrides = {};
  for (const task of AI_TASKS) {
    const raw = env[taskEnvName(task)];
    const ref = raw ? parseRef(raw) : undefined;
    if (ref) out[task] = ref;
  }
  return out;
}

/** "openrouter:anthropic/claude-sonnet-5.5" form used in settings storage and env vars. */
export function formatModelRef(ref: TaskModelRef): string {
  return `${ref.provider}:${ref.model}`;
}

export function parseModelRef(value: string): TaskModelRef | undefined {
  return parseRef(value);
}

/**
 * Picks the model for a task: user override -> workspace -> env default -> pinned default -> pinned fallbacks,
 * skipping candidates whose provider is not available. When nothing is available the pinned default is returned
 * (with source "default") so callers can surface a "configure a provider" error naming it.
 */
export function resolveModel(
  task: AiTask,
  prefs: ModelPrefs = {},
  options: ResolveOptions = {},
): ResolvedModel {
  const info = TASKS[task];
  const available = options.isAvailable ?? (() => true);
  const candidates: [TaskModelRef | undefined, ModelSource][] = [
    [prefs.user?.[task], "user"],
    [prefs.workspace?.[task], "workspace"],
    [prefs.env?.[task], "env"],
    [info.default, "default"],
    ...info.fallbacks.map((f): [TaskModelRef, ModelSource] => [f, "fallback"]),
  ];
  for (const [ref, source] of candidates) {
    if (ref && available(ref.provider))
      return { task, source, provider: ref.provider, model: ref.model };
  }
  return { task, source: "default", ...info.default };
}

/** Availability predicate backed by configured providers (the built-in tracer is always available). */
export function availabilityFrom(providers: AiProviders): (provider: TaskProvider) => boolean {
  return (provider) => provider === BUILTIN_PROVIDER || providers.isConfigured(provider);
}

/** Narrows a task ref to a provider model ref; throws for built-in refs. */
export function providerRef(ref: TaskModelRef): ModelRef {
  if (ref.provider === BUILTIN_PROVIDER)
    throw new Error(`"${ref.model}" is a built-in implementation`);
  return { provider: ref.provider, model: ref.model };
}

// ---------------------------------------------------------------------------------------------------------------
// Live catalogs
// ---------------------------------------------------------------------------------------------------------------

export interface CatalogModel {
  provider: ProviderId;
  id: string;
  label: string;
  description?: string;
  kinds: ProviderKind[];
  /** fal catalog category (e.g. "text-to-image") or OpenRouter modality string. */
  category?: string;
  tags?: string[];
  contextLength?: number;
  inputModalities?: string[];
  /** USD per million tokens (text models). */
  pricing?: { input?: number; output?: number };
  /** Tasks this model is a sensible choice for. */
  tasks: AiTask[];
}

export interface ModelCatalog {
  fetchedAt: number;
  models: CatalogModel[];
  /** Sources that failed; the catalog then contains only the others (plus stale data when cached). */
  errors: { source: string; message: string }[];
}

interface OpenRouterModel {
  id: string;
  name?: string;
  description?: string;
  context_length?: number;
  architecture?: { input_modalities?: string[]; output_modalities?: string[]; modality?: string };
  pricing?: { prompt?: string; completion?: string };
}

interface FalCatalogModel {
  endpoint_id: string;
  metadata?: {
    display_name?: string;
    category?: string;
    description?: string;
    status?: string;
    tags?: string[];
  };
}

const perMillion = (value: string | undefined): number | undefined => {
  const n = Number.parseFloat(value ?? "");
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 1e6 * 1e4) / 1e4 : undefined;
};

function openRouterTasks(m: OpenRouterModel): AiTask[] {
  const input = m.architecture?.input_modalities ?? [];
  const output = m.architecture?.output_modalities ?? ["text"];
  if (!output.includes("text")) return [];
  const tasks: AiTask[] = ["agent", "plan", "svg", "copy", "translate"];
  if (input.includes("image")) tasks.push("critique", "vision");
  return tasks;
}

export function normalizeOpenRouterModels(
  data: OpenRouterModel[],
  embeddings = false,
): CatalogModel[] {
  return data.map((m) => {
    const pricing: { input?: number; output?: number } = {};
    const input = perMillion(m.pricing?.prompt);
    const output = perMillion(m.pricing?.completion);
    if (input !== undefined) pricing.input = input;
    if (output !== undefined) pricing.output = output;
    const model: CatalogModel = {
      provider: "openrouter",
      id: m.id,
      label: m.name ?? m.id,
      kinds: embeddings
        ? ["embedding"]
        : (m.architecture?.output_modalities ?? ["text"]).includes("image")
          ? ["text", "image"]
          : ["text"],
      tasks: embeddings ? ["embedding"] : openRouterTasks(m),
    };
    if (m.description) model.description = m.description;
    if (m.context_length) model.contextLength = m.context_length;
    if (m.architecture?.input_modalities) model.inputModalities = m.architecture.input_modalities;
    if (m.architecture?.modality) model.category = m.architecture.modality;
    if (Object.keys(pricing).length > 0) model.pricing = pricing;
    return model;
  });
}

const FAL_CATEGORY: Record<
  string,
  { kind: ProviderKind; tasks: (m: FalCatalogModel) => AiTask[] }
> = {
  "text-to-image": {
    kind: "image",
    tasks: (m) => {
      const id = m.endpoint_id.toLowerCase();
      const tags = (m.metadata?.tags ?? []).join(" ").toLowerCase();
      if (/vector|svg/.test(id)) return ["vector"];
      const out: AiTask[] = ["image"];
      if (/typograph|text render/.test(tags) || /ideogram|recraft/.test(id)) out.push("imageText");
      return out;
    },
  },
  "image-to-image": {
    kind: "image",
    tasks: (m) => {
      const id = m.endpoint_id.toLowerCase();
      const tags = (m.metadata?.tags ?? []).join(" ").toLowerCase();
      const out: AiTask[] = [];
      if (/background|birefnet|rembg/.test(`${id} ${tags}`) && !/replace/.test(id))
        out.push("bgRemove");
      if (/upscal|esrgan|seedvr|topaz\/upscale/.test(id)) out.push("upscale");
      if (/outpaint|expand/.test(`${id} ${tags}`)) out.push("outpaint");
      if (/inpaint|fill|genfill/.test(id)) out.push("inpaint");
      if (/vectori[sz]e|image2svg|image-to-svg/.test(id)) out.push("trace");
      if (/\/edit$|kontext|nano-banana|seedream/.test(id)) out.push("mockup");
      return out;
    },
  },
  "image-to-video": { kind: "video", tasks: () => ["video"] },
  "text-to-video": { kind: "video", tasks: () => ["video"] },
  "text-to-speech": { kind: "speech", tasks: () => ["speech"] },
};

export function normalizeFalModels(data: FalCatalogModel[]): CatalogModel[] {
  const out: CatalogModel[] = [];
  for (const m of data) {
    const category = m.metadata?.category ?? "";
    const mapping = FAL_CATEGORY[category];
    if (!mapping || (m.metadata?.status && m.metadata.status !== "active")) continue;
    const model: CatalogModel = {
      provider: "fal",
      id: m.endpoint_id,
      label: m.metadata?.display_name ?? m.endpoint_id,
      kinds: [mapping.kind],
      category,
      tasks: mapping.tasks(m),
    };
    if (m.metadata?.description) model.description = m.metadata.description;
    if (m.metadata?.tags?.length) model.tags = m.metadata.tags;
    out.push(model);
  }
  return out;
}

export interface ListModelsOptions {
  fetch?: FetchLike;
  signal?: AbortSignal;
  /** Which catalogs to include (default both). */
  sources?: ("openrouter" | "fal")[];
  /** Max fal pages per category (100 models each; default 10). */
  falMaxPages?: number;
  /** Bypass the cache. */
  refresh?: boolean;
  /** Retries per request on 429/5xx (default 3 for OpenRouter, 5 for fal). */
  retries?: number;
}

/** Cache shared by every caller in the process; catalogs change slowly. */
export const CATALOG_TTL_MS = 6 * 60 * 60 * 1000;
const catalogCache = new TtlCache<CatalogModel[]>(CATALOG_TTL_MS);

async function fetchOpenRouter(options: ListModelsOptions): Promise<CatalogModel[]> {
  const common = {
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.retries !== undefined ? { retries: options.retries } : {}),
  };
  const [chat, embeddings] = await Promise.all([
    fetchJson<{ data: OpenRouterModel[] }>(MODEL_SOURCES.openrouter, common),
    fetchJson<{ data: OpenRouterModel[] }>(MODEL_SOURCES.openrouterEmbeddings, common).catch(
      () => ({
        data: [] as OpenRouterModel[],
      }),
    ),
  ]);
  const text = normalizeOpenRouterModels(chat.data ?? []);
  return [
    ...text,
    ...directMirror(text),
    ...normalizeOpenRouterModels(embeddings.data ?? [], true),
  ];
}

/** Vendors whose OpenRouter text models are also offered on their own API (when its key is configured). */
const DIRECT_VENDORS: Partial<Record<string, ProviderId>> = {
  anthropic: "anthropic",
  openai: "openai",
  google: "google",
};

/**
 * The OpenRouter text models of Anthropic, OpenAI and Google, listed again under the vendor's own provider with
 * its native model id ("anthropic/claude-sonnet-5.5" -> anthropic "claude-sonnet-5-5"), with the same prices.
 */
export function directMirror(models: CatalogModel[]): CatalogModel[] {
  const out: CatalogModel[] = [];
  for (const m of models) {
    if (m.provider !== "openrouter" || !m.kinds.includes("text")) continue;
    const slash = m.id.indexOf("/");
    const vendor = m.id.slice(0, slash);
    const provider = DIRECT_VENDORS[vendor];
    if (!provider || slash < 0) continue;
    const native = m.id.slice(slash + 1).replace(/:.*$/, "");
    out.push({ ...m, provider, id: vendor === "anthropic" ? native.replace(/\./g, "-") : native });
  }
  return out;
}

async function fetchFal(options: ListModelsOptions): Promise<CatalogModel[]> {
  const raw: FalCatalogModel[] = [];
  for (const category of Object.keys(FAL_CATEGORY)) {
    let cursor: string | undefined;
    for (let page = 0; page < (options.falMaxPages ?? 10); page++) {
      const url = new URL(MODEL_SOURCES.falCatalog);
      url.searchParams.set("category", category);
      url.searchParams.set("limit", "100");
      if (cursor) url.searchParams.set("cursor", cursor);
      // The public catalog rate-limits aggressively; fetchJson honours Retry-After.
      const body = await fetchJson<{
        models: FalCatalogModel[];
        next_cursor?: string;
        has_more?: boolean;
      }>(url.toString(), {
        ...(options.fetch ? { fetch: options.fetch } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
        retries: 5,
        maxDelayMs: 60_000,
      });
      raw.push(...(body.models ?? []));
      if (!body.has_more || !body.next_cursor) break;
      cursor = body.next_cursor;
    }
  }
  return normalizeFalModels(raw);
}

/**
 * Live model catalog from OpenRouter (text, vision, embeddings with prices) and fal (image, editing, video,
 * speech endpoints). Cached for 6 h; when a refresh fails the last good data is returned with the error noted.
 */
export async function listModels(options: ListModelsOptions = {}): Promise<ModelCatalog> {
  const sources = options.sources ?? ["openrouter", "fal"];
  const errors: ModelCatalog["errors"] = [];
  const loaders = { openrouter: fetchOpenRouter, fal: fetchFal };
  const parts = await Promise.all(
    sources.map(async (source) => {
      try {
        const load = () => loaders[source](options);
        return await (options.refresh
          ? catalogCache.refresh(source, load)
          : catalogCache.get(source, load));
      } catch (error) {
        errors.push({ source, message: error instanceof Error ? error.message : String(error) });
        return catalogCache.stale(source) ?? [];
      }
    }),
  );
  return { fetchedAt: Date.now(), models: parts.flat(), errors };
}

/** Clears cached catalogs (tests, admin "refresh"). */
export function clearModelCatalogCache(): void {
  catalogCache.clear();
}

/** Models from a catalog that suit a task, default first. */
export function modelsForTask(catalog: ModelCatalog, task: AiTask): CatalogModel[] {
  const info = TASKS[task];
  const list = catalog.models.filter((m) => m.tasks.includes(task));
  const pinned = [info.default, ...info.fallbacks].map((r) => `${r.provider}:${r.model}`);
  return list.sort((a, b) => {
    const ia = pinned.indexOf(`${a.provider}:${a.id}`);
    const ib = pinned.indexOf(`${b.provider}:${b.id}`);
    return (ia < 0 ? 1e9 : ia) - (ib < 0 ? 1e9 : ib) || a.label.localeCompare(b.label);
  });
}

/** Pinned refs that are missing from a fresh catalog (admin health check: pins drifted from the live catalog). */
export function missingPinnedModels(catalog: ModelCatalog): TaskModelRef[] {
  const ids = new Set(catalog.models.map((m) => `${m.provider}:${m.id}`));
  const checked = new Set(catalog.models.map((m) => m.provider));
  const missing: TaskModelRef[] = [];
  for (const info of Object.values(TASKS)) {
    for (const ref of [info.default, ...info.fallbacks]) {
      if (ref.provider === BUILTIN_PROVIDER || !checked.has(ref.provider)) continue;
      if (
        !ids.has(`${ref.provider}:${ref.model}`) &&
        !missing.some((m) => m.provider === ref.provider && m.model === ref.model)
      ) {
        missing.push(ref);
      }
    }
  }
  return missing;
}

/** USD price per million tokens for a text model: catalog first, then the pinned table. */
export function textPricing(
  model: string,
  catalog?: ModelCatalog,
): { input: number; output: number } | undefined {
  const fromCatalog = catalog?.models.find((m) => m.id === model && m.pricing)?.pricing;
  if (fromCatalog?.input !== undefined && fromCatalog.output !== undefined) {
    return { input: fromCatalog.input, output: fromCatalog.output };
  }
  return PINNED_TEXT_PRICING[model];
}
