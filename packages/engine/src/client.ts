// EngineClient: the main-thread face of the engine. Starts the worker (or the main-thread fallback when
// OffscreenCanvas is unavailable), keeps a mirror of the committed design for synchronous reads, tracks the
// canvas size / device-pixel ratio, resolves assets, and exposes typed, parsed engine calls.
import { applyTransaction } from "@desyn/doc-ops";
import type {
  ApplyResult,
  AssetRef,
  Description,
  Design,
  Id,
  Issue,
  Transaction,
} from "@desyn/schema";
import { designFontNeeds } from "./fonts";
import { ENGINE_WORKER_METHODS, EngineHost } from "./host";
import type {
  DescribeRequest,
  EngineApplyResult,
  EngineEvents,
  EngineInfo,
  EngineUrls,
  EngineWorkerApi,
  ExportRequest,
  ExportResult,
  FontLoaderOptions,
  FrameInfo,
  HandlesRequest,
  HandlesResult,
  HitOptions,
  HitRequest,
  HitResult,
  LoadInfo,
  MarqueeRequest,
  MeasureItem,
  MeasureResult,
  PageInfo,
  Point,
  Rect,
  RenderOptions,
  ResizeRequest,
  ResizeResult,
  RotateRequest,
  SnapRequest,
  SnapResult,
  TextLayoutInfo,
  TextOutline,
  TextQuery,
  TextQueryResult,
  ViewState,
} from "./protocol";
import { createLocalChannel, createRpcClient, exposeRpc, type RpcClient, transfer } from "./rpc";
import { fitRect, pageToScreen, panBy, screenToPage, snapToDevice, zoomAt } from "./viewport";

/** Where an asset's bytes come from: a URL (fetched in the worker), bytes, a Blob, or nothing (skip). */
export type AssetSource = string | Uint8Array | Blob | null | undefined;
export type AssetResolver = (asset: AssetRef) => AssetSource | Promise<AssetSource>;

export interface EngineClientOptions {
  /** The canvas to draw into (sized with CSS; the engine sets its backing store). */
  canvas: HTMLCanvasElement;
  /** `auto` (default): worker + OffscreenCanvas when available, else the main thread. */
  mode?: "auto" | "worker" | "main";
  /** Custom worker factory (default: `new Worker(new URL("./worker.ts", import.meta.url), { type: "module" })`). */
  createWorker?: () => Worker;
  urls?: Partial<EngineUrls>;
  render?: RenderOptions;
  fonts?: FontLoaderOptions;
  /** Longest wait for a design's fonts before its first frame (ms). */
  fontWaitMs?: number;
  /** Resolves asset bytes (default: `AssetRef.url`). */
  resolveAsset?: AssetResolver;
  /** Track the canvas size and device-pixel ratio (default true). */
  autoResize?: boolean;
}

/** Client-side events in addition to the worker's. */
export interface ClientEvents extends EngineEvents {
  /** The committed design mirror changed (apply, commitPreview, relayout, load). */
  change: { design: Design; result: EngineApplyResult | null };
  view: ViewState;
}

type Listener<T> = (value: T) => void;

function randomSeed(): Uint8Array {
  const seed = new Uint8Array(32);
  crypto.getRandomValues(seed);
  return seed;
}

/** Only non-ASCII text can need extra font subsets. */
function hasNonAscii(text: string): boolean {
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) > 0x7f) return true;
  return false;
}

async function sourceBytes(src: Uint8Array | Blob): Promise<Uint8Array> {
  return src instanceof Uint8Array ? src : new Uint8Array(await src.arrayBuffer());
}

export class EngineClient {
  /** `worker` (OffscreenCanvas in a dedicated worker) or `main` (fallback on the main thread). */
  readonly mode: "worker" | "main";
  readonly info: EngineInfo;
  private readonly rpc: RpcClient<EngineWorkerApi, EngineEvents>;
  private readonly worker: Worker | null;
  private readonly localHost: EngineHost | null;
  private readonly canvas: HTMLCanvasElement;
  private readonly resolveAsset: AssetResolver;
  private readonly listeners = new Map<string, Set<Listener<unknown>>>();
  private readonly cleanup: (() => void)[] = [];
  private mirror: Design | null = null;
  private pagesInfo: PageInfo[] = [];
  private viewState: ViewState;
  private renderOpts: RenderOptions;
  private readonly assetJobs = new Map<Id, Promise<void>>();
  private readonly loadedAssets = new Set<Id>();
  private previewInFlight: Promise<unknown> | null = null;
  private queuedPreview: {
    tx: Transaction;
    normalize: boolean;
    resolve: (r: EngineApplyResult | null) => void;
  } | null = null;
  private disposed = false;

  private constructor(args: {
    mode: "worker" | "main";
    info: EngineInfo;
    rpc: RpcClient<EngineWorkerApi, EngineEvents>;
    worker: Worker | null;
    localHost: EngineHost | null;
    options: EngineClientOptions;
  }) {
    this.mode = args.mode;
    this.info = args.info;
    this.rpc = args.rpc;
    this.worker = args.worker;
    this.localHost = args.localHost;
    this.canvas = args.options.canvas;
    this.resolveAsset = args.options.resolveAsset ?? ((a) => a.url);
    this.renderOpts = { ...args.options.render };
    const rect = this.canvas.getBoundingClientRect();
    this.viewState = {
      x: 0,
      y: 0,
      zoom: 1,
      width: rect.width || this.canvas.clientWidth || 1,
      height: rect.height || this.canvas.clientHeight || 1,
      dpr: globalThis.devicePixelRatio || 1,
    };
    for (const name of [
      "frame",
      "font",
      "assetError",
      "asset",
      "recovered",
      "warning",
      "fatal",
    ] as const) {
      this.cleanup.push(this.rpc.on(name, (v) => this.emit(name, v as never)));
    }
    this.cleanup.push(this.rpc.on("missingAssets", (ids) => void this.ensureAssets(ids)));
    this.cleanup.push(
      this.rpc.on("relayout", (r) => {
        this.applyToMirror(r);
        this.emit("relayout", r);
      }),
    );
    if (args.options.autoResize !== false) this.observeSize();
    this.pushView();
  }

  /** Starts the engine for a canvas. */
  static async create(options: EngineClientOptions): Promise<EngineClient> {
    const mode = options.mode ?? "auto";
    const canvas = options.canvas;
    const canWorker =
      typeof Worker !== "undefined" &&
      typeof OffscreenCanvas !== "undefined" &&
      typeof canvas.transferControlToOffscreen === "function";
    if (mode === "worker" && !canWorker)
      throw new Error("OffscreenCanvas workers are not available here");
    const useWorker = mode !== "main" && canWorker;
    const init = {
      urls: options.urls,
      seed: randomSeed(),
      render: options.render,
      fonts: options.fonts,
      fontWaitMs: options.fontWaitMs,
    };
    if (useWorker) {
      const worker =
        options.createWorker?.() ??
        new Worker(new URL("./worker.ts", import.meta.url), {
          type: "module",
          name: "desyn-engine",
        });
      const rpc = createRpcClient<EngineWorkerApi, EngineEvents>(worker);
      const offscreen = canvas.transferControlToOffscreen();
      let info: EngineInfo;
      try {
        info = await rpc.call("init", transfer({ ...init, canvas: offscreen }, [offscreen]));
      } catch (e) {
        rpc.close("init failed");
        worker.terminate();
        throw e;
      }
      const client = new EngineClient({
        mode: "worker",
        info,
        rpc,
        worker,
        localHost: null,
        options,
      });
      const onError = (ev: ErrorEvent) =>
        client.emit("fatal", { message: ev.message || "engine worker failed" });
      worker.addEventListener("error", onError);
      client.cleanup.push(() => worker.removeEventListener("error", onError));
      return client;
    }
    const [clientEnd, hostEnd] = createLocalChannel();
    let server: ReturnType<typeof exposeRpc<EngineEvents>> | null = null;
    const host = new EngineHost((event, value) => server?.emit(event, value));
    server = exposeRpc<EngineEvents>(host, hostEnd, ENGINE_WORKER_METHODS);
    host._attachCanvas(canvas);
    const rpc = createRpcClient<EngineWorkerApi, EngineEvents>(clientEnd);
    const info = await rpc.call("init", init);
    return new EngineClient({ mode: "main", info, rpc, worker: null, localHost: host, options });
  }

  // ---------------------------------------------------------------------------------------------------------
  // Events

  on<K extends keyof ClientEvents & string>(
    event: K,
    listener: Listener<ClientEvents[K]>,
  ): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener as Listener<unknown>);
    return () => set?.delete(listener as Listener<unknown>);
  }

  private emit<K extends keyof ClientEvents & string>(event: K, value: ClientEvents[K]): void {
    for (const l of this.listeners.get(event) ?? []) l(value);
  }

  // ---------------------------------------------------------------------------------------------------------
  // Document

  /** The committed design (without the active preview). */
  get design(): Design {
    if (!this.mirror) throw new Error("no design loaded");
    return this.mirror;
  }

  get hasDesign(): boolean {
    return this.mirror !== null;
  }

  get pages(): readonly PageInfo[] {
    return this.pagesInfo;
  }

  /** Loads a design; its fonts are fetched before the first frame and font assets are resolved right away. */
  async load(design: Design): Promise<LoadInfo> {
    const hints = designFontNeeds(design);
    const json = JSON.stringify(design);
    const info = JSON.parse(await this.rpc.call("load", json, hints)) as LoadInfo;
    this.mirror = design;
    this.pagesInfo = info.pages;
    this.loadedAssets.clear();
    this.assetJobs.clear();
    const fontAssets = Object.values(design.assets)
      .filter((a) => a.kind === "font")
      .map((a) => a.id);
    if (fontAssets.length) void this.ensureAssets(fontAssets);
    this.emit("change", { design, result: null });
    return info;
  }

  private applyToMirror(result: EngineApplyResult, tx?: Transaction): Design {
    const base = this.design;
    if (result.applied.length === 0) return base;
    const applied = applyTransaction(
      base,
      {
        id: tx?.id ?? result.inverse.id,
        label: tx?.label ?? result.inverse.label,
        ops: result.applied,
        source: tx?.source ?? result.inverse.source,
        ts: tx?.ts ?? Date.now(),
      },
      { validateNodes: false, inverseId: result.inverse.id },
    );
    this.mirror = applied.design;
    if (result.applied.some((op) => op.op === "create" || op.op === "delete" || op.op === "move")) {
      this.pagesInfo = this.computePages(applied.design);
    } else if (
      result.applied.some((op) => op.op === "update" && this.pagesInfo.some((p) => p.id === op.id))
    ) {
      this.pagesInfo = this.computePages(applied.design);
    }
    this.emit("change", { design: applied.design, result });
    return applied.design;
  }

  private computePages(design: Design): PageInfo[] {
    const root = design.nodes.root;
    const ids = root && "children" in root ? root.children : [];
    return ids
      .map((id) => design.nodes[id])
      .filter((n): n is NonNullable<typeof n> => n?.type === "page")
      .map((n) => ({ id: n.id, name: n.name, width: n.width, height: n.height }));
  }

  /** Applies a transaction (with layout normalization by default) and updates the mirror. */
  async apply(tx: Transaction, options: { normalize?: boolean } = {}): Promise<ApplyResult> {
    const normalize = options.normalize ?? true;
    const result = JSON.parse(
      await this.rpc.call("apply", JSON.stringify(tx), normalize),
    ) as EngineApplyResult;
    const design = this.applyToMirror(result, tx);
    this.noteTransactionText(tx);
    return { ...result, design };
  }

  /**
   * Shows a transaction live without committing it (drags, resizes, typing). Calls coalesce: while one preview is
   * being applied only the newest queued one is sent next. Resolves with the preview's result, or `null` when a
   * newer preview replaced it before it was sent.
   */
  preview(
    tx: Transaction,
    options: { normalize?: boolean } = {},
  ): Promise<EngineApplyResult | null> {
    const normalize = options.normalize ?? true;
    if (this.previewInFlight) {
      this.queuedPreview?.resolve(null);
      return new Promise((resolve) => {
        this.queuedPreview = { tx, normalize, resolve };
      });
    }
    return this.sendPreview(tx, normalize);
  }

  private sendPreview(tx: Transaction, normalize: boolean): Promise<EngineApplyResult | null> {
    const p = this.rpc
      .call("preview", JSON.stringify(tx), normalize)
      .then((json) => JSON.parse(json) as EngineApplyResult);
    this.previewInFlight = p;
    const next = () => {
      this.previewInFlight = null;
      const q = this.queuedPreview;
      this.queuedPreview = null;
      if (q) this.sendPreview(q.tx, q.normalize).then(q.resolve, () => q.resolve(null));
    };
    p.then(next, next);
    return p;
  }

  private async settlePreviews(): Promise<void> {
    while (this.previewInFlight || this.queuedPreview) {
      await (this.previewInFlight ?? Promise.resolve()).catch(() => undefined);
      if (!this.previewInFlight && this.queuedPreview) {
        const q = this.queuedPreview;
        this.queuedPreview = null;
        await this.sendPreview(q.tx, q.normalize).then(q.resolve, () => q.resolve(null));
      }
    }
  }

  /** Keeps the active preview: returns its result (commit `applied`, keep `inverse` for undo), or null. */
  async commitPreview(
    meta: Partial<Pick<Transaction, "id" | "label" | "source" | "actor">> = {},
  ): Promise<ApplyResult | null> {
    await this.settlePreviews();
    const json = await this.rpc.call("commitPreview");
    if (json === "null") return null;
    const result = JSON.parse(json) as EngineApplyResult;
    const design = this.applyToMirror(result, {
      id: meta.id ?? result.inverse.id,
      label: meta.label ?? result.inverse.label,
      ops: result.applied,
      source: meta.source ?? result.inverse.source,
      ts: Date.now(),
    });
    return { ...result, design };
  }

  /** Drops the active preview. */
  async cancelPreview(): Promise<boolean> {
    await this.settlePreviews();
    return this.rpc.call("cancelPreview");
  }

  /** Re-derives text boxes / auto-layout with the loaded fonts (also done automatically after font loads). */
  async relayout(): Promise<ApplyResult> {
    const result = JSON.parse(await this.rpc.call("relayout")) as EngineApplyResult;
    const design = this.applyToMirror(result);
    return { ...result, design };
  }

  /** The engine's own copy of the design (committed state plus the active preview). */
  async snapshot(): Promise<Design> {
    return JSON.parse(await this.rpc.call("snapshot")) as Design;
  }

  private noteTransactionText(tx: Transaction): void {
    let text = "";
    for (const op of tx.ops) {
      if (op.op === "update" && op.set && Array.isArray(op.set.runs)) {
        for (const r of op.set.runs as { text?: unknown }[])
          if (typeof r?.text === "string") text += r.text;
      } else if (op.op === "create") {
        for (const n of op.nodes) {
          if (n.type === "text") for (const r of n.runs) text += r.text;
        }
      }
    }
    if (hasNonAscii(text)) this.rpc.cast("noteText", text);
  }

  /** Tells the engine about characters about to be typed (loads covering font slices early). */
  noteText(text: string): void {
    if (hasNonAscii(text)) this.rpc.cast("noteText", text);
  }

  // ---------------------------------------------------------------------------------------------------------
  // Assets

  /** Resolves and loads assets (default: every asset of the design that is not loaded yet). */
  async ensureAssets(ids?: Id[]): Promise<void> {
    const design = this.mirror;
    if (!design) return;
    const wanted = ids ?? Object.keys(design.assets);
    await Promise.all(
      wanted.map((id) => {
        if (this.loadedAssets.has(id)) return Promise.resolve();
        let job = this.assetJobs.get(id);
        if (!job) {
          job = this.loadAsset(id).finally(() => this.assetJobs.delete(id));
          this.assetJobs.set(id, job);
        }
        return job;
      }),
    );
  }

  private async loadAsset(id: Id): Promise<void> {
    const asset = this.mirror?.assets[id];
    if (!asset) return;
    let src: AssetSource;
    try {
      src = await this.resolveAsset(asset);
    } catch (e) {
      this.emit("assetError", {
        id,
        message: `resolve failed: ${e instanceof Error ? e.message : String(e)}`,
      });
      return;
    }
    if (src === null || src === undefined || src === "") {
      this.emit("assetError", { id, message: "no URL or bytes for this asset" });
      return;
    }
    try {
      if (typeof src === "string") {
        await this.rpc.call("loadAsset", id, src);
      } else {
        const bytes = await sourceBytes(src);
        const copy = bytes.slice();
        await this.rpc.call("setAsset", id, transfer(copy, [copy.buffer]));
      }
      this.loadedAssets.add(id);
    } catch {
      // The worker already emitted `assetError` with the reason.
    }
  }

  /** Registers asset bytes directly (uploads, pastes). */
  async setAsset(id: Id, bytes: Uint8Array): Promise<void> {
    const copy = bytes.slice();
    await this.rpc.call("setAsset", id, transfer(copy, [copy.buffer]));
    this.loadedAssets.add(id);
  }

  /** Registers font bytes (custom fonts outside the design's assets). */
  async setFont(bytes: Uint8Array, family?: string): Promise<void> {
    const copy = bytes.slice();
    await this.rpc.call("setFont", transfer(copy, [copy.buffer]), family);
  }

  /** Bytes of a loaded asset (resolving it first when needed). */
  async readAsset(id: Id): Promise<{ bytes: Uint8Array; mime: string }> {
    let bytes = await this.rpc.call("assetBytes", id);
    if (!bytes) {
      await this.ensureAssets([id]);
      bytes = await this.rpc.call("assetBytes", id);
    }
    if (!bytes) throw new Error(`asset ${id} is not available`);
    return { bytes, mime: this.mirror?.assets[id]?.mime ?? "application/octet-stream" };
  }

  // ---------------------------------------------------------------------------------------------------------
  // View

  get view(): ViewState {
    return this.viewState;
  }

  /** Updates the view (origin snapped to device pixels so pans reuse the previous frame). */
  setView(next: Partial<ViewState>): ViewState {
    this.viewState = snapToDevice({ ...this.viewState, ...next });
    this.pushView();
    return this.viewState;
  }

  private pushView(): void {
    if (this.disposed) return;
    this.rpc.cast("setView", this.viewState);
    this.emit("view", this.viewState);
  }

  panBy(dx: number, dy: number): ViewState {
    this.viewState = panBy(this.viewState, dx, dy);
    this.pushView();
    return this.viewState;
  }

  /** Zooms about a screen point (CSS px relative to the canvas). */
  zoomAt(anchor: Point, zoom: number): ViewState {
    this.viewState = zoomAt(this.viewState, anchor, zoom);
    this.pushView();
    return this.viewState;
  }

  /** Fits a page (default: the shown page) or a page rectangle into the view. */
  fit(target?: Rect | Id, padding = 48): ViewState {
    let rect: Rect | undefined;
    if (typeof target === "object") rect = target;
    else {
      const id = target ?? this.renderOpts.pageId ?? this.pagesInfo[0]?.id;
      const p = this.pagesInfo.find((x) => x.id === id) ?? this.pagesInfo[0];
      if (p) rect = { x: 0, y: 0, w: p.width, h: p.height };
    }
    if (!rect) return this.viewState;
    this.viewState = fitRect(this.viewState, rect, padding);
    this.pushView();
    return this.viewState;
  }

  screenToPage(p: Point): Point {
    return screenToPage(this.viewState, p);
  }

  pageToScreen(p: Point): Point {
    return pageToScreen(this.viewState, p);
  }

  get renderOptions(): RenderOptions {
    return this.renderOpts;
  }

  /** Page, pasteboard, hidden nodes, animation time, frame budget. */
  setRenderOptions(options: RenderOptions): void {
    this.renderOpts = { ...this.renderOpts, ...options };
    this.rpc.cast("setRenderOptions", this.renderOpts);
  }

  private observeSize(): void {
    const update = (width: number, height: number, deviceWidth?: number, deviceHeight?: number) => {
      const dpr = globalThis.devicePixelRatio || 1;
      const v = this.viewState;
      if (
        v.width === width &&
        v.height === height &&
        v.dpr === dpr &&
        v.deviceWidth === deviceWidth &&
        v.deviceHeight === deviceHeight
      ) {
        return;
      }
      this.viewState = snapToDevice({ ...v, width, height, dpr, deviceWidth, deviceHeight });
      this.pushView();
    };
    if (typeof ResizeObserver !== "undefined") {
      const ro = new ResizeObserver((entries) => {
        for (const e of entries) {
          const box = e.contentBoxSize?.[0];
          const dev = e.devicePixelContentBoxSize?.[0];
          update(
            box?.inlineSize ?? e.contentRect.width,
            box?.blockSize ?? e.contentRect.height,
            dev?.inlineSize,
            dev?.blockSize,
          );
        }
      });
      try {
        ro.observe(this.canvas, { box: "device-pixel-content-box" });
      } catch {
        ro.observe(this.canvas);
      }
      this.cleanup.push(() => ro.disconnect());
    }
    // DPR changes (moving the window between screens, browser zoom).
    if (typeof matchMedia === "function") {
      let mq: MediaQueryList | null = null;
      const listen = () => {
        mq?.removeEventListener("change", onChange);
        mq = matchMedia(`(resolution: ${globalThis.devicePixelRatio || 1}dppx)`);
        mq.addEventListener("change", onChange);
      };
      const onChange = () => {
        const r = this.canvas.getBoundingClientRect();
        update(r.width, r.height);
        listen();
      };
      listen();
      this.cleanup.push(() => mq?.removeEventListener("change", onChange));
    }
  }

  /** Waits for in-flight font / asset loads, then renders everything pending. */
  async flush(timeoutMs = 8000): Promise<FrameInfo | null> {
    await this.settlePreviews();
    const deadline = performance.now() + timeoutMs;
    let frame: FrameInfo | null = null;
    // Frames can discover missing assets, which this side resolves; settle both until nothing is outstanding.
    for (let round = 0; round < 4; round++) {
      frame = await this.rpc.call("flush", Math.max(1, deadline - performance.now()));
      // Let the worker's `missingAssets` events reach this side before checking for asset work.
      await new Promise((r) => setTimeout(r, 0));
      if (this.assetJobs.size === 0) break;
      await Promise.race([
        Promise.allSettled([...this.assetJobs.values()]),
        new Promise((r) => setTimeout(r, Math.max(1, deadline - performance.now()))),
      ]);
    }
    return frame;
  }

  /** The presented canvas as PNG bytes. */
  async capture(): Promise<Uint8Array> {
    return this.rpc.call("capture");
  }

  // ---------------------------------------------------------------------------------------------------------
  // Queries

  async hitTest(req: HitRequest): Promise<HitResult> {
    return JSON.parse(await this.rpc.call("hitTest", req));
  }

  /** Hit test at a screen point; `tolerance` is in screen px. */
  async hitTestScreen(p: Point, options: HitOptions = {}): Promise<HitResult> {
    const page = this.screenToPage(p);
    return this.hitTest({
      x: page.x,
      y: page.y,
      pageId: this.renderOpts.pageId,
      options: { ...options, tolerance: (options.tolerance ?? 4) / this.viewState.zoom },
    });
  }

  async marquee(req: MarqueeRequest): Promise<Id[]> {
    return JSON.parse(await this.rpc.call("marquee", { pageId: this.renderOpts.pageId, ...req }));
  }

  /** Snapping; `options.threshold` is in screen px (converted to design px here). */
  async snap(req: SnapRequest): Promise<SnapResult> {
    const threshold = (req.options?.threshold ?? 6) / this.viewState.zoom;
    return JSON.parse(
      await this.rpc.call("snap", { ...req, options: { ...req.options, threshold } }),
    );
  }

  async handles(req: Omit<HandlesRequest, "zoom"> & { zoom?: number }): Promise<HandlesResult> {
    return JSON.parse(
      await this.rpc.call("handles", { ...req, zoom: req.zoom ?? this.viewState.zoom }),
    );
  }

  async resizeBox(req: ResizeRequest): Promise<ResizeResult> {
    return JSON.parse(await this.rpc.call("resizeBox", req));
  }

  rotationDelta(req: RotateRequest): Promise<number> {
    return this.rpc.call("rotationDelta", req);
  }

  async bounds(ids: Id[]): Promise<(Rect | null)[]> {
    return JSON.parse(await this.rpc.call("bounds", ids));
  }

  async measure(items: MeasureItem[]): Promise<MeasureResult[]> {
    return JSON.parse(await this.rpc.call("measure", items));
  }

  async describe(req: DescribeRequest = {}): Promise<Description> {
    return JSON.parse(await this.rpc.call("describe", { pageId: this.renderOpts.pageId, ...req }));
  }

  describeCompact(req: DescribeRequest, maxTokens: number): Promise<string> {
    return this.rpc.call("describeCompact", { pageId: this.renderOpts.pageId, ...req }, maxTokens);
  }

  async lint(req: DescribeRequest = {}): Promise<Issue[]> {
    return JSON.parse(await this.rpc.call("lint", { pageId: this.renderOpts.pageId, ...req }));
  }

  /** Exports (PDF / PPTX / GIF load the exporters module on first use). Loads every asset first. */
  async export(req: ExportRequest): Promise<ExportResult> {
    await this.settlePreviews();
    await this.ensureAssets();
    return this.rpc.call("export", req);
  }

  async textLayout(nodeId: Id): Promise<TextLayoutInfo> {
    return JSON.parse(await this.rpc.call("textLayout", nodeId));
  }

  async textQuery(query: TextQuery): Promise<TextQueryResult> {
    return JSON.parse(await this.rpc.call("textQuery", query));
  }

  async outlineText(nodeId: Id): Promise<TextOutline> {
    return JSON.parse(await this.rpc.call("outlineText", nodeId));
  }

  /** Stops the worker and detaches observers. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const c of this.cleanup) c();
    this.rpc.cast("dispose");
    this.rpc.close("disposed");
    this.worker?.terminate();
    this.localHost?.dispose();
  }
}
