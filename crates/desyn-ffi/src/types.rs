//! Records and enums that cross the FFI boundary.
//!
//! Geometry is in design px (page coordinates unless a field says otherwise); pixel rectangles are device pixels
//! of a rendered frame. Design content (designs, transactions, ops, describe output) crosses as JSON strings,
//! exactly as it does on the Convex wire (`convex/lib/designs_wire.ts`), so the app never re-encodes it.

/// A point.
#[derive(Debug, Clone, Copy, PartialEq, uniffi::Record)]
pub struct DesignPoint {
    /// X.
    pub x: f64,
    /// Y.
    pub y: f64,
}

/// An axis-aligned rectangle.
#[derive(Debug, Clone, Copy, PartialEq, uniffi::Record)]
pub struct DesignRect {
    /// Left.
    pub x: f64,
    /// Top.
    pub y: f64,
    /// Width.
    pub width: f64,
    /// Height.
    pub height: f64,
}

/// A rectangle of device pixels in a rendered frame.
#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Record)]
pub struct PixelRect {
    /// Left pixel column.
    pub x: u32,
    /// Top pixel row.
    pub y: u32,
    /// Width in pixels.
    pub width: u32,
    /// Height in pixels.
    pub height: u32,
}

/// 2D affine transform `[a c e; b d f; 0 0 1]` (same layout as `CGAffineTransform`).
#[derive(Debug, Clone, Copy, PartialEq, uniffi::Record)]
pub struct Affine {
    /// m11.
    pub a: f64,
    /// m12.
    pub b: f64,
    /// m21.
    pub c: f64,
    /// m22.
    pub d: f64,
    /// Translation x.
    pub tx: f64,
    /// Translation y.
    pub ty: f64,
}

/// A rotated box: `transform` maps the local box `(0, 0)..(width, height)` to page coordinates.
#[derive(Debug, Clone, Copy, PartialEq, uniffi::Record)]
pub struct OrientedBox {
    /// Local box to page.
    pub transform: Affine,
    /// Local width.
    pub width: f64,
    /// Local height.
    pub height: f64,
}

/// The visible part of a page: page point `(x, y)` is drawn at the top-left device pixel.
#[derive(Debug, Clone, Copy, PartialEq, uniffi::Record)]
pub struct Viewport {
    /// Page x at the left edge (design px).
    pub x: f64,
    /// Page y at the top edge.
    pub y: f64,
    /// Points per design px.
    pub zoom: f64,
    /// Frame width in device pixels.
    pub width: u32,
    /// Frame height in device pixels.
    pub height: u32,
    /// Device pixels per point (`UIScreen.scale`).
    pub device_scale: f64,
}

/// What to draw into the interactive frame.
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct RenderRequest {
    /// Page to draw (`None` = first page).
    #[uniffi(default = None)]
    pub page_id: Option<String>,
    /// Visible region and output size.
    pub viewport: Viewport,
    /// Canvas color behind the page as `#rrggbb` / `#rrggbbaa` (`None` = transparent).
    #[uniffi(default = None)]
    pub background: Option<String>,
    /// Subtrees not drawn (e.g. the text node under a native text-editing overlay).
    #[uniffi(default = [])]
    pub hidden: Vec<String>,
    /// Draw nodes with `visible: false` too.
    #[uniffi(default = false)]
    pub show_hidden: bool,
    /// Animation time in ms (`None` = designed state).
    #[uniffi(default = None)]
    pub time_ms: Option<f64>,
    /// Extend the page clip by its print bleed.
    #[uniffi(default = false)]
    pub bleed: bool,
    /// Rasterize the whole frame even when only part of it changed.
    #[uniffi(default = false)]
    pub full_redraw: bool,
}

/// A clickable link area in page coordinates.
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct LinkArea {
    /// Bounds of the link area.
    pub rect: DesignRect,
    /// External URL, when the link points outside the design.
    pub url: Option<String>,
    /// Target page, for `page:<id>` links.
    pub page_id: Option<String>,
}

/// Facts about a rendered frame.
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct FrameInfo {
    /// Number of this interactive frame (increasing; `0` for one-shot page renders). `damage` is relative to frame
    /// `sequence - 1` unless `full`.
    pub sequence: u64,
    /// Page that was drawn.
    pub page_id: String,
    /// Frame width in pixels.
    pub width: u32,
    /// Frame height in pixels.
    pub height: u32,
    /// Pixels that changed since frame `sequence - 1` (the whole frame after a full redraw).
    pub damage: Vec<PixelRect>,
    /// The whole frame was rasterized (viewport, page or background changed, or `full_redraw`).
    pub full: bool,
    /// Asset ids without bytes: fetch them, call `set_asset`, render again.
    pub missing_assets: Vec<String>,
    /// Font families requested by text but not registered (see `take_font_requests`).
    pub missing_fonts: Vec<String>,
    /// Non-fatal problems (undecodable assets, unparsable path data).
    pub warnings: Vec<String>,
    /// Links on the page (presenter / share views).
    pub links: Vec<LinkArea>,
}

/// Premultiplied RGBA8 pixels (byte order R, G, B, A; rows `stride` bytes apart).
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct RenderedFrame {
    /// Width in pixels.
    pub width: u32,
    /// Height in pixels.
    pub height: u32,
    /// Bytes per row.
    pub stride: u32,
    /// `stride * height` bytes.
    pub pixels: Vec<u8>,
    /// Damage, missing assets / fonts, links.
    pub info: FrameInfo,
}

/// One-shot render of a page (thumbnails, previews, share sheets).
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct PageImageRequest {
    /// Page (`None` = first page).
    #[uniffi(default = None)]
    pub page_id: Option<String>,
    /// Device pixels per design px.
    #[uniffi(default = 1.0)]
    pub scale: f64,
    /// Page-space region (`None` = the page).
    #[uniffi(default = None)]
    pub region: Option<DesignRect>,
    /// Skip the page background.
    #[uniffi(default = false)]
    pub transparent: bool,
    /// Color painted under everything (`#rrggbb[aa]`).
    #[uniffi(default = None)]
    pub background: Option<String>,
    /// Animation time.
    #[uniffi(default = None)]
    pub time_ms: Option<f64>,
    /// Include the print bleed.
    #[uniffi(default = false)]
    pub bleed: bool,
    /// Render only these subtrees.
    #[uniffi(default = None)]
    pub only: Option<Vec<String>>,
    /// Never render these subtrees.
    #[uniffi(default = [])]
    pub hidden: Vec<String>,
}

/// Result of loading a design.
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct LoadResult {
    /// Pages in order.
    pub pages: Vec<PageInfo>,
    /// Derived-geometry updates computed with real text metrics when loading with `normalize` (JSON `Op[]`;
    /// `[]` when nothing changed). Commit them as one `system` transaction so other clients converge.
    pub layout_ops_json: String,
    /// Invariant violations found in the document (`code: message`); the engine tolerates them.
    pub violations: Vec<String>,
    /// Engine revision after loading.
    pub revision: u64,
}

/// A page.
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct PageInfo {
    /// Page id.
    pub id: String,
    /// Page name.
    pub name: String,
    /// Index among the pages.
    pub index: u32,
    /// Width in design px.
    pub width: f64,
    /// Height in design px.
    pub height: f64,
    /// Print bleed in design px.
    pub bleed: f64,
}

/// An op of a transaction that did not apply.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct DroppedOp {
    /// Index in `tx.ops`.
    pub index: u32,
    /// Reason (`missing-node`, `cycle`, ... see DOCUMENT_MODEL section 5).
    pub reason: String,
}

/// Result of applying a transaction.
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct ApplyOutcome {
    /// The ops that took effect, in normal form, including derived-geometry updates when normalizing (JSON
    /// `Op[]`). Commit these (not the raw ops) when the transaction was applied with `normalize`.
    pub applied_json: String,
    /// Transaction that restores the previous state exactly (JSON `Transaction`); apply it with `normalize: false`.
    pub inverse_json: String,
    /// Ops that were dropped.
    pub dropped: Vec<DroppedOp>,
    /// Engine revision after applying.
    pub revision: u64,
}

/// Derived-geometry changes from a full relayout.
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct LayoutOutcome {
    /// Forward `update` ops (JSON `Op[]`, `[]` when nothing moved).
    pub ops_json: String,
    /// Ops restoring the previous geometry (JSON `Op[]`).
    pub inverse_ops_json: String,
}

/// Options for hit testing and marquee selection.
#[derive(Debug, Clone, Copy, PartialEq, uniffi::Record)]
pub struct HitOptions {
    /// Return the deepest node instead of the page's top-level child containing it.
    #[uniffi(default = false)]
    pub deep: bool,
    /// Consider locked nodes.
    #[uniffi(default = false)]
    pub include_locked: bool,
    /// Consider hidden nodes.
    #[uniffi(default = false)]
    pub include_hidden: bool,
    /// Extra slop in design px (divide screen slop by the zoom).
    #[uniffi(default = 0.0)]
    pub tolerance: f64,
}

/// Marquee selection rule.
#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum MarqueeMode {
    /// Nodes fully inside the rectangle.
    Contain,
    /// Nodes touching the rectangle.
    Intersect,
}

/// Bounds of a selection.
#[derive(Debug, Clone, Copy, PartialEq, uniffi::Record)]
pub struct SelectionBounds {
    /// Axis-aligned bounds of everything selected.
    pub aabb: DesignRect,
    /// Oriented box (rotated when every node shares one rotation).
    pub obb: OrientedBox,
    /// Rotation of the oriented box in degrees.
    pub rotation: f64,
}

/// A resize handle, clockwise from top-left.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, uniffi::Enum)]
pub enum HandleKind {
    /// Top-left corner.
    TopLeft,
    /// Top edge.
    Top,
    /// Top-right corner.
    TopRight,
    /// Right edge.
    Right,
    /// Bottom-right corner.
    BottomRight,
    /// Bottom edge.
    Bottom,
    /// Bottom-left corner.
    BottomLeft,
    /// Left edge.
    Left,
}

/// Size of handles on screen (points).
#[derive(Debug, Clone, Copy, PartialEq, uniffi::Record)]
pub struct HandleStyle {
    /// ResizeHandle square size.
    #[uniffi(default = 8.0)]
    pub size: f64,
    /// Extra hit slop around each handle (use ~14 for touch).
    #[uniffi(default = 4.0)]
    pub slop: f64,
    /// Rotate zone radius outside the corners.
    #[uniffi(default = 12.0)]
    pub rotate_radius: f64,
    /// Edge handles hide when the selection is shorter than this on screen.
    #[uniffi(default = 24.0)]
    pub min_side_for_edges: f64,
}

/// A resize handle.
#[derive(Debug, Clone, Copy, PartialEq, uniffi::Record)]
pub struct ResizeHandle {
    /// Which handle.
    pub kind: HandleKind,
    /// Center in page coordinates.
    pub center: DesignPoint,
    /// Hit / draw square (oriented with the selection).
    pub rect: OrientedBox,
    /// Cursor angle in degrees (for resize cursors / hover effects).
    pub cursor_angle: f64,
    /// False for edge handles of small selections.
    pub visible: bool,
}

/// A rotate zone outside a corner.
#[derive(Debug, Clone, Copy, PartialEq, uniffi::Record)]
pub struct RotateZone {
    /// The corner it belongs to.
    pub corner: HandleKind,
    /// Center in page coordinates.
    pub center: DesignPoint,
    /// Radius in design px.
    pub radius: f64,
}

/// Transform handles of a selection.
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct Handles {
    /// Selection box.
    pub bounds: OrientedBox,
    /// Resize handles.
    pub resize: Vec<ResizeHandle>,
    /// Rotate zones.
    pub rotate: Vec<RotateZone>,
}

/// What a point on the handles hits.
#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum HandleHit {
    /// A resize handle.
    Resize {
        /// ResizeHandle.
        kind: HandleKind,
    },
    /// A rotate zone.
    Rotate {
        /// Corner of the zone.
        corner: HandleKind,
    },
}

/// Resize modifiers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Record)]
pub struct ResizeOptions {
    /// Keep the aspect ratio.
    #[uniffi(default = false)]
    pub keep_aspect: bool,
    /// Resize symmetrically about the center.
    #[uniffi(default = false)]
    pub from_center: bool,
}

/// A resized box.
#[derive(Debug, Clone, Copy, PartialEq, uniffi::Record)]
pub struct ResizeResult {
    /// New box (pass it to `transform_selection` as `to`).
    pub bounds: OrientedBox,
    /// The drag crossed the opposite edge horizontally.
    pub flip_x: bool,
    /// The drag crossed the opposite edge vertically.
    pub flip_y: bool,
}

/// Snap axis.
#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum SnapAxis {
    /// Vertical lines (x positions) / widths.
    X,
    /// Horizontal lines (y positions) / heights.
    Y,
}

/// What a snap line came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum SnapKind {
    /// Another object's edge.
    Edge,
    /// Another object's center.
    Center,
    /// A page edge.
    PageEdge,
    /// The page center.
    PageCenter,
    /// A ruler guide.
    Guide,
    /// The layout grid.
    Grid,
}

/// Which snap sources are active.
#[derive(Debug, Clone, Copy, PartialEq, uniffi::Record)]
pub struct SnapOptions {
    /// Maximum snap distance in design px (screen distance divided by the zoom).
    #[uniffi(default = 6.0)]
    pub threshold: f64,
    /// Other objects.
    #[uniffi(default = true)]
    pub objects: bool,
    /// Page edges and center.
    #[uniffi(default = true)]
    pub page: bool,
    /// Ruler guides.
    #[uniffi(default = true)]
    pub guides: bool,
    /// Layout grid.
    #[uniffi(default = true)]
    pub grid: bool,
    /// Equal spacing.
    #[uniffi(default = true)]
    pub spacing: bool,
}

/// Edges a resize gesture moves.
#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Record)]
pub struct ResizeEdges {
    /// Left edge.
    pub left: bool,
    /// Right edge.
    pub right: bool,
    /// Top edge.
    pub top: bool,
    /// Bottom edge.
    pub bottom: bool,
}

/// An alignment line to draw.
#[derive(Debug, Clone, Copy, PartialEq, uniffi::Record)]
pub struct SnapGuide {
    /// `X` = vertical line at x = `pos`.
    pub axis: SnapAxis,
    /// Line position.
    pub pos: f64,
    /// Extent along the line: start.
    pub from: f64,
    /// Extent along the line: end.
    pub to: f64,
    /// Source.
    pub kind: SnapKind,
}

/// One equal gap.
#[derive(Debug, Clone, Copy, PartialEq, uniffi::Record)]
pub struct SpacingSegment {
    /// Start along the axis.
    pub start: f64,
    /// End along the axis.
    pub end: f64,
    /// Cross-axis position to draw at.
    pub cross: f64,
}

/// Equal-spacing indicator.
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct SpacingGuide {
    /// Axis the gaps are measured along.
    pub axis: SnapAxis,
    /// Gap size.
    pub gap: f64,
    /// Gaps that share the size.
    pub segments: Vec<SpacingSegment>,
}

/// A width / height match.
#[derive(Debug, Clone, Copy, PartialEq, uniffi::Record)]
pub struct SizeMatch {
    /// `X` = width, `Y` = height.
    pub axis: SnapAxis,
    /// Matched size.
    pub size: f64,
    /// Bounds of the matching object.
    pub with: DesignRect,
}

/// Result of a snap query.
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct SnapResult {
    /// Correction to add to the gesture in x.
    pub dx: f64,
    /// Correction to add in y.
    pub dy: f64,
    /// Alignment lines (after applying the correction).
    pub guides: Vec<SnapGuide>,
    /// Equal-spacing indicators.
    pub spacing: Vec<SpacingGuide>,
    /// Size matches (resize only).
    pub sizes: Vec<SizeMatch>,
}

/// A distance label between the moving box and a neighbor.
#[derive(Debug, Clone, Copy, PartialEq, uniffi::Record)]
pub struct DistanceLabel {
    /// Start of the measured segment.
    pub from: DesignPoint,
    /// End of the measured segment.
    pub to: DesignPoint,
    /// Distance in design px.
    pub value: f64,
}

/// Measured text size.
#[derive(Debug, Clone, Copy, PartialEq, uniffi::Record)]
pub struct TextSize {
    /// Width in design px.
    pub width: f64,
    /// Height.
    pub height: f64,
    /// Line count.
    pub lines: u32,
    /// First baseline from the top.
    pub baseline: f64,
}

/// Which side of a soft line break a caret sticks to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum TextAffinity {
    /// End of the earlier line.
    Upstream,
    /// Start of the later line.
    Downstream,
}

/// A caret position. `index` counts UTF-16 code units (`NSString` / `UITextInput` offsets).
#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Record)]
pub struct TextPosition {
    /// UTF-16 offset into the node's text.
    pub index: u32,
    /// Line-break affinity.
    pub affinity: TextAffinity,
}

/// A range of UTF-16 offsets.
#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Record)]
pub struct TextRange {
    /// Start (inclusive).
    pub start: u32,
    /// End (exclusive).
    pub end: u32,
}

/// Caret bar in box-local coordinates.
#[derive(Debug, Clone, Copy, PartialEq, uniffi::Record)]
pub struct CaretRect {
    /// x of the bar.
    pub x: f64,
    /// Top.
    pub y: f64,
    /// Height.
    pub height: f64,
    /// Line index.
    pub line: u32,
    /// The caret is in right-to-left text.
    pub rtl: bool,
}

/// A laid out line in box-local coordinates.
#[derive(Debug, Clone, Copy, PartialEq, uniffi::Record)]
pub struct TextLine {
    /// Text of the line (UTF-16, including trailing spaces, excluding the paragraph separator).
    pub range: TextRange,
    /// Paragraph index.
    pub paragraph: u32,
    /// Top of the line box.
    pub top: f64,
    /// Line box height.
    pub height: f64,
    /// Baseline y.
    pub baseline: f64,
    /// Left edge of the visible content.
    pub x: f64,
    /// Width of the visible content.
    pub width: f64,
    /// Right-to-left paragraph.
    pub rtl: bool,
    /// Last line of its paragraph.
    pub ends_paragraph: bool,
    /// Truncated with an ellipsis.
    pub ellipsis: bool,
}

/// Layout of a text node, for native text editing overlays.
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct TextLayout {
    /// Node id.
    pub node_id: String,
    /// The node's text (runs concatenated; `\n` separates paragraphs).
    pub text: String,
    /// Length in UTF-16 code units.
    pub length: u32,
    /// Box-local coordinates to page coordinates (rotation, flips and ancestors included).
    pub transform: Affine,
    /// Box width.
    pub width: f64,
    /// Box height.
    pub height: f64,
    /// Widest line including indents and list gutters.
    pub content_width: f64,
    /// Height of all lines.
    pub content_height: f64,
    /// Vertical-alignment offset of the content (negative when it overflows).
    pub content_top: f64,
    /// First baseline from the box top.
    pub first_baseline: f64,
    /// Lines.
    pub lines: Vec<TextLine>,
    /// Some text was cut by `maxLines`.
    pub truncated: bool,
    /// Content is taller than a fixed box.
    pub overflows: bool,
}

/// A text node converted to outlines ("convert to paths"): glyphs with synthetic bold / italic baked in,
/// underlines and strikethroughs, text on an arc placed along it.
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct TextOutline {
    /// SVG path data in the node's box coordinates (a `PathNode.paths[].d` for a node of the same box).
    pub d: String,
    /// Fill rule to draw it with (`nonzero`).
    pub fill_rule: String,
    /// Box width.
    pub width: f64,
    /// Box height.
    pub height: f64,
    /// Bounds of the outline in box coordinates (`None` for text without visible glyphs).
    pub bounds: Option<DesignRect>,
}

/// Caret movements.
#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum TextMovement {
    /// One grapheme towards the left edge (bidi-aware).
    Left,
    /// One grapheme towards the right edge (bidi-aware).
    Right,
    /// One line up (keeps `x`).
    Up,
    /// One line down (keeps `x`).
    Down,
    /// Next grapheme in logical order.
    GraphemeForward,
    /// Previous grapheme in logical order.
    GraphemeBackward,
    /// Next word boundary.
    WordForward,
    /// Previous word boundary.
    WordBackward,
    /// Start of the visual line.
    LineStart,
    /// End of the visual line.
    LineEnd,
    /// Start of the paragraph.
    ParagraphStart,
    /// End of the paragraph.
    ParagraphEnd,
}

/// Why the text engine needs a font.
#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum FontRequestReason {
    /// The text asks for this family by name.
    Family,
    /// Fallback family for a script no registered font covers.
    Fallback,
    /// An emoji no registered font covers.
    Emoji,
}

/// A font the text engine needs (fetch it, then `set_font`).
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct FontRequest {
    /// Family name (Google Fonts name for fallbacks).
    pub family: String,
    /// Requested weight.
    pub weight: f32,
    /// Requested italic.
    pub italic: bool,
    /// Why.
    pub reason: FontRequestReason,
}

/// A registered font face.
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct FontFace {
    /// Family it matches as.
    pub family: String,
    /// Subfamily (style name).
    pub subfamily: String,
    /// PostScript name.
    pub postscript_name: String,
    /// Default weight.
    pub weight: f32,
    /// Weight range (variable fonts; equal ends for static fonts).
    pub weight_min: f32,
    /// Upper end of the weight range.
    pub weight_max: f32,
    /// Italic or oblique face.
    pub italic: bool,
}

/// Export file format.
#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum ExportFormat {
    /// PNG.
    Png,
    /// JPEG.
    Jpeg,
    /// WebP.
    Webp,
    /// SVG.
    Svg,
    /// PDF (vector, embedded fonts).
    Pdf,
    /// PowerPoint.
    Pptx,
    /// Animated GIF.
    Gif,
}

/// Pages to export.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Enum)]
pub enum ExportPages {
    /// The first page.
    First,
    /// A page by id.
    Page {
        /// Page id.
        id: String,
    },
    /// A page by 0-based index.
    Index {
        /// Index.
        index: u32,
    },
    /// Every page (PDF / PPTX in one file; other formats via `export_pages`).
    All,
}

/// Page background in exports.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Enum)]
pub enum ExportBackground {
    /// The page's own background.
    Page,
    /// No background (JPEG and PDF flatten on white).
    Transparent,
    /// Replace the page background with a color (`#rrggbb[aa]`).
    Color {
        /// Color.
        hex: String,
    },
}

/// PDF options.
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct PdfExportOptions {
    /// Include the page bleed.
    #[uniffi(default = false)]
    pub bleed: bool,
    /// Draw crop marks.
    #[uniffi(default = false)]
    pub crop_marks: bool,
    /// DeviceCMYK colors (naive conversion).
    #[uniffi(default = false)]
    pub cmyk: bool,
    /// Flatten each page to one image.
    #[uniffi(default = false)]
    pub flatten: bool,
    /// Resolution of flattened pages and rasterized effects.
    #[uniffi(default = 300.0)]
    pub dpi: f64,
    /// Document title (default: the design name).
    #[uniffi(default = None)]
    pub title: Option<String>,
}

/// Export options (the worker's `/v1/render` body, typed).
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct ExportRequest {
    /// Format.
    pub format: ExportFormat,
    /// Pages.
    pub pages: ExportPages,
    /// Device pixels per design px for raster output (0 < scale <= 64).
    #[uniffi(default = 1.0)]
    pub scale: f64,
    /// DPI written into PNG / JPEG metadata (`None` = 96 x scale).
    #[uniffi(default = None)]
    pub dpi: Option<f64>,
    /// JPEG / WebP quality 1..100.
    #[uniffi(default = 90)]
    pub quality: u8,
    /// Background.
    pub background: ExportBackground,
    /// Page-space region (raster / SVG).
    #[uniffi(default = None)]
    pub region: Option<DesignRect>,
    /// Animation time for still formats.
    #[uniffi(default = None)]
    pub time_ms: Option<f64>,
    /// PDF options (`None` = defaults).
    #[uniffi(default = None)]
    pub pdf: Option<PdfExportOptions>,
    /// SVG: write text as outlines instead of `<text>`.
    #[uniffi(default = false)]
    pub svg_outlines: bool,
    /// SVG with `<text>`: embed the font files.
    #[uniffi(default = true)]
    pub svg_embed_fonts: bool,
    /// GIF frames per second (0 < fps <= 120).
    #[uniffi(default = 15.0)]
    pub fps: f64,
    /// GIF duration (`None` = the page duration).
    #[uniffi(default = None)]
    pub duration_ms: Option<f64>,
    /// Export only these subtrees.
    #[uniffi(default = None)]
    pub only: Option<Vec<String>>,
    /// Never export these subtrees.
    #[uniffi(default = [])]
    pub hidden: Vec<String>,
}

/// An encoded export.
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct ExportResult {
    /// File bytes.
    pub bytes: Vec<u8>,
    /// MIME type.
    pub mime: String,
    /// File extension (without dot).
    pub extension: String,
    /// Pages included.
    pub pages: u32,
    /// Assets that had no bytes.
    pub missing_assets: Vec<String>,
    /// Font families that were not available.
    pub missing_fonts: Vec<String>,
    /// Non-fatal problems.
    pub warnings: Vec<String>,
}

/// One page of a multi-page export.
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct ExportedPage {
    /// Page id.
    pub page_id: String,
    /// The file.
    pub result: ExportResult,
}
