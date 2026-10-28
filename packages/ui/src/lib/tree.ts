/**
 * Pure tree logic behind `<Tree>`: flattening for virtualization, drop target resolution for drag
 * and drop, and an immutable move helper. Kept separate so it is unit tested without a DOM.
 */

/** A node in a nested tree. `children` present (even empty) means the node can contain others. */
export interface TreeNode<T = unknown> {
  id: string;
  children?: TreeNode<T>[];
  data?: T;
}

/** One visible row. */
export interface FlatTreeItem<T = unknown> {
  id: string;
  node: TreeNode<T>;
  depth: number;
  parentId: string | null;
  /** Index among its siblings. */
  index: number;
  /** Number of siblings including itself (aria-setsize). */
  siblingCount: number;
  hasChildren: boolean;
  isExpanded: boolean;
}

/** Depth-first list of visible rows: children appear only under expanded parents. */
export function flattenTree<T>(
  nodes: TreeNode<T>[],
  expanded: ReadonlySet<string>,
  depth = 0,
  parentId: string | null = null,
  out: FlatTreeItem<T>[] = [],
): FlatTreeItem<T>[] {
  nodes.forEach((node, index) => {
    const hasChildren = (node.children?.length ?? 0) > 0;
    const isExpanded = hasChildren && expanded.has(node.id);
    out.push({
      id: node.id,
      node,
      depth,
      parentId,
      index,
      siblingCount: nodes.length,
      hasChildren,
      isExpanded,
    });
    if (isExpanded && node.children) flattenTree(node.children, expanded, depth + 1, node.id, out);
  });
  return out;
}

/** Maps every id to its node and parent id for O(1) lookups. */
export function indexTree<T>(
  nodes: TreeNode<T>[],
): Map<string, { node: TreeNode<T>; parentId: string | null }> {
  const map = new Map<string, { node: TreeNode<T>; parentId: string | null }>();
  const walk = (list: TreeNode<T>[], parentId: string | null) => {
    for (const node of list) {
      map.set(node.id, { node, parentId });
      if (node.children) walk(node.children, node.id);
    }
  };
  walk(nodes, null);
  return map;
}

/** True if `id` is `ancestorId` or lies anywhere beneath it. */
export function isSelfOrDescendant<T>(
  index: Map<string, { node: TreeNode<T>; parentId: string | null }>,
  id: string | null,
  ancestorId: string,
): boolean {
  let cur = id;
  while (cur !== null) {
    if (cur === ancestorId) return true;
    cur = index.get(cur)?.parentId ?? null;
  }
  return false;
}

/** All ids in the tree in depth-first order. */
export function allIds<T>(nodes: TreeNode<T>[]): string[] {
  const out: string[] = [];
  const walk = (list: TreeNode<T>[]) => {
    for (const n of list) {
      out.push(n.id);
      if (n.children) walk(n.children);
    }
  };
  walk(nodes);
  return out;
}

export type DropPosition = "before" | "after" | "inside";

/** Where a drop would land. `index` counts siblings after the dragged items are removed. */
export interface DropTarget {
  /** The row the drop is relative to (for "after" drops that outdent, the ancestor row). */
  targetId: string;
  position: DropPosition;
  parentId: string | null;
  index: number;
  /** Depth of the drop indicator line (for indentation). */
  depth: number;
  /**
   * Row boundary (index into the flat list) where the indicator line is drawn: the line sits on
   * top of row `line`. Unused for "inside" drops, which highlight `targetId` instead.
   */
  line: number;
}

/**
 * Resolves the drop target for a pointer over row `overIndex` at vertical `ratio` (0 top .. 1 bottom).
 * Containers accept "inside" in their middle half; leaves split at the midpoint. Below the last row
 * of a nested subtree, `pointerDepth` (derived from the pointer's x position) outdents the drop to an
 * ancestor level, so nodes can be dropped after a group as well as at the end of it. Returns `null`
 * when the drop is invalid (onto itself, into its own subtree, or rejected by `canDrop`).
 */
export function resolveDrop<T>(
  flat: FlatTreeItem<T>[],
  tree: TreeNode<T>[],
  overIndex: number,
  ratio: number,
  dragIds: readonly string[],
  options: {
    canHaveChildren?: (node: TreeNode<T>) => boolean;
    canDrop?: (dragIds: readonly string[], target: DropTarget) => boolean;
    /** Desired nesting depth from the pointer's x position (smaller = further left). */
    pointerDepth?: number;
  } = {},
): DropTarget | null {
  const hovered = flat[overIndex];
  if (!hovered) return null;
  let over: FlatTreeItem<T> = hovered;
  const canHaveChildren =
    options.canHaveChildren ?? ((n: TreeNode<T>) => Array.isArray(n.children));
  const container = canHaveChildren(over.node);

  let position: DropPosition;
  if (container) position = ratio < 0.25 ? "before" : ratio > 0.75 ? "after" : "inside";
  else position = ratio < 0.5 ? "before" : "after";
  // "After" an expanded container visually means "first child of it".
  if (position === "after" && over.isExpanded) position = "inside";

  const line = overIndex + (position === "after" ? 1 : 0);
  // Outdent: below the last child of a subtree the gap is shared by every ancestor that ends
  // there; climb to the one matching the pointer depth.
  if (position === "after" && options.pointerDepth !== undefined) {
    const rowIndex = new Map(flat.map((f, i) => [f.id, i]));
    while (
      over.depth > Math.max(0, options.pointerDepth) &&
      over.index === over.siblingCount - 1 &&
      over.parentId !== null
    ) {
      const parent: FlatTreeItem<T> | undefined = flat[rowIndex.get(over.parentId) ?? -1];
      if (!parent) break;
      over = parent;
    }
  }

  const idx = indexTree(tree);
  const dragSet = new Set(dragIds);
  let parentId: string | null;
  let rawIndex: number;
  let depth: number;
  if (position === "inside") {
    parentId = over.id;
    rawIndex = over.isExpanded ? 0 : (over.node.children?.length ?? 0);
    depth = over.depth + 1;
  } else {
    parentId = over.parentId;
    rawIndex = over.index + (position === "after" ? 1 : 0);
    depth = over.depth;
  }

  for (const id of dragIds) {
    if (isSelfOrDescendant(idx, parentId, id)) return null;
  }
  if (position !== "inside" && dragSet.has(over.id)) return null;

  // Convert to a post-removal index: dragged siblings above the insertion point shift it up.
  const siblings = parentId === null ? tree : (idx.get(parentId)?.node.children ?? []);
  let shift = 0;
  for (let i = 0; i < Math.min(rawIndex, siblings.length); i++) {
    const s = siblings[i];
    if (s && dragSet.has(s.id)) shift++;
  }
  const target: DropTarget = {
    targetId: over.id,
    position,
    parentId,
    index: rawIndex - shift,
    depth,
    line,
  };
  if (options.canDrop && !options.canDrop(dragIds, target)) return null;
  return target;
}

/**
 * Immutably moves `ids` (kept in their current visual order) under `parentId` at `index`, where
 * `index` counts the target's children after the moved nodes are removed (the convention used by
 * `resolveDrop` and `Tree`'s `onMove`). Nodes that would move into their own subtree are skipped.
 */
export function moveTreeNodes<T>(
  tree: TreeNode<T>[],
  ids: readonly string[],
  parentId: string | null,
  index: number,
): TreeNode<T>[] {
  const idx = indexTree(tree);
  const order = allIds(tree);
  const moving = ids
    .filter((id) => idx.has(id) && !isSelfOrDescendant(idx, parentId, id))
    // Drop ids whose ancestor is also moving; they travel with it.
    .filter(
      (id) =>
        !ids.some(
          (other) => other !== id && isSelfOrDescendant(idx, idx.get(id)?.parentId ?? null, other),
        ),
    )
    .sort((a, b) => order.indexOf(a) - order.indexOf(b));
  if (moving.length === 0) return tree;
  const movingSet = new Set(moving);
  const nodes = moving.map((id) => idx.get(id)?.node).filter((n): n is TreeNode<T> => !!n);

  const strip = (list: TreeNode<T>[]): TreeNode<T>[] =>
    list
      .filter((n) => !movingSet.has(n.id))
      .map((n) => (n.children ? { ...n, children: strip(n.children) } : n));
  const stripped = strip(tree);

  const insert = (list: TreeNode<T>[]): TreeNode<T>[] => {
    const at = Math.max(0, Math.min(index, list.length));
    return [...list.slice(0, at), ...nodes, ...list.slice(at)];
  };
  if (parentId === null) return insert(stripped);
  const place = (list: TreeNode<T>[]): TreeNode<T>[] =>
    list.map((n) => {
      if (n.id === parentId) return { ...n, children: insert(n.children ?? []) };
      return n.children ? { ...n, children: place(n.children) } : n;
    });
  return place(stripped);
}

/** Ids of the rows between `a` and `b` inclusive, in visual order (shift-click range select). */
export function rangeBetween<T>(flat: FlatTreeItem<T>[], a: string, b: string): string[] {
  const ia = flat.findIndex((f) => f.id === a);
  const ib = flat.findIndex((f) => f.id === b);
  if (ia < 0 || ib < 0) return [b];
  const [lo, hi] = ia < ib ? [ia, ib] : [ib, ia];
  return flat.slice(lo, hi + 1).map((f) => f.id);
}

/** Next row whose label starts with `query` after `fromIndex`, wrapping (type-ahead). */
export function typeaheadMatch<T>(
  flat: FlatTreeItem<T>[],
  fromIndex: number,
  query: string,
  getLabel: (node: TreeNode<T>) => string,
): number {
  const q = query.toLowerCase();
  for (let step = 1; step <= flat.length; step++) {
    const i = (fromIndex + step) % flat.length;
    const item = flat[i];
    if (item && getLabel(item.node).toLowerCase().startsWith(q)) return i;
  }
  return -1;
}
