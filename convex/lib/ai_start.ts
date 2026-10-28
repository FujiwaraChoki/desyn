import { type AiTask, estimateAgentRun, estimateCredits, type ModelPrefs } from "@desyn/ai";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import {
  type Availability,
  aiAccess,
  assertRoutable,
  availability,
  modelPrefs,
  parseOverride,
  requireFeatures,
} from "./ai_access";
import {
  type AgentMode,
  appendRunEvents,
  clip,
  isTerminal,
  MAX_ANSWER_CHARS,
  MAX_GOAL_CHARS,
  MEDIA_ALLOWANCE,
  type ReserveOutcome,
  type RunStatus,
  reserveSegment,
  segmentRefId,
  settleSegment,
  stepsFor,
  storedEvent,
} from "./ai_runs";
import { getDesignOrThrow, requireDesignWriter } from "./designs_access";
import { errors } from "./errors";
import { createLogger } from "./logger";
import type { FeatureKey } from "./plans";

// Lifecycle of agent runs inside mutations: start (plan gating, routing, fair use, credit reservation,
// scheduling), cancel, answer (resume after ask_user) and finish (settlement + final event). The agent loop
// itself runs in Node actions (convex/ai/agentNode.ts), chunked across scheduled actions.

export interface StartAgentInput {
  userId: string;
  designId: Id<"designs">;
  goal: string;
  mode: AgentMode;
  pageId?: string;
  selection?: string[];
  attachments?: Id<"assets">[];
  previousRunId?: Id<"aiRuns">;
  /** "provider:model" override for the agent route. */
  model?: string;
  maxSteps?: number;
  maxCredits?: number;
  via: "app" | "api";
  requestKey?: string;
}

const MAX_ATTACHMENTS = 10;
const MAX_SELECTION = 500;

/** Credits a run may spend at most: one turn per step plus a media allowance (or the caller's cap). */
export function runBudget(
  mode: AgentMode,
  maxSteps: number,
  turnBilling: string,
  maxCredits?: number,
) {
  if (maxCredits !== undefined) {
    if (!Number.isFinite(maxCredits) || maxCredits < 0)
      throw errors.invalid("maxCredits must be a positive number.", "maxCredits");
    return Math.floor(maxCredits);
  }
  const turns = turnBilling === "platform" ? maxSteps : 0;
  return turns + MEDIA_ALLOWANCE[mode];
}

/** Amount to hold for one segment: the run estimate, capped by what the run may still spend. */
export function segmentEstimate(
  run: Pick<
    Doc<"aiRuns">,
    "mode" | "maxSteps" | "steps" | "maxCredits" | "creditsUsed" | "billing"
  >,
  imageBilling: string,
): number {
  const remainingSteps = Math.max(1, run.maxSteps - run.steps);
  const billing = (run.billing ?? "platform") as "platform" | "byok" | "local";
  const estimate = estimateAgentRun({
    maxSteps: remainingSteps,
    billing,
    expectedAssets:
      run.mode === "generate"
        ? [{ action: "image", count: 2, billing: imageBilling as "platform" | "byok" | "local" }]
        : [],
  }).total;
  const cap =
    run.maxCredits === undefined ? estimate : Math.max(0, run.maxCredits - run.creditsUsed);
  return Math.max(0, Math.min(estimate, cap));
}

export function goalText(goal: string): string {
  const text = goal.trim();
  if (!text) throw errors.invalid("Describe what you want the AI to do.", "goal");
  return clip(text, MAX_GOAL_CHARS);
}

/**
 * One active agent per design: two loops editing the same layers would fight each other. A run waiting for
 * an answer is not active, but resuming it is checked the same way.
 */
async function assertNoActiveAgent(
  ctx: MutationCtx,
  designId: Id<"designs">,
  except?: Id<"aiRuns">,
): Promise<void> {
  const recent = await ctx.db
    .query("aiRuns")
    .withIndex("by_design_created", (q) => q.eq("designId", designId))
    .order("desc")
    .take(50);
  const busy = recent.some(
    (r) =>
      r._id !== except && r.kind === "agent" && (r.status === "queued" || r.status === "running"),
  );
  if (busy) {
    throw errors.conflict(
      "The AI is already working on this design. Wait for it or stop it first.",
    );
  }
}

/**
 * Tasks whose provider can bill platform credits during an agent run (the loop itself, its helper models and
 * every media tool). Built-in implementations cost nothing.
 */
const AGENT_BILLED_TASKS: readonly AiTask[] = [
  "agent",
  "plan",
  "critique",
  "vision",
  "svg",
  "copy",
  "translate",
  "image",
  "imageText",
  "vector",
  "bgRemove",
  "inpaint",
  "outpaint",
  "upscale",
  "mockup",
  "trace",
  "video",
];

/**
 * Whether a run can be reserved as BYOK (no credits held): only when nothing it may call bills the platform.
 * A BYOK reservation commits at 0 credits, so being wrong here would make platform usage free.
 */
export function agentRunIsByok(avail: Availability, prefs: ModelPrefs): boolean {
  return AGENT_BILLED_TASKS.every((task) => {
    const route = avail.route(task, prefs);
    // Unavailable tasks cannot be called at all, so they cannot bill either.
    return !route.available || route.ref.startsWith("builtin:") || route.billing !== "platform";
  });
}

/** Starts an agent run: checks everything that can fail before anything runs, then schedules chunk 0. */
export async function startAgentRun(
  ctx: MutationCtx,
  input: StartAgentInput,
): Promise<Doc<"aiRuns">> {
  if (input.requestKey) {
    const existing = await ctx.db
      .query("aiRuns")
      .withIndex("by_requestKey", (q) => q.eq("requestKey", input.requestKey))
      .first();
    if (existing && existing.userId === input.userId) return existing;
  }
  const design = await getDesignOrThrow(ctx, input.designId);
  const access = await requireDesignWriter(
    ctx,
    design,
    input.mode === "critique" ? "view" : "edit",
    {
      userId: input.userId,
    },
  );
  if (access.via !== "member")
    throw errors.forbidden("Only workspace members can run the AI here.");
  const features: FeatureKey[] = ["ai.agent"];
  if (input.mode === "generate") features.push("ai.generateDesign");
  await requireFeatures(ctx, input.userId, features);

  const goal = goalText(input.goal);
  if ((input.selection?.length ?? 0) > MAX_SELECTION)
    throw errors.invalid("Too many selected layers.", "selection");
  if ((input.attachments?.length ?? 0) > MAX_ATTACHMENTS)
    throw errors.invalid(`Attach at most ${MAX_ATTACHMENTS} files.`, "attachments");
  for (const assetId of input.attachments ?? []) {
    const asset = await ctx.db.get("assets", assetId);
    if (!asset || asset.workspaceId !== design.workspaceId || asset.status !== "ready")
      throw errors.notFound("Attachment");
  }
  if (input.previousRunId) {
    const previous = await ctx.db.get("aiRuns", input.previousRunId);
    if (!previous || previous.userId !== input.userId || previous.designId !== design._id)
      throw errors.notFound("Previous run");
  }

  const ai = await aiAccess(ctx, input.userId);
  const prefs: ModelPrefs = modelPrefs(
    ai.settings,
    input.model ? { task: "agent", ref: parseOverride(input.model) } : undefined,
  );
  const avail = availability(ai);
  if (prefs.user?.agent && input.model && !avail.providers.includes(prefs.user.agent.provider)) {
    // An explicit per-run model is strict: never silently fall back to another provider.
    throw errors.notConfigured(`The provider "${prefs.user.agent.provider}"`);
  }
  const route = assertRoutable(avail, "agent", prefs);
  const imageRoute = avail.route("image", prefs);
  const byok = agentRunIsByok(avail, prefs);

  await assertNoActiveAgent(ctx, design._id);

  const maxSteps =
    input.maxSteps === undefined ? stepsFor(input.mode) : stepsFor(input.mode, input.maxSteps);
  const maxCredits = runBudget(input.mode, maxSteps, route.billing, input.maxCredits);
  const now = Date.now();
  const runId = await ctx.db.insert("aiRuns", {
    kind: "agent",
    userId: input.userId,
    workspaceId: design.workspaceId,
    designId: design._id,
    mode: input.mode,
    goal,
    status: "queued",
    via: input.via,
    ...(input.requestKey ? { requestKey: input.requestKey } : {}),
    ...(input.pageId ? { pageId: input.pageId } : {}),
    ...(input.selection?.length ? { selection: input.selection } : {}),
    ...(input.attachments?.length ? { attachments: input.attachments } : {}),
    ...(input.previousRunId ? { previousRunId: input.previousRunId } : {}),
    ...(input.model ? { modelOverride: input.model } : {}),
    model: route.ref,
    billing: route.billing,
    maxSteps,
    maxCredits,
    steps: 0,
    chunk: 0,
    restarts: 0,
    creditsUsed: 0,
    creditsCharged: 0,
    segments: 0,
    transactions: 0,
    eventCount: 0,
    createdAt: now,
    updatedAt: now,
  });
  let run = (await ctx.db.get("aiRuns", runId)) as Doc<"aiRuns">;
  const reserved = await reserveSegment(ctx, {
    userId: input.userId,
    refId: segmentRefId("run", runId, 0),
    cost: segmentEstimate(run, imageRoute.billing),
    byok,
  });
  if (!reserved.ok) throw reserved.error; // rolls back the insert
  await ctx.db.patch("aiRuns", runId, {
    reservation: { refId: reserved.refId, amount: reserved.amount, usedAtStart: 0 },
    segments: 1,
  });
  const queued = storedEvent({
    type: "progress",
    label: "Queued",
    ...(reserved.throttled
      ? { detail: `Fair use: starting in ${Math.ceil(reserved.delayMs / 1000)} s` }
      : {}),
  });
  const count = await appendRunEvents(ctx, run, [queued]);
  await ctx.db.patch("aiRuns", runId, { eventCount: count });
  await ctx.scheduler.runAfter(reserved.delayMs, internal.ai.agentNode.runChunk, {
    runId,
    chunk: 0,
  });
  run = (await ctx.db.get("aiRuns", runId)) as Doc<"aiRuns">;
  const log = createLogger(ctx, { fn: "ai.startRun", runId, userId: input.userId });
  log.info("agent run queued", {
    mode: input.mode,
    model: route.ref,
    billing: route.billing,
    maxSteps,
    maxCredits,
    via: input.via,
    throttled: reserved.throttled,
  });
  await log.flush();
  return run;
}

/** Re-reserves credits for a run that continues (after a yield, a restart or an answer). */
export async function reserveForRun(ctx: MutationCtx, run: Doc<"aiRuns">): Promise<ReserveOutcome> {
  const ai = await aiAccess(ctx, run.userId);
  const avail = availability(ai);
  const prefs = modelPrefs(
    ai.settings,
    run.modelOverride ? { task: "agent", ref: parseOverride(run.modelOverride) } : undefined,
  );
  const imageRoute = avail.route("image", prefs);
  // Settings may have changed since the start: decide from the current routing, never from the old run.
  const byok = run.billing !== "platform" && agentRunIsByok(avail, prefs);
  const outcome = await reserveSegment(ctx, {
    userId: run.userId,
    refId: segmentRefId("run", run._id, run.segments),
    cost: segmentEstimate(run, imageRoute.billing),
    byok,
  });
  if (outcome.ok) {
    await ctx.db.patch("aiRuns", run._id, {
      reservation: { refId: outcome.refId, amount: outcome.amount, usedAtStart: run.creditsUsed },
      segments: run.segments + 1,
      updatedAt: Date.now(),
    });
  }
  return outcome;
}

/** Settles the run's open reservation with what it used since; returns the credits charged. */
export async function settleRun(ctx: MutationCtx, run: Doc<"aiRuns">): Promise<number> {
  if (!run.reservation) return 0;
  const charged = await settleSegment(ctx, run.reservation, run.creditsUsed);
  await ctx.db.patch("aiRuns", run._id, {
    reservation: undefined,
    creditsCharged: run.creditsCharged + charged,
  });
  return charged;
}

export interface FinishInput {
  status: Exclude<RunStatus, "queued" | "running" | "needs-input">;
  summary: string;
  error?: string;
  errorCode?: string;
  result?: Record<string, unknown>;
  /** Append a `done` event (when the agent loop did not emit one itself). */
  emitDone: boolean;
}

/** Ends a run: settles credits, records the result and (optionally) the final `done` event. Idempotent. */
export async function finishRun(
  ctx: MutationCtx,
  runId: Id<"aiRuns">,
  input: FinishInput,
): Promise<Doc<"aiRuns">> {
  const run = await ctx.db.get("aiRuns", runId);
  if (!run) throw errors.notFound("Run");
  if (isTerminal(run.status)) return run;
  await settleRun(ctx, run);
  const fresh = (await ctx.db.get("aiRuns", runId)) as Doc<"aiRuns">;
  const now = Date.now();
  let eventCount = fresh.eventCount;
  if (input.emitDone) {
    const events = [];
    if (input.error) {
      events.push(
        storedEvent({
          type: "error",
          message: input.error,
          ...(input.errorCode ? { code: input.errorCode } : {}),
          recoverable: false,
        }),
      );
    }
    events.push(
      storedEvent({
        type: "done",
        status: input.status,
        summary: input.summary,
        steps: fresh.steps,
        credits: fresh.creditsUsed,
        at: now,
      }),
    );
    eventCount = await appendRunEvents(ctx, fresh, events);
  }
  await ctx.db.patch("aiRuns", runId, {
    status: input.status,
    result: { ...(fresh.result ?? {}), ...(input.result ?? {}), summary: input.summary },
    ...(input.error ? { error: clip(input.error, 2000) } : {}),
    ...(input.errorCode ? { errorCode: input.errorCode } : {}),
    question: undefined,
    answer: undefined,
    leaseUntil: undefined,
    cancelRequested: undefined,
    eventCount,
    finishedAt: now,
    retention: 0,
    updatedAt: now,
  });
  const done = (await ctx.db.get("aiRuns", runId)) as Doc<"aiRuns">;
  if (done.workflowId === undefined && done.kind === "agent") {
    const log = createLogger(ctx, { fn: "ai.finishRun", runId, userId: done.userId });
    log.info("agent run finished", {
      status: done.status,
      steps: done.steps,
      credits: done.creditsUsed,
      charged: done.creditsCharged,
      transactions: done.transactions,
    });
    await log.flush();
  }
  return done;
}

/** Cancels a run: immediately when nothing is running, otherwise by flagging the running action. */
export async function cancelAgentRun(ctx: MutationCtx, run: Doc<"aiRuns">): Promise<Doc<"aiRuns">> {
  if (isTerminal(run.status)) return run;
  const now = Date.now();
  const alive = run.status === "running" && run.leaseUntil !== undefined && run.leaseUntil > now;
  if (alive) {
    await ctx.db.patch("aiRuns", run._id, { cancelRequested: true, updatedAt: now });
    return (await ctx.db.get("aiRuns", run._id)) as Doc<"aiRuns">;
  }
  // Queued, waiting for input, or between chunks: nothing to interrupt. Invalidate pending schedules.
  await ctx.db.patch("aiRuns", run._id, { chunk: run.chunk + 1 });
  return await finishRun(ctx, run._id, {
    status: "cancelled",
    summary:
      run.transactions > 0
        ? `Stopped. ${run.transactions} change(s) were applied before stopping.`
        : "Stopped before making changes.",
    emitDone: true,
  });
}

/** Resumes a run that asked the user a question. */
export async function answerAgentRun(
  ctx: MutationCtx,
  run: Doc<"aiRuns">,
  answer: string,
): Promise<Doc<"aiRuns">> {
  if (run.status !== "needs-input") throw errors.conflict("The run is not waiting for an answer.");
  const text = answer.trim();
  if (!text) throw errors.invalid("Write an answer.", "answer");
  if (run.designId) await assertNoActiveAgent(ctx, run.designId, run._id);
  const now = Date.now();
  const next = { ...run, status: "queued" as const };
  const reserved = await reserveForRun(ctx, next);
  if (!reserved.ok) throw reserved.error;
  const fresh = (await ctx.db.get("aiRuns", run._id)) as Doc<"aiRuns">;
  const count = await appendRunEvents(ctx, fresh, [
    storedEvent({ type: "answer", answer: clip(text, MAX_ANSWER_CHARS) }),
  ]);
  await ctx.db.patch("aiRuns", run._id, {
    status: "queued",
    answer: clip(text, MAX_ANSWER_CHARS),
    chunk: run.chunk + 1,
    eventCount: count,
    updatedAt: now,
  });
  await ctx.scheduler.runAfter(reserved.delayMs, internal.ai.agentNode.runChunk, {
    runId: run._id,
    chunk: run.chunk + 1,
  });
  return (await ctx.db.get("aiRuns", run._id)) as Doc<"aiRuns">;
}

/** Plain estimate shown before starting (UI "≈ N credits"). */
export function estimateFor(mode: AgentMode, maxSteps: number): number {
  return estimateCredits([
    { action: "agent.turn", count: maxSteps },
    ...(mode === "generate" ? [{ action: "image" as const, count: 2 }] : []),
  ]).total;
}
