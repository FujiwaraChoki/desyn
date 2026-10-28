// Input/output adapters for fal endpoints. Each pinned endpoint follows its published input schema (fetched from
// https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=<id> on 2026-10-20); endpoints picked by users from
// the live catalog fall back to a generic adapter based on the conventions shared by fal models.
import type { Color } from "@desyn/schema";

export type FalTask =
  | "image"
  | "imageText"
  | "vector"
  | "bgRemove"
  | "inpaint"
  | "outpaint"
  | "upscale"
  | "mockup"
  | "trace"
  | "video"
  | "speech";

export type FalRequest =
  | {
      task: "image" | "imageText" | "vector";
      prompt: string;
      width: number;
      height: number;
      n: number;
      seed?: number;
      palette?: Color[];
    }
  | { task: "bgRemove"; image: string; width?: number; height?: number }
  | { task: "inpaint"; image: string; mask: string; prompt: string; seed?: number }
  | {
      task: "outpaint";
      image: string;
      srcWidth: number;
      srcHeight: number;
      left: number;
      right: number;
      top: number;
      bottom: number;
      prompt?: string;
      seed?: number;
    }
  | { task: "upscale"; image: string; factor: number }
  | {
      task: "mockup";
      images: string[];
      prompt: string;
      width?: number;
      height?: number;
      aspectRatio?: string;
      seed?: number;
    }
  | { task: "trace"; image: string }
  | {
      task: "video";
      prompt: string;
      image?: string;
      durationSec?: number;
      aspectRatio?: string;
      resolution?: string;
      audio?: boolean;
      seed?: number;
    }
  | { task: "speech"; text: string; voice?: string; language?: string; speed?: number };

export interface FalFile {
  url: string;
  mime?: string;
  width?: number;
  height?: number;
}

export interface FalOutput {
  files: FalFile[];
  seed?: number;
  durationMs?: number;
}

export interface FalAdapter {
  /** Endpoint actually called (e.g. a text-to-video sibling when no start image is given). */
  endpoint(endpointId: string, request: FalRequest): string;
  input(request: FalRequest): Record<string, unknown>;
  output(data: unknown): FalOutput;
}

// Aspect ratio helpers -------------------------------------------------------------------------------------------

function ratioValue(r: string): number {
  const [w, h] = r.split(":").map(Number);
  return (w as number) / (h as number);
}

/** Closest ratio from `allowed` (compared in log space so 2:1 and 1:2 are symmetric). */
export function nearestRatio(width: number, height: number, allowed: readonly string[]): string {
  const target = Math.log(width / height);
  return allowed.reduce((best, r) =>
    Math.abs(Math.log(ratioValue(r)) - target) < Math.abs(Math.log(ratioValue(best)) - target)
      ? r
      : best,
  );
}

const SIZE_PRESETS: Record<string, string> = {
  "1:1": "square_hd",
  "3:4": "portrait_4_3",
  "9:16": "portrait_16_9",
  "4:3": "landscape_4_3",
  "16:9": "landscape_16_9",
};

function sizePreset(width: number, height: number): string {
  return SIZE_PRESETS[nearestRatio(width, height, Object.keys(SIZE_PRESETS))] as string;
}

function rgb(color: Color): { r: number; g: number; b: number } {
  const n = (i: number) => Number.parseInt(color.slice(i, i + 2), 16);
  return { r: n(1), g: n(3), b: n(5) };
}

function withSeed(
  input: Record<string, unknown>,
  seed: number | undefined,
): Record<string, unknown> {
  return seed === undefined ? input : { ...input, seed };
}

function promptWithPalette(prompt: string, palette?: Color[]): string {
  return palette && palette.length > 0
    ? `${prompt}. Color palette: ${palette.join(", ")}.`
    : prompt;
}

// Output parsing ---------------------------------------------------------------------------------------------------

interface RawFile {
  url?: unknown;
  content_type?: unknown;
  width?: unknown;
  height?: unknown;
}

function toFile(raw: unknown): FalFile | undefined {
  const f = raw as RawFile | undefined;
  if (!f || typeof f.url !== "string") return undefined;
  const out: FalFile = { url: f.url };
  if (typeof f.content_type === "string") out.mime = f.content_type;
  if (typeof f.width === "number") out.width = f.width;
  if (typeof f.height === "number") out.height = f.height;
  return out;
}

/** Handles the common fal shapes: `images[]`, `image`, `video`, `audio` (+ `seed`, `duration`, `duration_ms`). */
export function parseFalOutput(data: unknown): FalOutput {
  const d = (data ?? {}) as Record<string, unknown>;
  const files: FalFile[] = [];
  if (Array.isArray(d.images))
    for (const i of d.images) {
      const f = toFile(i);
      if (f) files.push(f);
    }
  for (const key of ["image", "video", "audio", "audio_file", "file"]) {
    const f = toFile(d[key]);
    if (f) files.push(f);
  }
  const out: FalOutput = { files };
  if (typeof d.seed === "number") out.seed = d.seed;
  if (typeof d.duration_ms === "number") out.durationMs = d.duration_ms;
  else if (typeof d.duration === "number") out.durationMs = Math.round(d.duration * 1000);
  return out;
}

const same = (id: string) => id;

function adapter(
  input: (r: FalRequest) => Record<string, unknown>,
  endpoint: FalAdapter["endpoint"] = same,
): FalAdapter {
  return { endpoint, input, output: parseFalOutput };
}

function expect<T extends FalRequest["task"]>(
  r: FalRequest,
  ...tasks: T[]
): Extract<FalRequest, { task: T }> {
  if (!tasks.includes(r.task as T)) throw new Error(`fal adapter cannot handle task "${r.task}"`);
  return r as Extract<FalRequest, { task: T }>;
}

const FLUX3_RATIOS = [
  "21:9",
  "2:1",
  "16:9",
  "3:2",
  "7:5",
  "4:3",
  "5:4",
  "1:1",
  "4:5",
  "3:4",
  "5:7",
  "2:3",
  "9:16",
  "1:2",
];
const NANO_RATIOS = [
  "21:9",
  "16:9",
  "3:2",
  "4:3",
  "5:4",
  "1:1",
  "4:5",
  "3:4",
  "2:3",
  "9:16",
  "4:1",
  "1:4",
  "8:1",
  "1:8",
];
const WAN_RATIOS = ["16:9", "4:3", "1:1", "3:4", "9:16"];
const SEEDANCE_RATIOS = ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"];

function resolutionK(width: number, height: number, upper = false): string {
  const long = Math.max(width, height);
  const k = long > 2600 ? "4k" : long > 1400 ? "2k" : "1k";
  return upper ? k.toUpperCase() : k;
}

/** Pinned endpoints with schema-exact inputs. */
export const FAL_ADAPTERS: Readonly<Record<string, FalAdapter>> = {
  "blackforestlabs/flux-3/text-to-image": adapter((r) => {
    const q = expect(r, "image", "imageText", "vector");
    return {
      prompt: promptWithPalette(q.prompt, q.palette),
      aspect_ratio: nearestRatio(q.width, q.height, FLUX3_RATIOS),
      resolution: resolutionK(q.width, q.height),
      output_format: "jpeg",
      safety_tolerance: 2,
    };
  }),
  "google/nano-banana-2.1": adapter((r) => {
    const q = expect(r, "image", "imageText", "vector");
    return withSeed(
      {
        prompt: promptWithPalette(q.prompt, q.palette),
        aspect_ratio: nearestRatio(q.width, q.height, NANO_RATIOS),
        resolution: resolutionK(q.width, q.height, true),
        num_images: q.n,
        output_format: "png",
      },
      q.seed,
    );
  }),
  "ideogram/v4.5": adapter((r) => {
    const q = expect(r, "image", "imageText", "vector");
    return withSeed(
      {
        prompt: promptWithPalette(q.prompt, q.palette),
        image_size: sizePreset(q.width, q.height),
        num_images: q.n,
        quality: "high",
      },
      q.seed,
    );
  }),
  "fal-ai/recraft/v4.1/text-to-vector": adapter((r) => {
    const q = expect(r, "image", "imageText", "vector");
    return {
      prompt: q.prompt,
      image_size: sizePreset(q.width, q.height),
      colors: (q.palette ?? []).map(rgb),
    };
  }),
  "fal-ai/recraft/v4/text-to-vector": adapter((r) => {
    const q = expect(r, "image", "imageText", "vector");
    return {
      prompt: q.prompt,
      image_size: sizePreset(q.width, q.height),
      colors: (q.palette ?? []).map(rgb),
    };
  }),
  "fal-ai/birefnet/v2": adapter((r) => {
    const q = expect(r, "bgRemove");
    const large = Math.max(q.width ?? 0, q.height ?? 0) > 1400;
    return {
      image_url: q.image,
      model: "General Use (Heavy)",
      operating_resolution: large ? "2048x2048" : "1024x1024",
      refine_foreground: true,
      output_format: "png",
    };
  }),
  "fal-ai/bria/background/remove": adapter((r) => ({ image_url: expect(r, "bgRemove").image })),
  "fal-ai/flux-pro/v1/fill": adapter((r) => {
    const q = expect(r, "inpaint");
    return withSeed(
      { image_url: q.image, mask_url: q.mask, prompt: q.prompt, output_format: "png" },
      q.seed,
    );
  }),
  "fal-ai/bria/genfill": adapter((r) => {
    const q = expect(r, "inpaint");
    return withSeed({ image_url: q.image, mask_url: q.mask, prompt: q.prompt }, q.seed);
  }),
  "fal-ai/flux-2-pro/outpaint": adapter((r) => {
    const q = expect(r, "outpaint");
    const clamp = (n: number) => Math.max(0, Math.min(2048, Math.round(n)));
    return {
      image_url: q.image,
      expand_left: clamp(q.left),
      expand_right: clamp(q.right),
      expand_top: clamp(q.top),
      expand_bottom: clamp(q.bottom),
      output_format: "png",
    };
  }),
  "fal-ai/bria/expand": adapter((r) => {
    const q = expect(r, "outpaint");
    return withSeed(
      {
        image_url: q.image,
        canvas_size: [
          Math.round(q.srcWidth + q.left + q.right),
          Math.round(q.srcHeight + q.top + q.bottom),
        ],
        original_image_size: [Math.round(q.srcWidth), Math.round(q.srcHeight)],
        original_image_location: [Math.round(q.left), Math.round(q.top)],
        prompt: q.prompt ?? "",
      },
      q.seed,
    );
  }),
  "fal-ai/seedvr/upscale/image": adapter((r) => {
    const q = expect(r, "upscale");
    return {
      image_url: q.image,
      upscale_mode: "factor",
      upscale_factor: q.factor,
      output_format: "png",
    };
  }),
  "topaz/upscale/image/precision": adapter((r) => {
    const q = expect(r, "upscale");
    return {
      image_url: q.image,
      upscale_factor: q.factor,
      model: "Standard V2",
      output_format: "png",
    };
  }),
  "google/nano-banana-2.1/edit": adapter((r) => {
    const q = expect(r, "mockup");
    return withSeed(
      {
        prompt: q.prompt,
        image_urls: q.images,
        aspect_ratio:
          q.aspectRatio ??
          (q.width && q.height ? nearestRatio(q.width, q.height, NANO_RATIOS) : "auto"),
        resolution: "2K",
        output_format: "png",
      },
      q.seed,
    );
  }),
  "bytedance/seedream/v5/pro/edit": adapter((r) => {
    const q = expect(r, "mockup");
    return {
      prompt: q.prompt,
      image_urls: q.images,
      image_size: q.width && q.height ? sizePreset(q.width, q.height) : "auto_2K",
      output_format: "png",
    };
  }),
  "fal-ai/recraft/vectorize": adapter((r) => ({ image_url: expect(r, "trace").image })),
  "alibaba/wan-3.0-prime/image-to-video": adapter(
    (r) => {
      const q = expect(r, "video");
      const base: Record<string, unknown> = {
        prompt: q.prompt,
        duration: Math.max(2, Math.min(30, Math.round(q.durationSec ?? 5))),
        resolution: q.resolution ?? "1080p",
        aspect_ratio:
          q.aspectRatio && WAN_RATIOS.includes(q.aspectRatio)
            ? q.aspectRatio
            : q.image
              ? "adaptive"
              : "16:9",
        audio: q.audio ?? false,
      };
      if (q.image) base.start_image_url = q.image;
      return withSeed(base, q.seed);
    },
    (id, r) =>
      r.task === "video" && !r.image ? id.replace(/\/image-to-video$/, "/text-to-video") : id,
  ),
  "bytedance/seedance-2.5/us/image-to-video": adapter(
    (r) => {
      const q = expect(r, "video");
      const seconds = Math.max(4, Math.min(15, Math.round(q.durationSec ?? 5)));
      const base: Record<string, unknown> = {
        prompt: q.prompt,
        duration: String(seconds),
        resolution: q.resolution ?? "720p",
        aspect_ratio:
          q.aspectRatio && SEEDANCE_RATIOS.includes(q.aspectRatio) ? q.aspectRatio : "auto",
        generate_audio: q.audio ?? false,
      };
      if (q.image) base.image_url = q.image;
      return base;
    },
    (id, r) =>
      r.task === "video" && !r.image ? id.replace(/\/image-to-video$/, "/text-to-video") : id,
  ),
  "elevenlabs/tts/eleven-v4": adapter((r) => {
    const q = expect(r, "speech");
    const input: Record<string, unknown> = {
      text: q.text,
      voice: q.voice ?? "Rachel",
      output_format: "mp3_44100_128",
    };
    if (q.language) input.language_code = q.language;
    return input;
  }),
  "fal-ai/minimax/speech-2.8-hd": adapter((r) => {
    const q = expect(r, "speech");
    return {
      prompt: q.text,
      output_format: "url",
      voice_setting: { voice_id: q.voice ?? "Wise_Woman", speed: q.speed ?? 1, vol: 1, pitch: 0 },
    };
  }),
};

/** Generic adapter for catalog endpoints without a pinned adapter (fal's common input conventions). */
export const GENERIC_FAL_ADAPTER: FalAdapter = adapter((r) => {
  switch (r.task) {
    case "image":
    case "imageText":
    case "vector":
      return withSeed(
        {
          prompt: promptWithPalette(r.prompt, r.palette),
          image_size: { width: Math.round(r.width), height: Math.round(r.height) },
          num_images: r.n,
        },
        r.seed,
      );
    case "bgRemove":
    case "trace":
      return { image_url: r.image };
    case "inpaint":
      return withSeed({ image_url: r.image, mask_url: r.mask, prompt: r.prompt }, r.seed);
    case "outpaint":
      return {
        image_url: r.image,
        expand_left: r.left,
        expand_right: r.right,
        expand_top: r.top,
        expand_bottom: r.bottom,
        prompt: r.prompt ?? "",
      };
    case "upscale":
      return { image_url: r.image, upscale_factor: r.factor, scale: r.factor };
    case "mockup":
      return withSeed({ prompt: r.prompt, image_urls: r.images }, r.seed);
    case "video": {
      const input: Record<string, unknown> = { prompt: r.prompt };
      if (r.image) input.image_url = r.image;
      if (r.durationSec) input.duration = r.durationSec;
      if (r.aspectRatio) input.aspect_ratio = r.aspectRatio;
      return withSeed(input, r.seed);
    }
    case "speech":
      return { text: r.text, prompt: r.text, ...(r.voice ? { voice: r.voice } : {}) };
  }
});

export function falAdapterFor(endpointId: string): FalAdapter {
  return FAL_ADAPTERS[endpointId] ?? GENERIC_FAL_ADAPTER;
}
