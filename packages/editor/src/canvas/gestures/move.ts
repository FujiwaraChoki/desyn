import { Builder, cloneSubtree, getNode, reparent } from "@desyn/doc-ops";
import type { Design, Id } from "@desyn/schema";
import type { CanvasPointer, Gesture } from "../../tools/types.ts";
import { dropContainerAt, type Insertion, insertionIndex } from "../autolayout.ts";
import type { CanvasController } from "../controller.ts";
import { autoLayoutOf, type SelectionBox, selectionBox } from "../geometry.ts";
import { dist, type Point, translateObb, translateRect } from "../math.ts";
import { drawDropTarget } from "../overlay/draw.ts";
import type { Painter } from "../overlay/paint.ts";

/**
 * Dragging layers: snapping to objects / guides / grid (engine snap; hold ⌘/Ctrl to disable), shift locks to
 * an axis, alt drags a copy, dropping onto a frame moves the layers into it, and inside an auto-layout frame
 * the drag reorders the children (with an insertion indicator). One undo step per drag.
 */

const DRAG_THRESHOLD = 3;

export interface MoveOptions {
  ids: Id[];
  start: CanvasPointer;
  /** Selection applied when the press ends without a drag (click inside a multi-selection). */
  clickSelect?: Id[] | null;
  /** Called instead when the press ends without a drag (select-through). */
  onClick?: () => void;
}

export class MoveGesture implements Gesture {
  cursor = "default";
  private readonly design: Design;
  private readonly box: SelectionBox | null;
  private readonly parent: Id | null;
  private readonly canReparent: boolean;
  private readonly dupIds = new Map<Id, Map<Id, Id>>();
  private moved = false;
  private seq = 0;
  private done = false;
  private duplicating = false;
  private insertion: Insertion | null = null;
  /** Snap query of the newest pointer move (awaited on release so the drop lands where the pointer was). */
  private pending: Promise<void> | null = null;

  constructor(
    private readonly c: CanvasController,
    private readonly o: MoveOptions,
  ) {
    this.design = c.design as Design;
    this.box = selectionBox(this.design, o.ids);
    const parents = new Set(o.ids.map((id) => getNode(this.design, id)?.parent ?? null));
    this.parent = parents.size === 1 ? ([...parents][0] ?? null) : null;
    const parentNode = this.parent ? getNode(this.design, this.parent) : undefined;
    // Layers inside groups / booleans stay there; layers of frames and pages can move between frames.
    this.canReparent = !!parentNode && (parentNode.type === "frame" || parentNode.type === "page");
  }

  /** Ids of the copies an alt-drag creates (stable for the whole gesture). */
  private copyMap(id: Id): Map<Id, Id> {
    let map = this.dupIds.get(id);
    if (!map) {
      map = new Map();
      const { idMap } = cloneSubtree(this.design, id);
      for (const [k, v] of idMap) map.set(k, v);
      this.dupIds.set(id, map);
    }
    return map;
  }

  move(e: CanvasPointer): void {
    if (this.done) return;
    if (!this.moved) {
      if (dist(e.screen, this.o.start.screen) < DRAG_THRESHOLD) return;
      this.moved = true;
      this.c.setHover(null);
    }
    const seq = ++this.seq;
    let dx = e.page.x - this.o.start.page.x;
    let dy = e.page.y - this.o.start.page.y;
    let axis: "x" | "y" | null = null;
    if (e.shift) {
      axis = Math.abs(dx) >= Math.abs(dy) ? "x" : "y";
      if (axis === "x") dy = 0;
      else dx = 0;
    }
    this.duplicating = e.alt;
    this.cursor = e.alt ? "copy" : "default";
    const pageId = this.c.pageId;
    // Auto-layout children reorder while the pointer stays inside their frame.
    const parentLayout = this.parent ? autoLayoutOf(getNode(this.design, this.parent)) : null;
    const target =
      this.canReparent && pageId ? dropContainerAt(this.design, pageId, e.page, this.o.ids) : null;
    if (parentLayout && this.parent && (target === this.parent || !this.canReparent) && !e.alt) {
      this.reorder(e.page);
      return;
    }
    this.insertion = null;
    const snapIds = this.o.ids;
    const raw = this.box ? translateRect(this.box.aabb, dx, dy) : null;
    const run = (sdx: number, sdy: number) => {
      if (seq !== this.seq || this.done) return;
      this.apply(dx + sdx, dy + sdy, target);
    };
    if (!raw || e.mod) {
      this.c.snap = null;
      run(0, 0);
      return;
    }
    this.pending = this.c.snapRect({ ids: snapIds, rect: raw }).then((snap) => {
      if (seq !== this.seq || this.done) return;
      if (snap && axis) {
        // Axis-locked drags only snap along the free axis.
        if (axis === "x") snap.dy = 0;
        else snap.dx = 0;
        snap.guides = snap.guides.filter((g) => (axis === "x" ? g.axis === "x" : g.axis === "y"));
      }
      this.c.snap = snap;
      run(snap?.dx ?? 0, snap?.dy ?? 0);
    });
  }

  private apply(dx: number, dy: number, target: Id | null): void {
    const b = new Builder(this.design);
    let moving = this.o.ids;
    if (this.duplicating) {
      moving = this.o.ids.map((id) => {
        const map = this.copyMap(id);
        const { op } = cloneSubtree(b.design, id, { newIds: map });
        b.push(op);
        return map.get(id) as Id;
      });
    }
    for (const id of moving) b.translateInPage(id, dx, dy);
    let into: Id | null = null;
    if (target && this.canReparent && target !== this.parent) {
      try {
        const insertion = autoLayoutOf(getNode(b.design, target))
          ? insertionIndex(b.design, target, moving, this.c.lastPointer?.page ?? { x: 0, y: 0 })
          : null;
        const tx = reparent(b.design, moving, target, insertion ? { index: insertion.index } : {});
        for (const op of tx.ops) b.push(op);
        into = target;
        this.insertion = insertion;
      } catch {
        into = null;
      }
    }
    b.refitGroups(moving);
    this.c.dropTarget = into && into !== this.c.pageId ? into : null;
    this.c.liveBox = this.box ? translateObb(this.box.obb, dx, dy) : null;
    this.c.preview(b.ops, this.label());
    this.c.invalidate();
  }

  private reorder(p: Point): void {
    if (!this.parent) return;
    const ins = insertionIndex(this.design, this.parent, this.o.ids, p);
    this.c.snap = null;
    this.c.dropTarget = null;
    this.insertion = ins;
    if (!ins) return;
    const ops = this.o.ids.map((id, k) => ({
      op: "move" as const,
      id,
      parent: ins.parent,
      index: ins.index + k,
    }));
    // The layer follows the pointer as a ghost box; the engine shows the reordered layout live.
    const start = this.o.start.page;
    const last = this.c.lastPointer?.page ?? p;
    this.c.liveBox = this.box
      ? translateObb(this.box.obb, last.x - start.x, last.y - start.y)
      : null;
    this.c.preview(ops, "Reorder");
    this.c.invalidate();
  }

  private label(): string {
    if (this.duplicating)
      return this.o.ids.length > 1 ? `Duplicate ${this.o.ids.length} layers` : "Duplicate";
    return this.o.ids.length > 1 ? `Move ${this.o.ids.length} layers` : "Move";
  }

  async up(): Promise<void> {
    if (this.pending) await this.pending;
    this.done = true;
    if (!this.moved) {
      if (this.o.onClick) this.o.onClick();
      else if (this.o.clickSelect) this.c.editor.select(this.o.clickSelect);
      return;
    }
    const select = this.duplicating
      ? this.o.ids.map((id) => this.dupIds.get(id)?.get(id)).filter((x): x is Id => !!x)
      : this.o.ids;
    const label =
      this.insertion && !this.duplicating && this.parent === this.insertion.parent
        ? "Reorder"
        : this.label();
    await this.c.commit(label, { select });
  }

  async cancel(): Promise<void> {
    this.done = true;
    if (this.moved) await this.c.cancelPreview();
  }

  draw(p: Painter): void {
    const design = this.c.design;
    if (!design) return;
    if (this.c.dropTarget) drawDropTarget(p, design, this.c.dropTarget);
    if (this.insertion && this.moved) {
      const [a, b] = this.insertion.line;
      p.line(a, b, p.theme.selection, 2.5);
    }
  }
}
