import { getNode } from "@desyn/doc-ops";
import type { Design, Id, Node } from "@desyn/schema";
import { autoLayoutOf, nodeObb } from "./geometry.ts";
import { apply, clamp, dist, type Obb, type Point, toLocal } from "./math.ts";
import { CORNERS, type HandleKind, handleAnchor, lineEndpoints, starPoints } from "./transform.ts";

/**
 * Handles that edit a shape's own parameters on the canvas (shown for a single selected layer):
 * line endpoints, corner radius (rects, frames, images), polygon / star point count, star inner ratio,
 * auto-layout padding and gap.
 */

export type ShapeHandle =
  | { kind: "line-start" | "line-end"; at: Point }
  | { kind: "radius"; corner: HandleKind; at: Point }
  | { kind: "count"; at: Point }
  | { kind: "ratio"; at: Point }
  | { kind: "padding"; side: 0 | 1 | 2 | 3; at: Point; a: Point; b: Point }
  | { kind: "gap"; at: Point; a: Point; b: Point };

/** Minimum on-screen box side for the parameter handles to appear. */
const MIN_SIDE = 40;
/** Handles keep this distance (screen px) from corners / edges so they never cover the resize handles. */
const INSET = 12;

function radiusOf(node: Node): number[] | null {
  if (!("cornerRadius" in node)) return null;
  const r = node.cornerRadius;
  return typeof r === "number" ? [r, r, r, r] : [...r];
}

export function supportsRadius(node: Node | undefined): boolean {
  return !!node && (node.type === "rect" || node.type === "frame" || node.type === "image");
}

/** Corner index (tl tr br bl) of a corner handle. */
export function cornerIndex(h: HandleKind): number {
  return CORNERS.indexOf(h);
}

export function shapeHandles(design: Design, id: Id, zoom: number): ShapeHandle[] {
  const node = getNode(design, id);
  const box = nodeObb(design, id);
  if (!node || !box) return [];
  if (node.type === "line") {
    const ends = lineEndpoints(design, id);
    return ends
      ? [
          { kind: "line-start", at: ends[0] },
          { kind: "line-end", at: ends[1] },
        ]
      : [];
  }
  const sw = box.w * zoom;
  const sh = box.h * zoom;
  if (sw < MIN_SIDE || sh < MIN_SIDE) return [];
  const out: ShapeHandle[] = [];
  const inset = INSET / zoom;
  if (supportsRadius(node)) {
    const radii = radiusOf(node) ?? [0, 0, 0, 0];
    const max = Math.min(box.w, box.h) / 2;
    CORNERS.forEach((corner, i) => {
      const [u, v] = handleAnchor(corner);
      const r = clamp(Math.max(radii[i] ?? 0, inset), 0, max);
      const local = { x: u === 0 ? r : box.w - r, y: v === 0 ? r : box.h - r };
      out.push({ kind: "radius", corner, at: apply(box.m, local) });
    });
  }
  if (node.type === "polygon" || node.type === "star") {
    out.push({
      kind: "count",
      at: apply(box.m, { x: box.w / 2, y: Math.min(box.h / 2, inset * 1.6) }),
    });
  }
  if (node.type === "star") {
    const inner = starPoints(box.w, box.h, node.points, node.innerRatio)[1];
    if (inner) out.push({ kind: "ratio", at: apply(box.m, inner) });
  }
  const layout = autoLayoutOf(node);
  if (layout && node.type === "frame") {
    const [pt, pr, pb, pl] = layout.padding;
    const sides: [0 | 1 | 2 | 3, Point, Point][] = [
      [0, { x: pl, y: pt }, { x: box.w - pr, y: pt }],
      [1, { x: box.w - pr, y: pt }, { x: box.w - pr, y: box.h - pb }],
      [2, { x: pl, y: box.h - pb }, { x: box.w - pr, y: box.h - pb }],
      [3, { x: pl, y: pt }, { x: pl, y: box.h - pb }],
    ];
    for (const [side, a, b] of sides) {
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      // Keep the handle off the frame edge when the padding is zero.
      const at =
        side === 0
          ? { x: mid.x, y: Math.max(mid.y, inset) }
          : side === 1
            ? { x: Math.min(mid.x, box.w - inset), y: mid.y }
            : side === 2
              ? { x: mid.x, y: Math.min(mid.y, box.h - inset) }
              : { x: Math.max(mid.x, inset), y: mid.y };
      out.push({
        kind: "padding",
        side,
        at: apply(box.m, at),
        a: apply(box.m, a),
        b: apply(box.m, b),
      });
    }
    const gap = gapHandle(design, node, box);
    if (gap) out.push(gap);
  }
  return out;
}

/** Handle in the middle of the gap between the first two laid-out children (row / column layouts). */
function gapHandle(
  design: Design,
  frame: Node & { children?: Id[] },
  box: Obb,
): ShapeHandle | null {
  const layout = autoLayoutOf(frame);
  if (!layout || layout.mode === "grid" || layout.mainAlign === "space-between") return null;
  const kids = (frame.children ?? [])
    .map((id) => getNode(design, id))
    .filter((n): n is Node => !!n && n.visible);
  if (kids.length < 2) return null;
  const row = layout.mode === "row";
  const ordered = [...kids].sort((a, b) => (row ? a.x - b.x : a.y - b.y));
  const first = ordered[0] as Node;
  const second = ordered[1] as Node;
  const [pt, pr, pb, pl] = layout.padding;
  if (row) {
    const x0 = first.x + first.width;
    const x1 = second.x;
    const x = (x0 + x1) / 2;
    return {
      kind: "gap",
      at: apply(box.m, { x, y: box.h / 2 }),
      a: apply(box.m, { x, y: pt }),
      b: apply(box.m, { x, y: box.h - pb }),
    };
  }
  const y0 = first.y + first.height;
  const y1 = second.y;
  const y = (y0 + y1) / 2;
  return {
    kind: "gap",
    at: apply(box.m, { x: box.w / 2, y }),
    a: apply(box.m, { x: pl, y }),
    b: apply(box.m, { x: box.w - pr, y }),
  };
}

/** Handle under `p` (page coordinates) within `slop` screen px. */
export function hitShapeHandle(
  handles: readonly ShapeHandle[],
  p: Point,
  zoom: number,
  slop = 6,
): ShapeHandle | null {
  let best: { h: ShapeHandle; d: number } | null = null;
  for (const h of handles) {
    const d = dist(h.at, p) * zoom;
    if (d <= slop && (!best || d < best.d)) best = { h, d };
  }
  return best?.h ?? null;
}

/** Padding value for a pointer dragged in a frame's box (local distance from the side's edge). */
export function paddingFromPointer(box: Obb, side: 0 | 1 | 2 | 3, p: Point): number {
  const q = toLocal(box, p);
  const v = side === 0 ? q.y : side === 1 ? box.w - q.x : side === 2 ? box.h - q.y : q.x;
  const max = side === 0 || side === 2 ? box.h : box.w;
  return clamp(Math.round(v), 0, Math.max(0, Math.floor(max)));
}
