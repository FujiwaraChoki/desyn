import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { internalAction, internalMutation, internalQuery } from "../_generated/server";
import { axiomConfigured, shipToAxiom } from "./logger";
import { sendToPosthog } from "./posthog";

const SHIP_BATCH = 500;
/** Lines older than this are dropped even if Axiom is unreachable, so the queue cannot grow forever. */
const MAX_QUEUE_AGE_MS = 24 * 60 * 60 * 1000;

export const capture = internalAction({
  args: {
    events: v.array(
      v.object({
        distinctId: v.string(),
        event: v.string(),
        properties: v.record(v.string(), v.any()),
      }),
    ),
  },
  handler: async (_ctx, args) => {
    await sendToPosthog(args.events);
  },
});

export const pendingLogs = internalQuery({
  args: { limit: v.number() },
  handler: async (ctx, args) => {
    const rows = await ctx.db.query("logQueue").withIndex("by_createdAt").take(args.limit);
    return rows.map((r) => ({ id: r._id, line: r.line }));
  },
});

export const deleteLogs = internalMutation({
  args: { ids: v.array(v.id("logQueue")) },
  handler: async (ctx, args) => {
    for (const id of args.ids) await ctx.db.delete("logQueue", id);
  },
});

export const dropStaleLogs = internalMutation({
  args: {},
  handler: async (ctx) => {
    const cutoff = Date.now() - MAX_QUEUE_AGE_MS;
    const stale = await ctx.db
      .query("logQueue")
      .withIndex("by_createdAt", (q) => q.lt("createdAt", cutoff))
      .take(1000);
    for (const row of stale) await ctx.db.delete("logQueue", row._id);
    return stale.length;
  },
});

/** Cron: ship queued mutation logs to Axiom. */
export const shipLogs = internalAction({
  args: {},
  handler: async (ctx): Promise<{ shipped: number }> => {
    // Nothing is queued while Axiom is not configured (see logger.flush), so there is no work.
    if (!axiomConfigured()) return { shipped: 0 };
    let shipped = 0;
    for (let round = 0; round < 20; round++) {
      const batch: { id: Id<"logQueue">; line: string }[] = await ctx.runQuery(
        internal.lib.telemetry.pendingLogs,
        { limit: SHIP_BATCH },
      );
      if (batch.length === 0) break;
      const ok = await shipToAxiom(batch.map((b) => b.line));
      if (!ok) break;
      await ctx.runMutation(internal.lib.telemetry.deleteLogs, { ids: batch.map((b) => b.id) });
      shipped += batch.length;
      if (batch.length < SHIP_BATCH) break;
    }
    await ctx.runMutation(internal.lib.telemetry.dropStaleLogs, {});
    return { shipped };
  },
});
