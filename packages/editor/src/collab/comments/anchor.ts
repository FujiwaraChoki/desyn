import { applyToPoint, invertMatrix, pageOf, worldTransform } from "@desyn/doc-ops";
import type { Design, Id } from "@desyn/schema";

/**
 * Comment pin anchoring (shared with other clients: web, desktop, iOS).
 *
 * A thread stores `pageId` plus `x`, `y`:
 * - without `nodeId`: page coordinates (design px from the page's top-left);
 * - with `nodeId`: coordinates in the node's own box (design px from its top-left corner, before rotation and
 *   flips), so the pin rides along when the layer moves, rotates or flips. When the layer shrinks the pin is
 *   clamped into its box; when the layer is deleted the pin falls back to its page (marked `detached`).
 */

export interface Anchor {
  pageId: Id;
  nodeId: Id | null;
  x: number;
  y: number;
}

export interface ResolvedPin {
  pageId: Id | null;
  /** Page coordinates of the pin tip. */
  x: number;
  y: number;
  /** The anchored layer no longer exists. */
  detached: boolean;
}

const round = (n: number) => Math.round(n * 100) / 100;

/** Anchor for a pin dropped at a page point, attached to `nodeId` when that layer is on the page. */
export function anchorAt(
  design: Design,
  pageId: Id,
  point: { x: number; y: number },
  nodeId: Id | null,
): Anchor {
  const node = nodeId ? design.nodes[nodeId] : undefined;
  if (!nodeId || !node || node.type === "page" || node.type === "root") {
    return { pageId, nodeId: null, x: round(point.x), y: round(point.y) };
  }
  if (pageOf(design, nodeId)?.id !== pageId) {
    return { pageId, nodeId: null, x: round(point.x), y: round(point.y) };
  }
  let local: { x: number; y: number };
  try {
    local = applyToPoint(invertMatrix(worldTransform(design, nodeId, "page")), point);
  } catch {
    // Degenerate transform (zero-size flip): keep the pin on the page.
    return { pageId, nodeId: null, x: round(point.x), y: round(point.y) };
  }
  return { pageId, nodeId, x: round(local.x), y: round(local.y) };
}

/** Where a thread's pin is now (page coordinates). */
export function resolvePin(
  design: Design,
  thread: { nodeId: Id | null; pageId: Id | null; x: number | null; y: number | null },
): ResolvedPin | null {
  const x = thread.x ?? 0;
  const y = thread.y ?? 0;
  if (thread.nodeId) {
    const node = design.nodes[thread.nodeId];
    if (node && node.type !== "page" && node.type !== "root") {
      const page = pageOf(design, thread.nodeId);
      const lx = clamp(x, 0, Math.max(0, node.width));
      const ly = clamp(y, 0, Math.max(0, node.height));
      const p = applyToPoint(worldTransform(design, thread.nodeId, "page"), { x: lx, y: ly });
      return { pageId: page?.id ?? thread.pageId, x: p.x, y: p.y, detached: false };
    }
    if (!thread.pageId || design.nodes[thread.pageId]?.type !== "page") return null;
    const page = design.nodes[thread.pageId];
    return {
      pageId: thread.pageId,
      x: clamp(x, 0, page?.width ?? x),
      y: clamp(y, 0, page?.height ?? y),
      detached: true,
    };
  }
  if (!thread.pageId) return null;
  if (design.nodes[thread.pageId]?.type !== "page") return null;
  if (thread.x === null || thread.y === null) {
    // Page-level thread without a point: pin at the page's top-left corner.
    return { pageId: thread.pageId, x: 0, y: 0, detached: false };
  }
  return { pageId: thread.pageId, x, y, detached: false };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
