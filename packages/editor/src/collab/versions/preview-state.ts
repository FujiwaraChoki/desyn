"use client";

import { type Design, validateDesign } from "@desyn/schema";
import { useConfirm } from "@desyn/ui";
import { useEditor } from "../../context.tsx";
import type { EditorController } from "../../controller.ts";
import type { VersionRow } from "../backend.ts";
import { errorCode, errorMessage } from "../live.ts";
import { collabOf } from "../state.ts";

const designs = new Map<string, Promise<Design>>();

/** Design JSON of a version (cached: versions never change). */
export function loadVersionDesign(editor: EditorController, versionId: string): Promise<Design> {
  const services = collabOf(editor);
  if (!services) return Promise.reject(new Error("Version history is not available here."));
  let p = designs.get(versionId);
  if (!p) {
    p = services.backend.versions.get(versionId).then(({ design }) => {
      const parsed = JSON.parse(design) as unknown;
      const result = validateDesign(parsed);
      if (!result.ok) throw new Error("The saved version could not be read.");
      return parsed as Design;
    });
    designs.set(versionId, p);
    p.catch(() => designs.delete(versionId));
  }
  return p;
}

export function useVersionPreview() {
  const editor = useEditor();
  const confirm = useConfirm();

  const open = async (version: VersionRow) => {
    const services = collabOf(editor);
    if (!services) return;
    try {
      const design = await loadVersionDesign(editor, version.id);
      services.store.setState({
        versionPreview: {
          versionId: version.id,
          name: version.name,
          createdAt: version.createdAt,
          auto: version.auto,
          design,
        },
      });
      editor.telemetry("version_previewed", { auto: version.auto });
    } catch (e) {
      editor.notify({
        kind: errorCode(e) === "LIMIT_REACHED" ? "info" : "error",
        title:
          errorCode(e) === "LIMIT_REACHED"
            ? "This version is older than your plan's history"
            : "Couldn't open the version",
        description: errorMessage(e),
      });
    }
  };

  const restore = async (version: { id: string; name: string }) => {
    const services = collabOf(editor);
    if (!services || !editor.canEdit) return;
    const ok = await confirm({
      title: `Restore “${version.name}”?`,
      description:
        "The design changes back to this version for everyone. The current state is saved as a version first, so you can return to it.",
      confirmLabel: "Restore",
    });
    if (!ok) return;
    try {
      await services.backend.versions.restore(version.id);
      services.store.setState({ versionPreview: null });
      editor.notify({
        kind: "success",
        title: `Restored “${version.name}”`,
        description: "The previous state was saved as “Before restoring”.",
      });
      editor.telemetry("version_restored", {});
    } catch (e) {
      editor.notify({
        kind: "error",
        title: "Couldn't restore the version",
        description: errorMessage(e),
      });
    }
  };

  return { open, restore };
}
