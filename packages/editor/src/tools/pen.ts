import { getNode, worldTransform } from "@desyn/doc-ops";
import { createPath, defaultStroke, type Id, solid } from "@desyn/schema";
import type { CanvasController } from "../canvas/controller.ts";
import {
  backgroundAt,
  createPathOps,
  creationParent,
  inkFor,
  updatePathOps,
} from "../canvas/create.ts";
import { penCursor } from "../canvas/cursors.ts";
import { nodeObb } from "../canvas/geometry.ts";
import {
  apply,
  constrainAngle,
  dist,
  inv,
  type Matrix,
  obbContains,
  type Point,
  type Rect,
  rectContainsPoint,
  rectFromPoints,
} from "../canvas/math.ts";
import type { Painter } from "../canvas/overlay/paint.ts";
import {
  type Anchor,
  anchorKind,
  clonePaths,
  nearestOnPaths,
  parseSubPaths,
  type SubPath,
  segmentPoints,
  segmentsOf,
  splitSegment,
  toggleSmooth,
} from "./path-model.ts";
import { selectTool } from "./select.ts";
import type { CanvasPointer, Gesture, Mode, Tool } from "./types.ts";

/**
 * Pen tool and path edit mode.
 *
 * Drawing: click adds a corner point, click-drag pulls out symmetric handles (alt: only the outgoing one),
 * shift keeps 45° steps, clicking the first point closes the path, Enter / Escape / double click finishes,
 * Backspace removes the last point.
 *
 * Editing (double click a path or Enter): drag points and handles (smooth points keep their handles aligned,
 * alt breaks them), click a segment to add a point, double click or alt-click a point to convert it between
 * corner and smooth, Delete removes selected points, arrows nudge them, Enter / Escape leaves.
 */

const ANCHOR_HIT = 7;
const HANDLE_HIT = 6;
const SEGMENT_HIT = 6;

function strokeOn(c: CanvasController, parent: Id) {
  const design = c.design;
  const ink = design ? inkFor(backgroundAt(design, parent)) : "#111111";
  return defaultStroke({ width: 2, fills: [solid(ink)], cap: "round", join: "round" });
}

/** Snaps a page point to objects / guides (zero-size snap rect). */
async function snapPoint(c: CanvasController, p: Point, e: CanvasPointer): Promise<Point> {
  if (e.mod) return p;
  const snap = await c.snapRect({
    ids: [],
    rect: { x: p.x, y: p.y, w: 0, h: 0 },
    distances: false,
  });
  c.snap = snap && (snap.dx || snap.dy) ? snap : null;
  return snap ? { x: p.x + snap.dx, y: p.y + snap.dy } : p;
}

function drawAnchor(
  p: Painter,
  at: Point,
  opts: { selected?: boolean; first?: boolean } = {},
): void {
  const s = p.s(at);
  const ctx = p.ctx;
  ctx.beginPath();
  ctx.arc(s.x, s.y, opts.first ? 4.5 : 3.75, 0, Math.PI * 2);
  ctx.fillStyle = opts.selected ? p.theme.selection : "#ffffff";
  ctx.fill();
  ctx.lineWidth = 1.25;
  ctx.strokeStyle = p.theme.selection;
  ctx.stroke();
}

function drawHandle(p: Painter, anchorAt: Point, h: Point): void {
  p.line(anchorAt, h, p.theme.selection, 1);
  const s = p.s(h);
  const ctx = p.ctx;
  ctx.beginPath();
  ctx.arc(s.x, s.y, 3, 0, Math.PI * 2);
  ctx.fillStyle = p.theme.selection;
  ctx.fill();
}

function strokeSubPath(
  p: Painter,
  sp: SubPath,
  map: (q: Point) => Point,
  color: string,
  width: number,
): void {
  const first = sp.anchors[0];
  if (!first) return;
  const ctx = p.ctx;
  ctx.beginPath();
  const f = p.s(map(first));
  ctx.moveTo(f.x, f.y);
  for (const seg of segmentsOf(sp)) {
    const [, c1, c2, p3] = segmentPoints(sp, seg).map((q) => p.s(map(q)));
    if (!c1 || !c2 || !p3) continue;
    ctx.bezierCurveTo(c1.x, c1.y, c2.x, c2.y, p3.x, p3.y);
  }
  if (sp.closed) ctx.closePath();
  p.stroke(color, width);
}

// --------------------------------------------------------------------------------------------------------------
// Drawing new paths

interface Draft {
  anchors: Anchor[];
  parent: Id;
}

class PenTool implements Tool {
  readonly id = "pen";
  private draft: Draft | null = null;
  private pointer: Point | null = null;
  private busy = false;

  cursor(c: CanvasController): string {
    const e = c.lastPointer;
    const first = this.draft?.anchors[0];
    if (
      e &&
      first &&
      (this.draft?.anchors.length ?? 0) >= 2 &&
      dist(first, e.page) * c.zoom <= ANCHOR_HIT
    ) {
      return penCursor("close");
    }
    return penCursor();
  }

  hover(c: CanvasController, e: CanvasPointer): void {
    this.pointer =
      e.shift && this.last() ? constrainAngle(this.last() as Point, e.page, 45) : e.page;
    c.invalidate();
  }

  private last(): Anchor | undefined {
    return this.draft?.anchors[this.draft.anchors.length - 1];
  }

  async down(c: CanvasController, e: CanvasPointer): Promise<Gesture | null> {
    const design = c.design;
    const pageId = c.pageId;
    if (!design || !pageId || !c.canEdit || this.busy) return null;
    if (!this.draft) this.draft = { anchors: [], parent: creationParent(design, pageId, e.page) };
    const draft = this.draft;
    const first = draft.anchors[0];
    if (first && draft.anchors.length >= 2 && dist(first, e.page) * c.zoom <= ANCHOR_HIT) {
      // Closing: a drag on the first point shapes the closing curve.
      return this.handleDrag(c, first, true, () => this.finish(c, true));
    }
    const last = this.last();
    let p = e.shift && last ? constrainAngle(last, e.page, 45) : e.page;
    if (!e.shift) p = await snapPoint(c, p, e);
    const anchor: Anchor = { x: p.x, y: p.y, in: null, out: null };
    draft.anchors.push(anchor);
    c.invalidate();
    return this.handleDrag(c, anchor, false, null);
  }

  /** Dragging out the handles of `anchor` (symmetric; alt moves only the outgoing / closing one). */
  private handleDrag(
    c: CanvasController,
    anchor: Anchor,
    closing: boolean,
    onUp: (() => Promise<void>) | null,
  ): Gesture {
    const start = { x: anchor.x, y: anchor.y };
    let dragged = false;
    return {
      cursor: penCursor(closing ? "close" : "none"),
      hidesHover: true,
      move: (e) => {
        let h = e.page;
        if (!dragged && dist(h, start) * c.zoom < 2) return;
        dragged = true;
        if (e.shift) h = constrainAngle(start, h, 45);
        const mirror = { x: 2 * start.x - h.x, y: 2 * start.y - h.y };
        if (closing) {
          // The closing segment arrives at the first point: its incoming handle mirrors the drag, and the
          // outgoing one follows it (alt shapes only the closing curve).
          anchor.in = mirror;
          if (!e.alt) anchor.out = h;
        } else {
          anchor.out = h;
          if (!e.alt) anchor.in = mirror;
        }
        c.invalidate();
      },
      up: async () => {
        c.snap = null;
        if (onUp) await onUp();
        c.invalidate();
      },
      cancel: () => {
        if (!closing) this.draft?.anchors.pop();
        c.invalidate();
      },
    };
  }

  async doubleClick(c: CanvasController): Promise<void> {
    await this.finish(c, false);
  }

  keyDown(c: CanvasController, e: KeyboardEvent): boolean {
    if (!this.draft) return false;
    if (e.key === "Enter" || e.key === "Escape") {
      void this.finish(c, false);
      return true;
    }
    if (e.key === "Backspace" || e.key === "Delete") {
      this.draft.anchors.pop();
      if (this.draft.anchors.length === 0) this.draft = null;
      return true;
    }
    return false;
  }

  deactivate(c: CanvasController): void {
    void this.finish(c, false, false);
  }

  /** Creates the path layer from the draft (2+ points). */
  async finish(c: CanvasController, closed: boolean, backToSelect = true): Promise<void> {
    const draft = this.draft;
    this.draft = null;
    this.pointer = null;
    c.snap = null;
    c.invalidate();
    const design = c.design;
    if (!draft || draft.anchors.length < 2 || !design || !getNode(design, draft.parent)) return;
    this.busy = true;
    try {
      const node = createPath({
        name: closed ? "Shape" : "Path",
        fills: [],
        strokes: [strokeOn(c, draft.parent)],
      });
      const ops = createPathOps(design, draft.parent, [{ anchors: draft.anchors, closed }], node);
      await c.editor.apply(ops, { label: "Draw path", select: [node.id] });
      if (backToSelect) c.finishTool();
    } finally {
      this.busy = false;
    }
  }

  draw(c: CanvasController, p: Painter): void {
    const draft = this.draft;
    if (!draft || draft.anchors.length === 0) return;
    const id = (q: Point) => q;
    strokeSubPath(p, { anchors: draft.anchors, closed: false }, id, p.theme.selection, 1.5);
    const last = this.last() as Anchor;
    const pointer = this.pointer;
    if (pointer && !c.gesture) {
      // Rubber band to the pointer (curved when the last point has an outgoing handle).
      const ctx = p.ctx;
      const a = p.s(last);
      const c1 = p.s(last.out ?? last);
      const b = p.s(pointer);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.bezierCurveTo(c1.x, c1.y, b.x, b.y, b.x, b.y);
      p.stroke(p.theme.selection, 1, [4, 3]);
    }
    draft.anchors.forEach((a, i) => {
      drawAnchor(p, a, { first: i === 0, selected: a === last });
    });
    if (last.in) drawHandle(p, last, last.in);
    if (last.out) drawHandle(p, last, last.out);
    const first = draft.anchors[0] as Anchor;
    if (first.in && first !== last) drawHandle(p, first, first.in);
  }
}

export const penTool = new PenTool();

// --------------------------------------------------------------------------------------------------------------
// Editing existing paths

type Ref = { e: number; s: number; i: number };
const key = (r: Ref) => `${r.e}:${r.s}:${r.i}`;

class PathEditMode implements Mode {
  readonly kind = "path" as const;
  readonly nodeId: Id;
  entries: SubPath[][] = [];
  selected = new Set<string>();
  private world: Matrix = [1, 0, 0, 1, 0, 0];
  private hoverSegment: Point | null = null;

  constructor(
    private readonly c: CanvasController,
    id: Id,
  ) {
    this.nodeId = id;
  }

  /** Reads the node's paths; false when they cannot be parsed. */
  load(): boolean {
    const design = this.c.design;
    const node = design ? getNode(design, this.nodeId) : undefined;
    if (!design || node?.type !== "path") return false;
    try {
      this.entries = node.paths.map((p) => parseSubPaths(p.d));
    } catch {
      return false;
    }
    this.world = worldTransform(design, this.nodeId);
    return true;
  }

  private toPage = (q: Point): Point => apply(this.world, q);
  private toLocal = (q: Point): Point => apply(inv(this.world), q);

  private anchorAt(r: Ref): Anchor | undefined {
    return this.entries[r.e]?.[r.s]?.anchors[r.i];
  }

  private refs(): Ref[] {
    const out: Ref[] = [];
    this.entries.forEach((entry, e) => {
      entry.forEach((sp, s) => {
        for (let i = 0; i < sp.anchors.length; i++) out.push({ e, s, i });
      });
    });
    return out;
  }

  private hitAnchor(p: Point, zoom: number): Ref | null {
    let best: { r: Ref; d: number } | null = null;
    for (const r of this.refs()) {
      const a = this.anchorAt(r) as Anchor;
      const d = dist(this.toPage(a), p) * zoom;
      if (d <= ANCHOR_HIT && (!best || d < best.d)) best = { r, d };
    }
    return best?.r ?? null;
  }

  /** Handles shown: those of selected anchors and the facing handles of their neighbours. */
  private visibleHandles(): { r: Ref; which: "in" | "out" }[] {
    const out: { r: Ref; which: "in" | "out" }[] = [];
    for (const k of this.selected) {
      const [e, s, i] = k.split(":").map(Number) as [number, number, number];
      const sp = this.entries[e]?.[s];
      if (!sp) continue;
      const a = sp.anchors[i];
      if (!a) continue;
      if (a.in) out.push({ r: { e, s, i }, which: "in" });
      if (a.out) out.push({ r: { e, s, i }, which: "out" });
      const n = sp.anchors.length;
      const prev = i > 0 ? i - 1 : sp.closed ? n - 1 : -1;
      const next = i < n - 1 ? i + 1 : sp.closed ? 0 : -1;
      if (prev >= 0 && sp.anchors[prev]?.out) out.push({ r: { e, s, i: prev }, which: "out" });
      if (next >= 0 && sp.anchors[next]?.in) out.push({ r: { e, s, i: next }, which: "in" });
    }
    return out;
  }

  private hitHandle(p: Point, zoom: number): { r: Ref; which: "in" | "out" } | null {
    for (const h of this.visibleHandles()) {
      const a = this.anchorAt(h.r);
      const at = a?.[h.which];
      if (at && dist(this.toPage(at), p) * zoom <= HANDLE_HIT) return h;
    }
    return null;
  }

  private hitSegment(p: Point, zoom: number) {
    let best: { e: number; s: number; segment: number; t: number; d: number; point: Point } | null =
      null;
    const local = this.toLocal(p);
    const scale = Math.hypot(this.world[0], this.world[1]) || 1;
    this.entries.forEach((entry, e) => {
      const hit = nearestOnPaths(entry, local);
      if (!hit) return;
      const d = hit.d * scale * zoom;
      if (d <= SEGMENT_HIT && (!best || d < best.d))
        best = { e, s: hit.path, segment: hit.segment, t: hit.t, d, point: hit.point };
    });
    return best as {
      e: number;
      s: number;
      segment: number;
      t: number;
      d: number;
      point: Point;
    } | null;
  }

  cursor(c: CanvasController): string {
    const e = c.lastPointer;
    if (!e) return penCursor();
    if (this.hitHandle(e.page, c.zoom)) return "default";
    if (this.hitAnchor(e.page, c.zoom)) return e.alt ? penCursor("convert") : "default";
    if (this.hitSegment(e.page, c.zoom)) return penCursor("add");
    return "default";
  }

  hover(c: CanvasController, e: CanvasPointer): void {
    const seg = this.hitAnchor(e.page, c.zoom) ? null : this.hitSegment(e.page, c.zoom);
    this.hoverSegment = seg ? this.toPage(seg.point) : null;
    c.invalidate();
  }

  async down(c: CanvasController, e: CanvasPointer): Promise<Gesture | null> {
    const handle = this.hitHandle(e.page, c.zoom);
    if (handle) return this.dragHandle(c, handle.r, handle.which);
    const anchor = this.hitAnchor(e.page, c.zoom);
    if (anchor) {
      const k = key(anchor);
      if (e.alt) {
        this.edit((entries) => {
          const sp = entries[anchor.e]?.[anchor.s];
          if (sp) toggleSmooth(sp, anchor.i);
        }, "Convert point");
        return null;
      }
      if (e.shift) {
        if (this.selected.has(k)) this.selected.delete(k);
        else this.selected.add(k);
      } else if (!this.selected.has(k)) {
        this.selected = new Set([k]);
      }
      c.invalidate();
      return this.dragAnchors(c, e);
    }
    const seg = this.hitSegment(e.page, c.zoom);
    if (seg) {
      // Insert a point on the segment and drag it right away.
      const entries = clonePaths2(this.entries);
      const sp = entries[seg.e]?.[seg.s];
      if (!sp) return null;
      const at = splitSegment(sp, seg.segment, seg.t);
      this.entries = entries;
      this.selected = new Set([key({ e: seg.e, s: seg.s, i: at })]);
      this.previewEntries("Add point");
      return this.dragAnchors(c, e, true);
    }
    const design = c.design;
    const box = design ? nodeObb(design, this.nodeId) : null;
    if (box && obbContains(box, e.page, 4 / c.zoom)) {
      // Rubber band over the path's points.
      if (!e.shift) this.selected.clear();
      return this.marquee(c, e.page);
    }
    await c.exitMode("click");
    return selectTool.down(c, e);
  }

  async doubleClick(c: CanvasController, e: CanvasPointer): Promise<void> {
    const anchor = this.hitAnchor(e.page, c.zoom);
    if (anchor) {
      this.edit((entries) => {
        const sp = entries[anchor.e]?.[anchor.s];
        if (sp) toggleSmooth(sp, anchor.i);
      }, "Convert point");
      return;
    }
    const design = c.design;
    const box = design ? nodeObb(design, this.nodeId) : null;
    if (!box || !obbContains(box, e.page, 4 / c.zoom)) await c.exitMode("click");
  }

  /** Applies an immediate edit (convert, delete, nudge) as its own undo step. */
  private edit(f: (entries: SubPath[][]) => void, label: string): void {
    const entries = clonePaths2(this.entries);
    f(entries);
    this.entries = entries;
    const design = this.c.design;
    if (!design) return;
    void this.c.editor
      .apply(updatePathOps(design, this.nodeId, entries), { label, select: [this.nodeId] })
      .then(() => this.reload());
  }

  private previewEntries(label: string): void {
    const design = this.c.design;
    if (!design) return;
    this.c.preview(updatePathOps(design, this.nodeId, this.entries), label);
    this.c.invalidate();
  }

  documentChanged(): void {
    this.reload();
  }

  private reload(): void {
    const keep = this.selected;
    if (!this.load()) {
      void this.c.exitMode("api");
      return;
    }
    this.selected = new Set(
      [...keep].filter((k) => {
        const [e, s, i] = k.split(":").map(Number) as [number, number, number];
        return !!this.entries[e]?.[s]?.anchors[i];
      }),
    );
    this.c.invalidate();
  }

  private async commit(label: string): Promise<void> {
    await this.c.commit(label, { select: [this.nodeId] });
    this.reload();
  }

  private dragAnchors(c: CanvasController, start: CanvasPointer, inserted = false): Gesture {
    const base = clonePaths2(this.entries);
    const refs = [...this.selected].map(
      (k) => k.split(":").map(Number) as [number, number, number],
    );
    let moved = inserted;
    return {
      hidesHover: true,
      move: (e) => {
        let p = e.page;
        if (e.shift) p = constrainAngle(start.page, p, 45);
        const d0 = this.toLocal(start.page);
        const d1 = this.toLocal(p);
        const dx = d1.x - d0.x;
        const dy = d1.y - d0.y;
        if (!moved && Math.hypot(e.screen.x - start.screen.x, e.screen.y - start.screen.y) < 2)
          return;
        moved = true;
        const next = clonePaths2(base);
        for (const [ei, si, ai] of refs) {
          const a = next[ei]?.[si]?.anchors[ai];
          if (!a) continue;
          a.x += dx;
          a.y += dy;
          if (a.in) a.in = { x: a.in.x + dx, y: a.in.y + dy };
          if (a.out) a.out = { x: a.out.x + dx, y: a.out.y + dy };
        }
        this.entries = next;
        this.previewEntries("Edit path");
      },
      up: async () => {
        if (moved) await this.commit(inserted ? "Add point" : "Edit path");
      },
      cancel: async () => {
        this.entries = base;
        await c.cancelPreview();
        this.reload();
      },
    };
  }

  private dragHandle(c: CanvasController, r: Ref, which: "in" | "out"): Gesture {
    const base = clonePaths2(this.entries);
    const kind = anchorKind(this.anchorAt(r) as Anchor);
    let moved = false;
    return {
      hidesHover: true,
      move: (e) => {
        const next = clonePaths2(base);
        const a = next[r.e]?.[r.s]?.anchors[r.i];
        if (!a) return;
        let p = this.toLocal(e.page);
        if (e.shift) p = constrainAngle(a, p, 45);
        a[which] = p;
        const other = which === "in" ? "out" : "in";
        const o = a[other];
        if (o && !e.alt && (kind === "smooth" || kind === "asymmetric")) {
          const vx = a.x - p.x;
          const vy = a.y - p.y;
          const l = Math.hypot(vx, vy) || 1;
          const keep = kind === "smooth" ? l : Math.hypot(o.x - a.x, o.y - a.y);
          a[other] = { x: a.x + (vx / l) * keep, y: a.y + (vy / l) * keep };
        }
        moved = true;
        this.entries = next;
        this.previewEntries("Edit path");
      },
      up: async () => {
        if (moved) await this.commit("Edit path");
      },
      cancel: async () => {
        this.entries = base;
        await c.cancelPreview();
      },
    };
  }

  private marquee(c: CanvasController, start: Point): Gesture {
    let rect: Rect | null = null;
    const base = new Set(this.selected);
    return {
      move: (e) => {
        rect = rectFromPoints(start, e.page);
        const inside = this.refs().filter((r) =>
          rectContainsPoint(rect as Rect, this.toPage(this.anchorAt(r) as Anchor)),
        );
        this.selected = new Set([...base, ...inside.map(key)]);
        c.invalidate();
      },
      up: () => {
        rect = null;
      },
      cancel: () => {
        rect = null;
      },
      draw: (p) => {
        if (!rect) return;
        const a = p.s({ x: rect.x, y: rect.y });
        p.ctx.strokeStyle = p.theme.selection;
        p.ctx.lineWidth = 1;
        p.ctx.setLineDash([3, 3]);
        p.ctx.strokeRect(a.x, a.y, rect.w * p.zoom, rect.h * p.zoom);
        p.ctx.setLineDash([]);
      },
    };
  }

  keyDown(c: CanvasController, e: KeyboardEvent): boolean {
    if (e.key === "Enter" || e.key === "Escape") {
      void c.exitMode("escape");
      return true;
    }
    if ((e.key === "Delete" || e.key === "Backspace") && this.selected.size > 0) {
      this.deleteSelected();
      return true;
    }
    const step = e.shiftKey ? 10 : 1;
    const arrows: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    };
    const d = arrows[e.key];
    if (d && this.selected.size > 0) {
      // Nudges are in page pixels: convert the page vector into the path's local axes.
      const inverse = inv(this.world);
      const lx = inverse[0] * d[0] + inverse[2] * d[1];
      const ly = inverse[1] * d[0] + inverse[3] * d[1];
      this.edit((entries) => {
        for (const k of this.selected) {
          const [ei, si, ai] = k.split(":").map(Number) as [number, number, number];
          const a = entries[ei]?.[si]?.anchors[ai];
          if (!a) continue;
          a.x += lx;
          a.y += ly;
          if (a.in) a.in = { x: a.in.x + lx, y: a.in.y + ly };
          if (a.out) a.out = { x: a.out.x + lx, y: a.out.y + ly };
        }
      }, "Nudge points");
      return true;
    }
    return false;
  }

  private deleteSelected(): void {
    const remove = new Set(this.selected);
    this.selected.clear();
    const entries = clonePaths2(this.entries).map((entry, e) =>
      entry
        .map((sp, s) => ({
          closed: sp.closed,
          anchors: sp.anchors.filter((_, i) => !remove.has(key({ e, s, i }))),
        }))
        .filter((sp) => sp.anchors.length >= 2),
    );
    const design = this.c.design;
    if (!design) return;
    if (entries.every((entry) => entry.length === 0)) {
      // Nothing left: the layer goes away.
      void this.c.exitMode("api");
      void this.c.editor.apply([{ op: "delete", id: this.nodeId }], {
        label: "Delete path",
        select: [],
      });
      return;
    }
    this.entries = entries;
    void this.c.editor
      .apply(updatePathOps(design, this.nodeId, entries), {
        label: "Delete points",
        select: [this.nodeId],
      })
      .then(() => this.reload());
  }

  draw(c: CanvasController, p: Painter): void {
    const design = c.design;
    if (!design || !getNode(design, this.nodeId)) return;
    for (const entry of this.entries) {
      for (const sp of entry) strokeSubPath(p, sp, this.toPage, p.theme.selection, 1);
    }
    if (this.hoverSegment && !c.gesture)
      p.roundHandle(this.hoverSegment, { r: 3, fill: p.theme.selection });
    for (const h of this.visibleHandles()) {
      const a = this.anchorAt(h.r);
      const at = a?.[h.which];
      if (a && at) drawHandle(p, this.toPage(a), this.toPage(at));
    }
    for (const r of this.refs()) {
      const a = this.anchorAt(r) as Anchor;
      drawAnchor(p, this.toPage(a), { selected: this.selected.has(key(r)) });
    }
  }

  exit(): void {
    this.selected.clear();
    if (this.c.design?.nodes[this.nodeId]) this.c.editor.select([this.nodeId]);
  }
}

function clonePaths2(entries: readonly SubPath[][]): SubPath[][] {
  return entries.map((e) => clonePaths(e));
}

/** Enters path editing for a path layer (double click / Enter). */
export async function startPathEditing(c: CanvasController, id: Id): Promise<void> {
  if (!c.canEdit) return;
  const mode = new PathEditMode(c, id);
  if (!mode.load()) {
    c.editor.notify({ kind: "warning", title: "This path can't be edited on the canvas." });
    return;
  }
  c.editor.select([id]);
  await c.enterMode(mode);
}
