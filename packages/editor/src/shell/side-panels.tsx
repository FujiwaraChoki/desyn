"use client";

import { cn, IconButton, Tabs, TabsContent, TabsList, TabsTrigger, Tooltip } from "@desyn/ui";
import { X } from "lucide-react";
import { useCommand, useEditor, useEditorStore, useRegistryVersion } from "../context.tsx";
import { DEFAULT_PANELS } from "../store/editor-store.ts";
import { availableIn, type InspectorTab, type RailPanel } from "./extensions.ts";
import { ResizeHandle } from "./resize-handle.tsx";

export const LEFT_WIDTH = { min: 260, max: 520 } as const;
export const INSPECTOR_WIDTH = { min: 240, max: 420 } as const;

/** Rail panels available in the current mode / context. */
export function useRailPanels(): RailPanel[] {
  const editor = useEditor();
  useRegistryVersion();
  const mode = useEditorStore((s) => s.mode);
  useEditorStore((s) => s.selection);
  const ctx = editor.context();
  return editor.extensions.railPanels.filter(
    (p) => availableIn(p, mode) && (!p.when || p.when(ctx)),
  );
}

/** Inspector tabs available in the current mode / context. */
export function useInspectorTabs(): InspectorTab[] {
  const editor = useEditor();
  useRegistryVersion();
  const mode = useEditorStore((s) => s.mode);
  // Tabs may depend on the selection (e.g. "Animate" needs one).
  useEditorStore((s) => s.selection);
  const ctx = editor.context();
  return editor.extensions.inspectorTabs.filter(
    (t) => availableIn(t, mode) && (!t.when || t.when(ctx)),
  );
}

function RailButton({ panel, active }: { panel: RailPanel; active: boolean }) {
  const editor = useEditor();
  const { shortcut } = useCommand(`panel.${panel.id}`);
  const Icon = panel.icon;
  return (
    <Tooltip content={panel.label} side="right" {...(shortcut ? { shortcut } : {})}>
      <button
        type="button"
        aria-pressed={active}
        aria-controls="editor-flyout"
        onClick={() => editor.toggleLeftPanel(panel.id)}
        className="group flex w-14 cursor-pointer flex-col items-center gap-1 rounded-[10px] py-1.5 text-[10px] leading-none text-fg-muted transition-colors duration-200 hover:text-fg focus-visible:outline-2 focus-visible:outline-ring aria-pressed:text-fg"
      >
        <span className="grid size-8 place-items-center rounded-[9px] transition-[background-color,color,box-shadow] duration-200 group-hover:bg-fg/6 group-aria-pressed:bg-fg/8 group-aria-pressed:text-accent [&_svg]:size-[18px] [&_svg]:stroke-[1.5]">
          <Icon />
        </span>
        <span className="max-w-full truncate px-0.5">{panel.label}</span>
      </button>
    </Tooltip>
  );
}

/** Left rail (Design, Elements, Text, Brand, Uploads, Photos, AI, Layers, Pages). */
export function Rail({ panels }: { panels: RailPanel[] }) {
  const open = useEditorStore((s) => s.panels.left);
  if (panels.length === 0) return null;
  return (
    <nav
      aria-label="Panels"
      className="flex w-[68px] shrink-0 flex-col items-center gap-0.5 overflow-y-auto border-r border-line-subtle bg-surface-1 py-2"
    >
      {panels.map((p) => (
        <RailButton key={p.id} panel={p} active={open === p.id} />
      ))}
    </nav>
  );
}

/** Body of a rail panel (header + component); also used inside the compact sheet. */
export function FlyoutBody({ panel, onClose }: { panel: RailPanel; onClose?: () => void }) {
  const editor = useEditor();
  const C = panel.component;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-11 shrink-0 items-center justify-between gap-2 pr-1.5 pl-4">
        <h2 className="truncate font-serif text-[20px] leading-none text-fg">{panel.label}</h2>
        {onClose ? (
          <IconButton label={`Close ${panel.label}`} size="xs" variant="ghost" onClick={onClose}>
            <X />
          </IconButton>
        ) : null}
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        <C editor={editor} />
      </div>
    </div>
  );
}

/**
 * The 320 px flyout next to the rail. It pushes the canvas on wide windows and floats over it (glass) on
 * narrower ones so the design keeps its space.
 */
export function Flyout({ panels, overlay }: { panels: RailPanel[]; overlay: boolean }) {
  const editor = useEditor();
  const open = useEditorStore((s) => s.panels.left);
  const width = useEditorStore((s) => s.panels.leftWidth);
  const panel = panels.find((p) => p.id === open);
  if (!panel) return null;
  return (
    <>
      <section
        id="editor-flyout"
        aria-label={panel.label}
        style={{ width }}
        className={cn(
          "flex min-h-0 shrink-0 flex-col bg-surface-1",
          overlay
            ? "absolute inset-y-0 left-[68px] z-[15] border-r border-line-subtle shadow-dialog"
            : "relative",
        )}
      >
        <FlyoutBody panel={panel} onClose={() => editor.setPanels({ left: null })} />
      </section>
      <div
        className={cn(overlay && "absolute inset-y-0 z-[16]")}
        style={overlay ? { left: 68 + width } : undefined}
      >
        <ResizeHandle
          label={`Resize ${panel.label} panel`}
          controls="editor-flyout"
          side="left"
          value={width}
          min={LEFT_WIDTH.min}
          max={LEFT_WIDTH.max}
          defaultValue={DEFAULT_PANELS.leftWidth}
          onChange={(v) => editor.setPanels({ leftWidth: v })}
        />
      </div>
    </>
  );
}

/** Inspector tabs and their content (sidebar and compact sheet). */
export function InspectorBody({ tabs }: { tabs: InspectorTab[] }) {
  const editor = useEditor();
  const stored = useEditorStore((s) => s.panels.inspectorTab);
  const active = tabs.find((t) => t.id === stored)?.id ?? tabs[0]?.id;
  if (!active) return null;
  return (
    <Tabs
      value={active}
      onValueChange={(v) => editor.setPanels({ inspectorTab: v })}
      className="flex h-full min-h-0 flex-col gap-0"
    >
      <TabsList className="shrink-0 overflow-x-auto px-3">
        {tabs.map((t) => (
          <TabsTrigger key={t.id} value={t.id}>
            {t.label}
          </TabsTrigger>
        ))}
      </TabsList>
      {tabs.map(({ id, component: C }) => (
        <TabsContent key={id} value={id} className="min-h-0 flex-1 overflow-y-auto">
          <C editor={editor} />
        </TabsContent>
      ))}
    </Tabs>
  );
}

/** Right inspector (Design, Arrange, Effects, Animate, Position...), resizable. */
export function Inspector({ tabs }: { tabs: InspectorTab[] }) {
  const editor = useEditor();
  const open = useEditorStore((s) => s.panels.inspectorOpen);
  const width = useEditorStore((s) => s.panels.inspectorWidth);
  if (!open || tabs.length === 0) return null;
  return (
    <>
      <ResizeHandle
        label="Resize inspector"
        controls="editor-inspector"
        side="right"
        value={width}
        min={INSPECTOR_WIDTH.min}
        max={INSPECTOR_WIDTH.max}
        defaultValue={DEFAULT_PANELS.inspectorWidth}
        onChange={(v) => editor.setPanels({ inspectorWidth: v })}
      />
      <aside
        id="editor-inspector"
        aria-label="Inspector"
        style={{ width }}
        className="flex min-h-0 shrink-0 flex-col bg-surface-1"
      >
        <InspectorBody tabs={tabs} />
      </aside>
    </>
  );
}
