import { getNode, replaceImage } from "@desyn/doc-ops";
import { createText, defaultTextStyle, type Id, solid } from "@desyn/schema";
import { defaultFontSize } from "../tools/text.ts";
import type { CanvasController } from "./controller.ts";
import { backgroundAt, creationParent, inkFor, placeRect } from "./create.ts";
import { localHitPath } from "./hit.ts";
import type { Point } from "./math.ts";

/**
 * Drag and drop onto the canvas: image / SVG files (uploaded and placed at the drop point; a single image
 * dropped on an image layer replaces it), images and links dragged from other pages (fetched, then uploaded),
 * SVG markup and plain text (a text layer at the drop point).
 */

const IMAGE_TYPES = /^image\/(png|jpe?g|webp|gif|avif|svg\+xml)$/;
const URL_RE = /^(https?:\/\/|data:image\/)/i;

export type DropKind = "files" | "url" | "text";

/** What a drag carries, from its types (contents are only readable on drop). */
export function dropKind(types: readonly string[]): DropKind | null {
  if (types.includes("Files")) return "files";
  if (types.includes("text/uri-list") || types.includes("text/html")) return "url";
  if (types.includes("text/plain")) return "text";
  return null;
}

/** First image URL in dropped HTML (`<img src>`), or the first URL of a uri-list. */
export function droppedUrl(uriList: string, html: string): string | null {
  if (html && typeof DOMParser !== "undefined") {
    const img = new DOMParser().parseFromString(html, "text/html").querySelector("img[src]");
    const src = img?.getAttribute("src");
    if (src && URL_RE.test(src)) return src;
  }
  const line = uriList
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith("#"));
  return line && URL_RE.test(line) ? line : null;
}

function fileNameFor(url: string, mime: string): string {
  const ext = mime.split("/")[1]?.replace("svg+xml", "svg").replace("jpeg", "jpg") ?? "png";
  try {
    const name = new URL(url).pathname.split("/").pop() ?? "";
    if (name && /\.[a-z0-9]+$/i.test(name)) return decodeURIComponent(name);
  } catch {
    // data: URLs have no file name.
  }
  return `dropped-image.${ext}`;
}

/** The image layer under a drop point (single-image replace target). */
function imageAt(c: CanvasController, p: Point): Id | null {
  const design = c.design;
  const pageId = c.pageId;
  if (!design || !pageId) return null;
  const path = localHitPath(design, pageId, p);
  const last = path[path.length - 1];
  return last && getNode(design, last)?.type === "image" ? last : null;
}

export function installDrop(c: CanvasController): () => void {
  const root = c.root;
  let depth = 0;

  const kindOf = (e: DragEvent) => (e.dataTransfer ? dropKind([...e.dataTransfer.types]) : null);
  const clear = () => {
    depth = 0;
    c.dropTarget = null;
    c.setUi({ drop: null });
    c.invalidate();
  };
  const screenOf = (e: DragEvent) => {
    const r = root.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const onEnter = (e: DragEvent) => {
    if (!c.canEdit || !kindOf(e)) return;
    e.preventDefault();
    depth++;
  };
  const onOver = (e: DragEvent) => {
    const kind = kindOf(e);
    if (!c.canEdit || !kind) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    const p = c.toPage(screenOf(e));
    const items = e.dataTransfer ? [...e.dataTransfer.items] : [];
    const imageFiles = items.filter((i) => i.kind === "file" && IMAGE_TYPES.test(i.type));
    const replace = kind === "files" && imageFiles.length === 1 ? imageAt(c, p) : null;
    const label = replace
      ? "Drop to replace the image"
      : kind === "files"
        ? "Drop to place"
        : kind === "url"
          ? "Drop to place the image"
          : "Drop to add text";
    const ui = c.getUi().drop;
    if (!ui || ui.label !== label || ui.target !== replace)
      c.setUi({ drop: { label, target: replace } });
    if (c.dropTarget !== replace) {
      c.dropTarget = replace;
      c.invalidate();
    }
  };
  const onLeave = (e: DragEvent) => {
    if (!kindOf(e)) return;
    depth = Math.max(0, depth - 1);
    if (depth === 0) clear();
  };
  const onDrop = (e: DragEvent) => {
    const kind = kindOf(e);
    if (!c.canEdit || !kind || !e.dataTransfer) return;
    e.preventDefault();
    e.stopPropagation();
    const at = c.toPage(screenOf(e));
    const data = e.dataTransfer;
    const files = [...data.files];
    const uriList = data.getData("text/uri-list");
    const html = data.getData("text/html");
    const text = data.getData("text/plain");
    const target = c.dropTarget;
    clear();
    void handleDrop(c, { kind, files, uriList, html, text, at, target });
  };

  root.addEventListener("dragenter", onEnter);
  root.addEventListener("dragover", onOver);
  root.addEventListener("dragleave", onLeave);
  root.addEventListener("drop", onDrop);
  return () => {
    root.removeEventListener("dragenter", onEnter);
    root.removeEventListener("dragover", onOver);
    root.removeEventListener("dragleave", onLeave);
    root.removeEventListener("drop", onDrop);
  };
}

export interface DropData {
  kind: DropKind;
  files: File[];
  uriList: string;
  html: string;
  text: string;
  at: Point;
  target: Id | null;
}

export async function handleDrop(c: CanvasController, d: DropData): Promise<void> {
  const editor = c.editor;
  if (d.kind === "files") {
    const images = d.files.filter((f) => IMAGE_TYPES.test(f.type));
    if (d.target && images.length === 1 && d.files.length === 1) {
      await replaceWith(c, d.target, images[0] as File);
      return;
    }
    await editor.clipboard.insertFiles(d.files, d.at);
    return;
  }
  const url =
    d.kind === "url"
      ? droppedUrl(d.uriList, d.html)
      : URL_RE.test(d.text.trim())
        ? d.text.trim()
        : null;
  if (url) {
    await placeUrl(c, url, d.at);
    return;
  }
  const text = d.text.trim();
  if (!text) return;
  if (/^<svg[\s>]/i.test(text) || (text.startsWith("<?xml") && text.includes("<svg"))) {
    await editor.clipboard.insertSvgMarkup(text, d.at);
    return;
  }
  await placeText(c, text, d.at);
}

async function replaceWith(c: CanvasController, id: Id, file: File): Promise<void> {
  const editor = c.editor;
  try {
    const { ref } = await editor.assets.upload(file, file.name);
    await editor.apply((design) => replaceImage(design, id, ref.id, { asset: ref }), {
      label: "Replace image",
      select: [id],
    });
  } catch (e) {
    editor.notify({
      kind: "error",
      title: `Couldn't upload "${file.name}"`,
      description: e instanceof Error ? e.message : String(e),
    });
  }
}

async function placeUrl(c: CanvasController, url: string, at: Point): Promise<void> {
  const editor = c.editor;
  let blob: Blob;
  try {
    const res = await fetch(url, { mode: "cors", credentials: "omit" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    blob = await res.blob();
  } catch {
    editor.notify({
      kind: "warning",
      title: "That site doesn't let other apps use its image",
      description: "Save the image to your computer, then drop the file here.",
    });
    return;
  }
  const mime = blob.type.split(";")[0]?.trim() ?? "";
  if (!IMAGE_TYPES.test(mime)) {
    editor.notify({ kind: "warning", title: "The link isn't an image Desyn can place." });
    return;
  }
  await editor.clipboard.insertFiles(
    [new File([blob], fileNameFor(url, mime), { type: mime })],
    at,
  );
}

async function placeText(c: CanvasController, text: string, at: Point): Promise<void> {
  const design = c.design;
  const pageId = c.pageId;
  const page = c.page;
  if (!design || !pageId || !page) return;
  const parent = creationParent(design, pageId, at);
  const fontSize = defaultFontSize(page.width, page.height);
  const content = text.replace(/\r\n?/g, "\n");
  const single = !content.includes("\n") && content.length <= 60;
  const width = single ? 0 : Math.round(page.width * 0.6);
  const node = createText({
    text: content,
    name: content.slice(0, 40),
    style: defaultTextStyle({ fontSize, fills: [solid(inkFor(backgroundAt(design, parent)))] }),
    autoResize: single ? "width" : "height",
  });
  const lineHeight = Math.round(fontSize * 1.2);
  const place = placeRect(design, parent, {
    x: at.x - width / 2,
    y: at.y - lineHeight / 2,
    w: width,
    h: lineHeight,
  });
  await c.editor.apply([{ op: "create", nodes: [{ ...node, ...place }], parent }], {
    label: "Drop text",
    select: [node.id],
  });
}
