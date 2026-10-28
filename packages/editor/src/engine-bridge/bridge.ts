import { diffOps } from "@desyn/doc-ops";
import {
  type EngineApplyResult,
  EngineClient,
  type EngineClientOptions,
  type ExportRequest,
  type ExportResult,
  type Rect,
  type ViewState,
} from "@desyn/engine";
import { type AssetRef, type Design, type Id, newId, type Transaction } from "@desyn/schema";
import type { EngineState, Viewport } from "../store/editor-store.ts";
import type { SyncChange } from "../sync/sync-client.ts";

/**
 * One `@desyn/engine` EngineClient per editor.
 *
 * The sync client owns the document; the engine renders it and normalizes own transactions (layout, text
 * boxes). Every engine mutation runs through `exclusive` (one at a time) so local applies and remote changes
 * reach the engine in a well-defined order:
 *
 * - local edits: `controller.apply` normalizes through the engine, then feeds the engine's `applied` ops to
 *   the sync client (`adoptLocal` records that the engine mirrors the new view);
 * - remote changes: applied directly when they extend the mirrored view linearly, otherwise the engine is
 *   brought to the sync view with a structural diff (rebase, rollback, out-of-order interleavings);
 * - loads / gap reloads: the engine loads the new view.
 *
 * The bridge also feeds assets (signed URLs through `resolveAsset`), follows the current page, mirrors the
 * engine's view state into the store, and owns the canvas element lifecycle (`attach` / `detach`).
 */

export const PASTEBOARD = { dark: "#0e0e0e", light: "#ece8df" } as const;

/**
 * Animates view changes requested by commands (zoom in / out / to 100% / fit / selection). The canvas layer
 * installs one with `setViewAnimator`; wheel, pinch and pans stay direct.
 */
export interface ViewAnimator {
  zoomAt(client: EngineClient, anchor: { x: number; y: number }, zoom: number): void;
  fit(client: EngineClient, target: Rect | Id | undefined, padding: number): void;
}

export interface EngineBridgeOptions {
  /**
   * The sync client's current view. Queued engine work always converges on it (not on the view a change
   * event carried), so a local edit made while a remote change waited in the queue is never reverted.
   */
  currentView?: () => Design | null;
  resolveAsset: (asset: AssetRef) => Promise<string | null>;
  onState: (state: Partial<EngineState>) => void;
  onView: (view: Viewport) => void;
  /** Derived geometry changed after fonts loaded: commit (edit) or adopt locally (read-only). */
  onRelayout: (result: EngineApplyResult) => void;
  telemetry?: (event: string, props: Record<string, unknown>) => void;
  /** Override for tests / alternative hosts. */
  createClient?: (options: EngineClientOptions) => Promise<EngineClient>;
}

export class EngineBridge {
  private client: EngineClient | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  /** The sync view the engine currently mirrors; null = unknown (diff on the next change). */
  private mirrored: Design | null = null;
  private pageId: Id | null = null;
  private readonly fitted = new Set<Id>();
  private theme: keyof typeof PASTEBOARD = "dark";
  private attachToken = 0;
  private offs: (() => void)[] = [];
  private animator: ViewAnimator | null = null;

  constructor(private readonly options: EngineBridgeOptions) {}

  get engine(): EngineClient | null {
    return this.client;
  }

  get ready(): boolean {
    return this.client !== null;
  }

  /** Runs `fn` after every previously queued engine task (errors do not break the chain). */
  exclusive<T>(fn: () => Promise<T> | T): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  /**
   * Creates the engine for a fresh canvas element (a canvas transfers to a worker only once) and loads the
   * current view. Resolves when the engine is ready or failed.
   */
  async attach(canvas: HTMLCanvasElement, current: () => Design | null): Promise<void> {
    const token = ++this.attachToken;
    this.options.onState({ status: "starting", message: null, painted: false });
    const create =
      this.options.createClient ?? ((o: EngineClientOptions) => EngineClient.create(o));
    let client: EngineClient;
    try {
      client = await create({
        canvas,
        render: { background: PASTEBOARD[this.theme], pageShadow: true, budgetMs: 10 },
        resolveAsset: (asset) => this.options.resolveAsset(asset),
      });
    } catch (e) {
      if (token !== this.attachToken) return;
      const message = e instanceof Error ? e.message : String(e);
      const unsupported = /OffscreenCanvas|WebAssembly|SIMD|Worker/i.test(message);
      this.options.onState({ status: unsupported ? "unsupported" : "failed", message });
      this.options.telemetry?.("engine_start_failed", { message });
      return;
    }
    if (token !== this.attachToken) {
      client.dispose();
      return;
    }
    this.client = client;
    // The theme may have changed while the engine was starting (the client was created with the old one).
    client.setRenderOptions({ background: PASTEBOARD[this.theme] });
    this.offs = [
      client.on("view", (v: ViewState) =>
        this.options.onView({ x: v.x, y: v.y, zoom: v.zoom, width: v.width, height: v.height }),
      ),
      client.on("frame", () => this.options.onState({ painted: true })),
      client.on("relayout", (r) => this.options.onRelayout(r)),
      client.on("recovered", ({ message }) =>
        this.options.telemetry?.("engine_recovered", { message }),
      ),
      client.on("fatal", ({ message }) => {
        this.options.onState({ status: "failed", message });
        this.options.telemetry?.("engine_fatal", { message });
      }),
    ];
    await this.exclusive(async () => {
      const design = current();
      if (design) await this.loadInto(client, design);
    });
    if (token === this.attachToken) this.options.onState({ status: "ready" });
  }

  /** Disposes the engine (unmount). A later `attach` needs a new canvas element. */
  detach(): void {
    this.attachToken++;
    for (const off of this.offs.splice(0)) off();
    this.client?.dispose();
    this.client = null;
    this.mirrored = null;
    this.fitted.clear();
    this.options.onState({ status: "idle", painted: false });
  }

  private async loadInto(client: EngineClient, design: Design): Promise<void> {
    await client.load(design);
    this.mirrored = design;
    const pages = client.pages;
    if (!this.pageId || !pages.some((p) => p.id === this.pageId))
      this.pageId = pages[0]?.id ?? null;
    this.showPage(client);
  }

  private showPage(client: EngineClient): void {
    if (!this.pageId) return;
    client.setRenderOptions({ pageId: this.pageId });
    if (!this.fitted.has(this.pageId)) {
      this.fitted.add(this.pageId);
      client.fit(this.pageId, 64);
    }
  }

  /** Shows a page (fits it the first time it is shown). */
  setPage(pageId: Id | null): void {
    if (pageId === this.pageId) return;
    this.pageId = pageId;
    if (this.client) this.showPage(this.client);
  }

  setTheme(theme: "dark" | "light"): void {
    this.theme = theme;
    this.client?.setRenderOptions({ background: PASTEBOARD[theme] });
  }

  /** Nodes drawn by a DOM overlay instead (text being edited). */
  setHidden(ids: Id[]): void {
    this.client?.setRenderOptions({ hidden: ids });
  }

  // ---------------------------------------------------------------------------------------------------------
  // Document feeding

  /** Normalizes and applies an own transaction (call inside `exclusive`). Null when the engine is not up. */
  async applyLocal(tx: Transaction, normalize: boolean): Promise<EngineApplyResult | null> {
    if (!this.client) return null;
    return await this.client.apply(tx, { normalize });
  }

  /**
   * After an own change reached the sync client: the engine now mirrors `after` if it mirrored `before`;
   * otherwise its relation to the sync view is unknown and the next change diffs.
   */
  adoptLocal(before: Design | null, after: Design | null): void {
    this.mirrored = this.mirrored !== null && this.mirrored === before ? after : null;
  }

  /** Feeds a sync change to the engine (queued behind running engine work). */
  onDocChange(change: SyncChange): void {
    if (change.cause === "local") return; // own edits reach the engine through applyLocal / adoptLocal
    void this.exclusive(async () => {
      const client = this.client;
      if (!client) {
        this.mirrored = null;
        return;
      }
      const target = this.options.currentView?.() ?? change.view;
      if (change.cause === "load" || change.cause === "reload") {
        await this.loadInto(client, target);
        return;
      }
      if (target === this.mirrored) return;
      if (
        change.linear &&
        change.view === target &&
        change.prevView !== null &&
        change.prevView === this.mirrored
      ) {
        for (const tx of change.remote) await client.apply(tx, { normalize: false });
      } else {
        const ops = diffOps(client.design, target);
        if (ops.length > 0) {
          await client.apply(
            { id: newId(), label: "Sync", ops, source: "system", ts: Date.now() },
            { normalize: false },
          );
        }
      }
      this.mirrored = target;
      // A page may have been added / removed remotely.
      if (this.pageId && !client.pages.some((p) => p.id === this.pageId)) {
        this.pageId = client.pages[0]?.id ?? null;
        this.showPage(client);
      }
    });
  }

  // ---------------------------------------------------------------------------------------------------------
  // Preview (drags, live inspector scrubs)

  async preview(tx: Transaction, normalize = true): Promise<EngineApplyResult | null> {
    if (!this.client) return null;
    return await this.client.preview(tx, { normalize });
  }

  async cancelPreview(): Promise<void> {
    if (this.client) await this.client.cancelPreview();
  }

  // ---------------------------------------------------------------------------------------------------------
  // View

  /** Installs the animator for command-driven view changes; returns its uninstaller. */
  setViewAnimator(animator: ViewAnimator | null): () => void {
    this.animator = animator;
    return () => {
      if (this.animator === animator) this.animator = null;
    };
  }

  zoomAt(anchor: { x: number; y: number }, zoom: number): void {
    const client = this.client;
    if (!client) return;
    if (this.animator) this.animator.zoomAt(client, anchor, zoom);
    else client.zoomAt(anchor, zoom);
  }

  panBy(dx: number, dy: number): void {
    this.client?.panBy(dx, dy);
  }

  fit(target?: Rect | Id, padding = 64): void {
    const client = this.client;
    if (!client) return;
    if (this.animator) this.animator.fit(client, target, padding);
    else client.fit(target, padding);
  }

  /** Engine bounds (page coordinates) of nodes, null for unknown ids. */
  async bounds(ids: Id[]): Promise<(Rect | null)[]> {
    if (!this.client) return ids.map(() => null);
    return await this.client.bounds(ids);
  }

  async export(req: ExportRequest): Promise<ExportResult> {
    if (!this.client) throw new Error("The rendering engine is not running.");
    return await this.client.export(req);
  }
}
