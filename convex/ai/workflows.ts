import { startWorkflow as createWorkflowState, type WorkflowState } from "@desyn/ai";
import { createDesign, type Design, getPreset, isDesignKind, type PagePreset } from "@desyn/schema";
import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
  mutation,
  query,
} from "../_generated/server";
import { exportView, requestExportFor } from "../exports/exports";
import {
  aiAccess,
  assertRoutable,
  availability,
  isWorkflowType,
  modelPrefs,
  requireFeatures,
  WORKFLOW_FEATURES,
  type WorkflowType,
} from "../lib/ai_access";
import { aiBrandKit, brandKitForDesign, defaultBrandKit } from "../lib/ai_brand";
import {
  appendRunEvents,
  clip,
  isTerminal,
  LEASE_MS,
  reserveSegment,
  resumeAfterRefusal,
  segmentRefId,
  settleSegment,
  storedEvent,
  workflowAppView,
} from "../lib/ai_runs";
import { finishRun } from "../lib/ai_start";
import { getDesignOrThrow, requireDesignPermission } from "../lib/designs_access";
import { insertDesignDocument } from "../lib/designs_create";
import { pageCountOf } from "../lib/designs_doc";
import { SvgSanitizeError, sanitizeNodesMarkup } from "../lib/designs_svg";
import { copyWithFreshIds } from "../lib/designs_templates";
import { assertLimit, getWorkspacePlan } from "../lib/entitlements";
import { env } from "../lib/env";
import { appError, errors, isAppError } from "../lib/errors";
import { requireMember, requireUser } from "../lib/guards";
import { createLogger } from "../lib/logger";
import { PLANS } from "../lib/plans";
import { incrementUsage } from "../lib/usage";
import { aiWorkflowTypeValidator } from "../tables/ai";

// Durable AI workflows (campaign, variants, resize, localize, bulk, exportBundle; SPEC §7). The workflow is a
// @desyn/ai step machine whose JSON state lives in `aiWorkflows`; one scheduled Node action
// (workflowsNode.advance) runs one step, and each step reserves and settles its own credits. A companion
// run (kind "workflow") carries the progress events, so clients follow workflows like agent runs.

const MAX_INPUT_BYTES = 512_000;
const STATE_INLINE_MAX = 800_000;

/** Text tasks a workflow needs a provider for (checked before it starts). */
const WORKFLOW_ROUTES: Record<WorkflowType, ("agent" | "plan" | "translate" | "copy")[]> = {
  campaign: ["plan", "agent"],
  variants: ["copy", "agent"],
  resize: [],
  localize: ["translate"],
  bulk: [],
  exportBundle: [],
};

interface StartWorkflowInput {
  userId: string;
  workspaceId?: Id<"workspaces">;
  type: string;
  designId?: string;
  /** JSON of the workflow input. */
  input: string;
  via: "app" | "api" | "agent";
  requestKey?: string;
}

function workflowLabel(type: WorkflowType): string {
  return {
    campaign: "Campaign",
    variants: "Variants",
    resize: "Magic resize",
    localize: "Localize",
    bulk: "Bulk create",
    exportBundle: "Export bundle",
  }[type];
}

/** Validation error of a workflow input (zod issues) as INVALID_ARGUMENT with the first field path. */
function inputError(err: unknown): never {
  const issues = (err as { issues?: { path: (string | number)[]; message: string }[] }).issues;
  if (Array.isArray(issues) && issues.length > 0) {
    const first = issues[0] as { path: (string | number)[]; message: string };
    const field = ["input", ...first.path].join(".");
    throw appError("INVALID_ARGUMENT", `${field}: ${first.message}`, { field });
  }
  throw errors.invalid(
    err instanceof Error ? err.message : "The workflow input is not valid.",
    "input",
  );
}

export async function startWorkflowFor(
  ctx: MutationCtx,
  args: StartWorkflowInput,
): Promise<Doc<"aiWorkflows">> {
  if (args.requestKey) {
    const existing = await ctx.db
      .query("aiWorkflows")
      .withIndex("by_requestKey", (q) => q.eq("requestKey", args.requestKey))
      .first();
    if (existing && existing.userId === args.userId) return existing;
  }
  if (!isWorkflowType(args.type)) throw errors.invalid(`Unknown workflow "${args.type}".`, "type");
  const type = args.type;
  if (args.input.length > MAX_INPUT_BYTES)
    throw errors.invalid("The workflow input is too large.", "input");
  let input: Record<string, unknown>;
  try {
    const parsed = JSON.parse(args.input) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error("not an object");
    input = parsed as Record<string, unknown>;
  } catch {
    throw errors.invalid("The workflow input must be a JSON object.", "input");
  }

  // Source design(s): every id must be a design of the workspace the caller can view.
  let workspaceId = args.workspaceId;
  let designId: Id<"designs"> | undefined;
  const rawDesign =
    args.designId ?? (typeof input.designId === "string" ? input.designId : undefined);
  if (rawDesign) {
    const id = ctx.db.normalizeId("designs", rawDesign);
    if (!id) throw errors.notFound("Design");
    const design = await getDesignOrThrow(ctx, id);
    if (workspaceId && design.workspaceId !== workspaceId) throw errors.notFound("Design");
    await requireDesignPermission(ctx, design, "view", { userId: args.userId });
    workspaceId = design.workspaceId;
    designId = id;
    input.designId = id;
  }
  if (Array.isArray(input.designIds)) {
    for (const raw of input.designIds) {
      const id = typeof raw === "string" ? ctx.db.normalizeId("designs", raw) : null;
      const design = id ? await ctx.db.get("designs", id) : null;
      if (
        !design ||
        design.state === "creating" ||
        (workspaceId && design.workspaceId !== workspaceId)
      )
        throw errors.notFound("Design");
      await requireDesignPermission(ctx, design, "view", { userId: args.userId });
      workspaceId = design.workspaceId;
    }
  }
  if (!workspaceId) throw errors.invalid("Choose a workspace or a source design.", "designId");
  // Workflows create designs: editors only.
  await requireMember(ctx, workspaceId, "editor", { userId: args.userId });
  await requireFeatures(ctx, args.userId, WORKFLOW_FEATURES[type]);

  let state: WorkflowState;
  try {
    state = createWorkflowState(type, input);
  } catch (err) {
    inputError(err);
  }
  const ai = await aiAccess(ctx, args.userId);
  const prefs = modelPrefs(ai.settings);
  const avail = availability(ai);
  for (const task of WORKFLOW_ROUTES[type]) assertRoutable(avail, task, prefs);
  if (type === "exportBundle" && !env.has("RENDER_WORKER_URL"))
    throw errors.notConfigured("Export rendering");

  const now = Date.now();
  const total = state.steps.length;
  const runId = await ctx.db.insert("aiRuns", {
    kind: "workflow",
    userId: args.userId,
    workspaceId,
    ...(designId ? { designId } : {}),
    mode: type,
    goal: `${workflowLabel(type)} workflow`,
    status: "queued",
    via: args.via === "agent" ? "workflow" : args.via,
    maxSteps: total,
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
  const json = JSON.stringify(state);
  if (json.length > STATE_INLINE_MAX)
    throw errors.invalid("The workflow input is too large.", "input");
  const workflowId = await ctx.db.insert("aiWorkflows", {
    type,
    userId: args.userId,
    workspaceId,
    ...(designId ? { designId } : {}),
    status: "queued",
    via: args.via,
    ...(args.requestKey ? { requestKey: args.requestKey } : {}),
    runId,
    state: json,
    progress: { done: 0, total },
    outputs: [],
    creditsEstimated: state.creditsEstimated,
    creditsUsed: 0,
    creditsCharged: 0,
    tick: 0,
    restarts: 0,
    createdAt: now,
    updatedAt: now,
  });
  const run = (await ctx.db.get("aiRuns", runId)) as Doc<"aiRuns">;
  const count = await appendRunEvents(ctx, run, [
    storedEvent({
      type: "progress",
      label: `${workflowLabel(type)} queued`,
      detail: `${total} step(s), about ${state.creditsEstimated} credit(s)`,
    }),
  ]);
  await ctx.db.patch("aiRuns", runId, { workflowId, eventCount: count });
  await ctx.scheduler.runAfter(0, internal.ai.workflowsNode.advance, { workflowId, tick: 0 });
  const log = createLogger(ctx, { fn: "ai.startWorkflow", workflowId, userId: args.userId });
  log.info("workflow queued", {
    type,
    steps: total,
    estimate: state.creditsEstimated,
    via: args.via,
  });
  await log.flush();
  return (await ctx.db.get("aiWorkflows", workflowId)) as Doc<"aiWorkflows">;
}

/** Cancels a workflow: at once when no step is running, otherwise between steps. */
export async function cancelWorkflowFor(
  ctx: MutationCtx,
  wf: Doc<"aiWorkflows">,
): Promise<Doc<"aiWorkflows">> {
  if (wf.status === "completed" || wf.status === "failed" || wf.status === "cancelled") return wf;
  const now = Date.now();
  const alive = wf.leaseUntil !== undefined && wf.leaseUntil > now;
  if (alive) {
    await ctx.db.patch("aiWorkflows", wf._id, { cancelRequested: true, updatedAt: now });
    await ctx.db.patch("aiRuns", wf.runId, { cancelRequested: true, updatedAt: now });
    return (await ctx.db.get("aiWorkflows", wf._id)) as Doc<"aiWorkflows">;
  }
  await closeWorkflow(ctx, wf, "cancelled", undefined);
  return (await ctx.db.get("aiWorkflows", wf._id)) as Doc<"aiWorkflows">;
}

/** Final state of a workflow and its companion run (settles any open step reservation). */
async function closeWorkflow(
  ctx: MutationCtx,
  wf: Doc<"aiWorkflows">,
  status: "completed" | "failed" | "cancelled",
  error: string | undefined,
): Promise<void> {
  let charged = 0;
  if (wf.reservation) charged = await settleSegment(ctx, wf.reservation, wf.creditsUsed);
  const now = Date.now();
  await ctx.db.patch("aiWorkflows", wf._id, {
    status,
    ...(error ? { error: clip(error, 2000) } : {}),
    reservation: undefined,
    leaseUntil: undefined,
    cancelRequested: undefined,
    creditsCharged: wf.creditsCharged + charged,
    tick: wf.tick + 1,
    finishedAt: now,
    updatedAt: now,
  });
  await ctx.db.patch("aiRuns", wf.runId, {
    creditsUsed: wf.creditsUsed,
    creditsCharged: wf.creditsCharged + charged,
    steps: wf.progress.done,
  });
  const summary =
    status === "completed"
      ? `${workflowLabel(wf.type)} finished: ${wf.outputs.length} result(s).`
      : status === "cancelled"
        ? `${workflowLabel(wf.type)} stopped after ${wf.progress.done} of ${wf.progress.total} step(s).`
        : `${workflowLabel(wf.type)} failed${error ? `: ${error}` : "."}`;
  await finishRun(ctx, wf.runId, {
    status,
    summary,
    ...(error ? { error } : {}),
    result: { workflowId: wf._id, outputs: wf.outputs.length },
    emitDone: true,
  });
}

// --- public API -----------------------------------------------------------------------------------------------

export const start = mutation({
  args: {
    type: aiWorkflowTypeValidator,
    designId: v.optional(v.id("designs")),
    workspaceId: v.optional(v.id("workspaces")),
    /** JSON object with the workflow input (see @desyn/ai workflows). */
    input: v.string(),
  },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx, { verified: true });
    const wf = await startWorkflowFor(ctx, {
      userId: user.userId,
      ...(args.workspaceId ? { workspaceId: args.workspaceId } : {}),
      type: args.type,
      ...(args.designId ? { designId: args.designId } : {}),
      input: args.input,
      via: "app",
    });
    return { workflowId: wf._id, runId: wf.runId, estimatedCredits: wf.creditsEstimated };
  },
});

export const cancel = mutation({
  args: { workflowId: v.id("aiWorkflows") },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const wf = await ctx.db.get("aiWorkflows", args.workflowId);
    if (!wf || wf.userId !== user.userId) throw errors.notFound("Workflow");
    return workflowAppView(await cancelWorkflowFor(ctx, wf));
  },
});

/** Workflow status (reactive): progress, outputs (created design ids), credits. */
export const status = query({
  args: { workflowId: v.id("aiWorkflows") },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const wf = await ctx.db.get("aiWorkflows", args.workflowId);
    if (!wf || wf.userId !== user.userId) throw errors.notFound("Workflow");
    return workflowAppView(wf);
  },
});

export const list = query({
  args: { workspaceId: v.optional(v.id("workspaces")), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const limit = Math.max(1, Math.min(100, args.limit ?? 20));
    const rows = await ctx.db
      .query("aiWorkflows")
      .withIndex("by_user_created", (q) => q.eq("userId", user.userId))
      .order("desc")
      .take(args.workspaceId ? limit * 4 : limit);
    return rows
      .filter((w) => !args.workspaceId || w.workspaceId === args.workspaceId)
      .slice(0, limit)
      .map(workflowAppView);
  },
});

// --- internal: started by the agent's run_workflow tool -------------------------------------------------------

export const startFromAgent = internalMutation({
  args: { runId: v.id("aiRuns"), type: v.string(), input: v.string() },
  handler: async (ctx, args) => {
    const run = await ctx.db.get("aiRuns", args.runId);
    if (!run) throw errors.notFound("Run");
    const wf = await startWorkflowFor(ctx, {
      userId: run.userId,
      workspaceId: run.workspaceId,
      type: args.type,
      input: args.input,
      via: "agent",
    });
    return {
      workflowId: wf._id as string,
      estimatedCredits: wf.creditsEstimated,
      message: "It runs in the background; progress shows in the Workflows panel.",
    };
  },
});

// --- internal: step lifecycle (workflowsNode.advance) ---------------------------------------------------------

/** Claims step `tick`: reserves its credits and returns the state and the user's AI context. */
export const beginStep = internalMutation({
  args: { workflowId: v.id("aiWorkflows"), tick: v.number() },
  handler: async (ctx, args) => {
    const wf = await ctx.db.get("aiWorkflows", args.workflowId);
    if (!wf || wf.tick !== args.tick) return null;
    if (wf.status === "completed" || wf.status === "failed" || wf.status === "cancelled")
      return null;
    const now = Date.now();
    if (wf.leaseUntil !== undefined && wf.leaseUntil > now) return null;
    if (wf.cancelRequested) {
      await closeWorkflow(ctx, wf, "cancelled", undefined);
      return null;
    }
    if (!wf.reservation) {
      const pending = Math.max(1, wf.progress.total - wf.progress.done);
      const share = Math.max(
        1,
        Math.ceil(Math.max(0, wf.creditsEstimated - wf.creditsUsed) / pending),
      );
      try {
        const reserved = await reserveSegment(ctx, {
          userId: wf.userId,
          refId: segmentRefId("wf", wf._id, wf.tick),
          cost: share,
          byok: false,
        });
        if (!reserved.ok) {
          const next = resumeAfterRefusal(reserved.error);
          if ("stop" in next) {
            await closeWorkflow(ctx, wf, "failed", next.stop);
            return null;
          }
          // Touch the workflow so the stale-run reaper does not mistake the wait for a dead step.
          await ctx.db.patch("aiWorkflows", wf._id, { updatedAt: now });
          await ctx.scheduler.runAfter(next.retryInMs, internal.ai.workflowsNode.advance, args);
          return null;
        }
        await ctx.db.patch("aiWorkflows", wf._id, {
          reservation: {
            refId: reserved.refId,
            amount: reserved.amount,
            usedAtStart: wf.creditsUsed,
          },
        });
        if (reserved.delayMs > 0) {
          await ctx.scheduler.runAfter(reserved.delayMs, internal.ai.workflowsNode.advance, args);
          return null;
        }
      } catch (err) {
        if (!isAppError(err)) throw err;
        await closeWorkflow(ctx, wf, "failed", (err.data as { message: string }).message);
        return null;
      }
    }
    await ctx.db.patch("aiWorkflows", wf._id, {
      status: "running",
      leaseUntil: now + LEASE_MS,
      updatedAt: now,
    });
    const run = await ctx.db.get("aiRuns", wf.runId);
    if (run && run.status === "queued") {
      await ctx.db.patch("aiRuns", wf.runId, { status: "running", startedAt: now, updatedAt: now });
    }
    const access = await aiAccess(ctx, wf.userId);
    return {
      workflow: {
        id: wf._id,
        type: wf.type,
        userId: wf.userId,
        workspaceId: wf.workspaceId,
        runId: wf.runId,
        tick: wf.tick,
        state: wf.state ?? null,
        stateId: wf.stateId ?? null,
      },
      settings: access.settings,
      byokAllowed: access.byokAllowed,
      localAllowed: access.localAllowed,
    };
  },
});

/** Stores the state after a step, settles the step's credits and schedules the next step. */
export const endStep = internalMutation({
  args: {
    workflowId: v.id("aiWorkflows"),
    tick: v.number(),
    state: v.optional(v.string()),
    stateId: v.optional(v.id("_storage")),
    status: v.union(
      v.literal("running"),
      v.literal("completed"),
      v.literal("failed"),
      v.literal("cancelled"),
    ),
    progress: v.object({ done: v.number(), total: v.number() }),
    outputs: v.array(v.any()),
    creditsUsed: v.number(),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const wf = await ctx.db.get("aiWorkflows", args.workflowId);
    if (
      !wf ||
      wf.tick !== args.tick ||
      wf.status === "completed" ||
      wf.status === "failed" ||
      wf.status === "cancelled"
    ) {
      if (args.stateId) await ctx.storage.delete(args.stateId);
      return null;
    }
    if (wf.stateId && wf.stateId !== args.stateId) await ctx.storage.delete(wf.stateId);
    let charged = 0;
    if (wf.reservation) charged = await settleSegment(ctx, wf.reservation, args.creditsUsed);
    const now = Date.now();
    await ctx.db.patch("aiWorkflows", wf._id, {
      ...(args.state !== undefined ? { state: args.state, stateId: undefined } : {}),
      ...(args.stateId ? { stateId: args.stateId, state: undefined } : {}),
      progress: args.progress,
      outputs: args.outputs,
      creditsUsed: args.creditsUsed,
      creditsCharged: wf.creditsCharged + charged,
      reservation: undefined,
      leaseUntil: undefined,
      tick: wf.tick + 1,
      updatedAt: now,
    });
    await ctx.db.patch("aiRuns", wf.runId, {
      steps: args.progress.done,
      maxSteps: args.progress.total,
      creditsUsed: args.creditsUsed,
      creditsCharged: wf.creditsCharged + charged,
      updatedAt: now,
    });
    const fresh = (await ctx.db.get("aiWorkflows", wf._id)) as Doc<"aiWorkflows">;
    const cancelled = fresh.cancelRequested === true || args.status === "cancelled";
    if (args.status === "completed" || args.status === "failed" || cancelled) {
      await closeWorkflow(
        ctx,
        { ...fresh, tick: fresh.tick - 1 },
        cancelled ? "cancelled" : args.status === "completed" ? "completed" : "failed",
        args.error,
      );
      return null;
    }
    await ctx.scheduler.runAfter(0, internal.ai.workflowsNode.advance, {
      workflowId: wf._id,
      tick: wf.tick + 1,
    });
    return null;
  },
});

/** A step crashed before producing a state (the action threw): retry later or fail after a few attempts. */
export const stepCrashed = internalMutation({
  args: { workflowId: v.id("aiWorkflows"), tick: v.number(), error: v.string() },
  handler: async (ctx, args) => {
    const wf = await ctx.db.get("aiWorkflows", args.workflowId);
    if (!wf || wf.tick !== args.tick || isTerminalWorkflow(wf)) return null;
    if (wf.restarts + 1 >= 3) {
      await closeWorkflow(ctx, wf, "failed", args.error);
      return null;
    }
    await ctx.db.patch("aiWorkflows", wf._id, {
      restarts: wf.restarts + 1,
      leaseUntil: undefined,
      tick: wf.tick + 1,
      updatedAt: Date.now(),
    });
    await ctx.scheduler.runAfter(15_000 * (wf.restarts + 1), internal.ai.workflowsNode.advance, {
      workflowId: wf._id,
      tick: wf.tick + 1,
    });
    return null;
  },
});

function isTerminalWorkflow(wf: Doc<"aiWorkflows">): boolean {
  return wf.status === "completed" || wf.status === "failed" || wf.status === "cancelled";
}

export const pollCancel = internalQuery({
  args: { workflowId: v.id("aiWorkflows") },
  handler: async (ctx, args): Promise<boolean> => {
    const wf = await ctx.db.get("aiWorkflows", args.workflowId);
    return !wf || wf.cancelRequested === true || isTerminalWorkflow(wf);
  },
});

/** Appends progress events to the companion run (renews the step lease). */
export const pushEvents = internalMutation({
  args: {
    workflowId: v.id("aiWorkflows"),
    events: v.array(v.object({ type: v.string(), ts: v.number(), payload: v.string() })),
  },
  handler: async (ctx, args): Promise<{ stop: boolean }> => {
    const wf = await ctx.db.get("aiWorkflows", args.workflowId);
    if (!wf) return { stop: true };
    const run = await ctx.db.get("aiRuns", wf.runId);
    const now = Date.now();
    if (run && !isTerminal(run.status) && args.events.length > 0) {
      const count = await appendRunEvents(ctx, run, args.events);
      await ctx.db.patch("aiRuns", run._id, { eventCount: count, updatedAt: now });
    }
    if (wf.status === "running")
      await ctx.db.patch("aiWorkflows", wf._id, { leaseUntil: now + LEASE_MS });
    return { stop: wf.cancelRequested === true || isTerminalWorkflow(wf) };
  },
});

// --- internal: designs created by workflow steps --------------------------------------------------------------

/**
 * Creates a design for a workflow step: a copy of `from` (fresh ids) or a blank design of a kind / preset /
 * size, with the same checks as creating one in the app (editor role, plan design + page limits, SVG sanitizing).
 */
export const createDesignForStep = internalMutation({
  args: {
    userId: v.string(),
    workspaceId: v.id("workspaces"),
    name: v.string(),
    kind: v.string(),
    preset: v.optional(v.string()),
    width: v.optional(v.number()),
    height: v.optional(v.number()),
    /** JSON of the Design to copy. */
    from: v.optional(v.string()),
    brandKitId: v.optional(v.string()),
    locale: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ designId: Id<"designs"> }> => {
    const member = await requireMember(ctx, args.workspaceId, "editor", { userId: args.userId });
    await assertLimit(ctx, member.userId, "designs");
    const name = clip(args.name.trim() || "Untitled design", 200);
    if (!isDesignKind(args.kind))
      throw errors.invalid(`Unknown design kind "${args.kind}".`, "kind");
    let design: Design;
    if (args.from) {
      const source = JSON.parse(args.from) as Design;
      design = copyWithFreshIds(source, { name });
      design.kind = args.kind;
      const assets: Design["assets"] = {};
      for (const [ref, asset] of Object.entries(design.assets)) {
        const { url: _url, ...rest } = asset;
        assets[ref] = rest;
      }
      design.assets = assets;
      try {
        design.nodes = sanitizeNodesMarkup(design.nodes);
      } catch (err) {
        if (err instanceof SvgSanitizeError) throw errors.invalid(err.message, "design");
        throw err;
      }
    } else {
      let preset: PagePreset | string | undefined;
      if (args.width && args.height) {
        preset = {
          id: "custom",
          label: "Custom",
          kind: args.kind,
          category: "other",
          width: Math.round(args.width * 100) / 100,
          height: Math.round(args.height * 100) / 100,
          unit: "px",
        };
      } else if (args.preset) {
        if (!getPreset(args.preset))
          throw errors.invalid(`Unknown preset "${args.preset}".`, "preset");
        preset = args.preset;
      }
      design = createDesign(args.kind, preset, { name });
    }
    if (args.brandKitId) {
      const kitId = ctx.db.normalizeId("brandKits", args.brandKitId);
      const kit = kitId ? await ctx.db.get("brandKits", kitId) : null;
      if (kit?.workspaceId === args.workspaceId) design.brandKitId = args.brandKitId;
    }
    if (args.locale) design.meta = { ...design.meta, locale: args.locale };
    const max = PLANS[await getWorkspacePlan(ctx, args.workspaceId)].limits.pagesPerDesign;
    const count = pageCountOf(design);
    if (max !== null && count > max) throw errors.limit("pagesPerDesign", max, count);
    const designId = await insertDesignDocument(ctx, {
      workspaceId: args.workspaceId,
      ownerId: member.userId,
      design,
      source: "workflow",
      label: args.from ? "Workflow copy" : "Workflow design",
    });
    await incrementUsage(ctx, member.userId, "designs", 1);
    return { designId };
  },
});

/** Queues an export job for an exportBundle step (same rules as the app's export dialog). */
export const requestExport = internalMutation({
  args: {
    userId: v.string(),
    designId: v.id("designs"),
    format: v.union(
      v.literal("png"),
      v.literal("jpeg"),
      v.literal("webp"),
      v.literal("svg"),
      v.literal("pdf"),
      v.literal("pptx"),
      v.literal("gif"),
      v.literal("mp4"),
    ),
    pages: v.union(v.literal("all"), v.array(v.string())),
    scale: v.optional(v.number()),
    quality: v.optional(v.number()),
    background: v.optional(v.string()),
    pdf: v.optional(v.object({ bleed: v.boolean(), cropMarks: v.boolean(), cmyk: v.boolean() })),
  },
  handler: async (ctx, args): Promise<Id<"exports">> => {
    const { userId, ...rest } = args;
    return await requestExportFor(ctx, { ...rest, notify: false }, { userId });
  },
});

export const exportState = internalQuery({
  args: { exportId: v.id("exports") },
  handler: async (ctx, args) => {
    const row = await ctx.db.get("exports", args.exportId);
    if (!row) return null;
    return { status: row.status, error: row.error ?? null, key: row.files[0]?.key ?? null };
  },
});

/** The designs a workflow may read (same workspace, view permission). */
export const designFor = internalQuery({
  args: { userId: v.string(), workspaceId: v.id("workspaces"), designId: v.string() },
  handler: async (ctx, args) => {
    const id = ctx.db.normalizeId("designs", args.designId);
    if (!id) throw errors.notFound("Design");
    const design = await getDesignOrThrow(ctx, id);
    if (design.workspaceId !== args.workspaceId) throw errors.notFound("Design");
    await requireDesignPermission(ctx, design, "view", { userId: args.userId });
    return { designId: id };
  },
});

/** Brand kit a workflow follows: the source design's kit, else the workspace default. */
export const brandFor = internalQuery({
  args: { workspaceId: v.id("workspaces"), designId: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const id = args.designId ? ctx.db.normalizeId("designs", args.designId) : null;
    const design = id ? await ctx.db.get("designs", id) : null;
    const kit =
      design && design.workspaceId === args.workspaceId
        ? await brandKitForDesign(ctx, design)
        : await defaultBrandKit(ctx, args.workspaceId);
    return kit ? await aiBrandKit(ctx, kit) : null;
  },
});

/** Download URL of the first file of a finished export. */
export const exportUrl = internalQuery({
  args: { exportId: v.id("exports") },
  handler: async (ctx, args): Promise<string | null> => {
    const row = await ctx.db.get("exports", args.exportId);
    if (row?.status !== "ready") return null;
    const view = await exportView(ctx, row);
    return view.files[0]?.url ?? null;
  },
});
