import { makeTransaction, topLevelSelection } from "@desyn/doc-ops";
import {
  type EngineClient,
  type SnapRequest,
  type SnapResult,
  type ViewState,
  wheelZoomFactor,
} from "@desyn/engine";
import type { Design, Id, Op, PageNode } from "@desyn/schema";
import { detectPlatform, isEditableTarget, type Platform } from "@desyn/ui";
import type { ApplyOptions, EditorController } from "../controller.ts";
import { activeTool, type EditorState } from "../store/editor-store.ts";
import type { CanvasPointer, Gesture, Mode, Tool } from "../tools/types.ts";
import { type SelectionBox, selectionBox } from "./geometry.ts";
import { localHitPath } from "./hit.ts";
import { type Obb, obbContains, type Point } from "./math.ts";
import {
  drawHover,
  drawLayoutGrid,
  drawPageGuides,
  drawSelection,
  drawSnap,
} from "./overlay/draw.ts";
import { type OverlayTheme, Painter, readTheme } from "./overlay/paint.ts";
import { pickTarget } from "./selection.ts";
import { startTextEditing, TextMode } from "./text/text-mode.ts";

/**
 * The canvas interaction controller: one per mounted interaction layer. It turns pointer, wheel, touch and
 * keyboard input over the engine canvas into tool gestures, keeps hover state, and draws the interaction
 * overlay (hover, selection, handles, snapping guides, tool feedback) on a main-thread 2D canvas at display
 * refresh rate. Document changes go through `EditorController.preview` / `commitPreview` / `apply`.
 */

/** Extra overlay painters contributed by features (auto-layout handles, measurements...). */
export type OverlayLayer = (c: CanvasController, p: Painter) => void;

/** Input handled before the mode / tool (ruler guides on the canvas). */
export interface Interceptor {
  down(c: CanvasController, e: CanvasPointer): Gesture | null;
  cursor(c: CanvasController, e: CanvasPointer): string | null;
}

/** DOM chrome the interaction layer renders with React (the controller owns the state). */
export interface CanvasUi {
  /** Comment composer at a point (comment tool, when no collaboration extension handles it). */
  composer: { screen: Point; page: Point; pageId: Id; nodeId: Id | null } | null;
  /** Text editing toolbar (text mode). */
  text: { nodeId: Id; version: number } | null;
  /** Drag and drop feedback. */
  drop: { label: string; target: Id | null } | null;
}

const DOUBLE_CLICK_MS = 400;
const DOUBLE_CLICK_SLOP = 6;

export class CanvasController {
  readonly platform: Platform;
  theme: OverlayTheme;
  /** Active mode (text editing, path editing, crop): gets input before the tool. */
  mode: Mode | null = null;
  gesture: Gesture | null = null;
  /** Last pointer state over the canvas (hover and modifier re-dispatch). */
  lastPointer: CanvasPointer | null = null;
  /** Live snapping feedback of the running gesture. */
  snap: SnapResult | null = null;
  /** Selection box shown instead of the document's while a gesture previews a change. */
  liveBox: Obb | null = null;
  /** Hide the selection chrome (during drawing gestures). */
  hideSelection = false;
  /** Container highlighted as the drop / reparent target. */
  dropTarget: Id | null = null;
  /** Ruler guide highlighted (index into the page's guides). */
  activeGuide: number | null = null;
  /** Alt is held (smart measurements). */
  altDown = false;
  private readonly tools = new Map<string, Tool>();
  private readonly layers = new Map<string, { order: number; draw: OverlayLayer }>();
  private readonly interceptors = new Set<Interceptor>();
  /** Stopped on direct navigation (wheel, pinch, pans) so command animations never fight the user. */
  viewAnimator: { stop(): void } | null = null;
  private toolId: string | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private raf = 0;
  private rect: DOMRect | null = null;
  private starting: Promise<Gesture | null> | null = null;
  private queuedMove: CanvasPointer | null = null;
  private queuedUp: CanvasPointer | null = null;
  private deferredDown: PointerEvent | null = null;
  private deferredUp: CanvasPointer | null = null;
  private lastDown: { time: number; x: number; y: number; count: number } | null = null;
  private readonly touches = new Map<number, Point>();
  private pinch: { dist: number; center: Point; zoom: number } | null = null;
  private hoverSeq = 0;
  private hoverInFlight = false;
  private hoverQueued: CanvasPointer | null = null;
  private cursorValue = "default";
  private selectionCache: { design: Design | null; ids: readonly Id[]; box: SelectionBox | null } =
    {
      design: null,
      ids: [],
      box: null,
    };
  private readonly disposers: (() => void)[] = [];
  private disposed = false;
  private uiState: CanvasUi = { composer: null, text: null, drop: null };
  private readonly uiListeners = new Set<() => void>();

  constructor(
    readonly editor: EditorController,
    /** The interaction layer element (covers the engine canvas exactly). */
    readonly root: HTMLElement,
    /** The overlay canvas inside `root`. */
    readonly overlay: HTMLCanvasElement,
    /** Container for DOM overlays (text editing, inputs) inside `root`. */
    readonly domLayer: HTMLElement,
    tools: readonly Tool[],
  ) {
    this.platform = detectPlatform();
    this.theme = readTheme(root);
    for (const t of tools) this.tools.set(t.id, t);
    this.ctx = overlay.getContext("2d");
    this.attach();
  }

  // ---------------------------------------------------------------------------------------------------------
  // State access

  get client(): EngineClient | null {
    return this.editor.engineClient;
  }

  get state(): EditorState {
    return this.editor.getState();
  }

  get design(): Design | null {
    return this.editor.design;
  }

  get pageId(): Id | null {
    return this.state.pageId;
  }

  get page(): PageNode | null {
    return this.editor.currentPage();
  }

  get canEdit(): boolean {
    return this.editor.canEdit;
  }

  /** View of the canvas (engine view when running; the store's otherwise). */
  get view(): ViewState {
    const c = this.client;
    if (c) return c.view;
    const v = this.state.viewport;
    return { ...v, zoom: v.zoom || 1, dpr: globalThis.devicePixelRatio || 1 };
  }

  get zoom(): number {
    return this.view.zoom;
  }

  toPage(p: Point): Point {
    const v = this.view;
    return { x: v.x + p.x / v.zoom, y: v.y + p.y / v.zoom };
  }

  toScreen(p: Point): Point {
    const v = this.view;
    return { x: (p.x - v.x) * v.zoom, y: (p.y - v.y) * v.zoom };
  }

  /** Top-level selected ids (document order, pages excluded). */
  selectedIds(): Id[] {
    const design = this.design;
    if (!design) return [];
    return topLevelSelection(design, this.state.selection).filter(
      (id) => design.nodes[id]?.type !== "page",
    );
  }

  /** Selection box of the current selection (cached per document version and selection). */
  selection(): SelectionBox | null {
    const design = this.design;
    const ids = this.state.selection;
    const cache = this.selectionCache;
    if (cache.design === design && cache.ids === ids) return cache.box;
    const box = design ? selectionBox(design, this.selectedIds()) : null;
    this.selectionCache = { design, ids, box };
    return box;
  }

  tool(): Tool | undefined {
    return this.tools.get(activeTool(this.state)) ?? this.tools.get("select");
  }

  /** The handler that gets input: the mode, else the tool. */
  private handler() {
    return this.mode ?? this.tool();
  }

  // ---------------------------------------------------------------------------------------------------------
  // DOM chrome state (read with useSyncExternalStore)

  getUi = (): CanvasUi => this.uiState;

  subscribeUi = (listener: () => void): (() => void) => {
    this.uiListeners.add(listener);
    return () => this.uiListeners.delete(listener);
  };

  setUi(patch: Partial<CanvasUi>): void {
    this.uiState = { ...this.uiState, ...patch };
    for (const l of this.uiListeners) l();
  }

  // ---------------------------------------------------------------------------------------------------------
  // Editing helpers for tools

  /** Hit path at a screen point (page child first, deepest last). */
  async hitPath(screen: Point, options: { includeLocked?: boolean } = {}): Promise<Id[]> {
    const client = this.client;
    const design = this.design;
    const pageId = this.pageId;
    if (!design || !pageId) return [];
    if (client?.hasDesign) {
      try {
        const r = await client.hitTestScreen(screen, {
          deep: true,
          tolerance: 4,
          ...(options.includeLocked ? { includeLocked: true } : {}),
        });
        return r.path;
      } catch {
        // Fall through to the box test (engine restarting).
      }
    }
    return localHitPath(design, pageId, this.toPage(screen), 4 / this.zoom);
  }

  /** Snapping through the engine (null when disabled, unavailable or failing). */
  async snapRect(req: SnapRequest): Promise<SnapResult | null> {
    const client = this.client;
    if (!client?.hasDesign || !this.state.panels.snapping) return null;
    try {
      return await client.snap({
        distances: true,
        ...req,
        options: { threshold: 6, ...req.options },
      });
    } catch {
      return null;
    }
  }

  /** Live preview of ops (one transaction per pointer move; the engine keeps only the newest). */
  preview(ops: Op[], label: string): void {
    void this.editor.preview(makeTransaction(ops, label));
  }

  async commit(label: string, options: Partial<ApplyOptions> = {}): Promise<boolean> {
    const r = await this.editor.commitPreview({ label, ...options });
    return !!r && r.applied.length > 0;
  }

  async cancelPreview(): Promise<void> {
    await this.editor.cancelPreview();
  }

  /** After drawing a shape: back to the select tool unless the tool is locked. */
  finishTool(): void {
    if (!this.state.toolLocked && this.state.tool !== "select") this.editor.setTool("select");
  }

  setCursor(cursor: string): void {
    if (cursor === this.cursorValue) return;
    this.cursorValue = cursor;
    this.root.style.cursor = cursor;
  }

  /** Requests an overlay redraw on the next animation frame. */
  invalidate(): void {
    if (this.raf || this.disposed) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.draw();
    });
  }

  addLayer(id: string, order: number, draw: OverlayLayer): () => void {
    this.layers.set(id, { order, draw });
    this.invalidate();
    return () => {
      this.layers.delete(id);
      this.invalidate();
    };
  }

  addInterceptor(i: Interceptor): () => void {
    this.interceptors.add(i);
    return () => this.interceptors.delete(i);
  }

  /** Enters a mode (exits the current one first). */
  async enterMode(mode: Mode): Promise<void> {
    if (this.mode) await this.exitMode("api");
    this.mode = mode;
    this.updateCursor();
    this.invalidate();
  }

  async exitMode(reason: Parameters<Mode["exit"]>[0]): Promise<void> {
    const mode = this.mode;
    if (!mode) return;
    this.mode = null;
    await mode.exit(reason);
    this.updateCursor();
    this.invalidate();
  }

  /** Ends a mode from inside (the mode already cleaned up). */
  modeEnded(mode: Mode): void {
    if (this.mode === mode) {
      this.mode = null;
      this.updateCursor();
      this.invalidate();
    }
  }

  // ---------------------------------------------------------------------------------------------------------
  // Pointer input

  pointerInfo(e: PointerEvent | MouseEvent, clickCount = 1): CanvasPointer {
    const rect = this.bounds();
    const screen = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    const pe = e as PointerEvent;
    return {
      screen,
      page: this.toPage(screen),
      button: e.button,
      buttons: e.buttons,
      shift: e.shiftKey,
      alt: e.altKey,
      mod: this.platform === "mac" ? e.metaKey : e.ctrlKey,
      ctrl: e.ctrlKey,
      meta: e.metaKey,
      pointerType: pe.pointerType ?? "mouse",
      pointerId: pe.pointerId ?? 1,
      clickCount,
      pressure: pe.pressure ?? 0.5,
      time: e.timeStamp,
    };
  }

  private bounds(): DOMRect {
    if (!this.rect) this.rect = this.root.getBoundingClientRect();
    return this.rect;
  }

  private clickCount(e: PointerEvent): number {
    const prev = this.lastDown;
    const count =
      prev &&
      e.timeStamp - prev.time < DOUBLE_CLICK_MS &&
      Math.hypot(e.clientX - prev.x, e.clientY - prev.y) < DOUBLE_CLICK_SLOP
        ? prev.count + 1
        : 1;
    this.lastDown = { time: e.timeStamp, x: e.clientX, y: e.clientY, count };
    return count;
  }

  /** Starts a gesture from a pointer down handled by DOM chrome (rulers). */
  beginExternal(ev: PointerEvent, g: Gesture): void {
    if (this.gesture || this.starting) return;
    try {
      this.root.setPointerCapture(ev.pointerId);
    } catch {
      // Synthetic events have no active pointer.
    }
    this.lastPointer = this.pointerInfo(ev);
    this.begin(g);
  }

  private onPointerDown = (ev: PointerEvent): void => {
    // Rulers, toolbars and composers inside the layer handle their own input.
    if (ev.target instanceof Element && ev.target.closest("[data-canvas-chrome]")) return;
    if (ev.pointerType === "touch") {
      this.touches.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
      if (this.touches.size === 2) {
        void this.cancelGesture();
        this.startPinch();
        return;
      }
      if (this.touches.size > 2 || this.pinch) return;
    }
    // A press that arrives while the previous (already released) press is still resolving its hit test
    // (fast double clicks) runs right after it.
    if (this.starting && this.queuedUp && ev.button === 0) {
      this.deferredDown = ev;
      return;
    }
    if (this.gesture || this.starting) return;
    // Right click: select what is under the pointer, then let the context menu open.
    if (ev.button === 2) {
      const e = this.pointerInfo(ev);
      void this.contextSelect(e);
      return;
    }
    if (ev.button !== 0 && ev.button !== 1) return;
    // Keep keyboard focus on the canvas (commands like delete / nudge act on it).
    if (!isEditableTarget(ev.target)) {
      const active = document.activeElement;
      if (
        active instanceof HTMLElement &&
        isEditableTarget(active) &&
        !this.domLayer.contains(active)
      )
        active.blur();
    }
    try {
      this.root.setPointerCapture(ev.pointerId);
    } catch {
      // Synthetic events in tests have no active pointer.
    }
    const e = this.pointerInfo(ev, this.clickCount(ev));
    this.lastPointer = e;
    this.queuedMove = null;
    this.queuedUp = null;
    // Middle button pans with any tool.
    if (ev.button === 1) {
      ev.preventDefault();
      const hand = this.tools.get("hand");
      if (hand) this.begin(hand.down(this, e));
      return;
    }
    if (!this.mode && e.button === 0) {
      for (const i of this.interceptors) {
        const g = i.down(this, e);
        if (g) {
          this.begin(g);
          return;
        }
      }
    }
    const handler = this.handler();
    if (!handler) return;
    if (e.clickCount === 2 && handler.doubleClick) {
      void Promise.resolve(handler.doubleClick(this, e)).then(() => this.invalidate());
      return;
    }
    this.begin(handler.down(this, e));
  };

  private begin(started: Gesture | null | Promise<Gesture | null>): void {
    if (!(started instanceof Promise)) {
      this.gesture = started;
      this.afterStart();
      return;
    }
    this.starting = started;
    void started.then(
      async (g) => {
        if (this.starting !== started) return;
        this.starting = null;
        this.gesture = g;
        this.afterStart();
        if (!g) return;
        if (this.queuedMove) g.move(this.queuedMove);
        const up = this.queuedUp;
        if (up) {
          this.queuedUp = null;
          await this.finish(up);
          // The pointer may have moved on after the release: refresh hover / measurements there.
          const last = this.lastPointer;
          if (!this.deferredDown && !this.gesture && !this.starting && last && last.buttons === 0)
            this.hover(last);
        }
        const next = this.deferredDown;
        const nextUp = this.deferredUp;
        this.deferredDown = null;
        this.deferredUp = null;
        if (next) {
          this.onPointerDown(next);
          if (nextUp) {
            if (this.starting) this.queuedUp = nextUp;
            else void this.finish(nextUp);
          }
        }
      },
      () => {
        this.starting = null;
      },
    );
  }

  private afterStart(): void {
    if (this.gesture?.cursor) this.setCursor(this.gesture.cursor);
    if (this.gesture) this.setHover(null);
    this.invalidate();
  }

  private onPointerMove = (ev: PointerEvent): void => {
    if (ev.pointerType === "touch" && this.touches.has(ev.pointerId)) {
      this.touches.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
      if (this.pinch) {
        this.updatePinch();
        return;
      }
    }
    const e = this.pointerInfo(ev, this.lastDown?.count ?? 1);
    this.lastPointer = e;
    if (this.starting) {
      // Moves after the release (fast clicks while the hit test resolves) are hover, not part of the press.
      if (!this.queuedUp) this.queuedMove = e;
      return;
    }
    if (this.gesture) {
      this.gesture.move(e);
      if (this.gesture.cursor) this.setCursor(this.gesture.cursor);
      this.invalidate();
      return;
    }
    if (ev.buttons !== 0 && ev.pointerType !== "mouse") return;
    this.hover(e);
  };

  private onPointerUp = (ev: PointerEvent): void => {
    if (ev.pointerType === "touch") {
      this.touches.delete(ev.pointerId);
      if (this.pinch) {
        if (this.touches.size < 2) this.pinch = null;
        return;
      }
    }
    try {
      if (this.root.hasPointerCapture(ev.pointerId)) this.root.releasePointerCapture(ev.pointerId);
    } catch {
      // Not captured.
    }
    const e = this.pointerInfo(ev, this.lastDown?.count ?? 1);
    if (this.deferredDown) {
      this.deferredUp = e;
      return;
    }
    if (this.starting) {
      this.queuedUp = e;
      return;
    }
    void this.finish(e);
  };

  private async finish(e: CanvasPointer): Promise<void> {
    const g = this.gesture;
    if (!g) return;
    this.gesture = null;
    try {
      await g.up(e);
    } finally {
      this.snap = null;
      this.liveBox = null;
      this.hideSelection = false;
      this.dropTarget = null;
      this.updateCursor();
      this.invalidate();
    }
  }

  private onPointerCancel = (ev: PointerEvent): void => {
    if (ev.pointerType === "touch") {
      this.touches.delete(ev.pointerId);
      if (this.touches.size < 2) this.pinch = null;
    }
    void this.cancelGesture();
  };

  /** Cancels the running gesture (Escape, lost capture, tool change). */
  async cancelGesture(): Promise<void> {
    this.starting = null;
    this.deferredDown = null;
    this.deferredUp = null;
    this.queuedMove = null;
    this.queuedUp = null;
    const g = this.gesture;
    this.gesture = null;
    this.snap = null;
    this.liveBox = null;
    this.hideSelection = false;
    this.dropTarget = null;
    if (g) await g.cancel();
    this.updateCursor();
    this.invalidate();
  }

  private onLeave = (): void => {
    if (!this.gesture) this.setHover(null);
  };

  private async contextSelect(e: CanvasPointer): Promise<void> {
    if (this.mode) return;
    const design = this.design;
    if (!design) return;
    const path = await this.hitPath(e.screen);
    const target = pickTarget(design, path, this.state, { deep: e.mod });
    if (!target) {
      if (this.state.selection.length > 0) {
        const box = this.selection();
        if (box && obbContains(box.obb, e.page)) return;
      }
      this.editor.clearSelection();
      return;
    }
    if (!this.state.selection.includes(target)) this.editor.select([target]);
  }

  // ---------------------------------------------------------------------------------------------------------
  // Hover

  private hover(e: CanvasPointer): void {
    const handler = this.handler();
    handler?.hover?.(this, e);
    this.updateCursor();
    if (this.altDown) this.invalidate();
  }

  /** Hover hit test with at most one engine query in flight (the newest pointer position wins). */
  hoverPick(e: CanvasPointer, pick: (path: Id[]) => Id | null): void {
    if (this.hoverInFlight) {
      this.hoverQueued = e;
      return;
    }
    this.hoverInFlight = true;
    const seq = ++this.hoverSeq;
    void this.hitPath(e.screen).then(
      (path) => {
        this.hoverInFlight = false;
        if (seq === this.hoverSeq && !this.gesture && !this.starting) this.setHover(pick(path));
        const next = this.hoverQueued;
        this.hoverQueued = null;
        if (next) this.hoverPick(next, pick);
      },
      () => {
        this.hoverInFlight = false;
      },
    );
  }

  setHover(id: Id | null): void {
    if (this.state.hover !== id) this.editor.store.setState({ hover: id });
  }

  updateCursor(): void {
    if (this.gesture?.cursor) {
      this.setCursor(this.gesture.cursor);
      return;
    }
    const e = this.lastPointer;
    if (e && !this.mode) {
      for (const i of this.interceptors) {
        const cursor = i.cursor(this, e);
        if (cursor) {
          this.setCursor(cursor);
          return;
        }
      }
    }
    const handler = this.handler();
    this.setCursor(handler?.cursor?.(this) ?? "default");
  }

  // ---------------------------------------------------------------------------------------------------------
  // Wheel, pinch

  private onWheel = (e: WheelEvent): void => {
    const client = this.client;
    if (!client) return;
    e.preventDefault();
    this.viewAnimator?.stop();
    const rect = this.bounds();
    const p = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    if (e.ctrlKey || e.metaKey) {
      client.zoomAt(
        p,
        client.view.zoom * wheelZoomFactor(e.deltaY, e.deltaMode, e.ctrlKey && !e.metaKey),
      );
    } else {
      const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
      client.panBy(-(e.shiftKey ? e.deltaY : e.deltaX) * k, -(e.shiftKey ? 0 : e.deltaY) * k);
    }
    // A gesture follows the pointer in page space: re-run it at the new view.
    if (this.gesture && this.lastPointer) {
      const e2 = { ...this.lastPointer, page: this.toPage(this.lastPointer.screen) };
      this.lastPointer = e2;
      this.gesture.move(e2);
    }
  };

  private startPinch(): void {
    const pts = [...this.touches.values()];
    const a = pts[0] as Point;
    const b = pts[1] as Point;
    const rect = this.bounds();
    this.pinch = {
      dist: Math.hypot(a.x - b.x, a.y - b.y) || 1,
      center: { x: (a.x + b.x) / 2 - rect.left, y: (a.y + b.y) / 2 - rect.top },
      zoom: this.zoom,
    };
  }

  private updatePinch(): void {
    const client = this.client;
    const pinch = this.pinch;
    if (!client || !pinch) return;
    this.viewAnimator?.stop();
    const pts = [...this.touches.values()];
    const a = pts[0] as Point;
    const b = pts[1] as Point;
    const rect = this.bounds();
    const center = { x: (a.x + b.x) / 2 - rect.left, y: (a.y + b.y) / 2 - rect.top };
    const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
    client.panBy(center.x - pinch.center.x, center.y - pinch.center.y);
    client.zoomAt(center, pinch.zoom * (d / pinch.dist));
    pinch.center = center;
  }

  /** Safari trackpad pinch (non-standard `gesture*` events). */
  private safariGesture: { zoom: number } | null = null;

  private onGestureStart = (e: Event): void => {
    e.preventDefault();
    this.safariGesture = { zoom: this.zoom };
  };

  private onGestureChange = (e: Event): void => {
    e.preventDefault();
    const g = e as Event & { scale?: number; clientX?: number; clientY?: number };
    const client = this.client;
    if (!client || !this.safariGesture || !g.scale) return;
    const rect = this.bounds();
    const at = {
      x: (g.clientX ?? rect.left + rect.width / 2) - rect.left,
      y: (g.clientY ?? rect.top + rect.height / 2) - rect.top,
    };
    client.zoomAt(at, this.safariGesture.zoom * g.scale);
  };

  // ---------------------------------------------------------------------------------------------------------
  // Keyboard

  private onKeyDown = (e: KeyboardEvent): void => {
    if (this.disposed || e.defaultPrevented) return;
    if (e.key === "Alt" && !this.altDown) {
      this.altDown = true;
      this.invalidate();
    }
    const target = e.target;
    const inDom = target instanceof Node && this.domLayer.contains(target);
    if (isEditableTarget(target) && !inDom) return;
    if (target instanceof Element && target.closest("[role=dialog],[role=alertdialog],[role=menu]"))
      return;
    if (this.state.modal || this.state.paletteOpen) return;
    if (isModifier(e.key)) {
      this.redispatch(e);
      return;
    }
    if (e.key === "Escape" && (this.gesture || this.starting)) {
      e.preventDefault();
      e.stopPropagation();
      void this.cancelGesture();
      return;
    }
    // Tool / mode keys (Enter to edit, Delete points, pen Backspace...) only while the keyboard is on the canvas
    // (or nowhere): Enter on a focused panel button keeps activating that button.
    if (
      target instanceof Element &&
      target !== document.body &&
      target !== document.documentElement &&
      !inDom &&
      !target.closest("[data-editor-canvas]")
    )
      return;
    const handler = this.handler();
    if (handler?.keyDown?.(this, e)) {
      e.preventDefault();
      e.stopPropagation();
      this.invalidate();
    }
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    if (e.key === "Alt") {
      this.altDown = false;
      this.invalidate();
    }
    if (isModifier(e.key)) this.redispatch(e);
  };

  private onBlur = (): void => {
    if (this.altDown) {
      this.altDown = false;
      this.invalidate();
    }
  };

  /** Modifier pressed / released mid-gesture: re-run the gesture with the new modifiers. */
  private redispatch(e: KeyboardEvent): void {
    const last = this.lastPointer;
    if (!last) return;
    const next: CanvasPointer = {
      ...last,
      shift: e.shiftKey,
      alt: e.altKey,
      mod: this.platform === "mac" ? e.metaKey : e.ctrlKey,
      ctrl: e.ctrlKey,
      meta: e.metaKey,
    };
    this.lastPointer = next;
    if (this.gesture) {
      this.gesture.move(next);
      this.invalidate();
    } else {
      this.updateCursor();
    }
  }

  // ---------------------------------------------------------------------------------------------------------
  // Drawing

  private resize(): void {
    this.rect = null;
    const rect = this.bounds();
    const dpr = globalThis.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(rect.width * dpr));
    const h = Math.max(1, Math.round(rect.height * dpr));
    if (this.overlay.width !== w || this.overlay.height !== h) {
      this.overlay.width = w;
      this.overlay.height = h;
    }
    this.invalidate();
  }

  refreshTheme(): void {
    this.theme = readTheme(this.root);
    this.invalidate();
  }

  /** Draws the overlay now (normally scheduled with `invalidate`). */
  draw(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const dpr = this.overlay.width / Math.max(1, this.bounds().width);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.overlay.width, this.overlay.height);
    const design = this.design;
    const page = this.page;
    if (!design || !page) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const p = new Painter(ctx, this.view, this.theme);
    const s = this.state;
    if (s.panels.layoutGrid) drawLayoutGrid(p, page);
    if (s.panels.rulers || this.activeGuide !== null) drawPageGuides(p, page, this.activeGuide);
    const layers = [...this.layers.values()].sort((a, b) => a.order - b.order);
    for (const l of layers) if (l.order < 0) l.draw(this, p);
    const modeShowsSelection = !this.mode || this.mode.showsSelection === true;
    const gestureHidesHover = this.gesture ? this.gesture.hidesHover !== false : false;
    if (s.hover && !gestureHidesHover && modeShowsSelection && !s.selection.includes(s.hover)) {
      drawHover(p, design, s.hover);
    }
    if (modeShowsSelection && !this.hideSelection) {
      const sel = this.selection();
      const ids = this.selectedIds();
      if (sel && ids.length > 0) {
        const box = this.liveBox ?? sel.obb;
        const editable =
          this.canEdit && ids.some((id) => !design.nodes[id]?.locked) && !this.gesture;
        drawSelection(p, design, this.liveBox ? [] : ids, box, { handles: editable });
      }
    }
    for (const l of layers) if (l.order >= 0) l.draw(this, p);
    this.tool()?.draw?.(this, p);
    this.mode?.draw?.(this, p);
    this.gesture?.draw?.(p);
    if (this.snap) drawSnap(p, this.snap);
  }

  // ---------------------------------------------------------------------------------------------------------
  // Lifecycle

  private attach(): void {
    const root = this.root;
    const on = <K extends keyof HTMLElementEventMap>(
      type: K,
      fn: (e: HTMLElementEventMap[K]) => void,
      opts?: AddEventListenerOptions,
    ) => {
      root.addEventListener(type, fn as EventListener, opts);
      this.disposers.push(() => root.removeEventListener(type, fn as EventListener, opts));
    };
    on("pointerdown", this.onPointerDown);
    on("pointermove", this.onPointerMove);
    on("pointerup", this.onPointerUp);
    on("pointercancel", this.onPointerCancel);
    on("pointerleave", this.onLeave);
    on("wheel", this.onWheel, { passive: false });
    root.addEventListener("gesturestart", this.onGestureStart);
    root.addEventListener("gesturechange", this.onGestureChange);
    this.disposers.push(() => {
      root.removeEventListener("gesturestart", this.onGestureStart);
      root.removeEventListener("gesturechange", this.onGestureChange);
    });
    // Capture phase: canvas modes and tools see keys before the global shortcut dispatcher.
    window.addEventListener("keydown", this.onKeyDown, true);
    window.addEventListener("keyup", this.onKeyUp, true);
    window.addEventListener("blur", this.onBlur);
    this.disposers.push(() => {
      window.removeEventListener("keydown", this.onKeyDown, true);
      window.removeEventListener("keyup", this.onKeyUp, true);
      window.removeEventListener("blur", this.onBlur);
    });
    if (typeof ResizeObserver !== "undefined") {
      const ro = new ResizeObserver(() => this.resize());
      ro.observe(root);
      this.disposers.push(() => ro.disconnect());
    }
    const onWindowResize = () => {
      this.rect = null;
    };
    window.addEventListener("resize", onWindowResize);
    window.addEventListener("scroll", onWindowResize, true);
    this.disposers.push(() => {
      window.removeEventListener("resize", onWindowResize);
      window.removeEventListener("scroll", onWindowResize, true);
    });
    // The bridge mirrors every engine view change into `viewport`, so the store drives redraws.
    this.disposers.push(this.editor.store.subscribe((s, prev) => this.onState(s, prev)));
    this.resize();
    this.syncTool();
  }

  private onState(s: EditorState, prev: EditorState): void {
    if (activeTool(s) !== activeTool(prev)) this.syncTool();
    if (
      s.doc.design !== prev.doc.design ||
      s.selection !== prev.selection ||
      s.hover !== prev.hover ||
      s.viewport !== prev.viewport ||
      s.pageId !== prev.pageId ||
      s.panels !== prev.panels ||
      s.scopeId !== prev.scopeId ||
      s.mode !== prev.mode
    ) {
      this.invalidate();
    }
    if (s.pageId !== prev.pageId && this.mode) void this.exitMode("api");
    else if (s.doc.design !== prev.doc.design && this.mode && !this.gesture && !this.starting)
      this.mode.documentChanged?.();
    if (s.textEditing !== prev.textEditing) this.followTextEditing(s.textEditing);
    if (s.selection !== prev.selection && this.mode?.kind === "path") {
      // Selecting another layer (layers panel, undo) leaves path editing.
      const editing = (this.mode as Mode & { nodeId?: Id }).nodeId;
      if (editing && !s.selection.includes(editing)) void this.exitMode("selection");
    }
  }

  /** `textEditing` set elsewhere (Enter command, layers panel) starts or ends the text mode. */
  private followTextEditing(id: Id | null): void {
    const mode = this.mode;
    const editing = mode instanceof TextMode ? mode.nodeId : null;
    if (id && id !== editing) void startTextEditing(this, id, { select: "end" });
    else if (!id && editing) void this.exitMode("api");
  }

  private syncTool(): void {
    const next = activeTool(this.state);
    if (next === this.toolId) return;
    const prev = this.toolId ? this.tools.get(this.toolId) : undefined;
    void this.cancelGesture();
    prev?.deactivate?.(this);
    this.toolId = next;
    // Switching tools leaves path editing and crop (text editing keeps keyboard focus in its input).
    if (this.mode && this.mode.kind !== "text" && next !== "select" && next !== "hand")
      void this.exitMode("tool");
    this.tool()?.activate?.(this);
    this.setHover(null);
    this.updateCursor();
    this.invalidate();
  }

  dispose(): void {
    if (this.disposed) return;
    void this.cancelGesture();
    if (this.mode) void this.exitMode("api");
    this.disposed = true;
    if (this.raf) cancelAnimationFrame(this.raf);
    for (const d of this.disposers.splice(0).reverse()) d();
    this.setHover(null);
  }
}

function isModifier(key: string): boolean {
  return key === "Shift" || key === "Alt" || key === "Meta" || key === "Control";
}
