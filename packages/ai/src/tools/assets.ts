// Asset tools: generate and edit media through the Media layer, upload results as design assets and place them
// as real layers (images, inline SVG, editable vector paths).
import { addPage, getNode, replaceImage, scalePath } from "@desyn/doc-ops";
import {
  type AssetRef,
  createGroup,
  createImage,
  createPath,
  createSvg,
  type Id,
  type ImageNode,
  type Node,
  newId,
  type Op,
} from "@desyn/schema";
import { z } from "zod";
import { coverCrop } from "../design/crop";
import { Canvas, encodePng } from "../design/raster";
import type { AssetUploadMeta } from "../host";
import type { MediaResult } from "../media/types";
import { imageSize, utf8 } from "../util/bytes";
import { assertContainer, currentPage } from "./build";
import { commit } from "./commit";
import { designTool } from "./define";
import { ColorInput, IdInput, type Placement, PlacementInput } from "./schemas";
import { type ToolContext, ToolInputError } from "./types";

const INLINE_SVG_LIMIT = 60 * 1024;

function requireMedia(ctx: ToolContext) {
  if (!ctx.media)
    throw new ToolInputError(
      "Media generation is not available in this run.",
      "Continue with shapes, text and existing assets.",
    );
  return ctx.media;
}

export async function uploadResult(
  ctx: ToolContext,
  result: MediaResult,
  meta: AssetUploadMeta,
): Promise<AssetRef> {
  if (!result.bytes) throw new ToolInputError("The provider returned no file to upload.");
  return ctx.host.assets.upload(result.bytes, result.mime, {
    source: "ai",
    ai: {
      provider: result.provider,
      model: result.model,
      prompt: result.prompt.slice(0, 2000),
      ...(result.seed !== undefined ? { seed: result.seed } : {}),
    },
    ...(result.width ? { width: result.width } : {}),
    ...(result.height ? { height: result.height } : {}),
    ...meta,
  });
}

function imageNodeOf(ctx: ToolContext, id: Id): ImageNode {
  const node = getNode(ctx.host.getDesign(), id);
  if (!node) throw new ToolInputError(`Element "${id}" does not exist.`);
  if (node.type !== "image")
    throw new ToolInputError(`Element "${id}" is a ${node.type}, not an image.`);
  return node;
}

async function readImage(ctx: ToolContext, node: ImageNode) {
  const asset = ctx.host.getDesign().assets[node.assetId];
  const bytes = await ctx.host.assets.read(node.assetId);
  const size =
    imageSize(bytes.bytes, bytes.mime) ??
    (asset?.width && asset.height ? { width: asset.width, height: asset.height } : undefined);
  return { ...bytes, width: size?.width, height: size?.height };
}

/** Aspect ratio (w/h) a placement asks for, if any. */
function placementAspect(ctx: ToolContext, p: Placement | undefined): number | undefined {
  if (!p) return undefined;
  if (p.targetId) {
    const n = getNode(ctx.host.getDesign(), p.targetId);
    if (n && n.width > 0 && n.height > 0) return n.width / n.height;
  }
  if (p.width && p.height) return p.width / p.height;
  return undefined;
}

/** Output pixel size for a generation: long edge 1536 (2048 for print pages). */
function outputSize(
  ctx: ToolContext,
  aspect: number,
  requested?: { width?: number; height?: number },
) {
  if (requested?.width && requested.height)
    return { width: requested.width, height: requested.height };
  const long = currentPage(ctx.host).unit === "px" ? 1536 : 2048;
  return aspect >= 1
    ? { width: long, height: Math.round(long / aspect) }
    : { width: Math.round(long * aspect), height: long };
}

/** Ops that put an asset on the canvas: replace a target's image or create a new image/svg node. */
export function placementOps(
  ctx: ToolContext,
  asset: AssetRef,
  placement: Placement | undefined,
  options: { svgMarkup?: string; defaultName: string; role?: string; alt?: string },
): { ops: Op[]; nodeId: Id } {
  const design = ctx.host.getDesign();
  const assetOp: Op = { op: "asset", set: { [asset.id]: asset } };
  if (placement?.targetId) {
    const target = getNode(design, placement.targetId);
    if (!target) throw new ToolInputError(`targetId "${placement.targetId}" does not exist.`);
    if (target.type === "image") {
      const tx = replaceImage(design, target.id, asset.id, { asset });
      const ops = [...tx.ops];
      ops.push({
        op: "update",
        id: target.id,
        set: {
          crop: coverCrop(asset.width, asset.height, target.width, target.height),
          fit: "crop",
        },
      });
      if (options.alt) ops.push({ op: "update", id: target.id, set: { alt: options.alt } });
      return { ops, nodeId: target.id };
    }
    if (target.type === "svg") {
      const set: Record<string, unknown> = options.svgMarkup
        ? { markup: options.svgMarkup }
        : { assetId: asset.id };
      return {
        ops: [
          assetOp,
          { op: "update", id: target.id, set, unset: options.svgMarkup ? ["assetId"] : ["markup"] },
        ],
        nodeId: target.id,
      };
    }
    if ("fills" in target) {
      const fills = [
        ...target.fills.filter((f) => f.type !== "image"),
        { type: "image" as const, assetId: asset.id, mode: "fill" as const },
      ];
      return { ops: [assetOp, { op: "update", id: target.id, set: { fills } }], nodeId: target.id };
    }
    throw new ToolInputError(`Cannot place an image into a ${target.type}.`);
  }
  const page = currentPage(ctx.host);
  const parentId = placement?.parentId ?? page.id;
  const parent = assertContainer(design, parentId);
  const pw = parent.type === "page" ? page.width : parent.width;
  const ph = parent.type === "page" ? page.height : parent.height;
  const aspect = asset.width && asset.height ? asset.width / asset.height : 1;
  let width = placement?.width ?? Math.round(Math.min(pw * 0.6, ph * 0.6 * aspect));
  let height = placement?.height ?? Math.round(width / aspect);
  if (!placement?.width && placement?.height) width = Math.round(height * aspect);
  if (placement?.width && !placement.height) height = Math.round(width / aspect);
  const x = placement?.x ?? Math.round((pw - width) / 2);
  const y = placement?.y ?? Math.round((ph - height) / 2);
  const common = {
    id: newId(),
    name: placement?.name ?? options.defaultName,
    parent: parentId,
    x,
    y,
    width,
    height,
    ...((placement?.role ?? options.role) ? { role: placement?.role ?? options.role } : {}),
    ...((placement?.alt ?? options.alt) ? { alt: placement?.alt ?? options.alt } : {}),
  };
  const node: Node = options.svgMarkup
    ? createSvg({ ...common, markup: options.svgMarkup })
    : asset.kind === "svg"
      ? createSvg({ ...common, assetId: asset.id })
      : createImage({
          ...common,
          assetId: asset.id,
          fit: placement?.fit ?? "crop",
          ...(placement?.cornerRadius !== undefined
            ? { cornerRadius: placement.cornerRadius }
            : {}),
          crop: coverCrop(asset.width, asset.height, width, height),
        });
  const create: Op = { op: "create", nodes: [node], parent: parentId };
  if (placement?.index !== undefined) create.index = placement.index;
  return { ops: [assetOp, create], nodeId: node.id };
}

/** White-on-black PNG mask of a normalized region (rect or ellipse) at the image's pixel size. */
export function regionMask(
  width: number,
  height: number,
  region: { x: number; y: number; width: number; height: number },
  shape: "rect" | "ellipse",
  feather = 0,
): Uint8Array {
  const canvas = new Canvas(width, height, { r: 0, g: 0, b: 0, a: 1 });
  const rx = region.x * width;
  const ry = region.y * height;
  const rw = region.width * width;
  const rh = region.height * height;
  const white = { r: 255, g: 255, b: 255, a: 1 };
  const grow = feather * Math.min(width, height);
  if (shape === "ellipse")
    canvas.fillEllipse(rx - grow, ry - grow, rw + 2 * grow, rh + 2 * grow, white);
  else canvas.fillRect(rx - grow, ry - grow, rw + 2 * grow, rh + 2 * grow, white);
  return encodePng(width, height, canvas.data);
}

const RegionInput = z
  .object({
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    width: z.number().min(0.01).max(1),
    height: z.number().min(0.01).max(1),
  })
  .describe("region of the source image, normalized 0..1 (x,y = top-left)");

export function assetTools(ctx: ToolContext) {
  return {
    generate_image: designTool(ctx, {
      description:
        "Generate a photo or illustration and place it (new image layer, or replace an existing image via placement.targetId). Use withText only when the image itself must contain legible words; normal copy belongs in text layers. vector=true returns flat SVG art.",
      inputSchema: z.object({
        prompt: z
          .string()
          .min(3)
          .describe(
            "subject, composition, lighting, mood, style; describe the empty space needed for text",
          ),
        style: z
          .enum(["photo", "illustration", "3d", "flat", "painting", "line-art", "pixel"])
          .optional(),
        withText: z.boolean().optional(),
        vector: z.boolean().optional(),
        negativePrompt: z.string().optional(),
        palette: z.array(ColorInput).max(8).optional(),
        count: z
          .number()
          .int()
          .min(1)
          .max(4)
          .default(1)
          .describe("alternatives; the first is placed, others are added as assets"),
        seed: z.number().int().optional(),
        placement: PlacementInput.optional(),
      }),
      async execute(input) {
        const media = requireMedia(ctx);
        const aspect = placementAspect(ctx, input.placement) ?? 1;
        const size = outputSize(ctx, aspect);
        ctx.emit({
          type: "progress",
          runId: ctx.run.runId,
          label: "Generating image",
          detail: input.prompt.slice(0, 80),
        });
        const results = await media.generateImage({
          prompt: input.prompt,
          ...size,
          n: input.count,
          ...(input.style ? { style: input.style } : {}),
          ...(input.withText ? { withText: true } : {}),
          ...(input.vector ? { vector: true } : {}),
          ...(input.negativePrompt ? { negativePrompt: input.negativePrompt } : {}),
          ...(input.palette ? { palette: input.palette } : {}),
          ...(input.seed !== undefined ? { seed: input.seed } : {}),
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        });
        const assets = await Promise.all(
          results.map((r, i) =>
            uploadResult(ctx, r, {
              name: `${input.prompt.slice(0, 40)}${results.length > 1 ? ` #${i + 1}` : ""}`,
            }),
          ),
        );
        const first = assets[0] as AssetRef;
        const firstResult = results[0] as MediaResult;
        const markup =
          firstResult.mime === "image/svg+xml" &&
          firstResult.bytes &&
          firstResult.bytes.length < INLINE_SVG_LIMIT
            ? utf8(firstResult.bytes)
            : undefined;
        const { ops, nodeId } = placementOps(ctx, first, input.placement, {
          defaultName: input.vector
            ? "Illustration"
            : input.style === "photo" || !input.style
              ? "Photo"
              : "Image",
          role:
            input.vector || input.style === "illustration" || input.style === "flat"
              ? "illustration"
              : "photo",
          alt: input.placement?.alt ?? input.prompt.slice(0, 200),
          ...(markup ? { svgMarkup: markup } : {}),
        });
        const extraAssets: Op[] = assets.slice(1).map((a) => ({ op: "asset", set: { [a.id]: a } }));
        await commit(ctx, [...ops, ...extraAssets], "Generate image");
        return {
          ok: true,
          summary: `Generated ${results.length} image(s) with ${firstResult.model}; placed as ${nodeId}.`,
          nodeId,
          assetIds: assets.map((a) => a.id),
          size: `${first.width ?? size.width}x${first.height ?? size.height}`,
          credits: results.reduce((s, r) => s + r.costCredits, 0),
        };
      },
    }),

    generate_svg: designTool(ctx, {
      description:
        "Draw a vector icon, illustration, pattern, badge, divider or logo mark as clean SVG (palette-constrained; brand colors by default) and place it.",
      inputSchema: z.object({
        prompt: z.string().min(3),
        kind: z
          .enum(["icon", "illustration", "pattern", "logo", "badge", "decoration", "divider"])
          .default("illustration"),
        palette: z.array(ColorInput).max(8).optional(),
        strokeOnly: z.boolean().optional(),
        placement: PlacementInput.optional(),
      }),
      async execute(input) {
        const media = requireMedia(ctx);
        const palette = input.palette ?? ctx.host.brand?.colors.map((c) => c.value.slice(0, 7));
        const aspect = placementAspect(ctx, input.placement);
        const base = input.kind === "icon" ? 24 : 512;
        const dims = aspect
          ? aspect >= 1
            ? { width: base, height: Math.round(base / aspect) }
            : { width: Math.round(base * aspect), height: base }
          : input.kind === "divider"
            ? { width: 400, height: 40 }
            : { width: base, height: base };
        ctx.emit({
          type: "progress",
          runId: ctx.run.runId,
          label: "Drawing SVG",
          detail: input.prompt.slice(0, 80),
        });
        const svg = await media.generateSvg({
          prompt: input.prompt,
          kind: input.kind,
          ...dims,
          ...(palette?.length ? { palette } : {}),
          ...(input.strokeOnly ? { strokeOnly: true } : {}),
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        });
        const asset = await uploadResult(ctx, svg, {
          name: input.prompt.slice(0, 40),
          kind: "svg",
        });
        const { ops, nodeId } = placementOps(ctx, asset, input.placement, {
          defaultName:
            input.kind === "icon" ? "Icon" : input.kind === "logo" ? "Logo mark" : "Vector",
          role:
            input.kind === "icon"
              ? "icon"
              : input.kind === "pattern"
                ? "pattern"
                : input.kind === "decoration" || input.kind === "divider"
                  ? "decoration"
                  : input.kind === "logo"
                    ? "brand-mark"
                    : "illustration",
          alt: input.prompt.slice(0, 200),
          ...(svg.svg.length < INLINE_SVG_LIMIT ? { svgMarkup: svg.svg } : {}),
        });
        await commit(ctx, ops, "Generate SVG");
        return {
          ok: true,
          summary: `Drew ${input.kind} (${svg.colors.length} colors, ${svg.repairs} repair rounds); placed as ${nodeId}.`,
          nodeId,
          assetId: asset.id,
          colors: svg.colors,
        };
      },
    }),

    remove_background: designTool(ctx, {
      description:
        "Remove the background of an image layer (subject cut-out with transparency); the layer keeps its position and crop.",
      inputSchema: z.object({ id: IdInput }),
      async execute(input) {
        const media = requireMedia(ctx);
        const node = imageNodeOf(ctx, input.id);
        const src = await readImage(ctx, node);
        const result = await media.removeBackground({
          image: { bytes: src.bytes, mime: src.mime },
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        });
        const asset = await uploadResult(ctx, result, { name: `${node.name} (cut out)` });
        const tx = replaceImage(ctx.host.getDesign(), node.id, asset.id, {
          asset,
          resetCrop: false,
        });
        await commit(ctx, tx.ops, "Remove background");
        return {
          ok: true,
          summary: `Removed the background of "${node.name}".`,
          assetId: asset.id,
        };
      },
    }),

    inpaint: designTool(ctx, {
      description:
        "Replace a region of an image with generated content (remove an object, change a detail). Region is normalized to the source image.",
      inputSchema: z.object({
        id: IdInput,
        prompt: z
          .string()
          .min(2)
          .describe('what should appear in the region, e.g. "empty wooden table surface"'),
        region: RegionInput,
        shape: z.enum(["rect", "ellipse"]).default("rect"),
        feather: z.number().min(0).max(0.1).default(0.01),
      }),
      async execute(input) {
        const media = requireMedia(ctx);
        const node = imageNodeOf(ctx, input.id);
        const src = await readImage(ctx, node);
        if (!src.width || !src.height) throw new ToolInputError("Could not read the image size.");
        const mask = regionMask(src.width, src.height, input.region, input.shape, input.feather);
        const result = await media.inpaint({
          image: { bytes: src.bytes, mime: src.mime },
          mask: { bytes: mask, mime: "image/png" },
          prompt: input.prompt,
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        });
        const asset = await uploadResult(ctx, result, { name: `${node.name} (edited)` });
        const tx = replaceImage(ctx.host.getDesign(), node.id, asset.id, {
          asset,
          resetCrop: false,
        });
        await commit(ctx, tx.ops, "Inpaint image");
        return { ok: true, summary: `Inpainted "${node.name}".`, assetId: asset.id };
      },
    }),

    outpaint: designTool(ctx, {
      description:
        "Expand an image beyond its edges to a new aspect ratio or size (e.g. turn a square photo into a 16:9 background). The layer grows so existing content keeps its size.",
      inputSchema: z.object({
        id: IdInput,
        aspectRatio: z
          .string()
          .regex(/^\d+(\.\d+)?:\d+(\.\d+)?$/)
          .optional()
          .describe('e.g. "16:9"'),
        target: z
          .object({ width: z.number().positive(), height: z.number().positive() })
          .optional()
          .describe("target pixel size"),
        direction: z
          .enum(["left", "right", "up", "down", "horizontal", "vertical", "all"])
          .default("all"),
        prompt: z.string().optional().describe("what the extended area should contain"),
        resizeLayer: z.boolean().default(true),
      }),
      async execute(input) {
        const media = requireMedia(ctx);
        const node = imageNodeOf(ctx, input.id);
        const src = await readImage(ctx, node);
        if (!src.width || !src.height) throw new ToolInputError("Could not read the image size.");
        let target = input.target;
        if (!target && input.aspectRatio) {
          const [a, b] = input.aspectRatio.split(":").map(Number) as [number, number];
          const ratio = a / b;
          target =
            ratio >= src.width / src.height
              ? { width: Math.round(src.height * ratio), height: src.height }
              : { width: src.width, height: Math.round(src.width / ratio) };
        }
        if (!target) throw new ToolInputError("Give aspectRatio or target.");
        const result = await media.outpaint({
          image: { bytes: src.bytes, mime: src.mime },
          sourceWidth: src.width,
          sourceHeight: src.height,
          target,
          direction: input.direction,
          ...(input.prompt ? { prompt: input.prompt } : {}),
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        });
        const asset = await uploadResult(ctx, result, { name: `${node.name} (expanded)` });
        const design = ctx.host.getDesign();
        const ops: Op[] = [...replaceImage(design, node.id, asset.id, { asset }).ops];
        if (input.resizeLayer && asset.width && asset.height) {
          // Keep the original content's on-canvas scale: px per source pixel stays the same.
          const crop = node.crop ?? { x: 0, y: 0, w: 1, h: 1 };
          const pxPerSrc = node.width / (crop.w * src.width);
          const width = Math.round(asset.width * pxPerSrc);
          const height = Math.round(asset.height * pxPerSrc);
          const dx = (width - node.width) / 2;
          const dy = (height - node.height) / 2;
          const shiftX =
            input.direction === "left" ? width - node.width : input.direction === "right" ? 0 : dx;
          const shiftY =
            input.direction === "up" ? height - node.height : input.direction === "down" ? 0 : dy;
          ops.push({
            op: "update",
            id: node.id,
            set: {
              width,
              height,
              x: Math.round((node.x - shiftX) * 100) / 100,
              y: Math.round((node.y - shiftY) * 100) / 100,
            },
          });
        }
        await commit(ctx, ops, "Expand image");
        return {
          ok: true,
          summary: `Expanded "${node.name}" to ${asset.width}x${asset.height}.`,
          assetId: asset.id,
        };
      },
    }),

    upscale: designTool(ctx, {
      description:
        "Upscale an image layer's asset (2x or 4x) with detail recovery; use when describe flags image-low-res.",
      inputSchema: z.object({
        id: IdInput,
        factor: z.union([z.literal(2), z.literal(4)]).default(2),
      }),
      async execute(input) {
        const media = requireMedia(ctx);
        const node = imageNodeOf(ctx, input.id);
        const src = await readImage(ctx, node);
        const result = await media.upscale({
          image: { bytes: src.bytes, mime: src.mime },
          factor: input.factor,
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        });
        const asset = await uploadResult(ctx, result, { name: `${node.name} (${input.factor}x)` });
        const tx = replaceImage(ctx.host.getDesign(), node.id, asset.id, {
          asset,
          resetCrop: false,
        });
        await commit(ctx, tx.ops, "Upscale image");
        return {
          ok: true,
          summary: `Upscaled "${node.name}" to ${asset.width}x${asset.height}.`,
          assetId: asset.id,
        };
      },
    }),

    mockup: designTool(ctx, {
      description:
        "Render the current page and place it into a realistic scene (device screen, poster on a wall, packaging, business card on a desk). Adds a new page with the mockup unless a placement is given.",
      inputSchema: z.object({
        scene: z.string().min(3),
        pageId: IdInput.optional().describe("page to mock up (default current)"),
        placement: PlacementInput.optional(),
      }),
      async execute(input) {
        const media = requireMedia(ctx);
        const pageId = input.pageId ?? ctx.host.page;
        const render = await ctx.host.render({ ...(pageId ? { pageId } : {}), maxSize: 1536 });
        const result = await media.mockup({
          design: { bytes: render.bytes, mime: render.mime },
          scene: input.scene,
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        });
        const asset = await uploadResult(ctx, result, {
          name: `Mockup: ${input.scene.slice(0, 40)}`,
        });
        if (input.placement) {
          const { ops, nodeId } = placementOps(ctx, asset, input.placement, {
            defaultName: "Mockup",
            role: "photo",
            alt: input.scene,
          });
          await commit(ctx, ops, "Mockup");
          return { ok: true, summary: `Placed mockup as ${nodeId}.`, nodeId, assetId: asset.id };
        }
        const design = ctx.host.getDesign();
        const width = 1600;
        const height = Math.round(width / ((asset.width ?? 4) / (asset.height ?? 3)));
        const newPageId = newId();
        const addOps = addPage(design, { pageId: newPageId, name: "Mockup", width, height }).ops;
        const image = createImage({
          id: newId(),
          name: "Mockup",
          role: "photo",
          alt: input.scene,
          parent: newPageId,
          x: 0,
          y: 0,
          width,
          height,
          assetId: asset.id,
          fit: "crop",
          crop: coverCrop(asset.width, asset.height, width, height),
        });
        await commit(
          ctx,
          [
            ...addOps,
            { op: "asset", set: { [asset.id]: asset } },
            { op: "create", nodes: [image], parent: newPageId },
          ],
          "Mockup",
        );
        return {
          ok: true,
          summary: `Added mockup page ${newPageId}.`,
          pageId: newPageId,
          assetId: asset.id,
        };
      },
    }),

    trace_to_vector: designTool(ctx, {
      description:
        "Convert a raster image layer (logo, icon, flat illustration) into editable vector shapes: one path per color, grouped, placed exactly over the original.",
      inputSchema: z.object({
        id: IdInput,
        colors: z.number().int().min(2).max(16).optional(),
        detail: z.enum(["low", "medium", "high"]).optional(),
        replace: z.boolean().default(true).describe("delete the raster layer after tracing"),
      }),
      async execute(input) {
        const media = requireMedia(ctx);
        const node = imageNodeOf(ctx, input.id);
        const src = await readImage(ctx, node);
        const traced = await media.trace({
          image: { bytes: src.bytes, mime: src.mime },
          ...(input.colors ? { colors: input.colors } : {}),
          ...(input.detail ? { detail: input.detail } : {}),
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        });
        const design = ctx.host.getDesign();
        const parent = node.parent as Id;
        const siblings = (getNode(design, parent) as { children: Id[] }).children;
        const index = siblings.indexOf(node.id) + 1;
        const ops: Op[] = [];
        let resultId: Id;
        if (traced.layers && traced.layers.length > 0 && traced.width && traced.height) {
          const sx = node.width / traced.width;
          const sy = node.height / traced.height;
          const group = createGroup({
            id: newId(),
            name: `${node.name} (vector)`,
            role: node.role ?? "illustration",
            parent,
            x: node.x,
            y: node.y,
            width: node.width,
            height: node.height,
            rotation: node.rotation,
          });
          const paths = traced.layers.map((layer, i) =>
            createPath({
              id: newId(),
              name: `Color ${i + 1} ${layer.color}`,
              parent: group.id,
              x: 0,
              y: 0,
              width: node.width,
              height: node.height,
              fills: [{ type: "solid", color: layer.color }],
              paths: [{ d: scalePath(layer.d, sx, sy), fillRule: "evenodd" }],
            }),
          );
          group.children = paths.map((p) => p.id);
          ops.push({ op: "create", nodes: [group, ...paths], parent, index });
          resultId = group.id;
        } else {
          const asset = await uploadResult(ctx, traced, {
            name: `${node.name} (vector)`,
            kind: "svg",
          });
          const svg = createSvg({
            id: newId(),
            name: `${node.name} (vector)`,
            role: node.role ?? "illustration",
            parent,
            x: node.x,
            y: node.y,
            width: node.width,
            height: node.height,
            rotation: node.rotation,
            ...(traced.svg.length < INLINE_SVG_LIMIT
              ? { markup: traced.svg }
              : { assetId: asset.id }),
          });
          ops.push(
            { op: "asset", set: { [asset.id]: asset } },
            { op: "create", nodes: [svg], parent, index },
          );
          resultId = svg.id;
        }
        if (input.replace) ops.push({ op: "delete", id: node.id });
        await commit(ctx, ops, "Trace to vector");
        return {
          ok: true,
          summary: `Traced "${node.name}" into ${traced.layers?.length ?? traced.colors.length} color layer(s) as ${resultId}.`,
          nodeId: resultId,
          colors: traced.colors,
        };
      },
    }),
  };
}
