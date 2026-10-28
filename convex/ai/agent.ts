import { v } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import { mutation, type QueryCtx, query } from "../_generated/server";
import { eventViews, getRun as findRun, isTerminal, runAppView, stepsFor } from "../lib/ai_runs";
import { answerAgentRun, cancelAgentRun, estimateFor, startAgentRun } from "../lib/ai_start";
import { getDesignOrThrow, requireDesignPermission } from "../lib/designs_access";
import { errors } from "../lib/errors";
import { getUser, requireUser } from "../lib/guards";
import { cancelWorkflowFor } from "./workflows";

// Server-run design agent (SPEC §6 `ai.runAgent` / §7): start a run on a design, follow its events live,
// answer its questions, cancel it. Runs execute in scheduled Node actions (agentNode.ts); every edit is a
// normal transaction (actor = the run) that collaborators see live and the editor can undo as one step.

const modeValidator = v.union(v.literal("edit"), v.literal("generate"), v.literal("critique"));

const startArgs = {
  designId: v.id("designs"),
  goal: v.string(),
  mode: v.optional(modeValidator),
  pageId: v.optional(v.string()),
  selection: v.optional(v.array(v.string())),
  /** Uploaded assets (Convex ids) the request refers to ("use this photo"). */
  attachments: v.optional(v.array(v.id("assets"))),
  /** Continue the conversation of an earlier run on the same design. */
  previousRunId: v.optional(v.id("aiRuns")),
  prefs: v.optional(
    v.object({
      /** "provider:model" for this run's agent. */
      model: v.optional(v.string()),
      maxSteps: v.optional(v.number()),
      maxCredits: v.optional(v.number()),
    }),
  ),
};

/** Starts an agent run; returns its id immediately (events follow through `runEvents`). */
export const startRun = mutation({
  args: startArgs,
  handler: async (ctx, args): Promise<{ runId: string }> => {
    const user = await requireUser(ctx, { verified: true });
    const run = await startAgentRun(ctx, {
      userId: user.userId,
      designId: args.designId,
      goal: args.goal,
      mode: args.mode ?? "edit",
      ...(args.pageId ? { pageId: args.pageId } : {}),
      ...(args.selection ? { selection: args.selection } : {}),
      ...(args.attachments ? { attachments: args.attachments } : {}),
      ...(args.previousRunId ? { previousRunId: args.previousRunId } : {}),
      ...(args.prefs?.model ? { model: args.prefs.model } : {}),
      ...(args.prefs?.maxSteps !== undefined ? { maxSteps: args.prefs.maxSteps } : {}),
      ...(args.prefs?.maxCredits !== undefined ? { maxCredits: args.prefs.maxCredits } : {}),
      via: "app",
    });
    return { runId: run._id };
  },
});

/** The web app's dashboard hand-off (`ai/agent:runAgent`): same as startRun with defaults. */
export const runAgent = mutation({
  args: {
    designId: v.string(),
    goal: v.string(),
    mode: v.optional(v.union(v.literal("generate"), v.literal("edit"))),
  },
  handler: async (ctx, args): Promise<{ runId: string }> => {
    const user = await requireUser(ctx, { verified: true });
    const designId = ctx.db.normalizeId("designs", args.designId);
    if (!designId) throw errors.notFound("Design");
    const run = await startAgentRun(ctx, {
      userId: user.userId,
      designId,
      goal: args.goal,
      mode: args.mode ?? "edit",
      via: "app",
    });
    return { runId: run._id };
  },
});

/** Stops a run (between stream parts when it is running). Changes already applied stay. */
export const cancelRun = mutation({
  args: { runId: v.string() },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const run = await findRun(ctx, args.runId);
    if (!run || run.userId !== user.userId) throw errors.notFound("Run");
    if (run.kind === "workflow" && run.workflowId) {
      const wf = await ctx.db.get("aiWorkflows", run.workflowId);
      if (wf) await cancelWorkflowFor(ctx, wf);
    } else {
      await cancelAgentRun(ctx, run);
    }
    return runAppView((await ctx.db.get("aiRuns", run._id)) as Doc<"aiRuns">);
  },
});

/** Answers the run's question (ask_user) and resumes it. */
export const answer = mutation({
  args: { runId: v.string(), answer: v.string() },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const run = await findRun(ctx, args.runId);
    if (!run || run.userId !== user.userId || run.kind !== "agent") throw errors.notFound("Run");
    return runAppView(await answerAgentRun(ctx, run, args.answer));
  },
});

/**
 * A run the caller may follow: their own, or (for agent runs) any run on a design they can view, so
 * collaborators see what the AI is doing.
 */
async function readableRun(ctx: QueryCtx, raw: string): Promise<Doc<"aiRuns">> {
  const user = await getUser(ctx);
  if (!user) throw errors.unauthenticated();
  const run = await findRun(ctx, raw);
  if (!run) throw errors.notFound("Run");
  if (run.userId === user.userId) return run;
  if (run.kind === "agent" && run.designId) {
    const design = await getDesignOrThrow(ctx, run.designId);
    await requireDesignPermission(ctx, design, "view", { userId: user.userId });
    return run;
  }
  throw errors.notFound("Run");
}

/** One run (reactive): status, question, result, credits. */
export const getRun = query({
  args: { runId: v.string() },
  handler: async (ctx, args) => runAppView(await readableRun(ctx, args.runId)),
});

/**
 * Events after `afterSeq` (reactive): subscribe with the last seen index; `done` once the run ended and every
 * event was returned. Preview events carry a short-lived `url`.
 */
export const runEvents = query({
  args: { runId: v.string(), afterSeq: v.optional(v.number()), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const run = await readableRun(ctx, args.runId);
    const limit = Math.max(1, Math.min(500, args.limit ?? 200));
    const after = args.afterSeq ?? -1;
    const events = await eventViews(ctx, run._id, after, limit);
    const next = events.at(-1)?.index ?? after;
    return {
      run: runAppView(run),
      events,
      next,
      done: isTerminal(run.status) && next >= run.eventCount - 1,
    };
  },
});

/** Recent runs of a design (everyone who can view it) or of the caller. */
export const listRuns = query({
  args: { designId: v.optional(v.id("designs")), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const limit = Math.max(1, Math.min(100, args.limit ?? 20));
    if (args.designId) {
      const design = await getDesignOrThrow(ctx, args.designId);
      await requireDesignPermission(ctx, design, "view", { userId: user.userId });
      const rows = await ctx.db
        .query("aiRuns")
        .withIndex("by_design_created", (q) => q.eq("designId", design._id))
        .order("desc")
        .take(limit);
      return rows.map(runAppView);
    }
    const rows = await ctx.db
      .query("aiRuns")
      .withIndex("by_user_created", (q) => q.eq("userId", user.userId))
      .order("desc")
      .take(limit);
    return rows.map(runAppView);
  },
});

/** Credits a run of this mode is expected to use (shown before starting). */
export const estimate = query({
  args: { mode: modeValidator, maxSteps: v.optional(v.number()) },
  handler: async (_ctx, args) => {
    const steps = stepsFor(args.mode, args.maxSteps);
    return { maxSteps: steps, credits: estimateFor(args.mode, steps) };
  },
});
