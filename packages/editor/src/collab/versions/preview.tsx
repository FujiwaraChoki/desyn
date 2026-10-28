"use client";

import { pages as pagesOf } from "@desyn/doc-ops";
import { EngineClient, wheelZoomFactor } from "@desyn/engine";
import { Button, IconButton, SunSpinner, useResolvedTheme } from "@desyn/ui";
import { ChevronLeft, ChevronRight, Eye, RotateCcw, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useEditor, useEditorStore } from "../../context.tsx";
import { PASTEBOARD } from "../../engine-bridge/bridge.ts";
import type { SlotProps } from "../../shell/extensions.ts";
import { useCollab, useCollabStore } from "../state.ts";
import { useVersionPreview } from "./preview-state.ts";

/**
 * Read-only preview of a saved version on the canvas (`canvas.overlay`): a second engine draws the version
 * over the live canvas with its own pan / zoom and page switcher; "Restore" and "Back to current" end it.
 */
export function VersionPreviewOverlay(_props: SlotProps) {
  const preview = useCollabStore((s) => s.versionPreview);
  if (!preview) return null;
  return <PreviewStage key={preview.versionId} />;
}

function PreviewStage() {
  const editor = useEditor();
  const { store } = useCollab();
  const preview = useCollabStore((s) => s.versionPreview);
  const canEdit = useEditorStore((s) => s.mode === "edit");
  const currentPage = useEditorStore((s) => s.pageId);
  const theme = useResolvedTheme();
  const host = useRef<HTMLDivElement>(null);
  const client = useRef<EngineClient | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");
  const [message, setMessage] = useState<string | null>(null);
  const { restore } = useVersionPreview();
  const design = preview?.design ?? null;
  const pageList = design ? pagesOf(design) : [];
  const [pageId, setPageId] = useState<string | null>(() => {
    if (!design) return null;
    const ids = pagesOf(design).map((p) => p.id);
    return currentPage && ids.includes(currentPage) ? currentPage : (ids[0] ?? null);
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: one engine per previewed version (keyed component)
  useEffect(() => {
    const el = host.current;
    if (!el || !design) return;
    const canvas = document.createElement("canvas");
    canvas.className = "absolute inset-0 block size-full";
    canvas.setAttribute("aria-hidden", "true");
    el.appendChild(canvas);
    let disposed = false;
    void (async () => {
      try {
        const c = await EngineClient.create({
          canvas,
          render: {
            background: PASTEBOARD[theme === "light" ? "light" : "dark"],
            pageShadow: true,
            budgetMs: 10,
          },
          resolveAsset: (asset) => editor.assets.urlFor(asset),
        });
        if (disposed) {
          c.dispose();
          return;
        }
        client.current = c;
        await c.load(design);
        if (pageId) {
          c.setRenderOptions({ pageId });
          c.fit(pageId, 64);
        }
        setState("ready");
      } catch (e) {
        if (disposed) return;
        setMessage(e instanceof Error ? e.message : String(e));
        setState("failed");
      }
    })();
    return () => {
      disposed = true;
      client.current?.dispose();
      client.current = null;
      canvas.remove();
    };
  }, []);

  useEffect(() => {
    client.current?.setRenderOptions({
      background: PASTEBOARD[theme === "light" ? "light" : "dark"],
    });
  }, [theme]);

  useEffect(() => {
    const c = client.current;
    if (!c || !pageId || state !== "ready") return;
    c.setRenderOptions({ pageId });
    c.fit(pageId, 64);
  }, [pageId, state]);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const c = client.current;
      if (!c) return;
      e.preventDefault();
      e.stopPropagation();
      const r = el.getBoundingClientRect();
      const p = { x: e.clientX - r.left, y: e.clientY - r.top };
      if (e.ctrlKey || e.metaKey) {
        c.zoomAt(p, c.view.zoom * wheelZoomFactor(e.deltaY, e.deltaMode, e.ctrlKey && !e.metaKey));
      } else {
        const k = e.deltaMode === 1 ? 16 : 1;
        c.panBy(-(e.shiftKey ? e.deltaY : e.deltaX) * k, -(e.shiftKey ? 0 : e.deltaY) * k);
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // Drag to pan (the preview is read-only, so every drag pans).
  const drag = useRef<{ x: number; y: number } | null>(null);

  if (!preview || !design) return null;
  const index = pageList.findIndex((p) => p.id === pageId);
  const page = pageList[index];
  const close = () => store.setState({ versionPreview: null });
  const when = new Date(preview.createdAt).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  return (
    <section
      data-canvas-chrome=""
      className="absolute inset-0 z-[9] bg-canvas"
      aria-label={`Preview of ${preview.name}`}
    >
      <div
        ref={host}
        className="absolute inset-0 cursor-grab overflow-hidden active:cursor-grabbing"
        onPointerDown={(e) => {
          drag.current = { x: e.clientX, y: e.clientY };
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d) return;
          client.current?.panBy(e.clientX - d.x, e.clientY - d.y);
          drag.current = { x: e.clientX, y: e.clientY };
        }}
        onPointerUp={() => {
          drag.current = null;
        }}
      />
      {state !== "ready" ? (
        <div className="absolute inset-0 grid place-items-center">
          {state === "loading" ? (
            <SunSpinner size="lg" label="Opening the version" />
          ) : (
            <p className="max-w-sm text-center text-sm text-fg-muted">
              The version couldn't be drawn{message ? ` (${message})` : ""}.
            </p>
          )}
        </div>
      ) : null}
      <div className="pointer-events-none absolute inset-x-0 top-3 flex justify-center px-3">
        <div className="pointer-events-auto flex max-w-full items-center gap-3 rounded-full border border-line-subtle bg-surface-1/90 py-1.5 pr-1.5 pl-4 shadow-popover backdrop-blur-xl">
          <Eye className="size-4 shrink-0 text-accent" />
          <div className="min-w-0">
            <p className="truncate text-[13px] font-medium text-fg">{preview.name}</p>
            <p className="truncate text-[11px] text-fg-muted">{when} · read-only preview</p>
          </div>
          {canEdit ? (
            <Button
              size="sm"
              variant="primary"
              leadingIcon={<RotateCcw />}
              onClick={() => void restore({ id: preview.versionId, name: preview.name })}
            >
              Restore
            </Button>
          ) : null}
          <Button size="sm" variant="secondary" leadingIcon={<X />} onClick={close}>
            Back to current
          </Button>
        </div>
      </div>
      {pageList.length > 1 ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-4 flex justify-center">
          <div className="pointer-events-auto flex items-center gap-1 rounded-full border border-line-subtle bg-surface-1/90 p-1 shadow-popover backdrop-blur-xl">
            <IconButton
              label="Previous page"
              size="sm"
              variant="ghost"
              disabled={index <= 0}
              onClick={() => setPageId(pageList[index - 1]?.id ?? pageId)}
            >
              <ChevronLeft />
            </IconButton>
            <span className="min-w-28 truncate px-1 text-center text-xs text-fg-secondary tabular-nums">
              {page?.name || "Page"} · {index + 1} / {pageList.length}
            </span>
            <IconButton
              label="Next page"
              size="sm"
              variant="ghost"
              disabled={index >= pageList.length - 1}
              onClick={() => setPageId(pageList[index + 1]?.id ?? pageId)}
            >
              <ChevronRight />
            </IconButton>
          </div>
        </div>
      ) : null}
    </section>
  );
}
