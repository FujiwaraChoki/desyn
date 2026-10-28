import {
  type Alignment,
  alignNodes,
  bringForward,
  bringToFront,
  distribute,
  matchSize,
  sendBackward,
  sendToBack,
  tidyGrid,
} from "@desyn/doc-ops";
import {
  AlignCenterHorizontal,
  AlignCenterVertical,
  AlignEndHorizontal,
  AlignEndVertical,
  AlignHorizontalDistributeCenter,
  AlignStartHorizontal,
  AlignStartVertical,
  AlignVerticalDistributeCenter,
  ArrowDownToLine,
  ArrowUpToLine,
  ChevronDown,
  ChevronUp,
  Grid3x3,
  MoveHorizontal,
  MoveVertical,
} from "lucide-react";
import { movableIds, selectedIds } from "./helpers.ts";
import type { AnyCommand, CommandIcon } from "./registry.ts";

const EDIT_SEL = "canEdit && !textEditing && selectionHasNodes";

const ALIGN: [Alignment, string, CommandIcon][] = [
  ["left", "Align left", AlignStartVertical],
  ["center", "Align horizontal centers", AlignCenterVertical],
  ["right", "Align right", AlignEndVertical],
  ["top", "Align top", AlignStartHorizontal],
  ["middle", "Align vertical centers", AlignCenterHorizontal],
  ["bottom", "Align bottom", AlignEndHorizontal],
];

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function arrangeCommands(): AnyCommand[] {
  const align: AnyCommand[] = ALIGN.map(([alignment, label, icon]) => ({
    id: `arrange.align${cap(alignment)}`,
    label,
    category: "arrange",
    icon,
    keywords: ["align"],
    when: EDIT_SEL,
    run: (args: { to?: "page" | "selection" } | undefined, { editor }) =>
      editor.apply((design) => {
        const ids = movableIds(editor, design);
        return ids.length > 0
          ? alignNodes(design, ids, alignment, args?.to ? { to: args.to } : {})
          : null;
      }),
  }));
  return [
    ...align,
    {
      id: "arrange.distributeHorizontal",
      label: "Distribute horizontally",
      category: "arrange",
      icon: AlignHorizontalDistributeCenter,
      when: `${EDIT_SEL} && selectionCount >= 3`,
      run: (args: { spacing?: number } | undefined, { editor }) =>
        editor.apply((design) =>
          distribute(design, movableIds(editor, design), "horizontal", args ?? {}),
        ),
    },
    {
      id: "arrange.distributeVertical",
      label: "Distribute vertically",
      category: "arrange",
      icon: AlignVerticalDistributeCenter,
      when: `${EDIT_SEL} && selectionCount >= 3`,
      run: (args: { spacing?: number } | undefined, { editor }) =>
        editor.apply((design) =>
          distribute(design, movableIds(editor, design), "vertical", args ?? {}),
        ),
    },
    {
      id: "arrange.tidy",
      label: "Tidy up",
      category: "arrange",
      icon: Grid3x3,
      keywords: ["grid", "arrange", "spacing"],
      when: `${EDIT_SEL} && selectionCount >= 2`,
      run: (_a, { editor }) =>
        editor.apply((design) => tidyGrid(design, movableIds(editor, design))),
    },
    {
      id: "arrange.matchWidth",
      label: "Match width",
      category: "arrange",
      icon: MoveHorizontal,
      when: `${EDIT_SEL} && selectionCount >= 2`,
      run: (_a, { editor }) =>
        editor.apply((design) =>
          matchSize(design, movableIds(editor, design), { dimension: "width" }),
        ),
    },
    {
      id: "arrange.matchHeight",
      label: "Match height",
      category: "arrange",
      icon: MoveVertical,
      when: `${EDIT_SEL} && selectionCount >= 2`,
      run: (_a, { editor }) =>
        editor.apply((design) =>
          matchSize(design, movableIds(editor, design), { dimension: "height" }),
        ),
    },
    {
      id: "arrange.bringForward",
      label: "Bring forward",
      category: "arrange",
      icon: ChevronUp,
      when: EDIT_SEL,
      repeat: true,
      run: (_a, { editor }) =>
        editor.apply((design) => bringForward(design, selectedIds(editor, design))),
    },
    {
      id: "arrange.sendBackward",
      label: "Send backward",
      category: "arrange",
      icon: ChevronDown,
      when: EDIT_SEL,
      repeat: true,
      run: (_a, { editor }) =>
        editor.apply((design) => sendBackward(design, selectedIds(editor, design))),
    },
    {
      id: "arrange.bringToFront",
      label: "Bring to front",
      category: "arrange",
      icon: ArrowUpToLine,
      when: EDIT_SEL,
      run: (_a, { editor }) =>
        editor.apply((design) => bringToFront(design, selectedIds(editor, design))),
    },
    {
      id: "arrange.sendToBack",
      label: "Send to back",
      category: "arrange",
      icon: ArrowDownToLine,
      when: EDIT_SEL,
      run: (_a, { editor }) =>
        editor.apply((design) => sendToBack(design, selectedIds(editor, design))),
    },
  ];
}
