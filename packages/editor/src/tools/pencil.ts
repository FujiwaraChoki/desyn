import { createPath, defaultStroke, solid } from "@desyn/schema";
import type { CanvasController } from "../canvas/controller.ts";
import { backgroundAt, createPathOps, creationParent, inkFor } from "../canvas/create.ts";
import { CURSORS } from "../canvas/cursors.ts";
import type { Point } from "../canvas/math.ts";
import type { Painter } from "../canvas/overlay/paint.ts";
import { fitCurve, smooth } from "./curve-fit.ts";
import type { Anchor, SubPath } from "./path-model.ts";
import type { CanvasPointer, Gesture, Tool } from "./types.ts";

/**
 * Pencil: freehand strokes. The raw stroke is drawn live on the overlay; on release the points are smoothed and
 * fitted with cubic Béziers (error ~2 screen px) into a path layer with a round 3 px (on screen) stroke. A stroke
 * that ends near its start closes.
 */

/** Fit tolerance in screen px. */
const FIT_ERROR = 2;
const CLOSE_DISTANCE = 10;

/** Turns a raw stroke (page coordinates) into a smooth subpath. */
export function strokeToSubPath(points: readonly Point[], zoom: number): SubPath | null {
  const z = Math.max(zoom, 1e-3);
  if (points.length < 2) return null;
  const smoothed = smooth(points, 2);
  const curves = fitCurve(smoothed, FIT_ERROR / z);
  if (curves.length === 0) return null;
  const anchors: Anchor[] = [];
  curves.forEach(([p0, c1, c2, p3], i) => {
    if (i === 0) anchors.push({ x: p0.x, y: p0.y, in: null, out: { ...c1 } });
    else (anchors[anchors.length - 1] as Anchor).out = { ...c1 };
    anchors.push({ x: p3.x, y: p3.y, in: { ...c2 }, out: null });
  });
  const first = points[0] as Point;
  const last = points[points.length - 1] as Point;
  const closed =
    anchors.length > 2 && Math.hypot(first.x - last.x, first.y - last.y) * z <= CLOSE_DISTANCE;
  if (closed) {
    const end = anchors.pop() as Anchor;
    (anchors[0] as Anchor).in = end.in;
  }
  return { anchors, closed };
}

export const pencilTool: Tool = {
  id: "pencil",

  cursor(): string {
    return CURSORS.pencil;
  },

  down(c: CanvasController, e: CanvasPointer): Gesture | null {
    const design = c.design;
    const pageId = c.pageId;
    if (!design || !pageId || !c.canEdit) return null;
    const points: Point[] = [e.page];
    const parent = creationParent(design, pageId, e.page);
    const ink = inkFor(backgroundAt(design, parent));
    const width = Math.max(0.5, Math.round((3 / c.zoom) * 100) / 100);
    return {
      cursor: CURSORS.pencil,
      hidesHover: true,
      move: (ev) => {
        points.push(ev.page);
        c.hideSelection = true;
        c.invalidate();
      },
      up: async () => {
        const sp = strokeToSubPath(points, c.zoom);
        if (!sp) return;
        const node = createPath({
          name: "Drawing",
          fills: [],
          strokes: [defaultStroke({ width, fills: [solid(ink)], cap: "round", join: "round" })],
        });
        const current = c.design;
        if (!current) return;
        await c.editor.apply(createPathOps(current, parent, [sp], node), {
          label: "Draw",
          select: [node.id],
        });
      },
      cancel: () => {
        points.length = 0;
      },
      draw: (p: Painter) => {
        if (points.length < 2) return;
        const ctx = p.ctx;
        ctx.beginPath();
        points.forEach((q, i) => {
          const s = p.s(q);
          if (i === 0) ctx.moveTo(s.x, s.y);
          else ctx.lineTo(s.x, s.y);
        });
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        p.stroke(ink, Math.max(1, width * c.zoom));
      },
    };
  },
};
