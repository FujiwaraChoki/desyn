import { createDesign, createFrame, createGroup, createRect, type Design } from "@desyn/schema";
import { describe, expect, test } from "vitest";
import {
  applyToPoint,
  approxBounds,
  boundsOfSelection,
  childIds,
  children,
  cloneSubtree,
  decompose,
  descendants,
  findNodes,
  getNode,
  IDENTITY,
  invertMatrix,
  isAncestor,
  localTransform,
  lowestCommonAncestor,
  multiply,
  normalizeDegrees,
  pageOf,
  pages,
  parentChain,
  pathTo,
  rectContains,
  rectsIntersect,
  rotate,
  siblings,
  sortByDocumentOrder,
  subtree,
  topLevelSelection,
  worldTransform,
  zIndex,
} from "../src";
import { applyOps } from "../src/apply";

const P = "page00000001";

/** page > frame(100,100 400x200 rot 90) > [rect a (0,0 100x50), group g > rect b] ; page > rect c */
function fixture(): Design {
  const d = createDesign("custom", "instagram-post", { id: "dsn000000001", pageId: P, now: 0 });
  const nodes = [
    createFrame({
      id: "frame0000001",
      parent: P,
      x: 100,
      y: 100,
      width: 400,
      height: 200,
      rotation: 90,
      children: ["recta0000001", "group0000001"],
    }),
    createRect({ id: "recta0000001", parent: "frame0000001", x: 0, y: 0, width: 100, height: 50 }),
    createGroup({
      id: "group0000001",
      parent: "frame0000001",
      x: 200,
      y: 100,
      width: 50,
      height: 50,
      children: ["rectb0000001"],
    }),
    createRect({ id: "rectb0000001", parent: "group0000001", x: 0, y: 0, width: 50, height: 50 }),
    createRect({ id: "rectc0000001", parent: P, x: 10, y: 10, width: 20, height: 20 }),
  ];
  for (const n of nodes) d.nodes[n.id] = n;
  (d.nodes[P] as { children: string[] }).children.push("frame0000001", "rectc0000001");
  return d;
}

describe("tree helpers", () => {
  const d = fixture();
  test("navigation", () => {
    expect(getNode(d, "nope")).toBeUndefined();
    expect(getNode(d, "toString")).toBeUndefined();
    expect(childIds(d, P)).toEqual(["frame0000001", "rectc0000001"]);
    expect(children(d, "frame0000001").map((n) => n.id)).toEqual(["recta0000001", "group0000001"]);
    expect(parentChain(d, "rectb0000001").map((n) => n.id)).toEqual([
      "group0000001",
      "frame0000001",
      P,
      "root",
    ]);
    expect(pathTo(d, "rectb0000001")).toEqual([
      "root",
      P,
      "frame0000001",
      "group0000001",
      "rectb0000001",
    ]);
    expect(pathTo(d, "nope")).toEqual([]);
    expect(descendants(d, "frame0000001").map((n) => n.id)).toEqual([
      "recta0000001",
      "group0000001",
      "rectb0000001",
    ]);
    expect(subtree(d, "group0000001").map((n) => n.id)).toEqual(["group0000001", "rectb0000001"]);
    expect(isAncestor(d, "frame0000001", "rectb0000001")).toBe(true);
    expect(isAncestor(d, "rectb0000001", "frame0000001")).toBe(false);
    expect(isAncestor(d, "frame0000001", "frame0000001")).toBe(false);
    expect(pageOf(d, "rectb0000001")?.id).toBe(P);
    expect(pageOf(d, P)?.id).toBe(P);
    expect(pageOf(d, "root")).toBeUndefined();
    expect(pages(d).map((p) => p.id)).toEqual([P]);
    expect(zIndex(d, "group0000001")).toBe(1);
    expect(zIndex(d, "root")).toBe(-1);
    expect(siblings(d, "recta0000001").map((n) => n.id)).toEqual(["group0000001"]);
    expect(findNodes(d, (n) => n.type === "rect").map((n) => n.id)).toEqual([
      "recta0000001",
      "rectb0000001",
      "rectc0000001",
    ]);
    expect(findNodes(d, (n) => n.type === "rect", "group0000001").map((n) => n.id)).toEqual([
      "rectb0000001",
    ]);
  });

  test("selection helpers", () => {
    expect(
      sortByDocumentOrder(d, ["rectc0000001", "recta0000001", "nope", "recta0000001"]),
    ).toEqual(["recta0000001", "rectc0000001"]);
    expect(topLevelSelection(d, ["rectb0000001", "frame0000001", "root", "rectc0000001"])).toEqual([
      "frame0000001",
      "rectc0000001",
    ]);
    expect(lowestCommonAncestor(d, ["recta0000001", "rectb0000001"])?.id).toBe("frame0000001");
    expect(lowestCommonAncestor(d, ["recta0000001"])?.id).toBe("recta0000001");
    expect(lowestCommonAncestor(d, ["recta0000001", "rectc0000001"])?.id).toBe(P);
    expect(lowestCommonAncestor(d, [])).toBeUndefined();
  });

  test("cloneSubtree produces a valid create op with fresh ids", () => {
    const { op, idMap } = cloneSubtree(d, "frame0000001", { offset: { x: 5, y: 5 } });
    expect(op.nodes).toHaveLength(4);
    expect(op.index).toBe(1);
    expect(idMap.size).toBe(4);
    expect(op.nodes[0]?.x).toBe(105);
    for (const n of op.nodes) expect(d.nodes[n.id]).toBeUndefined();
    const r = applyOps(d, [op]);
    expect(r.dropped).toEqual([]);
    const ids = new Map([["recta0000001", "copya0000001"]]);
    const mapped = cloneSubtree(d, "recta0000001", { newIds: ids, parent: P, name: "Copy" });
    expect(mapped.op.nodes[0]?.id).toBe("copya0000001");
    expect(mapped.op.nodes[0]?.name).toBe("Copy");
    expect(mapped.op.index).toBe(2);
    expect(() => cloneSubtree(d, "root")).toThrow();
    expect(() => cloneSubtree(d, "nope")).toThrow();
  });
});

describe("geometry", () => {
  const d = fixture();
  test("matrices", () => {
    const m = multiply(rotate(30), [2, 0, 0, 3, 5, 7]);
    const back = multiply(m, invertMatrix(m));
    back.forEach((v, i) => {
      expect(v).toBeCloseTo(IDENTITY[i] as number, 10);
    });
    expect(() => invertMatrix([0, 0, 0, 0, 0, 0])).toThrow();
    expect(normalizeDegrees(270)).toBe(-90);
    expect(normalizeDegrees(-180)).toBe(180);
    expect(normalizeDegrees(360)).toBe(0);
  });

  test("rotation-aware world transforms and bounds", () => {
    // frame 400x200 at (100,100) rotated 90° about its center (300,200): its AABB is 200x400 at (200,0).
    const fb = approxBounds(d, "frame0000001");
    expect(fb?.x).toBeCloseTo(200, 6);
    expect(fb?.y).toBeCloseTo(0, 6);
    expect(fb?.width).toBeCloseTo(200, 6);
    expect(fb?.height).toBeCloseTo(400, 6);
    // rect a at frame-local (0,0)-(100,50) maps to x in [350,400], y in [0,100]
    const ab = approxBounds(d, "recta0000001");
    expect(ab?.x).toBeCloseTo(350, 6);
    expect(ab?.y).toBeCloseTo(0, 6);
    expect(ab?.width).toBeCloseTo(50, 6);
    expect(ab?.height).toBeCloseTo(100, 6);
    expect(approxBounds(d, P)).toEqual({ x: 0, y: 0, width: 1080, height: 1080 });
    const canvas = worldTransform(d, P, "canvas");
    expect(canvas).toEqual([1, 0, 0, 1, 0, 0]);
    expect(worldTransform(d, "root")).toEqual(IDENTITY);
    expect(approxBounds(d, "nope")).toBeUndefined();
    const sel = boundsOfSelection(d, ["recta0000001", "rectc0000001"]);
    expect(sel?.x).toBeCloseTo(10, 6);
    expect(sel?.width).toBeCloseTo(390, 6);
    expect(boundsOfSelection(d, [])).toBeUndefined();
  });

  test("flips mirror about the center", () => {
    const m = localTransform({ x: 0, y: 0, width: 100, height: 50, rotation: 0, flipX: true });
    expect(applyToPoint(m, { x: 0, y: 0 })).toEqual({ x: 100, y: 0 });
  });

  test("decompose inverts localTransform", () => {
    for (const rotation of [0, 30, -45, 90, 179, -170]) {
      for (const flipX of [false, true]) {
        for (const flipY of [false, true]) {
          const box = { x: 12.5, y: -40, width: 80, height: 30, rotation, flipX, flipY };
          const p = decompose(localTransform(box), 80, 30, { flipX, flipY });
          const again = localTransform({ ...box, ...p });
          localTransform(box).forEach((v, i) => {
            expect(again[i]).toBeCloseTo(v, 9);
          });
          expect(p.x).toBeCloseTo(12.5, 9);
          expect(p.y).toBeCloseTo(-40, 9);
        }
      }
    }
    // Handedness flip toggles flipX when the preferred flips cannot match.
    const mirrored = localTransform({
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      rotation: 0,
      flipY: true,
    });
    const p = decompose(mirrored, 10, 10, {});
    expect(p.flipX).toBe(true);
    expect(Math.abs(p.rotation)).toBeCloseTo(180, 9);
  });

  test("rect predicates", () => {
    const a = { x: 0, y: 0, width: 10, height: 10 };
    expect(rectsIntersect(a, { x: 5, y: 5, width: 10, height: 10 })).toBe(true);
    expect(rectsIntersect(a, { x: 10, y: 0, width: 10, height: 10 })).toBe(false);
    expect(rectContains(a, { x: 1, y: 1, width: 2, height: 2 })).toBe(true);
    expect(rectContains(a, { x: 9, y: 9, width: 2, height: 2 })).toBe(false);
  });
});
