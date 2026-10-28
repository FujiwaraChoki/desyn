// Viewport math shared by the client, the text bridge and editors. Screen points are CSS px relative to the
// canvas' top-left corner; page points are design px.
import type { Point, Rect, ViewState } from "./protocol";

export const MIN_ZOOM = 0.02;
export const MAX_ZOOM = 256;

export function clampZoom(zoom: number, min = MIN_ZOOM, max = MAX_ZOOM): number {
  if (!Number.isFinite(zoom)) return 1;
  return Math.min(max, Math.max(min, zoom));
}

export function screenToPage(view: ViewState, p: Point): Point {
  return { x: view.x + p.x / view.zoom, y: view.y + p.y / view.zoom };
}

export function pageToScreen(view: ViewState, p: Point): Point {
  return { x: (p.x - view.x) * view.zoom, y: (p.y - view.y) * view.zoom };
}

export function pageRectToScreen(view: ViewState, r: Rect): Rect {
  const a = pageToScreen(view, { x: r.x, y: r.y });
  return { x: a.x, y: a.y, w: r.w * view.zoom, h: r.h * view.zoom };
}

/** Device pixels per design px. */
export function deviceScale(view: ViewState): number {
  const dpr = view.deviceWidth && view.width > 0 ? view.deviceWidth / view.width : view.dpr;
  return view.zoom * dpr;
}

/**
 * Rounds the view origin to the device-pixel grid. Two snapped views at the same zoom differ by whole device
 * pixels, which lets the engine reuse the previous frame when panning (only exposed strips are drawn).
 */
export function snapToDevice(view: ViewState): ViewState {
  const s = deviceScale(view);
  if (!(s > 0)) return view;
  return { ...view, x: Math.round(view.x * s) / s, y: Math.round(view.y * s) / s };
}

/** Pans by a screen delta (CSS px): content follows the pointer. */
export function panBy(view: ViewState, dx: number, dy: number): ViewState {
  return snapToDevice({ ...view, x: view.x - dx / view.zoom, y: view.y - dy / view.zoom });
}

/** Zooms keeping the page point under `anchor` (screen px) fixed. */
export function zoomAt(view: ViewState, anchor: Point, zoom: number): ViewState {
  const z = clampZoom(zoom);
  const p = screenToPage(view, anchor);
  return snapToDevice({ ...view, zoom: z, x: p.x - anchor.x / z, y: p.y - anchor.y / z });
}

/** Centers a page rectangle in the view with `padding` screen px around it. */
export function fitRect(view: ViewState, rect: Rect, padding = 48, maxZoom = 8): ViewState {
  const w = Math.max(1, view.width - padding * 2);
  const h = Math.max(1, view.height - padding * 2);
  const zoom = clampZoom(Math.min(w / Math.max(rect.w, 1e-6), h / Math.max(rect.h, 1e-6), maxZoom));
  const x = rect.x + rect.w / 2 - view.width / 2 / zoom;
  const y = rect.y + rect.h / 2 - view.height / 2 / zoom;
  return snapToDevice({ ...view, zoom, x, y });
}

/** Zoom factor of a wheel event (pinch on trackpads arrives as ctrl+wheel). */
export function wheelZoomFactor(deltaY: number, deltaMode: number, pinch: boolean): number {
  const px = deltaMode === 1 ? deltaY * 16 : deltaMode === 2 ? deltaY * 400 : deltaY;
  const sensitivity = pinch ? 0.01 : 0.0025;
  return Math.exp(-px * sensitivity);
}

/** Applies an affine `[a, b, c, d, e, f]` to a point. */
export function applyAffine(m: readonly number[], p: Point): Point {
  const [a = 1, b = 0, c = 0, d = 1, e = 0, f = 0] = m;
  return { x: a * p.x + c * p.y + e, y: b * p.x + d * p.y + f };
}
