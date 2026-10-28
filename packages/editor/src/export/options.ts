import type { ExportRequest } from "@desyn/engine";
import type { FeatureKey } from "@desyn/schema";
import { type ExportFormat, type FormatInfo, formatInfo } from "./formats.ts";

/**
 * Export options, their validation and the plan that decides how an export runs: small exports render in the
 * browser with the engine (`EngineClient.export`), large / multi-page / video ones become Convex export jobs
 * rendered by the worker (`exports.request`, progress + e-mail). Pure: unit tested.
 */

/** Same bounds as the server (`MAX_EXPORT_SCALE`) and the renderer (`MAX_OUTPUT_SIDE`). */
export const MIN_SCALE = 0.1;
export const MAX_SCALE = 8;
export const MAX_OUTPUT_SIDE = 16384;
/** Jobs above this many pages run on the server (and e-mail when ready), like the server's EXPORT_LARGE_PAGES. */
export const BROWSER_MAX_PAGES = 5;
/** Largest image the browser renders per file (megapixels); larger ones go to the worker. */
export const BROWSER_MAX_MEGAPIXELS = 48;

export interface ExportOptions {
  format: ExportFormat;
  /** Pages to export: all, the current one, or a list (kept in document order). */
  pages: "all" | "current" | string[];
  sizeMode: "scale" | "width";
  scale: number;
  /** Target width in px of the first exported page (sizeMode "width"). */
  width: number;
  /** 1..100 (JPG / WebP). */
  quality: number;
  transparent: boolean;
  /** Background override (`#rrggbb`) or null for the page's own background. */
  background: string | null;
  pdf: { bleed: boolean; cropMarks: boolean; cmyk: boolean; dpi: number };
  fps: number;
  /** E-mail when a server export is ready (default: only for large jobs). */
  notify: boolean;
  /** Render on the server even when the browser could. */
  forceServer: boolean;
}

export interface ExportPageInfo {
  id: string;
  name: string;
  width: number;
  height: number;
  bleed: number;
}

export interface ExportContext {
  designName: string;
  pages: ExportPageInfo[];
  currentPageId: string | null;
  /** Resolved plan features of the user (missing keys count as unavailable). */
  features: Partial<Record<FeatureKey, boolean>>;
  engineReady: boolean;
  signedIn: boolean;
  /** A backend for export jobs exists (Convex client). */
  serverAvailable: boolean;
}

export type ExportField =
  | "format"
  | "pages"
  | "scale"
  | "width"
  | "quality"
  | "background"
  | "pdf"
  | "fps"
  | "route";

export interface ExportOutput {
  pageId: string | null;
  name: string;
  width: number;
  height: number;
}

export interface ExportPlan {
  ok: boolean;
  errors: Partial<Record<ExportField, string>>;
  warnings: string[];
  /** Plan features the format / options need and the user lacks (shown with a Pro badge). */
  locked: FeatureKey[];
  format: FormatInfo;
  pageIds: string[];
  /** Effective scale (from the scale or the target width). */
  scale: number;
  /** Files the export produces (before zipping) with their pixel size (vector formats: the page size). */
  outputs: ExportOutput[];
  route: "browser" | "server";
  /** Why it runs on the server (shown in the dialog). */
  serverReason: string | null;
}

export function defaultExportOptions(format: ExportFormat = "png"): ExportOptions {
  return {
    format,
    pages: "all",
    sizeMode: "scale",
    scale: 2,
    width: 1920,
    quality: 90,
    transparent: false,
    background: null,
    pdf: { bleed: true, cropMarks: true, cmyk: false, dpi: 300 },
    fps: format === "mp4" ? 30 : 15,
    notify: false,
    forceServer: false,
  };
}

/** Frame rates the dialog offers per format (the server accepts 1-60). */
export const FPS_CHOICES: Partial<Record<ExportFormat, readonly number[]>> = {
  gif: [10, 15, 24, 30],
  mp4: [24, 30, 60],
};

/** `fps` when the format offers it, else the format's default (GIF 15, video 30, as the worker). */
export function snapFps(format: ExportFormat, fps: number): number {
  const choices = FPS_CHOICES[format];
  if (!choices || choices.includes(fps)) return fps;
  return format === "mp4" ? 30 : 15;
}

const HEX = /^#[0-9a-f]{6}$/;

export function resolvePages(options: ExportOptions, ctx: ExportContext): string[] {
  const order = ctx.pages.map((p) => p.id);
  if (options.pages === "all") return order;
  if (options.pages === "current") {
    return ctx.currentPageId && order.includes(ctx.currentPageId) ? [ctx.currentPageId] : [];
  }
  const chosen = new Set(options.pages);
  return order.filter((id) => chosen.has(id));
}

/** Validates options against the design and the plan and decides where the export runs. */
export function planExport(options: ExportOptions, ctx: ExportContext): ExportPlan {
  const format = formatInfo(options.format);
  const errors: ExportPlan["errors"] = {};
  const warnings: string[] = [];

  const locked = format.features.filter((f) => ctx.features[f] !== true);
  if (locked.length > 0) {
    errors.format =
      locked.includes("export.pdfPrint") && !locked.some((f) => f !== "export.pdfPrint")
        ? "Print-ready PDFs are part of Desyn Pro."
        : `${format.label} export is part of Desyn Pro.`;
  }

  const pageIds = resolvePages(options, ctx);
  if (pageIds.length === 0) errors.pages = "Choose at least one page.";
  const pages = pageIds
    .map((id) => ctx.pages.find((p) => p.id === id))
    .filter((p): p is ExportPageInfo => !!p);
  const first = pages[0];

  let scale = 1;
  if (format.supports.scale) {
    if (options.sizeMode === "width") {
      if (
        !Number.isFinite(options.width) ||
        options.width < 16 ||
        options.width > MAX_OUTPUT_SIDE
      ) {
        errors.width = `Width must be between 16 and ${MAX_OUTPUT_SIDE} px.`;
      } else if (first && first.width > 0) {
        scale = options.width / first.width;
      }
    } else {
      scale = options.scale;
    }
    if (!errors.width && !(Number.isFinite(scale) && scale >= MIN_SCALE && scale <= MAX_SCALE)) {
      errors[options.sizeMode === "width" ? "width" : "scale"] =
        options.sizeMode === "width"
          ? "That width needs a scale outside 0.1× to 8×."
          : `Scale must be between ${MIN_SCALE}× and ${MAX_SCALE}×.`;
    }
  }

  if (format.supports.quality) {
    if (!Number.isInteger(options.quality) || options.quality < 1 || options.quality > 100) {
      errors.quality = "Quality must be a whole number from 1 to 100.";
    }
  }

  if (options.transparent && !format.supports.transparent) {
    warnings.push(`${format.label} has no transparency; the page background is kept.`);
  }
  if (options.background !== null && !HEX.test(options.background)) {
    errors.background = "Use a color like #ffb02e.";
  }

  if (format.supports.compression) {
    const dpi = options.pdf.dpi;
    if (!Number.isFinite(dpi) || dpi < 72 || dpi > 600)
      errors.pdf = "Resolution must be 72 to 600 dpi.";
  }
  if (
    format.supports.bleed &&
    options.pdf.bleed &&
    pages.length > 0 &&
    pages.every((p) => p.bleed <= 0)
  ) {
    warnings.push("These pages have no bleed set, so the PDF ends at the page edge.");
  }

  if (format.supports.fps) {
    const [lo, hi] = format.id === "gif" ? [5, 30] : [12, 60];
    if (!Number.isFinite(options.fps) || options.fps < lo || options.fps > hi) {
      errors.fps = `Frame rate must be ${lo} to ${hi} fps.`;
    }
  }

  const effectiveScale = format.supports.scale ? scale : 1;
  const outputs: ExportOutput[] = [];
  if (format.perPage) {
    for (const p of pages) {
      outputs.push({
        pageId: p.id,
        name: p.name,
        width: Math.round(p.width * effectiveScale),
        height: Math.round(p.height * effectiveScale),
      });
    }
  } else if (first) {
    const bleed = format.supports.bleed && options.pdf.bleed ? first.bleed * 2 : 0;
    outputs.push({
      pageId: null,
      name: ctx.designName,
      width: Math.round((first.width + bleed) * effectiveScale),
      height: Math.round((first.height + bleed) * effectiveScale),
    });
  }
  if (format.supports.scale && !errors.scale && !errors.width) {
    const tooBig = outputs.find((o) => o.width > MAX_OUTPUT_SIDE || o.height > MAX_OUTPUT_SIDE);
    if (tooBig) {
      errors[options.sizeMode === "width" ? "width" : "scale"] =
        `${tooBig.width} × ${tooBig.height} px is larger than ${MAX_OUTPUT_SIDE} px on a side.`;
    }
  }

  // Where it runs.
  const all = pageIds.length === ctx.pages.length;
  const maxMp = Math.max(0, ...outputs.map((o) => (o.width * o.height) / 1e6));
  let serverReason: string | null = null;
  if (!format.browser) serverReason = `${format.label} is rendered on Desyn's servers.`;
  else if (options.forceServer) serverReason = "Rendering on the server as requested.";
  else if (pageIds.length > BROWSER_MAX_PAGES)
    serverReason = `${pageIds.length} pages render on the server.`;
  else if (!format.perPage && !all && pageIds.length > 1)
    serverReason = "A selection of pages renders on the server.";
  else if (format.supports.scale && maxMp > BROWSER_MAX_MEGAPIXELS)
    serverReason = "Very large images render on the server.";
  else if (!ctx.engineReady) serverReason = "The canvas is still starting.";
  const route: ExportPlan["route"] = serverReason ? "server" : "browser";
  if (route === "server") {
    if (!ctx.serverAvailable) {
      errors.route = ctx.engineReady
        ? "This export needs the Desyn server, which is not connected."
        : "Wait for the canvas to finish loading.";
    } else if (!ctx.signedIn) {
      errors.route = "Sign in to export larger files.";
    }
  }

  return {
    ok: Object.keys(errors).length === 0,
    errors,
    warnings,
    locked,
    format,
    pageIds,
    scale: effectiveScale,
    outputs,
    route,
    serverReason,
  };
}

function backgroundOf(options: ExportOptions, format: FormatInfo): string | undefined {
  if (options.transparent && format.supports.transparent) return "transparent";
  return options.background ?? undefined;
}

/** Engine requests for an in-browser export (one per produced file). */
export function engineRequests(plan: ExportPlan, options: ExportOptions): ExportRequest[] {
  const f = plan.format;
  const background = backgroundOf(options, f);
  const base: ExportRequest = {
    format: f.wire as ExportRequest["format"],
    ...(f.supports.scale ? { scale: plan.scale } : {}),
    ...(f.supports.quality ? { quality: options.quality } : {}),
    ...(background ? { background } : {}),
    ...(f.supports.fps ? { fps: options.fps } : {}),
  };
  if (f.id === "pdf" || f.id === "pdf-print") {
    base.pdf = {
      dpi: options.pdf.dpi,
      ...(f.id === "pdf-print"
        ? { bleed: options.pdf.bleed, cropMarks: options.pdf.cropMarks, cmyk: options.pdf.cmyk }
        : {}),
    };
  }
  if (f.perPage) return plan.pageIds.map((pageId) => ({ ...base, pageId }));
  const single = plan.pageIds.length === 1 ? plan.pageIds[0] : undefined;
  return [{ ...base, pageId: single ?? "all" }];
}

/** Arguments of `exports.request` for a server export. */
export interface ServerExportArgs {
  format: FormatInfo["wire"];
  pages: "all" | string[];
  scale?: number;
  quality?: number;
  background?: string;
  pdf?: { bleed: boolean; cropMarks: boolean; cmyk: boolean };
  fps?: number;
  dpi?: number;
  /** Only sent to force the e-mail: omitted, the server mails for large jobs on its own. */
  notify?: true;
}

export function serverRequest(
  plan: ExportPlan,
  options: ExportOptions,
  totalPages: number,
): ServerExportArgs {
  const f = plan.format;
  const background = backgroundOf(options, f);
  return {
    format: f.wire,
    pages: plan.pageIds.length === totalPages ? "all" : plan.pageIds,
    ...(f.supports.scale ? { scale: Math.round(plan.scale * 1000) / 1000 } : {}),
    ...(f.supports.quality ? { quality: options.quality } : {}),
    ...(background ? { background } : {}),
    ...(f.id === "pdf-print"
      ? {
          pdf: {
            bleed: options.pdf.bleed,
            cropMarks: options.pdf.cropMarks,
            cmyk: options.pdf.cmyk,
          },
        }
      : f.id === "pdf"
        ? { pdf: { bleed: false, cropMarks: false, cmyk: false } }
        : {}),
    ...(f.supports.fps ? { fps: options.fps } : {}),
    ...(f.supports.compression ? { dpi: options.pdf.dpi } : {}),
    // `notify: false` would switch off the e-mail the server sends for large jobs and videos.
    ...(options.notify ? { notify: true as const } : {}),
  };
}

/**
 * Whether a server export e-mails a link when ready: when asked, and always for large jobs (more than
 * `BROWSER_MAX_PAGES` pages, video, GIF, PowerPoint), as `exports.request` decides on the server.
 */
export function emailsWhenReady(plan: ExportPlan, options: ExportOptions): boolean {
  return (
    options.notify ||
    plan.pageIds.length > BROWSER_MAX_PAGES ||
    plan.format.wire === "mp4" ||
    plan.format.wire === "gif" ||
    plan.format.wire === "pptx"
  );
}

/** File-system safe name (no separators / control characters), never empty. */
export function safeFileName(name: string, fallback = "design"): string {
  return (
    name
      .replace(/[\\/:*?"<>|]+/g, " ")
      .replace(/\p{Cc}+/gu, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120) || fallback
  );
}

/** Names of the produced files, unique within the export. */
export function outputFileNames(plan: ExportPlan, designName: string): string[] {
  const ext = plan.format.extension;
  const base = safeFileName(designName);
  if (!plan.format.perPage) return [`${base}.${ext}`];
  const used = new Set<string>();
  return plan.outputs.map((o, i) => {
    const page = safeFileName(o.name, `Page ${i + 1}`);
    let name =
      plan.outputs.length === 1
        ? `${base} - ${page}.${ext}`
        : `${String(i + 1).padStart(2, "0")} ${page}.${ext}`;
    let n = 2;
    while (used.has(name))
      name = name.replace(new RegExp(`(?: \\(\\d+\\))?\\.${ext}$`), ` (${n++}).${ext}`);
    used.add(name);
    return name;
  });
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
