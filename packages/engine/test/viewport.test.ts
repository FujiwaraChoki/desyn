import { describe, expect, it } from "vitest";
import type { ViewState } from "../src/protocol";
import {
  fitRect,
  pageToScreen,
  panBy,
  screenToPage,
  snapToDevice,
  wheelZoomFactor,
  zoomAt,
} from "../src/viewport";

const view: ViewState = { x: 10, y: 20, zoom: 2, width: 800, height: 600, dpr: 1.5 };

describe("viewport", () => {
  it("maps screen and page points both ways", () => {
    const p = screenToPage(view, { x: 100, y: 50 });
    expect(p).toEqual({ x: 60, y: 45 });
    expect(pageToScreen(view, p)).toEqual({ x: 100, y: 50 });
  });

  it("zooms about an anchor", () => {
    const anchor = { x: 300, y: 200 };
    const before = screenToPage(view, anchor);
    const v = zoomAt(view, anchor, 3.7);
    const after = screenToPage(v, anchor);
    expect(after.x).toBeCloseTo(before.x, 2);
    expect(after.y).toBeCloseTo(before.y, 2);
  });

  it("snaps origins to whole device pixels", () => {
    const v = snapToDevice({ ...view, x: 10.1234 });
    expect((v.x * v.zoom * v.dpr) % 1).toBeCloseTo(0, 9);
    const a = panBy(v, 13, 0);
    const b = panBy(a, 7, -3);
    const dx = (a.x - b.x) * b.zoom * b.dpr;
    expect(Math.abs(dx - Math.round(dx))).toBeLessThan(1e-9);
  });

  it("fits a rectangle", () => {
    const v = fitRect(view, { x: 0, y: 0, w: 1080, h: 1080 }, 40);
    expect(v.zoom).toBeCloseTo(520 / 1080, 3);
    const center = screenToPage(v, { x: 400, y: 300 });
    expect(center.x).toBeCloseTo(540, 0);
    expect(center.y).toBeCloseTo(540, 0);
  });

  it("turns wheel deltas into zoom factors", () => {
    expect(wheelZoomFactor(-100, 0, false)).toBeGreaterThan(1);
    expect(wheelZoomFactor(100, 0, true)).toBeLessThan(wheelZoomFactor(100, 0, false));
  });
});
