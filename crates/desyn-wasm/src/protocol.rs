//! JSON shapes exchanged with the host (camelCase, mirrored by `packages/engine/src/protocol.ts`).

use desyn_core::geometry::{OrientedBox, Point, Rect};
use desyn_core::hit::{
    HandleKind, Handles, HitOptions, MarqueeMode, ResizeOptions, SelectionBounds,
};
use desyn_core::model::Id;
use desyn_core::snap::{ResizeEdges, SnapOptions};
use serde::{Deserialize, Serialize};

/// Viewport of a render request: page point `(x, y)` is drawn at the top-left device pixel.
#[derive(Debug, Clone, Copy, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewportSpec {
    /// Page x at the left edge (design px).
    pub x: f64,
    /// Page y at the top edge.
    pub y: f64,
    /// CSS px per design px.
    pub zoom: f64,
    /// Output width in device pixels.
    pub width: u32,
    /// Output height in device pixels.
    pub height: u32,
    /// Device pixels per CSS px.
    #[serde(default = "one")]
    pub dpr: f64,
}

fn one() -> f64 {
    1.0
}

/// A render request.
#[derive(Debug, Clone, PartialEq, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct RenderRequest {
    /// Viewport (required).
    pub viewport: Option<ViewportSpec>,
    /// Page to show (default: the first page).
    pub page_id: Option<Id>,
    /// Pasteboard color behind the page (`#rrggbb` / `#rrggbbaa`); `None` = transparent.
    pub background: Option<String>,
    /// Draw a soft shadow around the page on the pasteboard.
    pub page_shadow: bool,
    /// Nodes not to draw (e.g. text edited in a DOM overlay).
    pub hidden: Vec<Id>,
    /// Draw invisible nodes.
    pub show_hidden: bool,
    /// Animation time (ms) for previews; `None` = designed state.
    pub time_ms: Option<f64>,
    /// Time budget for this call (ms). With a budget, large invalid areas are rendered in tiles, nearest to the
    /// viewport center first, and the rest stays pending for the next call (progressive rendering).
    pub budget_ms: Option<f64>,
    /// Redraw the whole viewport.
    pub force: bool,
}

/// What a render call did.
#[derive(Debug, Clone, PartialEq, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct FrameInfo {
    /// Frame width (device px).
    pub width: u32,
    /// Frame height (device px).
    pub height: u32,
    /// Page shown.
    pub page_id: Option<Id>,
    /// Device rectangles `[x, y, w, h]` updated by this call (copy these to the canvas).
    pub rects: Vec<[i32; 4]>,
    /// The frame content moved by `[dx, dy]` device px before `rects` were drawn (shift the canvas first).
    pub scroll: Option<[i32; 2]>,
    /// Invalid rectangles still pending (call `render` again on the next frame).
    pub pending: usize,
    /// The whole frame was invalidated (zoom, resize, page or option change).
    pub full: bool,
    /// A display list was (re)built.
    pub built: bool,
    /// Milliseconds spent building the display list.
    pub build_ms: f64,
    /// Milliseconds spent rasterizing.
    pub raster_ms: f64,
    /// Asset ids the page references but has no bytes for.
    pub missing_assets: Vec<Id>,
    /// Fonts the text engine asked for.
    pub font_requests: Vec<FontRequestInfo>,
    /// Non-fatal build warnings (undecodable assets, bad path data).
    pub warnings: Vec<String>,
}

/// A font the text engine needs (fetch it, then `setFont`).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FontRequestInfo {
    /// Family name.
    pub family: String,
    /// Weight (100..900, variable values allowed).
    pub weight: f32,
    /// Italic.
    pub italic: bool,
    /// `family` (named by the text), `fallback` (script coverage) or `emoji`.
    pub reason: &'static str,
}

/// Requests that accumulated outside render calls (apply with normalization, measure, describe, text queries).
#[derive(Debug, Clone, PartialEq, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PendingRequests {
    /// Missing asset ids.
    pub missing_assets: Vec<Id>,
    /// Missing fonts.
    pub font_requests: Vec<FontRequestInfo>,
}

/// Summary returned by `load`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadInfo {
    /// Design id.
    pub id: Id,
    /// Pages in order.
    pub pages: Vec<PageInfo>,
    /// Number of nodes.
    pub node_count: usize,
    /// Invariant / schema violations (at most 50; the design still loads).
    pub violations: Vec<String>,
}

/// A page.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PageInfo {
    /// Id.
    pub id: Id,
    /// Name.
    pub name: String,
    /// Width (design px).
    pub width: f64,
    /// Height (design px).
    pub height: f64,
}

/// Hit test request (page coordinates).
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HitRequest {
    /// Page (default: the first page).
    #[serde(default)]
    pub page_id: Option<Id>,
    /// Point x.
    pub x: f64,
    /// Point y.
    pub y: f64,
    /// Options (`deep`, `includeLocked`, `includeHidden`, `tolerance` in design px).
    #[serde(default)]
    pub options: HitOptions,
    /// Return every node under the point (topmost first) instead of the hit path.
    #[serde(default)]
    pub all: bool,
}

/// Hit test answer.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HitResult {
    /// Top-level page child that was hit (or the deepest node with `deep`).
    pub id: Option<Id>,
    /// Path from the page child down to the deepest hit node (empty on a miss).
    pub path: Vec<Id>,
    /// With `all`: every node under the point, topmost first.
    pub all: Vec<Id>,
}

/// Marquee request.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarqueeRequest {
    /// Page (default: the first page).
    #[serde(default)]
    pub page_id: Option<Id>,
    /// Rectangle in page coordinates.
    pub rect: Rect,
    /// `contain` (default) or `intersect`.
    #[serde(default = "contain")]
    pub mode: MarqueeMode,
    /// Hit options (`deep`, `includeLocked`, `includeHidden`).
    #[serde(default)]
    pub options: HitOptions,
}

fn contain() -> MarqueeMode {
    MarqueeMode::Contain
}

/// Snap request.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapRequest {
    /// Page (default: the page of the first moving node, else the first page).
    #[serde(default)]
    pub page_id: Option<Id>,
    /// Moving nodes (never snap targets).
    #[serde(default)]
    pub ids: Vec<Id>,
    /// Bounds of the moving selection after the raw gesture (page coordinates).
    pub rect: Rect,
    /// Resize edges; absent = a move.
    #[serde(default)]
    pub edges: Option<ResizeEdges>,
    /// Sources and threshold (design px).
    #[serde(default)]
    pub options: SnapOptions,
    /// Also return distance labels to the nearest neighbours.
    #[serde(default)]
    pub distances: bool,
}

/// Handles request.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HandlesRequest {
    /// Selected nodes.
    pub ids: Vec<Id>,
    /// Screen px per design px.
    pub zoom: f64,
    /// Handle sizing (screen px).
    #[serde(default)]
    pub style: desyn_core::hit::HandleStyle,
    /// Optional pointer (page coordinates) to test against the handles.
    #[serde(default)]
    pub point: Option<Point>,
}

/// Handles answer.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HandlesResult {
    /// Selection bounds (`None` for an empty / unknown selection).
    pub bounds: Option<SelectionBounds>,
    /// Handle geometry.
    pub handles: Option<Handles>,
    /// Handle under `point`.
    pub hit: Option<desyn_core::hit::HandleHit>,
}

/// Resize math request.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResizeRequest {
    /// Box at gesture start.
    pub bounds: OrientedBox,
    /// Dragged handle.
    pub handle: HandleKind,
    /// Pointer (page coordinates).
    pub pointer: Point,
    /// Modifiers.
    #[serde(default)]
    pub options: ResizeOptions,
}

/// Rotation math request.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RotateRequest {
    /// Rotation center (page coordinates).
    pub center: Point,
    /// Pointer at gesture start.
    pub start: Point,
    /// Pointer now.
    pub pointer: Point,
    /// Snap step in degrees (e.g. 15 with shift).
    #[serde(default)]
    pub step: Option<f64>,
}

/// One text measuring item (DocHost `MeasureItem`).
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeasureItem {
    /// Runs.
    pub text: Vec<desyn_core::model::TextRun>,
    /// Default style.
    pub style: desyn_core::model::TextStyle,
    /// Paragraph style.
    pub paragraph: desyn_core::model::ParagraphStyle,
    /// Wrap width; absent = no wrapping.
    #[serde(default)]
    pub width: Option<f64>,
    /// Maximum lines.
    #[serde(default)]
    pub max_lines: Option<u32>,
}

/// Measured size (DocHost `MeasureResult`).
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeasureResult {
    /// Width.
    pub w: f64,
    /// Height.
    pub h: f64,
    /// Line count.
    pub lines: u32,
    /// First baseline from the top.
    pub baseline: f64,
}

/// Result of `setAsset`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetInfo {
    /// Asset id.
    pub id: Id,
    /// `image`, `svg`, `font` or `data` (bytes kept, not decoded).
    pub kind: &'static str,
    /// Pixel width (images).
    pub width: Option<u32>,
    /// Pixel height (images).
    pub height: Option<u32>,
    /// Font families registered (fonts).
    pub families: Vec<String>,
}

/// Result of `setFont`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FontInfo {
    /// Faces added.
    pub faces: Vec<FaceSummary>,
}

/// A registered face.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FaceSummary {
    /// Family.
    pub family: String,
    /// Weight (variable fonts: default instance).
    pub weight: f32,
    /// Weight range of variable fonts.
    pub weight_range: Option<(f32, f32)>,
    /// Italic or oblique.
    pub italic: bool,
    /// Variable axes tags.
    pub axes: Vec<String>,
}

/// Export metadata (bytes are returned separately).
#[derive(Debug, Clone, PartialEq, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ExportInfo {
    /// MIME type.
    pub mime: String,
    /// File extension.
    pub extension: String,
    /// Pages included.
    pub pages: usize,
    /// Byte length.
    pub bytes: usize,
    /// Assets without bytes.
    pub missing_assets: Vec<Id>,
    /// Fonts that were not available.
    pub missing_fonts: Vec<String>,
    /// Non-fatal problems.
    pub warnings: Vec<String>,
}

/// Export options (worker `/v1/render` body without the design).
#[derive(Debug, Clone, PartialEq, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ExportRequest {
    /// `png`, `jpeg`, `webp`, `svg`, `pdf`, `pptx`, `gif`.
    pub format: String,
    /// Page id, `"all"`, or absent for the first page.
    pub page_id: Option<String>,
    /// 0-based page index (alternative to `pageId`).
    pub page_index: Option<usize>,
    /// Device px per design px (raster formats).
    pub scale: Option<f64>,
    /// DPI metadata (PNG / JPEG).
    pub dpi: Option<f64>,
    /// JPEG / WebP quality (1..100).
    pub quality: Option<u8>,
    /// `"page"` (default), `"transparent"` or a color.
    pub background: Option<String>,
    /// Page-space region (raster / SVG).
    pub region: Option<Rect>,
    /// Animation time for still formats.
    pub time_ms: Option<f64>,
    /// PDF options.
    pub pdf: Option<PdfRequest>,
    /// SVG text mode: `"text"` (default, fonts embedded), `"text-no-fonts"` or `"outlines"`.
    pub svg_text: Option<String>,
    /// GIF / frames: frames per second.
    pub fps: Option<f64>,
    /// GIF / frames: duration.
    pub duration_ms: Option<f64>,
    /// GIF / frames: frame cap.
    pub max_frames: Option<usize>,
    /// Export only these subtrees.
    pub only: Option<Vec<Id>>,
    /// Never export these subtrees.
    pub hidden: Vec<Id>,
}

/// PDF options.
#[derive(Debug, Clone, PartialEq, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct PdfRequest {
    /// Include the bleed.
    pub bleed: bool,
    /// Crop marks.
    pub crop_marks: bool,
    /// DeviceCMYK colors.
    pub cmyk: bool,
    /// Flatten pages to images.
    pub flatten: bool,
    /// Rasterized fallback resolution.
    pub dpi: Option<f64>,
    /// Document title.
    pub title: Option<String>,
}

/// Text query (all indices are UTF-16 code units, coordinates in page space).
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum TextQuery {
    /// Caret geometry at an index.
    Caret {
        /// Text node.
        node_id: Id,
        /// Index.
        index: usize,
        /// `upstream` sticks to the end of the earlier line at soft wraps.
        #[serde(default)]
        affinity: desyn_text::Affinity,
    },
    /// Index under a page point.
    Hit {
        /// Text node.
        node_id: Id,
        /// Page x.
        x: f64,
        /// Page y.
        y: f64,
    },
    /// Selection rectangles of a range.
    Selection {
        /// Text node.
        node_id: Id,
        /// Start.
        start: usize,
        /// End.
        end: usize,
    },
    /// Caret movement.
    Move {
        /// Text node.
        node_id: Id,
        /// From.
        index: usize,
        /// Affinity of `index`.
        #[serde(default)]
        affinity: desyn_text::Affinity,
        /// `left`, `right`, `up`, `down`, `wordLeft`, `wordRight`, `lineStart`, `lineEnd`, `docStart`, `docEnd`.
        direction: String,
        /// Goal x (box coordinates) for vertical moves.
        #[serde(default)]
        x: Option<f64>,
    },
    /// Word, line or paragraph range around an index.
    Range {
        /// Text node.
        node_id: Id,
        /// Index.
        index: usize,
        /// `word`, `line` or `paragraph`.
        unit: String,
    },
}
