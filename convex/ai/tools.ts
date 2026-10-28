import type { DesignKind } from "@desyn/schema";
import { v } from "convex/values";
import { internalQuery } from "../_generated/server";
import { blobUrl } from "../lib/designs_blob";
import { loadTemplateDesign } from "../lib/designs_templates";
import { hasFeature } from "../lib/entitlements";

// Data the agent's search tools read (search_templates / apply_template), for the Node action's
// TemplateProvider. Premium templates are only offered to plans that may use them.

export const searchTemplates = internalQuery({
  args: {
    userId: v.string(),
    query: v.string(),
    kind: v.optional(v.string()),
    limit: v.number(),
  },
  handler: async (ctx, args) => {
    const premium = await hasFeature(ctx, args.userId, "templates.premium");
    const text = args.query.trim().toLowerCase().slice(0, 200);
    const limit = Math.max(1, Math.min(24, args.limit));
    const rows = text
      ? await ctx.db
          .query("templates")
          .withSearchIndex("search_text", (q) => {
            let s = q.search("searchText", text).eq("status", "published");
            if (args.kind) s = s.eq("kind", args.kind);
            if (!premium) s = s.eq("premium", false);
            return s;
          })
          .take(limit)
      : await ctx.db
          .query("templates")
          .withIndex("by_status_popularity", (q) => q.eq("status", "published"))
          .order("desc")
          .take(limit * 3);
    const out = [];
    for (const t of rows) {
      if (!premium && t.premium) continue;
      if (args.kind && t.kind !== args.kind) continue;
      const cover = t.thumbnails[0];
      const thumbnailUrl = cover ? await blobUrl(ctx, cover.key) : null;
      out.push({
        id: t._id as string,
        title: t.title,
        kind: t.kind as DesignKind,
        tags: t.tags,
        premium: t.premium,
        ...(thumbnailUrl ? { thumbnailUrl } : {}),
        ...(cover ? { width: cover.width, height: cover.height } : {}),
      });
      if (out.length >= limit) break;
    }
    return out;
  },
});

export const templateDesign = internalQuery({
  args: { userId: v.string(), templateId: v.string() },
  handler: async (ctx, args) => {
    const id = ctx.db.normalizeId("templates", args.templateId);
    if (!id) return null;
    try {
      const { template, design } = await loadTemplateDesign(ctx, id);
      if (template.premium && !(await hasFeature(ctx, args.userId, "templates.premium")))
        return null;
      return JSON.stringify(design);
    } catch {
      return null;
    }
  },
});
