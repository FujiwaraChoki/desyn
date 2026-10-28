import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { internalMutation, internalQuery } from "../_generated/server";
import { aiAccess } from "../lib/ai_access";
import { aiBrandKit, assetRefOf, brandKitForDesign } from "../lib/ai_brand";
import {
  appendRunEvents,
  clip,
  isAgentMode,
  isTerminal,
  LEASE_MS,
  resumeAfterRefusal,
} from "../lib/ai_runs";
import { finishRun, reserveForRun, settleRun } from "../lib/ai_start";
import { isAppError } from "../lib/errors";

// Internal state transitions of agent runs, called by the Node action that runs the agent loop
// (convex/ai/agentNode.ts). Every transition checks the chunk number so a stale or duplicated scheduled
// action can never act on a run it no longer owns.

const eventValidator = v.object({ type: v.string(), ts: v.number(), payload: v.string() });

/** Claims chunk `chunk` of a run and returns everything the action needs, or null when it must not run. */
export const beginChunk = internalMutation({
  args: { runId: v.id("aiRuns"), chunk: v.number() },
  handler: async (ctx, args) => {
    const run = await ctx.db.get("aiRuns", args.runId);
    if (run?.kind !== "agent" || run.chunk !== args.chunk) return null;
    if (isTerminal(run.status) || run.status === "needs-input") return null;
    const now = Date.now();
    if (run.leaseUntil !== undefined && run.leaseUntil > now) return null; // another action holds it
    if (run.cancelRequested) {
      await finishRun(ctx, run._id, {
        status: "cancelled",
        summary: "Stopped before making changes.",
        emitDone: true,
      });
      return null;
    }
    const design = run.designId ? await ctx.db.get("designs", run.designId) : null;
    if (!design || design.state === "creating" || design.state === "trashed") {
      await finishRun(ctx, run._id, {
        status: "failed",
        summary: "The design is no longer available.",
        error: "The design is no longer available.",
        errorCode: "NOT_FOUND",
        emitDone: true,
      });
      return null;
    }
    if (!run.reservation) {
      try {
        const reserved = await reserveForRun(ctx, run);
        if (!reserved.ok) {
          const next = resumeAfterRefusal(reserved.error);
          if ("stop" in next) {
            await finishRun(ctx, run._id, {
              status: "failed",
              summary: next.stop,
              error: next.stop,
              errorCode: "RATE_LIMITED",
              emitDone: true,
            });
            return null;
          }
          // Touch the run so the stale-run reaper does not mistake the wait for a dead action.
          await ctx.db.patch("aiRuns", run._id, { updatedAt: now });
          await ctx.scheduler.runAfter(next.retryInMs, internal.ai.agentNode.runChunk, args);
          return null;
        }
        if (reserved.delayMs > 0) {
          await ctx.scheduler.runAfter(reserved.delayMs, internal.ai.agentNode.runChunk, args);
          return null;
        }
      } catch (err) {
        if (!isAppError(err)) throw err;
        const data = err.data as { code: string; message: string };
        await finishRun(ctx, run._id, {
          status: "failed",
          summary: data.message,
          error: data.message,
          errorCode: data.code,
          emitDone: true,
        });
        return null;
      }
    }
    await ctx.db.patch("aiRuns", run._id, {
      status: "running",
      leaseUntil: now + LEASE_MS,
      startedAt: run.startedAt ?? now,
      updatedAt: now,
    });
    const fresh = (await ctx.db.get("aiRuns", run._id)) as Doc<"aiRuns">;
    const access = await aiAccess(ctx, run.userId);
    const kitDoc = await brandKitForDesign(ctx, design);
    const brand = kitDoc ? await aiBrandKit(ctx, kitDoc) : null;
    const attachments = [];
    for (const assetId of run.attachments ?? []) {
      const asset = await ctx.db.get("assets", assetId);
      if (asset?.status === "ready" && asset.workspaceId === design.workspaceId)
        attachments.push(assetRefOf(asset));
    }
    let historyId: Id<"_storage"> | null = fresh.historyId ?? null;
    if (!historyId && fresh.previousRunId) {
      const previous = await ctx.db.get("aiRuns", fresh.previousRunId);
      historyId = previous?.historyId ?? null;
    }
    if (!isAgentMode(fresh.mode)) throw new Error(`unknown agent mode ${fresh.mode}`);
    return {
      run: {
        id: fresh._id,
        userId: fresh.userId,
        workspaceId: fresh.workspaceId,
        designId: design._id,
        mode: fresh.mode,
        goal: fresh.goal,
        chunk: fresh.chunk,
        steps: fresh.steps,
        maxSteps: fresh.maxSteps,
        maxCredits: fresh.maxCredits ?? null,
        creditsUsed: fresh.creditsUsed,
        transactions: fresh.transactions,
        pageId: fresh.pageId ?? null,
        selection: fresh.selection ?? [],
        modelOverride: fresh.modelOverride ?? null,
        answer: fresh.answer ?? null,
        question: fresh.question ?? null,
        eventCount: fresh.eventCount,
        /** The first chunk of a run (not a continuation, not a resumed answer). */
        first: fresh.steps === 0 && !fresh.historyId && !fresh.answer,
      },
      historyId,
      settings: access.settings,
      byokAllowed: access.byokAllowed,
      localAllowed: access.localAllowed,
      brand,
      attachments,
    };
  },
});

/**
 * Appends a batch of events and renews the lease; doubles as the cancellation poll of the running action.
 * Returns `stop: true` when the run was cancelled or the chunk is stale.
 */
export const pushEvents = internalMutation({
  args: { runId: v.id("aiRuns"), chunk: v.optional(v.number()), events: v.array(eventValidator) },
  handler: async (ctx, args): Promise<{ stop: boolean }> => {
    const run = await ctx.db.get("aiRuns", args.runId);
    if (!run) return { stop: true };
    if (args.chunk !== undefined && run.chunk !== args.chunk) return { stop: true };
    const now = Date.now();
    const patch: Partial<Doc<"aiRuns">> = { updatedAt: now };
    if (args.events.length > 0) patch.eventCount = await appendRunEvents(ctx, run, args.events);
    if (run.status === "running") patch.leaseUntil = now + LEASE_MS;
    await ctx.db.patch("aiRuns", run._id, patch);
    return { stop: run.cancelRequested === true || isTerminal(run.status) };
  },
});

export const isStopRequested = internalQuery({
  args: { runId: v.id("aiRuns") },
  handler: async (ctx, args): Promise<boolean> => {
    const run = await ctx.db.get("aiRuns", args.runId);
    return !run || run.cancelRequested === true || isTerminal(run.status);
  },
});

const outcomeStatus = v.union(
  v.literal("yielded"),
  v.literal("completed"),
  v.literal("needs-input"),
  v.literal("budget-exceeded"),
  v.literal("step-limit"),
  v.literal("failed"),
  v.literal("cancelled"),
);

/** Records the outcome of a chunk: continue (next chunk), wait for an answer, or finish and settle. */
export const endChunk = internalMutation({
  args: {
    runId: v.id("aiRuns"),
    chunk: v.number(),
    status: outcomeStatus,
    summary: v.string(),
    changes: v.array(v.string()),
    followUps: v.array(v.string()),
    question: v.optional(
      v.object({
        question: v.string(),
        options: v.array(v.string()),
        callId: v.optional(v.string()),
      }),
    ),
    error: v.optional(v.string()),
    errorCode: v.optional(v.string()),
    steps: v.number(),
    credits: v.number(),
    inputTokens: v.number(),
    outputTokens: v.number(),
    costUsd: v.optional(v.number()),
    transactions: v.number(),
    model: v.optional(v.string()),
    historyId: v.optional(v.id("_storage")),
    /** The agent loop did not emit its own `done` event (crash, refusal before the loop). */
    emitDone: v.boolean(),
  },
  handler: async (ctx, args) => {
    const run = await ctx.db.get("aiRuns", args.runId);
    if (!run || run.chunk !== args.chunk || isTerminal(run.status)) {
      // Stale: a newer chunk owns the run. Drop the orphaned conversation blob.
      if (args.historyId && args.historyId !== run?.historyId)
        await ctx.storage.delete(args.historyId);
      return null;
    }
    const now = Date.now();
    if (args.historyId && run.historyId && run.historyId !== args.historyId) {
      await ctx.storage.delete(run.historyId);
    }
    const usage = run.usage ?? { inputTokens: 0, outputTokens: 0 };
    await ctx.db.patch("aiRuns", run._id, {
      steps: run.steps + args.steps,
      creditsUsed: run.creditsUsed + args.credits,
      transactions: run.transactions + args.transactions,
      usage: {
        inputTokens: usage.inputTokens + args.inputTokens,
        outputTokens: usage.outputTokens + args.outputTokens,
      },
      ...(args.costUsd !== undefined
        ? { costUsd: Math.round(((run.costUsd ?? 0) + args.costUsd) * 10_000) / 10_000 }
        : {}),
      ...(args.model ? { model: args.model } : {}),
      ...(args.historyId ? { historyId: args.historyId } : {}),
      answer: undefined,
      leaseUntil: undefined,
      updatedAt: now,
    });
    let current = (await ctx.db.get("aiRuns", run._id)) as Doc<"aiRuns">;
    const status = current.cancelRequested && args.status === "yielded" ? "cancelled" : args.status;

    if (status === "yielded") {
      // Settle what this chunk used so a reservation never outlives the stale-reservation window; the next
      // chunk reserves again (fair use applies per segment).
      await settleRun(ctx, current);
      await ctx.db.patch("aiRuns", run._id, { chunk: run.chunk + 1 });
      await ctx.scheduler.runAfter(0, internal.ai.agentNode.runChunk, {
        runId: run._id,
        chunk: run.chunk + 1,
      });
      return null;
    }
    if (status === "needs-input" && args.question) {
      await settleRun(ctx, current);
      current = (await ctx.db.get("aiRuns", run._id)) as Doc<"aiRuns">;
      await ctx.db.patch("aiRuns", run._id, {
        status: "needs-input",
        question: {
          question: clip(args.question.question, 2000),
          options: args.question.options.slice(0, 6).map((o) => clip(o, 200)),
          ...(args.question.callId ? { callId: args.question.callId } : {}),
        },
        result: { summary: args.summary, transactions: current.transactions },
      });
      return null;
    }
    await finishRun(ctx, run._id, {
      status: status === "needs-input" ? "completed" : status,
      summary: args.summary,
      ...(args.error ? { error: args.error } : {}),
      ...(args.errorCode ? { errorCode: args.errorCode } : {}),
      result: {
        changes: args.changes,
        followUps: args.followUps,
        transactions: current.transactions,
      },
      emitDone: args.emitDone || (current.cancelRequested === true && args.status === "yielded"),
    });
    return null;
  },
});

/** Accepted transactions after `after` for the WorkerHost (with a gap flag after log compaction). */
export const opsAfter = internalQuery({
  args: { designId: v.id("designs"), after: v.number() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("designOps")
      .withIndex("by_design_seq", (q) => q.eq("designId", args.designId).gt("seq", args.after))
      .take(200);
    const first = rows[0];
    if (!first) {
      const seqDoc = await ctx.db
        .query("designSeq")
        .withIndex("by_design", (q) => q.eq("designId", args.designId))
        .unique();
      return { txs: [], gap: (seqDoc?.seq ?? args.after) > args.after };
    }
    return {
      txs: rows.map((r) => ({ seq: r.seq, tx: r.tx })),
      gap: first.seq !== args.after + 1,
    };
  },
});

/** Records provenance of a generated asset. */
export const recordAsset = internalMutation({
  args: {
    assetId: v.id("assets"),
    refId: v.string(),
    workspaceId: v.id("workspaces"),
    userId: v.string(),
    designId: v.optional(v.id("designs")),
    runId: v.optional(v.id("aiRuns")),
    task: v.string(),
    provider: v.string(),
    model: v.string(),
    prompt: v.string(),
    seed: v.optional(v.number()),
    sourceAssetIds: v.optional(v.array(v.id("assets"))),
    billing: v.union(v.literal("platform"), v.literal("byok"), v.literal("local")),
    costCredits: v.number(),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("aiAssets", {
      ...args,
      prompt: clip(args.prompt, 2000),
      createdAt: Date.now(),
    });
    return null;
  },
});

/** Workspace asset refs by Convex id (attachments, sources of media edits). */
export const assetRefs = internalQuery({
  args: { workspaceId: v.id("workspaces"), assetIds: v.array(v.id("assets")) },
  handler: async (ctx, args) => {
    const out = [];
    for (const id of args.assetIds) {
      const asset = await ctx.db.get("assets", id);
      if (!asset || asset.workspaceId !== args.workspaceId || asset.status !== "ready") continue;
      out.push({ assetId: asset._id, ref: assetRefOf(asset) });
    }
    return out;
  },
});

/** Events of a run, for the workflow / agent actions that need to read a log back (tests, previews). */
export const runDoc = internalQuery({
  args: { runId: v.id("aiRuns") },
  handler: async (ctx, args) => await ctx.db.get("aiRuns", args.runId),
});
