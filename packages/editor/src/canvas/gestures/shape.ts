import { getNode } from "@desyn/doc-ops";
import type { Design, Id, Op } from "@desyn/schema";
import type { CanvasPointer, Gesture } from "../../tools/types.ts";
import type { CanvasController } from "../controller.ts";
import { autoLayoutOf, nodeObb } from "../geometry.ts";
import { clamp, constrainAngle, dist, type Obb, type Point, toLocal } from "../math.ts";
import { fmtNum, type Painter } from "../overlay/paint.ts";
import { cornerIndex, paddingFromPointer, type ShapeHandle } from "../shape-handles.ts";
import { lineEndpointOps, lineEndpoints, radiusFromPointer } from "../transform.ts";

/**
 * Gestures on a layer's own parameter handles: line endpoints (shift: 45° steps, snapping to objects), corner
 * radius (alt: one corner), polygon / star point count, star inner ratio, auto-layout padding (alt: opposite
 * side too, shift: all sides) and gap.
 */
export class ShapeHandleGesture implements Gesture {
  cursor = "default";
  private readonly design: Design;
  private readonly box: Obb;
  private label = "";
  private labelText = "";
  private labelAt: Point | null = null;
  private moved = false;
  private seq = 0;
  private done = false;
  /** Line endpoint snap of the newest pointer move (awaited on release). */
  private pending: Promise<void> | null = null;

  constructor(
    private readonly c: CanvasController,
    private readonly id: Id,
    private readonly handle: ShapeHandle,
    private readonly start: CanvasPointer,
  ) {
    this.design = c.design as Design;
    this.box = nodeObb(this.design, id) as Obb;
    this.cursor =
      handle.kind === "count"
        ? "ns-resize"
        : handle.kind === "gap" || handle.kind === "padding"
          ? "move"
          : "default";
  }

  move(e: CanvasPointer): void {
    if (this.done) return;
    if (!this.moved && dist(e.screen, this.start.screen) < 2) return;
    this.moved = true;
    const h = this.handle;
    const node = getNode(this.design, this.id);
    if (!node) return;
    switch (h.kind) {
      case "line-start":
      case "line-end": {
        this.pending = this.moveLineEnd(e, h.kind);
        return;
      }
      case "radius": {
        if (!("cornerRadius" in node)) return;
        const r = Math.round(
          radiusFromPointer(this.box.w, this.box.h, h.corner, toLocal(this.box, e.page)),
        );
        const current = node.cornerRadius;
        let value: number | [number, number, number, number];
        if (e.alt) {
          const arr: [number, number, number, number] =
            typeof current === "number" ? [current, current, current, current] : [...current];
          arr[cornerIndex(h.corner)] = r;
          value = arr;
        } else {
          value = r;
        }
        this.preview(
          [{ op: "update", id: this.id, set: { cornerRadius: value } }],
          "Corner radius",
        );
        this.setLabel(`Radius ${fmtNum(r)}`, e.screen);
        return;
      }
      case "count": {
        if (node.type !== "polygon" && node.type !== "star") return;
        const startCount = node.type === "polygon" ? node.sides : node.points;
        const steps = Math.round((this.start.screen.y - e.screen.y) / 12);
        const count = clamp(startCount + steps, 3, 60);
        const key = node.type === "polygon" ? "sides" : "points";
        this.preview(
          [{ op: "update", id: this.id, set: { [key]: count } }],
          node.type === "polygon" ? "Sides" : "Points",
        );
        this.setLabel(`${count} ${node.type === "polygon" ? "sides" : "points"}`, e.screen);
        return;
      }
      case "ratio": {
        if (node.type !== "star") return;
        const q = toLocal(this.box, e.page);
        const cx = this.box.w / 2;
        const cy = this.box.h / 2;
        const rx = Math.max(cx, 1e-6);
        const ry = Math.max(cy, 1e-6);
        // Normalized radial distance in the ellipse fitted to the box.
        const ratio = clamp(Math.hypot((q.x - cx) / rx, (q.y - cy) / ry), 0.05, 1);
        const value = Math.round(ratio * 1000) / 1000;
        this.preview([{ op: "update", id: this.id, set: { innerRatio: value } }], "Star ratio");
        this.setLabel(`Ratio ${Math.round(value * 100)}%`, e.screen);
        return;
      }
      case "padding": {
        const layout = autoLayoutOf(node);
        if (!layout) return;
        const v = paddingFromPointer(this.box, h.side, e.page);
        const padding: [number, number, number, number] = [...layout.padding];
        if (e.shift) padding.fill(v);
        else {
          padding[h.side] = v;
          if (e.alt) padding[(h.side + 2) % 4] = v;
        }
        this.preview(
          [{ op: "patch", id: this.id, path: ["layout", "padding"], value: padding }],
          "Padding",
        );
        this.setLabel(`Padding ${fmtNum(v)}`, e.screen);
        return;
      }
      case "gap": {
        const layout = autoLayoutOf(node);
        if (!layout) return;
        const row = layout.mode === "row";
        const q0 = toLocal(this.box, this.start.page);
        const q = toLocal(this.box, e.page);
        // The handle sits in the middle of the gap: moving it by d widens the gap by 2d.
        const d = row ? q.x - q0.x : q.y - q0.y;
        const gap = Math.max(0, Math.round(layout.gap + d * 2));
        this.preview([{ op: "patch", id: this.id, path: ["layout", "gap"], value: gap }], "Gap");
        this.setLabel(`Gap ${fmtNum(gap)}`, e.screen);
        return;
      }
    }
  }

  private async moveLineEnd(e: CanvasPointer, which: "line-start" | "line-end"): Promise<void> {
    const ends = lineEndpoints(this.design, this.id);
    if (!ends) return;
    const seq = ++this.seq;
    const fixed = which === "line-start" ? ends[1] : ends[0];
    let p = e.shift ? constrainAngle(fixed, e.page, 45) : e.page;
    if (!e.shift && !e.mod) {
      const snap = await this.c.snapRect({
        ids: [this.id],
        rect: { x: p.x, y: p.y, w: 0, h: 0 },
        distances: false,
      });
      if (seq !== this.seq || this.done) return;
      this.c.snap = snap;
      if (snap) p = { x: p.x + snap.dx, y: p.y + snap.dy };
    }
    const [start, end] = which === "line-start" ? [p, fixed] : [fixed, p];
    this.preview(lineEndpointOps(this.design, this.id, start, end), "Edit line");
    const len = Math.hypot(end.x - start.x, end.y - start.y);
    const angle = (Math.atan2(end.y - start.y, end.x - start.x) * 180) / Math.PI;
    this.setLabel(`${fmtNum(len)} · ${fmtNum(-angle)}°`, e.screen);
  }

  private preview(ops: Op[], label: string): void {
    this.label = this.label || label;
    this.c.preview(ops, label);
    this.c.invalidate();
  }

  private setLabel(text: string, at: Point): void {
    this.labelText = text;
    this.labelAt = at;
  }

  async up(): Promise<void> {
    if (this.pending) await this.pending;
    this.done = true;
    if (!this.moved || !this.label) {
      await this.c.cancelPreview();
      return;
    }
    await this.c.commit(this.label, { select: [this.id] });
  }

  async cancel(): Promise<void> {
    this.done = true;
    await this.c.cancelPreview();
  }

  draw(p: Painter): void {
    if (!this.labelAt || !this.labelText) return;
    p.label(this.labelText, { x: this.labelAt.x, y: this.labelAt.y + 22 }, { align: "below" });
  }
}
