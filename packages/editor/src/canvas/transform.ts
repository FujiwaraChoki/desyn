import { Builder, decompose, getNode, scalePath, worldTransform } from "@desyn/doc-ops";
import type { Design, Id, Node, Op } from "@desyn/schema";
import {
  apply,
  applyVec,
  clamp,
  IDENTITY,
  inv,
  type Matrix,
  mul,
  type Obb,
  type Point,
  scaling,
  toLocal,
  translation,
} from "./math.ts";

/**
 * Transform math for move / resize / rotate gestures and the ops that write the result: every selected node
 * gets the page-space map `T` applied to its box; placement (x, y, rotation, flips) is decomposed back into
 * its parent's coordinates. Groups and booleans have derived bounds, so a scale is applied to their children
 * and the bounds are refit; rigid transforms (moves, rotations) apply to the container itself.
 */

export type HandleKind =
  | "top-left"
  | "top"
  | "top-right"
  | "right"
  | "bottom-right"
  | "bottom"
  | "bottom-left"
  | "left";

export const HANDLES: readonly HandleKind[] = [
  "top-left",
  "top",
  "top-right",
  "right",
  "bottom-right",
  "bottom",
  "bottom-left",
  "left",
];

export const CORNERS: readonly HandleKind[] = [
  "top-left",
  "top-right",
  "bottom-right",
  "bottom-left",
];

/** Position of a handle in the unit box. */
export function handleAnchor(h: HandleKind): [number, number] {
  switch (h) {
    case "top-left":
      return [0, 0];
    case "top":
      return [0.5, 0];
    case "top-right":
      return [1, 0];
    case "right":
      return [1, 0.5];
    case "bottom-right":
      return [1, 1];
    case "bottom":
      return [0.5, 1];
    case "bottom-left":
      return [0, 1];
    case "left":
      return [0, 0.5];
  }
}

export function oppositeHandle(h: HandleKind): HandleKind {
  const i = HANDLES.indexOf(h);
  return HANDLES[(i + 4) % 8] as HandleKind;
}

export interface ResizeOptions {
  /** Keep the aspect ratio (shift, aspect-locked nodes). */
  keepAspect?: boolean;
  /** Resize about the center (alt). */
  fromCenter?: boolean;
}

export interface ResizeResult {
  /** The new box (unflipped: flips are reported separately). */
  box: Obb;
  flipX: boolean;
  flipY: boolean;
  /** Old box-local -> new box-local coordinates (includes flips). */
  local: Matrix;
  /** Page-space map from the old box to the new one. */
  page: Matrix;
}

/**
 * New box after dragging `handle` of `b` to `pointer` (page coordinates). The opposite handle (or the center)
 * stays fixed; dragging past it flips. Same rules as the engine's `resizeBox`.
 */
export function resizeObb(
  b: Obb,
  handle: HandleKind,
  pointer: Point,
  o: ResizeOptions = {},
): ResizeResult {
  const local = toLocal(b, pointer);
  const [u, v] = handleAnchor(handle);
  const [au, av] = o.fromCenter ? [0.5, 0.5] : handleAnchor(oppositeHandle(handle));
  const anchor = { x: au * b.w, y: av * b.h };
  const horizontal = u !== 0.5;
  const vertical = v !== 0.5;
  const k = o.fromCenter ? 2 : 1;
  let w = horizontal ? (local.x - anchor.x) * k * (u < au ? -1 : 1) : b.w;
  let h = vertical ? (local.y - anchor.y) * k * (v < av ? -1 : 1) : b.h;
  if (o.keepAspect && b.w > 0 && b.h > 0) {
    const ratio = b.w / b.h;
    const sign = (n: number) => (n < 0 ? -1 : 1);
    if (horizontal && vertical) {
      if (Math.abs(w / b.w) > Math.abs(h / b.h)) h = (Math.abs(w) / ratio) * sign(h);
      else w = Math.abs(h) * ratio * sign(w);
    } else if (horizontal) {
      h = Math.abs(w) / ratio;
    } else if (vertical) {
      w = Math.abs(h) * ratio;
    }
  }
  const flipX = w < 0;
  const flipY = h < 0;
  const nw = Math.abs(w);
  const nh = Math.abs(h);
  const ox = o.fromCenter
    ? anchor.x - nw / 2
    : !horizontal
      ? o.keepAspect
        ? (b.w - nw) / 2
        : 0
      : u < au !== flipX
        ? anchor.x - nw
        : anchor.x;
  const oy = o.fromCenter
    ? anchor.y - nh / 2
    : !vertical
      ? o.keepAspect
        ? (b.h - nh) / 2
        : 0
      : v < av !== flipY
        ? anchor.y - nh
        : anchor.y;
  const sx = b.w > 1e-9 ? nw / b.w : 1;
  const sy = b.h > 1e-9 ? nh / b.h : 1;
  // x' = ox + (flipX ? nw - x·sx : x·sx); same for y.
  const localMap: Matrix = [
    flipX ? -sx : sx,
    0,
    0,
    flipY ? -sy : sy,
    ox + (flipX ? nw : 0),
    oy + (flipY ? nh : 0),
  ];
  return {
    box: { m: mul(b.m, translation(ox, oy)), w: nw, h: nh },
    flipX,
    flipY,
    local: localMap,
    page: mul(b.m, mul(localMap, inv(b.m))),
  };
}

/** Moving edges of a handle drag in the unrotated box (for resize snapping). */
export function handleEdges(h: HandleKind, fromCenter = false) {
  const [u, v] = handleAnchor(h);
  return {
    left: u === 0 || (fromCenter && u === 1),
    right: u === 1 || (fromCenter && u === 0),
    top: v === 0 || (fromCenter && v === 1),
    bottom: v === 1 || (fromCenter && v === 0),
  };
}

const r4 = (v: number) => {
  const r = Math.round(v * 10000) / 10000;
  return Object.is(r, -0) ? 0 : r;
};

function isRigid(t: Matrix): boolean {
  const [a, b, c, d] = t;
  return (
    Math.abs(a * a + b * b - 1) < 1e-9 &&
    Math.abs(c * c + d * d - 1) < 1e-9 &&
    Math.abs(a * c + b * d) < 1e-9
  );
}

const DERIVED_BOUNDS: ReadonlySet<string> = new Set(["group", "boolean"]);

/**
 * Applies the page-space map `t` to a node: new size from how `t` stretches the node's axes, placement from
 * the rigid part (center preserved). Skew (non-uniform scale of a rotated node) is approximated by keeping the
 * node's own axes.
 */
export function transformNode(b: Builder, id: Id, t: Matrix): void {
  const node = b.node(id);
  if (node.type === "page" || node.type === "root") return;
  if (DERIVED_BOUNDS.has(node.type) && !isRigid(t) && "children" in node) {
    for (const child of node.children) transformNode(b, child, t);
    return;
  }
  const world = worldTransform(b.design, id);
  const a = mul(t, world);
  const ex = applyVec(a, { x: 1, y: 0 });
  const ey = applyVec(a, { x: 0, y: 1 });
  let sx = Math.hypot(ex.x, ex.y);
  let ux = sx > 1e-12 ? { x: ex.x / sx, y: ex.y / sx } : { x: 1, y: 0 };
  if (sx <= 1e-12) {
    // A collapsed axis keeps the node's direction.
    const wx = applyVec(world, { x: 1, y: 0 });
    const l = Math.hypot(wx.x, wx.y) || 1;
    ux = { x: wx.x / l, y: wx.y / l };
    sx = 0;
  }
  const perp = { x: -ux.y, y: ux.x };
  const eyPerp = ey.x * perp.x + ey.y * perp.y;
  const sy = Math.abs(eyPerp);
  const v = eyPerp < 0 ? { x: -perp.x, y: -perp.y } : perp;
  const w = node.width * sx;
  const h = node.height * sy;
  const center = apply(a, { x: node.width / 2, y: node.height / 2 });
  const origin = {
    x: center.x - (ux.x * w) / 2 - (v.x * h) / 2,
    y: center.y - (ux.y * w) / 2 - (v.y * h) / 2,
  };
  const m: Matrix = [ux.x, ux.y, v.x, v.y, origin.x, origin.y];
  const parentWorld = node.parent ? worldTransform(b.design, node.parent) : IDENTITY;
  const local = mul(inv(parentWorld), m);
  const resized = Math.abs(w - node.width) > 1e-6 || Math.abs(h - node.height) > 1e-6;
  b.place(id, decompose(local, w, h, node));
  if (!resized) return;
  const set: Record<string, unknown> = { width: r4(w), height: r4(h) };
  Object.assign(set, sizeDependentProps(node, w, h));
  b.update(id, set);
}

/** Properties that must follow a box size change (path data, table tracks, text sizing mode). */
function sizeDependentProps(node: Node, w: number, h: number): Record<string, unknown> {
  const kx = node.width > 1e-9 ? w / node.width : 1;
  const ky = node.height > 1e-9 ? h / node.height : 1;
  switch (node.type) {
    case "path":
      return {
        paths: node.paths.map((p) => {
          try {
            return { ...p, d: scalePath(p.d, kx, ky) };
          } catch {
            return p;
          }
        }),
      };
    case "table":
      return {
        colWidths: node.colWidths.map((c) => r4(c * kx)),
        rowHeights: node.rowHeights.map((c) => r4(c * ky)),
      };
    case "text": {
      const widthChanged = Math.abs(w - node.width) > 1e-6;
      const heightChanged = Math.abs(h - node.height) > 1e-6;
      // A height set by hand fixes the box; a width set by hand turns a growing line into a wrapping block.
      if (heightChanged && node.autoResize !== "none") return { autoResize: "none" };
      if (widthChanged && node.autoResize === "width") return { autoResize: "height" };
      return {};
    }
    default:
      return {};
  }
}

/** Applies `t` to every top-level id and refits the groups they live in. */
export function transformOps(design: Design, ids: readonly Id[], t: Matrix): Op[] {
  const b = new Builder(design);
  for (const id of ids) if (getNode(b.design, id)) transformNode(b, id, t);
  b.refitGroups(ids);
  return b.ops;
}

/** Moves top-level ids by a page-space delta. */
export function moveOps(design: Design, ids: readonly Id[], dx: number, dy: number): Op[] {
  const b = new Builder(design);
  for (const id of ids) if (getNode(b.design, id)) b.translateInPage(id, dx, dy);
  b.refitGroups(ids);
  return b.ops;
}

/** Writes a line's endpoints (page coordinates): length, angle and center in its parent's space. */
export function lineEndpointOps(design: Design, id: Id, start: Point, end: Point): Op[] {
  const b = new Builder(design);
  const node = b.node(id);
  const parentWorld = node.parent ? worldTransform(design, node.parent) : IDENTITY;
  const pi = inv(parentWorld);
  const q0 = apply(pi, start);
  const q1 = apply(pi, end);
  const len = Math.hypot(q1.x - q0.x, q1.y - q0.y);
  const angle = (Math.atan2(q1.y - q0.y, q1.x - q0.x) * 180) / Math.PI;
  const cx = (q0.x + q1.x) / 2;
  const cy = (q0.y + q1.y) / 2;
  b.place(id, {
    x: cx - len / 2,
    y: cy - node.height / 2,
    rotation: angle === -180 ? 180 : angle,
    flipX: false,
    flipY: false,
  });
  b.update(id, { width: r4(len) });
  b.refitGroups([id]);
  return b.ops;
}

/** Page-space endpoints of a line node. */
export function lineEndpoints(design: Design, id: Id): [Point, Point] | null {
  const node = getNode(design, id);
  if (node?.type !== "line") return null;
  const m = worldTransform(design, id);
  const y = node.height / 2;
  return [apply(m, { x: 0, y }), apply(m, { x: node.width, y })];
}

/** Scales a box-local map into a page map for a box. */
export function pageMapFromLocal(box: Obb, local: Matrix): Matrix {
  return mul(box.m, mul(local, inv(box.m)));
}

export function uniformScaleAbout(center: Point, k: number): Matrix {
  return mul(
    translation(center.x, center.y),
    mul(scaling(k, k), translation(-center.x, -center.y)),
  );
}

/** Corner radius from a pointer dragged inside a box corner (box-local), clamped to half the short side. */
export function radiusFromPointer(w: number, h: number, corner: HandleKind, local: Point): number {
  const [u, v] = handleAnchor(corner);
  const dx = u === 0 ? local.x : w - local.x;
  const dy = v === 0 ? local.y : h - local.y;
  // Projection on the corner's bisector: the handle sits at (r, r) from the corner.
  const r = (dx + dy) / 2;
  return clamp(r, 0, Math.min(w, h) / 2);
}

/** Unit-box vertices of a regular polygon / star fitted to `w × h` (first vertex at 12 o'clock), as the engine. */
export function polygonPoints(w: number, h: number, sides: number): Point[] {
  const n = Math.max(3, Math.min(Math.round(sides), 1000));
  const unit = Array.from({ length: n }, (_, i) => {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / n;
    return { x: Math.cos(a), y: Math.sin(a) };
  });
  return fitPoints(unit, unit, w, h);
}

export function starPoints(w: number, h: number, points: number, innerRatio: number): Point[] {
  const n = Math.max(3, Math.min(Math.round(points), 500));
  const ir = clamp(innerRatio, 0, 1);
  const unit = Array.from({ length: 2 * n }, (_, i) => {
    const a = -Math.PI / 2 + (i * Math.PI) / n;
    const r = i % 2 === 0 ? 1 : ir;
    return { x: Math.cos(a) * r, y: Math.sin(a) * r };
  });
  return fitPoints(
    unit,
    unit.filter((_, i) => i % 2 === 0),
    w,
    h,
  );
}

function fitPoints(points: Point[], boundsOf: Point[], w: number, h: number): Point[] {
  let x0 = Number.POSITIVE_INFINITY;
  let y0 = Number.POSITIVE_INFINITY;
  let x1 = Number.NEGATIVE_INFINITY;
  let y1 = Number.NEGATIVE_INFINITY;
  for (const p of boundsOf) {
    x0 = Math.min(x0, p.x);
    y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x);
    y1 = Math.max(y1, p.y);
  }
  const sx = x1 - x0 > 1e-12 ? w / (x1 - x0) : 0;
  const sy = y1 - y0 > 1e-12 ? h / (y1 - y0) : 0;
  return points.map((p) => ({ x: (p.x - x0) * sx, y: (p.y - y0) * sy }));
}
