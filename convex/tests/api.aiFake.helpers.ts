import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "../_generated/server";
import type { AiRunEventView, AiRunView, WorkflowView } from "../lib/api_ai";
import { principalValidator } from "../lib/api_principal";
import { appError, errors } from "../lib/errors";

// A stand-in for convex/ai/api.ts (the AI backend seam, see lib/api_ai.ts), registered as module "ai/api" in
// the AI API tests only. Runs are scripted: every listEvents call reveals one more event, so long-polling and
// SSE see events arrive over time; goals containing "ask" pause with a question, "busy" hits fair use.

interface FakeRun {
  view: AiRunView;
  workspaceId: string;
  events: AiRunEventView[];
  revealed: number;
}

const runs = new Map<string, FakeRun>();
const workflows = new Map<string, WorkflowView & { workspaceId: string }>();
const requestKeys = new Map<string, string>();
let counter = 0;

function own(runId: string, workspaceId: string): FakeRun {
  const run = runs.get(runId);
  if (!run || run.workspaceId !== workspaceId) throw errors.notFound("Run");
  return run;
}

function push(run: FakeRun, type: string, extra: Record<string, unknown> = {}) {
  run.events.push({ index: run.events.length, type, ts: Date.now(), runId: run.view.id, ...extra });
}

function finish(run: FakeRun, status: string, summary: string) {
  run.view = {
    ...run.view,
    status,
    finishedAt: Date.now(),
    updatedAt: Date.now(),
    question: null,
    result: { summary, transactions: 1 },
  };
  push(run, "done", { status, summary, steps: 3, credits: 2 });
}

function newRun(kind: AiRunView["kind"], workspaceId: string, extra: Partial<AiRunView>): FakeRun {
  counter++;
  const now = Date.now();
  const run: FakeRun = {
    workspaceId,
    revealed: 0,
    events: [],
    view: {
      id: `run${String(counter).padStart(9, "0")}`,
      kind,
      designId: null,
      status: "running",
      mode: null,
      goal: null,
      question: null,
      result: null,
      error: null,
      costCredits: 0,
      steps: 0,
      createdAt: now,
      updatedAt: now,
      finishedAt: null,
      ...extra,
    },
  };
  runs.set(run.view.id, run);
  return run;
}

export const startRun = internalMutation({
  args: {
    principal: principalValidator,
    designId: v.string(),
    goal: v.string(),
    mode: v.optional(v.string()),
    pageId: v.optional(v.string()),
    selection: v.optional(v.array(v.string())),
    model: v.optional(v.string()),
    maxSteps: v.optional(v.number()),
    maxCredits: v.optional(v.number()),
    requestKey: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<AiRunView> => {
    const designId = ctx.db.normalizeId("designs", args.designId);
    const design = designId ? await ctx.db.get("designs", designId) : null;
    if (!design || design.workspaceId !== args.principal.workspaceId)
      throw errors.notFound("Design");
    if (args.goal.includes("busy")) throw errors.rateLimited(4_000, "concurrency");
    const existing = args.requestKey ? requestKeys.get(args.requestKey) : undefined;
    if (existing) return (runs.get(existing) as FakeRun).view;
    const run = newRun("agent", args.principal.workspaceId, {
      designId: args.designId,
      goal: args.goal,
      mode: args.mode ?? "edit",
    });
    if (args.requestKey) requestKeys.set(args.requestKey, run.view.id);
    push(run, "start", {
      mode: run.view.mode,
      model: args.model ?? "openrouter:anthropic/claude-sonnet-5.5",
    });
    push(run, "tool-call", { callId: "c1", tool: "read_design", input: {} });
    push(run, "tool-result", { callId: "c1", tool: "read_design", ok: true, summary: "1 page" });
    if (args.goal.includes("ask")) {
      push(run, "question", { question: "Keep the price?", options: ["Yes", "No"] });
      run.view = {
        ...run.view,
        status: "needs-input",
        question: { question: "Keep the price?", options: ["Yes", "No"] },
      };
    } else {
      push(run, "text", { text: "Warming up the palette." });
      // A recoverable AgentEvent of type "error": it must reach SSE clients as data, not end the stream.
      push(run, "error", { message: "Image provider busy; retrying.", recoverable: true });
      finish(run, "completed", "Made it warmer.");
    }
    return run.view;
  },
});

export const getRun = internalQuery({
  args: { principal: principalValidator, runId: v.string() },
  handler: async (_ctx, args): Promise<AiRunView> =>
    own(args.runId, args.principal.workspaceId).view,
});

export const listEvents = internalQuery({
  args: { principal: principalValidator, runId: v.string(), after: v.number(), limit: v.number() },
  handler: async (_ctx, args) => {
    const run = own(args.runId, args.principal.workspaceId);
    run.revealed = Math.min(run.events.length, run.revealed + 1);
    const visible = run.events
      .slice(0, run.revealed)
      .filter((e) => e.index > args.after)
      .slice(0, args.limit);
    const last = visible.at(-1)?.index ?? args.after;
    const terminal = run.view.finishedAt !== null;
    return { items: visible, next: last, done: terminal && last >= run.events.length - 1 };
  },
});

export const answerRun = internalMutation({
  args: { principal: principalValidator, runId: v.string(), answer: v.string() },
  handler: async (_ctx, args): Promise<AiRunView> => {
    const run = own(args.runId, args.principal.workspaceId);
    if (run.view.status !== "needs-input")
      throw errors.conflict("The run is not waiting for an answer.");
    push(run, "text", { text: `Answer: ${args.answer}` });
    finish(run, "completed", `Done (${args.answer}).`);
    return run.view;
  },
});

export const cancelRun = internalMutation({
  args: { principal: principalValidator, runId: v.string() },
  handler: async (_ctx, args): Promise<AiRunView> => {
    const run = own(args.runId, args.principal.workspaceId);
    if (run.view.finishedAt === null) finish(run, "cancelled", "Cancelled.");
    return run.view;
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
  handler: async (_ctx, args): Promise<AiRunView> => {
    if (args.task === "image" && !args.prompt)
      throw errors.invalid("A prompt is required.", "prompt");
    const run = newRun("asset", args.principal.workspaceId, {
      goal: args.prompt ?? args.task,
      mode: args.task,
    });
    push(run, "progress", { label: "Generating" });
    run.view = {
      ...run.view,
      status: "completed",
      finishedAt: Date.now(),
      costCredits: 3,
      result: { assetId: "asset_fake", refId: "gen000000001" },
    };
    push(run, "done", { status: "completed", summary: "Generated.", steps: 1, credits: 3 });
    return run.view;
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
  handler: async (_ctx, args): Promise<WorkflowView> => {
    const input = JSON.parse(args.input) as { languages?: string[] };
    if (args.type === "localize" && !input.languages?.length) {
      throw appError("INVALID_ARGUMENT", "Pick at least one language.", {
        field: "input.languages",
      });
    }
    counter++;
    const now = Date.now();
    const wf = {
      id: `wf${String(counter).padStart(10, "0")}`,
      type: args.type,
      status: "running",
      designId: args.designId ?? null,
      progress: { done: 0, total: input.languages?.length ?? 1 },
      outputs: [],
      error: null,
      costCredits: 0,
      createdAt: now,
      updatedAt: now,
      finishedAt: null,
      workspaceId: args.principal.workspaceId,
    };
    workflows.set(wf.id, wf);
    const { workspaceId: _ws, ...view } = wf;
    return view;
  },
});

export const getWorkflow = internalQuery({
  args: { principal: principalValidator, workflowId: v.string() },
  handler: async (_ctx, args): Promise<WorkflowView> => {
    const wf = workflows.get(args.workflowId);
    if (!wf || wf.workspaceId !== args.principal.workspaceId) throw errors.notFound("Workflow");
    const { workspaceId: _ws, ...view } = wf;
    return view;
  },
});

export const listModels = internalAction({
  args: { principal: principalValidator, task: v.optional(v.string()) },
  handler: async (_ctx, args) => {
    const all = {
      agent: [
        {
          id: "openrouter:anthropic/claude-sonnet-5.5",
          label: "Sonnet 5.5",
          source: "server",
          default: true,
        },
      ],
      image: [{ id: "fal:fal-ai/flux", label: "FLUX", source: "server", default: true }],
    };
    if (args.task && !(args.task in all))
      throw appError("INVALID_ARGUMENT", "Unknown task.", { field: "task" });
    return { tasks: args.task ? { [args.task]: all[args.task as keyof typeof all] } : all };
  },
});
