import { Crop, Pencil, Spline } from "lucide-react";
import type { AnyCommand } from "../commands/registry.ts";
import { defineExtension } from "../shell/extensions.ts";
import { startPathEditing } from "../tools/pen.ts";
import { startCrop } from "./crop.ts";
import { CanvasInteraction } from "./interaction-layer.tsx";
import { canvasControllerOf } from "./registry.ts";

export { canvasControllerOf } from "./registry.ts";

/**
 * Canvas interaction extension: fills the `canvas.interaction` slot (selection, handles, snapping, tools,
 * text editing, path editing, crop, rulers and guides, drag and drop, smooth zoom), adds the pencil tool and the
 * "Edit path" / "Crop image" commands.
 */

function canvasCommands(): AnyCommand[] {
  return [
    {
      id: "tool.pencil",
      label: "Pencil tool",
      category: "tool",
      icon: Pencil,
      keys: ["shift+p"],
      keywords: ["draw", "freehand", "brush"],
      when: "canEdit && !textEditing",
      checked: (ctx) => ctx.tool === "pencil",
      run: (_a, { editor }) => editor.setTool("pencil"),
    },
    {
      id: "canvas.editPath",
      label: "Edit path",
      category: "edit",
      icon: Spline,
      keywords: ["points", "vector", "bezier", "nodes"],
      when: "canEdit && singleSelection && selectionType == 'path' && !textEditing",
      run: (_a, { editor }) => {
        const c = canvasControllerOf(editor);
        const id = editor.getState().selection[0];
        if (c && id) return startPathEditing(c, id);
      },
    },
    {
      id: "canvas.cropImage",
      label: "Crop image",
      category: "edit",
      icon: Crop,
      keywords: ["crop", "reframe", "mask"],
      when: "canEdit && singleSelection && selectionType == 'image' && !textEditing",
      run: (_a, { editor }) => {
        const c = canvasControllerOf(editor);
        const id = editor.getState().selection[0];
        if (c && id) return startCrop(c, id);
      },
    },
  ];
}

export const canvasExtension = defineExtension({
  id: "canvas",
  setup(api) {
    api.registerSlot("canvas.interaction", {
      id: "canvas-interaction",
      component: CanvasInteraction,
    });
    api.registerTool({
      id: "pencil",
      label: "Pencil",
      icon: Pencil,
      group: "pen",
      order: 105,
      command: "tool.pencil",
      modes: ["edit"],
    });
    api.registerCommands(canvasCommands());
    api.registerContextMenu([
      { command: "canvas.editPath", target: "selection", order: 45 },
      { command: "canvas.cropImage", target: "selection", order: 46 },
    ]);
  },
});
