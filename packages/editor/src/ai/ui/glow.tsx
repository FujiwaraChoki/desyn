"use client";

import { approxBounds, pageOf, topLevelSelection, unionRects } from "@desyn/doc-ops";
import { useShallow } from "zustand/react/shallow";
import { useEditorStore } from "../../context.tsx";
import type { SlotProps } from "../../shell/extensions.ts";
import { useAiShallow } from "./hooks.ts";

const MAX_RECTS = 48;
const PAD = 3;

/**
 * Canvas overlay (`canvas.overlay` slot): layers the AI is changing glow with a soft pulsing sun outline; when
 * a run finishes, a "sunrise" sweeps across everything it touched. Geometry comes from the document (page
 * coordinates) mapped through the viewport, so the glow follows pans and zooms without engine round trips.
 */
export function AiGlow(_props: SlotProps) {
  const { ids, phase, seq } = useAiShallow((s) => s.highlight);
  const design = useEditorStore((s) => s.doc.design);
  const pageId = useEditorStore((s) => s.pageId);
  const view = useEditorStore(
    useShallow((s) => ({ x: s.viewport.x, y: s.viewport.y, zoom: s.viewport.zoom })),
  );
  if (!phase || !design || ids.length === 0 || !pageId) return null;
  const onPage = topLevelSelection(
    design,
    ids.filter(
      (id) =>
        design.nodes[id] && pageOf(design, id)?.id === pageId && design.nodes[id]?.type !== "page",
    ),
  ).slice(0, MAX_RECTS);
  const rects = onPage
    .map((id) => approxBounds(design, id))
    .filter((r): r is NonNullable<typeof r> => !!r)
    .map((r) => ({
      left: (r.x - view.x) * view.zoom - PAD,
      top: (r.y - view.y) * view.zoom - PAD,
      width: Math.max(2, r.width * view.zoom + PAD * 2),
      height: Math.max(2, r.height * view.zoom + PAD * 2),
    }));
  if (rects.length === 0) return null;
  const all = unionRects(
    rects.map((r) => ({ x: r.left, y: r.top, width: r.width, height: r.height })),
  ) as { x: number; y: number; width: number; height: number };
  return (
    <div
      className="pointer-events-none absolute inset-0 z-[4] overflow-hidden"
      aria-hidden
      data-ai-glow={phase}
    >
      {phase === "working"
        ? rects.map((r, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: rects are recomputed per frame from `ids`
            <div key={`${seq}-${i}`} className="dsn-ai-glow absolute" style={r} />
          ))
        : null}
      {phase === "sunrise" ? (
        <>
          {rects.map((r, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: as above
            <div key={`${seq}-ring-${i}`} className="dsn-ai-sunrise-ring absolute" style={r} />
          ))}
          <div
            key={`${seq}-sweep`}
            className="dsn-ai-sunrise absolute rounded-[10px]"
            style={{ left: all.x, top: all.y, width: all.width, height: all.height }}
          />
        </>
      ) : null}
    </div>
  );
}
