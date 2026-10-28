import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { type MutationCtx, mutation, type QueryCtx, query } from "../_generated/server";
import { createDesignFor } from "../designs/designs";
import { blobUrl } from "../lib/designs_blob";
import { loadTemplateJson } from "../lib/designs_templates";
import { hasFeature } from "../lib/entitlements";
import { errors } from "../lib/errors";
import { getUser, requireUser } from "../lib/guards";

// templates.search|list|get|getDesign|collections|categories|instantiate|favorite|favorites.
// Browsing works signed out (landing gallery); instantiating needs an editor seat and, for premium
// templates, the plan feature `templates.premium`.

type DbCtx = QueryCtx | MutationCtx;

export async function templateView(ctx: DbCtx, t: Doc<"templates">, favorite: boolean) {
  const thumbnails = [];
  for (const thumb of t.thumbnails) {
    thumbnails.push({
      url: await blobUrl(ctx, thumb.key),
      width: thumb.width,
      height: thumb.height,
    });
  }
  return {
    id: t._id,
    slug: t.slug,
    title: t.title,
    description: t.description,
    kind: t.kind,
    category: t.category,
    categories: t.categories,
    tags: t.tags,
    premium: t.premium,
    pageCount: t.pageCount,
    width: t.width,
    height: t.height,
    popularity: t.popularity,
    thumbnails,
    favorite,
    updatedAt: t.updatedAt,
  };
}

/** Favorite template ids of the signed-in user (empty when signed out). */
async function favoriteSet(ctx: DbCtx): Promise<Set<string>> {
  const user = await getUser(ctx);
  if (!user) return new Set();
  const rows = await ctx.db
    .query("favorites")
    .withIndex("by_user_type_created", (q) =>
      q.eq("userId", user.userId).eq("targetType", "template"),
    )
    .take(1_000);
  return new Set(rows.map((r) => r.targetId));
}

export const search = query({
  args: {
    query: v.string(),
    kind: v.optional(v.string()),
    category: v.optional(v.string()),
    premium: v.optional(v.boolean()),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    const text = args.query.trim().toLowerCase().slice(0, 200);
    const page = text
      ? await ctx.db
          .query("templates")
          .withSearchIndex("search_text", (q) => {
            let s = q.search("searchText", text).eq("status", "published");
            if (args.kind) s = s.eq("kind", args.kind);
            if (args.category) s = s.eq("category", args.category);
            if (args.premium !== undefined) s = s.eq("premium", args.premium);
            return s;
          })
          .paginate(args.paginationOpts)
      : await listQuery(ctx, args).paginate(args.paginationOpts);
    const favorites = await favoriteSet(ctx);
    const out = [];
    for (const t of page.page) {
      if (args.premium !== undefined && t.premium !== args.premium) continue;
      out.push(await templateView(ctx, t, favorites.has(t._id)));
    }
    return { ...page, page: out };
  },
});

export function listQuery(
  ctx: QueryCtx,
  args: { kind?: string; category?: string; sort?: "popular" | "new" },
) {
  if (args.sort === "new") {
    const q = ctx.db
      .query("templates")
      .withIndex("by_status_updated", (q) => q.eq("status", "published"))
      .order("desc");
    return args.kind || args.category
      ? q.filter((f) =>
          f.and(
            args.kind ? f.eq(f.field("kind"), args.kind) : true,
            args.category ? f.eq(f.field("category"), args.category) : true,
          ),
        )
      : q;
  }
  if (args.category) {
    const q = ctx.db
      .query("templates")
      .withIndex("by_status_category_popularity", (q) =>
        q.eq("status", "published").eq("category", args.category as string),
      )
      .order("desc");
    return args.kind ? q.filter((f) => f.eq(f.field("kind"), args.kind as string)) : q;
  }
  if (args.kind) {
    return ctx.db
      .query("templates")
      .withIndex("by_status_kind_popularity", (q) =>
        q.eq("status", "published").eq("kind", args.kind as string),
      )
      .order("desc");
  }
  return ctx.db
    .query("templates")
    .withIndex("by_status_popularity", (q) => q.eq("status", "published"))
    .order("desc");
}

export const list = query({
  args: {
    /** Collection slug: templates in the collection's order. */
    collection: v.optional(v.string()),
    category: v.optional(v.string()),
    kind: v.optional(v.string()),
    sort: v.optional(v.union(v.literal("popular"), v.literal("new"))),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    const favorites = await favoriteSet(ctx);
    if (args.collection) {
      const collection = await ctx.db
        .query("templateCollections")
        .withIndex("by_slug", (q) => q.eq("slug", args.collection as string))
        .unique();
      if (!collection?.published) throw errors.notFound("Collection");
      // Collections are short ordered lists; the cursor is an offset.
      const offset = args.paginationOpts.cursor ? Number(args.paginationOpts.cursor) || 0 : 0;
      const ids = collection.templateIds.slice(offset, offset + args.paginationOpts.numItems);
      const page = [];
      for (const id of ids) {
        const t = await ctx.db.get("templates", id);
        if (t && t.status === "published")
          page.push(await templateView(ctx, t, favorites.has(t._id)));
      }
      const next = offset + ids.length;
      return {
        page,
        isDone: next >= collection.templateIds.length,
        continueCursor: String(next),
      };
    }
    const result = await listQuery(ctx, args).paginate(args.paginationOpts);
    const page = [];
    for (const t of result.page) page.push(await templateView(ctx, t, favorites.has(t._id)));
    return { ...result, page };
  },
});

export const get = query({
  args: { templateId: v.optional(v.id("templates")), slug: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const t = args.templateId
      ? await ctx.db.get("templates", args.templateId)
      : args.slug
        ? await ctx.db
            .query("templates")
            .withIndex("by_slug", (q) => q.eq("slug", args.slug as string))
            .unique()
        : null;
    if (t?.status !== "published") throw errors.notFound("Template");
    const user = await getUser(ctx);
    const favorites = await favoriteSet(ctx);
    const canUse =
      !t.premium || (user ? await hasFeature(ctx, user.userId, "templates.premium") : false);
    return { ...(await templateView(ctx, t, favorites.has(t._id))), canUse };
  },
});

/**
 * The template's Design JSON (for previews; instantiate to edit). Premium content is only handed to users
 * whose plan includes `templates.premium` (otherwise it could be imported, bypassing `instantiate`'s gate);
 * everyone else previews premium templates through their thumbnails.
 */
export const getDesign = query({
  args: { templateId: v.id("templates") },
  handler: async (ctx, args): Promise<{ design: string }> => {
    const t = await ctx.db.get("templates", args.templateId);
    if (t?.status !== "published") throw errors.notFound("Template");
    if (t.premium) {
      const user = await requireUser(ctx);
      if (!(await hasFeature(ctx, user.userId, "templates.premium"))) {
        throw errors.feature("templates.premium");
      }
    }
    return { design: await loadTemplateJson(ctx, t) };
  },
});

export const collections = query({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db
      .query("templateCollections")
      .withIndex("by_published_sort", (q) => q.eq("published", true))
      .collect();
    const out = [];
    for (const c of rows) {
      let coverUrl: string | null = c.coverKey ? await blobUrl(ctx, c.coverKey) : null;
      if (!coverUrl && c.templateIds[0]) {
        const first = await ctx.db.get("templates", c.templateIds[0]);
        const thumb = first?.thumbnails[0];
        if (thumb) coverUrl = await blobUrl(ctx, thumb.key);
      }
      out.push({
        id: c._id,
        slug: c.slug,
        title: c.title,
        description: c.description,
        count: c.templateIds.length,
        coverUrl,
      });
    }
    return out;
  },
});

/** Published categories with template counts (primary category). */
export const categories = query({
  args: {},
  handler: async (ctx) => {
    const counts = new Map<string, number>();
    const rows = ctx.db
      .query("templates")
      .withIndex("by_status_popularity", (q) => q.eq("status", "published"));
    for await (const t of rows) counts.set(t.category, (counts.get(t.category) ?? 0) + 1);
    return [...counts.entries()]
      .map(([category, count]) => ({ category, count }))
      .sort((a, b) => b.count - a.count || a.category.localeCompare(b.category));
  },
});

/** Create a design from a template in a workspace (fresh ids; premium templates need the plan). */
export const instantiate = mutation({
  args: {
    templateId: v.id("templates"),
    workspaceId: v.id("workspaces"),
    folderId: v.optional(v.id("folders")),
    name: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ designId: Id<"designs">; key: string }> =>
    await createDesignFor(ctx, {
      workspaceId: args.workspaceId,
      templateId: args.templateId,
      ...(args.folderId ? { folderId: args.folderId } : {}),
      ...(args.name !== undefined ? { name: args.name } : {}),
    }),
});

export const favorite = mutation({
  args: { templateId: v.id("templates"), favorite: v.boolean() },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const t = await ctx.db.get("templates", args.templateId);
    if (!t) throw errors.notFound("Template");
    const existing = await ctx.db
      .query("favorites")
      .withIndex("by_user_target", (q) =>
        q.eq("userId", user.userId).eq("targetType", "template").eq("targetId", t._id),
      )
      .unique();
    if (args.favorite && !existing) {
      await ctx.db.insert("favorites", {
        userId: user.userId,
        targetType: "template",
        targetId: t._id,
        createdAt: Date.now(),
      });
    } else if (!args.favorite && existing) {
      await ctx.db.delete("favorites", existing._id);
    }
    return { favorite: args.favorite };
  },
});

export const favorites = query({
  args: { paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const page = await ctx.db
      .query("favorites")
      .withIndex("by_user_type_created", (q) =>
        q.eq("userId", user.userId).eq("targetType", "template"),
      )
      .order("desc")
      .paginate(args.paginationOpts);
    const out = [];
    for (const row of page.page) {
      const t = await ctx.db.get("templates", row.targetId as Id<"templates">);
      if (t && t.status === "published") out.push(await templateView(ctx, t, true));
    }
    return { ...page, page: out };
  },
});
