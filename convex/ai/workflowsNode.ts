"use node";

import {
  type AgentEvent,
  CreditMeter,
  createMedia,
  createRuleModeration,
  type ExportJob,
  progress,
  stepWorkflow,
  type WorkflowEnv,
  type WorkflowEvent,
  type WorkflowState,
} from "@desyn/ai";
import { pages } from "@desyn/doc-ops";
import type { Design } from "@desyn/schema";
import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { type ActionCtx, internalAction } from "../_generated/server";
import { modelPrefs } from "../lib/ai_access";
import { convexHostBackend, EventSink, ingestAsset, searchProviders } from "../lib/ai_backend";
import { WorkerHost } from "../lib/ai_host";
import { guardedFetch } from "../lib/ai_net";
import { createRunProviders, type FetchLike } from "../lib/ai_providers";
import { clip } from "../lib/ai_runs";
import { decompressToString } from "../lib/designs_compress";
import { materializeDesign } from "../lib/designs_materialize";
import { isHosted } from "../lib/env";
import { isAppError } from "../lib/errors";
import { createLogger } from "../lib/logger";

// One durable workflow step per action (SPEC §7): load the persisted @desyn/ai WorkflowState, run the next
// step with a Convex WorkflowEnv (designs created and edited through the normal commit path, assets through
// the assets owner, exports through the export queue), then persist the new state and schedule the next step.

const STATE_INLINE_MAX = 800_000;
const POLL_MS = 2_000;
const EXPORT_WAIT_MS = 7 * 60_000;
/** Agent sub-runs inside one workflow step must fit a single action. */
const MAX_AGENT_STEPS = 20;

const EXPORT_FORMATS = new Set(["png", "jpeg", "webp", "svg", "pdf", "pptx", "gif", "mp4"]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Workflow events for the companion run's log (agent previews inside steps are dropped: too large). */
function eventForLog(event: WorkflowEvent): AgentEvent | null {
  if (event.type === "workflow-agent") {
    if (event.event.type === "preview" || event.event.type === "thinking") return null;
    const { runId: _r, ...inner } = event.event as AgentEvent & { runId: string };
    return {
      ...inner,
      type: event.event.type,
      runId: event.workflowId,
      stepId: event.stepId,
    } as unknown as AgentEvent;
  }
  return { ...event, runId: event.workflowId } as unknown as AgentEvent;
}

async function loadState(
  ctx: ActionCtx,
  state: string | null,
  stateId: Id<"_storage"> | null,
): Promise<WorkflowState> {
  if (state) return JSON.parse(state) as WorkflowState;
  if (!stateId) throw new Error("workflow state is missing");
  const blob = await ctx.storage.get(stateId);
  if (!blob) throw new Error("workflow state is missing");
  return JSON.parse(await blob.text()) as WorkflowState;
}

export const advance = internalAction({
  args: { workflowId: v.id("aiWorkflows"), tick: v.number() },
  handler: async (ctx, args) => {
    const begin = await ctx.runMutation(internal.ai.workflows.beginStep, args);
    if (!begin) return null;
    const wf = begin.workflow;
    const log = createLogger(ctx, { fn: "ai.workflowStep", workflowId: wf.id, tick: wf.tick });
    const controller = new AbortController();
    const fetchImpl: FetchLike = guardedFetch({ enabled: isHosted() });
    const sink = new EventSink({
      push: (events) =>
        ctx.runMutation(internal.ai.workflows.pushEvents, { workflowId: wf.id, events }),
      storePreview: async (bytes, mime) =>
        await ctx.storage.store(new Blob([bytes as BlobPart], { type: mime })),
      onStop: () => controller.abort(),
    });
    const poller = setInterval(() => sink.poll(), POLL_MS);
    const started = Date.now();
    try {
      const state = await loadState(ctx, wf.state, wf.stateId);
      const before = state.creditsUsed;
      const { providers } = await createRunProviders({
        userId: wf.userId,
        settings: begin.settings,
        byokAllowed: begin.byokAllowed,
        localAllowed: begin.localAllowed,
        fetch: fetchImpl,
      });
      const prefs = modelPrefs(begin.settings);
      const meter = new CreditMeter(null);
      const scope = { userId: wf.userId, workspaceId: wf.workspaceId };
      const openHost = async (designId: string) => {
        const id = (await ctx.runQuery(internal.ai.workflows.designFor, { ...scope, designId }))
          .designId;
        return await WorkerHost.open(
          convexHostBackend(ctx, { ...scope, designId: id, runId: wf.runId }),
        );
      };
      const loadDesign = async (designId: string): Promise<Design> => {
        const { designId: id } = await ctx.runQuery(internal.ai.workflows.designFor, {
          ...scope,
          designId,
        });
        const m = await materializeDesign(ctx, id, { decode: decompressToString });
        if (!m) throw new Error("The design is no longer available.");
        return m.design;
      };
      const brandKit = await ctx.runQuery(internal.ai.workflows.brandFor, {
        workspaceId: wf.workspaceId,
        ...(typeof (state.input as { designId?: unknown }).designId === "string"
          ? { designId: (state.input as { designId: string }).designId }
          : {}),
      });
      const env: WorkflowEnv = {
        loadDesign,
        openHost,
        createDesign: async (input) => {
          const { designId } = await ctx.runMutation(internal.ai.workflows.createDesignForStep, {
            ...scope,
            name: input.name,
            kind: input.kind,
            ...(input.preset ? { preset: input.preset } : {}),
            ...(input.width ? { width: input.width } : {}),
            ...(input.height ? { height: input.height } : {}),
            ...(input.from ? { from: JSON.stringify(input.from) } : {}),
            ...(input.brandKitId ? { brandKitId: input.brandKitId } : {}),
            ...(input.locale ? { locale: input.locale } : {}),
          });
          return { designId, host: await openHost(designId) };
        },
        uploadAsset: async (bytes, mime, meta = {}) => {
          const { assetId: _id, ...ref } = await ingestAsset(
            ctx,
            { ...scope, runId: wf.runId },
            bytes,
            mime,
            meta,
            `workflow:${wf.type}`,
          );
          return ref;
        },
        providers,
        prefs,
        media: createMedia({
          providers,
          prefs,
          meter,
          moderation: createRuleModeration(),
          fetch: fetchImpl,
        }),
        search: searchProviders(ctx, wf.userId, fetchImpl),
        ...(brandKit ? { brand: brandKit.kit } : {}),
        moderation: createRuleModeration(),
        exporter: {
          export: async (job: ExportJob, signal?: AbortSignal) =>
            await runExport(ctx, scope, job, loadDesign, signal),
        },
        meter,
        fetch: fetchImpl,
        signal: controller.signal,
        onEvent: (event) => {
          const logged = eventForLog(event);
          if (logged) sink.push(logged);
        },
        maxAgentSteps: MAX_AGENT_STEPS,
      };
      const next = await stepWorkflow(state, env);
      clearInterval(poller);
      await sink.flush();
      const json = JSON.stringify(next);
      let stateId: Id<"_storage"> | undefined;
      if (json.length > STATE_INLINE_MAX) {
        stateId = await ctx.storage.store(new Blob([json], { type: "application/json" }));
      }
      const status =
        next.status === "completed" || next.status === "failed" || next.status === "cancelled"
          ? next.status
          : "running";
      await ctx.runMutation(internal.ai.workflows.endStep, {
        workflowId: wf.id,
        tick: wf.tick,
        ...(stateId ? { stateId } : { state: json }),
        status,
        progress: progress(next),
        outputs: next.outputs.map((o) => JSON.parse(JSON.stringify(o)) as Record<string, unknown>),
        // Metered use of this step (models, media, sub-agents) on top of what earlier steps used.
        creditsUsed: before + Math.max(next.creditsUsed - before, meter.used),
        ...(next.error ? { error: clip(next.error, 1000) } : {}),
      });
      log.info("workflow step finished", {
        type: wf.type,
        status: next.status,
        done: progress(next).done,
        total: progress(next).total,
        ms: Date.now() - started,
      });
    } catch (err) {
      clearInterval(poller);
      await sink.flush().catch(() => undefined);
      const message = isAppError(err)
        ? (err.data as { message: string }).message
        : err instanceof Error
          ? err.message
          : String(err);
      log.error("workflow step crashed", { error: clip(message, 500) });
      await ctx.runMutation(internal.ai.workflows.stepCrashed, {
        workflowId: wf.id,
        tick: wf.tick,
        error: clip(message, 1000),
      });
    } finally {
      await log.flush();
    }
    return null;
  },
});

/** Runs one export job through the export queue and waits for the file. */
async function runExport(
  ctx: ActionCtx,
  scope: { userId: string; workspaceId: Id<"workspaces"> },
  job: ExportJob,
  loadDesign: (id: string) => Promise<Design>,
  signal?: AbortSignal,
): Promise<{ url?: string; storageKey?: string }> {
  if (!EXPORT_FORMATS.has(job.format)) throw new Error(`Unsupported export format ${job.format}.`);
  let pageIds: "all" | string[] = "all";
  if (job.pages !== "all") {
    const all = pages(await loadDesign(job.designId)).map((p) => p.id);
    pageIds = job.pages.map((i) => all[i]).filter((id): id is string => typeof id === "string");
    if (pageIds.length === 0) throw new Error("None of the selected pages exist.");
  }
  const { designId } = await ctx.runQuery(internal.ai.workflows.designFor, {
    ...scope,
    designId: job.designId,
  });
  const exportId = await ctx.runMutation(internal.ai.workflows.requestExport, {
    userId: scope.userId,
    designId,
    format: job.format,
    pages: pageIds,
    ...(job.scale !== undefined ? { scale: job.scale } : {}),
    ...(job.quality !== undefined ? { quality: job.quality } : {}),
    ...(job.background ? { background: job.background } : {}),
    ...(job.pdf ? { pdf: job.pdf } : {}),
  });
  const deadline = Date.now() + EXPORT_WAIT_MS;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const state = await ctx.runQuery(internal.ai.workflows.exportState, { exportId });
    if (!state) throw new Error("The export disappeared.");
    if (state.status === "ready") {
      const url = await ctx.runQuery(internal.ai.workflows.exportUrl, { exportId });
      return { ...(url ? { url } : {}), storageKey: exportId };
    }
    if (state.status === "failed" || state.status === "expired")
      throw new Error(state.error ?? "The export failed.");
    await sleep(POLL_MS);
  }
  throw new Error("The export is taking too long; it will be retried.");
}
