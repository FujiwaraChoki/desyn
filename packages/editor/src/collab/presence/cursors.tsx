"use client";

import { Button } from "@desyn/ui";
import { Eye, X } from "lucide-react";
import { useMemo } from "react";
import { useEditorStore } from "../../context.tsx";
import type { SlotProps } from "../../shell/extensions.ts";
import { useCollab, useCollabStore } from "../state.ts";
import { useCollaborators } from "./hooks.ts";
import { cursorsOnPage, editingMarkers, selectionsOnPage, toScreen } from "./reduce.ts";

/** Readable label text on a collaborator color (all presence colors are mid-bright). */
const INK = "#111111";

function CursorArrow({ color }: { color: string }) {
  return (
    <svg width="18" height="20" viewBox="0 0 18 20" aria-hidden="true" className="drop-shadow-sm">
      <path
        d="M1.5 1.5 L1.5 16.2 L5.6 12.4 L8.4 18.4 L11.2 17.1 L8.5 11.3 L14 11.1 Z"
        fill={color}
        stroke="#ffffff"
        strokeWidth="1.25"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * Collaborators on the canvas (`canvas.overlay`): live cursors with names, outlines of what others selected,
 * "typing" / "AI is editing" markers, and the follow-mode frame. Pointer-transparent except the stop button.
 */
export function PresenceOverlay(_props: SlotProps) {
  const { store } = useCollab();
  const collaborators = useCollaborators();
  const following = useCollabStore((s) => s.following);
  const pageId = useEditorStore((s) => s.pageId);
  const design = useEditorStore((s) => s.doc.design);
  const vx = useEditorStore((s) => s.viewport.x);
  const vy = useEditorStore((s) => s.viewport.y);
  const zoom = useEditorStore((s) => s.viewport.zoom);
  const ready = useEditorStore((s) => s.engine.status === "ready");

  const others = useMemo(() => collaborators.filter((c) => !c.isSelf), [collaborators]);
  // Own other tabs / devices are left out, like in the avatar stack.
  const cursors = useMemo(() => cursorsOnPage(others, pageId), [others, pageId]);
  const selections = useMemo(
    () => selectionsOnPage(others, design, pageId),
    [others, design, pageId],
  );
  const markers = useMemo(() => editingMarkers(others), [others]);
  const followed = following ? collaborators.find((c) => c.sessionId === following) : undefined;
  const view = { x: vx, y: vy, zoom };

  if (!ready) return null;
  return (
    <div
      className="pointer-events-none absolute inset-0 z-[4] overflow-hidden"
      aria-hidden={!followed}
    >
      {selections.map((sel) => {
        const tag = toScreen(view, { x: sel.bounds.x, y: sel.bounds.y });
        const marker = sel.rects.map((r) => markers.get(r.id)).find(Boolean);
        return (
          <div key={`sel-${sel.sessionId}`}>
            {sel.rects.map((r) => {
              const p = toScreen(view, r);
              return (
                <div
                  key={r.id}
                  className="absolute rounded-[2px]"
                  style={{
                    left: p.x,
                    top: p.y,
                    width: Math.max(1, r.width * zoom),
                    height: Math.max(1, r.height * zoom),
                    boxShadow: `0 0 0 1.5px ${sel.color}`,
                    background: `${sel.color}0f`,
                  }}
                />
              );
            })}
            <div
              className="absolute flex max-w-56 -translate-y-full items-center gap-1 truncate rounded-t-[4px] rounded-br-[4px] px-1.5 py-px text-[10px] font-medium leading-4"
              style={{ left: tag.x, top: tag.y - 2, background: sel.color, color: INK }}
            >
              {marker ? (
                <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-[#111]/70" />
              ) : null}
              <span className="truncate">{marker ? marker.label : sel.name}</span>
            </div>
          </div>
        );
      })}

      {cursors.map((c) => {
        const p = toScreen(view, c);
        return (
          <div
            key={`cur-${c.sessionId}`}
            className="absolute top-0 left-0 transition-transform duration-100 ease-linear will-change-transform motion-reduce:transition-none"
            style={{ transform: `translate3d(${p.x - 1.5}px, ${p.y - 1.5}px, 0)` }}
          >
            <CursorArrow color={c.color} />
            <span
              className="absolute top-[17px] left-[11px] max-w-40 truncate rounded-full px-2 py-0.5 text-[11px] font-medium leading-4 whitespace-nowrap shadow-sm"
              style={{ background: c.color, color: INK }}
            >
              {c.name}
              {c.editing?.kind === "text" ? " · typing" : ""}
            </span>
          </div>
        );
      })}

      {followed ? (
        <>
          <div
            className="absolute inset-0 rounded-[2px]"
            style={{ boxShadow: `inset 0 0 0 2px ${followed.color}` }}
          />
          <div
            data-canvas-chrome=""
            className="pointer-events-auto absolute top-3 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-full border border-line-subtle bg-surface-1/90 py-1 pr-1 pl-3 text-xs shadow-popover backdrop-blur-xl"
          >
            <Eye className="size-3.5" style={{ color: followed.color }} />
            <span className="text-fg-secondary">
              Following <span className="font-medium text-fg">{followed.name}</span>
            </span>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2"
              leadingIcon={<X />}
              onClick={() => store.setState({ following: null })}
            >
              Stop
            </Button>
          </div>
        </>
      ) : null}
    </div>
  );
}
