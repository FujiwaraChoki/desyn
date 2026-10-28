import {
  clampZoom,
  type EngineClient,
  fitRect,
  type Rect,
  type ViewState,
  zoomAt as zoomView,
} from "@desyn/engine";
import type { Id } from "@desyn/schema";
import { nextZoom } from "../commands/view.ts";
import type { ViewAnimator } from "../engine-bridge/bridge.ts";

/**
 * Smooth zoom for view commands (zoom in / out, 100 %, fit, selection). The zoom is interpolated in log space
 * and the origin along 1/zoom, which keeps an anchored point exactly still during a zoom about it and gives a
 * natural arc for fits. Repeated zoom steps during an animation continue from the animation's target, so
 * pressing + twice goes two steps. Honors `prefers-reduced-motion`.
 */

const DURATION_MS = 260;

/** cubic-bezier(.16, 1, .3, 1) (the design system's ease-out), solved numerically. */
export function easeOut(t: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  const x1 = 0.16;
  const y1 = 1;
  const x2 = 0.3;
  const y2 = 1;
  const bx = (u: number) => 3 * x1 * u * (1 - u) ** 2 + 3 * x2 * u * u * (1 - u) + u ** 3;
  const by = (u: number) => 3 * y1 * u * (1 - u) ** 2 + 3 * y2 * u * u * (1 - u) + u ** 3;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (bx(mid) < t) lo = mid;
    else hi = mid;
  }
  return by((lo + hi) / 2);
}

/** The view at progress `t` between two views (log zoom, origin linear in 1/zoom). */
export function interpolateView(
  from: Pick<ViewState, "x" | "y" | "zoom">,
  to: Pick<ViewState, "x" | "y" | "zoom">,
  t: number,
): { x: number; y: number; zoom: number } {
  const zoom = Math.exp(Math.log(from.zoom) + (Math.log(to.zoom) - Math.log(from.zoom)) * t);
  const inv0 = 1 / from.zoom;
  const inv1 = 1 / to.zoom;
  const s = Math.abs(inv1 - inv0) > 1e-9 ? (1 / zoom - inv0) / (inv1 - inv0) : t;
  return { zoom, x: from.x + (to.x - from.x) * s, y: from.y + (to.y - from.y) * s };
}

export class SmoothViewAnimator implements ViewAnimator {
  private raf = 0;
  private target: { x: number; y: number; zoom: number } | null = null;

  zoomAt(client: EngineClient, anchor: { x: number; y: number }, zoom: number): void {
    let z = clampZoom(zoom);
    const target = this.target;
    if (target) {
      // A zoom step while animating continues from where the animation is going.
      const current = client.view.zoom;
      const dir = Math.sign(z - current);
      if (dir !== 0 && Math.abs(z - target.zoom) < 1e-3 * target.zoom)
        z = nextZoom(target.zoom, dir as 1 | -1);
    }
    const base = this.target ? { ...client.view, ...this.target } : client.view;
    this.animate(client, zoomView(base, anchor, z));
  }

  fit(client: EngineClient, target: Rect | Id | undefined, padding: number): void {
    let rect: Rect | undefined;
    if (typeof target === "object") rect = target;
    else {
      const id = target ?? client.renderOptions.pageId ?? client.pages[0]?.id;
      const page = client.pages.find((p) => p.id === id) ?? client.pages[0];
      if (page) rect = { x: 0, y: 0, w: page.width, h: page.height };
    }
    if (!rect) return;
    this.animate(client, fitRect(client.view, rect, padding));
  }

  private animate(client: EngineClient, to: ViewState): void {
    const reduced =
      typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (this.raf) cancelAnimationFrame(this.raf);
    if (reduced || typeof requestAnimationFrame !== "function") {
      this.target = null;
      client.setView({ x: to.x, y: to.y, zoom: to.zoom });
      return;
    }
    const from = { x: client.view.x, y: client.view.y, zoom: client.view.zoom };
    this.target = { x: to.x, y: to.y, zoom: to.zoom };
    const start = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / DURATION_MS);
      const v = interpolateView(from, to, easeOut(t));
      client.setView(t >= 1 ? { x: to.x, y: to.y, zoom: to.zoom } : v);
      if (t < 1) this.raf = requestAnimationFrame(step);
      else {
        this.raf = 0;
        this.target = null;
      }
    };
    this.raf = requestAnimationFrame(step);
  }

  stop(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.target = null;
  }
}
