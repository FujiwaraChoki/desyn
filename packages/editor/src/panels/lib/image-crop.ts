import type { Design, ImageNode } from "@desyn/schema";

/**
 * Crop zoom and focus for the image inspector, in the model the renderer and the canvas crop mode share:
 * `crop` is the visible part of the source (normalized 0..1). crates/desyn-raster scales that rect to cover
 * the layer box and multiplies by `crop.zoom`; the canvas crop mode writes rects with the box's aspect and
 * no `zoom`. The inspector writes the same form, so both tools agree and nothing is zoomed twice.
 */

export interface Region {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Natural pixel size of the image's source (asset metadata, else the layer box). */
export function sourceSize(design: Design, node: ImageNode): { sw: number; sh: number } {
  const asset = design.assets[node.assetId];
  const sw = asset?.width && asset.width > 0 ? asset.width : Math.max(node.width, 1);
  const sh = asset?.height && asset.height > 0 ? asset.height : Math.max(node.height, 1);
  return { sw, sh };
}

/** The centered region "fill" shows: the largest rect with the box's aspect inside the source. */
export function coverRegion(node: ImageNode, sw: number, sh: number): Region {
  const box = Math.max(node.width, 1e-6) / Math.max(node.height, 1e-6);
  const src = sw / sh;
  if (src > box) {
    const w = box / src;
    return { x: (1 - w) / 2, y: 0, w, h: 1 };
  }
  const h = src / box;
  return { x: 0, y: (1 - h) / 2, w: 1, h };
}

/** The part of the source the layer shows now (exactly as the renderer places a crop). */
export function visibleRegion(node: ImageNode, sw: number, sh: number): Region {
  const c = node.crop;
  if (node.fit !== "crop" || !c || !(c.w > 0) || !(c.h > 0)) return coverRegion(node, sw, sh);
  const cw = Math.min(c.w, 1) * sw;
  const ch = Math.min(c.h, 1) * sh;
  const zoom = c.zoom && Number.isFinite(c.zoom) && c.zoom > 0 ? c.zoom : 1;
  const scale = Math.max(node.width / cw, node.height / ch) * zoom;
  const w = node.width / scale / sw;
  const h = node.height / scale / sh;
  const cx = c.x + Math.min(c.w, 1) / 2;
  const cy = c.y + Math.min(c.h, 1) / 2;
  return { x: cx - w / 2, y: cy - h / 2, w, h };
}

const r6 = (v: number) => Math.round(v * 1e6) / 1e6;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

function clampRegion(r: Region): Region {
  const w = clamp(r.w, 1e-4, 1);
  const h = clamp(r.h, 1e-4, 1);
  return {
    x: r6(clamp(r.x, 0, 1 - w)),
    y: r6(clamp(r.y, 0, 1 - h)),
    w: r6(w),
    h: r6(h),
  };
}

/** Zoom relative to "fill" (1 = the whole cover region, 2 = half of it...). */
export function cropZoom(node: ImageNode, sw: number, sh: number): number {
  const base = coverRegion(node, sw, sh);
  const visible = visibleRegion(node, sw, sh);
  return base.w / Math.max(visible.w, 1e-6);
}

/** Where the visible region sits in its free range, per axis (0..1; 0.5 when it cannot move). */
export function cropFocus(node: ImageNode, sw: number, sh: number): { x: number; y: number } {
  const v = visibleRegion(node, sw, sh);
  return {
    x: v.w < 0.9999 ? clamp(v.x / (1 - v.w), 0, 1) : 0.5,
    y: v.h < 0.9999 ? clamp(v.y / (1 - v.h), 0, 1) : 0.5,
  };
}

/** Patch zooming the image about the center of what it shows now. */
export function zoomCropPatch(
  node: ImageNode,
  sw: number,
  sh: number,
  zoom: number,
): { fit: "crop"; crop: Region } {
  const base = coverRegion(node, sw, sh);
  const visible = visibleRegion(node, sw, sh);
  const z = clamp(zoom, 1, 100);
  const w = base.w / z;
  const h = base.h / z;
  const cx = visible.x + visible.w / 2;
  const cy = visible.y + visible.h / 2;
  return { fit: "crop", crop: clampRegion({ x: cx - w / 2, y: cy - h / 2, w, h }) };
}

/** Patch moving the visible region along one axis (`t` 0..1 of the free range). */
export function focusCropPatch(
  node: ImageNode,
  sw: number,
  sh: number,
  axis: "x" | "y",
  t: number,
): { fit: "crop"; crop: Region } {
  const v = visibleRegion(node, sw, sh);
  const next = { ...v };
  if (axis === "x") next.x = (1 - v.w) * clamp(t, 0, 1);
  else next.y = (1 - v.h) * clamp(t, 0, 1);
  return { fit: "crop", crop: clampRegion(next) };
}
