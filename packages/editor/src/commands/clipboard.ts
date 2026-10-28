import {
  cloneSubtree,
  decompose,
  deleteNodes,
  invertMatrix,
  localTransform,
  makeTransaction,
  multiply,
  subtree,
  worldTransform,
} from "@desyn/doc-ops";
import {
  type AssetRef,
  createImage,
  createSvg,
  createText,
  type Design,
  defaultTextStyle,
  type Id,
  type Node,
  type Op,
  ROOT_ID,
} from "@desyn/schema";
import { ClipboardCopy, ClipboardPaste, Copy, ImageDown, Scissors } from "lucide-react";
import type { EditorController } from "../controller.ts";
import { boundsOf, selectedIds, viewCenterInPage, visiblePageRect } from "./helpers.ts";
import type { AnyCommand } from "./registry.ts";

/**
 * Clipboard: copy / cut / paste of layers through the system clipboard, plus images, SVG and plain text from
 * other apps.
 *
 * Copied layers are written as three flavours: `application/x-desyn+json` (same browser), `text/html` with the
 * payload base64-encoded in a `data-desyn-clipboard` attribute (survives other browsers and the desktop app),
 * and `text/plain` (the text content). Paste accepts those, image files (uploaded to the workspace library),
 * SVG markup or files (inline vector layers), and plain text (a text layer). An in-memory copy is kept for
 * environments that block clipboard access.
 */

export const DESYN_MIME = "application/x-desyn+json";
const HTML_ATTR = "data-desyn-clipboard";
/** Inline SVG markup above this size is uploaded as an asset instead. */
const MAX_INLINE_SVG = 200_000;
const PASTE_OFFSET = 16;

export interface ClipboardPayload {
  kind: "desyn/nodes";
  version: 1;
  designId: string;
  /** Subtree roots, back to front. */
  roots: Id[];
  /** Every node of every subtree (roots first in each subtree). */
  nodes: Node[];
  /** Page-space placement of each root (keeps rotated / nested layers in place). */
  placements: Record<
    Id,
    { x: number; y: number; rotation: number; flipX: boolean; flipY: boolean }
  >;
  /** Assets referenced by the nodes (without signed URLs). */
  assets: AssetRef[];
  /** Plain-text flavour. */
  text: string;
}

function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

function fromBase64(b64: string): string {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function isPayload(v: unknown): v is ClipboardPayload {
  if (typeof v !== "object" || v === null) return false;
  const p = v as Partial<ClipboardPayload>;
  return (
    p.kind === "desyn/nodes" &&
    p.version === 1 &&
    Array.isArray(p.roots) &&
    Array.isArray(p.nodes) &&
    typeof p.placements === "object" &&
    Array.isArray(p.assets)
  );
}

export function parsePayload(json: string): ClipboardPayload | null {
  try {
    const v = JSON.parse(json) as unknown;
    return isPayload(v) ? v : null;
  } catch {
    return null;
  }
}

/** Extracts a payload from clipboard HTML written by `encodeHtml`. */
export function payloadFromHtml(html: string): ClipboardPayload | null {
  const m = new RegExp(`${HTML_ATTR}="([A-Za-z0-9+/=]+)"`).exec(html);
  if (!m?.[1]) return null;
  try {
    return parsePayload(fromBase64(m[1]));
  } catch {
    return null;
  }
}

export function encodeHtml(payload: ClipboardPayload): string {
  return `<meta charset="utf-8"><div ${HTML_ATTR}="${toBase64(JSON.stringify(payload))}">${escapeHtml(payload.text)}</div>`;
}

function textOf(nodes: Node[]): string {
  return nodes
    .flatMap((n) => (n.type === "text" ? [n.runs.map((r) => r.text).join("")] : []))
    .join("\n");
}

/** Serializes layers (with their subtrees and assets) for the clipboard. */
export function serializeNodes(design: Design, ids: Id[]): ClipboardPayload | null {
  const roots = ids.filter((id) => {
    const n = design.nodes[id];
    return n && n.type !== "root" && n.type !== "page";
  });
  if (roots.length === 0) return null;
  const nodes: Node[] = [];
  const placements: ClipboardPayload["placements"] = {};
  const assetIds = new Set<Id>();
  for (const id of roots) {
    const node = design.nodes[id] as Node;
    const p = decompose(worldTransform(design, id), node.width, node.height, node);
    placements[id] = p;
    for (const n of subtree(design, id)) {
      nodes.push(structuredClone(n));
      collectAssetIds(n, assetIds);
    }
  }
  const assets = [...assetIds]
    .map((aid) => design.assets[aid])
    .filter((a): a is AssetRef => !!a)
    .map(({ url: _url, ...rest }) => rest as AssetRef);
  return {
    kind: "desyn/nodes",
    version: 1,
    designId: design.id,
    roots,
    nodes,
    placements,
    assets,
    text: textOf(nodes),
  };
}

function collectAssetIds(node: Node, out: Set<Id>): void {
  const r = node as unknown as Record<string, unknown>;
  for (const key of ["assetId", "maskAssetId", "posterAssetId"]) {
    if (typeof r[key] === "string") out.add(r[key] as string);
  }
  const fills = [
    ...((r.fills as { type: string; assetId?: string }[] | undefined) ?? []),
    ...(
      (r.strokes as { fills?: { type: string; assetId?: string }[] }[] | undefined) ?? []
    ).flatMap((s) => s.fills ?? []),
  ];
  for (const f of fills) if (f.type === "image" && f.assetId) out.add(f.assetId);
}

/** Where pasted layers go: into a single selected frame / group, otherwise onto the current page. */
function pasteTarget(
  editor: EditorController,
  design: Design,
  payload: ClipboardPayload,
): Id | null {
  const sel = editor.getState().selection;
  if (sel.length === 1) {
    const n = design.nodes[sel[0] as Id];
    if (
      n &&
      (n.type === "frame" || n.type === "group") &&
      !n.locked &&
      !payload.roots.includes(n.id)
    ) {
      return n.id;
    }
  }
  return editor.getState().pageId;
}

/**
 * Builds the ops that insert a payload (fresh ids) into `parent`, translated by (dx, dy) in page space.
 * Returns the ops and the new root ids.
 */
export function buildPasteOps(
  design: Design,
  payload: ClipboardPayload,
  parent: Id,
  delta: { x: number; y: number },
): { ops: Op[]; roots: Id[] } {
  // A scratch design holding the payload lets doc-ops' cloneSubtree remap ids, animations and links.
  const scratchPage = "zzclipboard0";
  const byId: Record<Id, Node> = {};
  for (const n of payload.nodes) byId[n.id] = structuredClone(n);
  for (const id of payload.roots) {
    const root = byId[id];
    if (root) root.parent = scratchPage;
  }
  const scratch: Design = {
    ...design,
    nodes: {
      ...byId,
      [ROOT_ID]: { ...(design.nodes[ROOT_ID] as Node), children: [scratchPage] } as Node,
      [scratchPage]: {
        ...(Object.values(design.nodes).find((n) => n.type === "page") as Node),
        id: scratchPage,
        parent: ROOT_ID,
        children: payload.roots.filter((id) => byId[id]),
      } as Node,
    },
  };
  const parentNode = design.nodes[parent];
  const toLocal = invertMatrix(worldTransform(design, parent));
  const startIndex = parentNode && "children" in parentNode ? parentNode.children.length : 0;
  const ops: Op[] = [];
  const roots: Id[] = [];
  // Clipboard content is untrusted (any page can put a payload there): drop `url`, which is never persisted
  // and would make the engine fetch an arbitrary address; signed URLs come from the design's assets.
  const missingAssets = payload.assets
    .filter((a) => typeof a?.id === "string" && !design.assets[a.id])
    .map(({ url: _url, ...ref }) => ref as AssetRef);
  if (missingAssets.length > 0) {
    ops.push({ op: "asset", set: Object.fromEntries(missingAssets.map((a) => [a.id, a])) });
  }
  payload.roots.forEach((id, k) => {
    const root = byId[id];
    const placed = payload.placements[id];
    if (!root || !placed) return;
    const { op } = cloneSubtree(scratch, id, { parent, index: startIndex + k });
    const head = op.nodes[0] as Node;
    const world = localTransform({
      x: placed.x + delta.x,
      y: placed.y + delta.y,
      width: root.width,
      height: root.height,
      rotation: placed.rotation,
      flipX: placed.flipX,
      flipY: placed.flipY,
    });
    const p = decompose(multiply(toLocal, world), root.width, root.height, placed);
    head.x = round(p.x);
    head.y = round(p.y);
    head.rotation = round(p.rotation);
    if (p.flipX) head.flipX = true;
    else delete head.flipX;
    if (p.flipY) head.flipY = true;
    else delete head.flipY;
    ops.push(op);
    roots.push(head.id);
  });
  return { ops, roots };
}

const round = (v: number) => Math.round(v * 10_000) / 10_000;

function payloadBounds(payload: ClipboardPayload) {
  let x0 = Number.POSITIVE_INFINITY;
  let y0 = Number.POSITIVE_INFINITY;
  let x1 = Number.NEGATIVE_INFINITY;
  let y1 = Number.NEGATIVE_INFINITY;
  for (const id of payload.roots) {
    const n = payload.nodes.find((x) => x.id === id);
    const p = payload.placements[id];
    if (!n || !p) continue;
    x0 = Math.min(x0, p.x);
    y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x + n.width);
    y1 = Math.max(y1, p.y + n.height);
  }
  return Number.isFinite(x0) ? { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } : null;
}

function intersects(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
) {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/** Fits a w×h box into the page (80 % at most), keeping the aspect ratio. */
function fitSize(w: number, h: number, page: { width: number; height: number } | null) {
  const maxW = (page?.width ?? 1080) * 0.8;
  const maxH = (page?.height ?? 1080) * 0.8;
  const s = Math.min(1, maxW / Math.max(w, 1), maxH / Math.max(h, 1));
  return { width: Math.max(1, Math.round(w * s)), height: Math.max(1, Math.round(h * s)) };
}

/** Width / height of SVG markup from its attributes or viewBox. */
export function svgSize(markup: string): { width: number; height: number } {
  const tag = /<svg\b[^>]*>/i.exec(markup)?.[0] ?? "";
  const attr = (name: string) => {
    const m = new RegExp(`\\s${name}\\s*=\\s*["']\\s*([\\d.]+)(px)?\\s*["']`, "i").exec(tag);
    return m?.[1] ? Number(m[1]) : undefined;
  };
  const vb = /viewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)\s*["']/i.exec(
    tag,
  );
  const width = attr("width") ?? (vb?.[1] ? Number(vb[1]) : 300);
  const height = attr("height") ?? (vb?.[2] ? Number(vb[2]) : 150);
  return { width: width > 0 ? width : 300, height: height > 0 ? height : 150 };
}

const isSvgText = (text: string) =>
  /^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(text);

const IMAGE_TYPES = /^image\/(png|jpe?g|webp|gif|avif|svg\+xml)$/;

export class ClipboardService {
  private internal: ClipboardPayload | null = null;
  private pasteCount = 0;
  private pasteInPlaceNext = false;

  constructor(private readonly editor: EditorController) {}

  hasContent(): boolean {
    return this.internal !== null;
  }

  /** The next native paste event pastes in place (mod+shift+v). */
  armPasteInPlace(): void {
    this.pasteInPlaceNext = true;
  }

  private capture(): ClipboardPayload | null {
    const design = this.editor.design;
    if (!design) return null;
    const payload = serializeNodes(design, selectedIds(this.editor, design));
    if (payload) {
      this.internal = payload;
      this.pasteCount = 0;
    }
    return payload;
  }

  /** `copy` / `cut` DOM events (document level). Returns true when handled. */
  handleCopyEvent(event: ClipboardEvent, cut: boolean): boolean {
    if (!event.clipboardData) return false;
    const payload = this.capture();
    if (!payload) return false;
    event.clipboardData.setData(DESYN_MIME, JSON.stringify(payload));
    event.clipboardData.setData("text/html", encodeHtml(payload));
    event.clipboardData.setData("text/plain", payload.text || " ");
    event.preventDefault();
    if (cut) void this.deleteSelection("Cut");
    return true;
  }

  /** Copy without a DOM event (menus, palette): async clipboard API, internal copy as fallback. */
  async copy(cut = false): Promise<void> {
    const payload = this.capture();
    if (!payload) return;
    try {
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/html": new Blob([encodeHtml(payload)], { type: "text/html" }),
          "text/plain": new Blob([payload.text || " "], { type: "text/plain" }),
        }),
      ]);
    } catch {
      // Clipboard permission denied: the in-memory copy still pastes inside this editor.
    }
    if (cut) await this.deleteSelection("Cut");
  }

  private async deleteSelection(label: string): Promise<void> {
    await this.editor.apply(
      (design) => {
        const ids = selectedIds(this.editor, design).filter((id) => !design.nodes[id]?.locked);
        return ids.length > 0 ? deleteNodes(design, ids, { label }) : null;
      },
      { select: [], label },
    );
  }

  /** `paste` DOM event. Returns true when handled. */
  handlePasteEvent(event: ClipboardEvent): boolean {
    const data = event.clipboardData;
    const inPlace = this.pasteInPlaceNext;
    this.pasteInPlaceNext = false;
    if (!data || !this.editor.canEdit) return false;
    const custom = data.getData(DESYN_MIME);
    const html = data.getData("text/html");
    const payload = (custom && parsePayload(custom)) || (html && payloadFromHtml(html)) || null;
    if (payload) {
      event.preventDefault();
      void this.insertPayload(payload, inPlace);
      return true;
    }
    const files = [...data.files].filter((f) => IMAGE_TYPES.test(f.type));
    if (files.length > 0) {
      event.preventDefault();
      void this.insertFiles(files);
      return true;
    }
    const text = data.getData("text/plain");
    if (text) {
      event.preventDefault();
      void this.insertPlainText(text, inPlace);
      return true;
    }
    return false;
  }

  /** Paste without a DOM event (menus, palette): async clipboard API, internal copy as fallback. */
  async paste(inPlace = false): Promise<void> {
    if (!this.editor.canEdit) return;
    try {
      const items = await navigator.clipboard.read();
      for (const item of items) {
        if (item.types.includes("text/html")) {
          const p = payloadFromHtml(await (await item.getType("text/html")).text());
          if (p) return void (await this.insertPayload(p, inPlace));
        }
        const image = item.types.find((t) => IMAGE_TYPES.test(t));
        if (image) {
          const blob = await item.getType(image);
          const ext = image.split("/")[1]?.replace("+xml", "") ?? "png";
          return void (await this.insertFiles([
            new File([blob], `pasted.${ext}`, { type: image }),
          ]));
        }
        if (item.types.includes("text/plain")) {
          return void (await this.insertPlainText(
            await (await item.getType("text/plain")).text(),
            inPlace,
          ));
        }
      }
    } catch {
      // No permission / unsupported: fall back to the in-memory copy.
    }
    if (this.internal) await this.insertPayload(this.internal, inPlace);
  }

  /** Inserts copied layers (fresh ids). Regular pastes cascade by 16 px or center in view when off-screen. */
  async insertPayload(payload: ClipboardPayload, inPlace = false): Promise<Id[]> {
    const isInternal =
      this.internal?.text === payload.text && this.internal?.designId === payload.designId;
    if (!inPlace && isInternal) this.pasteCount++;
    let roots: Id[] = [];
    await this.editor.apply(
      (design) => {
        const parent = pasteTarget(this.editor, design, payload);
        if (!parent) return null;
        let delta = { x: 0, y: 0 };
        if (!inPlace) {
          const bounds = payloadBounds(payload);
          const sameDesign = payload.designId === design.id;
          const step = sameDesign ? PASTE_OFFSET * Math.max(1, this.pasteCount) : 0;
          delta = { x: step, y: step };
          const visible = visiblePageRect(this.editor);
          if (bounds && visible) {
            const moved = { ...bounds, x: bounds.x + delta.x, y: bounds.y + delta.y };
            if (!intersects(moved, visible)) {
              const c = viewCenterInPage(this.editor);
              delta = {
                x: c.x - (bounds.x + bounds.width / 2),
                y: c.y - (bounds.y + bounds.height / 2),
              };
            }
          }
        }
        const built = buildPasteOps(design, payload, parent, delta);
        roots = built.roots;
        return built.ops.length > 0
          ? makeTransaction(built.ops, inPlace ? "Paste in place" : "Paste")
          : null;
      },
      { label: inPlace ? "Paste in place" : "Paste" },
    );
    if (roots.length > 0) this.editor.select(roots);
    return roots;
  }

  /** Text from another app: SVG markup becomes a vector layer, anything else a text layer. */
  async insertPlainText(text: string, inPlace = false): Promise<void> {
    if (this.internal && text === this.internal.text && this.internal.text !== "") {
      // The browser dropped our richer flavours (e.g. plain-text paste): use the in-memory copy.
      await this.insertPayload(this.internal, inPlace);
      return;
    }
    if (isSvgText(text)) {
      await this.insertSvgMarkup(text.trim());
      return;
    }
    const content = text.replace(/\r\n?/g, "\n").trim();
    if (!content) return;
    const center = viewCenterInPage(this.editor);
    const page = this.editor.currentPage();
    const singleLine = !content.includes("\n") && content.length <= 60;
    // Readable on the page it lands on: about 1/18 of the short side (60 px on a 1080 px post).
    const fontSize = page
      ? Math.min(120, Math.max(16, Math.round(Math.min(page.width, page.height) / 18)))
      : 32;
    const maxWidth = page ? Math.round(page.width * 0.8) : 640;
    const node = createText({
      text: content,
      name: content.slice(0, 40),
      style: defaultTextStyle({ fontSize }),
      autoResize: singleLine ? "width" : "height",
      // Approximate box; the engine measures the real text when it normalizes the transaction.
      width: singleLine
        ? Math.min(maxWidth, Math.max(40, Math.round(content.length * fontSize * 0.55)))
        : Math.min(maxWidth, Math.round(fontSize * 16)),
    });
    node.x = Math.round(center.x - node.width / 2);
    node.y = Math.round(center.y - node.height / 2);
    await this.insertNodes([node], "Paste text");
  }

  async insertSvgMarkup(markup: string, at?: { x: number; y: number }): Promise<void> {
    const size = fitSize(svgSize(markup).width, svgSize(markup).height, this.editor.currentPage());
    if (markup.length > MAX_INLINE_SVG) {
      await this.insertFiles([new File([markup], "pasted.svg", { type: "image/svg+xml" })], at);
      return;
    }
    const c = at ?? viewCenterInPage(this.editor);
    const node = createSvg({ markup, name: "Vector", ...size });
    node.x = Math.round(c.x - size.width / 2);
    node.y = Math.round(c.y - size.height / 2);
    await this.insertNodes([node], "Paste vector");
  }

  private async insertNodes(nodes: Node[], label: string, extra: Op[] = []): Promise<void> {
    const pageId = this.editor.getState().pageId;
    if (!pageId) return;
    const ops: Op[] = [
      ...extra,
      ...nodes.map((n): Op => ({ op: "create", nodes: [n], parent: pageId })),
    ];
    await this.editor.apply(ops, { label, select: nodes.map((n) => n.id) });
  }

  /**
   * Uploads image files to the workspace library and places them (centered in view, or at `at` in page
   * coordinates). SVG files become vector layers when small enough to inline.
   */
  async insertFiles(files: File[], at?: { x: number; y: number }): Promise<void> {
    if (!this.editor.canEdit) return;
    for (const [i, file] of files.entries()) {
      const offset = i * 24;
      const point = at ? { x: at.x + offset, y: at.y + offset } : undefined;
      if (file.type === "image/svg+xml" && file.size <= MAX_INLINE_SVG) {
        await this.insertSvgMarkup(await file.text(), point);
        continue;
      }
      if (!IMAGE_TYPES.test(file.type)) {
        this.editor.notify({
          kind: "warning",
          title: `"${file.name}" is not an image Desyn can place.`,
        });
        continue;
      }
      try {
        const { ref } = await this.editor.assets.upload(file, file.name);
        const size = fitSize(ref.width ?? 800, ref.height ?? 600, this.editor.currentPage());
        const c = point ?? viewCenterInPage(this.editor);
        const node =
          ref.kind === "svg"
            ? createSvg({ assetId: ref.id, name: file.name.replace(/\.[^.]+$/, ""), ...size })
            : createImage({
                assetId: ref.id,
                name: file.name.replace(/\.[^.]+$/, "") || "Image",
                ...size,
              });
        node.x = Math.round(c.x - size.width / 2 + offset);
        node.y = Math.round(c.y - size.height / 2 + offset);
        await this.insertNodes([node], "Place image", [{ op: "asset", set: { [ref.id]: ref } }]);
      } catch (e) {
        this.editor.notify({
          kind: "error",
          title: `Couldn't upload "${file.name}"`,
          description: e instanceof Error ? e.message : String(e),
        });
      }
    }
  }

  /** "Place image…": file picker, then upload + place. */
  pickAndPlaceImages(): void {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/png,image/jpeg,image/webp,image/gif,image/avif,image/svg+xml";
    input.multiple = true;
    input.addEventListener("change", () => {
      const files = [...(input.files ?? [])];
      if (files.length > 0) void this.insertFiles(files);
    });
    input.click();
  }

  /** Copies the selection (or the page) as a PNG image. */
  async copyAsPng(): Promise<void> {
    const design = this.editor.design;
    const page = this.editor.currentPage();
    if (!design || !page) return;
    const ids = selectedIds(this.editor, design);
    const b = ids.length > 0 ? boundsOf(design, ids) : undefined;
    try {
      const { bytes } = await this.editor.engine.export({
        format: "png",
        pageId: page.id,
        scale: 2,
        ...(b
          ? {
              region: { x: b.x, y: b.y, w: Math.max(1, b.width), h: Math.max(1, b.height) },
              background: "transparent",
            }
          : {}),
      });
      await navigator.clipboard.write([
        new ClipboardItem({ "image/png": new Blob([bytes as BlobPart], { type: "image/png" }) }),
      ]);
      this.editor.notify({ kind: "success", title: "Copied as PNG" });
    } catch (e) {
      this.editor.notify({
        kind: "error",
        title: "Couldn't copy as PNG",
        description: e instanceof Error ? e.message : String(e),
      });
    }
  }
}

export function clipboardCommands(): AnyCommand[] {
  return [
    {
      id: "edit.copy",
      label: "Copy",
      category: "clipboard",
      icon: Copy,
      when: "loaded && selectionHasNodes && !textEditing",
      // Keyboard copies go through the native `copy` event (system clipboard with all flavours).
      passThrough: true,
      run: (_a, { editor, source }) => {
        if (source !== "keyboard") return editor.clipboard.copy();
      },
    },
    {
      id: "edit.cut",
      label: "Cut",
      category: "clipboard",
      icon: Scissors,
      when: "canEdit && selectionHasNodes && !textEditing",
      passThrough: true,
      run: (_a, { editor, source }) => {
        if (source !== "keyboard") return editor.clipboard.copy(true);
      },
    },
    {
      id: "edit.paste",
      label: "Paste",
      category: "clipboard",
      icon: ClipboardPaste,
      when: "canEdit && !textEditing",
      passThrough: true,
      run: (_a, { editor, source }) => {
        if (source !== "keyboard") return editor.clipboard.paste(false);
      },
    },
    {
      id: "edit.pasteInPlace",
      label: "Paste in place",
      category: "clipboard",
      icon: ClipboardPaste,
      when: "canEdit && !textEditing",
      passThrough: true,
      run: (_a, { editor, source }) => {
        if (source === "keyboard") editor.clipboard.armPasteInPlace();
        else return editor.clipboard.paste(true);
      },
    },
    {
      id: "edit.copyAsPng",
      label: "Copy as PNG",
      category: "clipboard",
      icon: ImageDown,
      when: "engineReady && !textEditing",
      run: (_a, { editor }) => editor.clipboard.copyAsPng(),
    },
    {
      id: "edit.copyText",
      label: "Copy text",
      category: "clipboard",
      icon: ClipboardCopy,
      when: "selectionHasText && !textEditing",
      run: async (_a, { editor }) => {
        const text = textOf(editor.selectedNodes());
        if (text) await navigator.clipboard?.writeText(text);
      },
    },
  ];
}
