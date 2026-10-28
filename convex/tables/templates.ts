import { defineTable } from "convex/server";
import { v } from "convex/values";

// Template library. The template's Design JSON is stored in `templateDesigns` chunks so mutations can
// instantiate it without an action. Owned by the designs agent.

export const templatesTables = {
  templates: defineTable({
    slug: v.string(),
    title: v.string(),
    description: v.string(),
    kind: v.string(),
    /** Primary category (filters, category pages). */
    category: v.string(),
    categories: v.array(v.string()),
    tags: v.array(v.string()),
    premium: v.boolean(),
    status: v.union(v.literal("published"), v.literal("draft")),
    /** Blob refs of thumbnails, first is the cover. */
    thumbnails: v.array(v.object({ key: v.string(), width: v.number(), height: v.number() })),
    pageCount: v.number(),
    width: v.number(),
    height: v.number(),
    popularity: v.number(),
    /** Title + description + categories + tags + kind + slot copy, lowercased (search index). */
    searchText: v.string(),
    designBytes: v.number(),
    designHash: v.string(),
    parts: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_slug", ["slug"])
    .index("by_status_popularity", ["status", "popularity"])
    .index("by_status_category_popularity", ["status", "category", "popularity"])
    .index("by_status_kind_popularity", ["status", "kind", "popularity"])
    .index("by_status_updated", ["status", "updatedAt"])
    .searchIndex("search_text", {
      searchField: "searchText",
      filterFields: ["status", "kind", "category", "premium"],
    }),

  /** Design JSON of a template, split into ordered parts (< 1 MB documents). */
  templateDesigns: defineTable({
    templateId: v.id("templates"),
    part: v.number(),
    json: v.string(),
  }).index("by_template_part", ["templateId", "part"]),

  templateCollections: defineTable({
    slug: v.string(),
    title: v.string(),
    description: v.string(),
    templateIds: v.array(v.id("templates")),
    coverKey: v.optional(v.string()),
    sort: v.number(),
    published: v.boolean(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_slug", ["slug"])
    .index("by_published_sort", ["published", "sort"]),

  /** Per-user favorites of templates and designs. */
  favorites: defineTable({
    userId: v.string(),
    targetType: v.union(v.literal("template"), v.literal("design")),
    targetId: v.string(),
    createdAt: v.number(),
  })
    .index("by_user_type_created", ["userId", "targetType", "createdAt"])
    .index("by_user_target", ["userId", "targetType", "targetId"])
    .index("by_target", ["targetType", "targetId"]),
};
