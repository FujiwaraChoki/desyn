// @desyn/editor: the Desyn editor. See README.md and ARCHITECTURE.md.

// Collaboration, export / import and present mode (src/collab, src/export, src/present).
export {
  type CollabBackend,
  type CollabExtensionOptions,
  collabExtension,
  createCollabExtension,
  createConvexCollabBackend,
} from "./collab/index.ts";
export {
  buildPasteOps,
  type ClipboardPayload,
  ClipboardService,
  DESYN_MIME,
  encodeHtml,
  parsePayload,
  payloadFromHtml,
  serializeNodes,
} from "./commands/clipboard.ts";
export {
  boundsOf,
  movableIds,
  selectedIds,
  viewCenterInPage,
  visiblePageRect,
} from "./commands/helpers.ts";
// Commands + shortcuts.
export { builtinCommands } from "./commands/index.ts";
export {
  type AnyCommand,
  CATEGORY_LABELS,
  type Command,
  type CommandCategory,
  type CommandIcon,
  CommandRegistry,
  type CommandRunContext,
} from "./commands/registry.ts";
export { BUILTIN_TOOLS, builtinToolDefs, toolCommandId } from "./commands/tools.ts";
export { nextZoom, ZOOM_STEPS } from "./commands/view.ts";
export { evaluateWhen, validateWhen, type WhenContext } from "./commands/when.ts";
export {
  type CommandState,
  EditorProvider,
  useCommand,
  useEditor,
  useEditorStore,
  useRegistryVersion,
  useShortcutLabel,
} from "./context.tsx";
// Controller + React access.
export {
  type ApplyInput,
  type ApplyOptions,
  computeContext,
  EditorController,
  type EditorControllerOptions,
  type Notice,
} from "./controller.ts";
// Root component (apps/web mounts it at /design/[id]).
export { Editor, type EditorProps } from "./editor.tsx";
// Engine bridge.
export { EngineBridge, type EngineBridgeOptions, PASTEBOARD } from "./engine-bridge/bridge.ts";
export { EngineViewport } from "./engine-bridge/viewport.tsx";
export {
  createExportExtension,
  type ExportExtensionOptions,
  type ExportFormat,
  exportExtension,
} from "./export/index.ts";
export { BUILTIN_EXTENSIONS, coreExtension } from "./extensions.ts";
export {
  createPresentExtension,
  PresentDesign,
  type PresentDesignProps,
  Presenter,
  type PresenterProps,
  presentExtension,
  startPresenting,
} from "./present/index.ts";
// Shell + extension points.
export { CommandButton, CommandContextItem, CommandMenuItem } from "./shell/command-items.tsx";
export {
  availableIn,
  type ContextMenuEntry,
  defineExtension,
  type EditorExtension,
  type ExtensionApi,
  ExtensionRegistry,
  type InspectorTab,
  type ModalDef,
  type ModalProps,
  type MultiSlot,
  type RailPanel,
  type SingleSlot,
  type SlotItem,
  type SlotProps,
  type ToolDef,
} from "./shell/extensions.ts";
export { ResizeHandle } from "./shell/resize-handle.tsx";
export { Shell } from "./shell/shell.tsx";
export { DEFAULT_KEYMAP } from "./shortcuts/defaults.ts";
export { installShortcuts } from "./shortcuts/dispatcher.ts";
export {
  comboFromEvent,
  effectiveKeymap,
  findConflicts,
  formatCombo,
  keysFor,
  matchKey,
  normalizeCombo,
} from "./shortcuts/keymap.ts";
// Store.
export {
  type AiDockState,
  type AiHandoff,
  activeTool,
  createEditorStore,
  DEFAULT_PANELS,
  type DocState,
  type EditorMode,
  type EditorState,
  type EditorStore,
  type EditorUser,
  type EngineState,
  type HistoryState,
  type ModalState,
  modeForPermission,
  type PanelState,
  type ToolId,
  type Viewport,
} from "./store/editor-store.ts";
export { History, type HistoryEntry, pruneOps, type RecordOptions } from "./store/history.ts";
// Sync.
export { AssetService, type UploadedAsset } from "./sync/assets.ts";
export {
  type AssetBackend,
  createConvexBackend,
  type EditorBackend,
  type PrefsBackend,
} from "./sync/convex-transport.ts";
export { type ClassifiedError, classifyError } from "./sync/errors.ts";
export {
  defaultPendingStore,
  IndexedDbPendingStore,
  MemoryPendingStore,
  type PendingStore,
  type PersistedQueue,
} from "./sync/pending-store.ts";
export { chunkTxId, splitTransaction } from "./sync/split.ts";
export {
  type ChangeCause,
  type ConflictEvent,
  type RejectedEvent,
  type SyncChange,
  SyncClient,
  type SyncClientOptions,
  type SyncSnapshot,
  type SyncStatus,
  type Telemetry,
} from "./sync/sync-client.ts";
export type { SyncTransport } from "./sync/transport.ts";
export type {
  LoadHeader,
  LoadPage,
  OpEntry,
  Permission,
  ShareArg,
  SinceResult,
} from "./sync/wire.ts";
