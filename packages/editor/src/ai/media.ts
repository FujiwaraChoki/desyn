import type { OutpaintDirection } from "@desyn/ai";
import { addPage, approxBounds, makeTransaction, pageOf, replaceImage } from "@desyn/doc-ops";
import {
  type AssetRef,
  createImage,
  createSvg,
  type Design,
  type Id,
  type ImageNode,
  type Node,
  newId,
  type Op,
} from "@desyn/schema";
import { viewCenterInPage } from "../commands/helpers.ts";
import type { EditorController } from "../controller.ts";
import { assetRefFromView, mimeOf, sha256OfBlob } from "../sync/assets.ts";
import type {
  AiBackend,
  GeneratedAssetView,
  MediaArgs,
  MediaResult,
  MediaTask,
} from "./backend/types.ts";

/**
 * Generative media from the editor: resolves the selected image to its workspace asset (the media actions take
 * Convex asset ids), uploads masks and attachments, calls the ai/media actions and turns the stored results
 * into layers: replaced images keep their box (expanded ones grow by the new area), new images and vectors are
 * placed in view, mockups get a page of their own. Every change is one transaction labelled "AI: …".
 */

export interface ImageTarget {
  node: Node;
  /** Design asset id (AssetRef.id). */
  refId: Id;
  ref: AssetRef;
}

/** The image a media action works on: an image node, or a shape / frame with an image fill. */
export function imageTarget(design: Design, id: Id): ImageTarget | null {
  const node = design.nodes[id];
  if (!node) return null;
  let refId: Id | undefined;
  if (node.type === "image") refId = node.assetId;
  else if ("fills" in node && Array.isArray(node.fills)) {
    refId = node.fills.find((f) => f.type === "image")?.assetId;
  }
  const ref = refId ? design.assets[refId] : undefined;
  if (!refId || !ref || ref.kind !== "image") return null;
  return { node, refId, ref };
}

/** Selected images (the first one is what single-image actions use). */
export function selectedImages(editor: EditorController): ImageTarget[] {
  const design = editor.design;
  if (!design) return [];
  return editor
    .getState()
    .selection.map((id) => imageTarget(design, id))
    .filter((t): t is ImageTarget => t !== null);
}

export interface UploadedForAi {
  /** Convex `assets` id (what media actions and run attachments take). */
  assetId: string;
  ref: AssetRef;
  url: string | null;
}

async function putBlob(url: string, blob: Blob, headers: Record<string, string>): Promise<void> {
  const allowed: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    // Browsers set content-length from the body and refuse scripts that try.
    if (k.toLowerCase() !== "content-length") allowed[k] = v;
  }
  const res = await fetch(url, { method: "PUT", body: blob, headers: allowed });
  if (!res.ok) throw new Error(`Upload failed (${res.status}). Try again.`);
}

export class MediaService {
  constructor(
    private readonly editor: EditorController,
    private readonly backend: AiBackend,
  ) {}

  private workspaceId(): string {
    const id = this.editor.sync.loadHeader?.workspaceId;
    if (!id) throw new Error("This design is not in a workspace you can add files to.");
    return id;
  }

  private get designId(): string {
    return this.editor.getState().designId;
  }

  /** Uploads bytes to the design's workspace (deduplicated by hash) and returns the Convex id + AssetRef. */
  async upload(blob: Blob, name: string): Promise<UploadedForAi> {
    const assets = this.editor.backend.assets;
    const mime = mimeOf({ name, type: blob.type });
    const request = await assets.requestUpload({
      workspaceId: this.workspaceId(),
      name: name.slice(0, 200) || "upload",
      mime,
      bytes: blob.size,
      sha256: await sha256OfBlob(blob),
    });
    let assetId = request.assetId;
    if (request.upload) {
      await putBlob(request.upload.url, blob, request.upload.headers);
      assetId = (await assets.finalize(request.assetId)).assetId;
    }
    const view = await assets.getAsset(assetId);
    const ref = assetRefFromView(view);
    if (view.url) this.editor.assets.prime(ref.id, view.url);
    return { assetId, ref, url: view.url };
  }

  /**
   * Convex id of a design asset. Files of the workspace are found by their hash without uploading anything;
   * assets from elsewhere (templates, other workspaces) are copied into the workspace first.
   */
  async convexAssetId(ref: AssetRef): Promise<string> {
    const assets = this.editor.backend.assets;
    if (ref.hash && ref.bytes) {
      const found = await assets.requestUpload({
        workspaceId: this.workspaceId(),
        name: ref.name ?? "image",
        mime: ref.mime,
        bytes: ref.bytes,
        sha256: ref.hash,
      });
      if (found.deduplicated && !found.upload) return found.assetId;
      if (found.upload) {
        // Not in this workspace yet: complete the upload with the real bytes.
        const blob = await this.bytesOf(ref);
        await putBlob(found.upload.url, blob, found.upload.headers);
        return (await assets.finalize(found.assetId)).assetId;
      }
    }
    const blob = await this.bytesOf(ref);
    return (await this.upload(blob, ref.name ?? `image.${ref.mime.split("/")[1] ?? "png"}`))
      .assetId;
  }

  private async bytesOf(ref: AssetRef): Promise<Blob> {
    const client = this.editor.engineClient;
    if (client?.hasDesign) {
      try {
        const { bytes, mime } = await client.readAsset(ref.id);
        return new Blob([bytes as BlobPart], { type: mime });
      } catch {
        // Not decoded in the engine: fetch below.
      }
    }
    const url = await this.editor.assets.urlFor(ref);
    if (!url) throw new Error("The image is not available yet. Try again in a moment.");
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Could not read the image (${res.status}).`);
    return new Blob([await res.arrayBuffer()], { type: ref.mime });
  }

  /** Runs a media action against this design (the result is attached to it and follows its brand). */
  run<T extends MediaTask>(task: T, args: MediaArgs[T]): Promise<MediaResult> {
    return this.backend.media(task, { ...args, designId: this.designId });
  }

  /** AssetRef of a generated asset (for the transaction that uses it). */
  async refOf(result: GeneratedAssetView): Promise<AssetRef> {
    const view = await this.editor.backend.assets.getAsset(result.assetId);
    const ref = assetRefFromView(view);
    ref.source = "ai";
    if (view.url) this.editor.assets.prime(ref.id, view.url);
    else if (result.url) this.editor.assets.prime(ref.id, result.url);
    return ref;
  }

  // -------------------------------------------------------------------------------------------------------
  // Applying results

  /** Points the target at a new image (background removal, upscale, inpaint). Returns the node id. */
  async replace(
    target: ImageTarget,
    result: GeneratedAssetView,
    label: string,
  ): Promise<Id | null> {
    const ref = await this.refOf(result);
    const applied = await this.editor.apply(
      (design) =>
        design.nodes[target.node.id]
          ? replaceImage(design, target.node.id, ref.id, { asset: ref, label, source: "ai" })
          : null,
      { label, select: [target.node.id] },
    );
    return applied ? target.node.id : null;
  }

  /**
   * Replaces an image with its expanded version and grows the layer by the generated area so the original
   * pixels stay exactly where they were.
   */
  async replaceExpanded(
    target: ImageTarget,
    result: GeneratedAssetView,
    grow: { left: number; right: number; top: number; bottom: number },
    source: { width: number; height: number },
    label: string,
  ): Promise<Id | null> {
    const ref = await this.refOf(result);
    const id = target.node.id;
    const applied = await this.editor.apply(
      (design) => {
        const node = design.nodes[id];
        if (!node) return null;
        const tx = replaceImage(design, id, ref.id, { asset: ref, label, source: "ai" });
        const sx = node.width / Math.max(1, source.width);
        const sy = node.height / Math.max(1, source.height);
        const ops: Op[] = [
          ...tx.ops,
          {
            op: "update",
            id,
            set: {
              x: node.x - grow.left * sx,
              y: node.y - grow.top * sy,
              width: node.width + (grow.left + grow.right) * sx,
              height: node.height + (grow.top + grow.bottom) * sy,
            },
          },
        ];
        return makeTransaction(ops, label, { source: "ai" });
      },
      { label, select: [id] },
    );
    return applied ? id : null;
  }

  /** Places a generated image (or vector) in view, sized to fit about 60 % of the visible page area. */
  async place(
    result: GeneratedAssetView,
    options: { label: string; name: string; near?: Id; kind?: "image" | "svg" },
  ): Promise<Id | null> {
    const ref = await this.refOf(result);
    const page = this.editor.currentPage();
    if (!page) return null;
    const w0 = result.width ?? ref.width ?? 1024;
    const h0 = result.height ?? ref.height ?? 1024;
    let box = { x: 0, y: 0, width: w0, height: h0 };
    const near =
      options.near && this.editor.design
        ? approxBounds(this.editor.design, options.near)
        : undefined;
    if (near) {
      // Over the source layer (vectors traced from an image keep its footprint).
      box = { x: near.x, y: near.y, width: near.width, height: near.height };
    } else {
      const fit = Math.min(1, (page.width * 0.6) / w0, (page.height * 0.6) / h0);
      const c = viewCenterInPage(this.editor);
      const width = w0 * fit;
      const height = h0 * fit;
      box = { x: c.x - width / 2, y: c.y - height / 2, width, height };
    }
    const id = newId();
    const kind = options.kind ?? (ref.kind === "svg" ? "svg" : "image");
    const node: Node =
      kind === "svg"
        ? createSvg({ id, parent: page.id, name: options.name, assetId: ref.id, ...box })
        : createImage({
            id,
            parent: page.id,
            name: options.name,
            assetId: ref.id,
            fit: "fill",
            ...box,
          });
    const applied = await this.editor.apply(
      (design) => {
        const parent = options.near ? (design.nodes[options.near]?.parent ?? page.id) : page.id;
        const siblings = (design.nodes[parent] as { children?: Id[] } | undefined)?.children ?? [];
        const index = options.near ? siblings.indexOf(options.near) + 1 : siblings.length;
        return makeTransaction(
          [
            { op: "asset", set: { [ref.id]: ref } },
            { op: "create", nodes: [{ ...node, parent }], parent, index: Math.max(0, index) },
          ],
          options.label,
          { source: "ai" },
        );
      },
      { label: options.label, select: [id] },
    );
    return applied ? id : null;
  }

  /** A mockup gets its own page sized to the photo, right after the current page. */
  async addMockupPage(result: GeneratedAssetView, scene: string): Promise<Id | null> {
    const ref = await this.refOf(result);
    const current = this.editor.currentPage();
    const width = result.width ?? ref.width ?? 1536;
    const height = result.height ?? ref.height ?? 1024;
    const pageId = newId();
    const imageId = newId();
    const label = "AI: Mockup";
    const applied = await this.editor.apply(
      (design) => {
        const order = (design.nodes.root as { children?: Id[] }).children ?? [];
        const at = current ? order.indexOf(current.id) + 1 : order.length;
        const page = addPage(design, {
          pageId,
          index: at,
          name: `Mockup · ${scene.slice(0, 40)}`,
          width,
          height,
          unit: "px",
          background: [{ type: "solid", color: "#000000" }],
        });
        const image: ImageNode = createImage({
          id: imageId,
          parent: pageId,
          name: "Mockup",
          role: "photo",
          assetId: ref.id,
          x: 0,
          y: 0,
          width,
          height,
          fit: "fill",
        });
        return makeTransaction(
          [
            { op: "asset", set: { [ref.id]: ref } },
            ...page.ops,
            { op: "create", nodes: [image], parent: pageId },
          ],
          label,
          { source: "ai" },
        );
      },
      { label, select: [imageId] },
    );
    if (!applied) return null;
    this.editor.setPage(pageId);
    return pageId;
  }

  /** Page that holds a node (for mockups of the selection's page). */
  pageOfNode(id: Id): Id | null {
    const design = this.editor.design;
    return (design && pageOf(design, id)?.id) ?? null;
  }
}

/** Directions offered by the expand picker, with arrow glyph positions for the preview. */
export const EXPAND_DIRECTIONS: readonly { id: OutpaintDirection; label: string }[] = [
  { id: "all", label: "All sides" },
  { id: "horizontal", label: "Left and right" },
  { id: "vertical", label: "Top and bottom" },
  { id: "left", label: "Left" },
  { id: "right", label: "Right" },
  { id: "up", label: "Top" },
  { id: "down", label: "Bottom" },
];
