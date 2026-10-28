import {
  Builder,
  createdIds,
  deleteNodes,
  duplicate,
  groupNodes,
  makeTransaction,
  ungroup,
  wrapInFrame,
} from "@desyn/doc-ops";
import type { AutoLayout, Design, Id, Node, Op } from "@desyn/schema";
import {
  Copy,
  CopyPlus,
  Eye,
  FlipHorizontal2,
  FlipVertical2,
  Frame,
  Group,
  Layers2,
  Lock,
  PaintBucket,
  Paintbrush,
  PenLine,
  Redo2,
  Rows3,
  SquareDashed,
  Trash2,
  Undo2,
  Ungroup,
} from "lucide-react";
import type { EditorController } from "../controller.ts";
import { boundsOf, movableIds, selectedIds } from "./helpers.ts";
import type { AnyCommand } from "./registry.ts";

const EDIT = "canEdit && !textEditing";
const EDIT_SEL = `${EDIT} && selectionHasNodes`;

export function historyCommands(): AnyCommand[] {
  return [
    {
      id: "history.undo",
      label: (ctx) => (ctx.undoLabel ? `Undo ${String(ctx.undoLabel)}` : "Undo"),
      category: "history",
      icon: Undo2,
      when: "canEdit && canUndo && !textEditing",
      repeat: true,
      run: (_a, { editor }) => editor.undo(),
    },
    {
      id: "history.redo",
      label: (ctx) => (ctx.redoLabel ? `Redo ${String(ctx.redoLabel)}` : "Redo"),
      category: "history",
      icon: Redo2,
      when: "canEdit && canRedo && !textEditing",
      repeat: true,
      run: (_a, { editor }) => editor.redo(),
    },
  ];
}

/** Style keys copied by "Copy style" (only those the target type has are pasted). */
const STYLE_KEYS = [
  "fills",
  "strokes",
  "effects",
  "opacity",
  "blend",
  "cornerRadius",
  "cornerSmoothing",
  "style",
  "paragraph",
  "adjust",
] as const;

let copiedStyle: Record<string, unknown> | null = null;

function styleOf(node: Node): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const src = node as unknown as Record<string, unknown>;
  for (const k of STYLE_KEYS) if (src[k] !== undefined) out[k] = structuredClone(src[k]);
  return out;
}

/** Auto layout guessed from the arrangement of the children: row when they spread horizontally. */
export function inferAutoLayout(design: Design, ids: Id[]): AutoLayout {
  const boxes = ids
    .map((id) => boundsOf(design, [id]))
    .filter((b): b is NonNullable<typeof b> => !!b);
  const all = boundsOf(design, ids);
  const horizontal = !all || all.width >= all.height;
  const sorted = [...boxes].sort((a, b) => (horizontal ? a.x - b.x : a.y - b.y));
  let gaps = 0;
  for (let i = 1; i < sorted.length; i++) {
    const p = sorted[i - 1] as (typeof sorted)[number];
    const c = sorted[i] as (typeof sorted)[number];
    gaps += Math.max(0, horizontal ? c.x - (p.x + p.width) : c.y - (p.y + p.height));
  }
  const gap = sorted.length > 1 ? Math.round(gaps / (sorted.length - 1)) : 16;
  return {
    mode: horizontal ? "row" : "column",
    gap,
    padding: [0, 0, 0, 0],
    mainAlign: "start",
    crossAlign: horizontal ? "center" : "start",
  };
}

function toggle(
  editor: EditorController,
  key: "locked" | "visible" | "flipX" | "flipY",
  label: string,
): Promise<unknown> {
  return editor.apply(
    (design) => {
      const ids = selectedIds(editor, design);
      if (ids.length === 0) return null;
      const nodes = ids.map((id) => design.nodes[id] as Node);
      const b = new Builder(design);
      if (key === "visible") {
        const show = nodes.every((n) => !n.visible);
        for (const n of nodes) b.update(n.id, { visible: show });
      } else if (key === "locked") {
        const lock = !nodes.every((n) => n.locked);
        for (const n of nodes) b.update(n.id, { locked: lock });
      } else {
        for (const n of nodes) b.update(n.id, { [key]: !n[key] });
      }
      return b.build(label);
    },
    { label },
  );
}

export function editCommands(): AnyCommand[] {
  return [
    {
      id: "edit.delete",
      label: "Delete",
      category: "edit",
      icon: Trash2,
      when: `${EDIT} && hasSelection`,
      run: (_a, { editor }) =>
        editor.apply(
          (design, s) => {
            const ids = s.selection.filter((id) => !design.nodes[id]?.locked);
            return ids.length > 0 ? deleteNodes(design, ids) : null;
          },
          { select: [] },
        ),
    },
    {
      id: "edit.duplicate",
      label: "Duplicate",
      category: "edit",
      icon: CopyPlus,
      when: `${EDIT} && hasSelection`,
      run: (_a, { editor }) =>
        editor.apply((design, s) => duplicate(design, s.selection), { selectCreated: true }),
    },
    {
      id: "edit.group",
      label: "Group selection",
      category: "edit",
      icon: Group,
      when: EDIT_SEL,
      run: (_a, { editor }) =>
        editor.apply((design) => groupNodes(design, selectedIds(editor, design)), {
          selectCreated: true,
        }),
    },
    {
      id: "edit.ungroup",
      label: "Ungroup",
      category: "edit",
      icon: Ungroup,
      when: `${EDIT} && selectionHasContainer`,
      run: async (_a, { editor }) => {
        let children: Id[] = [];
        await editor.apply((design) => {
          const ids = selectedIds(editor, design).filter((id) => {
            const t = design.nodes[id]?.type;
            return t === "group" || t === "frame" || t === "boolean";
          });
          if (ids.length === 0) return null;
          children = ids.flatMap((id) => {
            const n = design.nodes[id] as Node & { children?: Id[] };
            return n.children ?? [];
          });
          return ungroup(design, ids);
        });
        if (children.length > 0) editor.select(children);
      },
    },
    {
      id: "edit.frameSelection",
      label: "Frame selection",
      category: "edit",
      icon: Frame,
      when: EDIT_SEL,
      run: (_a, { editor }) =>
        editor.apply((design) => wrapInFrame(design, selectedIds(editor, design)), {
          selectCreated: true,
        }),
    },
    {
      id: "edit.autoLayout",
      label: (ctx) =>
        ctx.selectionType === "frame" && ctx.selectionHasAutoLayout
          ? "Remove auto layout"
          : "Add auto layout",
      category: "edit",
      icon: Rows3,
      when: EDIT_SEL,
      keywords: ["stack", "flex", "row", "column"],
      run: (_a, { editor }) =>
        editor.apply(
          (design) => {
            const ids = selectedIds(editor, design);
            const only = ids.length === 1 ? design.nodes[ids[0] as Id] : undefined;
            if (only?.type === "frame") {
              if (only.layout) {
                return makeTransaction(
                  [{ op: "update", id: only.id, unset: ["layout"] }],
                  "Remove auto layout",
                );
              }
              return makeTransaction(
                [
                  {
                    op: "update",
                    id: only.id,
                    set: { layout: inferAutoLayout(design, only.children) },
                  },
                ],
                "Add auto layout",
              );
            }
            const layout = inferAutoLayout(design, ids);
            const wrap = wrapInFrame(design, ids, { name: "Auto layout" });
            const frameId = createdIds(wrap)[0] as Id;
            return {
              ...wrap,
              label: "Add auto layout",
              ops: [...wrap.ops, { op: "update", id: frameId, set: { layout } } as Op],
            };
          },
          { selectCreated: true },
        ),
    },
    {
      id: "edit.useAsMask",
      label: "Use as mask",
      category: "edit",
      icon: SquareDashed,
      when: EDIT_SEL,
      keywords: ["clip", "mask"],
      run: (_a, { editor }) =>
        editor.apply(
          (design) => {
            const ids = selectedIds(editor, design);
            const first = ids[0];
            if (!first) return null;
            if (ids.length === 1) {
              const n = design.nodes[first] as Node;
              return makeTransaction(
                [{ op: "update", id: first, set: { mask: !n.mask } }],
                n.mask ? "Remove mask" : "Use as mask",
              );
            }
            // The bottom-most selected layer masks the others inside a new group.
            const grouped = groupNodes(design, ids, { name: "Mask group" });
            return {
              ...grouped,
              label: "Use as mask",
              ops: [...grouped.ops, { op: "update", id: first, set: { mask: true } } as Op],
            };
          },
          { selectCreated: true },
        ),
    },
    {
      id: "edit.flipHorizontal",
      label: "Flip horizontal",
      category: "edit",
      icon: FlipHorizontal2,
      when: EDIT_SEL,
      run: (_a, { editor }) => toggle(editor, "flipX", "Flip horizontal"),
    },
    {
      id: "edit.flipVertical",
      label: "Flip vertical",
      category: "edit",
      icon: FlipVertical2,
      when: EDIT_SEL,
      run: (_a, { editor }) => toggle(editor, "flipY", "Flip vertical"),
    },
    {
      id: "edit.toggleLock",
      label: (ctx) => (ctx.selectionAllLocked ? "Unlock" : "Lock"),
      category: "edit",
      icon: Lock,
      when: EDIT_SEL,
      run: (_a, { editor }) => toggle(editor, "locked", "Lock / unlock"),
    },
    {
      id: "edit.toggleVisibility",
      label: (ctx) => (ctx.selectionAllHidden ? "Show" : "Hide"),
      category: "edit",
      icon: Eye,
      when: EDIT_SEL,
      run: (_a, { editor }) => toggle(editor, "visible", "Show / hide"),
    },
    {
      id: "edit.rename",
      label: "Rename layer",
      category: "edit",
      icon: PenLine,
      when: `${EDIT} && singleSelection`,
      run: (_a, { editor }) => {
        const id = editor.getState().selection[0];
        if (!id) return;
        editor.toggleLeftPanel("layers", true);
        editor.store.setState({ renaming: id });
      },
    },
    {
      id: "edit.copyStyle",
      label: "Copy style",
      category: "edit",
      icon: Paintbrush,
      when: "loaded && singleSelection && !textEditing",
      run: (_a, { editor }) => {
        const node = editor.selectedNodes()[0];
        if (!node) return;
        copiedStyle = styleOf(node);
        editor.notify({ kind: "success", title: "Style copied" });
      },
    },
    {
      id: "edit.pasteStyle",
      label: "Paste style",
      category: "edit",
      icon: PaintBucket,
      when: (ctx) => ctx.canEdit === true && ctx.selectionHasNodes === true && copiedStyle !== null,
      run: (_a, { editor }) =>
        editor.apply(
          (design) => {
            const style = copiedStyle;
            if (!style) return null;
            const b = new Builder(design);
            for (const id of selectedIds(editor, design)) {
              const node = design.nodes[id] as unknown as Record<string, unknown>;
              const set: Record<string, unknown> = {};
              for (const [k, v] of Object.entries(style)) {
                // Only properties this node type has (a rect gets no text style).
                if (k in node) set[k] = structuredClone(v);
              }
              if (Object.keys(set).length > 0) b.update(id, set as never);
            }
            return b.build("Paste style");
          },
          { label: "Paste style" },
        ),
    },
    ...nudgeCommands(),
    {
      id: "edit.copyId",
      label: "Copy layer id",
      category: "edit",
      icon: Copy,
      hidden: true,
      when: "singleSelection",
      run: async (_a, { editor }) => {
        const id = editor.getState().selection[0];
        if (id) await navigator.clipboard?.writeText(id);
      },
    },
    {
      id: "edit.bringIntoScope",
      label: "Select layers above",
      category: "edit",
      icon: Layers2,
      hidden: true,
      when: "singleSelection",
      run: (_a, { editor }) => {
        const design = editor.design;
        const id = editor.getState().selection[0];
        const node = id ? design?.nodes[id] : undefined;
        const parent = node?.parent ? design?.nodes[node.parent] : undefined;
        if (!parent || !("children" in parent) || !id) return;
        const i = parent.children.indexOf(id);
        editor.select(parent.children.slice(i));
      },
    },
  ];
}

function nudgeCommands(): AnyCommand[] {
  const dirs = [
    ["Left", -1, 0, "arrowleft"],
    ["Right", 1, 0, "arrowright"],
    ["Up", 0, -1, "arrowup"],
    ["Down", 0, 1, "arrowdown"],
  ] as const;
  return dirs.flatMap(([name, dx, dy]) =>
    [1, 10].map(
      (step): AnyCommand => ({
        id: `edit.nudge${name}${step === 10 ? "Big" : ""}`,
        label: `Nudge ${name.toLowerCase()} ${step} px`,
        category: "edit",
        hidden: true,
        repeat: true,
        when: EDIT_SEL,
        run: (_a, { editor }) => {
          const ids = movableIds(editor);
          if (ids.length === 0) return;
          return editor.apply(
            (design) => {
              const b = new Builder(design);
              for (const id of movableIds(editor, design))
                b.translateInPage(id, dx * step, dy * step);
              b.refitGroups(ids);
              return b.build("Nudge");
            },
            // Holding an arrow key is one undo step.
            { label: "Nudge", coalesceKey: `nudge:${[...ids].sort().join(",")}` },
          );
        },
      }),
    ),
  );
}
