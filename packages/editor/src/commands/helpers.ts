import { approxBounds, topLevelSelection, unionRects } from "@desyn/doc-ops";
import type { Design, Id } from "@desyn/schema";
import type { EditorController } from "../controller.ts";

/** Top-level selected nodes (document order), pages excluded. */
export function selectedIds(editor: EditorController, design = editor.design): Id[] {
  if (!design) return [];
  return topLevelSelection(design, editor.getState().selection).filter(
    (id) => design.nodes[id]?.type !== "page",
  );
}

/** Same, unlocked only (locked layers do not move). */
export function movableIds(editor: EditorController, design = editor.design): Id[] {
  if (!design) return [];
  return selectedIds(editor, design).filter((id) => !design.nodes[id]?.locked);
}

/** Bounds (page coordinates) of ids, from the document geometry. */
export function boundsOf(design: Design, ids: Id[]) {
  return unionRects(
    ids
      .map((id) => approxBounds(design, id))
      .filter((r): r is NonNullable<typeof r> => r !== undefined),
  );
}

/** Center of the visible canvas in page coordinates (falls back to the page center). */
export function viewCenterInPage(editor: EditorController): { x: number; y: number } {
  const client = editor.engineClient;
  const { viewport } = editor.getState();
  if (client && viewport.width > 0) {
    return client.screenToPage({ x: viewport.width / 2, y: viewport.height / 2 });
  }
  const page = editor.currentPage();
  return page ? { x: page.width / 2, y: page.height / 2 } : { x: 0, y: 0 };
}

/** Visible page rectangle (page coordinates), or the page itself without an engine. */
export function visiblePageRect(editor: EditorController) {
  const client = editor.engineClient;
  const { viewport } = editor.getState();
  if (client && viewport.width > 0) {
    const a = client.screenToPage({ x: 0, y: 0 });
    const b = client.screenToPage({ x: viewport.width, y: viewport.height });
    return { x: a.x, y: a.y, width: b.x - a.x, height: b.y - a.y };
  }
  const page = editor.currentPage();
  return page ? { x: 0, y: 0, width: page.width, height: page.height } : null;
}
