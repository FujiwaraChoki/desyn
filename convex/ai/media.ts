"use node";

import {
  type AgentEvent,
  CreditMeter,
  createMedia,
  createRuleModeration,
  type ImageInput,
  type ImageStyle,
  isAiError,
  type MediaResult,
  type OutpaintDirection,
  type SvgKind,
} from "@desyn/ai";
import { newId } from "@desyn/schema";
import { type ConvexError, v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { type ActionCtx, action, internalAction } from "../_generated/server";
import { modelPrefs } from "../lib/ai_access";
import { convexHostBackend, EventSink, ingestAsset } from "../lib/ai_backend";
import { WorkerHost } from "../lib/ai_host";
import { guardedFetch } from "../lib/ai_net";
import { createRunProviders, type FetchLike } from "../lib/ai_providers";
import { clip, preview } from "../lib/ai_runs";
import { isHosted } from "../lib/env";
import { appError, type ErrorCode, isAppError } from "../lib/errors";
import { createLogger } from "../lib/logger";
import type { AssetInfo, JobContext } from "./mediaJobs";

// Generative media for the editor and the Agent API (SPEC §7 "generate / modify assets"): image generation,
// SVG generation, background removal, inpaint, outpaint, upscale, mockups, tracing and video. Results are
// stored as workspace assets (S3, through the assets owner) with AI provenance, attached to the design when
// one is given, and returned as AssetRefs ready for an `asset` op plus a signed URL for immediate display.

const POLL_MS = 2_000;

async function beginSync(
  ctx: ActionCtx,
  args: {
    task: string;
    input: Record<string, unknown>;
    designId?: Id<"designs">;
    workspaceId?: Id<"workspaces">;
    sourceAssetIds?: Id<"assets">[];
    count?: number;
  },
): Promise<JobContext> {
  return await ctx.runMutation(internal.ai.mediaJobs.begin, {
    task: args.task,
    input: JSON.stringify(args.input),
    ...(args.designId ? { designId: args.designId } : {}),
    ...(args.workspaceId ? { workspaceId: args.workspaceId } : {}),
    ...(args.sourceAssetIds?.length ? { sourceAssetIds: args.sourceAssetIds } : {}),
    ...(args.count ? { count: args.count } : {}),
  });
}

export interface GeneratedAsset {
  assetId: Id<"assets">;
  refId: string;
  mime: string;
  width?: number;
  height?: number;
  provider: string;
  model: string;
  costCredits: number;
}

const AI_ERROR_CODE: Record<string, ErrorCode> = {
  "provider-not-configured": "NOT_CONFIGURED",
  "moderation-blocked": "INVALID_ARGUMENT",
  "invalid-input": "INVALID_ARGUMENT",
  unsupported: "INVALID_ARGUMENT",
  "budget-exceeded": "LIMIT_REACHED",
  "not-found": "NOT_FOUND",
};

/** Client-safe error for a failed generation (provider details stay in the logs). */
function clientError(err: unknown): ConvexError<{ code: string; message: string }> {
  if (isAppError(err)) return err as ConvexError<{ code: string; message: string }>;
  if (isAiError(err)) {
    const code = AI_ERROR_CODE[err.code] ?? "INTERNAL";
    return appError(code, clip(err.message, 500), { aiCode: err.code });
  }
  return appError("INTERNAL", "The generation failed. Try again in a moment.");
}

async function fetchImage(
  fetchImpl: FetchLike,
  url: string,
): Promise<{ bytes: Uint8Array; mime: string }> {
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`Could not read the source image (${res.status}).`);
  return {
    bytes: new Uint8Array(await res.arrayBuffer()),
    mime: res.headers.get("content-type")?.split(";")[0]?.trim() ?? "image/png",
  };
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Runs one asset job end to end; always settles the run (finish) before returning or throwing. */
async function execute(ctx: ActionCtx, job: JobContext): Promise<GeneratedAsset[]> {
  const run = job.run;
  const log = createLogger(ctx, { fn: "ai.media", runId: run.id, task: run.task });
  const fetchImpl = guardedFetch({ enabled: isHosted() });
  const controller = new AbortController();
  const sink = new EventSink({
    push: (events) => ctx.runMutation(internal.ai.mediaJobs.pushEvents, { runId: run.id, events }),
    storePreview: async (bytes, mime) =>
      await ctx.storage.store(new Blob([bytes as BlobPart], { type: mime })),
    onStop: () => controller.abort(),
  });
  const meter = new CreditMeter(run.maxCredits);
  const started = Date.now();
  // Heartbeat: renews the lease and notices cancelRun while a long generation (video) is in flight.
  const poller = setInterval(() => sink.poll(), POLL_MS);
  try {
    // Fair use: past the monthly pool requests still run, a little slower (never a surprise charge).
    if (job.throttleMs > 0) {
      sink.push({
        type: "progress",
        runId: run.id,
        label: "Fair use",
        detail: `starting in ${Math.ceil(job.throttleMs / 1000)} s`,
      } as AgentEvent);
      await new Promise((resolve) => setTimeout(resolve, job.throttleMs));
    }
    const { providers } = await createRunProviders({
      userId: run.userId,
      settings: job.settings,
      byokAllowed: job.byokAllowed,
      localAllowed: job.localAllowed,
      fetch: fetchImpl,
    });
    const media = createMedia({
      providers,
      prefs: modelPrefs(job.settings),
      meter,
      moderation: createRuleModeration(),
      fetch: fetchImpl,
      onProgress: (p) =>
        sink.push({
          type: "progress",
          runId: run.id,
          label: `${p.task}: ${p.status}`,
          ...(p.position !== undefined ? { detail: `queue position ${p.position}` } : {}),
        } as AgentEvent),
    });
    const o = JSON.parse(run.input) as Record<string, unknown>;
    const signal = controller.signal;
    const infos: AssetInfo[] = await ctx.runQuery(internal.ai.mediaJobs.assetsInfo, {
      workspaceId: run.workspaceId,
      assetIds: run.sources,
    });
    const sourceInputs: ImageInput[] = [];
    for (const id of run.sources) {
      const info = infos.find((i) => i.assetId === id);
      if (!info?.url) throw appError("NOT_CONFIGURED", "File storage is not configured.");
      // Our own signed storage URL (self-hosted S3 may be on a private network).
      sourceInputs.push(await fetchImage((input, init) => fetch(input, init), info.url));
    }
    const source = sourceInputs[0];
    const palette = Array.isArray(o.palette)
      ? (o.palette as string[])
          .filter((c) => /^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(c))
          .map((c) => c.toLowerCase())
      : o.useBrand === false
        ? []
        : job.palette;
    const prompt = str(o.prompt) ?? "";
    let results: MediaResult[] = [];
    switch (run.task) {
      case "image":
        results = await media.generateImage({
          prompt,
          ...(str(o.negativePrompt) ? { negativePrompt: str(o.negativePrompt) as string } : {}),
          ...(num(o.width) ? { width: num(o.width) as number } : {}),
          ...(num(o.height) ? { height: num(o.height) as number } : {}),
          ...(o.withText === true ? { withText: true } : {}),
          ...(o.vector === true ? { vector: true } : {}),
          ...(str(o.style) ? { style: str(o.style) as ImageStyle } : {}),
          ...(palette.length ? { palette } : {}),
          ...(num(o.seed) !== undefined ? { seed: num(o.seed) as number } : {}),
          n: Math.max(1, Math.min(4, num(o.n) ?? 1)),
          signal,
        });
        break;
      case "svg":
        results = [
          await media.generateSvg({
            prompt,
            ...(str(o.kind) ? { kind: str(o.kind) as SvgKind } : {}),
            ...(num(o.width) ? { width: num(o.width) as number } : {}),
            ...(num(o.height) ? { height: num(o.height) as number } : {}),
            ...(palette.length ? { palette } : {}),
            ...(o.strokeOnly === true ? { strokeOnly: true } : {}),
            signal,
          }),
        ];
        break;
      case "remove-background":
        results = [await media.removeBackground({ image: source as ImageInput, signal })];
        break;
      case "inpaint": {
        const mask = sourceInputs[1];
        if (!mask)
          throw appError("INVALID_ARGUMENT", "Choose a mask (white = replace).", {
            field: "maskAssetId",
          });
        results = [
          await media.inpaint({
            image: source as ImageInput,
            mask,
            prompt,
            ...(num(o.seed) !== undefined ? { seed: num(o.seed) as number } : {}),
            signal,
          }),
        ];
        break;
      }
      case "outpaint": {
        const info = infos[0];
        const width = num(o.width) ?? info?.width ?? 1024;
        const height = num(o.height) ?? info?.height ?? 1024;
        results = [
          await media.outpaint({
            image: source as ImageInput,
            ...(info?.width ? { sourceWidth: info.width } : {}),
            ...(info?.height ? { sourceHeight: info.height } : {}),
            target: { width, height },
            ...(str(o.direction) ? { direction: str(o.direction) as OutpaintDirection } : {}),
            ...(prompt ? { prompt } : {}),
            signal,
          }),
        ];
        break;
      }
      case "upscale":
        results = [
          await media.upscale({
            image: source as ImageInput,
            factor: num(o.factor) === 4 || num(o.scale) === 4 ? 4 : 2,
            signal,
          }),
        ];
        break;
      case "mockup": {
        let design: ImageInput | undefined = source;
        if (!design && run.designId) {
          const host = await WorkerHost.open(
            convexHostBackend(ctx, {
              designId: run.designId,
              userId: run.userId,
              workspaceId: run.workspaceId,
              runId: run.id,
            }),
            str(o.pageId) ? { page: str(o.pageId) as string } : {},
          );
          const render = await host.render({ maxSize: 1536 });
          design = { bytes: render.bytes, mime: render.mime };
        }
        results = [
          await media.mockup({
            design: design as ImageInput,
            scene: prompt,
            ...(str(o.aspectRatio) ? { aspectRatio: str(o.aspectRatio) as string } : {}),
            ...(num(o.seed) !== undefined ? { seed: num(o.seed) as number } : {}),
            signal,
          }),
        ];
        break;
      }
      case "trace":
        results = [
          await media.trace({
            image: source as ImageInput,
            ...(num(o.colors) ? { colors: num(o.colors) as number } : {}),
            ...(o.detail === "low" || o.detail === "medium" || o.detail === "high"
              ? { detail: o.detail }
              : {}),
            signal,
          }),
        ];
        break;
      case "video":
        results = [
          await media.generateVideo({
            prompt,
            ...(source ? { image: source } : {}),
            ...(num(o.durationSec) ? { durationSec: num(o.durationSec) as number } : {}),
            ...(o.aspectRatio &&
            ["16:9", "9:16", "1:1", "4:3", "3:4"].includes(String(o.aspectRatio))
              ? { aspectRatio: o.aspectRatio as "16:9" }
              : {}),
            ...(o.resolution && ["480p", "720p", "1080p"].includes(String(o.resolution))
              ? { resolution: o.resolution as "720p" }
              : {}),
            ...(o.audio === true ? { audio: true } : {}),
            signal,
          }),
        ];
        break;
      default:
        throw appError("INVALID_ARGUMENT", `Unknown media task "${run.task}".`);
    }

    const scope = {
      userId: run.userId,
      workspaceId: run.workspaceId,
      runId: run.id,
      ...(run.designId ? { designId: run.designId } : {}),
    };
    const assets: GeneratedAsset[] = [];
    const refs = [];
    for (const [i, r] of results.entries()) {
      const bytes = r.bytes ?? (r.url ? (await fetchImage(fetchImpl, r.url)).bytes : undefined);
      if (!bytes) continue;
      const stored = await ingestAsset(
        ctx,
        scope,
        bytes,
        r.mime,
        {
          name: `${run.task === "svg" || run.task === "trace" ? "Vector" : "Generated"} ${preview(prompt || run.task, 40)}${results.length > 1 ? ` ${i + 1}` : ""}`,
          source: "ai",
          ...(r.width ? { width: r.width } : {}),
          ...(r.height ? { height: r.height } : {}),
          ...(r.durationMs ? { durationMs: r.durationMs } : {}),
          ai: {
            provider: String(r.provider),
            model: r.model,
            prompt: r.prompt || prompt || run.task,
            ...(r.seed !== undefined ? { seed: r.seed } : {}),
          },
        },
        run.task,
        { costCredits: r.costCredits, billing: r.billing, sources: run.sources },
      );
      const { assetId, ...ref } = stored;
      refs.push(ref);
      assets.push({
        assetId,
        refId: ref.id,
        mime: ref.mime,
        ...(ref.width !== undefined ? { width: ref.width } : {}),
        ...(ref.height !== undefined ? { height: ref.height } : {}),
        provider: String(r.provider),
        model: r.model,
        costCredits: r.costCredits,
      });
    }
    if (assets.length === 0) throw appError("INTERNAL", "The provider returned no result.");
    if (run.designId && refs.length > 0) {
      await ctx.runMutation(internal.designs.designs.commitAs, {
        designId: run.designId,
        userId: run.userId,
        tx: JSON.stringify({
          id: newId(),
          label: `AI: ${run.task === "image" ? "generated image" : run.task}`,
          ops: [{ op: "asset", set: Object.fromEntries(refs.map((r) => [r.id, r])) }],
          source: "ai",
          actor: { userId: run.userId, runId: run.id, agent: "desyn-media" },
          ts: Date.now(),
        }),
      });
    }
    await sink.flush();
    await ctx.runMutation(internal.ai.mediaJobs.finish, {
      runId: run.id,
      ok: true,
      assets,
      credits: meter.used,
    });
    log.info("media generated", {
      assets: assets.length,
      credits: meter.used,
      ms: Date.now() - started,
      prompt: preview(prompt),
    });
    return assets;
  } catch (err) {
    await sink.flush().catch(() => undefined);
    const safe = clientError(err);
    const data = safe.data as { code: string; message: string };
    log.warn("media generation failed", {
      code: data.code,
      error: clip(err instanceof Error ? err.message : String(err), 500),
    });
    await ctx.runMutation(internal.ai.mediaJobs.finish, {
      runId: run.id,
      ok: false,
      assets: [],
      credits: meter.used,
      error: data.message,
      errorCode: data.code,
      ...(controller.signal.aborted ? { cancelled: true } : {}),
    });
    throw safe;
  } finally {
    clearInterval(poller);
    await log.flush();
  }
}

export interface MediaActionResult {
  runId: Id<"aiRuns">;
  assets: (GeneratedAsset & { url: string | null })[];
}

/** Results with AssetRefs and signed URLs for the client. */
async function withRefs(
  ctx: ActionCtx,
  job: JobContext,
  assets: GeneratedAsset[],
): Promise<MediaActionResult> {
  const infos: AssetInfo[] = await ctx.runQuery(internal.ai.mediaJobs.assetsInfo, {
    workspaceId: job.run.workspaceId,
    assetIds: assets.map((a) => a.assetId),
  });
  return {
    runId: job.run.id,
    assets: assets.map((a) => ({
      ...a,
      url: infos.find((i) => i.assetId === a.assetId)?.url ?? null,
    })),
  };
}

const target = {
  /** Attach the result to this design (and follow its brand palette). */
  designId: v.optional(v.id("designs")),
  /** Workspace that stores the result when no design is given (default: the personal workspace). */
  workspaceId: v.optional(v.id("workspaces")),
};

async function runSync(
  ctx: ActionCtx,
  task: string,
  input: Record<string, unknown>,
  args: { designId?: Id<"designs">; workspaceId?: Id<"workspaces"> },
  extra: { sourceAssetIds?: Id<"assets">[]; count?: number } = {},
): Promise<MediaActionResult> {
  const job = await beginSync(ctx, {
    task,
    input,
    ...(args.designId ? { designId: args.designId } : {}),
    ...(args.workspaceId ? { workspaceId: args.workspaceId } : {}),
    ...extra,
  });
  return await withRefs(ctx, job, await execute(ctx, job));
}

export const generateImage = action({
  args: {
    prompt: v.string(),
    negativePrompt: v.optional(v.string()),
    width: v.optional(v.number()),
    height: v.optional(v.number()),
    style: v.optional(v.string()),
    withText: v.optional(v.boolean()),
    vector: v.optional(v.boolean()),
    palette: v.optional(v.array(v.string())),
    useBrand: v.optional(v.boolean()),
    seed: v.optional(v.number()),
    n: v.optional(v.number()),
    ...target,
  },
  handler: async (ctx, args): Promise<MediaActionResult> => {
    const { designId, workspaceId, ...input } = args;
    return await runSync(ctx, "image", input, { designId, workspaceId }, { count: args.n ?? 1 });
  },
});

export const generateSvg = action({
  args: {
    prompt: v.string(),
    kind: v.optional(v.string()),
    width: v.optional(v.number()),
    height: v.optional(v.number()),
    palette: v.optional(v.array(v.string())),
    useBrand: v.optional(v.boolean()),
    strokeOnly: v.optional(v.boolean()),
    ...target,
  },
  handler: async (ctx, args): Promise<MediaActionResult> => {
    const { designId, workspaceId, ...input } = args;
    return await runSync(ctx, "svg", input, { designId, workspaceId });
  },
});

export const removeBackground = action({
  args: { assetId: v.id("assets"), ...target },
  handler: async (ctx, args): Promise<MediaActionResult> =>
    await runSync(ctx, "remove-background", {}, args, { sourceAssetIds: [args.assetId] }),
});

export const inpaint = action({
  args: {
    assetId: v.id("assets"),
    maskAssetId: v.id("assets"),
    prompt: v.string(),
    seed: v.optional(v.number()),
    ...target,
  },
  handler: async (ctx, args): Promise<MediaActionResult> =>
    await runSync(
      ctx,
      "inpaint",
      { prompt: args.prompt, ...(args.seed !== undefined ? { seed: args.seed } : {}) },
      args,
      { sourceAssetIds: [args.assetId, args.maskAssetId] },
    ),
});

export const outpaint = action({
  args: {
    assetId: v.id("assets"),
    width: v.number(),
    height: v.number(),
    direction: v.optional(v.string()),
    prompt: v.optional(v.string()),
    ...target,
  },
  handler: async (ctx, args): Promise<MediaActionResult> => {
    const { assetId, designId, workspaceId, ...input } = args;
    return await runSync(
      ctx,
      "outpaint",
      input,
      { designId, workspaceId },
      { sourceAssetIds: [assetId] },
    );
  },
});

export const upscale = action({
  args: { assetId: v.id("assets"), factor: v.optional(v.number()), ...target },
  handler: async (ctx, args): Promise<MediaActionResult> =>
    await runSync(ctx, "upscale", { factor: args.factor ?? 2 }, args, {
      sourceAssetIds: [args.assetId],
    }),
});

export const mockup = action({
  args: {
    scene: v.string(),
    /** Image to place; without it the design's page is rendered and placed. */
    assetId: v.optional(v.id("assets")),
    pageId: v.optional(v.string()),
    aspectRatio: v.optional(v.string()),
    seed: v.optional(v.number()),
    ...target,
  },
  handler: async (ctx, args): Promise<MediaActionResult> => {
    const { assetId, designId, workspaceId, scene, ...rest } = args;
    return await runSync(
      ctx,
      "mockup",
      { prompt: scene, ...rest },
      { designId, workspaceId },
      {
        ...(assetId ? { sourceAssetIds: [assetId] } : {}),
      },
    );
  },
});

export const trace = action({
  args: {
    assetId: v.id("assets"),
    colors: v.optional(v.number()),
    detail: v.optional(v.union(v.literal("low"), v.literal("medium"), v.literal("high"))),
    ...target,
  },
  handler: async (ctx, args): Promise<MediaActionResult> => {
    const { assetId, designId, workspaceId, ...input } = args;
    return await runSync(
      ctx,
      "trace",
      input,
      { designId, workspaceId },
      { sourceAssetIds: [assetId] },
    );
  },
});

export const video = action({
  args: {
    prompt: v.string(),
    /** First frame (image-to-video). */
    assetId: v.optional(v.id("assets")),
    durationSec: v.optional(v.number()),
    aspectRatio: v.optional(v.string()),
    resolution: v.optional(v.string()),
    audio: v.optional(v.boolean()),
    ...target,
  },
  handler: async (ctx, args): Promise<MediaActionResult> => {
    const { assetId, designId, workspaceId, ...input } = args;
    return await runSync(
      ctx,
      "video",
      input,
      { designId, workspaceId },
      {
        ...(assetId ? { sourceAssetIds: [assetId] } : {}),
      },
    );
  },
});

/** Asynchronous asset run (Agent API): claims the run and executes it; results land on the run. */
export const runJob = internalAction({
  args: { runId: v.id("aiRuns"), chunk: v.number() },
  handler: async (ctx, args): Promise<null> => {
    const job: JobContext | null = await ctx.runMutation(internal.ai.mediaJobs.claim, args);
    if (!job) return null;
    try {
      await execute(ctx, job);
    } catch {
      // execute() already recorded the failure on the run.
    }
    return null;
  },
});
