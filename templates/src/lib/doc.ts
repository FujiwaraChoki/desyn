// A small, typed builder over the Design JSON contract (DOCUMENT_MODEL). Archetypes describe a layout in terms of
// palette roles and type roles; the builder turns that into nodes with named color styles, real roles and stable ids.
// Text heights are estimates here; the generate step runs every design through the real engine (relayout) so the
// stored boxes match what the renderer and every client compute.
import {
  type AssetRef,
  type AutoLayout,
  type Color,
  type ColorRef,
  type CornerRadius,
  type Design,
  type DesignKind,
  type Effect,
  type Fill,
  getPreset,
  type ImageAdjust,
  type ImageShape,
  type Node,
  type PagePreset,
  type ParagraphStyle,
  type Role,
  type Stroke,
  type TextAlign,
  type TextCase,
  type TextRun,
  type TextStyle,
} from "@desyn/schema";
import type { Palette } from "./palettes";
import { idGenerator } from "./rand";
import type { TypePair } from "./type";

export type PaletteKey = "bg" | "surface" | "ink" | "muted" | "accent" | "accent2" | "onAccent";
/** A palette role (rendered as a named-style reference) or a literal `#rrggbb[aa]`. */
export type Paint = PaletteKey | Color;

const PALETTE_KEYS: readonly PaletteKey[] = [
  "bg",
  "surface",
  "ink",
  "muted",
  "accent",
  "accent2",
  "onAccent",
];
const STYLE_NAMES: Record<PaletteKey, string> = {
  bg: "Background",
  surface: "Surface",
  ink: "Text",
  muted: "Muted text",
  accent: "Accent",
  accent2: "Accent 2",
  onAccent: "On accent",
};

export interface DocOptions {
  slug: string;
  name: string;
  kind: DesignKind;
  preset: string;
  palette: Palette;
  type: TypePair;
}

interface Common {
  name?: string;
  role?: Role;
  opacity?: number;
  rotation?: number;
  effects?: Effect[];
  alt?: string;
  locked?: boolean;
  meta?: Record<string, unknown>;
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ShapeOpts extends Common, Box {
  fill?: Paint | Fill | Fill[];
  stroke?: { color: Paint; width: number; dash?: number[]; align?: Stroke["align"] };
  radius?: CornerRadius;
}

export interface TextOpts extends Common {
  x: number;
  y: number;
  w: number;
  /** Fixed height (autoResize "none"); omit to let the box grow with the text. */
  h?: number;
  text?: string;
  runs?: {
    text: string;
    italic?: boolean;
    color?: Paint;
    weight?: number;
    font?: "heading" | "body";
  }[];
  font?: "heading" | "body" | "mono";
  family?: string;
  size: number;
  weight?: number;
  italic?: boolean;
  color?: Paint;
  align?: TextAlign;
  /** percent, e.g. 110 */
  leading?: number;
  /** em */
  tracking?: number;
  textCase?: TextCase;
  maxLines?: number;
  paragraphSpacing?: number;
  list?: ParagraphStyle["list"];
  valign?: "top" | "middle" | "bottom";
  highlight?: Color;
  /** single line that grows in width */
  hug?: boolean;
}

export interface ImageOpts extends Common, Box {
  /** key into the imagery catalog (templates/assets/manifest.json) */
  image: string;
  radius?: CornerRadius;
  shape?: ImageShape;
  adjust?: Partial<ImageAdjust>;
  crop?: { x: number; y: number; w: number; h: number };
}

export interface StackOpts extends Common {
  x: number;
  y: number;
  w: number;
  h?: number;
  gap: number;
  padding?: [number, number, number, number];
  align?: AutoLayout["crossAlign"];
  justify?: AutoLayout["mainAlign"];
  direction?: "column" | "row";
  fill?: Paint | Fill | Fill[];
  radius?: CornerRadius;
  stroke?: { color: Paint; width: number };
  /** width follows the content (rows / pills) */
  hugWidth?: boolean;
}

export interface ImageAsset {
  key: string;
  file: string;
  width: number;
  height: number;
  mime: string;
  alt: string;
  provenance: { provider: string; model: string; prompt: string; seed?: number };
}

type Container = { id: string; children: string[] };

export class Doc {
  readonly design: Design;
  readonly palette: Palette;
  readonly type: TypePair;
  readonly preset: PagePreset;
  /** imagery catalog keys this design uses */
  readonly images = new Set<string>();
  private readonly nextId: () => string;
  private readonly styleIds: Record<PaletteKey, string>;

  constructor(readonly opts: DocOptions) {
    const preset = getPreset(opts.preset);
    if (!preset) throw new Error(`unknown preset ${opts.preset}`);
    if (preset.kind !== opts.kind && !(opts.kind === "story" && preset.kind === "video")) {
      // presets are grouped by kind; a mismatch is a catalog bug
      throw new Error(`${opts.slug}: preset ${opts.preset} is a ${preset.kind}, not ${opts.kind}`);
    }
    this.preset = preset;
    this.palette = opts.palette;
    this.type = opts.type;
    this.nextId = idGenerator(opts.slug);
    const colors: Design["styles"]["colors"] = {};
    const styleIds = {} as Record<PaletteKey, string>;
    for (const key of PALETTE_KEYS) {
      const id = this.nextId();
      styleIds[key] = id;
      colors[id] = { name: STYLE_NAMES[key], value: opts.palette[key] };
    }
    this.styleIds = styleIds;
    const text: Design["styles"]["text"] = {};
    const t = opts.type;
    const textStyle = (family: string, weight: number, size: number): TextStyle => ({
      fontFamily: family,
      fontWeight: weight,
      fontStyle: "normal",
      fontSize: size,
      fills: [{ type: "solid", color: { $style: styleIds.ink } }],
      letterSpacing: 0,
      textCase: "none",
      decoration: "none",
    });
    const base = Math.min(preset.width, preset.height);
    text[this.nextId()] = {
      name: "Heading",
      style: textStyle(t.heading, t.headingWeight, Math.round(base * 0.09)),
    };
    text[this.nextId()] = {
      name: "Subheading",
      style: textStyle(t.body, Math.max(500, t.bodyWeight), Math.round(base * 0.04)),
    };
    text[this.nextId()] = {
      name: "Body",
      style: textStyle(t.body, t.bodyWeight, Math.round(base * 0.026)),
    };
    this.design = {
      schema: 1,
      id: this.nextId(),
      name: opts.name,
      kind: opts.kind,
      nodes: {
        root: {
          id: "root",
          type: "root",
          name: "Root",
          parent: null,
          x: 0,
          y: 0,
          width: 0,
          height: 0,
          rotation: 0,
          opacity: 1,
          blend: "normal",
          visible: true,
          locked: false,
          effects: [],
          children: [],
        },
      },
      assets: {},
      styles: { colors, text, effects: {}, variables: {} },
      meta: { templateId: opts.slug, tags: [] },
    };
  }

  get width(): number {
    return this.preset.width;
  }
  get height(): number {
    return this.preset.height;
  }

  /** Solid color value for a paint (palette role resolved). */
  color(p: Paint): Color {
    return (PALETTE_KEYS as readonly string[]).includes(p) ? this.palette[p as PaletteKey] : p;
  }

  ref(p: Paint): Color | ColorRef {
    return (PALETTE_KEYS as readonly string[]).includes(p)
      ? { $style: this.styleIds[p as PaletteKey] }
      : p;
  }

  solid(p: Paint, opacity?: number): Fill {
    return { type: "solid", color: this.ref(p), ...(opacity !== undefined ? { opacity } : {}) };
  }

  linear(angle: number, stops: [number, Paint][], opacity?: number): Fill {
    return {
      type: "linear",
      angle,
      stops: stops.map(([pos, c]) => ({ pos, color: this.ref(c) })),
      ...(opacity !== undefined ? { opacity } : {}),
    };
  }

  radial(cx: number, cy: number, r: number, stops: [number, Paint][], opacity?: number): Fill {
    return {
      type: "radial",
      cx,
      cy,
      rx: r,
      ry: r,
      stops: stops.map(([pos, c]) => ({ pos, color: this.ref(c) })),
      ...(opacity !== undefined ? { opacity } : {}),
    };
  }

  fills(f: Paint | Fill | Fill[] | undefined): Fill[] {
    if (f === undefined) return [];
    if (Array.isArray(f)) return f;
    if (typeof f === "string") return [this.solid(f)];
    return [f];
  }

  /** Add a page; returns its builder. */
  page(background: Paint | Fill | Fill[] = "bg", name?: string): PageBuilder {
    const id = this.nextId();
    const root = this.design.nodes.root as Container & Node;
    const pageNo = root.children.length + 1;
    this.design.nodes[id] = {
      id,
      type: "page",
      name: name ?? `Page ${pageNo}`,
      parent: "root",
      x: 0,
      y: 0,
      width: this.preset.width,
      height: this.preset.height,
      rotation: 0,
      opacity: 1,
      blend: "normal",
      visible: true,
      locked: false,
      effects: [],
      children: [],
      clip: true,
      unit: this.preset.unit,
      background: this.fills(background),
      bleed: this.preset.bleed ?? 0,
    };
    root.children.push(id);
    return new PageBuilder(this, id);
  }

  /** @internal */
  allocId(): string {
    return this.nextId();
  }

  /** @internal register an imagery asset and return its asset id */
  imageAsset(asset: ImageAsset): string {
    this.images.add(asset.key);
    const existing = Object.values(this.design.assets).find((a) => a.name === asset.key);
    if (existing) return existing.id;
    const id = this.nextId();
    const ref: AssetRef = {
      id,
      kind: "image",
      mime: asset.mime,
      width: asset.width,
      height: asset.height,
      name: asset.key,
      source: "template",
      ai: asset.provenance,
    };
    this.design.assets[id] = ref;
    return id;
  }

  tag(...tags: string[]): void {
    const list = this.design.meta.tags ?? [];
    this.design.meta.tags = list;
    for (const t of tags) if (!list.includes(t)) list.push(t);
  }
}

let imageResolver: ((key: string) => ImageAsset) | undefined;
/** Printed kinds use 2x upscaled `<key>@print` photos when the catalog has them (300 dpi output). */
const PRINT_KINDS = new Set([
  "poster",
  "flyer",
  "book-cover",
  "menu",
  "invitation",
  "certificate",
  "business-card",
  "resume",
  "document",
]);
const PRINT_PRESETS = new Set(["newsletter-a4", "newsletter-letter"]);
function tryResolve(key: string): ImageAsset | undefined {
  try {
    return imageResolver?.(key);
  } catch {
    return undefined;
  }
}
/** The generate step installs the imagery catalog before building designs. */
export function setImageResolver(resolve: (key: string) => ImageAsset): void {
  imageResolver = resolve;
}

export class PageBuilder {
  constructor(
    readonly doc: Doc,
    readonly id: string,
  ) {}

  get width(): number {
    return this.doc.width;
  }
  get height(): number {
    return this.doc.height;
  }

  private add(node: Node): string {
    const parent = this.doc.design.nodes[this.id] as unknown as Container;
    node.parent = this.id;
    this.doc.design.nodes[node.id] = node;
    parent.children.push(node.id);
    return node.id;
  }

  private base(type: string, name: string, b: Box, c: Common) {
    return {
      id: this.doc.allocId(),
      type,
      name: c.name ?? name,
      parent: this.id,
      x: round(b.x),
      y: round(b.y),
      width: round(Math.max(0, b.w)),
      height: round(Math.max(0, b.h)),
      rotation: c.rotation ?? 0,
      opacity: c.opacity ?? 1,
      blend: "normal" as const,
      visible: true,
      locked: c.locked ?? false,
      effects: c.effects ?? [],
      ...(c.role ? { role: c.role } : {}),
      ...(c.alt ? { alt: c.alt } : {}),
      ...(c.meta ? { meta: c.meta } : {}),
    };
  }

  private strokes(s: ShapeOpts["stroke"]): Stroke[] {
    if (!s) return [];
    return [
      {
        fills: [this.doc.solid(s.color)],
        width: s.width,
        align: s.align ?? "inside",
        cap: "butt",
        join: "miter",
        ...(s.dash ? { dash: s.dash } : {}),
      },
    ];
  }

  rect(o: ShapeOpts): string {
    return this.add({
      ...this.base("rect", "Rectangle", o, o),
      type: "rect",
      fills: this.doc.fills(o.fill ?? "surface"),
      strokes: this.strokes(o.stroke),
      cornerRadius: o.radius ?? 0,
    });
  }

  ellipse(o: ShapeOpts & { arc?: { start: number; end: number; inner: number } }): string {
    return this.add({
      ...this.base("ellipse", "Ellipse", o, o),
      type: "ellipse",
      fills: this.doc.fills(o.fill ?? "accent"),
      strokes: this.strokes(o.stroke),
      cornerRadius: 0,
      ...(o.arc ? { arc: o.arc } : {}),
    });
  }

  star(o: ShapeOpts & { points: number; inner: number }): string {
    return this.add({
      ...this.base("star", "Star", o, o),
      type: "star",
      fills: this.doc.fills(o.fill ?? "accent"),
      strokes: this.strokes(o.stroke),
      cornerRadius: o.radius ?? 0,
      points: o.points,
      innerRatio: o.inner,
    });
  }

  polygon(o: ShapeOpts & { sides: number }): string {
    return this.add({
      ...this.base("polygon", "Polygon", o, o),
      type: "polygon",
      fills: this.doc.fills(o.fill ?? "accent"),
      strokes: this.strokes(o.stroke),
      cornerRadius: o.radius ?? 0,
      sides: o.sides,
    });
  }

  path(o: ShapeOpts & { d: string | string[]; evenodd?: boolean }): string {
    const ds = Array.isArray(o.d) ? o.d : [o.d];
    return this.add({
      ...this.base("path", "Shape", o, o),
      type: "path",
      fills: this.doc.fills(o.fill ?? "accent"),
      strokes: this.strokes(o.stroke),
      cornerRadius: 0,
      paths: ds.map((d) => ({ d, fillRule: o.evenodd ? "evenodd" : "nonzero" })),
    });
  }

  line(
    o: Common & {
      x1: number;
      y1: number;
      x2: number;
      y2: number;
      color?: Paint;
      width?: number;
      dash?: number[];
    },
  ): string {
    const x = Math.min(o.x1, o.x2);
    const y = Math.min(o.y1, o.y2);
    const dx = o.x2 - o.x1;
    const dy = o.y2 - o.y1;
    const length = Math.hypot(dx, dy);
    const angle = (Math.atan2(dy, dx) * 180) / Math.PI;
    // A line is a horizontal segment of `width` rotated about its center.
    const cx = (o.x1 + o.x2) / 2;
    const cy = (o.y1 + o.y2) / 2;
    void x;
    void y;
    return this.add({
      ...this.base(
        "line",
        "Line",
        { x: cx - length / 2, y: cy, w: length, h: 0 },
        { role: "divider", ...o, rotation: round(angle) },
      ),
      type: "line",
      strokes: [
        {
          fills: [this.doc.solid(o.color ?? "muted")],
          width: o.width ?? 2,
          align: "center",
          cap: "round",
          join: "round",
          ...(o.dash ? { dash: o.dash } : {}),
        },
      ],
      startCap: "none",
      endCap: "none",
    });
  }

  text(o: TextOpts): string {
    const t = this.doc.type;
    const family =
      o.family ??
      (o.font === "mono" ? "JetBrains Mono" : o.font === "heading" ? t.heading : t.body);
    const weight = o.weight ?? (o.font === "heading" ? t.headingWeight : t.bodyWeight);
    const style: TextStyle = {
      fontFamily: family,
      fontWeight: weight,
      fontStyle: o.italic ? "italic" : "normal",
      fontSize: o.size,
      fills: [this.doc.solid(o.color ?? "ink")],
      letterSpacing: o.tracking ?? 0,
      textCase: o.textCase ?? "none",
      decoration: "none",
      ...(o.highlight ? { highlight: o.highlight } : {}),
    };
    const runs: TextRun[] = o.runs
      ? o.runs.map((r) => {
          const s: Partial<TextStyle> = {};
          if (r.italic) s.fontStyle = "italic";
          if (r.color) s.fills = [this.doc.solid(r.color)];
          if (r.weight) s.fontWeight = r.weight;
          if (r.font === "heading") s.fontFamily = t.heading;
          if (r.font === "body") s.fontFamily = t.body;
          return Object.keys(s).length ? { text: r.text, style: s } : { text: r.text };
        })
      : [{ text: o.text ?? "" }];
    const content = runs.map((r) => r.text).join("");
    const leading = o.leading ?? (o.font === "heading" ? 105 : 140);
    const h =
      o.h ?? estimateHeight(content, o.size, o.w, leading, o.textCase === "upper", o.tracking ?? 0);
    const w = o.hug ? estimateWidth(content, o.size, o.textCase === "upper", o.tracking ?? 0) : o.w;
    return this.add({
      ...this.base("text", nameFromText(content), { x: o.x, y: o.y, w, h }, o),
      type: "text",
      runs,
      style,
      paragraph: {
        align: o.align ?? "left",
        direction: "auto",
        lineHeight: { unit: "percent", value: leading },
        spacing: o.paragraphSpacing ?? 0,
        indent: 0,
        list: o.list ?? "none",
      },
      autoResize: o.hug ? "width" : o.h !== undefined ? "none" : "height",
      verticalAlign: o.valign ?? "top",
      ...(o.maxLines ? { maxLines: o.maxLines } : {}),
    });
  }

  image(o: ImageOpts): string {
    if (!imageResolver) throw new Error("image resolver not installed");
    const asset =
      (PRINT_KINDS.has(this.doc.opts.kind) || PRINT_PRESETS.has(this.doc.opts.preset)
        ? tryResolve(`${o.image}@print`)
        : undefined) ?? imageResolver(o.image);
    const assetId = this.doc.imageAsset(asset);
    const crop = o.crop ?? coverCrop(asset.width, asset.height, o.w, o.h);
    return this.add({
      ...this.base("image", "Photo", o, { role: "photo", alt: asset.alt, ...o }),
      type: "image",
      assetId,
      fit: "crop",
      crop,
      cornerRadius: o.radius ?? 0,
      strokes: [],
      ...(o.shape ? { shape: o.shape } : {}),
      ...(o.adjust ? { adjust: { ...NEUTRAL_ADJUST, ...o.adjust } } : {}),
    });
  }

  svg(o: Common & Box & { markup: string }): string {
    return this.add({
      ...this.base("svg", "Illustration", o, { role: "illustration", ...o }),
      type: "svg",
      markup: o.markup,
    });
  }

  qr(o: Common & Box & { data: string; fg?: Paint; bg?: Paint }): string {
    return this.add({
      ...this.base("qr", "QR code", o, { role: "qr", ...o }),
      type: "qr",
      data: o.data,
      fg: this.doc.color(o.fg ?? "ink"),
      bg: this.doc.color(o.bg ?? "bg"),
      errorCorrection: "M",
      rounded: true,
    });
  }

  chart(
    o: Common &
      Box & {
        chart: import("@desyn/schema").ChartType;
        labels: string[];
        series: { name: string; values: number[] }[];
        unit?: string;
        legend?: boolean;
        size?: number;
      },
  ): string {
    const d = this.doc;
    return this.add({
      ...this.base("chart", "Chart", o, { role: "chart", ...o }),
      type: "chart",
      chart: o.chart,
      data: { labels: o.labels, series: o.series },
      options: {
        legend: o.legend ?? o.series.length > 1,
        grid: o.chart !== "pie" && o.chart !== "donut",
        labels: true,
        palette: [
          d.color("accent"),
          d.color("accent2"),
          d.color("ink"),
          d.color("muted"),
          d.color("surface"),
        ],
        fontFamily: d.type.body,
        fontSize: o.size ?? 14,
        textColor: d.color("muted"),
        ...(o.unit ? { unit: o.unit } : {}),
      },
    });
  }

  table(
    o: Common &
      Box & {
        rows: string[][];
        header?: boolean;
        size?: number;
        colWidths?: number[];
        align?: ("left" | "center" | "right")[];
      },
  ): string {
    const d = this.doc;
    const rows = o.rows.length;
    const cols = Math.max(...o.rows.map((r) => r.length));
    const colWidths = o.colWidths ?? Array.from({ length: cols }, () => round(o.w / cols));
    const rowH = round(o.h / rows);
    const size = o.size ?? 14;
    const cells: import("@desyn/schema").TableCell[] = [];
    o.rows.forEach((row, r) => {
      row.forEach((text, c) => {
        const align = o.align?.[c];
        cells.push({
          r,
          c,
          text,
          ...(r === 0 && o.header !== false
            ? { style: { fontWeight: 700, fills: [d.solid("onAccent")] }, fill: d.solid("accent") }
            : {}),
          ...(align ? { align } : {}),
        });
      });
    });
    return this.add({
      ...this.base("table", "Table", o, { role: "table", ...o }),
      type: "table",
      rows,
      cols,
      colWidths,
      rowHeights: Array.from({ length: rows }, () => rowH),
      cells,
      header: o.header !== false,
      stripe: true,
      borderColor: d.color("surface"),
      borderWidth: 1,
      cellPadding: Math.round(size * 0.6),
      defaultStyle: {
        fontFamily: d.type.body,
        fontWeight: d.type.bodyWeight,
        fontStyle: "normal",
        fontSize: size,
        fills: [d.solid("ink")],
        letterSpacing: 0,
        textCase: "none",
        decoration: "none",
      },
    });
  }

  /**
   * Auto-layout stack (a frame with `layout`): children are positioned by the engine, so text of any length
   * keeps its rhythm. `build` receives a child builder bound to the stack.
   */
  stack(o: StackOpts, build: (s: PageBuilder) => void): string {
    const id = this.add({
      ...this.base(
        "frame",
        o.direction === "row" ? "Row" : "Stack",
        { x: o.x, y: o.y, w: o.w, h: o.h ?? 10 },
        o,
      ),
      type: "frame",
      fills: this.doc.fills(o.fill),
      strokes: this.strokes(o.stroke ? { ...o.stroke } : undefined),
      cornerRadius: o.radius ?? 0,
      children: [],
      clip: false,
      layout: {
        mode: o.direction ?? "column",
        gap: o.gap,
        padding: o.padding ?? [0, 0, 0, 0],
        mainAlign: o.justify ?? "start",
        crossAlign: o.align ?? "stretch",
      },
      sizing: { h: o.hugWidth ? "hug" : "fixed", v: o.h !== undefined ? "fixed" : "hug" },
    });
    const child = new PageBuilder(this.doc, id);
    build(child);
    // Children of a column stack fill its width; rows hug their content.
    const frame = this.doc.design.nodes[id] as unknown as Container;
    for (const cid of frame.children) {
      const n = this.doc.design.nodes[cid] as Node;
      n.x = 0;
      n.y = 0;
      // nested stacks keep their own sizing (they hug their content vertically)
      const own = n.type === "frame" && n.layout ? n.sizing : undefined;
      const text = n.type === "text";
      if (o.direction === "row")
        n.sizing = { h: text ? "hug" : (own?.h ?? "fixed"), v: text ? "hug" : (own?.v ?? "fixed") };
      else
        n.sizing = {
          h:
            o.align === "stretch" || o.align === undefined
              ? "fill"
              : text
                ? "hug"
                : (own?.h ?? "fixed"),
          v: text ? "hug" : (own?.v ?? "fixed"),
        };
      if (n.type === "text" && o.direction === "row") n.autoResize = "width";
    }
    return id;
  }

  /** Group nodes built by `build` (bounds are derived from the children). */
  group(o: Common, build: (g: PageBuilder) => void): string {
    const id = this.add({
      ...this.base("group", "Group", { x: 0, y: 0, w: 0, h: 0 }, o),
      type: "group",
      children: [],
      clip: false,
    });
    build(new PageBuilder(this.doc, id));
    return id;
  }

  /** Pill button: a frame with a centered label (role cta). */
  button(
    o: Common & {
      x: number;
      y: number;
      label: string;
      size: number;
      fill?: Paint;
      color?: Paint;
      outline?: boolean;
      radius?: number;
    },
  ): string {
    const padY = Math.round(o.size * 0.75);
    const padX = Math.round(o.size * 1.5);
    return this.stack(
      {
        name: o.name ?? "Button",
        role: o.role ?? "cta",
        x: o.x,
        y: o.y,
        w: 10,
        gap: 0,
        padding: [padY, padX, padY, padX],
        direction: "row",
        hugWidth: true,
        align: "center",
        fill: o.outline ? undefined : (o.fill ?? "accent"),
        stroke: o.outline
          ? { color: o.color ?? "ink", width: Math.max(1.5, o.size / 10) }
          : undefined,
        radius: o.radius ?? 999,
      },
      (b) => {
        b.text({
          x: 0,
          y: 0,
          w: 10,
          hug: true,
          text: o.label,
          size: o.size,
          weight: 600,
          color: o.color ?? (o.outline ? "ink" : "onAccent"),
          leading: 120,
          name: "Button label",
        });
      },
    );
  }
}

const NEUTRAL_ADJUST: ImageAdjust = {
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
};

/** Normalized crop rect that covers a w x h box with an image of iw x ih (centered). */
export function coverCrop(
  iw: number,
  ih: number,
  w: number,
  h: number,
): { x: number; y: number; w: number; h: number } {
  const boxRatio = w / h;
  const imgRatio = iw / ih;
  if (imgRatio > boxRatio) {
    const cw = boxRatio / imgRatio;
    return { x: round4((1 - cw) / 2), y: 0, w: round4(cw), h: 1 };
  }
  const ch = imgRatio / boxRatio;
  return { x: 0, y: round4((1 - ch) / 2), w: 1, h: round4(ch) };
}

function round(v: number): number {
  return Math.round(v * 100) / 100;
}
function round4(v: number): number {
  return Math.round(v * 10000) / 10000;
}

function nameFromText(s: string): string {
  const first = s.split("\n")[0]?.trim() ?? "";
  return first.length > 40 ? `${first.slice(0, 39)}…` : first || "Text";
}

/** Rough advance width (em) of a string; the engine relayout replaces heights computed from it. */
export function ems(s: string, upper: boolean): number {
  let w = 0;
  for (const raw of s) {
    const ch = upper ? raw.toUpperCase() : raw;
    if (ch === " ") w += 0.28;
    else if (/[.,:;'!|]/.test(ch)) w += 0.28;
    else if (/[ijlI]/.test(ch)) w += ch === "I" ? 0.34 : 0.28;
    else if (/[tfrJ]/.test(ch)) w += 0.4;
    else if (/[MW]/.test(ch)) w += 0.98;
    else if (/[mw]/.test(ch)) w += 0.85;
    else if (/[A-Z]/.test(ch)) w += 0.74;
    else if (/[0-9]/.test(ch)) w += 0.62;
    else w += 0.54;
  }
  return w;
}

export function estimateWidth(s: string, size: number, upper: boolean, tracking: number): number {
  const longest = s
    .split("\n")
    .reduce((m, l) => Math.max(m, ems(l, upper) + l.length * tracking), 0);
  return Math.ceil(longest * size) + 2;
}

export function estimateHeight(
  s: string,
  size: number,
  w: number,
  leading: number,
  upper: boolean,
  tracking: number,
): number {
  let lines = 0;
  for (const para of s.split("\n")) {
    const width = (ems(para, upper) + para.length * tracking) * size;
    lines += Math.max(1, Math.ceil(width / Math.max(1, w)));
  }
  return Math.ceil(lines * size * (leading / 100));
}
