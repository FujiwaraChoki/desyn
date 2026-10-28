import {
  AI_TASKS,
  type AiTask,
  availabilityFrom,
  createProviders,
  envProviderConfigs,
  formatModelRef,
  isProviderId,
  type ModelPrefs,
  modelEnvDefaults,
  type PROVIDERS,
  type ProviderConfig,
  type ProviderConfigs,
  type ProviderKind,
  parseModelRef,
  resolveModel,
  type TaskModelRef,
  type TaskOverrides,
} from "@desyn/ai";
import type { Doc } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { hasFeature } from "./entitlements";
import { isHosted } from "./env";
import { errors } from "./errors";
import { getProfile } from "./guards";
import type { FeatureKey } from "./plans";
import type { AiSettings } from "./validators";

// Plan gating and provider availability for AI requests. Availability is decided without decrypting any key
// (mutations only need to know whether a provider is configured); actions decrypt BYOK keys themselves.

type DbCtx = QueryCtx | MutationCtx;

/** Plan feature per media task (config/plans.json). */
export const MEDIA_FEATURE = {
  image: "ai.images",
  svg: "ai.svg",
  "remove-background": "ai.removeBackground",
  inpaint: "ai.inpaint",
  outpaint: "ai.outpaint",
  upscale: "ai.upscale",
  mockup: "ai.mockup",
  trace: "ai.svg",
  video: "video",
} as const satisfies Record<string, FeatureKey>;
export type MediaTask = keyof typeof MEDIA_FEATURE;
export const MEDIA_TASKS = Object.keys(MEDIA_FEATURE) as MediaTask[];
export function isMediaTask(task: string): task is MediaTask {
  return Object.hasOwn(MEDIA_FEATURE, task);
}

/** Routing task (packages/ai models.ts) used by each media task. */
export const MEDIA_ROUTE: Record<MediaTask, AiTask> = {
  image: "image",
  svg: "svg",
  "remove-background": "bgRemove",
  inpaint: "inpaint",
  outpaint: "outpaint",
  upscale: "upscale",
  mockup: "mockup",
  trace: "trace",
  video: "video",
};

/** Plan features each workflow needs (on top of `workflows`). */
export const WORKFLOW_FEATURES = {
  campaign: ["workflows", "campaign", "ai.agent"],
  variants: ["workflows", "ai.agent"],
  resize: ["workflows", "magicResize"],
  localize: ["workflows", "localize", "ai.translate"],
  bulk: ["workflows", "bulkCreate"],
  exportBundle: ["workflows"],
} as const satisfies Record<string, readonly FeatureKey[]>;
export type WorkflowType = keyof typeof WORKFLOW_FEATURES;
export function isWorkflowType(type: string): type is WorkflowType {
  return Object.hasOwn(WORKFLOW_FEATURES, type);
}

export interface AiAccess {
  profile: Doc<"profiles"> | null;
  settings: AiSettings;
  byokAllowed: boolean;
  localAllowed: boolean;
}

export async function aiAccess(ctx: DbCtx, userId: string): Promise<AiAccess> {
  const profile = await getProfile(ctx, userId);
  return {
    profile,
    settings: profile?.aiSettings ?? {},
    byokAllowed: await hasFeature(ctx, userId, "ai.byok"),
    localAllowed: await hasFeature(ctx, userId, "ai.local"),
  };
}

export async function requireFeatures(
  ctx: DbCtx,
  userId: string,
  features: readonly FeatureKey[],
): Promise<void> {
  for (const feature of features) {
    if (!(await hasFeature(ctx, userId, feature))) throw errors.feature(feature);
  }
}

/** Placeholder secret standing in for a stored (encrypted) key when only availability matters. */
const PRESENT = "configured-key-placeholder";

/**
 * Providers configured for a user, keyed by source, without secrets: server env keys and stored BYOK keys
 * (when the plan allows BYOK and the user keeps keys on the server). Locally configured providers (Ollama on
 * the user's machine) are browser-only and never available to server runs.
 */
export function presenceConfigs(access: AiAccess): { env: ProviderConfigs; user: ProviderConfigs } {
  const env = envProviderConfigs();
  const user: ProviderConfigs = {};
  const byok = access.settings.keyMode === "local" ? {} : (access.settings.byok ?? {});
  if (access.byokAllowed) {
    for (const [id, entry] of Object.entries(byok)) {
      if (!isProviderId(id)) continue;
      const config: ProviderConfig = { apiKey: PRESENT };
      if (entry.baseUrl) config.baseURL = entry.baseUrl;
      user[id] = config;
    }
  }
  // Hosted servers cannot reach a user's local Ollama; self-hosters may point the server at one.
  if (!isHosted() && access.localAllowed && access.settings.ollamaBaseUrl && !env.ollama) {
    user.ollama = { baseURL: access.settings.ollamaBaseUrl };
  }
  return { env, user };
}

/** User per-task overrides from profiles.aiSettings.taskModels (invalid entries ignored). */
export function userTaskOverrides(settings: AiSettings): TaskOverrides {
  const out: TaskOverrides = {};
  for (const [task, ref] of Object.entries(settings.taskModels ?? {})) {
    if (!(AI_TASKS as readonly string[]).includes(task)) continue;
    const parsed = parseModelRef(`${ref.provider}:${ref.model}`);
    if (parsed) out[task as AiTask] = parsed;
  }
  return out;
}

export function modelPrefs(
  settings: AiSettings,
  override?: { task: AiTask; ref: TaskModelRef },
): ModelPrefs {
  const user = userTaskOverrides(settings);
  if (override) user[override.task] = override.ref;
  return { user, env: modelEnvDefaults(process.env as Record<string, string | undefined>) };
}

/** Parses a "provider:model" override; INVALID_ARGUMENT when malformed. */
export function parseOverride(model: string): TaskModelRef {
  const ref = parseModelRef(model);
  if (!ref) throw errors.invalid('Model must look like "provider:model".', "model");
  return ref;
}

export interface Availability {
  /** Providers usable by server runs for this user. */
  providers: string[];
  /** Whether at least one provider of the kind is configured. */
  has(kind: ProviderKind): boolean;
  /** Who pays for a configured provider (server keys = platform credits). */
  billingOf(provider: string): "platform" | "byok" | "local" | null;
  /** Model the task would route to, and whether its provider is available. */
  route(task: AiTask, prefs: ModelPrefs): { ref: string; available: boolean; billing: string };
}

export function availability(access: AiAccess): Availability {
  const configs = presenceConfigs(access);
  const providers = createProviders({ env: configs.env, user: configs.user });
  const isAvailable = availabilityFrom(providers);
  return {
    providers: providers.configured(),
    has: (kind) => providers.configured(kind).length > 0,
    billingOf: (provider) =>
      isProviderId(provider)
        ? (providers.billing(provider) ?? null)
        : provider === "builtin"
          ? "platform"
          : null,
    route: (task, prefs) => {
      const resolved = resolveModel(task, prefs, { isAvailable });
      const available = isAvailable(resolved.provider);
      const billing =
        resolved.provider === "builtin"
          ? "platform"
          : (providers.billing(resolved.provider as keyof typeof PROVIDERS) ?? "platform");
      return { ref: formatModelRef(resolved), available, billing };
    },
  };
}

/** NOT_CONFIGURED unless the task can be routed to a configured provider. */
export function assertRoutable(
  avail: Availability,
  task: AiTask,
  prefs: ModelPrefs,
): { ref: string; billing: "platform" | "byok" | "local" } {
  const route = avail.route(task, prefs);
  if (!route.available) {
    throw errors.notConfigured(
      `An AI provider for ${task === "agent" ? "the design agent" : task} (${route.ref.split(":")[0]})`,
    );
  }
  return { ref: route.ref, billing: route.billing as "platform" | "byok" | "local" };
}
