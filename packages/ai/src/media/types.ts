import type { Color } from "@desyn/schema";
import type { CreditMeter } from "../credits";
import type { ModelPrefs, TaskProvider } from "../models";
import type { AiProviders } from "../providers/config";
import type { Billing } from "../providers/types";
import type { FetchLike } from "../util/async";
import type { ModerationHook } from "./moderation";

/** Image given to an editing operation: raw bytes, or a URL the provider can fetch. */
export type ImageInput = { bytes: Uint8Array; mime: string } | { url: string; mime?: string };

export interface MediaResult {
  /** Downloaded bytes (always present unless `download: false`). */
  bytes?: Uint8Array;
  /** Provider URL (may expire); `undefined` for locally produced media. */
  url?: string;
  mime: string;
  width?: number;
  height?: number;
  durationMs?: number;
  provider: TaskProvider;
  model: string;
  prompt: string;
  seed?: number;
  /** Credits this result cost (0 for BYOK / local). */
  costCredits: number;
  billing: Billing;
}

export interface SvgResult extends MediaResult {
  svg: string;
  colors: Color[];
  /** Number of repair rounds the model needed. */
  repairs: number;
}

export interface TraceMediaResult extends SvgResult {
  /** Per-color layers when traced by the built-in tracer. */
  layers?: { color: Color; d: string; coverage: number }[];
}

export type ImageStyle =
  | "photo"
  | "illustration"
  | "3d"
  | "flat"
  | "painting"
  | "line-art"
  | "pixel";

export interface GenerateImageOptions {
  prompt: string;
  negativePrompt?: string;
  width?: number;
  height?: number;
  /** Must render legible words (routes to the text-in-image model). */
  withText?: boolean;
  /** Flat vector output as SVG (routes to the vector model). */
  vector?: boolean;
  style?: ImageStyle;
  /** Preferred colors (vector models honour them; others get them in the prompt). */
  palette?: Color[];
  seed?: number;
  n?: number;
  signal?: AbortSignal;
}

export type SvgKind =
  | "icon"
  | "illustration"
  | "pattern"
  | "logo"
  | "badge"
  | "decoration"
  | "divider";

export interface GenerateSvgOptions {
  prompt: string;
  kind?: SvgKind;
  width?: number;
  height?: number;
  palette?: Color[];
  /** Outline-only drawings (icons). */
  strokeOnly?: boolean;
  maxRepairs?: number;
  signal?: AbortSignal;
}

export interface RemoveBackgroundOptions {
  image: ImageInput;
  signal?: AbortSignal;
}

export interface InpaintOptions {
  image: ImageInput;
  /** White = replace, black = keep (same size as the image). */
  mask: ImageInput;
  prompt: string;
  seed?: number;
  signal?: AbortSignal;
}

export type OutpaintDirection =
  | "left"
  | "right"
  | "up"
  | "down"
  | "horizontal"
  | "vertical"
  | "all";

export interface OutpaintOptions {
  image: ImageInput;
  /** Source size in px (read from the bytes when omitted). */
  sourceWidth?: number;
  sourceHeight?: number;
  target: { width: number; height: number };
  /** Where new content grows; default "all" (centered). */
  direction?: OutpaintDirection;
  prompt?: string;
  seed?: number;
  signal?: AbortSignal;
}

export interface UpscaleOptions {
  image: ImageInput;
  /** 2 or 4 (default 2). */
  factor?: number;
  signal?: AbortSignal;
}

export interface MockupOptions {
  /** The design render to place. */
  design: ImageInput;
  /** Scene description, e.g. "poster in a sunlit concrete gallery". */
  scene: string;
  /** Extra reference images (scene photo, product shot). */
  references?: ImageInput[];
  aspectRatio?: string;
  seed?: number;
  signal?: AbortSignal;
}

export interface TraceOptionsMedia {
  image: ImageInput;
  colors?: number;
  detail?: "low" | "medium" | "high";
  signal?: AbortSignal;
}

export interface GenerateVideoOptions {
  prompt: string;
  /** First frame (image-to-video); omitted = text-to-video. */
  image?: ImageInput;
  durationSec?: number;
  aspectRatio?: "16:9" | "9:16" | "1:1" | "4:3" | "3:4";
  resolution?: "480p" | "720p" | "1080p";
  audio?: boolean;
  seed?: number;
  signal?: AbortSignal;
}

export interface SpeechOptions {
  text: string;
  voice?: string;
  language?: string;
  speed?: number;
  signal?: AbortSignal;
}

export interface MediaProgress {
  task: string;
  status: "queued" | "running" | "downloading" | "done";
  position?: number;
  message?: string;
}

export interface MediaContext {
  providers: AiProviders;
  prefs?: ModelPrefs;
  moderation?: ModerationHook;
  meter?: CreditMeter;
  fetch?: FetchLike;
  onProgress?: (progress: MediaProgress) => void;
  /** Download results to bytes (default true). */
  download?: boolean;
}

export interface Media {
  generateImage(options: GenerateImageOptions): Promise<MediaResult[]>;
  generateSvg(options: GenerateSvgOptions): Promise<SvgResult>;
  removeBackground(options: RemoveBackgroundOptions): Promise<MediaResult>;
  inpaint(options: InpaintOptions): Promise<MediaResult>;
  outpaint(options: OutpaintOptions): Promise<MediaResult>;
  upscale(options: UpscaleOptions): Promise<MediaResult>;
  mockup(options: MockupOptions): Promise<MediaResult>;
  trace(options: TraceOptionsMedia): Promise<TraceMediaResult>;
  generateVideo(options: GenerateVideoOptions): Promise<MediaResult>;
  speech(options: SpeechOptions): Promise<MediaResult>;
}
