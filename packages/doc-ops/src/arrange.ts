// Arrangement builders: align, distribute, tidy into a grid, match size, z-order.
import type { Design, Id, Transaction } from "@desyn/schema";
import { Builder } from "./builder";
import { approxBounds, type Rect, unionRects } from "./geometry";
import { reorderMoves } from "./order";
import { childIds, getNode, pageOf, topLevelSelection } from "./tree";
import type { TxOptions } from "./tx";
import { DocOpsError, roundGeom } from "./util";

export type Alignment = "left" | "center" | "right" | "top" | "middle" | "bottom";

/** Movable selection: top-level, existing, not pages, not locked. */
function movable(design: Design, ids: Id[]): Id[] {
  return topLevelSelection(design, ids).filter((id) => {
    const n = getNode(design, id);
    return n && n.type !== "page" && !n.locked;
  });
}

function pageRect(design: Design, id: Id): Rect {
  const page = pageOf(design, id);
  if (!page) throw new DocOpsError(`node "${id}" is not on a page`);
  return { x: 0, y: 0, width: page.width, height: page.height };
}

function boundsOf(design: Design, id: Id): Rect {
  return approxBounds(design, id) as Rect;
}

export interface AlignOptions extends TxOptions {
  /** Align to the selection's bounds (default) or to the page. A single node always aligns to its page. */
  to?: "selection" | "page";
}

/** Aligns nodes' rotated bounds to an edge or center of the selection or page. Locked nodes stay put. */
export function alignNodes(
  design: Design,
  ids: Id[],
  alignment: Alignment,
  options: AlignOptions = {},
): Transaction {
  const sel = movable(design, ids);
  const b = new Builder(design);
  const toPage = options.to === "page" || sel.length === 1;
  const selection = unionRects(sel.map((id) => boundsOf(design, id)));
  for (const id of sel) {
    const box = boundsOf(design, id);
    const t = toPage ? pageRect(design, id) : (selection as Rect);
    let dx = 0;
    let dy = 0;
    switch (alignment) {
      case "left":
        dx = t.x - box.x;
        break;
      case "center":
        dx = t.x + t.width / 2 - (box.x + box.width / 2);
        break;
      case "right":
        dx = t.x + t.width - (box.x + box.width);
        break;
      case "top":
        dy = t.y - box.y;
        break;
      case "middle":
        dy = t.y + t.height / 2 - (box.y + box.height / 2);
        break;
      case "bottom":
        dy = t.y + t.height - (box.y + box.height);
        break;
    }
    b.translateInPage(id, dx, dy);
  }
  b.refitGroups(sel);
  return b.build(`Align ${alignment}`, options);
}

export type Axis = "horizontal" | "vertical";

export interface DistributeOptions extends TxOptions {
  /** Fixed gap in px between neighbours. Omitted: spread evenly between the outermost nodes (needs >= 3). */
  spacing?: number;
}

/** Distributes nodes along an axis by their rotated bounds. */
export function distribute(
  design: Design,
  ids: Id[],
  axis: Axis,
  options: DistributeOptions = {},
): Transaction {
  const sel = movable(design, ids);
  const b = new Builder(design);
  const minimum = options.spacing === undefined ? 3 : 2;
  if (sel.length < minimum) return b.build("Distribute", options);
  const horizontal = axis === "horizontal";
  const items = sel
    .map((id) => ({ id, box: boundsOf(design, id) }))
    .sort((p, q) => (horizontal ? p.box.x - q.box.x : p.box.y - q.box.y));
  const start = (r: Rect) => (horizontal ? r.x : r.y);
  const size = (r: Rect) => (horizontal ? r.width : r.height);
  const first = items[0] as (typeof items)[number];
  const last = items[items.length - 1] as (typeof items)[number];
  const gap =
    options.spacing ??
    (start(last.box) +
      size(last.box) -
      start(first.box) -
      items.reduce((s, it) => s + size(it.box), 0)) /
      (items.length - 1);
  let cursor = start(first.box);
  for (const it of items) {
    const delta = cursor - start(it.box);
    b.translateInPage(it.id, horizontal ? delta : 0, horizontal ? 0 : delta);
    cursor += size(it.box) + gap;
  }
  b.refitGroups(sel);
  return b.build(horizontal ? "Distribute horizontally" : "Distribute vertically", options);
}

export interface TidyOptions extends TxOptions {
  /** Columns; default ceil(sqrt(n)). */
  columns?: number;
  /** Gap between cells in px; default 24. */
  gap?: number;
}

/** Arranges nodes into a grid in reading order, starting at the selection's top-left, one max-size cell each. */
export function tidyGrid(design: Design, ids: Id[], options: TidyOptions = {}): Transaction {
  const sel = movable(design, ids);
  const b = new Builder(design);
  if (sel.length < 2) return b.build("Tidy up", options);
  const items = sel.map((id) => ({ id, box: boundsOf(design, id) }));
  const cellW = Math.max(...items.map((i) => i.box.width));
  const cellH = Math.max(...items.map((i) => i.box.height));
  // Reading order: rows by vertical center (half a cell of tolerance), then left to right.
  items.sort((p, q) => {
    const dy = p.box.y + p.box.height / 2 - (q.box.y + q.box.height / 2);
    if (Math.abs(dy) > cellH / 2) return dy;
    return p.box.x - q.box.x;
  });
  const columns = Math.max(1, Math.floor(options.columns ?? Math.ceil(Math.sqrt(items.length))));
  const gap = options.gap ?? 24;
  const origin = unionRects(items.map((i) => i.box)) as Rect;
  items.forEach((it, i) => {
    const col = i % columns;
    const row = Math.floor(i / columns);
    const tx = origin.x + col * (cellW + gap) + (cellW - it.box.width) / 2;
    const ty = origin.y + row * (cellH + gap) + (cellH - it.box.height) / 2;
    b.translateInPage(it.id, tx - it.box.x, ty - it.box.y);
  });
  b.refitGroups(sel);
  return b.build("Tidy up", options);
}

export interface MatchSizeOptions extends TxOptions {
  dimension?: "width" | "height" | "both";
  /** Reference: the first / last selected (document order), the largest or smallest, or an explicit node id. */
  to?: "first" | "last" | "largest" | "smallest" | Id;
}

/** Gives every selected node the reference node's width and/or height (keeping each node's center). */
export function matchSize(design: Design, ids: Id[], options: MatchSizeOptions = {}): Transaction {
  const sel = movable(design, ids);
  const b = new Builder(design);
  if (sel.length === 0) return b.build("Match size", options);
  const nodes = sel.map((id) => b.node(id));
  const area = (n: (typeof nodes)[number]) => n.width * n.height;
  const to = options.to ?? "first";
  let ref = nodes[0] as (typeof nodes)[number];
  if (to === "last") ref = nodes[nodes.length - 1] as typeof ref;
  else if (to === "largest") ref = nodes.reduce((m, n) => (area(n) > area(m) ? n : m));
  else if (to === "smallest") ref = nodes.reduce((m, n) => (area(n) < area(m) ? n : m));
  else if (to !== "first") {
    const explicit = getNode(design, to);
    if (!explicit) throw new DocOpsError(`matchSize: reference "${to}" does not exist`);
    ref = explicit;
  }
  const dim = options.dimension ?? "both";
  for (const n of nodes) {
    if (n.id === ref.id) continue;
    const width = dim === "height" ? n.width : ref.width;
    const height = dim === "width" || n.type === "line" ? n.height : ref.height;
    b.update(n.id, {
      x: roundGeom(n.x + (n.width - width) / 2),
      y: roundGeom(n.y + (n.height - height) / 2),
      width,
      height,
    });
  }
  b.refitGroups(sel);
  return b.build("Match size", options);
}

type Reorder = (order: Id[], selected: Set<Id>) => Id[];

function reorderSelection(
  design: Design,
  ids: Id[],
  fn: Reorder,
  label: string,
  options: TxOptions,
): Transaction {
  const sel = topLevelSelection(design, ids).filter((id) => getNode(design, id)?.type !== "page");
  const b = new Builder(design);
  const byParent = new Map<Id, Set<Id>>();
  for (const id of sel) {
    const parent = getNode(design, id)?.parent as Id;
    if (!byParent.has(parent)) byParent.set(parent, new Set());
    byParent.get(parent)?.add(id);
  }
  for (const [parent, selected] of byParent) {
    const current = childIds(design, parent);
    const target = fn(current, selected);
    for (const move of reorderMoves(parent, current, target)) b.push(move);
  }
  return b.build(label, options);
}

/** Moves each selected node one step up past its next unselected sibling. */
export function bringForward(design: Design, ids: Id[], options: TxOptions = {}): Transaction {
  return reorderSelection(
    design,
    ids,
    (order, sel) => {
      const out = order.slice();
      for (let i = out.length - 2; i >= 0; i--) {
        if (sel.has(out[i] as Id) && !sel.has(out[i + 1] as Id)) {
          [out[i], out[i + 1]] = [out[i + 1] as Id, out[i] as Id];
        }
      }
      return out;
    },
    "Bring forward",
    options,
  );
}

/** Moves each selected node one step down past its previous unselected sibling. */
export function sendBackward(design: Design, ids: Id[], options: TxOptions = {}): Transaction {
  return reorderSelection(
    design,
    ids,
    (order, sel) => {
      const out = order.slice();
      for (let i = 1; i < out.length; i++) {
        if (sel.has(out[i] as Id) && !sel.has(out[i - 1] as Id)) {
          [out[i], out[i - 1]] = [out[i - 1] as Id, out[i] as Id];
        }
      }
      return out;
    },
    "Send backward",
    options,
  );
}

/** Moves the selection to the top of its parent(s), keeping its relative order. */
export function bringToFront(design: Design, ids: Id[], options: TxOptions = {}): Transaction {
  return reorderSelection(
    design,
    ids,
    (order, sel) => [...order.filter((id) => !sel.has(id)), ...order.filter((id) => sel.has(id))],
    "Bring to front",
    options,
  );
}

/** Moves the selection to the bottom of its parent(s), keeping its relative order. */
export function sendToBack(design: Design, ids: Id[], options: TxOptions = {}): Transaction {
  return reorderSelection(
    design,
    ids,
    (order, sel) => [...order.filter((id) => sel.has(id)), ...order.filter((id) => !sel.has(id))],
    "Send to back",
    options,
  );
}

/** Alias of bringToFront. */
export const toFront = bringToFront;
/** Alias of sendToBack. */
export const toBack = sendToBack;
