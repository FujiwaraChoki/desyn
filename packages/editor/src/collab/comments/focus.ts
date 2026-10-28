"use client";

import { useEditor } from "../../context.tsx";
import type { EditorController } from "../../controller.ts";
import type { CommentThread } from "../backend.ts";
import { collabOf } from "../state.ts";
import { resolvePin } from "./anchor.ts";

/** Shows a thread's pin: switches to its page, pans it into view (keeping the zoom) and opens it. */
export function focusThread(editor: EditorController, thread: CommentThread): void {
  const services = collabOf(editor);
  const design = editor.design;
  if (!services || !design) return;
  const pin = resolvePin(design, thread);
  services.store.setState({ activeThread: thread.id, draft: null });
  if (!pin?.pageId) return;
  if (pin.pageId !== editor.getState().pageId) editor.setPage(pin.pageId);
  const client = editor.engineClient;
  if (!client) return;
  const view = client.view;
  // Pan only when the pin is off screen (or under the edges); keep the user's zoom.
  const sx = (pin.x - view.x) * view.zoom;
  const sy = (pin.y - view.y) * view.zoom;
  const margin = 80;
  if (sx > margin && sy > margin && sx < view.width - margin && sy < view.height - 200) return;
  client.setView({
    x: pin.x - view.width / 2 / view.zoom,
    y: pin.y - view.height / 2 / view.zoom,
  });
}

export function usePinFocus(): (thread: CommentThread) => void {
  const editor = useEditor();
  return (thread) => focusThread(editor, thread);
}
