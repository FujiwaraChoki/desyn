// Minimal raster pipeline for hosts without the Rust renderer: an RGBA canvas with alpha blending of boxes,
// ellipses and "greeked" text lines, a PNG encoder (stored deflate blocks, no compression library) and a PNG
// decoder (DecompressionStream) used by the posterize tracer. Rendering is approximate by design: it gives
// critique models the composition (masses, colors, text placement), not pixel-exact typography.
import type { Color } from "@desyn/schema";

export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

export function hexToRgba(hex: Color, opacity = 1): Rgba {
  const h = hex.replace("#", "");
  const n = (i: number) => Number.parseInt(h.slice(i, i + 2), 16);
  const a = h.length >= 8 ? n(6) / 255 : 1;
  return { r: n(0), g: n(2), b: n(4), a: Math.max(0, Math.min(1, a * opacity)) };
}

export class Canvas {
  readonly data: Uint8Array;

  constructor(
    readonly width: number,
    readonly height: number,
    background?: Rgba,
  ) {
    this.data = new Uint8Array(width * height * 4);
    if (background) this.fillRect(0, 0, width, height, background);
  }

  private blend(i: number, c: Rgba, coverage: number): void {
    const a = c.a * coverage;
    if (a <= 0) return;
    const d = this.data;
    const da = (d[i + 3] as number) / 255;
    const oa = a + da * (1 - a);
    if (oa <= 0) return;
    d[i] = Math.round((c.r * a + (d[i] as number) * da * (1 - a)) / oa);
    d[i + 1] = Math.round((c.g * a + (d[i + 1] as number) * da * (1 - a)) / oa);
    d[i + 2] = Math.round((c.b * a + (d[i + 2] as number) * da * (1 - a)) / oa);
    d[i + 3] = Math.round(oa * 255);
  }

  fillRect(x: number, y: number, w: number, h: number, c: Rgba, clip?: Clip): void {
    const x0 = Math.max(0, Math.floor(x), clip ? Math.floor(clip.x) : 0);
    const y0 = Math.max(0, Math.floor(y), clip ? Math.floor(clip.y) : 0);
    const x1 = Math.min(
      this.width,
      Math.ceil(x + w),
      clip ? Math.ceil(clip.x + clip.w) : this.width,
    );
    const y1 = Math.min(
      this.height,
      Math.ceil(y + h),
      clip ? Math.ceil(clip.y + clip.h) : this.height,
    );
    for (let py = y0; py < y1; py++) {
      // Partial coverage at the edges keeps small shapes visible after downscaling.
      const cy = Math.min(py + 1, y + h) - Math.max(py, y);
      for (let px = x0; px < x1; px++) {
        const cx = Math.min(px + 1, x + w) - Math.max(px, x);
        this.blend((py * this.width + px) * 4, c, Math.max(0, Math.min(1, cx * cy)));
      }
    }
  }

  fillEllipse(x: number, y: number, w: number, h: number, c: Rgba, clip?: Clip): void {
    const rx = w / 2;
    const ry = h / 2;
    const cx = x + rx;
    const cy = y + ry;
    if (rx <= 0 || ry <= 0) return;
    const x0 = Math.max(0, Math.floor(x), clip ? Math.floor(clip.x) : 0);
    const y0 = Math.max(0, Math.floor(y), clip ? Math.floor(clip.y) : 0);
    const x1 = Math.min(
      this.width,
      Math.ceil(x + w),
      clip ? Math.ceil(clip.x + clip.w) : this.width,
    );
    const y1 = Math.min(
      this.height,
      Math.ceil(y + h),
      clip ? Math.ceil(clip.y + clip.h) : this.height,
    );
    for (let py = y0; py < y1; py++) {
      for (let px = x0; px < x1; px++) {
        const dx = (px + 0.5 - cx) / rx;
        const dy = (py + 0.5 - cy) / ry;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const edge = Math.min(rx, ry);
        const coverage = Math.max(0, Math.min(1, (1 - dist) * edge + 0.5));
        this.blend((py * this.width + px) * 4, c, coverage);
      }
    }
  }

  /** Rounded rectangle (uniform radius). */
  fillRoundRect(
    x: number,
    y: number,
    w: number,
    h: number,
    radius: number,
    c: Rgba,
    clip?: Clip,
  ): void {
    const r = Math.max(0, Math.min(radius, w / 2, h / 2));
    if (r < 0.5) {
      this.fillRect(x, y, w, h, c, clip);
      return;
    }
    this.fillRect(x + r, y, w - 2 * r, h, c, clip);
    this.fillRect(x, y + r, r, h - 2 * r, c, clip);
    this.fillRect(x + w - r, y + r, r, h - 2 * r, c, clip);
    for (const [ex, ey] of [
      [x, y],
      [x + w - 2 * r, y],
      [x, y + h - 2 * r],
      [x + w - 2 * r, y + h - 2 * r],
    ] as const) {
      // Quarter of a circle per corner: draw the circle clipped to the corner square.
      const corner: Clip = { x: ex === x ? x : x + w - r, y: ey === y ? y : y + h - r, w: r, h: r };
      this.fillEllipse(ex, ey, 2 * r, 2 * r, c, intersectClip(corner, clip));
    }
  }
}

export interface Clip {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function intersectClip(a: Clip, b?: Clip): Clip {
  if (!b) return a;
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  return {
    x,
    y,
    w: Math.max(0, Math.min(a.x + a.w, b.x + b.w) - x),
    h: Math.max(0, Math.min(a.y + a.h, b.y + b.h) - y),
  };
}

// PNG ---------------------------------------------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array, start = 0, end = bytes.length): number {
  let c = 0xffffffff;
  for (let i = start; i < end; i++)
    c = (CRC_TABLE[(c ^ (bytes[i] as number)) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function adler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (let i = 0; i < bytes.length; i++) {
    a = (a + (bytes[i] as number)) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

/** zlib stream made of stored (uncompressed) deflate blocks. */
function zlibStored(raw: Uint8Array): Uint8Array {
  const blocks = Math.max(1, Math.ceil(raw.length / 65535));
  const out = new Uint8Array(2 + raw.length + blocks * 5 + 4);
  out[0] = 0x78;
  out[1] = 0x01;
  let o = 2;
  for (let i = 0; i < blocks; i++) {
    const start = i * 65535;
    const len = Math.min(65535, raw.length - start);
    out[o++] = i === blocks - 1 ? 1 : 0;
    out[o++] = len & 0xff;
    out[o++] = len >>> 8;
    out[o++] = ~len & 0xff;
    out[o++] = (~len >>> 8) & 0xff;
    out.set(raw.subarray(start, start + len), o);
    o += len;
  }
  const ad = adler32(raw);
  out[o++] = ad >>> 24;
  out[o++] = (ad >>> 16) & 0xff;
  out[o++] = (ad >>> 8) & 0xff;
  out[o++] = ad & 0xff;
  return out;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out, 4, 8 + data.length));
  return out;
}

/** Encodes RGBA pixels as a PNG (filter 0, stored deflate). */
export function encodePng(width: number, height: number, rgba: Uint8Array): Uint8Array {
  const raw = new Uint8Array((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
  }
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlibStored(raw)),
    chunk("IEND", new Uint8Array(0)),
  ];
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

async function inflateZlib(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export interface DecodedImage {
  width: number;
  height: number;
  /** RGBA, 8 bits per channel. */
  data: Uint8Array;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Decodes 8-bit non-interlaced PNGs (gray, gray+alpha, RGB, RGBA, palette) to RGBA. */
export async function decodePng(bytes: Uint8Array): Promise<DecodedImage> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0) !== 0x89504e47) throw new Error("not a PNG");
  let o = 8;
  let width = 0;
  let height = 0;
  let depth = 0;
  let colorType = 0;
  let interlace = 0;
  let palette: Uint8Array | undefined;
  let trns: Uint8Array | undefined;
  const idat: Uint8Array[] = [];
  while (o + 8 <= bytes.length) {
    const len = view.getUint32(o);
    const type = String.fromCharCode(...bytes.subarray(o + 4, o + 8));
    const data = bytes.subarray(o + 8, o + 8 + len);
    if (type === "IHDR") {
      const d = new DataView(data.buffer, data.byteOffset, data.byteLength);
      width = d.getUint32(0);
      height = d.getUint32(4);
      depth = data[8] as number;
      colorType = data[9] as number;
      interlace = data[12] as number;
    } else if (type === "PLTE") palette = data;
    else if (type === "tRNS") trns = data;
    else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    o += 12 + len;
  }
  if (depth !== 8 || interlace !== 0)
    throw new Error("only 8-bit non-interlaced PNGs are supported");
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error(`unsupported PNG color type ${colorType}`);
  const total = idat.reduce((s, d) => s + d.length, 0);
  const joined = new Uint8Array(total);
  let p = 0;
  for (const d of idat) {
    joined.set(d, p);
    p += d.length;
  }
  const raw = await inflateZlib(joined);
  const stride = width * channels;
  const pixels = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)] as number;
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const cur = raw[src + x] as number;
      const left = x >= channels ? (pixels[dst + x - channels] as number) : 0;
      const up = y > 0 ? (pixels[dst - stride + x] as number) : 0;
      const ul = y > 0 && x >= channels ? (pixels[dst - stride + x - channels] as number) : 0;
      let v = cur;
      if (filter === 1) v = cur + left;
      else if (filter === 2) v = cur + up;
      else if (filter === 3) v = cur + ((left + up) >> 1);
      else if (filter === 4) v = cur + paeth(left, up, ul);
      pixels[dst + x] = v & 0xff;
    }
  }
  const out = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const s = i * channels;
    const d = i * 4;
    if (colorType === 6) out.set(pixels.subarray(s, s + 4), d);
    else if (colorType === 2) {
      out[d] = pixels[s] as number;
      out[d + 1] = pixels[s + 1] as number;
      out[d + 2] = pixels[s + 2] as number;
      out[d + 3] = 255;
    } else if (colorType === 0 || colorType === 4) {
      const g = pixels[s] as number;
      out[d] = g;
      out[d + 1] = g;
      out[d + 2] = g;
      out[d + 3] = colorType === 4 ? (pixels[s + 1] as number) : 255;
    } else {
      const idx = pixels[s] as number;
      out[d] = palette?.[idx * 3] ?? 0;
      out[d + 1] = palette?.[idx * 3 + 1] ?? 0;
      out[d + 2] = palette?.[idx * 3 + 2] ?? 0;
      out[d + 3] = trns?.[idx] ?? 255;
    }
  }
  return { width, height, data: out };
}
