// Built-in raster -> vector tracer (no provider needed): decodes a PNG, posterizes it with k-means in OKLab,
// traces each color region's pixel boundaries into closed loops, simplifies them (Ramer–Douglas–Peucker) and
// emits one even-odd path per color, largest area first. Good for logos, icons and flat illustrations.
import { type Color, formatHex, rgbToOklab } from "@desyn/schema";
import { type DecodedImage, decodePng } from "../design/raster";

export interface TraceOptions {
  /** Number of colors (2–16, default 6). */
  colors?: number;
  /** Detail: higher keeps more corners (default "medium"). */
  detail?: "low" | "medium" | "high";
  /** Longest edge of the working raster (default 320 px). */
  workSize?: number;
  /** Treat pixels with alpha below this as transparent (default 128). */
  alphaThreshold?: number;
}

export interface TracedLayer {
  color: Color;
  /** SVG path data in the original image's pixel coordinates. */
  d: string;
  /** Share of opaque pixels. */
  coverage: number;
}

export interface TraceResult {
  width: number;
  height: number;
  layers: TracedLayer[];
  svg: string;
}

function downsample(img: DecodedImage, maxSize: number): DecodedImage {
  const scale = Math.min(1, maxSize / Math.max(img.width, img.height));
  if (scale >= 1) return img;
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // Box filter over the source footprint.
      const sx0 = Math.floor(x / scale);
      const sy0 = Math.floor(y / scale);
      const sx1 = Math.min(img.width, Math.ceil((x + 1) / scale));
      const sy1 = Math.min(img.height, Math.ceil((y + 1) / scale));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      for (let sy = sy0; sy < sy1; sy++) {
        for (let sx = sx0; sx < sx1; sx++) {
          const i = (sy * img.width + sx) * 4;
          const alpha = img.data[i + 3] as number;
          r += (img.data[i] as number) * alpha;
          g += (img.data[i + 1] as number) * alpha;
          b += (img.data[i + 2] as number) * alpha;
          a += alpha;
          n++;
        }
      }
      const o = (y * w + x) * 4;
      out[o] = a > 0 ? Math.round(r / a) : 0;
      out[o + 1] = a > 0 ? Math.round(g / a) : 0;
      out[o + 2] = a > 0 ? Math.round(b / a) : 0;
      out[o + 3] = n > 0 ? Math.round(a / n) : 0;
    }
  }
  return { width: w, height: h, data: out };
}

interface Lab {
  l: number;
  a: number;
  b: number;
}

/** k-means++ seeded, deterministic (seeded by pixel order) color quantization in OKLab. */
function quantize(
  img: DecodedImage,
  k: number,
  alphaThreshold: number,
): { labels: Int16Array; centers: Lab[]; rgb: Color[] } {
  const n = img.width * img.height;
  const labs: (Lab | null)[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const a = img.data[i * 4 + 3] as number;
    if (a < alphaThreshold) {
      labs[i] = null;
      continue;
    }
    const o = rgbToOklab({
      r: img.data[i * 4] as number,
      g: img.data[i * 4 + 1] as number,
      b: img.data[i * 4 + 2] as number,
      a: 1,
    });
    labs[i] = { l: o.l, a: o.a, b: o.b };
  }
  const opaque = labs.filter((l): l is Lab => l !== null);
  const labels = new Int16Array(n).fill(-1);
  if (opaque.length === 0) return { labels, centers: [], rgb: [] };
  const dist = (p: Lab, q: Lab) => (p.l - q.l) ** 2 + (p.a - q.a) ** 2 + (p.b - q.b) ** 2;
  // Sample for speed on big images.
  const step = Math.max(1, Math.floor(opaque.length / 6000));
  const sample = opaque.filter((_, i) => i % step === 0);
  const centers: Lab[] = [sample[0] as Lab];
  while (centers.length < k) {
    let best = -1;
    let bestD = -1;
    for (let i = 0; i < sample.length; i++) {
      const d = Math.min(...centers.map((c) => dist(sample[i] as Lab, c)));
      if (d > bestD) {
        bestD = d;
        best = i;
      }
    }
    if (bestD <= 1e-6) break;
    centers.push(sample[best] as Lab);
  }
  for (let iter = 0; iter < 12; iter++) {
    const sums = centers.map(() => ({ l: 0, a: 0, b: 0, n: 0 }));
    for (const p of sample) {
      let ci = 0;
      let cd = Number.POSITIVE_INFINITY;
      centers.forEach((c, idx) => {
        const d = dist(p, c);
        if (d < cd) {
          cd = d;
          ci = idx;
        }
      });
      const s = sums[ci] as { l: number; a: number; b: number; n: number };
      s.l += p.l;
      s.a += p.a;
      s.b += p.b;
      s.n++;
    }
    let moved = 0;
    sums.forEach((s, idx) => {
      if (s.n === 0) return;
      const next = { l: s.l / s.n, a: s.a / s.n, b: s.b / s.n };
      moved += dist(next, centers[idx] as Lab);
      centers[idx] = next;
    });
    if (moved < 1e-7) break;
  }
  for (let i = 0; i < n; i++) {
    const p = labs[i];
    if (!p) continue;
    let ci = 0;
    let cd = Number.POSITIVE_INFINITY;
    centers.forEach((c, idx) => {
      const d = dist(p, c);
      if (d < cd) {
        cd = d;
        ci = idx;
      }
    });
    labels[i] = ci;
  }
  // Average sRGB of members gives the displayed color (avoids OKLab round-trip drift).
  const acc = centers.map(() => ({ r: 0, g: 0, b: 0, n: 0 }));
  for (let i = 0; i < n; i++) {
    const l = labels[i] as number;
    if (l < 0) continue;
    const s = acc[l] as { r: number; g: number; b: number; n: number };
    s.r += img.data[i * 4] as number;
    s.g += img.data[i * 4 + 1] as number;
    s.b += img.data[i * 4 + 2] as number;
    s.n++;
  }
  const rgb = acc.map((s) =>
    s.n > 0 ? formatHex({ r: s.r / s.n, g: s.g / s.n, b: s.b / s.n, a: 1 }).slice(0, 7) : "#000000",
  );
  return { labels, centers, rgb };
}

/** Removes isolated specks: pixels whose 8 neighbours mostly disagree take the majority label. */
function despeckle(labels: Int16Array, w: number, h: number): void {
  const copy = labels.slice();
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const counts = new Map<number, number>();
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const l = copy[(y + dy) * w + x + dx] as number;
          counts.set(l, (counts.get(l) ?? 0) + 1);
        }
      }
      const self = copy[i] as number;
      if ((counts.get(self) ?? 0) <= 1) {
        const [major] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0] as [number, number];
        labels[i] = major;
      }
    }
  }
}

type Pt = [number, number];

/** Traces boundary loops of a binary mask on the pixel-edge lattice (clockwise outer, counter-clockwise holes). */
function traceLoops(mask: Uint8Array, w: number, h: number): Pt[][] {
  const inside = (x: number, y: number) =>
    x >= 0 && y >= 0 && x < w && y < h && mask[y * w + x] === 1;
  const W = w + 1;
  const key = (x: number, y: number) => y * W + x;
  // Directed edges keyed by start vertex; each vertex has at most two outgoing edges (saddles).
  const out = new Map<number, Pt[]>();
  const add = (x0: number, y0: number, x1: number, y1: number) => {
    const k = key(x0, y0);
    const list = out.get(k);
    if (list) list.push([x1, y1]);
    else out.set(k, [[x1, y1]]);
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!inside(x, y)) continue;
      if (!inside(x, y - 1)) add(x, y, x + 1, y);
      if (!inside(x + 1, y)) add(x + 1, y, x + 1, y + 1);
      if (!inside(x, y + 1)) add(x + 1, y + 1, x, y + 1);
      if (!inside(x - 1, y)) add(x, y + 1, x, y);
    }
  }
  const loops: Pt[][] = [];
  for (const [startKey, targets] of out) {
    while (targets.length > 0) {
      const sx = startKey % W;
      const sy = Math.floor(startKey / W);
      const loop: Pt[] = [[sx, sy]];
      let [cx, cy] = targets.pop() as Pt;
      let dir: Pt = [cx - sx, cy - sy];
      while (!(cx === sx && cy === sy)) {
        loop.push([cx, cy]);
        const nexts = out.get(key(cx, cy));
        if (!nexts || nexts.length === 0) break;
        let pick = 0;
        if (nexts.length > 1) {
          // At a saddle, turn right (relative to travel) so diagonal regions stay separate.
          const right: Pt = [-dir[1], dir[0]];
          const idx = nexts.findIndex((n) => n[0] - cx === right[0] && n[1] - cy === right[1]);
          pick = idx >= 0 ? idx : 0;
        }
        const [nx, ny] = nexts.splice(pick, 1)[0] as Pt;
        dir = [nx - cx, ny - cy];
        cx = nx;
        cy = ny;
      }
      if (loop.length >= 4) loops.push(loop);
    }
  }
  return loops;
}

function removeCollinear(loop: Pt[]): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i < loop.length; i++) {
    const prev = loop[(i - 1 + loop.length) % loop.length] as Pt;
    const cur = loop[i] as Pt;
    const next = loop[(i + 1) % loop.length] as Pt;
    const cross = (cur[0] - prev[0]) * (next[1] - cur[1]) - (cur[1] - prev[1]) * (next[0] - cur[0]);
    if (cross !== 0) out.push(cur);
  }
  return out;
}

function rdp(points: Pt[], epsilon: number): Pt[] {
  if (points.length < 3) return points;
  const [ax, ay] = points[0] as Pt;
  const [bx, by] = points[points.length - 1] as Pt;
  const len = Math.hypot(bx - ax, by - ay) || 1;
  let maxD = 0;
  let index = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const [px, py] = points[i] as Pt;
    const d = Math.abs((bx - ax) * (ay - py) - (ax - px) * (by - ay)) / len;
    if (d > maxD) {
      maxD = d;
      index = i;
    }
  }
  if (maxD <= epsilon) return [points[0] as Pt, points[points.length - 1] as Pt];
  return [
    ...rdp(points.slice(0, index + 1), epsilon).slice(0, -1),
    ...rdp(points.slice(index), epsilon),
  ];
}

function simplifyLoop(loop: Pt[], epsilon: number): Pt[] {
  const corners = removeCollinear(loop);
  if (corners.length < 4 || epsilon <= 0) return corners;
  // Split the closed loop at its two farthest-apart points so RDP has stable anchors.
  let far = 0;
  let farD = -1;
  const [x0, y0] = corners[0] as Pt;
  corners.forEach(([x, y], i) => {
    const d = (x - x0) ** 2 + (y - y0) ** 2;
    if (d > farD) {
      farD = d;
      far = i;
    }
  });
  const a = rdp(corners.slice(0, far + 1), epsilon);
  const b = rdp([...corners.slice(far), corners[0] as Pt], epsilon);
  return [...a.slice(0, -1), ...b.slice(0, -1)];
}

function fmt(n: number): string {
  const r = Math.round(n * 100) / 100;
  return Object.is(r, -0) ? "0" : String(r);
}

/** Traces PNG bytes into vector layers. Throws for non-PNG input. */
export async function traceRaster(
  png: Uint8Array,
  options: TraceOptions = {},
): Promise<TraceResult> {
  const source = await decodePng(png);
  const work = downsample(source, options.workSize ?? 320);
  const k = Math.max(2, Math.min(16, options.colors ?? 6));
  const { labels, rgb } = quantize(work, k, options.alphaThreshold ?? 128);
  despeckle(labels, work.width, work.height);
  const epsilon = { low: 1.6, medium: 0.9, high: 0.45 }[options.detail ?? "medium"];
  const sx = source.width / work.width;
  const sy = source.height / work.height;
  const total = labels.reduce((s, l) => s + (l >= 0 ? 1 : 0), 0) || 1;
  const layers: TracedLayer[] = [];
  rgb.forEach((color, ci) => {
    const mask = new Uint8Array(work.width * work.height);
    let count = 0;
    for (let i = 0; i < mask.length; i++) {
      if (labels[i] === ci) {
        mask[i] = 1;
        count++;
      }
    }
    if (count === 0) return;
    const loops = traceLoops(mask, work.width, work.height)
      .map((l) => simplifyLoop(l, epsilon))
      .filter((l) => l.length >= 3);
    if (loops.length === 0) return;
    const d = loops
      .map((l) => `M${l.map(([x, y]) => `${fmt(x * sx)} ${fmt(y * sy)}`).join("L")}Z`)
      .join("");
    layers.push({ color, d, coverage: count / total });
  });
  layers.sort((a, b) => b.coverage - a.coverage);
  const paths = layers
    .map((l) => `<path fill="${l.color}" fill-rule="evenodd" d="${l.d}"/>`)
    .join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${source.width} ${source.height}" width="${source.width}" height="${source.height}">${paths}</svg>`;
  return { width: source.width, height: source.height, layers, svg };
}
