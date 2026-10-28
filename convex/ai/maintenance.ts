import { internal } from "../_generated/api";
import type { Doc } from "../_generated/dataModel";
import { internalMutation, type MutationCtx } from "../_generated/server";
import {
  appendRunEvents,
  EVENTS_RETENTION_MS,
  HISTORY_RETENTION_MS,
  LEASE_MS,
  MAX_RESTARTS,
  storedEvent,
  WAITING_TTL_MS,
} from "../lib/ai_runs";
import { finishRun } from "../lib/ai_start";
import { createLogger } from "../lib/logger";

// Crons of the AI backend: the stale-run reaper (SPEC §6) resumes runs and workflows whose action died
// (crash, deploy, time limit) from their last saved state, closes runs that waited too long for an answer,
// and retention removes old event logs, previews and conversation blobs.

const BATCH = 100;
/** A queued run whose first action never started (lost schedule) is rescheduled after this long. */
const QUEUED_STALE_MS = 15 * 60_000;

async function restartRun(ctx: MutationCtx, run: Doc<"aiRuns">, reason: string): Promise<boolean> {
  if (run.restarts >= MAX_RESTARTS) {
    await finishRun(ctx, run._id, {
      status: "failed",
      summary: "The run stopped unexpectedly.",
      error: `The run stopped unexpectedly (${reason}).`,
      errorCode: "INTERNAL",
      emitDone: true,
    });
    return false;
  }
  const chunk = run.chunk + 1;
  const count = await appendRunEvents(ctx, run, [
    storedEvent({
      type: "error",
      message: "The run was interrupted and resumes from its last checkpoint.",
      code: "restarted",
      recoverable: true,
    }),
  ]);
  await ctx.db.patch("aiRuns", run._id, {
    chunk,
    restarts: run.restarts + 1,
    leaseUntil: undefined,
    eventCount: count,
    updatedAt: Date.now(),
  });
  if (run.kind === "asset") {
    await ctx.scheduler.runAfter(0, internal.ai.media.runJob, { runId: run._id, chunk });
  } else {
    await ctx.scheduler.runAfter(0, internal.ai.agentNode.runChunk, { runId: run._id, chunk });
  }
  return true;
}

export const reapStale = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    let restarted = 0;
    let failed = 0;
    let closed = 0;
    // Running agent / asset runs whose lease expired: the action died.
    const running = await ctx.db
      .query("aiRuns")
      .withIndex("by_status_updated", (q) =>
        q.eq("status", "running").lt("updatedAt", now - LEASE_MS),
      )
      .take(BATCH);
    for (const run of running) {
      if (run.kind === "workflow") continue; // follows its workflow
      if (run.leaseUntil !== undefined && run.leaseUntil > now) continue;
      if (run.via === "app" && run.kind === "asset") {
        // Synchronous media requests cannot be resumed: the caller already got the error.
        await finishRun(ctx, run._id, {
          status: "failed",
          summary: "The generation stopped unexpectedly.",
          error: "The generation stopped unexpectedly.",
          emitDone: true,
        });
        failed++;
        continue;
      }
      if (await restartRun(ctx, run, "lease expired")) restarted++;
      else failed++;
    }
    // Queued runs that never started (lost schedule, e.g. during a deploy).
    const queued = await ctx.db
      .query("aiRuns")
      .withIndex("by_status_updated", (q) =>
        q.eq("status", "queued").lt("updatedAt", now - QUEUED_STALE_MS),
      )
      .take(BATCH);
    for (const run of queued) {
      if (run.kind === "workflow") continue;
      if (await restartRun(ctx, run, "never started")) restarted++;
      else failed++;
    }
    // Runs waiting for an answer for too long.
    const waiting = await ctx.db
      .query("aiRuns")
      .withIndex("by_status_updated", (q) =>
        q.eq("status", "needs-input").lt("updatedAt", now - WAITING_TTL_MS),
      )
      .take(BATCH);
    for (const run of waiting) {
      await finishRun(ctx, run._id, {
        status: "cancelled",
        summary: "Closed after waiting a day for an answer. Start a follow-up run to continue.",
        emitDone: true,
      });
      closed++;
    }
    // Workflows whose step action died.
    const workflows = await ctx.db
      .query("aiWorkflows")
      .withIndex("by_status_updated", (q) =>
        q.eq("status", "running").lt("updatedAt", now - LEASE_MS),
      )
      .take(BATCH);
    for (const wf of workflows) {
      if (wf.leaseUntil !== undefined && wf.leaseUntil > now) continue;
      await ctx.runMutation(internal.ai.workflows.stepCrashed, {
        workflowId: wf._id,
        tick: wf.tick,
        error: "The step stopped unexpectedly.",
      });
      restarted++;
    }
    const queuedWf = await ctx.db
      .query("aiWorkflows")
      .withIndex("by_status_updated", (q) =>
        q.eq("status", "queued").lt("updatedAt", now - QUEUED_STALE_MS),
      )
      .take(BATCH);
    for (const wf of queuedWf) {
      await ctx.scheduler.runAfter(0, internal.ai.workflowsNode.advance, {
        workflowId: wf._id,
        tick: wf.tick,
      });
      await ctx.db.patch("aiWorkflows", wf._id, { updatedAt: now });
      restarted++;
    }
    if (restarted + failed + closed > 0) {
      const log = createLogger(ctx, { fn: "ai.reapStale" });
      log.warn("stale AI runs handled", { restarted, failed, closed });
      await log.flush();
    }
    return { restarted, failed, closed };
  },
});

/** Deletes conversation blobs (after 7 days) and event logs with their previews (after 30 days). */
export const purgeOld = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const conversations = await ctx.db
      .query("aiRuns")
      .withIndex("by_retention_finished", (q) =>
        q.eq("retention", 0).lt("finishedAt", now - HISTORY_RETENTION_MS),
      )
      .take(BATCH);
    for (const run of conversations) {
      if (run.historyId) await ctx.storage.delete(run.historyId);
      await ctx.db.patch("aiRuns", run._id, { historyId: undefined, retention: 1 });
    }
    let events = 0;
    const logs = await ctx.db
      .query("aiRuns")
      .withIndex("by_retention_finished", (q) =>
        q.eq("retention", 1).lt("finishedAt", now - EVENTS_RETENTION_MS),
      )
      .take(10);
    for (const run of logs) {
      const rows = await ctx.db
        .query("aiRunEvents")
        .withIndex("by_run_seq", (q) => q.eq("runId", run._id))
        .take(400);
      for (const row of rows) {
        if (row.type === "preview") {
          const previewId = (JSON.parse(row.payload) as { previewId?: string }).previewId;
          const id = previewId ? ctx.db.system.normalizeId("_storage", previewId) : null;
          if (id) await ctx.storage.delete(id);
        }
        await ctx.db.delete("aiRunEvents", row._id);
        events++;
      }
      if (rows.length < 400) await ctx.db.patch("aiRuns", run._id, { retention: 2 });
    }
    if (conversations.length === BATCH || logs.length === 10) {
      await ctx.scheduler.runAfter(1_000, internal.ai.maintenance.purgeOld, {});
    }
    return { conversations: conversations.length, events };
  },
});
