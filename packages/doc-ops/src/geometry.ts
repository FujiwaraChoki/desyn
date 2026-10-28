// Box geometry without text shaping: affine transforms of node boxes (rotation + flips about the center) and
// axis-aligned bounds. Derived sizes (text height, group bounds) are taken as persisted on the nodes.
import type { Design, Id, Node } from "@desyn/schema";
import { getNode, parentChain } from "./tree";

/** Affine matrix [a, b, c, d, e, f]: x' = a*x + c*y + e, y' = b*x + d*y + f. */
export type Matrix = [number, number, number, number, number, number];
export interface Point {
  x: number;
  y: number;
}
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

export function multiply(m: Matrix, n: Matrix): Matrix {
  const [a, b, c, d, e, f] = m;
  const [a2, b2, c2, d2, e2, f2] = n;
  return [
    a * a2 + c * b2,
    b * a2 + d * b2,
    a * c2 + c * d2,
    b * c2 + d * d2,
    a * e2 + c * f2 + e,
    b * e2 + d * f2 + f,
  ];
}

export function invertMatrix(m: Matrix): Matrix {
  const [a, b, c, d, e, f] = m;
  const det = a * d - b * c;
  if (det === 0) throw new Error("matrix is not invertible");
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}

export function applyToPoint(m: Matrix, p: Point): Point {
  return { x: m[0] * p.x + m[2] * p.y + m[4], y: m[1] * p.x + m[3] * p.y + m[5] };
}

/** Applies only the linear part (for direction vectors / deltas). */
export function applyToVector(m: Matrix, v: Point): Point {
  return { x: m[0] * v.x + m[2] * v.y, y: m[1] * v.x + m[3] * v.y };
}

export const translate = (x: number, y: number): Matrix => [1, 0, 0, 1, x, y];
export const scale = (sx: number, sy: number = sx): Matrix => [sx, 0, 0, sy, 0, 0];
export function rotate(degrees: number): Matrix {
  const r = (degrees * Math.PI) / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  return [cos, sin, -sin, cos, 0, 0];
}

type Box = Pick<Node, "x" | "y" | "width" | "height" | "rotation"> & {
  flipX?: boolean;
  flipY?: boolean;
};

/** Node box -> parent coordinates: translate(x, y) · rotate/flip about the box center. */
export function localTransform(node: Box): Matrix {
  const cx = node.width / 2;
  const cy = node.height / 2;
  let m = translate(node.x + cx, node.y + cy);
  if (node.rotation) m = multiply(m, rotate(node.rotation));
  if (node.flipX || node.flipY) m = multiply(m, scale(node.flipX ? -1 : 1, node.flipY ? -1 : 1));
  return multiply(m, translate(-cx, -cy));
}

export type Space = "page" | "canvas";

/**
 * Node box -> page coordinates ("page", default) or canvas coordinates ("canvas", which adds the page's own
 * position). A page itself is the identity in page space.
 */
export function worldTransform(design: Design, id: Id, space: Space = "page"): Matrix {
  const node = getNode(design, id);
  if (!node || node.type === "root") return IDENTITY;
  const chain = [node, ...parentChain(design, id)].reverse();
  let m = IDENTITY;
  for (const n of chain) {
    if (n.type === "root") continue;
    if (n.type === "page" && space === "page") continue;
    m = multiply(m, localTransform(n));
  }
  return m;
}

/** Transform of the coordinate system `id`'s children live in (the node's own box), in `space`. */
export function childSpaceTransform(design: Design, id: Id, space: Space = "page"): Matrix {
  return worldTransform(design, id, space);
}

/** Transform of the coordinate system `id` itself is positioned in (its parent's box). */
export function parentSpaceTransform(design: Design, id: Id, space: Space = "page"): Matrix {
  const parent = getNode(design, id)?.parent;
  return parent ? worldTransform(design, parent, space) : IDENTITY;
}

export function boxCorners(width: number, height: number, m: Matrix): Point[] {
  return [
    applyToPoint(m, { x: 0, y: 0 }),
    applyToPoint(m, { x: width, y: 0 }),
    applyToPoint(m, { x: width, y: height }),
    applyToPoint(m, { x: 0, y: height }),
  ];
}

export function boundsOfPoints(points: Point[]): Rect {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** Axis-aligned bounds of the node's (rotated) box in `space`. Uses persisted sizes (no text shaping). */
export function approxBounds(design: Design, id: Id, space: Space = "page"): Rect | undefined {
  const node = getNode(design, id);
  if (!node) return undefined;
  return boundsOfPoints(boxCorners(node.width, node.height, worldTransform(design, id, space)));
}

export function unionRects(rects: Rect[]): Rect | undefined {
  if (rects.length === 0) return undefined;
  return boundsOfPoints(
    rects.flatMap((r) => [
      { x: r.x, y: r.y },
      { x: r.x + r.width, y: r.y + r.height },
    ]),
  );
}

/** Union of the bounds of every existing id. */
export function boundsOfSelection(
  design: Design,
  ids: Id[],
  space: Space = "page",
): Rect | undefined {
  return unionRects(ids.map((id) => approxBounds(design, id, space)).filter((r): r is Rect => !!r));
}

export function rectCenter(r: Rect): Point {
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}

export function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

export function rectContains(outer: Rect, inner: Rect): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  );
}

export interface Placement {
  x: number;
  y: number;
  rotation: number;
  flipX: boolean;
  flipY: boolean;
}

/** Normalizes degrees to (-180, 180]. */
export function normalizeDegrees(deg: number): number {
  let r = deg % 360;
  if (r <= -180) r += 360;
  if (r > 180) r -= 360;
  return r === 0 ? 0 : r;
}

/**
 * Finds x / y / rotation / flips such that localTransform(box) equals the rigid matrix `m` for a box of the given
 * size. The node's current flips are kept when the matrix's handedness allows it; otherwise flipX toggles.
 */
export function decompose(
  m: Matrix,
  width: number,
  height: number,
  prefer: { flipX?: boolean; flipY?: boolean } = {},
): Placement {
  let flipX = prefer.flipX ?? false;
  const flipY = prefer.flipY ?? false;
  const det = m[0] * m[3] - m[1] * m[2];
  const handed = (flipX ? -1 : 1) * (flipY ? -1 : 1);
  if (Math.sign(det) !== handed && det !== 0) flipX = !flipX;
  // R = L · S^-1 with S = diag(fx, fy); R's first column is L's first column times fx.
  const fx = flipX ? -1 : 1;
  const ra = m[0] * fx;
  const rb = m[1] * fx;
  const rotation = normalizeDegrees((Math.atan2(rb, ra) * 180) / Math.PI);
  const center = applyToPoint(m, { x: width / 2, y: height / 2 });
  return { x: center.x - width / 2, y: center.y - height / 2, rotation, flipX, flipY };
}
