"use client";

import {
  Button,
  ContextMenu,
  ContextMenuContent,
  ContextMenuSeparator,
  ContextMenuTrigger,
  EmptyState,
  SunSpinner,
} from "@desyn/ui";
import { MonitorX } from "lucide-react";
import { type DragEvent, Fragment, type ReactNode, useState } from "react";
import { useEditor, useEditorStore, useRegistryVersion } from "../context.tsx";
import { EngineViewport } from "../engine-bridge/viewport.tsx";
import { CommandContextItem } from "./command-items.tsx";
import { availableIn, type ContextMenuEntry } from "./extensions.ts";

/** Context menu rows for the current target, with separators collapsed (no leading / doubled ones). */
function ContextMenuRows({ entries }: { entries: ContextMenuEntry[] }) {
  const editor = useEditor();
  const ctx = editor.context();
  const visible = entries.filter(
    (e) =>
      e.command === "-" ||
      (editor.commands.get(e.command) && editor.commands.isEnabled(e.command, ctx)),
  );
  const rows: ReactNode[] = [];
  let pendingSeparator = false;
  visible.forEach((e, i) => {
    if (e.command === "-") {
      pendingSeparator = rows.length > 0;
      return;
    }
    if (pendingSeparator) {
      // biome-ignore lint/suspicious/noArrayIndexKey: separators have no identity of their own
      rows.push(<ContextMenuSeparator key={`sep-${i}`} />);
      pendingSeparator = false;
    }
    rows.push(<CommandContextItem key={`${e.command}-${e.order}`} id={e.command} args={e.args} />);
  });
  return <>{rows}</>;
}

function EngineStatus() {
  const status = useEditorStore((s) => s.engine.status);
  const painted = useEditorStore((s) => s.engine.painted);
  const message = useEditorStore((s) => s.engine.message);
  if (status === "unsupported" || status === "failed") {
    return (
      <div className="absolute inset-0 z-[5] grid place-items-center bg-canvas">
        <EmptyState
          icon={<MonitorX />}
          title={
            status === "unsupported" ? (
              <>
                this browser can't <em className="text-accent">render</em> designs
              </>
            ) : (
              <>
                the canvas <em className="text-accent">stopped</em>
              </>
            )
          }
          description={
            status === "unsupported"
              ? "Desyn needs WebAssembly SIMD and OffscreenCanvas. Use a current version of Chrome, Edge, Firefox or Safari."
              : `The rendering engine failed${message ? ` (${message})` : ""}. Your changes are saved; reload to continue.`
          }
          action={
            status === "failed" ? (
              <Button variant="secondary" onClick={() => window.location.reload()}>
                Reload editor
              </Button>
            ) : undefined
          }
        />
      </div>
    );
  }
  if (painted) return null;
  return (
    <div
      className="pointer-events-none absolute inset-0 z-[5] grid place-items-center"
      aria-live="polite"
    >
      <div className="flex flex-col items-center gap-3 text-fg-muted">
        <SunSpinner size="lg" label="Rendering the design" />
      </div>
    </div>
  );
}

/**
 * Center canvas: the engine viewport, the interaction layer (slot), overlays (slots), the floating context
 * toolbar (slot), engine status, the canvas context menu and file drops (images / SVG are uploaded and placed).
 */
export function CanvasArea({ children }: { children?: ReactNode }) {
  const editor = useEditor();
  useRegistryVersion();
  const mode = useEditorStore((s) => s.mode);
  const hasSelection = useEditorStore((s) => s.selection.length > 0);
  const pageName = useEditorStore((s) =>
    s.pageId ? (s.doc.design?.nodes[s.pageId]?.name ?? "") : "",
  );
  const [dragOver, setDragOver] = useState(false);
  const interaction = editor.extensions.slot("canvas.interaction");
  const toolbar = editor.extensions.slot("canvas.toolbar");
  const overlays = editor.extensions.slots("canvas.overlay").filter((o) => availableIn(o, mode));
  const target = hasSelection ? "selection" : "canvas";
  const entries = editor.extensions.contextMenu.filter(
    (e) => e.target === target || e.target === "both",
  );

  const acceptsFiles = (e: DragEvent) =>
    mode === "edit" && [...e.dataTransfer.types].includes("Files");
  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    if (!acceptsFiles(e)) return;
    e.preventDefault();
    setDragOver(false);
    const files = [...e.dataTransfer.files];
    const rect = e.currentTarget.getBoundingClientRect();
    const client = editor.engineClient;
    const at = client
      ? client.screenToPage({ x: e.clientX - rect.left, y: e.clientY - rect.top })
      : undefined;
    void editor.clipboard.insertFiles(files, at);
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        {/* biome-ignore lint/a11y/useSemanticElements: the canvas is an application region, not a document section */}
        <div
          data-editor-canvas=""
          role="region"
          aria-label={pageName ? `Canvas, ${pageName}` : "Canvas"}
          tabIndex={-1}
          className="relative min-h-0 min-w-0 flex-1 overflow-hidden bg-canvas outline-none"
          onDragOver={(e) => {
            if (!acceptsFiles(e)) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = "copy";
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
        >
          <EngineViewport />
          {interaction ? <interaction.component editor={editor} /> : null}
          {overlays.map(({ id, component: C }) => (
            <Fragment key={id}>
              <C editor={editor} />
            </Fragment>
          ))}
          {toolbar ? <toolbar.component editor={editor} /> : null}
          <EngineStatus />
          {dragOver ? (
            <div className="pointer-events-none absolute inset-3 z-[6] grid place-items-center rounded-panel border-2 border-dashed border-accent/70 bg-accent/8">
              <span className="rounded-full bg-surface-1/90 px-4 py-2 text-sm text-fg shadow-popover">
                Drop images to place them
              </span>
            </div>
          ) : null}
          {children}
        </div>
      </ContextMenuTrigger>
      {entries.length > 0 ? (
        <ContextMenuContent className="w-60">
          <ContextMenuRows entries={entries} />
        </ContextMenuContent>
      ) : null}
    </ContextMenu>
  );
}
