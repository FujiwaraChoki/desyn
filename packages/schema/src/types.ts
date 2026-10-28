// TypeScript mirror of docs/DOCUMENT_MODEL.md (the frozen contract). Names and shapes are exact; when the contract
// changes (additively, via its change log) this file changes with it. Runtime validation lives in ./zod.ts.

// ---------------------------------------------------------------------------------------------------------------
// 1. Primitives
// ---------------------------------------------------------------------------------------------------------------

/** 12 chars [a-z0-9]. `"root"` is reserved for the root node. */
export type Id = string;
/** `"#rrggbb"` or `"#rrggbbaa"`, lowercase hex. */
export type Color = string;
export type Unit = "px" | "mm" | "in" | "pt";
export type BlendMode =
  | "normal"
  | "multiply"
  | "screen"
  | "overlay"
  | "darken"
  | "lighten"
  | "color-dodge"
  | "color-burn"
  | "hard-light"
  | "soft-light"
  | "difference"
  | "exclusion"
  | "hue"
  | "saturation"
  | "color"
  | "luminosity";

export type ColorRef = { $var: string } | { $style: Id };

// ---------------------------------------------------------------------------------------------------------------
// 2. Design
// ---------------------------------------------------------------------------------------------------------------

export type DesignKind =
  | "social-post"
  | "story"
  | "poster"
  | "flyer"
  | "thumbnail"
  | "banner"
  | "ad"
  | "presentation"
  | "infographic"
  | "business-card"
  | "resume"
  | "invitation"
  | "menu"
  | "logo"
  | "newsletter"
  | "document"
  | "whiteboard"
  | "website"
  | "video"
  | "book-cover"
  | "certificate"
  | "sticker"
  | "mockup"
  | "custom";

export interface DesignMeta {
  createdAt?: number;
  updatedAt?: number;
  templateId?: string;
  tags?: string[];
  locale?: string;
  [k: string]: unknown;
}

export interface Design {
  schema: 1;
  id: Id;
  name: string;
  kind: DesignKind;
  /** Flat map. `nodes["root"]` is the RootNode whose children are the page ids, in order. */
  nodes: Record<Id, Node>;
  assets: Record<Id, AssetRef>;
  styles: DesignStyles;
  brandKitId?: string;
  meta: DesignMeta;
}

export type AssetKind = "image" | "svg" | "font" | "video" | "audio" | "lottie" | "data";
export type AssetSource = "upload" | "ai" | "stock" | "template" | "brand";

export interface AssetRef {
  id: Id;
  kind: AssetKind;
  url?: string;
  storageKey?: string;
  mime: string;
  bytes?: number;
  width?: number;
  height?: number;
  durationMs?: number;
  hash?: string;
  name?: string;
  source?: AssetSource;
  attribution?: { author?: string; license?: string; url?: string };
  ai?: { provider: string; model: string; prompt: string; seed?: number };
  family?: string;
  weight?: number;
  style?: "normal" | "italic";
}

export interface ColorStyle {
  name: string;
  value: Color;
}
export interface TextStyleDef {
  name: string;
  style: TextStyle;
  paragraph?: Partial<ParagraphStyle>;
}
export interface EffectStyle {
  name: string;
  effects: Effect[];
}

export interface DesignStyles {
  colors: Record<Id, ColorStyle>;
  text: Record<Id, TextStyleDef>;
  effects: Record<Id, EffectStyle>;
  variables: Record<string, string | number | boolean>;
}

// ---------------------------------------------------------------------------------------------------------------
// 3. Nodes
// ---------------------------------------------------------------------------------------------------------------

/** Open string union: unknown roles are opaque. See KNOWN_ROLES in ./roles.ts. */
export type Role = KnownRole | (string & {});

export type KnownRole =
  | "background"
  | "hero"
  | "headline"
  | "subhead"
  | "body"
  | "caption"
  | "eyebrow"
  | "cta"
  | "button"
  | "logo"
  | "brand-mark"
  | "photo"
  | "product"
  | "product-card"
  | "card"
  | "badge"
  | "price"
  | "rating"
  | "icon"
  | "illustration"
  | "decoration"
  | "pattern"
  | "divider"
  | "quote"
  | "author"
  | "stat"
  | "stat-label"
  | "list"
  | "list-item"
  | "nav"
  | "footer"
  | "header"
  | "section"
  | "chart"
  | "table"
  | "qr"
  | "contact"
  | "date"
  | "location"
  | "url"
  | "watermark"
  | "placeholder"
  | "slide-title"
  | "slide-body"
  | "speaker"
  | "avatar"
  | "form-field";

export type HConstraint = "left" | "right" | "center" | "stretch" | "scale";
export type VConstraint = "top" | "bottom" | "center" | "stretch" | "scale";
export type SizingMode = "fixed" | "hug" | "fill";

export interface BaseNode {
  id: Id;
  type: string;
  name: string;
  parent: Id | null;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  flipX?: boolean;
  flipY?: boolean;
  opacity: number;
  blend: BlendMode;
  visible: boolean;
  locked: boolean;
  effects: Effect[];
  role?: Role;
  constraints?: { h: HConstraint; v: VConstraint };
  sizing?: { h: SizingMode; v: SizingMode };
  aspectLocked?: boolean;
  mask?: boolean;
  link?: string;
  alt?: string;
  anim?: Animation[];
  notes?: string;
  meta?: Record<string, unknown>;
}

export interface AutoLayout {
  mode: "row" | "column" | "grid";
  gap: number;
  rowGap?: number;
  padding: [number, number, number, number];
  mainAlign: "start" | "center" | "end" | "space-between";
  crossAlign: "start" | "center" | "end" | "stretch" | "baseline";
  wrap?: boolean;
  columns?: number;
  reverse?: boolean;
}

export interface ContainerProps {
  /** Ordered back-to-front (index 0 is bottom-most). */
  children: Id[];
  clip: boolean;
  layout?: AutoLayout;
}

export type CornerRadius = number | [number, number, number, number];

export interface Shaped {
  fills: Fill[];
  strokes: Stroke[];
  cornerRadius: CornerRadius;
  cornerSmoothing?: number;
}

export interface RootNode extends BaseNode, Pick<ContainerProps, "children"> {
  type: "root";
}

export type PageTransitionKind = "none" | "fade" | "slide" | "push" | "zoom" | "dissolve";

export interface PageNode extends BaseNode, ContainerProps {
  type: "page";
  unit: Unit;
  background: Fill[];
  bleed: number;
  durationMs?: number;
  transition?: { kind: PageTransitionKind; durationMs: number };
  grid?: { columns: number; gutter: number; margin: number; baseline?: number };
  guides?: { axis: "x" | "y"; pos: number }[];
}

export interface FrameNode extends BaseNode, ContainerProps, Shaped {
  type: "frame";
}
export interface GroupNode extends BaseNode, ContainerProps {
  type: "group";
}
export type BooleanOp = "union" | "subtract" | "intersect" | "exclude";
export interface BooleanNode extends BaseNode, ContainerProps, Shaped {
  type: "boolean";
  op: BooleanOp;
}

export interface RectNode extends BaseNode, Shaped {
  type: "rect";
}
export interface EllipseNode extends BaseNode, Shaped {
  type: "ellipse";
  arc?: { start: number; end: number; inner: number };
}
export interface PolygonNode extends BaseNode, Shaped {
  type: "polygon";
  sides: number;
}
export interface StarNode extends BaseNode, Shaped {
  type: "star";
  points: number;
  innerRatio: number;
}
export type Cap = "none" | "arrow" | "triangle" | "circle" | "square" | "diamond" | "bar";
export interface LineNode extends BaseNode {
  type: "line";
  strokes: Stroke[];
  startCap: Cap;
  endCap: Cap;
}

export type FillRule = "nonzero" | "evenodd";
export interface PathNode extends BaseNode, Shaped {
  type: "path";
  paths: { d: string; fillRule: FillRule }[];
}

export interface TextRun {
  text: string;
  style?: Partial<TextStyle>;
}
export type TextCase = "none" | "upper" | "lower" | "title";
export type TextDecoration = "none" | "underline" | "strikethrough";
export interface TextStyle {
  fontFamily: string;
  fontWeight: number;
  fontStyle: "normal" | "italic";
  fontSize: number;
  fills: Fill[];
  /** em */
  letterSpacing: number;
  textCase: TextCase;
  decoration: TextDecoration;
  link?: string;
  highlight?: Color;
  features?: string[];
  variations?: Record<string, number>;
}
export type TextAlign = "left" | "center" | "right" | "justify";
export type TextDirection = "ltr" | "rtl" | "auto";
export type LineHeight = { unit: "auto" | "px" | "percent"; value: number };
export type ListStyle = "none" | "bullet" | "number";
export interface ParagraphStyle {
  align: TextAlign;
  direction: TextDirection;
  lineHeight: LineHeight;
  spacing: number;
  indent: number;
  list: ListStyle;
}
export type TextAutoResize = "none" | "height" | "width";
export type VerticalAlign = "top" | "middle" | "bottom";
export interface TextNode extends BaseNode {
  type: "text";
  runs: TextRun[];
  style: TextStyle;
  paragraph: ParagraphStyle;
  autoResize: TextAutoResize;
  maxLines?: number;
  curve?: number;
  verticalAlign: VerticalAlign;
  strokes?: Stroke[];
  styleRef?: Id;
}

export interface ImageAdjust {
  brightness: number;
  contrast: number;
  saturation: number;
  hue: number;
  temperature: number;
  tint: number;
  exposure: number;
  vignette: number;
  blur: number;
  grayscale: number;
  sepia: number;
  sharpen: number;
  grain: number;
  duotone?: [Color, Color];
  filter?: string;
}
export type ImageFit = "fill" | "fit" | "crop" | "tile";
export type ImageCrop = { x: number; y: number; w: number; h: number; zoom?: number };
export type ImageShape = "rect" | "ellipse" | { path: string };
export interface ImageNode extends BaseNode {
  type: "image";
  assetId: Id;
  fit: ImageFit;
  crop?: ImageCrop;
  cornerRadius: CornerRadius;
  shape?: ImageShape;
  adjust?: ImageAdjust;
  strokes: Stroke[];
  maskAssetId?: Id;
}

export interface SvgNode extends BaseNode {
  type: "svg";
  assetId?: Id;
  markup?: string;
  recolor?: Record<Color, Color>;
  strokes?: Stroke[];
}
export interface VideoNode extends BaseNode {
  type: "video";
  assetId: Id;
  trimStartMs: number;
  trimEndMs?: number;
  muted: boolean;
  loop: boolean;
  volume: number;
  posterAssetId?: Id;
  fit: "fill" | "fit" | "crop";
  cornerRadius: number;
}
export interface AudioNode extends BaseNode {
  type: "audio";
  assetId: Id;
  startMs: number;
  trimStartMs: number;
  trimEndMs?: number;
  volume: number;
  fadeInMs?: number;
  fadeOutMs?: number;
}

export type ChartType =
  | "bar"
  | "column"
  | "line"
  | "area"
  | "pie"
  | "donut"
  | "scatter"
  | "radar"
  | "funnel"
  | "stacked-column"
  | "progress";
export interface ChartSeries {
  name: string;
  values: number[];
  color?: Color;
}
export interface ChartData {
  labels: string[];
  series: ChartSeries[];
}
export interface ChartOptions {
  legend: boolean;
  grid: boolean;
  labels: boolean;
  palette: Color[];
  fontFamily: string;
  fontSize: number;
  textColor: Color;
  min?: number;
  max?: number;
  unit?: string;
}
export interface ChartNode extends BaseNode {
  type: "chart";
  chart: ChartType;
  data: ChartData;
  options: ChartOptions;
}

export interface TableCell {
  r: number;
  c: number;
  text: string;
  style?: Partial<TextStyle>;
  fill?: Fill;
  align?: "left" | "center" | "right";
  colspan?: number;
  rowspan?: number;
}
export interface TableNode extends BaseNode {
  type: "table";
  rows: number;
  cols: number;
  colWidths: number[];
  rowHeights: number[];
  cells: TableCell[];
  header: boolean;
  stripe: boolean;
  borderColor: Color;
  borderWidth: number;
  cellPadding: number;
  defaultStyle: TextStyle;
}

export type QrErrorCorrection = "L" | "M" | "Q" | "H";
export interface QrNode extends BaseNode {
  type: "qr";
  data: string;
  fg: Color;
  bg: Color;
  errorCorrection: QrErrorCorrection;
  rounded: boolean;
}

export type Node =
  | RootNode
  | PageNode
  | FrameNode
  | GroupNode
  | BooleanNode
  | RectNode
  | EllipseNode
  | PolygonNode
  | StarNode
  | LineNode
  | PathNode
  | TextNode
  | ImageNode
  | SvgNode
  | VideoNode
  | AudioNode
  | ChartNode
  | TableNode
  | QrNode;

export type NodeType = Node["type"];
export type ContainerNode = RootNode | PageNode | FrameNode | GroupNode | BooleanNode;
export type ShapedNode =
  | FrameNode
  | BooleanNode
  | RectNode
  | EllipseNode
  | PolygonNode
  | StarNode
  | PathNode;
/** Node of a given `type`. */
export type NodeOfType<T extends NodeType> = Extract<Node, { type: T }>;

// Paint ---------------------------------------------------------------------------------------------------------

export interface Stop {
  /** 0..1 */
  pos: number;
  color: Color | ColorRef;
}

interface FillCommon {
  opacity?: number;
  visible?: boolean;
  blend?: BlendMode;
}
export interface SolidFill extends FillCommon {
  type: "solid";
  color: Color | ColorRef;
}
export interface LinearFill extends FillCommon {
  type: "linear";
  angle: number;
  stops: Stop[];
}
export interface RadialFill extends FillCommon {
  type: "radial";
  cx: number;
  cy: number;
  rx: number;
  ry: number;
  stops: Stop[];
}
export interface ConicFill extends FillCommon {
  type: "conic";
  cx: number;
  cy: number;
  angle: number;
  stops: Stop[];
}
export type ImageFillMode = "fill" | "fit" | "tile" | "stretch";
export interface ImageFill extends FillCommon {
  type: "image";
  assetId: Id;
  mode: ImageFillMode;
  scale?: number;
  offsetX?: number;
  offsetY?: number;
  rotation?: number;
  adjust?: Partial<ImageAdjust>;
}
export type Fill = SolidFill | LinearFill | RadialFill | ConicFill | ImageFill;
export type FillType = Fill["type"];

export interface Stroke {
  fills: Fill[];
  width: number;
  align: "inside" | "center" | "outside";
  dash?: number[];
  cap: "butt" | "round" | "square";
  join: "miter" | "round" | "bevel";
  miterLimit?: number;
  visible?: boolean;
}

export interface DropShadowEffect {
  type: "dropShadow";
  x: number;
  y: number;
  blur: number;
  spread: number;
  color: Color;
  visible?: boolean;
}
export interface InnerShadowEffect {
  type: "innerShadow";
  x: number;
  y: number;
  blur: number;
  spread: number;
  color: Color;
  visible?: boolean;
}
export interface LayerBlurEffect {
  type: "layerBlur";
  radius: number;
  visible?: boolean;
}
export interface BackgroundBlurEffect {
  type: "backgroundBlur";
  radius: number;
  visible?: boolean;
}
export interface NoiseEffect {
  type: "noise";
  amount: number;
  scale: number;
  mono: boolean;
  visible?: boolean;
}
export interface GlowEffect {
  type: "glow";
  radius: number;
  strength: number;
  color: Color;
  visible?: boolean;
}
export type Effect =
  | DropShadowEffect
  | InnerShadowEffect
  | LayerBlurEffect
  | BackgroundBlurEffect
  | NoiseEffect
  | GlowEffect;
export type EffectType = Effect["type"];

export type AnimationPreset =
  | "fade"
  | "rise"
  | "drop"
  | "slide-left"
  | "slide-right"
  | "zoom-in"
  | "zoom-out"
  | "pop"
  | "rotate"
  | "wipe"
  | "typewriter"
  | "pulse"
  | "float"
  | "shake"
  | "blur-in"
  | "none";
export type AnimationPhase = "in" | "out" | "loop";
export type Easing = "linear" | "ease" | "ease-in" | "ease-out" | "ease-in-out" | "spring";
export interface Animation {
  id: Id;
  preset: AnimationPreset;
  phase: AnimationPhase;
  startMs: number;
  durationMs: number;
  easing: Easing;
}

// ---------------------------------------------------------------------------------------------------------------
// 5. Operations
// ---------------------------------------------------------------------------------------------------------------

export type PathSegment = string | number;

export interface CreateOp {
  op: "create";
  nodes: Node[];
  parent: Id;
  index?: number;
}
export interface UpdateOp {
  op: "update";
  id: Id;
  set?: Record<string, unknown>;
  unset?: string[];
}
export interface PatchOp {
  op: "patch";
  id: Id;
  path: PathSegment[];
  value: unknown;
}
export interface DeleteOp {
  op: "delete";
  id: Id;
}
export interface MoveOp {
  op: "move";
  id: Id;
  parent: Id;
  index?: number;
}
export interface AssetOp {
  op: "asset";
  set?: Record<Id, AssetRef>;
  remove?: Id[];
}
export interface StylesOp {
  op: "styles";
  path: PathSegment[];
  value: unknown;
}
export interface DocSet {
  name?: string;
  kind?: DesignKind;
  brandKitId?: string;
  meta?: Record<string, unknown>;
}
export interface DocOp {
  op: "doc";
  set: DocSet;
  /** Additive (change log 2026-10-20): optional design fields to remove. Only `brandKitId` is optional. */
  unset?: "brandKitId"[];
}
export type Op = CreateOp | UpdateOp | PatchOp | DeleteOp | MoveOp | AssetOp | StylesOp | DocOp;
export type OpKind = Op["op"];

export type TransactionSource = "user" | "ai" | "workflow" | "import" | "template" | "system";
export interface TransactionActor {
  userId?: string;
  runId?: string;
  agent?: string;
}
export interface Transaction {
  id: Id;
  label: string;
  ops: Op[];
  source: TransactionSource;
  actor?: TransactionActor;
  ts: number;
}

/** See spec/fixtures/README.md for the exact meaning of each reason. */
export type DropReason =
  | "invalid-op"
  | "missing-node"
  | "missing-parent"
  | "not-container"
  | "cycle"
  | "duplicate-id"
  | "immutable-field"
  | "invalid-node"
  | "root-protected"
  | "page-nesting"
  | "invalid-path"
  | "invalid-value";

export interface DroppedOp {
  index: number;
  reason: DropReason;
}

export interface ApplyResult {
  design: Design;
  inverse: Transaction;
  applied: Op[];
  dropped: DroppedOp[];
}

// ---------------------------------------------------------------------------------------------------------------
// 7. Semantic description for AI
// ---------------------------------------------------------------------------------------------------------------

export type IssueCode =
  | "low-contrast"
  | "tiny-text"
  | "text-overflow"
  | "off-page"
  | "overlap"
  | "misaligned"
  | "uneven-spacing"
  | "orphan-line"
  | "too-many-fonts"
  | "too-many-colors"
  | "weak-hierarchy"
  | "image-low-res"
  | "unsafe-margin"
  | "missing-alt"
  | "unlabeled-group";

export type IssueSeverity = "info" | "warn" | "error";

export interface Issue {
  severity: IssueSeverity;
  code: IssueCode;
  ids: Id[];
  message: string;
  fix?: Op[];
}

export interface DNode {
  id: Id;
  type: string;
  name: string;
  role?: string;
  box: { x: number; y: number; w: number; h: number; rotation: number };
  z: number;
  visible: boolean;
  locked: boolean;
  opacity: number;
  text?: string;
  font?: {
    family: string;
    size: number;
    weight: number;
    color: Color;
    align: string;
    lines?: number;
  };
  fill?: string;
  image?: {
    assetId: Id;
    alt?: string;
    kind?: "photo" | "illustration" | "logo" | "icon" | "unknown";
  };
  semantic?: string;
  children?: DNode[];
  flags?: string[];
}

export interface Description {
  design: { id: Id; name: string; kind: DesignKind; pageCount: number; locale?: string };
  page: { id: Id; index: number; width: number; height: number; unit: Unit; background: string };
  selection: Id[];
  tree: DNode[];
  palette: { color: Color; share: number }[];
  fonts: { family: string; weights: number[]; usedBy: number }[];
  typography: { scale: number[]; headlineSize?: number; bodySize?: number; ratio?: number };
  grid: {
    margins: { t: number; r: number; b: number; l: number };
    alignments: { axis: "x" | "y"; pos: number; ids: Id[] }[];
    spacingRhythm?: number;
  };
  hierarchy: { id: Id; rank: number; reason: string }[];
  issues: Issue[];
}
