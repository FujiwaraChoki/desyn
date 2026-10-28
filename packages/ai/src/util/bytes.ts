// Byte helpers that work in browsers, Node and Convex (no Buffer): base64, data URIs, media sniffing and image
// dimension parsing from file headers.

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function bytesToBase64(bytes: Uint8Array): string {
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n =
      ((bytes[i] as number) << 16) | ((bytes[i + 1] as number) << 8) | (bytes[i + 2] as number);
    out +=
      B64.charAt((n >> 18) & 63) +
      B64.charAt((n >> 12) & 63) +
      B64.charAt((n >> 6) & 63) +
      B64.charAt(n & 63);
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = (bytes[i] as number) << 16;
    out += `${B64.charAt((n >> 18) & 63)}${B64.charAt((n >> 12) & 63)}==`;
  } else if (rest === 2) {
    const n = ((bytes[i] as number) << 16) | ((bytes[i + 1] as number) << 8);
    out += `${B64.charAt((n >> 18) & 63)}${B64.charAt((n >> 12) & 63)}${B64.charAt((n >> 6) & 63)}=`;
  }
  return out;
}

const B64_LOOKUP = (() => {
  const table = new Int16Array(128).fill(-1);
  for (let i = 0; i < B64.length; i++) table[B64.charCodeAt(i)] = i;
  table["-".charCodeAt(0)] = 62;
  table["_".charCodeAt(0)] = 63;
  return table;
})();

/** Decodes standard or URL-safe base64 (padding optional, whitespace ignored). Throws on invalid input. */
export function base64ToBytes(text: string): Uint8Array {
  const clean = text.replace(/[\s=]+/g, "");
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let buffer = 0;
  let bits = 0;
  let o = 0;
  for (let i = 0; i < clean.length; i++) {
    const code = clean.charCodeAt(i);
    const v = code < 128 ? (B64_LOOKUP[code] as number) : -1;
    if (v < 0) throw new Error("invalid base64 input");
    buffer = (buffer << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (buffer >> bits) & 0xff;
    }
  }
  return out.subarray(0, o);
}

export function toDataUri(bytes: Uint8Array, mime: string): string {
  return `data:${mime};base64,${bytesToBase64(bytes)}`;
}

export interface ParsedDataUri {
  mime: string;
  bytes: Uint8Array;
}

export function parseDataUri(uri: string): ParsedDataUri | null {
  const match = /^data:([^;,]*)(;[^,]*)?,(.*)$/s.exec(uri);
  if (!match) return null;
  const mime = match[1] || "text/plain";
  const isBase64 = (match[2] ?? "").includes(";base64");
  const payload = match[3] ?? "";
  if (isBase64) return { mime, bytes: base64ToBytes(payload) };
  return { mime, bytes: new TextEncoder().encode(decodeURIComponent(payload)) };
}

export function utf8(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

export function fromUtf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** Lowercase hex of a SHA-256 digest (Web Crypto). */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes as BufferSource);
  let out = "";
  for (const b of new Uint8Array(digest)) out += b.toString(16).padStart(2, "0");
  return out;
}

function startsWith(bytes: Uint8Array, sig: number[], offset = 0): boolean {
  if (bytes.length < offset + sig.length) return false;
  return sig.every((b, i) => bytes[offset + i] === b);
}

/** Media type from magic bytes; `undefined` when unknown. */
export function sniffMime(bytes: Uint8Array): string | undefined {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return "image/gif";
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8))
    return "image/webp";
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x41, 0x56, 0x45], 8))
    return "audio/wav";
  if (startsWith(bytes, [0x66, 0x74, 0x79, 0x70], 4)) {
    const brand = String.fromCharCode(...bytes.subarray(8, 12));
    if (brand.startsWith("avif") || brand.startsWith("avis")) return "image/avif";
    if (brand.startsWith("qt")) return "video/quicktime";
    return "video/mp4";
  }
  if (startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3])) return "video/webm";
  if (startsWith(bytes, [0x49, 0x44, 0x33]) || startsWith(bytes, [0xff, 0xfb])) return "audio/mpeg";
  if (startsWith(bytes, [0x4f, 0x67, 0x67, 0x53])) return "audio/ogg";
  const head = utf8(bytes.subarray(0, 512)).trimStart().toLowerCase();
  if (head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg")))
    return "image/svg+xml";
  return undefined;
}

export interface ImageSize {
  width: number;
  height: number;
}

function u16be(b: Uint8Array, o: number): number {
  return ((b[o] as number) << 8) | (b[o + 1] as number);
}
function u32be(b: Uint8Array, o: number): number {
  return (
    (((b[o] as number) << 24) >>> 0) +
    ((b[o + 1] as number) << 16) +
    ((b[o + 2] as number) << 8) +
    (b[o + 3] as number)
  );
}
function u16le(b: Uint8Array, o: number): number {
  return (b[o] as number) | ((b[o + 1] as number) << 8);
}
function u24le(b: Uint8Array, o: number): number {
  return (b[o] as number) | ((b[o + 1] as number) << 8) | ((b[o + 2] as number) << 16);
}

function jpegSize(b: Uint8Array): ImageSize | undefined {
  let o = 2;
  while (o + 9 < b.length) {
    if (b[o] !== 0xff) return undefined;
    const marker = b[o + 1] as number;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      o += 2;
      continue;
    }
    const len = u16be(b, o + 2);
    // SOF0..SOF15 except DHT (c4), JPG (c8) and DAC (cc) carry the frame size.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: u16be(b, o + 5), width: u16be(b, o + 7) };
    }
    o += 2 + len;
  }
  return undefined;
}

function webpSize(b: Uint8Array): ImageSize | undefined {
  const chunk = String.fromCharCode(...b.subarray(12, 16));
  if (chunk === "VP8 " && b.length >= 30) {
    return { width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff };
  }
  if (chunk === "VP8L" && b.length >= 25) {
    const bits = u32le(b, 21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (chunk === "VP8X" && b.length >= 30) {
    return { width: u24le(b, 24) + 1, height: u24le(b, 27) + 1 };
  }
  return undefined;
}

function u32le(b: Uint8Array, o: number): number {
  return (
    ((b[o] as number) |
      ((b[o + 1] as number) << 8) |
      ((b[o + 2] as number) << 16) |
      ((b[o + 3] as number) << 24)) >>>
    0
  );
}

function svgSize(text: string): ImageSize | undefined {
  const tag = /<svg\b[^>]*>/i.exec(text)?.[0];
  if (!tag) return undefined;
  const attr = (name: string) =>
    new RegExp(`\\s${name}\\s*=\\s*["']([^"']+)["']`, "i").exec(tag)?.[1];
  const num = (v: string | undefined) => {
    if (!v || v.trim().endsWith("%")) return undefined;
    const n = Number.parseFloat(v);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  };
  const w = num(attr("width"));
  const h = num(attr("height"));
  if (w && h) return { width: w, height: h };
  const vb = attr("viewBox")
    ?.trim()
    .split(/[\s,]+/)
    .map(Number);
  if (vb && vb.length === 4 && (vb[2] as number) > 0 && (vb[3] as number) > 0) {
    return { width: vb[2] as number, height: vb[3] as number };
  }
  return undefined;
}

/** Pixel size of a PNG / JPEG / GIF / WebP / SVG from its bytes; `undefined` when it cannot be determined. */
export function imageSize(bytes: Uint8Array, mime = sniffMime(bytes)): ImageSize | undefined {
  switch (mime) {
    case "image/png":
      return bytes.length >= 24 ? { width: u32be(bytes, 16), height: u32be(bytes, 20) } : undefined;
    case "image/gif":
      return bytes.length >= 10 ? { width: u16le(bytes, 6), height: u16le(bytes, 8) } : undefined;
    case "image/jpeg":
      return jpegSize(bytes);
    case "image/webp":
      return webpSize(bytes);
    case "image/svg+xml":
      return svgSize(utf8(bytes));
    default:
      return undefined;
  }
}
