import {
  canonicalize,
  createRect,
  type Design,
  type Transaction,
  validateDesign,
} from "@desyn/schema";
import { describe, expect, test } from "vitest";
import { applyOps, applyTransaction, inverseTxId, invert } from "../src";
import { clone, deepFreeze, randomDesign, randomOps } from "./helpers";

const tx = (ops: unknown[], extra: Partial<Transaction> = {}): Transaction =>
  ({ id: "txtxtxtxtxtx", label: "t", ops, source: "user", ts: 5, ...extra }) as Transaction;

function firstPage(d: Design): string {
  return (d.nodes.root as { children: string[] }).children[0] as string;
}

describe("applyTransaction", () => {
  test("never mutates its input (deep-frozen input works)", () => {
    for (let seed = 1; seed <= 30; seed++) {
      const d = deepFreeze(randomDesign(seed));
      const snapshot = canonicalize(d);
      applyTransaction(d, tx(randomOps(d, seed, 25)));
      expect(canonicalize(d)).toBe(snapshot);
    }
  });

  test("structural sharing: untouched nodes keep their identity", () => {
    const d = randomDesign(7);
    const page = firstPage(d);
    const r = applyTransaction(d, tx([{ op: "update", id: page, set: { name: "X" } }]));
    for (const id of Object.keys(d.nodes)) {
      if (id === page) expect(r.design.nodes[id]).not.toBe(d.nodes[id]);
      else expect(r.design.nodes[id]).toBe(d.nodes[id]);
    }
    expect(r.design.assets).toBe(d.assets);
    expect(r.design.styles).toBe(d.styles);
  });

  test("an all-dropped transaction returns the same design object", () => {
    const d = randomDesign(3);
    const r = applyTransaction(d, tx([{ op: "delete", id: "missing00000" }]));
    expect(r.design).toBe(d);
    expect(r.inverse.ops).toEqual([]);
  });

  test("random op lists keep every invariant; inverse and applied replay are exact", () => {
    for (let seed = 1; seed <= 200; seed++) {
      const d = randomDesign(seed);
      const r = applyTransaction(d, tx(randomOps(d, seed * 31, 20)));
      const v = validateDesign(r.design);
      expect(v.errors, `seed ${seed}`).toEqual([]);
      expect(r.applied.length + r.dropped.length).toBe(20);
      const undo = applyTransaction(r.design, r.inverse);
      expect(undo.dropped, `seed ${seed}`).toEqual([]);
      expect(canonicalize(undo.design), `seed ${seed}`).toBe(canonicalize(d));
      const redo = applyTransaction(undo.design, undo.inverse);
      expect(canonicalize(redo.design)).toBe(canonicalize(r.design));
      const replay = applyOps(d, r.applied);
      expect(replay.dropped).toEqual([]);
      expect(canonicalize(replay.design)).toBe(canonicalize(r.design));
    }
  });

  test("inverse metadata", () => {
    const d = randomDesign(1);
    const r = applyTransaction(
      d,
      tx([{ op: "doc", set: { name: "x" } }], {
        source: "ai",
        actor: { runId: "r1" },
        label: "AI edit",
      }),
    );
    expect(r.inverse.id).toBe(inverseTxId("txtxtxtxtxtx"));
    expect(r.inverse.id).toMatch(/^[0-9a-f]{12}$/);
    expect(r.inverse.label).toBe("AI edit");
    expect(r.inverse.source).toBe("ai");
    expect(r.inverse.actor).toEqual({ runId: "r1" });
    expect(r.inverse.ts).toBe(5);
    expect(applyTransaction(d, tx([]), { inverseId: "customcustom" }).inverse.id).toBe(
      "customcustom",
    );
    expect(invert(d, tx([{ op: "doc", set: { name: "x" } }])).ops).toEqual([
      { op: "doc", set: { name: d.name } },
    ]);
  });

  test("hostile __proto__ keys stay plain data", () => {
    const d = randomDesign(2);
    const page = firstPage(d);
    const set = JSON.parse('{"__proto__": {"polluted": true}, "name": "p"}');
    const r = applyTransaction(d, tx([{ op: "update", id: page, set }]));
    expect(r.dropped).toEqual([]);
    const node = r.design.nodes[page] as unknown as Record<string, unknown>;
    expect(Object.getPrototypeOf(node)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.hasOwn(node, "__proto__")).toBe(true);
    const patched = applyTransaction(
      d,
      tx([{ op: "patch", id: page, path: ["__proto__"], value: { x: 1 } }]),
    );
    expect(Object.getPrototypeOf(patched.design.nodes[page])).toBe(Object.prototype);
    const back = applyTransaction(r.design, r.inverse);
    expect(canonicalize(back.design)).toBe(canonicalize(d));
  });

  test("validateNodes: false skips shape validation but keeps structure checks", () => {
    const d = randomDesign(4);
    const page = firstPage(d);
    const bad = { ...createRect({ id: "rectrectrect", parent: page }), opacity: 7 };
    expect(
      applyTransaction(d, tx([{ op: "create", nodes: [bad], parent: page }])).dropped,
    ).toHaveLength(1);
    const loose = applyTransaction(d, tx([{ op: "create", nodes: [bad], parent: page }]), {
      validateNodes: false,
    });
    expect(loose.dropped).toEqual([]);
    const structural = applyTransaction(
      d,
      tx([{ op: "create", nodes: [{ ...bad, children: [] }], parent: page }]),
      { validateNodes: false },
    );
    expect(structural.dropped[0]?.reason).toBe("invalid-node");
  });

  test("tx.ops that is not an array applies nothing", () => {
    const d = randomDesign(5);
    const r = applyTransaction(d, { ...tx([]), ops: null as never });
    expect(r.applied).toEqual([]);
    expect(r.design).toBe(d);
  });

  test("created nodes are copies of the op payload", () => {
    const d = randomDesign(6);
    const page = firstPage(d);
    const node = createRect({ id: "rectrectrect", parent: page });
    const op = { op: "create", nodes: [node], parent: page };
    const r = applyTransaction(d, tx([op]));
    node.name = "mutated later";
    expect(r.design.nodes.rectrectrect?.name).toBe("Rectangle");
  });

  test("brandKitId round trip through doc set / unset", () => {
    const d = clone(randomDesign(8));
    const set = applyTransaction(d, tx([{ op: "doc", set: { brandKitId: "kit" } }]));
    expect(set.design.brandKitId).toBe("kit");
    const back = applyTransaction(set.design, set.inverse);
    expect("brandKitId" in back.design).toBe(false);
    const unset = applyTransaction(set.design, tx([{ op: "doc", set: {}, unset: ["brandKitId"] }]));
    expect("brandKitId" in unset.design).toBe(false);
    expect(applyTransaction(unset.design, unset.inverse).design.brandKitId).toBe("kit");
  });
});
