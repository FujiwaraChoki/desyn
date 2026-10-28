import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { internalMutation, internalQuery, type MutationCtx } from "../_generated/server";
import { urlFor } from "../assets/assets";
import {
  aiAccess,
  assertRoutable,
  availability,
  isMediaTask,
  MEDIA_FEATURE,
  MEDIA_ROUTE,
  type MediaTask,
  modelPrefs,
  requireFeatures,
} from "../lib/ai_access";
import { aiBrandKit, brandKitForDesign, defaultBrandKit } from "../lib/ai_brand";
import {
  appendRunEvents,
  clip,
  isTerminal,
  LEASE_MS,
  MAX_GOAL_CHARS,
  reserveSegment,
  segmentRefId,
  storedEvent,
} from "../lib/ai_runs";
import { finishRun } from "../lib/ai_start";
import { getDesignOrThrow, requireDesignWriter } from "../lib/designs_access";
import { errors } from "../lib/errors";
import { requireMember, requireUser } from "../lib/guards";
import { creditCost } from "../lib/plans";
import type { AiSettings } from "../lib/validators";

// Asset runs (generative media, SPEC §7 "generate/modify assets"): one aiRuns row of kind "asset" per
// request, so media requests share the fair-use caps, the credit ledger and the event log with agent runs.
// The app calls the Node actions in media.ts (synchronous: they return the stored assets); the Agent API
// starts them asynchronously (runJob) and polls the run.

/** Credit kind (config/plans.json creditCosts) of each media task. */
export const MEDIA_CREDIT_KIND: Record<MediaTask, string> = {
  image: "ai.image",
  svg: "ai.svg",
  "remove-background": "ai.removeBackground",
  inpaint: "ai.inpaint",
  outpaint: "ai.outpaint",
  upscale: "ai.upscale",
  mockup: "ai.mockup",
  trace: "ai.svg",
  video: "ai.videoClip",
};

/** Tasks that transform an existing image (need a source asset). */
const NEEDS_SOURCE: ReadonlySet<MediaTask> = new Set([
  "remove-background",
  "inpaint",
  "outpaint",
  "upscale",
  "trace",
]);
const NEEDS_PROMPT: ReadonlySet<MediaTask> = new Set([
  "image",
  "svg",
  "inpaint",
  "mockup",
  "video",
]);

export interface MediaRequest {
  task: string;
  /** JSON of the task options (prompt, sizes, …). */
  input: string;
  designId?: Id<"designs">;
  workspaceId?: Id<"workspaces">;
  sourceAssetIds?: Id<"assets">[];
  count?: number;
}

/**
 * Creates an asset run after checking plan, routing, sources and fair use; reserves its credits. `delayMs` is
 * the fair-use soft throttle the caller must wait before generating (asynchronous runs are scheduled after it).
 */
export async function createAssetRun(
  ctx: MutationCtx,
  userId: string,
  req: MediaRequest,
  opts: { via: "app" | "api"; requestKey?: string; sync: boolean },
): Promise<{ run: Doc<"aiRuns">; delayMs: number }> {
  if (opts.requestKey) {
    const existing = await ctx.db
      .query("aiRuns")
      .withIndex("by_requestKey", (q) => q.eq("requestKey", opts.requestKey))
      .first();
    if (existing && existing.userId === userId) return { run: existing, delayMs: 0 };
  }
  if (!isMediaTask(req.task)) throw errors.invalid(`Unknown media task "${req.task}".`, "task");
  const task = req.task;
  let options: Record<string, unknown>;
  try {
    options = JSON.parse(req.input) as Record<string, unknown>;
  } catch {
    throw errors.invalid("Invalid options.", "input");
  }
  const prompt = typeof options.prompt === "string" ? options.prompt.trim() : "";
  if (NEEDS_PROMPT.has(task) && !prompt) throw errors.invalid("A prompt is required.", "prompt");
  if (prompt.length > 4_000) throw errors.invalid("The prompt is too long.", "prompt");

  let workspaceId = req.workspaceId;
  if (req.designId) {
    const design = await getDesignOrThrow(ctx, req.designId);
    const access = await requireDesignWriter(ctx, design, "edit", { userId });
    if (access.via !== "member")
      throw errors.forbidden("Only workspace members can run the AI here.");
    if (workspaceId && workspaceId !== design.workspaceId) throw errors.notFound("Design");
    workspaceId = design.workspaceId;
  }
  if (!workspaceId) {
    const profile = await ctx.db
      .query("profiles")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .unique();
    workspaceId = profile?.defaultWorkspaceId;
  }
  if (!workspaceId) throw errors.invalid("Choose a workspace.", "workspaceId");
  await requireMember(ctx, workspaceId, "editor", { userId });
  await requireFeatures(ctx, userId, [MEDIA_FEATURE[task]]);

  const sources = req.sourceAssetIds ?? [];
  if (NEEDS_SOURCE.has(task) && sources.length === 0)
    throw errors.invalid("Choose the image to edit.", "assetId");
  for (const id of sources) {
    const asset = await ctx.db.get("assets", id);
    if (!asset || asset.workspaceId !== workspaceId || asset.status !== "ready")
      throw errors.notFound("Asset");
    if (asset.kind !== "image") throw errors.invalid("Choose an image.", "assetId");
  }
  if (task === "mockup" && !req.designId && sources.length === 0)
    throw errors.invalid("Choose a design or an image to place in the mockup.", "designId");

  const ai = await aiAccess(ctx, userId);
  const route = assertRoutable(availability(ai), MEDIA_ROUTE[task], modelPrefs(ai.settings));
  const count = Math.max(1, Math.min(4, Math.round(req.count ?? 1)));
  const unit = creditCost(MEDIA_CREDIT_KIND[task]) ?? 1;
  const now = Date.now();
  const runId = await ctx.db.insert("aiRuns", {
    kind: "asset",
    userId,
    workspaceId,
    ...(req.designId ? { designId: req.designId } : {}),
    mode: task,
    goal: clip(prompt || task, MAX_GOAL_CHARS),
    status: opts.sync ? "running" : "queued",
    via: opts.via,
    ...(opts.requestKey ? { requestKey: opts.requestKey } : {}),
    input: req.input,
    ...(sources.length ? { attachments: sources } : {}),
    model: route.ref,
    billing: route.billing,
    maxSteps: 1,
    maxCredits: unit * count,
    steps: 0,
    chunk: 0,
    restarts: 0,
    creditsUsed: 0,
    creditsCharged: 0,
    segments: 1,
    transactions: 0,
    eventCount: 0,
    createdAt: now,
    updatedAt: now,
    ...(opts.sync ? { startedAt: now, leaseUntil: now + LEASE_MS } : {}),
  });
  const reserved = await reserveSegment(ctx, {
    userId,
    refId: segmentRefId("run", runId, 0),
    cost: unit * count,
    byok: route.billing !== "platform",
    kind: MEDIA_CREDIT_KIND[task],
  });
  if (!reserved.ok) throw reserved.error;
  await ctx.db.patch("aiRuns", runId, {
    reservation: { refId: reserved.refId, amount: reserved.amount, usedAtStart: 0 },
  });
  const run = (await ctx.db.get("aiRuns", runId)) as Doc<"aiRuns">;
  const count0 = await appendRunEvents(ctx, run, [
    storedEvent({ type: "start", mode: task, model: route.ref, at: now }),
  ]);
  await ctx.db.patch("aiRuns", runId, { eventCount: count0 });
  if (!opts.sync) {
    await ctx.scheduler.runAfter(reserved.delayMs, internal.ai.media.runJob, { runId, chunk: 0 });
  }
  return { run: (await ctx.db.get("aiRuns", runId)) as Doc<"aiRuns">, delayMs: reserved.delayMs };
}

export interface JobContext {
  run: {
    id: Id<"aiRuns">;
    userId: string;
    workspaceId: Id<"workspaces">;
    designId: Id<"designs"> | null;
    task: string;
    input: string;
    sources: Id<"assets">[];
    maxCredits: number | null;
    chunk: number;
  };
  settings: AiSettings;
  byokAllowed: boolean;
  localAllowed: boolean;
  palette: string[];
  /** Fair-use soft throttle to wait before generating (synchronous app requests). */
  throttleMs: number;
}

/** Context a media action needs (settings with encrypted keys stay server-side). */
async function jobContext(
  ctx: MutationCtx,
  run: Doc<"aiRuns">,
  throttleMs = 0,
): Promise<JobContext> {
  const access = await aiAccess(ctx, run.userId);
  const design = run.designId ? await ctx.db.get("designs", run.designId) : null;
  const kitDoc = design
    ? await brandKitForDesign(ctx, design)
    : await defaultBrandKit(ctx, run.workspaceId);
  const brand = kitDoc ? (await aiBrandKit(ctx, kitDoc)).kit : null;
  return {
    run: {
      id: run._id,
      userId: run.userId,
      workspaceId: run.workspaceId,
      designId: run.designId ?? null,
      task: run.mode,
      input: run.input ?? "{}",
      sources: run.attachments ?? [],
      maxCredits: run.maxCredits ?? null,
      chunk: run.chunk,
    },
    settings: access.settings,
    byokAllowed: access.byokAllowed,
    localAllowed: access.localAllowed,
    palette: brand ? brand.colors.map((c) => c.value).slice(0, 8) : [],
    throttleMs,
  };
}

/** Synchronous start (app actions): creates the run and returns the execution context. */
export const begin = internalMutation({
  args: {
    task: v.string(),
    input: v.string(),
    designId: v.optional(v.id("designs")),
    workspaceId: v.optional(v.id("workspaces")),
    sourceAssetIds: v.optional(v.array(v.id("assets"))),
    count: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<JobContext> => {
    const user = await requireUser(ctx, { verified: true });
    const { run, delayMs } = await createAssetRun(ctx, user.userId, args, {
      via: "app",
      sync: true,
    });
    return await jobContext(ctx, run, delayMs);
  },
});

/** Asynchronous start (Agent API): claims a queued asset run for the job action. */
export const claim = internalMutation({
  args: { runId: v.id("aiRuns"), chunk: v.number() },
  handler: async (ctx, args): Promise<JobContext | null> => {
    const run = await ctx.db.get("aiRuns", args.runId);
    if (run?.kind !== "asset" || run.chunk !== args.chunk || isTerminal(run.status)) return null;
    const now = Date.now();
    if (run.leaseUntil !== undefined && run.leaseUntil > now) return null;
    if (run.cancelRequested) {
      await finishRun(ctx, run._id, { status: "cancelled", summary: "Cancelled.", emitDone: true });
      return null;
    }
    await ctx.db.patch("aiRuns", run._id, {
      status: "running",
      leaseUntil: now + LEASE_MS,
      startedAt: run.startedAt ?? now,
      updatedAt: now,
    });
    return await jobContext(ctx, (await ctx.db.get("aiRuns", run._id)) as Doc<"aiRuns">);
  },
});

const assetResult = v.object({
  assetId: v.id("assets"),
  refId: v.string(),
  mime: v.string(),
  width: v.optional(v.number()),
  height: v.optional(v.number()),
  provider: v.string(),
  model: v.string(),
  costCredits: v.number(),
});

/** Ends an asset run: settles credits (actual use) and records the result or the error. */
export const finish = internalMutation({
  args: {
    runId: v.id("aiRuns"),
    ok: v.boolean(),
    assets: v.array(assetResult),
    credits: v.number(),
    error: v.optional(v.string()),
    errorCode: v.optional(v.string()),
    cancelled: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const run = await ctx.db.get("aiRuns", args.runId);
    if (!run || isTerminal(run.status)) return null;
    await ctx.db.patch("aiRuns", run._id, {
      creditsUsed: args.credits,
      steps: 1,
      transactions: run.designId && args.assets.length ? 1 : 0,
    });
    const first = args.assets[0];
    await finishRun(ctx, run._id, {
      status: args.cancelled ? "cancelled" : args.ok ? "completed" : "failed",
      summary: args.ok
        ? `${args.assets.length} asset(s) generated.`
        : args.cancelled
          ? "Cancelled."
          : (args.error ?? "Generation failed."),
      ...(args.error && !args.ok ? { error: args.error } : {}),
      ...(args.errorCode && !args.ok ? { errorCode: args.errorCode } : {}),
      result: args.ok
        ? {
            ...(first ? { assetId: first.assetId, refId: first.refId } : {}),
            assets: args.assets,
          }
        : {},
      emitDone: true,
    });
    return null;
  },
});

export interface AssetInfo {
  assetId: Id<"assets">;
  refId: string;
  kind: string;
  mime: string;
  width: number | null;
  height: number | null;
  url: string | null;
}

/** Signed URLs and AssetRefs of workspace assets (sources of edits, results for the client). */
export const assetsInfo = internalQuery({
  args: { workspaceId: v.id("workspaces"), assetIds: v.array(v.id("assets")) },
  handler: async (ctx, args): Promise<AssetInfo[]> => {
    const out = [];
    for (const id of args.assetIds) {
      const asset = await ctx.db.get("assets", id);
      if (!asset || asset.workspaceId !== args.workspaceId) continue;
      out.push({
        assetId: asset._id,
        refId: asset.refId,
        kind: asset.kind,
        mime: asset.mime,
        width: asset.width ?? null,
        height: asset.height ?? null,
        url: urlFor(asset),
      });
    }
    return out;
  },
});

/** Progress events of an asset run (provider queue updates). */
export const pushEvents = internalMutation({
  args: {
    runId: v.id("aiRuns"),
    events: v.array(v.object({ type: v.string(), ts: v.number(), payload: v.string() })),
  },
  handler: async (ctx, args): Promise<{ stop: boolean }> => {
    const run = await ctx.db.get("aiRuns", args.runId);
    if (!run) return { stop: true };
    const now = Date.now();
    const count = args.events.length
      ? await appendRunEvents(ctx, run, args.events)
      : run.eventCount;
    await ctx.db.patch("aiRuns", run._id, {
      eventCount: count,
      updatedAt: now,
      ...(run.status === "running" ? { leaseUntil: now + LEASE_MS } : {}),
    });
    return { stop: run.cancelRequested === true || isTerminal(run.status) };
  },
});
