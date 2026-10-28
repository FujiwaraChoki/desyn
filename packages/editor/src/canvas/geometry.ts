import { getNode, isAncestor, pageOf, parentChain, worldTransform } from "@desyn/doc-ops";
import type { Design, Id, Node } from "@desyn/schema";
import {
  type Obb,
  obbAabb,
  obbFromRect,
  obbRotation,
  type Rect,
  rotatedBounds,
  unionRect,
} from "./math.ts";

/**
 * Node geometry in page space, read from the document (the engine's derived values are persisted on the
 * nodes, so boxes here match what the engine draws). Used for overlays, handles and gesture math, which must
 * stay synchronous at frame rate.
 */

/** The node's box in page coordinates (null for unknown ids, the root and pages). */
export function nodeObb(design: Design, id: Id): Obb | null {
  const node = getNode(design, id);
  if (!node || node.type === "root" || node.type === "page") return null;
  return { m: worldTransform(design, id), w: node.width, h: node.height };
}

export function nodeAabb(design: Design, id: Id): Rect | null {
  const o = nodeObb(design, id);
  return o ? obbAabb(o) : null;
}

export interface SelectionBox {
  /** Axis-aligned bounds of everything selected. */
  aabb: Rect;
  /** The box handles attach to: the node's own box for one node, the shared rotated frame when all nodes share
   * a rotation, otherwise `aabb`. */
  obb: Obb;
  rotation: number;
}

/** Selection bounds with the same rules as the engine's `handles`. */
export function selectionBox(design: Design, ids: readonly Id[]): SelectionBox | null {
  const boxes = ids.map((id) => nodeObb(design, id)).filter((b): b is Obb => b !== null);
  const first = boxes[0];
  if (!first) return null;
  const aabb = unionRect(boxes.map(obbAabb)) as Rect;
  if (boxes.length === 1) return { aabb, obb: first, rotation: obbRotation(first) };
  const rot = obbRotation(first);
  const same = boxes.every((b) => {
    const diff = (((obbRotation(b) - rot) % 360) + 360) % 360;
    return diff < 1e-6 || 360 - diff < 1e-6;
  });
  if (!same || Math.abs(rot) < 1e-9) return { aabb, obb: obbFromRect(aabb), rotation: 0 };
  const obb = rotatedBounds(boxes, rot);
  return obb ? { aabb, obb, rotation: rot } : { aabb, obb: obbFromRect(aabb), rotation: 0 };
}

const CONTAINER_TYPES: ReadonlySet<string> = new Set(["frame", "group", "boolean", "page"]);

export function isContainerNode(node: Node | undefined): node is Node & { children: Id[] } {
  return !!node && CONTAINER_TYPES.has(node.type) && "children" in node;
}

/** Ancestors of `id` up to (excluding) its page, nearest first. */
export function ancestorsBelowPage(design: Design, id: Id): Node[] {
  return parentChain(design, id).filter((n) => n.type !== "page" && n.type !== "root");
}

/** Whether a node or any ancestor is locked or hidden (such layers cannot be picked on the canvas). */
export function isInteractive(design: Design, id: Id): boolean {
  const node = getNode(design, id);
  if (!node?.visible || node.locked) return false;
  return ancestorsBelowPage(design, id).every((n) => n.visible && !n.locked);
}

/** The page a node lives on (its own id for pages). */
export function pageIdOf(design: Design, id: Id): Id | null {
  const node = getNode(design, id);
  if (!node) return null;
  if (node.type === "page") return node.id;
  return pageOf(design, id)?.id ?? null;
}

/** True when `id` is `ancestor` or below it. */
export function isSelfOrDescendant(design: Design, ancestor: Id, id: Id): boolean {
  return ancestor === id || isAncestor(design, ancestor, id);
}

/** Frame with an auto layout (children are positioned by the engine). */
export function autoLayoutOf(node: Node | undefined) {
  if (node?.type !== "frame" || !node.layout) return null;
  return node.layout;
}
