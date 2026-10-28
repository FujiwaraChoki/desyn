// Text editing bridge: the editor's DOM overlay for live text editing on the canvas. A transparent <textarea>
// receives keyboard input, IME composition, clipboard and accessibility; the engine renders the text itself
// (identical to every other client) and answers caret / selection / hit / movement queries with its own layout
// (bidi, wrapping, ligatures). Each change is a live preview; edits commit after a pause (DOCUMENT_MODEL §6:
// one transaction per debounced edit, never per keystroke).
import type { ApplyResult, Id, TextRun, TextStyle } from "@desyn/schema";
import type { EngineClient } from "./client";
import type { Affinity, Point, TextMove, TextQueryResult } from "./protocol";
import {
  applyRunStyle,
  caretStyle,
  diffText,
  type RunStyle,
  rangeHasStyle,
  replaceText,
  runsText,
  textTransaction,
} from "./text-ops";
import { applyAffine, pageToScreen } from "./viewport";

export interface TextGeometry {
  /** Caret segment in screen px (null while a range is selected). */
  caret: { x0: number; y0: number; x1: number; y1: number } | null;
  /** Selection quads in screen px. */
  selection: Point[][];
  /** IME composition underline quads in screen px. */
  composition: Point[][];
  focused: boolean;
}

export interface TextBridgeOptions {
  nodeId: Id;
  /** Overlay element whose top-left corner coincides with the canvas' (position: relative / absolute). */
  container: HTMLElement;
  /** Initial selection: everything, the end, or the caret under a screen point. */
  select?: "all" | "end" | { at: Point };
  /** Draw caret and selection with the built-in overlay (default true). */
  overlay?: boolean;
  /** Called with screen geometry after every change (custom caret / selection drawing). */
  onGeometry?: (g: TextGeometry) => void;
  /** Called after each committed edit (send `result.applied` to the server, keep `inverse` for undo). */
  onCommit?: (result: ApplyResult) => void;
  /** Called once editing ends. */
  onEnd?: (reason: "escape" | "blur" | "api") => void;
  /** Idle time before an edit is committed (ms, default 400). */
  commitDelayMs?: number;
  /** Selection color (default the sun accent). */
  accent?: string;
  /** Accessible label of the input. */
  label?: string;
}

interface Snapshot {
  runs: TextRun[];
  start: number;
  end: number;
}

const ACCENT = "#ffb02e";
/** U+2028: a forced line break inside a paragraph (Shift+Enter). */
const LINE_BREAK = String.fromCharCode(0x2028);

export class TextEditBridge {
  readonly nodeId: Id;
  private runs: TextRun[];
  private readonly baseStyle: TextStyle;
  private readonly input: HTMLTextAreaElement;
  private readonly layer: HTMLDivElement | null;
  private readonly svg: SVGSVGElement | null;
  private readonly caretEl: HTMLDivElement | null;
  private readonly options: TextBridgeOptions;
  private anchor = 0;
  private focus = 0;
  private affinity: Affinity = "downstream";
  private goalX: number | null = null;
  private typingStyle: RunStyle | null = null;
  private composing: { start: number; length: number } | null = null;
  private commitTimer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;
  private queue: Promise<void> = Promise.resolve();
  private queued = 0;
  private ended = false;
  private dragging = false;
  private readonly undoStack: Snapshot[] = [];
  private readonly redoStack: Snapshot[] = [];
  private lastPush = 0;
  private pageCaret: [number, number, number, number] | null = null;
  private pageSelection: Point[][] = [];
  private pageComposition: Point[][] = [];
  private queryId = 0;
  private readonly offs: (() => void)[] = [];

  constructor(
    private readonly client: EngineClient,
    options: TextBridgeOptions,
  ) {
    this.options = options;
    this.nodeId = options.nodeId;
    const node = client.design.nodes[options.nodeId];
    if (node?.type !== "text") throw new Error(`${options.nodeId} is not a text node`);
    this.runs = node.runs.map((r) => ({ ...r }));
    this.baseStyle = node.style;

    const input = document.createElement("textarea");
    input.value = runsText(this.runs);
    input.setAttribute("aria-label", options.label ?? `Edit text: ${node.name}`);
    input.setAttribute("autocomplete", "off");
    input.setAttribute("autocorrect", "off");
    input.setAttribute("autocapitalize", "off");
    input.spellcheck = false;
    input.wrap = "off";
    Object.assign(input.style, {
      position: "absolute",
      left: "0px",
      top: "0px",
      width: "1px",
      height: "1em",
      padding: "0",
      border: "0",
      margin: "0",
      opacity: "0",
      resize: "none",
      overflow: "hidden",
      whiteSpace: "pre",
      caretColor: "transparent",
      background: "transparent",
      color: "transparent",
      outline: "none",
      zIndex: "2",
      fontSize: "16px",
    } satisfies Partial<CSSStyleDeclaration>);
    options.container.appendChild(input);
    this.input = input;

    if (options.overlay !== false) {
      const layer = document.createElement("div");
      Object.assign(layer.style, {
        position: "absolute",
        inset: "0",
        pointerEvents: "none",
        overflow: "hidden",
        zIndex: "1",
      } satisfies Partial<CSSStyleDeclaration>);
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("width", "100%");
      svg.setAttribute("height", "100%");
      svg.style.position = "absolute";
      svg.style.inset = "0";
      svg.style.overflow = "visible";
      layer.appendChild(svg);
      const caret = document.createElement("div");
      caret.dataset.desynCaret = "";
      Object.assign(caret.style, {
        position: "absolute",
        left: "0px",
        top: "0px",
        width: "2px",
        background: options.accent ?? ACCENT,
        borderRadius: "1px",
        transformOrigin: "0 0",
        boxShadow: `0 0 8px ${options.accent ?? ACCENT}66`,
      } satisfies Partial<CSSStyleDeclaration>);
      layer.appendChild(caret);
      options.container.appendChild(layer);
      this.layer = layer;
      this.svg = svg;
      this.caretEl = caret;
      this.startBlink();
    } else {
      this.layer = null;
      this.svg = null;
      this.caretEl = null;
    }

    const on = <K extends keyof HTMLElementEventMap>(
      type: K,
      fn: (e: HTMLElementEventMap[K]) => void,
    ) => {
      input.addEventListener(type, fn as EventListener);
      this.offs.push(() => input.removeEventListener(type, fn as EventListener));
    };
    on("beforeinput", (e) => this.onBeforeInput(e));
    on("input", () => this.onInput());
    on("keydown", (e) => this.onKeyDown(e));
    on("compositionstart", () => {
      this.composing = { start: Math.min(input.selectionStart, input.selectionEnd), length: 0 };
    });
    on("compositionupdate", (e) => {
      if (this.composing) this.composing.length = e.data.length;
    });
    on("compositionend", () => {
      this.composing = null;
      this.pageComposition = [];
      this.scheduleCommit();
      void this.updateGeometry();
    });
    on("blur", () => {
      // Clicks on the canvas refocus the input (pointerDown); a real blur ends the session.
      setTimeout(() => {
        if (!this.ended && document.activeElement !== input && !this.dragging)
          void this.end("blur");
      }, 0);
    });
    on("focus", () => this.emitGeometry());
    this.offs.push(client.on("view", () => this.emitGeometry()));
    const onSelectionChange = () => {
      if (document.activeElement !== input || this.ended) return;
      if (
        input.selectionStart !== Math.min(this.anchor, this.focus) ||
        input.selectionEnd !== Math.max(this.anchor, this.focus)
      ) {
        this.readSelection();
        void this.updateGeometry();
      }
    };
    document.addEventListener("selectionchange", onSelectionChange);
    this.offs.push(() => document.removeEventListener("selectionchange", onSelectionChange));
  }

  /** Focuses the input and places the initial selection (input typed meanwhile is replayed after it). */
  start(): Promise<void> {
    this.input.focus({ preventScroll: true });
    return this.run(async () => {
      const len = this.input.value.length;
      const sel = this.options.select ?? "end";
      if (sel === "all") this.setSelection(0, len);
      else if (sel === "end") this.setSelection(len, len);
      else {
        const idx = await this.indexAt(sel.at);
        this.setSelection(idx.index, idx.index, idx.affinity);
      }
      await this.updateGeometry();
    });
  }

  /** Queues `fn` after earlier keyboard / pointer actions and resolves when it ran. */
  private run(fn: () => void | Promise<void>): Promise<void> {
    return new Promise((resolve, reject) => {
      this.enqueue(async () => {
        try {
          await fn();
          resolve();
        } catch (e) {
          reject(e);
        }
      });
    });
  }

  /** Plain text being edited. */
  get text(): string {
    return this.input.value;
  }

  /** Current runs (styled text). */
  get currentRuns(): readonly TextRun[] {
    return this.runs;
  }

  /** Selection in UTF-16 offsets (`anchor` stays fixed while extending). */
  get selection(): { anchor: number; focus: number; start: number; end: number } {
    return {
      anchor: this.anchor,
      focus: this.focus,
      start: Math.min(this.anchor, this.focus),
      end: Math.max(this.anchor, this.focus),
    };
  }

  get active(): boolean {
    return !this.ended;
  }

  // ---------------------------------------------------------------------------------------------------------
  // Selection

  setSelection(anchor: number, focus = anchor, affinity: Affinity = "downstream"): void {
    const len = this.input.value.length;
    this.anchor = clamp(anchor, 0, len);
    this.focus = clamp(focus, 0, len);
    this.affinity = affinity;
    const start = Math.min(this.anchor, this.focus);
    const end = Math.max(this.anchor, this.focus);
    this.input.setSelectionRange(start, end, this.focus < this.anchor ? "backward" : "forward");
    if (start !== end) this.typingStyle = null;
    void this.updateGeometry();
  }

  private readSelection(): void {
    const i = this.input;
    if (i.selectionDirection === "backward") {
      this.anchor = i.selectionEnd;
      this.focus = i.selectionStart;
    } else {
      this.anchor = i.selectionStart;
      this.focus = i.selectionEnd;
    }
    this.affinity = "downstream";
  }

  private async indexAt(screen: Point): Promise<{ index: number; affinity: Affinity }> {
    const page = this.client.screenToPage(screen);
    const r = await this.client.textQuery({ op: "hit", nodeId: this.nodeId, x: page.x, y: page.y });
    return { index: r.index ?? 0, affinity: r.affinity ?? "downstream" };
  }

  /** Whether a screen point is inside the text box. */
  async contains(screen: Point): Promise<boolean> {
    const layout = await this.client.textLayout(this.nodeId);
    const [a, b, c, d, e, f] = layout.transform;
    const det = a * d - b * c;
    if (!det) return false;
    const p = this.client.screenToPage(screen);
    const x = (d * (p.x - e) - c * (p.y - f)) / det;
    const y = (-b * (p.x - e) + a * (p.y - f)) / det;
    return (
      x >= 0 && y >= 0 && x <= layout.width && y <= Math.max(layout.height, layout.contentTop + 1)
    );
  }

  /** Canvas pointer down while editing: caret placement, shift-extend, double (word) / triple (paragraph). */
  pointerDown(screen: Point, opts: { shift?: boolean; clickCount?: number } = {}): Promise<void> {
    this.input.focus({ preventScroll: true });
    this.dragging = true;
    return this.run(() => this.placeAt(screen, opts));
  }

  private async placeAt(
    screen: Point,
    opts: { shift?: boolean; clickCount?: number },
  ): Promise<void> {
    const { index, affinity } = await this.indexAt(screen);
    const count = opts.clickCount ?? 1;
    if (count >= 2) {
      const unit = count === 2 ? "word" : "paragraph";
      const r = await this.client.textQuery({ op: "range", nodeId: this.nodeId, index, unit });
      this.setSelection(r.start ?? index, r.end ?? index);
      return;
    }
    if (opts.shift) this.setSelection(this.anchor, index, affinity);
    else this.setSelection(index, index, affinity);
    this.goalX = null;
  }

  /** Canvas pointer move during a drag: extends the selection. */
  async pointerMove(screen: Point): Promise<void> {
    if (!this.dragging) return;
    const { index, affinity } = await this.indexAt(screen);
    if (this.dragging) this.setSelection(this.anchor, index, affinity);
  }

  pointerUp(): void {
    this.dragging = false;
    this.input.focus({ preventScroll: true });
  }

  // ---------------------------------------------------------------------------------------------------------
  // Editing

  private pushUndo(force = false): void {
    const now = Date.now();
    if (!force && now - this.lastPush < 600 && this.undoStack.length > 0) return;
    this.lastPush = now;
    const s = this.selection;
    this.undoStack.push({ runs: this.runs.map((r) => ({ ...r })), start: s.start, end: s.end });
    if (this.undoStack.length > 200) this.undoStack.shift();
    this.redoStack.length = 0;
  }

  private onInput(): void {
    const before = runsText(this.runs);
    const after = this.input.value;
    if (before === after) {
      this.readSelection();
      void this.updateGeometry();
      return;
    }
    this.pushUndo();
    const d = diffText(before, after);
    this.runs = replaceText(this.runs, d.start, d.end, d.insert, this.typingStyle ?? undefined);
    this.readSelection();
    if (d.insert) this.client.noteText(d.insert);
    this.changed();
  }

  /** Inserts text at the selection (paste handlers, emoji pickers). */
  insertText(text: string): void {
    const s = this.selection;
    this.pushUndo(true);
    this.runs = replaceText(this.runs, s.start, s.end, text, this.typingStyle ?? undefined);
    this.input.value = runsText(this.runs);
    const caret = s.start + text.length;
    this.input.setSelectionRange(caret, caret);
    this.readSelection();
    this.client.noteText(text);
    this.changed();
  }

  /**
   * Applies a style to the selection, or to the next typed text when the selection is collapsed. `toggle`
   * flips between `value` and the base style's value (bold / italic / underline buttons).
   */
  setStyle<K extends keyof TextStyle>(key: K, value: TextStyle[K], toggle = false): void {
    const s = this.selection;
    if (s.start === s.end) {
      const current =
        this.typingStyle?.[key] ?? caretStyle(this.runs, s.start)?.[key] ?? this.baseStyle[key];
      const next = toggle && current === value ? this.baseStyle[key] : value;
      this.typingStyle = {
        ...(this.typingStyle ?? caretStyle(this.runs, s.start) ?? {}),
        [key]: next,
      };
      return;
    }
    const has = rangeHasStyle(this.runs, s.start, s.end, key, value, this.baseStyle);
    const next = toggle && has ? this.baseStyle[key] : value;
    this.pushUndo(true);
    const patch = { [key]: next === this.baseStyle[key] ? null : next } as {
      [P in keyof TextStyle]?: TextStyle[P] | null;
    };
    this.runs = applyRunStyle(this.runs, s.start, s.end, patch);
    this.changed();
  }

  undo(): void {
    const prev = this.undoStack.pop();
    if (!prev) return;
    const s = this.selection;
    this.redoStack.push({ runs: this.runs, start: s.start, end: s.end });
    this.restore(prev);
  }

  redo(): void {
    const next = this.redoStack.pop();
    if (!next) return;
    const s = this.selection;
    this.undoStack.push({ runs: this.runs, start: s.start, end: s.end });
    this.restore(next);
  }

  private restore(s: Snapshot): void {
    this.runs = s.runs.map((r) => ({ ...r }));
    this.input.value = runsText(this.runs);
    this.input.setSelectionRange(s.start, s.end);
    this.readSelection();
    this.lastPush = 0;
    this.changed();
  }

  private changed(): void {
    this.dirty = true;
    this.goalX = null;
    const tx = textTransaction(this.nodeId, this.runs, { id: "texteditprev", label: "Edit text" });
    void this.client.preview(tx).then(() => this.updateGeometry());
    this.scheduleCommit();
  }

  private scheduleCommit(): void {
    if (this.commitTimer) clearTimeout(this.commitTimer);
    this.commitTimer = setTimeout(() => {
      this.commitTimer = null;
      if (this.composing) {
        this.scheduleCommit();
        return;
      }
      void this.commit();
    }, this.options.commitDelayMs ?? 400);
  }

  /** Commits the pending edit now (no-op when nothing changed). */
  async commit(): Promise<ApplyResult | null> {
    if (this.commitTimer) {
      clearTimeout(this.commitTimer);
      this.commitTimer = null;
    }
    if (!this.dirty) return null;
    this.dirty = false;
    const result = await this.client.commitPreview({ label: "Edit text", source: "user" });
    if (result?.applied.length) this.options.onCommit?.(result);
    return result;
  }

  // ---------------------------------------------------------------------------------------------------------
  // Keys

  /**
   * Runs keyboard actions in order. Caret moves ask the engine (async), so typing that arrives while one is
   * pending must wait for it: such input is taken over in `beforeinput` and replayed in the queue.
   */
  private enqueue(fn: () => void | Promise<void>): void {
    this.queued += 1;
    this.queue = this.queue
      .then(fn)
      .catch(() => undefined)
      .finally(() => {
        this.queued -= 1;
      });
  }

  private onBeforeInput(e: InputEvent): void {
    if (this.queued === 0 || this.composing || e.isComposing) return;
    const t = e.inputType;
    if (t === "insertText" || t === "insertReplacementText") {
      e.preventDefault();
      const data = e.data ?? "";
      this.enqueue(() => this.insertText(data));
    } else if (t === "insertLineBreak" || t === "insertParagraph") {
      e.preventDefault();
      this.enqueue(() => this.insertText("\n"));
    } else if (t === "deleteContentBackward" || t === "deleteContentForward") {
      e.preventDefault();
      const forward = t === "deleteContentForward";
      this.enqueue(() => this.deleteChar(forward));
    }
  }

  /** Deletes the selection, or one grapheme before / after the caret. */
  deleteChar(forward: boolean): void {
    const s = this.selection;
    let start = s.start;
    let end = s.end;
    if (start === end) {
      const text = this.input.value;
      const seg = new Intl.Segmenter(undefined, { granularity: "grapheme" });
      const bounds = [...seg.segment(text)].map((g) => g.index).concat(text.length);
      if (forward) end = bounds.find((b) => b > start) ?? start;
      else start = [...bounds].reverse().find((b) => b < end) ?? end;
    }
    if (start === end) return;
    this.pushUndo(true);
    this.runs = replaceText(this.runs, start, end, "");
    this.input.value = runsText(this.runs);
    this.input.setSelectionRange(start, start);
    this.readSelection();
    this.changed();
  }

  private onKeyDown(e: KeyboardEvent): void {
    if (e.isComposing || this.composing) return;
    const mod = e.metaKey || e.ctrlKey;
    const mac = /Mac|iPhone|iPad/.test(navigator.platform);
    const word = mac ? e.altKey : e.ctrlKey;
    const lineKey = mac && e.metaKey;
    let move: TextMove | null = null;
    switch (e.key) {
      case "ArrowLeft":
        move = lineKey ? "lineStart" : word ? "wordLeft" : "left";
        break;
      case "ArrowRight":
        move = lineKey ? "lineEnd" : word ? "wordRight" : "right";
        break;
      case "ArrowUp":
        move = lineKey ? "docStart" : "up";
        break;
      case "ArrowDown":
        move = lineKey ? "docEnd" : "down";
        break;
      case "Home":
        move = e.ctrlKey ? "docStart" : "lineStart";
        break;
      case "End":
        move = e.ctrlKey ? "docEnd" : "lineEnd";
        break;
      case "Escape":
        e.preventDefault();
        this.enqueue(() => this.end("escape").then(() => undefined));
        return;
      case "Tab":
        e.preventDefault();
        this.enqueue(() => this.insertText("\t"));
        return;
      case "Enter":
        if (e.shiftKey) {
          // Forced line break inside the paragraph.
          e.preventDefault();
          this.enqueue(() => this.insertText(LINE_BREAK));
        }
        return;
      default:
        break;
    }
    if (move) {
      e.preventDefault();
      const extend = e.shiftKey;
      this.enqueue(() => this.moveCaret(move, extend));
      return;
    }
    if (!mod) return;
    const k = e.key.toLowerCase();
    const shift = e.shiftKey;
    if (k === "b") {
      e.preventDefault();
      const weight = (this.baseStyle.fontWeight >= 600 ? 400 : 700) as TextStyle["fontWeight"];
      this.enqueue(() => this.setStyle("fontWeight", weight, true));
    } else if (k === "i") {
      e.preventDefault();
      this.enqueue(() => this.setStyle("fontStyle", "italic", true));
    } else if (k === "u") {
      e.preventDefault();
      this.enqueue(() => this.setStyle("decoration", "underline", true));
    } else if (k === "z") {
      e.preventDefault();
      this.enqueue(() => (shift ? this.redo() : this.undo()));
    } else if (k === "y" && !mac) {
      e.preventDefault();
      this.enqueue(() => this.redo());
    }
  }

  /** Moves the caret with the engine's layout (visual bidi order, wrapped lines, goal column). */
  async moveCaret(direction: TextMove, extend = false): Promise<void> {
    const s = this.selection;
    // A plain left / right with a range collapses to its visual edge.
    if (!extend && s.start !== s.end && (direction === "left" || direction === "right")) {
      this.setSelection(direction === "left" ? s.start : s.end);
      return;
    }
    const vertical = direction === "up" || direction === "down";
    const r = await this.client.textQuery({
      op: "move",
      nodeId: this.nodeId,
      index: this.focus,
      affinity: this.affinity,
      direction,
      x: vertical ? (this.goalX ?? undefined) : undefined,
    });
    if (vertical && this.goalX === null) {
      const caret = await this.client.textQuery({
        op: "caret",
        nodeId: this.nodeId,
        index: this.focus,
        affinity: this.affinity,
      });
      this.goalX = caret.caret?.x ?? null;
    }
    const keepGoal = vertical ? this.goalX : null;
    const index = r.index ?? this.focus;
    this.setSelection(extend ? this.anchor : index, index, r.affinity ?? "downstream");
    this.goalX = keepGoal;
  }

  // ---------------------------------------------------------------------------------------------------------
  // Geometry

  private async updateGeometry(): Promise<void> {
    if (this.ended) return;
    const id = ++this.queryId;
    const s = this.selection;
    let caret: TextQueryResult | null = null;
    let sel: TextQueryResult | null = null;
    let comp: TextQueryResult | null = null;
    try {
      if (s.start === s.end) {
        caret = await this.client.textQuery({
          op: "caret",
          nodeId: this.nodeId,
          index: s.start,
          affinity: this.affinity,
        });
      } else {
        sel = await this.client.textQuery({
          op: "selection",
          nodeId: this.nodeId,
          start: s.start,
          end: s.end,
        });
      }
      if (this.composing && this.composing.length > 0) {
        comp = await this.client.textQuery({
          op: "selection",
          nodeId: this.nodeId,
          start: this.composing.start,
          end: this.composing.start + this.composing.length,
        });
      }
    } catch {
      return;
    }
    if (id !== this.queryId || this.ended) return;
    this.pageCaret = caret?.caretPage ?? null;
    this.pageSelection = sel?.quads ?? [];
    this.pageComposition = (comp?.rects ?? []).map((r) => {
      // Underline: a thin band at the bottom of each composition rectangle.
      const t = comp?.transform ?? [1, 0, 0, 1, 0, 0];
      const y0 = r.y + r.h - 2;
      return [
        applyAffine(t, { x: r.x, y: y0 }),
        applyAffine(t, { x: r.x + r.w, y: y0 }),
        applyAffine(t, { x: r.x + r.w, y: r.y + r.h }),
        applyAffine(t, { x: r.x, y: r.y + r.h }),
      ];
    });
    this.emitGeometry();
  }

  private emitGeometry(): void {
    if (this.ended) return;
    const view = this.client.view;
    const toScreen = (p: Point) => pageToScreen(view, p);
    let caret: TextGeometry["caret"] = null;
    if (this.pageCaret) {
      const [x0, y0, x1, y1] = this.pageCaret;
      const a = toScreen({ x: x0, y: y0 });
      const b = toScreen({ x: x1, y: y1 });
      caret = { x0: a.x, y0: a.y, x1: b.x, y1: b.y };
    }
    const g: TextGeometry = {
      caret,
      selection: this.pageSelection.map((q) => q.map(toScreen)),
      composition: this.pageComposition.map((q) => q.map(toScreen)),
      focused: document.activeElement === this.input,
    };
    // Keep the input at the caret so IME candidate windows open next to it.
    const anchorPoint = caret ? { x: caret.x0, y: caret.y0 } : g.selection[0]?.[0];
    if (anchorPoint) {
      this.input.style.left = `${anchorPoint.x}px`;
      this.input.style.top = `${anchorPoint.y}px`;
      if (caret)
        this.input.style.height = `${Math.max(8, Math.hypot(caret.x1 - caret.x0, caret.y1 - caret.y0))}px`;
    }
    this.drawOverlay(g);
    this.options.onGeometry?.(g);
  }

  private drawOverlay(g: TextGeometry): void {
    const svg = this.svg;
    const caretEl = this.caretEl;
    if (!svg || !caretEl) return;
    const accent = this.options.accent ?? ACCENT;
    const poly = (q: Point[], fill: string) =>
      `<polygon points="${q.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(" ")}" fill="${fill}"/>`;
    svg.innerHTML =
      g.selection.map((q) => poly(q, `${accent}55`)).join("") +
      g.composition.map((q) => poly(q, accent)).join("");
    if (g.caret && g.focused) {
      const { x0, y0, x1, y1 } = g.caret;
      const len = Math.hypot(x1 - x0, y1 - y0);
      const angle = (Math.atan2(y1 - y0, x1 - x0) * 180) / Math.PI - 90;
      caretEl.style.display = "block";
      caretEl.style.height = `${len}px`;
      caretEl.style.transform = `translate(${x0 - 1}px, ${y0}px) rotate(${angle}deg)`;
      this.restartBlink();
    } else {
      caretEl.style.display = "none";
    }
  }

  private blinkAnim: Animation | null = null;

  private startBlink(): void {
    const el = this.caretEl;
    if (!el || typeof el.animate !== "function") return;
    if (globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    this.blinkAnim = el.animate(
      [{ opacity: 1 }, { opacity: 1, offset: 0.5 }, { opacity: 0, offset: 0.55 }, { opacity: 0 }],
      {
        duration: 1060,
        iterations: Number.POSITIVE_INFINITY,
        delay: 500,
      },
    );
  }

  private restartBlink(): void {
    if (!this.blinkAnim) return;
    this.blinkAnim.currentTime = 0;
  }

  /** Re-reads geometry (call after external changes to the node, e.g. resizing its box). */
  refresh(): Promise<void> {
    return this.updateGeometry();
  }

  /** Ends editing: commits pending changes and removes the DOM. */
  async end(reason: "escape" | "blur" | "api" = "api"): Promise<ApplyResult | null> {
    if (this.ended) return null;
    const result = await this.commit();
    this.ended = true;
    for (const off of this.offs) off();
    this.blinkAnim?.cancel();
    this.input.remove();
    this.layer?.remove();
    this.options.onEnd?.(reason);
    return result;
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
