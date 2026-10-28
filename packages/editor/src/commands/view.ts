import { clampZoom } from "@desyn/engine";
import {
  Grid2x2,
  Magnet,
  Maximize,
  Ruler,
  Scan,
  ScanSearch,
  SquareDashedMousePointer,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import type { EditorController } from "../controller.ts";
import { boundsOf, selectedIds } from "./helpers.ts";
import type { AnyCommand } from "./registry.ts";

/** Zoom presets the +/- commands step through (also offered in the zoom menu). */
export const ZOOM_STEPS = [
  0.02, 0.05, 0.1, 0.25, 0.33, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4, 6, 8, 12, 16, 32, 64,
] as const;

export function nextZoom(current: number, direction: 1 | -1): number {
  const eps = 1e-3;
  if (direction > 0) return ZOOM_STEPS.find((z) => z > current + eps) ?? current;
  return [...ZOOM_STEPS].reverse().find((z) => z < current - eps) ?? current;
}

function zoomTo(editor: EditorController, zoom: number): void {
  const { viewport } = editor.getState();
  editor.engine.zoomAt({ x: viewport.width / 2, y: viewport.height / 2 }, clampZoom(zoom));
}

async function zoomToSelection(editor: EditorController): Promise<void> {
  const design = editor.design;
  const ids = design ? selectedIds(editor, design) : [];
  if (!design || ids.length === 0) {
    editor.engine.fit();
    return;
  }
  const engineBounds = await editor.engine.bounds(ids);
  const rects = engineBounds.filter((r): r is NonNullable<typeof r> => r !== null);
  if (rects.length > 0) {
    const x = Math.min(...rects.map((r) => r.x));
    const y = Math.min(...rects.map((r) => r.y));
    const w = Math.max(...rects.map((r) => r.x + r.w)) - x;
    const h = Math.max(...rects.map((r) => r.y + r.h)) - y;
    editor.engine.fit({ x, y, w: Math.max(w, 1), h: Math.max(h, 1) }, 96);
    return;
  }
  const b = boundsOf(design, ids);
  if (b)
    editor.engine.fit({ x: b.x, y: b.y, w: Math.max(b.width, 1), h: Math.max(b.height, 1) }, 96);
}

const togglePanel =
  (key: "rulers" | "layoutGrid" | "snapping" | "focusMode") =>
  (_a: unknown, { editor }: { editor: EditorController }) =>
    editor.setPanels({ [key]: !editor.getState().panels[key] });

export function viewCommands(): AnyCommand[] {
  return [
    {
      id: "view.zoomIn",
      label: "Zoom in",
      category: "view",
      icon: ZoomIn,
      when: "engineReady",
      repeat: true,
      run: (_a, { editor }) => zoomTo(editor, nextZoom(editor.getState().viewport.zoom, 1)),
    },
    {
      id: "view.zoomOut",
      label: "Zoom out",
      category: "view",
      icon: ZoomOut,
      when: "engineReady",
      repeat: true,
      run: (_a, { editor }) => zoomTo(editor, nextZoom(editor.getState().viewport.zoom, -1)),
    },
    {
      id: "view.zoomTo",
      label: "Zoom to…",
      category: "view",
      hidden: true,
      when: "engineReady",
      run: (args: { zoom: number }, { editor }) => zoomTo(editor, args.zoom),
    },
    {
      id: "view.zoom100",
      label: "Zoom to 100%",
      category: "view",
      icon: Scan,
      when: "engineReady",
      run: (_a, { editor }) => zoomTo(editor, 1),
    },
    {
      id: "view.zoomFit",
      label: "Zoom to fit",
      category: "view",
      icon: Maximize,
      when: "engineReady",
      run: (_a, { editor }) => editor.engine.fit(),
    },
    {
      id: "view.zoomSelection",
      label: "Zoom to selection",
      category: "view",
      icon: ScanSearch,
      when: "engineReady",
      run: (_a, { editor }) => zoomToSelection(editor),
    },
    {
      id: "view.toggleRulers",
      label: "Rulers",
      category: "view",
      icon: Ruler,
      checked: (ctx) => ctx.rulers === true,
      run: togglePanel("rulers"),
    },
    {
      id: "view.toggleLayoutGrid",
      label: "Layout grid",
      category: "view",
      icon: Grid2x2,
      checked: (ctx) => ctx.layoutGrid === true,
      run: togglePanel("layoutGrid"),
    },
    {
      id: "view.toggleSnapping",
      label: "Snapping",
      category: "view",
      icon: Magnet,
      checked: (ctx) => ctx.snapping === true,
      run: togglePanel("snapping"),
    },
    {
      id: "view.toggleFocusMode",
      label: "Focus mode (hide interface)",
      category: "view",
      icon: SquareDashedMousePointer,
      checked: (ctx) => ctx.focusMode === true,
      allowInInput: false,
      run: togglePanel("focusMode"),
    },
  ];
}
