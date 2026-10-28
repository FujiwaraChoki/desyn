// DocHost: the agent's view of a live design. Implementations: WasmHost (browser, @desyn/engine), WorkerHost
// (Convex action + render worker) and MemoryHost (tests, offline evals; ./memory-host). Every edit goes through
// `apply(tx)` so it is one undo step and visible to collaborators.
import type {
  ApplyResult,
  AssetKind,
  AssetRef,
  AssetSource,
  Color,
  Description,
  Design,
  Id,
  ParagraphStyle,
  TextRun,
  TextStyle,
  Transaction,
} from "@desyn/schema";

export interface DescribeOptions {
  pageId?: Id;
  selection?: Id[];
  maxDepth?: number;
  includeStyles?: boolean;
}

export interface RenderRegion {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface RenderOptions {
  pageId?: Id;
  /** Page-coordinate region; default the whole page. */
  region?: RenderRegion;
  /** Pixel scale; when omitted the host picks one so the longest edge fits `maxSize`. */
  scale?: number;
  /** Longest edge in pixels when `scale` is omitted (default 1024; previews for models stay small). */
  maxSize?: number;
  background?: Color | "transparent";
}

export interface RenderResult {
  bytes: Uint8Array;
  mime: "image/png" | "image/jpeg" | "image/webp";
  width: number;
  height: number;
}

export interface MeasureItem {
  text: TextRun[];
  style: TextStyle;
  paragraph: ParagraphStyle;
  /** Wrap width in px; omitted = single line, no wrapping. */
  width?: number;
}

export interface MeasureResult {
  w: number;
  h: number;
  lines: number;
}

export interface AssetUploadMeta {
  name?: string;
  kind?: AssetKind;
  source?: AssetSource;
  width?: number;
  height?: number;
  durationMs?: number;
  attribution?: AssetRef["attribution"];
  ai?: AssetRef["ai"];
}

export interface AssetBytes {
  bytes: Uint8Array;
  mime: string;
}

export interface HostAssets {
  /** Stores bytes (S3 via Convex, IndexedDB/upload in the browser) and returns the AssetRef to put in the design. */
  upload(bytes: Uint8Array, mime: string, meta?: AssetUploadMeta): Promise<AssetRef>;
  /** Bytes of an asset referenced by the design (needed to edit existing images). */
  read(assetId: Id): Promise<AssetBytes>;
}

export type BrandColorRole =
  | "primary"
  | "secondary"
  | "accent"
  | "background"
  | "surface"
  | "text"
  | "neutral";
export type BrandFontRole = "heading" | "body" | "accent";
export type BrandLogoVariant = "primary" | "mark" | "wordmark" | "light" | "dark" | "mono";

/** Brand kit as the AI sees it (mirrors the Convex `brandKits` table). */
export interface BrandKit {
  id?: string;
  name: string;
  colors: { value: Color; name?: string; role?: BrandColorRole }[];
  fonts: { family: string; role?: BrandFontRole; weight?: number }[];
  logos: {
    assetId: Id;
    name?: string;
    variant?: BrandLogoVariant;
    width?: number;
    height?: number;
    mime?: string;
  }[];
  voice?: string;
  rules?: string[];
  guidelines?: string;
}

export interface DocHost {
  /** Semantic description (docs/DOCUMENT_MODEL.md §7) of a page. */
  describe(options?: DescribeOptions): Promise<Description>;
  /** Raster preview of a page or region. */
  render(options?: RenderOptions): Promise<RenderResult>;
  /** Text measurement with the same shaper the renderer uses. */
  measure(items: MeasureItem[]): Promise<MeasureResult[]>;
  /** Applies a transaction (with layout normalization where the host supports it). */
  apply(tx: Transaction): Promise<ApplyResult>;
  /** Current design state (after every applied transaction). */
  getDesign(): Design;
  /** Currently selected node ids. */
  readonly selection: Id[];
  /** Page the user is looking at; defaults to the first page. */
  readonly page?: Id;
  readonly assets: HostAssets;
  readonly brand?: BrandKit;
}
