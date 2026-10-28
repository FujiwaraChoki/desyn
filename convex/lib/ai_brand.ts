import type { BrandColorRole, BrandKit, BrandLogoVariant } from "@desyn/ai";
import type { AssetRef } from "@desyn/schema";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

// Brand kits as the AI sees them (@desyn/ai BrandKit): logo asset ids become the AssetRef ids designs use,
// and the AssetRefs of the logos are returned so the agent can place them.

type DbCtx = QueryCtx | MutationCtx;

const COLOR_ROLE: Partial<
  Record<NonNullable<Doc<"brandKits">["colors"][number]["role"]>, BrandColorRole>
> = {
  primary: "primary",
  secondary: "secondary",
  accent: "accent",
  background: "background",
  surface: "surface",
  text: "text",
  muted: "neutral",
};

const LOGO_VARIANT: Partial<
  Record<Doc<"brandKits">["logos"][number]["variant"], BrandLogoVariant>
> = {
  primary: "primary",
  icon: "mark",
  wordmark: "wordmark",
  light: "light",
  dark: "dark",
};

/** The design's brand kit, else the workspace default kit, else none. */
export async function brandKitForDesign(
  ctx: DbCtx,
  design: Pick<Doc<"designs">, "_id" | "workspaceId">,
): Promise<Doc<"brandKits"> | null> {
  const state = await ctx.db
    .query("designState")
    .withIndex("by_design", (q) => q.eq("designId", design._id))
    .unique();
  const own = state?.brandKitId ? ctx.db.normalizeId("brandKits", state.brandKitId) : null;
  const kit = own ? await ctx.db.get("brandKits", own) : null;
  if (kit && kit.workspaceId === design.workspaceId) return kit;
  return await defaultBrandKit(ctx, design.workspaceId);
}

export async function defaultBrandKit(
  ctx: DbCtx,
  workspaceId: Id<"workspaces">,
): Promise<Doc<"brandKits"> | null> {
  const kits = await ctx.db
    .query("brandKits")
    .withIndex("by_workspace_updated", (q) => q.eq("workspaceId", workspaceId))
    .order("desc")
    .take(100);
  return kits.find((k) => k.isDefault) ?? null;
}

export async function aiBrandKit(
  ctx: DbCtx,
  kit: Doc<"brandKits">,
): Promise<{ kit: BrandKit; logoRefs: AssetRef[] }> {
  const logos: BrandKit["logos"] = [];
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
    logoRefs.push(assetRefOf(asset, "brand"));
  }
  const fonts: BrandKit["fonts"] = [];
  for (const role of ["heading", "body", "accent"] as const) {
    const f = kit.fonts[role];
    if (f) fonts.push({ family: f.family, role, weight: f.weight });
  }
  const voice = kit.voice
    ? [
        kit.voice.tone,
        kit.voice.description,
        kit.voice.keywords.length ? `Keywords: ${kit.voice.keywords.join(", ")}` : "",
        kit.voice.avoid.length ? `Avoid: ${kit.voice.avoid.join(", ")}` : "",
      ]
        .filter(Boolean)
        .join(". ")
    : undefined;
  return {
    kit: {
      id: kit._id,
      name: kit.name,
      colors: kit.colors.map((c) => {
        const role = c.role ? COLOR_ROLE[c.role] : undefined;
        return { value: c.value, name: c.name, ...(role ? { role } : {}) };
      }),
      fonts,
      logos,
      ...(voice ? { voice } : {}),
      rules: kit.rules,
      ...(kit.guidelines ? { guidelines: kit.guidelines } : {}),
    },
    logoRefs,
  };
}

/** The AssetRef a design uses for a stored asset (never with a URL; clients resolve those). */
export function assetRefOf(asset: Doc<"assets">, source?: AssetRef["source"]): AssetRef {
  return {
    id: asset.refId,
    kind: asset.kind,
    mime: asset.mime,
    storageKey: asset.storageKey,
    bytes: asset.bytes,
    ...(asset.width !== undefined ? { width: asset.width } : {}),
    ...(asset.height !== undefined ? { height: asset.height } : {}),
    ...(asset.durationMs !== undefined ? { durationMs: asset.durationMs } : {}),
    ...(asset.hash !== undefined ? { hash: asset.hash } : {}),
    name: asset.name,
    source: source ?? (asset.source as AssetRef["source"]),
    ...(asset.ai ? { ai: asset.ai } : {}),
    ...(asset.attribution ? { attribution: asset.attribution } : {}),
    ...(asset.family ? { family: asset.family } : {}),
    ...(asset.weight !== undefined ? { weight: asset.weight } : {}),
    ...(asset.style ? { style: asset.style } : {}),
  };
}
