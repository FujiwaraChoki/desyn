"use client";

import { useResolvedTheme } from "@desyn/ui";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useEditorStore } from "../context.tsx";
import type { SlotProps } from "../shell/extensions.ts";
import { ALL_TOOLS } from "../tools/index.ts";
import { CommentComposer } from "./comment-composer.tsx";
import { CanvasController } from "./controller.ts";
import { installDrop } from "./drop.ts";
import { registerCanvasController } from "./registry.ts";
import { guideInterceptor, Rulers } from "./rulers.tsx";
import { TextToolbar } from "./text/text-toolbar.tsx";
import { SmoothViewAnimator } from "./view-animation.ts";

/**
 * The `canvas.interaction` slot: an absolutely positioned layer over the engine canvas that owns pointer,
 * wheel, touch and keyboard interaction, draws the interaction overlay on a 2D canvas, hosts DOM overlays (text
 * editing input, text toolbar, comment composer, drop hint) and the rulers.
 */
export function CanvasInteraction({ editor }: SlotProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const domRef = useRef<HTMLDivElement>(null);
  const [controller, setController] = useState<CanvasController | null>(null);
  const theme = useResolvedTheme();
  const rulers = useEditorStore((s) => s.panels.rulers);
  const mode = useEditorStore((s) => s.mode);

  useEffect(() => {
    const root = rootRef.current;
    const overlay = overlayRef.current;
    const dom = domRef.current;
    if (!root || !overlay || !dom) return;
    const c = new CanvasController(editor, root, overlay, dom, ALL_TOOLS);
    const animator = new SmoothViewAnimator();
    c.viewAnimator = animator;
    const offAnimator = editor.engine.setViewAnimator(animator);
    const offDrop = installDrop(c);
    const offGuides = c.addInterceptor(guideInterceptor());
    setController(c);
    registerCanvasController(editor, c);
    return () => {
      registerCanvasController(editor, null);
      offGuides();
      offDrop();
      offAnimator();
      animator.stop();
      c.dispose();
      setController(null);
    };
  }, [editor]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: the theme is the trigger, the colors are read from the DOM
  useEffect(() => {
    // Token colors change with the theme: re-read them on the next frame (after the class switch).
    const id = requestAnimationFrame(() => controller?.refreshTheme());
    return () => cancelAnimationFrame(id);
  }, [controller, theme]);

  return (
    <div
      ref={rootRef}
      data-canvas-interaction=""
      data-mode={mode}
      className="absolute inset-0 z-[2] touch-none select-none overflow-hidden outline-none"
    >
      <canvas ref={overlayRef} className="pointer-events-none absolute inset-0 block size-full" />
      <div ref={domRef} className="pointer-events-none absolute inset-0" />
      {controller ? (
        <>
          {rulers ? <Rulers controller={controller} /> : null}
          <TextToolbar controller={controller} />
          <CommentComposer controller={controller} />
          <DropHint controller={controller} />
        </>
      ) : null}
    </div>
  );
}

function DropHint({ controller }: { controller: CanvasController }) {
  const ui = useSyncExternalStore(controller.subscribeUi, controller.getUi, controller.getUi);
  if (!ui.drop) return null;
  return (
    <div className="pointer-events-none absolute inset-3 z-[5] grid place-items-center rounded-panel border-2 border-dashed border-accent/60 bg-accent/5">
      <span className="rounded-full border border-line-subtle bg-glass px-4 py-2 text-sm text-fg shadow-popover backdrop-blur-[20px]">
        {ui.drop.label}
      </span>
    </div>
  );
}
