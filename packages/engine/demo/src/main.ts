// Engine demo: the wasm engine in a worker drawing an OffscreenCanvas, with pan / zoom, hover and selection from
// engine hit tests, 60 fps drags as live previews with snapping, live text editing through the bridge, undo,
// and exports (PDF loads the exporters module on first use).
import "./styles.css";
import { type ApplyResult, type Design, newId, type Transaction } from "@desyn/schema";
import {
  EngineClient,
  type FrameStats,
  type OrientedBox,
  type Point,
  type Rect,
  type SnapResult,
  TextEditBridge,
  wheelZoomFactor,
} from "../../src/index";

const designs = import.meta.glob<Design>("../../../../spec/fixtures/render/*.json", {
  import: "default",
});
const assetUrls = import.meta.glob<string>("../../../../spec/fixtures/render/assets/*", {
  query: "?url",
  import: "default",
  eager: true,
});

const $ = <T extends Element>(sel: string) => document.querySelector(sel) as T;
const stage = $<HTMLElement>("#stage");
const canvas = $<HTMLCanvasElement>("#canvas");
const overlay = $<SVGSVGElement>("#overlay");
const textLayer = $<HTMLDivElement>("#text-layer");
const picker = $<HTMLSelectElement>("#fixture");
const zoomValue = $<HTMLButtonElement>("#zoom-value");
const toastEl = $<HTMLDivElement>("#toast");

const fixtureName = (path: string) =>
  path
    .split("/")
    .pop()
    ?.replace(/\.json$/, "") ?? path;
const names = Object.keys(designs).map(fixtureName).sort();
const params = new URLSearchParams(location.search);
const initial = params.get("design") ?? "social";

// ---------------------------------------------------------------------------------------------------------------
// State

interface UndoEntry {
  undo: Transaction;
  redo: Transaction;
}

let client: EngineClient;
let selection: string[] = [];
let hovered: string | null = null;
let editing: TextEditBridge | null = null;
let guides: SnapResult | null = null;
let marquee: Rect | null = null;
let selectionBox: OrientedBox | null = null;
const undoStack: UndoEntry[] = [];
const redoStack: UndoEntry[] = [];
const frames: FrameStats[] = [];

type Gesture =
  | { kind: "pan"; last: Point }
  | {
      kind: "move";
      startPage: Point;
      origin: { id: string; x: number; y: number }[];
      bounds: Rect;
      box: OrientedBox | null;
      seq: number;
      moved: boolean;
    }
  | {
      kind: "resize";
      id: string;
      box: OrientedBox;
      handle: string;
      start: { x: number; y: number; w: number; h: number };
      seq: number;
    }
  | { kind: "marquee"; start: Point }
  | { kind: "text" };

let gesture: Gesture | null = null;
let spaceDown = false;
let gestureSeq = 0;

function toast(message: string): void {
  toastEl.textContent = message;
  toastEl.classList.add("show");
  clearTimeout((toast as unknown as { t?: number }).t);
  (toast as unknown as { t?: number }).t = window.setTimeout(
    () => toastEl.classList.remove("show"),
    2600,
  );
}

function local(e: { clientX: number; clientY: number }): Point {
  const r = canvas.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

function tx(label: string, ops: Transaction["ops"]): Transaction {
  return { id: newId(), label, ops, source: "user", ts: Date.now() };
}

function pushUndo(result: ApplyResult, label: string): void {
  if (!result.applied.length) return;
  undoStack.push({ undo: result.inverse, redo: tx(label, result.applied) });
  if (undoStack.length > 200) undoStack.shift();
  redoStack.length = 0;
}

async function applyUser(label: string, ops: Transaction["ops"]): Promise<void> {
  const r = await client.apply(tx(label, ops));
  pushUndo(r, label);
  await refreshSelection();
}

// ---------------------------------------------------------------------------------------------------------------
// Overlay

function boxPoints(box: OrientedBox): Point[] {
  const t = box.transform;
  const corners = [
    { x: 0, y: 0 },
    { x: box.width, y: 0 },
    { x: box.width, y: box.height },
    { x: 0, y: box.height },
  ];
  return corners.map((c) =>
    client.pageToScreen({ x: t.a * c.x + t.c * c.y + t.e, y: t.b * c.x + t.d * c.y + t.f }),
  );
}

function poly(points: Point[], cls: string): string {
  return `<polygon class="${cls}" points="${points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ")}"/>`;
}

let hoverBox: OrientedBox | null = null;

function drawOverlay(): void {
  let html = "";
  if (hoverBox && hovered && !selection.includes(hovered) && !gesture)
    html += poly(boxPoints(hoverBox), "hover");
  if (selectionBox) {
    const pts = boxPoints(selectionBox);
    html += poly(pts, "selection");
    if (!editing && gesture?.kind !== "move") {
      const mids = pts.map((p, i) => {
        const q = pts[(i + 1) % 4] ?? p;
        return { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 };
      });
      for (const p of [...pts, ...mids]) {
        html += `<rect class="handle" x="${(p.x - 4).toFixed(1)}" y="${(p.y - 4).toFixed(1)}" width="8" height="8" rx="1.5"/>`;
      }
    }
  }
  if (guides) {
    for (const g of guides.guides) {
      const a = client.pageToScreen(
        g.axis === "x" ? { x: g.pos, y: g.from } : { x: g.from, y: g.pos },
      );
      const b = client.pageToScreen(g.axis === "x" ? { x: g.pos, y: g.to } : { x: g.to, y: g.pos });
      html += `<line class="guide" x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}"/>`;
    }
    for (const s of guides.spacing) {
      for (const [from, to, cross] of s.segments) {
        const a = client.pageToScreen(
          s.axis === "x" ? { x: from, y: cross } : { x: cross, y: from },
        );
        const b = client.pageToScreen(s.axis === "x" ? { x: to, y: cross } : { x: cross, y: to });
        html += `<line class="spacing" x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}"/>`;
      }
    }
    for (const d of guides.distances ?? []) {
      if (d.value < 1) continue;
      const a = client.pageToScreen(d.from);
      const b = client.pageToScreen(d.to);
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      const label = String(Math.round(d.value));
      const w = 8 + label.length * 6.4;
      html += `<line class="guide" x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}"/>`;
      html += `<rect class="label-bg" x="${mx - w / 2}" y="${my - 8}" width="${w}" height="16" rx="4"/>`;
      html += `<text class="label" x="${mx}" y="${my + 3.5}" text-anchor="middle">${label}</text>`;
    }
  }
  if (marquee) {
    const a = client.pageToScreen({ x: marquee.x, y: marquee.y });
    html += `<rect class="marquee" x="${a.x}" y="${a.y}" width="${marquee.w * client.view.zoom}" height="${marquee.h * client.view.zoom}"/>`;
  }
  overlay.innerHTML = html;
}

async function refreshSelection(): Promise<void> {
  if (!selection.length) {
    selectionBox = null;
    drawOverlay();
    return;
  }
  const h = await client.handles({ ids: selection });
  selectionBox = h.bounds?.obb ?? null;
  drawOverlay();
}

let hoverSeq = 0;
async function updateHover(p: Point): Promise<void> {
  const seq = ++hoverSeq;
  const hit = await client.hitTestScreen(p);
  if (seq !== hoverSeq) return;
  if (hit.id !== hovered) {
    hovered = hit.id;
    hoverBox = hit.id ? ((await client.handles({ ids: [hit.id] })).bounds?.obb ?? null) : null;
  }
  drawOverlay();
}

// ---------------------------------------------------------------------------------------------------------------
// Pointer interaction

function translateBox(box: OrientedBox, dx: number, dy: number): OrientedBox {
  return {
    ...box,
    transform: { ...box.transform, e: box.transform.e + dx, f: box.transform.f + dy },
  };
}

async function onPointerDown(e: PointerEvent): Promise<void> {
  canvas.setPointerCapture(e.pointerId);
  const p = local(e);
  if (spaceDown || e.button === 1) {
    gesture = { kind: "pan", last: p };
    stage.classList.add("panning");
    return;
  }
  if (e.button !== 0) return;
  if (editing) {
    if (await editing.contains(p)) {
      gesture = { kind: "text" };
      await editing.pointerDown(p, { shift: e.shiftKey, clickCount: e.detail });
      return;
    }
    await endEditing();
  }
  const page = client.screenToPage(p);
  if (selection.length === 1) {
    const h = await client.handles({ ids: selection, point: page });
    const id = selection[0];
    const node = id ? client.design.nodes[id] : undefined;
    if (h.hit?.type === "resize" && h.bounds && node && id) {
      gesture = {
        kind: "resize",
        id,
        box: h.bounds.obb,
        handle: h.hit.handle,
        start: { x: node.x, y: node.y, w: node.width, h: node.height },
        seq: ++gestureSeq,
      };
      return;
    }
  }
  const hit = await client.hitTestScreen(p);
  if (hit.id) {
    if (!selection.includes(hit.id)) selection = e.shiftKey ? [...selection, hit.id] : [hit.id];
    const origin = selection.flatMap((id) => {
      const n = client.design.nodes[id];
      return n ? [{ id, x: n.x, y: n.y }] : [];
    });
    const rects = (await client.bounds(selection)).filter((r): r is Rect => r !== null);
    const bounds = rects.reduce<Rect | null>((u, r) => {
      if (!u) return r;
      const x = Math.min(u.x, r.x);
      const y = Math.min(u.y, r.y);
      return { x, y, w: Math.max(u.x + u.w, r.x + r.w) - x, h: Math.max(u.y + u.h, r.y + r.h) - y };
    }, null);
    await refreshSelection();
    if (bounds) {
      gesture = {
        kind: "move",
        startPage: page,
        origin,
        bounds,
        box: selectionBox,
        seq: ++gestureSeq,
        moved: false,
      };
    }
  } else {
    selection = [];
    selectionBox = null;
    gesture = { kind: "marquee", start: page };
    drawOverlay();
  }
}

async function onPointerMove(e: PointerEvent): Promise<void> {
  const p = local(e);
  const g = gesture;
  if (!g) {
    if (!editing && !spaceDown) void updateHover(p);
    return;
  }
  if (g.kind === "pan") {
    client.panBy(p.x - g.last.x, p.y - g.last.y);
    g.last = p;
    drawOverlay();
    return;
  }
  if (g.kind === "text") {
    await editing?.pointerMove(p);
    return;
  }
  const page = client.screenToPage(p);
  if (g.kind === "marquee") {
    const x = Math.min(g.start.x, page.x);
    const y = Math.min(g.start.y, page.y);
    marquee = { x, y, w: Math.abs(page.x - g.start.x), h: Math.abs(page.y - g.start.y) };
    selection = await client.marquee({ rect: marquee, mode: "intersect" });
    await refreshSelection();
    return;
  }
  if (g.kind === "move") {
    const seq = ++g.seq;
    const dx0 = page.x - g.startPage.x;
    const dy0 = page.y - g.startPage.y;
    const snapped = e.altKey
      ? null
      : await client.snap({
          ids: selection,
          rect: { ...g.bounds, x: g.bounds.x + dx0, y: g.bounds.y + dy0 },
          distances: true,
        });
    if (seq !== g.seq || gesture !== g) return;
    const dx = dx0 + (snapped?.dx ?? 0);
    const dy = dy0 + (snapped?.dy ?? 0);
    g.moved = true;
    guides = snapped;
    void client.preview(
      tx(
        "Move",
        g.origin.map((o) => ({ op: "update", id: o.id, set: { x: o.x + dx, y: o.y + dy } })),
      ),
    );
    if (g.box) selectionBox = translateBox(g.box, dx, dy);
    drawOverlay();
    return;
  }
  if (g.kind === "resize") {
    const seq = ++g.seq;
    const r = await client.resizeBox({
      bounds: g.box,
      handle: g.handle as Parameters<EngineClient["resizeBox"]>[0]["handle"],
      pointer: page,
      options: { keepAspect: e.shiftKey, fromCenter: e.altKey },
    });
    if (seq !== g.seq || gesture !== g) return;
    const b = r.bounds;
    const node = client.design.nodes[g.id];
    if (!node) return;
    // Unrotated top-level nodes: the box origin is the node origin.
    const set =
      node.rotation === 0
        ? { x: b.transform.e, y: b.transform.f, width: b.width, height: b.height }
        : { width: b.width, height: b.height };
    void client.preview(tx("Resize", [{ op: "update", id: g.id, set }]));
    selectionBox = b;
    drawOverlay();
  }
}

async function onPointerUp(e: PointerEvent): Promise<void> {
  if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
  const g = gesture;
  gesture = null;
  stage.classList.remove("panning");
  if (!g) return;
  if (g.kind === "text") {
    editing?.pointerUp();
    return;
  }
  if (g.kind === "move" || g.kind === "resize") {
    g.seq++;
    guides = null;
    const label = g.kind === "move" ? "Move" : "Resize";
    if (g.kind === "move" && !g.moved) {
      await client.cancelPreview();
    } else {
      const r = await client.commitPreview({ label });
      if (r) pushUndo(r, label);
    }
    await refreshSelection();
  }
  if (g.kind === "marquee") {
    marquee = null;
    drawOverlay();
  }
}

async function onDoubleClick(e: MouseEvent): Promise<void> {
  const p = local(e);
  const hit = await client.hitTestScreen(p, { deep: true });
  const id = hit.id;
  if (!id || client.design.nodes[id]?.type !== "text") return;
  await startEditing(id, p);
}

async function startEditing(id: string, at?: Point): Promise<void> {
  await endEditing();
  selection = [id];
  await refreshSelection();
  editing = new TextEditBridge(client, {
    nodeId: id,
    container: textLayer,
    select: at ? { at } : "all",
    onCommit: (r) => {
      pushUndo(r, "Edit text");
      void refreshSelection();
    },
    onGeometry: () => void refreshSelection(),
    onEnd: () => {
      editing = null;
      stage.classList.remove("editing");
      void refreshSelection();
    },
  });
  stage.classList.add("editing");
  await editing.start();
}

async function endEditing(): Promise<void> {
  const e = editing;
  if (!e) return;
  editing = null;
  await e.end("api");
}

// ---------------------------------------------------------------------------------------------------------------
// Keyboard, wheel, toolbar

async function undo(): Promise<void> {
  const entry = undoStack.pop();
  if (!entry) return;
  await client.apply(entry.undo, { normalize: false });
  redoStack.push(entry);
  await refreshSelection();
}

async function redo(): Promise<void> {
  const entry = redoStack.pop();
  if (!entry) return;
  await client.apply({ ...entry.redo, id: newId() }, { normalize: false });
  undoStack.push(entry);
  await refreshSelection();
}

function onKeyDown(e: KeyboardEvent): void {
  if (editing) return;
  if (e.target instanceof HTMLSelectElement || e.target instanceof HTMLButtonElement) {
    if (e.key !== " ") return;
  }
  const mod = e.metaKey || e.ctrlKey;
  if (e.key === " " && !spaceDown) {
    spaceDown = true;
    stage.classList.add("space");
    e.preventDefault();
    return;
  }
  if (mod && e.key.toLowerCase() === "z") {
    e.preventDefault();
    void (e.shiftKey ? redo() : undo());
    return;
  }
  if (e.key === "Escape") {
    selection = [];
    void refreshSelection();
  } else if ((e.key === "Delete" || e.key === "Backspace") && selection.length) {
    const ids = selection;
    selection = [];
    void applyUser(
      "Delete",
      ids.map((id) => ({ op: "delete", id })),
    );
  } else if (e.key.startsWith("Arrow") && selection.length) {
    e.preventDefault();
    const step = e.shiftKey ? 10 : 1;
    const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
    const dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
    void applyUser(
      "Nudge",
      selection.flatMap((id) => {
        const n = client.design.nodes[id];
        return n ? [{ op: "update" as const, id, set: { x: n.x + dx, y: n.y + dy } }] : [];
      }),
    );
  } else if (e.key === "Enter" && selection.length === 1) {
    const id = selection[0];
    if (id && client.design.nodes[id]?.type === "text") void startEditing(id);
  } else if (e.key === "0") {
    client.fit();
  } else if (e.key === "1") {
    zoomTo(1);
  } else if (e.key === "+" || e.key === "=") {
    zoomTo(client.view.zoom * 1.25);
  } else if (e.key === "-") {
    zoomTo(client.view.zoom / 1.25);
  }
}

function zoomTo(zoom: number): void {
  client.zoomAt({ x: client.view.width / 2, y: client.view.height / 2 }, zoom);
}

function onWheel(e: WheelEvent): void {
  e.preventDefault();
  const p = local(e);
  if (e.ctrlKey || e.metaKey) {
    client.zoomAt(
      p,
      client.view.zoom * wheelZoomFactor(e.deltaY, e.deltaMode, e.ctrlKey && !e.metaKey),
    );
  } else {
    const k = e.deltaMode === 1 ? 16 : 1;
    client.panBy(-(e.shiftKey ? e.deltaY : e.deltaX) * k, -(e.shiftKey ? 0 : e.deltaY) * k);
  }
}

async function exportAs(format: "png" | "svg" | "pdf", button: HTMLButtonElement): Promise<void> {
  button.disabled = true;
  try {
    const started = performance.now();
    const out = await client.export(format === "png" ? { format, scale: 2 } : { format });
    const blob = new Blob([out.bytes.slice().buffer], { type: out.info.mime });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${picker.value}.${out.info.extension}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    toast(
      `${format.toUpperCase()} ready · ${(out.bytes.length / 1024).toFixed(0)} KB in ${Math.round(performance.now() - started)} ms`,
    );
  } catch (err) {
    toast(`Export failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    button.disabled = false;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// HUD

function startHud(): void {
  const fpsEl = $<HTMLElement>("#hud-fps");
  const frameEl = $<HTMLElement>("#hud-frame");
  const tilesEl = $<HTMLElement>("#hud-tiles");
  $<HTMLElement>("#hud-mode").textContent =
    client.mode === "worker" ? "Worker · OffscreenCanvas" : "Main thread";
  client.on("frame", (f) => {
    frames.push(f);
    if (frames.length > 600) frames.splice(0, frames.length - 600);
    tilesEl.textContent = String(f.pending);
  });
  setInterval(() => {
    const now = performance.now();
    const recent = frames.filter((f) => now - f.at < 1000);
    fpsEl.textContent = recent.length ? String(recent.length) : "idle";
    const last = frames.slice(-30);
    if (last.length) {
      const avg = last.reduce((s, f) => s + f.renderMs + f.presentMs, 0) / last.length;
      frameEl.textContent = avg.toFixed(1);
    }
  }, 250);
}

// ---------------------------------------------------------------------------------------------------------------
// Boot

async function loadDesign(name: string): Promise<void> {
  const path = Object.keys(designs).find((p) => fixtureName(p) === name);
  const load = path ? designs[path] : undefined;
  if (!load) return;
  await endEditing();
  selection = [];
  hovered = null;
  hoverBox = null;
  selectionBox = null;
  undoStack.length = 0;
  redoStack.length = 0;
  picker.value = name;
  const design = structuredClone(await load());
  await client.load(design);
  client.fit(undefined, 56);
  drawOverlay();
  const url = new URL(location.href);
  url.searchParams.set("design", name);
  history.replaceState(null, "", url);
}

/** The pasteboard color of the active theme (the `--canvas` token; `data-theme="system"` follows the OS). */
function pasteboard(): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue("--canvas").trim();
  return /^#[0-9a-f]{6}$/i.test(v) ? v : "#0e0e0e";
}

async function boot(): Promise<void> {
  const mode = params.get("mode") === "main" ? "main" : "auto";
  const theme = params.get("theme");
  if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
  client = await EngineClient.create({
    canvas,
    mode,
    render: { background: pasteboard(), pageShadow: true, budgetMs: 10 },
    resolveAsset: (asset) => {
      const key = Object.keys(assetUrls).find((k) =>
        k.split("/").pop()?.startsWith(`${asset.id}.`),
      );
      return key ? assetUrls[key] : asset.url;
    },
  });
  client.on("view", (v) => {
    zoomValue.textContent = `${Math.round(v.zoom * 100)}%`;
    drawOverlay();
  });
  matchMedia("(prefers-color-scheme: light)").addEventListener("change", () =>
    client.setRenderOptions({ background: pasteboard() }),
  );
  client.on("assetError", (e) => toast(`Asset ${e.id}: ${e.message}`));
  client.on("fatal", (e) => toast(`Engine stopped: ${e.message}`));
  client.on("recovered", () => toast("The engine recovered from an error"));
  for (const n of names) picker.add(new Option(n.replace(/_/g, " & "), n));
  picker.value = names.includes(initial) ? initial : (names[0] ?? "");
  picker.addEventListener("change", () => void loadDesign(picker.value));
  await loadDesign(picker.value);
  startHud();
  await client.flush();
  $<HTMLElement>("#loading").classList.add("done");

  canvas.addEventListener("pointerdown", (e) => void onPointerDown(e));
  canvas.addEventListener("pointermove", (e) => void onPointerMove(e));
  canvas.addEventListener("pointerup", (e) => void onPointerUp(e));
  canvas.addEventListener("pointercancel", (e) => void onPointerUp(e));
  canvas.addEventListener("pointerleave", () => {
    if (!gesture) {
      hovered = null;
      drawOverlay();
    }
  });
  canvas.addEventListener("dblclick", (e) => void onDoubleClick(e));
  canvas.addEventListener("wheel", onWheel, { passive: false });
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", (e) => {
    if (e.key === " ") {
      spaceDown = false;
      stage.classList.remove("space");
    }
  });
  $<HTMLButtonElement>("#zoom-in").addEventListener("click", () => zoomTo(client.view.zoom * 1.25));
  $<HTMLButtonElement>("#zoom-out").addEventListener("click", () =>
    zoomTo(client.view.zoom / 1.25),
  );
  zoomValue.addEventListener("click", () => zoomTo(1));
  $<HTMLButtonElement>("#fit").addEventListener("click", () => client.fit(undefined, 56));
  for (const f of ["png", "svg", "pdf"] as const) {
    const b = $<HTMLButtonElement>(`#export-${f}`);
    b.addEventListener("click", () => void exportAs(f, b));
  }
}

const ready = boot().catch((e) => {
  $<HTMLElement>("#loading p").textContent =
    `The engine could not start: ${e instanceof Error ? e.message : String(e)}`;
  throw e;
});

// Hooks for the Playwright verification script (demo/verify.mjs).
Object.assign(window, {
  desyn: {
    ready,
    frames,
    get client() {
      return client;
    },
    get selection() {
      return selection;
    },
    get editing() {
      return editing;
    },
    loadDesign,
    startEditing,
  },
});
