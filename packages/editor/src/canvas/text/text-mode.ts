import { createdIds, getNode, makeTransaction } from "@desyn/doc-ops";
import { caretStyle, runsText, TextEditBridge } from "@desyn/engine";
import type { ApplyResult, Id, ParagraphStyle, TextNode, TextStyle } from "@desyn/schema";
import { selectTool } from "../../tools/select.ts";
import type { CanvasPointer, Gesture, Mode } from "../../tools/types.ts";
import type { CanvasController } from "../controller.ts";
import { nodeObb } from "../geometry.ts";
import type { Point } from "../math.ts";
import type { Painter } from "../overlay/paint.ts";
import {
  htmlToRuns,
  type PastedRun,
  parseRunsPayload,
  RUNS_MIME,
  runsToHtml,
  sliceRuns,
} from "./rich-text.ts";

/**
 * Text editing on the canvas. The engine's `TextEditBridge` owns the input element (keyboard, IME composition,
 * caret / selection geometry from the engine's own layout, live previews committed after 400 ms); this mode
 * routes canvas pointer input to it, adds rich copy / paste, range styling shortcuts and the text toolbar, and
 * commits every edit through the editor (one undo step per word-ish burst, coalesced per node).
 */

export interface TextStartOptions {
  /** Caret under this screen point. */
  at?: Point;
  select?: "all" | "end";
  /** The layer was just created by the text tool: an empty result removes it (and its undo step). */
  created?: boolean;
}

export class TextMode implements Mode {
  readonly kind = "text" as const;
  bridge: TextEditBridge | null = null;
  private ended = false;
  private version = 0;
  private readonly offs: (() => void)[] = [];

  constructor(
    private readonly c: CanvasController,
    readonly nodeId: Id,
    private readonly opts: TextStartOptions,
  ) {}

  get node(): TextNode | null {
    const n = this.c.design ? getNode(this.c.design, this.nodeId) : undefined;
    return n?.type === "text" ? n : null;
  }

  /** Starts the bridge; false when the engine cannot edit this layer. */
  async start(): Promise<boolean> {
    const client = this.c.client;
    const node = this.node;
    if (!client?.hasDesign || !node || client.design.nodes[this.nodeId]?.type !== "text")
      return false;
    this.c.editor.setTextEditing(this.nodeId);
    const bridge = new TextEditBridge(client, {
      nodeId: this.nodeId,
      container: this.c.domLayer,
      select: this.opts.at ? { at: this.opts.at } : (this.opts.select ?? "end"),
      label: `Edit text: ${node.name}`,
      onCommit: (r) => this.onCommit(r),
      onEnd: (reason) => this.onEnd(reason),
      onGeometry: () => this.bump(),
    });
    this.bridge = bridge;
    const on = <K extends keyof HTMLElementEventMap>(
      type: K,
      fn: (e: HTMLElementEventMap[K]) => void,
    ) => {
      this.c.domLayer.addEventListener(type, fn as EventListener);
      this.offs.push(() => this.c.domLayer.removeEventListener(type, fn as EventListener));
    };
    on("copy", (e) => this.onCopy(e, false));
    on("cut", (e) => this.onCopy(e, true));
    on("paste", (e) => this.onPaste(e));
    await bridge.start();
    this.c.setUi({ text: { nodeId: this.nodeId, version: this.version } });
    return true;
  }

  private bump(): void {
    this.version++;
    if (!this.ended) this.c.setUi({ text: { nodeId: this.nodeId, version: this.version } });
  }

  private onCommit(r: ApplyResult): void {
    if (r.applied.length === 0) return;
    void this.c.editor.apply(makeTransaction(r.applied, "Edit text"), {
      label: "Edit text",
      coalesceKey: `text:${this.nodeId}`,
      normalize: false,
    });
  }

  private onEnd(reason: "escape" | "blur" | "api"): void {
    if (this.ended) return;
    this.ended = true;
    for (const off of this.offs.splice(0)) off();
    const text = this.bridge ? this.bridge.text : this.node ? runsText(this.node.runs) : "";
    this.bridge = null;
    this.c.setUi({ text: null });
    this.c.modeEnded(this);
    if (this.c.state.textEditing === this.nodeId) this.c.editor.setTextEditing(null);
    if (text.trim().length === 0 && this.node) {
      void this.removeEmpty();
      return;
    }
    if (reason === "escape") this.c.editor.select([this.nodeId]);
  }

  /**
   * An emptied text layer goes away. One that was just created (text tool, or a double click that put text into
   * a shape) undoes its whole creating step instead, undo entry included, so a shape that was turned into a
   * text container goes back to how it was.
   */
  private async removeEmpty(): Promise<void> {
    const editor = this.c.editor;
    const top = editor.history.peekUndo();
    const created = this.opts.created && !!top && createdIds(top.forward).includes(this.nodeId);
    if (created && top) {
      await editor.apply(top.inverse.ops, { label: "Undo add text", history: false, select: [] });
      if (editor.history.peekUndo() === top) editor.history.takeUndo();
      return;
    }
    await editor.apply([{ op: "delete", id: this.nodeId }], { label: "Delete text", select: [] });
  }

  async exit(): Promise<void> {
    if (this.ended) return;
    await this.bridge?.end("api");
  }

  // ------------------------------------------------------------------------------------------------------
  // Pointer

  async down(c: CanvasController, e: CanvasPointer): Promise<Gesture | null> {
    const bridge = this.bridge;
    if (!bridge) return null;
    if (await bridge.contains(e.screen)) {
      await bridge.pointerDown(e.screen, { shift: e.shift, clickCount: e.clickCount });
      return {
        cursor: "text",
        move: (ev) => void bridge.pointerMove(ev.screen),
        up: () => bridge.pointerUp(),
        cancel: () => bridge.pointerUp(),
      };
    }
    // A click outside ends editing and acts like a normal click.
    await c.exitMode("click");
    return selectTool.down(c, e);
  }

  cursor(): string {
    return "text";
  }

  // ------------------------------------------------------------------------------------------------------
  // Keys

  keyDown(_c: CanvasController, e: KeyboardEvent): boolean {
    const bridge = this.bridge;
    if (!bridge || e.isComposing) return false;
    const mod = this.c.platform === "mac" ? e.metaKey : e.ctrlKey;
    if (!mod) return false;
    const k = e.key.toLowerCase();
    if (e.shiftKey && !e.altKey && k === "x") {
      this.toggle("decoration", "strikethrough");
      return true;
    }
    if (e.shiftKey && !e.altKey && (e.key === ">" || e.key === "." || e.code === "Period")) {
      this.stepSize(1);
      return true;
    }
    if (e.shiftKey && !e.altKey && (e.key === "<" || e.key === "," || e.code === "Comma")) {
      this.stepSize(-1);
      return true;
    }
    if (e.altKey && !e.shiftKey) {
      const align = ({ KeyL: "left", KeyT: "center", KeyR: "right", KeyJ: "justify" } as const)[
        e.code as "KeyL" | "KeyT" | "KeyR" | "KeyJ"
      ];
      if (align) {
        void this.setParagraph({ align });
        return true;
      }
    }
    if (e.shiftKey && !e.altKey && (e.code === "Digit7" || e.code === "Digit8")) {
      const list = e.code === "Digit7" ? "number" : "bullet";
      void this.setParagraph({ list: this.node?.paragraph.list === list ? "none" : list });
      return true;
    }
    return false;
  }

  // ------------------------------------------------------------------------------------------------------
  // Styling (shortcuts and the toolbar)

  /** Style at the caret / start of the selection (run override over the node style). */
  styleAt(): TextStyle | null {
    const node = this.node;
    const bridge = this.bridge;
    if (!node || !bridge) return null;
    const runs = bridge.currentRuns;
    const { start, end } = bridge.selection;
    const style =
      start === end ? caretStyle(runs, start) : sliceRuns(runs, start, start + 1)[0]?.style;
    return { ...node.style, ...style };
  }

  toggle<K extends keyof TextStyle>(key: K, value: TextStyle[K]): void {
    this.bridge?.setStyle(key, value, true);
    this.bump();
  }

  set<K extends keyof TextStyle>(key: K, value: TextStyle[K]): void {
    this.bridge?.setStyle(key, value, false);
    this.bump();
  }

  /** Bold toggles between the node weight and 700 (or 400 for bold nodes). */
  toggleBold(): void {
    const node = this.node;
    if (!node) return;
    const weight = (node.style.fontWeight >= 600 ? 400 : 700) as TextStyle["fontWeight"];
    this.toggle("fontWeight", weight);
  }

  stepSize(direction: 1 | -1): void {
    const current = this.styleAt()?.fontSize ?? 16;
    const steps = [
      8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 40, 48, 56, 64, 72, 80, 96, 112, 128, 144,
      160, 192, 240, 288,
    ];
    const next =
      direction > 0
        ? (steps.find((s) => s > current + 0.01) ?? Math.round(current * 1.2))
        : ([...steps].reverse().find((s) => s < current - 0.01) ??
          Math.max(1, Math.round(current / 1.2)));
    this.set("fontSize", next);
  }

  /** Paragraph settings apply to the whole layer: pending typing is committed first. */
  async setParagraph(patch: Partial<ParagraphStyle>): Promise<void> {
    const node = this.node;
    if (!node) return;
    await this.bridge?.commit();
    const paragraph = { ...node.paragraph, ...patch };
    await this.c.editor.apply([{ op: "update", id: this.nodeId, set: { paragraph } }], {
      label: patch.align ? "Align text" : "List",
    });
    await this.bridge?.refresh();
    this.bump();
  }

  // ------------------------------------------------------------------------------------------------------
  // Clipboard

  private onCopy(e: ClipboardEvent, cut: boolean): void {
    const bridge = this.bridge;
    const node = this.node;
    if (!bridge || !node || !e.clipboardData) return;
    const { start, end } = bridge.selection;
    if (start === end) return;
    const runs = sliceRuns(bridge.currentRuns, start, end);
    // Effective styles travel with the text so it looks the same in another layer.
    const full = runs.map((r) => ({ text: r.text, style: { ...node.style, ...r.style } }));
    e.clipboardData.setData(
      "text/plain",
      runs
        .map((r) => r.text)
        .join("")
        .replace(/\u2028/g, "\n"),
    );
    e.clipboardData.setData("text/html", runsToHtml(runs, node.style));
    e.clipboardData.setData(RUNS_MIME, JSON.stringify(full));
    e.preventDefault();
    if (cut) {
      bridge.deleteChar(false);
      this.bump();
    }
  }

  private onPaste(e: ClipboardEvent): void {
    const bridge = this.bridge;
    const data = e.clipboardData;
    if (!bridge || !data) return;
    const own = data.getData(RUNS_MIME);
    let runs: PastedRun[] | null = own ? parseRunsPayload(own) : null;
    if (!runs) {
      const html = data.getData("text/html");
      runs = html ? htmlToRuns(html) : null;
      // Plain text (or HTML without emphasis) goes through the input as typed text.
      if (!runs || runs.every((r) => Object.keys(r.style).length === 0)) return;
    }
    e.preventDefault();
    this.insertRuns(runs);
  }

  /** Inserts styled runs at the selection. */
  insertRuns(runs: readonly PastedRun[]): void {
    const bridge = this.bridge;
    if (!bridge) return;
    const text = runs.map((r) => r.text.replace(/\r\n?/g, "\n")).join("");
    const start = bridge.selection.start;
    bridge.insertText(text);
    let pos = start;
    for (const r of runs) {
      const len = r.text.replace(/\r\n?/g, "\n").length;
      const keys = Object.keys(r.style) as (keyof TextStyle)[];
      if (keys.length > 0 && len > 0) {
        bridge.setSelection(pos, pos + len);
        for (const k of keys) {
          const v = r.style[k];
          if (v !== undefined) bridge.setStyle(k, v as never, false);
        }
      }
      pos += len;
    }
    bridge.setSelection(start + text.length);
    this.bump();
  }

  // ------------------------------------------------------------------------------------------------------
  // Overlay

  draw(c: CanvasController, p: Painter): void {
    const design = c.design;
    const box = design ? nodeObb(design, this.nodeId) : null;
    if (box) p.strokeObb(box, p.theme.selection, 1);
  }
}

/** Starts editing a text layer (double click, Enter, the text tool, the `textEditing` state). */
export async function startTextEditing(
  c: CanvasController,
  id: Id,
  opts: TextStartOptions = {},
): Promise<boolean> {
  if (!c.canEdit) return false;
  const current = c.mode;
  if (current instanceof TextMode && current.nodeId === id) return true;
  const mode = new TextMode(c, id, opts);
  await c.enterMode(mode);
  c.editor.select([id]);
  const ok = await mode.start();
  if (!ok) {
    c.modeEnded(mode);
    if (c.state.textEditing === id) c.editor.setTextEditing(null);
    return false;
  }
  return true;
}
