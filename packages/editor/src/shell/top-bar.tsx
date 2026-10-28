"use client";

import {
  Badge,
  Button,
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
  IconButton,
  SunMark,
  Tooltip,
} from "@desyn/ui";
import {
  ChevronDown,
  Download,
  Eye,
  LayoutPanelLeft,
  MessageCircle,
  PanelRight,
  Share2,
} from "lucide-react";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { ZOOM_STEPS } from "../commands/view.ts";
import { useCommand, useEditor, useEditorStore, useRegistryVersion } from "../context.tsx";
import { CommandButton, CommandMenuItem } from "./command-items.tsx";
import { availableIn } from "./extensions.ts";
import { SyncStatus } from "./sync-status.tsx";

const MENUS: { label: string; items: string[] }[] = [
  {
    label: "File",
    items: [
      "file.rename",
      "file.copyLink",
      "-",
      "file.saveVersion",
      "panel.versions",
      "-",
      "file.export",
      "file.downloadPng",
      "file.present",
    ],
  },
  {
    label: "Edit",
    items: [
      "history.undo",
      "history.redo",
      "-",
      "edit.cut",
      "edit.copy",
      "edit.paste",
      "edit.pasteInPlace",
      "edit.copyAsPng",
      "-",
      "edit.duplicate",
      "edit.delete",
      "-",
      "selection.selectAll",
      "selection.matching",
      "-",
      "edit.copyStyle",
      "edit.pasteStyle",
    ],
  },
  {
    label: "View",
    items: [
      "view.zoomIn",
      "view.zoomOut",
      "view.zoom100",
      "view.zoomFit",
      "view.zoomSelection",
      "-",
      "view.toggleRulers",
      "view.toggleLayoutGrid",
      "view.toggleSnapping",
      "view.toggleFocusMode",
      "-",
      "panel.toggleInspector",
      "panel.togglePages",
    ],
  },
  {
    label: "Arrange",
    items: [
      "arrange.bringToFront",
      "arrange.bringForward",
      "arrange.sendBackward",
      "arrange.sendToBack",
      "-",
      "arrange.alignLeft",
      "arrange.alignCenter",
      "arrange.alignRight",
      "arrange.alignTop",
      "arrange.alignMiddle",
      "arrange.alignBottom",
      "arrange.distributeHorizontal",
      "arrange.distributeVertical",
      "arrange.tidy",
      "-",
      "edit.group",
      "edit.ungroup",
      "edit.frameSelection",
      "edit.autoLayout",
      "edit.useAsMask",
      "-",
      "edit.flipHorizontal",
      "edit.flipVertical",
      "edit.toggleLock",
      "edit.toggleVisibility",
    ],
  },
  {
    label: "Page",
    items: [
      "page.add",
      "page.duplicate",
      "page.delete",
      "-",
      "page.moveUp",
      "page.moveDown",
      "-",
      "page.previous",
      "page.next",
    ],
  },
  { label: "Help", items: ["help.shortcuts"] },
];

function MenuItems({ items }: { items: string[] }) {
  return (
    <>
      {items.map((id, i) =>
        id === "-" ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: separators have no identity of their own
          <DropdownMenuSeparator key={`sep-${i}`} />
        ) : (
          <CommandMenuItem key={id} id={id} />
        ),
      )}
    </>
  );
}

/** Sun mark: the app menu (File / Edit / View / Arrange / Page / Help) and the way back. */
function AppMenu() {
  const editor = useEditor();
  const palette = useCommand("help.commandPalette");
  return (
    <DropdownMenu>
      <Tooltip content="Menu">
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label="Main menu"
            className="group flex h-8 items-center gap-1 rounded-[8px] px-1.5 text-fg-muted transition-colors hover:bg-fg/6 hover:text-fg focus-visible:outline-2 focus-visible:outline-ring data-[state=open]:bg-fg/8"
          >
            <SunMark size={18} />
            <ChevronDown className="size-3 transition-transform group-data-[state=open]:rotate-180" />
          </button>
        </DropdownMenuTrigger>
      </Tooltip>
      <DropdownMenuContent align="start" className="w-60">
        <DropdownMenuItem onSelect={() => editor.navigate(editor.getState().exitHref)}>
          Back to designs
        </DropdownMenuItem>
        <DropdownMenuItem
          {...(palette.shortcut ? { shortcut: palette.shortcut } : {})}
          onSelect={() => void palette.run()}
        >
          Search commands…
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {MENUS.map((m) => (
          <DropdownMenuSub key={m.label}>
            <DropdownMenuSubTrigger>{m.label}</DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-64">
              <MenuItems items={m.items} />
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Design name; click to rename (edit mode), Enter / blur saves, Escape cancels. */
function DesignTitle() {
  const editor = useEditor();
  const name = useEditorStore((s) => s.doc.design?.name ?? s.doc.sync.header?.name ?? "");
  const canEdit = useEditorStore((s) => s.mode === "edit");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const input = useRef<HTMLInputElement>(null);
  const open = useRef(false);

  useEffect(() => {
    const start = () => {
      if (!editor.canEdit) return;
      setDraft(editor.design?.name ?? "");
      setEditing(true);
    };
    window.addEventListener("desyn:rename-design", start);
    return () => window.removeEventListener("desyn:rename-design", start);
  }, [editor]);

  useEffect(() => {
    open.current = editing;
    if (editing) input.current?.select();
  }, [editing]);

  const commit = () => {
    // Enter commits and unmounts the input, which can fire blur as well: save once.
    if (!open.current) return;
    open.current = false;
    setEditing(false);
    const next = draft.trim().slice(0, 200);
    if (!next || next === name) return;
    void editor.apply([{ op: "doc", set: { name: next } }], { label: "Rename design" });
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") commit();
    if (e.key === "Escape") {
      open.current = false;
      setEditing(false);
    }
  };

  if (editing) {
    return (
      <input
        ref={input}
        value={draft}
        maxLength={200}
        aria-label="Design name"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={onKeyDown}
        className="h-8 w-[min(320px,40vw)] rounded-[6px] border border-ring/60 bg-surface-2 px-2 text-sm text-fg outline-none"
      />
    );
  }
  return (
    <Tooltip content={canEdit ? "Rename" : name}>
      <button
        type="button"
        disabled={!canEdit}
        onClick={() => {
          setDraft(name);
          setEditing(true);
        }}
        className="h-8 max-w-[min(320px,36vw)] truncate rounded-[6px] px-2 text-left text-sm font-medium text-fg transition-colors enabled:hover:bg-fg/6 disabled:cursor-default"
      >
        {name || "Untitled design"}
      </button>
    </Tooltip>
  );
}

function ModeBadge() {
  const mode = useEditorStore((s) => s.mode);
  const loaded = useEditorStore((s) => s.permission !== null);
  if (!loaded || mode === "edit") return null;
  return (
    <Tooltip
      content={
        mode === "comment"
          ? "You can view and comment. Ask the owner for edit access to change the design."
          : "You can view this design. Ask the owner for access to comment or edit."
      }
    >
      <Badge tone="neutral" className="gap-1 max-sm:hidden">
        {mode === "comment" ? <MessageCircle className="size-3" /> : <Eye className="size-3" />}
        {mode === "comment" ? "Can comment" : "View only"}
      </Badge>
    </Tooltip>
  );
}

function ZoomMenu() {
  const editor = useEditor();
  const zoom = useEditorStore((s) => s.viewport.zoom);
  const ready = useEditorStore((s) => s.engine.status === "ready");
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={!ready}
          aria-label={`Zoom ${Math.round(zoom * 100)}%`}
          className="flex h-8 min-w-14 items-center justify-center gap-0.5 rounded-[6px] px-2 text-xs tabular-nums text-fg-secondary transition-colors enabled:hover:bg-fg/6 enabled:hover:text-fg disabled:opacity-40 data-[state=open]:bg-fg/8"
        >
          {Math.round(zoom * 100)}%
          <ChevronDown className="size-3 text-fg-muted" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <CommandMenuItem id="view.zoomIn" />
        <CommandMenuItem id="view.zoomOut" />
        <CommandMenuItem id="view.zoomFit" />
        <CommandMenuItem id="view.zoomSelection" />
        <CommandMenuItem id="view.zoom100" />
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Zoom to</DropdownMenuLabel>
        {ZOOM_STEPS.filter((z) => [0.25, 0.5, 1, 2, 4].includes(z)).map((z) => (
          <DropdownMenuItem
            key={z}
            onSelect={() => void editor.commands.run("view.zoomTo", { zoom: z }, "menu")}
          >
            {z * 100}%
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Top bar (DESIGN_SYSTEM §6): menu, name, undo/redo, sync, collaborators, zoom, AI, share, export. */
export function TopBar({
  onOpenPanels,
  onOpenInspector,
}: {
  onOpenPanels: () => void;
  onOpenInspector: () => void;
}) {
  const editor = useEditor();
  useRegistryVersion();
  const mode = useEditorStore((s) => s.mode);
  const compact = useEditorStore((s) => s.compact);
  const presence = editor.extensions.slots("topbar.presence").filter((i) => availableIn(i, mode));
  const actions = editor.extensions.slots("topbar.actions").filter((i) => availableIn(i, mode));
  const ai = useCommand("panel.toggleAiDock");
  const share = useCommand("file.share");
  const exportCmd = useCommand("file.export");
  const download = useCommand("file.downloadPng");
  const hasInspector = editor.extensions.inspectorTabs.some((t) => availableIn(t, mode));
  const hasRail = editor.extensions.railPanels.some((p) => availableIn(p, mode));

  return (
    <header className="relative z-20 flex h-12 shrink-0 items-center gap-1 border-b border-line-subtle bg-surface-1 px-2">
      <AppMenu />
      {compact && hasRail ? (
        <IconButton label="Panels" size="sm" onClick={onOpenPanels}>
          <LayoutPanelLeft />
        </IconButton>
      ) : null}
      <div className="mx-1 h-5 w-px bg-line-subtle max-sm:hidden" />
      <DesignTitle />
      <ModeBadge />
      {mode === "edit" ? (
        <div className="ml-1 flex items-center gap-0.5 max-sm:hidden">
          <CommandButton id="history.undo" size="sm" />
          <CommandButton id="history.redo" size="sm" />
        </div>
      ) : null}
      <SyncStatus />
      <div className="min-w-2 flex-1" />
      {presence.map(({ id, component: C }) => (
        <C key={id} editor={editor} />
      ))}
      {actions.map(({ id, component: C }) => (
        <C key={id} editor={editor} />
      ))}
      <div className="max-md:hidden">
        <ZoomMenu />
      </div>
      {ai.exists && ai.enabled ? (
        <Button variant="ghost" size="sm" className="max-sm:hidden" onClick={() => void ai.run()}>
          Ask AI
        </Button>
      ) : null}
      {share.exists && share.enabled ? (
        <Button
          variant="secondary"
          size="sm"
          leadingIcon={<Share2 />}
          className={cn(compact && "max-sm:hidden")}
          onClick={() => void share.run()}
        >
          Share
        </Button>
      ) : null}
      {exportCmd.exists && exportCmd.enabled ? (
        <Button
          variant="primary"
          size="sm"
          leadingIcon={<Download />}
          onClick={() => void exportCmd.run()}
        >
          Export
        </Button>
      ) : download.exists ? (
        <Button
          variant="primary"
          size="sm"
          leadingIcon={<Download />}
          disabled={!download.enabled}
          onClick={() => void download.run()}
        >
          Download
        </Button>
      ) : null}
      {compact && hasInspector ? (
        <IconButton label="Inspector" size="sm" onClick={onOpenInspector}>
          <PanelRight />
        </IconButton>
      ) : null}
    </header>
  );
}
