import type { Point, Rect } from "./math.ts";

/**
 * Smart measurements (alt + hover): distances from the selection to the hovered layer, or to the container
 * around it. Pure geometry on axis-aligned bounds; the overlay draws each segment with its value.
 */

export interface Measurement {
  a: Point;
  b: Point;
  value: number;
  /** Dashed helper lines extending an edge to the measurement (when the boxes do not overlap). */
  guides: [Point, Point][];
}

const EPS = 1e-6;

function insideOf(outer: Rect, inner: Rect): boolean {
  return (
    inner.x >= outer.x - EPS &&
    inner.y >= outer.y - EPS &&
    inner.x + inner.w <= outer.x + outer.w + EPS &&
    inner.y + inner.h <= outer.y + outer.h + EPS
  );
}

/** Distances from each side of `inner` to the matching side of `outer`. */
function containment(inner: Rect, outer: Rect): Measurement[] {
  const cx = inner.x + inner.w / 2;
  const cy = inner.y + inner.h / 2;
  const out: Measurement[] = [];
  const push = (a: Point, b: Point) => {
    const value = Math.hypot(b.x - a.x, b.y - a.y);
    if (value > EPS) out.push({ a, b, value, guides: [] });
  };
  push({ x: inner.x, y: cy }, { x: outer.x, y: cy });
  push({ x: inner.x + inner.w, y: cy }, { x: outer.x + outer.w, y: cy });
  push({ x: cx, y: inner.y }, { x: cx, y: outer.y });
  push({ x: cx, y: inner.y + inner.h }, { x: cx, y: outer.y + outer.h });
  return out;
}

export function measureBetween(sel: Rect, other: Rect): Measurement[] {
  if (insideOf(other, sel)) return containment(sel, other);
  if (insideOf(sel, other)) return containment(other, sel);
  const out: Measurement[] = [];
  const selR = sel.x + sel.w;
  const selB = sel.y + sel.h;
  const othR = other.x + other.w;
  const othB = other.y + other.h;
  // Horizontal gap.
  if (other.x >= selR || othR <= sel.x) {
    const right = other.x >= selR;
    const x0 = right ? selR : othR;
    const x1 = right ? other.x : sel.x;
    const top = Math.max(sel.y, other.y);
    const bottom = Math.min(selB, othB);
    const overlap = bottom >= top;
    const y = overlap ? (top + bottom) / 2 : sel.y + sel.h / 2;
    const guides: [Point, Point][] = [];
    if (!overlap) {
      // Extend the other box's near edge to the measurement line.
      const ex = right ? other.x : othR;
      const ey = other.y > selB ? other.y : othB;
      guides.push([
        { x: ex, y: ey },
        { x: ex, y },
      ]);
    }
    out.push({ a: { x: x0, y }, b: { x: x1, y }, value: x1 - x0, guides });
  }
  // Vertical gap.
  if (other.y >= selB || othB <= sel.y) {
    const below = other.y >= selB;
    const y0 = below ? selB : othB;
    const y1 = below ? other.y : sel.y;
    const left = Math.max(sel.x, other.x);
    const right = Math.min(selR, othR);
    const overlap = right >= left;
    const x = overlap ? (left + right) / 2 : sel.x + sel.w / 2;
    const guides: [Point, Point][] = [];
    if (!overlap) {
      const ey = below ? other.y : othB;
      const ex = other.x > selR ? other.x : othR;
      guides.push([
        { x: ex, y: ey },
        { x, y: ey },
      ]);
    }
    out.push({ a: { x, y: y0 }, b: { x, y: y1 }, value: y1 - y0, guides });
  }
  if (out.length > 0) return out;
  // Partial overlap: offsets between the matching edges.
  const cy = Math.max(sel.y, other.y) + (Math.min(selB, othB) - Math.max(sel.y, other.y)) / 2;
  const cx = Math.max(sel.x, other.x) + (Math.min(selR, othR) - Math.max(sel.x, other.x)) / 2;
  const push = (a: Point, b: Point) => {
    const value = Math.hypot(b.x - a.x, b.y - a.y);
    if (value > EPS) out.push({ a, b, value, guides: [] });
  };
  push({ x: sel.x, y: cy }, { x: other.x, y: cy });
  push({ x: selR, y: cy }, { x: othR, y: cy });
  push({ x: cx, y: sel.y }, { x: cx, y: other.y });
  push({ x: cx, y: selB }, { x: cx, y: othB });
  return out;
}
