// Factories that produce valid nodes and designs. Every factory takes optional overrides; ids default to fresh
// `newId()` values. A node's `parent` defaults to "root" — `create` ops overwrite the subtree root's parent anyway.
import { ROOT_ID, SCHEMA_VERSION } from "./constants";
import { newId } from "./ids";
import { DESIGN_KIND_INFO } from "./kinds";
import { getPreset, type PagePreset } from "./presets";
import type {
  AudioNode,
  BooleanNode,
  ChartNode,
  Color,
  ColorRef,
  Design,
  DesignKind,
  DesignStyles,
  EllipseNode,
  Fill,
  FrameNode,
  GroupNode,
  ImageAdjust,
  ImageNode,
  LineNode,
  PageNode,
  ParagraphStyle,
  PathNode,
  PolygonNode,
  QrNode,
  RectNode,
  RootNode,
  StarNode,
  Stroke,
  SvgNode,
  TableNode,
  TextNode,
  TextStyle,
  VideoNode,
} from "./types";

export const DEFAULT_FONT_FAMILY = "Inter";
export const DEFAULT_TEXT_COLOR: Color = "#111111";
export const DEFAULT_SHAPE_COLOR: Color = "#d9d9d9";

export function solid(color: Color | ColorRef, opacity?: number): Fill {
  return opacity === undefined ? { type: "solid", color } : { type: "solid", color, opacity };
}

export function defaultTextStyle(overrides: Partial<TextStyle> = {}): TextStyle {
  return {
    fontFamily: DEFAULT_FONT_FAMILY,
    fontWeight: 400,
    fontStyle: "normal",
    fontSize: 24,
    fills: [solid(DEFAULT_TEXT_COLOR)],
    letterSpacing: 0,
    textCase: "none",
    decoration: "none",
    ...overrides,
  };
}

export function defaultParagraph(overrides: Partial<ParagraphStyle> = {}): ParagraphStyle {
  return {
    align: "left",
    direction: "auto",
    lineHeight: { unit: "percent", value: 120 },
    spacing: 0,
    indent: 0,
    list: "none",
    ...overrides,
  };
}

export function defaultStroke(overrides: Partial<Stroke> = {}): Stroke {
  return {
    fills: [solid("#111111")],
    width: 1,
    align: "center",
    cap: "butt",
    join: "miter",
    ...overrides,
  };
}

export function defaultImageAdjust(overrides: Partial<ImageAdjust> = {}): ImageAdjust {
  return {
    brightness: 0,
    contrast: 0,
    saturation: 0,
    hue: 0,
    temperature: 0,
    tint: 0,
    exposure: 0,
    vignette: 0,
    blur: 0,
    grayscale: 0,
    sepia: 0,
    sharpen: 0,
    grain: 0,
    ...overrides,
  };
}

export function emptyStyles(): DesignStyles {
  return { colors: {}, text: {}, effects: {}, variables: {} };
}

/** Fields every node shares, with neutral defaults. */
function base(type: string, name: string) {
  return {
    id: newId(),
    type,
    name,
    parent: ROOT_ID as string | null,
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    rotation: 0,
    opacity: 1,
    blend: "normal" as const,
    visible: true,
    locked: false,
    effects: [],
  };
}

function shaped(color: Color = DEFAULT_SHAPE_COLOR) {
  return { fills: [solid(color)], strokes: [], cornerRadius: 0 };
}

export function createRoot(overrides: Partial<RootNode> = {}): RootNode {
  return {
    ...base("root", "Root"),
    id: ROOT_ID,
    parent: null,
    width: 0,
    height: 0,
    children: [],
    ...overrides,
    type: "root",
  };
}

export function createPage(overrides: Partial<PageNode> = {}): PageNode {
  return {
    ...base("page", "Page"),
    parent: ROOT_ID,
    width: 1080,
    height: 1080,
    children: [],
    clip: true,
    unit: "px",
    background: [solid("#ffffff")],
    bleed: 0,
    ...overrides,
    type: "page",
  };
}

export function createFrame(overrides: Partial<FrameNode> = {}): FrameNode {
  return {
    ...base("frame", "Frame"),
    ...shaped("#ffffff"),
    children: [],
    clip: true,
    ...overrides,
    type: "frame",
  };
}

export function createGroup(overrides: Partial<GroupNode> = {}): GroupNode {
  return { ...base("group", "Group"), children: [], clip: false, ...overrides, type: "group" };
}

export function createBoolean(overrides: Partial<BooleanNode> = {}): BooleanNode {
  return {
    ...base("boolean", "Boolean"),
    ...shaped(),
    children: [],
    clip: false,
    op: "union",
    ...overrides,
    type: "boolean",
  };
}

export function createRect(overrides: Partial<RectNode> = {}): RectNode {
  return { ...base("rect", "Rectangle"), ...shaped(), ...overrides, type: "rect" };
}

export function createEllipse(overrides: Partial<EllipseNode> = {}): EllipseNode {
  return { ...base("ellipse", "Ellipse"), ...shaped(), ...overrides, type: "ellipse" };
}

export function createPolygon(overrides: Partial<PolygonNode> = {}): PolygonNode {
  return { ...base("polygon", "Polygon"), ...shaped(), sides: 6, ...overrides, type: "polygon" };
}

export function createStar(overrides: Partial<StarNode> = {}): StarNode {
  return {
    ...base("star", "Star"),
    ...shaped(),
    points: 5,
    innerRatio: 0.382,
    ...overrides,
    type: "star",
  };
}

export function createLine(overrides: Partial<LineNode> = {}): LineNode {
  return {
    ...base("line", "Line"),
    height: 0,
    strokes: [defaultStroke({ width: 2 })],
    startCap: "none",
    endCap: "none",
    ...overrides,
    type: "line",
  };
}

export function createPath(overrides: Partial<PathNode> = {}): PathNode {
  return {
    ...base("path", "Path"),
    ...shaped(),
    paths: [{ d: "M0 0L100 0L100 100L0 100Z", fillRule: "nonzero" }],
    ...overrides,
    type: "path",
  };
}

export function createText(overrides: Partial<TextNode> & { text?: string } = {}): TextNode {
  const { text, ...rest } = overrides;
  const style = rest.style ?? defaultTextStyle();
  return {
    ...base("text", "Text"),
    width: 320,
    height: Math.round(style.fontSize * 1.2),
    runs: [{ text: text ?? "Add a heading" }],
    style,
    paragraph: defaultParagraph(),
    autoResize: "height",
    verticalAlign: "top",
    ...rest,
    type: "text",
  };
}

export function createImage(overrides: Partial<ImageNode> & Pick<ImageNode, "assetId">): ImageNode {
  return {
    ...base("image", "Image"),
    width: 400,
    height: 300,
    fit: "fill",
    cornerRadius: 0,
    strokes: [],
    ...overrides,
    type: "image",
  };
}

export function createSvg(
  overrides: Partial<SvgNode> & ({ assetId: string } | { markup: string }),
): SvgNode {
  return { ...base("svg", "Vector"), ...overrides, type: "svg" };
}

export function createVideo(overrides: Partial<VideoNode> & Pick<VideoNode, "assetId">): VideoNode {
  return {
    ...base("video", "Video"),
    width: 640,
    height: 360,
    trimStartMs: 0,
    muted: false,
    loop: false,
    volume: 1,
    fit: "fill",
    cornerRadius: 0,
    ...overrides,
    type: "video",
  };
}

export function createAudio(overrides: Partial<AudioNode> & Pick<AudioNode, "assetId">): AudioNode {
  return {
    ...base("audio", "Audio"),
    width: 0,
    height: 0,
    startMs: 0,
    trimStartMs: 0,
    volume: 1,
    ...overrides,
    type: "audio",
  };
}

/** Warm-first chart palette from docs/DESIGN_SYSTEM.md §1. */
export const DEFAULT_CHART_PALETTE: Color[] = [
  "#ffb02e",
  "#ff6a1f",
  "#ffd66b",
  "#c4451c",
  "#8a5a00",
  "#e8e1d3",
  "#7a7468",
];

export function createChart(overrides: Partial<ChartNode> = {}): ChartNode {
  return {
    ...base("chart", "Chart"),
    width: 480,
    height: 320,
    chart: "column",
    data: { labels: [], series: [] },
    options: {
      legend: true,
      grid: true,
      labels: true,
      palette: [...DEFAULT_CHART_PALETTE],
      fontFamily: DEFAULT_FONT_FAMILY,
      fontSize: 14,
      textColor: DEFAULT_TEXT_COLOR,
    },
    ...overrides,
    type: "chart",
  };
}

export function createTable(
  overrides: Partial<TableNode> & { rows?: number; cols?: number } = {},
): TableNode {
  const rows = overrides.rows ?? 3;
  const cols = overrides.cols ?? 3;
  const colWidth = 120;
  const rowHeight = 40;
  const cells: TableNode["cells"] = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) cells.push({ r, c, text: "" });
  return {
    ...base("table", "Table"),
    width: cols * colWidth,
    height: rows * rowHeight,
    rows,
    cols,
    colWidths: Array.from({ length: cols }, () => colWidth),
    rowHeights: Array.from({ length: rows }, () => rowHeight),
    cells,
    header: true,
    stripe: false,
    borderColor: "#d9d9d9",
    borderWidth: 1,
    cellPadding: 8,
    defaultStyle: defaultTextStyle({ fontSize: 14 }),
    ...overrides,
    type: "table",
  };
}

export function createQr(overrides: Partial<QrNode> = {}): QrNode {
  return {
    ...base("qr", "QR code"),
    width: 160,
    height: 160,
    data: "https://desyn.app",
    fg: "#000000",
    bg: "#ffffff",
    errorCorrection: "M",
    rounded: false,
    ...overrides,
    type: "qr",
  };
}

export interface CreateDesignOptions {
  id?: string;
  name?: string;
  /** ms epoch written to meta.createdAt / meta.updatedAt; defaults to Date.now(). */
  now?: number;
  pageId?: string;
  locale?: string;
}

/** Page fields implied by a preset (size, display unit, bleed). */
export function pageFromPreset(preset: PagePreset, overrides: Partial<PageNode> = {}): PageNode {
  return createPage({
    name: preset.label,
    width: preset.width,
    height: preset.height,
    unit: preset.unit,
    bleed: preset.bleed ?? 0,
    ...overrides,
  });
}

/**
 * A valid design with the root node and one page. `preset` is a preset id or object; when omitted the kind's
 * default preset (see DESIGN_KIND_INFO) is used.
 */
export function createDesign(
  kind: DesignKind,
  preset?: PagePreset | string,
  options: CreateDesignOptions = {},
): Design {
  const resolved =
    typeof preset === "object" ? preset : getPreset(preset ?? DESIGN_KIND_INFO[kind].defaultPreset);
  if (!resolved) throw new Error(`unknown page preset "${String(preset)}"`);
  const page = pageFromPreset(resolved, options.pageId ? { id: options.pageId } : {});
  page.name = "Page 1";
  const root = createRoot({ children: [page.id] });
  const now = options.now ?? Date.now();
  const meta: Design["meta"] = { createdAt: now, updatedAt: now };
  if (options.locale) meta.locale = options.locale;
  return {
    schema: SCHEMA_VERSION,
    id: options.id ?? newId(),
    name: options.name ?? `Untitled ${DESIGN_KIND_INFO[kind].label.toLowerCase()}`,
    kind,
    nodes: { [root.id]: root, [page.id]: page },
    assets: {},
    styles: emptyStyles(),
    meta,
  };
}
