"use node";

import { v } from "convex/values";
import { internal } from "../_generated/api";
import { internalAction } from "../_generated/server";
import { deleteBlob, putBlob } from "../lib/designs_blob";
import { decompressToString, gzip } from "../lib/designs_compress";
import { THUMBNAIL_WIDTH } from "../lib/designs_limits";
import { materializeDesign } from "../lib/designs_materialize";
import { callWorker, withAssetUrls, workerConfig } from "../lib/designs_worker";
import { createLogger } from "../lib/logger";

// Thumbnails: rendered by the worker (`POST /v1/thumbnail`) a few seconds after a burst of commits
// (scheduled by designs.commit, debounced through designSeq.thumbnailAt).

export const thumbnail = internalAction({
  args: { designId: v.id("designs") },
  handler: async (ctx, args) => {
    const begin = await ctx.runMutation(internal.designs.internal.beginThumbnail, {
      designId: args.designId,
    });
    if (!begin || begin.thumbnailSeq === begin.seq || !workerConfig()) return null;
    const log = createLogger(ctx, { fn: "designs.thumbnail", designId: args.designId });
    try {
      const m = await materializeDesign(ctx, args.designId, { decode: decompressToString });
      if (!m) return null;
      const root = m.design.nodes.root as { children?: string[] } | undefined;
      const pageId = root?.children?.[0];
      if (!pageId) return null;
      const assetUrls = await ctx.runQuery(internal.designs.internal.assetUrls, {
        designId: args.designId,
      });
      const out = await callWorker(
        "/v1/thumbnail",
        { design: withAssetUrls(m.design, assetUrls), pageId, width: THUMBNAIL_WIDTH, assetUrls },
        { gzip },
      );
      const key = await putBlob(
        ctx,
        `thumbnails/${args.designId}/${m.seq}.webp`,
        out.bytes,
        "image/webp",
      );
      const result = await ctx.runMutation(internal.designs.internal.setThumbnail, {
        designId: args.designId,
        key,
        seq: m.seq,
      });
      if (result.discard) await deleteBlob(ctx, result.discard);
    } catch (err) {
      log.warn("thumbnail failed", { error: err instanceof Error ? err.message : String(err) });
    } finally {
      await log.flush();
    }
    return null;
  },
});
