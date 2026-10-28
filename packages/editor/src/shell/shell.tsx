"use client";

import { Button, cn, Sheet, SheetContent, SheetTitle, VisuallyHidden } from "@desyn/ui";
import { Minimize2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useEditor, useEditorStore, useRegistryVersion } from "../context.tsx";
import { installShortcuts } from "../shortcuts/dispatcher.ts";
import { CanvasArea } from "./canvas-area.tsx";
import { EditorCommandPalette } from "./command-palette.tsx";
import { availableIn } from "./extensions.ts";
import { describeLoadError, ErrorScreen, LoadingScreen } from "./screens.tsx";
import {
  Flyout,
  FlyoutBody,
  Inspector,
  InspectorBody,
  Rail,
  useInspectorTabs,
  useRailPanels,
} from "./side-panels.tsx";
import { ToolDock } from "./tool-dock.tsx";
import { TopBar } from "./top-bar.tsx";

/** Below this width panels become sheets (phones, split screens). */
const COMPACT_QUERY = "(max-width: 767px)";
/** Below this width the flyout floats over the canvas instead of pushing it. */
const NARROW_QUERY = "(max-width: 1199px)";

function useMedia(query: string): boolean {
  const [matches, setMatches] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(query);
    setMatches(mq.matches);
    const on = () => setMatches(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [query]);
  return matches;
}

/** Renders the open modal registered by an extension (or the shell's own). */
function ModalHost() {
  const editor = useEditor();
  useRegistryVersion();
  const modal = useEditorStore((s) => s.modal);
  const def = modal ? editor.extensions.modals.get(modal.id) : undefined;
  if (!modal || !def) return null;
  const C = def.component;
  return <C editor={editor} props={modal.props ?? {}} close={() => editor.closeModal()} />;
}

/** Invisible extension controllers (presence heartbeats, AI run followers...). */
function RootSlots() {
  const editor = useEditor();
  useRegistryVersion();
  const mode = useEditorStore((s) => s.mode);
  return (
    <>
      {editor.extensions
        .slots("root")
        .filter((s) => availableIn(s, mode))
        .map(({ id, component: C }) => (
          <C key={id} editor={editor} />
        ))}
    </>
  );
}

function CompactPanels({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const editor = useEditor();
  const panels = useRailPanels();
  const current = useEditorStore((s) => s.panels.left);
  const panel = panels.find((p) => p.id === current) ?? panels[0];
  if (!panel) return null;
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="left" className="flex flex-col p-0" showClose={false}>
        <VisuallyHidden>
          <SheetTitle>Panels</SheetTitle>
        </VisuallyHidden>
        <div
          className="flex shrink-0 gap-1 overflow-x-auto border-b border-line-subtle p-2"
          role="tablist"
        >
          {panels.map((p) => {
            const Icon = p.icon;
            return (
              <button
                key={p.id}
                type="button"
                role="tab"
                aria-selected={p.id === panel.id}
                onClick={() => editor.setPanels({ left: p.id })}
                className="flex min-h-11 shrink-0 flex-col items-center justify-center gap-0.5 rounded-[10px] px-2.5 text-[10px] text-fg-muted aria-selected:bg-fg/8 aria-selected:text-accent [&_svg]:size-4"
              >
                <Icon />
                {p.label}
              </button>
            );
          })}
        </div>
        <div className="min-h-0 flex-1">
          <FlyoutBody panel={panel} onClose={() => onOpenChange(false)} />
        </div>
      </SheetContent>
    </Sheet>
  );
}

function CompactInspector({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const tabs = useInspectorTabs();
  if (tabs.length === 0) return null;
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="flex h-[72dvh] flex-col p-0">
        <VisuallyHidden>
          <SheetTitle>Inspector</SheetTitle>
        </VisuallyHidden>
        <div className="min-h-0 flex-1 pt-2">
          <InspectorBody tabs={tabs} />
        </div>
      </SheetContent>
    </Sheet>
  );
}

/**
 * Editor layout (DESIGN_SYSTEM §6): top bar / left rail + 320 px flyout / center canvas with the floating
 * tool dock and AI dock / bottom pages strip / right inspector. Panels resize and remember their state per
 * user; below 768 px they become sheets; focus mode hides everything but the canvas.
 */
export function Shell() {
  const editor = useEditor();
  useRegistryVersion();
  const design = useEditorStore((s) => s.doc.design);
  const error = useEditorStore((s) => s.doc.sync.error);
  const exitHref = useEditorStore((s) => s.exitHref);
  const shareToken = useEditorStore((s) => s.shareToken);
  const designId = useEditorStore((s) => s.designId);
  const mode = useEditorStore((s) => s.mode);
  const focus = useEditorStore((s) => s.panels.focusMode);
  const pagesOpen = useEditorStore((s) => s.panels.pagesOpen);
  const compact = useMedia(COMPACT_QUERY);
  const narrow = useMedia(NARROW_QUERY);
  const panels = useRailPanels();
  const tabs = useInspectorTabs();
  const [panelsSheet, setPanelsSheet] = useState(false);
  const [inspectorSheet, setInspectorSheet] = useState(false);

  useEffect(() => installShortcuts(editor), [editor]);
  useEffect(() => {
    editor.store.setState({ compact });
  }, [editor, compact]);

  if (!design) {
    if (error)
      return <ErrorScreen info={describeLoadError(error, { exitHref, shareToken, designId })} />;
    return <LoadingScreen />;
  }

  const pages = editor.extensions.slot("pages");
  const aiDock = editor.extensions.slot("ai.dock");
  const showChrome = !focus;

  return (
    <div
      data-editor-root=""
      data-mode={mode}
      className="flex h-dvh w-full flex-col overflow-hidden bg-background text-fg"
    >
      {showChrome ? (
        <TopBar
          onOpenPanels={() => setPanelsSheet(true)}
          onOpenInspector={() => setInspectorSheet(true)}
        />
      ) : null}
      <div className="relative flex min-h-0 flex-1">
        {showChrome && !compact ? <Rail panels={panels} /> : null}
        {showChrome && !compact ? <Flyout panels={panels} overlay={narrow} /> : null}
        <main className="relative flex min-w-0 flex-1 flex-col" aria-label="Design canvas">
          <CanvasArea>
            <div
              className={cn(
                "pointer-events-none absolute inset-x-0 bottom-4 z-10 flex flex-col items-center gap-3 px-3",
                compact && "bottom-3",
              )}
            >
              {aiDock && availableIn(aiDock, mode) ? <aiDock.component editor={editor} /> : null}
              {showChrome ? <ToolDock /> : null}
            </div>
            {focus ? (
              <Button
                variant="secondary"
                size="sm"
                leadingIcon={<Minimize2 />}
                className="absolute top-3 right-3 z-10 shadow-popover"
                onClick={() => editor.setPanels({ focusMode: false })}
              >
                Show interface
              </Button>
            ) : null}
          </CanvasArea>
          {showChrome && pagesOpen && pages && availableIn(pages, mode) ? (
            <div className="relative z-[11] shrink-0 border-t border-line-subtle bg-surface-1">
              <pages.component editor={editor} />
            </div>
          ) : null}
        </main>
        {showChrome && !compact ? <Inspector tabs={tabs} /> : null}
      </div>
      {compact ? (
        <>
          <CompactPanels open={panelsSheet} onOpenChange={setPanelsSheet} />
          <CompactInspector open={inspectorSheet} onOpenChange={setInspectorSheet} />
        </>
      ) : null}
      <ModalHost />
      <EditorCommandPalette />
      <RootSlots />
    </div>
  );
}
