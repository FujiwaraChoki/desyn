import { Builder, decompose, getNode, worldTransform } from "@desyn/doc-ops";
import type { Color, Design, Id, Node, Op, PageNode } from "@desyn/schema";
import { mapPoints, pathBounds, type SubPath, serializeSubPaths } from "../tools/path-model.ts";
import { dropContainerAt } from "./autolayout.ts";
import { apply, IDENTITY, inv, mul, type Point, type Rect, translation } from "./math.ts";

/**
 * Helpers for tools that create layers: where a new layer goes (the frame under the pointer, else the page),
 * how a page-space rectangle maps into that parent, and a stroke / text color that reads on the page.
 */

const r4 = (v: number) => {
  const r = Math.round(v * 10000) / 10000;
  return Object.is(r, -0) ? 0 : r;
};

/** Container for a layer created at `p`: the deepest frame under it, else the page. */
export function creationParent(design: Design, pageId: Id, p: Point): Id {
  return dropContainerAt(design, pageId, p, []);
}

/** Placement of a page-space, axis-aligned rectangle inside `parent` (x, y, rotation in its coordinates). */
export function placeRect(
  design: Design,
  parent: Id,
  rect: Rect,
): { x: number; y: number; width: number; height: number; rotation: number } {
  const parentNode = getNode(design, parent);
  const pw = parentNode && parentNode.type !== "page" ? worldTransform(design, parent) : IDENTITY;
  const local = mul(inv(pw), translation(rect.x, rect.y));
  const p = decompose(local, rect.w, rect.h);
  return {
    x: r4(p.x),
    y: r4(p.y),
    width: r4(rect.w),
    height: r4(rect.h),
    rotation: r4(p.rotation),
  };
}

function luminance(hex: string): number {
  const m = /^#([0-9a-f]{6})/i.exec(hex);
  if (!m?.[1]) return 1;
  const n = Number.parseInt(m[1], 16);
  const ch = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * ch((n >> 16) & 255) + 0.7152 * ch((n >> 8) & 255) + 0.0722 * ch(n & 255);
}

/** Background color under a new layer: the parent frame's or page's top solid fill (white when unknown). */
export function backgroundAt(design: Design, parent: Id): string {
  let node: Node | undefined = getNode(design, parent);
  while (node) {
    const fills =
      node.type === "page"
        ? (node as PageNode).background
        : "fills" in node && Array.isArray(node.fills)
          ? node.fills
          : [];
    const top = [...fills].reverse().find((f) => f.visible !== false && f.type === "solid");
    const color = top && top.type === "solid" ? solidHex(design, top.color) : null;
    if (color) return color;
    if (node.type === "page" || !node.parent) break;
    node = getNode(design, node.parent);
  }
  return "#ffffff";
}

/** A solid fill's color as hex, resolving named color styles (`{ $style }`); null for variables. */
function solidHex(design: Design, color: unknown): string | null {
  if (typeof color === "string") return color;
  if (color && typeof color === "object" && "$style" in color) {
    const style = design.styles.colors[(color as { $style: string }).$style];
    return style?.value ?? null;
  }
  return null;
}

/** Ink that reads on the background (near-black on light, white on dark). */
export function inkFor(background: string): Color {
  return luminance(background) > 0.35 ? "#111111" : "#ffffff";
}

/** Ops creating a path layer from page-space subpaths (box fitted to the curves), in `parent`. */
export function createPathOps(
  design: Design,
  parent: Id,
  paths: SubPath[],
  node: Node & { type: "path" },
): Op[] {
  const parentNode = getNode(design, parent);
  const pw = parentNode && parentNode.type !== "page" ? worldTransform(design, parent) : IDENTITY;
  const pi = inv(pw);
  // Work in the parent's coordinates so the box is axis-aligned there.
  const local = mapPoints(paths, (p) => apply(pi, p));
  const b = pathBounds(local) ?? { x: 0, y: 0, w: 0, h: 0 };
  const shifted = mapPoints(local, (p) => ({ x: p.x - b.x, y: p.y - b.y }));
  const created: Node = {
    ...node,
    x: r4(b.x),
    y: r4(b.y),
    width: r4(b.w),
    height: r4(b.h),
    rotation: 0,
    paths: [{ d: serializeSubPaths(shifted), fillRule: "nonzero" }],
  } as Node;
  return [{ op: "create", nodes: [created], parent }];
}

/**
 * Ops writing edited subpaths (node-local, one list per `paths` entry) back to a path node: the box is refit to
 * the curves and the node moved so nothing shifts on the page.
 */
export function updatePathOps(design: Design, id: Id, entries: SubPath[][]): Op[] {
  const node = getNode(design, id);
  if (node?.type !== "path") return [];
  const b = pathBounds(entries.flat()) ?? { x: 0, y: 0, w: 0, h: 0 };
  const builder = new Builder(design);
  const world = worldTransform(design, id);
  const parentWorld = node.parent ? worldTransform(design, node.parent) : IDENTITY;
  // The new box starts at the curves' local origin: same rigid map (flips included), shifted.
  const nextWorld = mul(world, translation(b.x, b.y));
  const placement = decompose(mul(inv(parentWorld), nextWorld), b.w, b.h, node);
  builder.place(id, placement);
  builder.update(id, {
    width: r4(b.w),
    height: r4(b.h),
    paths: node.paths.map((p, i) => {
      const sp = entries[i];
      if (!sp) return p;
      return { ...p, d: serializeSubPaths(mapPoints(sp, (q) => ({ x: q.x - b.x, y: q.y - b.y }))) };
    }),
  });
  builder.refitGroups([id]);
  return builder.ops;
}
