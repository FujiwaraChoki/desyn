import { findNodes, getNode, siblings } from "@desyn/doc-ops";
import { canonicalEqual, type Id, type Node } from "@desyn/schema";
import { BoxSelect, CornerLeftUp, CornerRightDown, ListChecks, SquareX } from "lucide-react";
import type { EditorController } from "../controller.ts";
import type { AnyCommand } from "./registry.ts";

const NAV = "loaded && !textEditing";

function selectable(node: Node | undefined): node is Node {
  return !!node && node.type !== "root" && node.type !== "page" && node.visible && !node.locked;
}

/** Children of the entered scope, else the current page's top-level layers. */
function scopeChildren(editor: EditorController): Id[] {
  const s = editor.getState();
  const design = editor.design;
  if (!design) return [];
  const container = (s.scopeId && design.nodes[s.scopeId]) || (s.pageId && design.nodes[s.pageId]);
  if (!container || !("children" in container)) return [];
  return container.children.filter((id) => selectable(design.nodes[id]));
}

const CONTAINER_TYPES: ReadonlySet<string> = new Set(["frame", "group", "boolean"]);

/** Similar layers for "Select matching": same type and same visual style. */
function matches(a: Node, b: Node): boolean {
  if (a.type !== b.type) return false;
  const pick = (n: Node) => {
    const r = n as unknown as Record<string, unknown>;
    return { fills: r.fills, strokes: r.strokes, effects: r.effects, style: r.style };
  };
  return canonicalEqual(pick(a) as never, pick(b) as never);
}

function step(editor: EditorController, delta: 1 | -1): void {
  const design = editor.design;
  const current = editor.getState().selection[0];
  if (!design) return;
  if (!current) {
    const all = scopeChildren(editor);
    const pick = delta === 1 ? all[0] : all[all.length - 1];
    if (pick) editor.select([pick]);
    return;
  }
  const ids = [
    current,
    ...siblings(design, current)
      .filter(selectable)
      .map((n) => n.id),
  ];
  const parent = getNode(design, design.nodes[current]?.parent ?? "");
  const order =
    parent && "children" in parent ? parent.children.filter((id) => ids.includes(id)) : ids;
  const i = order.indexOf(current);
  const next = order[(i + delta + order.length) % order.length];
  if (next) editor.select([next]);
}

export function selectionCommands(): AnyCommand[] {
  return [
    {
      id: "selection.selectAll",
      label: "Select all",
      category: "selection",
      icon: BoxSelect,
      when: NAV,
      run: (_a, { editor }) => editor.select(scopeChildren(editor)),
    },
    {
      id: "selection.clear",
      label: "Deselect",
      category: "selection",
      icon: SquareX,
      when: "loaded && (hasSelection || inScope) && !textEditing && !modalOpen && !paletteOpen",
      run: (_a, { editor }) => {
        const s = editor.getState();
        // Escape first leaves an entered group (selecting it), then clears.
        if (s.scopeId) {
          const scope = s.scopeId;
          editor.store.setState({ scopeId: null });
          editor.select([scope]);
          return;
        }
        editor.clearSelection();
      },
    },
    {
      id: "selection.enter",
      label: "Select children",
      category: "selection",
      icon: CornerRightDown,
      when: "loaded && singleSelection && !textEditing",
      run: (_a, { editor }) => {
        const node = editor.selectedNodes()[0];
        const design = editor.design;
        if (!node || !design) return;
        if (node.type === "text" && editor.canEdit) {
          editor.setTextEditing(node.id);
          return;
        }
        if (CONTAINER_TYPES.has(node.type) && "children" in node) {
          const kids = node.children.filter((id) => selectable(design.nodes[id]));
          if (kids.length > 0) {
            editor.store.setState({ scopeId: node.id });
            editor.select(kids);
          }
        }
      },
    },
    {
      id: "selection.parent",
      label: "Select parent",
      category: "selection",
      icon: CornerLeftUp,
      when: "loaded && hasSelection && !textEditing",
      run: (_a, { editor }) => {
        const design = editor.design;
        const node = editor.selectedNodes()[0];
        const parent = node?.parent ? design?.nodes[node.parent] : undefined;
        if (!parent || parent.type === "page" || parent.type === "root") return;
        const grand = parent.parent ? design?.nodes[parent.parent] : undefined;
        editor.store.setState({
          scopeId: grand && grand.type !== "page" && grand.type !== "root" ? grand.id : null,
        });
        editor.select([parent.id]);
      },
    },
    {
      id: "selection.next",
      label: "Select next layer",
      category: "selection",
      hidden: true,
      repeat: true,
      // Only with a selection: otherwise Tab keeps moving keyboard focus into the editor chrome.
      when: `${NAV} && hasSelection`,
      run: (_a, { editor }) => step(editor, 1),
    },
    {
      id: "selection.previous",
      label: "Select previous layer",
      category: "selection",
      hidden: true,
      repeat: true,
      when: `${NAV} && hasSelection`,
      run: (_a, { editor }) => step(editor, -1),
    },
    {
      id: "selection.matching",
      label: "Select matching layers",
      category: "selection",
      icon: ListChecks,
      when: "loaded && singleSelection && selectionHasNodes && !textEditing",
      keywords: ["similar", "same"],
      run: (_a, { editor }) => {
        const design = editor.design;
        const node = editor.selectedNodes()[0];
        const page = editor.currentPage();
        if (!design || !node || !page) return;
        const found = findNodes(design, (n) => selectable(n) && matches(n, node), page.id);
        editor.select(found.map((n) => n.id));
      },
    },
  ];
}
