import type { FeatureKey } from "@desyn/schema";

/**
 * Export formats (DOCUMENT_MODEL §8 and crates/desyn-raster). `pdf-print` is PDF with bleed, crop marks and
 * the CMYK option (plan feature `export.pdfPrint`); `mp4` is rendered by the worker only.
 */
export type ExportFormat =
  | "png"
  | "jpeg"
  | "webp"
  | "svg"
  | "pdf"
  | "pdf-print"
  | "pptx"
  | "gif"
  | "mp4";

/** Format name the engine / worker / `exports.request` use. */
export type WireFormat = "png" | "jpeg" | "webp" | "svg" | "pdf" | "pptx" | "gif" | "mp4";

export interface FormatInfo {
  id: ExportFormat;
  wire: WireFormat;
  label: string;
  /** One line for the picker. */
  description: string;
  extension: string;
  mime: string;
  /** Plan features needed (all of them). */
  features: FeatureKey[];
  /** One file per page (raster, SVG) vs one file for all selected pages (PDF, PPTX, GIF, MP4). */
  perPage: boolean;
  /** The in-browser engine can render it. */
  browser: boolean;
  supports: {
    scale: boolean;
    quality: boolean;
    transparent: boolean;
    /** PDF image resolution (file size). */
    compression: boolean;
    bleed: boolean;
    fps: boolean;
  };
  group: "image" | "document" | "motion";
}

export const FORMATS: readonly FormatInfo[] = [
  {
    id: "png",
    wire: "png",
    label: "PNG",
    description: "Sharp image, transparency",
    extension: "png",
    mime: "image/png",
    features: ["export.png"],
    perPage: true,
    browser: true,
    supports: {
      scale: true,
      quality: false,
      transparent: true,
      compression: false,
      bleed: false,
      fps: false,
    },
    group: "image",
  },
  {
    id: "jpeg",
    wire: "jpeg",
    label: "JPG",
    description: "Small image for photos",
    extension: "jpg",
    mime: "image/jpeg",
    features: ["export.jpg"],
    perPage: true,
    browser: true,
    supports: {
      scale: true,
      quality: true,
      transparent: false,
      compression: false,
      bleed: false,
      fps: false,
    },
    group: "image",
  },
  {
    id: "webp",
    wire: "webp",
    label: "WebP",
    description: "Modern web image",
    extension: "webp",
    mime: "image/webp",
    features: ["export.webp"],
    perPage: true,
    browser: true,
    supports: {
      scale: true,
      quality: true,
      transparent: true,
      compression: false,
      bleed: false,
      fps: false,
    },
    group: "image",
  },
  {
    id: "svg",
    wire: "svg",
    label: "SVG",
    description: "Scalable vector for the web",
    extension: "svg",
    mime: "image/svg+xml",
    features: ["export.svg"],
    perPage: true,
    browser: true,
    supports: {
      scale: false,
      quality: false,
      transparent: true,
      compression: false,
      bleed: false,
      fps: false,
    },
    group: "image",
  },
  {
    id: "pdf",
    wire: "pdf",
    label: "PDF",
    description: "Document with real text and vectors",
    extension: "pdf",
    mime: "application/pdf",
    features: ["export.pdf"],
    perPage: false,
    browser: true,
    supports: {
      scale: false,
      quality: false,
      transparent: false,
      compression: true,
      bleed: false,
      fps: false,
    },
    group: "document",
  },
  {
    id: "pdf-print",
    wire: "pdf",
    label: "PDF Print",
    description: "Bleed, crop marks and CMYK for printers",
    extension: "pdf",
    mime: "application/pdf",
    features: ["export.pdf", "export.pdfPrint"],
    perPage: false,
    browser: true,
    supports: {
      scale: false,
      quality: false,
      transparent: false,
      compression: true,
      bleed: true,
      fps: false,
    },
    group: "document",
  },
  {
    id: "pptx",
    wire: "pptx",
    label: "PowerPoint",
    description: "Editable slides with notes",
    extension: "pptx",
    mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    features: ["export.pptx"],
    perPage: false,
    browser: true,
    supports: {
      scale: false,
      quality: false,
      transparent: false,
      compression: false,
      bleed: false,
      fps: false,
    },
    group: "document",
  },
  {
    id: "gif",
    wire: "gif",
    label: "GIF",
    description: "Animated loop of the pages",
    extension: "gif",
    mime: "image/gif",
    features: ["export.video"],
    perPage: false,
    browser: true,
    supports: {
      scale: true,
      quality: false,
      transparent: false,
      compression: false,
      bleed: false,
      fps: true,
    },
    group: "motion",
  },
  {
    id: "mp4",
    wire: "mp4",
    label: "MP4 video",
    description: "Video with animations and transitions",
    extension: "mp4",
    mime: "video/mp4",
    features: ["export.video"],
    perPage: false,
    browser: false,
    supports: {
      scale: true,
      quality: false,
      transparent: false,
      compression: false,
      bleed: false,
      fps: true,
    },
    group: "motion",
  },
];

export function formatInfo(id: ExportFormat): FormatInfo {
  const f = FORMATS.find((x) => x.id === id);
  if (!f) throw new Error(`Unknown export format "${id}".`);
  return f;
}

export function isExportFormat(v: unknown): v is ExportFormat {
  return typeof v === "string" && FORMATS.some((f) => f.id === v);
}
