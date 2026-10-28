import {
  createEllipse,
  createFrame,
  createLine,
  createPolygon,
  createRect,
  createStar,
  defaultStroke,
  type Id,
  type Node,
  solid,
} from "@desyn/schema";
import type { CanvasController } from "../canvas/controller.ts";
import { backgroundAt, creationParent, inkFor, placeRect } from "../canvas/create.ts";
import { CURSORS } from "../canvas/cursors.ts";
import { constrainAngle, dist, obbFromRect, type Point, type Rect } from "../canvas/math.ts";
import { drawSizeLabel } from "../canvas/overlay/draw.ts";
import { fmtNum, type Painter } from "../canvas/overlay/paint.ts";
import { lineEndpointOps } from "../canvas/transform.ts";
import type { CanvasPointer, Gesture, Tool } from "./types.ts";

/**
 * Shape tools (frame, rectangle, ellipse, polygon, star, line, arrow): drag to draw (shift: square / circle,
 * or 45° for lines; alt: from the center), click for a default-size shape. The new layer goes into the frame
 * under the pointer, snaps its corner to objects and guides, and is drawn live by the engine.
 */

type BoxShape = "frame" | "rect" | "ellipse" | "polygon" | "star";
const DEFAULT_SIZE = 100;

function makeBoxNode(kind: BoxShape): Node {
  switch (kind) {
    case "frame":
      return createFrame({ name: "Frame" });
    case "rect":
      return createRect({ name: "Rectangle" });
    case "ellipse":
      return createEllipse({ name: "Ellipse" });
    case "polygon":
      return createPolygon({ name: "Polygon", sides: 3 });
    case "star":
      return createStar({ name: "Star" });
  }
}

async function snapCorner(c: CanvasController, p: Point, e: CanvasPointer): Promise<Point> {
  if (e.mod) {
    c.snap = null;
    return p;
  }
  const snap = await c.snapRect({
    ids: [],
    rect: { x: p.x, y: p.y, w: 0, h: 0 },
    distances: false,
  });
  c.snap = snap && (snap.dx || snap.dy) ? snap : null;
  return snap ? { x: p.x + snap.dx, y: p.y + snap.dy } : p;
}

/** Drag rectangle from the start point with shift (square) / alt (from center). */
export function dragRect(start: Point, p: Point, square: boolean, fromCenter: boolean): Rect {
  let dx = p.x - start.x;
  let dy = p.y - start.y;
  if (square) {
    const s = Math.max(Math.abs(dx), Math.abs(dy));
    dx = (dx < 0 ? -1 : 1) * s;
    dy = (dy < 0 ? -1 : 1) * s;
  }
  if (fromCenter)
    return {
      x: start.x - Math.abs(dx),
      y: start.y - Math.abs(dy),
      w: Math.abs(dx) * 2,
      h: Math.abs(dy) * 2,
    };
  return {
    x: Math.min(start.x, start.x + dx),
    y: Math.min(start.y, start.y + dy),
    w: Math.abs(dx),
    h: Math.abs(dy),
  };
}

class BoxShapeTool implements Tool {
  constructor(
    readonly id: BoxShape,
    private readonly label: string,
  ) {}

  cursor(): string {
    return CURSORS.crosshair;
  }

  async down(c: CanvasController, e: CanvasPointer): Promise<Gesture | null> {
    const design = c.design;
    const pageId = c.pageId;
    if (!design || !pageId || !c.canEdit) return null;
    const start = await snapCorner(c, e.page, e);
    const parent = creationParent(design, pageId, start);
    const node = makeBoxNode(this.id);
    let rect: Rect | null = null;
    let moved = false;
    const preview = () => {
      if (!rect) return;
      const place = placeRect(design, parent, rect);
      c.preview(
        [{ op: "create", nodes: [{ ...node, ...place } as Node], parent }],
        `Add ${this.label}`,
      );
    };
    let seq = 0;
    // Snap of the newest pointer move: awaited on release so a quick flick keeps its size.
    let pending: Promise<void> | null = null;
    return {
      cursor: CURSORS.crosshair,
      hidesHover: true,
      move: (ev) => {
        if (!moved && dist(ev.screen, e.screen) < 3) return;
        moved = true;
        c.hideSelection = true;
        const s = ++seq;
        pending = snapCorner(c, ev.page, ev).then((p) => {
          if (s !== seq) return;
          rect = dragRect(start, p, ev.shift, ev.alt);
          preview();
          c.invalidate();
        });
      },
      up: async () => {
        if (pending) await pending;
        seq++;
        c.snap = null;
        if (!moved || !rect || rect.w < 1 || rect.h < 1) {
          // A click places a default-size shape centered on the pointer.
          const size = DEFAULT_SIZE;
          rect = { x: start.x - size / 2, y: start.y - size / 2, w: size, h: size };
          await c.cancelPreview();
          const place = placeRect(design, parent, rect);
          await c.editor.apply([{ op: "create", nodes: [{ ...node, ...place } as Node], parent }], {
            label: `Add ${this.label}`,
            select: [node.id],
          });
        } else {
          await c.commit(`Add ${this.label}`, { select: [node.id] });
        }
        c.finishTool();
      },
      cancel: async () => {
        seq++;
        await c.cancelPreview();
      },
      draw: (p: Painter) => {
        if (rect) drawSizeLabel(p, obbFromRect(rect));
      },
    };
  }
}

class LineTool implements Tool {
  constructor(
    readonly id: "line" | "arrow",
    private readonly label: string,
  ) {}

  cursor(): string {
    return CURSORS.crosshair;
  }

  async down(c: CanvasController, e: CanvasPointer): Promise<Gesture | null> {
    const design = c.design;
    const pageId = c.pageId;
    if (!design || !pageId || !c.canEdit) return null;
    const start = await snapCorner(c, e.page, e);
    const parent = creationParent(design, pageId, start);
    const ink = inkFor(backgroundAt(design, parent));
    const node = createLine({
      name: this.label,
      strokes: [defaultStroke({ width: 2, fills: [solid(ink)], cap: "round" })],
      endCap: this.id === "arrow" ? "arrow" : "none",
    });
    let end: Point | null = null;
    let moved = false;
    let seq = 0;
    let pending: Promise<void> | null = null;
    const ops = (a: Point, b: Point) => {
      // Create a placeholder, then let the endpoint writer place it in the parent's coordinates.
      const base = {
        ...design,
        nodes: { ...design.nodes, [node.id]: { ...node, parent } as Node },
      };
      const parentNode = base.nodes[parent] as Node & { children: Id[] };
      base.nodes[parent] = { ...parentNode, children: [...parentNode.children, node.id] } as Node;
      const placed = lineEndpointOps(base, node.id, a, b);
      const set: Record<string, unknown> = {};
      for (const op of placed)
        if (op.op === "update" && op.id === node.id) Object.assign(set, op.set);
      return [{ op: "create" as const, nodes: [{ ...node, ...set } as Node], parent }];
    };
    return {
      cursor: CURSORS.crosshair,
      hidesHover: true,
      move: (ev) => {
        if (!moved && dist(ev.screen, e.screen) < 3) return;
        moved = true;
        c.hideSelection = true;
        const s = ++seq;
        const raw = ev.shift ? constrainAngle(start, ev.page, 45) : ev.page;
        const done = (p: Point) => {
          if (s !== seq) return;
          end = p;
          c.preview(ops(start, p), `Add ${this.label}`);
          c.invalidate();
        };
        if (ev.shift) done(raw);
        else pending = snapCorner(c, raw, ev).then(done);
      },
      up: async () => {
        if (pending) await pending;
        seq++;
        c.snap = null;
        if (!moved || !end || dist(start, end) * c.zoom < 2) {
          await c.cancelPreview();
          await c.editor.apply(ops(start, { x: start.x + 100, y: start.y }), {
            label: `Add ${this.label}`,
            select: [node.id],
          });
        } else {
          await c.commit(`Add ${this.label}`, { select: [node.id] });
        }
        c.finishTool();
      },
      cancel: async () => {
        seq++;
        await c.cancelPreview();
      },
      draw: (p: Painter) => {
        if (!end) return;
        const len = dist(start, end);
        const angle = (Math.atan2(end.y - start.y, end.x - start.x) * 180) / Math.PI;
        const s = p.s(end);
        p.label(`${fmtNum(len)} · ${fmtNum(-angle)}°`, { x: s.x, y: s.y + 16 }, { align: "below" });
      },
    };
  }
}

export const shapeTools: Tool[] = [
  new BoxShapeTool("frame", "frame"),
  new BoxShapeTool("rect", "rectangle"),
  new BoxShapeTool("ellipse", "ellipse"),
  new BoxShapeTool("polygon", "polygon"),
  new BoxShapeTool("star", "star"),
  new LineTool("line", "Line"),
  new LineTool("arrow", "Arrow"),
];
