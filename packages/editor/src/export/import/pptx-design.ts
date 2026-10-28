import {
  type AssetRef,
  createEllipse,
  createGroup,
  createImage,
  createLine,
  createPage,
  createRect,
  createText,
  type Fill,
  type Id,
  type Node,
  newId,
  type Op,
  ROOT_ID,
  solid,
  type TextRun,
  type TextStyle,
} from "@desyn/schema";
import type { PptxBox, PptxDocument, PptxElement, PptxParagraph } from "./pptx.ts";

/** Converts a parsed presentation into pages appended to a design (one `create` op per slide). */

const PT_TO_PX = 96 / 72;
const DEFAULT_FONT = "Inter";

function rounded(n: number): number {
  return Math.round(n * 100) / 100;
}

function baseBox(b: PptxBox) {
  return {
    x: rounded(b.x),
    y: rounded(b.y),
    width: rounded(Math.max(0, b.w)),
    height: rounded(Math.max(0, b.h)),
    rotation: rounded(b.rotation),
    ...(b.flipH ? { flipX: true } : {}),
    ...(b.flipV ? { flipY: true } : {}),
  };
}

function runStyle(r: PptxParagraph["runs"][number]): Partial<TextStyle> {
  return {
    ...(r.sizePt ? { fontSize: rounded(r.sizePt * PT_TO_PX) } : {}),
    fontWeight: r.bold ? 700 : 400,
    fontStyle: r.italic ? "italic" : "normal",
    decoration: r.underline ? "underline" : "none",
    ...(r.color ? { fills: [solid(r.color.slice(0, 7))] } : {}),
    ...(r.font ? { fontFamily: r.font } : {}),
  };
}

function textNodes(el: Extract<PptxElement, { kind: "shape" }>, parent: Id): Node | null {
  const paragraphs = el.paragraphs.filter((p) => p.runs.length > 0 || el.paragraphs.length > 1);
  if (!paragraphs.some((p) => p.runs.some((r) => r.text.trim()))) return null;
  const first = paragraphs.find((p) => p.runs.length > 0)?.runs[0];
  const base: TextStyle = {
    fontFamily: first?.font || DEFAULT_FONT,
    fontWeight: first?.bold ? 700 : 400,
    fontStyle: first?.italic ? "italic" : "normal",
    fontSize: rounded((first?.sizePt ?? 18) * PT_TO_PX),
    fills: [solid((first?.color ?? "#000000").slice(0, 7))],
    letterSpacing: 0,
    textCase: "none",
    decoration: first?.underline ? "underline" : "none",
  };
  const runs: TextRun[] = [];
  paragraphs.forEach((p, i) => {
    for (const r of p.runs) {
      runs.push({ text: r.text, style: runStyle(r) });
    }
    if (i < paragraphs.length - 1) runs.push({ text: "\n" });
  });
  const [t, r, b, l] = el.insets;
  const box = baseBox(el.box);
  const align = paragraphs[0]?.align ?? "left";
  return createText({
    id: newId(),
    parent,
    name: el.name,
    ...box,
    x: rounded(box.x + l),
    y: rounded(box.y + t),
    width: rounded(Math.max(1, box.width - l - r)),
    height: rounded(Math.max(1, box.height - t - b)),
    runs,
    style: base,
    paragraph: {
      align,
      direction: "auto",
      lineHeight: { unit: "percent", value: 110 },
      spacing: 0,
      indent: 0,
      list: paragraphs.some((p) => p.bullet) ? "bullet" : "none",
    },
    autoResize: "none",
    verticalAlign: el.anchor,
  });
}

function convert(
  el: PptxElement,
  parent: Id,
  media: ReadonlyMap<string, AssetRef>,
  out: Node[],
): Id[] {
  switch (el.kind) {
    case "picture": {
      const ref = media.get(el.media);
      if (!ref) return [];
      const crop = el.crop;
      const node = createImage({
        id: newId(),
        parent,
        name: el.name,
        assetId: ref.id,
        ...baseBox(el.box),
        ...(crop && (crop.l || crop.t || crop.r || crop.b)
          ? {
              fit: "crop",
              crop: {
                x: rounded(crop.l),
                y: rounded(crop.t),
                w: rounded(Math.max(0.001, 1 - crop.l - crop.r)),
                h: rounded(Math.max(0.001, 1 - crop.t - crop.b)),
              },
            }
          : { fit: "fill" }),
        ...(el.alt ? { alt: el.alt } : {}),
      });
      out.push(node);
      return [node.id];
    }
    case "line": {
      const b = el.box;
      const dx = b.w * (b.flipH ? -1 : 1);
      const dy = b.h * (b.flipV ? -1 : 1);
      const length = Math.hypot(dx, dy);
      const angle = (Math.atan2(dy, dx) * 180) / Math.PI;
      const cx = b.x + b.w / 2;
      const cy = b.y + b.h / 2;
      const node = createLine({
        id: newId(),
        parent,
        name: el.name,
        x: rounded(cx - length / 2),
        y: rounded(cy),
        width: rounded(length),
        height: 0,
        rotation: rounded(angle + b.rotation),
        strokes: [
          {
            fills: [solid(el.stroke.color.slice(0, 7))],
            width: rounded(el.stroke.widthPx),
            align: "center",
            cap: "round",
            join: "round",
          },
        ],
      });
      out.push(node);
      return [node.id];
    }
    case "group": {
      const group = createGroup({ id: newId(), parent, name: el.name, ...baseBox(el.box) });
      out.push(group);
      const children: Id[] = [];
      for (const c of el.children) children.push(...convert(c, group.id, media, out));
      if (children.length === 0) {
        out.pop();
        return [];
      }
      (group as { children: Id[] }).children = children;
      return [group.id];
    }
    case "shape": {
      const ids: Id[] = [];
      if (el.fill || el.stroke) {
        const fills: Fill[] = el.fill ? [solid(el.fill.slice(0, 7), alphaOf(el.fill))] : [];
        const strokes = el.stroke
          ? [
              {
                fills: [solid(el.stroke.color.slice(0, 7))],
                width: rounded(el.stroke.widthPx),
                align: "inside" as const,
                cap: "butt" as const,
                join: "miter" as const,
              },
            ]
          : [];
        const box = baseBox(el.box);
        const shape =
          el.geometry === "ellipse"
            ? createEllipse({ id: newId(), parent, name: el.name, ...box, fills, strokes })
            : createRect({
                id: newId(),
                parent,
                name: el.name,
                ...box,
                fills,
                strokes,
                cornerRadius:
                  el.geometry === "roundRect"
                    ? rounded(Math.min(box.width, box.height) * 0.1667)
                    : 0,
              });
        out.push(shape);
        ids.push(shape.id);
      }
      const text = textNodes(el, parent);
      if (text) {
        out.push(text);
        ids.push(text.id);
      }
      return ids;
    }
  }
}

function alphaOf(color: string): number | undefined {
  if (color.length !== 9) return undefined;
  return Math.round((Number.parseInt(color.slice(7, 9), 16) / 255) * 1000) / 1000;
}

export interface PptxImport {
  ops: Op[];
  pageIds: Id[];
}

/**
 * Pages for the slides, appended after `startIndex` existing pages. `media` maps the presentation's media
 * paths to uploaded assets (pictures whose upload failed are left out).
 */
export function pptxToOps(
  doc: PptxDocument,
  media: ReadonlyMap<string, AssetRef>,
  startIndex: number,
): PptxImport {
  const ops: Op[] = [];
  const assets: Record<string, AssetRef> = {};
  for (const ref of media.values()) assets[ref.id] = ref;
  if (Object.keys(assets).length > 0) ops.push({ op: "asset", set: assets });
  const pageIds: Id[] = [];
  doc.slides.forEach((slide, i) => {
    const pageId = newId();
    const nodes: Node[] = [];
    const children: Id[] = [];
    const bgRef = slide.backgroundMedia ? media.get(slide.backgroundMedia) : undefined;
    for (const el of slide.elements) children.push(...convert(el, pageId, media, nodes));
    const background: Fill[] = bgRef
      ? [{ type: "image", assetId: bgRef.id, mode: "fill" }]
      : [solid((slide.background ?? "#ffffff").slice(0, 7))];
    const page = createPage({
      id: pageId,
      parent: ROOT_ID,
      name: slide.name,
      width: doc.width,
      height: doc.height,
      background,
      children,
      ...(slide.notes ? { notes: slide.notes } : {}),
    });
    ops.push({ op: "create", nodes: [page, ...nodes], parent: ROOT_ID, index: startIndex + i });
    pageIds.push(pageId);
  });
  return { ops, pageIds };
}
