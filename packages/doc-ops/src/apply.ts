// applyTransaction: the reference implementation of DOCUMENT_MODEL §5. Every rule here is specified in
// spec/fixtures/README.md and pinned by spec/fixtures/ops/*.json; the Rust core must behave identically.
import {
  type ApplyResult,
  type AssetRef,
  AssetRefSchema,
  type CreateOp,
  compareCodePoints,
  DESIGN_KINDS,
  type Design,
  type DesignKind,
  type DesignStyles,
  DesignStylesSchema,
  type DocOp,
  type DroppedOp,
  type DropReason,
  type Id,
  IMMUTABLE_NODE_KEYS,
  isContainerType,
  type Node,
  type Op,
  type PathSegment,
  ROOT_ID,
  sha256Hex,
  type Transaction,
  validateNode,
} from "@desyn/schema";
import { isPathShape, setAtPath } from "./path";
import {
  clamp,
  copyObject,
  deepClone,
  hasOwn,
  isInteger,
  isPlainObject,
  isStringArray,
  type JsonObject,
  setOwn,
} from "./util";

export interface ApplyOptions {
  /**
   * Validate node shapes (zod) after create/update/patch. Default true. Turning it off trusts the caller for
   * node shape (structural invariants are always enforced); use only for trusted bulk imports.
   */
  validateNodes?: boolean;
  /** Id for the inverse transaction. Default: first 12 hex chars of sha256("inverse:" + tx.id). */
  inverseId?: string;
}

/** Deterministic inverse transaction id (documented in spec/fixtures/README.md). */
export function inverseTxId(txId: string): string {
  return sha256Hex(`inverse:${txId}`).slice(0, 12);
}

const IMMUTABLE: ReadonlySet<string> = new Set(IMMUTABLE_NODE_KEYS);
const DOC_SET_KEYS: ReadonlySet<string> = new Set(["name", "kind", "brandKitId", "meta"]);
const KINDS: ReadonlySet<string> = new Set(DESIGN_KINDS);

type Outcome = { ok: true; applied: Op; inverse: Op } | { ok: false; reason: DropReason };

const drop = (reason: DropReason): Outcome => ({ ok: false, reason });

/**
 * Mutable working state for one transaction. The input design is never mutated: the node and asset maps are
 * copied on first write, and every changed node / container is a fresh object (structural sharing elsewhere).
 */
class Draft {
  nodes: Record<Id, Node>;
  assets: Record<Id, AssetRef>;
  styles: DesignStyles;
  name: string;
  kind: DesignKind;
  brandKitId: string | undefined;
  hasBrandKitId: boolean;
  meta: Design["meta"];
  private nodesCopied = false;
  private assetsCopied = false;
  changed = false;

  constructor(
    readonly base: Design,
    readonly validate: boolean,
  ) {
    this.nodes = base.nodes;
    this.assets = base.assets;
    this.styles = base.styles;
    this.name = base.name;
    this.kind = base.kind;
    this.hasBrandKitId = hasOwn(base, "brandKitId") && base.brandKitId !== undefined;
    this.brandKitId = base.brandKitId;
    this.meta = base.meta;
  }

  node(id: unknown): Node | undefined {
    return typeof id === "string" && hasOwn(this.nodes, id) ? this.nodes[id] : undefined;
  }

  writableNodes(): Record<Id, Node> {
    if (!this.nodesCopied) {
      this.nodes = copyObject(this.nodes);
      this.nodesCopied = true;
    }
    this.changed = true;
    return this.nodes;
  }

  writableAssets(): Record<Id, AssetRef> {
    if (!this.assetsCopied) {
      this.assets = copyObject(this.assets);
      this.assetsCopied = true;
    }
    this.changed = true;
    return this.assets;
  }

  putNode(node: Node): void {
    setOwn(this.writableNodes() as unknown as JsonObject, node.id, node);
  }

  children(id: Id): Id[] {
    return (this.nodes[id] as { children?: Id[] }).children ?? [];
  }

  setChildren(id: Id, children: Id[]): void {
    const node = this.nodes[id] as Node & { children: Id[] };
    this.putNode({ ...node, children } as Node);
  }

  isValidNode(node: unknown): boolean {
    if (!this.validate) return true;
    return validateNode(node).length === 0;
  }

  finish(): Design {
    if (!this.changed) return this.base;
    const out = copyObject(this.base) as Design;
    out.nodes = this.nodes;
    out.assets = this.assets;
    out.styles = this.styles;
    out.name = this.name;
    out.kind = this.kind;
    out.meta = this.meta;
    if (this.hasBrandKitId) out.brandKitId = this.brandKitId as string;
    else delete (out as Partial<Design>).brandKitId;
    return out;
  }
}

// create ---------------------------------------------------------------------------------------------------------

function applyCreate(d: Draft, op: JsonObject): Outcome {
  const { nodes, parent, index } = op;
  if (!Array.isArray(nodes) || nodes.length === 0) return drop("invalid-op");
  if (typeof parent !== "string") return drop("invalid-op");
  if (index !== undefined && !isInteger(index)) return drop("invalid-op");

  const parentNode = d.node(parent);
  if (!parentNode) return drop("missing-parent");
  if (!isContainerType(parentNode.type)) return drop("not-container");

  if (!nodes.every((n) => isPlainObject(n) && typeof n.id === "string"))
    return drop("invalid-node");
  const batch = nodes as JsonObject[];
  const ids = new Set<string>();
  for (const n of batch) {
    const id = n.id as string;
    if (ids.has(id) || hasOwn(d.nodes, id) || id === ROOT_ID) return drop("duplicate-id");
    ids.add(id);
  }
  if (batch.some((n) => n.type === "root")) return drop("root-protected");
  const head = batch[0] as JsonObject;
  if ((parent === ROOT_ID) !== (head.type === "page")) return drop("page-nesting");
  if (batch.slice(1).some((n) => n.type === "page")) return drop("page-nesting");

  // Structure: descendants form a tree under nodes[0] whose parent/children agree exactly.
  const prepared = batch.map((n, i) => {
    const copy = deepClone(n);
    if (i === 0) setOwn(copy, "parent", parent);
    return copy;
  });
  const byId = new Map(prepared.map((n) => [n.id as string, n]));
  const headId = head.id as string;
  const listedIn = new Map<string, string>();
  for (const n of prepared) {
    const children = n.children;
    if (children === undefined) continue;
    if (!isContainerType(String(n.type)) || !isStringArray(children)) return drop("invalid-node");
    for (const c of children) {
      if (!byId.has(c) || c === headId || listedIn.has(c)) return drop("invalid-node");
      listedIn.set(c, n.id as string);
    }
  }
  for (const n of prepared.slice(1)) {
    if (typeof n.parent !== "string" || listedIn.get(n.id as string) !== n.parent) {
      return drop("invalid-node");
    }
  }
  // Every node reachable from the head (rules out detached cycles).
  const seen = new Set<string>([headId]);
  const stack = [headId];
  while (stack.length > 0) {
    const cur = byId.get(stack.pop() as string) as JsonObject;
    for (const c of (cur.children as string[] | undefined) ?? []) {
      if (!seen.has(c)) {
        seen.add(c);
        stack.push(c);
      }
    }
  }
  if (seen.size !== prepared.length) return drop("invalid-node");
  if (!prepared.every((n) => d.isValidNode(n))) return drop("invalid-node");

  const siblings = d.children(parent);
  const at = index === undefined ? siblings.length : clamp(index as number, 0, siblings.length);
  for (const n of prepared) d.putNode(n as unknown as Node);
  const nextChildren = siblings.slice();
  nextChildren.splice(at, 0, headId);
  d.setChildren(parent, nextChildren);

  const applied: CreateOp = {
    op: "create",
    nodes: prepared as unknown as Node[],
    parent,
    index: at,
  };
  return { ok: true, applied, inverse: { op: "delete", id: headId } };
}

// update ---------------------------------------------------------------------------------------------------------

function applyUpdate(d: Draft, op: JsonObject): Outcome {
  const { id, set, unset } = op;
  if (typeof id !== "string") return drop("invalid-op");
  if (set !== undefined && !isPlainObject(set)) return drop("invalid-op");
  if (unset !== undefined && !isStringArray(unset)) return drop("invalid-op");
  const setKeys = set ? Object.keys(set) : [];
  const unsetKeys = unset ? [...new Set(unset as string[])] : [];
  if (unsetKeys.some((k) => setKeys.includes(k))) return drop("invalid-op");

  const node = d.node(id);
  if (!node) return drop("missing-node");
  if ([...setKeys, ...unsetKeys].some((k) => IMMUTABLE.has(k))) return drop("immutable-field");

  const before = node as unknown as JsonObject;
  const next = copyObject(before);
  const values = set ? deepClone(set as JsonObject) : {};
  for (const k of setKeys) setOwn(next, k, values[k]);
  for (const k of unsetKeys) delete next[k];
  if (!d.isValidNode(next)) return drop("invalid-node");
  d.putNode(next as unknown as Node);

  const invSet: JsonObject = {};
  const invUnset: string[] = [];
  for (const k of [...setKeys, ...unsetKeys]) {
    if (hasOwn(before, k)) setOwn(invSet, k, before[k]);
    else if (setKeys.includes(k)) invUnset.push(k);
  }
  // JSON object key order carries no meaning, so arrays derived from `set` keys use code point order.
  invUnset.sort(compareCodePoints);
  const applied: Op = { op: "update", id };
  if (setKeys.length > 0) applied.set = values;
  if (unsetKeys.length > 0) applied.unset = unsetKeys;
  const inverse: Op = { op: "update", id };
  if (Object.keys(invSet).length > 0) inverse.set = invSet;
  if (invUnset.length > 0) inverse.unset = invUnset;
  return { ok: true, applied, inverse };
}

// patch ----------------------------------------------------------------------------------------------------------

function applyPatch(d: Draft, op: JsonObject): Outcome {
  const { id, path } = op;
  if (typeof id !== "string" || !isPathShape(path) || !hasOwn(op, "value"))
    return drop("invalid-op");
  const node = d.node(id);
  if (!node) return drop("missing-node");
  if (path.length === 0) return drop("invalid-path");
  if (typeof path[0] === "string" && IMMUTABLE.has(path[0])) return drop("immutable-field");

  const value = deepClone(op.value);
  const result = setAtPath(node, path, value);
  if (!result) return drop("invalid-path");
  if (!d.isValidNode(result.root)) return drop("invalid-node");
  d.putNode(result.root as Node);

  const segs = path.slice();
  let inverse: Op;
  if (result.existed) inverse = { op: "patch", id, path: segs, value: result.oldValue };
  else if (segs.length === 1) inverse = { op: "update", id, unset: [segs[0] as string] };
  else inverse = { op: "patch", id, path: segs.slice(0, -1), value: result.parentBefore };
  return { ok: true, applied: { op: "patch", id, path: segs, value }, inverse };
}

// delete ---------------------------------------------------------------------------------------------------------

function applyDelete(d: Draft, op: JsonObject): Outcome {
  const { id } = op;
  if (typeof id !== "string") return drop("invalid-op");
  if (id === ROOT_ID) return drop("root-protected");
  const node = d.node(id);
  if (!node) return drop("missing-node");
  const parentId = node.parent as Id;
  const siblings = d.children(parentId);
  const at = siblings.indexOf(id);

  // Pre-order subtree, which is also a valid `create` node list for the inverse.
  const subtree: Node[] = [];
  const stack: Id[] = [id];
  while (stack.length > 0) {
    const cur = d.nodes[stack.pop() as Id] as Node;
    subtree.push(cur);
    const kids = (cur as { children?: Id[] }).children;
    if (kids) for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i] as Id);
  }
  const nodes = d.writableNodes() as unknown as JsonObject;
  for (const n of subtree) delete nodes[n.id];
  d.setChildren(
    parentId,
    siblings.filter((c) => c !== id),
  );
  return {
    ok: true,
    applied: { op: "delete", id },
    inverse: { op: "create", nodes: subtree, parent: parentId, index: at },
  };
}

// move -----------------------------------------------------------------------------------------------------------

function applyMove(d: Draft, op: JsonObject): Outcome {
  const { id, parent, index } = op;
  if (typeof id !== "string" || typeof parent !== "string") return drop("invalid-op");
  if (index !== undefined && !isInteger(index)) return drop("invalid-op");
  const node = d.node(id);
  if (!node) return drop("missing-node");
  if (id === ROOT_ID) return drop("root-protected");
  const target = d.node(parent);
  if (!target) return drop("missing-parent");
  if (!isContainerType(target.type)) return drop("not-container");
  for (let cur: Node | undefined = target; cur; cur = d.node(cur.parent)) {
    if (cur.id === id) return drop("cycle");
  }
  if ((parent === ROOT_ID) !== (node.type === "page")) return drop("page-nesting");

  const oldParent = node.parent as Id;
  const oldSiblings = d.children(oldParent);
  const oldIndex = oldSiblings.indexOf(id);
  const without = oldSiblings.filter((c) => c !== id);
  if (oldParent !== parent) d.setChildren(oldParent, without);
  const base = oldParent === parent ? without : d.children(parent);
  const at = index === undefined ? base.length : clamp(index as number, 0, base.length);
  const next = base.slice();
  next.splice(at, 0, id);
  d.setChildren(parent, next);
  if (oldParent !== parent) d.putNode({ ...d.nodes[id], parent } as Node);

  return {
    ok: true,
    applied: { op: "move", id, parent, index: at },
    inverse: { op: "move", id, parent: oldParent, index: oldIndex },
  };
}

// asset ----------------------------------------------------------------------------------------------------------

function applyAsset(d: Draft, op: JsonObject): Outcome {
  const { set, remove } = op;
  if (set !== undefined && !isPlainObject(set)) return drop("invalid-op");
  if (remove !== undefined && !isStringArray(remove)) return drop("invalid-op");
  const setEntries = set ? Object.entries(set as JsonObject) : [];
  const removeIds = remove ? [...new Set(remove as string[])] : [];
  for (const [key, value] of setEntries) {
    if (!isPlainObject(value) || value.id !== key) return drop("invalid-op");
    if (removeIds.includes(key)) return drop("invalid-op");
  }
  for (const [, value] of setEntries) {
    if (!AssetRefSchema.safeParse(value).success) return drop("invalid-value");
  }

  const before = d.assets;
  const existing = removeIds.filter((rid) => hasOwn(before, rid));
  const invSet: Record<Id, AssetRef> = {};
  const invRemove: Id[] = [];
  const appliedSet: Record<Id, AssetRef> = {};
  if (setEntries.length > 0 || existing.length > 0) {
    const assets = d.writableAssets() as unknown as JsonObject;
    for (const [key, value] of setEntries) {
      if (hasOwn(before, key)) setOwn(invSet, key, before[key]);
      else invRemove.push(key);
      const copy = deepClone(value);
      setOwn(appliedSet, key, copy);
      setOwn(assets, key, copy);
    }
    for (const rid of existing) {
      setOwn(invSet, rid, before[rid]);
      delete assets[rid];
    }
  }
  invRemove.sort(compareCodePoints);
  const applied: Op = { op: "asset" };
  if (setEntries.length > 0) applied.set = appliedSet;
  if (existing.length > 0) applied.remove = existing;
  const inverse: Op = { op: "asset" };
  if (Object.keys(invSet).length > 0) inverse.set = invSet;
  if (invRemove.length > 0) inverse.remove = invRemove;
  return { ok: true, applied, inverse };
}

// styles ---------------------------------------------------------------------------------------------------------

function applyStyles(d: Draft, op: JsonObject): Outcome {
  const { path } = op;
  if (!isPathShape(path) || !hasOwn(op, "value")) return drop("invalid-op");
  const value = deepClone(op.value);
  const result = setAtPath(d.styles, path, value);
  if (!result) return drop("invalid-path");
  if (!DesignStylesSchema.safeParse(result.root).success) return drop("invalid-value");
  d.styles = result.root as DesignStyles;
  d.changed = true;

  const segs: PathSegment[] = path.slice();
  let inverse: Op;
  if (result.existed) inverse = { op: "styles", path: segs, value: result.oldValue };
  else inverse = { op: "styles", path: segs.slice(0, -1), value: result.parentBefore };
  return { ok: true, applied: { op: "styles", path: segs, value }, inverse };
}

// doc ------------------------------------------------------------------------------------------------------------

function applyDoc(d: Draft, op: JsonObject): Outcome {
  const { set, unset } = op;
  if (!isPlainObject(set)) return drop("invalid-op");
  if (!Object.keys(set).every((k) => DOC_SET_KEYS.has(k))) return drop("invalid-op");
  if (unset !== undefined && !(Array.isArray(unset) && unset.every((u) => u === "brandKitId"))) {
    return drop("invalid-op");
  }
  const unsetBrand = Array.isArray(unset) && unset.length > 0;
  if (unsetBrand && hasOwn(set, "brandKitId")) return drop("invalid-op");
  if (hasOwn(set, "name") && typeof set.name !== "string") return drop("invalid-value");
  if (hasOwn(set, "kind") && !(typeof set.kind === "string" && KINDS.has(set.kind))) {
    return drop("invalid-value");
  }
  if (hasOwn(set, "brandKitId") && typeof set.brandKitId !== "string") return drop("invalid-value");
  if (hasOwn(set, "meta") && !isPlainObject(set.meta)) return drop("invalid-value");

  const appliedSet: JsonObject = {};
  const invSet: JsonObject = {};
  let invUnsetBrand = false;
  if (hasOwn(set, "name")) {
    invSet.name = d.name;
    appliedSet.name = set.name;
    d.name = set.name as string;
  }
  if (hasOwn(set, "kind")) {
    invSet.kind = d.kind;
    appliedSet.kind = set.kind;
    d.kind = set.kind as DesignKind;
  }
  if (hasOwn(set, "brandKitId")) {
    if (d.hasBrandKitId) invSet.brandKitId = d.brandKitId;
    else invUnsetBrand = true;
    appliedSet.brandKitId = set.brandKitId;
    d.brandKitId = set.brandKitId as string;
    d.hasBrandKitId = true;
  }
  if (hasOwn(set, "meta")) {
    invSet.meta = d.meta;
    const meta = deepClone(set.meta as JsonObject);
    appliedSet.meta = meta;
    d.meta = meta;
  }
  if (unsetBrand && d.hasBrandKitId) {
    invSet.brandKitId = d.brandKitId;
    d.brandKitId = undefined;
    d.hasBrandKitId = false;
  }
  d.changed = true;
  const applied: DocOp = { op: "doc", set: appliedSet };
  if (unsetBrand) applied.unset = ["brandKitId"];
  const inverse: DocOp = { op: "doc", set: invSet };
  if (invUnsetBrand) inverse.unset = ["brandKitId"];
  return { ok: true, applied, inverse };
}

// ---------------------------------------------------------------------------------------------------------------

function applyOne(d: Draft, op: unknown): Outcome {
  if (!isPlainObject(op)) return drop("invalid-op");
  switch (op.op) {
    case "create":
      return applyCreate(d, op);
    case "update":
      return applyUpdate(d, op);
    case "patch":
      return applyPatch(d, op);
    case "delete":
      return applyDelete(d, op);
    case "move":
      return applyMove(d, op);
    case "asset":
      return applyAsset(d, op);
    case "styles":
      return applyStyles(d, op);
    case "doc":
      return applyDoc(d, op);
    default:
      return drop("invalid-op");
  }
}

export interface ApplyOpsResult {
  design: Design;
  applied: Op[];
  /** Inverse ops in undo order (already reversed). */
  inverseOps: Op[];
  dropped: DroppedOp[];
}

/**
 * Applies ops one at a time against one evolving working copy, for callers that must look at the state between
 * ops (the builders). Each op costs O(size of the op) instead of re-copying the node map per op the way repeated
 * `applyOps` calls would. The input design is never mutated. `design` is a live view: it stays correct for the
 * current state, but an earlier `design` value shares the node and asset maps and must not be kept across later
 * `apply` calls (take `canonicalize`/`deepClone` of it if a snapshot is needed).
 */
export class ApplySession {
  private readonly draft: Draft;
  private view: Design | undefined;

  constructor(design: Design, options: ApplyOptions = {}) {
    this.draft = new Draft(design, options.validateNodes ?? true);
  }

  /** Applies one op: its normalized form and inverse, or the drop reason. A dropped op changes nothing. */
  apply(op: unknown): { applied: Op; inverse: Op } | { dropped: DropReason } {
    const outcome = applyOne(this.draft, op);
    if (!outcome.ok) return { dropped: outcome.reason };
    this.view = undefined;
    return { applied: outcome.applied, inverse: outcome.inverse };
  }

  get design(): Design {
    if (!this.view) this.view = this.draft.finish();
    return this.view;
  }
}

/** Applies a bare op list. `applyTransaction` wraps this with transaction metadata. */
export function applyOps(
  design: Design,
  ops: readonly unknown[],
  options: ApplyOptions = {},
): ApplyOpsResult {
  const draft = new Draft(design, options.validateNodes ?? true);
  const applied: Op[] = [];
  const inverse: Op[] = [];
  const dropped: DroppedOp[] = [];
  ops.forEach((op, index) => {
    const outcome = applyOne(draft, op);
    if (outcome.ok) {
      applied.push(outcome.applied);
      inverse.push(outcome.inverse);
    } else {
      dropped.push({ index, reason: outcome.reason });
    }
  });
  inverse.reverse();
  return { design: draft.finish(), applied, inverseOps: inverse, dropped };
}

/**
 * Applies `tx` to `design` (never mutating it). Ops apply in order; an op that is malformed, references a missing
 * node or parent, would create a cycle or violates an invariant is dropped (reported in `dropped`) and never
 * throws. `applied` lists the ops that took effect in normalized form; `inverse` replays to the previous state.
 */
export function applyTransaction(
  design: Design,
  tx: Transaction,
  options: ApplyOptions = {},
): ApplyResult {
  const ops: readonly unknown[] = Array.isArray(tx.ops) ? tx.ops : [];
  const result = applyOps(design, ops, options);
  const inverse: Transaction = {
    id: options.inverseId ?? inverseTxId(tx.id),
    label: tx.label,
    ops: result.inverseOps,
    source: tx.source,
    ts: tx.ts,
  };
  if (tx.actor) inverse.actor = deepClone(tx.actor);
  return { design: result.design, inverse, applied: result.applied, dropped: result.dropped };
}

/** The inverse of `tx` relative to `design` (the state it is applied to). */
export function invert(design: Design, tx: Transaction, options: ApplyOptions = {}): Transaction {
  return applyTransaction(design, tx, options).inverse;
}
