import {
  AI_TASKS,
  type AiTask,
  availabilityFrom,
  createProviders,
  formatModelRef,
  isProviderId,
  PROVIDERS,
  parseModelRef,
  resolveModel,
  TASKS,
} from "@desyn/ai";
import { v } from "convex/values";
import { internal } from "../_generated/api";
import { mutation, query } from "../_generated/server";
import { aiAccess, modelPrefs, presenceConfigs } from "../lib/ai_access";
import { errors } from "../lib/errors";
import { requireUser } from "../lib/guards";
import type { AiSettings } from "../lib/validators";

// AI settings view and per-task model choice (Settings › AI providers). Keys never leave the server: the
// view only says which providers are configured and where from. Saving keys: ai/settings:saveByokKey.

/** Providers, per-task routing and the user's choices, without secrets. */
export const get = query({
  args: {},
  handler: async (ctx) => {
    const user = await requireUser(ctx);
    const access = await aiAccess(ctx, user.userId);
    const configs = presenceConfigs(access);
    const providers = createProviders({ env: configs.env, user: configs.user });
    const prefs = modelPrefs(access.settings);
    const isAvailable = availabilityFrom(providers);
    return {
      byokAllowed: access.byokAllowed,
      localAllowed: access.localAllowed,
      keyMode: access.settings.keyMode ?? "server",
      preferByok: access.settings.preferByok !== false,
      providers: Object.values(PROVIDERS).map((p) => {
        const stored = access.settings.byok?.[p.id];
        return {
          id: p.id,
          label: p.label,
          description: p.description,
          kinds: [...p.kinds],
          byok: p.byok,
          local: p.local,
          docsUrl: p.docsUrl,
          server: Boolean(configs.env[p.id]),
          key: stored
            ? {
                last4: stored.last4 ?? null,
                label: stored.label ?? null,
                baseUrl: stored.baseUrl ?? null,
                updatedAt: stored.updatedAt,
              }
            : null,
          available: providers.isConfigured(p.id),
          billing: providers.billing(p.id) ?? null,
        };
      }),
      tasks: AI_TASKS.map((task) => {
        const info = TASKS[task];
        const resolved = resolveModel(task, prefs, { isAvailable });
        const choice = prefs.user?.[task];
        return {
          task,
          label: info.label,
          description: info.description,
          kind: info.kind,
          choice: choice ? formatModelRef(choice) : null,
          model: formatModelRef(resolved),
          source: resolved.source,
          available: isAvailable(resolved.provider),
        };
      }),
    };
  },
});

/** Chooses the model for one task ("provider:model"), or resets it to the default (null). */
export const setTaskModel = mutation({
  args: { task: v.string(), model: v.union(v.string(), v.null()) },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    if (!(AI_TASKS as readonly string[]).includes(args.task))
      throw errors.invalid("Unknown task.", "task");
    const task = args.task as AiTask;
    const settings: AiSettings = { ...(user.profile?.aiSettings ?? {}) };
    const taskModels = { ...(settings.taskModels ?? {}) };
    if (args.model === null) {
      delete taskModels[task];
    } else {
      const ref = parseModelRef(args.model);
      if (!ref || args.model.length > 260) throw errors.invalid('Use "provider:model".', "model");
      if (ref.provider !== "builtin" && !isProviderId(ref.provider))
        throw errors.invalid("Unknown provider.", "model");
      const kind = TASKS[task].kind;
      if (ref.provider !== "builtin" && !PROVIDERS[ref.provider].kinds.includes(kind))
        throw errors.invalid(`${PROVIDERS[ref.provider].label} has no ${kind} models.`, "model");
      taskModels[task] = { provider: ref.provider, model: ref.model };
    }
    await ctx.runMutation(internal.accounts.profiles.setAiSettings, {
      userId: user.userId,
      aiSettings: { ...settings, taskModels },
    });
    return null;
  },
});
