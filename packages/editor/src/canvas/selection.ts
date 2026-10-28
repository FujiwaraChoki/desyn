import { getNode } from "@desyn/doc-ops";
import type { Design, Id, Node } from "@desyn/schema";
import { isContainerNode, isInteractive, nodeObb } from "./geometry.ts";
import { obbContains, obbIntersectsRect, type Point, type Rect, rectContainsObb } from "./math.ts";

/**
 * Selection rules of the canvas (Figma-like):
 *
 * - a click selects the layer at the current level: the page's top-level layer, the child of an entered
 *   container (`scopeId`), or a sibling of the current selection (selection context);
 * - cmd / ctrl + click selects the deepest layer under the pointer (deep select);
 * - a double click enters a group / frame (selects its child under the pointer);
 * - alt + click selects through: the next layer below the selected one at that point;
 * - marquee picks layers of the current level that touch (default) or are inside (alt) the rectangle; with
 *   cmd / ctrl it picks the deepest layers.
 */

export interface PickState {
  scopeId: Id | null;
  selection: readonly Id[];
}

/** Containers a double click can enter (their children become selectable). */
export function isEnterable(node: Node | undefined): boolean {
  return (
    !!node &&
    (node.type === "group" || node.type === "frame" || node.type === "boolean") &&
    "children" in node &&
    node.children.length > 0
  );
}

/**
 * The layer a click selects, from an engine hit path (page child first, deepest last). Null when nothing
 * selectable was hit.
 */
export function pickTarget(
  design: Design,
  path: readonly Id[],
  state: PickState,
  opts: { deep?: boolean } = {},
): Id | null {
  const ids = path.filter((id) => !!getNode(design, id));
  if (ids.length === 0) return null;
  if (opts.deep) return ids[ids.length - 1] ?? null;
  // Selection context: a sibling (or the selected layer itself) at the selection's level.
  const parents = new Set<Id>();
  for (const id of state.selection) {
    const n = getNode(design, id);
    const p = n?.parent ? getNode(design, n.parent) : undefined;
    if (p && p.type !== "page" && p.type !== "root") parents.add(p.id);
  }
  if (parents.size > 0) {
    for (let i = ids.length - 1; i >= 0; i--) {
      const id = ids[i] as Id;
      const parent = getNode(design, id)?.parent;
      if (parent && parents.has(parent)) return id;
    }
  }
  if (state.scopeId) {
    const k = ids.indexOf(state.scopeId);
    if (k >= 0) return ids[k + 1] ?? state.scopeId;
  }
  return ids[0] ?? null;
}

/**
 * Double click: the child of the clicked container under the pointer (one level deeper than `current`), or null
 * when `current` is not an enterable container on the path.
 */
export function enterTarget(design: Design, path: readonly Id[], current: Id): Id | null {
  const k = path.indexOf(current);
  if (k < 0 || !isEnterable(getNode(design, current))) return null;
  return path[k + 1] ?? null;
}

/** The container whose children are picked at the current level (scope, selection parent, else the page). */
export function levelContainer(design: Design, pageId: Id, state: PickState): Id {
  if (state.scopeId && getNode(design, state.scopeId)) return state.scopeId;
  const first = state.selection[0];
  const parent = first ? getNode(design, first)?.parent : null;
  if (parent && getNode(design, parent) && parent !== "root") return parent;
  return pageId;
}

function candidates(design: Design, container: Id, deep: boolean): Id[] {
  const node = getNode(design, container);
  if (!isContainerNode(node)) return [];
  const out: Id[] = [];
  for (const id of node.children) {
    const child = getNode(design, id);
    if (!child?.visible || child.locked || child.mask) continue;
    if (deep && isContainerNode(child) && child.type !== "boolean" && child.children.length > 0) {
      out.push(...candidates(design, id, true));
    } else {
      out.push(id);
    }
  }
  return out;
}

/** Layers selected by a marquee rectangle (page coordinates), back to front. */
export function marqueeSelect(
  design: Design,
  container: Id,
  rect: Rect,
  opts: { contain?: boolean; deep?: boolean } = {},
): Id[] {
  return candidates(design, container, !!opts.deep).filter((id) => {
    const box = nodeObb(design, id);
    if (!box) return false;
    return opts.contain ? rectContainsObb(rect, box) : obbIntersectsRect(box, rect);
  });
}

/** Layers of a container whose boxes contain `p`, topmost first (for select-through). */
export function layersAt(design: Design, container: Id, p: Point, slop = 0): Id[] {
  return candidates(design, container, false)
    .filter((id) => {
      const box = nodeObb(design, id);
      return !!box && obbContains(box, p, slop);
    })
    .reverse();
}

/** Select-through: the layer below `current` at the point (wrapping around), or the topmost one. */
export function selectThrough(stack: readonly Id[], current: Id | undefined): Id | null {
  if (stack.length === 0) return null;
  const i = current ? stack.indexOf(current) : -1;
  return stack[(i + 1) % stack.length] ?? null;
}

/** Whether a layer can be picked on the canvas (visible, unlocked, on an unlocked branch). */
export function isPickable(design: Design, id: Id): boolean {
  return isInteractive(design, id);
}
