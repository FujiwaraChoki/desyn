// Structural builders: group / ungroup / wrap in frame, duplicate, delete, reparent.
import {
  createFrame,
  createGroup,
  type Design,
  type Fill,
  type Id,
  isContainerType,
  type Node,
  newId,
  ROOT_ID,
  type Transaction,
} from "@desyn/schema";
import { Builder } from "./builder";
import {
  boundsOfPoints,
  boxCorners,
  decompose,
  invertMatrix,
  localTransform,
  type Matrix,
  multiply,
  translate,
  worldTransform,
} from "./geometry";
import {
  childIds,
  cloneSubtree,
  getNode,
  isAncestor,
  lowestCommonAncestor,
  pageOf,
  pathTo,
  topLevelSelection,
  zIndex,
} from "./tree";
import type { TxOptions } from "./tx";
import { DocOpsError, roundGeom } from "./util";

/** Top-level selection of non-page nodes that must all share one page. */
function selectionOnOnePage(design: Design, ids: Id[], what: string): Id[] {
  const sel = topLevelSelection(design, ids).filter((id) => getNode(design, id)?.type !== "page");
  if (sel.length === 0) throw new DocOpsError(`${what}: nothing selected`);
  const page = pageOf(design, sel[0] as Id)?.id;
  if (!page || sel.some((id) => pageOf(design, id)?.id !== page)) {
    throw new DocOpsError(`${what}: all nodes must be on the same page`);
  }
  return sel;
}

interface WrapPlan {
  container: Id;
  index: number;
  box: { x: number; y: number; width: number; height: number };
  relative: Map<Id, Matrix>;
}

/** Where a wrapper (group / frame) around `sel` goes and the selection's transforms relative to its container. */
function planWrap(design: Design, sel: Id[], padding = 0): WrapPlan {
  const lca = lowestCommonAncestor(design, sel) as Node;
  const container =
    sel.length === 1 || sel.includes(lca.id)
      ? (getNode(design, sel[0] as Id)?.parent as Id)
      : lca.id;
  const toContainer = invertMatrix(worldTransform(design, container));
  const relative = new Map<Id, Matrix>();
  const corners = sel.flatMap((id) => {
    const n = getNode(design, id) as Node;
    const m = multiply(toContainer, worldTransform(design, id));
    relative.set(id, m);
    return boxCorners(n.width, n.height, m);
  });
  const raw = boundsOfPoints(corners);
  const box = {
    x: roundGeom(raw.x - padding),
    y: roundGeom(raw.y - padding),
    width: roundGeom(raw.width + 2 * padding),
    height: roundGeom(raw.height + 2 * padding),
  };
  const depth = pathTo(design, container).length;
  const index =
    Math.max(
      ...sel.map((id) => {
        const anchor = pathTo(design, id)[depth] as Id;
        return childIds(design, container).indexOf(anchor);
      }),
    ) + 1;
  return { container, index, box, relative };
}

function wrap(b: Builder, sel: Id[], plan: WrapPlan, wrapper: Node): void {
  b.push({ op: "create", nodes: [wrapper], parent: plan.container, index: plan.index });
  for (const id of sel) {
    const n = b.node(id);
    const local = multiply(translate(-plan.box.x, -plan.box.y), plan.relative.get(id) as Matrix);
    b.push({ op: "move", id, parent: wrapper.id });
    b.place(id, decompose(local, n.width, n.height, n));
  }
}

export interface GroupOptions extends TxOptions {
  name?: string;
  /** Id of the new group (default fresh). */
  groupId?: Id;
}

/**
 * Groups nodes (all on one page) into a new group placed in their lowest common container, directly above the
 * top-most selected node. Children keep their page positions; the group's box fits them.
 */
export function groupNodes(design: Design, ids: Id[], options: GroupOptions = {}): Transaction {
  const sel = selectionOnOnePage(design, ids, "groupNodes");
  const plan = planWrap(design, sel);
  const b = new Builder(design);
  const group = createGroup({
    id: options.groupId ?? newId(),
    name: options.name ?? "Group",
    parent: plan.container,
    ...plan.box,
  });
  wrap(b, sel, plan, group);
  b.refitGroups([plan.container]);
  return b.build("Group", options);
}

export interface WrapInFrameOptions extends TxOptions {
  name?: string;
  frameId?: Id;
  /** Space between the selection bounds and the frame edge, px (default 0). */
  padding?: number;
  clip?: boolean;
  fills?: Fill[];
  cornerRadius?: number;
}

/** Wraps nodes in a new frame sized to their bounds (plus padding). */
export function wrapInFrame(
  design: Design,
  ids: Id[],
  options: WrapInFrameOptions = {},
): Transaction {
  const sel = selectionOnOnePage(design, ids, "wrapInFrame");
  const plan = planWrap(design, sel, options.padding ?? 0);
  const b = new Builder(design);
  const frame = createFrame({
    id: options.frameId ?? newId(),
    name: options.name ?? "Frame",
    parent: plan.container,
    ...plan.box,
    fills: options.fills ?? [],
    clip: options.clip ?? false,
    cornerRadius: options.cornerRadius ?? 0,
  });
  wrap(b, sel, plan, frame);
  b.refitGroups([plan.container]);
  return b.build("Wrap in frame", options);
}

/**
 * Dissolves groups (also frames and boolean nodes): children move into the parent at the container's position,
 * keep their page placement and inherit the container's opacity; the container is deleted.
 */
export function ungroup(design: Design, ids: Id[], options: TxOptions = {}): Transaction {
  const targets = topLevelSelection(design, ids).filter((id) => {
    const t = getNode(design, id)?.type;
    return t === "group" || t === "frame" || t === "boolean";
  });
  const b = new Builder(design);
  const touched: Id[] = [];
  for (const id of targets) {
    const group = b.node(id) as Node & { children: Id[] };
    const parent = group.parent as Id;
    const at = zIndex(b.design, id);
    const g = localTransform(group);
    group.children.forEach((childId, k) => {
      const child = b.node(childId);
      b.push({ op: "move", id: childId, parent, index: at + k });
      b.place(
        childId,
        decompose(multiply(g, localTransform(child)), child.width, child.height, child),
      );
      if (group.opacity < 1)
        b.update(childId, { opacity: roundGeom(child.opacity * group.opacity) });
      touched.push(childId);
    });
    b.push({ op: "delete", id });
  }
  b.refitGroups(touched);
  return b.build("Ungroup", options);
}

export interface DuplicateOptions extends TxOptions {
  /** Offset of each copy in its parent's coordinates (default 16, 16; pages are never offset). */
  offset?: { x: number; y: number };
}

/** Duplicates nodes (with fresh ids), each copy directly above its original. */
export function duplicate(design: Design, ids: Id[], options: DuplicateOptions = {}): Transaction {
  const sel = topLevelSelection(design, ids);
  const offset = options.offset ?? { x: 16, y: 16 };
  const b = new Builder(design);
  for (const id of sel) {
    const isPage = getNode(design, id)?.type === "page";
    const { op } = cloneSubtree(b.design, id, isPage ? {} : { offset });
    b.push(op);
  }
  b.refitGroups(sel);
  return b.build(sel.length > 1 ? `Duplicate ${sel.length} elements` : "Duplicate", options);
}

/**
 * Deletes nodes (and their subtrees); groups left empty are deleted too. The root is never deleted, and like
 * `deletePage` this refuses to delete every page of the design.
 */
export function deleteNodes(design: Design, ids: Id[], options: TxOptions = {}): Transaction {
  const sel = topLevelSelection(design, ids);
  const pageCount = childIds(design, ROOT_ID).length;
  if (
    pageCount > 0 &&
    sel.filter((id) => getNode(design, id)?.type === "page").length >= pageCount
  ) {
    throw new DocOpsError("deleteNodes: a design keeps at least one page");
  }
  const b = new Builder(design);
  const parents = new Set<Id>();
  for (const id of sel) {
    parents.add(getNode(design, id)?.parent as Id);
    b.push({ op: "delete", id });
  }
  // Remove groups that lost all their children (bottom-up), then refit the rest.
  let pending = [...parents];
  while (pending.length > 0) {
    const next: Id[] = [];
    for (const pid of pending) {
      const p = getNode(b.design, pid) as (Node & { children?: Id[] }) | undefined;
      if (p && p.type === "group" && (p.children ?? []).length === 0) {
        next.push(p.parent as Id);
        b.push({ op: "delete", id: pid });
      }
    }
    pending = next;
  }
  b.refitGroups([...parents].filter((p) => getNode(b.design, p)));
  return b.build(sel.length > 1 ? `Delete ${sel.length} elements` : "Delete", options);
}

export interface ReparentOptions extends TxOptions {
  /** Index of the first moved node in the new parent (default: on top). */
  index?: number;
  /** Keep each node's position on the page (default true). */
  keepPosition?: boolean;
}

/** Moves nodes into another container, preserving their on-page placement by default. */
export function reparent(
  design: Design,
  ids: Id[],
  parentId: Id,
  options: ReparentOptions = {},
): Transaction {
  const parent = getNode(design, parentId);
  if (!parent || !isContainerType(parent.type)) {
    throw new DocOpsError(`reparent: "${parentId}" is not a container`);
  }
  const sel = topLevelSelection(design, ids);
  for (const id of sel) {
    if (id === parentId || isAncestor(design, id, parentId)) {
      throw new DocOpsError(`reparent: cannot move "${id}" into itself`);
    }
    const isPage = getNode(design, id)?.type === "page";
    if (isPage !== (parentId === ROOT_ID))
      throw new DocOpsError("reparent: pages live directly under the root");
  }
  const b = new Builder(design);
  const oldParents = sel.map((id) => getNode(design, id)?.parent as Id);
  sel.forEach((id, k) => {
    const node = b.node(id);
    const world = worldTransform(b.design, id);
    const op = { op: "move" as const, id, parent: parentId };
    b.push(options.index === undefined ? op : { ...op, index: options.index + k });
    if (options.keepPosition !== false && node.type !== "page") {
      const local = multiply(invertMatrix(worldTransform(b.design, parentId)), world);
      b.place(id, decompose(local, node.width, node.height, node));
    }
  });
  b.refitGroups([...oldParents.filter((p) => getNode(b.design, p)), ...sel]);
  return b.build("Move into container", options);
}
