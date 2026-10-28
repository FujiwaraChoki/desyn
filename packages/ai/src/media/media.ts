// Media generation and editing: routes each operation to the configured model (fal endpoints through their
// adapters, other providers through the AI SDK), moderates prompts, meters credits and returns normalized
// results with bytes ready to upload as design assets.
import {
  experimental_generateVideo,
  generateSpeech,
  generateText,
  type ModelMessage,
  generateImage as sdkGenerateImage,
} from "ai";
import { CREDIT_ACTION, creditsFor, TASK_ACTION } from "../credits";
import { AiError, isAiError } from "../errors";
import {
  type AiTask,
  availabilityFrom,
  BUILTIN_PROVIDER,
  providerRef,
  resolveModel,
  TASKS,
  type TaskModelRef,
} from "../models";
import { svgSystemPrompt } from "../prompts/svg";
import type { Billing } from "../providers/types";
import { defaultFetch, isAbortError, throwIfAborted } from "../util/async";
import { fromUtf8, imageSize, parseDataUri, sniffMime, toDataUri, utf8 } from "../util/bytes";
import { type FalFile, type FalRequest, falAdapterFor } from "./fal-endpoints";
import {
  constrainPalette,
  extractSvg,
  optimizeSvg,
  SvgParseError,
  sanitizeSvg,
  validateSvg,
} from "./svg";
import { traceRaster } from "./trace";
import type {
  GenerateImageOptions,
  GenerateVideoOptions,
  ImageInput,
  InpaintOptions,
  Media,
  MediaContext,
  MediaResult,
  MockupOptions,
  OutpaintOptions,
  RemoveBackgroundOptions,
  SpeechOptions,
  SvgResult,
  TraceMediaResult,
  TraceOptionsMedia,
  UpscaleOptions,
} from "./types";

const STYLE_HINTS: Record<NonNullable<GenerateImageOptions["style"]>, string> = {
  photo: "photorealistic photograph, natural light, shallow depth of field, high detail",
  illustration: "polished editorial illustration, clean shapes, cohesive palette",
  "3d": "soft 3D render, studio lighting, subtle shadows",
  flat: "flat vector style, simple geometric shapes, no gradients",
  painting: "painterly artwork, visible brush strokes",
  "line-art": "clean line art, monoline strokes, minimal fills",
  pixel: "pixel art, crisp pixels, limited palette",
};

/** Retry the next model only for provider-side failures, never for bad input, moderation or cancellation. */
function shouldFallback(error: unknown): boolean {
  if (isAbortError(error)) return false;
  if (isAiError(error)) return error.code === "provider-error" || error.code === "invalid-output";
  return true;
}

export function createMedia(ctx: MediaContext): Media {
  const doFetch = ctx.fetch ?? defaultFetch();
  const available = availabilityFrom(ctx.providers);

  function candidates(task: AiTask): TaskModelRef[] {
    const resolved = resolveModel(task, ctx.prefs ?? {}, { isAvailable: available });
    if (!available(resolved.provider)) {
      throw new AiError(
        "provider-not-configured",
        `No provider is configured for ${TASKS[task].label.toLowerCase()} (needs ${resolved.provider}).`,
        { task, provider: resolved.provider },
      );
    }
    const list: TaskModelRef[] = [resolved];
    // Explicit user/workspace choices are honoured strictly; defaults may fall back.
    if (resolved.source !== "user" && resolved.source !== "workspace") {
      for (const f of [TASKS[task].default, ...TASKS[task].fallbacks]) {
        if (
          available(f.provider) &&
          !list.some((c) => c.provider === f.provider && c.model === f.model)
        )
          list.push(f);
      }
    }
    return list;
  }

  function billingOf(provider: TaskModelRef["provider"]): Billing {
    if (provider === BUILTIN_PROVIDER) return "local";
    return ctx.providers.billing(provider) ?? "platform";
  }

  function precheck(task: AiTask, provider: TaskModelRef["provider"], count = 1): void {
    const action = TASK_ACTION[task];
    if (action && ctx.meter?.wouldExceed(action, billingOf(provider), count)) {
      throw new AiError(
        "budget-exceeded",
        `This would exceed the run's credit budget (${CREDIT_ACTION[action]}).`,
        {
          task,
          remaining: ctx.meter.remaining,
        },
      );
    }
  }

  function charge(task: AiTask, provider: TaskModelRef["provider"], count = 1): number {
    const action = TASK_ACTION[task];
    if (!action) return 0;
    const billing = billingOf(provider);
    if (ctx.meter) return ctx.meter.charge(action, billing, { count });
    // Without a meter the result still reports its platform cost.
    return billing === "platform" ? creditsFor(action, count) : 0;
  }

  async function moderate(task: AiTask, prompt: string, signal?: AbortSignal): Promise<void> {
    if (!ctx.moderation || !prompt.trim()) return;
    const verdict = await ctx.moderation({ task, prompt }, signal);
    if (!verdict.allowed) {
      throw new AiError("moderation-blocked", verdict.reason ?? "This request is not allowed.", {
        task,
        categories: verdict.categories ?? [],
      });
    }
  }

  async function run<T>(task: AiTask, fn: (ref: TaskModelRef) => Promise<T>): Promise<T> {
    let lastError: unknown;
    for (const ref of candidates(task)) {
      try {
        return await fn(ref);
      } catch (error) {
        lastError = error;
        if (!shouldFallback(error)) throw error;
      }
    }
    throw lastError;
  }

  async function inputBytes(
    img: ImageInput,
    signal?: AbortSignal,
  ): Promise<{ bytes: Uint8Array; mime: string }> {
    if ("bytes" in img) return img;
    const parsed = parseDataUri(img.url);
    if (parsed) return parsed;
    const init: RequestInit = signal ? { signal } : {};
    const res = await doFetch(img.url, init);
    if (!res.ok)
      throw new AiError("invalid-input", `Could not fetch the source image (${res.status}).`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    return {
      bytes,
      mime:
        img.mime ??
        res.headers.get("content-type") ??
        sniffMime(bytes) ??
        "application/octet-stream",
    };
  }

  function inputUrl(img: ImageInput): string {
    return "bytes" in img ? toDataUri(img.bytes, img.mime) : img.url;
  }

  async function download(
    file: FalFile,
    signal?: AbortSignal,
  ): Promise<{ bytes?: Uint8Array; mime: string; width?: number; height?: number }> {
    const parsed = parseDataUri(file.url);
    let bytes: Uint8Array | undefined;
    let mime = file.mime;
    if (parsed) {
      bytes = parsed.bytes;
      mime = mime ?? parsed.mime;
    } else if (ctx.download !== false) {
      const res = await doFetch(file.url, signal ? { signal } : {});
      if (!res.ok)
        throw new AiError("provider-error", `Downloading the result failed (${res.status}).`);
      bytes = new Uint8Array(await res.arrayBuffer());
      mime = mime ?? res.headers.get("content-type")?.split(";")[0] ?? undefined;
    }
    const sniffed = bytes ? sniffMime(bytes) : undefined;
    const finalMime = sniffed ?? mime ?? "application/octet-stream";
    const size = bytes ? imageSize(bytes, finalMime) : undefined;
    const out: { bytes?: Uint8Array; mime: string; width?: number; height?: number } = {
      mime: finalMime,
    };
    if (bytes) out.bytes = bytes;
    const width = size?.width ?? file.width;
    const height = size?.height ?? file.height;
    if (width) out.width = width;
    if (height) out.height = height;
    return out;
  }

  async function runFal(
    task: AiTask,
    ref: TaskModelRef,
    request: FalRequest,
    signal?: AbortSignal,
  ) {
    const adapter = falAdapterFor(ref.model);
    const endpoint = adapter.endpoint(ref.model, request);
    ctx.onProgress?.({ task, status: "queued" });
    const { data } = await ctx.providers.fal().run(endpoint, adapter.input(request), {
      ...(signal ? { signal } : {}),
      onQueueUpdate: (u) =>
        ctx.onProgress?.({
          task,
          status:
            u.status === "IN_QUEUE"
              ? "queued"
              : u.status === "IN_PROGRESS"
                ? "running"
                : "downloading",
          ...(u.position !== undefined ? { position: u.position } : {}),
          ...(u.logs?.length ? { message: u.logs[u.logs.length - 1] } : {}),
        }),
    });
    const output = adapter.output(data);
    if (output.files.length === 0) {
      throw new AiError("invalid-output", `fal ${endpoint} returned no files.`, { endpoint });
    }
    ctx.onProgress?.({ task, status: "downloading" });
    const files = await Promise.all(output.files.map((f) => download(f, signal)));
    ctx.onProgress?.({ task, status: "done" });
    return {
      endpoint,
      files,
      urls: output.files.map((f) => f.url),
      seed: output.seed,
      durationMs: output.durationMs,
    };
  }

  function result(
    ref: TaskModelRef,
    prompt: string,
    file: { bytes?: Uint8Array; mime: string; width?: number; height?: number },
    extra: {
      url?: string;
      seed?: number;
      durationMs?: number;
      model?: string;
      costCredits: number;
    },
  ): MediaResult {
    const out: MediaResult = {
      mime: file.mime,
      provider: ref.provider,
      model: extra.model ?? ref.model,
      prompt,
      costCredits: extra.costCredits,
      billing: billingOf(ref.provider),
    };
    if (file.bytes) out.bytes = file.bytes;
    if (extra.url && !extra.url.startsWith("data:")) out.url = extra.url;
    if (file.width) out.width = file.width;
    if (file.height) out.height = file.height;
    if (extra.seed !== undefined) out.seed = extra.seed;
    if (extra.durationMs !== undefined) out.durationMs = extra.durationMs;
    return out;
  }

  /** Vector results are sanitized before they reach a design. */
  function cleanVector(file: {
    bytes?: Uint8Array;
    mime: string;
    width?: number;
    height?: number;
  }) {
    if (file.mime !== "image/svg+xml" || !file.bytes) return file;
    const { svg } = sanitizeSvg(utf8(file.bytes));
    return { ...file, bytes: fromUtf8(svg) };
  }

  const media: Media = {
    async generateImage(options) {
      throwIfAborted(options.signal);
      const task: AiTask = options.vector ? "vector" : options.withText ? "imageText" : "image";
      const width = options.width ?? 1024;
      const height = options.height ?? 1024;
      const n = Math.max(1, Math.min(4, options.n ?? 1));
      const parts = [options.prompt.trim()];
      if (options.style && task !== "vector") parts.push(STYLE_HINTS[options.style]);
      if (options.negativePrompt) parts.push(`Avoid: ${options.negativePrompt}`);
      const prompt = parts.join(". ");
      await moderate(task, prompt, options.signal);
      return run(task, async (ref) => {
        precheck(task, ref.provider, n);
        if (ref.provider === "fal") {
          const out = await runFal(
            task,
            ref,
            {
              task: task as "image",
              prompt,
              width,
              height,
              n,
              ...(options.seed !== undefined ? { seed: options.seed } : {}),
              ...(options.palette ? { palette: options.palette } : {}),
            },
            options.signal,
          );
          const cost = charge(task, ref.provider, out.files.length);
          return out.files.map((f, i) =>
            result(ref, prompt, cleanVector(f), {
              ...(out.urls[i] ? { url: out.urls[i] } : {}),
              ...(out.seed !== undefined ? { seed: out.seed } : {}),
              model: out.endpoint,
              costCredits: cost / out.files.length,
            }),
          );
        }
        const generated = await sdkGenerateImage({
          model: ctx.providers.imageModel(providerRef(ref)),
          prompt: options.palette?.length
            ? `${prompt}. Color palette: ${options.palette.join(", ")}`
            : prompt,
          n,
          aspectRatio: `${Math.round((width / height) * 1000)}:1000` as `${number}:${number}`,
          ...(options.seed !== undefined ? { seed: options.seed } : {}),
          ...(options.signal ? { abortSignal: options.signal } : {}),
        });
        const cost = charge(task, ref.provider, generated.images.length);
        return generated.images.map((img) => {
          const mime = sniffMime(img.uint8Array) ?? img.mediaType;
          const size = imageSize(img.uint8Array, mime);
          return result(
            ref,
            prompt,
            cleanVector({ bytes: img.uint8Array, mime, ...(size ?? {}) }),
            {
              ...(options.seed !== undefined ? { seed: options.seed } : {}),
              costCredits: cost / generated.images.length,
            },
          );
        });
      });
    },

    async generateSvg(options) {
      throwIfAborted(options.signal);
      await moderate("svg", options.prompt, options.signal);
      return run("svg", async (ref) => {
        precheck("svg", ref.provider);
        const model = ctx.providers.languageModel(providerRef(ref));
        const instructions = svgSystemPrompt({
          ...(options.kind ? { kind: options.kind } : {}),
          ...(options.width ? { width: options.width } : {}),
          ...(options.height ? { height: options.height } : {}),
          ...(options.palette ? { palette: options.palette } : {}),
          ...(options.strokeOnly ? { strokeOnly: true } : {}),
        });
        const messages: ModelMessage[] = [{ role: "user", content: `Draw: ${options.prompt}` }];
        const maxRepairs = options.maxRepairs ?? 2;
        let repairs = 0;
        let best: string | undefined;
        for (;;) {
          const res = await generateText({
            model,
            instructions,
            messages,
            temperature: 0.4,
            maxOutputTokens: 16_000,
            ...(options.signal ? { abortSignal: options.signal } : {}),
          });
          const raw = extractSvg(res.text);
          let issues: string[];
          if (!raw) {
            issues = ["Answer with a complete <svg>…</svg> document only."];
          } else {
            try {
              const cleaned = optimizeSvg(sanitizeSvg(raw).svg);
              const validation = validateSvg(
                cleaned,
                options.palette ? { palette: options.palette } : {},
              );
              best = cleaned;
              issues = validation.issues;
            } catch (error) {
              issues = [
                error instanceof SvgParseError
                  ? `Not well-formed: ${error.message}.`
                  : "Not a valid SVG.",
              ];
            }
          }
          if (issues.length === 0 || repairs >= maxRepairs) {
            if (!best)
              throw new AiError(
                "invalid-output",
                `The model did not produce a valid SVG: ${issues.join(" ")}`,
              );
            break;
          }
          repairs++;
          messages.push(
            { role: "assistant", content: res.text },
            {
              role: "user",
              content: `Fix these problems and answer with the corrected SVG only:\n- ${issues.join("\n- ")}`,
            },
          );
        }
        let svg = best as string;
        if (options.palette?.length) svg = constrainPalette(svg, options.palette);
        const validation = validateSvg(svg);
        const bytes = fromUtf8(svg);
        const vb = validation.viewBox;
        const cost = charge("svg", ref.provider);
        const out: SvgResult = {
          ...result(
            ref,
            options.prompt,
            { bytes, mime: "image/svg+xml", ...(vb ? { width: vb[2], height: vb[3] } : {}) },
            { costCredits: cost },
          ),
          svg,
          colors: validation.colors,
          repairs,
        };
        return out;
      });
    },

    async removeBackground(options: RemoveBackgroundOptions) {
      throwIfAborted(options.signal);
      return run("bgRemove", async (ref) => {
        if (ref.provider !== "fal") {
          throw new AiError(
            "unsupported",
            "Background removal runs on fal; pick a fal model in settings.",
          );
        }
        precheck("bgRemove", ref.provider);
        const src =
          "bytes" in options.image ? imageSize(options.image.bytes, options.image.mime) : undefined;
        const out = await runFal(
          "bgRemove",
          ref,
          {
            task: "bgRemove",
            image: inputUrl(options.image),
            ...(src ? { width: src.width, height: src.height } : {}),
          },
          options.signal,
        );
        const cost = charge("bgRemove", ref.provider);
        return result(ref, "", out.files[0] as { mime: string }, {
          ...(out.urls[0] ? { url: out.urls[0] } : {}),
          costCredits: cost,
        });
      });
    },

    async inpaint(options: InpaintOptions) {
      throwIfAborted(options.signal);
      await moderate("inpaint", options.prompt, options.signal);
      return run("inpaint", async (ref) => {
        precheck("inpaint", ref.provider);
        if (ref.provider === "fal") {
          const out = await runFal(
            "inpaint",
            ref,
            {
              task: "inpaint",
              image: inputUrl(options.image),
              mask: inputUrl(options.mask),
              prompt: options.prompt,
              ...(options.seed !== undefined ? { seed: options.seed } : {}),
            },
            options.signal,
          );
          const cost = charge("inpaint", ref.provider);
          return result(ref, options.prompt, out.files[0] as { mime: string }, {
            ...(out.urls[0] ? { url: out.urls[0] } : {}),
            ...(out.seed !== undefined ? { seed: out.seed } : {}),
            costCredits: cost,
          });
        }
        const [image, mask] = await Promise.all([
          inputBytes(options.image, options.signal),
          inputBytes(options.mask, options.signal),
        ]);
        const generated = await sdkGenerateImage({
          model: ctx.providers.imageModel(providerRef(ref)),
          prompt: { text: options.prompt, images: [image.bytes], mask: mask.bytes },
          ...(options.seed !== undefined ? { seed: options.seed } : {}),
          ...(options.signal ? { abortSignal: options.signal } : {}),
        });
        const img = generated.image;
        const mime = sniffMime(img.uint8Array) ?? img.mediaType;
        return result(
          ref,
          options.prompt,
          { bytes: img.uint8Array, mime, ...(imageSize(img.uint8Array, mime) ?? {}) },
          {
            costCredits: charge("inpaint", ref.provider),
          },
        );
      });
    },

    async outpaint(options: OutpaintOptions) {
      throwIfAborted(options.signal);
      const prompt = options.prompt ?? "";
      await moderate("outpaint", prompt, options.signal);
      let srcW = options.sourceWidth;
      let srcH = options.sourceHeight;
      if (!srcW || !srcH) {
        const { bytes, mime } = await inputBytes(options.image, options.signal);
        const size = imageSize(bytes, mime);
        if (!size) throw new AiError("invalid-input", "Could not read the source image size.");
        srcW = size.width;
        srcH = size.height;
      }
      const expansion = outpaintExpansion(srcW, srcH, options.target, options.direction ?? "all");
      return run("outpaint", async (ref) => {
        if (ref.provider !== "fal")
          throw new AiError(
            "unsupported",
            "Image expansion runs on fal; pick a fal model in settings.",
          );
        precheck("outpaint", ref.provider);
        const out = await runFal(
          "outpaint",
          ref,
          {
            task: "outpaint",
            image: inputUrl(options.image),
            srcWidth: srcW as number,
            srcHeight: srcH as number,
            ...expansion,
            ...(options.prompt ? { prompt: options.prompt } : {}),
            ...(options.seed !== undefined ? { seed: options.seed } : {}),
          },
          options.signal,
        );
        return result(ref, prompt, out.files[0] as { mime: string }, {
          ...(out.urls[0] ? { url: out.urls[0] } : {}),
          ...(out.seed !== undefined ? { seed: out.seed } : {}),
          costCredits: charge("outpaint", ref.provider),
        });
      });
    },

    async upscale(options: UpscaleOptions) {
      throwIfAborted(options.signal);
      const factor =
        options.factor === 4
          ? 4
          : options.factor && options.factor > 1
            ? Math.min(4, options.factor)
            : 2;
      return run("upscale", async (ref) => {
        if (ref.provider !== "fal")
          throw new AiError("unsupported", "Upscaling runs on fal; pick a fal model in settings.");
        precheck("upscale", ref.provider);
        const out = await runFal(
          "upscale",
          ref,
          { task: "upscale", image: inputUrl(options.image), factor },
          options.signal,
        );
        return result(ref, "", out.files[0] as { mime: string }, {
          ...(out.urls[0] ? { url: out.urls[0] } : {}),
          costCredits: charge("upscale", ref.provider),
        });
      });
    },

    async mockup(options: MockupOptions) {
      throwIfAborted(options.signal);
      const prompt =
        `Place the design from the first image into this scene: ${options.scene}. ` +
        "Reproduce the design exactly (same layout, text, colors and proportions) as a physical object in the scene, " +
        "with realistic perspective, lighting, shadows and material texture. Do not add or change any text.";
      await moderate("mockup", options.scene, options.signal);
      return run("mockup", async (ref) => {
        precheck("mockup", ref.provider);
        const images = [options.design, ...(options.references ?? [])];
        if (ref.provider === "fal") {
          const out = await runFal(
            "mockup",
            ref,
            {
              task: "mockup",
              images: images.map(inputUrl),
              prompt,
              ...(options.aspectRatio ? { aspectRatio: options.aspectRatio } : {}),
              ...(options.seed !== undefined ? { seed: options.seed } : {}),
            },
            options.signal,
          );
          return result(ref, prompt, out.files[0] as { mime: string }, {
            ...(out.urls[0] ? { url: out.urls[0] } : {}),
            costCredits: charge("mockup", ref.provider),
          });
        }
        const inputs = await Promise.all(images.map((i) => inputBytes(i, options.signal)));
        const generated = await sdkGenerateImage({
          model: ctx.providers.imageModel(providerRef(ref)),
          prompt: { text: prompt, images: inputs.map((i) => i.bytes) },
          ...(options.signal ? { abortSignal: options.signal } : {}),
        });
        const img = generated.image;
        const mime = sniffMime(img.uint8Array) ?? img.mediaType;
        return result(
          ref,
          prompt,
          { bytes: img.uint8Array, mime, ...(imageSize(img.uint8Array, mime) ?? {}) },
          {
            costCredits: charge("mockup", ref.provider),
          },
        );
      });
    },

    async trace(options: TraceOptionsMedia): Promise<TraceMediaResult> {
      throwIfAborted(options.signal);
      return run("trace", async (ref) => {
        precheck("trace", ref.provider);
        if (ref.provider === BUILTIN_PROVIDER) {
          const { bytes, mime } = await inputBytes(options.image, options.signal);
          if ((sniffMime(bytes) ?? mime) !== "image/png") {
            throw new AiError(
              "unsupported",
              "The built-in tracer reads PNG images; use the fal vectorizer for JPEG/WebP.",
            );
          }
          const traced = await traceRaster(bytes, {
            ...(options.colors ? { colors: options.colors } : {}),
            ...(options.detail ? { detail: options.detail } : {}),
          });
          const svg = optimizeSvg(traced.svg);
          const out: TraceMediaResult = {
            ...result(
              ref,
              "",
              {
                bytes: fromUtf8(svg),
                mime: "image/svg+xml",
                width: traced.width,
                height: traced.height,
              },
              {
                costCredits: charge("trace", ref.provider),
              },
            ),
            svg,
            colors: traced.layers.map((l) => l.color),
            repairs: 0,
            layers: traced.layers,
          };
          return out;
        }
        if (ref.provider !== "fal")
          throw new AiError("unsupported", "Tracing runs on fal or the built-in tracer.");
        const out = await runFal(
          "trace",
          ref,
          { task: "trace", image: inputUrl(options.image) },
          options.signal,
        );
        const file = out.files[0] as {
          bytes?: Uint8Array;
          mime: string;
          width?: number;
          height?: number;
        };
        if (!file.bytes)
          throw new AiError("invalid-output", "The vectorizer returned no SVG bytes.");
        const svg = optimizeSvg(sanitizeSvg(utf8(file.bytes)).svg);
        const validation = validateSvg(svg);
        const vb = validation.viewBox;
        const traced: TraceMediaResult = {
          ...result(
            ref,
            "",
            {
              bytes: fromUtf8(svg),
              mime: "image/svg+xml",
              ...(vb ? { width: vb[2], height: vb[3] } : {}),
            },
            {
              ...(out.urls[0] ? { url: out.urls[0] } : {}),
              costCredits: charge("trace", ref.provider),
            },
          ),
          svg,
          colors: validation.colors,
          repairs: 0,
        };
        return traced;
      });
    },

    async generateVideo(options: GenerateVideoOptions) {
      throwIfAborted(options.signal);
      await moderate("video", options.prompt, options.signal);
      return run("video", async (ref) => {
        precheck("video", ref.provider);
        if (ref.provider === "fal") {
          const out = await runFal(
            "video",
            ref,
            {
              task: "video",
              prompt: options.prompt,
              ...(options.image ? { image: inputUrl(options.image) } : {}),
              ...(options.durationSec ? { durationSec: options.durationSec } : {}),
              ...(options.aspectRatio ? { aspectRatio: options.aspectRatio } : {}),
              ...(options.resolution ? { resolution: options.resolution } : {}),
              ...(options.audio !== undefined ? { audio: options.audio } : {}),
              ...(options.seed !== undefined ? { seed: options.seed } : {}),
            },
            options.signal,
          );
          return result(ref, options.prompt, out.files[0] as { mime: string }, {
            ...(out.urls[0] ? { url: out.urls[0] } : {}),
            ...(out.seed !== undefined ? { seed: out.seed } : {}),
            ...(out.durationMs !== undefined ? { durationMs: out.durationMs } : {}),
            model: out.endpoint,
            costCredits: charge("video", ref.provider),
          });
        }
        const image = options.image ? await inputBytes(options.image, options.signal) : undefined;
        const generated = await experimental_generateVideo({
          model: ctx.providers.videoModel(providerRef(ref)),
          prompt: image ? { image: image.bytes, text: options.prompt } : options.prompt,
          ...(options.durationSec ? { duration: options.durationSec } : {}),
          ...(options.aspectRatio
            ? { aspectRatio: options.aspectRatio as `${number}:${number}` }
            : {}),
          ...(options.seed !== undefined ? { seed: options.seed } : {}),
          ...(options.audio !== undefined ? { generateAudio: options.audio } : {}),
          ...(options.signal ? { abortSignal: options.signal } : {}),
        });
        const video = generated.video;
        return result(
          ref,
          options.prompt,
          { bytes: video.uint8Array, mime: sniffMime(video.uint8Array) ?? video.mediaType },
          {
            ...(options.durationSec ? { durationMs: options.durationSec * 1000 } : {}),
            costCredits: charge("video", ref.provider),
          },
        );
      });
    },

    async speech(options: SpeechOptions) {
      throwIfAborted(options.signal);
      await moderate("speech", options.text, options.signal);
      return run("speech", async (ref) => {
        precheck("speech", ref.provider);
        if (ref.provider === "fal") {
          const out = await runFal(
            "speech",
            ref,
            {
              task: "speech",
              text: options.text,
              ...(options.voice ? { voice: options.voice } : {}),
              ...(options.language ? { language: options.language } : {}),
              ...(options.speed ? { speed: options.speed } : {}),
            },
            options.signal,
          );
          return result(ref, options.text, out.files[0] as { mime: string }, {
            ...(out.urls[0] ? { url: out.urls[0] } : {}),
            ...(out.durationMs !== undefined ? { durationMs: out.durationMs } : {}),
            costCredits: charge("speech", ref.provider),
          });
        }
        const speech = await generateSpeech({
          model: ctx.providers.speechModel(providerRef(ref)),
          text: options.text,
          ...(options.voice ? { voice: options.voice } : {}),
          ...(options.language ? { language: options.language } : {}),
          ...(options.speed ? { speed: options.speed } : {}),
          ...(options.signal ? { abortSignal: options.signal } : {}),
        });
        const audio = speech.audio;
        return result(
          ref,
          options.text,
          { bytes: audio.uint8Array, mime: sniffMime(audio.uint8Array) ?? audio.mediaType },
          {
            costCredits: charge("speech", ref.provider),
          },
        );
      });
    },
  };
  return media;
}

/** Pixels to add on each side (in source pixels) so the result has the target aspect ratio at full source scale. */
export function outpaintExpansion(
  srcW: number,
  srcH: number,
  target: { width: number; height: number },
  direction: NonNullable<OutpaintOptions["direction"]>,
): { left: number; right: number; top: number; bottom: number } {
  const s = Math.min(target.width / srcW, target.height / srcH);
  const totalW = target.width / s;
  const totalH = target.height / s;
  const extraX = Math.max(0, totalW - srcW);
  const extraY = Math.max(0, totalH - srcH);
  const split = (n: number) => [Math.floor(n / 2), Math.ceil(n / 2)] as const;
  let left = 0;
  let right = 0;
  let top = 0;
  let bottom = 0;
  const [hx0, hx1] = split(Math.round(extraX));
  const [vy0, vy1] = split(Math.round(extraY));
  switch (direction) {
    case "left":
      left = Math.round(extraX);
      [top, bottom] = [vy0, vy1];
      break;
    case "right":
      right = Math.round(extraX);
      [top, bottom] = [vy0, vy1];
      break;
    case "up":
      top = Math.round(extraY);
      [left, right] = [hx0, hx1];
      break;
    case "down":
      bottom = Math.round(extraY);
      [left, right] = [hx0, hx1];
      break;
    default:
      [left, right] = [hx0, hx1];
      [top, bottom] = [vy0, vy1];
  }
  return { left, right, top, bottom };
}
