"use client";

import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronRight } from "lucide-react";
import {
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { cn } from "../lib/cn.ts";
import {
  allIds,
  type DropTarget,
  type FlatTreeItem,
  flattenTree,
  rangeBetween,
  resolveDrop,
  type TreeNode,
  typeaheadMatch,
} from "../lib/tree.ts";
import { useControllableState } from "../lib/use-controllable.ts";
import { Tooltip } from "./tooltip.tsx";

export type { DropTarget, TreeNode };

/** Per-row state passed to render slots. */
export interface TreeItemState {
  depth: number;
  selected: boolean;
  active: boolean;
  expanded: boolean;
  hasChildren: boolean;
  dragging: boolean;
  renaming: boolean;
}

export interface TreeProps<T> {
  items: TreeNode<T>[];
  /** Text label (used for display, type-ahead and the rename field). */
  getLabel: (node: TreeNode<T>) => string;
  /** Leading icon per row. */
  renderIcon?: (node: TreeNode<T>, state: TreeItemState) => ReactNode;
  /** Custom label content (badges, secondary text). Defaults to `getLabel`. */
  renderLabel?: (node: TreeNode<T>, state: TreeItemState) => ReactNode;
  /** Trailing controls, e.g. lock/visibility `TreeRowToggle`s. */
  renderActions?: (node: TreeNode<T>, state: TreeItemState) => ReactNode;
  /** Dim a row (hidden layers). */
  isDimmed?: (node: TreeNode<T>) => boolean;
  expanded?: string[];
  defaultExpanded?: string[];
  onExpandedChange?: (ids: string[]) => void;
  selected?: string[];
  defaultSelected?: string[];
  onSelectedChange?: (ids: string[]) => void;
  selectionMode?: "single" | "multiple";
  /** Double-click or Enter on a row. */
  onActivate?: (id: string) => void;
  /** Enables inline rename (F2, or double-click the label). Empty names are rejected. */
  onRename?: (id: string, name: string) => void;
  /**
   * Enables drag and drop. `index` is the position among `parentId`'s children after the dragged
   * nodes are removed (see `moveTreeNodes`). `parentId` is `null` for the root level.
   */
  onMove?: (ids: string[], parentId: string | null, index: number) => void;
  canDrag?: (node: TreeNode<T>) => boolean;
  canDrop?: (dragIds: readonly string[], target: DropTarget) => boolean;
  /** Which nodes accept children (default: nodes with a `children` array). */
  canHaveChildren?: (node: TreeNode<T>) => boolean;
  /** Extra key handling for the active row (e.g. shortcuts to hide/lock). */
  onItemKeyDown?: (id: string, event: KeyboardEvent<HTMLDivElement>) => void;
  /** Row height in px (default 28). */
  rowHeight?: number;
  /** Indent per level in px (default 14). */
  indent?: number;
  /** Extra rows rendered outside the viewport. */
  overscan?: number;
  "aria-label": string;
  className?: string;
  style?: CSSProperties;
  /** Shown when `items` is empty. */
  empty?: ReactNode;
}

const DRAG_THRESHOLD = 4;
const AUTOSCROLL_EDGE = 28;
const HOVER_EXPAND_MS = 600;

interface DragState {
  pointerId: number;
  startX: number;
  startY: number;
  originId: string;
  ids: string[];
  active: boolean;
  x: number;
  y: number;
}

/**
 * Virtualized tree (layers panel, outlines). Single tab stop with `aria-activedescendant`;
 * ↑/↓ move, ←/→ collapse/expand or go to parent/child, Home/End, type-ahead, Space/click to select,
 * Shift/⌘ to extend, F2 to rename, Enter to activate. Rows can be dragged to reorder or reparent
 * (drop above/below a row, or onto a container to nest it; below the end of a group, move the
 * pointer left to drop after the group instead of inside it); Escape cancels a drag.
 */
export function Tree<T>({
  items,
  getLabel,
  renderIcon,
  renderLabel,
  renderActions,
  isDimmed,
  expanded: expandedProp,
  defaultExpanded = [],
  onExpandedChange,
  selected: selectedProp,
  defaultSelected = [],
  onSelectedChange,
  selectionMode = "multiple",
  onActivate,
  onRename,
  onMove,
  canDrag,
  canDrop,
  canHaveChildren,
  onItemKeyDown,
  rowHeight = 28,
  indent = 14,
  overscan = 10,
  "aria-label": ariaLabel,
  className,
  style,
  empty,
}: TreeProps<T>) {
  const treeId = useId().replace(/:/g, "");
  const [expandedList, setExpandedList] = useControllableState(
    expandedProp,
    defaultExpanded,
    onExpandedChange,
  );
  const [selectedList, setSelectedList] = useControllableState(
    selectedProp,
    defaultSelected,
    onSelectedChange,
  );
  const expanded = useMemo(() => new Set(expandedList), [expandedList]);
  const selected = useMemo(() => new Set(selectedList), [selectedList]);
  const flat = useMemo(() => flattenTree(items, expanded), [items, expanded]);
  const indexById = useMemo(() => new Map(flat.map((f, i) => [f.id, i])), [flat]);

  const [activeId, setActiveId] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [drop, setDropState] = useState<DropTarget | null>(null);
  // Mirrors `drop` so pointer-up reads the latest target even before a re-render.
  const dropRef = useRef<DropTarget | null>(null);
  const setDrop = (target: DropTarget | null) => {
    dropRef.current = target;
    setDropState(target);
  };
  const [dragView, setDragView] = useState<{ ids: string[]; x: number; y: number } | null>(null);
  const anchor = useRef<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const drag = useRef<DragState | null>(null);
  const typeahead = useRef({ buffer: "", timer: 0 });
  const autoScroll = useRef(0);
  const hoverExpand = useRef<{ id: string; timer: number } | null>(null);

  const virtualizer = useVirtualizer({
    count: flat.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan,
  });

  // Keep the active row valid when the tree changes underneath it.
  const active = activeId !== null && indexById.has(activeId) ? activeId : null;

  const moveActive = useCallback(
    (index: number) => {
      const item = flat[Math.max(0, Math.min(flat.length - 1, index))];
      if (!item) return null;
      setActiveId(item.id);
      virtualizer.scrollToIndex(indexById.get(item.id) ?? 0, { align: "auto" });
      return item;
    },
    [flat, indexById, virtualizer],
  );

  const setExpanded = (id: string, open: boolean) => {
    setExpandedList((prev) =>
      open ? (prev.includes(id) ? prev : [...prev, id]) : prev.filter((x) => x !== id),
    );
  };

  const select = (id: string, mode: "replace" | "toggle" | "range") => {
    if (selectionMode === "single" || mode === "replace") {
      setSelectedList([id]);
      anchor.current = id;
      return;
    }
    if (mode === "toggle") {
      setSelectedList((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
      anchor.current = id;
      return;
    }
    setSelectedList(rangeBetween(flat, anchor.current ?? id, id));
  };

  // ---- Keyboard -----------------------------------------------------------------------------
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (renamingId) return;
    const idx = active ? (indexById.get(active) ?? 0) : -1;
    const item = idx >= 0 ? flat[idx] : undefined;
    const mod = e.metaKey || e.ctrlKey;
    if (item) onItemKeyDown?.(item.id, e);
    if (e.defaultPrevented) return;

    const go = (next: number) => {
      e.preventDefault();
      const target = moveActive(next);
      if (target && e.shiftKey && selectionMode === "multiple") select(target.id, "range");
    };

    switch (e.key) {
      case "ArrowDown":
        return go(idx + 1);
      case "ArrowUp":
        return go(idx < 0 ? 0 : idx - 1);
      case "Home":
        return go(0);
      case "End":
        return go(flat.length - 1);
      case "PageDown":
        return go(
          idx + Math.max(1, Math.floor((scrollRef.current?.clientHeight ?? 280) / rowHeight) - 1),
        );
      case "PageUp":
        return go(
          idx - Math.max(1, Math.floor((scrollRef.current?.clientHeight ?? 280) / rowHeight) - 1),
        );
      case "ArrowRight":
        if (!item) return;
        e.preventDefault();
        if (item.hasChildren && !item.isExpanded) setExpanded(item.id, true);
        else if (item.isExpanded) moveActive(idx + 1);
        return;
      case "ArrowLeft":
        if (!item) return;
        e.preventDefault();
        if (item.isExpanded) setExpanded(item.id, false);
        else if (item.parentId) moveActive(indexById.get(item.parentId) ?? idx);
        return;
      case " ":
        if (!item) return;
        e.preventDefault();
        select(item.id, mod ? "toggle" : e.shiftKey ? "range" : "replace");
        return;
      case "Enter":
        if (!item) return;
        e.preventDefault();
        if (onActivate) onActivate(item.id);
        else select(item.id, "replace");
        return;
      case "F2":
        if (!item || !onRename) return;
        e.preventDefault();
        setRenamingId(item.id);
        return;
      case "Escape":
        if (drag.current?.active) return;
        if (selectedList.length) {
          e.preventDefault();
          setSelectedList([]);
        }
        return;
      case "a":
        if (mod && selectionMode === "multiple") {
          e.preventDefault();
          setSelectedList(flat.map((f) => f.id));
          return;
        }
        break;
    }

    if (e.key.length === 1 && !mod && !e.altKey && /\S/.test(e.key)) {
      const t = typeahead.current;
      window.clearTimeout(t.timer);
      t.buffer += e.key;
      t.timer = window.setTimeout(() => (t.buffer = ""), 600);
      // Continuing a word keeps matching from the current row; a fresh letter starts after it.
      const from = t.buffer.length > 1 ? idx - 1 : idx;
      const match = typeaheadMatch(flat, Math.max(-1, from), t.buffer, getLabel);
      if (match >= 0) {
        e.preventDefault();
        moveActive(match);
      }
    }
  };

  // ---- Pointer: selection + drag and drop ----------------------------------------------------
  const pointToRow = (
    clientX: number,
    clientY: number,
  ): { index: number; ratio: number; depth: number } | null => {
    // Measure against the row container: it scrolls with the content and excludes padding.
    const list = listRef.current;
    if (!list) return null;
    const rect = list.getBoundingClientRect();
    const y = clientY - rect.top;
    // Nesting level under the pointer: rows indent `indent` px per level after an 8 px inset.
    const depth = Math.max(0, Math.floor((clientX - rect.left - 8) / indent));
    const index = Math.floor(y / rowHeight);
    if (index < 0) return { index: 0, ratio: 0, depth };
    if (index >= flat.length)
      return flat.length ? { index: flat.length - 1, ratio: 1, depth } : null;
    return { index, ratio: (y - index * rowHeight) / rowHeight, depth };
  };

  const stopAutoScroll = () => {
    cancelAnimationFrame(autoScroll.current);
    autoScroll.current = 0;
  };
  const clearHoverExpand = () => {
    if (hoverExpand.current) window.clearTimeout(hoverExpand.current.timer);
    hoverExpand.current = null;
  };

  const updateDrop = (clientX: number, clientY: number) => {
    const d = drag.current;
    if (!d) return;
    const hit = pointToRow(clientX, clientY);
    const target = hit
      ? resolveDrop(flat, items, hit.index, hit.ratio, d.ids, {
          canHaveChildren,
          canDrop,
          pointerDepth: hit.depth,
        })
      : null;
    setDrop(target);
    // Hovering the middle of a collapsed container expands it after a beat.
    const over = hit ? flat[hit.index] : undefined;
    if (target?.position === "inside" && over && over.hasChildren && !over.isExpanded) {
      if (hoverExpand.current?.id !== over.id) {
        clearHoverExpand();
        hoverExpand.current = {
          id: over.id,
          timer: window.setTimeout(() => setExpanded(over.id, true), HOVER_EXPAND_MS),
        };
      }
    } else clearHoverExpand();
  };

  const runAutoScroll = () => {
    const el = scrollRef.current;
    const d = drag.current;
    if (!el || !d?.active) return stopAutoScroll();
    const rect = el.getBoundingClientRect();
    let delta = 0;
    if (d.y < rect.top + AUTOSCROLL_EDGE)
      delta = -Math.ceil((rect.top + AUTOSCROLL_EDGE - d.y) / 3);
    else if (d.y > rect.bottom - AUTOSCROLL_EDGE)
      delta = Math.ceil((d.y - (rect.bottom - AUTOSCROLL_EDGE)) / 3);
    if (delta !== 0) {
      el.scrollTop += delta;
      updateDrop(d.x, d.y);
    }
    autoScroll.current = requestAnimationFrame(runAutoScroll);
  };

  const endDrag = (commit: boolean) => {
    const d = drag.current;
    drag.current = null;
    stopAutoScroll();
    clearHoverExpand();
    setDragView(null);
    const target = dropRef.current;
    setDrop(null);
    if (!d?.active || !commit || !target || !onMove) return;
    onMove(d.ids, target.parentId, target.index);
    if (target.position === "inside" && target.parentId) setExpanded(target.parentId, true);
  };

  useEffect(() => {
    if (!dragView) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        endDrag(false);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  useEffect(() => () => cancelAnimationFrame(autoScroll.current), []);

  const onRowPointerDown = (e: ReactPointerEvent<HTMLDivElement>, item: FlatTreeItem<T>) => {
    if (e.button !== 0 || renamingId) return;
    const target = e.target as HTMLElement;
    if (target.closest("[data-tree-ignore]")) return;
    scrollRef.current?.focus({ preventScroll: true });
    setActiveId(item.id);
    if (!onMove || (canDrag && !canDrag(item.node))) return;
    const ids = selected.has(item.id)
      ? flat.filter((f) => selected.has(f.id)).map((f) => f.id)
      : [item.id];
    drag.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      originId: item.id,
      ids,
      active: false,
      x: e.clientX,
      y: e.clientY,
    };
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    d.x = e.clientX;
    d.y = e.clientY;
    if (!d.active) {
      if (Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < DRAG_THRESHOLD) return;
      d.active = true;
      scrollRef.current?.setPointerCapture?.(e.pointerId);
      if (!selected.has(d.originId)) select(d.originId, "replace");
      autoScroll.current = requestAnimationFrame(runAutoScroll);
    }
    setDragView({ ids: d.ids, x: e.clientX, y: e.clientY });
    updateDrop(e.clientX, e.clientY);
  };

  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    scrollRef.current?.releasePointerCapture?.(e.pointerId);
    if (d.active) endDrag(true);
    else drag.current = null;
  };

  const onRowClick = (e: ReactMouseEvent<HTMLDivElement>, item: FlatTreeItem<T>) => {
    if ((e.target as HTMLElement).closest("[data-tree-ignore]")) return;
    if (e.detail > 1) return; // Second click of a double-click: keep the selection.
    const mode = e.metaKey || e.ctrlKey ? "toggle" : e.shiftKey ? "range" : "replace";
    select(item.id, mode);
  };

  // ---- Rename -------------------------------------------------------------------------------
  const commitRename = (id: string, value: string, original: string) => {
    setRenamingId(null);
    const name = value.trim();
    if (name && name !== original) onRename?.(id, name);
    scrollRef.current?.focus({ preventScroll: true });
  };

  const rowDomId = (id: string) => `${treeId}-row-${id.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
  const vItems = virtualizer.getVirtualItems();

  return (
    <div
      ref={scrollRef}
      role="tree"
      aria-label={ariaLabel}
      aria-multiselectable={selectionMode === "multiple" || undefined}
      aria-activedescendant={active ? rowDomId(active) : undefined}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onFocus={(e) => {
        if (e.target !== e.currentTarget) return;
        setFocused(true);
        if (!active && flat.length) {
          const first = flat.find((f) => selected.has(f.id)) ?? flat[0];
          if (first) setActiveId(first.id);
        }
      }}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(false);
      }}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => endDrag(false)}
      className={cn(
        "relative h-full overflow-y-auto overflow-x-hidden py-1 outline-none select-none",
        "focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-line",
        dragView && "cursor-grabbing",
        className,
      )}
      style={style}
    >
      {flat.length === 0 ? (
        <div className="px-3 py-6 text-center text-xs text-fg-muted">
          {empty ?? "Nothing here yet"}
        </div>
      ) : null}
      <div ref={listRef} style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
        {vItems.map((v) => {
          const item = flat[v.index];
          if (!item) return null;
          const state: TreeItemState = {
            depth: item.depth,
            selected: selected.has(item.id),
            active: active === item.id,
            expanded: item.isExpanded,
            hasChildren: item.hasChildren,
            dragging: !!dragView && dragView.ids.includes(item.id),
            renaming: renamingId === item.id,
          };
          const label = getLabel(item.node);
          const dropInside = drop?.position === "inside" && drop.targetId === item.id;
          return (
            // biome-ignore lint/a11y/useFocusableInteractive: focus stays on the tree (aria-activedescendant)
            // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard is handled on the tree container
            <div
              key={item.id}
              id={rowDomId(item.id)}
              role="treeitem"
              aria-level={item.depth + 1}
              aria-setsize={item.siblingCount}
              aria-posinset={item.index + 1}
              aria-expanded={item.hasChildren ? item.isExpanded : undefined}
              aria-selected={state.selected}
              aria-label={label}
              data-selected={state.selected || undefined}
              data-active={state.active || undefined}
              onPointerDown={(e) => onRowPointerDown(e, item)}
              onClick={(e) => onRowClick(e, item)}
              onDoubleClick={(e) => {
                if ((e.target as HTMLElement).closest("[data-tree-ignore]")) return;
                if (onRename && (e.target as HTMLElement).closest("[data-tree-label]"))
                  setRenamingId(item.id);
                else onActivate?.(item.id);
              }}
              className="group/row absolute inset-x-0 px-1"
              style={{ top: v.start, height: rowHeight }}
            >
              <div
                className={cn(
                  "flex h-full items-center gap-1 rounded-[6px] pr-1 text-sm transition-colors duration-100",
                  state.selected
                    ? "bg-fg/10 text-fg"
                    : "text-fg-secondary hover:bg-fg/5 hover:text-fg",
                  state.active && focused && "shadow-[inset_0_0_0_1px_var(--ring)]",
                  state.dragging && "opacity-45",
                  dropInside && "bg-accent-wash shadow-[inset_0_0_0_1.5px_var(--accent)]",
                  isDimmed?.(item.node) && !state.selected && "text-fg-muted",
                )}
                style={{ paddingLeft: 4 + item.depth * indent }}
              >
                {item.hasChildren ? (
                  <button
                    type="button"
                    tabIndex={-1}
                    aria-hidden
                    data-tree-ignore=""
                    onClick={() => setExpanded(item.id, !item.isExpanded)}
                    className="grid size-4 shrink-0 cursor-pointer place-items-center rounded-[4px] text-fg-muted hover:text-fg"
                  >
                    <ChevronRight
                      className={cn(
                        "size-3 transition-transform duration-200 ease-out",
                        item.isExpanded && "rotate-90",
                      )}
                    />
                  </button>
                ) : (
                  <span aria-hidden className="size-4 shrink-0" />
                )}
                {renderIcon ? (
                  <span className="flex size-4 shrink-0 items-center justify-center text-fg-muted [&_svg]:size-3.5">
                    {renderIcon(item.node, state)}
                  </span>
                ) : null}
                {state.renaming ? (
                  <RenameInput
                    initial={label}
                    onCommit={(value) => commitRename(item.id, value, label)}
                    onCancel={() => {
                      setRenamingId(null);
                      scrollRef.current?.focus({ preventScroll: true });
                    }}
                  />
                ) : (
                  <span data-tree-label="" className="min-w-0 flex-1 truncate pl-0.5">
                    {renderLabel ? renderLabel(item.node, state) : label}
                  </span>
                )}
                {renderActions && !state.renaming ? (
                  <span data-tree-ignore="" className="flex shrink-0 items-center gap-0.5">
                    {renderActions(item.node, state)}
                  </span>
                ) : null}
              </div>
            </div>
          );
        })}
        {drop && drop.position !== "inside" ? (
          <DropLine top={drop.line * rowHeight} left={8 + drop.depth * indent + 16} />
        ) : null}
      </div>
      {dragView ? (
        <DragGhost x={dragView.x} y={dragView.y} label={dragLabel(dragView.ids, flat, getLabel)} />
      ) : null}
    </div>
  );
}

function dragLabel<T>(
  ids: string[],
  flat: FlatTreeItem<T>[],
  getLabel: (n: TreeNode<T>) => string,
): string {
  const first = flat.find((f) => f.id === ids[0]);
  const name = first ? getLabel(first.node) : "";
  return ids.length > 1 ? `${name} +${ids.length - 1}` : name;
}

function DropLine({ top, left }: { top: number; left: number }) {
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute right-2 h-0.5 -translate-y-1/2 rounded-full bg-accent"
      style={{ top, left }}
    >
      <span className="-left-1 -translate-y-1/2 absolute top-1/2 size-1.5 rounded-full border-[1.5px] border-accent bg-background" />
    </div>
  );
}

function DragGhost({ x, y, label }: { x: number; y: number; label: string }) {
  return (
    <div
      aria-hidden
      className="pointer-events-none fixed z-(--z-tooltip) rounded-[6px] border border-line-subtle bg-surface-3/95 px-2 py-1 text-xs text-fg shadow-popover backdrop-blur-md"
      style={{ left: x + 12, top: y + 8 }}
    >
      {label}
    </div>
  );
}

function RenameInput({
  initial,
  onCommit,
  onCancel,
}: {
  initial: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const done = useRef(false);
  return (
    <input
      // biome-ignore lint/a11y/noAutofocus: rename is an explicit user action; focus must move to the field
      autoFocus
      aria-label="Rename"
      data-tree-ignore=""
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onFocus={(e) => e.currentTarget.select()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") {
          done.current = true;
          onCommit(value);
        } else if (e.key === "Escape") {
          done.current = true;
          onCancel();
        }
      }}
      onBlur={() => {
        if (!done.current) onCommit(value);
      }}
      onPointerDown={(e) => e.stopPropagation()}
      className="h-[22px] min-w-0 flex-1 rounded-[4px] border border-accent/60 bg-background px-1 text-sm text-fg outline-none ring-2 ring-accent/20"
    />
  );
}

export interface TreeRowToggleProps {
  /** Accessible name / tooltip, e.g. "Hide layer". */
  label: string;
  /** Whether the toggle is on (e.g. layer hidden / locked). On toggles stay visible. */
  active: boolean;
  onToggle: () => void;
  /** Icon when off. */
  icon: ReactNode;
  /** Icon when on (defaults to `icon`). */
  activeIcon?: ReactNode;
}

/**
 * Small trailing toggle for tree rows (visibility, lock). Hidden until the row is hovered unless
 * active, so a locked/hidden layer is visible at a glance.
 */
export function TreeRowToggle({ label, active, onToggle, icon, activeIcon }: TreeRowToggleProps) {
  return (
    <Tooltip content={label}>
      <button
        type="button"
        tabIndex={-1}
        aria-label={label}
        aria-pressed={active}
        data-tree-ignore=""
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          onToggle();
        }}
        className={cn(
          "grid size-5 cursor-pointer place-items-center rounded-[4px] text-fg-muted transition-[opacity,color,background-color] duration-100 hover:bg-fg/8 hover:text-fg [&_svg]:size-3.5",
          active
            ? "opacity-100"
            : "opacity-0 group-hover/row:opacity-100 group-data-[active]/row:opacity-100",
        )}
      >
        {active ? (activeIcon ?? icon) : icon}
      </button>
    </Tooltip>
  );
}

/** Every id in a tree (handy for "expand all"). */
export { allIds as treeIds };
