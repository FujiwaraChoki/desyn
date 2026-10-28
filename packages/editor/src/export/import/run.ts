import { pages } from "@desyn/doc-ops";
import {
  type AssetRef,
  createImage,
  createPage,
  type Id,
  newId,
  type Op,
  ROOT_ID,
  solid,
} from "@desyn/schema";
import { errorMessage } from "../../collab/live.ts";
import type { EditorController } from "../../controller.ts";
import { parseDesignFile } from "./desyn-file.ts";
import { mergeDesignPages, usedAssetIds } from "./merge.ts";
import { renderPdfPages } from "./pdf.ts";
import { parsePptx } from "./pptx.ts";
import { pptxToOps } from "./pptx-design.ts";

/**
 * Import of files into the open design: images and SVG are placed on the current page (the clipboard
 * service does that), PDF pages become pages with the rendered page image, PowerPoint slides become pages with
 * editable shapes and text, `.desyn` / Design JSON files add their pages. One undo step per file.
 */

export type ImportKind = "image" | "svg" | "pdf" | "pptx" | "design";

export interface ImportItem {
  id: string;
  name: string;
  kind: ImportKind | null;
  status: "waiting" | "working" | "done" | "error";
  done: number;
  total: number;
  message: string | null;
}

const IMAGE = /^image\/(png|jpeg|webp|gif|avif|bmp)$/;
const PPTX_MIME = "application/vnd.openxmlformats-officedocument.presentationml.presentation";

/** What a file is, by type and extension (browsers often leave `type` empty for .desyn / .pptx). */
export function importKindOf(file: { name: string; type: string }): ImportKind | null {
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  if (file.type === "image/svg+xml" || ext === "svg") return "svg";
  if (IMAGE.test(file.type) || ["png", "jpg", "jpeg", "webp", "gif", "avif", "bmp"].includes(ext))
    return "image";
  if (file.type === "application/pdf" || ext === "pdf") return "pdf";
  if (file.type === PPTX_MIME || ext === "pptx") return "pptx";
  if (ext === "desyn" || file.type === "application/x-desyn") return "design";
  if (ext === "json" || file.type === "application/json") return "design";
  return null;
}

function extensionMime(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "png";
  return ext === "jpg" ? "jpeg" : ext;
}

export const IMPORT_ACCEPT =
  ".svg,.png,.jpg,.jpeg,.webp,.gif,.avif,.bmp,.pdf,.pptx,.desyn,.json,image/*,application/pdf";

export interface ImportCallbacks {
  onUpdate: (patch: Partial<ImportItem>) => void;
  signal?: AbortSignal;
}

function bytesOf(file: Blob): Promise<Uint8Array> {
  return file.arrayBuffer().then((b) => new Uint8Array(b));
}

async function upload(
  editor: EditorController,
  bytes: Uint8Array | Blob,
  name: string,
  mime: string,
): Promise<AssetRef> {
  const blob = bytes instanceof Blob ? bytes : new Blob([bytes as BlobPart], { type: mime });
  const file = new File([blob], name, { type: mime });
  return (await editor.assets.upload(file, name)).ref;
}

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Import canceled", "AbortError");
}

async function commitPages(
  editor: EditorController,
  ops: Op[],
  pageIds: Id[],
  label: string,
): Promise<void> {
  const result = await editor.apply(ops, { label, source: "import" });
  if (!result) throw new Error("The design could not be changed (read-only or still loading).");
  const first = pageIds.find((id) => editor.design?.nodes[id]?.type === "page");
  if (first) editor.setPage(first);
}

async function importPdf(
  editor: EditorController,
  file: File,
  cb: ImportCallbacks,
): Promise<string[]> {
  const data = await bytesOf(file);
  const base = file.name.replace(/\.pdf$/i, "");
  const ops: Op[] = [];
  const assets: Record<Id, AssetRef> = {};
  const pageIds: Id[] = [];
  const start = editor.design ? pages(editor.design).length : 0;
  for await (const page of renderPdfPages(data, cb.signal ? { signal: cb.signal } : {})) {
    cb.onUpdate({
      total: page.count,
      done: page.index,
      message: `Rendering page ${page.index + 1} of ${page.count}`,
    });
    const ext = page.mime === "image/png" ? "png" : "jpg";
    const ref = await upload(
      editor,
      page.image,
      `${base} - page ${page.index + 1}.${ext}`,
      page.mime,
    );
    checkAbort(cb.signal);
    assets[ref.id] = ref;
    const pageId = newId();
    const image = createImage({
      id: newId(),
      parent: pageId,
      name: `${base} · page ${page.index + 1}`,
      assetId: ref.id,
      x: 0,
      y: 0,
      width: page.width,
      height: page.height,
      fit: "fill",
    });
    const node = createPage({
      id: pageId,
      parent: ROOT_ID,
      name: page.count > 1 ? `${base} ${page.index + 1}` : base,
      width: page.width,
      height: page.height,
      unit: "pt",
      background: [solid("#ffffff")],
      children: [image.id],
    });
    ops.push({
      op: "create",
      nodes: [node, image],
      parent: ROOT_ID,
      index: start + pageIds.length,
    });
    pageIds.push(pageId);
    cb.onUpdate({ done: page.index + 1 });
  }
  if (pageIds.length === 0) throw new Error("The PDF has no pages.");
  await commitPages(editor, [{ op: "asset", set: assets }, ...ops], pageIds, `Import ${file.name}`);
  return [];
}

async function importPptx(
  editor: EditorController,
  file: File,
  cb: ImportCallbacks,
): Promise<string[]> {
  const doc = parsePptx(await bytesOf(file));
  const media = new Map<string, AssetRef>();
  const total = doc.media.size + 1;
  cb.onUpdate({ total, done: 0, message: `${doc.slides.length} slides` });
  let done = 0;
  const failed: string[] = [];
  for (const [path, m] of doc.media) {
    checkAbort(cb.signal);
    try {
      media.set(path, await upload(editor, m.bytes, path.split("/").pop() ?? "image", m.mime));
    } catch (e) {
      failed.push(errorMessage(e));
    }
    cb.onUpdate({ done: ++done, message: `Uploading pictures (${done} of ${doc.media.size})` });
  }
  const start = editor.design ? pages(editor.design).length : 0;
  const { ops, pageIds } = pptxToOps(doc, media, start);
  await commitPages(editor, ops, pageIds, `Import ${file.name}`);
  cb.onUpdate({ done: total });
  const warnings = [...doc.warnings];
  if (failed.length > 0)
    warnings.push(`${failed.length} pictures could not be uploaded (${failed[0]}).`);
  return warnings;
}

async function importDesignFile(
  editor: EditorController,
  file: File,
  cb: ImportCallbacks,
): Promise<string[]> {
  const parsed = parseDesignFile(await bytesOf(file));
  const target = editor.design;
  if (!target) throw new Error("The design is still loading.");
  // Upload the assets the imported pages use (bytes from the archive).
  const pageNodes = new Set<Id>();
  for (const p of pages(parsed.design)) {
    const stack: Id[] = [p.id];
    while (stack.length > 0) {
      const id = stack.pop() as Id;
      pageNodes.add(id);
      const n = parsed.design.nodes[id] as { children?: Id[] } | undefined;
      if (n?.children) stack.push(...n.children);
    }
  }
  // Assets the imported layers reference, plus custom fonts (text refers to them by family, not by id).
  const fonts = Object.values(parsed.design.assets)
    .filter((a) => a.kind === "font" && !target.assets[a.id])
    .map((a) => a.id);
  const used = [...new Set([...usedAssetIds(parsed.design, pageNodes), ...fonts])].filter((id) =>
    parsed.assets.has(id),
  );
  const map = new Map<Id, AssetRef>();
  cb.onUpdate({ total: used.length + 1, done: 0 });
  let done = 0;
  const failed: string[] = [];
  const failedIds = new Set<Id>();
  for (const id of used) {
    checkAbort(cb.signal);
    const a = parsed.assets.get(id);
    if (!a) continue;
    try {
      const ref = await upload(editor, a.bytes, a.name, a.mime);
      // Keep font metadata (family / weight / style) the upload cannot know.
      const original = parsed.design.assets[id];
      map.set(id, {
        ...ref,
        ...(original?.family ? { family: original.family } : {}),
        ...(original?.weight ? { weight: original.weight } : {}),
        ...(original?.style ? { style: original.style } : {}),
        ...(original?.name ? { name: original.name } : {}),
      });
    } catch (e) {
      // One asset the plan or the server refuses (custom fonts on Free, an unsupported type) does not stop
      // the import; it is reported and shows as missing.
      failed.push(`${a.name}: ${errorMessage(e)}`);
      failedIds.add(id);
    }
    cb.onUpdate({ done: ++done, message: `Uploading assets (${done} of ${used.length})` });
  }
  const merged = mergeDesignPages(parsed.design, editor.design ?? target, { assets: map });
  await commitPages(editor, merged.ops, merged.pageIds, `Import ${file.name}`);
  cb.onUpdate({ done: used.length + 1 });
  const warnings = [...parsed.warnings];
  if (failed.length > 0) {
    warnings.push(
      `${failed.length} ${failed.length === 1 ? "file" : "files"} could not be uploaded (${failed[0]}).`,
    );
  }
  const notInFile = merged.missingAssets.filter((id) => !failedIds.has(id)).length;
  if (notInFile > 0) {
    warnings.push(`${notInFile} images or fonts were not in the file and show as missing.`);
  }
  return warnings;
}

/** Imports one file. Resolves to warnings for the person (empty when everything came across). */
export async function importFile(
  editor: EditorController,
  file: File,
  cb: ImportCallbacks,
): Promise<string[]> {
  if (!editor.canEdit) throw new Error("You can't edit this design.");
  const kind = importKindOf(file);
  switch (kind) {
    case "image":
    case "svg": {
      cb.onUpdate({ total: 1, done: 0 });
      // Files from some sources (drag from other apps, renamed files) carry no MIME type.
      const type = kind === "svg" ? "image/svg+xml" : `image/${extensionMime(file.name)}`;
      const typed = file.type ? file : new File([file], file.name, { type });
      await editor.clipboard.insertFiles([typed]);
      cb.onUpdate({ done: 1 });
      return [];
    }
    case "pdf":
      return importPdf(editor, file, cb);
    case "pptx":
      return importPptx(editor, file, cb);
    case "design":
      return importDesignFile(editor, file, cb);
    default:
      throw new Error(
        "Desyn can import SVG, images, PDF, PowerPoint, .desyn and design JSON files.",
      );
  }
}
