import {
  canonicalize,
  type Design,
  isDesignKind,
  newId,
  sha256Hex,
  validateDesign,
} from "@desyn/schema";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { action, internalMutation, internalQuery, type MutationCtx } from "../_generated/server";
import { scheduleBlobDeletion } from "../designs/maintenance";
import { timingSafeEqual } from "../lib/crypto";
import { TEMPLATE_PREFIX } from "../lib/designs_assets";
import { putBlob } from "../lib/designs_blob";
import { firstPageSize, pageCountOf } from "../lib/designs_doc";
import { s3Config, s3Request } from "../lib/designs_s3";
import { SvgSanitizeError, sanitizeNodesMarkup } from "../lib/designs_svg";
import { splitJson } from "../lib/designs_templates";
import {
  inspectUpload,
  kindForMime,
  needsFullContent,
  normalizeMime,
  safeFileName,
} from "../lib/designs_upload";
import { env } from "../lib/env";
import { errors } from "../lib/errors";
import { requireAdmin } from "../lib/guards";

// Template library administration, used by the templates pipeline (templates/): an internal upsert mutation
// and an authenticated action that accepts a whole template bundle (design JSON + asset bytes + thumbnails).
// Authentication: a signed-in admin, or the pipeline token `TEMPLATES_PIPELINE_SECRET`.

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const bundleFields = {
  slug: v.string(),
  title: v.string(),
  description: v.string(),
  kind: v.string(),
  category: v.string(),
  categories: v.array(v.string()),
  tags: v.array(v.string()),
  premium: v.boolean(),
  status: v.optional(v.union(v.literal("published"), v.literal("draft"))),
  popularity: v.optional(v.number()),
  /** Collection slugs this template belongs to (created when missing). */
  collections: v.optional(v.array(v.string())),
};

/** Text of every text run / table cell, so prompts like "bakery menu with prices" find templates. */
function slotText(design: Design): string {
  const parts: string[] = [];
  for (const node of Object.values(design.nodes)) {
    if (node.type === "text") parts.push(node.runs.map((r) => r.text).join(""));
    else if (node.type === "table") parts.push(node.cells.map((c) => c.text).join(" "));
    if (node.role) parts.push(node.role);
    const slot = (node.meta as { slot?: unknown } | undefined)?.slot;
    if (typeof slot === "string") parts.push(slot);
  }
  return parts.join(" ");
}

function titleFromSlug(slug: string): string {
  return slug
    .split("-")
    .map((w) => (w ? w[0]?.toUpperCase() + w.slice(1) : w))
    .join(" ");
}

async function addToCollection(
  ctx: MutationCtx,
  slug: string,
  templateId: Id<"templates">,
): Promise<void> {
  const now = Date.now();
  const existing = await ctx.db
    .query("templateCollections")
    .withIndex("by_slug", (q) => q.eq("slug", slug))
    .unique();
  if (existing) {
    if (!existing.templateIds.includes(templateId)) {
      await ctx.db.patch("templateCollections", existing._id, {
        templateIds: [...existing.templateIds, templateId],
        updatedAt: now,
      });
    }
    return;
  }
  await ctx.db.insert("templateCollections", {
    slug,
    title: titleFromSlug(slug),
    description: "",
    templateIds: [templateId],
    sort: 1_000,
    published: true,
    createdAt: now,
    updatedAt: now,
  });
}

/** Insert or update a template by slug (design JSON validated with validateDesign). */
export const upsert = internalMutation({
  args: {
    ...bundleFields,
    design: v.string(),
    thumbnails: v.array(v.object({ key: v.string(), width: v.number(), height: v.number() })),
  },
  handler: async (ctx, args): Promise<{ templateId: Id<"templates">; created: boolean }> => {
    if (!SLUG.test(args.slug) || args.slug.length > 120)
      throw errors.invalid("Invalid template slug.", "slug");
    if (!isDesignKind(args.kind))
      throw errors.invalid(`Unknown design kind "${args.kind}".`, "kind");
    let design: Design;
    try {
      design = JSON.parse(args.design) as Design;
    } catch {
      throw errors.invalid("The template design is not valid JSON.", "design");
    }
    const validation = validateDesign(design);
    if (!validation.ok) {
      const first = validation.errors[0];
      throw errors.invalid(
        `The template design is not valid: ${first ? `${first.path.join(".")}: ${first.message}` : "unknown error"}`,
        "design",
      );
    }
    // Templates are served publicly and copied into user designs: inline markup is sanitized like commits.
    try {
      design = { ...design, nodes: sanitizeNodesMarkup(design.nodes) };
    } catch (err) {
      if (err instanceof SvgSanitizeError) throw errors.invalid(err.message, "design");
      throw err;
    }
    const now = Date.now();
    const json = JSON.stringify(design);
    const parts = splitJson(json);
    const size = firstPageSize(design);
    const categories = [
      ...new Set([args.category, ...args.categories].map((c) => c.trim().toLowerCase())),
    ].filter(Boolean);
    const tags = [...new Set(args.tags.map((t) => t.trim().toLowerCase()))].filter(Boolean);
    const searchText = [
      args.title,
      args.description,
      args.kind,
      ...categories,
      ...tags,
      slotText(design),
    ]
      .join(" ")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .slice(0, 30_000);
    const fields = {
      slug: args.slug,
      title: args.title.trim().slice(0, 200),
      description: args.description.trim().slice(0, 2_000),
      kind: args.kind,
      category: args.category.trim().toLowerCase(),
      categories,
      tags,
      premium: args.premium,
      status: args.status ?? ("published" as const),
      thumbnails: args.thumbnails,
      pageCount: pageCountOf(design),
      width: size.width,
      height: size.height,
      searchText,
      designBytes: json.length,
      designHash: sha256Hex(canonicalize(design)),
      parts: parts.length,
      updatedAt: now,
    };
    const existing = await ctx.db
      .query("templates")
      .withIndex("by_slug", (q) => q.eq("slug", args.slug))
      .unique();
    let templateId: Id<"templates">;
    if (existing) {
      const oldThumbs = existing.thumbnails
        .map((t) => t.key)
        .filter((k) => !args.thumbnails.some((t) => t.key === k));
      await ctx.db.patch("templates", existing._id, {
        ...fields,
        popularity: args.popularity ?? existing.popularity,
      });
      templateId = existing._id;
      for (const row of await ctx.db
        .query("templateDesigns")
        .withIndex("by_template_part", (q) => q.eq("templateId", templateId))
        .collect()) {
        await ctx.db.delete("templateDesigns", row._id);
      }
      await scheduleBlobDeletion(ctx, oldThumbs);
    } else {
      templateId = await ctx.db.insert("templates", {
        ...fields,
        popularity: args.popularity ?? 0,
        createdAt: now,
      });
    }
    for (const [part, chunk] of parts.entries()) {
      await ctx.db.insert("templateDesigns", { templateId, part, json: chunk });
    }
    for (const slug of args.collections ?? []) {
      if (SLUG.test(slug)) await addToCollection(ctx, slug, templateId);
    }
    return { templateId, created: !existing };
  },
});

export const upsertCollection = internalMutation({
  args: {
    slug: v.string(),
    title: v.string(),
    description: v.string(),
    templateSlugs: v.array(v.string()),
    sort: v.number(),
    published: v.boolean(),
    coverKey: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<Id<"templateCollections">> => {
    if (!SLUG.test(args.slug)) throw errors.invalid("Invalid collection slug.", "slug");
    const templateIds: Id<"templates">[] = [];
    for (const slug of args.templateSlugs) {
      const t = await ctx.db
        .query("templates")
        .withIndex("by_slug", (q) => q.eq("slug", slug))
        .unique();
      if (t) templateIds.push(t._id);
    }
    const now = Date.now();
    const fields = {
      slug: args.slug,
      title: args.title,
      description: args.description,
      templateIds,
      sort: args.sort,
      published: args.published,
      ...(args.coverKey ? { coverKey: args.coverKey } : {}),
      updatedAt: now,
    };
    const existing = await ctx.db
      .query("templateCollections")
      .withIndex("by_slug", (q) => q.eq("slug", args.slug))
      .unique();
    if (existing) {
      await ctx.db.patch("templateCollections", existing._id, fields);
      return existing._id;
    }
    return await ctx.db.insert("templateCollections", { ...fields, createdAt: now });
  },
});

export const remove = internalMutation({
  args: { slug: v.string() },
  handler: async (ctx, args) => {
    const t = await ctx.db
      .query("templates")
      .withIndex("by_slug", (q) => q.eq("slug", args.slug))
      .unique();
    if (!t) return { removed: false };
    for (const row of await ctx.db
      .query("templateDesigns")
      .withIndex("by_template_part", (q) => q.eq("templateId", t._id))
      .collect()) {
      await ctx.db.delete("templateDesigns", row._id);
    }
    for (const c of await ctx.db.query("templateCollections").collect()) {
      if (c.templateIds.includes(t._id)) {
        await ctx.db.patch("templateCollections", c._id, {
          templateIds: c.templateIds.filter((id) => id !== t._id),
        });
      }
    }
    await scheduleBlobDeletion(
      ctx,
      t.thumbnails.map((th) => th.key),
    );
    await ctx.db.delete("templates", t._id);
    return { removed: true };
  },
});

/** Register a library asset (no workspace) so designs made from templates can resolve it. */
export const upsertSystemAsset = internalMutation({
  args: {
    refId: v.string(),
    name: v.string(),
    mime: v.string(),
    kind: v.union(
      v.literal("image"),
      v.literal("svg"),
      v.literal("font"),
      v.literal("video"),
      v.literal("audio"),
      v.literal("lottie"),
      v.literal("data"),
    ),
    bytes: v.number(),
    hash: v.string(),
    storageKey: v.string(),
    width: v.optional(v.number()),
    height: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const existing = await ctx.db
      .query("assets")
      .withIndex("by_workspace_refId", (q) =>
        q.eq("workspaceId", undefined).eq("refId", args.refId),
      )
      .first();
    const fields = {
      ...args,
      status: "ready" as const,
      source: "template" as const,
      updatedAt: now,
    };
    if (existing) await ctx.db.patch("assets", existing._id, fields);
    else
      await ctx.db.insert("assets", { ...fields, ownerId: "system", createdAt: now, readyAt: now });
    return null;
  },
});

export const assertAdmin = internalQuery({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);
    return true;
  },
});

/**
 * Publish a template bundle. Asset bytes are validated (SVG sanitized), stored under `templates/<slug>/` and
 * their AssetRefs rewritten to point at the stored keys; thumbnails are stored as blobs.
 */
export const publish = action({
  args: {
    ...bundleFields,
    design: v.string(),
    /** Pipeline token (TEMPLATES_PIPELINE_SECRET); not needed for signed-in admins. */
    token: v.optional(v.string()),
    assets: v.optional(
      v.array(v.object({ refId: v.string(), name: v.string(), mime: v.string(), data: v.bytes() })),
    ),
    thumbnails: v.optional(
      v.array(
        v.object({ width: v.number(), height: v.number(), mime: v.string(), data: v.bytes() }),
      ),
    ),
  },
  handler: async (ctx, args): Promise<{ templateId: Id<"templates">; created: boolean }> => {
    const secret = env.get("TEMPLATES_PIPELINE_SECRET");
    if (!(args.token && secret && timingSafeEqual(args.token, secret))) {
      await ctx.runQuery(internal.templates.admin.assertAdmin, {});
    }
    if (!SLUG.test(args.slug)) throw errors.invalid("Invalid template slug.", "slug");
    let design: Design;
    try {
      design = JSON.parse(args.design) as Design;
    } catch {
      throw errors.invalid("The template design is not valid JSON.", "design");
    }
    const uploads = args.assets ?? [];
    if (uploads.length > 0 && !s3Config()) throw errors.notConfigured("File storage (S3)");
    const cfg = s3Config();
    for (const upload of uploads) {
      const asset = design.assets[upload.refId];
      if (!asset)
        throw errors.invalid(`Asset ${upload.refId} is not referenced by the design.`, "assets");
      const mime = normalizeMime(upload.mime);
      const kind = kindForMime(mime);
      if (!kind || !cfg) throw errors.invalid(`Unsupported asset type ${upload.mime}.`, "assets");
      let bytes = new Uint8Array(upload.data);
      const inspected = inspectUpload(
        kind,
        mime,
        bytes.subarray(0, 512 * 1024),
        needsFullContent(kind) ? bytes : undefined,
      );
      if (inspected.rewritten) bytes = new Uint8Array(inspected.rewritten);
      const key = `${TEMPLATE_PREFIX}${args.slug}/${upload.refId}-${safeFileName(upload.name)}`;
      const put = await s3Request(cfg, {
        method: "PUT",
        key,
        body: bytes,
        headers: { "content-type": mime },
      });
      if (!put.ok) throw new Error(`S3 PUT failed with status ${put.status}`);
      const hash = sha256HexBytes(bytes);
      design.assets[upload.refId] = {
        ...asset,
        storageKey: key,
        mime,
        bytes: bytes.length,
        hash,
        source: "template",
        ...(inspected.width !== undefined ? { width: inspected.width } : {}),
        ...(inspected.height !== undefined ? { height: inspected.height } : {}),
      };
      await ctx.runMutation(internal.templates.admin.upsertSystemAsset, {
        refId: upload.refId,
        name: upload.name.slice(0, 200),
        mime,
        kind,
        bytes: bytes.length,
        hash,
        storageKey: key,
        ...(inspected.width !== undefined ? { width: inspected.width } : {}),
        ...(inspected.height !== undefined ? { height: inspected.height } : {}),
      });
    }
    const thumbnails = [];
    for (const [i, thumb] of (args.thumbnails ?? []).entries()) {
      const mime = normalizeMime(thumb.mime);
      if (!mime.startsWith("image/"))
        throw errors.invalid("Thumbnails must be images.", "thumbnails");
      const ext = mime === "image/webp" ? "webp" : mime === "image/png" ? "png" : "jpg";
      const key = await putBlob(
        ctx,
        `${TEMPLATE_PREFIX}${args.slug}/thumb-${i}-${newId()}.${ext}`,
        new Uint8Array(thumb.data),
        mime,
      );
      thumbnails.push({ key, width: thumb.width, height: thumb.height });
    }
    const {
      token: _token,
      assets: _assets,
      thumbnails: _thumbs,
      design: _design,
      ...bundle
    } = args;
    return await ctx.runMutation(internal.templates.admin.upsert, {
      ...bundle,
      design: JSON.stringify(design),
      thumbnails,
    });
  },
});

function sha256HexBytes(bytes: Uint8Array): string {
  return bytesToHex(sha256(bytes));
}
