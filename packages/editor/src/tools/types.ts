import type { CanvasController } from "../canvas/controller.ts";
import type { Point } from "../canvas/math.ts";
import type { Painter } from "../canvas/overlay/paint.ts";

/**
 * Canvas tools and modes. A tool turns pointer input on the canvas into a gesture (drag, draw, pan) and may
 * draw its own overlay. A mode (text editing, path editing, crop) temporarily takes over input from the tool
 * until it exits. The canvas controller routes events: mode first, then the active tool.
 */

export interface CanvasPointer {
  /** CSS px relative to the canvas' top-left corner. */
  screen: Point;
  /** Design px on the current page. */
  page: Point;
  button: number;
  buttons: number;
  shift: boolean;
  alt: boolean;
  /** ⌘ on macOS, Ctrl elsewhere. */
  mod: boolean;
  ctrl: boolean;
  meta: boolean;
  pointerType: string;
  pointerId: number;
  /** 1 = single click, 2 = double click ... (pointer `detail`). */
  clickCount: number;
  pressure: number;
  time: number;
}

/** A drag in progress. `move` may run at pointer rate; it must stay cheap (previews coalesce in the engine). */
export interface Gesture {
  move(e: CanvasPointer): void;
  up(e: CanvasPointer): void | Promise<void>;
  /** Escape / lost capture / tool change: undo the live preview. */
  cancel(): void | Promise<void>;
  /** Overlay while the gesture runs. */
  draw?(p: Painter): void;
  /** Cursor while dragging. */
  cursor?: string;
  /** Whether hover outlines stay hidden while the gesture runs (default true). */
  hidesHover?: boolean;
}

export interface CanvasHandler {
  /** Pointer down on the canvas: a gesture, or null when the press was fully handled. */
  down(c: CanvasController, e: CanvasPointer): Gesture | null | Promise<Gesture | null>;
  /** Pointer moved without a button (hover feedback, cursors). */
  hover?(c: CanvasController, e: CanvasPointer): void;
  /** Double click (after the second `down` was handled). */
  doubleClick?(c: CanvasController, e: CanvasPointer): void | Promise<void>;
  /** Key down while the canvas owns the keyboard; true when handled (the default action is prevented). */
  keyDown?(c: CanvasController, e: KeyboardEvent): boolean;
  /** Overlay drawn on top of the selection. */
  draw?(c: CanvasController, p: Painter): void;
  /** Cursor at rest. */
  cursor?(c: CanvasController): string;
}

export interface Tool extends CanvasHandler {
  id: string;
  /** Called when the tool becomes active / inactive. */
  activate?(c: CanvasController): void;
  deactivate?(c: CanvasController): void;
}

export interface Mode extends CanvasHandler {
  readonly kind: "text" | "path" | "crop";
  /** Ends the mode (commits pending work). */
  exit(reason: "escape" | "tool" | "selection" | "click" | "api"): void | Promise<void>;
  /** Whether the hover outline and selection handles are drawn while active (default false). */
  showsSelection?: boolean;
  /**
   * The document changed outside a gesture of this mode (undo / redo, a collaborator, the inspector): re-read
   * the edited layer so the next edit starts from the current state, or exit when it is gone.
   */
  documentChanged?(): void;
}
