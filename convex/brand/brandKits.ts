import { newId } from "@desyn/schema";
import { type Infer, v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { type MutationCtx, mutation, type QueryCtx, query } from "../_generated/server";
import { signAssetKey } from "../lib/designs_assets";
import { s3Config } from "../lib/designs_s3";
import { assertFeature, assertLimit } from "../lib/entitlements";
import { errors } from "../lib/errors";
import { requireMember } from "../lib/guards";
import { incrementUsage } from "../lib/usage";
import { brandFontValidator, brandVoiceValidator } from "../tables/brand";

// brandKits.* : brand kits per workspace (logos as assets, named colors with roles, heading/body/accent
// fonts incl. custom font uploads, voice and rules). Creating kits needs the `brandKit` feature and counts
// toward the creator's `brandKits` limit.

type DbCtx = QueryCtx | MutationCtx;

const COLOR = /^#(?:[0-9a-f]{6}|[0-9a-f]{8})$/;
const colorRoles = v.union(
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
);
const colorInput = v.object({
  id: v.optional(v.string()),
  name: v.string(),
  value: v.string(),
  role: v.optional(colorRoles),
});
const logoInput = v.object({
  id: v.optional(v.string()),
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
const fontsInput = v.object({
  heading: v.optional(brandFontValidator),
  body: v.optional(brandFontValidator),
  accent: v.optional(brandFontValidator),
});

type ColorInput = Infer<typeof colorInput>;
type LogoInput = Infer<typeof logoInput>;
type FontsInput = Infer<typeof fontsInput>;
type VoiceInput = Infer<typeof brandVoiceValidator>;

function text(value: string, field: string, max: number, min = 0): string {
  const t = value.trim();
  if (t.length < min || t.length > max)
    throw errors.invalid(`${field} must be ${min} to ${max} characters.`, field);
  return t;
}

function normalizeColors(colors: ColorInput[]): Doc<"brandKits">["colors"] {
  if (colors.length > 64) throw errors.invalid("A brand kit can have at most 64 colors.", "colors");
  return colors.map((c) => {
    const value = c.value.trim().toLowerCase();
    if (!COLOR.test(value)) throw errors.invalid(`"${c.value}" is not a #rrggbb color.`, "colors");
    return {
      id: c.id && /^[a-z0-9]{12}$/.test(c.id) ? c.id : newId(),
      name: text(c.name, "Color name", 60, 1),
      value,
      ...(c.role ? { role: c.role } : {}),
    };
  });
}

async function readyAsset(
  ctx: DbCtx,
  workspaceId: Id<"workspaces">,
  assetId: Id<"assets">,
  kinds: readonly string[],
): Promise<Doc<"assets">> {
  const asset = await ctx.db.get("assets", assetId);
  if (asset?.status !== "ready" || !kinds.includes(asset.kind))
    throw errors.invalid("Unknown asset.", "assetId");
  if (asset.workspaceId !== undefined && asset.workspaceId !== workspaceId)
    throw errors.invalid("Unknown asset.", "assetId");
  return asset;
}

async function normalizeLogos(
  ctx: DbCtx,
  workspaceId: Id<"workspaces">,
  logos: LogoInput[],
): Promise<Doc<"brandKits">["logos"]> {
  if (logos.length > 20) throw errors.invalid("A brand kit can have at most 20 logos.", "logos");
  const out = [];
  for (const logo of logos) {
    await readyAsset(ctx, workspaceId, logo.assetId, ["image", "svg"]);
    out.push({
      id: logo.id && /^[a-z0-9]{12}$/.test(logo.id) ? logo.id : newId(),
      assetId: logo.assetId,
      name: text(logo.name, "Logo name", 60, 1),
      variant: logo.variant,
    });
  }
  return out;
}

async function normalizeFonts(
  ctx: DbCtx,
  workspaceId: Id<"workspaces">,
  userId: string,
  fonts: FontsInput,
): Promise<Doc<"brandKits">["fonts"]> {
  const out: Doc<"brandKits">["fonts"] = {};
  for (const slot of ["heading", "body", "accent"] as const) {
    const font = fonts[slot];
    if (!font) continue;
    if (!(font.weight >= 1 && font.weight <= 1000))
      throw errors.invalid("Font weight must be 1 to 1000.", "fonts");
    if (font.assetId) {
      await assertFeature(ctx, userId, "fonts.custom");
      await readyAsset(ctx, workspaceId, font.assetId, ["font"]);
    }
    out[slot] = {
      family: text(font.family, "Font family", 100, 1),
      weight: Math.round(font.weight),
      style: font.style,
      ...(font.assetId ? { assetId: font.assetId } : {}),
      ...(font.fallback ? { fallback: text(font.fallback, "Fallback", 200) } : {}),
    };
  }
  return out;
}

function normalizeVoice(voice: VoiceInput): VoiceInput {
  const list = (items: string[], field: string) => {
    if (items.length > 30) throw errors.invalid(`At most 30 ${field}.`, field);
    return items.map((i) => text(i, field, 80, 1));
  };
  return {
    tone: text(voice.tone, "Tone", 200),
    description: text(voice.description, "Voice description", 4_000),
    keywords: list(voice.keywords, "keywords"),
    avoid: list(voice.avoid, "avoid"),
    ...(voice.sampleCopy ? { sampleCopy: text(voice.sampleCopy, "Sample copy", 4_000) } : {}),
  };
}

function normalizeRules(rules: string[]): string[] {
  if (rules.length > 50) throw errors.invalid("At most 50 rules.", "rules");
  return rules.map((r) => text(r, "Rule", 500, 1));
}

export async function kitView(ctx: DbCtx, kit: Doc<"brandKits">) {
  const cfg = s3Config();
  const now = Date.now();
  const logos = [];
  for (const logo of kit.logos) {
    const asset = await ctx.db.get("assets", logo.assetId);
    logos.push({
      ...logo,
      refId: asset?.refId ?? null,
      mime: asset?.mime ?? null,
      width: asset?.width ?? null,
      height: asset?.height ?? null,
      url: asset && cfg && !asset.purgedAt ? signAssetKey(cfg, asset.storageKey, now) : null,
    });
  }
  const fonts: Record<string, unknown> = {};
  for (const slot of ["heading", "body", "accent"] as const) {
    const font = kit.fonts[slot];
    if (!font) continue;
    const asset = font.assetId ? await ctx.db.get("assets", font.assetId) : null;
    fonts[slot] = {
      ...font,
      url: asset && cfg && !asset.purgedAt ? signAssetKey(cfg, asset.storageKey, now) : null,
      refId: asset?.refId ?? null,
    };
  }
  return {
    id: kit._id,
    workspaceId: kit.workspaceId,
    name: kit.name,
    logos,
    colors: kit.colors,
    fonts: fonts as {
      heading?: Doc<"brandKits">["fonts"]["heading"] & { url: string | null; refId: string | null };
      body?: Doc<"brandKits">["fonts"]["body"] & { url: string | null; refId: string | null };
      accent?: Doc<"brandKits">["fonts"]["accent"] & { url: string | null; refId: string | null };
    },
    voice: kit.voice ?? null,
    rules: kit.rules,
    guidelines: kit.guidelines ?? null,
    extractedFrom: kit.extractedFrom ?? null,
    isDefault: kit.isDefault,
    createdBy: kit.createdBy,
    createdAt: kit.createdAt,
    updatedAt: kit.updatedAt,
  };
}

export async function getKit(ctx: DbCtx, brandKitId: Id<"brandKits">): Promise<Doc<"brandKits">> {
  const kit = await ctx.db.get("brandKits", brandKitId);
  if (!kit) throw errors.notFound("Brand kit");
  return kit;
}

export const list = query({
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, args) => {
    await requireMember(ctx, args.workspaceId, "viewer");
    const kits = await ctx.db
      .query("brandKits")
      .withIndex("by_workspace_updated", (q) => q.eq("workspaceId", args.workspaceId))
      .order("desc")
      .take(100);
    const out = [];
    for (const kit of kits) out.push(await kitView(ctx, kit));
    return out.sort((a, b) => Number(b.isDefault) - Number(a.isDefault));
  },
});

export const get = query({
  args: { brandKitId: v.id("brandKits") },
  handler: async (ctx, args) => {
    const kit = await getKit(ctx, args.brandKitId);
    await requireMember(ctx, kit.workspaceId, "viewer");
    return await kitView(ctx, kit);
  },
});

const optionalFields = {
  colors: v.optional(v.array(colorInput)),
  logos: v.optional(v.array(logoInput)),
  fonts: v.optional(fontsInput),
  voice: v.optional(v.union(brandVoiceValidator, v.null())),
  rules: v.optional(v.array(v.string())),
  guidelines: v.optional(v.union(v.string(), v.null())),
};

const createArgs = {
  workspaceId: v.id("workspaces"),
  name: v.string(),
  ...optionalFields,
  extractedFrom: v.optional(
    v.object({
      kind: v.union(v.literal("url"), v.literal("design"), v.literal("asset")),
      ref: v.string(),
    }),
  ),
};
const createValidator = v.object(createArgs);

/** Create a brand kit. `opts.userId` is a trusted caller-verified user (Agent API after API-key verification). */
export async function createKitFor(
  ctx: MutationCtx,
  args: Infer<typeof createValidator>,
  opts: { userId?: string } = {},
): Promise<Id<"brandKits">> {
  const member = await requireMember(ctx, args.workspaceId, "editor", opts);
  await assertFeature(ctx, member.userId, "brandKit");
  await assertLimit(ctx, member.userId, "brandKits");
  const existing = await ctx.db
    .query("brandKits")
    .withIndex("by_workspace_updated", (q) => q.eq("workspaceId", args.workspaceId))
    .first();
  const now = Date.now();
  const id = await ctx.db.insert("brandKits", {
    workspaceId: args.workspaceId,
    name: text(args.name, "Name", 100, 1),
    logos: await normalizeLogos(ctx, args.workspaceId, args.logos ?? []),
    colors: normalizeColors(args.colors ?? []),
    fonts: await normalizeFonts(ctx, args.workspaceId, member.userId, args.fonts ?? {}),
    ...(args.voice ? { voice: normalizeVoice(args.voice) } : {}),
    rules: normalizeRules(args.rules ?? []),
    ...(args.guidelines ? { guidelines: text(args.guidelines, "Guidelines", 20_000) } : {}),
    ...(args.extractedFrom
      ? { extractedFrom: { ...args.extractedFrom, ref: args.extractedFrom.ref.slice(0, 500) } }
      : {}),
    isDefault: existing === null,
    createdBy: member.userId,
    createdAt: now,
    updatedAt: now,
  });
  await incrementUsage(ctx, member.userId, "brandKits", 1);
  return id;
}

export const create = mutation({
  args: createArgs,
  handler: async (ctx, args): Promise<Id<"brandKits">> => await createKitFor(ctx, args),
});

const updateArgs = {
  brandKitId: v.id("brandKits"),
  name: v.optional(v.string()),
  ...optionalFields,
};
const updateValidator = v.object(updateArgs);

/** Update a brand kit. `opts.userId` is a trusted caller-verified user (Agent API after API-key verification). */
export async function updateKitFor(
  ctx: MutationCtx,
  args: Infer<typeof updateValidator>,
  opts: { userId?: string } = {},
): Promise<null> {
  const kit = await getKit(ctx, args.brandKitId);
  const member = await requireMember(ctx, kit.workspaceId, "editor", opts);
  const patch: Partial<Doc<"brandKits">> = { updatedAt: Date.now() };
  if (args.name !== undefined) patch.name = text(args.name, "Name", 100, 1);
  if (args.colors !== undefined) patch.colors = normalizeColors(args.colors);
  if (args.logos !== undefined)
    patch.logos = await normalizeLogos(ctx, kit.workspaceId, args.logos);
  if (args.fonts !== undefined)
    patch.fonts = await normalizeFonts(ctx, kit.workspaceId, member.userId, args.fonts);
  if (args.voice !== undefined)
    patch.voice = args.voice === null ? undefined : normalizeVoice(args.voice);
  if (args.rules !== undefined) patch.rules = normalizeRules(args.rules);
  if (args.guidelines !== undefined) {
    patch.guidelines =
      args.guidelines === null ? undefined : text(args.guidelines, "Guidelines", 20_000);
  }
  await ctx.db.patch("brandKits", kit._id, patch);
  return null;
}

export const update = mutation({
  args: updateArgs,
  handler: async (ctx, args): Promise<null> => await updateKitFor(ctx, args),
});

export const setDefault = mutation({
  args: { brandKitId: v.id("brandKits") },
  handler: async (ctx, args) => {
    const kit = await getKit(ctx, args.brandKitId);
    await requireMember(ctx, kit.workspaceId, "editor");
    const kits = await ctx.db
      .query("brandKits")
      .withIndex("by_workspace_updated", (q) => q.eq("workspaceId", kit.workspaceId))
      .collect();
    for (const other of kits) {
      const shouldBe = other._id === kit._id;
      if (other.isDefault !== shouldBe)
        await ctx.db.patch("brandKits", other._id, { isDefault: shouldBe });
    }
    return null;
  },
});

export const duplicate = mutation({
  args: { brandKitId: v.id("brandKits"), name: v.optional(v.string()) },
  handler: async (ctx, args): Promise<Id<"brandKits">> => {
    const kit = await getKit(ctx, args.brandKitId);
    const member = await requireMember(ctx, kit.workspaceId, "editor");
    await assertFeature(ctx, member.userId, "brandKit");
    await assertLimit(ctx, member.userId, "brandKits");
    const now = Date.now();
    const { _id, _creationTime, ...fields } = kit;
    const id = await ctx.db.insert("brandKits", {
      ...fields,
      name: args.name ? text(args.name, "Name", 100, 1) : `${kit.name} (copy)`.slice(0, 100),
      isDefault: false,
      createdBy: member.userId,
      createdAt: now,
      updatedAt: now,
    });
    await incrementUsage(ctx, member.userId, "brandKits", 1);
    return id;
  },
});

/** Delete a brand kit. `opts.userId` is a trusted caller-verified user (Agent API after API-key verification). */
export async function deleteKitFor(
  ctx: MutationCtx,
  args: { brandKitId: Id<"brandKits"> },
  opts: { userId?: string } = {},
): Promise<null> {
  const kit = await getKit(ctx, args.brandKitId);
  await requireMember(ctx, kit.workspaceId, "editor", opts);
  await ctx.db.delete("brandKits", kit._id);
  await incrementUsage(ctx, kit.createdBy, "brandKits", -1);
  if (kit.isDefault) {
    const next = await ctx.db
      .query("brandKits")
      .withIndex("by_workspace_updated", (q) => q.eq("workspaceId", kit.workspaceId))
      .order("desc")
      .first();
    if (next) await ctx.db.patch("brandKits", next._id, { isDefault: true });
  }
  return null;
}

const remove = mutation({
  args: { brandKitId: v.id("brandKits") },
  handler: async (ctx, args) => await deleteKitFor(ctx, args),
});

export { remove as delete };
