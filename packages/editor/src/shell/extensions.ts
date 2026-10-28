import type { ComponentType, ReactNode } from "react";
import type { AnyCommand, CommandIcon } from "../commands/registry.ts";
import type { WhenContext } from "../commands/when.ts";
import type { EditorController } from "../controller.ts";
import type { EditorMode, ToolId } from "../store/editor-store.ts";

/**
 * Extension points of the editor shell. Feature areas (canvas interaction, panels, AI, collaboration, export)
 * are extensions: each registers components into named slots plus its commands, tools and modals. The shell
 * only lays slots out; it never imports a feature directly. See ARCHITECTURE.md for the contract.
 */

/** Props every slot component receives. */
export interface SlotProps {
  editor: EditorController;
}

/** A panel in the left rail; its component renders inside the 320 px flyout. */
export interface RailPanel {
  id: string;
  label: string;
  icon: CommandIcon;
  component: ComponentType<SlotProps>;
  /** Lower first. Built-in order: design 10, elements 20, text 30, brand 40, uploads 50, photos 60, ai 70, layers 80, pages 90. */
  order: number;
  /** Modes where the panel is offered (default: all). */
  modes?: EditorMode[];
  when?: (ctx: WhenContext) => boolean;
}

/** A tab of the right inspector (Design, Arrange, Effects, Animate, Position...). */
export interface InspectorTab {
  id: string;
  label: string;
  component: ComponentType<SlotProps>;
  order: number;
  modes?: EditorMode[];
  /** Shown only when true (e.g. "Animate" needs a selection). */
  when?: (ctx: WhenContext) => boolean;
}

/** Props of a modal component: the editor, the `props` given to `openModal`, and `close`. */
export type ModalProps = SlotProps & { props: Record<string, unknown>; close: () => void };

/** A modal dialog opened with `editor.openModal(id, props)`. */
export interface ModalDef {
  id: string;
  component: ComponentType<ModalProps>;
}

/** A tool shown in the bottom tool dock. Selecting it runs `editor.setTool(id)`. */
export interface ToolDef {
  id: ToolId;
  label: string;
  icon: CommandIcon;
  /** Group in the dock; tools of one group share a slot with a flyout (e.g. shapes). */
  group: string;
  order: number;
  /** Command that activates the tool (for its shortcut hint). */
  command: string;
  modes?: EditorMode[];
}

/**
 * Single-component slots (the last registration wins) and multi-component slots (rendered in `order`).
 *
 * - `canvas.interaction`  (single) pointer layer over the engine canvas: selection, handles, tools, text bridge.
 * - `canvas.overlay`      (multi)  extra layers over the canvas: rulers, guides, comments pins, cursors, AI glow.
 * - `canvas.toolbar`      (single) floating context toolbar above the selection.
 * - `pages`               (single) bottom pages strip.
 * - `ai.dock`             (single) AI prompt bar / chat panel (bottom center).
 * - `topbar.presence`     (multi)  collaborator avatars.
 * - `topbar.actions`      (multi)  extra top bar buttons, left of Share / Export.
 * - `statusbar`           (multi)  small items next to the zoom control.
 * - `root`                (multi)  invisible controllers / global listeners (presence heartbeats, AI runs).
 */
export type SingleSlot = "canvas.interaction" | "canvas.toolbar" | "pages" | "ai.dock";
export type MultiSlot =
  | "canvas.overlay"
  | "topbar.presence"
  | "topbar.actions"
  | "statusbar"
  | "root";

export interface SlotItem {
  id: string;
  component: ComponentType<SlotProps>;
  order?: number;
  modes?: EditorMode[];
}

/** Context menu entries: command references (enablement and labels come from the commands). */
export interface ContextMenuEntry {
  /** Command id, or "-" for a separator. */
  command: string;
  /** Where it applies: on a selection, on empty canvas, or both. */
  target: "selection" | "canvas" | "both";
  order: number;
  args?: unknown;
}

export interface ExtensionApi {
  editor: EditorController;
  registerCommands(commands: AnyCommand[]): void;
  registerRailPanel(panel: RailPanel): void;
  registerInspectorTab(tab: InspectorTab): void;
  registerModal(modal: ModalDef): void;
  registerTool(tool: ToolDef): void;
  registerSlot(slot: SingleSlot | MultiSlot, item: SlotItem): void;
  registerContextMenu(entries: ContextMenuEntry[]): void;
  /** Runs on dispose (unsubscribe listeners, stop timers). */
  onDispose(fn: () => void): void;
}

export interface EditorExtension {
  id: string;
  setup(api: ExtensionApi): void;
}

const SINGLE: ReadonlySet<string> = new Set([
  "canvas.interaction",
  "canvas.toolbar",
  "pages",
  "ai.dock",
]);

type Listener = () => void;

/** Registered extension contributions; the shell subscribes and re-renders on changes. */
export class ExtensionRegistry {
  readonly railPanels: RailPanel[] = [];
  readonly inspectorTabs: InspectorTab[] = [];
  readonly modals = new Map<string, ModalDef>();
  readonly tools: ToolDef[] = [];
  readonly contextMenu: ContextMenuEntry[] = [];
  private readonly single = new Map<string, SlotItem>();
  private readonly multi = new Map<string, SlotItem[]>();
  private readonly listeners = new Set<Listener>();
  private version = 0;

  subscribe = (l: Listener): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  getVersion = (): number => this.version;

  private bump(): void {
    this.version++;
    for (const l of this.listeners) l();
  }

  private upsert<T extends { id: string }>(
    list: T[],
    item: T,
    sortKey?: (t: T) => number,
  ): () => void {
    const i = list.findIndex((x) => x.id === item.id);
    if (i >= 0) list.splice(i, 1, item);
    else list.push(item);
    if (sortKey) list.sort((a, b) => sortKey(a) - sortKey(b));
    this.bump();
    return () => {
      const j = list.indexOf(item);
      if (j >= 0) list.splice(j, 1);
      this.bump();
    };
  }

  addRailPanel(p: RailPanel): () => void {
    return this.upsert(this.railPanels, p, (x) => x.order);
  }

  addInspectorTab(t: InspectorTab): () => void {
    return this.upsert(this.inspectorTabs, t, (x) => x.order);
  }

  addTool(t: ToolDef): () => void {
    return this.upsert(this.tools, t, (x) => x.order);
  }

  addModal(m: ModalDef): () => void {
    this.modals.set(m.id, m);
    this.bump();
    return () => {
      if (this.modals.get(m.id) === m) this.modals.delete(m.id);
      this.bump();
    };
  }

  addContextMenu(entries: ContextMenuEntry[]): () => void {
    this.contextMenu.push(...entries);
    this.contextMenu.sort((a, b) => a.order - b.order);
    this.bump();
    return () => {
      for (const e of entries) {
        const i = this.contextMenu.indexOf(e);
        if (i >= 0) this.contextMenu.splice(i, 1);
      }
      this.bump();
    };
  }

  addSlot(slot: SingleSlot | MultiSlot, item: SlotItem): () => void {
    if (SINGLE.has(slot)) {
      const prev = this.single.get(slot);
      this.single.set(slot, item);
      this.bump();
      return () => {
        if (this.single.get(slot) === item) {
          if (prev) this.single.set(slot, prev);
          else this.single.delete(slot);
        }
        this.bump();
      };
    }
    const list = this.multi.get(slot) ?? [];
    this.multi.set(slot, list);
    return this.upsert(list, item, (x) => x.order ?? 0);
  }

  slot(slot: SingleSlot): SlotItem | undefined {
    return this.single.get(slot);
  }

  slots(slot: MultiSlot): readonly SlotItem[] {
    return this.multi.get(slot) ?? [];
  }
}

/** Helper for extension modules: `export const layersExtension = defineExtension({ ... })`. */
export function defineExtension(extension: EditorExtension): EditorExtension {
  return extension;
}

/** True when an item applies in `mode` (no `modes` = every mode). */
export function availableIn(item: { modes?: EditorMode[] }, mode: EditorMode): boolean {
  return !item.modes || item.modes.includes(mode);
}

export type { ReactNode };
