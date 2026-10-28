"use client";

import {
  type ComponentPropsWithoutRef,
  createContext,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { cn } from "../lib/cn.ts";
import { readStorage, writeStorage } from "../lib/storage.ts";

/**
 * Pixel-based resizable layout for editor chrome: side panels have a width in px (min/max,
 * collapsible), and one or more flexible panels take the remaining space. Sizes persist with
 * `autoSaveId`. Handles are keyboard operable (`role="separator"`).
 */

interface PanelConfig {
  defaultSize?: number;
  minSize: number;
  maxSize: number;
  collapsible: boolean;
  collapsedSize: number;
  onResize?: (size: number) => void;
  onCollapsedChange?: (collapsed: boolean) => void;
}

interface Persisted {
  sizes: Record<string, number>;
  collapsed: string[];
}

interface GroupContextValue {
  direction: "horizontal" | "vertical";
  sizes: Record<string, number>;
  collapsed: ReadonlySet<string>;
  register: (id: string, config: PanelConfig) => void;
  config: (id: string) => PanelConfig | undefined;
  resize: (id: string, size: number, commit?: boolean) => void;
  setCollapsed: (id: string, collapsed: boolean) => void;
  commit: () => void;
}

const GroupContext = createContext<GroupContextValue | null>(null);

function useGroup(component: string): GroupContextValue {
  const ctx = useContext(GroupContext);
  if (!ctx) throw new Error(`<${component}> must be inside <ResizablePanelGroup>.`);
  return ctx;
}

const isPersisted = (v: unknown): v is Persisted =>
  typeof v === "object" &&
  v !== null &&
  typeof (v as Persisted).sizes === "object" &&
  Array.isArray((v as Persisted).collapsed);

export interface ResizablePanelGroupProps extends ComponentPropsWithoutRef<"div"> {
  direction?: "horizontal" | "vertical";
  /** localStorage key for persisting sizes and collapsed state. */
  autoSaveId?: string;
}

export function ResizablePanelGroup({
  direction = "horizontal",
  autoSaveId,
  className,
  children,
  ...props
}: ResizablePanelGroupProps) {
  const storageKey = autoSaveId ? `desyn-panels:${autoSaveId}` : null;
  // Start from defaults so server and hydration renders agree; persisted sizes are applied in a
  // layout effect, before the first paint.
  const [sizes, setSizes] = useState<Record<string, number>>({});
  const [collapsed, setCollapsedState] = useState<Set<string>>(() => new Set());
  const configs = useRef(new Map<string, PanelConfig>());
  const latest = useRef({ sizes, collapsed });
  latest.current = { sizes, collapsed };

  useLayoutEffect(() => {
    const persisted = storageKey ? readStorage(storageKey, isPersisted) : undefined;
    if (!persisted) return;
    // Persisted sizes win over defaults panels registered meanwhile; clamp to current limits.
    const restored: Record<string, number> = {};
    for (const [id, size] of Object.entries(persisted.sizes)) {
      if (typeof size !== "number" || !Number.isFinite(size)) continue;
      const cfg = configs.current.get(id);
      restored[id] = cfg ? Math.min(cfg.maxSize, Math.max(cfg.minSize, size)) : size;
    }
    const next = {
      sizes: { ...latest.current.sizes, ...restored },
      collapsed: new Set(persisted.collapsed),
    };
    latest.current = next;
    setSizes(next.sizes);
    setCollapsedState(next.collapsed);
  }, [storageKey]);

  const register = useCallback((id: string, config: PanelConfig) => {
    configs.current.set(id, config);
    if (config.defaultSize !== undefined) {
      setSizes((s) => (id in s ? s : { ...s, [id]: config.defaultSize as number }));
    }
  }, []);

  const commit = useCallback(() => {
    if (!storageKey) return;
    writeStorage(storageKey, {
      sizes: latest.current.sizes,
      collapsed: [...latest.current.collapsed],
    } satisfies Persisted);
  }, [storageKey]);

  const resize = useCallback(
    (id: string, size: number, shouldCommit = false) => {
      const cfg = configs.current.get(id);
      if (!cfg) return;
      const next = Math.round(Math.min(cfg.maxSize, Math.max(cfg.minSize, size)));
      if (latest.current.sizes[id] === next) return;
      const sizesNext = { ...latest.current.sizes, [id]: next };
      latest.current = { ...latest.current, sizes: sizesNext };
      setSizes(sizesNext);
      cfg.onResize?.(next);
      if (shouldCommit) commit();
    },
    [commit],
  );

  const setCollapsed = useCallback(
    (id: string, value: boolean) => {
      if (latest.current.collapsed.has(id) === value) return;
      const next = new Set(latest.current.collapsed);
      if (value) next.add(id);
      else next.delete(id);
      latest.current = { ...latest.current, collapsed: next };
      setCollapsedState(next);
      configs.current.get(id)?.onCollapsedChange?.(value);
      commit();
    },
    [commit],
  );

  const value = useMemo<GroupContextValue>(
    () => ({
      direction,
      sizes,
      collapsed,
      register,
      config: (id) => configs.current.get(id),
      resize,
      setCollapsed,
      commit,
    }),
    [direction, sizes, collapsed, register, resize, setCollapsed, commit],
  );

  return (
    <GroupContext.Provider value={value}>
      <div
        data-panel-group=""
        data-direction={direction}
        className={cn(
          "flex size-full overflow-hidden",
          direction === "vertical" ? "flex-col" : "flex-row",
          className,
        )}
        {...props}
      >
        {children}
      </div>
    </GroupContext.Provider>
  );
}

export interface ResizablePanelProps extends ComponentPropsWithoutRef<"div"> {
  /** Stable id (used for persistence and handle wiring). */
  id: string;
  /** Initial size in px. Omit to make the panel flexible (fills remaining space). */
  defaultSize?: number;
  minSize?: number;
  maxSize?: number;
  /** Dragging below half of `minSize` collapses the panel. */
  collapsible?: boolean;
  collapsedSize?: number;
  /** Controlled collapsed state. */
  collapsed?: boolean;
  onResize?: (size: number) => void;
  onCollapsedChange?: (collapsed: boolean) => void;
}

export function ResizablePanel({
  id,
  defaultSize,
  minSize = 0,
  maxSize = Number.POSITIVE_INFINITY,
  collapsible = false,
  collapsedSize = 0,
  collapsed: collapsedProp,
  onResize,
  onCollapsedChange,
  className,
  style,
  children,
  ...props
}: ResizablePanelProps) {
  const group = useGroup("ResizablePanel");
  const { register, setCollapsed } = group;
  const callbacks = useRef({ onResize, onCollapsedChange });
  callbacks.current = { onResize, onCollapsedChange };

  useEffect(() => {
    register(id, {
      defaultSize,
      minSize,
      maxSize,
      collapsible,
      collapsedSize,
      onResize: (s) => callbacks.current.onResize?.(s),
      onCollapsedChange: (c) => callbacks.current.onCollapsedChange?.(c),
    });
  }, [register, id, defaultSize, minSize, maxSize, collapsible, collapsedSize]);

  useEffect(() => {
    if (collapsedProp !== undefined) setCollapsed(id, collapsedProp);
  }, [collapsedProp, id, setCollapsed]);

  const isCollapsed = collapsedProp ?? group.collapsed.has(id);
  const sized = defaultSize !== undefined;
  const size = isCollapsed ? collapsedSize : (group.sizes[id] ?? defaultSize);
  const horizontal = group.direction === "horizontal";

  return (
    <div
      id={id}
      data-panel-id={id}
      data-panel-sized={sized || undefined}
      data-collapsed={isCollapsed || undefined}
      style={{
        ...(sized
          ? { flex: `0 0 ${size}px`, [horizontal ? "width" : "height"]: size }
          : { flex: "1 1 0" }),
        ...style,
      }}
      className={cn(
        "relative min-h-0 min-w-0 overflow-hidden",
        isCollapsed && collapsedSize === 0 && "invisible",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

/** Finds the sized panel next to a handle; `sign` is +1 when it sits before the handle. */
function neighbour(handle: HTMLElement): { id: string; sign: 1 | -1 } | null {
  const prev = handle.previousElementSibling as HTMLElement | null;
  const next = handle.nextElementSibling as HTMLElement | null;
  if (prev?.dataset.panelSized !== undefined && prev.dataset.panelId)
    return { id: prev.dataset.panelId, sign: 1 };
  if (next?.dataset.panelSized !== undefined && next.dataset.panelId)
    return { id: next.dataset.panelId, sign: -1 };
  return null;
}

export interface ResizableHandleProps extends ComponentPropsWithoutRef<"div"> {
  /** Accessible name, e.g. "Resize layers panel". */
  "aria-label"?: string;
}

/** Drag (or use arrow keys) to resize the adjacent sized panel. Double-click resets it. */
export function ResizableHandle({
  className,
  "aria-label": ariaLabel = "Resize panel",
  ...props
}: ResizableHandleProps) {
  const group = useGroup("ResizableHandle");
  const ref = useRef<HTMLDivElement>(null);
  const [target, setTarget] = useState<{ id: string; sign: 1 | -1 } | null>(null);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ pointerId: number; start: number; startSize: number } | null>(null);
  const horizontal = group.direction === "horizontal";

  useEffect(() => {
    if (ref.current) setTarget(neighbour(ref.current));
  }, []);

  const cfg = target ? group.config(target.id) : undefined;
  const isCollapsed = target ? group.collapsed.has(target.id) : false;
  const size = target
    ? isCollapsed
      ? (cfg?.collapsedSize ?? 0)
      : (group.sizes[target.id] ?? cfg?.defaultSize ?? 0)
    : 0;

  const applySize = (raw: number, commit: boolean) => {
    if (!target || !cfg) return;
    if (cfg.collapsible && raw < cfg.minSize / 2) {
      group.setCollapsed(target.id, true);
      return;
    }
    if (isCollapsed) group.setCollapsed(target.id, false);
    group.resize(target.id, raw, commit);
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !target) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    drag.current = {
      pointerId: e.pointerId,
      start: horizontal ? e.clientX : e.clientY,
      startSize: size,
    };
    setDragging(true);
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId || !target) return;
    const delta = (horizontal ? e.clientX : e.clientY) - d.start;
    applySize(d.startSize + delta * target.sign, false);
  };
  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag.current || drag.current.pointerId !== e.pointerId) return;
    drag.current = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    setDragging(false);
    group.commit();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!target || !cfg) return;
    const amount = e.shiftKey ? 32 : 8;
    const grow = horizontal ? "ArrowRight" : "ArrowDown";
    const shrink = horizontal ? "ArrowLeft" : "ArrowUp";
    if (e.key === grow || e.key === shrink) {
      e.preventDefault();
      const dir = (e.key === grow ? 1 : -1) * target.sign;
      applySize((isCollapsed ? cfg.minSize : size) + dir * amount, true);
    } else if (e.key === "Home") {
      e.preventDefault();
      applySize(cfg.minSize, true);
    } else if (e.key === "End" && Number.isFinite(cfg.maxSize)) {
      e.preventDefault();
      applySize(cfg.maxSize, true);
    } else if (e.key === "Enter" && cfg.collapsible) {
      e.preventDefault();
      group.setCollapsed(target.id, !isCollapsed);
    }
  };

  return (
    // biome-ignore lint/a11y/useSemanticElements: an <hr> cannot be focusable/interactive; ARIA window splitter pattern
    <div
      ref={ref}
      role="separator"
      tabIndex={0}
      aria-label={ariaLabel}
      aria-controls={target?.id}
      aria-orientation={horizontal ? "vertical" : "horizontal"}
      aria-valuenow={Math.round(size)}
      aria-valuemin={cfg?.collapsible ? (cfg.collapsedSize ?? 0) : cfg?.minSize}
      aria-valuemax={cfg && Number.isFinite(cfg.maxSize) ? cfg.maxSize : undefined}
      data-dragging={dragging || undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onKeyDown={onKeyDown}
      onDoubleClick={() => {
        if (target && cfg?.defaultSize !== undefined) {
          group.setCollapsed(target.id, false);
          group.resize(target.id, cfg.defaultSize, true);
        }
      }}
      className={cn(
        "group/handle relative z-[1] flex shrink-0 items-center justify-center outline-none",
        horizontal ? "w-px cursor-col-resize" : "h-px cursor-row-resize",
        "bg-line-subtle transition-colors duration-150 hover:bg-accent/70 focus-visible:bg-accent data-[dragging]:bg-accent",
        // Generous invisible hit area.
        horizontal
          ? "before:absolute before:inset-y-0 before:-left-1 before:-right-1"
          : "before:absolute before:inset-x-0 before:-top-1 before:-bottom-1",
        "before:content-['']",
        className,
      )}
      {...props}
    />
  );
}

/** Imperative access to a panel from inside its group (e.g. a toolbar button that collapses it). */
export function useResizablePanel(id: string) {
  const group = useGroup("useResizablePanel consumer");
  const cfg = group.config(id);
  const collapsed = group.collapsed.has(id);
  return {
    size: collapsed ? (cfg?.collapsedSize ?? 0) : (group.sizes[id] ?? cfg?.defaultSize ?? 0),
    collapsed,
    collapse: () => group.setCollapsed(id, true),
    expand: () => group.setCollapsed(id, false),
    toggle: () => group.setCollapsed(id, !collapsed),
    resize: (px: number) => group.resize(id, px, true),
  };
}
