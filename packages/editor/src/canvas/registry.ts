import type { EditorController } from "../controller.ts";
import type { CanvasController } from "./controller.ts";

/** The mounted canvas controller per editor (commands reach the canvas through it). */
const controllers = new WeakMap<EditorController, CanvasController>();

/** The mounted canvas controller of an editor (null before the canvas mounts). */
export function canvasControllerOf(editor: EditorController): CanvasController | null {
  return controllers.get(editor) ?? null;
}

export function registerCanvasController(
  editor: EditorController,
  c: CanvasController | null,
): void {
  if (c) controllers.set(editor, c);
  else controllers.delete(editor);
}
