import { Builder, decompose, getNode, worldTransform } from "@desyn/doc-ops";
import type { Design, Id, ImageNode, Op } from "@desyn/schema";
import { selectTool } from "../tools/select.ts";
import type { CanvasPointer, Gesture, Mode } from "../tools/types.ts";
import type { CanvasController } from "./controller.ts";
import { resizeCursor } from "./cursors.ts";
import { handleDirection, hitHandles } from "./handles.ts";
import {
  apply,
  clamp,
  IDENTITY,
  inv,
  type Matrix,
  mul,
  type Obb,
  type Point,
  type Rect,
  translation,
} from "./math.ts";
import type { Painter } from "./overlay/paint.ts";
import { type HandleKind, handleAnchor } from "./transform.ts";

/**
 * Crop mode for image layers (double click an image, or Enter). The whole source image is shown as a ghost
 * around the layer: drag inside to move the image within the frame, drag the frame handles to change what is
 * visible (the image stays put), drag the image corners to scale it. Enter, Escape or a click outside leaves.
 * Each drag is one undo step; the layer switches to `fit: "crop"` with a normalized `crop` rectangle.
 */

export interface CropState {
  /** Frame (the layer box) in layer-local coordinates: always (0, 0, w, h). */
  w: number;
  h: number;
  /** The whole image in layer-local coordinates. */
  image: Rect;
}

/** Normalized visible source rectangle of an image layer for its current fit. */
export function visibleCrop(
  node: ImageNode,
  sw: number,
  sh: number,
): { x: number; y: number; w: number; h: number } {
  if (node.fit === "crop" && node.crop && node.crop.w > 0 && node.crop.h > 0) {
    return { x: node.crop.x, y: node.crop.y, w: node.crop.w, h: node.crop.h };
  }
  if (node.fit === "fill" && sw > 0 && sh > 0 && node.width > 0 && node.height > 0) {
    const box = node.width / node.height;
    const src = sw / sh;
    if (src > box) {
      const w = box / src;
      return { x: (1 - w) / 2, y: 0, w, h: 1 };
    }
    const h = src / box;
    return { x: 0, y: (1 - h) / 2, w: 1, h };
  }
  return { x: 0, y: 0, w: 1, h: 1 };
}

/** The whole image in layer-local coordinates for a crop. */
export function imageRectFor(
  w: number,
  h: number,
  crop: { x: number; y: number; w: number; h: number },
): Rect {
  const iw = w / crop.w;
  const ih = h / crop.h;
  return { x: -crop.x * iw, y: -crop.y * ih, w: iw, h: ih };
}

/** Crop rectangle (normalized) of a frame `f` (layer-local) over the image rect. */
export function cropFor(f: Rect, image: Rect) {
  const r6 = (v: number) => Math.round(v * 1e6) / 1e6;
  return {
    x: r6((f.x - image.x) / image.w),
    y: r6((f.y - image.y) / image.h),
    w: r6(f.w / image.w),
    h: r6(f.h / image.h),
  };
}

/** Ops writing a frame (layer-local rect) and image rect back to the layer. */
export function cropOps(design: Design, id: Id, frame: Rect, image: Rect): Op[] {
  const node = getNode(design, id);
  if (node?.type !== "image") return [];
  const b = new Builder(design);
  const world = worldTransform(design, id);
  const parentWorld = node.parent ? worldTransform(design, node.parent) : IDENTITY;
  if (
    Math.abs(frame.x) > 1e-9 ||
    Math.abs(frame.y) > 1e-9 ||
    Math.abs(frame.w - node.width) > 1e-9 ||
    Math.abs(frame.h - node.height) > 1e-9
  ) {
    const next = mul(world, translation(frame.x, frame.y));
    b.place(id, decompose(mul(inv(parentWorld), next), frame.w, frame.h, node));
    b.update(id, {
      width: Math.round(frame.w * 1e4) / 1e4,
      height: Math.round(frame.h * 1e4) / 1e4,
    });
  }
  const shifted = { ...image, x: image.x - frame.x, y: image.y - frame.y };
  b.update(id, { fit: "crop", crop: cropFor({ x: 0, y: 0, w: frame.w, h: frame.h }, shifted) });
  b.refitGroups([id]);
  return b.ops;
}

const IMAGE_CORNER_HIT = 8;
const MIN_SIZE = 4;

type CropDrag =
  | { kind: "pan" }
  | { kind: "frame"; handle: HandleKind }
  | { kind: "image"; corner: HandleKind };

class CropMode implements Mode {
  readonly kind = "crop" as const;
  private world: Matrix = IDENTITY;
  private state: CropState | null = null;
  private img: HTMLImageElement | null = null;
  private imgAsset: Id | null = null;
  private live: { frame: Rect; image: Rect } | null = null;

  constructor(
    private readonly c: CanvasController,
    readonly nodeId: Id,
  ) {}

  /** Reads the layer; false when it is not a croppable image. */
  load(): boolean {
    const design = this.c.design;
    const node = design ? getNode(design, this.nodeId) : undefined;
    if (!design || node?.type !== "image") return false;
    const asset = design.assets[node.assetId];
    const sw = asset?.width ?? node.width;
    const sh = asset?.height ?? node.height;
    // Cropping starts from the covering crop for every other fit: a letterboxed ("fit") or tiled image
    // would otherwise be stretched to the layer box by the first crop edit.
    const crop = visibleCrop(node.fit === "crop" ? node : { ...node, fit: "fill" }, sw, sh);
    this.world = worldTransform(design, this.nodeId);
    this.state = {
      w: node.width,
      h: node.height,
      image: imageRectFor(node.width, node.height, crop),
    };
    if (asset && this.imgAsset !== asset.id) {
      this.imgAsset = asset.id;
      this.img = null;
      void this.loadImage(asset);
    }
    return true;
  }

  documentChanged(): void {
    if (this.live) return;
    if (!this.load()) void this.c.exitMode("api");
    else this.c.invalidate();
  }

  private async loadImage(asset: NonNullable<Design["assets"][string]>): Promise<void> {
    if (typeof Image === "undefined") return;
    const url = await this.c.editor.assets.urlFor(asset).catch(() => null);
    if (!url) return;
    const img = new Image();
    img.decoding = "async";
    img.src = url;
    try {
      await img.decode();
      if (this.imgAsset !== asset.id) return;
      this.img = img;
      this.c.invalidate();
    } catch {
      // Without pixels the image outline is still shown.
    }
  }

  private frameObb(frame?: Rect): Obb {
    const s = this.state as CropState;
    const f = frame ?? { x: 0, y: 0, w: s.w, h: s.h };
    return { m: mul(this.world, translation(f.x, f.y)), w: f.w, h: f.h };
  }

  private imageCorners(image: Rect): { corner: HandleKind; at: Point }[] {
    return (["top-left", "top-right", "bottom-right", "bottom-left"] as HandleKind[]).map(
      (corner) => {
        const [u, v] = handleAnchor(corner);
        return {
          corner,
          at: apply(this.world, { x: image.x + u * image.w, y: image.y + v * image.h }),
        };
      },
    );
  }

  private hit(p: Point): CropDrag | null {
    const s = this.state;
    if (!s) return null;
    const zoom = this.c.zoom;
    const h = hitHandles(this.frameObb(), zoom, p, { allowRotate: false });
    if (h?.type === "resize") return { kind: "frame", handle: h.handle };
    for (const ic of this.imageCorners(s.image)) {
      if (Math.hypot(ic.at.x - p.x, ic.at.y - p.y) * zoom <= IMAGE_CORNER_HIT)
        return { kind: "image", corner: ic.corner };
    }
    const q = apply(inv(this.world), p);
    const img = s.image;
    if (q.x >= img.x && q.y >= img.y && q.x <= img.x + img.w && q.y <= img.y + img.h)
      return { kind: "pan" };
    return null;
  }

  cursor(c: CanvasController): string {
    const e = c.lastPointer;
    if (!e) return "default";
    const h = this.hit(e.page);
    if (!h) return "default";
    if (h.kind === "pan") return "move";
    if (h.kind === "frame") return resizeCursor(handleDirection(this.frameObb(), h.handle));
    return resizeCursor(handleDirection({ m: this.world, w: 1, h: 1 }, h.corner));
  }

  async down(c: CanvasController, e: CanvasPointer): Promise<Gesture | null> {
    const s = this.state;
    if (!s) return null;
    const h = this.hit(e.page);
    if (!h) {
      await c.exitMode("click");
      return selectTool.down(c, e);
    }
    const design = c.design as Design;
    const startLocal = apply(inv(this.world), e.page);
    const frame0: Rect = { x: 0, y: 0, w: s.w, h: s.h };
    const image0 = { ...s.image };
    let moved = false;
    const update = (frame: Rect, image: Rect) => {
      moved = true;
      this.live = { frame, image };
      c.preview(cropOps(design, this.nodeId, frame, image), "Crop");
      c.invalidate();
    };
    return {
      hidesHover: true,
      cursor: this.cursor(c),
      move: (ev) => {
        const q = apply(inv(this.world), ev.page);
        const dx = q.x - startLocal.x;
        const dy = q.y - startLocal.y;
        if (h.kind === "pan") {
          // The image moves under the fixed frame, never uncovering it.
          const x = clamp(image0.x + dx, frame0.w - image0.w, 0);
          const y = clamp(image0.y + dy, frame0.h - image0.h, 0);
          update(frame0, { ...image0, x, y });
        } else if (h.kind === "frame") {
          const [u, v] = handleAnchor(h.handle);
          let x0 = frame0.x;
          let y0 = frame0.y;
          let x1 = frame0.x + frame0.w;
          let y1 = frame0.y + frame0.h;
          if (u === 0) x0 = clamp(x0 + dx, image0.x, x1 - MIN_SIZE);
          if (u === 1) x1 = clamp(x1 + dx, x0 + MIN_SIZE, image0.x + image0.w);
          if (v === 0) y0 = clamp(y0 + dy, image0.y, y1 - MIN_SIZE);
          if (v === 1) y1 = clamp(y1 + dy, y0 + MIN_SIZE, image0.y + image0.h);
          update({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, image0);
        } else {
          // Scale the image about its opposite corner, keeping its aspect and covering the frame.
          const [u, v] = handleAnchor(h.corner);
          const ax = image0.x + (1 - u) * image0.w;
          const ay = image0.y + (1 - v) * image0.h;
          const px = q.x;
          const py = q.y;
          const kx = Math.abs(px - ax) / image0.w;
          const ky = Math.abs(py - ay) / image0.h;
          let k = Math.max(kx, ky);
          // Never smaller than needed to cover the frame from the anchor.
          const needX =
            u === 1 ? (frame0.x + frame0.w - ax) / image0.w : (ax - frame0.x) / image0.w;
          const needY =
            v === 1 ? (frame0.y + frame0.h - ay) / image0.h : (ay - frame0.y) / image0.h;
          k = Math.max(k, needX, needY, 0.01);
          const w = image0.w * k;
          const hh = image0.h * k;
          update(frame0, { x: u === 1 ? ax : ax - w, y: v === 1 ? ay : ay - hh, w, h: hh });
        }
      },
      up: async () => {
        if (!moved) return;
        const live = this.live;
        const same = (a: Rect, b: Rect) =>
          Math.abs(a.x - b.x) < 1e-6 &&
          Math.abs(a.y - b.y) < 1e-6 &&
          Math.abs(a.w - b.w) < 1e-6 &&
          Math.abs(a.h - b.h) < 1e-6;
        if (live && same(live.frame, frame0) && same(live.image, image0)) {
          // Nothing changed (e.g. the image already exactly covers the frame).
          this.live = null;
          await c.cancelPreview();
          return;
        }
        await c.commit("Crop", { select: [this.nodeId] });
        this.live = null;
        this.load();
        c.invalidate();
      },
      cancel: async () => {
        this.live = null;
        await c.cancelPreview();
      },
    };
  }

  keyDown(c: CanvasController, e: KeyboardEvent): boolean {
    if (e.key === "Enter" || e.key === "Escape") {
      void c.exitMode("escape");
      return true;
    }
    return false;
  }

  draw(_c: CanvasController, p: Painter): void {
    const s = this.state;
    if (!s) return;
    const frame = this.live?.frame ?? { x: 0, y: 0, w: s.w, h: s.h };
    const image = this.live ? { ...this.live.image } : s.image;
    const ctx = p.ctx;
    const v = p.view;
    const z = v.zoom;
    const m = this.world;
    // Ghost of the whole image outside the frame.
    ctx.save();
    ctx.transform(m[0] * z, m[1] * z, m[2] * z, m[3] * z, (m[4] - v.x) * z, (m[5] - v.y) * z);
    ctx.beginPath();
    ctx.rect(image.x, image.y, image.w, image.h);
    ctx.rect(frame.x, frame.y, frame.w, frame.h);
    ctx.clip("evenodd");
    if (this.img) {
      ctx.globalAlpha = 0.42;
      ctx.drawImage(this.img, image.x, image.y, image.w, image.h);
      ctx.globalAlpha = 1;
    }
    ctx.fillStyle = p.theme.dark ? "rgba(10, 10, 10, 0.35)" : "rgba(255, 255, 255, 0.35)";
    ctx.fillRect(image.x, image.y, image.w, image.h);
    ctx.restore();
    p.strokeObb(
      { m: mul(m, translation(image.x, image.y)), w: image.w, h: image.h },
      p.theme.selection,
      1,
      [4, 3],
    );
    const fobb = this.frameObb(frame);
    p.strokeObb(fobb, p.theme.selection, 1.5);
    // Rule-of-thirds guides while cropping.
    for (const t of [1 / 3, 2 / 3]) {
      p.line(
        apply(fobb.m, { x: frame.w * t, y: 0 }),
        apply(fobb.m, { x: frame.w * t, y: frame.h }),
        "rgba(255,255,255,0.35)",
        1,
      );
      p.line(
        apply(fobb.m, { x: 0, y: frame.h * t }),
        apply(fobb.m, { x: frame.w, y: frame.h * t }),
        "rgba(255,255,255,0.35)",
        1,
      );
    }
    for (const h of [
      "top-left",
      "top",
      "top-right",
      "right",
      "bottom-right",
      "bottom",
      "bottom-left",
      "left",
    ] as HandleKind[]) {
      const [u, vv] = handleAnchor(h);
      p.squareHandle(
        apply(fobb.m, { x: u * frame.w, y: vv * frame.h }),
        Math.atan2(m[1], m[0]) * (180 / Math.PI),
        u === 0.5 || vv === 0.5 ? 7 : 8,
      );
    }
    for (const ic of this.imageCorners(image)) p.roundHandle(ic.at, { r: 4.5 });
  }

  exit(): void {
    if (this.c.design?.nodes[this.nodeId]) this.c.editor.select([this.nodeId]);
  }
}

/** Enters crop mode for an image layer. */
export async function startCrop(c: CanvasController, id: Id): Promise<void> {
  if (!c.canEdit) return;
  const mode = new CropMode(c, id);
  if (!mode.load()) return;
  c.editor.select([id]);
  await c.enterMode(mode);
}
