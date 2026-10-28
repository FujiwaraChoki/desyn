import { detectPlatform, isEditableTarget, type Platform } from "@desyn/ui";
import type { EditorController } from "../controller.ts";
import { effectiveKeymap, matchKey } from "./keymap.ts";

/**
 * Global keyboard handling for one editor: keydown -> matching command (when-clause enabled) -> run.
 *
 * - Focus in a text field (inspector inputs, the AI prompt, the text-editing textarea) only lets commands
 *   with `allowInInput` through.
 * - Inside an open dialog only `allowInInput` commands run (the dialog owns Escape / Enter).
 * - Auto-repeat only fires commands marked `repeat` (nudges, zoom, undo).
 * - `passThrough` commands (copy / cut / paste) run without preventing the default, so the browser fires the
 *   clipboard events the clipboard service handles.
 * - Holding Space switches to the hand tool until release.
 */
const INTERACTIVE =
  "button,a[href],select,summary,[role=button],[role=menuitem],[role=tab],[role=treeitem],[role=slider]," +
  "[role=separator],[role=option],[role=switch],[role=checkbox],[role=radio],[role=listbox],[role=grid]";

const NAVIGATION_KEYS: ReadonlySet<string> = new Set([
  "Tab",
  "Enter",
  "Escape",
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "Delete",
  "Backspace",
  "Home",
  "End",
  "PageUp",
  "PageDown",
]);

const hasModifier = (e: KeyboardEvent) => e.metaKey || e.ctrlKey || e.altKey;

export function installShortcuts(
  editor: EditorController,
  target: Window = window,
  platform: Platform = detectPlatform(),
): () => void {
  let cache: {
    version: number;
    keymap: Record<string, string[]>;
    map: Map<string, readonly string[]>;
  } | null = null;
  const bindings = () => {
    const version = editor.commands.getVersion();
    const overrides = editor.getState().keymap;
    if (!cache || cache.version !== version || cache.keymap !== overrides) {
      cache = { version, keymap: overrides, map: effectiveKeymap(editor.commands, overrides) };
    }
    return cache.map;
  };

  const inDialog = (t: EventTarget | null) =>
    t instanceof Element && !!t.closest("[role=dialog],[role=alertdialog]");

  // Plain navigation keys belong to a focused control (buttons, tabs, tree rows, sliders...): Tab must move
  // focus and Enter must press the button. They act on the canvas only when focus is on the page body or
  // inside the canvas region.
  const ownsNavigation = (t: EventTarget | null) =>
    t instanceof Element && !t.closest("[data-editor-canvas]") && !!t.closest(INTERACTIVE);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.defaultPrevented || e.isComposing) return;
    const editable = isEditableTarget(e.target);
    const dialog = inDialog(e.target);
    const state = editor.getState();
    if (
      e.key === " " &&
      !e.metaKey &&
      !e.ctrlKey &&
      !e.altKey &&
      !editable &&
      !dialog &&
      !state.textEditing
    ) {
      e.preventDefault();
      if (!e.repeat && state.heldTool !== "hand") editor.holdTool("hand");
      return;
    }
    for (const [id, keys] of bindings()) {
      if (!keys.some((k) => matchKey(e, k, platform))) continue;
      const cmd = editor.commands.get(id);
      if (!cmd) continue;
      if ((editable || dialog) && !cmd.allowInInput) continue;
      if (!hasModifier(e) && NAVIGATION_KEYS.has(e.key) && ownsNavigation(e.target)) continue;
      if (!editor.commands.isEnabled(id)) continue;
      if (e.repeat && !cmd.repeat) {
        if (!cmd.passThrough) e.preventDefault();
        return;
      }
      if (!cmd.passThrough) e.preventDefault();
      void editor.commands.run(id, undefined, "keyboard", e);
      return;
    }
  };

  const onKeyUp = (e: KeyboardEvent) => {
    if (e.key === " " && editor.getState().heldTool === "hand") editor.holdTool(null);
  };
  const onBlur = () => {
    if (editor.getState().heldTool) editor.holdTool(null);
  };

  // Clipboard events (keyboard and browser menu copies / pastes) go to the clipboard service unless a text
  // field owns them.
  const onCopy = (e: ClipboardEvent) => {
    if (isEditableTarget(e.target) || editor.getState().textEditing) return;
    editor.clipboard.handleCopyEvent(e, false);
  };
  const onCut = (e: ClipboardEvent) => {
    if (isEditableTarget(e.target) || editor.getState().textEditing || !editor.canEdit) return;
    editor.clipboard.handleCopyEvent(e, true);
  };
  const onPaste = (e: ClipboardEvent) => {
    if (isEditableTarget(e.target) || editor.getState().textEditing || inDialog(e.target)) return;
    editor.clipboard.handlePasteEvent(e);
  };

  target.addEventListener("keydown", onKeyDown);
  target.addEventListener("keyup", onKeyUp);
  target.addEventListener("blur", onBlur);
  target.document.addEventListener("copy", onCopy);
  target.document.addEventListener("cut", onCut);
  target.document.addEventListener("paste", onPaste);
  return () => {
    target.removeEventListener("keydown", onKeyDown);
    target.removeEventListener("keyup", onKeyUp);
    target.removeEventListener("blur", onBlur);
    target.document.removeEventListener("copy", onCopy);
    target.document.removeEventListener("cut", onCut);
    target.document.removeEventListener("paste", onPaste);
  };
}
