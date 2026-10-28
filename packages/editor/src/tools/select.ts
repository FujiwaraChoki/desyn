import { getNode } from "@desyn/doc-ops";
import type { Id } from "@desyn/schema";
import type { CanvasController } from "../canvas/controller.ts";
import { startCrop } from "../canvas/crop.ts";
import { resizeCursor, rotateCursor } from "../canvas/cursors.ts";
import { isInteractive, isSelfOrDescendant, nodeAabb } from "../canvas/geometry.ts";
import { MarqueeGesture } from "../canvas/gestures/marquee.ts";
import { MoveGesture } from "../canvas/gestures/move.ts";
import { ShapeHandleGesture } from "../canvas/gestures/shape.ts";
import { ResizeGesture, RotateGesture } from "../canvas/gestures/transform.ts";
import { handleDirection, hitHandles, hitRotateKnob } from "../canvas/handles.ts";
import { obbContains, type Rect } from "../canvas/math.ts";
import { measureBetween } from "../canvas/measure.ts";
import { fmtNum, type Painter } from "../canvas/overlay/paint.ts";
import {
  enterTarget,
  isEnterable,
  layersAt,
  levelContainer,
  pickTarget,
  selectThrough,
} from "../canvas/selection.ts";
import { hitShapeHandle, type ShapeHandle, shapeHandles } from "../canvas/shape-handles.ts";
import { startTextEditing } from "../canvas/text/text-mode.ts";
import { startPathEditing } from "./pen.ts";
import { addTextInto, hostsText, isTextBox, textChildOf } from "./text.ts";
import type { CanvasPointer, Gesture, Tool } from "./types.ts";

/**
 * The select tool: click / shift / deep (⌘/Ctrl) selection, select-through (alt+click), double click to enter
 * groups and frames or to edit text / paths / image crops, marquee, move (with snapping, alt-duplicate,
 * reparenting and auto-layout reordering), resize, rotate and the shape parameter handles. Alt shows smart
 * measurements to the hovered layer.
 */

function editableSelection(c: CanvasController): Id[] {
  const design = c.design;
  if (!design || !c.canEdit) return [];
  return c.selectedIds().filter((id) => !design.nodes[id]?.locked);
}

function singleShapeHandles(c: CanvasController): { id: Id; handles: ShapeHandle[] } | null {
  const ids = editableSelection(c);
  const design = c.design;
  if (ids.length !== 1 || !design) return null;
  const id = ids[0] as Id;
  return { id, handles: shapeHandles(design, id, c.zoom) };
}

export const selectTool: Tool = {
  id: "select",

  async down(c: CanvasController, e: CanvasPointer): Promise<Gesture | null> {
    const design = c.design;
    if (!design) return null;
    const editable = editableSelection(c);
    const sel = c.selection();
    if (editable.length > 0 && sel && !e.mod) {
      const k = e.pointerType === "touch" ? 2 : 1;
      const shape = singleShapeHandles(c);
      const isLine = shape && design.nodes[shape.id]?.type === "line";
      if (shape && isLine) {
        const h = hitShapeHandle(shape.handles, e.page, c.zoom, 7 * k);
        if (h) return new ShapeHandleGesture(c, shape.id, h, e);
        if (hitRotateKnob(sel.obb, c.zoom, e.page, k)) {
          return new RotateGesture(c, editable, sel.obb, "bottom", e);
        }
      }
      if (!isLine) {
        const corner = hitHandles(sel.obb, c.zoom, e.page, { allowRotate: false, scale: k });
        if (corner?.type === "resize" && corner.handle.includes("-")) {
          return new ResizeGesture(c, editable, sel.obb, corner.handle);
        }
        if (shape) {
          const h = hitShapeHandle(shape.handles, e.page, c.zoom, 6 * k);
          if (h) return new ShapeHandleGesture(c, shape.id, h, e);
        }
        const hit = hitHandles(sel.obb, c.zoom, e.page, { scale: k });
        if (hit?.type === "resize") return new ResizeGesture(c, editable, sel.obb, hit.handle);
        if (hit?.type === "rotate") return new RotateGesture(c, editable, sel.obb, hit.handle, e);
      }
    }
    const path = await c.hitPath(e.screen);
    const state = c.state;
    let target = pickTarget(design, path, state, { deep: e.mod });
    // Leaving an entered container by clicking outside it.
    if (state.scopeId && (!target || !isSelfOrDescendant(design, state.scopeId, target))) {
      c.editor.store.setState({ scopeId: null });
      target = pickTarget(design, path, { scopeId: null, selection: [] }, { deep: e.mod });
    }
    const selection = state.selection;
    if (!target) {
      // Dragging inside the selection's box moves it (even over empty space between layers).
      if (sel && editable.length > 0 && !e.shift && obbContains(sel.obb, e.page)) {
        return new MoveGesture(c, { ids: editable, start: e, clickSelect: [] });
      }
      if (!e.shift) c.editor.clearSelection();
      return new MarqueeGesture(c, e.page, e.shift ? selection : []);
    }
    if (e.shift) {
      const wasSelected = selection.includes(target);
      c.editor.toggleSelection([target]);
      if (wasSelected) return null;
    } else if (!selection.includes(target)) {
      c.editor.select([target]);
    }
    if (!c.canEdit) return null;
    const ids = editableSelection(c);
    if (ids.length === 0) return null;
    const multi = selection.length > 1 && selection.includes(target) && !e.shift;
    const onClick = e.alt
      ? () => {
          const d = c.design;
          const pageId = c.pageId;
          if (!d || !pageId) return;
          const container = levelContainer(d, pageId, {
            scopeId: c.state.scopeId,
            selection: [target as Id],
          });
          const stack = layersAt(d, container, e.page, 2 / c.zoom);
          // Each alt+click goes one layer further down from the layer selected before the press (the press
          // itself selected the topmost one); wraps around at the bottom.
          const from = selection.find((id) => stack.includes(id));
          const next = from ? selectThrough(stack, from) : (target as Id);
          if (next) c.editor.select([next]);
        }
      : undefined;
    return new MoveGesture(c, {
      ids,
      start: e,
      clickSelect: multi ? [target] : null,
      ...(onClick ? { onClick } : {}),
    });
  },

  hover(c: CanvasController, e: CanvasPointer): void {
    const design = c.design;
    if (!design) return;
    c.hoverPick(e, (path) => pickTarget(design, path, c.state, { deep: e.mod }));
    // Parameter handles appear while the pointer is over the selected layer.
    if (singleShapeHandles(c)) c.invalidate();
  },

  async doubleClick(c: CanvasController, e: CanvasPointer): Promise<void> {
    const design = c.design;
    if (!design) return;
    const path = await c.hitPath(e.screen);
    const state = c.state;
    const target = pickTarget(design, path, state, { deep: e.mod });
    if (!target) return;
    const node = getNode(design, target);
    if (!node) return;
    if (isEnterable(node)) {
      const child = enterTarget(design, path, target);
      // A text container (a shape holding text) edits its text wherever it is double clicked.
      const boxText = isTextBox(node) ? textChildOf(design, target) : null;
      const reached = boxText ?? child;
      if (reached) {
        c.editor.store.setState({ scopeId: target });
        c.editor.select([reached]);
        // A text inside a group opens right away on the double click that reached it.
        if (
          c.canEdit &&
          getNode(design, reached)?.type === "text" &&
          isInteractive(design, reached)
        ) {
          await startTextEditing(c, reached, boxText ? { select: "end" } : { at: e.screen });
        }
        return;
      }
    }
    if (!c.canEdit) {
      c.editor.select([target]);
      return;
    }
    c.editor.select([target]);
    if (node.type === "text") {
      await startTextEditing(c, target, { at: e.screen });
      return;
    }
    if (node.type === "path") {
      await startPathEditing(c, target);
      return;
    }
    if (node.type === "image") {
      await startCrop(c, target);
      return;
    }
    // Shapes and frames (with nothing hit inside them) take text on a double click.
    if (hostsText(node)) await addTextInto(c, target);
  },

  keyDown(c: CanvasController, e: KeyboardEvent): boolean {
    if (e.key !== "Enter" || e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return false;
    const ids = editableSelection(c);
    const design = c.design;
    if (ids.length !== 1 || !design) return false;
    const node = design.nodes[ids[0] as Id];
    if (node?.type === "path") {
      void startPathEditing(c, node.id);
      return true;
    }
    if (node?.type === "image") {
      void startCrop(c, node.id);
      return true;
    }
    if (node?.type === "text") {
      void startTextEditing(c, node.id, { select: "all" });
      return true;
    }
    return false;
  },

  cursor(c: CanvasController): string {
    const e = c.lastPointer;
    const sel = c.selection();
    if (!e || !sel || editableSelection(c).length === 0) return "default";
    const shape = singleShapeHandles(c);
    if (shape) {
      const h = hitShapeHandle(shape.handles, e.page, c.zoom);
      if (h) return h.kind === "count" ? "ns-resize" : "pointer";
    }
    if (shape && c.design?.nodes[shape.id]?.type === "line") {
      return hitRotateKnob(sel.obb, c.zoom, e.page)
        ? rotateCursor(handleDirection(sel.obb, "bottom"))
        : "default";
    }
    const hit = hitHandles(sel.obb, c.zoom, e.page);
    if (hit?.type === "resize") return resizeCursor(handleDirection(sel.obb, hit.handle));
    if (hit?.type === "rotate") return rotateCursor(handleDirection(sel.obb, hit.handle));
    return "default";
  },

  draw(c: CanvasController, p: Painter): void {
    if (c.gesture || c.mode) return;
    const shape = singleShapeHandles(c);
    if (shape) drawShapeHandles(c, p, shape.handles);
    if (c.altDown) drawMeasurements(c, p);
  },
};

function drawShapeHandles(c: CanvasController, p: Painter, handles: ShapeHandle[]): void {
  const pointer = c.lastPointer?.page;
  const hovered = pointer ? hitShapeHandle(handles, pointer, c.zoom) : null;
  const box = c.selection()?.obb;
  // Line endpoints always show; the other parameter handles only while the pointer is over the layer, so a
  // plain selection stays calm.
  const over = !!pointer && !!box && obbContains(box, pointer, 8 / c.zoom);
  for (const h of handles) {
    if (!over && h.kind !== "line-start" && h.kind !== "line-end") continue;
    const active = h === hovered;
    switch (h.kind) {
      case "line-start":
      case "line-end":
        p.roundHandle(h.at, { r: 5, active });
        break;
      case "radius":
        p.roundHandle(h.at, { r: 3.75, active });
        break;
      case "count":
      case "ratio":
        p.diamondHandle(h.at, { active });
        break;
      case "padding": {
        if (active) {
          p.line(h.a, h.b, p.theme.measure, 1, [3, 3]);
        }
        const s = p.s(h.at);
        const ctx = p.ctx;
        const vertical = h.side === 1 || h.side === 3;
        ctx.beginPath();
        ctx.roundRect(
          s.x - (vertical ? 2 : 7),
          s.y - (vertical ? 7 : 2),
          vertical ? 4 : 14,
          vertical ? 14 : 4,
          2,
        );
        ctx.fillStyle = active ? p.theme.selection : "#ffffff";
        ctx.fill();
        ctx.strokeStyle = p.theme.selection;
        ctx.lineWidth = 1;
        ctx.stroke();
        break;
      }
      case "gap": {
        if (active) p.line(h.a, h.b, p.theme.measure, 1, [3, 3]);
        p.diamondHandle(h.at, { active, size: 8 });
        break;
      }
    }
  }
}

/** Alt + hover: distances from the selection to the hovered layer (or its container / the page). */
function drawMeasurements(c: CanvasController, p: Painter): void {
  const design = c.design;
  const page = c.page;
  const ids = c.selectedIds();
  if (!design || !page || ids.length === 0) return;
  const sel = c.selection();
  if (!sel) return;
  const hover = c.state.hover;
  let other: Rect | null = null;
  if (hover && !ids.some((id) => isSelfOrDescendant(design, id, hover)))
    other = nodeAabb(design, hover);
  if (!other) {
    const parent = getNode(design, ids[0] as Id)?.parent;
    other =
      parent && parent !== page.id
        ? nodeAabb(design, parent)
        : { x: 0, y: 0, w: page.width, h: page.height };
  }
  if (!other) return;
  if (hover) {
    const box = nodeAabb(design, hover);
    if (box) {
      p.polygon([
        { x: box.x, y: box.y },
        { x: box.x + box.w, y: box.y },
        { x: box.x + box.w, y: box.y + box.h },
        { x: box.x, y: box.y + box.h },
      ]);
      p.stroke(p.theme.measure, 1);
    }
  }
  for (const m of measureBetween(sel.aabb, other)) {
    for (const [a, b] of m.guides) p.line(a, b, p.theme.measure, 1, [3, 3]);
    p.line(m.a, m.b, p.theme.measure, 1);
    const a = p.s(m.a);
    const b = p.s(m.b);
    p.label(fmtNum(m.value), { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, { tone: "measure" });
  }
}
