import { applyToPoint, applyToVector, invertMatrix, type Matrix, multiply } from "@desyn/doc-ops";

/**
 * Plane geometry for the canvas layer: points, axis-aligned rectangles (`{ x, y, w, h }`, the engine's shape),
 * oriented boxes (a node box `0..w × 0..h` mapped to page space by an affine matrix) and the small helpers the
 * gestures need. Pure functions only; everything here is unit tested.
 */

export type { Matrix };

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A box `0..w × 0..h` placed by `m` (box-local -> page). */
export interface Obb {
  m: Matrix;
  w: number;
  h: number;
}

export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];
const EPS = 1e-9;

export const mul = multiply;
export const apply = applyToPoint;
export const applyVec = applyToVector;

/** Inverse, or the identity for a degenerate matrix (a zero-size parent must not crash a gesture). */
export function inv(m: Matrix): Matrix {
  const det = m[0] * m[3] - m[1] * m[2];
  if (Math.abs(det) < 1e-12) return IDENTITY;
  return invertMatrix(m);
}

export const translation = (x: number, y: number): Matrix => [1, 0, 0, 1, x, y];
export const scaling = (sx: number, sy: number): Matrix => [sx, 0, 0, sy, 0, 0];

export function rotation(deg: number): Matrix {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return [c, s, -s, c, 0, 0];
}

/** Rotation by `deg` about `center`. */
export function rotationAbout(center: Point, deg: number): Matrix {
  return mul(
    translation(center.x, center.y),
    mul(rotation(deg), translation(-center.x, -center.y)),
  );
}

export function dist(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function lerpPoint(a: Point, b: Point, t: number): Point {
  return { x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t) };
}

export function midpoint(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** Normalizes degrees to (-180, 180]. */
export function normDeg(deg: number): number {
  let r = deg % 360;
  if (r <= -180) r += 360;
  if (r > 180) r -= 360;
  return Object.is(r, -0) ? 0 : r;
}

/** Snaps an angle (degrees) to multiples of `step`. */
export function snapAngle(deg: number, step: number): number {
  if (step <= 0) return deg;
  return normDeg(Math.round(deg / step) * step);
}

/** Angle of the vector a -> b in degrees (0 = +x, clockwise positive since y grows downward). */
export function angleOf(a: Point, b: Point): number {
  return (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
}

/**
 * Constrains `p` around `origin` to the nearest multiple of `step` degrees, keeping the projected length
 * (shift while drawing lines, dragging pen handles and moving along an axis).
 */
export function constrainAngle(origin: Point, p: Point, step = 45): Point {
  const len = dist(origin, p);
  if (len < EPS) return { ...p };
  const a = (snapAngle(angleOf(origin, p), step) * Math.PI) / 180;
  const dx = Math.cos(a);
  const dy = Math.sin(a);
  const proj = (p.x - origin.x) * dx + (p.y - origin.y) * dy;
  return { x: origin.x + dx * proj, y: origin.y + dy * proj };
}

// ------------------------------------------------------------------------------------------------------------
// Rectangles

export function rectFromPoints(a: Point, b: Point): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
}

export function boundsOfPoints(points: readonly Point[]): Rect | null {
  if (points.length === 0) return null;
  let x0 = Number.POSITIVE_INFINITY;
  let y0 = Number.POSITIVE_INFINITY;
  let x1 = Number.NEGATIVE_INFINITY;
  let y1 = Number.NEGATIVE_INFINITY;
  for (const p of points) {
    if (p.x < x0) x0 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.x > x1) x1 = p.x;
    if (p.y > y1) y1 = p.y;
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export function unionRect(rects: readonly Rect[]): Rect | null {
  if (rects.length === 0) return null;
  return boundsOfPoints(
    rects.flatMap((r) => [
      { x: r.x, y: r.y },
      { x: r.x + r.w, y: r.y + r.h },
    ]),
  );
}

export function rectCenter(r: Rect): Point {
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
}

export function rectContainsPoint(r: Rect, p: Point, slop = 0): boolean {
  return (
    p.x >= r.x - slop && p.y >= r.y - slop && p.x <= r.x + r.w + slop && p.y <= r.y + r.h + slop
  );
}

export function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.x <= b.x + b.w && b.x <= a.x + a.w && a.y <= b.y + b.h && b.y <= a.y + a.h;
}

export function rectContainsRect(outer: Rect, inner: Rect): boolean {
  return (
    inner.x >= outer.x - EPS &&
    inner.y >= outer.y - EPS &&
    inner.x + inner.w <= outer.x + outer.w + EPS &&
    inner.y + inner.h <= outer.y + outer.h + EPS
  );
}

export function translateRect(r: Rect, dx: number, dy: number): Rect {
  return { x: r.x + dx, y: r.y + dy, w: r.w, h: r.h };
}

// ------------------------------------------------------------------------------------------------------------
// Oriented boxes

export function obbFromRect(r: Rect): Obb {
  return { m: translation(r.x, r.y), w: r.w, h: r.h };
}

export function obbCorners(o: Obb): [Point, Point, Point, Point] {
  return [
    apply(o.m, { x: 0, y: 0 }),
    apply(o.m, { x: o.w, y: 0 }),
    apply(o.m, { x: o.w, y: o.h }),
    apply(o.m, { x: 0, y: o.h }),
  ];
}

export function obbAabb(o: Obb): Rect {
  return boundsOfPoints(obbCorners(o)) as Rect;
}

export function obbCenter(o: Obb): Point {
  return apply(o.m, { x: o.w / 2, y: o.h / 2 });
}

/** Rotation of the box's x axis in degrees. */
export function obbRotation(o: Obb): number {
  return normDeg((Math.atan2(o.m[1], o.m[0]) * 180) / Math.PI);
}

/** Whether the box is mirrored (negative determinant). */
export function obbFlipped(o: Obb): boolean {
  return o.m[0] * o.m[3] - o.m[1] * o.m[2] < 0;
}

/** Point in the box's local coordinates. */
export function toLocal(o: Obb, p: Point): Point {
  return apply(inv(o.m), p);
}

export function obbContains(o: Obb, p: Point, slop = 0): boolean {
  const q = toLocal(o, p);
  // Slop is given in page units; the box may be scaled (never for node boxes, but be exact anyway).
  const sx = Math.hypot(o.m[0], o.m[1]) || 1;
  const sy = Math.hypot(o.m[2], o.m[3]) || 1;
  const ex = slop / sx;
  const ey = slop / sy;
  return q.x >= -ex && q.y >= -ey && q.x <= o.w + ex && q.y <= o.h + ey;
}

export function translateObb(o: Obb, dx: number, dy: number): Obb {
  const [a, b, c, d, e, f] = o.m;
  return { m: [a, b, c, d, e + dx, f + dy], w: o.w, h: o.h };
}

export function transformObb(t: Matrix, o: Obb): Obb {
  return { m: mul(t, o.m), w: o.w, h: o.h };
}

function project(points: readonly Point[], axis: Point): [number, number] {
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  for (const p of points) {
    const v = p.x * axis.x + p.y * axis.y;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return [lo, hi];
}

/** Separating-axis test between a box and an axis-aligned rectangle (touching counts). */
export function obbIntersectsRect(o: Obb, r: Rect): boolean {
  const a = obbCorners(o);
  const b: Point[] = [
    { x: r.x, y: r.y },
    { x: r.x + r.w, y: r.y },
    { x: r.x + r.w, y: r.y + r.h },
    { x: r.x, y: r.y + r.h },
  ];
  const axes: Point[] = [
    { x: 1, y: 0 },
    { x: 0, y: 1 },
    { x: a[1].x - a[0].x, y: a[1].y - a[0].y },
    { x: a[3].x - a[0].x, y: a[3].y - a[0].y },
  ];
  for (const axis of axes) {
    if (Math.abs(axis.x) < EPS && Math.abs(axis.y) < EPS) continue;
    const [a0, a1] = project(a, axis);
    const [b0, b1] = project(b, axis);
    if (a1 < b0 - EPS || b1 < a0 - EPS) return false;
  }
  return true;
}

export function rectContainsObb(r: Rect, o: Obb): boolean {
  return obbCorners(o).every((p) => rectContainsPoint(r, p, EPS));
}

/** Tight box around boxes sharing `rotation` (degrees), in that rotated frame. */
export function rotatedBounds(boxes: readonly Obb[], rotationDeg: number): Obb | null {
  const unrot = rotation(-rotationDeg);
  const pts = boxes.flatMap((b) => obbCorners(b).map((p) => apply(unrot, p)));
  const r = boundsOfPoints(pts);
  if (!r) return null;
  return { m: mul(rotation(rotationDeg), translation(r.x, r.y)), w: r.w, h: r.h };
}

// ------------------------------------------------------------------------------------------------------------
// Segments

/** Distance from `p` to the segment a-b and the parameter of the closest point. */
export function segmentDistance(p: Point, a: Point, b: Point): { d: number; t: number } {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 < EPS ? 0 : clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / len2, 0, 1);
  return { d: Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t)), t };
}

/** Rounds to `decimals` places (geometry written to the document keeps 1/100 px precision). */
export function round(v: number, decimals = 2): number {
  const k = 10 ** decimals;
  const r = Math.round(v * k) / k;
  return Object.is(r, -0) ? 0 : r;
}
