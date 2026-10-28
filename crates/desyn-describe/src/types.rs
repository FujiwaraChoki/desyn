//! Output types of `describe` (docs/DOCUMENT_MODEL.md section 7, names exact).
//!
//! Every contract field is present with the contract's name and meaning. Fields marked *additive* are extensions
//! that the loose `@desyn/schema` zod schemas preserve (unknown keys are kept); consumers that only know the
//! contract can ignore them.

use desyn_core::{Id, Op};
use serde::{Deserialize, Serialize};

/// Semantic description of one page of a design.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Description {
    /// Design identity.
    pub design: DesignInfo,
    /// The described page.
    pub page: PageInfo,
    /// Selected ids that exist (echo of the request, in request order).
    pub selection: Vec<Id>,
    /// Top-level children of the page, back-to-front (z-order preserved, reading order not applied).
    pub tree: Vec<DNode>,
    /// Dominant colors by visible area.
    pub palette: Vec<PaletteEntry>,
    /// Font families in use.
    pub fonts: Vec<FontUsage>,
    /// Type scale summary.
    pub typography: Typography,
    /// Margins, shared alignment lines and spacing rhythm.
    pub grid: Grid,
    /// Visual weight ranking (rank 1 = strongest).
    pub hierarchy: Vec<HierarchyEntry>,
    /// Lint results, most severe first.
    pub issues: Vec<Issue>,
    /// *Additive.* Content ids in reading order (z, position and direction aware).
    pub reading_order: Vec<Id>,
    /// *Additive.* Inferred semantic groups (containers and clusters of loose siblings).
    pub groups: Vec<SemanticGroup>,
    /// *Additive.* Dominant reading direction of the page.
    pub direction: Direction,
    /// *Additive.* Design tokens (with `includeStyles` or `detail: "full"`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tokens: Option<crate::tokens::DesignTokens>,
    /// *Additive.* Number of nodes left out of `tree` because of `maxNodes` / `maxDepth` / hidden filtering.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub omitted: usize,
}

fn is_zero(n: &usize) -> bool {
    *n == 0
}

/// `Description.design`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesignInfo {
    /// Design id.
    pub id: Id,
    /// Design name.
    pub name: String,
    /// Design kind (`DesignKind` string).
    pub kind: String,
    /// Number of pages.
    pub page_count: usize,
    /// `meta.locale` when it is a string.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub locale: Option<String>,
}

/// `Description.page`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageInfo {
    /// Page id.
    pub id: Id,
    /// Index among the design's pages.
    pub index: usize,
    /// Width in design px.
    pub width: f64,
    /// Height in design px.
    pub height: f64,
    /// Display unit.
    pub unit: String,
    /// CSS-ish summary of the page background (`"#ffffff"`, `"linear(#a → #b)"`, `"image(<id>)"`, `"none"`).
    pub background: String,
}

/// Node of the semantic tree (page coordinates).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DNode {
    /// Node id.
    pub id: Id,
    /// Node type (`"text"`, `"frame"`, ...).
    #[serde(rename = "type")]
    pub node_type: String,
    /// Layer name.
    pub name: String,
    /// Explicit role.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    /// Axis-aligned bounds of the (rotated) node box in page coordinates, plus its page-space rotation.
    #[serde(rename = "box")]
    pub bbox: DBox,
    /// Paint order index on the page (0 = bottom-most).
    pub z: usize,
    /// Own visibility flag.
    pub visible: bool,
    /// Locked flag.
    pub locked: bool,
    /// Own opacity.
    pub opacity: f64,
    /// Plain text (text nodes; summary detail truncates long text).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    /// Resolved dominant text style (text nodes).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub font: Option<DFont>,
    /// CSS-ish fill summary (shapes, frames; stroke summary for lines).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fill: Option<String>,
    /// Image / vector asset summary.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image: Option<DImage>,
    /// Inferred group meaning (`"product card: image + title + price + button"`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub semantic: Option<String>,
    /// Children back-to-front (omitted beyond `maxDepth`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub children: Option<Vec<DNode>>,
    /// Flags: `"overflows-page"`, `"overlaps:<id>"`, `"low-contrast"`, `"tiny-text"`, `"off-center"`, ...
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub flags: Option<Vec<String>>,
    /// *Additive.* Visual weight 0..1 (1 = the strongest element on the page).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub weight: Option<f64>,
}

/// `DNode.box`.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct DBox {
    /// Left.
    pub x: f64,
    /// Top.
    pub y: f64,
    /// Width.
    pub w: f64,
    /// Height.
    pub h: f64,
    /// Rotation in degrees (clockwise, accumulated through ancestors).
    pub rotation: f64,
}

/// `DNode.font`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DFont {
    /// Family of the dominant run.
    pub family: String,
    /// Size in px of the dominant run.
    pub size: f64,
    /// Weight of the dominant run.
    pub weight: f64,
    /// Resolved color (`#rrggbb`).
    pub color: String,
    /// Paragraph alignment.
    pub align: String,
    /// Laid-out line count.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lines: Option<u32>,
}

/// `DNode.image`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DImage {
    /// Asset id.
    pub asset_id: Id,
    /// Alt text.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub alt: Option<String>,
    /// What the image depicts (from role / type / asset).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<ImageKind>,
}

/// `DNode.image.kind`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
#[allow(missing_docs)]
pub enum ImageKind {
    Photo,
    Illustration,
    Logo,
    Icon,
    Unknown,
}

/// `Description.palette[]`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PaletteEntry {
    /// Color (`#rrggbb`).
    pub color: String,
    /// Share of the visible painted area 0..1.
    pub share: f64,
}

/// `Description.fonts[]`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FontUsage {
    /// Family.
    pub family: String,
    /// Weights in use, ascending.
    pub weights: Vec<f64>,
    /// Number of text nodes using the family.
    pub used_by: usize,
}

/// `Description.typography`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Typography {
    /// Distinct font sizes, descending.
    pub scale: Vec<f64>,
    /// Largest size.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub headline_size: Option<f64>,
    /// Size carrying the most characters (excluding the headline size).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body_size: Option<f64>,
    /// `headlineSize / bodySize`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ratio: Option<f64>,
}

/// `Description.grid`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Grid {
    /// Distance from the page edges to the content.
    pub margins: Margins,
    /// Shared alignment lines among top-level blocks.
    pub alignments: Vec<Alignment>,
    /// Most common gap between stacked blocks (multiple of 4).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spacing_rhythm: Option<f64>,
}

/// `Description.grid.margins`.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, Default)]
#[allow(missing_docs)]
pub struct Margins {
    pub t: f64,
    pub r: f64,
    pub b: f64,
    pub l: f64,
}

/// `Description.grid.alignments[]`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Alignment {
    /// `"x"` (vertical line) or `"y"` (horizontal line).
    pub axis: String,
    /// Position in page px.
    pub pos: f64,
    /// Ids sharing the line.
    pub ids: Vec<Id>,
}

/// `Description.hierarchy[]`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HierarchyEntry {
    /// Node id.
    pub id: Id,
    /// 1-based rank.
    pub rank: usize,
    /// Why it ranks there.
    pub reason: String,
}

/// Lint severity.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
#[allow(missing_docs)]
pub enum Severity {
    Info,
    Warn,
    Error,
}

impl Severity {
    /// Contract string.
    pub fn as_str(self) -> &'static str {
        match self {
            Severity::Info => "info",
            Severity::Warn => "warn",
            Severity::Error => "error",
        }
    }
}

/// `IssueCode` (exact contract vocabulary). Finer distinctions live in [`Issue::rule`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
#[allow(missing_docs)]
pub enum IssueCode {
    LowContrast,
    TinyText,
    TextOverflow,
    OffPage,
    Overlap,
    Misaligned,
    UnevenSpacing,
    OrphanLine,
    TooManyFonts,
    TooManyColors,
    WeakHierarchy,
    ImageLowRes,
    UnsafeMargin,
    MissingAlt,
    UnlabeledGroup,
}

impl IssueCode {
    /// Every code, in contract order.
    pub const ALL: &'static [IssueCode] = &[
        IssueCode::LowContrast,
        IssueCode::TinyText,
        IssueCode::TextOverflow,
        IssueCode::OffPage,
        IssueCode::Overlap,
        IssueCode::Misaligned,
        IssueCode::UnevenSpacing,
        IssueCode::OrphanLine,
        IssueCode::TooManyFonts,
        IssueCode::TooManyColors,
        IssueCode::WeakHierarchy,
        IssueCode::ImageLowRes,
        IssueCode::UnsafeMargin,
        IssueCode::MissingAlt,
        IssueCode::UnlabeledGroup,
    ];

    /// Contract string.
    pub fn as_str(self) -> &'static str {
        match self {
            IssueCode::LowContrast => "low-contrast",
            IssueCode::TinyText => "tiny-text",
            IssueCode::TextOverflow => "text-overflow",
            IssueCode::OffPage => "off-page",
            IssueCode::Overlap => "overlap",
            IssueCode::Misaligned => "misaligned",
            IssueCode::UnevenSpacing => "uneven-spacing",
            IssueCode::OrphanLine => "orphan-line",
            IssueCode::TooManyFonts => "too-many-fonts",
            IssueCode::TooManyColors => "too-many-colors",
            IssueCode::WeakHierarchy => "weak-hierarchy",
            IssueCode::ImageLowRes => "image-low-res",
            IssueCode::UnsafeMargin => "unsafe-margin",
            IssueCode::MissingAlt => "missing-alt",
            IssueCode::UnlabeledGroup => "unlabeled-group",
        }
    }
}

/// One lint result.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Issue {
    /// Severity.
    pub severity: Severity,
    /// Contract code.
    pub code: IssueCode,
    /// Affected node ids (may be empty for page-wide issues).
    pub ids: Vec<Id>,
    /// Human readable explanation (names are the layer names, quoted).
    pub message: String,
    /// Operations that fix the issue when applied as one transaction (only when a safe automatic fix exists).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fix: Option<Vec<Op>>,
    /// *Additive.* Precise lint rule (see [`crate::lint::RULES`]), e.g. `"text-clipped"` under `text-overflow`.
    pub rule: String,
    /// *Additive.* What to do about it, in one sentence.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hint: Option<String>,
}

/// *Additive.* An inferred semantic group.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SemanticGroup {
    /// Stable id within this description (`"g1"`, `"g2"`, ... in reading order of discovery).
    pub id: String,
    /// Group kind (see [`crate::semantic::GroupKind`]).
    pub kind: crate::semantic::GroupKind,
    /// Human readable meaning, e.g. `"product card: image + title + price + button"`.
    pub label: String,
    /// The container node when the group is an existing container.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub node: Option<Id>,
    /// Member node ids (top-level members of the group, back-to-front).
    pub ids: Vec<Id>,
    /// Nested groups that make up this one (e.g. the cards of a grid).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub parts: Vec<String>,
    /// Bounds in page coordinates.
    #[serde(rename = "box")]
    pub bbox: DBox,
    /// How the group was found: `"role"`, `"container"`, `"containment"`, `"proximity"` or `"repetition"`.
    pub source: String,
}

/// *Additive.* Reading direction.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
#[allow(missing_docs)]
pub enum Direction {
    #[default]
    Ltr,
    Rtl,
}
