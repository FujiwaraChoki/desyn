import { canonicalize, createFrame, createRect, type Design, validateDesign } from "@desyn/schema";
import { describe, expect, test } from "vitest";
import { applyTransaction, diffDesigns, diffOps } from "../src";
import { clone, mutate, randomDesign } from "./helpers";

function roundTrip(a: Design, b: Design) {
  const tx = diffDesigns(a, b, { id: "diffdiffdiff", ts: 0 });
  const r = applyTransaction(a, tx);
  return { tx, r };
}

describe("diffDesigns", () => {
  test("identical designs give an empty transaction", () => {
    const a = randomDesign(1);
    expect(diffOps(a, clone(a))).toEqual([]);
    const tx = diffDesigns(a, a);
    expect(tx.ops).toEqual([]);
    expect(tx.source).toBe("system");
  });

  test("apply(diff(a, b)) == b for 400 random mutation chains", () => {
    for (let seed = 1; seed <= 400; seed++) {
      const a = randomDesign(seed);
      const b = mutate(a, seed * 7 + 1, 1 + (seed % 12));
      const vb = validateDesign(b);
      expect(vb.errors, `mutation ${seed} produced an invalid design`).toEqual([]);
      const { tx, r } = roundTrip(a, b);
      expect(r.dropped, `seed ${seed}: ${JSON.stringify(tx.ops)}`).toEqual([]);
      expect(canonicalize(r.design), `seed ${seed}`).toBe(canonicalize(b));
      // And back.
      const back = roundTrip(b, a);
      expect(back.r.dropped, `reverse seed ${seed}`).toEqual([]);
      expect(canonicalize(back.r.design), `reverse seed ${seed}`).toBe(canonicalize(a));
    }
  });

  test("between unrelated random designs", () => {
    for (let seed = 1; seed <= 60; seed++) {
      const a = randomDesign(seed);
      const b = randomDesign(seed + 1000);
      const { r } = roundTrip(a, b);
      expect(r.dropped).toEqual([]);
      expect(canonicalize(r.design)).toBe(canonicalize(b));
    }
  });

  test("one op per changed node; reorders use the minimum number of moves", () => {
    const a = randomDesign(11);
    const pageId = (a.nodes.root as { children: string[] }).children[0] as string;
    const b = clone(a);
    const page = b.nodes[pageId] as { children: string[] };
    page.children = [...page.children.slice(1), page.children[0] as string];
    const ops = diffOps(a, b);
    if ((a.nodes[pageId] as { children: string[] }).children.length > 1) {
      expect(ops).toHaveLength(1);
      expect(ops[0]?.op).toBe("move");
    }
    const c = clone(a);
    const first = page.children[0] as string;
    (c.nodes[first] as { name: string }).name = "Changed";
    (c.nodes[first] as { x: number }).x = 1234;
    expect(diffOps(a, c)).toEqual([{ op: "update", id: first, set: { name: "Changed", x: 1234 } }]);
  });

  test("new subtrees are created in one op", () => {
    const a = randomDesign(12);
    const pageId = (a.nodes.root as { children: string[] }).children[0] as string;
    const b = clone(a);
    b.nodes.frameframefr = createFrame({
      id: "frameframefr",
      parent: pageId,
      children: ["rectrectrect"],
    });
    b.nodes.rectrectrect = createRect({ id: "rectrectrect", parent: "frameframefr" });
    (b.nodes[pageId] as { children: string[] }).children.splice(0, 0, "frameframefr");
    const ops = diffOps(a, b);
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ op: "create", parent: pageId, index: 0 });
    expect((ops[0] as { nodes: unknown[] }).nodes).toHaveLength(2);
  });

  test("retyped node with surviving children", () => {
    const a = randomDesign(13);
    const pageId = (a.nodes.root as { children: string[] }).children[0] as string;
    a.nodes.frameframefr = createFrame({
      id: "frameframefr",
      parent: pageId,
      children: ["rectrectrect"],
    });
    a.nodes.rectrectrect = createRect({ id: "rectrectrect", parent: "frameframefr" });
    (a.nodes[pageId] as { children: string[] }).children.push("frameframefr");
    const b = clone(a);
    b.nodes.frameframefr = {
      ...createFrame({ id: "frameframefr", parent: pageId }),
      type: "group",
      children: ["rectrectrect"],
    } as never;
    delete (b.nodes.frameframefr as unknown as Record<string, unknown>).fills;
    delete (b.nodes.frameframefr as unknown as Record<string, unknown>).strokes;
    delete (b.nodes.frameframefr as unknown as Record<string, unknown>).cornerRadius;
    expect(validateDesign(b).errors).toEqual([]);
    const { r } = roundTrip(a, b);
    expect(r.dropped).toEqual([]);
    expect(canonicalize(r.design)).toBe(canonicalize(b));
  });

  test("doc, asset and style changes", () => {
    const a = randomDesign(14);
    const b = clone(a);
    b.name = "New";
    b.brandKitId = "kit";
    b.assets = {};
    b.styles.colors = {};
    b.styles.variables.x = 1;
    const ops = diffOps(a, b);
    expect(ops.map((o) => o.op)).toEqual(["doc", "asset", "styles", "styles"]);
    const { r } = roundTrip(a, b);
    expect(canonicalize(r.design)).toBe(canonicalize(b));
    const c = clone(b);
    delete c.brandKitId;
    expect(diffOps(b, c)).toEqual([{ op: "doc", set: {}, unset: ["brandKitId"] }]);
  });

  test("removed top-level style key replaces all styles", () => {
    const a = randomDesign(15);
    (a.styles as unknown as Record<string, unknown>).future = { x: 1 };
    const b = clone(a);
    delete (b.styles as unknown as Record<string, unknown>).future;
    expect(diffOps(a, b)).toEqual([{ op: "styles", path: [], value: b.styles }]);
  });
});
