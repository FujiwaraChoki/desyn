//! Constructors with the default values used by every client when creating new content.

use serde_json::Map;

use super::design::{Design, DesignKind, DesignStyles, NodeMap};
use super::node::*;
use super::paint::{Fill, Stroke};
use super::primitives::{Color, Id, ROOT_ID, Unit};
use super::text::*;

/// Default fill of new shapes (`#d9d9d9`).
pub const DEFAULT_SHAPE_FILL: &str = "#d9d9d9";
/// Default text color (`#111111`), same as `@desyn/schema`.
pub const DEFAULT_TEXT_COLOR: &str = "#111111";
/// Default font family of new text, same as `@desyn/schema`.
pub const DEFAULT_FONT_FAMILY: &str = "Inter";

fn color(s: &str) -> Color {
    Color::new(s).expect("factory colors are valid")
}

impl TextStyle {
    /// Default character style (mirrors `defaultTextStyle()`): Inter 400 24px `#111111`.
    pub fn default_style() -> Self {
        TextStyle {
            font_family: DEFAULT_FONT_FAMILY.into(),
            font_weight: 400.0,
            font_style: FontStyle::Normal,
            font_size: 24.0,
            fills: vec![Fill::solid(color(DEFAULT_TEXT_COLOR))],
            letter_spacing: 0.0,
            text_case: TextCase::None,
            decoration: TextDecoration::None,
            link: None,
            highlight: None,
            features: None,
            variations: None,
            extra: Default::default(),
        }
    }
}

impl Default for TextStyle {
    fn default() -> Self {
        Self::default_style()
    }
}

impl ParagraphStyle {
    /// Default paragraph style (mirrors `defaultParagraph()`): left, auto direction, 120% line height.
    pub fn default_style() -> Self {
        ParagraphStyle {
            align: TextAlign::Left,
            direction: TextDirection::Auto,
            line_height: LineHeight {
                unit: LineHeightUnit::Percent,
                value: 120.0,
                extra: Default::default(),
            },
            spacing: 0.0,
            indent: 0.0,
            list: ListStyle::None,
            extra: Default::default(),
        }
    }
}

impl Default for ParagraphStyle {
    fn default() -> Self {
        Self::default_style()
    }
}

impl Shaped {
    /// Shape paint with one solid fill and no strokes.
    pub fn with_fill(fill: Color) -> Self {
        Shaped {
            fills: vec![Fill::solid(fill)],
            strokes: Vec::new(),
            corner_radius: CornerRadius::Uniform(0.0),
            corner_smoothing: None,
        }
    }
}

impl Node {
    /// The root node.
    pub fn root() -> Node {
        let mut base = Base::new(ROOT_ID, "Root", 0.0, 0.0, 0.0, 0.0);
        base.parent = None;
        Node::Root(RootNode {
            base,
            children: Vec::new(),
            extra: Map::new(),
        })
    }

    /// Page with a white background, clipping on, px unit, no bleed.
    pub fn page(id: impl Into<Id>, name: impl Into<String>, width: f64, height: f64) -> Node {
        let mut base = Base::new(id, name, 0.0, 0.0, width, height);
        base.parent = Some(ROOT_ID.into());
        Node::Page(PageNode {
            base,
            container: Container {
                children: Vec::new(),
                clip: true,
                layout: None,
            },
            unit: Unit::Px,
            background: vec![Fill::solid(color("#ffffff"))],
            bleed: 0.0,
            duration_ms: None,
            transition: None,
            grid: None,
            guides: None,
            extra: Map::new(),
        })
    }

    /// Frame with a white fill and clipping on.
    pub fn frame(
        id: impl Into<Id>,
        name: impl Into<String>,
        x: f64,
        y: f64,
        w: f64,
        h: f64,
    ) -> Node {
        Node::Frame(FrameNode {
            base: Base::new(id, name, x, y, w, h),
            container: Container {
                children: Vec::new(),
                clip: true,
                layout: None,
            },
            shape: Shaped::with_fill(color("#ffffff")),
            extra: Map::new(),
        })
    }

    /// Empty group (bounds are recomputed from children by layout normalization).
    pub fn group(
        id: impl Into<Id>,
        name: impl Into<String>,
        x: f64,
        y: f64,
        w: f64,
        h: f64,
    ) -> Node {
        Node::Group(GroupNode {
            base: Base::new(id, name, x, y, w, h),
            container: Container {
                children: Vec::new(),
                clip: false,
                layout: None,
            },
            extra: Map::new(),
        })
    }

    /// Boolean container.
    pub fn boolean(
        id: impl Into<Id>,
        name: impl Into<String>,
        op: BoolOp,
        x: f64,
        y: f64,
        w: f64,
        h: f64,
    ) -> Node {
        Node::Boolean(BooleanNode {
            base: Base::new(id, name, x, y, w, h),
            container: Container {
                children: Vec::new(),
                clip: false,
                layout: None,
            },
            shape: Shaped::with_fill(color(DEFAULT_SHAPE_FILL)),
            op,
            extra: Map::new(),
        })
    }

    /// Rectangle with the default gray fill.
    pub fn rect(
        id: impl Into<Id>,
        name: impl Into<String>,
        x: f64,
        y: f64,
        w: f64,
        h: f64,
    ) -> Node {
        Node::Rect(RectNode {
            base: Base::new(id, name, x, y, w, h),
            shape: Shaped::with_fill(color(DEFAULT_SHAPE_FILL)),
            extra: Map::new(),
        })
    }

    /// Ellipse with the default gray fill.
    pub fn ellipse(
        id: impl Into<Id>,
        name: impl Into<String>,
        x: f64,
        y: f64,
        w: f64,
        h: f64,
    ) -> Node {
        Node::Ellipse(EllipseNode {
            base: Base::new(id, name, x, y, w, h),
            shape: Shaped::with_fill(color(DEFAULT_SHAPE_FILL)),
            arc: None,
            extra: Map::new(),
        })
    }

    /// Regular polygon (`sides` clamped to >= 3).
    pub fn polygon(
        id: impl Into<Id>,
        name: impl Into<String>,
        sides: u64,
        x: f64,
        y: f64,
        w: f64,
        h: f64,
    ) -> Node {
        Node::Polygon(PolygonNode {
            base: Base::new(id, name, x, y, w, h),
            shape: Shaped::with_fill(color(DEFAULT_SHAPE_FILL)),
            sides: sides.max(3),
            extra: Map::new(),
        })
    }

    /// Star (`points` clamped to >= 3).
    #[allow(clippy::too_many_arguments)]
    pub fn star(
        id: impl Into<Id>,
        name: impl Into<String>,
        points: u64,
        inner_ratio: f64,
        x: f64,
        y: f64,
        w: f64,
        h: f64,
    ) -> Node {
        Node::Star(StarNode {
            base: Base::new(id, name, x, y, w, h),
            shape: Shaped::with_fill(color(DEFAULT_SHAPE_FILL)),
            points: points.max(3),
            inner_ratio: inner_ratio.clamp(0.0, 1.0),
            extra: Map::new(),
        })
    }

    /// Line from (x, y) with the given length along +x, 2px `#111111` stroke, no caps.
    pub fn line(id: impl Into<Id>, name: impl Into<String>, x: f64, y: f64, length: f64) -> Node {
        Node::Line(LineNode {
            base: Base::new(id, name, x, y, length, 0.0),
            strokes: vec![Stroke::solid(color("#111111"), 2.0)],
            start_cap: Cap::None,
            end_cap: Cap::None,
            extra: Map::new(),
        })
    }

    /// Path node from SVG data (local box coordinates).
    pub fn path(
        id: impl Into<Id>,
        name: impl Into<String>,
        d: impl Into<String>,
        x: f64,
        y: f64,
        w: f64,
        h: f64,
    ) -> Node {
        Node::Path(PathNode {
            base: Base::new(id, name, x, y, w, h),
            shape: Shaped::with_fill(color(DEFAULT_SHAPE_FILL)),
            paths: vec![PathData {
                d: d.into(),
                fill_rule: FillRule::Nonzero,
                extra: Default::default(),
            }],
            extra: Map::new(),
        })
    }

    /// Text node with the default style. `autoResize` is `width` when `width` is `None`, else `height`.
    pub fn text(
        id: impl Into<Id>,
        text: impl Into<String>,
        x: f64,
        y: f64,
        width: Option<f64>,
    ) -> Node {
        let text = text.into();
        let name: String = text.chars().take(40).collect();
        let style = TextStyle::default_style();
        let (w, auto) = match width {
            Some(w) => (w, AutoResize::Height),
            None => (0.0, AutoResize::Width),
        };
        Node::Text(TextNode {
            base: Base::new(
                id,
                if name.is_empty() {
                    "Text".to_string()
                } else {
                    name
                },
                x,
                y,
                w,
                (style.font_size * 1.2).round(),
            ),
            runs: vec![TextRun::plain(text)],
            style,
            paragraph: ParagraphStyle::default_style(),
            auto_resize: auto,
            max_lines: None,
            curve: None,
            vertical_align: VerticalAlign::Top,
            strokes: None,
            style_ref: None,
            extra: Map::new(),
        })
    }

    /// Image node filling its box.
    pub fn image(
        id: impl Into<Id>,
        name: impl Into<String>,
        asset_id: impl Into<Id>,
        x: f64,
        y: f64,
        w: f64,
        h: f64,
    ) -> Node {
        Node::Image(ImageNode {
            base: Base::new(id, name, x, y, w, h),
            asset_id: asset_id.into(),
            fit: ImageFit::Fill,
            crop: None,
            corner_radius: CornerRadius::Uniform(0.0),
            shape: None,
            adjust: None,
            strokes: Vec::new(),
            mask_asset_id: None,
            extra: Map::new(),
        })
    }

    /// Svg node from an asset.
    pub fn svg(
        id: impl Into<Id>,
        name: impl Into<String>,
        asset_id: impl Into<Id>,
        x: f64,
        y: f64,
        w: f64,
        h: f64,
    ) -> Node {
        Node::Svg(SvgNode {
            base: Base::new(id, name, x, y, w, h),
            asset_id: Some(asset_id.into()),
            markup: None,
            recolor: None,
            strokes: None,
            extra: Map::new(),
        })
    }

    /// QR code, black on white, error correction M.
    pub fn qr(id: impl Into<Id>, data: impl Into<String>, x: f64, y: f64, size: f64) -> Node {
        Node::Qr(QrNode {
            base: Base::new(id, "QR code", x, y, size, size),
            data: data.into(),
            fg: color("#000000"),
            bg: color("#ffffff"),
            error_correction: QrErrorCorrection::M,
            rounded: false,
            extra: Map::new(),
        })
    }

    /// Returns this node with `parent` set (builder helper).
    pub fn with_parent(mut self, parent: impl Into<Id>) -> Node {
        self.base_mut().parent = Some(parent.into());
        self
    }
}

impl Design {
    /// Empty design (root only), schema 1, empty styles/meta.
    pub fn new(id: impl Into<Id>, name: impl Into<String>, kind: DesignKind) -> Design {
        let mut nodes = NodeMap::default();
        nodes.insert(ROOT_ID.into(), Node::root());
        Design {
            schema: 1,
            id: id.into(),
            name: name.into(),
            kind,
            nodes,
            assets: Default::default(),
            styles: DesignStyles::default(),
            brand_kit_id: None,
            meta: Map::new(),
            extra: Map::new(),
        }
    }

    /// Design with one page of the given size.
    pub fn with_page(
        id: impl Into<Id>,
        name: impl Into<String>,
        kind: DesignKind,
        page_id: impl Into<Id>,
        width: f64,
        height: f64,
    ) -> Design {
        let mut d = Design::new(id, name, kind);
        let page_id = page_id.into();
        d.nodes.insert(
            page_id.clone(),
            Node::page(page_id.clone(), "Page 1", width, height),
        );
        if let Some(Node::Root(r)) = d.nodes.get_mut(ROOT_ID) {
            r.children.push(page_id);
        }
        d
    }

    /// Inserts `node` as the last child of `parent` without validation (builder for tests and importers).
    /// Returns false when the parent is missing or not a container.
    pub fn push_child(&mut self, parent: &str, mut node: Node) -> bool {
        let id = node.id().to_string();
        match self.nodes.get_mut(parent).and_then(Node::children_mut) {
            Some(ch) => ch.push(id.clone()),
            None => return false,
        }
        node.base_mut().parent = Some(parent.to_string());
        self.nodes.insert(id, node);
        true
    }
}
