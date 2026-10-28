// Converts friendly tool inputs into exact document-model nodes and property patches, fills in sensible defaults
// (role-aware type sizes, readable text colors, brand fonts) and computes derived geometry the TS applier does not
// (text boxes, auto-layout positions, group bounds) so every host persists consistent boxes.

import { getNode, pageOf, pages } from "@desyn/doc-ops";
import {
  type AutoLayout,
  type Color,
  createChart,
  createEllipse,
  createFrame,
  createGroup,
  createImage,
  createLine,
  createPath,
  createPolygon,
  createQr,
  createRect,
  createStar,
  createSvg,
  createTable,
  createText,
  DEFAULT_CHART_PALETTE,
  type Design,
  defaultParagraph,
  defaultStroke,
  defaultTextStyle,
  type Effect,
  type Fill,
  type Id,
  isContainerType,
  type Node,
  newId,
  type PageNode,
  type ParagraphStyle,
  readableTextColor,
  type Stroke,
  type TextNode,
  type TextRun,
  type TextStyle,
} from "@desyn/schema";
import { coverCrop } from "../design/crop";
import { fillColor } from "../design/paint";
import type { BrandKit, DocHost } from "../host";
import { sanitizeSvg } from "../media/svg";
import type { ElementSpec, StyleSpec } from "./schemas";
import { ToolInputError } from "./types";

type FillLike = NonNullable<StyleSpec["fill"]>;

export function toFill(input: FillLike): Fill | null {
  if (input === "none") return null;
  if (typeof input === "string") return { type: "solid", color: input };
  switch (input.type) {
    case "solid":
      return input.opacity !== undefined
        ? { type: "solid", color: input.color, opacity: input.opacity }
        : { type: "solid", color: input.color };
    case "linear":
      return {
        type: "linear",
        angle: input.angle,
        stops: input.stops,
        ...(input.opacity !== undefined ? { opacity: input.opacity } : {}),
      };
    case "radial": {
      const r = input.r ?? 0.5;
      return {
        type: "radial",
        cx: input.cx ?? 0.5,
        cy: input.cy ?? 0.5,
        rx: r,
        ry: r,
        stops: input.stops,
        ...(input.opacity !== undefined ? { opacity: input.opacity } : {}),
      };
    }
    case "image":
      return {
        type: "image",
        assetId: input.assetId,
        mode: input.mode ?? "fill",
        ...(input.opacity !== undefined ? { opacity: input.opacity } : {}),
      };
  }
}

export function toFills(spec: Pick<StyleSpec, "fill" | "fills">): Fill[] | undefined {
  if (spec.fills) return spec.fills.map(toFill).filter((f): f is Fill => f !== null);
  if (spec.fill !== undefined) {
    const f = toFill(spec.fill);
    return f ? [f] : [];
  }
  return undefined;
}

export function toStroke(stroke: NonNullable<StyleSpec["stroke"]>): Stroke[] {
  if (stroke === "none") return [];
  return [
    defaultStroke({
      fills: [{ type: "solid", color: stroke.color }],
      width: stroke.width,
      align: stroke.align ?? "inside",
      ...(stroke.dash ? { dash: stroke.dash } : {}),
    }),
  ];
}

export function toEffects(
  spec: Pick<StyleSpec, "shadow" | "blur">,
  current: Effect[] = [],
): Effect[] | undefined {
  if (spec.shadow === undefined && spec.blur === undefined) return undefined;
  let effects = [...current];
  if (spec.shadow !== undefined) {
    effects = effects.filter((e) => e.type !== "dropShadow");
    if (spec.shadow !== "none") {
      effects.push({
        type: "dropShadow",
        x: spec.shadow.x,
        y: spec.shadow.y,
        blur: spec.shadow.blur,
        spread: spec.shadow.spread,
        color: spec.shadow.color,
      });
    }
  }
  if (spec.blur !== undefined) {
    effects = effects.filter((e) => e.type !== "layerBlur");
    if (spec.blur > 0) effects.push({ type: "layerBlur", radius: spec.blur });
  }
  return effects;
}

export function toLayout(layout: NonNullable<StyleSpec["layout"]>): AutoLayout | null {
  if (layout === "none") return null;
  const p = layout.padding;
  const padding: [number, number, number, number] =
    typeof p === "number" ? [p, p, p, p] : [p[0] ?? 0, p[1] ?? 0, p[2] ?? 0, p[3] ?? 0];
  const out: AutoLayout = {
    mode: layout.mode,
    gap: layout.gap,
    padding,
    mainAlign: layout.mainAlign,
    crossAlign: layout.crossAlign,
  };
  if (layout.rowGap !== undefined) out.rowGap = layout.rowGap;
  if (layout.wrap !== undefined) out.wrap = layout.wrap;
  if (layout.columns !== undefined) out.columns = layout.columns;
  return out;
}

// Defaults ---------------------------------------------------------------------------------------------------------

const HEADING_ROLES = new Set(["headline", "subhead", "stat", "slide-title", "price", "quote"]);

/** Font size as a fraction of the page's short side, by role. */
const ROLE_SIZE: Record<string, number> = {
  headline: 0.085,
  "slide-title": 0.06,
  subhead: 0.042,
  stat: 0.11,
  price: 0.06,
  quote: 0.05,
  body: 0.028,
  "slide-body": 0.032,
  caption: 0.02,
  eyebrow: 0.02,
  cta: 0.028,
  button: 0.026,
  "stat-label": 0.022,
  date: 0.024,
  location: 0.024,
  contact: 0.02,
  url: 0.02,
  author: 0.022,
  badge: 0.02,
  footer: 0.018,
};

const ROLE_WEIGHT: Record<string, number> = {
  headline: 700,
  subhead: 500,
  stat: 700,
  cta: 600,
  button: 600,
  price: 700,
  eyebrow: 600,
  "slide-title": 700,
};
const ROLE_LINE_HEIGHT: Record<string, number> = {
  headline: 1.05,
  "slide-title": 1.1,
  stat: 1,
  subhead: 1.2,
  quote: 1.25,
  price: 1,
};

export interface BuildContext {
  design: Design;
  page: PageNode;
  brand?: BrandKit;
  /** Nodes created earlier in the same call (not yet in the design). */
  pending?: Map<Id, Node>;
}

function lookup(ctx: BuildContext, id: Id): Node | undefined {
  return ctx.pending?.get(id) ?? getNode(ctx.design, id);
}

export function brandFont(
  brand: BrandKit | undefined,
  role: "heading" | "body",
): string | undefined {
  if (!brand) return undefined;
  return (
    brand.fonts.find((f) => f.role === role)?.family ??
    (role === "body" ? (brand.fonts[1]?.family ?? brand.fonts[0]?.family) : brand.fonts[0]?.family)
  );
}

/** Solid color behind a new element: its frame parent's fill, else the page background. */
function backdropColor(ctx: BuildContext, parentId: Id): Color {
  let current: Node | undefined = lookup(ctx, parentId);
  while (current && current.type !== "page") {
    if ("fills" in current) {
      const c = fillColor(current.fills, ctx.design);
      if (c) return c.slice(0, 7);
    }
    current = current.parent ? lookup(ctx, current.parent) : undefined;
  }
  return fillColor(ctx.page.background, ctx.design)?.slice(0, 7) ?? "#ffffff";
}

function shortSide(page: PageNode): number {
  return Math.min(page.width, page.height);
}

export function defaultFontSize(role: string | undefined, page: PageNode): number {
  const f = ROLE_SIZE[role ?? "body"] ?? ROLE_SIZE.body ?? 0.028;
  const min = page.unit === "px" ? 12 : 8;
  return Math.max(min, Math.round(shortSide(page) * f));
}

// Text ---------------------------------------------------------------------------------------------------------

export function textStyleFrom(spec: StyleSpec, base: TextStyle, color?: Color): TextStyle {
  const style: TextStyle = { ...base };
  if (spec.fontFamily) style.fontFamily = spec.fontFamily;
  if (spec.fontSize !== undefined) style.fontSize = spec.fontSize;
  if (spec.fontWeight !== undefined) style.fontWeight = spec.fontWeight;
  if (spec.italic !== undefined) style.fontStyle = spec.italic ? "italic" : "normal";
  if (spec.letterSpacing !== undefined) style.letterSpacing = spec.letterSpacing;
  if (spec.textCase) style.textCase = spec.textCase;
  if (spec.underline !== undefined) style.decoration = spec.underline ? "underline" : "none";
  const fills = toFills(spec);
  if (spec.color) style.fills = [{ type: "solid", color: spec.color }];
  else if (fills && fills.length > 0) style.fills = fills;
  else if (color && !spec.color)
    style.fills = base.fills.length > 0 ? base.fills : [{ type: "solid", color }];
  return style;
}

export function paragraphFrom(spec: StyleSpec, base: ParagraphStyle): ParagraphStyle {
  const p: ParagraphStyle = { ...base };
  if (spec.align) p.align = spec.align;
  if (spec.direction) p.direction = spec.direction;
  if (spec.lineHeight !== undefined)
    p.lineHeight = { unit: "percent", value: Math.round(spec.lineHeight * 100) };
  return p;
}

export function runsFrom(spec: StyleSpec): TextRun[] | undefined {
  if (spec.runs) {
    return spec.runs.map((r) => {
      const style: Partial<TextStyle> = {};
      if (r.color) style.fills = [{ type: "solid", color: r.color }];
      if (r.fontWeight) style.fontWeight = r.fontWeight;
      if (r.fontFamily) style.fontFamily = r.fontFamily;
      if (r.fontSize) style.fontSize = r.fontSize;
      if (r.italic !== undefined) style.fontStyle = r.italic ? "italic" : "normal";
      if (r.underline !== undefined) style.decoration = r.underline ? "underline" : "none";
      return Object.keys(style).length > 0 ? { text: r.text, style } : { text: r.text };
    });
  }
  return spec.text !== undefined ? [{ text: spec.text }] : undefined;
}

// Node construction ----------------------------------------------------------------------------------------------

function base(spec: ElementSpec): Partial<Node> {
  const out: Record<string, unknown> = { id: newId() };
  for (const key of [
    "x",
    "y",
    "width",
    "height",
    "rotation",
    "opacity",
    "visible",
    "locked",
    "blend",
    "role",
    "link",
    "constraints",
    "sizing",
    "alt",
    "notes",
  ] as const) {
    if (spec[key] !== undefined) out[key] = spec[key];
  }
  if (spec.name) out.name = spec.name;
  if (spec.anim) out.anim = spec.anim.map((a) => ({ id: newId(), ...a }));
  if (spec.slot) out.meta = { slot: spec.slot };
  const effects = toEffects(spec);
  if (effects) out.effects = effects;
  return out as Partial<Node>;
}

function shapedProps(spec: ElementSpec, defaultFill: Fill[]): Record<string, unknown> {
  const out: Record<string, unknown> = { fills: toFills(spec) ?? defaultFill };
  if (spec.stroke !== undefined) out.strokes = toStroke(spec.stroke);
  if (spec.cornerRadius !== undefined) {
    out.cornerRadius =
      typeof spec.cornerRadius === "number"
        ? spec.cornerRadius
        : (spec.cornerRadius as [number, number, number, number]);
  }
  return out;
}

const titleCase = (s: string) =>
  s.replace(
    /(^|[-\s])(\w)/g,
    (_, a: string, b: string) => `${a === "-" ? " " : a}${b.toUpperCase()}`,
  );

function defaultName(spec: ElementSpec): string {
  if (spec.role) return titleCase(spec.role);
  if (spec.type === "text") {
    const t = (spec.text ?? spec.runs?.map((r) => r.text).join("") ?? "").trim();
    return t ? (t.length > 28 ? `${t.slice(0, 27)}…` : t) : "Text";
  }
  return titleCase(spec.type);
}

export function buildNode(spec: ElementSpec, parentId: Id, ctx: BuildContext): Node {
  const common = {
    ...base(spec),
    name: spec.name ?? defaultName(spec),
    parent: parentId,
  } as Partial<Node>;
  const parentNode = lookup(ctx, parentId);
  const parentW =
    parentNode && parentNode.type !== "root" && parentNode.width > 0
      ? parentNode.width
      : ctx.page.width;
  switch (spec.type) {
    case "text": {
      const role = spec.role;
      const heading = HEADING_ROLES.has(role ?? "");
      const family =
        spec.fontFamily ?? brandFont(ctx.brand, heading ? "heading" : "body") ?? "Inter";
      const size = spec.fontSize ?? defaultFontSize(role, ctx.page);
      const color = readableTextColor(backdropColor(ctx, parentId));
      const baseStyle = defaultTextStyle({
        fontFamily: family,
        fontSize: size,
        fontWeight: ROLE_WEIGHT[role ?? ""] ?? 400,
        fills: [{ type: "solid", color: color === "#000000" ? "#111111" : "#ffffff" }],
        ...(role === "eyebrow" ? { textCase: "upper" as const, letterSpacing: 0.12 } : {}),
        ...(heading && size >= 40 ? { letterSpacing: -0.02 } : {}),
      });
      const style = textStyleFrom(spec, baseStyle);
      const lh = ROLE_LINE_HEIGHT[role ?? ""] ?? (size >= 32 ? 1.15 : 1.45);
      const paragraph = paragraphFrom(
        spec,
        defaultParagraph({ lineHeight: { unit: "percent", value: Math.round(lh * 100) } }),
      );
      const runs = runsFrom(spec) ?? [{ text: "" }];
      const textLen = runs.map((r) => r.text).join("").length;
      const autoResize =
        spec.autoResize ??
        (spec.width === undefined && textLen <= 32 && !runs.some((r) => r.text.includes("\n"))
          ? "width"
          : "height");
      const width =
        spec.width ??
        Math.round(Math.min(parentW * 0.84, Math.max(size * 8, textLen * size * 0.55)));
      const node = createText({
        ...(common as Partial<TextNode>),
        runs,
        style,
        paragraph,
        autoResize,
        width,
        height: spec.height ?? Math.round(size * (lh || 1.2)),
        verticalAlign: spec.verticalAlign ?? "top",
        ...(spec.maxLines ? { maxLines: spec.maxLines } : {}),
      });
      if (spec.stroke && spec.stroke !== "none") node.strokes = toStroke(spec.stroke);
      return node;
    }
    case "frame": {
      const node = createFrame({
        ...(common as object),
        ...shapedProps(spec, []),
        clip: spec.clip ?? true,
        width: spec.width ?? 0,
        height: spec.height ?? 0,
      });
      if (spec.layout && spec.layout !== "none") node.layout = toLayout(spec.layout) as AutoLayout;
      return node;
    }
    case "group":
      return createGroup({
        ...(common as object),
        clip: false,
        width: spec.width ?? 0,
        height: spec.height ?? 0,
      });
    case "rect":
      return createRect({
        ...(common as object),
        ...shapedProps(spec, [{ type: "solid", color: "#d9d9d9" }]),
      });
    case "ellipse":
      return createEllipse({
        ...(common as object),
        ...shapedProps(spec, [{ type: "solid", color: "#d9d9d9" }]),
      });
    case "polygon":
      return createPolygon({
        ...(common as object),
        ...shapedProps(spec, [{ type: "solid", color: "#d9d9d9" }]),
        ...(spec.sides ? { sides: spec.sides } : {}),
      });
    case "star":
      return createStar({
        ...(common as object),
        ...shapedProps(spec, [{ type: "solid", color: "#d9d9d9" }]),
        ...(spec.points ? { points: spec.points } : {}),
        ...(spec.innerRatio ? { innerRatio: spec.innerRatio } : {}),
      });
    case "path": {
      if (!spec.d)
        throw new ToolInputError("path elements need `d` (SVG path data in the local box).");
      return createPath({
        ...(common as object),
        ...shapedProps(spec, [{ type: "solid", color: "#111111" }]),
        paths: [{ d: spec.d, fillRule: "nonzero" }],
      });
    }
    case "line": {
      const color =
        spec.color ??
        (spec.stroke && spec.stroke !== "none"
          ? spec.stroke.color
          : readableTextColor(backdropColor(ctx, parentId)));
      const width = spec.stroke && spec.stroke !== "none" ? spec.stroke.width : 2;
      return createLine({
        ...(common as object),
        height: 0,
        width: spec.width ?? Math.round(parentW * 0.3),
        strokes: [defaultStroke({ fills: [{ type: "solid", color }], width, cap: "round" })],
        startCap: spec.startCap ?? "none",
        endCap: spec.endCap ?? "none",
      });
    }
    case "image": {
      if (!spec.assetId)
        throw new ToolInputError(
          "image elements need an assetId (generate_image, search_stock or an uploaded asset).",
        );
      if (!ctx.design.assets[spec.assetId])
        throw new ToolInputError(`asset "${spec.assetId}" is not in this design.`);
      const asset = ctx.design.assets[spec.assetId];
      const w = spec.width ?? Math.min(parentW * 0.6, asset?.width ?? 400);
      const h =
        spec.height ?? (asset?.width && asset.height ? (w * asset.height) / asset.width : w * 0.75);
      const node = createImage({
        ...(common as object),
        assetId: spec.assetId,
        width: w,
        height: h,
        fit: spec.fit ?? "crop",
        ...(spec.cornerRadius !== undefined
          ? {
              cornerRadius:
                typeof spec.cornerRadius === "number"
                  ? spec.cornerRadius
                  : (spec.cornerRadius as [number, number, number, number]),
            }
          : {}),
        ...(spec.imageShape ? { shape: spec.imageShape } : {}),
      });
      if (spec.fit === "crop" || !spec.fit)
        node.crop = coverCrop(asset?.width, asset?.height, w, h);
      if (spec.stroke) node.strokes = toStroke(spec.stroke);
      return node;
    }
    case "svg": {
      if (spec.markup) {
        const { svg } = sanitizeSvg(spec.markup);
        return createSvg({ ...(common as object), markup: svg });
      }
      if (spec.assetId) return createSvg({ ...(common as object), assetId: spec.assetId });
      throw new ToolInputError(
        "svg elements need markup or an assetId (generate_svg / search_icons).",
      );
    }
    case "chart": {
      if (!spec.chart) throw new ToolInputError("chart elements need a `chart` object.");
      const c = spec.chart;
      const textColor = spec.color ?? readableTextColor(backdropColor(ctx, parentId));
      return createChart({
        ...(common as object),
        chart: c.type,
        data: {
          labels: c.labels,
          series: c.series.map((s) => ({
            name: s.name,
            values: s.values,
            ...(s.color ? { color: s.color } : {}),
          })),
        },
        options: {
          legend: c.legend ?? c.series.length > 1,
          grid: c.grid ?? true,
          labels: true,
          palette: c.palette ?? brandPalette(ctx.brand) ?? [...DEFAULT_CHART_PALETTE],
          fontFamily: spec.fontFamily ?? brandFont(ctx.brand, "body") ?? "Inter",
          fontSize: spec.fontSize ?? Math.max(12, Math.round(shortSide(ctx.page) * 0.018)),
          textColor,
          ...(c.unit ? { unit: c.unit } : {}),
        },
      });
    }
    case "table": {
      if (!spec.table) throw new ToolInputError("table elements need a `table` object.");
      const t = spec.table;
      const rows = t.rows.length;
      const cols = Math.max(...t.rows.map((r) => r.length));
      const width = spec.width ?? Math.min(parentW * 0.84, cols * 160);
      const colWidths =
        t.colWidths && t.colWidths.length === cols
          ? t.colWidths
          : Array.from({ length: cols }, () => width / cols);
      const fontSize = spec.fontSize ?? Math.max(12, Math.round(shortSide(ctx.page) * 0.018));
      const rowHeight = Math.round(fontSize * 2.4);
      const node = createTable({
        ...(common as object),
        rows,
        cols,
        width: colWidths.reduce((s, w) => s + w, 0),
        height: rows * rowHeight,
        colWidths,
        rowHeights: Array.from({ length: rows }, () => rowHeight),
        header: t.header ?? true,
        stripe: t.stripe ?? false,
        ...(t.borderColor ? { borderColor: t.borderColor } : {}),
        defaultStyle: defaultTextStyle({
          fontFamily: spec.fontFamily ?? brandFont(ctx.brand, "body") ?? "Inter",
          fontSize,
        }),
      });
      node.cells = t.rows.flatMap((row, r) =>
        Array.from({ length: cols }, (_, c) => ({ r, c, text: row[c] ?? "" })),
      );
      return node;
    }
    case "qr":
      return createQr({
        ...(common as object),
        data: spec.qrData ?? "https://desyn.app",
        ...(spec.color ? { fg: spec.color } : {}),
        ...(spec.background ? { bg: spec.background } : {}),
        errorCorrection: "M",
      });
  }
}

function brandPalette(brand: BrandKit | undefined): Color[] | undefined {
  if (!brand || brand.colors.length === 0) return undefined;
  const order = ["primary", "accent", "secondary", undefined, "neutral"];
  return [...brand.colors]
    .sort((a, b) => order.indexOf(a.role) - order.indexOf(b.role))
    .map((c) => c.value);
}

const round2 = (n: number) => Math.round(n * 100) / 100;

// Derived geometry ---------------------------------------------------------------------------------------------

/** Re-measures text nodes in place according to their autoResize mode. */
export async function measureTextNodes(host: DocHost, nodes: TextNode[]): Promise<void> {
  if (nodes.length === 0) return;
  const results = await host.measure(
    nodes.map((n) => ({
      text: n.runs,
      style: n.style,
      paragraph: n.paragraph,
      ...(n.autoResize === "width" ? {} : { width: n.width }),
    })),
  );
  nodes.forEach((n, i) => {
    const m = results[i];
    if (!m) return;
    if (n.autoResize === "width") {
      n.width = Math.ceil(m.w);
      n.height = Math.ceil(m.h);
    } else if (n.autoResize === "height") {
      n.height = Math.ceil(m.h);
    }
  });
}

type Box = { x: number; y: number; width: number; height: number; sizing?: Node["sizing"] };

/** Positions children of an auto-layout frame (row / column / grid) and hugs the frame when it has no size. */
export function layoutChildren(
  frame: { width: number; height: number; layout: AutoLayout },
  kids: Box[],
  hug: { w: boolean; h: boolean },
): void {
  const { layout } = frame;
  const [pt, pr, pb, pl] = layout.padding;
  const gap = layout.gap;
  const rowGap = layout.rowGap ?? gap;
  if (kids.length === 0) {
    if (hug.w) frame.width = pl + pr;
    if (hug.h) frame.height = pt + pb;
    return;
  }
  if (layout.mode === "grid") {
    const cols = Math.max(1, layout.columns ?? Math.ceil(Math.sqrt(kids.length)));
    const innerW = hug.w
      ? Math.max(...kids.map((k) => k.width)) * cols + gap * (cols - 1)
      : frame.width - pl - pr;
    const cellW = (innerW - gap * (cols - 1)) / cols;
    let y = pt;
    for (let r = 0; r * cols < kids.length; r++) {
      const row = kids.slice(r * cols, r * cols + cols);
      const rowH = Math.max(...row.map((k) => k.height));
      row.forEach((k, c) => {
        if (layout.crossAlign === "stretch" || k.sizing?.h === "fill") k.width = cellW;
        k.x = round2(
          pl +
            c * (cellW + gap) +
            (layout.crossAlign === "center"
              ? (cellW - k.width) / 2
              : layout.crossAlign === "end"
                ? cellW - k.width
                : 0),
        );
        k.y = round2(y);
      });
      y += rowH + rowGap;
    }
    if (hug.w) frame.width = round2(innerW + pl + pr);
    if (hug.h) frame.height = round2(y - rowGap + pb);
    return;
  }
  const row = layout.mode === "row";
  const main = (k: Box) => (row ? k.width : k.height);
  const cross = (k: Box) => (row ? k.height : k.width);
  const innerMain = row ? frame.width - pl - pr : frame.height - pt - pb;
  // Lines (wrapping only for rows with wrap=true and a fixed width).
  const lines: Box[][] = [];
  if (row && layout.wrap && !hug.w) {
    let line: Box[] = [];
    let used = 0;
    for (const k of kids) {
      if (line.length > 0 && used + gap + k.width > innerMain) {
        lines.push(line);
        line = [];
        used = 0;
      }
      used += (line.length > 0 ? gap : 0) + k.width;
      line.push(k);
    }
    if (line.length) lines.push(line);
  } else {
    lines.push(kids);
  }
  // Fill children share the remaining main-axis space (single line only).
  if (lines.length === 1 && !(row ? hug.w : hug.h)) {
    const fills = kids.filter((k) => (row ? k.sizing?.h : k.sizing?.v) === "fill");
    if (fills.length > 0) {
      const fixed = kids.filter((k) => !fills.includes(k)).reduce((s, k) => s + main(k), 0);
      const share = Math.max(0, (innerMain - fixed - gap * (kids.length - 1)) / fills.length);
      for (const k of fills) {
        if (row) k.width = share;
        else k.height = share;
      }
    }
  }
  const lineCross = lines.map((l) => Math.max(...l.map(cross)));
  const totalCross = lineCross.reduce((s, c) => s + c, 0) + rowGap * (lines.length - 1);
  const contentMain = Math.max(
    ...lines.map((l) => l.reduce((s, k) => s + main(k), 0) + gap * (l.length - 1)),
  );
  if (row) {
    if (hug.w) frame.width = round2(contentMain + pl + pr);
    if (hug.h) frame.height = round2(totalCross + pt + pb);
  } else {
    if (hug.h) frame.height = round2(contentMain + pt + pb);
    if (hug.w) frame.width = round2(totalCross + pl + pr);
  }
  const availMain = row ? frame.width - pl - pr : frame.height - pt - pb;
  const availCross = row ? frame.height - pt - pb : frame.width - pl - pr;
  let crossCursor = row ? pt : pl;
  lines.forEach((line, li) => {
    const used = line.reduce((s, k) => s + main(k), 0);
    const free = availMain - used - gap * (line.length - 1);
    let cursor =
      (row ? pl : pt) +
      (layout.mainAlign === "center" ? free / 2 : layout.mainAlign === "end" ? free : 0);
    const between =
      layout.mainAlign === "space-between" && line.length > 1
        ? gap + free / (line.length - 1)
        : gap;
    const lc = lines.length === 1 ? availCross : (lineCross[li] as number);
    for (const k of line) {
      if (layout.crossAlign === "stretch") {
        if (row) k.height = lc;
        else k.width = lc;
      }
      const offset =
        layout.crossAlign === "center"
          ? (lc - cross(k)) / 2
          : layout.crossAlign === "end"
            ? lc - cross(k)
            : 0;
      if (row) {
        k.x = round2(cursor);
        k.y = round2(crossCursor + offset);
      } else {
        k.y = round2(cursor);
        k.x = round2(crossCursor + offset);
      }
      cursor += main(k) + between;
    }
    crossCursor += (lineCross[li] as number) + rowGap;
  });
}

/** Fits a new group's box to its children (children stay in place on the page). */
export function fitGroup(group: Box, kids: Box[]): void {
  if (kids.length === 0) return;
  const minX = Math.min(...kids.map((k) => k.x));
  const minY = Math.min(...kids.map((k) => k.y));
  const maxX = Math.max(...kids.map((k) => k.x + k.width));
  const maxY = Math.max(...kids.map((k) => k.y + k.height));
  group.x = round2(group.x + minX);
  group.y = round2(group.y + minY);
  group.width = round2(maxX - minX);
  group.height = round2(maxY - minY);
  for (const k of kids) {
    k.x = round2(k.x - minX);
    k.y = round2(k.y - minY);
  }
}

export function currentPage(host: DocHost): PageNode {
  const design = host.getDesign();
  const page = (host.page ? getNode(design, host.page) : undefined) ?? pages(design)[0];
  if (page?.type !== "page") throw new ToolInputError("The design has no page.");
  return page;
}

export function buildContext(host: DocHost, parentId?: Id): BuildContext {
  const design = host.getDesign();
  const page = (parentId ? pageOf(design, parentId) : undefined) ?? currentPage(host);
  return { design, page, ...(host.brand ? { brand: host.brand } : {}) };
}

export function assertContainer(design: Design, id: Id): Node {
  const node = getNode(design, id);
  if (!node)
    throw new ToolInputError(
      `Element "${id}" does not exist.`,
      "Use read_design or query_elements to find ids.",
    );
  if (!isContainerType(node.type) || node.type === "root") {
    throw new ToolInputError(
      `Element "${id}" (${node.type}) cannot contain children.`,
      "Use a page, frame or group as parent.",
    );
  }
  return node;
}
