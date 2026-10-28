import { makeTransaction } from "@desyn/doc-ops";
import type { Design, Op } from "@desyn/schema";
import { useMemo, useRef } from "react";
import { useEditor } from "../../context.tsx";
import type { EditorController } from "../../controller.ts";

/**
 * Inspector edits.
 *
 * Continuous input (scrubbing a number, dragging a color or slider) previews through the engine on every step
 * (`editor.preview`) and commits once at the end of the gesture (`editor.commitPreview`): one transaction,
 * one undo step, nothing sent to the server per frame (ARCHITECTURE golden rules 1 and 3). Discrete input
 * (a select, a toggle, a typed value) goes straight to `editor.apply`.
 *
 * Builders receive the committed design view, so every preview is computed from the state before the
 * gesture (the engine replaces the previous preview).
 */

export type OpsBuilder = (design: Design) => Op[] | null;

export interface LiveEdit {
  /** Live step of a gesture. */
  preview: (build: OpsBuilder) => void;
  /** End of the gesture: commit the last state (built again from the final value). */
  commit: (build: OpsBuilder) => void;
  /** One-shot edit. */
  apply: (build: OpsBuilder) => void;
}

export function liveEdit(editor: EditorController, label: string): LiveEdit {
  let previewing = false;
  return {
    preview(build) {
      const design = editor.design;
      if (!design || !editor.canEdit) return;
      const ops = build(design);
      if (!ops || ops.length === 0) return;
      previewing = true;
      void editor.preview(makeTransaction(ops, label));
    },
    commit(build) {
      const design = editor.design;
      if (!design || !editor.canEdit) return;
      const ops = build(design);
      if (previewing) {
        previewing = false;
        if (!ops || ops.length === 0) {
          // The gesture ended where it started: drop the preview instead of committing its last
          // intermediate step.
          void editor.cancelPreview();
          return;
        }
        // Preview the final value (it may differ from the last step) and commit it.
        void editor.preview(makeTransaction(ops, label));
        void editor.commitPreview({ label });
        return;
      }
      if (ops && ops.length > 0) void editor.apply(ops, { label });
    },
    apply(build) {
      const design = editor.design;
      if (!design || !editor.canEdit) return;
      const ops = build(design);
      if (ops && ops.length > 0) void editor.apply(ops, { label });
    },
  };
}

/** `liveEdit` bound to the current editor, stable per label. */
export function useLiveEdit(label: string): LiveEdit {
  const editor = useEditor();
  const ref = useRef<{ key: string; edit: LiveEdit } | null>(null);
  return useMemo(() => {
    if (ref.current?.key !== label) ref.current = { key: label, edit: liveEdit(editor, label) };
    return ref.current.edit;
  }, [editor, label]);
}
