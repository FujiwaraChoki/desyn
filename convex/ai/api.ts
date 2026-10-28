import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import {
  internalAction,
  internalMutation,
  internalQuery,
  type QueryCtx,
} from "../_generated/server";
import { eventViews, isTerminal, requireOwnRun, runView, workflowView } from "../lib/ai_runs";
import { answerAgentRun, cancelAgentRun, startAgentRun } from "../lib/ai_start";
import type { AiRunEventView, AiRunView, WorkflowView } from "../lib/api_ai";
import { principalValidator } from "../lib/api_principal";
import { errors } from "../lib/errors";
import { createAssetRun } from "./mediaJobs";
import type { ModelOption } from "./models";
import { cancelWorkflowFor, startWorkflowFor } from "./workflows";

// The AI backend seam of the Agent API (contract in convex/lib/api_ai.ts): internal functions the REST and
// MCP handlers call with a verified principal ({ userId, workspaceId } from the API key). Same rules as the
// app: design permission, plan features, routing, fair use and credits; foreign or malformed ids are 404.

const modeValidator = v.union(v.literal("edit"), v.literal("generate"), v.literal("critique"));

function designIdOf(ctx: QueryCtx, raw: string): Id<"designs"> {
  const id = ctx.db.normalizeId("designs", raw);
  if (!id) throw errors.notFound("Design");
  return id;
}

export const startRun = internalMutation({
  args: {
    principal: principalValidator,
    designId: v.string(),
    goal: v.string(),
    mode: v.optional(modeValidator),
    pageId: v.optional(v.string()),
    selection: v.optional(v.array(v.string())),
    model: v.optional(v.string()),
    maxSteps: v.optional(v.number()),
    maxCredits: v.optional(v.number()),
    requestKey: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<AiRunView> => {
    const designId = designIdOf(ctx, args.designId);
    const design = await ctx.db.get("designs", designId);
    if (!design || design.workspaceId !== args.principal.workspaceId)
      throw errors.notFound("Design");
    const run = await startAgentRun(ctx, {
      userId: args.principal.userId,
      designId,
      goal: args.goal,
      mode: args.mode ?? "edit",
      ...(args.pageId ? { pageId: args.pageId } : {}),
      ...(args.selection ? { selection: args.selection } : {}),
      ...(args.model ? { model: args.model } : {}),
      ...(args.maxSteps !== undefined ? { maxSteps: args.maxSteps } : {}),
      ...(args.maxCredits !== undefined ? { maxCredits: args.maxCredits } : {}),
      via: "api",
      ...(args.requestKey ? { requestKey: args.requestKey } : {}),
    });
    return runView(run);
  },
});

export const getRun = internalQuery({
  args: { principal: principalValidator, runId: v.string() },
  handler: async (ctx, args): Promise<AiRunView> =>
    runView(
      await requireOwnRun(ctx, args.runId, args.principal.userId, args.principal.workspaceId),
    ),
});

export const listEvents = internalQuery({
  args: { principal: principalValidator, runId: v.string(), after: v.number(), limit: v.number() },
  handler: async (ctx, args): Promise<{ items: AiRunEventView[]; next: number; done: boolean }> => {
    const run = await requireOwnRun(
      ctx,
      args.runId,
      args.principal.userId,
      args.principal.workspaceId,
    );
    const limit = Math.max(1, Math.min(500, args.limit));
    const items = await eventViews(ctx, run._id, args.after, limit);
    const next = items.at(-1)?.index ?? args.after;
    return { items, next, done: isTerminal(run.status) && next >= run.eventCount - 1 };
  },
});

export const answerRun = internalMutation({
  args: { principal: principalValidator, runId: v.string(), answer: v.string() },
  handler: async (ctx, args): Promise<AiRunView> => {
    const run = await requireOwnRun(
      ctx,
      args.runId,
      args.principal.userId,
      args.principal.workspaceId,
    );
    if (run.kind !== "agent") throw errors.conflict("The run is not waiting for an answer.");
    return runView(await answerAgentRun(ctx, run, args.answer));
  },
});

export const cancelRun = internalMutation({
  args: { principal: principalValidator, runId: v.string() },
  handler: async (ctx, args): Promise<AiRunView> => {
    const run = await requireOwnRun(
      ctx,
      args.runId,
      args.principal.userId,
      args.principal.workspaceId,
    );
    if (run.kind === "workflow" && run.workflowId) {
      const wf = await ctx.db.get("aiWorkflows", run.workflowId);
      if (wf) await cancelWorkflowFor(ctx, wf);
    } else {
      await cancelAgentRun(ctx, run);
    }
    return runView((await ctx.db.get("aiRuns", run._id)) as Doc<"aiRuns">);
  },
});

export const generateAsset = internalMutation({
  args: {
    principal: principalValidator,
    task: v.string(),
    prompt: v.optional(v.string()),
    assetId: v.optional(v.string()),
    maskAssetId: v.optional(v.string()),
    width: v.optional(v.number()),
    height: v.optional(v.number()),
    scale: v.optional(v.number()),
    style: v.optional(v.string()),
    designId: v.optional(v.string()),
    requestKey: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<AiRunView> => {
    const assetIdOf = (raw: string): Id<"assets"> => {
      const id = ctx.db.normalizeId("assets", raw);
      if (!id) throw errors.notFound("Asset");
      return id;
    };
    let designId: Id<"designs"> | undefined;
    if (args.designId) {
      designId = designIdOf(ctx, args.designId);
      const design = await ctx.db.get("designs", designId);
      if (!design || design.workspaceId !== args.principal.workspaceId)
        throw errors.notFound("Design");
    }
    const sources = [
      ...(args.assetId ? [assetIdOf(args.assetId)] : []),
      ...(args.maskAssetId ? [assetIdOf(args.maskAssetId)] : []),
    ];
    const input = {
      ...(args.prompt !== undefined ? { prompt: args.prompt } : {}),
      ...(args.width !== undefined ? { width: args.width } : {}),
      ...(args.height !== undefined ? { height: args.height } : {}),
      ...(args.scale !== undefined ? { factor: args.scale } : {}),
      ...(args.style !== undefined ? { style: args.style } : {}),
    };
    const { run } = await createAssetRun(
      ctx,
      args.principal.userId,
      {
        task: args.task,
        input: JSON.stringify(input),
        workspaceId: args.principal.workspaceId,
        ...(designId ? { designId } : {}),
        ...(sources.length ? { sourceAssetIds: sources } : {}),
      },
      { via: "api", sync: false, ...(args.requestKey ? { requestKey: args.requestKey } : {}) },
    );
    return runView(run);
  },
});

export const startWorkflow = internalMutation({
  args: {
    principal: principalValidator,
    type: v.string(),
    designId: v.optional(v.string()),
    input: v.string(),
    requestKey: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<WorkflowView> => {
    const wf = await startWorkflowFor(ctx, {
      userId: args.principal.userId,
      workspaceId: args.principal.workspaceId,
      type: args.type,
      ...(args.designId ? { designId: args.designId } : {}),
      input: args.input,
      via: "api",
      ...(args.requestKey ? { requestKey: args.requestKey } : {}),
    });
    return workflowView(wf);
  },
});

export const getWorkflow = internalQuery({
  args: { principal: principalValidator, workflowId: v.string() },
  handler: async (ctx, args): Promise<WorkflowView> => {
    const id = ctx.db.normalizeId("aiWorkflows", args.workflowId);
    const wf = id ? await ctx.db.get("aiWorkflows", id) : null;
    if (!wf || wf.userId !== args.principal.userId || wf.workspaceId !== args.principal.workspaceId)
      throw errors.notFound("Workflow");
    return workflowView(wf);
  },
});

export const listModels = internalAction({
  args: { principal: principalValidator, task: v.optional(v.string()) },
  handler: async (ctx, args): Promise<{ tasks: Record<string, ModelOption[]> }> =>
    await ctx.runAction(internal.ai.models.listForUser, {
      userId: args.principal.userId,
      ...(args.task ? { task: args.task } : {}),
    }),
});
