import type { Point } from "../canvas/math.ts";

/**
 * Freehand smoothing for the pencil: jitter is removed with a short moving average, then Philip J. Schneider's
 * least-squares cubic Bézier fitting ("An Algorithm for Automatically Fitting Digitized Curves", Graphics Gems,
 * 1990) turns the stroke into a few smooth segments within `maxError`.
 */

export type Cubic = [Point, Point, Point, Point];

const add = (a: Point, b: Point): Point => ({ x: a.x + b.x, y: a.y + b.y });
const sub = (a: Point, b: Point): Point => ({ x: a.x - b.x, y: a.y - b.y });
const scale = (a: Point, k: number): Point => ({ x: a.x * k, y: a.y * k });
const dot = (a: Point, b: Point): number => a.x * b.x + a.y * b.y;
const len = (a: Point): number => Math.hypot(a.x, a.y);
const dist = (a: Point, b: Point): number => len(sub(a, b));

function normalize(a: Point): Point {
  const l = len(a);
  return l < 1e-12 ? { x: 0, y: 0 } : { x: a.x / l, y: a.y / l };
}

/** Drops points closer than `minDist` to the previous kept point (the last point is always kept). */
export function dedupe(points: readonly Point[], minDist: number): Point[] {
  const out: Point[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (!last || dist(last, p) >= minDist) out.push({ ...p });
  }
  const end = points[points.length - 1];
  const last = out[out.length - 1];
  if (end && last && (end.x !== last.x || end.y !== last.y)) out.push({ ...end });
  return out;
}

/** Moving average over a window of `radius` points each side (endpoints stay fixed). */
export function smooth(points: readonly Point[], radius: number): Point[] {
  if (radius < 1 || points.length < 3) return points.map((p) => ({ ...p }));
  return points.map((p, i) => {
    if (i === 0 || i === points.length - 1) return { ...p };
    const r = Math.min(radius, i, points.length - 1 - i);
    let x = 0;
    let y = 0;
    for (let k = -r; k <= r; k++) {
      const q = points[i + k] as Point;
      x += q.x;
      y += q.y;
    }
    const n = 2 * r + 1;
    return { x: x / n, y: y / n };
  });
}

function bezier(c: Cubic, t: number): Point {
  const u = 1 - t;
  return add(
    add(scale(c[0], u * u * u), scale(c[1], 3 * u * u * t)),
    add(scale(c[2], 3 * u * t * t), scale(c[3], t * t * t)),
  );
}

function bezierPrime(c: Cubic, t: number): Point {
  const u = 1 - t;
  return add(
    add(scale(sub(c[1], c[0]), 3 * u * u), scale(sub(c[2], c[1]), 6 * u * t)),
    scale(sub(c[3], c[2]), 3 * t * t),
  );
}

function bezierPrime2(c: Cubic, t: number): Point {
  return add(
    scale(add(sub(c[2], scale(c[1], 2)), c[0]), 6 * (1 - t)),
    scale(add(sub(c[3], scale(c[2], 2)), c[1]), 6 * t),
  );
}

function chordLengths(points: readonly Point[]): number[] {
  const u = [0];
  for (let i = 1; i < points.length; i++)
    u.push((u[i - 1] as number) + dist(points[i] as Point, points[i - 1] as Point));
  const total = u[u.length - 1] as number;
  return total > 0 ? u.map((v) => v / total) : u.map((_, i) => i / Math.max(1, u.length - 1));
}

function generateBezier(
  points: readonly Point[],
  u: readonly number[],
  t1: Point,
  t2: Point,
): Cubic {
  const first = points[0] as Point;
  const last = points[points.length - 1] as Point;
  // Least squares for the handle lengths along the fixed end tangents.
  let c00 = 0;
  let c01 = 0;
  let c11 = 0;
  let x0 = 0;
  let x1 = 0;
  for (let i = 0; i < points.length; i++) {
    const t = u[i] as number;
    const v = 1 - t;
    const a1 = scale(t1, 3 * v * v * t);
    const a2 = scale(t2, 3 * v * t * t);
    c00 += dot(a1, a1);
    c01 += dot(a1, a2);
    c11 += dot(a2, a2);
    const base = add(
      scale(first, v * v * v + 3 * v * v * t),
      scale(last, 3 * v * t * t + t * t * t),
    );
    const shortfall = sub(points[i] as Point, base);
    x0 += dot(a1, shortfall);
    x1 += dot(a2, shortfall);
  }
  const detC = c00 * c11 - c01 * c01;
  let alphaL = Math.abs(detC) < 1e-12 ? 0 : (x0 * c11 - x1 * c01) / detC;
  let alphaR = Math.abs(detC) < 1e-12 ? 0 : (c00 * x1 - c01 * x0) / detC;
  const segLen = dist(first, last);
  const eps = 1e-6 * segLen;
  if (alphaL < eps || alphaR < eps) {
    // Degenerate system: fall back to the Wu / Barsky heuristic.
    alphaL = segLen / 3;
    alphaR = segLen / 3;
  }
  return [first, add(first, scale(t1, alphaL)), add(last, scale(t2, alphaR)), last];
}

function maxError(
  points: readonly Point[],
  c: Cubic,
  u: readonly number[],
): { error: number; split: number } {
  let error = 0;
  let split = Math.floor(points.length / 2);
  for (let i = 1; i < points.length - 1; i++) {
    const d = dist(bezier(c, u[i] as number), points[i] as Point);
    if (d > error) {
      error = d;
      split = i;
    }
  }
  return { error, split };
}

function reparameterize(points: readonly Point[], u: readonly number[], c: Cubic): number[] {
  return u.map((t, i) => {
    const p = points[i] as Point;
    const d = sub(bezier(c, t), p);
    const d1 = bezierPrime(c, t);
    const d2 = bezierPrime2(c, t);
    const num = dot(d, d1);
    const den = dot(d1, d1) + dot(d, d2);
    if (Math.abs(den) < 1e-12) return t;
    return Math.min(1, Math.max(0, t - num / den));
  });
}

function fitCubic(
  points: readonly Point[],
  t1: Point,
  t2: Point,
  error: number,
  out: Cubic[],
): void {
  if (points.length === 2) {
    const a = points[0] as Point;
    const b = points[1] as Point;
    const d = dist(a, b) / 3;
    out.push([a, add(a, scale(t1, d)), add(b, scale(t2, d)), b]);
    return;
  }
  let u = chordLengths(points);
  let curve = generateBezier(points, u, t1, t2);
  let { error: err, split } = maxError(points, curve, u);
  if (err < error) {
    out.push(curve);
    return;
  }
  if (err < error * 4) {
    for (let i = 0; i < 20; i++) {
      u = reparameterize(points, u, curve);
      curve = generateBezier(points, u, t1, t2);
      ({ error: err, split } = maxError(points, curve, u));
      if (err < error) {
        out.push(curve);
        return;
      }
    }
  }
  split = Math.min(Math.max(split, 1), points.length - 2);
  const center = normalize(sub(points[split - 1] as Point, points[split + 1] as Point));
  fitCubic(points.slice(0, split + 1), t1, center, error, out);
  fitCubic(points.slice(split), scale(center, -1), t2, error, out);
}

/** Fits cubic segments through a stroke (points in drawing order). */
export function fitCurve(input: readonly Point[], maxErr: number): Cubic[] {
  const points = dedupe(input, maxErr / 8);
  if (points.length < 2) return [];
  const first = points[0] as Point;
  const second = points[1] as Point;
  const last = points[points.length - 1] as Point;
  const prev = points[points.length - 2] as Point;
  const out: Cubic[] = [];
  fitCubic(points, normalize(sub(second, first)), normalize(sub(prev, last)), maxErr, out);
  return out;
}
