//! Shape geometry, fills and strokes (alignment, dashes, joins, caps, per-side rectangle strokes), lines.

use std::sync::Arc;

use desyn_core::geometry::{Affine, Rect};
use desyn_core::model::{
    BlendMode, Fill, FillRule as ModelRule, ImageShape, ImageShapeKind, LineNode, Node, Stroke,
    StrokeAlign, StrokeCap, StrokeJoin,
};
use desyn_core::paths::kurbo::{self, BezPath, PathEl};
use desyn_core::paths::{
    StrokeStyle as CoreStroke, aligned_stroke_outline, ellipse_path, line_geometry, node_outline,
    parse_svg_path, rect_path,
};

use super::build::DisplayListBuilder;
use super::{Clip, FillItem, FillRule, Item, LineCap, LineJoin, Path, StrokeItem, StrokeStyle};
use crate::geom::{self, bez_to_path, path_bounds};
use crate::paint::{self, Paint};

/// Analytic shape classes (exact inside / outside strokes without boolean operations).
#[derive(Debug, Clone, Copy, PartialEq)]
pub(super) enum ShapeKind {
    /// Rounded rectangle (`radii` tl tr br bl).
    Rect {
        w: f64,
        h: f64,
        radii: [f64; 4],
        smoothing: f64,
    },
    /// Full ellipse.
    Ellipse { w: f64, h: f64 },
    /// Anything else.
    Other,
}

/// A node's fill geometry in local coordinates.
#[derive(Debug, Clone)]
pub(super) struct Shape {
    pub path: Path,
    pub bez: BezPath,
    pub rule: FillRule,
    pub kind: ShapeKind,
    pub closed: bool,
    /// Top-left of the analytic box (rect / ellipse kinds).
    pub origin: (f64, f64),
}

fn all_closed(b: &BezPath) -> bool {
    let mut open = false;
    let mut closed = true;
    for el in b.elements() {
        match el {
            PathEl::MoveTo(_) => {
                if open {
                    closed = false;
                }
                open = true;
            }
            PathEl::ClosePath => open = false,
            _ => {}
        }
    }
    closed && !open
}

impl Shape {
    pub fn from_bez(bez: BezPath, rule: FillRule, kind: ShapeKind) -> Option<Shape> {
        let path = bez_to_path(&bez)?;
        Some(Shape {
            path: Arc::new(path),
            closed: all_closed(&bez),
            bez,
            rule,
            kind,
            origin: (0.0, 0.0),
        })
    }

    /// Rectangle-like shape from an already built path.
    pub fn rect_like(
        path: tiny_skia::Path,
        w: f64,
        h: f64,
        radii: [f64; 4],
        smoothing: f64,
    ) -> Shape {
        let bez = geom::path_to_bez(&path);
        Shape {
            path: Arc::new(path),
            bez,
            rule: FillRule::Nonzero,
            kind: ShapeKind::Rect {
                w,
                h,
                radii,
                smoothing,
            },
            closed: true,
            origin: (0.0, 0.0),
        }
    }

    /// Declares the analytic box origin (the path is already positioned).
    pub fn translated_box(mut self, x: f64, y: f64) -> Shape {
        self.origin = (x, y);
        self
    }

    pub fn bounds(&self) -> Rect {
        path_bounds(&self.path)
    }

    pub fn clip(&self) -> Clip {
        let rect = match self.kind {
            ShapeKind::Rect { w, h, radii, .. } if radii.iter().all(|r| *r <= 0.0) => {
                Some(Rect::new(self.origin.0, self.origin.1, w, h))
            }
            _ => None,
        };
        Clip {
            path: self.path.clone(),
            rule: self.rule,
            rect,
        }
    }
}

/// Rounded-rectangle path at `(x, y)`.
pub(super) fn rounded_rect(
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    radii: [f64; 4],
    smoothing: f64,
) -> Option<BezPath> {
    if !(w > 0.0 && h > 0.0) {
        return None;
    }
    let mut b = if radii.iter().all(|r| *r <= 0.0) {
        let mut b = BezPath::new();
        b.move_to((0.0, 0.0));
        b.line_to((w, 0.0));
        b.line_to((w, h));
        b.line_to((0.0, h));
        b.close_path();
        b
    } else {
        rect_path(w, h, radii, smoothing)
    };
    if x != 0.0 || y != 0.0 {
        b.apply_affine(kurbo::Affine::translate((x, y)));
    }
    Some(b)
}

fn ellipse_at(x: f64, y: f64, w: f64, h: f64) -> Option<BezPath> {
    if !(w > 0.0 && h > 0.0) {
        return None;
    }
    let mut b = ellipse_path(w, h, None);
    b.apply_affine(kurbo::Affine::translate((x, y)));
    Some(b)
}

pub(super) fn model_rule(r: ModelRule) -> FillRule {
    match r {
        ModelRule::Nonzero => FillRule::Nonzero,
        ModelRule::Evenodd => FillRule::EvenOdd,
    }
}

/// Stroke style from a model stroke (dashes sanitized; patterns that would produce more than 100k dashes on
/// `path_len` are drawn solid).
pub(super) fn stroke_style(s: &Stroke, width: f64, path_len: f64) -> StrokeStyle {
    let mut dash: Vec<f64> = s
        .dash
        .iter()
        .flatten()
        .copied()
        .filter(|d| d.is_finite() && *d >= 0.0)
        .collect();
    if dash.len() % 2 == 1 {
        dash.extend(dash.clone());
    }
    let period: f64 = dash.iter().sum();
    let dash =
        (period > 1e-3 && !dash.is_empty() && path_len / period * dash.len() as f64 <= 100_000.0)
            .then_some((dash, 0.0));
    StrokeStyle {
        width,
        cap: match s.cap {
            StrokeCap::Butt => LineCap::Butt,
            StrokeCap::Round => LineCap::Round,
            StrokeCap::Square => LineCap::Square,
        },
        join: match s.join {
            StrokeJoin::Miter => LineJoin::Miter,
            StrokeJoin::Round => LineJoin::Round,
            StrokeJoin::Bevel => LineJoin::Bevel,
        },
        miter_limit: s
            .miter_limit
            .filter(|m| m.is_finite() && *m >= 1.0)
            .unwrap_or(4.0)
            .min(100.0),
        dash,
    }
}

/// Upper bound of a path's length (control polygon).
pub(super) fn path_len(b: &BezPath) -> f64 {
    let mut len = 0.0;
    let mut start = kurbo::Point::ZERO;
    let mut last = kurbo::Point::ZERO;
    for el in b.elements() {
        match *el {
            PathEl::MoveTo(p) => {
                start = p;
                last = p;
            }
            PathEl::LineTo(p) => {
                len += last.distance(p);
                last = p;
            }
            PathEl::QuadTo(a, p) => {
                len += last.distance(a) + a.distance(p);
                last = p;
            }
            PathEl::CurveTo(a, c, p) => {
                len += last.distance(a) + a.distance(c) + c.distance(p);
                last = p;
            }
            PathEl::ClosePath => {
                len += last.distance(start);
                last = start;
            }
        }
    }
    len
}

/// Moves a paint by `(dx, dy)` (paints are defined relative to a box origin).
pub(super) fn translate_paint(p: Paint, dx: f64, dy: f64) -> Paint {
    if dx == 0.0 && dy == 0.0 {
        return p;
    }
    let t = Affine::translate(dx, dy);
    match p {
        Paint::Solid(c) => Paint::Solid(c),
        Paint::Linear {
            start,
            end,
            stops,
            spread,
            transform,
        } => Paint::Linear {
            start,
            end,
            stops,
            spread,
            transform: t * transform,
        },
        Paint::Radial {
            c0,
            r0,
            c1,
            r1,
            stops,
            spread,
            transform,
        } => Paint::Radial {
            c0,
            r0,
            c1,
            r1,
            stops,
            spread,
            transform: t * transform,
        },
        Paint::Conic {
            center,
            start_deg,
            end_deg,
            stops,
            spread,
            transform,
        } => Paint::Conic {
            center,
            start_deg,
            end_deg,
            stops,
            spread,
            transform: t * transform,
        },
        Paint::Image(mut i) => {
            i.transform = t * i.transform;
            Paint::Image(i)
        }
    }
}

/// A resolved paint layer: paint, opacity, blend, and overlay paints drawn on top with the same geometry
/// (image vignette / grain).
pub(super) struct PaintLayer {
    pub paint: Paint,
    pub opacity: f32,
    pub blend: BlendMode,
    pub overlays: Vec<(Paint, f32, BlendMode)>,
}

impl DisplayListBuilder<'_> {
    /// Resolves a model fill against a `w x h` box at `origin`.
    pub(super) fn resolve_fill(
        &mut self,
        f: &Fill,
        w: f64,
        h: f64,
        origin: (f64, f64),
    ) -> Option<PaintLayer> {
        if !f.is_visible() {
            return None;
        }
        let flags = f.flags();
        let opacity = flags
            .opacity
            .filter(|o| o.is_finite())
            .unwrap_or(1.0)
            .clamp(0.0, 1.0) as f32;
        let blend = flags.blend.unwrap_or(BlendMode::Normal);
        let styles = &self.design.styles;
        let (paint, opacity, overlays) = match f {
            Fill::Solid(s) => {
                let c = paint::resolve(&s.color, styles)?;
                (Paint::Solid(c.with_alpha_mul(opacity)), 1.0, Vec::new())
            }
            Fill::Linear(l) => (paint::linear_paint(l, styles, w, h), opacity, Vec::new()),
            Fill::Radial(r) => (paint::radial_paint(r, styles, w, h), opacity, Vec::new()),
            Fill::Conic(c) => (paint::conic_paint(c, styles, w, h), opacity, Vec::new()),
            Fill::Image(i) => {
                let (p, overlays) = self.image_fill_paint(i, w, h)?;
                (p, opacity, overlays)
            }
        };
        if paint.is_invisible() {
            return None;
        }
        Some(PaintLayer {
            paint: translate_paint(paint, origin.0, origin.1),
            opacity,
            blend,
            overlays: overlays
                .into_iter()
                .map(|(p, o, b)| (translate_paint(p, origin.0, origin.1), o * opacity, b))
                .collect(),
        })
    }

    /// Fill items of `fills` over a shape.
    pub(super) fn fill_items(
        &mut self,
        shape: &Shape,
        fills: &[Fill],
        w: f64,
        h: f64,
        origin: (f64, f64),
    ) -> Vec<Item> {
        let bounds = shape.bounds();
        let mut out = Vec::new();
        for f in fills {
            let Some(pl) = self.resolve_fill(f, w, h, origin) else {
                continue;
            };
            out.push(Item::Fill(FillItem {
                path: shape.path.clone(),
                rule: shape.rule,
                paint: pl.paint,
                opacity: pl.opacity,
                blend: pl.blend,
                bounds,
            }));
            for (paint, opacity, blend) in pl.overlays {
                out.push(Item::Fill(FillItem {
                    path: shape.path.clone(),
                    rule: shape.rule,
                    paint,
                    opacity,
                    blend,
                    bounds,
                }));
            }
        }
        out
    }

    /// Geometry of one stroke: either a centered stroke of a path or a filled outline.
    fn stroke_geometry(&mut self, shape: &Shape, s: &Stroke) -> Option<StrokeGeom> {
        let width = if s.width.is_finite() {
            s.width.min(10_000.0)
        } else {
            0.0
        };
        let sides = per_side(s);
        if width <= 0.0 && sides.is_none() {
            return None;
        }
        let len = path_len(&shape.bez);
        let style = stroke_style(s, width, len);
        if let (
            Some(sides),
            ShapeKind::Rect {
                w,
                h,
                radii,
                smoothing,
            },
        ) = (sides, shape.kind)
        {
            let (ox, oy) = shape.origin;
            let [t, r, b, l] = sides;
            let k = match s.align {
                StrokeAlign::Inside => 0.0,
                StrokeAlign::Center => 0.5,
                StrokeAlign::Outside => 1.0,
            };
            let outer = rounded_rect(
                ox - l * k,
                oy - t * k,
                w + (l + r) * k,
                h + (t + b) * k,
                radii.map(|x| if x > 0.0 { x + (t.max(l)) * k } else { 0.0 }),
                smoothing,
            )?;
            let ki = 1.0 - k;
            let inner = rounded_rect(
                ox + l * ki,
                oy + t * ki,
                w - (l + r) * ki,
                h - (t + b) * ki,
                radii.map(|x| (x - t.max(l) * ki).max(0.0)),
                smoothing,
            );
            let mut ring = outer;
            if let Some(inner) = inner {
                ring.extend(inner);
            }
            return Some(StrokeGeom::Filled(ring, FillRule::EvenOdd));
        }
        if s.align == StrokeAlign::Center || !shape.closed {
            return Some(StrokeGeom::Centered(shape.path.clone(), style));
        }
        let (ox, oy) = shape.origin;
        match shape.kind {
            ShapeKind::Rect {
                w,
                h,
                radii,
                smoothing,
            } if style.dash.is_none() => {
                let (outer, inner) = if s.align == StrokeAlign::Inside {
                    (
                        rounded_rect(ox, oy, w, h, radii, smoothing),
                        rounded_rect(
                            ox + width,
                            oy + width,
                            w - 2.0 * width,
                            h - 2.0 * width,
                            radii.map(|r| (r - width).max(0.0)),
                            smoothing,
                        ),
                    )
                } else {
                    (
                        rounded_rect(
                            ox - width,
                            oy - width,
                            w + 2.0 * width,
                            h + 2.0 * width,
                            radii.map(|r| if r > 0.0 { r + width } else { 0.0 }),
                            smoothing,
                        ),
                        rounded_rect(ox, oy, w, h, radii, smoothing),
                    )
                };
                let mut ring = outer?;
                if let Some(i) = inner {
                    ring.extend(i);
                }
                Some(StrokeGeom::Filled(ring, FillRule::EvenOdd))
            }
            ShapeKind::Ellipse { w, h } if style.dash.is_none() => {
                let (outer, inner) = if s.align == StrokeAlign::Inside {
                    (
                        ellipse_at(ox, oy, w, h),
                        ellipse_at(ox + width, oy + width, w - 2.0 * width, h - 2.0 * width),
                    )
                } else {
                    (
                        ellipse_at(ox - width, oy - width, w + 2.0 * width, h + 2.0 * width),
                        ellipse_at(ox, oy, w, h),
                    )
                };
                let mut ring = outer?;
                if let Some(i) = inner {
                    ring.extend(i);
                }
                Some(StrokeGeom::Filled(ring, FillRule::EvenOdd))
            }
            _ => {
                let core = CoreStroke {
                    width,
                    cap: s.cap,
                    join: s.join,
                    miter_limit: style.miter_limit,
                    dash: style.dash.as_ref().map(|d| d.0.clone()).unwrap_or_default(),
                };
                let rule = match shape.rule {
                    FillRule::Nonzero => ModelRule::Nonzero,
                    FillRule::EvenOdd => ModelRule::Evenodd,
                };
                let outline = aligned_stroke_outline(&shape.bez, rule, &core, s.align, self.tol());
                if outline.elements().is_empty() {
                    return None;
                }
                Some(StrokeGeom::Filled(outline, FillRule::Nonzero))
            }
        }
    }

    /// Stroke items of a shape (each visible stroke, each visible paint).
    pub(super) fn stroke_items(
        &mut self,
        shape: &Shape,
        strokes: &[Stroke],
        w: f64,
        h: f64,
    ) -> Vec<Item> {
        let mut out = Vec::new();
        for s in strokes {
            if !(s.visible.unwrap_or(true) && s.fills.iter().any(Fill::is_visible)) {
                continue;
            }
            let Some(g) = self.stroke_geometry(shape, s) else {
                continue;
            };
            let geom_item: (Path, Option<StrokeStyle>, FillRule, Rect) = match g {
                StrokeGeom::Centered(p, st) => {
                    let b = path_bounds(&p).inflate(st.outset());
                    (p, Some(st), FillRule::Nonzero, b)
                }
                StrokeGeom::Filled(bez, rule) => {
                    let Some(p) = bez_to_path(&bez) else { continue };
                    let b = path_bounds(&p);
                    (Arc::new(p), None, rule, b)
                }
            };
            for f in &s.fills {
                let Some(pl) = self.resolve_fill(f, w, h, shape.origin) else {
                    continue;
                };
                let (path, style, rule, bounds) = geom_item.clone();
                out.push(match style {
                    Some(stroke) => Item::Stroke(StrokeItem {
                        path,
                        stroke,
                        paint: pl.paint,
                        opacity: pl.opacity,
                        blend: pl.blend,
                        bounds,
                    }),
                    None => Item::Fill(FillItem {
                        path,
                        rule,
                        paint: pl.paint,
                        opacity: pl.opacity,
                        blend: pl.blend,
                        bounds,
                    }),
                });
            }
        }
        out
    }

    /// Fill geometry of shape-like nodes, images and videos.
    pub(super) fn node_shape(&mut self, node: &Node) -> Option<Shape> {
        let b = node.base();
        let (w, h) = (b.width.max(0.0), b.height.max(0.0));
        let rect_kind = |n: &Node| {
            let radii = n
                .corner_radii()
                .map(|r| if r.is_finite() { r.max(0.0) } else { 0.0 });
            let smoothing = n
                .shaped()
                .and_then(|s| s.corner_smoothing)
                .filter(|v| v.is_finite())
                .unwrap_or(0.0)
                .clamp(0.0, 1.0);
            (radii, smoothing)
        };
        match node {
            Node::Frame(_) | Node::Rect(_) | Node::Video(_) => {
                let (radii, smoothing) = rect_kind(node);
                let bez = rounded_rect(0.0, 0.0, w, h, radii, smoothing)?;
                Shape::from_bez(
                    bez,
                    FillRule::Nonzero,
                    ShapeKind::Rect {
                        w,
                        h,
                        radii,
                        smoothing,
                    },
                )
            }
            Node::Image(i) => match &i.shape {
                Some(ImageShape::Named(ImageShapeKind::Ellipse)) => Shape::from_bez(
                    ellipse_at(0.0, 0.0, w, h)?,
                    FillRule::Nonzero,
                    ShapeKind::Ellipse { w, h },
                ),
                Some(ImageShape::Path { path, .. }) => match parse_svg_path(path) {
                    Ok(mut p) => {
                        p.apply_affine(kurbo::Affine::scale_non_uniform(w, h));
                        Shape::from_bez(p, FillRule::Nonzero, ShapeKind::Other)
                    }
                    Err(e) => {
                        self.warn(format!("image shape path: {e:?}"));
                        None
                    }
                },
                _ => {
                    let (radii, smoothing) = rect_kind(node);
                    let bez = rounded_rect(0.0, 0.0, w, h, radii, smoothing)?;
                    Shape::from_bez(
                        bez,
                        FillRule::Nonzero,
                        ShapeKind::Rect {
                            w,
                            h,
                            radii,
                            smoothing,
                        },
                    )
                }
            },
            Node::Ellipse(e) => {
                if !(w > 0.0 && h > 0.0) {
                    return None;
                }
                let kind = if e.arc.is_none() {
                    ShapeKind::Ellipse { w, h }
                } else {
                    ShapeKind::Other
                };
                Shape::from_bez(ellipse_path(w, h, e.arc.as_ref()), FillRule::Nonzero, kind)
            }
            Node::Path(p) => {
                let mut bez = BezPath::new();
                let mut rules = Vec::new();
                for pd in &p.paths {
                    match parse_svg_path(&pd.d) {
                        Ok(b) => {
                            bez.extend(b);
                            rules.push(pd.fill_rule);
                        }
                        Err(e) => self.warn(format!("path data: {e:?}")),
                    }
                }
                if rules.iter().all(|r| *r == rules[0]) && !rules.is_empty() {
                    Shape::from_bez(bez, model_rule(rules[0]), ShapeKind::Other)
                } else {
                    let o = node_outline(self.design, node.id(), self.tol())?;
                    let mut s = Shape::from_bez(o.path, model_rule(o.fill_rule), ShapeKind::Other)?;
                    s.closed = all_closed(&bez);
                    s.bez = bez;
                    Some(s)
                }
            }
            Node::Polygon(_) | Node::Star(_) | Node::Boolean(_) => {
                let o = node_outline(self.design, node.id(), self.tol())?;
                Shape::from_bez(o.path, model_rule(o.fill_rule), ShapeKind::Other)
            }
            _ => None,
        }
    }

    /// Fills and strokes of a shape node.
    pub(super) fn shape_node_items(&mut self, node: &Node, w: f64, h: f64) -> Vec<Item> {
        let Some(shaped) = node.shaped() else {
            return Vec::new();
        };
        let Some(shape) = self.node_shape(node) else {
            return Vec::new();
        };
        let mut out = self.fill_items(&shape, &shaped.fills, w, h, (0.0, 0.0));
        out.extend(self.stroke_items(&shape, &shaped.strokes, w, h));
        out
    }

    /// Line: centered shaft strokes plus end decorations in the stroke paint.
    pub(super) fn line_items(&mut self, l: &LineNode) -> Vec<Item> {
        let length = if l.base.width.is_finite() {
            l.base.width.max(0.0)
        } else {
            0.0
        };
        let mut out = Vec::new();
        for s in &l.strokes {
            if !s.is_visible() {
                continue;
            }
            let width = s.width.min(10_000.0);
            let g = line_geometry(length, width, l.start_cap, l.end_cap);
            let style = stroke_style(s, width, length);
            let cap_style = StrokeStyle {
                dash: None,
                join: if style.join == LineJoin::Bevel {
                    LineJoin::Bevel
                } else {
                    LineJoin::Round
                },
                cap: LineCap::Round,
                ..style.clone()
            };
            let shaft = bez_to_path(&g.shaft).map(Arc::new);
            let caps: Vec<(Option<Path>, bool)> = g
                .caps
                .iter()
                .map(|(p, filled)| (bez_to_path(p).map(Arc::new), *filled))
                .collect();
            for f in &s.fills {
                let Some(pl) =
                    self.resolve_fill(f, length.max(1.0), width.max(1.0), (0.0, -width / 2.0))
                else {
                    continue;
                };
                if let Some(p) = &shaft {
                    out.push(Item::Stroke(StrokeItem {
                        path: p.clone(),
                        bounds: path_bounds(p).inflate(style.outset()),
                        stroke: style.clone(),
                        paint: pl.paint.clone(),
                        opacity: pl.opacity,
                        blend: pl.blend,
                    }));
                }
                for (p, filled) in &caps {
                    let Some(p) = p else { continue };
                    if *filled {
                        out.push(Item::Fill(FillItem {
                            path: p.clone(),
                            rule: FillRule::Nonzero,
                            paint: pl.paint.clone(),
                            opacity: pl.opacity,
                            blend: pl.blend,
                            bounds: path_bounds(p),
                        }));
                    } else {
                        out.push(Item::Stroke(StrokeItem {
                            path: p.clone(),
                            bounds: path_bounds(p).inflate(cap_style.outset()),
                            stroke: cap_style.clone(),
                            paint: pl.paint.clone(),
                            opacity: pl.opacity,
                            blend: pl.blend,
                        }));
                    }
                }
            }
        }
        out
    }
}

/// Stroke geometry.
#[derive(Debug, Clone)]
enum StrokeGeom {
    Centered(Path, StrokeStyle),
    Filled(BezPath, FillRule),
}

/// Per-side widths `[top, right, bottom, left]` from the stroke's `sides` extension key.
fn per_side(s: &Stroke) -> Option<[f64; 4]> {
    let v = s.extra.get("sides")?;
    let arr = v.as_array()?;
    if arr.len() != 4 {
        return None;
    }
    let mut out = [0.0; 4];
    for (o, x) in out.iter_mut().zip(arr) {
        let f = x.as_f64()?;
        *o = if f.is_finite() {
            f.clamp(0.0, 10_000.0)
        } else {
            0.0
        };
    }
    out.iter().any(|v| *v > 0.0).then_some(out)
}
