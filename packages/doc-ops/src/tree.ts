// Read-only tree queries over a Design's flat node map.
import {
  type CreateOp,
  type Design,
  type Id,
  isContainerType,
  type Node,
  newId,
  type PageNode,
  ROOT_ID,
} from "@desyn/schema";
import { deepClone, hasOwn, setOwn } from "./util";

export function getNode(design: Design, id: Id): Node | undefined {
  return hasOwn(design.nodes, id) ? design.nodes[id] : undefined;
}

export function childIds(design: Design, id: Id): Id[] {
  const node = getNode(design, id) as { children?: Id[] } | undefined;
  return node?.children ?? [];
}

/** Direct children, back-to-front. */
export function children(design: Design, id: Id): Node[] {
  return childIds(design, id)
    .map((c) => getNode(design, c))
    .filter((n): n is Node => n !== undefined);
}

export function parentOf(design: Design, id: Id): Node | undefined {
  const parent = getNode(design, id)?.parent;
  return parent ? getNode(design, parent) : undefined;
}

/** Ancestors from the direct parent up to the root (excluding the node itself). */
export function parentChain(design: Design, id: Id): Node[] {
  const out: Node[] = [];
  const guard = new Set<Id>([id]);
  for (let cur = parentOf(design, id); cur; cur = parentOf(design, cur.id)) {
    if (guard.has(cur.id)) break;
    guard.add(cur.id);
    out.push(cur);
  }
  return out;
}

/** Ids from the root down to `id`, inclusive. Empty when `id` does not exist. */
export function pathTo(design: Design, id: Id): Id[] {
  if (!getNode(design, id)) return [];
  return [
    ...parentChain(design, id)
      .map((n) => n.id)
      .reverse(),
    id,
  ];
}

/** All descendants in pre-order (document order, back-to-front within each container), excluding `id`. */
export function descendants(design: Design, id: Id): Node[] {
  const out: Node[] = [];
  const stack = childIds(design, id).slice().reverse();
  while (stack.length > 0) {
    const node = getNode(design, stack.pop() as Id);
    if (!node) continue;
    out.push(node);
    const kids = (node as { children?: Id[] }).children;
    if (kids) for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i] as Id);
  }
  return out;
}

/** `id` and its descendants in pre-order. */
export function subtree(design: Design, id: Id): Node[] {
  const node = getNode(design, id);
  return node ? [node, ...descendants(design, id)] : [];
}

/** True when `ancestorId` is a strict ancestor of `id`. */
export function isAncestor(design: Design, ancestorId: Id, id: Id): boolean {
  return parentChain(design, id).some((n) => n.id === ancestorId);
}

/** The page containing `id` (the page itself for a page). */
export function pageOf(design: Design, id: Id): PageNode | undefined {
  const node = getNode(design, id);
  if (!node) return undefined;
  if (node.type === "page") return node;
  return parentChain(design, id).find((n): n is PageNode => n.type === "page");
}

export function pages(design: Design): PageNode[] {
  return children(design, ROOT_ID).filter((n): n is PageNode => n.type === "page");
}

/** Index within the parent's children (0 = bottom-most), or -1. */
export function zIndex(design: Design, id: Id): number {
  const parent = getNode(design, id)?.parent;
  return parent ? childIds(design, parent).indexOf(id) : -1;
}

/** Other children of the same parent, back-to-front. */
export function siblings(design: Design, id: Id): Node[] {
  const parent = getNode(design, id)?.parent;
  return parent ? children(design, parent).filter((n) => n.id !== id) : [];
}

/** Nodes matching `predicate`, in document order, searching below `rootId` (default: whole design). */
export function findNodes(
  design: Design,
  predicate: (node: Node) => boolean,
  rootId: Id = ROOT_ID,
): Node[] {
  return subtree(design, rootId).filter(predicate);
}

/** Position of every node in a pre-order walk; used to sort selections into document (z) order. */
export function documentOrder(design: Design): Map<Id, number> {
  const order = new Map<Id, number>();
  subtree(design, ROOT_ID).forEach((n, i) => {
    order.set(n.id, i);
  });
  return order;
}

export function sortByDocumentOrder(design: Design, ids: Iterable<Id>): Id[] {
  const order = documentOrder(design);
  return [...new Set(ids)]
    .filter((id) => order.has(id))
    .sort((a, b) => (order.get(a) as number) - (order.get(b) as number));
}

/** Existing ids minus those whose ancestor is also selected, in document order. Root is excluded. */
export function topLevelSelection(design: Design, ids: Iterable<Id>): Id[] {
  const set = new Set([...ids].filter((id) => id !== ROOT_ID && getNode(design, id)));
  return sortByDocumentOrder(
    design,
    [...set].filter((id) => !parentChain(design, id).some((a) => set.has(a.id))),
  );
}

/** Deepest node that is an ancestor-or-self of every id, or undefined for an empty / unknown selection. */
export function lowestCommonAncestor(design: Design, ids: Id[]): Node | undefined {
  const paths = ids.map((id) => pathTo(design, id)).filter((p) => p.length > 0);
  if (paths.length === 0) return undefined;
  const first = paths[0] as Id[];
  let depth = 0;
  while (depth < first.length && paths.every((p) => p[depth] === first[depth])) depth++;
  return depth === 0 ? undefined : getNode(design, first[depth - 1] as Id);
}

export function isContainer(node: Node | undefined): node is Extract<Node, { children: Id[] }> {
  return node !== undefined && isContainerType(node.type);
}

export interface CloneSubtreeOptions {
  /** Id generator or explicit mapping; default `newId`. */
  newIds?: ((oldId: Id) => Id) | Map<Id, Id>;
  /** Parent of the copy; default: the original's parent. */
  parent?: Id;
  /** Index in the parent; default: right above the original when the parent is unchanged, else on top. */
  index?: number;
  /** Offset added to the copy's x / y. */
  offset?: { x: number; y: number };
  /** Name for the copy's root. */
  name?: string;
}

export interface ClonedSubtree {
  op: CreateOp;
  /** old id -> new id for every node in the subtree. */
  idMap: Map<Id, Id>;
}

/**
 * Deep-copies the subtree rooted at `id` with fresh ids and returns the `create` op that inserts it. Animation
 * ids are renewed too, and `link: "page:<id>"` references into the copied subtree are remapped.
 */
export function cloneSubtree(
  design: Design,
  id: Id,
  options: CloneSubtreeOptions = {},
): ClonedSubtree {
  const nodes = subtree(design, id);
  const root = nodes[0];
  if (!root) throw new Error(`cloneSubtree: node "${id}" does not exist`);
  if (root.type === "root") throw new Error("cloneSubtree: the root cannot be cloned");
  const gen = options.newIds;
  const idMap = new Map<Id, Id>();
  for (const n of nodes) {
    const mapped = gen instanceof Map ? gen.get(n.id) : gen?.(n.id);
    idMap.set(n.id, mapped ?? newId());
  }
  const remap = (old: Id) => idMap.get(old) ?? old;
  const copies = nodes.map((n, i) => {
    const copy = deepClone(n) as Node & { children?: Id[]; anim?: { id: Id }[] };
    copy.id = remap(n.id);
    if (i > 0) copy.parent = remap(n.parent as Id);
    if (copy.children) copy.children = copy.children.map(remap);
    if (copy.anim) copy.anim = copy.anim.map((a) => ({ ...a, id: newId() }));
    if (typeof copy.link === "string" && copy.link.startsWith("page:")) {
      copy.link = `page:${remap(copy.link.slice(5))}`;
    }
    return copy as Node;
  });
  const head = copies[0] as Node;
  const parent = options.parent ?? (root.parent as Id);
  head.parent = parent;
  if (options.offset) {
    head.x += options.offset.x;
    head.y += options.offset.y;
  }
  if (options.name !== undefined)
    setOwn(head as unknown as Record<string, unknown>, "name", options.name);
  const index =
    options.index ??
    (parent === root.parent ? zIndex(design, id) + 1 : childIds(design, parent).length);
  return { op: { op: "create", nodes: copies, parent, index }, idMap };
}
