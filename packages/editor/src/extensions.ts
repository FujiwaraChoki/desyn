import { aiExtension } from "./ai/index.ts";
import { canvasExtension } from "./canvas/index.ts";
import { collabExtension } from "./collab/index.ts";
import { builtinToolDefs } from "./commands/tools.ts";
import { exportExtension } from "./export/index.ts";
import { panelsExtension } from "./panels/index.ts";
import { presentExtension } from "./present/index.ts";
import {
  type ContextMenuEntry,
  defineExtension,
  type EditorExtension,
} from "./shell/extensions.ts";
import { ShortcutsDialog } from "./shell/shortcuts-dialog.tsx";

/**
 * Built-in shell contributions: the tools of the dock, the shortcuts dialog and the canvas context menu.
 * Feature extensions add theirs below (one import + one array entry each; keep the list append-only):
 *
 *   import { canvasExtension } from "./canvas/index.ts";
 *   export const BUILTIN_EXTENSIONS = [coreExtension, canvasExtension, ...];
 */

const SELECTION_MENU: [string, number][] = [
  ["edit.cut", 10],
  ["edit.copy", 11],
  ["edit.paste", 12],
  ["edit.pasteInPlace", 13],
  ["edit.duplicate", 14],
  ["-", 19],
  ["arrange.bringToFront", 20],
  ["arrange.bringForward", 21],
  ["arrange.sendBackward", 22],
  ["arrange.sendToBack", 23],
  ["-", 29],
  ["edit.group", 30],
  ["edit.ungroup", 31],
  ["edit.frameSelection", 32],
  ["edit.autoLayout", 33],
  ["edit.useAsMask", 34],
  ["-", 39],
  ["edit.flipHorizontal", 40],
  ["edit.flipVertical", 41],
  ["edit.toggleLock", 42],
  ["edit.toggleVisibility", 43],
  ["edit.rename", 44],
  ["-", 49],
  ["edit.copyStyle", 50],
  ["edit.pasteStyle", 51],
  ["edit.copyAsPng", 52],
  ["-", 89],
  ["edit.delete", 90],
];

const CANVAS_MENU: [string, number][] = [
  ["edit.paste", 10],
  ["edit.pasteInPlace", 11],
  ["selection.selectAll", 12],
  ["-", 19],
  ["view.zoomFit", 20],
  ["view.zoom100", 21],
  ["-", 29],
  ["view.toggleRulers", 30],
  ["view.toggleLayoutGrid", 31],
  ["view.toggleSnapping", 32],
  ["-", 39],
  ["page.add", 40],
  ["page.duplicate", 41],
  ["page.delete", 42],
];

const entries = (
  list: [string, number][],
  target: ContextMenuEntry["target"],
): ContextMenuEntry[] => list.map(([command, order]) => ({ command, order, target }));

export const coreExtension = defineExtension({
  id: "core",
  setup(api) {
    for (const tool of builtinToolDefs()) api.registerTool(tool);
    api.registerModal({ id: "shortcuts", component: ShortcutsDialog });
    api.registerContextMenu([
      ...entries(SELECTION_MENU, "selection"),
      ...entries(CANVAS_MENU, "canvas"),
    ]);
  },
});

/** Extensions every <Editor/> installs, in order. */
export const BUILTIN_EXTENSIONS: EditorExtension[] = [
  coreExtension,
  aiExtension,
  panelsExtension,
  collabExtension,
  exportExtension,
  presentExtension,
  canvasExtension,
];
