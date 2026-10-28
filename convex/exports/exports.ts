import { type Infer, v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { internalMutation, type MutationCtx, mutation, query } from "../_generated/server";
import { scheduleBlobDeletion } from "../designs/maintenance";
import { enqueueEmail } from "../emails/queue";
import {
  getDesignOrThrow,
  requireDesignPermission,
  requireDesignWriter,
  shareArg,
} from "../lib/designs_access";
import { blobUrl } from "../lib/designs_blob";
import {
  EXPORT_DOWNLOAD_URL_TTL_S,
  EXPORT_LARGE_PAGES,
  EXPORT_STUCK_MS,
  EXPORT_TTL_MS,
  MAX_ACTIVE_EXPORTS,
  MAX_EXPORT_SCALE,
} from "../lib/designs_limits";
import { assertFeature, assertLimit } from "../lib/entitlements";
import { appUrl, env } from "../lib/env";
import { errors } from "../lib/errors";
import type { FeatureKey } from "../lib/plans";
import { incrementUsage } from "../lib/usage";
import { exportFormatValidator } from "../tables/designs";

// exports.request|status|list : export jobs rendered by the worker (DOCUMENT_MODEL §8 POST /v1/render).

export type ExportFormat = Doc<"exports">["format"];

const FORMAT_FEATURE: Record<ExportFormat, FeatureKey> = {
  png: "export.png",
  jpeg: "export.jpg",
  webp: "export.webp",
  svg: "export.svg",
  pdf: "export.pdf",
  pptx: "export.pptx",
  gif: "export.video",
  mp4: "export.video",
};

const requestArgs = {
  designId: v.id("designs"),
  format: exportFormatValidator,
  /** "all" (default) or page ids in output order. */
  pages: v.optional(v.union(v.literal("all"), v.array(v.string()))),
  scale: v.optional(v.number()),
  quality: v.optional(v.number()),
  /** "#rrggbb(aa)" or "transparent". */
  background: v.optional(v.string()),
  pdf: v.optional(v.object({ bleed: v.boolean(), cropMarks: v.boolean(), cmyk: v.boolean() })),
  /** Additive: frames per second of gif / mp4 (worker default: gif 15, video 30). */
  fps: v.optional(v.number()),
  /** Additive: PDF image resolution in dpi (worker default 300; smaller files with lower values). */
  dpi: v.optional(v.number()),
  /** Force (true) or suppress (false) the "export ready" email; default: only for large jobs. */
  notify: v.optional(v.boolean()),
  share: shareArg,
};
const requestValidator = v.object(requestArgs);

/**
 * Queue an export (see `request`). `opts.userId` is a trusted caller-verified user (Agent API after API-key
 * verification).
 */
export async function requestExportFor(
  ctx: MutationCtx,
  args: Infer<typeof requestValidator>,
  opts: { userId?: string } = {},
): Promise<Id<"exports">> {
  const design = await getDesignOrThrow(ctx, args.designId);
  const access = await requireDesignWriter(ctx, design, "view", {
    ...(args.share ? { share: args.share } : {}),
    ...opts,
  });
  if (design.state === "trashed") throw errors.conflict("Restore the design to export it.");
  if (!env.has("RENDER_WORKER_URL")) throw errors.notConfigured("Export rendering");
  await assertFeature(ctx, access.userId, FORMAT_FEATURE[args.format]);
  if (
    args.format === "pdf" &&
    args.pdf &&
    (args.pdf.bleed || args.pdf.cropMarks || args.pdf.cmyk)
  ) {
    await assertFeature(ctx, access.userId, "export.pdfPrint");
  }
  // Jobs only count toward exportsPerMonth once they finish, so jobs still in flight are counted here
  // too, and their number is capped so one user cannot flood the render worker.
  const now = Date.now();
  const recent = await ctx.db
    .query("exports")
    .withIndex("by_user_created", (q) =>
      q.eq("userId", access.userId).gt("createdAt", now - EXPORT_STUCK_MS),
    )
    .order("desc")
    .take(200);
  const inFlight = recent.filter((r) => r.status === "queued" || r.status === "rendering");
  if (inFlight.length >= MAX_ACTIVE_EXPORTS) {
    const oldest = Math.min(...inFlight.map((r) => r.createdAt));
    throw errors.rateLimited(Math.max(1_000, oldest + EXPORT_STUCK_MS - now), "exports");
  }
  await assertLimit(ctx, access.userId, "exportsPerMonth", { adding: 1 + inFlight.length });

  const scale = args.scale ?? 1;
  if (!(scale >= 0.1 && scale <= MAX_EXPORT_SCALE)) {
    throw errors.invalid(`Scale must be between 0.1 and ${MAX_EXPORT_SCALE}.`, "scale");
  }
  if (args.quality !== undefined && !(args.quality >= 1 && args.quality <= 100)) {
    throw errors.invalid("Quality must be between 1 and 100.", "quality");
  }
  if (
    args.background !== undefined &&
    args.background !== "transparent" &&
    !/^#(?:[0-9a-f]{6}|[0-9a-f]{8})$/.test(args.background)
  ) {
    throw errors.invalid(
      'Background must be "#rrggbb", "#rrggbbaa" or "transparent".',
      "background",
    );
  }
  if (
    args.fps !== undefined &&
    (!(args.format === "gif" || args.format === "mp4") || !(args.fps >= 1 && args.fps <= 60))
  ) {
    throw errors.invalid("fps applies to gif / mp4 exports and must be between 1 and 60.", "fps");
  }
  if (args.dpi !== undefined && (args.format !== "pdf" || !(args.dpi >= 36 && args.dpi <= 2400))) {
    throw errors.invalid("dpi applies to pdf exports and must be between 36 and 2400.", "dpi");
  }
  const root = await ctx.db
    .query("nodes")
    .withIndex("by_design_node", (q) => q.eq("designId", design._id).eq("nodeId", "root"))
    .unique();
  const allPages = root ? ((JSON.parse(root.data) as { children?: string[] }).children ?? []) : [];
  const pages = args.pages ?? "all";
  if (pages !== "all") {
    if (pages.length === 0 || pages.length > 500)
      throw errors.invalid("Select between 1 and 500 pages.", "pages");
    const known = new Set(allPages);
    if (!pages.every((id) => known.has(id)))
      throw errors.invalid("Some pages do not exist.", "pages");
  }
  const pageCount = pages === "all" ? allPages.length : pages.length;
  if (pageCount === 0) throw errors.invalid("The design has no pages to export.", "pages");
  const large =
    pageCount > EXPORT_LARGE_PAGES ||
    args.format === "mp4" ||
    args.format === "gif" ||
    args.format === "pptx";
  const exportId = await ctx.db.insert("exports", {
    designId: design._id,
    workspaceId: design.workspaceId,
    userId: access.userId,
    format: args.format,
    pages,
    scale,
    ...(args.quality !== undefined ? { quality: args.quality } : {}),
    ...(args.background !== undefined ? { background: args.background } : {}),
    ...(args.pdf ? { pdf: args.pdf } : {}),
    ...(args.fps !== undefined ? { fps: args.fps } : {}),
    ...(args.dpi !== undefined ? { dpi: args.dpi } : {}),
    status: "queued",
    files: [],
    notify: args.notify ?? large,
    attempts: 0,
    createdAt: now,
  });
  await ctx.scheduler.runAfter(0, internal.exports.node.run, { exportId });
  return exportId;
}

/**
 * Queue an export. Members and share-link viewers who are signed in may export (the job counts toward the
 * requester's plan). Large jobs (many pages, video, decks) also send an email when ready.
 */
export const request = mutation({
  args: requestArgs,
  handler: async (ctx, args): Promise<Id<"exports">> => await requestExportFor(ctx, args),
});

export async function exportView(ctx: Parameters<typeof blobUrl>[0], row: Doc<"exports">) {
  const files = [];
  for (const f of row.status === "ready" ? row.files : []) {
    files.push({
      pageId: f.pageId ?? null,
      fileName: f.fileName,
      contentType: f.contentType,
      bytes: f.bytes,
      url: await blobUrl(ctx, f.key, {
        fileName: f.fileName,
        ttlSeconds: EXPORT_DOWNLOAD_URL_TTL_S,
      }),
    });
  }
  return {
    id: row._id,
    designId: row.designId,
    format: row.format,
    pages: row.pages,
    scale: row.scale,
    status: row.status,
    files,
    error: row.error ?? null,
    attempts: row.attempts,
    createdAt: row.createdAt,
    startedAt: row.startedAt ?? null,
    finishedAt: row.finishedAt ?? null,
    expiresAt: row.expiresAt ?? null,
  };
}

/** Status of an export job with download URLs once ready (requester or design managers). */
export const status = query({
  args: { exportId: v.id("exports") },
  handler: async (ctx, args) => {
    const row = await ctx.db.get("exports", args.exportId);
    if (!row) throw errors.notFound("Export");
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw errors.unauthenticated();
    if (row.userId !== identity.subject) {
      const design = await getDesignOrThrow(ctx, row.designId);
      await requireDesignPermission(ctx, design, "manage");
    }
    return await exportView(ctx, row);
  },
});

/** The caller's recent exports of a design. */
export const list = query({
  args: { designId: v.id("designs") },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw errors.unauthenticated();
    const rows = await ctx.db
      .query("exports")
      .withIndex("by_design_created", (q) => q.eq("designId", args.designId))
      .order("desc")
      .filter((q) => q.eq(q.field("userId"), identity.subject))
      .take(20);
    const out = [];
    for (const row of rows) out.push(await exportView(ctx, row));
    return out;
  },
});

// --- worker lifecycle (internal) -------------------------------------------------------------------------

export const start = internalMutation({
  args: { exportId: v.id("exports") },
  handler: async (ctx, args) => {
    const row = await ctx.db.get("exports", args.exportId);
    if (row?.status !== "queued") return null;
    const design = await ctx.db.get("designs", row.designId);
    if (!design) {
      await ctx.db.patch("exports", row._id, {
        status: "failed",
        error: "The design was deleted.",
        finishedAt: Date.now(),
      });
      return null;
    }
    await ctx.db.patch("exports", row._id, {
      status: "rendering",
      attempts: row.attempts + 1,
      startedAt: Date.now(),
    });
    return { row: { ...row, attempts: row.attempts + 1 }, designName: design.name };
  },
});

export const complete = internalMutation({
  args: {
    exportId: v.id("exports"),
    seq: v.number(),
    files: v.array(
      v.object({
        key: v.string(),
        pageId: v.optional(v.string()),
        fileName: v.string(),
        contentType: v.string(),
        bytes: v.number(),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db.get("exports", args.exportId);
    if (row?.status !== "rendering") {
      await scheduleBlobDeletion(
        ctx,
        args.files.map((f) => f.key),
      );
      return null;
    }
    const now = Date.now();
    const expiresAt = now + EXPORT_TTL_MS;
    await ctx.db.patch("exports", row._id, {
      status: "ready",
      files: args.files,
      seq: args.seq,
      finishedAt: now,
      expiresAt,
      error: undefined,
    });
    await incrementUsage(ctx, row.userId, "exports", 1);
    if (row.notify) {
      const profile = await ctx.db
        .query("profiles")
        .withIndex("by_userId", (q) => q.eq("userId", row.userId))
        .unique();
      const design = await ctx.db.get("designs", row.designId);
      if (profile?.email && design) {
        await enqueueEmail(ctx, {
          to: profile.email,
          template: "exportReady",
          userId: row.userId,
          idempotencyKey: `export:${row._id}`,
          data: {
            designName: design.name,
            format: row.format,
            url: `${appUrl()}/design/${design._id}?export=${row._id}`,
            expiresAt,
          },
        });
      }
    }
    return null;
  },
});

export const fail = internalMutation({
  args: { exportId: v.id("exports"), error: v.string(), retryInMs: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const row = await ctx.db.get("exports", args.exportId);
    if (row?.status !== "rendering") return null;
    if (args.retryInMs !== undefined) {
      await ctx.db.patch("exports", row._id, { status: "queued", error: args.error.slice(0, 500) });
      await ctx.scheduler.runAfter(args.retryInMs, internal.exports.node.run, {
        exportId: row._id,
      });
      return null;
    }
    await ctx.db.patch("exports", row._id, {
      status: "failed",
      error: args.error.slice(0, 500),
      finishedAt: Date.now(),
    });
    return null;
  },
});

/** Cron: expire downloadable files and fail jobs stuck for over an hour. */
export const cleanup = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const expired = await ctx.db
      .query("exports")
      .withIndex("by_status_expires", (q) => q.eq("status", "ready").lt("expiresAt", now))
      .take(100);
    for (const row of expired) {
      await scheduleBlobDeletion(
        ctx,
        row.files.map((f) => f.key),
      );
      await ctx.db.patch("exports", row._id, { status: "expired", files: [] });
    }
    let stuck = 0;
    for (const status of ["queued", "rendering"] as const) {
      const rows = await ctx.db
        .query("exports")
        .withIndex("by_status_created", (q) =>
          q.eq("status", status).lt("createdAt", now - EXPORT_STUCK_MS),
        )
        .take(100);
      for (const row of rows) {
        await ctx.db.patch("exports", row._id, {
          status: "failed",
          error: "The export timed out.",
          finishedAt: now,
        });
        stuck++;
      }
    }
    return { expired: expired.length, stuck };
  },
});
