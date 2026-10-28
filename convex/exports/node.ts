"use node";

import { v } from "convex/values";
import { internal } from "../_generated/api";
import { internalAction } from "../_generated/server";
import { deleteBlob, putBlob } from "../lib/designs_blob";
import { decompressToString, gzip } from "../lib/designs_compress";
import { EXPORT_MAX_ATTEMPTS } from "../lib/designs_limits";
import { materializeDesign } from "../lib/designs_materialize";
import {
  callWorker,
  MULTI_PAGE_FORMATS,
  WorkerError,
  withAssetUrls,
  withPages,
} from "../lib/designs_worker";
import { createLogger } from "../lib/logger";

// Export rendering: rebuild the design, call the worker's POST /v1/render once per output file, store the
// results and complete the job. Transient worker failures are retried with backoff.

const EXTENSION: Record<string, string> = {
  png: "png",
  jpeg: "jpg",
  webp: "webp",
  svg: "svg",
  pdf: "pdf",
  pptx: "pptx",
  gif: "gif",
  mp4: "mp4",
};

const CONTENT_TYPE: Record<string, string> = {
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  gif: "image/gif",
  mp4: "video/mp4",
};

/** File name base from a design name ("Spring Sale!" -> "Spring-Sale"). */
function fileBase(name: string): string {
  const base = name
    .normalize("NFKD")
    .replace(/[^\w\s-]+/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 80);
  return base || "design";
}

export const run = internalAction({
  args: { exportId: v.id("exports") },
  handler: async (ctx, args) => {
    const started = await ctx.runMutation(internal.exports.exports.start, {
      exportId: args.exportId,
    });
    if (!started) return null;
    const { row, designName } = started;
    const log = createLogger(ctx, { fn: "exports.run", exportId: row._id, format: row.format });
    const written: string[] = [];
    try {
      const m = await materializeDesign(ctx, row.designId, { decode: decompressToString });
      if (!m) throw new WorkerError("The design was deleted.", 0, false);
      const assetUrls = await ctx.runQuery(internal.designs.internal.assetUrls, {
        designId: row.designId,
      });
      const allPages = (m.design.nodes.root as { children?: string[] } | undefined)?.children ?? [];
      const pages =
        row.pages === "all" ? allPages : row.pages.filter((id) => allPages.includes(id));
      if (pages.length === 0)
        throw new WorkerError("The selected pages no longer exist.", 0, false);
      const design = withAssetUrls(m.design, assetUrls);
      const common = {
        scale: row.scale,
        format: row.format,
        ...(row.quality !== undefined ? { quality: row.quality } : {}),
        ...(row.background !== undefined ? { background: row.background } : {}),
        ...(row.pdf || row.dpi !== undefined
          ? {
              pdf: {
                ...(row.pdf ?? { bleed: false, cropMarks: false, cmyk: false }),
                ...(row.dpi !== undefined ? { dpi: row.dpi } : {}),
              },
            }
          : {}),
        ...(row.fps !== undefined ? { fps: row.fps } : {}),
        assetUrls,
      };
      const base = fileBase(designName);
      const ext = EXTENSION[row.format] ?? row.format;
      const jobs = MULTI_PAGE_FORMATS.has(row.format)
        ? [
            {
              design: row.pages === "all" ? design : withPages(design, pages),
              pageId: "all" as string,
              fileName: `${base}.${ext}`,
            },
          ]
        : pages.map((pageId, i) => ({
            design,
            pageId,
            fileName: pages.length > 1 ? `${base}-${i + 1}.${ext}` : `${base}.${ext}`,
          }));
      const files = [];
      for (const job of jobs) {
        const out = await callWorker(
          "/v1/render",
          { ...common, design: job.design, pageId: job.pageId },
          { gzip },
        );
        const contentType = CONTENT_TYPE[row.format] ?? out.contentType;
        const key = await putBlob(
          ctx,
          `exports/${row._id}/${job.fileName}`,
          out.bytes,
          contentType,
        );
        written.push(key);
        files.push({
          key,
          ...(job.pageId !== "all" ? { pageId: job.pageId } : {}),
          fileName: job.fileName,
          contentType,
          bytes: out.bytes.length,
        });
      }
      await ctx.runMutation(internal.exports.exports.complete, {
        exportId: row._id,
        seq: m.seq,
        files,
      });
      log.info("export ready", { files: files.length });
    } catch (err) {
      for (const key of written) {
        try {
          await deleteBlob(ctx, key);
        } catch {
          // Orphaned partial outputs are removed with the job's expiry otherwise.
        }
      }
      const retryable = err instanceof WorkerError ? err.retryable : true;
      const error = err instanceof Error ? err.message : String(err);
      log.warn("export failed", { error, attempt: row.attempts, retryable });
      await ctx.runMutation(internal.exports.exports.fail, {
        exportId: row._id,
        error,
        ...(retryable && row.attempts < EXPORT_MAX_ATTEMPTS
          ? { retryInMs: 5_000 * 2 ** row.attempts }
          : {}),
      });
    } finally {
      await log.flush();
    }
    return null;
  },
});
