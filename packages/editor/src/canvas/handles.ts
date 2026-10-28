import { apply, dist, type Obb, type Point, segmentDistance, toLocal } from "./math.ts";
import { CORNERS, type HandleKind, handleAnchor } from "./transform.ts";

/**
 * Transform handles of a selection box: four corner squares, edge zones (with visible midpoint squares when
 * the box is large enough on screen), a round rotate knob under the box (Canva-style, every layer type
 * including lines) and rotation zones just outside the corners. Sizes are in screen px and converted with the
 * zoom, so handles feel the same at every zoom level.
 */

export const CORNER_HIT = 7;
export const EDGE_HIT = 5;
export const ROTATE_HIT = 18;
/** Rotate knob: radius and distance of its center from the box's bottom edge (screen px). */
export const KNOB_RADIUS = 11;
export const KNOB_OFFSET = 26;
/** Below this on-screen side length the edge midpoint squares are not drawn. */
export const EDGE_HANDLE_MIN = 48;

export type HandleHit =
  | { type: "resize"; handle: HandleKind }
  | { type: "rotate"; handle: HandleKind };

export function handlePoint(box: Obb, h: HandleKind): Point {
  const [u, v] = handleAnchor(h);
  return apply(box.m, { x: u * box.w, y: v * box.h });
}

/**
 * Center of the rotate knob: under the middle of the box's bottom edge, along the box's own vertical axis, so
 * it turns with the layer. Lines (zero height) get it on the side their local y axis points to.
 */
export function rotateKnobPoint(box: Obb, zoom: number): Point {
  const bottom = handlePoint(box, "bottom");
  const len = Math.hypot(box.m[2], box.m[3]) || 1;
  const d = KNOB_OFFSET / zoom;
  return { x: bottom.x + (box.m[2] / len) * d, y: bottom.y + (box.m[3] / len) * d };
}

/** Whether `p` (page coordinates) is on the rotate knob. */
export function hitRotateKnob(box: Obb, zoom: number, p: Point, scale = 1): boolean {
  return dist(rotateKnobPoint(box, zoom), p) * zoom <= (KNOB_RADIUS + 2) * scale;
}

/** Screen length of the box's sides. */
export function screenSides(box: Obb, zoom: number): { w: number; h: number } {
  const sx = Math.hypot(box.m[0], box.m[1]);
  const sy = Math.hypot(box.m[2], box.m[3]);
  return { w: box.w * sx * zoom, h: box.h * sy * zoom };
}

/**
 * The handle under `p` (page coordinates). Corners win over edges; rotation zones are outside the box near the
 * corners. `allowRotate` false for selections that cannot rotate (pages).
 */
export function hitHandles(
  box: Obb,
  zoom: number,
  p: Point,
  opts: { allowRotate?: boolean; allowResize?: boolean; scale?: number } = {},
): HandleHit | null {
  const allowResize = opts.allowResize ?? true;
  // Fingers need larger targets than the 8 px squares (touch input passes 2).
  const k = opts.scale ?? 1;
  if (opts.allowRotate !== false && hitRotateKnob(box, zoom, p, k)) {
    return { type: "rotate", handle: "bottom" };
  }
  const sides = screenSides(box, zoom);
  const toScreen = (d: number) => d * zoom;
  if (allowResize) {
    // Tiny boxes: corners only (edges would cover the whole box and make it impossible to move).
    let best: { h: HandleKind; d: number } | null = null;
    for (const h of CORNERS) {
      const d = toScreen(dist(handlePoint(box, h), p));
      if (d <= CORNER_HIT * k && (!best || d < best.d)) best = { h, d };
    }
    if (best) return { type: "resize", handle: best.h };
    const edges: [HandleKind, HandleKind, HandleKind, boolean][] = [
      ["top", "top-left", "top-right", sides.w >= 12],
      ["right", "top-right", "bottom-right", sides.h >= 12],
      ["bottom", "bottom-left", "bottom-right", sides.w >= 12],
      ["left", "top-left", "bottom-left", sides.h >= 12],
    ];
    for (const [h, a, b, ok] of edges) {
      if (!ok) continue;
      const { d } = segmentDistance(p, handlePoint(box, a), handlePoint(box, b));
      if (toScreen(d) <= EDGE_HIT * k) return { type: "resize", handle: h };
    }
  }
  if (opts.allowRotate !== false) {
    const local = toLocal(box, p);
    const inside = local.x >= 0 && local.y >= 0 && local.x <= box.w && local.y <= box.h;
    if (!inside) {
      for (const h of CORNERS) {
        const d = toScreen(dist(handlePoint(box, h), p));
        if (d <= ROTATE_HIT * k) return { type: "rotate", handle: h };
      }
    }
  }
  return null;
}

/** Screen direction (degrees) a handle points to from the box center: drives the resize / rotate cursor. */
export function handleDirection(box: Obb, h: HandleKind): number {
  const [u, v] = handleAnchor(h);
  // Edges point straight out, corners along 45° diagonals (whatever the aspect), through the box's axes.
  const ax = Math.hypot(box.m[0], box.m[1]) || 1;
  const ay = Math.hypot(box.m[2], box.m[3]) || 1;
  const su = Math.sign(u - 0.5);
  const sv = Math.sign(v - 0.5);
  const x = (box.m[0] / ax) * su + (box.m[2] / ay) * sv;
  const y = (box.m[1] / ax) * su + (box.m[3] / ay) * sv;
  return (Math.atan2(y, x) * 180) / Math.PI;
}
