import { useMemo } from "react";
import { useEditorStore } from "../../context.tsx";
import { refs, useBackendQuery, useWorkspaceId } from "../backend.ts";

/** Colors of the design's brand kit (or the workspace default kit) for the color pickers. */
export function useBrandColors(): string[] {
  const workspaceId = useWorkspaceId();
  const kitId = useEditorStore((s) => s.doc.design?.brandKitId ?? null);
  const kits = useBackendQuery(refs.brandList, workspaceId ? { workspaceId } : "skip");
  return useMemo(() => {
    const list = kits.data ?? [];
    const kit = list.find((k) => k.id === kitId) ?? list.find((k) => k.isDefault) ?? list[0];
    return kit ? kit.colors.map((c) => c.value) : [];
  }, [kits.data, kitId]);
}
