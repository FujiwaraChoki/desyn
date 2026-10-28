import { parsePath } from "@desyn/doc-ops";
import type { Point } from "../canvas/math.ts";

/**
 * Editable vector paths: SVG path data <-> anchors with Bézier handles. Every command (relative or absolute
 * M L H V C S Q T A Z) is converted to cubic segments, so editing works on any imported path; serialization
 * writes `M`, `L`, `C` and `Z` with absolute coordinates.
 */

export interface Anchor {
  x: number;
  y: number;
  /** Control point of the segment arriving at this anchor (absolute), null for a straight end. */
  in: Point | null;
  /** Control point of the segment leaving this anchor (absolute). */
  out: Point | null;
}

export interface SubPath {
  anchors: Anchor[];
  closed: boolean;
}

export type AnchorKind = "corner" | "smooth" | "asymmetric" | "mixed";

const EPS = 1e-9;

function anchor(x: number, y: number): Anchor {
  return { x, y, in: null, out: null };
}

/** Cubic control points approximating an SVG elliptical arc (endpoint parameterization). */
function arcToCubics(
  x1: number,
  y1: number,
  rxIn: number,
  ryIn: number,
  angleDeg: number,
  largeArc: number,
  sweep: number,
  x2: number,
  y2: number,
): [Point, Point, Point][] {
  let rx = Math.abs(rxIn);
  let ry = Math.abs(ryIn);
  if (rx < EPS || ry < EPS || (Math.abs(x1 - x2) < EPS && Math.abs(y1 - y2) < EPS)) {
    return [
      [
        { x: x1, y: y1 },
        { x: x2, y: y2 },
        { x: x2, y: y2 },
      ],
    ];
  }
  const phi = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(phi);
  const sin = Math.sin(phi);
  const dx = (x1 - x2) / 2;
  const dy = (y1 - y2) / 2;
  const x1p = cos * dx + sin * dy;
  const y1p = -sin * dx + cos * dy;
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) {
    const s = Math.sqrt(lambda);
    rx *= s;
    ry *= s;
  }
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  let coef = Math.sqrt(Math.max(0, num / den));
  if (largeArc === sweep) coef = -coef;
  const cxp = (coef * rx * y1p) / ry;
  const cyp = (-coef * ry * x1p) / rx;
  const cx = cos * cxp - sin * cyp + (x1 + x2) / 2;
  const cy = sin * cxp + cos * cyp + (y1 + y2) / 2;
  const angle = (ux: number, uy: number, vx: number, vy: number) => {
    const a = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
    return a;
  };
  const t1 = angle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let dt = angle((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!sweep && dt > 0) dt -= 2 * Math.PI;
  else if (sweep && dt < 0) dt += 2 * Math.PI;
  const segments = Math.max(1, Math.ceil(Math.abs(dt) / (Math.PI / 2) - 1e-6));
  const step = dt / segments;
  const k = (4 / 3) * Math.tan(step / 4);
  const point = (t: number) => ({
    x: cx + rx * Math.cos(t) * cos - ry * Math.sin(t) * sin,
    y: cy + rx * Math.cos(t) * sin + ry * Math.sin(t) * cos,
  });
  const deriv = (t: number) => ({
    x: -rx * Math.sin(t) * cos - ry * Math.cos(t) * sin,
    y: -rx * Math.sin(t) * sin + ry * Math.cos(t) * cos,
  });
  const out: [Point, Point, Point][] = [];
  for (let i = 0; i < segments; i++) {
    const a = t1 + i * step;
    const b = a + step;
    const p0 = point(a);
    const p3 = i === segments - 1 ? { x: x2, y: y2 } : point(b);
    const d0 = deriv(a);
    const d1 = deriv(b);
    out.push([
      { x: p0.x + k * d0.x, y: p0.y + k * d0.y },
      { x: p3.x - k * d1.x, y: p3.y - k * d1.y },
      p3,
    ]);
  }
  return out;
}

/** Parses path data into editable subpaths (throws on malformed data). */
export function parseSubPaths(d: string): SubPath[] {
  const out: SubPath[] = [];
  let current: SubPath | null = null;
  let x = 0;
  let y = 0;
  let startX = 0;
  let startY = 0;
  let lastCubic: Point | null = null;
  let lastQuad: Point | null = null;
  const last = () => current?.anchors[current.anchors.length - 1];
  const ensure = () => {
    if (!current) {
      current = { anchors: [anchor(x, y)], closed: false };
      out.push(current);
    }
    return current;
  };
  const cubicTo = (c1: Point, c2: Point, p: Point) => {
    const sp = ensure();
    const prev = sp.anchors[sp.anchors.length - 1] as Anchor;
    prev.out = { ...c1 };
    const next = anchor(p.x, p.y);
    next.in = { ...c2 };
    sp.anchors.push(next);
    x = p.x;
    y = p.y;
  };
  const lineTo = (p: Point) => {
    const sp = ensure();
    sp.anchors.push(anchor(p.x, p.y));
    x = p.x;
    y = p.y;
  };
  for (const { cmd, args } of parsePath(d)) {
    const rel = cmd === cmd.toLowerCase();
    const ox = rel ? x : 0;
    const oy = rel ? y : 0;
    const a = args as number[];
    let cubic: Point | null = null;
    let quad: Point | null = null;
    switch (cmd.toLowerCase()) {
      case "m": {
        x = (a[0] as number) + ox;
        y = (a[1] as number) + oy;
        startX = x;
        startY = y;
        current = { anchors: [anchor(x, y)], closed: false };
        out.push(current);
        break;
      }
      case "l":
        lineTo({ x: (a[0] as number) + ox, y: (a[1] as number) + oy });
        break;
      case "h":
        lineTo({ x: (a[0] as number) + ox, y });
        break;
      case "v":
        lineTo({ x, y: (a[0] as number) + oy });
        break;
      case "c": {
        const c1 = { x: (a[0] as number) + ox, y: (a[1] as number) + oy };
        const c2 = { x: (a[2] as number) + ox, y: (a[3] as number) + oy };
        cubicTo(c1, c2, { x: (a[4] as number) + ox, y: (a[5] as number) + oy });
        cubic = c2;
        break;
      }
      case "s": {
        const prevCubic: Point | null = lastCubic;
        const c1: Point = prevCubic ? { x: 2 * x - prevCubic.x, y: 2 * y - prevCubic.y } : { x, y };
        const c2 = { x: (a[0] as number) + ox, y: (a[1] as number) + oy };
        cubicTo(c1, c2, { x: (a[2] as number) + ox, y: (a[3] as number) + oy });
        cubic = c2;
        break;
      }
      case "q": {
        const q = { x: (a[0] as number) + ox, y: (a[1] as number) + oy };
        const p = { x: (a[2] as number) + ox, y: (a[3] as number) + oy };
        cubicTo(
          { x: x + (2 / 3) * (q.x - x), y: y + (2 / 3) * (q.y - y) },
          { x: p.x + (2 / 3) * (q.x - p.x), y: p.y + (2 / 3) * (q.y - p.y) },
          p,
        );
        quad = q;
        break;
      }
      case "t": {
        const prevQuad: Point | null = lastQuad;
        const q: Point = prevQuad ? { x: 2 * x - prevQuad.x, y: 2 * y - prevQuad.y } : { x, y };
        const p = { x: (a[0] as number) + ox, y: (a[1] as number) + oy };
        cubicTo(
          { x: x + (2 / 3) * (q.x - x), y: y + (2 / 3) * (q.y - y) },
          { x: p.x + (2 / 3) * (q.x - p.x), y: p.y + (2 / 3) * (q.y - p.y) },
          p,
        );
        quad = q;
        break;
      }
      case "a": {
        const ex = (a[5] as number) + ox;
        const ey = (a[6] as number) + oy;
        for (const [c1, c2, p] of arcToCubics(
          x,
          y,
          a[0] as number,
          a[1] as number,
          a[2] as number,
          a[3] as number,
          a[4] as number,
          ex,
          ey,
        )) {
          cubicTo(c1, c2, p);
        }
        break;
      }
      case "z": {
        const sp = current as SubPath | null;
        if (sp) {
          const first = sp.anchors[0] as Anchor;
          const end = last() as Anchor;
          // A closing segment drawn explicitly onto the start point merges into the first anchor.
          if (
            sp.anchors.length > 1 &&
            Math.abs(end.x - first.x) < 1e-6 &&
            Math.abs(end.y - first.y) < 1e-6
          ) {
            first.in = end.in;
            sp.anchors.pop();
          }
          sp.closed = true;
        }
        x = startX;
        y = startY;
        current = null;
        break;
      }
    }
    lastCubic = cubic;
    lastQuad = quad;
  }
  return out.filter((sp) => sp.anchors.length > 0);
}

function fmt(n: number): string {
  const r = Math.round(n * 1000) / 1000;
  return String(Object.is(r, -0) ? 0 : r);
}

function segment(from: Anchor, to: Anchor): string {
  if (from.out || to.in) {
    const c1 = from.out ?? from;
    const c2 = to.in ?? to;
    return `C${fmt(c1.x)} ${fmt(c1.y)} ${fmt(c2.x)} ${fmt(c2.y)} ${fmt(to.x)} ${fmt(to.y)}`;
  }
  return `L${fmt(to.x)} ${fmt(to.y)}`;
}

export function serializeSubPaths(paths: readonly SubPath[]): string {
  let d = "";
  for (const sp of paths) {
    const first = sp.anchors[0];
    if (!first) continue;
    d += `M${fmt(first.x)} ${fmt(first.y)}`;
    for (let i = 1; i < sp.anchors.length; i++) {
      d += segment(sp.anchors[i - 1] as Anchor, sp.anchors[i] as Anchor);
    }
    if (sp.closed && sp.anchors.length > 1) {
      const lastA = sp.anchors[sp.anchors.length - 1] as Anchor;
      if (lastA.out || first.in) d += segment(lastA, first);
      d += "Z";
    }
  }
  return d;
}

export function clonePaths(paths: readonly SubPath[]): SubPath[] {
  return paths.map((sp) => ({
    closed: sp.closed,
    anchors: sp.anchors.map((a) => ({
      x: a.x,
      y: a.y,
      in: a.in ? { ...a.in } : null,
      out: a.out ? { ...a.out } : null,
    })),
  }));
}

/** Applies `f` to every point (anchors and handles). */
export function mapPoints(paths: readonly SubPath[], f: (p: Point) => Point): SubPath[] {
  return paths.map((sp) => ({
    closed: sp.closed,
    anchors: sp.anchors.map((a) => {
      const p = f(a);
      return { x: p.x, y: p.y, in: a.in ? f(a.in) : null, out: a.out ? f(a.out) : null };
    }),
  }));
}

export function anchorKind(a: Anchor): AnchorKind {
  if (!a.in && !a.out) return "corner";
  if (!a.in || !a.out) return "mixed";
  const vin = { x: a.in.x - a.x, y: a.in.y - a.y };
  const vout = { x: a.out.x - a.x, y: a.out.y - a.y };
  const lin = Math.hypot(vin.x, vin.y);
  const lout = Math.hypot(vout.x, vout.y);
  if (lin < EPS || lout < EPS) return "mixed";
  const cross = vin.x * vout.y - vin.y * vout.x;
  const dot = vin.x * vout.x + vin.y * vout.y;
  const colinear = Math.abs(cross) / (lin * lout) < 1e-3 && dot < 0;
  if (!colinear) return "corner";
  return Math.abs(lin - lout) < 1e-3 * Math.max(lin, lout) ? "smooth" : "asymmetric";
}

/** Point on a cubic at t. */
export function cubicAt(p0: Point, c1: Point, c2: Point, p3: Point, t: number): Point {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return {
    x: a * p0.x + b * c1.x + c * c2.x + d * p3.x,
    y: a * p0.y + b * c1.y + c * c2.y + d * p3.y,
  };
}

/** The segments of a subpath as [from index, to index]. */
export function segmentsOf(sp: SubPath): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 1; i < sp.anchors.length; i++) out.push([i - 1, i]);
  if (sp.closed && sp.anchors.length > 1) out.push([sp.anchors.length - 1, 0]);
  return out;
}

export function segmentPoints(sp: SubPath, seg: [number, number]): [Point, Point, Point, Point] {
  const a = sp.anchors[seg[0]] as Anchor;
  const b = sp.anchors[seg[1]] as Anchor;
  return [a, a.out ?? a, b.in ?? b, b];
}

/** Nearest point on any segment: subpath / segment index, parameter and distance. */
export function nearestOnPaths(
  paths: readonly SubPath[],
  p: Point,
): { path: number; segment: number; t: number; point: Point; d: number } | null {
  let best: { path: number; segment: number; t: number; point: Point; d: number } | null = null;
  paths.forEach((sp, pi) => {
    segmentsOf(sp).forEach((seg, si) => {
      const [p0, c1, c2, p3] = segmentPoints(sp, seg);
      const steps = 48;
      let bestT = 0;
      let bestD = Number.POSITIVE_INFINITY;
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const q = cubicAt(p0, c1, c2, p3, t);
        const d = Math.hypot(q.x - p.x, q.y - p.y);
        if (d < bestD) {
          bestD = d;
          bestT = t;
        }
      }
      // Refine around the best sample.
      let lo = Math.max(0, bestT - 1 / steps);
      let hi = Math.min(1, bestT + 1 / steps);
      for (let k = 0; k < 20; k++) {
        const m1 = lo + (hi - lo) / 3;
        const m2 = hi - (hi - lo) / 3;
        const d1 = Math.hypot(
          cubicAt(p0, c1, c2, p3, m1).x - p.x,
          cubicAt(p0, c1, c2, p3, m1).y - p.y,
        );
        const d2 = Math.hypot(
          cubicAt(p0, c1, c2, p3, m2).x - p.x,
          cubicAt(p0, c1, c2, p3, m2).y - p.y,
        );
        if (d1 < d2) hi = m2;
        else lo = m1;
      }
      const t = (lo + hi) / 2;
      const point = cubicAt(p0, c1, c2, p3, t);
      const d = Math.hypot(point.x - p.x, point.y - p.y);
      if (!best || d < best.d) best = { path: pi, segment: si, t, point, d };
    });
  });
  return best;
}

/** Splits a segment at t (de Casteljau), inserting a smooth anchor; returns the new anchor index. */
export function splitSegment(sp: SubPath, segIndex: number, t: number): number {
  const seg = segmentsOf(sp)[segIndex];
  if (!seg) return -1;
  const a = sp.anchors[seg[0]] as Anchor;
  const b = sp.anchors[seg[1]] as Anchor;
  const straight = !a.out && !b.in;
  const [p0, c1, c2, p3] = segmentPoints(sp, seg);
  const lerp = (u: Point, v: Point) => ({ x: u.x + (v.x - u.x) * t, y: u.y + (v.y - u.y) * t });
  const q0 = lerp(p0, c1);
  const q1 = lerp(c1, c2);
  const q2 = lerp(c2, p3);
  const r0 = lerp(q0, q1);
  const r1 = lerp(q1, q2);
  const s = lerp(r0, r1);
  const inserted: Anchor = straight
    ? { x: s.x, y: s.y, in: null, out: null }
    : { x: s.x, y: s.y, in: r0, out: r1 };
  if (!straight) {
    a.out = q0;
    b.in = q2;
  }
  const at = seg[1] === 0 ? sp.anchors.length : seg[1];
  sp.anchors.splice(at, 0, inserted);
  return at;
}

/** Toggles an anchor between corner (no handles) and smooth (symmetric handles along the neighbours). */
export function toggleSmooth(sp: SubPath, index: number): void {
  const a = sp.anchors[index];
  if (!a) return;
  if (a.in || a.out) {
    a.in = null;
    a.out = null;
    return;
  }
  const n = sp.anchors.length;
  const prev = index > 0 ? sp.anchors[index - 1] : sp.closed ? sp.anchors[n - 1] : undefined;
  const next = index < n - 1 ? sp.anchors[index + 1] : sp.closed ? sp.anchors[0] : undefined;
  const from = prev ?? a;
  const to = next ?? a;
  let dx = to.x - from.x;
  let dy = to.y - from.y;
  const len = Math.hypot(dx, dy);
  if (len < EPS) {
    dx = 1;
    dy = 0;
  } else {
    dx /= len;
    dy /= len;
  }
  const lin = prev ? Math.hypot(a.x - prev.x, a.y - prev.y) / 3 : 0;
  const lout = next ? Math.hypot(next.x - a.x, next.y - a.y) / 3 : 0;
  const l = Math.max(lin, lout, 8);
  a.in = prev ? { x: a.x - dx * (lin || l), y: a.y - dy * (lin || l) } : null;
  a.out = next ? { x: a.x + dx * (lout || l), y: a.y + dy * (lout || l) } : null;
}

/** Real roots of a·t² + b·t + c in (0, 1). */
function unitRoots(a: number, b: number, c: number): number[] {
  if (Math.abs(a) < 1e-12) {
    if (Math.abs(b) < 1e-12) return [];
    const t = -c / b;
    return t > 0 && t < 1 ? [t] : [];
  }
  const disc = b * b - 4 * a * c;
  if (disc < 0) return [];
  const s = Math.sqrt(disc);
  return [(-b + s) / (2 * a), (-b - s) / (2 * a)].filter((t) => t > 0 && t < 1);
}

/** Exact bounds of the curves (extrema of each cubic). */
export function pathBounds(
  paths: readonly SubPath[],
): { x: number; y: number; w: number; h: number } | null {
  let x0 = Number.POSITIVE_INFINITY;
  let y0 = Number.POSITIVE_INFINITY;
  let x1 = Number.NEGATIVE_INFINITY;
  let y1 = Number.NEGATIVE_INFINITY;
  const add = (p: Point) => {
    x0 = Math.min(x0, p.x);
    y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x);
    y1 = Math.max(y1, p.y);
  };
  for (const sp of paths) {
    for (const a of sp.anchors) add(a);
    for (const seg of segmentsOf(sp)) {
      const [p0, c1, c2, p3] = segmentPoints(sp, seg);
      for (const axis of ["x", "y"] as const) {
        // B'(t)/3 = (1-t)²A + 2(1-t)t·B + t²C with A = c1-p0, B = c2-c1, C = p3-c2.
        const A = c1[axis] - p0[axis];
        const B = c2[axis] - c1[axis];
        const C = p3[axis] - c2[axis];
        for (const t of unitRoots(A - 2 * B + C, 2 * (B - A), A)) add(cubicAt(p0, c1, c2, p3, t));
      }
    }
  }
  if (!Number.isFinite(x0)) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
