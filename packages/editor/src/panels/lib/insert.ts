import type { AssetRef, Design, Id, Node, Op } from "@desyn/schema";
import { viewCenterInPage } from "../../commands/helpers.ts";
import type { EditorController } from "../../controller.ts";

/**
 * Placing new layers from the panels: centered in the visible part of the current page (clamped onto the
 * page), on top of the page's layers, selected afterwards, one undo step.
 */

export interface InsertOptions {
  label: string;
  /** Assets the nodes reference (added with one `asset` op when the design lacks them). */
  assets?: AssetRef[];
  /** Page-space point to center on (default: the center of the view). */
  at?: { x: number; y: number };
  /** Keep the given x / y instead of centering. */
  keepPosition?: boolean;
}

/** Box centered on `center`, kept inside a page of `pageW` x `pageH` where it fits. */
export function centeredBox(
  size: { width: number; height: number },
  center: { x: number; y: number },
  page: { width: number; height: number } | null,
): { x: number; y: number } {
  let x = center.x - size.width / 2;
  let y = center.y - size.height / 2;
  if (page) {
    if (size.width <= page.width) x = Math.min(Math.max(x, 0), page.width - size.width);
    if (size.height <= page.height) y = Math.min(Math.max(y, 0), page.height - size.height);
  }
  return { x: Math.round(x), y: Math.round(y) };
}

/** Scales a natural size down to fit within `fraction` of the page (never up). */
export function fitToPage(
  width: number,
  height: number,
  page: { width: number; height: number } | null,
  fraction = 0.6,
): { width: number; height: number } {
  const maxW = (page?.width ?? 1080) * fraction;
  const maxH = (page?.height ?? 1080) * fraction;
  const s = Math.min(1, maxW / Math.max(width, 1), maxH / Math.max(height, 1));
  return { width: Math.max(1, Math.round(width * s)), height: Math.max(1, Math.round(height * s)) };
}

/** The `asset` op adding the refs the design lacks (signed URLs are never persisted, DOCUMENT_MODEL §2). */
export function assetOps(design: Design, assets: readonly AssetRef[]): Op[] {
  const missing = assets.filter((a) => !design.assets[a.id]);
  if (missing.length === 0) return [];
  const set: Record<Id, AssetRef> = {};
  for (const a of missing) {
    const { url: _url, ...rest } = a;
    set[a.id] = rest;
  }
  return [{ op: "asset", set }];
}

/** Ops inserting subtrees (each: root first, then its descendants) on a page, plus their assets. */
export function insertOps(
  design: Design,
  pageId: Id,
  subtrees: Node[][],
  assets: AssetRef[] = [],
): Op[] {
  const ops: Op[] = assetOps(design, assets);
  for (const nodes of subtrees) {
    if (nodes.length > 0) ops.push({ op: "create", nodes, parent: pageId });
  }
  return ops;
}

/**
 * Inserts one subtree (root first, then its descendants) on the current page and selects it. Resolves to
 * the root id, or null when nothing was inserted (read-only, no page).
 */
export async function insertSubtree(
  editor: EditorController,
  nodes: Node[],
  options: InsertOptions,
): Promise<Id | null> {
  const root = nodes[0];
  const page = editor.currentPage();
  if (!root || !page || !editor.canEdit) return null;
  if (!options.keepPosition) {
    const center = options.at ?? viewCenterInPage(editor);
    const pos = centeredBox(root, center, page);
    root.x = pos.x;
    root.y = pos.y;
  }
  const result = await editor.apply(
    (design) => insertOps(design, page.id, [nodes], options.assets ?? []),
    { label: options.label, select: [root.id] },
  );
  if (result && result.applied.length > 0) {
    editor.telemetry("panel_insert", { type: root.type, label: options.label });
    return root.id;
  }
  return null;
}
