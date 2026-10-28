// JSON shapes exchanged with the wasm engine (mirrors crates/desyn-wasm/src/protocol.rs and text.rs) and the
// worker API. Everything crossing the worker boundary is structured-clone friendly.
import type { ApplyResult, Description, Id, Issue, Op, Transaction } from "@desyn/schema";

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Row-major 2D affine `{a, b, c, d, e, f}`: x' = a x + c y + e, y' = b x + d y + f. */
export interface Affine {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

export interface OrientedBox {
  transform: Affine;
  width: number;
  height: number;
}

/** What the canvas shows: page point (x, y) at the top-left corner, `zoom` CSS px per design px. */
export interface ViewState {
  x: number;
  y: number;
  zoom: number;
  /** Canvas size in CSS px. */
  width: number;
  height: number;
  /** Device pixels per CSS px. */
  dpr: number;
  /** Exact device-pixel size when known (ResizeObserver `devicePixelContentBoxSize`). */
  deviceWidth?: number;
  deviceHeight?: number;
}

export interface RenderOptions {
  /** Page to show (default: the first page). */
  pageId?: Id;
  /** Pasteboard color (`#rrggbb[aa]`); `null` = transparent. */
  background?: string | null;
  /** Soft page shadow on the pasteboard. */
  pageShadow?: boolean;
  /** Nodes not drawn (e.g. text edited in a DOM overlay). */
  hidden?: Id[];
  showHidden?: boolean;
  /** Animation time (ms) for previews; undefined = designed state. */
  timeMs?: number;
  /** Per-frame time budget for progressive rendering (ms). */
  budgetMs?: number;
}

export interface FontRequestInfo {
  family: string;
  weight: number;
  italic: boolean;
  reason: "family" | "fallback" | "emoji";
}

export interface FrameInfo {
  width: number;
  height: number;
  pageId: Id | null;
  /** Device rects `[x, y, w, h]` updated by this call. */
  rects: [number, number, number, number][];
  /** Content shifted by `[dx, dy]` device px before `rects` were drawn. */
  scroll: [number, number] | null;
  pending: number;
  full: boolean;
  built: boolean;
  buildMs: number;
  rasterMs: number;
  missingAssets: Id[];
  fontRequests: FontRequestInfo[];
  warnings: string[];
}

export interface PendingRequests {
  missingAssets: Id[];
  fontRequests: FontRequestInfo[];
}

export interface PageInfo {
  id: Id;
  name: string;
  width: number;
  height: number;
}

export interface LoadInfo {
  id: Id;
  pages: PageInfo[];
  nodeCount: number;
  violations: string[];
}

export interface EngineInfo {
  version: string;
  formats: string[];
  exporters: boolean;
}

/** `applyTransaction` result without the design (the client keeps its own mirror). */
export type EngineApplyResult = Omit<ApplyResult, "design">;

export interface HitOptions {
  /** Deepest node instead of the page's top-level child. */
  deep?: boolean;
  includeLocked?: boolean;
  includeHidden?: boolean;
  /** Hit slop in design px (screen px / zoom). */
  tolerance?: number;
}

export interface HitRequest {
  pageId?: Id;
  x: number;
  y: number;
  options?: HitOptions;
  /** Every node under the point (topmost first). */
  all?: boolean;
}

export interface HitResult {
  id: Id | null;
  /** Page child .. deepest node. */
  path: Id[];
  all: Id[];
}

export interface MarqueeRequest {
  pageId?: Id;
  rect: Rect;
  mode?: "contain" | "intersect";
  options?: HitOptions;
}

export interface SnapOptions {
  threshold?: number;
  objects?: boolean;
  page?: boolean;
  guides?: boolean;
  grid?: boolean;
  spacing?: boolean;
}

export interface ResizeEdges {
  left: boolean;
  right: boolean;
  top: boolean;
  bottom: boolean;
}

export interface SnapRequest {
  pageId?: Id;
  /** Moving nodes (never targets). */
  ids: Id[];
  /** Bounds after the raw gesture (page coordinates). */
  rect: Rect;
  edges?: ResizeEdges;
  options?: SnapOptions;
  distances?: boolean;
}

export interface SnapGuide {
  axis: "x" | "y";
  pos: number;
  from: number;
  to: number;
  kind: "edge" | "center" | "page-edge" | "page-center" | "guide" | "grid";
}

export interface SpacingGuide {
  axis: "x" | "y";
  gap: number;
  /** `[start, end, cross]` per gap. */
  segments: [number, number, number][];
}

export interface SizeMatch {
  axis: "x" | "y";
  size: number;
  with: Rect;
}

export interface DistanceLabel {
  from: Point;
  to: Point;
  value: number;
}

export interface SnapResult {
  dx: number;
  dy: number;
  guides: SnapGuide[];
  spacing: SpacingGuide[];
  sizes: SizeMatch[];
  distances?: DistanceLabel[];
}

export type HandleKind =
  | "top-left"
  | "top"
  | "top-right"
  | "right"
  | "bottom-right"
  | "bottom"
  | "bottom-left"
  | "left";

export interface Handle {
  kind: HandleKind;
  rect: OrientedBox;
  center: Point;
  visible: boolean;
  cursorAngle: number;
}

export interface RotateZone {
  corner: HandleKind;
  center: Point;
  radius: number;
}

export interface Handles {
  bounds: OrientedBox;
  resize: Handle[];
  rotate: RotateZone[];
}

export interface SelectionBounds {
  aabb: Rect;
  obb: OrientedBox;
  rotation: number;
}

export interface HandleStyle {
  size?: number;
  slop?: number;
  rotateRadius?: number;
  minSideForEdges?: number;
}

export interface HandlesRequest {
  ids: Id[];
  zoom: number;
  style?: HandleStyle;
  point?: Point;
}

export type HandleHit =
  | { type: "resize"; handle: HandleKind }
  | { type: "rotate"; handle: HandleKind };

export interface HandlesResult {
  bounds: SelectionBounds | null;
  handles: Handles | null;
  hit: HandleHit | null;
}

export interface ResizeRequest {
  bounds: OrientedBox;
  handle: HandleKind;
  pointer: Point;
  options?: { keepAspect?: boolean; fromCenter?: boolean };
}

export interface ResizeResult {
  bounds: OrientedBox;
  flipX: boolean;
  flipY: boolean;
}

export interface RotateRequest {
  center: Point;
  start: Point;
  pointer: Point;
  step?: number;
}

export interface MeasureItem {
  text: { text: string; style?: Record<string, unknown> }[];
  style: Record<string, unknown>;
  paragraph: Record<string, unknown>;
  width?: number;
  maxLines?: number;
}

export interface MeasureResult {
  w: number;
  h: number;
  lines: number;
  baseline: number;
}

export interface DescribeRequest {
  pageId?: Id;
  selection?: Id[];
  maxDepth?: number;
  includeHidden?: boolean;
  includeStyles?: boolean;
  detail?: "summary" | "full";
  maxNodes?: number;
  lint?: boolean;
  brand?: unknown;
}

export interface ExportRequest {
  format: "png" | "jpeg" | "jpg" | "webp" | "svg" | "pdf" | "pptx" | "gif";
  /** Page id or `"all"` (PDF / PPTX); default the first page. */
  pageId?: string;
  pageIndex?: number;
  scale?: number;
  dpi?: number;
  quality?: number;
  /** `"page"` (default), `"transparent"` or a color. */
  background?: string;
  region?: Rect;
  timeMs?: number;
  pdf?: {
    bleed?: boolean;
    cropMarks?: boolean;
    cmyk?: boolean;
    flatten?: boolean;
    dpi?: number;
    title?: string;
  };
  svgText?: "text" | "text-no-fonts" | "outlines";
  fps?: number;
  durationMs?: number;
  maxFrames?: number;
  only?: Id[];
  hidden?: Id[];
}

export interface ExportInfo {
  mime: string;
  extension: string;
  pages: number;
  bytes: number;
  missingAssets: Id[];
  missingFonts: string[];
  warnings: string[];
}

export interface ExportResult {
  bytes: Uint8Array;
  info: ExportInfo;
}

export interface FaceSummary {
  family: string;
  weight: number;
  weightRange: [number, number] | null;
  italic: boolean;
  axes: string[];
}

export interface FontInfo {
  faces: FaceSummary[];
}

export interface AssetInfo {
  id: Id;
  kind: "image" | "svg" | "font" | "data";
  width: number | null;
  height: number | null;
  families: string[];
}

// Text editing ------------------------------------------------------------------------------------------------

export interface TextLineInfo {
  start: number;
  end: number;
  top: number;
  height: number;
  baseline: number;
  x: number;
  width: number;
  rtl: boolean;
  endsParagraph: boolean;
}

export interface TextClusterInfo {
  start: number;
  end: number;
  line: number;
  x0: number;
  x1: number;
  rtl: boolean;
}

export interface TextLayoutInfo {
  nodeId: Id;
  /** Runs concatenated; indices are UTF-16 offsets (DOM offsets). */
  text: string;
  length: number;
  width: number;
  height: number;
  /** Box -> page affine `[a, b, c, d, e, f]`. */
  transform: [number, number, number, number, number, number];
  curved: boolean;
  contentTop: number;
  overflows: boolean;
  truncated: boolean;
  lines: TextLineInfo[];
  clusters: TextClusterInfo[];
  paragraphs: { start: number; end: number; rtl: boolean }[];
}

export type Affinity = "upstream" | "downstream";

export type TextMove =
  | "left"
  | "right"
  | "up"
  | "down"
  | "wordLeft"
  | "wordRight"
  | "lineStart"
  | "lineEnd"
  | "docStart"
  | "docEnd"
  | "graphemeLeft"
  | "graphemeRight";

export type TextQuery =
  | { op: "caret"; nodeId: Id; index: number; affinity?: Affinity }
  | { op: "hit"; nodeId: Id; x: number; y: number }
  | { op: "selection"; nodeId: Id; start: number; end: number }
  | { op: "move"; nodeId: Id; index: number; affinity?: Affinity; direction: TextMove; x?: number }
  | { op: "range"; nodeId: Id; index: number; unit: "word" | "line" | "paragraph" };

export interface CaretInfo {
  x: number;
  y: number;
  height: number;
  line: number;
  rtl: boolean;
}

export interface TextQueryResult {
  index: number | null;
  affinity: Affinity | null;
  start: number | null;
  end: number | null;
  caret: CaretInfo | null;
  /** Page-space caret segment `[x0, y0, x1, y1]`. */
  caretPage: [number, number, number, number] | null;
  rects: Rect[];
  /** Page-space selection quads. */
  quads: [Point, Point, Point, Point][];
  transform: [number, number, number, number, number, number];
}

export interface TextOutline {
  d: string;
  fillRule: "nonzero" | "evenodd";
  width: number;
  height: number;
  bounds: Rect | null;
}

// Worker API -------------------------------------------------------------------------------------------------

/** Frame statistics posted after each presented frame. */
export interface FrameStats {
  /** Worker time spent in `render` (build + raster) for this frame. */
  renderMs: number;
  buildMs: number;
  rasterMs: number;
  /** Time spent copying pixels to the canvas. */
  presentMs: number;
  /** Device pixels copied. */
  pixels: number;
  rects: number;
  pending: number;
  full: boolean;
  scrolled: boolean;
  /** `performance.now()` in the worker when the frame was presented. */
  at: number;
  frame: number;
}

export interface EngineEvents {
  frame: FrameStats;
  /** Asset ids the engine needs bytes for (the client resolves them). */
  missingAssets: Id[];
  /** A font finished loading (or failed). */
  font: {
    family: string;
    weight: number;
    italic: boolean;
    ok: boolean;
    source: string;
    error?: string;
  };
  /** An asset could not be fetched or decoded. */
  assetError: { id: Id; message: string };
  /** An asset finished loading. */
  asset: AssetInfo;
  /** Derived geometry changed after fonts loaded (commit `applied` as a system transaction). */
  relayout: EngineApplyResult;
  /** The wasm instance trapped and was re-created from the last good state. */
  recovered: { message: string };
  /** Non-fatal problems. */
  warning: { message: string };
  /** The engine could not be restored after a crash; re-create the client. */
  fatal: { message: string };
}

/** Fonts a design needs (computed on the main thread from the design, see `designFontNeeds`). */
export interface LoadHints {
  fonts: { family: string; weight: number; italic: boolean }[];
  /** All text of the design (picks font subsets). */
  text: string;
  /** Families provided by design font assets. */
  assetFamilies: string[];
}

export interface InitOptions {
  /** OffscreenCanvas transferred from the main thread (worker mode). */
  canvas?: OffscreenCanvas;
  /** URLs of the wasm-bindgen glue and binaries (defaults resolve next to the package). */
  urls?: Partial<EngineUrls>;
  /** 32 random bytes for id generation. */
  seed: Uint8Array;
  render?: RenderOptions;
  fonts?: FontLoaderOptions;
  /** Wait at most this long for a design's fonts before the first frame (ms, default 1500). */
  fontWaitMs?: number;
}

export interface EngineUrls {
  /** `desyn_engine_bg.wasm` (interactive module). */
  engineWasm: string;
  /** `desyn_export.js` glue of the exporters module (PDF / PPTX / GIF). */
  exportGlue: string;
  /** `desyn_export_bg.wasm`. */
  exportWasm: string;
  /** Bundled default fonts: a directory URL (trailing slash) or file name -> URL. */
  fonts: string | Record<string, string>;
}

export interface FontLoaderOptions {
  /** Google Fonts CSS2 endpoint (`false` disables on-demand fonts). */
  googleFonts?: string | false;
  /** Extra family -> URL list (custom / self-hosted fonts). */
  sources?: Record<string, { url: string; weight?: number | [number, number]; italic?: boolean }[]>;
  /** Fetch timeout (ms). */
  timeoutMs?: number;
}

/** Methods the worker exposes. Results are JSON strings where the wasm engine produces JSON (the client parses). */
export interface EngineWorkerApi {
  init(options: InitOptions): Promise<EngineInfo>;
  /** Loads a design. `hints` lets the worker fetch the design's fonts before the first frame. */
  load(designJson: string, hints?: LoadHints): Promise<string>;
  apply(txJson: string, normalize: boolean): Promise<string>;
  preview(txJson: string, normalize: boolean): Promise<string>;
  commitPreview(): Promise<string>;
  cancelPreview(): Promise<boolean>;
  relayout(): Promise<string>;
  snapshot(): Promise<string>;
  setView(view: ViewState): void;
  setRenderOptions(options: RenderOptions): void;
  flush(timeoutMs?: number): Promise<FrameInfo | null>;
  hitTest(req: HitRequest): Promise<string>;
  marquee(req: MarqueeRequest): Promise<string>;
  snap(req: SnapRequest): Promise<string>;
  handles(req: HandlesRequest): Promise<string>;
  resizeBox(req: ResizeRequest): Promise<string>;
  rotationDelta(req: RotateRequest): Promise<number>;
  bounds(ids: Id[]): Promise<string>;
  measure(items: MeasureItem[]): Promise<string>;
  describe(req: DescribeRequest): Promise<string>;
  describeCompact(req: DescribeRequest, maxTokens: number): Promise<string>;
  lint(req: DescribeRequest): Promise<string>;
  export(req: ExportRequest): Promise<ExportResult>;
  setFont(bytes: Uint8Array, family?: string): Promise<string>;
  setAsset(id: Id, bytes: Uint8Array): Promise<string>;
  loadAsset(id: Id, url: string): Promise<string>;
  removeAsset(id: Id): void;
  /** Bytes of a loaded asset (null when the engine has none). */
  assetBytes(id: Id): Promise<Uint8Array | null>;
  /** Characters the document now uses (loads font slices that cover them). */
  noteText(text: string): void;
  textLayout(nodeId: Id): Promise<string>;
  textQuery(query: TextQuery): Promise<string>;
  outlineText(nodeId: Id): Promise<string>;
  /** Renders the current view into a PNG (for previews and tests). */
  capture(): Promise<Uint8Array>;
  dispose(): void;
}

export type { Description, Issue, Op, Transaction };
