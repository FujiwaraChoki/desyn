import { imageSize } from "image-size";
import { MAX_SVG_BYTES } from "./designs_limits";
import { SvgSanitizeError, sanitizeSvg } from "./designs_svg";

// Upload validation shared by assets.finalize (S3 uploads) and assets.ingest (server-produced bytes):
// allowed types, magic-byte checks, image dimensions from the header bytes, SVG sanitization.

export type AssetKind = "image" | "svg" | "font" | "video" | "audio" | "lottie" | "data";

export const MIME_KINDS: Readonly<Record<string, AssetKind>> = {
  "image/png": "image",
  "image/jpeg": "image",
  "image/webp": "image",
  "image/gif": "image",
  "image/avif": "image",
  "image/svg+xml": "svg",
  "font/ttf": "font",
  "font/otf": "font",
  "font/woff": "font",
  "font/woff2": "font",
  "application/font-woff": "font",
  "application/x-font-ttf": "font",
  "application/x-font-otf": "font",
  "application/vnd.ms-opentype": "font",
  "video/mp4": "video",
  "video/webm": "video",
  "video/quicktime": "video",
  "audio/mpeg": "audio",
  "audio/wav": "audio",
  "audio/x-wav": "audio",
  "audio/ogg": "audio",
  "audio/mp4": "audio",
  "audio/aac": "audio",
  "application/json": "data",
};

/** image-size type names accepted for each image mime. */
const IMAGE_TYPES: Readonly<Record<string, readonly string[]>> = {
  "image/png": ["png"],
  "image/jpeg": ["jpg"],
  "image/webp": ["webp"],
  "image/gif": ["gif"],
  "image/avif": ["avif", "avis"],
};

export class UploadValidationError extends Error {}

export function normalizeMime(mime: string): string {
  return mime.split(";")[0]?.trim().toLowerCase() ?? "";
}

/** Asset kind for an upload, or null when the type is not accepted. `lottie` JSON is declared by the client. */
export function kindForMime(mime: string, declared?: "lottie" | "data"): AssetKind | null {
  const kind = MIME_KINDS[normalizeMime(mime)];
  if (!kind) return null;
  if (kind === "data" && declared === "lottie") return "lottie";
  return kind;
}

/** File name safe for an object key segment (keeps the extension). */
export function safeFileName(name: string): string {
  const cleaned = name
    .normalize("NFKD")
    .replace(/[^\w.-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(-80);
  return cleaned || "file";
}

function isFont(head: Uint8Array): boolean {
  const tag = String.fromCharCode(...head.slice(0, 4));
  return (
    tag === "OTTO" ||
    tag === "true" ||
    tag === "wOFF" ||
    tag === "wOF2" ||
    (head[0] === 0x00 && head[1] === 0x01 && head[2] === 0x00 && head[3] === 0x00)
  );
}

function isVideoOrAudio(mime: string, head: Uint8Array): boolean {
  const ascii = (from: number, to: number) => String.fromCharCode(...head.slice(from, to));
  switch (normalizeMime(mime)) {
    case "video/mp4":
    case "video/quicktime":
    case "audio/mp4":
      return (
        ascii(4, 8) === "ftyp" ||
        ascii(4, 8) === "moov" ||
        ascii(4, 8) === "wide" ||
        ascii(4, 8) === "mdat"
      );
    case "video/webm":
      return head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3;
    case "audio/mpeg":
      return ascii(0, 3) === "ID3" || (head[0] === 0xff && ((head[1] ?? 0) & 0xe0) === 0xe0);
    case "audio/wav":
    case "audio/x-wav":
      return ascii(0, 4) === "RIFF" && ascii(8, 12) === "WAVE";
    case "audio/ogg":
      return ascii(0, 4) === "OggS";
    case "audio/aac":
      return head[0] === 0xff && ((head[1] ?? 0) & 0xf6) === 0xf0;
    default:
      return false;
  }
}

export interface InspectResult {
  width?: number;
  height?: number;
  /** Replacement bytes when the upload had to be rewritten (sanitized SVG). */
  rewritten?: Uint8Array;
}

/**
 * Validate the bytes of an upload. `head` is the first bytes (at least 512 KiB when available); `full` the
 * whole content for kinds that need it (SVG, JSON). Throws UploadValidationError with a user-safe message.
 */
export function inspectUpload(
  kind: AssetKind,
  mime: string,
  head: Uint8Array,
  full?: Uint8Array,
): InspectResult {
  switch (kind) {
    case "image": {
      let size: { width: number; height: number; type?: string };
      try {
        size = imageSize(head);
      } catch {
        throw new UploadValidationError("The file is not a readable image.");
      }
      const allowed = IMAGE_TYPES[normalizeMime(mime)] ?? [];
      if (size.type && !allowed.includes(size.type)) {
        throw new UploadValidationError(
          `The file content (${size.type}) does not match its type ${mime}.`,
        );
      }
      if (!(size.width > 0 && size.height > 0))
        throw new UploadValidationError("The image has no size.");
      return { width: size.width, height: size.height };
    }
    case "svg": {
      if (!full) throw new UploadValidationError("The SVG could not be read.");
      if (full.length > MAX_SVG_BYTES)
        throw new UploadValidationError("SVG files can be at most 5 MB.");
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(full);
      } catch {
        throw new UploadValidationError("The SVG is not valid UTF-8 text.");
      }
      try {
        const result = sanitizeSvg(text);
        const out: InspectResult = {
          ...(result.width !== undefined ? { width: result.width } : {}),
          ...(result.height !== undefined ? { height: result.height } : {}),
        };
        const bytes = new TextEncoder().encode(result.svg);
        // Always store the normalized markup so nothing unsanitized is ever served.
        if (
          result.changed ||
          bytes.length !== full.length ||
          !bytes.every((b, i) => b === full[i])
        ) {
          out.rewritten = bytes;
        }
        return out;
      } catch (err) {
        if (err instanceof SvgSanitizeError) throw new UploadValidationError(err.message);
        throw err;
      }
    }
    case "font":
      if (!isFont(head))
        throw new UploadValidationError("The file is not a TrueType, OpenType or WOFF font.");
      return {};
    case "video":
    case "audio":
      if (!isVideoOrAudio(mime, head)) {
        throw new UploadValidationError(`The file content does not match its type ${mime}.`);
      }
      return {};
    case "lottie":
    case "data": {
      if (!full) throw new UploadValidationError("The file could not be read.");
      let parsed: unknown;
      try {
        parsed = JSON.parse(new TextDecoder().decode(full));
      } catch {
        throw new UploadValidationError("The file is not valid JSON.");
      }
      if (kind === "lottie") {
        const anim = parsed as { v?: unknown; layers?: unknown; w?: unknown; h?: unknown };
        if (typeof anim.v !== "string" || !Array.isArray(anim.layers)) {
          throw new UploadValidationError("The file is not a Lottie animation.");
        }
        return {
          ...(typeof anim.w === "number" ? { width: anim.w } : {}),
          ...(typeof anim.h === "number" ? { height: anim.h } : {}),
        };
      }
      return {};
    }
  }
}

/** Kinds whose full content must be read for validation. */
export function needsFullContent(kind: AssetKind): boolean {
  return kind === "svg" || kind === "lottie" || kind === "data";
}
