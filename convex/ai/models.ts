"use node";

import {
  AI_TASKS,
  type AiTask,
  BUILTIN_PROVIDER,
  type CatalogModel,
  formatModelRef,
  listModels,
  type ModelCatalog,
  type ModelPrefs,
  modelsForTask,
  resolveModel,
  TASKS,
} from "@desyn/ai";
import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { type ActionCtx, action, internalAction } from "../_generated/server";
import { guardedFetch } from "../lib/ai_net";
import { isHosted } from "../lib/env";
import { appError, errors } from "../lib/errors";
import { createLogger } from "../lib/logger";
import { CATALOG_TTL_MS } from "./catalog";

// `ai.models.list`: per-task model options for the settings pickers and the Agent API, from the live
// OpenRouter and fal catalogs (cached in aiModelCatalog for 6 h, refreshed by a cron) plus the pinned
// defaults, marked with who pays (server credits, BYOK, local) and whether the provider is configured.

type Source = "openrouter" | "fal";
const SOURCES: Source[] = ["openrouter", "fal"];
const MAX_OPTIONS = 200;
/** A forced refresh (settings "Refresh" button) re-fetches a catalog at most this often. */
export const MIN_REFRESH_MS = 10 * 60_000;

export interface ModelOption {
  id: string;
  label: string;
  provider: string;
  source: "server" | "byok" | "local" | "builtin";
  default: boolean;
  available: boolean;
  description?: string;
  pricing?: { input?: number; output?: number };
  contextLength?: number;
}

interface CatalogEntry {
  source: Source;
  storageId: Id<"_storage">;
  count: number;
  fetchedAt: number;
  checkedAt: number;
  error: string | null;
}

/**
 * Whether a catalog should be fetched now: when missing, past its TTL (a failed, empty one after
 * MIN_REFRESH_MS) or on a forced refresh, and never more often than MIN_REFRESH_MS. Anyone signed in may ask
 * for a refresh: neither that nor a provider outage may turn into a stream of catalog downloads.
 */
export function dueForFetch(
  row: Pick<CatalogEntry, "count" | "fetchedAt" | "checkedAt"> | undefined,
  now: number,
  refresh: boolean,
): boolean {
  if (!row) return true;
  if (now - Math.max(row.fetchedAt, row.checkedAt) <= MIN_REFRESH_MS) return false;
  const ttl = row.count === 0 ? MIN_REFRESH_MS : CATALOG_TTL_MS;
  return refresh || now - row.fetchedAt > ttl;
}

interface ModelList {
  tasks: Record<string, ModelOption[]>;
  fetchedAt: number;
  errors: { source: string; message: string }[];
}

interface Access {
  providers: string[];
  billing: Record<string, string>;
  prefs: ModelPrefs;
}

async function readCatalog(ctx: ActionCtx, refresh: boolean): Promise<ModelCatalog> {
  const rows: CatalogEntry[] = await ctx.runQuery(internal.ai.catalog.entries, {});
  const now = Date.now();
  // Grouped by catalog source: the OpenRouter catalog also lists Anthropic, OpenAI and Google models under
  // their own providers (directMirror), so a refresh replaces whole sources, not providers.
  const bySource = new Map<Source, CatalogModel[]>();
  const errorsOut: ModelCatalog["errors"] = [];
  const stale: Source[] = [];
  for (const source of SOURCES) {
    const row = rows.find((r) => r.source === source);
    if (dueForFetch(row, now, refresh)) stale.push(source);
    if (row) {
      const blob = await ctx.storage.get(row.storageId);
      if (blob) bySource.set(source, JSON.parse(await blob.text()) as CatalogModel[]);
    }
  }
  const stored = () => [...bySource.values()].flat();
  if (stale.length === 0) return { fetchedAt: now, models: stored(), errors: errorsOut };
  const fresh = await fetchAndStore(ctx, stale);
  for (const source of fresh.sources) bySource.delete(source);
  return { fetchedAt: now, models: [...stored(), ...fresh.models], errors: fresh.errors };
}

async function fetchAndStore(
  ctx: ActionCtx,
  sources: Source[],
): Promise<{ models: CatalogModel[]; errors: ModelCatalog["errors"]; sources: Source[] }> {
  const fetchImpl = guardedFetch({ enabled: isHosted() });
  const out: CatalogModel[] = [];
  const failures: ModelCatalog["errors"] = [];
  const refreshed: Source[] = [];
  for (const source of sources) {
    const catalog = await listModels({
      sources: [source],
      refresh: true,
      fetch: (input, init) => fetchImpl(input, init),
    });
    const err = catalog.errors[0];
    if (err || catalog.models.length === 0) {
      const message = err?.message ?? "empty catalog";
      failures.push({ source, message });
      const kept = await ctx.runMutation(internal.ai.catalog.markError, {
        source,
        error: message,
      });
      if (!kept) {
        // No earlier catalog to keep serving: remember the failure (empty catalog) so readers back off.
        const storageId = await ctx.storage.store(new Blob(["[]"], { type: "application/json" }));
        await ctx.runMutation(internal.ai.catalog.put, {
          source,
          storageId,
          count: 0,
          fetchedAt: Date.now(),
          checkedAt: Date.now(),
          error: message.slice(0, 500),
        });
      }
      continue;
    }
    const storageId = await ctx.storage.store(
      new Blob([JSON.stringify(catalog.models)], { type: "application/json" }),
    );
    await ctx.runMutation(internal.ai.catalog.put, {
      source,
      storageId,
      count: catalog.models.length,
      fetchedAt: Date.now(),
    });
    out.push(...catalog.models);
    refreshed.push(source);
  }
  return { models: out, errors: failures, sources: refreshed };
}

function sourceOf(provider: string, access: Access): ModelOption["source"] {
  if (provider === BUILTIN_PROVIDER) return "builtin";
  const billing = access.billing[provider];
  return billing === "byok" ? "byok" : billing === "local" ? "local" : "server";
}

/** Options for one task: the model that will run, the user's choice, the pinned routes, then the live catalog. */
export function optionsFor(task: AiTask, catalog: ModelCatalog, access: Access): ModelOption[] {
  const configured = new Set(access.providers);
  const isAvailable = (p: string) => p === BUILTIN_PROVIDER || configured.has(p);
  const resolvedRef = resolveModel(task, access.prefs, { isAvailable });
  const resolved = formatModelRef(resolvedRef);
  const options = new Map<string, ModelOption>();
  const add = (provider: string, model: string, extra: Partial<ModelOption> = {}) => {
    const id = `${provider}:${model}`;
    if (options.has(id)) return;
    options.set(id, {
      id,
      label: extra.label ?? model,
      provider,
      source: sourceOf(provider, access),
      default: id === resolved,
      available: isAvailable(provider),
      ...(extra.description ? { description: extra.description.slice(0, 300) } : {}),
      ...(extra.pricing ? { pricing: extra.pricing } : {}),
      ...(extra.contextLength ? { contextLength: extra.contextLength } : {}),
    });
  };
  const info = TASKS[task];
  // The model that will actually run comes first (with several routes to the same model, e.g. Claude on the
  // Anthropic API or through OpenRouter, that is the first configured one).
  const resolvedFromCatalog = catalog.models.find(
    (m) => m.provider === resolvedRef.provider && m.id === resolvedRef.model,
  );
  add(
    resolvedRef.provider,
    resolvedRef.model,
    resolvedFromCatalog ? { label: resolvedFromCatalog.label } : {},
  );
  const own = access.prefs.user?.[task];
  if (own) add(own.provider, own.model);
  for (const ref of [info.default, ...info.fallbacks]) {
    const fromCatalog = catalog.models.find(
      (m) => m.provider === ref.provider && m.id === ref.model,
    );
    add(ref.provider, ref.model, fromCatalog ? { label: fromCatalog.label } : {});
  }
  for (const m of modelsForTask(catalog, task)) {
    if (options.size >= MAX_OPTIONS) break;
    add(m.provider, m.id, {
      label: m.label,
      ...(m.description ? { description: m.description } : {}),
      ...(m.pricing ? { pricing: m.pricing } : {}),
      ...(m.contextLength ? { contextLength: m.contextLength } : {}),
    });
  }
  return [...options.values()];
}

async function listFor(
  ctx: ActionCtx,
  access: Access,
  args: { task?: string; refresh?: boolean },
): Promise<ModelList> {
  if (args.task !== undefined && !(AI_TASKS as readonly string[]).includes(args.task)) {
    throw appError("INVALID_ARGUMENT", "Unknown task.", { field: "task" });
  }
  const catalog = await readCatalog(ctx, args.refresh === true);
  const tasks = (args.task ? [args.task as AiTask] : [...AI_TASKS]).filter(
    (t) => TASKS[t] !== undefined,
  );
  return {
    tasks: Object.fromEntries(tasks.map((t) => [t, optionsFor(t, catalog, access)])),
    fetchedAt: catalog.fetchedAt,
    errors: catalog.errors.map((e) => ({ source: e.source, message: e.message.slice(0, 200) })),
  };
}

/** Model options per task for the signed-in user (settings → AI providers). */
export const list = action({
  args: { task: v.optional(v.string()), refresh: v.optional(v.boolean()) },
  handler: async (ctx, args): Promise<ModelList> => {
    const access: Access | null = await ctx.runQuery(internal.ai.catalog.accessFor, {});
    if (!access) throw errors.unauthenticated();
    return await listFor(ctx, access, args);
  },
});

/** Agent API: model options for a verified API user; NOT_CONFIGURED when no provider is available. */
export const listForUser = internalAction({
  args: { userId: v.string(), task: v.optional(v.string()) },
  handler: async (ctx, args): Promise<{ tasks: Record<string, ModelOption[]> }> => {
    const access: (Access & { providers: string[] }) | null = await ctx.runQuery(
      internal.ai.catalog.accessFor,
      { userId: args.userId },
    );
    if (!access) throw errors.notFound("User");
    if (access.providers.length === 0) throw errors.notConfigured("AI providers");
    const out = await listFor(ctx, access, args.task ? { task: args.task } : {});
    return { tasks: out.tasks };
  },
});

/** Cron: refreshes stale catalogs so pickers never wait on the providers. */
export const refreshCatalogs = internalAction({
  args: {},
  handler: async (ctx): Promise<null> => {
    const log = createLogger(ctx, { fn: "ai.refreshCatalogs" });
    const rows: CatalogEntry[] = await ctx.runQuery(internal.ai.catalog.entries, {});
    // A little ahead of the TTL so readers never find a stale catalog.
    const now = Date.now() + 15 * 60_000;
    const stale = SOURCES.filter((s) =>
      dueForFetch(
        rows.find((r) => r.source === s),
        now,
        false,
      ),
    );
    if (stale.length > 0) {
      const res = await fetchAndStore(ctx, stale);
      log.info("model catalogs refreshed", {
        sources: res.sources,
        models: res.models.length,
        failed: res.errors.map((e) => e.source),
      });
    }
    await log.flush();
    return null;
  },
});
