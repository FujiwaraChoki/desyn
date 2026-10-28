import { applyTransaction } from "@desyn/doc-ops";
import { describe, expect, it } from "vitest";
import { dropContainerAt, insertionIndex } from "../../src/canvas/autolayout.ts";
import { localHitPath } from "../../src/canvas/hit.ts";
import {
  enterTarget,
  layersAt,
  levelContainer,
  marqueeSelect,
  pickTarget,
  selectThrough,
} from "../../src/canvas/selection.ts";
import {
  createDesign,
  createFrame,
  createGroup,
  createRect,
  type Design,
  makeTx,
} from "./fixtures.ts";

/** page: A (rect), G (group: G1, G2), F (frame: F1, row auto-layout L: L1 L2 L3), locked K. */
function scene() {
  const { design, page } = createDesign();
  const a = createRect({ parent: page, name: "A", x: 10, y: 10, width: 100, height: 100 });
  const g = createGroup({ parent: page, name: "G", x: 200, y: 0, width: 200, height: 100 });
  const g1 = createRect({ parent: g.id, name: "G1", x: 0, y: 0, width: 100, height: 100 });
  const g2 = createRect({ parent: g.id, name: "G2", x: 100, y: 0, width: 100, height: 100 });
  const f = createFrame({ parent: page, name: "F", x: 0, y: 300, width: 600, height: 300 });
  const f1 = createRect({ parent: f.id, name: "F1", x: 20, y: 20, width: 50, height: 50 });
  const l = createFrame({
    parent: f.id,
    name: "L",
    x: 100,
    y: 100,
    width: 400,
    height: 100,
    layout: {
      mode: "row",
      gap: 20,
      padding: [10, 10, 10, 10],
      mainAlign: "start",
      crossAlign: "start",
    },
  });
  const kids = [0, 1, 2].map((i) =>
    createRect({ parent: l.id, name: `L${i + 1}`, x: 10 + i * 120, y: 10, width: 100, height: 80 }),
  );
  const k = createRect({
    parent: page,
    name: "K",
    x: 700,
    y: 0,
    width: 50,
    height: 50,
    locked: true,
  });
  const ops = [
    { op: "create" as const, nodes: [a], parent: page },
    { op: "create" as const, nodes: [g], parent: page },
    { op: "create" as const, nodes: [g1], parent: g.id },
    { op: "create" as const, nodes: [g2], parent: g.id },
    { op: "create" as const, nodes: [f], parent: page },
    { op: "create" as const, nodes: [f1], parent: f.id },
    { op: "create" as const, nodes: [l], parent: f.id },
    ...kids.map((n) => ({ op: "create" as const, nodes: [n], parent: l.id })),
    { op: "create" as const, nodes: [k], parent: page },
  ];
  const r = applyTransaction(design, makeTx(ops));
  expect(r.dropped).toEqual([]);
  return {
    d: r.design as Design,
    page,
    a: a.id,
    g: g.id,
    g1: g1.id,
    g2: g2.id,
    f: f.id,
    f1: f1.id,
    l: l.id,
    l1: kids[0]?.id as string,
    l2: kids[1]?.id as string,
    l3: kids[2]?.id as string,
    k: k.id,
  };
}

describe("click selection", () => {
  it("selects the page-level layer, the deepest with deep select", () => {
    const s = scene();
    const path = localHitPath(s.d, s.page, { x: 250, y: 50 });
    expect(path).toEqual([s.g, s.g1]);
    expect(pickTarget(s.d, path, { scopeId: null, selection: [] })).toBe(s.g);
    expect(pickTarget(s.d, path, { scopeId: null, selection: [] }, { deep: true })).toBe(s.g1);
  });

  it("selects siblings of the current selection (selection context)", () => {
    const s = scene();
    const path = localHitPath(s.d, s.page, { x: 350, y: 50 });
    expect(pickTarget(s.d, path, { scopeId: null, selection: [s.g1] })).toBe(s.g2);
  });

  it("selects children of an entered container", () => {
    const s = scene();
    const path = localHitPath(s.d, s.page, { x: 30, y: 330 });
    expect(path).toEqual([s.f, s.f1]);
    expect(pickTarget(s.d, path, { scopeId: s.f, selection: [] })).toBe(s.f1);
    // The container itself when its own area is hit.
    const empty = localHitPath(s.d, s.page, { x: 590, y: 590 });
    expect(pickTarget(s.d, empty, { scopeId: s.f, selection: [] })).toBe(s.f);
  });

  it("enters groups on double click", () => {
    const s = scene();
    const path = localHitPath(s.d, s.page, { x: 350, y: 50 });
    expect(enterTarget(s.d, path, s.g)).toBe(s.g2);
    expect(enterTarget(s.d, path, s.a)).toBeNull();
  });

  it("skips locked layers and walks select-through stacks", () => {
    const s = scene();
    expect(localHitPath(s.d, s.page, { x: 720, y: 20 })).toEqual([]);
    const stack = layersAt(s.d, s.f, { x: 120, y: 420 });
    expect(stack).toEqual([s.l]);
    expect(selectThrough([s.a, s.g, s.f], s.g)).toBe(s.f);
    expect(selectThrough([s.a, s.g, s.f], s.f)).toBe(s.a);
    expect(selectThrough([s.a], undefined)).toBe(s.a);
  });
});

describe("marquee", () => {
  it("selects touching layers, or contained ones with alt", () => {
    const s = scene();
    const rect = { x: 0, y: 0, w: 250, h: 50 };
    expect(marqueeSelect(s.d, s.page, rect)).toEqual([s.a, s.g]);
    expect(marqueeSelect(s.d, s.page, { x: 0, y: 0, w: 450, h: 150 }, { contain: true })).toEqual([
      s.a,
      s.g,
    ]);
    expect(marqueeSelect(s.d, s.page, rect, { contain: true })).toEqual([]);
  });

  it("picks the deepest layers with deep select and stays in its level", () => {
    const s = scene();
    const rect = { x: 0, y: 0, w: 600, h: 600 };
    expect(marqueeSelect(s.d, s.page, rect, { deep: true })).toEqual([
      s.a,
      s.g1,
      s.g2,
      s.f1,
      s.l1,
      s.l2,
      s.l3,
    ]);
    const level = levelContainer(s.d, s.page, { scopeId: null, selection: [s.l1] });
    expect(level).toBe(s.l);
    expect(marqueeSelect(s.d, level, { x: 100, y: 400, w: 110, h: 20 })).toEqual([s.l1]);
  });
});

describe("auto-layout and drop targets", () => {
  it("computes the reorder index along the main axis", () => {
    const s = scene();
    // Page coordinates of L's children: x = 100 + 10 + i·120, y = 400.
    const before = insertionIndex(s.d, s.l, [s.l3], { x: 112, y: 440 });
    expect(before?.index).toBe(0);
    const middle = insertionIndex(s.d, s.l, [s.l1], { x: 300, y: 440 });
    expect(middle?.index).toBe(1);
    const end = insertionIndex(s.d, s.l, [s.l1], { x: 490, y: 440 });
    expect(end?.index).toBe(2);
    expect(end?.line[0].y).toBeCloseTo(410);
  });

  it("drops into the deepest frame under the pointer, never into moving layers", () => {
    const s = scene();
    expect(dropContainerAt(s.d, s.page, { x: 300, y: 440 }, [])).toBe(s.l);
    expect(dropContainerAt(s.d, s.page, { x: 50, y: 350 }, [])).toBe(s.f);
    expect(dropContainerAt(s.d, s.page, { x: 300, y: 440 }, [s.l])).toBe(s.f);
    expect(dropContainerAt(s.d, s.page, { x: 50, y: 50 }, [])).toBe(s.page);
  });
});
