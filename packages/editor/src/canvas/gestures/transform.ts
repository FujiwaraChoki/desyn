import { getNode } from "@desyn/doc-ops";
import type { Design, Id } from "@desyn/schema";
import type { CanvasPointer, Gesture } from "../../tools/types.ts";
import type { CanvasController } from "../controller.ts";
import { resizeCursor, rotateCursor } from "../cursors.ts";
import { handleDirection, KNOB_RADIUS, rotateKnobPoint } from "../handles.ts";
import {
  angleOf,
  normDeg,
  type Obb,
  obbAabb,
  obbCenter,
  obbCorners,
  obbRotation,
  rotationAbout,
  snapAngle,
  transformObb,
} from "../math.ts";
import { drawSizeLabel } from "../overlay/draw.ts";
import { fmtNum, type Painter } from "../overlay/paint.ts";
import {
  type HandleKind,
  handleEdges,
  type ResizeResult,
  resizeObb,
  transformOps,
} from "../transform.ts";

/**
 * Resize: drag a handle (shift keeps the aspect ratio, inverted for aspect-locked layers; alt resizes from the
 * center; ⌘/Ctrl disables snapping). Unrotated boxes snap their moving edges and match sizes of other layers.
 */
export class ResizeGesture implements Gesture {
  cursor: string;
  private readonly design: Design;
  private readonly aspectLocked: boolean;
  private seq = 0;
  private done = false;
  private result: ResizeResult | null = null;
  /** Snap query of the newest pointer move (awaited on release). */
  private pending: Promise<void> | null = null;

  constructor(
    private readonly c: CanvasController,
    private readonly ids: Id[],
    private readonly box: Obb,
    private readonly handle: HandleKind,
  ) {
    this.design = c.design as Design;
    this.aspectLocked = ids.every((id) => !!getNode(this.design, id)?.aspectLocked);
    this.cursor = resizeCursor(handleDirection(box, handle));
  }

  private axisAligned(): boolean {
    const [a, b, cc, d] = this.box.m;
    return Math.abs(b) < 1e-9 && Math.abs(cc) < 1e-9 && a > 0 && d > 0;
  }

  move(e: CanvasPointer): void {
    if (this.done) return;
    const seq = ++this.seq;
    const opts = { keepAspect: e.shift !== this.aspectLocked, fromCenter: e.alt };
    const first = resizeObb(this.box, this.handle, e.page, opts);
    if (e.mod || !this.axisAligned()) {
      this.c.snap = null;
      this.apply(first);
      return;
    }
    // Edges that move in the result (a drag past the opposite side flips which edge follows the pointer).
    const base = handleEdges(this.handle);
    const edges = {
      left: first.flipX ? base.right : base.left,
      right: first.flipX ? base.left : base.right,
      top: first.flipY ? base.bottom : base.top,
      bottom: first.flipY ? base.top : base.bottom,
    };
    this.pending = this.c
      .snapRect({ ids: this.ids, rect: obbAabb(first.box), edges, distances: false })
      .then((snap) => {
        if (seq !== this.seq || this.done) return;
        if (!snap || (snap.dx === 0 && snap.dy === 0)) {
          this.c.snap = snap;
          this.apply(first);
          return;
        }
        // The correction moves the dragged edge: shift the pointer by it and resize again.
        const moveX = edges.left || edges.right ? snap.dx : 0;
        const moveY = edges.top || edges.bottom ? snap.dy : 0;
        const snapped = resizeObb(
          this.box,
          this.handle,
          { x: e.page.x + moveX, y: e.page.y + moveY },
          opts,
        );
        this.c.snap = snap;
        this.apply(snapped);
      });
  }

  private apply(r: ResizeResult): void {
    this.result = r;
    this.c.liveBox = r.box;
    this.c.preview(transformOps(this.design, this.ids, r.page), "Resize");
    this.c.invalidate();
  }

  async up(): Promise<void> {
    if (this.pending) await this.pending;
    this.done = true;
    if (!this.result) {
      await this.c.cancelPreview();
      return;
    }
    await this.c.commit(this.ids.length > 1 ? `Resize ${this.ids.length} layers` : "Resize", {
      select: this.ids,
    });
  }

  async cancel(): Promise<void> {
    this.done = true;
    await this.c.cancelPreview();
  }

  draw(p: Painter): void {
    const box = this.result?.box;
    if (!box) return;
    p.strokeObb(box, p.theme.selection, 1.5);
    drawSizeLabel(p, box);
  }
}

/** Rotate around the selection center; shift snaps to 15° steps. */
export class RotateGesture implements Gesture {
  cursor: string;
  private readonly design: Design;
  private readonly center;
  private readonly startAngle: number;
  private readonly baseRotation: number;
  private delta = 0;
  private moved = false;

  constructor(
    private readonly c: CanvasController,
    private readonly ids: Id[],
    private readonly box: Obb,
    private readonly corner: HandleKind,
    start: CanvasPointer,
  ) {
    this.design = c.design as Design;
    this.center = obbCenter(box);
    this.startAngle = angleOf(this.center, start.page);
    this.baseRotation = obbRotation(box);
    this.cursor = rotateCursor(handleDirection(box, corner));
  }

  move(e: CanvasPointer): void {
    let delta = normDeg(angleOf(this.center, e.page) - this.startAngle);
    if (e.shift) delta = normDeg(snapAngle(this.baseRotation + delta, 15) - this.baseRotation);
    this.delta = delta;
    this.moved = true;
    const t = rotationAbout(this.center, delta);
    this.cursor = rotateCursor(handleDirection(transformObb(t, this.box), this.corner));
    this.c.liveBox = transformObb(t, this.box);
    this.c.preview(transformOps(this.design, this.ids, t), "Rotate");
    this.c.invalidate();
  }

  async up(): Promise<void> {
    if (!this.moved || Math.abs(this.delta) < 1e-9) {
      await this.c.cancelPreview();
      return;
    }
    await this.c.commit(this.ids.length > 1 ? `Rotate ${this.ids.length} layers` : "Rotate", {
      select: this.ids,
    });
  }

  async cancel(): Promise<void> {
    await this.c.cancelPreview();
  }

  draw(p: Painter): void {
    const box = this.c.liveBox;
    if (!box) return;
    p.strokeObb(box, p.theme.selection, 1.5);
    const text = `${fmtNum(normDeg(this.baseRotation + this.delta))}°`;
    if (this.corner === "bottom") {
      // Dragged by the knob: it stays under the pointer's swing and the angle shows just past it.
      const knob = rotateKnobPoint(box, p.zoom);
      p.rotateKnob(knob, KNOB_RADIUS, true);
      const at = p.s(knob);
      p.label(text, { x: at.x, y: at.y + KNOB_RADIUS + 6 }, { align: "below" });
      return;
    }
    const corners = obbCorners(box).map((q) => p.s(q));
    const maxY = Math.max(...corners.map((q) => q.y));
    const cx = corners.reduce((s, q) => s + q.x, 0) / 4;
    p.label(text, { x: cx, y: maxY + 8 }, { align: "below" });
  }
}
