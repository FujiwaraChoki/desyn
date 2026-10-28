// EngineHost: owns one wasm engine and a canvas. Runs inside the dedicated worker (OffscreenCanvas) or, as the
// fallback, on the main thread (HTMLCanvasElement). Responsibilities: requestAnimationFrame-paced rendering,
// presenting damage rectangles / scrolls / progressive tiles to the canvas, font and asset loading, exports
// (with the lazily loaded exporters module) and crash recovery.
import { AssetLoader } from "./assets";
import { FontLoader, type FontLoadRequest, normalizeFamily } from "./fonts";
import type {
  DescribeRequest,
  EngineEvents,
  EngineInfo,
  EngineUrls,
  EngineWorkerApi,
  ExportRequest,
  ExportResult,
  FrameInfo,
  HandlesRequest,
  HitRequest,
  InitOptions,
  LoadHints,
  MarqueeRequest,
  MeasureItem,
  RenderOptions,
  ResizeRequest,
  RotateRequest,
  SnapRequest,
  TextQuery,
  ViewState,
} from "./protocol";
import { transfer } from "./rpc";
import {
  defaultEngineWasmUrl,
  defaultExportWasmUrl,
  defaultFontUrls,
  type EngineModule,
  loadEngineModule,
  loadExportModule,
  type WasmEngine,
} from "./wasm";

export type Emit = <K extends keyof EngineEvents & string>(
  event: K,
  value: EngineEvents[K],
  transferables?: Transferable[],
) => void;

type AnyCanvas = OffscreenCanvas | HTMLCanvasElement;
type Ctx2D = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

interface DeviceView {
  x: number;
  y: number;
  zoom: number;
  width: number;
  height: number;
  dpr: number;
  scale: number;
}

/** Formats only the exporters module has. */
const EXPORTER_FORMATS = new Set(["pdf", "pptx", "gif"]);

/** Rest time after the last zoom change before the engine re-renders at the new scale. */
const ZOOM_SETTLE_MS = 110;

function makeCanvas(width: number, height: number): AnyCanvas {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(width, height);
  const c = document.createElement("canvas");
  c.width = width;
  c.height = height;
  return c;
}

/** Committed transactions kept for crash recovery before the log is compacted into a snapshot. */
const LOG_COMPACT_AT = 200;

const DEFAULT_RENDER: Required<Pick<RenderOptions, "background" | "pageShadow" | "budgetMs">> = {
  background: "#0e0e0e",
  pageShadow: true,
  budgetMs: 10,
};

function now(): number {
  return performance.now();
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** The methods the client may call (the worker serves exactly these; internal helpers stay unreachable). */
const WORKER_METHODS: Record<keyof EngineWorkerApi, true> = {
  init: true,
  load: true,
  apply: true,
  preview: true,
  commitPreview: true,
  cancelPreview: true,
  relayout: true,
  snapshot: true,
  setView: true,
  setRenderOptions: true,
  flush: true,
  hitTest: true,
  marquee: true,
  snap: true,
  handles: true,
  resizeBox: true,
  rotationDelta: true,
  bounds: true,
  measure: true,
  describe: true,
  describeCompact: true,
  lint: true,
  export: true,
  setFont: true,
  setAsset: true,
  loadAsset: true,
  removeAsset: true,
  assetBytes: true,
  noteText: true,
  textLayout: true,
  textQuery: true,
  outlineText: true,
  capture: true,
  dispose: true,
};

export const ENGINE_WORKER_METHODS: readonly string[] = Object.keys(WORKER_METHODS);

export class EngineHost implements EngineWorkerApi {
  private mod: EngineModule | null = null;
  private engine: WasmEngine | null = null;
  private canvas: AnyCanvas | null = null;
  private ctx: Ctx2D | null = null;
  private seed: Uint8Array = new Uint8Array(32);
  private urls: EngineUrls = {
    engineWasm: "",
    exportGlue: "",
    exportWasm: "",
    fonts: {},
  };
  private view: ViewState | null = null;
  private presented: DeviceView | null = null;
  /** Last complete frame, shown transformed while a zoom gesture is in progress. */
  private zoomBase: { canvas: AnyCanvas; view: DeviceView } | null = null;
  private lastZoomChange = 0;
  private lastZoomSeen = 0;
  private settleTimer: ReturnType<typeof setTimeout> | null = null;
  private renderOpts: RenderOptions = { ...DEFAULT_RENDER };
  private loaded = false;
  private gateOpen = true;
  private fonts: FontLoader | null = null;
  private readonly assets = new AssetLoader();
  private readonly fontFiles: { bytes: Uint8Array; family: string | null; key: string }[] = [];
  private readonly assetData = new Map<string, Uint8Array>();
  private log: { base: string; txs: { json: string; normalize: boolean }[] } = {
    base: "",
    txs: [],
  };
  private previewActive = false;
  private frameNo = 0;
  private scheduled = false;
  private relayoutTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly inFlight = new Set<Promise<unknown>>();
  private fontWaitMs = 1500;
  private hintFonts: FontLoadRequest[] = [];
  private readonly failedFonts = new Set<string>();
  private forceNext = false;
  private disposed = false;

  constructor(private readonly emit: Emit) {}

  /** Main-thread fallback: the canvas is handed over directly (an HTMLCanvasElement cannot be posted). */
  _attachCanvas(canvas: AnyCanvas): void {
    this.setCanvas(canvas);
  }

  private setCanvas(canvas: AnyCanvas): void {
    const ctx = canvas.getContext("2d", { alpha: true, desynchronized: true }) as Ctx2D | null;
    if (!ctx) throw new Error("2D canvas context unavailable");
    this.canvas = canvas;
    this.ctx = ctx;
  }

  async init(options: InitOptions): Promise<EngineInfo> {
    this.seed = options.seed;
    this.urls = {
      engineWasm: options.urls?.engineWasm ?? defaultEngineWasmUrl(),
      exportGlue: options.urls?.exportGlue ?? "",
      exportWasm: options.urls?.exportWasm ?? defaultExportWasmUrl(),
      fonts: options.urls?.fonts ?? defaultFontUrls(),
    };
    if (options.canvas) this.setCanvas(options.canvas);
    this.renderOpts = { ...DEFAULT_RENDER, ...options.render };
    this.fontWaitMs = options.fontWaitMs ?? 1500;
    this.fonts = new FontLoader({ fonts: this.urls.fonts, ...options.fonts });
    this.mod = await loadEngineModule(this.urls.engineWasm);
    this.engine = this.mod.create(this.seed);
    // Inter is every family's last fallback: have it before anything is drawn.
    this.track(this.loadFont({ family: "Inter", weight: 400, italic: false }));
    return this.mod.info;
  }

  // ---------------------------------------------------------------------------------------------------------
  // Engine access and crash recovery

  private need(): WasmEngine {
    if (!this.engine) throw new Error("engine unavailable");
    return this.engine;
  }

  private call<T>(fn: (e: WasmEngine) => T): T {
    const engine = this.need();
    try {
      return fn(engine);
    } catch (e) {
      if (e instanceof WebAssembly.RuntimeError) {
        this.recover(e);
        throw new Error(`the engine crashed and was restored (${e.message})`);
      }
      throw e;
    }
  }

  /** Replaces a trapped engine with a fresh one restored from the load + transaction log, fonts and assets. */
  private recover(cause: Error): void {
    const mod = this.mod;
    const old = this.engine;
    this.engine = null;
    if (!mod) return;
    try {
      old?.free();
    } catch {
      // A trapped object may still be borrowed; its memory is abandoned.
    }
    try {
      const engine = mod.create(this.seed);
      for (const f of this.fontFiles) engine.setFont(f.bytes, f.family);
      if (this.loaded && this.log.base) {
        engine.load(this.log.base);
        for (const tx of this.log.txs) engine.applyTransaction(tx.json, tx.normalize);
      }
      for (const [id, bytes] of this.assetData) {
        try {
          engine.setAsset(id, bytes);
        } catch {
          this.assetData.delete(id);
        }
      }
      this.engine = engine;
      this.previewActive = false;
      this.presented = null;
      this.forceNext = true;
      this.emit("recovered", { message: cause.message });
      this.requestFrame();
    } catch (e) {
      this.emit("fatal", {
        message: `${cause.message}; recovery failed: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }

  private logTx(json: string, normalize: boolean): void {
    this.log.txs.push({ json, normalize });
    if (this.log.txs.length >= LOG_COMPACT_AT && !this.previewActive) {
      this.log = { base: this.call((e) => e.snapshot()), txs: [] };
    }
  }

  private track<T>(p: Promise<T>): Promise<T> {
    this.inFlight.add(p);
    const done = () => this.inFlight.delete(p);
    p.then(done, done);
    return p;
  }

  // ---------------------------------------------------------------------------------------------------------
  // Document

  async load(designJson: string, hints?: LoadHints): Promise<string> {
    const info = this.call((e) => e.load(designJson));
    this.log = { base: designJson, txs: [] };
    this.loaded = true;
    this.previewActive = false;
    this.presented = null;
    this.forceNext = true;
    this.hintFonts = hints?.fonts ?? [];
    if (hints && this.fonts) {
      this.fonts.setAssetFamilies(hints.assetFamilies);
      await this.fonts.noteText(hints.text);
      const wanted = hints.fonts.filter((f) => !hints.assetFamilies.includes(f.family));
      if (wanted.length) {
        // Hold the first frame until the design's fonts arrive (bounded), so text never flashes in fallbacks.
        this.gateOpen = false;
        const all = Promise.allSettled(wanted.map((f) => this.track(this.loadFont(f))));
        void Promise.race([all, sleep(this.fontWaitMs)]).then(() => {
          this.gateOpen = true;
          this.requestFrame();
        });
      }
    }
    this.requestFrame();
    return info;
  }

  async apply(txJson: string, normalize: boolean): Promise<string> {
    const out = this.call((e) => e.applyTransaction(txJson, normalize));
    this.logTx(txJson, normalize);
    this.afterChange();
    return out;
  }

  async preview(txJson: string, normalize: boolean): Promise<string> {
    const out = this.call((e) => e.preview(txJson, normalize));
    this.previewActive = true;
    this.afterChange();
    return out;
  }

  async commitPreview(): Promise<string> {
    const out = this.call((e) => e.commitPreview());
    if (this.previewActive && out !== "null") {
      const r = JSON.parse(out) as { applied: unknown[] };
      this.logTx(
        JSON.stringify({
          id: this.call((e) => e.newId()),
          label: "Preview",
          ops: r.applied,
          source: "user",
          ts: 0,
        }),
        false,
      );
    }
    this.previewActive = false;
    this.afterChange();
    return out;
  }

  async cancelPreview(): Promise<boolean> {
    const had = this.call((e) => e.cancelPreview());
    this.previewActive = false;
    this.afterChange();
    return had;
  }

  async relayout(): Promise<string> {
    const out = this.call((e) => e.relayout());
    this.logRelayout(out);
    this.afterChange();
    return out;
  }

  private logRelayout(out: string): boolean {
    const r = JSON.parse(out) as { applied: unknown[] };
    if (r.applied.length === 0) return false;
    this.logTx(
      JSON.stringify({
        id: this.call((e) => e.newId()),
        label: "Relayout",
        ops: r.applied,
        source: "system",
        ts: 0,
      }),
      false,
    );
    return true;
  }

  async snapshot(): Promise<string> {
    return this.call((e) => e.snapshot());
  }

  private afterChange(): void {
    this.requestFrame();
    this.drainRequests();
  }

  /** Missing assets / fonts noticed by apply, measure, describe and text queries. */
  private drainRequests(): void {
    if (!this.engine) return;
    const r = JSON.parse(this.call((e) => e.takeRequests())) as {
      missingAssets: string[];
      fontRequests: FontLoadRequest[];
    };
    if (r.missingAssets.length) this.emit("missingAssets", r.missingAssets);
    this.requestFonts(r.fontRequests);
  }

  // ---------------------------------------------------------------------------------------------------------
  // Fonts and assets

  private registerFont(bytes: Uint8Array, family: string | null): void {
    const key = `${family ?? ""}|${bytes.byteLength}|${bytes[0]}|${bytes[bytes.byteLength >> 1]}|${bytes[bytes.byteLength - 1]}`;
    if (this.fontFiles.some((f) => f.key === key)) return;
    this.call((e) => e.setFont(bytes, family));
    this.fontFiles.push({ bytes, family, key });
  }

  /**
   * Loads fonts the engine asked for. The renderer reports families only, so every weight / style the design
   * uses for a family (from the load hints) is fetched; a family that failed is not retried in this session.
   */
  private requestFonts(requests: FontLoadRequest[]): void {
    for (const r of requests) {
      const fam = normalizeFamily(r.family);
      const variants = this.hintFonts.filter((h) => normalizeFamily(h.family) === fam);
      for (const v of variants.length ? variants : [r]) {
        const key = `${fam}|${Math.round(v.weight)}|${v.italic}`;
        if (this.failedFonts.has(key)) continue;
        this.track(this.loadFont(v));
      }
    }
  }

  private async loadFont(req: FontLoadRequest): Promise<void> {
    const fonts = this.fonts;
    if (!fonts) return;
    try {
      const files = await fonts.load(req);
      for (const f of files) this.registerFont(f.bytes, f.family);
      this.emit("font", { ...req, ok: true, source: files[0]?.source ?? "none" });
      this.fontsChanged();
    } catch (e) {
      this.failedFonts.add(
        `${normalizeFamily(req.family)}|${Math.round(req.weight)}|${req.italic}`,
      );
      this.emit("font", {
        ...req,
        ok: false,
        source: "none",
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  /** New faces change text metrics: redraw now, re-derive text boxes once the burst of loads settles. */
  private fontsChanged(): void {
    this.forceNext = true;
    this.requestFrame();
    if (this.relayoutTimer) clearTimeout(this.relayoutTimer);
    this.relayoutTimer = setTimeout(() => {
      this.relayoutTimer = null;
      if (!this.loaded || !this.engine || this.disposed) return;
      try {
        const out = this.call((e) => e.relayout());
        if (this.logRelayout(out)) {
          this.emit("relayout", JSON.parse(out));
          this.requestFrame();
        }
      } catch (e) {
        this.emit("warning", {
          message: `relayout failed: ${e instanceof Error ? e.message : String(e)}`,
        });
      }
    }, 120);
  }

  async setFont(bytes: Uint8Array, family?: string): Promise<string> {
    const out = this.call((e) => e.setFont(bytes, family ?? null));
    this.fontFiles.push({ bytes, family: family ?? null, key: `manual|${this.fontFiles.length}` });
    this.fontsChanged();
    return out;
  }

  async setAsset(id: string, bytes: Uint8Array): Promise<string> {
    let out: string;
    try {
      out = this.call((e) => e.setAsset(id, bytes));
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.emit("assetError", { id, message });
      throw e;
    }
    this.assetData.set(id, bytes);
    const info = JSON.parse(out);
    this.emit("asset", info);
    if (info.kind === "font") this.fontsChanged();
    this.requestFrame();
    return out;
  }

  async loadAsset(id: string, url: string): Promise<string> {
    let bytes: Uint8Array;
    try {
      bytes = await this.track(this.assets.load(url));
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.emit("assetError", { id, message });
      throw e;
    }
    return this.setAsset(id, bytes);
  }

  removeAsset(id: string): void {
    this.assetData.delete(id);
    this.engine?.removeAsset(id);
    this.forceNext = true;
    this.requestFrame();
  }

  async assetBytes(id: string): Promise<Uint8Array | null> {
    const b = this.assetData.get(id);
    return b ? b.slice() : null;
  }

  noteText(text: string): void {
    const fonts = this.fonts;
    if (!fonts) return;
    this.track(
      fonts.noteText(text).then((files) => {
        if (!files.length) return;
        for (const f of files) this.registerFont(f.bytes, f.family);
        this.fontsChanged();
      }),
    );
  }

  // ---------------------------------------------------------------------------------------------------------
  // Rendering

  setView(view: ViewState): void {
    this.view = view;
    this.requestFrame();
  }

  setRenderOptions(options: RenderOptions): void {
    const next = { ...this.renderOpts, ...options };
    if (JSON.stringify(next) === JSON.stringify(this.renderOpts)) return;
    this.renderOpts = next;
    this.requestFrame();
  }

  private requestFrame(): void {
    if (this.scheduled || this.disposed) return;
    this.scheduled = true;
    const run = () => {
      this.scheduled = false;
      try {
        this.frame();
      } catch (e) {
        this.emit("warning", {
          message: `frame failed: ${e instanceof Error ? e.message : String(e)}`,
        });
      }
    };
    const raf = (globalThis as { requestAnimationFrame?: (cb: FrameRequestCallback) => number })
      .requestAnimationFrame;
    if (typeof raf === "function") raf(run);
    else setTimeout(run, 16);
  }

  private deviceView(view: ViewState): DeviceView {
    const width = Math.max(1, Math.round(view.deviceWidth ?? view.width * view.dpr));
    const height = Math.max(1, Math.round(view.deviceHeight ?? view.height * view.dpr));
    const dpr = view.width > 0 ? width / view.width : view.dpr;
    return { x: view.x, y: view.y, zoom: view.zoom, width, height, dpr, scale: view.zoom * dpr };
  }

  /** Renders and presents one frame. `budget: null` renders everything that is pending. */
  private frame(budget: number | null | undefined = undefined): FrameInfo | null {
    const view = this.view;
    if (!this.engine || !this.loaded || !view || !this.ctx || !this.canvas || !this.gateOpen)
      return null;
    if (view.width <= 0 || view.height <= 0) return null;
    const dv = this.deviceView(view);
    if (budget !== null && this.zoomGesture(dv)) return null;
    const o = this.renderOpts;
    const req = {
      viewport: {
        x: dv.x,
        y: dv.y,
        zoom: dv.zoom,
        width: dv.width,
        height: dv.height,
        dpr: dv.dpr,
      },
      pageId: o.pageId,
      background: o.background ?? null,
      pageShadow: o.pageShadow ?? false,
      hidden: o.hidden ?? [],
      showHidden: o.showHidden ?? false,
      timeMs: o.timeMs,
      budgetMs: budget === null ? undefined : (budget ?? o.budgetMs),
      force: this.forceNext,
    };
    this.forceNext = false;
    const t0 = now();
    const info = JSON.parse(this.call((e) => e.render(JSON.stringify(req)))) as FrameInfo;
    const t1 = now();
    const pixels = this.present(info, dv);
    const t2 = now();
    this.frameNo += 1;
    this.emit("frame", {
      renderMs: t1 - t0,
      buildMs: info.buildMs,
      rasterMs: info.rasterMs,
      presentMs: t2 - t1,
      pixels,
      rects: info.rects.length,
      pending: info.pending,
      full: info.full,
      scrolled: info.scroll !== null,
      at: t2,
      frame: this.frameNo,
    });
    if (info.pending > 0) this.requestFrame();
    if (info.missingAssets.length) this.emit("missingAssets", info.missingAssets);
    this.requestFonts(info.fontRequests);
    return info;
  }

  /**
   * While the zoom keeps changing (wheel / pinch gestures), re-rendering every step would mostly redraw tiles that
   * are obsolete a frame later. Instead the last complete frame is shown scaled to the current view, and the
   * engine renders once the zoom has rested for ZOOM_SETTLE_MS. Returns true when the frame was handled here.
   */
  private zoomGesture(dv: DeviceView): boolean {
    const prev = this.presented;
    const canvas = this.canvas;
    const ctx = this.ctx;
    if (!prev || !canvas || !ctx) return false;
    const now = performance.now();
    if (dv.zoom !== this.lastZoomSeen) {
      // Changes in quick succession extend the gesture; a lone zoom step (a button) settles after half the delay.
      if (this.lastZoomSeen !== 0 && now - this.lastZoomChange < ZOOM_SETTLE_MS)
        this.lastZoomChange = now;
      else if (this.lastZoomSeen !== 0) this.lastZoomChange = now - ZOOM_SETTLE_MS / 2;
      this.lastZoomSeen = dv.zoom;
    }
    const zooming = prev.zoom !== dv.zoom;
    if (!zooming || now - this.lastZoomChange >= ZOOM_SETTLE_MS) {
      this.zoomBase = null;
      return false;
    }
    if (prev.width !== dv.width || prev.height !== dv.height) return false;
    if (!this.zoomBase) {
      const copy = makeCanvas(canvas.width, canvas.height);
      const c2 = copy.getContext("2d") as Ctx2D | null;
      if (!c2) return false;
      c2.drawImage(canvas, 0, 0);
      this.zoomBase = { canvas: copy, view: prev };
    }
    const base = this.zoomBase;
    const k = dv.scale / base.view.scale;
    const t0 = now;
    ctx.save();
    ctx.globalCompositeOperation = "copy";
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "low";
    ctx.setTransform(k, 0, 0, k, (base.view.x - dv.x) * dv.scale, (base.view.y - dv.y) * dv.scale);
    ctx.drawImage(base.canvas, 0, 0);
    ctx.restore();
    this.presented = { ...dv, scale: dv.scale };
    // Keep `presented.zoom` at the base zoom so the settle frame knows the view changed.
    this.presented.zoom = base.view.zoom;
    this.presented.scale = base.view.scale;
    this.presented.x = base.view.x;
    this.presented.y = base.view.y;
    this.frameNo += 1;
    this.emit("frame", {
      renderMs: 0,
      buildMs: 0,
      rasterMs: 0,
      presentMs: performance.now() - t0,
      pixels: 0,
      rects: 0,
      pending: 1,
      full: true,
      scrolled: false,
      at: performance.now(),
      frame: this.frameNo,
    });
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.settleTimer = setTimeout(() => {
      this.settleTimer = null;
      this.requestFrame();
    }, ZOOM_SETTLE_MS);
    return true;
  }

  /** Copies the frame's new pixels to the canvas. Returns the number of pixels copied. */
  private present(info: FrameInfo, dv: DeviceView): number {
    const canvas = this.canvas;
    const ctx = this.ctx;
    const mod = this.mod;
    if (!canvas || !ctx || !mod) return 0;
    let resized = false;
    if (canvas.width !== info.width || canvas.height !== info.height) {
      canvas.width = info.width;
      canvas.height = info.height;
      resized = true;
    }
    const prev = this.presented;
    if (info.scroll && !resized) {
      ctx.save();
      ctx.globalCompositeOperation = "copy";
      ctx.drawImage(canvas, info.scroll[0], info.scroll[1]);
      ctx.restore();
    } else if (info.full && info.pending > 0 && prev && !resized) {
      // Progressive frame: show the previous image transformed into the new view until the tiles land.
      const k = dv.scale / prev.scale;
      ctx.save();
      ctx.globalCompositeOperation = "copy";
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "low";
      ctx.setTransform(k, 0, 0, k, (prev.x - dv.x) * dv.scale, (prev.y - dv.y) * dv.scale);
      ctx.drawImage(canvas, 0, 0);
      ctx.restore();
    }
    let pixels = 0;
    if (info.rects.length) {
      const engine = this.need();
      const ptr = engine.framePtr();
      const len = engine.frameLen();
      const data = new Uint8ClampedArray(mod.memory.buffer, ptr, len);
      const image = new ImageData(data, info.width, info.height);
      for (const [x, y, w, h] of info.rects) {
        ctx.putImageData(image, 0, 0, x, y, w, h);
        pixels += w * h;
      }
    }
    this.presented = dv;
    return pixels;
  }

  async flush(timeoutMs = 8000): Promise<FrameInfo | null> {
    const deadline = now() + timeoutMs;
    let last: FrameInfo | null = null;
    for (let round = 0; round < 6; round++) {
      while ((this.inFlight.size > 0 || !this.gateOpen) && now() < deadline) {
        await Promise.race([
          Promise.allSettled([...this.inFlight]),
          sleep(Math.max(1, deadline - now())),
        ]);
        if (!this.gateOpen) await sleep(5);
      }
      if (this.relayoutTimer) {
        clearTimeout(this.relayoutTimer);
        this.relayoutTimer = null;
        const out = this.call((e) => e.relayout());
        if (this.logRelayout(out)) this.emit("relayout", JSON.parse(out));
      }
      last = this.frame(null) ?? last;
      if (this.inFlight.size === 0 && this.gateOpen) break;
    }
    return last;
  }

  async capture(): Promise<Uint8Array> {
    const canvas = this.canvas;
    if (!canvas) throw new Error("no canvas");
    const blob =
      "convertToBlob" in canvas
        ? await canvas.convertToBlob({ type: "image/png" })
        : await new Promise<Blob>((resolve, reject) =>
            (canvas as HTMLCanvasElement).toBlob(
              (b) => (b ? resolve(b) : reject(new Error("toBlob failed"))),
              "image/png",
            ),
          );
    const bytes = new Uint8Array(await blob.arrayBuffer());
    return transfer(bytes, [bytes.buffer]);
  }

  // ---------------------------------------------------------------------------------------------------------
  // Queries

  async hitTest(req: HitRequest): Promise<string> {
    return this.call((e) => e.hitTest(JSON.stringify(req)));
  }

  async marquee(req: MarqueeRequest): Promise<string> {
    return this.call((e) => e.marquee(JSON.stringify(req)));
  }

  async snap(req: SnapRequest): Promise<string> {
    return this.call((e) => e.snap(JSON.stringify(req)));
  }

  async handles(req: HandlesRequest): Promise<string> {
    return this.call((e) => e.handles(JSON.stringify(req)));
  }

  async resizeBox(req: ResizeRequest): Promise<string> {
    return this.call((e) => e.resizeBox(JSON.stringify(req)));
  }

  async rotationDelta(req: RotateRequest): Promise<number> {
    return this.call((e) => e.rotationDelta(JSON.stringify(req)));
  }

  async bounds(ids: string[]): Promise<string> {
    return this.call((e) => e.bounds(JSON.stringify(ids)));
  }

  async measure(items: MeasureItem[]): Promise<string> {
    const out = this.call((e) => e.measure(JSON.stringify(items)));
    this.drainRequests();
    return out;
  }

  async describe(req: DescribeRequest): Promise<string> {
    const out = this.call((e) => e.describe(JSON.stringify(req)));
    this.drainRequests();
    return out;
  }

  async describeCompact(req: DescribeRequest, maxTokens: number): Promise<string> {
    const out = this.call((e) => e.describeCompact(JSON.stringify(req), maxTokens));
    this.drainRequests();
    return out;
  }

  async lint(req: DescribeRequest): Promise<string> {
    const out = this.call((e) => e.lint(JSON.stringify(req)));
    this.drainRequests();
    return out;
  }

  async textLayout(nodeId: string): Promise<string> {
    const out = this.call((e) => e.textLayout(nodeId));
    this.drainRequests();
    return out;
  }

  async textQuery(query: TextQuery): Promise<string> {
    return this.call((e) => e.textQuery(JSON.stringify(query)));
  }

  async outlineText(nodeId: string): Promise<string> {
    return this.call((e) => e.outlineText(nodeId));
  }

  // ---------------------------------------------------------------------------------------------------------
  // Export

  async export(req: ExportRequest): Promise<ExportResult> {
    const format = req.format === "jpg" ? "jpeg" : req.format;
    const mod = this.mod;
    if (!mod) throw new Error("engine unavailable");
    const json = JSON.stringify({ ...req, format });
    let bytes: Uint8Array;
    let info: ExportResult["info"];
    if (EXPORTER_FORMATS.has(format) && !mod.info.exporters) {
      const ex = await loadExportModule(this.urls.exportWasm);
      const engine = ex.create(this.seed);
      try {
        engine.load(this.call((e) => e.snapshot()));
        for (const f of this.fontFiles) engine.setFont(f.bytes, f.family);
        for (const [id, b] of this.assetData) {
          try {
            engine.setAsset(id, b);
          } catch {
            // Already reported when the asset was first loaded.
          }
        }
        bytes = engine.export(json);
        info = JSON.parse(engine.exportInfo());
      } finally {
        engine.free();
      }
    } else {
      bytes = this.call((e) => e.export(json));
      info = JSON.parse(this.call((e) => e.exportInfo()));
    }
    return transfer({ bytes, info }, [bytes.buffer]);
  }

  dispose(): void {
    this.disposed = true;
    if (this.relayoutTimer) clearTimeout(this.relayoutTimer);
    try {
      this.engine?.free();
    } catch {
      // already gone
    }
    this.engine = null;
  }
}
