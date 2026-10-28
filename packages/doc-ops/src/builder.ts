// Incremental transaction builder used by every high-level builder: each op is applied to a working copy right
// away so later ops are computed against the evolving state, and an op the applier would drop is a bug (throws).
import type { Design, Id, Node, Op, Transaction } from "@desyn/schema";
import { ApplySession } from "./apply";
import {
  applyToVector,
  boundsOfPoints,
  boxCorners,
  decompose,
  invertMatrix,
  localTransform,
  multiply,
  type Placement,
  parentSpaceTransform,
  translate,
} from "./geometry";
import { getNode, parentChain } from "./tree";
import { makeTransaction, type TxOptions } from "./tx";
import { DocOpsError, deepEqual, hasOwn, type JsonObject, roundGeom, setOwn } from "./util";

const EPS = 1e-4;

export class Builder {
  readonly ops: Op[] = [];
  private readonly session: ApplySession;

  constructor(readonly base: Design) {
    this.session = new ApplySession(base);
  }

  /** The working state (base + ops so far). A live view: do not hold on to it across `push` calls. */
  get design(): Design {
    return this.session.design;
  }

  node(id: Id): Node {
    const n = getNode(this.design, id);
    if (!n) throw new DocOpsError(`node "${id}" does not exist`);
    return n;
  }

  push(op: Op): void {
    const r = this.session.apply(op);
    if ("dropped" in r) {
      throw new DocOpsError(`builder produced a ${op.op} op that does not apply (${r.dropped})`);
    }
    this.ops.push(op);
  }

  /** Pushes an update with only the keys whose value actually changes. */
  update(id: Id, set: JsonObject, unset: string[] = []): void {
    const node = this.node(id) as unknown as JsonObject;
    const changed: JsonObject = {};
    for (const [k, v] of Object.entries(set)) {
      if (!hasOwn(node, k) || !deepEqual(node[k], v)) setOwn(changed, k, v);
    }
    const removing = unset.filter((k) => hasOwn(node, k));
    if (Object.keys(changed).length === 0 && removing.length === 0) return;
    const op: Op = { op: "update", id };
    if (Object.keys(changed).length > 0) op.set = changed;
    if (removing.length > 0) op.unset = removing;
    this.push(op);
  }

  /** Writes a placement (x, y, rotation, flips) computed by `decompose`, rounded to 1/10000 px. */
  place(id: Id, p: Placement): void {
    const node = this.node(id);
    const set: JsonObject = {
      x: roundGeom(p.x),
      y: roundGeom(p.y),
      rotation: roundGeom(p.rotation),
    };
    const unset: string[] = [];
    if (p.flipX) set.flipX = true;
    else if (node.flipX) unset.push("flipX");
    if (p.flipY) set.flipY = true;
    else if (node.flipY) unset.push("flipY");
    this.update(id, set, unset);
  }

  /** Translates a node by a delta given in page coordinates. */
  translateInPage(id: Id, dx: number, dy: number): void {
    if (Math.abs(dx) < EPS && Math.abs(dy) < EPS) return;
    const node = this.node(id);
    const local = applyToVector(invertMatrix(parentSpaceTransform(this.design, id)), {
      x: dx,
      y: dy,
    });
    this.update(id, { x: roundGeom(node.x + local.x), y: roundGeom(node.y + local.y) });
  }

  /**
   * Recomputes the derived bounds of every group that contains (or is) one of `ids`, deepest first, keeping each
   * child's position on the page unchanged.
   */
  refitGroups(ids: Iterable<Id>): void {
    const groups = new Map<Id, number>();
    for (const id of ids) {
      const node = getNode(this.design, id);
      if (!node) continue;
      const chain = [node, ...parentChain(this.design, id)];
      chain.forEach((n, i) => {
        if (n.type === "group") groups.set(n.id, Math.max(groups.get(n.id) ?? 0, chain.length - i));
      });
    }
    const deepestFirst = [...groups.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
    for (const id of deepestFirst) this.refitGroup(id);
  }

  private refitGroup(id: Id): void {
    const group = getNode(this.design, id) as (Node & { children: Id[] }) | undefined;
    if (group?.type !== "group" || group.children.length === 0) return;
    const kids = group.children.map((c) => this.node(c));
    const b = boundsOfPoints(kids.flatMap((k) => boxCorners(k.width, k.height, localTransform(k))));
    if (
      Math.abs(b.x) < EPS &&
      Math.abs(b.y) < EPS &&
      Math.abs(b.width - group.width) < EPS &&
      Math.abs(b.height - group.height) < EPS
    ) {
      return;
    }
    const placement = decompose(
      multiply(localTransform(group), translate(b.x, b.y)),
      b.width,
      b.height,
      group,
    );
    this.update(id, {
      x: roundGeom(placement.x),
      y: roundGeom(placement.y),
      width: roundGeom(b.width),
      height: roundGeom(b.height),
      rotation: roundGeom(placement.rotation),
    });
    for (const k of kids) this.update(k.id, { x: roundGeom(k.x - b.x), y: roundGeom(k.y - b.y) });
  }

  build(label: string, options: TxOptions = {}): Transaction {
    return makeTransaction(this.ops, label, options);
  }
}
