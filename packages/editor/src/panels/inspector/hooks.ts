import { topLevelSelection } from "@desyn/doc-ops";
import type { Design, Id, Node, PageNode } from "@desyn/schema";
import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { useEditorStore } from "../../context.tsx";
import { documentColors } from "../lib/paint.ts";

export interface InspectorTarget {
  design: Design | null;
  /** Top-level selected layers (no pages), document order. */
  ids: Id[];
  nodes: Node[];
  /** The current page (shown when nothing is selected). */
  page: PageNode | null;
  editable: boolean;
}

export function useInspectorTarget(): InspectorTarget {
  const design = useEditorStore((s) => s.doc.design);
  const selection = useEditorStore(useShallow((s) => s.selection));
  const pageId = useEditorStore((s) => s.pageId);
  const editable = useEditorStore((s) => s.mode === "edit");
  return useMemo(() => {
    if (!design) return { design, ids: [], nodes: [], page: null, editable };
    const ids = topLevelSelection(design, selection).filter(
      (id) => design.nodes[id]?.type !== "page",
    );
    const nodes = ids.map((id) => design.nodes[id]).filter((n): n is Node => !!n);
    const p = pageId ? design.nodes[pageId] : undefined;
    return { design, ids, nodes, page: p?.type === "page" ? p : null, editable };
  }, [design, selection, pageId, editable]);
}

/** Document colors for color pickers (recomputed when the document changes). */
export function useDocumentColors(): string[] {
  const design = useEditorStore((s) => s.doc.design);
  return useMemo(() => documentColors(design), [design]);
}

/** Kind of the selection for contextual sections. */
export function selectionKind(nodes: Node[]): string {
  if (nodes.length === 0) return "page";
  if (nodes.length > 1) {
    const t = nodes[0]?.type;
    return nodes.every((n) => n.type === t) ? `multi:${t}` : "multi";
  }
  return nodes[0]?.type ?? "page";
}
