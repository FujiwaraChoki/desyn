import type { Design, Id, Node } from "@desyn/schema";
import { describe, expect, test } from "vitest";
import { anchorAt, resolvePin } from "../../src/collab/comments/anchor.ts";
import { cardPosition } from "../../src/collab/comments/pins.tsx";
import { fixture } from "./fixtures.ts";

function patch(design: Design, id: Id, set: Partial<Node>): Design {
  return { ...design, nodes: { ...design.nodes, [id]: { ...design.nodes[id], ...set } as Node } };
}

const close = (a: { x: number; y: number } | null | undefined, x: number, y: number) => {
  expect(a).toBeTruthy();
  expect(a?.x).toBeCloseTo(x, 1);
  expect(a?.y).toBeCloseTo(y, 1);
};

describe("comment anchoring", () => {
  test("a pin on a layer is stored in the layer's box and follows moves", () => {
    const f = fixture();
    const anchor = anchorAt(f.design, f.page, { x: 30, y: 20 }, f.a);
    expect(anchor).toEqual({ pageId: f.page, nodeId: f.a, x: 20, y: 10 });
    const moved = patch(f.design, f.a, { x: 110, y: 60 });
    close(resolvePin(moved, anchor), 130, 70);
  });

  test("rotation and flips carry the pin with the layer", () => {
    const f = fixture();
    // Pin at the top-left corner of the rotated group's first child.
    const g = f.design.nodes[f.g] as Node;
    const before = resolvePin(f.design, { nodeId: f.g1, pageId: f.page, x: 0, y: 0 });
    const anchor = anchorAt(f.design, f.page, before as { x: number; y: number }, f.g1);
    close(anchor, 0, 0);
    // Rotating the group to 0 puts that corner at the group's top-left.
    const straight = patch(f.design, f.g, { rotation: 0 });
    close(resolvePin(straight, anchor), g.x, g.y);
    // Flipping B horizontally mirrors a pin near its left edge to the right edge.
    const onB = anchorAt(f.design, f.page, { x: 210, y: 140 }, f.b);
    const flipped = patch(f.design, f.b, { flipX: true });
    close(resolvePin(flipped, onB), 270, 140);
  });

  test("a shrunken layer keeps the pin inside it; a deleted one detaches it", () => {
    const f = fixture();
    const anchor = anchorAt(f.design, f.page, { x: 100, y: 55 }, f.a); // near A's bottom-right
    const small = patch(f.design, f.a, { width: 20, height: 10 });
    close(resolvePin(small, anchor), 30, 20);
    const nodes = { ...f.design.nodes };
    delete nodes[f.a];
    const gone = resolvePin({ ...f.design, nodes }, anchor);
    expect(gone?.detached).toBe(true);
    expect(gone?.pageId).toBe(f.page);
  });

  test("page pins, other pages and unknown pages", () => {
    const f = fixture();
    expect(anchorAt(f.design, f.page, { x: 5.555, y: 7 }, null)).toEqual({
      pageId: f.page,
      nodeId: null,
      x: 5.56,
      y: 7,
    });
    // The page itself is not a layer to attach to.
    expect(anchorAt(f.design, f.page, { x: 1, y: 2 }, f.page).nodeId).toBeNull();
    // A layer on another page is not attached either.
    expect(anchorAt(f.design, "otherpage000", { x: 1, y: 2 }, f.a).nodeId).toBeNull();
    expect(resolvePin(f.design, { nodeId: null, pageId: f.page, x: 40, y: 50 })).toEqual({
      pageId: f.page,
      x: 40,
      y: 50,
      detached: false,
    });
    expect(resolvePin(f.design, { nodeId: null, pageId: "nope", x: 1, y: 1 })).toBeNull();
    expect(resolvePin(f.design, { nodeId: null, pageId: null, x: 1, y: 1 })).toBeNull();
  });
});

describe("thread card placement", () => {
  const size = { w: 320, h: 200 };
  const bounds = { w: 1200, h: 800 };
  test("the card sits beside the pin body and never covers the pin", () => {
    const pin = { x: 400, y: 300 };
    const right = cardPosition(pin, size, bounds);
    // Pin body spans x 400..460 and y 270..300.
    expect(right.left).toBeGreaterThanOrEqual(460);
    expect(right.top).toBe(270);
    const nearEdge = cardPosition({ x: 1000, y: 300 }, size, bounds);
    expect(nearEdge.left + size.w).toBeLessThanOrEqual(1000);
  });

  test("the card stays inside the canvas", () => {
    const low = cardPosition({ x: 100, y: 790 }, size, bounds);
    expect(low.top + size.h).toBeLessThanOrEqual(bounds.h - 8);
    const high = cardPosition({ x: 100, y: 5 }, size, bounds);
    expect(high.top).toBe(8);
  });
});
