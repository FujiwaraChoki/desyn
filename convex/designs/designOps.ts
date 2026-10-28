import { v } from "convex/values";
import { query } from "../_generated/server";
import { getDesignOrThrow, requireDesignPermission, shareArg } from "../lib/designs_access";
import { SINCE_LIMIT } from "../lib/designs_limits";
import type { OpEntry } from "../lib/designs_wire";

/**
 * designOps.since (DOCUMENT_MODEL §6): accepted transactions after `seq`, oldest first, at most 200. Reactive:
 * subscribe with the seq of the loaded state and advance it as entries arrive. `gap` means transactions
 * after `seq` were compacted away (or `hasMore` stays true for long): reload the design.
 */
export const since = query({
  args: { designId: v.id("designs"), seq: v.number(), share: shareArg },
  handler: async (
    ctx,
    args,
  ): Promise<{ ops: OpEntry[]; hasMore: boolean; gap: boolean; latestSeq: number }> => {
    const design = await getDesignOrThrow(ctx, args.designId);
    await requireDesignPermission(ctx, design, "view", { share: args.share });
    const rows = await ctx.db
      .query("designOps")
      .withIndex("by_design_seq", (q) => q.eq("designId", design._id).gt("seq", args.seq))
      .take(SINCE_LIMIT + 1);
    const page = rows.slice(0, SINCE_LIMIT);
    const first = page[0];
    if (!first) {
      // No entries after `seq`: the client is current, unless compaction removed the entries it still
      // needs (an idle design's whole log can be trimmed behind its snapshot). Only read the counter in
      // that case so ordinary subscriptions do not depend on it.
      const seqDoc = await ctx.db
        .query("designSeq")
        .withIndex("by_design", (q) => q.eq("designId", design._id))
        .unique();
      const latest = seqDoc?.seq ?? args.seq;
      return {
        ops: [],
        hasMore: false,
        gap: latest > args.seq,
        latestSeq: Math.max(latest, args.seq),
      };
    }
    return {
      ops: page.map((row) => ({
        seq: row.seq,
        txId: row.txId,
        tx: row.tx,
        actor: row.actor ?? null,
        source: row.source,
        ts: row.ts,
      })),
      hasMore: rows.length > SINCE_LIMIT,
      gap: first !== undefined && first.seq !== args.seq + 1,
      latestSeq: page[page.length - 1]?.seq ?? args.seq,
    };
  },
});
