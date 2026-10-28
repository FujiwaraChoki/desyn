import { applyTransaction, worldTransform } from "@desyn/doc-ops";
import { describe, expect, it } from "vitest";
import { createPathOps, updatePathOps } from "../../src/canvas/create.ts";
import { apply } from "../../src/canvas/math.ts";
import { fitCurve, smooth } from "../../src/tools/curve-fit.ts";
import {
  anchorKind,
  cubicAt,
  nearestOnPaths,
  parseSubPaths,
  pathBounds,
  segmentPoints,
  segmentsOf,
  serializeSubPaths,
  splitSegment,
  toggleSmooth,
} from "../../src/tools/path-model.ts";
import { strokeToSubPath } from "../../src/tools/pencil.ts";
import { createDesign, createPath, makeTx } from "./fixtures.ts";

describe("path model", () => {
  it("parses absolute and relative commands into anchors", () => {
    const sp = parseSubPaths("m10 10 h80 v80 l-80 0 z");
    expect(sp).toHaveLength(1);
    expect(sp[0]?.closed).toBe(true);
    expect(sp[0]?.anchors.map((a) => [a.x, a.y])).toEqual([
      [10, 10],
      [90, 10],
      [90, 90],
      [10, 90],
    ]);
    expect(serializeSubPaths(sp)).toBe("M10 10L90 10L90 90L10 90Z");
  });

  it("converts quadratic, smooth and arc segments to cubics", () => {
    const q = parseSubPaths("M0 0Q50 100 100 0T200 0");
    expect(q[0]?.anchors).toHaveLength(3);
    // The reflected control point of T mirrors Q's.
    const mid = q[0]?.anchors[1];
    expect(mid?.out?.y).toBeCloseTo(-200 / 3);
    const arc = parseSubPaths("M0 50A50 50 0 0 1 100 50");
    const end = arc[0]?.anchors[arc[0].anchors.length - 1];
    expect(end?.x).toBeCloseTo(100);
    // A half circle above the chord reaches y = 0.
    expect(pathBounds(arc)?.y).toBeCloseTo(0, 3);
  });

  it("merges an explicit closing point into the first anchor", () => {
    const sp = parseSubPaths("M0 0C10 0 20 10 20 20C20 30 10 40 0 40C-10 40 -20 0 0 0Z");
    expect(sp[0]?.anchors).toHaveLength(3);
    expect(sp[0]?.anchors[0]?.in).toEqual({ x: -20, y: 0 });
    const round = parseSubPaths(serializeSubPaths(sp));
    expect(round).toEqual(sp);
  });

  it("splits a curve without changing its shape", () => {
    const sp = parseSubPaths("M0 0C0 100 100 100 100 0")[0];
    if (!sp) throw new Error("no path");
    const [p0, c1, c2, p3] = segmentPoints(sp, [0, 1]);
    const before = cubicAt(p0, c1, c2, p3, 0.3);
    const at = splitSegment(sp, 0, 0.5);
    expect(at).toBe(1);
    expect(sp.anchors).toHaveLength(3);
    const [q0, q1, q2, q3] = segmentPoints(sp, [0, 1]);
    const after = cubicAt(q0, q1, q2, q3, 0.6);
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
    // The new point keeps the curve's tangent: its handles are aligned.
    expect(anchorKind(sp.anchors[1] as never)).not.toBe("corner");
  });

  it("finds the nearest point on a path", () => {
    const sp = parseSubPaths("M0 0L100 0");
    const hit = nearestOnPaths(sp, { x: 40, y: 5 });
    expect(hit?.point.x).toBeCloseTo(40, 3);
    expect(hit?.d).toBeCloseTo(5, 3);
  });

  it("converts corners to smooth points and back", () => {
    const sp = parseSubPaths("M0 0L50 50L100 0")[0];
    if (!sp) throw new Error("no path");
    toggleSmooth(sp, 1);
    expect(anchorKind(sp.anchors[1] as never)).not.toBe("corner");
    expect(sp.anchors[1]?.in?.y).toBeCloseTo(50);
    toggleSmooth(sp, 1);
    expect(anchorKind(sp.anchors[1] as never)).toBe("corner");
    expect(segmentsOf(sp)).toEqual([
      [0, 1],
      [1, 2],
    ]);
  });

  it("computes exact curve bounds (not the control polygon)", () => {
    const b = pathBounds(parseSubPaths("M0 0C0 100 100 100 100 0"));
    expect(b?.h).toBeCloseTo(75);
    expect(b?.w).toBeCloseTo(100);
  });
});

describe("path layers", () => {
  it("creates a path layer whose box fits its curves", () => {
    const { design, page } = createDesign();
    const node = createPath({ name: "Path", fills: [] });
    const ops = createPathOps(
      design,
      page,
      [
        {
          closed: false,
          anchors: [
            { x: 100, y: 100, in: null, out: null },
            { x: 200, y: 150, in: null, out: null },
          ],
        },
      ],
      node,
    );
    const d = applyTransaction(design, makeTx(ops)).design;
    const n = d.nodes[node.id];
    expect(n).toMatchObject({ x: 100, y: 100, width: 100, height: 50 });
    expect(n?.type === "path" && n.paths[0]?.d).toBe("M0 0L100 50");
  });

  it("refits the box after an edit without moving the rest on the page", () => {
    const { design, page } = createDesign();
    const node = createPath({ x: 50, y: 50, width: 100, height: 100, rotation: 30 });
    let d = applyTransaction(
      design,
      makeTx([{ op: "create", nodes: [node], parent: page }]),
    ).design;
    const world = worldTransform(d, node.id);
    const entries = [parseSubPaths("M0 0L100 0L100 100L0 100Z").map((sp) => sp)];
    // Move the first point outside the box (to -20, -20).
    const first = entries[0]?.[0]?.anchors[0];
    if (first) {
      first.x = -20;
      first.y = -20;
    }
    const fixed = apply(world, { x: 100, y: 100 });
    d = applyTransaction(d, makeTx(updatePathOps(d, node.id, entries))).design;
    const n = d.nodes[node.id];
    expect(n?.width).toBeCloseTo(120);
    expect(n?.height).toBeCloseTo(120);
    // The untouched corner stays where it was on the page.
    const after = apply(worldTransform(d, node.id), { x: 120, y: 120 });
    expect(after.x).toBeCloseTo(fixed.x, 4);
    expect(after.y).toBeCloseTo(fixed.y, 4);
  });
});

describe("pencil smoothing", () => {
  const circle = (n: number, noise = 0) =>
    Array.from({ length: n }, (_, i) => {
      const a = (i / (n - 1)) * Math.PI * 1.5;
      const jitter = noise ? Math.sin(i * 12.9898) * noise : 0;
      return { x: 100 + Math.cos(a) * (50 + jitter), y: 100 + Math.sin(a) * (50 + jitter) };
    });

  it("fits a stroke within the error with few segments", () => {
    const pts = circle(200);
    const curves = fitCurve(pts, 0.5);
    expect(curves.length).toBeGreaterThan(0);
    expect(curves.length).toBeLessThan(10);
    for (const p of pts) {
      let best = Number.POSITIVE_INFINITY;
      for (const [p0, c1, c2, p3] of curves) {
        for (let t = 0; t <= 1; t += 0.01) {
          const q = cubicAt(p0, c1, c2, p3, t);
          best = Math.min(best, Math.hypot(q.x - p.x, q.y - p.y));
        }
      }
      expect(best).toBeLessThan(1);
    }
  });

  it("smooths jitter and keeps the endpoints", () => {
    const pts = circle(100, 2);
    const s = smooth(pts, 2);
    expect(s[0]).toEqual(pts[0]);
    expect(s[s.length - 1]).toEqual(pts[pts.length - 1]);
    const sp = strokeToSubPath(pts, 1);
    expect(sp?.closed).toBe(false);
    expect((sp?.anchors.length ?? 0) >= 2).toBe(true);
  });

  it("closes a stroke that ends at its start", () => {
    const loop = Array.from({ length: 120 }, (_, i) => {
      const a = (i / 119) * Math.PI * 2;
      return { x: Math.cos(a) * 60, y: Math.sin(a) * 60 };
    });
    expect(strokeToSubPath(loop, 1)?.closed).toBe(true);
  });
});
