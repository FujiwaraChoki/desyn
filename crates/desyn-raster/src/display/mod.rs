//! Display lists: the backend-neutral render tree built from a design page.
//!
//! A [`DisplayList`] is a tree of [`Layer`]s (one per rendered node plus internal groups) holding draw [`Item`]s
//! in layer-local coordinates. Every layer carries a stable content [`Layer::key`] (hash of the node subtree,
//! the resolved styles / fonts / assets it depends on and the animation time) and its paint bounds, so clients can
//! cache rendered layers and compute damage rectangles. The rasterizer, the SVG writer and the PDF writer all
//! consume the same list.

mod build;
mod chart;
mod damage;
mod image;
mod qr;
mod shapes;
mod svg;
mod table;
mod text;

use std::ops::Range;
use std::sync::Arc;

use desyn_core::geometry::{Affine, Point, Rect};
use desyn_core::model::{BlendMode, Id};

use crate::assets::RasterImage;
use crate::paint::{Color4, Paint, Quality};

pub use build::{BuildCache, BuildOptions, DisplayListBuilder, MAX_RENDER_DEPTH};
pub use damage::{damage, damage_rects};
pub use image::{Fit, placement};

/// Shared tiny-skia path (f32, layer-local coordinates).
pub type Path = Arc<tiny_skia::Path>;

/// Fill rule.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum FillRule {
    /// Nonzero winding.
    #[default]
    Nonzero,
    /// Even-odd.
    EvenOdd,
}

impl FillRule {
    /// tiny-skia rule.
    pub fn to_skia(self) -> tiny_skia::FillRule {
        match self {
            FillRule::Nonzero => tiny_skia::FillRule::Winding,
            FillRule::EvenOdd => tiny_skia::FillRule::EvenOdd,
        }
    }
}

/// Line cap.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum LineCap {
    /// Butt.
    #[default]
    Butt,
    /// Round.
    Round,
    /// Square.
    Square,
}

/// Line join.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum LineJoin {
    /// Miter.
    #[default]
    Miter,
    /// Round.
    Round,
    /// Bevel.
    Bevel,
}

/// Centered stroke geometry.
#[derive(Debug, Clone, PartialEq)]
pub struct StrokeStyle {
    /// Width (layer-local units).
    pub width: f64,
    /// Cap.
    pub cap: LineCap,
    /// Join.
    pub join: LineJoin,
    /// Miter limit.
    pub miter_limit: f64,
    /// Dash array (even length, all >= 0, positive sum) and offset.
    pub dash: Option<(Vec<f64>, f64)>,
}

impl StrokeStyle {
    /// tiny-skia stroke.
    pub fn to_skia(&self) -> tiny_skia::Stroke {
        tiny_skia::Stroke {
            width: self.width as f32,
            miter_limit: self.miter_limit.max(1.0) as f32,
            line_cap: match self.cap {
                LineCap::Butt => tiny_skia::LineCap::Butt,
                LineCap::Round => tiny_skia::LineCap::Round,
                LineCap::Square => tiny_skia::LineCap::Square,
            },
            line_join: match self.join {
                LineJoin::Miter => tiny_skia::LineJoin::Miter,
                LineJoin::Round => tiny_skia::LineJoin::Round,
                LineJoin::Bevel => tiny_skia::LineJoin::Bevel,
            },
            dash: self.dash.as_ref().and_then(|(d, off)| {
                tiny_skia::StrokeDash::new(d.iter().map(|v| *v as f32).collect(), *off as f32)
            }),
        }
    }

    /// How far the stroke can reach outside the path (miter joins included).
    pub fn outset(&self) -> f64 {
        let half = self.width / 2.0;
        match self.join {
            LineJoin::Miter => half * self.miter_limit.max(1.0),
            _ => half,
        }
        .max(if self.cap == LineCap::Square {
            half * std::f64::consts::SQRT_2
        } else {
            half
        })
    }
}

/// Filled path.
#[derive(Debug, Clone)]
pub struct FillItem {
    /// Geometry.
    pub path: Path,
    /// Fill rule.
    pub rule: FillRule,
    /// Paint.
    pub paint: Paint,
    /// Paint opacity (0..1).
    pub opacity: f32,
    /// Blend mode of this paint with everything below.
    pub blend: BlendMode,
    /// Bounds (local).
    pub bounds: Rect,
}

/// Stroked path (centered).
#[derive(Debug, Clone)]
pub struct StrokeItem {
    /// Geometry.
    pub path: Path,
    /// Stroke.
    pub stroke: StrokeStyle,
    /// Paint.
    pub paint: Paint,
    /// Opacity.
    pub opacity: f32,
    /// Blend mode.
    pub blend: BlendMode,
    /// Bounds including the stroke (local).
    pub bounds: Rect,
}

/// Unclipped image: the image pixel rectangle mapped by `transform`.
#[derive(Debug, Clone)]
pub struct ImageItem {
    /// Image.
    pub image: Arc<RasterImage>,
    /// Image pixel space to local.
    pub transform: Affine,
    /// Opacity.
    pub opacity: f32,
    /// Blend mode.
    pub blend: BlendMode,
    /// Sampling quality.
    pub quality: Quality,
    /// Bounds (local).
    pub bounds: Rect,
}

/// A font instance used by text items (vector exporters embed it).
#[derive(Debug, Clone)]
pub struct FontEntry {
    /// Face id in the text engine.
    pub face: u32,
    /// Font file bytes.
    pub data: Arc<[u8]>,
    /// Face index inside a collection.
    pub index: u32,
    /// Family name.
    pub family: String,
    /// PostScript name.
    pub postscript_name: String,
    /// CSS weight of the instance.
    pub weight: f32,
    /// Weight range of the face (variable fonts span several weights).
    pub weight_range: (f32, f32),
    /// Italic / oblique.
    pub italic: bool,
    /// Variation axis values of the instance.
    pub variations: Vec<(String, f32)>,
    /// Units per em.
    pub units_per_em: f64,
}

/// Fonts referenced by the text items of a display list (filled when [`BuildOptions::vector`] is set).
#[derive(Debug, Clone, Default)]
pub struct FontTable {
    /// Entries, indexed by [`GlyphRunItem::font`].
    pub entries: Vec<FontEntry>,
}

/// A glyph placed by the text engine.
#[derive(Debug, Clone, PartialEq)]
pub struct GlyphItem {
    /// Glyph id.
    pub id: u32,
    /// Origin x (local).
    pub x: f64,
    /// Origin y on the baseline (local).
    pub y: f64,
    /// Advance (px).
    pub advance: f64,
    /// Source text (UTF-8 byte range in [`GlyphRunItem::text`]) of the glyph's cluster.
    pub text: Range<usize>,
}

/// One shaped run, for vector exporters (real text in PDF / SVG).
#[derive(Debug, Clone)]
pub struct GlyphRunItem {
    /// Index into [`FontTable::entries`].
    pub font: usize,
    /// Font size (px).
    pub size: f64,
    /// Synthetic oblique skew factor.
    pub skew: f64,
    /// Synthetic bold stroke width (px, 0 = none).
    pub bold: f64,
    /// Glyphs.
    pub glyphs: Vec<GlyphItem>,
    /// Source text of the node (shared by its runs).
    pub text: Arc<str>,
}

/// Text painted with one paint: the outline for rasterizers plus the shaped runs for vector exporters.
#[derive(Debug, Clone)]
pub struct TextItem {
    /// Glyph outlines (nonzero).
    pub outline: Path,
    /// Paint.
    pub paint: Paint,
    /// Opacity.
    pub opacity: f32,
    /// Blend mode.
    pub blend: BlendMode,
    /// Synthetic bold: stroke the outline with this width (px) as well.
    pub bold: f64,
    /// Runs (empty unless [`BuildOptions::vector`]; exporters then fall back to the outline).
    pub runs: Vec<GlyphRunItem>,
    /// Bounds (local).
    pub bounds: Rect,
}

/// A draw operation.
#[derive(Debug, Clone)]
pub enum Item {
    /// Fill.
    Fill(FillItem),
    /// Stroke.
    Stroke(StrokeItem),
    /// Image.
    Image(ImageItem),
    /// Text.
    Text(TextItem),
    /// Nested layer.
    Layer(Box<Layer>),
}

impl Item {
    /// Bounds in the containing layer's local space.
    pub fn bounds(&self) -> Rect {
        match self {
            Item::Fill(f) => f.bounds,
            Item::Stroke(s) => s.bounds,
            Item::Image(i) => i.bounds,
            Item::Text(t) => t.bounds,
            Item::Layer(l) => l.bounds,
        }
    }

    fn leaf_count(&self, cap: usize) -> usize {
        match self {
            Item::Layer(l) => l.leaf_count(cap),
            _ => 1,
        }
    }
}

/// Clip geometry (local).
#[derive(Debug, Clone)]
pub struct Clip {
    /// Path.
    pub path: Path,
    /// Rule.
    pub rule: FillRule,
    /// Set when the clip is exactly this axis-aligned rectangle (enables cheaper clipping).
    pub rect: Option<Rect>,
}

/// How a mask layer's pixels mask content.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum MaskKind {
    /// Alpha channel.
    #[default]
    Alpha,
    /// Luminance (times alpha).
    Luminance,
}

/// Mask content: rendered in the masked layer's local space.
#[derive(Debug, Clone)]
pub struct LayerMask {
    /// Mask content (its `transform` maps into the masked layer's local space).
    pub layer: Layer,
    /// Kind.
    pub kind: MaskKind,
}

/// A layer effect in local units.
#[derive(Debug, Clone, PartialEq)]
pub enum LayerEffect {
    /// Drop shadow (CSS box-shadow semantics: `blur` is the blur radius, sigma = blur / 2).
    DropShadow {
        /// Offset x.
        dx: f64,
        /// Offset y.
        dy: f64,
        /// Blur radius.
        blur: f64,
        /// Spread.
        spread: f64,
        /// Color.
        color: Color4,
    },
    /// Inner shadow.
    InnerShadow {
        /// Offset x.
        dx: f64,
        /// Offset y.
        dy: f64,
        /// Blur radius.
        blur: f64,
        /// Spread (choke).
        spread: f64,
        /// Color.
        color: Color4,
    },
    /// Gaussian blur of the layer (sigma = radius / 2).
    LayerBlur {
        /// Radius.
        radius: f64,
    },
    /// Blur of the backdrop inside the layer's shape (sigma = radius / 2).
    BackgroundBlur {
        /// Radius.
        radius: f64,
    },
    /// Outer glow.
    Glow {
        /// Radius.
        radius: f64,
        /// Strength 0..1.
        strength: f64,
        /// Color.
        color: Color4,
    },
    /// Grain overlay inside the layer's shape.
    Noise {
        /// Amount 0..1.
        amount: f64,
        /// Grain size (px).
        scale: f64,
        /// Monochrome.
        mono: bool,
        /// Deterministic seed.
        seed: u64,
    },
}

impl LayerEffect {
    /// Paint extent outside the content `[left, top, right, bottom]` (3 sigma for blurs).
    pub fn outsets(&self) -> [f64; 4] {
        match *self {
            LayerEffect::DropShadow {
                dx,
                dy,
                blur,
                spread,
                ..
            } => {
                let r = blur.max(0.0) * 1.5 + spread.max(0.0);
                [
                    (r - dx).max(0.0),
                    (r - dy).max(0.0),
                    (r + dx).max(0.0),
                    (r + dy).max(0.0),
                ]
            }
            LayerEffect::LayerBlur { radius } => [radius.max(0.0) * 1.5; 4],
            LayerEffect::Glow { radius, .. } => [radius.max(0.0) * 1.5; 4],
            _ => [0.0; 4],
        }
    }
}

/// What a layer represents.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LayerKind {
    /// The page (root of the list).
    Page,
    /// A design node.
    Node,
    /// A mask node and the siblings it masks.
    MaskGroup,
    /// Internal grouping (SVG groups, chart parts, clipped images).
    Group,
}

/// A group of items with a transform, opacity, blend mode, optional clip / mask and effects.
#[derive(Debug, Clone)]
pub struct Layer {
    /// Kind.
    pub kind: LayerKind,
    /// Design node id (node and page layers).
    pub node: Option<Id>,
    /// Stable content key of everything this layer draws (cache key).
    pub key: u64,
    /// Key of the layer's own leaf items (excluding child layers); damage tracking compares it.
    pub paint_key: u64,
    /// Local to parent space.
    pub transform: Affine,
    /// Group opacity.
    pub opacity: f32,
    /// Blend mode of the group with its backdrop.
    pub blend: BlendMode,
    /// Clip (local).
    pub clip: Option<Clip>,
    /// Mask.
    pub mask: Option<Box<LayerMask>>,
    /// Effects, in paint order.
    pub effects: Vec<LayerEffect>,
    /// Children, back to front.
    pub items: Vec<Item>,
    /// Content bounds (local, without effects).
    pub content_bounds: Rect,
    /// Paint bounds in the parent's space (transform, clip and effects applied).
    pub bounds: Rect,
}

impl Layer {
    /// Empty layer.
    pub fn new(kind: LayerKind, node: Option<Id>, transform: Affine) -> Self {
        Layer {
            kind,
            node,
            key: 0,
            paint_key: 0,
            transform,
            opacity: 1.0,
            blend: BlendMode::Normal,
            clip: None,
            mask: None,
            effects: Vec::new(),
            items: Vec::new(),
            content_bounds: Rect::new(0.0, 0.0, 0.0, 0.0),
            bounds: Rect::new(0.0, 0.0, 0.0, 0.0),
        }
    }

    /// Copy of the layer without its items.
    pub fn clone_header(&self) -> Layer {
        Layer {
            kind: self.kind,
            node: self.node.clone(),
            key: self.key,
            paint_key: self.paint_key,
            transform: self.transform,
            opacity: self.opacity,
            blend: self.blend,
            clip: self.clip.clone(),
            mask: self.mask.clone(),
            effects: self.effects.clone(),
            items: Vec::new(),
            content_bounds: self.content_bounds,
            bounds: self.bounds,
        }
    }

    /// Recomputes `content_bounds` and `bounds` from the items, clip, effects and transform.
    pub fn update_bounds(&mut self) {
        let mut content: Option<Rect> = None;
        for it in &self.items {
            content = crate::geom::union_rect(content, &it.bounds());
        }
        let mut c = content.unwrap_or(Rect::new(0.0, 0.0, 0.0, 0.0));
        if let Some(clip) = &self.clip {
            let cb = crate::geom::path_bounds(&clip.path);
            c = c
                .intersection(&cb)
                .unwrap_or(Rect::new(cb.x, cb.y, 0.0, 0.0));
        }
        if let Some(m) = &self.mask {
            let mb = m.layer.bounds;
            c = c
                .intersection(&mb)
                .unwrap_or(Rect::new(mb.x, mb.y, 0.0, 0.0));
        }
        self.content_bounds = c;
        let mut paint = c;
        if c.w > 0.0 || c.h > 0.0 {
            for e in &self.effects {
                paint = paint.outset(e.outsets());
            }
        }
        self.bounds = crate::geom::transform_rect(&self.transform, &paint);
    }

    /// Number of drawable leaves (stops counting at `cap`).
    pub fn leaf_count(&self, cap: usize) -> usize {
        let mut n = 0;
        for it in &self.items {
            n += it.leaf_count(cap - n.min(cap));
            if n >= cap {
                return cap;
            }
        }
        n
    }

    /// Depth-first search for the layer of a node.
    pub fn find(&self, node: &str) -> Option<&Layer> {
        if self.node.as_deref() == Some(node) {
            return Some(self);
        }
        self.items.iter().find_map(|it| match it {
            Item::Layer(l) => l.find(node),
            _ => None,
        })
    }

    /// Total number of items (all depths).
    pub fn item_count(&self) -> usize {
        self.items
            .iter()
            .map(|it| match it {
                Item::Layer(l) => 1 + l.item_count(),
                _ => 1,
            })
            .sum()
    }
}

/// Where a link points.
#[derive(Debug, Clone, PartialEq)]
pub enum LinkTarget {
    /// External URL.
    Url(String),
    /// Another page of the design (`page:<id>`).
    Page(Id),
}

/// URL schemes a design link may use; anything else (`javascript:`, `data:`, `file:`, `vbscript:`, ...) is dropped
/// because exported SVG / PDF / PPTX files are opened in browsers and office suites.
pub const LINK_SCHEMES: [&str; 4] = ["http", "https", "mailto", "tel"];

/// Parses a design link (`node.link`, `TextStyle.link`): `"page:<id>"` or a URL with a safe scheme. Bare
/// host names (`desyn.app/pricing`) and scheme-relative URLs get `https:`. Returns `None` for empty, relative or
/// unsafe links.
pub fn parse_link(s: &str) -> Option<LinkTarget> {
    // Browsers ignore tabs and newlines inside URLs ("java\tscript:"), so they must not hide a scheme here.
    let s: String = s
        .trim()
        .chars()
        .filter(|c| !matches!(c, '\t' | '\n' | '\r'))
        .collect();
    if s.is_empty() || s.chars().any(char::is_control) {
        return None;
    }
    if let Some(p) = s.strip_prefix("page:") {
        let p = p.trim();
        return (!p.is_empty()).then(|| LinkTarget::Page(p.to_string()));
    }
    let s = s.replace(' ', "%20");
    if let Some(rest) = s.strip_prefix("//") {
        return host_like(rest).then(|| LinkTarget::Url(format!("https:{s}")));
    }
    let scheme_end = s.find(':');
    let scheme = scheme_end.map(|i| &s[..i]).filter(|sc| {
        let mut cs = sc.chars();
        cs.next().is_some_and(|c| c.is_ascii_alphabetic())
            && cs.all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-'))
    });
    match scheme {
        Some(sc) => LINK_SCHEMES
            .iter()
            .any(|ok| sc.eq_ignore_ascii_case(ok))
            .then(|| LinkTarget::Url(s.clone())),
        // No scheme: `desyn.app/x`, `www.desyn.app:8080` (a host with a port is not a scheme).
        None => host_like(&s).then(|| LinkTarget::Url(format!("https://{s}"))),
    }
}

/// `host[:port][/...]` with a dotted host name.
fn host_like(s: &str) -> bool {
    let host = s.split(['/', '?', '#']).next().unwrap_or("");
    let name = host.split(':').next().unwrap_or("");
    name.contains('.')
        && !name.starts_with('.')
        && name
            .chars()
            .all(|c| c.is_alphanumeric() || matches!(c, '.' | '-' | '_'))
}

/// A clickable area (page coordinates).
#[derive(Debug, Clone, PartialEq)]
pub struct LinkArea {
    /// Quad (clockwise from top-left).
    pub quad: [Point; 4],
    /// Axis-aligned bounds of the quad.
    pub rect: Rect,
    /// Target.
    pub target: LinkTarget,
}

/// The render tree of one page.
#[derive(Debug, Clone)]
pub struct DisplayList {
    /// Page id.
    pub page: Id,
    /// Page width (design px).
    pub width: f64,
    /// Page height.
    pub height: f64,
    /// Print bleed of the page (px); content extends this far when built with `bleed`.
    pub bleed: f64,
    /// Root layer (page coordinates; page background first).
    pub root: Layer,
    /// Links (URLs and page links) in page coordinates.
    pub links: Vec<LinkArea>,
    /// Fonts of text runs (vector builds).
    pub fonts: FontTable,
    /// Asset ids that had no bytes (hosts fetch them and rebuild).
    pub missing_assets: Vec<String>,
    /// Font families requested by text layout but not registered.
    pub missing_fonts: Vec<String>,
    /// Non-fatal problems (undecodable assets, unparsable SVG / path data).
    pub warnings: Vec<String>,
    /// Animation time the list was built for.
    pub time_ms: Option<f64>,
}

impl DisplayList {
    /// Page rectangle (trim box).
    pub fn page_rect(&self) -> Rect {
        Rect::new(0.0, 0.0, self.width, self.height)
    }

    /// Page rectangle grown by the bleed.
    pub fn bleed_rect(&self) -> Rect {
        Rect::new(
            -self.bleed,
            -self.bleed,
            self.width + 2.0 * self.bleed,
            self.height + 2.0 * self.bleed,
        )
    }

    /// Layer of a node.
    pub fn find(&self, node: &str) -> Option<&Layer> {
        self.root.find(node)
    }

    /// Total item count.
    pub fn item_count(&self) -> usize {
        self.root.item_count()
    }
}
