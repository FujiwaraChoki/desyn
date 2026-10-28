import { getNode } from "@desyn/doc-ops";
import type { SnapResult } from "@desyn/engine";
import type { Design, Id, Node, PageNode } from "@desyn/schema";
import { nodeObb } from "../geometry.ts";
import {
  EDGE_HANDLE_MIN,
  handlePoint,
  KNOB_RADIUS,
  rotateKnobPoint,
  screenSides,
} from "../handles.ts";
import { type Obb, obbCorners, obbRotation, type Point } from "../math.ts";
import { CORNERS, type HandleKind, polygonPoints, starPoints } from "../transform.ts";
import { fmtNum, type Painter } from "./paint.ts";

/** Outline of a node in its local box (the hover / selection silhouette). */
export function outlinePath(node: Node): Path2D | null {
  if (typeof Path2D === "undefined") return null;
  const path = new Path2D();
  const { width: w, height: h } = node;
  switch (node.type) {
    case "ellipse":
      path.ellipse(w / 2, h / 2, Math.max(w / 2, 0), Math.max(h / 2, 0), 0, 0, Math.PI * 2);
      return path;
    case "line":
      path.moveTo(0, h / 2);
      path.lineTo(w, h / 2);
      return path;
    case "polygon":
    case "star": {
      const pts =
        node.type === "polygon"
          ? polygonPoints(w, h, node.sides)
          : starPoints(w, h, node.points, node.innerRatio);
      pts.forEach((p, i) => {
        if (i === 0) path.moveTo(p.x, p.y);
        else path.lineTo(p.x, p.y);
      });
      path.closePath();
      return path;
    }
    case "path":
      for (const p of node.paths) {
        try {
          path.addPath(new Path2D(p.d));
        } catch {
          // Unparseable path data draws nothing (the box outline is used instead).
        }
      }
      return path;
    default:
      return null;
  }
}

/** Hover outline: the shape's silhouette (or its box). */
export function drawHover(p: Painter, design: Design, id: Id): void {
  const node = getNode(design, id);
  const box = nodeObb(design, id);
  if (!node || !box) return;
  const color = p.theme.selection;
  const shape = outlinePath(node);
  if (shape && node.type !== "line") {
    p.strokeLocalPath(shape, box.m, color, 1.5);
    return;
  }
  if (node.type === "line") {
    p.strokeLocalPath(shape ?? new Path2D(), box.m, color, 2);
    return;
  }
  p.strokeObb(box, color, 1.5);
}

export interface SelectionDrawOptions {
  handles: boolean;
  /** Draw the edge midpoint squares (box large enough on screen). */
  rotateHint?: boolean;
  activeHandle?: HandleKind | null;
}

/** Selection outlines: each node (multi-selections) plus the shared box and its handles. */
export function drawSelection(
  p: Painter,
  design: Design,
  ids: readonly Id[],
  box: Obb,
  opts: SelectionDrawOptions,
): void {
  const color = p.theme.selection;
  if (ids.length > 1) {
    for (const id of ids) {
      const b = nodeObb(design, id);
      if (b) p.strokeObb(b, color, 1);
    }
  }
  const single = ids.length === 1 ? getNode(design, ids[0] as Id) : undefined;
  if (single?.type === "line") {
    if (opts.handles) p.rotateKnob(rotateKnobPoint(box, p.zoom), KNOB_RADIUS);
    return;
  }
  p.strokeObb(box, color, 1.5);
  if (!opts.handles) return;
  const rot = obbRotation(box);
  const sides = screenSides(box, p.zoom);
  if (sides.w < 2 && sides.h < 2) return;
  if (sides.w >= EDGE_HANDLE_MIN) {
    for (const h of ["top", "bottom"] as const)
      p.squareHandle(handlePoint(box, h), rot, 7, opts.activeHandle === h);
  }
  if (sides.h >= EDGE_HANDLE_MIN) {
    for (const h of ["left", "right"] as const)
      p.squareHandle(handlePoint(box, h), rot, 7, opts.activeHandle === h);
  }
  for (const h of CORNERS) p.squareHandle(handlePoint(box, h), rot, 8, opts.activeHandle === h);
  p.rotateKnob(rotateKnobPoint(box, p.zoom), KNOB_RADIUS);
}

/** "W × H" pill centered under a box (axis of the box's bottom edge). */
export function drawSizeLabel(p: Painter, box: Obb, text?: string): void {
  const corners = obbCorners(box).map((c) => p.s(c));
  const maxY = Math.max(...corners.map((c) => c.y));
  const cx = corners.reduce((s, c) => s + c.x, 0) / 4;
  p.label(
    text ?? `${fmtNum(box.w)} × ${fmtNum(box.h)}`,
    { x: cx, y: maxY + 8 },
    { align: "below" },
  );
}

/** Snapping feedback: alignment lines with x marks, equal-spacing gaps and distance labels. */
export function drawSnap(p: Painter, snap: SnapResult): void {
  const color = p.theme.measure;
  for (const g of snap.guides) {
    const a = g.axis === "x" ? { x: g.pos, y: g.from } : { x: g.from, y: g.pos };
    const b = g.axis === "x" ? { x: g.pos, y: g.to } : { x: g.to, y: g.pos };
    p.line(a, b, color, 1);
    for (const end of [a, b]) cross(p, end, color);
  }
  for (const s of snap.spacing) {
    for (const [from, to, at] of s.segments) {
      const a = s.axis === "x" ? { x: from, y: at } : { x: at, y: from };
      const b = s.axis === "x" ? { x: to, y: at } : { x: at, y: to };
      p.line(a, b, color, 1);
      tick(p, a, s.axis, color);
      tick(p, b, s.axis, color);
      const m = p.s({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
      p.label(fmtNum(s.gap), m, { tone: "measure" });
    }
  }
  for (const d of snap.distances ?? []) {
    if (d.value < 0.5) continue;
    p.line(d.from, d.to, color, 1, [3, 3]);
    const a = p.s(d.from);
    const b = p.s(d.to);
    p.label(fmtNum(d.value), { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, { tone: "measure" });
  }
}

function cross(p: Painter, at: Point, color: string): void {
  const s = p.s(at);
  const c = p.ctx;
  c.beginPath();
  c.moveTo(s.x - 3, s.y - 3);
  c.lineTo(s.x + 3, s.y + 3);
  c.moveTo(s.x + 3, s.y - 3);
  c.lineTo(s.x - 3, s.y + 3);
  p.stroke(color, 1);
}

function tick(p: Painter, at: Point, axis: "x" | "y", color: string): void {
  const s = p.s(at);
  const c = p.ctx;
  c.beginPath();
  if (axis === "x") {
    c.moveTo(s.x, s.y - 4);
    c.lineTo(s.x, s.y + 4);
  } else {
    c.moveTo(s.x - 4, s.y);
    c.lineTo(s.x + 4, s.y);
  }
  p.stroke(color, 1);
}

/** Columns of the page's layout grid (and baseline rows) as tinted bands. */
export function drawLayoutGrid(p: Painter, page: PageNode): void {
  const grid = page.grid;
  if (!grid || grid.columns < 1) return;
  const { width: w, height: h } = page;
  const n = Math.max(1, Math.floor(grid.columns));
  const cw = (w - 2 * grid.margin - grid.gutter * (n - 1)) / n;
  if (cw > 0) {
    for (let i = 0; i < n; i++) {
      const x0 = grid.margin + i * (cw + grid.gutter);
      p.fillPolygon(
        [
          { x: x0, y: 0 },
          { x: x0 + cw, y: 0 },
          { x: x0 + cw, y: h },
          { x: x0, y: h },
        ],
        p.theme.grid,
      );
    }
  }
  if (grid.baseline && grid.baseline > 0 && grid.baseline * p.zoom >= 4) {
    const color = p.theme.dark ? "rgba(122, 184, 255, 0.16)" : "rgba(29, 95, 191, 0.14)";
    for (let y = grid.baseline; y < h; y += grid.baseline)
      p.line({ x: 0, y }, { x: w, y }, color, 1);
  }
}

/** Ruler guides of a page (full-length lines across the visible canvas). */
export function drawPageGuides(p: Painter, page: PageNode, active: number | null): void {
  const guides = page.guides ?? [];
  const v = p.view;
  const x0 = v.x;
  const y0 = v.y;
  const x1 = v.x + v.width / v.zoom;
  const y1 = v.y + v.height / v.zoom;
  guides.forEach((g, i) => {
    const color = p.theme.guide;
    const width = i === active ? 1.5 : 1;
    if (g.axis === "x") p.line({ x: g.pos, y: y0 }, { x: g.pos, y: y1 }, color, width);
    else p.line({ x: x0, y: g.pos }, { x: x1, y: g.pos }, color, width);
  });
}

/** Thin outline of a container that will receive dropped / moved layers. */
export function drawDropTarget(p: Painter, design: Design, id: Id): void {
  const box = nodeObb(design, id);
  if (!box) return;
  p.strokeObb(box, p.theme.selection, 2);
  const name = getNode(design, id)?.name ?? "";
  const tl = p.s(obbCorners(box)[0]);
  if (name) p.label(name, { x: tl.x, y: tl.y - 4 }, { align: "above", tone: "sun" });
}
