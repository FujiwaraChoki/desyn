import type { AssetRef } from "@desyn/schema";
import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
} from "../_generated/server";
import { createKitFor, deleteKitFor, getKit, kitView, updateKitFor } from "../brand/brandKits";
import { designOf, idOf, type Principal, principalValidator } from "../lib/api_principal";
import { errors } from "../lib/errors";
import { requireMember } from "../lib/guards";
import { type brandFontValidator, brandVoiceValidator } from "../tables/brand";

// Agent API: brand kits (list / get / create / update / delete) and the brand kit as the AI applies it.

type DbCtx = QueryCtx | MutationCtx;

/** A brand kit of the principal's workspace. */
async function kitOf(ctx: DbCtx, principal: Principal, raw: string): Promise<Doc<"brandKits">> {
  const kit = await getKit(ctx, idOf(ctx, "brandKits", raw, "Brand kit"));
  if (kit.workspaceId !== principal.workspaceId) throw errors.notFound("Brand kit");
  return kit;
}

async function apiKitView(ctx: DbCtx, kit: Doc<"brandKits">) {
  const view = await kitView(ctx, kit);
  return {
    id: view.id,
    workspaceId: view.workspaceId,
    name: view.name,
    isDefault: view.isDefault,
    colors: view.colors,
    logos: view.logos,
    fonts: view.fonts,
    voice: view.voice,
    rules: view.rules,
    guidelines: view.guidelines,
    createdAt: view.createdAt,
    updatedAt: view.updatedAt,
  };
}

export const list = internalQuery({
  args: { principal: principalValidator },
  handler: async (ctx, args) => {
    await requireMember(ctx, args.principal.workspaceId, "viewer", {
      userId: args.principal.userId,
    });
    const kits = await ctx.db
      .query("brandKits")
      .withIndex("by_workspace_updated", (q) => q.eq("workspaceId", args.principal.workspaceId))
      .order("desc")
      .take(100);
    const items = [];
    for (const kit of kits) items.push(await apiKitView(ctx, kit));
    items.sort((a, b) => Number(b.isDefault) - Number(a.isDefault));
    return { items };
  },
});

export const get = internalQuery({
  args: { principal: principalValidator, brandKitId: v.string() },
  handler: async (ctx, args) => {
    const kit = await kitOf(ctx, args.principal, args.brandKitId);
    await requireMember(ctx, kit.workspaceId, "viewer", { userId: args.principal.userId });
    return await apiKitView(ctx, kit);
  },
});

const colorInput = v.object({
  id: v.optional(v.string()),
  name: v.string(),
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
const logoInput = v.object({
  id: v.optional(v.string()),
  assetId: v.string(),
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
const fontInput = v.object({
  family: v.string(),
  weight: v.number(),
  style: v.union(v.literal("normal"), v.literal("italic")),
  assetId: v.optional(v.string()),
  fallback: v.optional(v.string()),
});
const fields = {
  colors: v.optional(v.array(colorInput)),
  logos: v.optional(v.array(logoInput)),
  fonts: v.optional(
    v.object({
      heading: v.optional(fontInput),
      body: v.optional(fontInput),
      accent: v.optional(fontInput),
    }),
  ),
  voice: v.optional(v.union(brandVoiceValidator, v.null())),
  rules: v.optional(v.array(v.string())),
  guidelines: v.optional(v.union(v.string(), v.null())),
};

type LogoIn = {
  id?: string;
  assetId: string;
  name: string;
  variant: Doc<"brandKits">["logos"][number]["variant"];
};
type FontIn = {
  family: string;
  weight: number;
  style: "normal" | "italic";
  assetId?: string;
  fallback?: string;
};

/** Asset ids arrive as strings from JSON; malformed ids are rejected like unknown assets. */
function logosIn(ctx: DbCtx, logos: LogoIn[]) {
  return logos.map((l) => {
    const assetId = ctx.db.normalizeId("assets", l.assetId);
    if (!assetId) throw errors.invalid("Unknown asset.", "logos");
    return { ...l, assetId };
  });
}

function fontsIn(ctx: DbCtx, fonts: { heading?: FontIn; body?: FontIn; accent?: FontIn }) {
  const out: {
    heading?: typeof brandFontValidator.type;
    body?: typeof brandFontValidator.type;
    accent?: typeof brandFontValidator.type;
  } = {};
  for (const slot of ["heading", "body", "accent"] as const) {
    const font = fonts[slot];
    if (!font) continue;
    const { assetId: raw, ...rest } = font;
    let assetId: Id<"assets"> | undefined;
    if (raw !== undefined) {
      assetId = ctx.db.normalizeId("assets", raw) ?? undefined;
      if (!assetId) throw errors.invalid("Unknown asset.", "fonts");
    }
    out[slot] = { ...rest, ...(assetId ? { assetId } : {}) };
  }
  return out;
}

export const create = internalMutation({
  args: { principal: principalValidator, name: v.string(), ...fields },
  handler: async (ctx, args) => {
    const { principal, logos, fonts, ...rest } = args;
    const id = await createKitFor(
      ctx,
      {
        ...rest,
        workspaceId: principal.workspaceId,
        ...(logos ? { logos: logosIn(ctx, logos) } : {}),
        ...(fonts ? { fonts: fontsIn(ctx, fonts) } : {}),
      },
      { userId: principal.userId },
    );
    return await apiKitView(ctx, await getKit(ctx, id));
  },
});

export const update = internalMutation({
  args: {
    principal: principalValidator,
    brandKitId: v.string(),
    name: v.optional(v.string()),
    ...fields,
  },
  handler: async (ctx, args) => {
    const { principal, brandKitId, logos, fonts, ...rest } = args;
    const kit = await kitOf(ctx, principal, brandKitId);
    await updateKitFor(
      ctx,
      {
        ...rest,
        brandKitId: kit._id,
        ...(logos ? { logos: logosIn(ctx, logos) } : {}),
        ...(fonts ? { fonts: fontsIn(ctx, fonts) } : {}),
      },
      { userId: principal.userId },
    );
    return await apiKitView(ctx, await getKit(ctx, kit._id));
  },
});

export const remove = internalMutation({
  args: { principal: principalValidator, brandKitId: v.string() },
  handler: async (ctx, args): Promise<{ deleted: true }> => {
    const kit = await kitOf(ctx, args.principal, args.brandKitId);
    await deleteKitFor(ctx, { brandKitId: kit._id }, { userId: args.principal.userId });
    return { deleted: true };
  },
});

const COLOR_ROLE: Record<
  string,
  "primary" | "secondary" | "accent" | "background" | "surface" | "text" | "neutral"
> = {
  primary: "primary",
  secondary: "secondary",
  accent: "accent",
  background: "background",
  surface: "surface",
  text: "text",
  muted: "neutral",
};
const LOGO_VARIANT: Record<string, "primary" | "mark" | "wordmark" | "light" | "dark"> = {
  primary: "primary",
  icon: "mark",
  wordmark: "wordmark",
  light: "light",
  dark: "dark",
};

/**
 * The brand kit to apply to a design, in the shape @desyn/ai `brandOps` expects (logo asset ids are the
 * AssetRef ids), plus the AssetRefs of its logos so they can be added to the design. Requires edit access
 * to the design; `brandKitId` defaults to the design's kit, then the workspace default.
 */
export const forApply = internalQuery({
  args: { principal: principalValidator, designId: v.string(), brandKitId: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const design = await designOf(ctx, args.principal, args.designId);
    await requireMember(ctx, design.workspaceId, "editor", { userId: args.principal.userId });
    let kit: Doc<"brandKits"> | null = null;
    if (args.brandKitId) kit = await kitOf(ctx, args.principal, args.brandKitId);
    if (!kit) {
      const state = await ctx.db
        .query("designState")
        .withIndex("by_design", (q) => q.eq("designId", design._id))
        .unique();
      const own = state?.brandKitId ? ctx.db.normalizeId("brandKits", state.brandKitId) : null;
      const candidate = own ? await ctx.db.get("brandKits", own) : null;
      if (candidate?.workspaceId === design.workspaceId) kit = candidate;
    }
    if (!kit) {
      const kits = await ctx.db
        .query("brandKits")
        .withIndex("by_workspace_updated", (q) => q.eq("workspaceId", design.workspaceId))
        .take(100);
      kit = kits.find((k) => k.isDefault) ?? kits[0] ?? null;
    }
    if (!kit) throw errors.notFound("Brand kit");
    const logos = [];
    const logoRefs: AssetRef[] = [];
    for (const logo of kit.logos) {
      const asset = await ctx.db.get("assets", logo.assetId);
      if (asset?.status !== "ready") continue;
      const variant = LOGO_VARIANT[logo.variant];
      logos.push({
        assetId: asset.refId,
        name: logo.name,
        ...(variant ? { variant } : {}),
        ...(asset.width !== undefined ? { width: asset.width } : {}),
        ...(asset.height !== undefined ? { height: asset.height } : {}),
        mime: asset.mime,
      });
      logoRefs.push({
        id: asset.refId,
        kind: asset.kind,
        storageKey: asset.storageKey,
        mime: asset.mime,
        bytes: asset.bytes,
        ...(asset.width !== undefined ? { width: asset.width } : {}),
        ...(asset.height !== undefined ? { height: asset.height } : {}),
        ...(asset.hash !== undefined ? { hash: asset.hash } : {}),
        name: asset.name,
        source: "brand",
      });
    }
    const fonts = [];
    for (const role of ["heading", "body", "accent"] as const) {
      const f = kit.fonts[role];
      if (f) fonts.push({ family: f.family, role, weight: f.weight });
    }
    return {
      brandKitId: kit._id,
      kit: {
        id: kit._id,
        name: kit.name,
        colors: kit.colors.map((c) => {
          const role = c.role ? COLOR_ROLE[c.role] : undefined;
          return { value: c.value, name: c.name, ...(role ? { role } : {}) };
        }),
        fonts,
        logos,
        ...(kit.voice ? { voice: `${kit.voice.tone}. ${kit.voice.description}`.trim() } : {}),
        rules: kit.rules,
        ...(kit.guidelines ? { guidelines: kit.guidelines } : {}),
      },
      logoRefs,
    };
  },
});
