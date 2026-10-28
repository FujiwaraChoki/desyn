"use client";

import type { Id, Node } from "@desyn/schema";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuSeparator,
  ContextMenuTrigger,
  cn,
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  IconButton,
  Tree,
  TreeRowToggle,
} from "@desyn/ui";
import {
  Box,
  ChartColumn,
  Circle,
  Component,
  Eye,
  EyeOff,
  Film,
  Frame,
  Group,
  Hexagon,
  Image,
  Layers,
  ListFilter,
  Lock,
  LockOpen,
  Minus,
  Music,
  PenTool,
  QrCode,
  Square,
  Star,
  Table2,
  Type,
} from "lucide-react";
import { type ComponentType, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useEditor, useEditorStore, useRegistryVersion } from "../../context.tsx";
import { CommandContextItem } from "../../shell/command-items.tsx";
import {
  filterTree,
  isFilterActive,
  type LayerFilter,
  type LayerRow,
  layerLabel,
  layerTree,
  moveLayersTransaction,
} from "../lib/layers-model.ts";
import { updateEach } from "../lib/ops.ts";
import { PanelEmpty, SearchField } from "../ui/primitives.tsx";

/**
 * Layers: the current page's layer tree, front-most first. Virtualized (@desyn/ui Tree), multi-select synced
 * with the canvas, drag and drop to reorder and reparent (positions on the page are kept), inline rename,
 * lock / hide toggles, role badges, search and type filters, and the selection context menu.
 */

const TYPE_ICONS: Record<string, ComponentType<{ className?: string }>> = {
  frame: Frame,
  group: Group,
  boolean: Component,
  rect: Square,
  ellipse: Circle,
  polygon: Hexagon,
  star: Star,
  line: Minus,
  path: PenTool,
  text: Type,
  image: Image,
  svg: PenTool,
  video: Film,
  audio: Music,
  chart: ChartColumn,
  table: Table2,
  qr: QrCode,
};

const FILTER_TYPES: { types: string[]; label: string }[] = [
  { types: ["text"], label: "Text" },
  { types: ["image", "svg"], label: "Images & graphics" },
  { types: ["rect", "ellipse", "polygon", "star", "line", "path", "boolean"], label: "Shapes" },
  { types: ["frame", "group"], label: "Frames & groups" },
  { types: ["chart", "table", "qr"], label: "Data" },
  { types: ["video", "audio"], label: "Media" },
];

const CONTAINERS = new Set(["frame", "group", "boolean"]);

function rowId(el: Element | null): Id | null {
  const row = el?.closest('[role="treeitem"]');
  const id = row?.id.split("-row-")[1];
  return id && id.length > 0 ? id : null;
}

export function LayersPanel() {
  const editor = useEditor();
  const design = useEditorStore((s) => s.doc.design);
  const pageId = useEditorStore((s) => s.pageId);
  const selection = useEditorStore(useShallow((s) => s.selection));
  const hover = useEditorStore((s) => s.hover);
  const renaming = useEditorStore((s) => s.renaming);
  const canEdit = useEditorStore((s) => s.mode === "edit");
  const [filter, setFilter] = useState<LayerFilter>({ query: "", types: [] });
  const [expanded, setExpanded] = useState<string[]>([]);

  const tree = useMemo(() => (design && pageId ? layerTree(design, pageId) : []), [design, pageId]);
  const filtered = useMemo(() => filterTree(tree, filter), [tree, filter]);
  const filtering = isFilterActive(filter);

  // Reveal selected layers: expand their ancestors (canvas selection deep inside a frame).
  useEffect(() => {
    if (!design || selection.length === 0) return;
    const need = new Set<string>();
    for (const id of selection) {
      let p = design.nodes[id]?.parent;
      while (p && design.nodes[p] && design.nodes[p]?.type !== "page") {
        need.add(p);
        p = design.nodes[p]?.parent ?? null;
      }
    }
    if (need.size === 0) return;
    setExpanded((prev) => {
      const missing = [...need].filter((id) => !prev.includes(id));
      return missing.length > 0 ? [...prev, ...missing] : prev;
    });
  }, [design, selection]);

  const visibleExpanded = filtering ? [...new Set([...expanded, ...filtered.expand])] : expanded;
  const pageName = design && pageId ? (design.nodes[pageId]?.name ?? "") : "";

  const toggle = (node: Node, key: "visible" | "locked") =>
    void editor.apply((d) => updateEach(d, [node.id], (n) => ({ [key]: !n[key] })), {
      label:
        key === "visible"
          ? node.visible
            ? "Hide layer"
            : "Show layer"
          : node.locked
            ? "Unlock layer"
            : "Lock layer",
    });

  const typeFilterOn = (types: string[]) => types.every((t) => filter.types.includes(t));

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1 px-3 pb-2">
        <SearchField
          value={filter.query}
          onChange={(query) => setFilter((f) => ({ ...f, query }))}
          label="Search layers"
          placeholder={pageName ? `Search ${pageName}` : "Search layers"}
          className="min-w-0 flex-1"
        />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <IconButton
              label="Filter layers"
              size="sm"
              variant="ghost"
              active={filter.types.length > 0 || !!filter.hiddenOnly || !!filter.lockedOnly}
            >
              <ListFilter />
            </IconButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            <DropdownMenuLabel>Show only</DropdownMenuLabel>
            {FILTER_TYPES.map((g) => (
              <DropdownMenuCheckboxItem
                key={g.label}
                checked={typeFilterOn(g.types)}
                onSelect={(e) => e.preventDefault()}
                onCheckedChange={(on) =>
                  setFilter((f) => ({
                    ...f,
                    types: on
                      ? [...new Set([...f.types, ...g.types])]
                      : f.types.filter((t) => !g.types.includes(t)),
                  }))
                }
              >
                {g.label}
              </DropdownMenuCheckboxItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuCheckboxItem
              checked={!!filter.hiddenOnly}
              onSelect={(e) => e.preventDefault()}
              onCheckedChange={(on) => setFilter((f) => ({ ...f, hiddenOnly: on === true }))}
            >
              Hidden layers
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem
              checked={!!filter.lockedOnly}
              onSelect={(e) => e.preventDefault()}
              onCheckedChange={(on) => setFilter((f) => ({ ...f, lockedOnly: on === true }))}
            >
              Locked layers
            </DropdownMenuCheckboxItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {tree.length === 0 ? (
        <PanelEmpty
          icon={<Layers />}
          title={
            <>
              a blank <em className="text-accent">page</em>
            </>
          }
          description="Layers appear here as you add text, shapes and images."
        />
      ) : (
        <LayersContextMenu>
          {/* biome-ignore lint/a11y/noStaticElementInteractions: hover feedback only; the tree inside is the interactive element */}
          <div
            className="min-h-0 flex-1"
            onPointerMove={(e) => {
              const id = rowId(e.target as Element);
              if (id !== editor.getState().hover) editor.store.setState({ hover: id });
            }}
            onPointerLeave={() => editor.store.setState({ hover: null })}
            onKeyDown={(e) => {
              // Tab moves focus out of the tree; it must not reach the canvas "select next layer" shortcut.
              if (e.key === "Tab") e.stopPropagation();
            }}
            onContextMenu={(e) => {
              const id = rowId(e.target as Element);
              if (id && !editor.getState().selection.includes(id)) editor.select([id]);
            }}
          >
            <Tree<LayerRow>
              aria-label={`Layers of ${pageName || "the page"}`}
              items={filtered.tree}
              getLabel={(n) => layerLabel(n.data)}
              selected={selection}
              onSelectedChange={(ids) => editor.select(ids)}
              expanded={visibleExpanded}
              onExpandedChange={setExpanded}
              onActivate={(id) => {
                const node = design?.nodes[id];
                if (node && CONTAINERS.has(node.type)) editor.store.setState({ scopeId: id });
                editor.select([id]);
                void editor.commands.run("view.zoomSelection", undefined, "api");
              }}
              {...(canEdit
                ? {
                    onRename: (id: string, name: string) =>
                      void editor.apply(
                        (d) => updateEach(d, [id], () => ({ name: name.slice(0, 200) })),
                        {
                          label: "Rename layer",
                        },
                      ),
                    onMove: (ids: string[], parent: string | null, index: number) => {
                      if (!pageId) return;
                      void editor.apply(
                        (d) => moveLayersTransaction(d, pageId, ids, parent, index),
                        {
                          select: ids,
                        },
                      );
                    },
                  }
                : {})}
              canHaveChildren={(n) =>
                !!n.data && CONTAINERS.has(n.data.node.type) && !n.data.node.locked
              }
              isDimmed={(n) => !!n.data && !n.data.node.visible}
              onItemKeyDown={(id, e) => {
                if (!canEdit) return;
                if (e.key === "Delete" || e.key === "Backspace") {
                  e.preventDefault();
                  if (!editor.getState().selection.includes(id)) editor.select([id]);
                  void editor.commands.run("edit.delete", undefined, "keyboard");
                }
              }}
              renderIcon={(n) => {
                const Icon = TYPE_ICONS[n.data?.node.type ?? ""] ?? Box;
                return <Icon className={cn(n.data?.node.mask && "text-accent")} />;
              }}
              renderLabel={(n, state) =>
                n.data ? (
                  <LayerLabel
                    row={n.data}
                    renaming={renaming === n.id}
                    hovered={hover === n.id && !state.selected}
                  />
                ) : null
              }
              renderActions={(n) =>
                n.data && canEdit ? (
                  <>
                    <TreeRowToggle
                      label={n.data.node.locked ? "Unlock layer" : "Lock layer"}
                      active={n.data.node.locked}
                      icon={<LockOpen />}
                      activeIcon={<Lock />}
                      onToggle={() => toggle(n.data?.node as Node, "locked")}
                    />
                    <TreeRowToggle
                      label={n.data.node.visible ? "Hide layer" : "Show layer"}
                      active={!n.data.node.visible}
                      icon={<Eye />}
                      activeIcon={<EyeOff />}
                      onToggle={() => toggle(n.data?.node as Node, "visible")}
                    />
                  </>
                ) : null
              }
              empty={filtering ? "No layers match the filter." : "No layers"}
              rowHeight={30}
            />
          </div>
        </LayersContextMenu>
      )}
      <LayersFooter count={selection.length} />
    </div>
  );
}

function LayerLabel({
  row,
  renaming,
  hovered,
}: {
  row: LayerRow;
  renaming: boolean;
  hovered: boolean;
}) {
  const editor = useEditor();
  const role = row.node.role;
  if (renaming) return <InlineRename node={row.node} />;
  return (
    <span className={cn("flex min-w-0 items-center gap-1.5", hovered && "text-fg")}>
      <span className="max-w-[70%] shrink-0 truncate">
        {row.node.name || row.text || row.node.type}
      </span>
      {row.text && row.node.name && row.node.name !== row.text ? (
        <span className="min-w-0 truncate text-2xs text-fg-muted">{row.text}</span>
      ) : null}
      {role ? (
        <span
          title={`Role: ${role}`}
          className="shrink-0 rounded-full border border-line-subtle px-1.5 py-px font-mono text-[9.5px] leading-[13px] text-fg-muted"
        >
          {role}
        </span>
      ) : null}
      {row.node.mask ? (
        <span className="shrink-0 rounded-full bg-accent-tint px-1.5 py-px text-[9.5px] leading-[13px] text-accent-text">
          mask
        </span>
      ) : null}
      {editor.getState().scopeId === row.node.id ? (
        <span className="size-1.5 shrink-0 rounded-full bg-accent" title="Entered" />
      ) : null}
    </span>
  );
}

/** Rename started from the `edit.rename` command (store `renaming`), not from the tree's own F2. */
function InlineRename({ node }: { node: Node }) {
  const editor = useEditor();
  const [value, setValue] = useState(node.name);
  const done = useRef(false);
  const finish = (commit: boolean) => {
    if (done.current) return;
    done.current = true;
    editor.store.setState({ renaming: null });
    const name = value.trim().slice(0, 200);
    if (commit && name && name !== node.name) {
      void editor.apply((d) => updateEach(d, [node.id], () => ({ name })), {
        label: "Rename layer",
      });
    }
  };
  return (
    <input
      // biome-ignore lint/a11y/noAutofocus: the user asked to rename this layer
      autoFocus
      aria-label="Layer name"
      data-tree-ignore=""
      value={value}
      maxLength={200}
      onChange={(e) => setValue(e.target.value)}
      onFocus={(e) => e.currentTarget.select()}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") finish(true);
        if (e.key === "Escape") finish(false);
      }}
      onBlur={() => finish(true)}
      className="h-[22px] w-full min-w-0 rounded-[4px] border border-accent/60 bg-background px-1 text-sm text-fg ring-2 ring-accent/20 outline-none"
    />
  );
}

/** The selection context menu (the same entries as the canvas, from the extension registry). */
function LayersContextMenu({ children }: { children: ReactNode }) {
  const editor = useEditor();
  useRegistryVersion();
  const entries = editor.extensions.contextMenu.filter(
    (e) => e.target === "selection" || e.target === "both",
  );
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="w-60">
        <MenuRows entries={entries} />
      </ContextMenuContent>
    </ContextMenu>
  );
}

function MenuRows({ entries }: { entries: { command: string; order: number; args?: unknown }[] }) {
  const editor = useEditor();
  const ctx = editor.context();
  const rows: ReactNode[] = [];
  let sep = false;
  entries.forEach((e, i) => {
    if (e.command === "-") {
      sep = rows.length > 0;
      return;
    }
    if (!editor.commands.get(e.command) || !editor.commands.isEnabled(e.command, ctx)) return;
    if (sep) {
      // biome-ignore lint/suspicious/noArrayIndexKey: separators have no identity of their own
      rows.push(<ContextMenuSeparator key={`sep-${i}`} />);
      sep = false;
    }
    rows.push(<CommandContextItem key={`${e.command}-${e.order}`} id={e.command} args={e.args} />);
  });
  return <>{rows}</>;
}

function LayersFooter({ count }: { count: number }) {
  if (count < 2) return null;
  return (
    <div className="shrink-0 border-t border-line-subtle px-4 py-2 text-2xs text-fg-muted">
      {count} layers selected
    </div>
  );
}
