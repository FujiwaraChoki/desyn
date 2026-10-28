// Resolves models, media and search for a run from provider settings and preferences.
import type { LanguageModel } from "ai";
import type { CreditMeter } from "../credits";
import { AiError } from "../errors";
import { createMedia } from "../media/media";
import { createRuleModeration, type ModerationHook } from "../media/moderation";
import type { Media } from "../media/types";
import {
  type AiTask,
  availabilityFrom,
  BUILTIN_PROVIDER,
  formatModelRef,
  type ModelPrefs,
  providerRef,
  type ResolvedModel,
  resolveModel,
} from "../models";
import type { AiProviders } from "../providers/config";
import type { Billing } from "../providers/types";
import type { RoutedModel, TextModels } from "../tools/types";
import type { FetchLike } from "../util/async";
import type { AgentEvent } from "./events";

export interface RouteOptions {
  providers: AiProviders;
  prefs?: ModelPrefs;
}

/** Resolves a text task to a language model, or undefined when no provider for it is configured. */
export function routeText(
  task: AiTask,
  options: RouteOptions,
): (RoutedModel & { resolved: ResolvedModel }) | undefined {
  const isAvailable = availabilityFrom(options.providers);
  const resolved = resolveModel(task, options.prefs ?? {}, { isAvailable });
  if (resolved.provider === BUILTIN_PROVIDER || !isAvailable(resolved.provider)) return undefined;
  const ref = providerRef(resolved);
  return {
    model: options.providers.languageModel(ref),
    billing: options.providers.billing(ref.provider) ?? ("platform" as Billing),
    label: formatModelRef(resolved),
    resolved,
  };
}

export function routeTextModels(options: RouteOptions): TextModels {
  const out: TextModels = {};
  const copy = routeText("copy", options);
  const translate = routeText("translate", options);
  const critique = routeText("critique", options);
  if (copy) out.copy = copy;
  if (translate) out.translate = translate;
  if (critique) out.critique = critique;
  return out;
}

export interface MediaSetup {
  providers: AiProviders;
  prefs?: ModelPrefs;
  moderation?: ModerationHook;
  meter?: CreditMeter;
  fetch?: FetchLike;
  runId: string;
  emit: (event: AgentEvent) => void;
}

/** Media for a run, or undefined when no image-capable provider is configured. */
export function setupMedia(options: MediaSetup): Media | undefined {
  if (options.providers.configured("image").length === 0) return undefined;
  return createMedia({
    providers: options.providers,
    ...(options.prefs ? { prefs: options.prefs } : {}),
    moderation: options.moderation ?? createRuleModeration(),
    ...(options.meter ? { meter: options.meter } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
    onProgress: (p) =>
      options.emit({
        type: "progress",
        runId: options.runId,
        label: `${p.task}: ${p.status}`,
        ...(p.position !== undefined
          ? { detail: `queue position ${p.position}` }
          : p.message
            ? { detail: p.message }
            : {}),
      }),
  });
}

export interface AgentModel {
  model: LanguageModel;
  billing: Billing;
  label: string;
  /** Model id for pricing lookups. */
  modelId: string;
}

export function routeAgentModel(options: RouteOptions & { model?: LanguageModel }): AgentModel {
  if (options.model) {
    const id = typeof options.model === "string" ? options.model : options.model.modelId;
    return { model: options.model, billing: "platform", label: id, modelId: id };
  }
  const routed = routeText("agent", options);
  if (!routed) {
    const fallback = resolveModel("agent", options.prefs ?? {});
    throw new AiError(
      "provider-not-configured",
      `No provider is configured for the agent (default ${formatModelRef(fallback)}). Add a key in Settings › AI providers.`,
    );
  }
  return {
    model: routed.model,
    billing: routed.billing,
    label: routed.label,
    modelId: routed.resolved.model,
  };
}
