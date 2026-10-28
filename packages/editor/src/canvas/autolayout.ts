import { getNode, worldTransform } from "@desyn/doc-ops";
import type { Design, Id, Node } from "@desyn/schema";
import { autoLayoutOf, isContainerNode, isSelfOrDescendant, nodeObb } from "./geometry.ts";
import { apply, inv, obbContains, type Point } from "./math.ts";

/**
 * Auto-layout on the canvas: where a dragged layer lands among a layout frame's children (reorder by drag),
 * and which container a drag drops into (reparenting into frames).
 */

export interface Insertion {
  parent: Id;
  /** Final index among the parent's children after removing the moving layers. */
  index: number;
  /** Indicator line (page coordinates). */
  line: [Point, Point];
}

/**
 * Index at which layers dragged to `p` (page coordinates) land in an auto-layout frame, with the indicator
 * line drawn in the gap. Row / column layouts compare with sibling centers along the main axis; grids pick
 * the nearest sibling cell and insert before or after it.
 */
export function insertionIndex(
  design: Design,
  parentId: Id,
  moving: readonly Id[],
  p: Point,
): Insertion | null {
  const parent = getNode(design, parentId);
  const layout = autoLayoutOf(parent);
  if (!parent || !layout || !isContainerNode(parent)) return null;
  const m = worldTransform(design, parentId);
  const q = apply(inv(m), p);
  const siblings = parent.children
    .filter((id) => !moving.includes(id))
    .map((id) => getNode(design, id))
    .filter((n): n is Node => !!n && n.visible);
  const [pt, pr, pb, pl] = layout.padding;
  const toPage = (x: number, y: number) => apply(m, { x, y });
  if (siblings.length === 0) {
    const row = layout.mode !== "column";
    return {
      parent: parentId,
      index: 0,
      line: row
        ? [toPage(pl, pt), toPage(pl, parent.height - pb)]
        : [toPage(pl, pt), toPage(parent.width - pr, pt)],
    };
  }
  if (layout.mode === "grid") {
    let best = 0;
    let bestD = Number.POSITIVE_INFINITY;
    siblings.forEach((n, i) => {
      const d = Math.hypot(n.x + n.width / 2 - q.x, n.y + n.height / 2 - q.y);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    const n = siblings[best] as Node;
    const after = q.x > n.x + n.width / 2;
    const x = after ? n.x + n.width + (layout.gap ?? 0) / 2 : n.x - (layout.gap ?? 0) / 2;
    return {
      parent: parentId,
      index: parent.children.filter((id) => !moving.includes(id)).indexOf(n.id) + (after ? 1 : 0),
      line: [toPage(x, n.y), toPage(x, n.y + n.height)],
    };
  }
  const row = layout.mode === "row";
  const reverse = !!layout.reverse;
  // Visual order along the main axis.
  const visual = [...siblings].sort((a, b) => (row ? a.x - b.x : a.y - b.y));
  const center = (n: Node) => (row ? n.x + n.width / 2 : n.y + n.height / 2);
  const pos = row ? q.x : q.y;
  let k = visual.findIndex((n) => pos < center(n));
  if (k < 0) k = visual.length;
  const before = visual[k - 1];
  const next = visual[k];
  const gapPos =
    before && next
      ? row
        ? (before.x + before.width + next.x) / 2
        : (before.y + before.height + next.y) / 2
      : before
        ? row
          ? before.x + before.width + Math.min(layout.gap, 8) / 2
          : before.y + before.height + Math.min(layout.gap, 8) / 2
        : next
          ? row
            ? next.x - Math.min(layout.gap, 8) / 2
            : next.y - Math.min(layout.gap, 8) / 2
          : 0;
  const order = parent.children.filter((id) => !moving.includes(id));
  // Document order follows visual order unless reversed.
  let index: number;
  if (!reverse) index = next ? order.indexOf(next.id) : order.length;
  else index = before ? order.indexOf(before.id) : order.length;
  if (index < 0) index = order.length;
  const line: [Point, Point] = row
    ? [toPage(gapPos, pt), toPage(gapPos, parent.height - pb)]
    : [toPage(pl, gapPos), toPage(parent.width - pr, gapPos)];
  return { parent: parentId, index, line };
}

/**
 * The deepest frame under `p` that layers can be dropped into (not one of the moving layers or inside them,
 * visible and unlocked), else the page.
 */
export function dropContainerAt(design: Design, pageId: Id, p: Point, moving: readonly Id[]): Id {
  const visit = (containerId: Id): Id | null => {
    const container = getNode(design, containerId);
    if (!isContainerNode(container)) return null;
    for (let i = container.children.length - 1; i >= 0; i--) {
      const id = container.children[i] as Id;
      const node = getNode(design, id);
      if (!node?.visible || node.locked) continue;
      if (moving.some((m) => isSelfOrDescendant(design, m, id))) continue;
      if (node.type !== "frame") continue;
      const box = nodeObb(design, id);
      if (!box || !obbContains(box, p)) continue;
      return visit(id) ?? id;
    }
    return null;
  };
  return visit(pageId) ?? pageId;
}
