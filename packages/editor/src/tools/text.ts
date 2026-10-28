import { getNode } from "@desyn/doc-ops";
import {
  createFrame,
  createText,
  type Design,
  defaultTextStyle,
  type FrameNode,
  type Id,
  type Node,
  newId,
  type Op,
  solid,
} from "@desyn/schema";
import type { CanvasController } from "../canvas/controller.ts";
import { backgroundAt, creationParent, inkFor, placeRect } from "../canvas/create.ts";
import { CURSORS } from "../canvas/cursors.ts";
import { isInteractive } from "../canvas/geometry.ts";
import { clamp, dist, obbFromRect, type Rect, rectFromPoints } from "../canvas/math.ts";
import { drawSizeLabel } from "../canvas/overlay/draw.ts";
import type { Painter } from "../canvas/overlay/paint.ts";
import { startTextEditing } from "../canvas/text/text-mode.ts";
import type { CanvasPointer, Gesture, Tool } from "./types.ts";

/**
 * Text tool: click to type a line that grows with its text, drag to type in a fixed-width box (height follows
 * the text). Clicking an existing text layer edits it. The size scales with the page so a first heading reads
 * well on a poster and on a business card alike.
 */

/**
 * Default font size for a page: about 1/18 of its short side (60 px on a 1080 px post), between 16 and 120 px,
 * the same rule as pasted text.
 */
export function defaultFontSize(pageWidth: number, pageHeight: number): number {
  return clamp(Math.round(Math.min(pageWidth, pageHeight) / 18), 16, 120);
}

export const textTool: Tool = {
  id: "text",

  cursor(): string {
    return CURSORS.text;
  },

  async down(c: CanvasController, e: CanvasPointer): Promise<Gesture | null> {
    const design = c.design;
    const pageId = c.pageId;
    const page = c.page;
    if (!design || !pageId || !page || !c.canEdit) return null;
    if (!c.client?.hasDesign) {
      // Typing needs the engine's text layout.
      c.editor.notify({
        kind: "info",
        title: "The canvas is still starting",
        description: "Try again in a moment.",
      });
      return null;
    }
    // Editing an existing text layer.
    const path = await c.hitPath(e.screen);
    const hitText = [...path].reverse().find((id) => getNode(design, id)?.type === "text");
    if (hitText && isInteractive(design, hitText)) {
      c.editor.select([hitText]);
      await startTextEditing(c, hitText, { at: e.screen });
      c.finishTool();
      return null;
    }
    const start = e.page;
    let rect: Rect | null = null;
    return {
      cursor: CURSORS.text,
      hidesHover: true,
      move: (ev) => {
        if (dist(ev.screen, e.screen) < 4) return;
        rect = rectFromPoints(start, ev.page);
        c.hideSelection = true;
        c.invalidate();
      },
      up: async () => {
        const parent = creationParent(design, pageId, start);
        const fontSize = defaultFontSize(page.width, page.height);
        const ink = inkFor(backgroundAt(design, parent));
        const style = defaultTextStyle({ fontSize, fills: [solid(ink)] });
        const lineHeight = Math.round(fontSize * 1.2);
        const box: Rect =
          rect && rect.w * c.zoom >= 8
            ? { x: rect.x, y: rect.y, w: rect.w, h: Math.max(rect.h, lineHeight) }
            : { x: start.x, y: start.y - lineHeight / 2, w: 0, h: lineHeight };
        const node = createText({
          name: "Text",
          style,
          runs: [],
          autoResize: rect && rect.w * c.zoom >= 8 ? "height" : "width",
        });
        const place = placeRect(design, parent, box);
        const created = { ...node, ...place } as Node;
        await c.editor.apply([{ op: "create", nodes: [created], parent }], {
          label: "Add text",
          select: [node.id as Id],
        });
        c.finishTool();
        await startTextEditing(c, node.id, { select: "end", created: true });
      },
      cancel: () => {
        rect = null;
      },
      draw: (p: Painter) => {
        if (!rect) return;
        p.strokeObb(obbFromRect(rect), p.theme.selection, 1, [4, 3]);
        drawSizeLabel(p, obbFromRect(rect), `${Math.round(rect.w)} wide`);
      },
    };
  },
};

/** Layers that take text on a double click: shapes become text containers, frames get a text child. */
const TEXT_HOSTS = new Set(["rect", "ellipse", "polygon", "star", "frame"]);

export function hostsText(node: Node | undefined): boolean {
  return !!node && TEXT_HOSTS.has(node.type);
}

/** Frames created around a shape to hold its text carry this flag (`meta.textBox`). */
export function isTextBox(node: Node | undefined): boolean {
  return (
    node?.type === "frame" && (node.meta as { textBox?: unknown } | undefined)?.textBox === true
  );
}

/** The text child a text container shows, if any (its top-most text layer). */
export function textChildOf(design: Design, id: Id): Id | null {
  const node = getNode(design, id);
  if (!node || !("children" in node)) return null;
  for (let i = node.children.length - 1; i >= 0; i--) {
    const child = getNode(design, node.children[i] as Id);
    if (child?.type === "text") return child.id;
  }
  return null;
}

const STRETCH = { h: "stretch", v: "stretch" } as const;

/**
 * Text inside a shape or frame, like Canva: the text belongs to the element, moves and resizes with it and
 * re-wraps when it is resized.
 * - A rectangle becomes a frame with the same paint, corners, effects and name, holding a text child.
 * - An ellipse, polygon or star is wrapped in a transparent frame: the shape stretches to fill it (the
 *   background) and the text sits on top.
 * - A frame gets a text child (filling it in auto-layout frames, stretching with it otherwise).
 * Text is centered both ways, padded, in an ink that reads on the fill and the design's body face.
 * Returns the ops (one undoable step) and the new text layer's id; null for other layers.
 */
export function textIntoOps(
  design: Design,
  id: Id,
  page: { width: number; height: number },
  newId: () => Id,
): { ops: Op[]; textId: Id; containerId: Id } | null {
  const host = getNode(design, id);
  if (!host || !hostsText(host)) return null;
  const parent = host.parent;
  if (!parent) return null;
  const ink = inkFor(backgroundAt(design, host.id));
  const pad = Math.min(host.width, host.height) * 0.08;
  const fontSize = clamp(
    Math.min(defaultFontSize(page.width, page.height), Math.round(host.height * 0.35)),
    10,
    120,
  );
  // The design's own body face (templates and brand kits name it "Body"), so new text matches the design.
  const body = Object.values(design.styles.text).find((t) => t.name === "Body")?.style;
  const text = createText({
    id: newId(),
    name: "Text",
    style: defaultTextStyle({
      fontSize,
      fills: [solid(ink)],
      ...(body ? { fontFamily: body.fontFamily, fontWeight: body.fontWeight } : {}),
    }),
    runs: [],
    autoResize: "none",
    verticalAlign: "middle",
  });
  text.paragraph = { ...text.paragraph, align: "center" };
  const inside = (w: number, h: number, layout: boolean): Node =>
    ({
      ...text,
      x: pad,
      y: pad,
      width: Math.max(1, w - pad * 2),
      height: Math.max(1, h - pad * 2),
      rotation: 0,
      ...(layout ? { sizing: { h: "fill", v: "fill" } } : { constraints: STRETCH }),
    }) as Node;

  if (host.type === "frame") {
    const layout = "layout" in host && !!host.layout;
    const node = inside(host.width, host.height, layout);
    return {
      ops: [{ op: "create", nodes: [node], parent: host.id, index: host.children.length }],
      textId: node.id,
      containerId: host.id,
    };
  }

  const parentNode = getNode(design, parent);
  const siblings = parentNode && "children" in parentNode ? parentNode.children : [];
  const index = Math.max(0, siblings.indexOf(host.id));
  const frameId = newId();
  const node = inside(host.width, host.height, false);
  const { id: _id, type: _type, parent: _parent, ...base } = host as Node & Record<string, unknown>;
  void _id;
  void _type;
  void _parent;
  if (host.type === "rect") {
    // The rectangle itself becomes the container: same box, paint, corners, effects, role and name.
    const frame = createFrame({
      ...(base as Partial<FrameNode>),
      id: frameId,
      children: [],
      clip: false,
      meta: { ...(host.meta ?? {}), textBox: true },
    });
    return {
      ops: [
        { op: "delete", id: host.id },
        { op: "create", nodes: [frame], parent, index },
        { op: "create", nodes: [node], parent: frameId, index: 0 },
      ],
      textId: node.id,
      containerId: frameId,
    };
  }
  // Other shapes keep their geometry inside a transparent frame that holds the text.
  const frame = createFrame({
    id: frameId,
    name: host.name,
    x: host.x,
    y: host.y,
    width: host.width,
    height: host.height,
    rotation: host.rotation,
    fills: [],
    strokes: [],
    children: [],
    clip: false,
    ...(host.role ? { role: host.role } : {}),
    meta: { textBox: true },
  });
  return {
    ops: [
      { op: "create", nodes: [frame], parent, index },
      { op: "move", id: host.id, parent: frameId, index: 0 },
      {
        op: "update",
        id: host.id,
        set: { x: 0, y: 0, rotation: 0, constraints: STRETCH },
        unset: ["role"],
      },
      { op: "create", nodes: [node], parent: frameId, index: 1 },
    ],
    textId: node.id,
    containerId: frameId,
  };
}

/**
 * Double click on a shape or frame: types text inside it (see `textIntoOps`). Leaving it empty undoes the whole
 * step (the shape goes back to how it was), so an accidental double click changes nothing.
 */
export async function addTextInto(c: CanvasController, id: Id): Promise<boolean> {
  const design = c.design;
  const page = c.page;
  if (!design || !page || !c.canEdit || !c.client?.hasDesign) return false;
  const made = textIntoOps(design, id, page, () => newId());
  if (!made) return false;
  await c.editor.apply(made.ops, { label: "Add text", select: [made.textId] });
  return startTextEditing(c, made.textId, { select: "end", created: true });
}
