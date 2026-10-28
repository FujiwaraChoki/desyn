// Smart resize ("magic resize"): adapts a page to a new size using roles, constraints and layout structure instead
// of plain scaling. Backdrops cover the new page, edge-anchored elements (logos, footers) keep their corners,
// explicit constraints are honoured, text re-flows to the new width, and side-by-side layouts restack when the
// orientation flips (and vice versa).

import {
  approxBounds,
  childIds,
  descendants,
  getNode,
  type Rect,
  scaledProps,
} from "@desyn/doc-ops";
import type { Design, Id, Node, Op, TextNode } from "@desyn/schema";
import type { MeasureItem, MeasureResult } from "../host";
import { coverCrop } from "./crop";

export interface ReflowOptions {
  /** Real text measurement (host.measure); boxes are re-measured after font scaling. */
  measure: (items: MeasureItem[]) => Promise<MeasureResult[]>;
  /** Minimum margin as a fraction of the new short side (default 0.05). */
  margin?: number;
}

export interface ReflowResult {
  ops: Op[];
  layout: "anchored" | "restacked-vertical" | "restacked-horizontal";
  scale: number;
}

const IMAGE_ROLES = new Set(["photo", "hero", "product", "illustration", "avatar"]);
const r2 = (n: number) => Math.round(n * 100) / 100;

interface Item {
  node: Node;
  box: Rect;
  backdrop: boolean;
}

function isImageLike(n: Node): boolean {
  return (
    n.type === "image" || n.type === "video" || n.type === "svg" || IMAGE_ROLES.has(n.role ?? "")
  );
}

/** Clusters items into columns by horizontal overlap (or rows by vertical overlap). */
function clusters(items: Item[], axis: "x" | "y"): Item[][] {
  const sorted = [...items].sort((a, b) => (axis === "x" ? a.box.x - b.box.x : a.box.y - b.box.y));
  const out: { start: number; end: number; items: Item[] }[] = [];
  for (const it of sorted) {
    const s = axis === "x" ? it.box.x : it.box.y;
    const e = s + (axis === "x" ? it.box.width : it.box.height);
    const last = out[out.length - 1];
    if (last && s < last.end - 1) {
      last.end = Math.max(last.end, e);
      last.items.push(it);
    } else {
      out.push({ start: s, end: e, items: [it] });
    }
  }
  return out.map((c) => c.items);
}

function unionBox(items: Item[]): Rect {
  const x = Math.min(...items.map((i) => i.box.x));
  const y = Math.min(...items.map((i) => i.box.y));
  return {
    x,
    y,
    width: Math.max(...items.map((i) => i.box.x + i.box.width)) - x,
    height: Math.max(...items.map((i) => i.box.y + i.box.height)) - y,
  };
}

interface Placement {
  x: number;
  y: number;
  scale: number;
  /** Text only: new wrap width. */
  width?: number;
}

export async function reflowPage(
  design: Design,
  pageId: Id,
  target: { width: number; height: number },
  options: ReflowOptions,
): Promise<ReflowResult> {
  const page = getNode(design, pageId);
  if (page?.type !== "page") throw new Error(`"${pageId}" is not a page`);
  const W = target.width;
  const H = target.height;
  const w = page.width;
  const h = page.height;
  const sx = W / w;
  const sy = H / h;
  const k = Math.min(sx, sy);
  const marginNew = Math.round(Math.min(W, H) * (options.margin ?? 0.05));
  const items: Item[] = childIds(design, pageId).map((id) => {
    const node = getNode(design, id) as Node;
    const box = approxBounds(design, id) as Rect;
    const backdrop =
      node.role === "background" || (box.width >= w * 0.85 && box.height >= h * 0.85);
    return { node, box, backdrop };
  });
  const content = items.filter((i) => !i.backdrop && i.node.visible);
  const placements = new Map<Id, Placement>();
  let layout: ReflowResult["layout"] = "anchored";

  const srcLandscape = w > h * 1.15;
  const srcPortrait = h > w * 1.15;
  const dstLandscape = W > H * 1.15;
  const dstPortrait = H > W * 1.15;
  const cols = clusters(content, "x");
  const rows = clusters(content, "y");

  const placeBlock = (block: Item[], area: Rect, align: "center" | "start") => {
    const b = unionBox(block);
    const s = Math.min(area.width / b.width, area.height / b.height);
    const ox = area.x + (area.width - b.width * s) / 2;
    const oy = align === "center" ? area.y + (area.height - b.height * s) / 2 : area.y;
    for (const it of block)
      placements.set(it.node.id, {
        x: ox + (it.box.x - b.x) * s,
        y: oy + (it.box.y - b.y) * s,
        scale: s,
      });
    return s;
  };

  if (
    (srcLandscape || !srcPortrait) &&
    dstPortrait &&
    cols.length === 2 &&
    cols.some((c) => c.some((i) => isImageLike(i.node)))
  ) {
    // Side-by-side -> stacked: visual block on top, text block below.
    const [a, b] = cols as [Item[], Item[]];
    const visualFirst = a.some((i) => isImageLike(i.node)) ? [a, b] : [b, a];
    const inner = {
      x: marginNew,
      y: marginNew,
      width: W - 2 * marginNew,
      height: H - 2 * marginNew,
    };
    const gap = Math.round(marginNew * 0.6);
    const vb = unionBox(visualFirst[0] as Item[]);
    const tb = unionBox(visualFirst[1] as Item[]);
    // Share the height in proportion to each block's height at full width.
    const hv = (vb.height * inner.width) / vb.width;
    const ht = (tb.height * inner.width) / tb.width;
    const fit = Math.min(1, (inner.height - gap) / (hv + ht));
    placeBlock(
      visualFirst[0] as Item[],
      { x: inner.x, y: inner.y, width: inner.width, height: hv * fit },
      "start",
    );
    placeBlock(
      visualFirst[1] as Item[],
      {
        x: inner.x,
        y: inner.y + hv * fit + gap,
        width: inner.width,
        height: inner.height - hv * fit - gap,
      },
      "start",
    );
    layout = "restacked-vertical";
  } else if (
    (srcPortrait || !srcLandscape) &&
    dstLandscape &&
    rows.length >= 2 &&
    rows.some((r) => r.some((i) => isImageLike(i.node)))
  ) {
    // Stacked -> side-by-side: visual rows on the left, remaining rows on the right.
    const visual = rows.filter((r) => r.some((i) => isImageLike(i.node))).flat();
    const text = rows.filter((r) => !r.some((i) => isImageLike(i.node))).flat();
    if (text.length > 0) {
      const inner = {
        x: marginNew,
        y: marginNew,
        width: W - 2 * marginNew,
        height: H - 2 * marginNew,
      };
      const gap = Math.round(marginNew * 0.8);
      const half = (inner.width - gap) / 2;
      placeBlock(visual, { x: inner.x, y: inner.y, width: half, height: inner.height }, "center");
      placeBlock(
        text,
        { x: inner.x + half + gap, y: inner.y, width: half, height: inner.height },
        "center",
      );
      layout = "restacked-horizontal";
    }
  }

  if (layout === "anchored") {
    const edge = 0.12;
    for (const it of content) {
      const n = it.node;
      const b = it.box;
      const c = n.constraints;
      let nx: number;
      let ny: number;
      let s = k;
      const textWidthScale = n.type === "text" ? sx : undefined;
      // Horizontal
      const leftGap = b.x;
      const rightGap = w - (b.x + b.width);
      if (c?.h === "stretch" || c?.h === "scale") {
        s = c.h === "scale" ? Math.min(sx, sy) : k;
        nx = b.x * sx;
      } else if (c?.h === "right" || (!c && rightGap < w * edge && rightGap < leftGap)) {
        nx = W - rightGap * k - b.width * s;
      } else if (c?.h === "left" || (!c && leftGap < w * edge && leftGap <= rightGap)) {
        nx = leftGap * k;
      } else {
        nx = ((b.x + b.width / 2) / w) * W - (b.width * s) / 2;
      }
      // Vertical
      const topGap = b.y;
      const bottomGap = h - (b.y + b.height);
      if (c?.v === "stretch" || c?.v === "scale") {
        ny = b.y * sy;
      } else if (c?.v === "bottom" || (!c && bottomGap < h * edge && bottomGap < topGap)) {
        ny = H - bottomGap * k - b.height * s;
      } else if (c?.v === "top" || (!c && topGap < h * edge && topGap <= bottomGap)) {
        ny = topGap * k;
      } else {
        ny = ((b.y + b.height / 2) / h) * H - (b.height * s) / 2;
      }
      const placement: Placement = { x: nx, y: ny, scale: s };
      if (textWidthScale !== undefined && n.type === "text" && n.autoResize !== "width") {
        // Text re-flows to the new width but never beyond the margins.
        placement.width = Math.min(n.width * textWidthScale, W - 2 * marginNew);
        if (c?.h !== "left" && c?.h !== "right") {
          const center = ((b.x + b.width / 2) / w) * W;
          placement.x =
            leftGap < w * edge
              ? leftGap * k
              : rightGap < w * edge
                ? W - rightGap * k - placement.width
                : center - placement.width / 2;
        }
      }
      placements.set(n.id, placement);
    }
  }

  const ops: Op[] = [{ op: "update", id: pageId, set: { width: W, height: H } }];
  // Backdrops cover the new page.
  for (const it of items.filter((i) => i.backdrop)) {
    const n = it.node;
    const set: Record<string, unknown> = { x: 0, y: 0, width: W, height: H };
    if (n.type === "image") {
      const asset = design.assets[n.assetId];
      set.crop = coverCrop(asset?.width, asset?.height, W, H);
      set.fit = "crop";
    }
    ops.push({ op: "update", id: n.id, set });
    const s = Math.max(W / Math.max(n.width, 1), H / Math.max(n.height, 1));
    for (const d of descendants(design, n.id))
      ops.push({ op: "update", id: d.id, set: scaledProps(d, s, s, s) });
  }
  // Content: position + uniform scale of the subtree; text re-measured.
  const textMeasure: { node: TextNode; set: Record<string, unknown>; width: number }[] = [];
  for (const it of content) {
    const p = placements.get(it.node.id);
    if (!p) continue;
    const n = it.node;
    const set = scaledProps(n, p.scale, p.scale, p.scale, false);
    set.x = r2(p.x + (n.x - it.box.x) * p.scale);
    set.y = r2(p.y + (n.y - it.box.y) * p.scale);
    if (n.type === "text") {
      const width = p.width ?? n.width * p.scale;
      set.width = r2(width);
      textMeasure.push({ node: n, set, width });
    }
    ops.push({ op: "update", id: n.id, set });
    for (const d of descendants(design, n.id))
      ops.push({ op: "update", id: d.id, set: scaledProps(d, p.scale, p.scale, p.scale) });
  }
  if (textMeasure.length > 0) {
    const results = await options.measure(
      textMeasure.map(({ node, set, width }) => ({
        text: (set.runs as TextNode["runs"] | undefined) ?? node.runs,
        style: (set.style as TextNode["style"] | undefined) ?? node.style,
        paragraph: node.paragraph,
        ...(node.autoResize === "width" ? {} : { width }),
      })),
    );
    textMeasure.forEach(({ node, set }, i) => {
      const m = results[i];
      if (!m) return;
      if (node.autoResize === "width") set.width = Math.ceil(m.w);
      set.height = Math.ceil(m.h);
    });
  }
  // Keep content inside the page.
  for (const op of ops) {
    if (op.op !== "update" || !op.set || op.id === pageId) continue;
    const n = getNode(design, op.id);
    if (!n || n.parent !== pageId || items.find((i) => i.node.id === op.id)?.backdrop) continue;
    const width = (op.set.width as number | undefined) ?? n.width;
    const height = (op.set.height as number | undefined) ?? n.height;
    const x = op.set.x as number;
    const y = op.set.y as number;
    if (typeof x === "number") op.set.x = r2(Math.min(Math.max(x, 0), Math.max(0, W - width)));
    if (typeof y === "number") op.set.y = r2(Math.min(Math.max(y, 0), Math.max(0, H - height)));
  }
  if (page.guides)
    ops[0] = {
      op: "update",
      id: pageId,
      set: {
        width: W,
        height: H,
        guides: page.guides.map((g) => ({
          ...g,
          pos: r2(g.axis === "x" ? g.pos * sx : g.pos * sy),
        })),
      },
    };
  return { ops, layout, scale: k };
}
