import {
  type Cap,
  type ChartNode,
  createChart,
  createEllipse,
  createFrame,
  createLine,
  createPath,
  createPolygon,
  createQr,
  createRect,
  createStar,
  createTable,
  createText,
  defaultParagraph,
  defaultStroke,
  defaultTextStyle,
  type Effect,
  type Id,
  type Node,
  type Stroke,
  type TableNode,
  type TextNode,
  type TextStyle,
} from "@desyn/schema";

/**
 * What the Elements and Text panels insert. Every entry builds fresh nodes (new ids per call) at the origin;
 * the caller positions the subtree root (lib/insert.ts).
 */

const SHAPE = "#ffb02e";
const INK = "#171717";
const PLACEHOLDER = "#d9d4ca";

export interface ElementEntry {
  id: string;
  label: string;
  keywords: string[];
  /** Root first, then its descendants. */
  build: () => Node[];
  /** SVG preview drawn in a 48x48 box (path data / primitive markup is rendered by the panel). */
  preview: PreviewSpec;
}

export type PreviewSpec =
  | { kind: "rect"; radius?: number; ratio?: number }
  | { kind: "ellipse" }
  | { kind: "path"; d: string }
  | { kind: "line"; start: Cap; end: Cap; dash?: boolean }
  | { kind: "frame"; radius: number | [number, number, number, number]; ratio: number }
  | { kind: "grid"; cols: number; rows: number; gap: number };

// Paths in a 100 x 100 box (scaled with the node: path data is in local box coordinates).
const PATHS = {
  heart:
    "M50 90 C20 70 2 52 2 31 C2 15 14 4 28 4 C38 4 46 10 50 18 C54 10 62 4 72 4 C86 4 98 15 98 31 C98 52 80 70 50 90 Z",
  arch: "M0 100 L0 50 C0 22 22 0 50 0 C78 0 100 22 100 50 L100 100 Z",
  bubble:
    "M14 6 L86 6 C93 6 98 11 98 18 L98 62 C98 69 93 74 86 74 L40 74 L22 94 L24 74 L14 74 C7 74 2 69 2 62 L2 18 C2 11 7 6 14 6 Z",
  blob: "M54 4 C76 4 96 18 96 44 C96 70 80 96 52 96 C26 96 4 80 4 54 C4 26 28 4 54 4 Z",
  arrowRight: "M2 38 L62 38 L62 14 L98 50 L62 86 L62 62 L2 62 Z",
  chevron: "M2 6 L60 6 L98 50 L60 94 L2 94 L40 50 Z",
  cross: "M36 2 L64 2 L64 36 L98 36 L98 64 L64 64 L64 98 L36 98 L36 64 L2 64 L2 36 L36 36 Z",
  ring: "M50 2 A48 48 0 1 1 49.99 2 Z M50 26 A24 24 0 1 0 50.01 26 Z",
  pill: "M30 20 L70 20 A30 30 0 0 1 70 80 L30 80 A30 30 0 0 1 30 20 Z",
  diamond: "M50 2 L98 50 L50 98 L2 50 Z",
  parallelogram: "M26 10 L98 10 L74 90 L2 90 Z",
  semicircle: "M2 75 A48 48 0 0 1 98 75 Z",
  wave: "M0 40 C17 20 33 20 50 40 C67 60 83 60 100 40 L100 100 L0 100 Z",
} as const;

function pathNode(
  name: string,
  d: string,
  w = 200,
  h = 200,
  fillRule: "nonzero" | "evenodd" = "nonzero",
) {
  // Scale the 100x100 path to the node box so the stored data matches DOCUMENT_MODEL (local box coords).
  const sx = w / 100;
  const sy = h / 100;
  const scaled = d.replace(
    /(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)/g,
    (_m, x: string, y: string) => `${round(Number(x) * sx)} ${round(Number(y) * sy)}`,
  );
  return createPath({
    name,
    width: w,
    height: h,
    fills: [{ type: "solid", color: SHAPE }],
    paths: [{ d: scaled, fillRule }],
  });
}

const round = (n: number) => Math.round(n * 100) / 100;

function line(name: string, start: Cap, end: Cap, dash?: number[]): Node[] {
  const stroke: Stroke = defaultStroke({
    width: 4,
    cap: "round",
    fills: [{ type: "solid", color: INK }],
    ...(dash ? { dash } : {}),
  });
  return [createLine({ name, width: 240, strokes: [stroke], startCap: start, endCap: end })];
}

export const SHAPES: ElementEntry[] = [
  {
    id: "rect",
    label: "Square",
    keywords: ["rectangle", "box"],
    build: () => [
      createRect({
        name: "Square",
        width: 200,
        height: 200,
        fills: [{ type: "solid", color: SHAPE }],
      }),
    ],
    preview: { kind: "rect" },
  },
  {
    id: "rounded",
    label: "Rounded square",
    keywords: ["rectangle", "card", "radius"],
    build: () => [
      createRect({
        name: "Rounded square",
        width: 200,
        height: 200,
        cornerRadius: 32,
        fills: [{ type: "solid", color: SHAPE }],
      }),
    ],
    preview: { kind: "rect", radius: 10 },
  },
  {
    id: "circle",
    label: "Circle",
    keywords: ["ellipse", "round", "dot"],
    build: () => [
      createEllipse({
        name: "Circle",
        width: 200,
        height: 200,
        fills: [{ type: "solid", color: SHAPE }],
      }),
    ],
    preview: { kind: "ellipse" },
  },
  {
    id: "triangle",
    label: "Triangle",
    keywords: ["polygon"],
    build: () => [
      createPolygon({
        name: "Triangle",
        sides: 3,
        width: 200,
        height: 200,
        fills: [{ type: "solid", color: SHAPE }],
      }),
    ],
    preview: { kind: "path", d: "M24 6 L44 42 L4 42 Z" },
  },
  {
    id: "hexagon",
    label: "Hexagon",
    keywords: ["polygon"],
    build: () => [
      createPolygon({
        name: "Hexagon",
        sides: 6,
        width: 200,
        height: 200,
        fills: [{ type: "solid", color: SHAPE }],
      }),
    ],
    preview: { kind: "path", d: "M24 4 L41.3 14 L41.3 34 L24 44 L6.7 34 L6.7 14 Z" },
  },
  {
    id: "star",
    label: "Star",
    keywords: ["rating", "favorite"],
    build: () => [
      createStar({
        name: "Star",
        width: 200,
        height: 200,
        fills: [{ type: "solid", color: SHAPE }],
      }),
    ],
    preview: {
      kind: "path",
      d: "M24 4 L29.4 17.6 L44 18.3 L32.6 27.4 L36.4 41.6 L24 33.5 L11.6 41.6 L15.4 27.4 L4 18.3 L18.6 17.6 Z",
    },
  },
  {
    id: "burst",
    label: "Burst",
    keywords: ["star", "badge", "sale", "sticker"],
    build: () => [
      createStar({
        name: "Burst",
        points: 12,
        innerRatio: 0.78,
        width: 200,
        height: 200,
        fills: [{ type: "solid", color: SHAPE }],
      }),
    ],
    preview: { kind: "path", d: burstPreview(12, 0.78) },
  },
  ...(
    [
      ["heart", "Heart", ["love", "like"]],
      ["arch", "Arch", ["window", "door"]],
      ["bubble", "Speech bubble", ["chat", "quote", "comment"]],
      ["blob", "Blob", ["organic", "round"]],
      ["arrowRight", "Arrow", ["direction", "next"]],
      ["chevron", "Chevron", ["direction", "tag"]],
      ["cross", "Cross", ["plus", "add"]],
      ["ring", "Ring", ["donut", "circle"]],
      ["pill", "Pill", ["capsule", "button"]],
      ["diamond", "Diamond", ["rhombus"]],
      ["parallelogram", "Slant", ["parallelogram"]],
      ["semicircle", "Half circle", ["semicircle", "dome"]],
      ["wave", "Wave", ["divider", "water"]],
    ] as const
  ).map(
    ([key, label, keywords]): ElementEntry => ({
      id: key,
      label,
      keywords: [...keywords],
      build: () => [
        pathNode(
          label,
          PATHS[key],
          200,
          key === "pill" ? 120 : 200,
          key === "ring" ? "evenodd" : "nonzero",
        ),
      ],
      preview: { kind: "path", d: scalePreview(PATHS[key]) },
    }),
  ),
];

function scalePreview(d: string): string {
  return d.replace(
    /(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)/g,
    (_m, x: string, y: string) => `${round(4 + Number(x) * 0.4)} ${round(4 + Number(y) * 0.4)}`,
  );
}

function burstPreview(points: number, inner: number): string {
  const parts: string[] = [];
  for (let i = 0; i < points * 2; i++) {
    const r = i % 2 === 0 ? 20 : 20 * inner;
    const a = (Math.PI * i) / points - Math.PI / 2;
    parts.push(
      `${i === 0 ? "M" : "L"}${round(24 + r * Math.cos(a))} ${round(24 + r * Math.sin(a))}`,
    );
  }
  return `${parts.join(" ")} Z`;
}

export const LINES: ElementEntry[] = [
  {
    id: "line",
    label: "Line",
    keywords: ["divider", "rule"],
    build: () => line("Line", "none", "none"),
    preview: { kind: "line", start: "none", end: "none" },
  },
  {
    id: "dashed",
    label: "Dashed line",
    keywords: ["divider", "dots"],
    build: () => line("Dashed line", "none", "none", [12, 10]),
    preview: { kind: "line", start: "none", end: "none", dash: true },
  },
  {
    id: "arrow",
    label: "Arrow",
    keywords: ["pointer", "direction"],
    build: () => line("Arrow", "none", "arrow"),
    preview: { kind: "line", start: "none", end: "arrow" },
  },
  {
    id: "double",
    label: "Double arrow",
    keywords: ["both", "range"],
    build: () => line("Double arrow", "arrow", "arrow"),
    preview: { kind: "line", start: "arrow", end: "arrow" },
  },
  {
    id: "dot-line",
    label: "Connector",
    keywords: ["dots", "timeline"],
    build: () => line("Connector", "circle", "circle"),
    preview: { kind: "line", start: "circle", end: "circle" },
  },
  {
    id: "triangle-line",
    label: "Pointer",
    keywords: ["triangle", "arrow"],
    build: () => line("Pointer", "none", "triangle"),
    preview: { kind: "line", start: "none", end: "triangle" },
  },
];

/** Photo frames: clipping frames with a placeholder tone; images dropped or placed inside take their shape. */
function photoFrame(
  name: string,
  w: number,
  h: number,
  radius: number | [number, number, number, number],
): Node[] {
  return [
    createFrame({
      name,
      width: w,
      height: h,
      cornerRadius: radius,
      clip: true,
      fills: [{ type: "solid", color: PLACEHOLDER }],
      role: "photo",
      meta: { placeholder: "photo" },
    }),
  ];
}

export const FRAMES: ElementEntry[] = [
  {
    id: "frame-square",
    label: "Square frame",
    keywords: ["photo", "image"],
    build: () => photoFrame("Square frame", 320, 320, 0),
    preview: { kind: "frame", radius: 0, ratio: 1 },
  },
  {
    id: "frame-rounded",
    label: "Rounded frame",
    keywords: ["photo", "card"],
    build: () => photoFrame("Rounded frame", 320, 320, 40),
    preview: { kind: "frame", radius: 8, ratio: 1 },
  },
  {
    id: "frame-circle",
    label: "Circle frame",
    keywords: ["photo", "avatar", "round"],
    build: () => photoFrame("Circle frame", 320, 320, 160),
    preview: { kind: "frame", radius: 999, ratio: 1 },
  },
  {
    id: "frame-arch",
    label: "Arch frame",
    keywords: ["photo", "window"],
    build: () => photoFrame("Arch frame", 280, 360, [140, 140, 0, 0]),
    preview: { kind: "frame", radius: [999, 999, 0, 0], ratio: 0.78 },
  },
  {
    id: "frame-portrait",
    label: "Portrait frame",
    keywords: ["photo", "vertical", "story"],
    build: () => photoFrame("Portrait frame", 270, 480, 24),
    preview: { kind: "frame", radius: 5, ratio: 0.56 },
  },
  {
    id: "frame-landscape",
    label: "Landscape frame",
    keywords: ["photo", "wide"],
    build: () => photoFrame("Landscape frame", 480, 270, 24),
    preview: { kind: "frame", radius: 5, ratio: 1.78 },
  },
];

/** Photo grids: an auto-layout grid frame with photo cells. */
function grid(name: string, cols: number, rows: number, cell: number, gap: number): Node[] {
  const width = cols * cell + (cols - 1) * gap;
  const height = rows * cell + (rows - 1) * gap;
  const root = createFrame({
    name,
    width,
    height,
    clip: false,
    fills: [],
    layout: {
      mode: "grid",
      columns: cols,
      gap,
      rowGap: gap,
      padding: [0, 0, 0, 0],
      mainAlign: "start",
      crossAlign: "stretch",
    },
  });
  const cells: Node[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cellNode = createFrame({
        name: `Photo ${r * cols + c + 1}`,
        parent: root.id,
        x: c * (cell + gap),
        y: r * (cell + gap),
        width: cell,
        height: cell,
        cornerRadius: 8,
        clip: true,
        fills: [{ type: "solid", color: PLACEHOLDER }],
        sizing: { h: "fill", v: "fill" },
        role: "photo",
        meta: { placeholder: "photo" },
      });
      cells.push(cellNode);
    }
  }
  (root as Node & { children: Id[] }).children = cells.map((c) => c.id);
  return [root, ...cells];
}

export const GRIDS: ElementEntry[] = [
  {
    id: "grid-2",
    label: "Two up",
    keywords: ["grid", "collage", "split"],
    build: () => grid("Photo grid", 2, 1, 240, 12),
    preview: { kind: "grid", cols: 2, rows: 1, gap: 3 },
  },
  {
    id: "grid-3",
    label: "Three up",
    keywords: ["grid", "collage", "row"],
    build: () => grid("Photo grid", 3, 1, 200, 12),
    preview: { kind: "grid", cols: 3, rows: 1, gap: 3 },
  },
  {
    id: "grid-4",
    label: "Four square",
    keywords: ["grid", "collage"],
    build: () => grid("Photo grid", 2, 2, 220, 12),
    preview: { kind: "grid", cols: 2, rows: 2, gap: 3 },
  },
  {
    id: "grid-6",
    label: "Six grid",
    keywords: ["grid", "collage", "gallery"],
    build: () => grid("Photo grid", 3, 2, 180, 10),
    preview: { kind: "grid", cols: 3, rows: 2, gap: 3 },
  },
  {
    id: "grid-9",
    label: "Nine grid",
    keywords: ["grid", "collage", "gallery"],
    build: () => grid("Photo grid", 3, 3, 160, 8),
    preview: { kind: "grid", cols: 3, rows: 3, gap: 2 },
  },
];

// ---------------------------------------------------------------------------------------------------------
// Charts, tables, QR

export const CHART_TYPES: { id: ChartNode["chart"]; label: string }[] = [
  { id: "column", label: "Column" },
  { id: "bar", label: "Bar" },
  { id: "stacked-column", label: "Stacked" },
  { id: "line", label: "Line" },
  { id: "area", label: "Area" },
  { id: "pie", label: "Pie" },
  { id: "donut", label: "Donut" },
  { id: "scatter", label: "Scatter" },
  { id: "radar", label: "Radar" },
  { id: "funnel", label: "Funnel" },
  { id: "progress", label: "Progress" },
];

/**
 * A new chart with a small starter table (quarters x one series) that the data sheet opens on, so the
 * shape of the data is obvious; users replace it right away.
 */
export function newChart(kind: ChartNode["chart"]): ChartNode {
  const single = kind === "pie" || kind === "donut" || kind === "funnel" || kind === "progress";
  const data: ChartNode["data"] = single
    ? kind === "progress"
      ? { labels: ["Progress"], series: [{ name: "Done", values: [64] }] }
      : {
          labels: ["Direct", "Search", "Social", "Email"],
          series: [{ name: "Share", values: [42, 28, 18, 12] }],
        }
    : {
        labels: ["Q1", "Q2", "Q3", "Q4"],
        series:
          kind === "stacked-column" || kind === "radar"
            ? [
                { name: "Series 1", values: [12, 19, 15, 24] },
                { name: "Series 2", values: [8, 11, 14, 12] },
              ]
            : [{ name: "Series 1", values: [12, 19, 15, 24] }],
      };
  return createChart({
    name: `${CHART_TYPES.find((c) => c.id === kind)?.label ?? "Chart"} chart`,
    chart: kind,
    data,
    width: kind === "progress" ? 480 : 520,
    height: kind === "progress" ? 64 : 340,
    role: "chart",
    ...(kind === "progress" ? {} : {}),
  });
}

export function newTable(rows: number, cols: number): TableNode {
  const table = createTable({ rows, cols, name: "Table", role: "table" });
  table.defaultStyle = defaultTextStyle({ fontSize: 16, fontFamily: "Inter" });
  table.header = true;
  return table;
}

export function newQr(data: string): Node {
  return createQr({ name: "QR code", data, width: 200, height: 200, role: "qr" });
}

// ---------------------------------------------------------------------------------------------------------
// Text

export interface TextPreset {
  id: "heading" | "subheading" | "body" | "caption" | "quote" | "eyebrow";
  label: string;
  sample: string;
  role: string;
  style: Partial<TextStyle>;
  width: number;
  lineHeight: number;
}

export const TEXT_PRESETS: TextPreset[] = [
  {
    id: "heading",
    label: "Add a heading",
    sample: "Add a heading",
    role: "headline",
    style: { fontSize: 72, fontWeight: 700, letterSpacing: -0.02 },
    width: 720,
    lineHeight: 110,
  },
  {
    id: "subheading",
    label: "Add a subheading",
    sample: "Add a subheading",
    role: "subhead",
    style: { fontSize: 40, fontWeight: 600, letterSpacing: -0.01 },
    width: 640,
    lineHeight: 120,
  },
  {
    id: "body",
    label: "Add a little bit of body text",
    sample: "Add a little bit of body text",
    role: "body",
    style: { fontSize: 24, fontWeight: 400 },
    width: 520,
    lineHeight: 150,
  },
  {
    id: "caption",
    label: "Caption",
    sample: "Caption",
    role: "caption",
    style: { fontSize: 16, fontWeight: 400 },
    width: 320,
    lineHeight: 140,
  },
  {
    id: "quote",
    label: "Quote",
    sample: "“Design is thinking made visual.”",
    role: "quote",
    style: { fontSize: 40, fontWeight: 400, fontStyle: "italic" },
    width: 640,
    lineHeight: 125,
  },
  {
    id: "eyebrow",
    label: "EYEBROW",
    sample: "Eyebrow",
    role: "eyebrow",
    style: { fontSize: 16, fontWeight: 600, letterSpacing: 0.24, textCase: "upper" },
    width: 360,
    lineHeight: 120,
  },
];

export function textFromPreset(preset: TextPreset, family?: string, color = INK): TextNode {
  const style = defaultTextStyle({
    ...preset.style,
    ...(family ? { fontFamily: family } : {}),
    fills: [{ type: "solid", color }],
  });
  return createText({
    name: preset.sample.replace(/[“”]/g, ""),
    text: preset.sample,
    role: preset.role,
    width: preset.width,
    height: Math.round(style.fontSize * (preset.lineHeight / 100)),
    style,
    paragraph: defaultParagraph({ lineHeight: { unit: "percent", value: preset.lineHeight } }),
    autoResize: "height",
  });
}

/** A heading + body pair from a font pairing, grouped in an auto-layout column frame. */
export function pairingBlock(
  heading: string,
  hw: number,
  body: string,
  bw: number,
  color = INK,
): Node[] {
  const root = createFrame({
    name: `${heading} + ${body}`,
    width: 560,
    height: 180,
    fills: [],
    clip: false,
    layout: {
      mode: "column",
      gap: 16,
      padding: [0, 0, 0, 0],
      mainAlign: "start",
      crossAlign: "start",
    },
  });
  const title = createText({
    parent: root.id,
    name: "Heading",
    text: "Make it memorable",
    role: "headline",
    width: 560,
    height: 67,
    style: defaultTextStyle({
      fontFamily: heading,
      fontWeight: hw,
      fontSize: 56,
      letterSpacing: -0.01,
      fills: [{ type: "solid", color }],
    }),
    paragraph: defaultParagraph({ lineHeight: { unit: "percent", value: 115 } }),
    sizing: { h: "fill", v: "hug" },
  });
  const copy = createText({
    parent: root.id,
    name: "Body",
    text: "Pair a confident headline with calm, readable body text.",
    role: "body",
    y: 83,
    width: 560,
    height: 45,
    style: defaultTextStyle({
      fontFamily: body,
      fontWeight: bw,
      fontSize: 22,
      fills: [{ type: "solid", color }],
    }),
    paragraph: defaultParagraph({ lineHeight: { unit: "percent", value: 145 } }),
    sizing: { h: "fill", v: "hug" },
  });
  (root as Node & { children: Id[] }).children = [title.id, copy.id];
  return [root, title, copy];
}

/** Text effects: patches applied to the selected text layers (`none` clears what the others set). */
export interface TextEffect {
  id: string;
  label: string;
  apply: (node: TextNode) => Partial<TextNode> & { effects?: Effect[] };
  /** Keys this effect writes (cleared by "none" and before applying another effect). */
}

const shadow = (x: number, y: number, blur: number, color: string): Effect => ({
  type: "dropShadow",
  x,
  y,
  blur,
  spread: 0,
  color,
});

function textColor(node: TextNode): string {
  const f = node.style.fills[0];
  return f?.type === "solid" && typeof f.color === "string" ? f.color.slice(0, 7) : INK;
}

export const TEXT_EFFECTS: TextEffect[] = [
  { id: "none", label: "None", apply: () => ({ effects: [], strokes: [], curve: 0 }) },
  {
    id: "shadow",
    label: "Shadow",
    apply: () => ({ effects: [shadow(4, 6, 12, "#00000059")], strokes: [] }),
  },
  {
    id: "lift",
    label: "Lift",
    apply: () => ({ effects: [shadow(0, 14, 28, "#00000040")], strokes: [] }),
  },
  {
    id: "hollow",
    label: "Hollow",
    apply: (n) => ({
      effects: [],
      strokes: [
        defaultStroke({
          width: 2,
          align: "outside",
          fills: [{ type: "solid", color: textColor(n) }],
        }),
      ],
      style: { ...n.style, fills: [] },
    }),
  },
  {
    id: "outline",
    label: "Outline",
    apply: () => ({
      effects: [],
      strokes: [
        defaultStroke({
          width: 3,
          align: "outside",
          join: "round",
          fills: [{ type: "solid", color: "#ffffff" }],
        }),
      ],
    }),
  },
  {
    id: "echo",
    label: "Echo",
    apply: (n) => ({
      effects: [shadow(6, 6, 0, `${textColor(n)}66`), shadow(12, 12, 0, `${textColor(n)}33`)],
      strokes: [],
    }),
  },
  {
    id: "neon",
    label: "Neon",
    apply: (n) => ({
      effects: [
        {
          type: "glow",
          radius: 18,
          strength: 0.9,
          color: textColor(n) === INK ? "#ffb02e" : textColor(n),
        },
      ],
      strokes: [],
    }),
  },
  {
    id: "glitch",
    label: "Splice",
    apply: () => ({
      effects: [shadow(-4, 0, 0, "#ff6a1fcc"), shadow(4, 0, 0, "#5aa9ffcc")],
      strokes: [],
    }),
  },
  { id: "curve", label: "Curve", apply: (n) => ({ curve: n.curve ? 0 : 120 }) },
];
