"use client";

import type { Id, PageNode } from "@desyn/schema";
import { type PointerEvent as ReactPointerEvent, useEffect, useRef } from "react";
import type { CanvasPointer, Gesture } from "../tools/types.ts";
import type { CanvasController, Interceptor } from "./controller.ts";
import { fmtNum, type Painter } from "./overlay/paint.ts";

/**
 * Rulers (top and left, in the page's unit) and ruler guides. Drag from a ruler to create a guide, drag a guide
 * on the canvas to move it (snapping to whole units; shift: 10), drop it back on a ruler to delete it. Guides
 * live on the page (`PageNode.guides`) and are snap targets for every gesture.
 */

export const RULER_SIZE = 20;
const GUIDE_HIT = 4;

const UNIT_PX: Record<string, number> = { px: 1, mm: 96 / 25.4, in: 96, pt: 96 / 72 };

export function unitScale(page: PageNode | null): number {
  return UNIT_PX[page?.unit ?? "px"] ?? 1;
}

/** Major tick step (in units) for a zoom: the smallest "nice" step at least 60 screen px apart. */
export function tickStep(zoom: number, unitPx: number): number {
  const minScreen = 60;
  const nice = [1, 2, 5];
  let base = 1e-3;
  for (let i = 0; i < 40; i++) {
    for (const n of nice) {
      const step = n * base;
      if (step * unitPx * zoom >= minScreen) return step;
    }
    base *= 10;
  }
  return 1e6;
}

type Axis = "x" | "y";

function guidesOf(page: PageNode | null): { axis: Axis; pos: number }[] {
  return (page?.guides ?? []) as { axis: Axis; pos: number }[];
}

function guideAt(c: CanvasController, e: CanvasPointer): number | null {
  const page = c.page;
  if (!page || !c.state.panels.rulers || !c.canEdit) return null;
  const guides = guidesOf(page);
  for (let i = guides.length - 1; i >= 0; i--) {
    const g = guides[i] as { axis: Axis; pos: number };
    const d = g.axis === "x" ? Math.abs(e.page.x - g.pos) : Math.abs(e.page.y - g.pos);
    if (d * c.zoom <= GUIDE_HIT) return i;
  }
  return null;
}

/** Rounds a guide position to whole units (shift: tens) in design px. */
function snapGuide(pos: number, unitPx: number, coarse: boolean): number {
  const step = (coarse ? 10 : 1) * unitPx;
  return Math.round(Math.round(pos / step) * step * 1000) / 1000;
}

class GuideGesture implements Gesture {
  cursor: string;
  private pos: number | null = null;
  private removing = false;

  constructor(
    private readonly c: CanvasController,
    private readonly axis: Axis,
    /** Index of the guide being moved, or null for a new one. */
    private readonly index: number | null,
  ) {
    this.cursor = axis === "x" ? "col-resize" : "row-resize";
    c.activeGuide = index;
  }

  move(e: CanvasPointer): void {
    const unit = unitScale(this.c.page);
    const raw = this.axis === "x" ? e.page.x : e.page.y;
    this.pos = snapGuide(raw, unit, e.shift);
    // Dropping back onto the ruler deletes the guide.
    this.removing =
      this.c.state.panels.rulers &&
      (this.axis === "x" ? e.screen.x < RULER_SIZE : e.screen.y < RULER_SIZE);
    this.c.invalidate();
  }

  async up(): Promise<void> {
    this.c.activeGuide = null;
    const page = this.c.page;
    if (!page || this.pos === null) return;
    const guides = guidesOf(page).slice();
    if (this.index !== null) guides.splice(this.index, 1);
    if (!this.removing) guides.push({ axis: this.axis, pos: this.pos });
    const label = this.removing ? "Remove guide" : this.index === null ? "Add guide" : "Move guide";
    await this.c.editor.apply([{ op: "update", id: page.id as Id, set: { guides } }], { label });
  }

  cancel(): void {
    this.c.activeGuide = null;
  }

  draw(p: Painter): void {
    if (this.pos === null) return;
    const v = p.view;
    const color = this.removing ? p.theme.danger : p.theme.guide;
    if (this.axis === "x") {
      p.line({ x: this.pos, y: v.y }, { x: this.pos, y: v.y + v.height / v.zoom }, color, 1.5);
    } else {
      p.line({ x: v.x, y: this.pos }, { x: v.x + v.width / v.zoom, y: this.pos }, color, 1.5);
    }
    const unit = unitScale(this.c.page);
    const at = p.s(this.axis === "x" ? { x: this.pos, y: 0 } : { x: 0, y: this.pos });
    const label = this.removing ? "Remove" : fmtNum(this.pos / unit);
    p.label(
      label,
      this.axis === "x" ? { x: at.x, y: RULER_SIZE + 14 } : { x: RULER_SIZE + 26, y: at.y },
      {
        tone: this.removing ? "neutral" : "measure",
      },
    );
  }
}

/** Canvas-side guide dragging (registered with the controller while rulers are on). */
export function guideInterceptor(): Interceptor {
  return {
    down(c, e) {
      const i = guideAt(c, e);
      if (i === null) return null;
      const g = guidesOf(c.page)[i];
      return g ? new GuideGesture(c, g.axis, i) : null;
    },
    cursor(c, e) {
      const i = guideAt(c, e);
      if (i === null) return null;
      return guidesOf(c.page)[i]?.axis === "x" ? "col-resize" : "row-resize";
    },
  };
}

function drawRuler(canvas: HTMLCanvasElement, c: CanvasController, axis: Axis): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const dpr = globalThis.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(1, Math.round(rect.width * dpr));
  const h = Math.max(1, Math.round(rect.height * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const theme = c.theme;
  ctx.clearRect(0, 0, rect.width, rect.height);
  ctx.fillStyle = theme.dark ? "rgba(17, 17, 17, 0.92)" : "rgba(250, 248, 244, 0.95)";
  ctx.fillRect(0, 0, rect.width, rect.height);
  // Each ruler starts RULER_SIZE px into the canvas (after the corner): draw in canvas screen coordinates.
  ctx.translate(axis === "x" ? -RULER_SIZE : 0, axis === "y" ? -RULER_SIZE : 0);
  const length = (axis === "x" ? rect.width : rect.height) + RULER_SIZE;
  const v = c.view;
  const page = c.page;
  const unit = unitScale(page);
  const origin = axis === "x" ? v.x : v.y;
  // Selection extent band.
  const sel = c.selection();
  if (sel) {
    const a = axis === "x" ? sel.aabb.x : sel.aabb.y;
    const b = a + (axis === "x" ? sel.aabb.w : sel.aabb.h);
    const s0 = (a - origin) * v.zoom;
    const s1 = (b - origin) * v.zoom;
    ctx.fillStyle = theme.dark ? "rgba(255, 176, 46, 0.16)" : "rgba(210, 116, 0, 0.14)";
    if (axis === "x") ctx.fillRect(s0, 0, s1 - s0, RULER_SIZE);
    else ctx.fillRect(0, s0, RULER_SIZE, s1 - s0);
  }
  const step = tickStep(v.zoom, unit);
  const minor = step / 10;
  const startUnits = Math.floor(origin / unit / minor) * minor;
  const endUnits = (origin + length / v.zoom) / unit;
  ctx.strokeStyle = theme.dark ? "rgba(237, 237, 237, 0.28)" : "rgba(23, 23, 23, 0.3)";
  ctx.fillStyle = theme.dark ? "rgba(237, 237, 237, 0.62)" : "rgba(23, 23, 23, 0.62)";
  ctx.font = `10px ${theme.fontSans}`;
  ctx.lineWidth = 1;
  ctx.beginPath();
  let i = 0;
  for (let u = startUnits; u <= endUnits && i < 4000; u += minor, i++) {
    const s = Math.round((u * unit - origin) * v.zoom) + 0.5;
    const major = Math.abs(u / step - Math.round(u / step)) < 1e-6;
    const half = !major && Math.abs((u * 2) / step - Math.round((u * 2) / step)) < 1e-6;
    const len = major ? RULER_SIZE : half ? 7 : 4;
    if (minor * unit * v.zoom < 4 && !major) continue;
    if (axis === "x") {
      ctx.moveTo(s, RULER_SIZE);
      ctx.lineTo(s, RULER_SIZE - len);
    } else {
      ctx.moveTo(RULER_SIZE, s);
      ctx.lineTo(RULER_SIZE - len, s);
    }
    if (major) {
      const label = fmtNum(Math.round(u * 1000) / 1000);
      if (axis === "x") {
        ctx.textAlign = "left";
        ctx.textBaseline = "top";
        ctx.fillText(label, s + 3, 3);
      } else {
        ctx.save();
        ctx.translate(3, s - 3);
        ctx.rotate(-Math.PI / 2);
        ctx.textAlign = "left";
        ctx.textBaseline = "top";
        ctx.fillText(label, 0, 0);
        ctx.restore();
      }
    }
  }
  ctx.stroke();
  // Guides on the ruler.
  for (const g of guidesOf(page)) {
    if (g.axis !== axis) continue;
    const s = (g.pos - origin) * v.zoom;
    ctx.fillStyle = theme.guide;
    ctx.beginPath();
    if (axis === "x") {
      ctx.moveTo(s - 4, RULER_SIZE - 6);
      ctx.lineTo(s + 4, RULER_SIZE - 6);
      ctx.lineTo(s, RULER_SIZE);
    } else {
      ctx.moveTo(RULER_SIZE - 6, s - 4);
      ctx.lineTo(RULER_SIZE - 6, s + 4);
      ctx.lineTo(RULER_SIZE, s);
    }
    ctx.fill();
  }
  // Pointer position.
  const p = c.lastPointer;
  if (p) {
    const s = axis === "x" ? p.screen.x : p.screen.y;
    ctx.strokeStyle = theme.selection;
    ctx.beginPath();
    if (axis === "x") {
      ctx.moveTo(Math.round(s) + 0.5, 0);
      ctx.lineTo(Math.round(s) + 0.5, RULER_SIZE);
    } else {
      ctx.moveTo(0, Math.round(s) + 0.5);
      ctx.lineTo(RULER_SIZE, Math.round(s) + 0.5);
    }
    ctx.stroke();
  }
  // Hairline border towards the canvas.
  ctx.strokeStyle = theme.dark ? "rgba(237, 237, 237, 0.1)" : "rgba(23, 23, 23, 0.1)";
  ctx.beginPath();
  if (axis === "x") {
    ctx.moveTo(RULER_SIZE, RULER_SIZE - 0.5);
    ctx.lineTo(length, RULER_SIZE - 0.5);
  } else {
    ctx.moveTo(RULER_SIZE - 0.5, RULER_SIZE);
    ctx.lineTo(RULER_SIZE - 0.5, length);
  }
  ctx.stroke();
}

/** The two rulers and the corner, drawn on every view / selection / pointer change. */
export function Rulers({ controller }: { controller: CanvasController }) {
  const top = useRef<HTMLCanvasElement>(null);
  const left = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    let raf = 0;
    const draw = () => {
      raf = 0;
      if (top.current) drawRuler(top.current, controller, "x");
      if (left.current) drawRuler(left.current, controller, "y");
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(draw);
    };
    schedule();
    const unsub = controller.editor.store.subscribe(schedule);
    const onMove = () => schedule();
    controller.root.addEventListener("pointermove", onMove);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      unsub();
      controller.root.removeEventListener("pointermove", onMove);
    };
  }, [controller]);

  const startGuide = (axis: Axis) => (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0 || !controller.canEdit) return;
    e.stopPropagation();
    e.preventDefault();
    controller.beginExternal(e.nativeEvent, new GuideGesture(controller, axis, null));
  };

  return (
    <>
      <canvas
        ref={top}
        data-canvas-chrome=""
        className="absolute top-0 right-0 z-[3] block"
        style={{
          left: RULER_SIZE,
          width: `calc(100% - ${RULER_SIZE}px)`,
          height: RULER_SIZE,
          cursor: "row-resize",
        }}
        onPointerDown={startGuide("y")}
      />
      <canvas
        ref={left}
        data-canvas-chrome=""
        className="absolute bottom-0 left-0 z-[3] block"
        style={{
          top: RULER_SIZE,
          width: RULER_SIZE,
          height: `calc(100% - ${RULER_SIZE}px)`,
          cursor: "col-resize",
        }}
        onPointerDown={startGuide("x")}
      />
      <div
        aria-hidden="true"
        data-canvas-chrome=""
        className="absolute top-0 left-0 z-[3] border-r border-b border-line-subtle bg-surface-1/95"
        style={{ width: RULER_SIZE, height: RULER_SIZE }}
      />
    </>
  );
}
