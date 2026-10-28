// diffDesigns(a, b): a transaction that turns `a` into `b` (applyTransaction(a, diff).design is canonically equal to
// b for valid designs with the same id). One op per changed node / asset map / style entry; structure changes are
// minimal moves (longest-increasing-subsequence reorders).
import {
  type AssetRef,
  type Design,
  type DocOp,
  type Id,
  type Node,
  type Op,
  ROOT_ID,
  type Transaction,
} from "@desyn/schema";
import { reorderMoves } from "./order";
import { makeTransaction, type TxOptions } from "./tx";
import { deepEqual, hasOwn, isPlainObject, type JsonObject, setOwn } from "./util";

const STRUCTURAL = new Set(["id", "type", "parent", "children"]);

function kidsOf(nodes: Record<Id, Node>, id: Id): Id[] {
  return (nodes[id] as { children?: Id[] } | undefined)?.children ?? [];
}

function preorder(nodes: Record<Id, Node>, rootId: Id): Id[] {
  const out: Id[] = [];
  const stack = [rootId];
  while (stack.length > 0) {
    const id = stack.pop() as Id;
    if (!hasOwn(nodes, id)) continue;
    out.push(id);
    const kids = kidsOf(nodes, id);
    for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i] as Id);
  }
  return out;
}

/** Structure-only simulation of the target being built (parents + ordered children). */
class Sim {
  parent = new Map<Id, Id | null>();
  kids = new Map<Id, Id[]>();

  constructor(nodes: Record<Id, Node>) {
    for (const [id, n] of Object.entries(nodes)) {
      this.parent.set(id, n.parent);
      const c = (n as { children?: Id[] }).children;
      if (c) this.kids.set(id, c.slice());
    }
  }

  has(id: Id): boolean {
    return this.parent.has(id);
  }

  children(id: Id): Id[] {
    return this.kids.get(id) ?? [];
  }

  insert(nodes: Node[], parent: Id, index: number): void {
    for (const n of nodes) {
      this.parent.set(n.id, n.parent);
      const c = (n as { children?: Id[] }).children;
      if (c) this.kids.set(n.id, c.slice());
    }
    const head = nodes[0] as Node;
    this.parent.set(head.id, parent);
    this.children(parent).splice(index, 0, head.id);
  }

  move(id: Id, parent: Id, index: number): void {
    const old = this.parent.get(id) as Id;
    const from = this.children(old);
    from.splice(from.indexOf(id), 1);
    this.children(parent).splice(index, 0, id);
    this.parent.set(id, parent);
  }

  remove(id: Id): void {
    const p = this.parent.get(id);
    if (p) {
      const list = this.children(p);
      list.splice(list.indexOf(id), 1);
    }
    const stack = [id];
    while (stack.length > 0) {
      const cur = stack.pop() as Id;
      stack.push(...this.children(cur));
      this.parent.delete(cur);
      this.kids.delete(cur);
    }
  }
}

/** Insertion index under `parent` that lands right after the nearest preceding target sibling already present. */
function insertionIndex(sim: Sim, parent: Id, targetSiblings: Id[], id: Id): number {
  const current = sim.children(parent).filter((c) => c !== id);
  for (let i = targetSiblings.indexOf(id) - 1; i >= 0; i--) {
    const at = current.indexOf(targetSiblings[i] as Id);
    if (at >= 0) return at + 1;
  }
  return 0;
}

function docOp(a: Design, b: Design): DocOp | null {
  const set: DocOp["set"] = {};
  if (a.name !== b.name) set.name = b.name;
  if (a.kind !== b.kind) set.kind = b.kind;
  if (b.brandKitId !== undefined && a.brandKitId !== b.brandKitId) set.brandKitId = b.brandKitId;
  if (!deepEqual(a.meta, b.meta)) set.meta = b.meta;
  const unset = a.brandKitId !== undefined && b.brandKitId === undefined;
  if (Object.keys(set).length === 0 && !unset) return null;
  const op: DocOp = { op: "doc", set };
  if (unset) op.unset = ["brandKitId"];
  return op;
}

function assetOp(a: Design, b: Design): Op | null {
  const set: Record<Id, AssetRef> = {};
  const remove: Id[] = [];
  for (const [id, asset] of Object.entries(b.assets)) {
    if (!hasOwn(a.assets, id) || !deepEqual(a.assets[id], asset)) setOwn(set, id, asset);
  }
  for (const id of Object.keys(a.assets)) if (!hasOwn(b.assets, id)) remove.push(id);
  if (Object.keys(set).length === 0 && remove.length === 0) return null;
  const op: Op = { op: "asset" };
  if (Object.keys(set).length > 0) op.set = set;
  if (remove.length > 0) op.remove = remove;
  return op;
}

function styleOps(a: Design, b: Design): Op[] {
  if (deepEqual(a.styles, b.styles)) return [];
  const as = a.styles as unknown as JsonObject;
  const bs = b.styles as unknown as JsonObject;
  // A removed top-level key can only be expressed by replacing the whole styles object.
  if (Object.keys(as).some((k) => !hasOwn(bs, k)))
    return [{ op: "styles", path: [], value: b.styles }];
  const ops: Op[] = [];
  for (const key of Object.keys(bs)) {
    const av = as[key];
    const bv = bs[key];
    if (deepEqual(av, bv)) continue;
    if (!hasOwn(as, key) || !isPlainObject(av) || !isPlainObject(bv)) {
      ops.push({ op: "styles", path: [key], value: bv });
      continue;
    }
    if (Object.keys(av).some((k) => !hasOwn(bv, k))) {
      ops.push({ op: "styles", path: [key], value: bv });
      continue;
    }
    for (const [entry, value] of Object.entries(bv)) {
      if (!hasOwn(av, entry) || !deepEqual(av[entry], value)) {
        ops.push({ op: "styles", path: [key, entry], value });
      }
    }
  }
  return ops;
}

function nodeUpdate(before: Node, after: Node): Op | null {
  const a = before as unknown as JsonObject;
  const b = after as unknown as JsonObject;
  const set: JsonObject = {};
  const unset: string[] = [];
  for (const [k, v] of Object.entries(b)) {
    if (STRUCTURAL.has(k) || v === undefined) continue;
    if (!hasOwn(a, k) || !deepEqual(a[k], v)) setOwn(set, k, v);
  }
  for (const k of Object.keys(a)) {
    if (STRUCTURAL.has(k) || a[k] === undefined) continue;
    if (!hasOwn(b, k) || b[k] === undefined) unset.push(k);
  }
  if (Object.keys(set).length === 0 && unset.length === 0) return null;
  const op: Op = { op: "update", id: after.id };
  if (Object.keys(set).length > 0) op.set = set;
  if (unset.length > 0) op.unset = unset;
  return op;
}

/** The ops of diffDesigns. */
export function diffOps(a: Design, b: Design): Op[] {
  const ops: Op[] = [];
  const doc = docOp(a, b);
  if (doc) ops.push(doc);
  const assets = assetOp(a, b);
  if (assets) ops.push(assets);
  ops.push(...styleOps(a, b));

  const A = a.nodes;
  const B = b.nodes;
  const inA = (id: Id) => hasOwn(A, id);
  const inB = (id: Id) => hasOwn(B, id);

  // Retyped ids cannot be updated (type is immutable): they and every target node below them are rebuilt.
  const rebuilt = new Set<Id>();
  for (const id of Object.keys(B)) {
    if (inA(id) && (A[id] as Node).type !== (B[id] as Node).type) {
      for (const sub of preorder(B, id)) rebuilt.add(sub);
    }
  }
  const dead = new Set<Id>(Object.keys(A).filter((id) => !inB(id) || rebuilt.has(id)));
  const pureNew = (id: Id) => !inA(id) && !rebuilt.has(id);

  const sim = new Sim(A);
  const placed = new Set<Id>();
  const bOrder = preorder(B, ROOT_ID);

  // Phase 1: top-down over the target, creating new regions and moving surviving nodes to their target parents.
  const visit = (parentId: Id) => {
    const targetKids = kidsOf(B, parentId);
    for (const id of targetKids) {
      if (rebuilt.has(id)) continue;
      if (!placed.has(id)) {
        if (pureNew(id)) {
          const region = preorder(B, id).filter((sub) => {
            if (!pureNew(sub)) return false;
            // Only nodes connected to `id` through new nodes belong to this create op.
            for (let p = B[sub]?.parent; p && p !== parentId; p = B[p]?.parent) {
              if (!pureNew(p)) return false;
            }
            return true;
          });
          const members = new Set(region);
          const nodes = region.map((sub) => {
            const n = B[sub] as Node & { children?: Id[] };
            return (
              n.children ? { ...n, children: n.children.filter((c) => members.has(c)) } : n
            ) as Node;
          });
          const index = insertionIndex(sim, parentId, targetKids, id);
          ops.push({ op: "create", nodes, parent: parentId, index });
          sim.insert(nodes, parentId, index);
          for (const m of region) placed.add(m);
        } else if (sim.parent.get(id) !== parentId) {
          const index = insertionIndex(sim, parentId, targetKids, id);
          ops.push({ op: "move", id, parent: parentId, index });
          sim.move(id, parentId, index);
        }
        placed.add(id);
      }
      visit(id);
    }
  };
  visit(ROOT_ID);

  // Phase 2: delete removed / retyped nodes (their subtrees now hold only dead nodes).
  for (const id of preorder(A, ROOT_ID)) {
    if (!dead.has(id) || !sim.has(id)) continue;
    const parent = sim.parent.get(id);
    if (parent && !dead.has(parent)) {
      ops.push({ op: "delete", id });
      sim.remove(id);
    }
  }

  // Phase 3: rebuild retyped subtrees from the target.
  for (const id of bOrder) {
    if (!rebuilt.has(id)) continue;
    const parentId = B[id]?.parent as Id;
    if (rebuilt.has(parentId)) continue;
    const nodes = preorder(B, id).map((sub) => B[sub] as Node);
    const index = insertionIndex(sim, parentId, kidsOf(B, parentId), id);
    ops.push({ op: "create", nodes, parent: parentId, index });
    sim.insert(nodes, parentId, index);
  }

  // Phase 4: child order.
  for (const id of bOrder) {
    const target = kidsOf(B, id);
    if (!(B[id] as { children?: Id[] }).children) continue;
    const current = sim.children(id);
    if (!deepEqual(current, target)) {
      for (const move of reorderMoves(id, current, target)) {
        ops.push(move);
        sim.move(move.id, id, move.index as number);
      }
    }
  }

  // Phase 5: properties of surviving nodes.
  for (const id of bOrder) {
    if (!inA(id) || rebuilt.has(id)) continue;
    const update = nodeUpdate(A[id] as Node, B[id] as Node);
    if (update) ops.push(update);
  }
  return ops;
}

/** A transaction turning `a` into `b`. Empty `ops` when they are equal. */
export function diffDesigns(a: Design, b: Design, options: TxOptions = {}): Transaction {
  return makeTransaction(diffOps(a, b), "Sync changes", { source: "system", ...options });
}
