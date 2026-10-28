import { v } from "convex/values";
import { internalMutation, internalQuery } from "../_generated/server";
import { aiAccess, availability, modelPrefs } from "../lib/ai_access";
import { getUser } from "../lib/guards";

// Cached live model catalogs (OpenRouter + fal) for the settings model pickers and `ai.models.list`. The
// catalog JSON lives in file storage (the fal catalog is too large for a document); rows point at it.

/** Catalogs older than this are refreshed on the next read (and by the cron). */
export const CATALOG_TTL_MS = 6 * 60 * 60_000;

export const entries = internalQuery({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("aiModelCatalog").collect();
    return rows.map((r) => ({
      source: r.source,
      storageId: r.storageId,
      count: r.count,
      fetchedAt: r.fetchedAt,
      checkedAt: r.checkedAt ?? r.fetchedAt,
      error: r.error ?? null,
    }));
  },
});

export const put = internalMutation({
  args: {
    source: v.union(v.literal("openrouter"), v.literal("fal")),
    storageId: v.id("_storage"),
    count: v.number(),
    fetchedAt: v.number(),
    error: v.optional(v.string()),
    checkedAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("aiModelCatalog")
      .withIndex("by_source", (q) => q.eq("source", args.source))
      .collect();
    for (const row of existing) {
      await ctx.storage.delete(row.storageId);
      await ctx.db.delete("aiModelCatalog", row._id);
    }
    await ctx.db.insert("aiModelCatalog", args);
    return null;
  },
});

/**
 * Notes a failed refresh on the existing row (the last good catalog keeps serving); `checkedAt` makes the
 * next attempt wait. False when there is no row yet.
 */
export const markError = internalMutation({
  args: { source: v.union(v.literal("openrouter"), v.literal("fal")), error: v.string() },
  handler: async (ctx, args): Promise<boolean> => {
    const row = await ctx.db
      .query("aiModelCatalog")
      .withIndex("by_source", (q) => q.eq("source", args.source))
      .first();
    if (!row) return false;
    await ctx.db.patch("aiModelCatalog", row._id, {
      error: args.error.slice(0, 500),
      checkedAt: Date.now(),
    });
    return true;
  },
});

/**
 * Which providers the signed-in user (or a verified API user) can use from the server, and the model each
 * task routes to. No secrets: presence only.
 */
export const accessFor = internalQuery({
  args: { userId: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const userId = args.userId ?? (await getUser(ctx))?.userId;
    if (!userId) return null;
    const access = await aiAccess(ctx, userId);
    const avail = availability(access);
    return {
      userId,
      providers: avail.providers,
      billing: Object.fromEntries(
        avail.providers.map((p) => [p, avail.billingOf(p) ?? "platform"]),
      ),
      byokAllowed: access.byokAllowed,
      localAllowed: access.localAllowed,
      taskModels: access.settings.taskModels ?? {},
      keyMode: access.settings.keyMode ?? "server",
      preferByok: access.settings.preferByok !== false,
      byok: Object.fromEntries(
        Object.entries(access.settings.byok ?? {}).map(([id, e]) => [
          id,
          {
            last4: e.last4 ?? null,
            label: e.label ?? null,
            baseUrl: e.baseUrl ?? null,
            updatedAt: e.updatedAt,
          },
        ]),
      ),
      prefs: modelPrefs(access.settings),
    };
  },
});
