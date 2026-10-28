import type { Id } from "@desyn/schema";
import type { CanvasPointer, Gesture } from "../../tools/types.ts";
import type { CanvasController } from "../controller.ts";
import { type Point, type Rect, rectFromPoints } from "../math.ts";
import type { Painter } from "../overlay/paint.ts";
import { levelContainer, marqueeSelect } from "../selection.ts";

/**
 * Rubber-band selection. Layers of the current level touching the rectangle are selected live; alt selects
 * only layers fully inside, ⌘/Ctrl selects the deepest layers, shift adds to the selection.
 */
export class MarqueeGesture implements Gesture {
  cursor = "default";
  private rect: Rect | null = null;
  private readonly container: Id;

  constructor(
    private readonly c: CanvasController,
    private readonly start: Point,
    private readonly base: readonly Id[],
  ) {
    const design = c.design;
    const pageId = c.pageId;
    this.container =
      design && pageId
        ? levelContainer(design, pageId, { scopeId: c.state.scopeId, selection: [] })
        : (pageId ?? "");
  }

  move(e: CanvasPointer): void {
    const design = this.c.design;
    if (!design) return;
    const rect = rectFromPoints(this.start, e.page);
    if (rect.w * this.c.zoom < 2 && rect.h * this.c.zoom < 2) return;
    this.rect = rect;
    const picked = marqueeSelect(design, this.container, rect, { contain: e.alt, deep: e.mod });
    const next = e.shift ? [...new Set([...this.base, ...picked])] : picked;
    const current = this.c.state.selection;
    if (next.length !== current.length || next.some((id, i) => id !== current[i])) {
      this.c.editor.select(next);
    }
  }

  up(): void {
    this.rect = null;
  }

  cancel(): void {
    this.rect = null;
    this.c.editor.select([...this.base]);
  }

  draw(p: Painter): void {
    const r = this.rect;
    if (!r) return;
    const a = p.s({ x: r.x, y: r.y });
    const b = p.s({ x: r.x + r.w, y: r.y + r.h });
    const ctx = p.ctx;
    const x = p.crisp(Math.min(a.x, b.x));
    const y = p.crisp(Math.min(a.y, b.y));
    const w = Math.round(Math.abs(b.x - a.x));
    const h = Math.round(Math.abs(b.y - a.y));
    ctx.fillStyle = p.theme.dark ? "rgba(255, 176, 46, 0.08)" : "rgba(210, 116, 0, 0.08)";
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = p.theme.selection;
    ctx.lineWidth = 1;
    ctx.strokeRect(x, y, w, h);
  }
}

/** Hand tool / space / middle-button drag: the canvas follows the pointer. */
export class PanGesture implements Gesture {
  cursor = "grabbing";
  hidesHover = true;
  private last: Point;

  constructor(
    private readonly c: CanvasController,
    start: CanvasPointer,
  ) {
    this.last = start.screen;
  }

  move(e: CanvasPointer): void {
    const client = this.c.client;
    const dx = e.screen.x - this.last.x;
    const dy = e.screen.y - this.last.y;
    this.last = e.screen;
    if (client && (dx || dy)) {
      this.c.viewAnimator?.stop();
      client.panBy(dx, dy);
    }
  }

  up(): void {}

  cancel(): void {}
}
