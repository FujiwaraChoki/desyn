import type { Design, Id } from "@desyn/schema";
import { createStore, type StoreApi } from "zustand/vanilla";
import type { SyncSnapshot } from "../sync/sync-client.ts";
import type { Permission } from "../sync/wire.ts";

/**
 * Editor state (Zustand, vanilla store so non-React code — commands, the engine bridge, tests — reads and
 * writes it directly; React reads it with `useEditorStore(selector)`).
 *
 * The document itself is owned by the sync client; `doc.design` is its current view (confirmed + pending),
 * replaced on every change. Everything else here is local UI state: selection, tool, viewport, hover, panels
 * (persisted per user), modals.
 */

/** `edit` (full editing), `comment` (view + comments), `view` (read-only). */
export type EditorMode = "edit" | "comment" | "view";

export type ToolId =
  | "select"
  | "hand"
  | "frame"
  | "rect"
  | "ellipse"
  | "polygon"
  | "star"
  | "line"
  | "arrow"
  | "pen"
  | "text"
  | "image"
  | "comment"
  // Tools registered by extensions use their own ids.
  | (string & {});

export interface Viewport {
  x: number;
  y: number;
  zoom: number;
  width: number;
  height: number;
}

export type AiDockState = "closed" | "bar" | "expanded";

/** Panel layout, persisted per user (localStorage + profile prefs). */
export interface PanelState {
  /** Open left flyout (rail panel id) or null. */
  left: string | null;
  leftWidth: number;
  inspectorOpen: boolean;
  inspectorWidth: number;
  inspectorTab: string | null;
  pagesOpen: boolean;
  aiDock: AiDockState;
  rulers: boolean;
  layoutGrid: boolean;
  snapping: boolean;
  /** Hide all chrome except the canvas (mod+\). */
  focusMode: boolean;
}

export const DEFAULT_PANELS: PanelState = {
  left: null,
  leftWidth: 320,
  inspectorOpen: true,
  inspectorWidth: 288,
  inspectorTab: null,
  pagesOpen: true,
  aiDock: "bar",
  rulers: false,
  layoutGrid: true,
  snapping: true,
  focusMode: false,
};

export interface ModalState {
  id: string;
  props?: Record<string, unknown>;
}

export interface HistoryState {
  canUndo: boolean;
  canRedo: boolean;
  undoLabel: string | null;
  redoLabel: string | null;
}

export interface EditorUser {
  id: string;
  name: string;
  image: string | null;
}

export interface DocState {
  design: Design | null;
  sync: SyncSnapshot;
}

export interface AiHandoff {
  /** Prompt from the dashboard to prefill (send only when `autoStart`). */
  initialPrompt: string | null;
  autoStart: boolean;
  /** Server run started by the dashboard (the AI dock follows its events). */
  runId: string | null;
}

export interface EngineState {
  status: "idle" | "starting" | "ready" | "unsupported" | "failed";
  message: string | null;
  /** First frame of the current page has been presented. */
  painted: boolean;
}

export interface EditorState {
  designId: string;
  shareToken: string | null;
  exitHref: string;
  /** Permission the server granted (load header); null until loaded. */
  permission: Permission | null;
  mode: EditorMode;
  user: EditorUser | null;
  doc: DocState;
  engine: EngineState;
  /** Selected node ids (document order not guaranteed; use `topLevelSelection` when it matters). */
  selection: Id[];
  /** Current page. */
  pageId: Id | null;
  /** Container the user entered (double-click / Enter): clicks select its children. */
  scopeId: Id | null;
  hover: Id | null;
  tool: ToolId;
  /** Tool active while a key is held (space = hand); wins over `tool`. */
  heldTool: ToolId | null;
  /** Keep the tool after drawing one shape (double-click a tool / shift+key). */
  toolLocked: boolean;
  viewport: Viewport;
  panels: PanelState;
  modal: ModalState | null;
  paletteOpen: boolean;
  /** Text node in edit mode (text bridge active). */
  textEditing: Id | null;
  /** Layer being renamed inline (layers panel). */
  renaming: Id | null;
  /** Narrow window: panels become sheets. */
  compact: boolean;
  history: HistoryState;
  ai: AiHandoff;
  /** User shortcut overrides: command id -> key combos (empty array = unbound). */
  keymap: Record<string, string[]>;
}

export type EditorStore = StoreApi<EditorState>;

export interface InitialEditorState {
  designId: string;
  shareToken?: string | null;
  exitHref: string;
  ai?: Partial<AiHandoff>;
  panels?: Partial<PanelState>;
  keymap?: Record<string, string[]>;
}

const EMPTY_SYNC: SyncSnapshot = {
  status: "loading",
  seq: 0,
  pending: 0,
  online: true,
  header: null,
  error: null,
  retrying: null,
  lastSyncedAt: null,
};

export function createEditorStore(init: InitialEditorState): EditorStore {
  return createStore<EditorState>()(() => ({
    designId: init.designId,
    shareToken: init.shareToken ?? null,
    exitHref: init.exitHref,
    permission: null,
    mode: "view",
    user: null,
    doc: { design: null, sync: EMPTY_SYNC },
    engine: { status: "idle", message: null, painted: false },
    selection: [],
    pageId: null,
    scopeId: null,
    hover: null,
    tool: "select",
    heldTool: null,
    toolLocked: false,
    viewport: { x: 0, y: 0, zoom: 1, width: 0, height: 0 },
    panels: { ...DEFAULT_PANELS, ...init.panels },
    modal: null,
    paletteOpen: false,
    textEditing: null,
    renaming: null,
    compact: false,
    history: { canUndo: false, canRedo: false, undoLabel: null, redoLabel: null },
    ai: {
      initialPrompt: init.ai?.initialPrompt ?? null,
      autoStart: init.ai?.autoStart ?? false,
      runId: init.ai?.runId ?? null,
    },
    keymap: init.keymap ?? {},
  }));
}

/** Mode for a permission: share links and roles map to edit / comment / view. */
export function modeForPermission(permission: Permission | null): EditorMode {
  if (permission === "edit" || permission === "manage") return "edit";
  if (permission === "comment") return "comment";
  return "view";
}

/** The tool in effect (a held tool wins). */
export function activeTool(state: Pick<EditorState, "tool" | "heldTool">): ToolId {
  return state.heldTool ?? state.tool;
}
