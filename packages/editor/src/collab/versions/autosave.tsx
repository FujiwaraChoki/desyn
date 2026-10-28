"use client";

import { useEffect } from "react";
import type { SlotProps } from "../../shell/extensions.ts";
import { errorCode } from "../live.ts";
import { collabOf } from "../state.ts";

/** How often an editing client asks the server for an autosave while its user keeps editing. */
export const AUTOSAVE_CHECK_MS = 3 * 60_000;

/**
 * Autosaved versions (root slot, edit mode): after own edits, ask `editor/autosave:autosave` every few
 * minutes; the server creates an automatic version when the design changed and none was made in the last
 * ten minutes, so several open clients never duplicate them. Stops for plans without version history.
 */
export function AutosaveController({ editor }: SlotProps) {
  useEffect(() => {
    const services = collabOf(editor);
    if (!services) return;
    let dirty = false;
    let stopped = false;
    let busy = false;
    const off = editor.sync.on("change", (c) => {
      if (c.cause === "local") dirty = true;
    });
    const tick = async () => {
      if (stopped || busy || !dirty || !editor.canEdit) return;
      // Wait until own edits reached the server so the version contains them.
      if (editor.getState().doc.sync.pending > 0) return;
      busy = true;
      try {
        const res = await services.backend.versions.autosave();
        if (res.skipped === "unavailable") stopped = true;
        else if (res.skipped !== "recent") dirty = false;
      } catch (e) {
        const code = errorCode(e);
        if (code === "FORBIDDEN" || code === "UNAUTHENTICATED" || code === "NOT_FOUND") {
          stopped = true;
        }
      } finally {
        busy = false;
      }
    };
    const timer = setInterval(() => void tick(), AUTOSAVE_CHECK_MS);
    const onHide = () => {
      if (document.visibilityState === "hidden") void tick();
    };
    document.addEventListener("visibilitychange", onHide);
    return () => {
      off();
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onHide);
    };
  }, [editor]);
  return null;
}
