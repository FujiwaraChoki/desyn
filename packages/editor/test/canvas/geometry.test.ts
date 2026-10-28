import { applyTransaction, worldTransform } from "@desyn/doc-ops";
import { describe, expect, it } from "vitest";
import { nodeObb, selectionBox } from "../../src/canvas/geometry.ts";
import { handleDirection, hitHandles } from "../../src/canvas/handles.ts";
import {
  apply,
  constrainAngle,
  normDeg,
  obbAabb,
  obbCenter,
  obbIntersectsRect,
  obbRotation,
  rectContainsObb,
  rotation,
  rotationAbout,
  snapAngle,
  translation,
} from "../../src/canvas/math.ts";
import { measureBetween } from "../../src/canvas/measure.ts";
import {
  handleEdges,
  lineEndpointOps,
  lineEndpoints,
  moveOps,
  polygonPoints,
  radiusFromPointer,
  resizeObb,
  starPoints,
  transformOps,
} from "../../src/canvas/transform.ts";
import {
  createDesign,
  createGroup,
  createLine,
  createPath,
  createRect,
  type Design,
  makeTx,
} from "./fixtures.ts";

const close = (a: number, b: number, eps = 1e-6) => expect(Math.abs(a - b)).toBeLessThan(eps);

function applyOps(design: Design, ops: Parameters<typeof makeTx>[0]): Design {
  return applyTransaction(design, makeTx(ops)).design;
}

describe("plane math", () => {
  it("normalizes and snaps angles", () => {
    expect(normDeg(190)).toBe(-170);
    expect(normDeg(-180)).toBe(180);
    expect(normDeg(720)).toBe(0);
    expect(snapAngle(22, 15)).toBe(15);
    expect(snapAngle(23, 15)).toBe(30);
    expect(snapAngle(-7, 15)).toBe(0);
  });

  it("constrains a point to 45° steps keeping the projection", () => {
    const p = constrainAngle({ x: 0, y: 0 }, { x: 10, y: 1 }, 45);
    close(p.y, 0);
    close(p.x, 10);
    const d = constrainAngle({ x: 0, y: 0 }, { x: 10, y: 9 }, 45);
    close(d.x, d.y);
  });

  it("intersects rotated boxes with rectangles (SAT)", () => {
    // A 100×10 bar rotated 45° about its center at (50, 5).
    const bar = { m: rotationAbout({ x: 50, y: 5 }, 45), w: 100, h: 10 };
    expect(obbIntersectsRect(bar, { x: 45, y: 0, w: 10, h: 10 })).toBe(true);
    // The axis-aligned bounds contain this corner, the rotated bar does not.
    const aabb = obbAabb(bar);
    expect(obbIntersectsRect(bar, { x: aabb.x + aabb.w - 5, y: aabb.y, w: 5, h: 5 })).toBe(false);
    expect(rectContainsObb({ x: -100, y: -100, w: 400, h: 400 }, bar)).toBe(true);
  });
});

describe("node geometry", () => {
  it("reads rotated, nested boxes in page space", () => {
    const { design, page } = createDesign();
    const g = createGroup({ parent: page, x: 100, y: 100, width: 200, height: 100, rotation: 90 });
    const r = createRect({ parent: g.id, x: 0, y: 0, width: 200, height: 100 });
    const d = applyOps(design, [
      { op: "create", nodes: [g], parent: page },
      { op: "create", nodes: [r], parent: g.id },
    ]);
    const box = nodeObb(d, r.id);
    expect(box).not.toBeNull();
    const c = obbCenter(box as NonNullable<typeof box>);
    close(c.x, 200);
    close(c.y, 150);
    close(obbRotation(box as NonNullable<typeof box>), 90);
  });

  it("uses a shared rotated frame for multi-selections with equal rotation", () => {
    const { design, page } = createDesign();
    const a = createRect({ parent: page, x: 0, y: 0, width: 50, height: 50, rotation: 30 });
    const b = createRect({ parent: page, x: 100, y: 0, width: 50, height: 50, rotation: 30 });
    const c = createRect({ parent: page, x: 200, y: 0, width: 50, height: 50, rotation: 0 });
    const d = applyOps(design, [
      { op: "create", nodes: [a], parent: page },
      { op: "create", nodes: [b], parent: page },
      { op: "create", nodes: [c], parent: page },
    ]);
    expect(selectionBox(d, [a.id, b.id])?.rotation).toBeCloseTo(30);
    expect(selectionBox(d, [a.id, c.id])?.rotation).toBe(0);
  });
});

describe("resize math", () => {
  const box = { m: translation(100, 100), w: 200, h: 100 };

  it("drags a corner with the opposite corner fixed", () => {
    const r = resizeObb(box, "bottom-right", { x: 400, y: 300 });
    close(r.box.w, 300);
    close(r.box.h, 200);
    const tl = apply(r.box.m, { x: 0, y: 0 });
    close(tl.x, 100);
    close(tl.y, 100);
  });

  it("keeps the aspect ratio and resizes from the center", () => {
    const r = resizeObb(box, "bottom-right", { x: 500, y: 210 }, { keepAspect: true });
    close(r.box.w / r.box.h, 2);
    const c = resizeObb(box, "right", { x: 350, y: 150 }, { fromCenter: true });
    close(c.box.w, 300);
    close(obbCenter(c.box).x, 200);
  });

  it("flips when dragged past the opposite side", () => {
    const r = resizeObb(box, "right", { x: 50, y: 150 });
    expect(r.flipX).toBe(true);
    close(r.box.w, 50);
    // The page map mirrors: the old left edge (x = 100) stays put.
    close(apply(r.page, { x: 100, y: 100 }).x, 100);
    close(apply(r.page, { x: 300, y: 100 }).x, 50);
  });

  it("reports the edges a handle moves", () => {
    expect(handleEdges("top-left")).toEqual({ left: true, right: false, top: true, bottom: false });
    expect(handleEdges("right", true)).toEqual({
      left: true,
      right: true,
      top: false,
      bottom: false,
    });
  });

  it("scales a group by scaling its children and refitting", () => {
    const { design, page } = createDesign();
    const g = createGroup({ parent: page, x: 0, y: 0, width: 100, height: 100 });
    const a = createRect({ parent: g.id, x: 0, y: 0, width: 50, height: 50 });
    const b = createRect({ parent: g.id, x: 50, y: 50, width: 50, height: 50 });
    let d = applyOps(design, [
      { op: "create", nodes: [g], parent: page },
      { op: "create", nodes: [a], parent: g.id },
      { op: "create", nodes: [b], parent: g.id },
    ]);
    const r = resizeObb({ m: translation(0, 0), w: 100, h: 100 }, "bottom-right", {
      x: 200,
      y: 100,
    });
    d = applyOps(d, transformOps(d, [g.id], r.page));
    expect(d.nodes[g.id]?.width).toBeCloseTo(200);
    expect(d.nodes[a.id]?.width).toBeCloseTo(100);
    expect(d.nodes[b.id]?.x).toBeCloseTo(100);
  });

  it("rotates nodes about a center and keeps their size", () => {
    const { design, page } = createDesign();
    const r = createRect({ parent: page, x: 0, y: 0, width: 100, height: 50 });
    let d = applyOps(design, [{ op: "create", nodes: [r], parent: page }]);
    d = applyOps(d, transformOps(d, [r.id], rotationAbout({ x: 50, y: 25 }, 90)));
    const n = d.nodes[r.id];
    expect(n?.rotation).toBeCloseTo(90);
    expect(n?.width).toBeCloseTo(100);
    expect(n?.x).toBeCloseTo(0);
  });

  it("moves a node inside a rotated parent along the page axes", () => {
    const { design, page } = createDesign();
    const g = createGroup({ parent: page, x: 0, y: 0, width: 100, height: 100, rotation: 90 });
    const r = createRect({ parent: g.id, x: 0, y: 0, width: 100, height: 100 });
    let d = applyOps(design, [
      { op: "create", nodes: [g], parent: page },
      { op: "create", nodes: [r], parent: g.id },
    ]);
    const before = apply(worldTransform(d, r.id), { x: 0, y: 0 });
    d = applyOps(d, moveOps(d, [r.id], 10, 0));
    const after = apply(worldTransform(d, r.id), { x: 0, y: 0 });
    close(after.x - before.x, 10, 1e-3);
    close(after.y - before.y, 0, 1e-3);
  });

  it("scales path data with the box", () => {
    const { design, page } = createDesign();
    const p = createPath({ parent: page, x: 0, y: 0, width: 100, height: 100 });
    let d = applyOps(design, [{ op: "create", nodes: [p], parent: page }]);
    const r = resizeObb({ m: translation(0, 0), w: 100, h: 100 }, "right", { x: 200, y: 50 });
    d = applyOps(d, transformOps(d, [p.id], r.page));
    const node = d.nodes[p.id];
    expect(node?.type === "path" && node.paths[0]?.d).toBe("M0 0L200 0L200 100L0 100Z");
  });
});

describe("lines", () => {
  it("writes endpoints as length, angle and center", () => {
    const { design, page } = createDesign();
    const l = createLine({ parent: page, x: 0, y: 0, width: 100 });
    let d = applyOps(design, [{ op: "create", nodes: [l], parent: page }]);
    d = applyOps(d, lineEndpointOps(d, l.id, { x: 10, y: 10 }, { x: 10, y: 110 }));
    const n = d.nodes[l.id];
    expect(n?.width).toBeCloseTo(100);
    expect(n?.rotation).toBeCloseTo(90);
    const ends = lineEndpoints(d, l.id);
    close(ends?.[0].x ?? 0, 10, 1e-3);
    close(ends?.[0].y ?? 0, 10, 1e-3);
    close(ends?.[1].y ?? 0, 110, 1e-3);
  });
});

describe("handles", () => {
  const box = { m: translation(0, 0), w: 100, h: 100 };

  it("hits corners, edges and rotation zones in screen px", () => {
    expect(hitHandles(box, 1, { x: 102, y: 101 })).toEqual({
      type: "resize",
      handle: "bottom-right",
    });
    expect(hitHandles(box, 1, { x: 50, y: 3 })).toEqual({ type: "resize", handle: "top" });
    expect(hitHandles(box, 1, { x: 112, y: 112 })).toEqual({
      type: "rotate",
      handle: "bottom-right",
    });
    expect(hitHandles(box, 1, { x: 50, y: 50 })).toBeNull();
    // At 4× zoom the same page distance is 4× further on screen.
    expect(hitHandles(box, 4, { x: 103, y: 103 })).toEqual({
      type: "rotate",
      handle: "bottom-right",
    });
    expect(hitHandles(box, 4, { x: 105, y: 105 })).toBeNull();
  });

  it("gives touch input larger handle targets", () => {
    // 10 px from the corner: outside the 7 px mouse target (a rotation zone), inside the touch one.
    expect(hitHandles(box, 1, { x: 107, y: 107 })).toEqual({
      type: "rotate",
      handle: "bottom-right",
    });
    expect(hitHandles(box, 1, { x: 107, y: 107 }, { scale: 2 })).toEqual({
      type: "resize",
      handle: "bottom-right",
    });
  });

  it("points cursors along the rotated box", () => {
    close(handleDirection(box, "right"), 0);
    close(handleDirection(box, "bottom-right"), 45);
    const rotated = { m: rotation(90), w: 100, h: 100 };
    close(handleDirection(rotated, "right"), 90);
  });

  it("derives corner radius from a pointer inside the corner", () => {
    expect(radiusFromPointer(100, 60, "top-left", { x: 10, y: 10 })).toBe(10);
    expect(radiusFromPointer(100, 60, "bottom-right", { x: 80, y: 40 })).toBe(20);
    expect(radiusFromPointer(100, 60, "top-left", { x: 90, y: 90 })).toBe(30);
  });

  it("matches the engine's polygon and star point placement", () => {
    const tri = polygonPoints(100, 100, 3);
    close(tri[0]?.x ?? 0, 50);
    close(tri[0]?.y ?? 0, 0);
    expect(Math.max(...tri.map((p) => p.y))).toBeCloseTo(100);
    const star = starPoints(100, 100, 5, 0.5);
    expect(star).toHaveLength(10);
    close(star[0]?.y ?? 1, 0);
  });
});

describe("measurements", () => {
  it("measures gaps between separate boxes", () => {
    const m = measureBetween({ x: 0, y: 0, w: 10, h: 10 }, { x: 30, y: 0, w: 10, h: 10 });
    expect(m).toHaveLength(1);
    expect(m[0]?.value).toBe(20);
  });

  it("measures to every side of a containing box", () => {
    const m = measureBetween({ x: 10, y: 20, w: 10, h: 10 }, { x: 0, y: 0, w: 100, h: 100 });
    expect(m.map((x) => x.value).sort((a, b) => a - b)).toEqual([10, 20, 70, 80]);
  });

  it("adds a helper line when boxes do not overlap on the cross axis", () => {
    const m = measureBetween({ x: 0, y: 0, w: 10, h: 10 }, { x: 30, y: 50, w: 10, h: 10 });
    expect(m.length).toBe(2);
    expect(m.every((x) => x.guides.length === 1)).toBe(true);
  });
});
