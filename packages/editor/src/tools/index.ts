import { commentTool } from "./comment.ts";
import { handTool } from "./navigation.ts";
import { penTool } from "./pen.ts";
import { pencilTool } from "./pencil.ts";
import { selectTool } from "./select.ts";
import { shapeTools } from "./shapes.ts";
import { textTool } from "./text.ts";
import type { Tool } from "./types.ts";

export { COMPOSE_COMMAND } from "./comment.ts";
export { startPathEditing } from "./pen.ts";
export type { CanvasPointer, Gesture, Mode, Tool } from "./types.ts";

/** Every canvas tool by id (the store's `tool` picks one; ids match the dock's tool definitions). */
export const ALL_TOOLS: readonly Tool[] = [
  selectTool,
  handTool,
  ...shapeTools,
  penTool,
  pencilTool,
  textTool,
  commentTool,
];
