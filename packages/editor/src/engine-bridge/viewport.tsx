"use client";

import { wheelZoomFactor } from "@desyn/engine";
import { cn, useResolvedTheme } from "@desyn/ui";
import { useEffect, useRef } from "react";
import { useEditor } from "../context.tsx";

/**
 * The engine's drawing surface. Creates a fresh <canvas> per mount (a canvas can be transferred to a worker
 * only once, and React StrictMode mounts effects twice), attaches the engine bridge to it and handles
 * wheel / trackpad navigation: scroll pans, ctrl/cmd + scroll and pinch zoom about the pointer.
 *
 * Pointer interaction (selection, tools, handles) is the `canvas.interaction` slot layered above.
 */
export function EngineViewport({ className }: { className?: string }) {
  const editor = useEditor();
  const hostRef = useRef<HTMLDivElement>(null);
  const theme = useResolvedTheme();

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const canvas = document.createElement("canvas");
    canvas.className = "absolute inset-0 block size-full";
    canvas.setAttribute("aria-hidden", "true");
    host.appendChild(canvas);
    void editor.engine.attach(canvas, () => editor.design);
    return () => {
      editor.engine.detach();
      canvas.remove();
    };
  }, [editor]);

  useEffect(() => {
    editor.engine.setTheme(theme === "light" ? "light" : "dark");
  }, [editor, theme]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const onWheel = (e: WheelEvent) => {
      const client = editor.engineClient;
      if (!client) return;
      e.preventDefault();
      const rect = host.getBoundingClientRect();
      const p = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      if (e.ctrlKey || e.metaKey) {
        client.zoomAt(
          p,
          client.view.zoom * wheelZoomFactor(e.deltaY, e.deltaMode, e.ctrlKey && !e.metaKey),
        );
      } else {
        const k = e.deltaMode === 1 ? 16 : 1;
        client.panBy(-(e.shiftKey ? e.deltaY : e.deltaX) * k, -(e.shiftKey ? 0 : e.deltaY) * k);
      }
    };
    // Non-passive: the page must not scroll or browser-zoom while navigating the canvas.
    host.addEventListener("wheel", onWheel, { passive: false });
    return () => host.removeEventListener("wheel", onWheel);
  }, [editor]);

  return <div ref={hostRef} className={cn("absolute inset-0 overflow-hidden", className)} />;
}
