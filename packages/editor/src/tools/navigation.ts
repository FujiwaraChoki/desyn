import type { CanvasController } from "../canvas/controller.ts";
import { CURSORS } from "../canvas/cursors.ts";
import { PanGesture } from "../canvas/gestures/marquee.ts";
import type { CanvasPointer, Gesture, Tool } from "./types.ts";

/** Hand tool (also space-hold and the middle mouse button): drag to pan. */
export const handTool: Tool = {
  id: "hand",
  cursor(): string {
    return CURSORS.grab;
  },
  down(c: CanvasController, e: CanvasPointer): Gesture {
    return new PanGesture(c, e);
  },
};
