import { Builder, isAncestor, reorderMoves, reparent, topLevelSelection } from "@desyn/doc-ops";
import type { Design, Id, Node, Transaction } from "@desyn/schema";
import type { TreeNode } from "@desyn/ui";

/**
 * The layers panel shows a page's layers front-most first (like Figma / Canva); the document stores children
 * back-to-front. These helpers build the tree for @desyn/ui's <Tree>, filter it, and turn a tree drop into a
 * document transaction.
 */

export interface LayerRow {
  node: Node;
  /** Text content for text layers (search and secondary label). */
  text?: string;
}

const CONTAINERS = new Set(["frame", "group", "boolean"]);

function textOf(node: Node): string | undefined {
  if (node.type !== "text") return undefined;
  return node.runs
    .map((r) => r.text)
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

/** Children front-most first. */
function front(design: Design, id: Id): Node[] {
  const n = design.nodes[id] as (Node & { children?: Id[] }) | undefined;
  return [...(n?.children ?? [])]
    .reverse()
    .map((c) => design.nodes[c])
    .filter((c): c is Node => !!c);
}

/** Tree of a page's layers (containers keep a `children` array even when empty, so they accept drops). */
export function layerTree(design: Design, pageId: Id): TreeNode<LayerRow>[] {
  const build = (node: Node): TreeNode<LayerRow> => {
    const text = textOf(node);
    const row: TreeNode<LayerRow> = { id: node.id, data: text ? { node, text } : { node } };
    if (CONTAINERS.has(node.type)) row.children = front(design, node.id).map(build);
    return row;
  };
  return front(design, pageId).map(build);
}

/** Display name of a layer (its name, else its text, else its type). */
export function layerLabel(row: LayerRow | undefined): string {
  if (!row) return "";
  return row.node.name || row.text || row.node.type;
}

export interface LayerFilter {
  query: string;
  /** Node types to keep (empty = all). */
  types: string[];
  hiddenOnly?: boolean;
  lockedOnly?: boolean;
}

function matches(row: LayerRow, f: LayerFilter): boolean {
  const q = f.query.trim().toLowerCase();
  if (q) {
    const hay =
      `${row.node.name} ${row.text ?? ""} ${row.node.role ?? ""} ${row.node.type}`.toLowerCase();
    if (!hay.includes(q)) return false;
  }
  if (f.types.length > 0 && !f.types.includes(row.node.type)) return false;
  if (f.hiddenOnly && row.node.visible) return false;
  if (f.lockedOnly && !row.node.locked) return false;
  return true;
}

export function isFilterActive(f: LayerFilter): boolean {
  return f.query.trim() !== "" || f.types.length > 0 || !!f.hiddenOnly || !!f.lockedOnly;
}

/** Keeps matching rows and the ancestors that lead to them; also returns the ancestors to expand. */
export function filterTree(
  tree: TreeNode<LayerRow>[],
  f: LayerFilter,
): { tree: TreeNode<LayerRow>[]; expand: Id[] } {
  if (!isFilterActive(f)) return { tree, expand: [] };
  const expand: Id[] = [];
  const walk = (nodes: TreeNode<LayerRow>[]): TreeNode<LayerRow>[] => {
    const out: TreeNode<LayerRow>[] = [];
    for (const n of nodes) {
      const kids = n.children ? walk(n.children) : [];
      const self = n.data ? matches(n.data, f) : false;
      if (self || kids.length > 0) {
        if (kids.length > 0) expand.push(n.id);
        out.push(n.children ? { ...n, children: kids } : n);
      }
    }
    return out;
  };
  return { tree: walk(tree), expand };
}

/**
 * Transaction for a tree drop: `ids` (visual order, front-most first) into `parentId` (null = the page) at
 * `index` counted front-most first among the parent's other children. Layers from other containers keep
 * their place on the page. Returns null when nothing changes or the drop is invalid (into itself).
 */
export function moveLayersTransaction(
  design: Design,
  pageId: Id,
  ids: Id[],
  parentId: Id | null,
  index: number,
): Transaction | null {
  const parent = parentId ?? pageId;
  const container = design.nodes[parent] as (Node & { children?: Id[] }) | undefined;
  if (!container?.children) return null;
  const moving = topLevelSelection(design, ids).filter((id) => id !== parent && id !== pageId);
  if (moving.length === 0) return null;
  if (moving.some((id) => id === parent || isAncestor(design, id, parent))) return null;
  // Keep the visual order the user dragged in (front-most first in `ids`).
  moving.sort((a, b) => ids.indexOf(a) - ids.indexOf(b));
  const b = new Builder(design);
  const foreign = moving.filter((id) => design.nodes[id]?.parent !== parent);
  if (foreign.length > 0) {
    for (const op of reparent(design, foreign, parent).ops) b.push(op);
  }
  const current = (b.node(parent) as Node & { children: Id[] }).children;
  const remaining = current.filter((c) => !moving.includes(c));
  // Front-most-first index among the remaining children -> back-to-front slot.
  const slot = Math.max(0, Math.min(remaining.length, remaining.length - index));
  const target = [...remaining.slice(0, slot), ...[...moving].reverse(), ...remaining.slice(slot)];
  for (const move of reorderMoves(parent, current, target)) b.push(move);
  if (b.ops.length === 0) return null;
  b.refitGroups(moving);
  return b.build(moving.length > 1 ? `Move ${moving.length} layers` : "Move layer");
}
