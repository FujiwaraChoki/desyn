import { createdIds, DocOpsError, makeTransaction, pageOf, pages } from "@desyn/doc-ops";
import type { EngineClient } from "@desyn/engine";
import {
  type ApplyResult,
  type Design,
  type Id,
  type Node,
  newId,
  type Op,
  type PageNode,
  ROOT_ID,
  type Transaction,
  type TransactionActor,
  type TransactionSource,
} from "@desyn/schema";
import type { ConvexReactClient } from "convex/react";
import { ClipboardService } from "./commands/clipboard.ts";
import { builtinCommands } from "./commands/index.ts";
import { CommandRegistry } from "./commands/registry.ts";
import type { WhenContext } from "./commands/when.ts";
import { EngineBridge, type EngineBridgeOptions } from "./engine-bridge/bridge.ts";
import { type EditorExtension, type ExtensionApi, ExtensionRegistry } from "./shell/extensions.ts";
import {
  type AiHandoff,
  activeTool,
  createEditorStore,
  type EditorState,
  type EditorStore,
  modeForPermission,
  type PanelState,
  type ToolId,
} from "./store/editor-store.ts";
import { History, type HistoryEntry } from "./store/history.ts";
import { PrefsSync, pickPersistedPanels } from "./store/prefs.ts";
import { AssetService } from "./sync/assets.ts";
import type { EditorBackend } from "./sync/convex-transport.ts";
import type { PendingStore } from "./sync/pending-store.ts";
import { defaultPendingStore } from "./sync/pending-store.ts";
import {
  type SyncChange,
  SyncClient,
  type SyncClientOptions,
  type Telemetry,
} from "./sync/sync-client.ts";
import type { ShareArg } from "./sync/wire.ts";

/**
 * The editor instance. One per open design (and per <Editor/> mount). Owns:
 *
 * - `store`      Zustand store (document view, selection, tool, viewport, panels, modals, history flags);
 * - `sync`       the Convex sync client (DOCUMENT_MODEL §6);
 * - `history`    per-user undo / redo;
 * - `engine`     the engine bridge (one EngineClient, created when the canvas mounts);
 * - `commands`   the command registry (built-ins + extensions);
 * - `extensions` slot contributions of feature areas;
 * - `assets`, `clipboard`.
 *
 * All edits go through `apply` (or `preview` + `commitPreview` for gestures): it normalizes through the
 * engine, applies optimistically, queues for the server and records one undo step.
 */

export interface Notice {
  kind: "info" | "success" | "warning" | "error";
  title: string;
  description?: string;
}

export interface ApplyOptions {
  /** History label (and transaction label) when `input` is ops or a builder. */
  label?: string;
  /** Record an undo step (default true). */
  history?: boolean;
  /** Merge with the previous step when it has the same key (scrubs, nudges, typing). */
  coalesceKey?: string;
  /** Run engine layout normalization (default true). Undo / redo pass false. */
  normalize?: boolean;
  /** Selection after the edit. */
  select?: Id[];
  /** Select the subtree roots the transaction created (duplicate, group, paste). */
  selectCreated?: boolean;
  source?: TransactionSource;
  actor?: TransactionActor;
  /** Allow in view / comment mode (system bookkeeping only). */
  system?: boolean;
}

export type ApplyInput =
  | Transaction
  | Op[]
  /** Built against the freshest view (inside the edit lock); return null to skip. */
  | ((design: Design, state: EditorState) => Transaction | Op[] | null);

export interface EditorControllerOptions {
  designId: string;
  shareToken?: string | null;
  exitHref: string;
  backend: EditorBackend;
  pendingStore?: PendingStore;
  telemetry?: Telemetry;
  ai?: Partial<AiHandoff>;
  extensions?: EditorExtension[];
  /** Navigation (exit, present). Default: `window.location.assign`. */
  navigate?: (href: string) => void;
  /** User-facing notices (the shell passes @desyn/ui toasts). */
  notify?: (notice: Notice) => void;
  engine?: Pick<EngineBridgeOptions, "createClient">;
  /** Convex client for extensions that call other backend functions (presence, comments, exports, AI). */
  convex?: ConvexReactClient | null;
  /** Share-link access passed to every design function (`share` argument). */
  share?: ShareArg;
  sync?: Pick<SyncClientOptions, "retry" | "random" | "resubscribeAt" | "loadAttempts">;
}

export class EditorController {
  readonly store: EditorStore;
  readonly sync: SyncClient;
  readonly history = new History();
  readonly commands: CommandRegistry;
  readonly extensions = new ExtensionRegistry();
  readonly engine: EngineBridge;
  readonly assets: AssetService;
  readonly clipboard: ClipboardService;
  readonly backend: EditorBackend;
  /** Convex client (null in tests / other hosts). Extensions may also use convex/react hooks directly. */
  readonly convex: ConvexReactClient | null;
  /** `share` argument for design functions when opened through a share link. */
  readonly share: ShareArg | undefined;
  private readonly telemetryFn: Telemetry;
  private readonly navigateFn: (href: string) => void;
  private readonly notifyFn: (notice: Notice) => void;
  private readonly disposers: (() => void)[] = [];
  private prefs: PrefsSync | null = null;
  private previewTx: Transaction | null = null;
  private contextCache = new WeakMap<EditorState, WhenContext>();
  private started = false;
  private disposed = false;

  constructor(options: EditorControllerOptions) {
    this.backend = options.backend;
    this.convex = options.convex ?? null;
    this.share = options.share;
    this.telemetryFn = options.telemetry ?? dispatchTelemetry;
    this.navigateFn = options.navigate ?? ((href) => window.location.assign(href));
    this.notifyFn = options.notify ?? (() => {});
    this.store = createEditorStore({
      designId: options.designId,
      shareToken: options.shareToken ?? null,
      exitHref: options.exitHref,
      ...(options.ai ? { ai: options.ai } : {}),
    });
    this.sync = new SyncClient({
      designId: options.designId,
      transport: options.backend.sync,
      // Queues are per user: another account in this browser never replays them.
      pendingStore:
        options.pendingStore ?? defaultPendingStore(() => this.getState().user?.id ?? "anon"),
      telemetry: (event, props) => this.telemetry(event, props),
      ...options.sync,
    });
    this.assets = new AssetService(
      options.backend.assets,
      () => this.sync.loadHeader?.workspaceId ?? null,
    );
    this.engine = new EngineBridge({
      currentView: () => this.sync.view,
      resolveAsset: (asset) => this.assets.urlFor(asset),
      onState: (patch) => this.store.setState((s) => ({ engine: { ...s.engine, ...patch } })),
      onView: (viewport) => this.store.setState({ viewport }),
      onRelayout: (r) => void this.adoptRelayout(r.applied),
      telemetry: (event, props) => this.telemetry(event, props),
      ...(options.engine?.createClient ? { createClient: options.engine.createClient } : {}),
    });
    this.commands = new CommandRegistry(() => this);
    this.clipboard = new ClipboardService(this);
    this.commands.register(builtinCommands());

    this.disposers.push(
      this.sync.on("change", (c) => this.onDocChange(c)),
      this.sync.on("status", (snapshot) => {
        const header = snapshot.header;
        this.store.setState((s) => {
          const permission = header?.permission ?? s.permission;
          return {
            doc: { ...s.doc, sync: snapshot },
            permission,
            mode: modeForPermission(permission),
          };
        });
      }),
      this.sync.on("rejected", ({ tx, message }) =>
        this.notify({
          kind: "error",
          title: `Couldn't save "${tx.label}"`,
          description: `${message} The change was undone.`,
        }),
      ),
      this.history.subscribe(() => this.store.setState({ history: this.history.state() })),
    );
    for (const ext of options.extensions ?? []) this.installExtension(ext);
  }

  // ---------------------------------------------------------------------------------------------------------
  // Lifecycle

  /** Loads the user, preferences and the design. Safe to call once. */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    const user = await this.backend.me().catch(() => null);
    if (this.disposed) return;
    if (user) {
      this.store.setState({ user: { id: user.userId, name: user.name, image: user.image } });
    }
    this.prefs = new PrefsSync(user?.userId ?? "anon", user ? this.backend.prefs : null);
    const prefs = await this.prefs.load();
    if (this.disposed) return;
    if (prefs) {
      this.store.setState((s) => ({
        panels: { ...s.panels, ...prefs.panels },
        keymap: prefs.keymap,
      }));
    }
    this.disposers.push(
      this.store.subscribe((s, prev) => {
        if (s.panels !== prev.panels || s.keymap !== prev.keymap) {
          this.prefs?.save({ panels: pickPersistedPanels(s.panels), keymap: s.keymap });
        }
      }),
    );
    await this.sync.start();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    for (const d of this.disposers.splice(0).reverse()) {
      try {
        d();
      } catch {
        // A failing disposer must not keep the others from running.
      }
    }
    this.engine.detach();
    await Promise.all([this.sync.stop(), this.prefs?.flush()]);
  }

  /** Installs an extension (commands, slots, panels, tools, modals). */
  installExtension(ext: EditorExtension): void {
    const offs: (() => void)[] = [];
    const reg = this.extensions;
    const api: ExtensionApi = {
      editor: this,
      registerCommands: (cmds) => offs.push(this.commands.register(cmds)),
      registerRailPanel: (p) => offs.push(reg.addRailPanel(p)),
      registerInspectorTab: (t) => offs.push(reg.addInspectorTab(t)),
      registerModal: (m) => offs.push(reg.addModal(m)),
      registerTool: (t) => offs.push(reg.addTool(t)),
      registerSlot: (slot, item) => offs.push(reg.addSlot(slot, item)),
      registerContextMenu: (entries) => offs.push(reg.addContextMenu(entries)),
      onDispose: (fn) => offs.push(fn),
    };
    ext.setup(api);
    this.disposers.push(() => {
      for (const off of offs.reverse()) off();
    });
  }

  // ---------------------------------------------------------------------------------------------------------
  // State access

  getState(): EditorState {
    return this.store.getState();
  }

  /** The current document view (confirmed + pending); null before load. */
  get design(): Design | null {
    return this.store.getState().doc.design;
  }

  get canEdit(): boolean {
    return this.getState().mode === "edit";
  }

  /** The EngineClient when the canvas is up (hit tests, snapping, text layout for the canvas layer). */
  get engineClient(): EngineClient | null {
    return this.engine.engine;
  }

  currentPage(): PageNode | null {
    const { pageId } = this.getState();
    const d = this.design;
    const n = d && pageId ? d.nodes[pageId] : undefined;
    return n?.type === "page" ? n : null;
  }

  selectedNodes(): Node[] {
    const d = this.design;
    if (!d) return [];
    return this.getState()
      .selection.map((id) => d.nodes[id])
      .filter((n): n is Node => !!n);
  }

  /** Keys for when-clauses (cached per store state). */
  context(): WhenContext {
    return this.contextFor(this.getState());
  }

  contextFor(s: EditorState): WhenContext {
    const cached = this.contextCache.get(s);
    if (cached) return cached;
    const ctx = computeContext(s, this.clipboard.hasContent());
    this.contextCache.set(s, ctx);
    return ctx;
  }

  telemetry(event: string, props: Record<string, unknown> = {}): void {
    try {
      this.telemetryFn(event, props);
    } catch {
      // Telemetry never breaks editing.
    }
  }

  notify(notice: Notice): void {
    this.notifyFn(notice);
  }

  navigate(href: string): void {
    this.navigateFn(href);
  }

  // ---------------------------------------------------------------------------------------------------------
  // Editing

  /**
   * Applies an own edit: engine normalization, optimistic apply, server queue, one undo step. Resolves to the
   * doc-ops result (null when nothing happened, e.g. read-only or a builder refused).
   */
  apply(input: ApplyInput, options: ApplyOptions = {}): Promise<ApplyResult | null> {
    if (!options.system && !this.canEdit) {
      this.notifyReadOnly();
      return Promise.resolve(null);
    }
    return this.engine.exclusive(() => {
      const design = this.sync.view;
      if (!design) return null;
      let built: Transaction | Op[] | null;
      try {
        built = typeof input === "function" ? input(design, this.getState()) : input;
      } catch (e) {
        if (e instanceof DocOpsError) {
          this.notify({ kind: "warning", title: friendlyDocOpsMessage(e.message) });
          return null;
        }
        throw e;
      }
      if (!built) return null;
      const tx = Array.isArray(built)
        ? makeTransaction(built, options.label ?? "Edit", {
            source: options.source ?? "user",
            ...(options.actor ? { actor: options.actor } : {}),
          })
        : options.label
          ? { ...built, label: options.label }
          : built;
      if (tx.ops.length === 0) return null;
      return this.commitUnlocked(tx, options);
    });
  }

  /** Inside the edit lock: engine normalize, sync apply, history. */
  private async commitUnlocked(
    tx: Transaction,
    options: ApplyOptions,
  ): Promise<ApplyResult | null> {
    const state = this.getState();
    const before = this.sync.view;
    let normalized: Awaited<ReturnType<EngineBridge["applyLocal"]>> = null;
    let engineFailed = false;
    try {
      normalized = await this.engine.applyLocal(tx, options.normalize ?? true);
    } catch (e) {
      // A crashed engine must not lose the edit: commit it as is; the engine catches up (or reloads).
      engineFailed = true;
      this.telemetry("engine_apply_failed", { error: e instanceof Error ? e.name : typeof e });
    }
    const syncBefore = this.sync.view;
    const committed = normalized ? { ...tx, ops: normalized.applied } : tx;
    const result = this.sync.applyLocal(committed);
    this.engine.adoptLocal(
      engineFailed ? null : normalized ? (before === syncBefore ? before : null) : syncBefore,
      this.sync.view,
    );
    if (result.applied.length === 0) return result;
    const created = options.selectCreated ? createdIds(committed) : null;
    const selectAfter = options.select ?? (created && created.length > 0 ? created : undefined);
    if (options.history !== false) {
      const after = selectAfter ?? this.getState().selection;
      const entry: HistoryEntry = {
        id: tx.id,
        label: tx.label,
        forward: { ...committed, ops: result.applied },
        inverse: result.inverse,
        ts: Date.now(),
        selectionBefore: state.selection,
        selectionAfter: after,
        pageBefore: state.pageId,
        pageAfter: this.getState().pageId,
        ...(tx.actor?.runId ? { runId: tx.actor.runId } : {}),
      };
      this.history.record(entry, options.coalesceKey ? { coalesceKey: options.coalesceKey } : {});
    }
    if (selectAfter) this.select(selectAfter);
    return result;
  }

  /** Live preview of a gesture (drag, resize, scrub). Not committed until `commitPreview`. */
  async preview(tx: Transaction, options: { normalize?: boolean } = {}): Promise<void> {
    if (!this.canEdit) return;
    this.previewTx = tx;
    await this.engine.preview(tx, options.normalize ?? true);
  }

  /** Commits the active preview as one transaction and one undo step. */
  commitPreview(options: ApplyOptions & { label: string }): Promise<ApplyResult | null> {
    if (!this.canEdit) return Promise.resolve(null);
    return this.engine.exclusive(async () => {
      const last = this.previewTx;
      this.previewTx = null;
      const client = this.engine.engine;
      if (!client) {
        // No engine (still starting): commit the last previewed transaction directly.
        return last ? this.commitUnlocked({ ...last, label: options.label }, options) : null;
      }
      const state = this.getState();
      const before = this.sync.view;
      const r = await client.commitPreview({ label: options.label });
      if (!r || r.applied.length === 0) return null;
      const syncBefore = this.sync.view;
      const tx = makeTransaction(r.applied, options.label, {
        source: options.source ?? "user",
        ...(options.actor ? { actor: options.actor } : {}),
      });
      const result = this.sync.applyLocal(tx);
      this.engine.adoptLocal(before === syncBefore ? before : null, this.sync.view);
      if (result.applied.length > 0 && options.history !== false) {
        this.history.record(
          {
            id: tx.id,
            label: tx.label,
            forward: { ...tx, ops: result.applied },
            inverse: result.inverse,
            ts: Date.now(),
            selectionBefore: state.selection,
            selectionAfter: options.select ?? state.selection,
            pageBefore: state.pageId,
            pageAfter: state.pageId,
          },
          options.coalesceKey ? { coalesceKey: options.coalesceKey } : {},
        );
      }
      if (options.select) this.select(options.select);
      return result;
    });
  }

  async cancelPreview(): Promise<void> {
    this.previewTx = null;
    await this.engine.cancelPreview();
  }

  /** Undoes the last own step (skips steps a collaborator fully overwrote). */
  undo(): Promise<boolean> {
    return this.step("undo");
  }

  redo(): Promise<boolean> {
    return this.step("redo");
  }

  private step(direction: "undo" | "redo"): Promise<boolean> {
    if (!this.canEdit) return Promise.resolve(false);
    this.history.seal();
    return this.engine.exclusive(async () => {
      let entry: HistoryEntry | undefined;
      for (;;) {
        entry = direction === "undo" ? this.history.takeUndo() : this.history.takeRedo();
        if (!entry || entry.inverse.ops.length > 0) break;
      }
      if (!entry) return false;
      const tx: Transaction = {
        ...entry.inverse,
        // Fresh ids: the server is idempotent on tx.id, and undo / redo / undo must all reach it.
        id: newId(),
        label: `${direction === "undo" ? "Undo" : "Redo"} ${entry.label}`,
        source: "user",
        ts: Date.now(),
      };
      const result = await this.commitUnlocked(tx, { history: false, normalize: false });
      const back: HistoryEntry = {
        ...entry,
        forward: { ...tx, ops: result?.applied ?? [] },
        inverse: result?.inverse ?? { ...tx, ops: [] },
        ts: Date.now(),
      };
      if (direction === "undo") this.history.pushRedo(back);
      else this.history.pushUndo(back);
      const design = this.sync.view;
      const page = direction === "undo" ? entry.pageBefore : entry.pageAfter;
      if (design && page && design.nodes[page]?.type === "page") this.setPage(page);
      this.select(direction === "undo" ? entry.selectionBefore : entry.selectionAfter);
      // Labels can quote the user's AI prompt: only the kind of step is reported.
      this.telemetry(`history_${direction}`, { ai: !!entry.runId });
      return true;
    });
  }

  /** Engine relayout after font loads: committed as a system transaction (no undo step). */
  private adoptRelayout(ops: Op[]): Promise<void> {
    if (ops.length === 0) return Promise.resolve();
    return this.engine.exclusive(() => {
      const before = this.sync.view;
      if (!before) return;
      const tx = makeTransaction(ops, "Layout", { source: "system" });
      if (this.canEdit) this.sync.applyLocal(tx);
      else this.sync.applyLocalOnly(tx);
      this.engine.adoptLocal(before, this.sync.view);
    });
  }

  private notifyReadOnly(): void {
    const mode = this.getState().mode;
    this.notify({
      kind: "info",
      title: mode === "comment" ? "You can comment on this design" : "This design is view only",
      description: "Ask the owner for edit access to change it.",
    });
  }

  // ---------------------------------------------------------------------------------------------------------
  // Sync -> store

  private onDocChange(change: SyncChange): void {
    if (change.cause === "remote") this.foldRemoteIntoHistory(change);
    const design = change.view;
    this.store.setState((s) => {
      const next: Partial<EditorState> = { doc: { ...s.doc, design } };
      const pageIds = pages(design).map((p) => p.id);
      let pageId = s.pageId;
      if (!pageId || !pageIds.includes(pageId)) pageId = pageIds[0] ?? null;
      if (pageId !== s.pageId) next.pageId = pageId;
      const selection = s.selection.filter((id) => !!design.nodes[id]);
      if (selection.length !== s.selection.length) next.selection = selection;
      if (s.scopeId && !design.nodes[s.scopeId]) next.scopeId = null;
      if (s.hover && !design.nodes[s.hover]) next.hover = null;
      if (s.textEditing && !design.nodes[s.textEditing]) next.textEditing = null;
      return next;
    });
    this.engine.setPage(this.getState().pageId);
    this.engine.onDocChange(change);
  }

  /**
   * Remote transactions and the undo history. Collaborators' edits prune the stacks so undo never reverts
   * what they changed since (own echoes are acks, not remote). Transactions of the user's own server-run AI
   * agent or workflow (`designs.commitAs` with `actor.userId` = this user and an `actor.runId`) are the
   * user's steps: they are recorded, one undo step per run (§6).
   */
  private foldRemoteIntoHistory(change: SyncChange): void {
    const s = this.getState();
    const me = s.user?.id;
    change.remote.forEach((tx, i) => {
      const inverse = change.remoteInverses[i];
      const runId = tx.actor?.runId;
      const ownRun =
        !!me &&
        tx.actor?.userId === me &&
        !!runId &&
        (tx.source === "ai" || tx.source === "workflow");
      if (!ownRun || !inverse) {
        this.history.rebaseRemote(tx);
        return;
      }
      if (tx.ops.length === 0) return;
      this.history.record({
        id: tx.id,
        label: tx.label,
        forward: tx,
        inverse,
        ts: Date.now(),
        selectionBefore: s.selection,
        selectionAfter: s.selection,
        pageBefore: s.pageId,
        pageAfter: s.pageId,
        runId,
      });
    });
  }

  // ---------------------------------------------------------------------------------------------------------
  // Selection, pages, tools, panels

  /** Sets the selection (unknown ids and the root are ignored). Switches to the page of the first node. */
  select(ids: readonly Id[]): void {
    const design = this.design;
    if (!design) return;
    const seen = new Set<Id>();
    const valid = ids.filter((id) => {
      if (id === ROOT_ID || seen.has(id) || !design.nodes[id]) return false;
      seen.add(id);
      return true;
    });
    const first = valid[0];
    const page = first ? pageOf(design, first) : undefined;
    this.store.setState((s) => {
      const next: Partial<EditorState> = { selection: valid };
      if (page && page.id !== s.pageId) {
        next.pageId = page.id;
        next.scopeId = null;
      }
      return next;
    });
    this.engine.setPage(this.getState().pageId);
  }

  /** Toggles ids in the selection (shift+click). */
  toggleSelection(ids: readonly Id[]): void {
    const current = new Set(this.getState().selection);
    for (const id of ids) {
      if (current.has(id)) current.delete(id);
      else current.add(id);
    }
    this.select([...current]);
  }

  clearSelection(): void {
    this.store.setState({ selection: [], scopeId: null });
  }

  setPage(pageId: Id): void {
    const design = this.design;
    if (design?.nodes[pageId]?.type !== "page") return;
    this.store.setState((s) => ({
      pageId,
      scopeId: null,
      selection: s.selection.filter((id) => pageOf(design, id)?.id === pageId),
    }));
    this.engine.setPage(pageId);
  }

  setTool(tool: ToolId, options: { locked?: boolean } = {}): void {
    const { mode } = this.getState();
    const allowed =
      mode === "edit" ||
      tool === "select" ||
      tool === "hand" ||
      (mode === "comment" && tool === "comment");
    if (!allowed) {
      this.notifyReadOnly();
      return;
    }
    this.store.setState({ tool, toolLocked: options.locked ?? false });
  }

  /** Temporary tool while a key is held (space = hand). */
  holdTool(tool: ToolId | null): void {
    this.store.setState({ heldTool: tool });
  }

  get tool(): ToolId {
    return activeTool(this.getState());
  }

  setPanels(patch: Partial<PanelState>): void {
    this.store.setState((s) => ({ panels: { ...s.panels, ...patch } }));
  }

  /** Opens a rail flyout (or closes it when it is already open). */
  toggleLeftPanel(id: string, open?: boolean): void {
    const current = this.getState().panels.left;
    const next = (open ?? current !== id) ? id : null;
    this.setPanels({ left: next });
  }

  openModal(id: string, props?: Record<string, unknown>): void {
    this.store.setState({ modal: props ? { id, props } : { id }, paletteOpen: false });
  }

  closeModal(): void {
    this.store.setState({ modal: null });
  }

  setKeymap(keymap: Record<string, string[]>): void {
    this.store.setState({ keymap });
  }

  setTextEditing(nodeId: Id | null): void {
    this.store.setState({ textEditing: nodeId });
  }
}

function friendlyDocOpsMessage(message: string): string {
  const m = message.replace(/^[A-Za-z]+:\s*/, "");
  return m.charAt(0).toUpperCase() + m.slice(1);
}

/** Default telemetry: a DOM event the host app can forward (`desyn:editor-telemetry`). */
function dispatchTelemetry(event: string, props: Record<string, unknown>): void {
  if (typeof window === "undefined" || typeof CustomEvent === "undefined") return;
  window.dispatchEvent(new CustomEvent("desyn:editor-telemetry", { detail: { event, props } }));
}

const CONTAINERS: ReadonlySet<string> = new Set(["frame", "group", "boolean", "page"]);

/** When-clause keys (documented in ARCHITECTURE.md). */
export function computeContext(s: EditorState, clipboard: boolean): WhenContext {
  const design = s.doc.design;
  const nodes = design
    ? s.selection.map((id) => design.nodes[id]).filter((n): n is Node => !!n)
    : [];
  const single = nodes.length === 1 ? nodes[0] : undefined;
  const pageIds = design ? pages(design).map((p) => p.id) : [];
  const pageIndex = s.pageId ? pageIds.indexOf(s.pageId) : -1;
  const nonPage = nodes.filter((n) => n.type !== "page");
  return {
    loaded: !!design,
    mode: s.mode,
    canEdit: s.mode === "edit" && !!design,
    canComment: (s.mode === "edit" || s.mode === "comment") && !!design,
    readOnly: s.mode !== "edit",
    signedIn: !!s.user,
    isShare: !!s.shareToken,
    hasSelection: nodes.length > 0,
    selectionCount: nodes.length,
    singleSelection: nodes.length === 1,
    multiSelection: nodes.length > 1,
    selectionType: single?.type ?? null,
    selectionIsPage: nodes.length > 0 && nodes.every((n) => n.type === "page"),
    selectionHasNodes: nonPage.length > 0,
    selectionHasContainer: nonPage.some((n) => CONTAINERS.has(n.type)),
    selectionHasGroup: nonPage.some((n) => n.type === "group" || n.type === "boolean"),
    selectionAllLocked: nonPage.length > 0 && nonPage.every((n) => n.locked),
    selectionAllHidden: nonPage.length > 0 && nonPage.every((n) => !n.visible),
    selectionHasText: nonPage.some((n) => n.type === "text"),
    selectionHasImage: nonPage.some((n) => n.type === "image"),
    inScope: !!s.scopeId,
    textEditing: !!s.textEditing,
    tool: activeTool(s),
    canUndo: s.history.canUndo,
    canRedo: s.history.canRedo,
    undoLabel: s.history.undoLabel,
    redoLabel: s.history.redoLabel,
    selectionHasAutoLayout: nonPage.some((n) => n.type === "frame" && !!n.layout),
    pageCount: pageIds.length,
    pageIndex,
    hasPrevPage: pageIndex > 0,
    hasNextPage: pageIndex >= 0 && pageIndex < pageIds.length - 1,
    multiplePages: pageIds.length > 1,
    zoom: s.viewport.zoom,
    modalOpen: !!s.modal,
    paletteOpen: s.paletteOpen,
    compact: s.compact,
    focusMode: s.panels.focusMode,
    rulers: s.panels.rulers,
    layoutGrid: s.panels.layoutGrid,
    snapping: s.panels.snapping,
    inspectorOpen: s.panels.inspectorOpen,
    pagesOpen: s.panels.pagesOpen,
    aiDock: s.panels.aiDock,
    leftPanel: s.panels.left,
    online: s.doc.sync.online,
    syncing: s.doc.sync.pending > 0,
    engineReady: s.engine.status === "ready",
    clipboardHasContent: clipboard,
  };
}
