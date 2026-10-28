import { defineTable } from "convex/server";
import { v } from "convex/values";

// Brand kits. Owned by the designs agent.

export const brandColorValidator = v.object({
  id: v.string(),
  name: v.string(),
  /** Lowercase "#rrggbb" or "#rrggbbaa". */
  value: v.string(),
  role: v.optional(
    v.union(
      v.literal("primary"),
      v.literal("secondary"),
      v.literal("accent"),
      v.literal("background"),
      v.literal("surface"),
      v.literal("text"),
      v.literal("muted"),
      v.literal("success"),
      v.literal("warning"),
      v.literal("danger"),
      v.literal("other"),
    ),
  ),
});

export const brandFontValidator = v.object({
  family: v.string(),
  weight: v.number(),
  style: v.union(v.literal("normal"), v.literal("italic")),
  /** Custom font upload (assets row of kind "font"); absent for catalog (Google) fonts. */
  assetId: v.optional(v.id("assets")),
  fallback: v.optional(v.string()),
});

export const brandLogoValidator = v.object({
  id: v.string(),
  assetId: v.id("assets"),
  name: v.string(),
  variant: v.union(
    v.literal("primary"),
    v.literal("secondary"),
    v.literal("icon"),
    v.literal("wordmark"),
    v.literal("light"),
    v.literal("dark"),
    v.literal("other"),
  ),
});

export const brandVoiceValidator = v.object({
  tone: v.string(),
  description: v.string(),
  keywords: v.array(v.string()),
  avoid: v.array(v.string()),
  sampleCopy: v.optional(v.string()),
});

export const brandTables = {
  brandKits: defineTable({
    workspaceId: v.id("workspaces"),
    name: v.string(),
    logos: v.array(brandLogoValidator),
    colors: v.array(brandColorValidator),
    fonts: v.object({
      heading: v.optional(brandFontValidator),
      body: v.optional(brandFontValidator),
      accent: v.optional(brandFontValidator),
    }),
    voice: v.optional(brandVoiceValidator),
    rules: v.array(v.string()),
    guidelines: v.optional(v.string()),
    extractedFrom: v.optional(
      v.object({
        kind: v.union(v.literal("url"), v.literal("design"), v.literal("asset")),
        ref: v.string(),
      }),
    ),
    isDefault: v.boolean(),
    createdBy: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_workspace_updated", ["workspaceId", "updatedAt"]),
};
