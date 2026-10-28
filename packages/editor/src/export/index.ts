import { FileUp } from "lucide-react";
import { useEffect } from "react";
import type { AnyCommand } from "../commands/registry.ts";
import type { EditorController } from "../controller.ts";
import { defineExtension, type EditorExtension, type SlotProps } from "../shell/extensions.ts";
import { createConvexExportBackend, type ExportBackend } from "./backend.ts";
import { ExportDialog } from "./dialog.tsx";
import { isExportFormat } from "./formats.ts";
import { ImportDialog } from "./import/dialog.tsx";
import { importKindOf } from "./import/run.ts";
import { attachExport, detachExport, trackJobs } from "./run.ts";

export interface ExportExtensionOptions {
  /** Backend for server exports (default: the editor's Convex client; none = browser exports only). */
  backend?: (editor: EditorController) => ExportBackend | null;
}

function defaultBackend(editor: EditorController): ExportBackend | null {
  if (!editor.convex) return null;
  return createConvexExportBackend(editor.convex, editor.getState().designId, editor.share);
}

/** Root slot: follows server export jobs after the dialog closes (download + toast when ready). */
function ExportJobsTracker({ editor }: SlotProps) {
  useEffect(() => trackJobs(editor), [editor]);
  return null;
}

/**
 * Root slot: PDF, PowerPoint, .desyn and JSON files dropped anywhere on the editor open the import dialog
 * (images and SVG keep the canvas' own drop handling, which places them at the pointer).
 */
function DocumentDropTarget({ editor }: SlotProps) {
  useEffect(() => {
    const documents = (dt: DataTransfer | null) =>
      [...(dt?.files ?? [])].filter((f) => {
        const kind = importKindOf(f);
        return kind === "pdf" || kind === "pptx" || kind === "design";
      });
    const hasFiles = (e: DragEvent) => [...(e.dataTransfer?.types ?? [])].includes("Files");
    const onDragOver = (e: DragEvent) => {
      if (!editor.canEdit || !hasFiles(e)) return;
      // Items' names are hidden until drop; accept so the drop event fires everywhere in the editor.
      e.preventDefault();
    };
    const onDrop = (e: DragEvent) => {
      if (!editor.canEdit) return;
      const files = documents(e.dataTransfer);
      if (files.length === 0) return;
      e.preventDefault();
      e.stopPropagation();
      editor.openModal("import", { files });
    };
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("drop", onDrop, { capture: true });
    return () => {
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("drop", onDrop, { capture: true });
    };
  }, [editor]);
  return null;
}

function exportCommands(): AnyCommand[] {
  return [
    {
      id: "file.import",
      label: "Import files…",
      category: "file",
      icon: FileUp,
      keywords: ["pdf", "pptx", "powerpoint", "svg", "upload", "open", "desyn", "json"],
      when: "canEdit",
      run: (_a, { editor }) => editor.openModal("import"),
    },
    {
      id: "file.exportAs",
      label: "Export as…",
      category: "file",
      hidden: true,
      when: "loaded",
      run: (args: { format?: string; pages?: "current" } | undefined, { editor }) =>
        editor.openModal("export", {
          ...(args?.format && isExportFormat(args.format) ? { format: args.format } : {}),
          ...(args?.pages ? { pages: args.pages } : {}),
        }),
    },
  ];
}

/**
 * Export (dialog with every format; small exports in the browser, large / video ones as server jobs with
 * progress and e-mail) and import (SVG, images, PDF pages, PowerPoint, .desyn, Design JSON).
 */
export function createExportExtension(options: ExportExtensionOptions = {}): EditorExtension {
  return defineExtension({
    id: "export",
    setup(api) {
      attachExport(api.editor, (options.backend ?? defaultBackend)(api.editor));
      api.onDispose(() => detachExport(api.editor));
      api.registerModal({ id: "export", component: ExportDialog });
      api.registerModal({ id: "import", component: ImportDialog });
      api.registerSlot("root", { id: "export.jobs", component: ExportJobsTracker });
      api.registerSlot("root", {
        id: "export.drop",
        component: DocumentDropTarget,
        modes: ["edit"],
      });
      api.registerCommands(exportCommands());
    },
  });
}

export const exportExtension = createExportExtension();

export { type ExportFormat, FORMATS, formatInfo } from "./formats.ts";
export {
  defaultExportOptions,
  type ExportOptions,
  type ExportPlan,
  planExport,
} from "./options.ts";
