import { type Design, validateDesign } from "@desyn/schema";
import { unzipSync } from "fflate";

/**
 * Reads `.desyn` archives (the desktop app's file format: zip with `design.json`, `manifest.json` and
 * `assets/<id>.<ext>`, see apps/desktop/src/file/format.rs) and plain Design JSON files.
 */

export interface AssetBytes {
  bytes: Uint8Array;
  mime: string;
  name: string;
}

export interface ParsedDesignFile {
  design: Design;
  /** Asset bytes found in the archive, by asset id. */
  assets: Map<string, AssetBytes>;
  warnings: string[];
}

/** Largest archive / JSON accepted (the server's import limit is 5 MB of JSON; assets upload separately). */
export const MAX_DESIGN_FILE_BYTES = 512 * 1024 * 1024;
const MAX_ENTRY_BYTES = 256 * 1024 * 1024;
const MAX_JSON_BYTES = 64 * 1024 * 1024;

const EXT_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/bmp": "bmp",
  "image/avif": "avif",
  "image/svg+xml": "svg",
  "font/ttf": "ttf",
  "font/otf": "otf",
  "font/woff": "woff",
  "font/woff2": "woff2",
  "video/mp4": "mp4",
  "audio/mpeg": "mp3",
  "application/json": "json",
};

/** Entry name the desktop app writes for an asset (`assets/<id>.<ext>`). */
export function assetEntryName(id: string, mime: string): string {
  return `assets/${id}.${EXT_BY_MIME[mime] ?? "bin"}`;
}

function isZip(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 4 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    bytes[2] === 0x03 &&
    bytes[3] === 0x04
  );
}

/** Parses Design JSON text, validating it against the document model. */
export function parseDesignJson(text: string): { design: Design; warnings: string[] } {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("The file is not valid JSON.");
  }
  // Accept `{ design: {...} }` wrappers (exports of the Agent API / clipboard tools).
  if (
    typeof value === "object" &&
    value !== null &&
    !("schema" in value) &&
    "design" in value &&
    typeof (value as { design: unknown }).design === "object"
  ) {
    value = (value as { design: unknown }).design;
  }
  const result = validateDesign(value);
  if (!result.ok) {
    const first = result.errors[0];
    throw new Error(
      `This is not a Desyn design${first ? ` (${first.message}${first.path.length ? ` at ${first.path.join(".")}` : ""})` : ""}.`,
    );
  }
  return {
    design: value as Design,
    warnings: result.warnings.map((w) => w.message),
  };
}

export function parseDesignFile(bytes: Uint8Array): ParsedDesignFile {
  if (bytes.length > MAX_DESIGN_FILE_BYTES) throw new Error("The file is too large to import.");
  if (!isZip(bytes)) {
    if (bytes.length > MAX_JSON_BYTES) throw new Error("The design JSON is too large to import.");
    const { design, warnings } = parseDesignJson(new TextDecoder().decode(bytes));
    return { design, assets: new Map(), warnings };
  }
  let total = 0;
  const entries = unzipSync(bytes, {
    filter: (f) => {
      // Zip bombs: check declared sizes before inflating, and only read entries we use.
      if (f.originalSize > MAX_ENTRY_BYTES) throw new Error(`"${f.name}" is too large.`);
      total += f.originalSize;
      if (total > MAX_DESIGN_FILE_BYTES) throw new Error("The archive is too large when unpacked.");
      return f.name === "design.json" || f.name === "manifest.json" || f.name.startsWith("assets/");
    },
  });
  const json = entries["design.json"];
  if (!json) throw new Error("This archive has no design.json, so it is not a .desyn file.");
  const { design, warnings } = parseDesignJson(new TextDecoder().decode(json));
  const assets = new Map<string, AssetBytes>();
  for (const [id, ref] of Object.entries(design.assets)) {
    const candidates = [ref.storageKey, assetEntryName(id, ref.mime)].filter(
      (c): c is string => typeof c === "string",
    );
    const found = candidates.map((c) => entries[c]).find((b) => b !== undefined);
    if (found) {
      assets.set(id, {
        bytes: found,
        mime: ref.mime,
        name: ref.name ?? `${id}.${EXT_BY_MIME[ref.mime] ?? "bin"}`,
      });
    }
  }
  return { design, assets, warnings };
}
