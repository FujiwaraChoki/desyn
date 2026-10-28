// Page builders: add, duplicate, delete, reorder, resize.
import {
  createPage,
  type Design,
  type Fill,
  getPreset,
  type Id,
  newId,
  type PagePreset,
  ROOT_ID,
  type Transaction,
  type Unit,
} from "@desyn/schema";
import { Builder } from "./builder";
import { reorderMoves } from "./order";
import { scaledProps } from "./scale";
import { childIds, cloneSubtree, descendants, getNode, pages, zIndex } from "./tree";
import type { TxOptions } from "./tx";
import { DocOpsError, roundGeom } from "./util";

export interface AddPageOptions extends TxOptions {
  pageId?: Id;
  /** Insert position among pages (default: after the last page). */
  index?: number;
  name?: string;
  /** Size from a preset (id or object); otherwise width/height; otherwise the reference page's size. */
  preset?: string | PagePreset;
  width?: number;
  height?: number;
  unit?: Unit;
  background?: Fill[];
  /** Page whose size, unit and background are copied when not given (default: the last page). */
  like?: Id;
}

/** Adds an empty page. */
export function addPage(design: Design, options: AddPageOptions = {}): Transaction {
  const all = pages(design);
  const ref = options.like ? getNode(design, options.like) : all[all.length - 1];
  if (options.like && ref?.type !== "page")
    throw new DocOpsError(`addPage: "${options.like}" is not a page`);
  const preset = typeof options.preset === "string" ? getPreset(options.preset) : options.preset;
  if (options.preset !== undefined && !preset)
    throw new DocOpsError(`addPage: unknown preset "${String(options.preset)}"`);
  const refPage = ref?.type === "page" ? ref : undefined;
  const page = createPage({
    id: options.pageId ?? newId(),
    name: options.name ?? `Page ${all.length + 1}`,
    width: options.width ?? preset?.width ?? refPage?.width ?? 1080,
    height: options.height ?? preset?.height ?? refPage?.height ?? 1080,
    unit: options.unit ?? preset?.unit ?? refPage?.unit ?? "px",
    bleed: preset?.bleed ?? refPage?.bleed ?? 0,
    background: options.background ?? refPage?.background ?? [{ type: "solid", color: "#ffffff" }],
  });
  const b = new Builder(design);
  const index = options.index ?? all.length;
  b.push({ op: "create", nodes: [page], parent: ROOT_ID, index });
  return b.build("Add page", options);
}

/** Duplicates a page (fresh ids) right after it. */
export function duplicatePage(
  design: Design,
  pageId: Id,
  options: TxOptions & { name?: string } = {},
): Transaction {
  const page = getNode(design, pageId);
  if (page?.type !== "page") throw new DocOpsError(`duplicatePage: "${pageId}" is not a page`);
  const b = new Builder(design);
  const { op } = cloneSubtree(design, pageId, {
    index: zIndex(design, pageId) + 1,
    name: options.name ?? `${page.name} copy`,
  });
  b.push(op);
  return b.build("Duplicate page", options);
}

/** Deletes a page; the last remaining page cannot be deleted. */
export function deletePage(design: Design, pageId: Id, options: TxOptions = {}): Transaction {
  if (getNode(design, pageId)?.type !== "page")
    throw new DocOpsError(`deletePage: "${pageId}" is not a page`);
  if (pages(design).length <= 1)
    throw new DocOpsError("deletePage: a design keeps at least one page");
  const b = new Builder(design);
  b.push({ op: "delete", id: pageId });
  return b.build("Delete page", options);
}

/** Reorders pages to `order` (a permutation of the current page ids). */
export function reorderPages(design: Design, order: Id[], options: TxOptions = {}): Transaction {
  const current = childIds(design, ROOT_ID);
  if (order.length !== current.length || !current.every((id) => order.includes(id))) {
    throw new DocOpsError("reorderPages: order must list every page exactly once");
  }
  const b = new Builder(design);
  for (const move of reorderMoves(ROOT_ID, current, order)) b.push(move);
  return b.build("Reorder pages", options);
}

/** Moves one page to `index` (final position). */
export function movePage(
  design: Design,
  pageId: Id,
  index: number,
  options: TxOptions = {},
): Transaction {
  const current = childIds(design, ROOT_ID);
  if (!current.includes(pageId)) throw new DocOpsError(`movePage: "${pageId}" is not a page`);
  const order = current.filter((id) => id !== pageId);
  order.splice(Math.max(0, Math.min(index, order.length)), 0, pageId);
  return reorderPages(design, order, { label: "Move page", ...options });
}

/**
 * How content follows a page resize:
 * - "none": only the page size changes;
 * - "center": content keeps its size and stays centered;
 * - "scale": content scales uniformly to fit (contain) and is centered;
 * - "fill": content scales uniformly to cover and is centered (may crop);
 * - "stretch": positions and sizes scale per axis; font sizes, strokes and radii scale by min(sx, sy).
 */
export type ResizeStrategy = "none" | "center" | "scale" | "fill" | "stretch";

export interface ResizePageOptions extends TxOptions {
  strategy?: ResizeStrategy;
  unit?: Unit;
}

/** Resizes a page and adapts its content with a scale strategy (default "scale"). */
export function resizePage(
  design: Design,
  pageId: Id,
  size: { width: number; height: number },
  options: ResizePageOptions = {},
): Transaction {
  const page = getNode(design, pageId);
  if (page?.type !== "page") throw new DocOpsError(`resizePage: "${pageId}" is not a page`);
  if (!(size.width > 0 && size.height > 0))
    throw new DocOpsError("resizePage: size must be positive");
  const strategy = options.strategy ?? "scale";
  const b = new Builder(design);
  const W = page.width;
  const H = page.height;
  const pageSet: Record<string, unknown> = { width: size.width, height: size.height };
  if (options.unit) pageSet.unit = options.unit;
  const canScale = W > 0 && H > 0;

  if (strategy !== "none" && canScale) {
    let sx = size.width / W;
    let sy = size.height / H;
    if (strategy === "scale" || strategy === "fill") {
      const s = strategy === "scale" ? Math.min(sx, sy) : Math.max(sx, sy);
      sx = s;
      sy = s;
    }
    if (strategy === "center") {
      sx = 1;
      sy = 1;
    }
    const k = Math.min(sx, sy);
    const ox = strategy === "stretch" ? 0 : (size.width - W * sx) / 2;
    const oy = strategy === "stretch" ? 0 : (size.height - H * sy) / 2;
    const top = new Set(childIds(design, pageId));
    for (const node of descendants(design, pageId)) {
      if (strategy === "center") {
        if (top.has(node.id))
          b.update(node.id, { x: roundGeom(node.x + ox), y: roundGeom(node.y + oy) });
        continue;
      }
      const set = scaledProps(node, sx, sy, k);
      if (top.has(node.id)) {
        set.x = roundGeom(node.x * sx + ox);
        set.y = roundGeom(node.y * sy + oy);
      }
      b.update(node.id, set);
    }
    if (page.guides) {
      pageSet.guides = page.guides.map((g) => ({
        ...g,
        pos: roundGeom(g.axis === "x" ? g.pos * sx + ox : g.pos * sy + oy),
      }));
    }
    if (page.grid) {
      pageSet.grid = {
        ...page.grid,
        gutter: roundGeom(page.grid.gutter * k),
        margin: roundGeom(page.grid.margin * k),
        ...(page.grid.baseline !== undefined
          ? { baseline: roundGeom(page.grid.baseline * k) }
          : {}),
      };
    }
  }
  b.update(pageId, pageSet);
  return b.build("Resize page", options);
}
