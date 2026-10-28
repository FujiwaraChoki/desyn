//! Node types (`Node` enum with a shared [`Base`]).
//!
//! Every node struct flattens [`Base`] and keeps unknown JSON keys in `extra` so documents written by newer
//! clients round-trip unchanged (forward compatibility, DOCUMENT_MODEL section 5).

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::num::{nn, opt_u64_lenient, u64_lenient};
use super::paint::{Animation, Effect, Fill, ImageAdjust, Stroke};
use super::primitives::{BlendMode, Color, Id, Unit, string_enum};
use super::text::{ParagraphStyle, TextRun, TextStyle, TextStylePatch};

/// Unknown JSON keys preserved on a node.
pub type Extra = Map<String, Value>;

string_enum!(
    /// Horizontal constraint relative to the parent when the parent is resized.
    HConstraint { Left = "left", Right = "right", Center = "center", Stretch = "stretch", Scale = "scale" }
);
string_enum!(
    /// Vertical constraint relative to the parent when the parent is resized.
    VConstraint { Top = "top", Bottom = "bottom", Center = "center", Stretch = "stretch", Scale = "scale" }
);
string_enum!(
    /// Sizing behaviour along one axis (inside auto-layout parents; `hug` also applies to auto-layout containers).
    SizingMode { Fixed = "fixed", Hug = "hug", Fill = "fill" }
);

/// Resize constraints.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Constraints {
    /// Horizontal.
    pub h: HConstraint,
    /// Vertical.
    pub v: VConstraint,
    /// Unknown keys preserved for forward compatibility.
    #[serde(flatten)]
    pub extra: Extra,
}

/// Auto-layout child sizing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Sizing {
    /// Horizontal.
    pub h: SizingMode,
    /// Vertical.
    pub v: SizingMode,
    /// Unknown keys preserved for forward compatibility.
    #[serde(flatten)]
    pub extra: Extra,
}

string_enum!(
    /// Auto-layout direction.
    LayoutMode { Row = "row", Column = "column", Grid = "grid" }
);
string_enum!(
    /// Main-axis distribution.
    MainAlign { Start = "start", Center = "center", End = "end", SpaceBetween = "space-between" }
);
string_enum!(
    /// Cross-axis alignment.
    CrossAlign { Start = "start", Center = "center", End = "end", Stretch = "stretch", Baseline = "baseline" }
);

/// Auto-layout settings of a container.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoLayout {
    /// Direction.
    pub mode: LayoutMode,
    /// Main-axis gap (column gap for grids).
    pub gap: f64,
    /// Gap between wrapped lines / grid rows (defaults to `gap`).
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "nn"
    )]
    pub row_gap: Option<f64>,
    /// Padding `[top, right, bottom, left]`.
    pub padding: [f64; 4],
    /// Main-axis distribution.
    pub main_align: MainAlign,
    /// Cross-axis alignment.
    pub cross_align: CrossAlign,
    /// Wrap onto multiple lines (row / column).
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "nn"
    )]
    pub wrap: Option<bool>,
    /// Grid column count.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "opt_u64_lenient"
    )]
    pub columns: Option<u64>,
    /// Lay children out last-to-first.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "nn"
    )]
    pub reverse: Option<bool>,
    /// Unknown keys preserved for forward compatibility.
    #[serde(flatten)]
    pub extra: Extra,
}

/// Fields shared by every node.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Base {
    /// Node id.
    pub id: Id,
    /// Display name.
    pub name: String,
    /// Parent id (`None` only for the root).
    pub parent: Option<Id>,
    /// Left relative to the parent's top-left (before parent rotation).
    pub x: f64,
    /// Top relative to the parent's top-left.
    pub y: f64,
    /// Width (>= 0).
    pub width: f64,
    /// Height (>= 0).
    pub height: f64,
    /// Degrees clockwise about the node center.
    pub rotation: f64,
    /// Mirror horizontally about the center.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "nn"
    )]
    pub flip_x: Option<bool>,
    /// Mirror vertically about the center.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "nn"
    )]
    pub flip_y: Option<bool>,
    /// Opacity 0..1.
    pub opacity: f64,
    /// Layer blend mode.
    pub blend: BlendMode,
    /// Visibility.
    pub visible: bool,
    /// Locked against canvas selection.
    pub locked: bool,
    /// Effects.
    pub effects: Vec<Effect>,
    /// Semantic role (open set).
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "nn"
    )]
    pub role: Option<String>,
    /// Resize constraints.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "nn"
    )]
    pub constraints: Option<Constraints>,
    /// Auto-layout sizing.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "nn"
    )]
    pub sizing: Option<Sizing>,
    /// Keep aspect ratio while resizing.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "nn"
    )]
    pub aspect_locked: Option<bool>,
    /// Alpha-masks following siblings until the next mask.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "nn"
    )]
    pub mask: Option<bool>,
    /// Link url or `"page:<pageId>"`.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "nn"
    )]
    pub link: Option<String>,
    /// Accessibility description.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "nn"
    )]
    pub alt: Option<String>,
    /// Animations.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "nn"
    )]
    pub anim: Option<Vec<Animation>>,
    /// Speaker / designer notes.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "nn"
    )]
    pub notes: Option<String>,
    /// Free-form metadata (template slots, AI notes).
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "nn"
    )]
    pub meta: Option<Map<String, Value>>,
}

impl Base {
    /// Base with the factory defaults (as `@desyn/schema` factories): parent `"root"`, no rotation, opacity 1,
    /// normal blend, visible, unlocked, no effects. `create` ops overwrite the subtree root's parent.
    pub fn new(
        id: impl Into<Id>,
        name: impl Into<String>,
        x: f64,
        y: f64,
        width: f64,
        height: f64,
    ) -> Self {
        Base {
            id: id.into(),
            name: name.into(),
            parent: Some(crate::model::ROOT_ID.to_string()),
            x,
            y,
            width,
            height,
            rotation: 0.0,
            flip_x: None,
            flip_y: None,
            opacity: 1.0,
            blend: BlendMode::Normal,
            visible: true,
            locked: false,
            effects: Vec::new(),
            role: None,
            constraints: None,
            sizing: None,
            aspect_locked: None,
            mask: None,
            link: None,
            alt: None,
            anim: None,
            notes: None,
            meta: None,
        }
    }

    /// `flipX == true`.
    pub fn flipped_x(&self) -> bool {
        self.flip_x.unwrap_or(false)
    }

    /// `flipY == true`.
    pub fn flipped_y(&self) -> bool {
        self.flip_y.unwrap_or(false)
    }

    /// `mask == true`.
    pub fn is_mask(&self) -> bool {
        self.mask.unwrap_or(false)
    }

    /// Effective sizing (fixed/fixed when unset).
    pub fn sizing_or_fixed(&self) -> Sizing {
        self.sizing.clone().unwrap_or(Sizing {
            h: SizingMode::Fixed,
            v: SizingMode::Fixed,
            extra: Extra::new(),
        })
    }

    /// Effective constraints (left/top when unset).
    pub fn constraints_or_default(&self) -> Constraints {
        self.constraints.clone().unwrap_or(Constraints {
            h: HConstraint::Left,
            v: VConstraint::Top,
            extra: Extra::new(),
        })
    }
}

/// Children list, clipping and auto-layout of a container node.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Container {
    /// Child ids, back to front (index 0 is bottom-most).
    pub children: Vec<Id>,
    /// Clip children to the node bounds.
    pub clip: bool,
    /// Auto-layout settings.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "nn"
    )]
    pub layout: Option<AutoLayout>,
}

/// `number | [tl, tr, br, bl]`.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum CornerRadius {
    /// Same radius for all corners.
    Uniform(f64),
    /// Per-corner radii `[top-left, top-right, bottom-right, bottom-left]`.
    PerCorner([f64; 4]),
}

impl Default for CornerRadius {
    fn default() -> Self {
        CornerRadius::Uniform(0.0)
    }
}

impl CornerRadius {
    /// Radii as `[tl, tr, br, bl]`.
    pub fn corners(&self) -> [f64; 4] {
        match *self {
            CornerRadius::Uniform(r) => [r; 4],
            CornerRadius::PerCorner(c) => c,
        }
    }

    /// True when every radius is zero (or negative).
    pub fn is_zero(&self) -> bool {
        self.corners().iter().all(|r| *r <= 0.0)
    }
}

/// Paint and outline settings of shape-like nodes.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Shaped {
    /// Fills, bottom to top.
    pub fills: Vec<Fill>,
    /// Strokes.
    pub strokes: Vec<Stroke>,
    /// Corner radius.
    pub corner_radius: CornerRadius,
    /// iOS-style corner smoothing 0..1.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "nn"
    )]
    pub corner_smoothing: Option<f64>,
}

macro_rules! node_struct {
    ($(#[$meta:meta])* $name:ident { $($body:tt)* }) => {
        $(#[$meta])*
        #[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
        #[serde(rename_all = "camelCase")]
        pub struct $name {
            /// Shared node fields.
            #[serde(flatten)]
            pub base: Base,
            $($body)*
            /// Unknown keys preserved for forward compatibility.
            #[serde(flatten)]
            pub extra: Extra,
        }
    };
}

node_struct!(
    /// The single root node; its children are page ids.
    RootNode {
        /// Page ids in order.
        pub children: Vec<Id>,
    }
);

string_enum!(
    /// Page transition kind.
    TransitionKind { None = "none", Fade = "fade", Slide = "slide", Push = "push", Zoom = "zoom", Dissolve = "dissolve" }
);

/// Page transition.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Transition {
    /// Kind.
    pub kind: TransitionKind,
    /// Duration in ms.
    pub duration_ms: f64,
    /// Unknown keys preserved for forward compatibility.
    #[serde(flatten)]
    pub extra: Extra,
}

/// Page layout grid (columns + optional baseline grid).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LayoutGrid {
    /// Column count.
    #[serde(deserialize_with = "u64_lenient")]
    pub columns: u64,
    /// Gutter between columns.
    pub gutter: f64,
    /// Outer margin.
    pub margin: f64,
    /// Baseline grid step.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "nn"
    )]
    pub baseline: Option<f64>,
    /// Unknown keys preserved for forward compatibility.
    #[serde(flatten)]
    pub extra: Extra,
}

string_enum!(
    /// Guide axis: `x` guides are vertical lines at x = pos.
    GuideAxis { X = "x", Y = "y" }
);

/// Ruler guide.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Guide {
    /// Axis.
    pub axis: GuideAxis,
    /// Position in page px.
    pub pos: f64,
    /// Unknown keys preserved for forward compatibility.
    #[serde(flatten)]
    pub extra: Extra,
}

node_struct!(
    /// A page (artboard) - child of root.
    PageNode {
        /// Children / clip / layout.
        #[serde(flatten)]
        pub container: Container,
        /// Display unit.
        pub unit: Unit,
        /// Background paints.
        pub background: Vec<Fill>,
        /// Print bleed in px.
        pub bleed: f64,
        /// Auto-advance duration.
        #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "nn")]
        pub duration_ms: Option<f64>,
        /// Transition into this page.
        #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "nn")]
        pub transition: Option<Transition>,
        /// Layout grid.
        #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "nn")]
        pub grid: Option<LayoutGrid>,
        /// Ruler guides.
        #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "nn")]
        pub guides: Option<Vec<Guide>>,
    }
);

node_struct!(
    /// Frame: painted container.
    FrameNode {
        /// Children / clip / layout.
        #[serde(flatten)]
        pub container: Container,
        /// Paint.
        #[serde(flatten)]
        pub shape: Shaped,
    }
);

node_struct!(
    /// Group: unpainted container whose bounds fit its children.
    GroupNode {
        /// Children / clip / layout.
        #[serde(flatten)]
        pub container: Container,
    }
);

string_enum!(
    /// Boolean operation.
    BoolOp { Union = "union", Subtract = "subtract", Intersect = "intersect", Exclude = "exclude" }
);

node_struct!(
    /// Boolean combination of its children's outlines.
    BooleanNode {
        /// Children / clip / layout.
        #[serde(flatten)]
        pub container: Container,
        /// Paint.
        #[serde(flatten)]
        pub shape: Shaped,
        /// Operation.
        pub op: BoolOp,
    }
);

node_struct!(
    /// Rectangle.
    RectNode {
        /// Paint.
        #[serde(flatten)]
        pub shape: Shaped,
    }
);

/// Ellipse arc settings (pie / donut).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EllipseArc {
    /// Start angle in degrees (0 = 3 o'clock, clockwise).
    pub start: f64,
    /// End angle in degrees.
    pub end: f64,
    /// Inner radius ratio 0..1 (donut).
    pub inner: f64,
    /// Unknown keys preserved for forward compatibility.
    #[serde(flatten)]
    pub extra: Extra,
}

node_struct!(
    /// Ellipse, optionally an arc / donut.
    EllipseNode {
        /// Paint.
        #[serde(flatten)]
        pub shape: Shaped,
        /// Arc / donut.
        #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "nn")]
        pub arc: Option<EllipseArc>,
    }
);

node_struct!(
    /// Regular polygon fitted to the box.
    PolygonNode {
        /// Paint.
        #[serde(flatten)]
        pub shape: Shaped,
        /// Side count (>= 3).
        #[serde(deserialize_with = "u64_lenient")]
        pub sides: u64,
    }
);

node_struct!(
    /// Star fitted to the box.
    StarNode {
        /// Paint.
        #[serde(flatten)]
        pub shape: Shaped,
        /// Point count (>= 3).
        #[serde(deserialize_with = "u64_lenient")]
        pub points: u64,
        /// Inner radius ratio 0..1.
        pub inner_ratio: f64,
    }
);

string_enum!(
    /// Line end decoration.
    Cap { None = "none", Arrow = "arrow", Triangle = "triangle", Circle = "circle", Square = "square", Diamond = "diamond", Bar = "bar" }
);

node_struct!(
    /// Straight line along +x of the box.
    LineNode {
        /// Strokes.
        pub strokes: Vec<Stroke>,
        /// Start decoration.
        pub start_cap: Cap,
        /// End decoration.
        pub end_cap: Cap,
    }
);

string_enum!(
    /// Path fill rule.
    FillRule { Nonzero = "nonzero", Evenodd = "evenodd" }
);

/// One SVG sub-path of a path node.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PathData {
    /// SVG path data in local box coordinates.
    pub d: String,
    /// Fill rule.
    pub fill_rule: FillRule,
    /// Unknown keys preserved for forward compatibility.
    #[serde(flatten)]
    pub extra: Extra,
}

node_struct!(
    /// Vector path.
    PathNode {
        /// Paint.
        #[serde(flatten)]
        pub shape: Shaped,
        /// Paths.
        pub paths: Vec<PathData>,
    }
);

string_enum!(
    /// Text box auto-resize behaviour.
    AutoResize { None = "none", Height = "height", Width = "width" }
);
string_enum!(
    /// Vertical alignment of text in its box.
    VerticalAlign { Top = "top", Middle = "middle", Bottom = "bottom" }
);

node_struct!(
    /// Rich text.
    TextNode {
        /// Runs.
        pub runs: Vec<TextRun>,
        /// Default style.
        pub style: TextStyle,
        /// Paragraph style.
        pub paragraph: ParagraphStyle,
        /// Auto-resize mode.
        pub auto_resize: AutoResize,
        /// Maximum lines (ellipsis truncation).
        #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "opt_u64_lenient")]
        pub max_lines: Option<u64>,
        /// Text-on-arc sweep in degrees.
        #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "nn")]
        pub curve: Option<f64>,
        /// Vertical alignment.
        pub vertical_align: VerticalAlign,
        /// Outline strokes.
        #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "nn")]
        pub strokes: Option<Vec<Stroke>>,
        /// Followed text style id.
        #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "nn")]
        pub style_ref: Option<Id>,
    }
);

string_enum!(
    /// Image fit mode.
    ImageFit { Fill = "fill", Fit = "fit", Crop = "crop", Tile = "tile" }
);

/// Normalized crop rectangle of the source image.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Crop {
    /// Left 0..1.
    pub x: f64,
    /// Top 0..1.
    pub y: f64,
    /// Width 0..1.
    pub w: f64,
    /// Height 0..1.
    pub h: f64,
    /// Zoom factor.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "nn"
    )]
    pub zoom: Option<f64>,
    /// Unknown keys preserved for forward compatibility.
    #[serde(flatten)]
    pub extra: Extra,
}

string_enum!(
    /// Named image clip shapes.
    ImageShapeKind { Rect = "rect", Ellipse = "ellipse" }
);

/// Image clip shape: `"rect" | "ellipse" | { path }`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ImageShape {
    /// Named shape.
    Named(ImageShapeKind),
    /// SVG path in a 0..1 unit box.
    Path {
        /// Path data.
        path: String,
        /// Unknown keys preserved for forward compatibility.
        #[serde(flatten)]
        extra: Extra,
    },
}

node_struct!(
    /// Raster image.
    ImageNode {
        /// Image asset.
        pub asset_id: Id,
        /// Fit.
        pub fit: ImageFit,
        /// Crop rectangle.
        #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "nn")]
        pub crop: Option<Crop>,
        /// Corner radius.
        pub corner_radius: CornerRadius,
        /// Clip shape.
        #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "nn")]
        pub shape: Option<ImageShape>,
        /// Adjustments.
        #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "nn")]
        pub adjust: Option<ImageAdjust>,
        /// Strokes.
        pub strokes: Vec<Stroke>,
        /// Alpha matte asset.
        #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "nn")]
        pub mask_asset_id: Option<Id>,
    }
);

node_struct!(
    /// Vector graphic from an SVG asset or inline markup.
    SvgNode {
        /// SVG asset.
        #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "nn")]
        pub asset_id: Option<Id>,
        /// Inline sanitized markup.
        #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "nn")]
        pub markup: Option<String>,
        /// Original -> replacement colors.
        #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "nn")]
        pub recolor: Option<BTreeMap<Color, Color>>,
        /// Strokes.
        #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "nn")]
        pub strokes: Option<Vec<Stroke>>,
    }
);

string_enum!(
    /// Video fit mode.
    VideoFit { Fill = "fill", Fit = "fit", Crop = "crop" }
);

node_struct!(
    /// Video clip.
    VideoNode {
        /// Video asset.
        pub asset_id: Id,
        /// Trim start.
        pub trim_start_ms: f64,
        /// Trim end.
        #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "nn")]
        pub trim_end_ms: Option<f64>,
        /// Muted.
        pub muted: bool,
        /// Loop.
        #[serde(rename = "loop")]
        pub looped: bool,
        /// Volume 0..1.
        pub volume: f64,
        /// Poster image asset.
        #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "nn")]
        pub poster_asset_id: Option<Id>,
        /// Fit.
        pub fit: VideoFit,
        /// Corner radius.
        pub corner_radius: f64,
    }
);

node_struct!(
    /// Audio track.
    AudioNode {
        /// Audio asset.
        pub asset_id: Id,
        /// Start time on the timeline.
        pub start_ms: f64,
        /// Trim start.
        pub trim_start_ms: f64,
        /// Trim end.
        #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "nn")]
        pub trim_end_ms: Option<f64>,
        /// Volume 0..1.
        pub volume: f64,
        /// Fade in.
        #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "nn")]
        pub fade_in_ms: Option<f64>,
        /// Fade out.
        #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "nn")]
        pub fade_out_ms: Option<f64>,
    }
);

string_enum!(
    /// Chart kind.
    ChartKind {
        Bar = "bar", Column = "column", Line = "line", Area = "area", Pie = "pie", Donut = "donut", Scatter = "scatter",
        Radar = "radar", Funnel = "funnel", StackedColumn = "stacked-column", Progress = "progress",
    }
);

/// Chart series.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChartSeries {
    /// Series name.
    pub name: String,
    /// Values per label.
    pub values: Vec<f64>,
    /// Series color.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "nn"
    )]
    pub color: Option<Color>,
    /// Unknown keys preserved for forward compatibility.
    #[serde(flatten)]
    pub extra: Extra,
}

/// Chart data.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChartData {
    /// Category labels.
    pub labels: Vec<String>,
    /// Series.
    pub series: Vec<ChartSeries>,
    /// Unknown keys preserved for forward compatibility.
    #[serde(flatten)]
    pub extra: Extra,
}

/// Chart presentation options.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChartOptions {
    /// Show legend.
    pub legend: bool,
    /// Show grid lines.
    pub grid: bool,
    /// Show value labels.
    pub labels: bool,
    /// Series palette.
    pub palette: Vec<Color>,
    /// Font family.
    pub font_family: String,
    /// Font size.
    pub font_size: f64,
    /// Text color.
    pub text_color: Color,
    /// Axis minimum.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "nn"
    )]
    pub min: Option<f64>,
    /// Axis maximum.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "nn"
    )]
    pub max: Option<f64>,
    /// Value unit suffix.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "nn"
    )]
    pub unit: Option<String>,
    /// Unknown keys preserved for forward compatibility.
    #[serde(flatten)]
    pub extra: Extra,
}

node_struct!(
    /// Data chart.
    ChartNode {
        /// Kind.
        pub chart: ChartKind,
        /// Data.
        pub data: ChartData,
        /// Options.
        pub options: ChartOptions,
    }
);

string_enum!(
    /// Table cell horizontal alignment.
    CellAlign { Left = "left", Center = "center", Right = "right" }
);

/// Table cell.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableCell {
    /// Row index.
    #[serde(deserialize_with = "u64_lenient")]
    pub r: u64,
    /// Column index.
    #[serde(deserialize_with = "u64_lenient")]
    pub c: u64,
    /// Cell text.
    pub text: String,
    /// Style overrides.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "nn"
    )]
    pub style: Option<TextStylePatch>,
    /// Background.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "nn"
    )]
    pub fill: Option<Fill>,
    /// Alignment.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "nn"
    )]
    pub align: Option<CellAlign>,
    /// Column span.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "opt_u64_lenient"
    )]
    pub colspan: Option<u64>,
    /// Row span.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "opt_u64_lenient"
    )]
    pub rowspan: Option<u64>,
    /// Unknown keys preserved for forward compatibility.
    #[serde(flatten)]
    pub extra: Extra,
}

node_struct!(
    /// Table.
    TableNode {
        /// Row count.
        #[serde(deserialize_with = "u64_lenient")]
        pub rows: u64,
        /// Column count.
        #[serde(deserialize_with = "u64_lenient")]
        pub cols: u64,
        /// Column widths.
        pub col_widths: Vec<f64>,
        /// Row heights.
        pub row_heights: Vec<f64>,
        /// Cells (sparse).
        pub cells: Vec<TableCell>,
        /// First row is a header.
        pub header: bool,
        /// Zebra striping.
        pub stripe: bool,
        /// Border color.
        pub border_color: Color,
        /// Border width.
        pub border_width: f64,
        /// Cell padding.
        pub cell_padding: f64,
        /// Default cell text style.
        pub default_style: TextStyle,
    }
);

string_enum!(
    /// QR error correction level.
    QrErrorCorrection { L = "L", M = "M", Q = "Q", H = "H" }
);

node_struct!(
    /// QR code.
    QrNode {
        /// Encoded data.
        pub data: String,
        /// Foreground color.
        pub fg: Color,
        /// Background color.
        pub bg: Color,
        /// Error correction.
        pub error_correction: QrErrorCorrection,
        /// Rounded modules.
        pub rounded: bool,
    }
);

string_enum!(
    /// Node discriminant (`type`).
    NodeType {
        Root = "root", Page = "page", Frame = "frame", Group = "group", Boolean = "boolean", Rect = "rect",
        Ellipse = "ellipse", Polygon = "polygon", Star = "star", Line = "line", Path = "path", Text = "text",
        Image = "image", Svg = "svg", Video = "video", Audio = "audio", Chart = "chart", Table = "table", Qr = "qr",
    }
);

/// Any node, internally tagged on `type`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
#[allow(missing_docs)]
pub enum Node {
    Root(RootNode),
    Page(PageNode),
    Frame(FrameNode),
    Group(GroupNode),
    Boolean(BooleanNode),
    Rect(RectNode),
    Ellipse(EllipseNode),
    Polygon(PolygonNode),
    Star(StarNode),
    Line(LineNode),
    Path(PathNode),
    Text(TextNode),
    Image(ImageNode),
    Svg(SvgNode),
    Video(VideoNode),
    Audio(AudioNode),
    Chart(ChartNode),
    Table(TableNode),
    Qr(QrNode),
}

/// Derived deserializer for [`Node`]; the public impl first checks that the tag is a string (serde would
/// otherwise accept a variant index such as `"type": 1`).
#[derive(Deserialize)]
#[serde(remote = "Node", tag = "type", rename_all = "lowercase")]
enum NodeDef {
    Root(RootNode),
    Page(PageNode),
    Frame(FrameNode),
    Group(GroupNode),
    Boolean(BooleanNode),
    Rect(RectNode),
    Ellipse(EllipseNode),
    Polygon(PolygonNode),
    Star(StarNode),
    Line(LineNode),
    Path(PathNode),
    Text(TextNode),
    Image(ImageNode),
    Svg(SvgNode),
    Video(VideoNode),
    Audio(AudioNode),
    Chart(ChartNode),
    Table(TableNode),
    Qr(QrNode),
}

impl<'de> Deserialize<'de> for Node {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let v = serde_json::Value::deserialize(d)?;
        if !matches!(v.get("type"), Some(serde_json::Value::String(_))) {
            return Err(serde::de::Error::custom("`type` must be a string"));
        }
        NodeDef::deserialize(v).map_err(serde::de::Error::custom)
    }
}

macro_rules! each_node {
    ($self:expr, $n:ident => $e:expr) => {
        match $self {
            Node::Root($n) => $e,
            Node::Page($n) => $e,
            Node::Frame($n) => $e,
            Node::Group($n) => $e,
            Node::Boolean($n) => $e,
            Node::Rect($n) => $e,
            Node::Ellipse($n) => $e,
            Node::Polygon($n) => $e,
            Node::Star($n) => $e,
            Node::Line($n) => $e,
            Node::Path($n) => $e,
            Node::Text($n) => $e,
            Node::Image($n) => $e,
            Node::Svg($n) => $e,
            Node::Video($n) => $e,
            Node::Audio($n) => $e,
            Node::Chart($n) => $e,
            Node::Table($n) => $e,
            Node::Qr($n) => $e,
        }
    };
}

impl Node {
    /// Shared fields.
    #[inline]
    pub fn base(&self) -> &Base {
        each_node!(self, n => &n.base)
    }

    /// Shared fields (mutable).
    #[inline]
    pub fn base_mut(&mut self) -> &mut Base {
        each_node!(self, n => &mut n.base)
    }

    /// Unknown keys.
    pub fn extra(&self) -> &Extra {
        each_node!(self, n => &n.extra)
    }

    /// Unknown keys (mutable).
    pub fn extra_mut(&mut self) -> &mut Extra {
        each_node!(self, n => &mut n.extra)
    }

    /// Node id.
    #[inline]
    pub fn id(&self) -> &str {
        &self.base().id
    }

    /// Parent id.
    #[inline]
    pub fn parent(&self) -> Option<&str> {
        self.base().parent.as_deref()
    }

    /// Discriminant.
    pub fn node_type(&self) -> NodeType {
        match self {
            Node::Root(_) => NodeType::Root,
            Node::Page(_) => NodeType::Page,
            Node::Frame(_) => NodeType::Frame,
            Node::Group(_) => NodeType::Group,
            Node::Boolean(_) => NodeType::Boolean,
            Node::Rect(_) => NodeType::Rect,
            Node::Ellipse(_) => NodeType::Ellipse,
            Node::Polygon(_) => NodeType::Polygon,
            Node::Star(_) => NodeType::Star,
            Node::Line(_) => NodeType::Line,
            Node::Path(_) => NodeType::Path,
            Node::Text(_) => NodeType::Text,
            Node::Image(_) => NodeType::Image,
            Node::Svg(_) => NodeType::Svg,
            Node::Video(_) => NodeType::Video,
            Node::Audio(_) => NodeType::Audio,
            Node::Chart(_) => NodeType::Chart,
            Node::Table(_) => NodeType::Table,
            Node::Qr(_) => NodeType::Qr,
        }
    }

    /// Children ids for containers (root, page, frame, group, boolean).
    #[inline]
    pub fn children(&self) -> Option<&Vec<Id>> {
        match self {
            Node::Root(n) => Some(&n.children),
            Node::Page(n) => Some(&n.container.children),
            Node::Frame(n) => Some(&n.container.children),
            Node::Group(n) => Some(&n.container.children),
            Node::Boolean(n) => Some(&n.container.children),
            _ => None,
        }
    }

    /// Children ids (mutable).
    #[inline]
    pub fn children_mut(&mut self) -> Option<&mut Vec<Id>> {
        match self {
            Node::Root(n) => Some(&mut n.children),
            Node::Page(n) => Some(&mut n.container.children),
            Node::Frame(n) => Some(&mut n.container.children),
            Node::Group(n) => Some(&mut n.container.children),
            Node::Boolean(n) => Some(&mut n.container.children),
            _ => None,
        }
    }

    /// Children slice (empty for leaves).
    #[inline]
    pub fn child_ids(&self) -> &[Id] {
        self.children().map(Vec::as_slice).unwrap_or(&[])
    }

    /// True for nodes that can have children.
    #[inline]
    pub fn is_container(&self) -> bool {
        self.children().is_some()
    }

    /// Container props (page, frame, group, boolean; not root).
    pub fn container(&self) -> Option<&Container> {
        match self {
            Node::Page(n) => Some(&n.container),
            Node::Frame(n) => Some(&n.container),
            Node::Group(n) => Some(&n.container),
            Node::Boolean(n) => Some(&n.container),
            _ => None,
        }
    }

    /// Container props (mutable).
    pub fn container_mut(&mut self) -> Option<&mut Container> {
        match self {
            Node::Page(n) => Some(&mut n.container),
            Node::Frame(n) => Some(&mut n.container),
            Node::Group(n) => Some(&mut n.container),
            Node::Boolean(n) => Some(&mut n.container),
            _ => None,
        }
    }

    /// Auto-layout settings if this container has them.
    pub fn layout(&self) -> Option<&AutoLayout> {
        self.container().and_then(|c| c.layout.as_ref())
    }

    /// Whether children are clipped to the bounds.
    pub fn clips(&self) -> bool {
        self.container().is_some_and(|c| c.clip)
    }

    /// Shape paint props for shape-like nodes.
    pub fn shaped(&self) -> Option<&Shaped> {
        match self {
            Node::Frame(n) => Some(&n.shape),
            Node::Boolean(n) => Some(&n.shape),
            Node::Rect(n) => Some(&n.shape),
            Node::Ellipse(n) => Some(&n.shape),
            Node::Polygon(n) => Some(&n.shape),
            Node::Star(n) => Some(&n.shape),
            Node::Path(n) => Some(&n.shape),
            _ => None,
        }
    }

    /// Shape paint props (mutable).
    pub fn shaped_mut(&mut self) -> Option<&mut Shaped> {
        match self {
            Node::Frame(n) => Some(&mut n.shape),
            Node::Boolean(n) => Some(&mut n.shape),
            Node::Rect(n) => Some(&mut n.shape),
            Node::Ellipse(n) => Some(&mut n.shape),
            Node::Polygon(n) => Some(&mut n.shape),
            Node::Star(n) => Some(&mut n.shape),
            Node::Path(n) => Some(&mut n.shape),
            _ => None,
        }
    }

    /// Fills of the node (shape fills; page background for pages; empty otherwise).
    pub fn fills(&self) -> &[Fill] {
        match self {
            Node::Page(p) => &p.background,
            _ => self.shaped().map(|s| s.fills.as_slice()).unwrap_or(&[]),
        }
    }

    /// Strokes of the node (empty when the kind has none).
    pub fn strokes(&self) -> &[Stroke] {
        if let Some(s) = self.shaped() {
            return &s.strokes;
        }
        match self {
            Node::Line(n) => &n.strokes,
            Node::Image(n) => &n.strokes,
            Node::Text(n) => n.strokes.as_deref().unwrap_or(&[]),
            Node::Svg(n) => n.strokes.as_deref().unwrap_or(&[]),
            _ => &[],
        }
    }

    /// Corner radii `[tl, tr, br, bl]` of kinds that have them.
    pub fn corner_radii(&self) -> [f64; 4] {
        match self {
            Node::Image(n) => n.corner_radius.corners(),
            Node::Video(n) => [n.corner_radius; 4],
            _ => self
                .shaped()
                .map(|s| s.corner_radius.corners())
                .unwrap_or([0.0; 4]),
        }
    }

    /// Whether the node paints anything itself (not counting children).
    pub fn paints_self(&self) -> bool {
        !matches!(self, Node::Root(_) | Node::Group(_) | Node::Audio(_))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rect_roundtrip_with_unknown_keys() {
        let j = r##"{"type":"rect","id":"r1","name":"Rect","parent":"p1","x":1,"y":2,"width":3,"height":4,"rotation":0,"opacity":1,"blend":"normal","visible":true,"locked":false,"effects":[],"fills":[{"type":"solid","color":"#ff0000"}],"strokes":[],"cornerRadius":[1,2,3,4],"futureKey":{"a":1}}"##;
        let n: Node = serde_json::from_str(j).unwrap();
        let Node::Rect(r) = &n else { panic!() };
        assert_eq!(r.shape.corner_radius.corners(), [1.0, 2.0, 3.0, 4.0]);
        assert_eq!(r.extra.get("futureKey").unwrap()["a"], 1);
        assert!(!r.extra.contains_key("type"));
        let v = serde_json::to_value(&n).unwrap();
        let orig: Value = serde_json::from_str(j).unwrap();
        assert_eq!(
            crate::canonical::canonical_json(&v),
            crate::canonical::canonical_json(&orig)
        );
    }

    #[test]
    fn root_parent_null() {
        let j = r#"{"type":"root","id":"root","name":"Root","parent":null,"x":0,"y":0,"width":0,"height":0,"rotation":0,"opacity":1,"blend":"normal","visible":true,"locked":false,"effects":[],"children":["p"]}"#;
        let n: Node = serde_json::from_str(j).unwrap();
        assert!(n.parent().is_none());
        let out = serde_json::to_value(&n).unwrap();
        assert!(out["parent"].is_null());
    }

    #[test]
    fn missing_required_field_fails() {
        let j = r#"{"type":"group","id":"g","name":"G","parent":"p","x":0,"y":0,"width":0,"height":0,"rotation":0,"opacity":1,"blend":"normal","visible":true,"locked":false,"effects":[],"children":[]}"#;
        assert!(serde_json::from_str::<Node>(j).is_err(), "clip is required");
    }

    #[test]
    fn counts_accept_integral_floats() {
        let j = r#"{"type":"polygon","id":"g","name":"G","parent":"p","x":0,"y":0,"width":0,"height":0,"rotation":0,"opacity":1,"blend":"normal","visible":true,"locked":false,"effects":[],"fills":[],"strokes":[],"cornerRadius":0,"sides":5.0}"#;
        let n: Node = serde_json::from_str(j).unwrap();
        assert!(matches!(n, Node::Polygon(PolygonNode { sides: 5, .. })));
        assert!(serde_json::from_str::<Node>(&j.replace("5.0", "5.5")).is_err());
    }
}

#[cfg(test)]
mod tag_tests {
    use super::*;

    #[test]
    fn numeric_tags_are_rejected() {
        let rect =
            serde_json::to_value(Node::rect("rect00000001", "r", 0.0, 0.0, 1.0, 1.0)).unwrap();
        let mut bad = rect.clone();
        bad["type"] = serde_json::json!(1);
        assert!(serde_json::from_value::<Node>(bad).is_err());
        let mut bad_fill = rect.clone();
        bad_fill["fills"][0]["type"] = serde_json::json!(0);
        assert!(serde_json::from_value::<Node>(bad_fill).is_err());
        assert!(serde_json::from_value::<Node>(rect).is_ok());
        let op: crate::model::Op =
            serde_json::from_value(serde_json::json!({"op": 3, "id": "x"})).unwrap();
        assert!(matches!(op, crate::model::Op::Invalid { .. }));
    }
}
