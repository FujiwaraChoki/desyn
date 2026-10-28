//! SVG nodes: the sanitized usvg tree converted into display items (paths, gradients, images, groups with
//! opacity / blend / clip / mask) so every backend draws SVG as vectors. Subtrees using SVG filters or pattern
//! paints are rasterized with resvg at the target resolution. `recolor` maps colors while converting.

use std::collections::HashMap;
use std::sync::Arc;

use desyn_core::geometry::{Affine, Point, Rect};
use desyn_core::model::{BlendMode, BoolOp, FillRule as ModelRule, SvgNode};
use desyn_core::paths::kurbo::BezPath;
use desyn_core::paths::{Shape as CoreShape, boolean};

use super::build::DisplayListBuilder;
use super::shapes::{Shape, ShapeKind};
use super::{
    Clip, FillItem, FillRule, ImageItem, Item, Layer, LayerKind, LayerMask, LineCap, LineJoin,
    MaskKind, StrokeItem, StrokeStyle,
};
use crate::assets::{AssetIssue, RasterImage};
use crate::geom::{self, from_ts, path_bounds, path_to_bez};
use crate::paint::{Color4, GradientStop, Paint, Quality, Spread};

/// Nesting limit inside one SVG.
const MAX_SVG_DEPTH: usize = 64;
/// Largest side of a rasterized SVG fallback.
const MAX_FALLBACK_SIDE: f64 = 4096.0;

struct Conv<'r> {
    recolor: &'r HashMap<[u8; 3], Color4>,
    /// Device pixels per unit of the current coordinate system.
    scale: f64,
    salt: u64,
    warnings: Vec<String>,
}

fn blend(b: usvg::BlendMode) -> BlendMode {
    use usvg::BlendMode as U;
    match b {
        U::Normal => BlendMode::Normal,
        U::Multiply => BlendMode::Multiply,
        U::Screen => BlendMode::Screen,
        U::Overlay => BlendMode::Overlay,
        U::Darken => BlendMode::Darken,
        U::Lighten => BlendMode::Lighten,
        U::ColorDodge => BlendMode::ColorDodge,
        U::ColorBurn => BlendMode::ColorBurn,
        U::HardLight => BlendMode::HardLight,
        U::SoftLight => BlendMode::SoftLight,
        U::Difference => BlendMode::Difference,
        U::Exclusion => BlendMode::Exclusion,
        U::Hue => BlendMode::Hue,
        U::Saturation => BlendMode::Saturation,
        U::Color => BlendMode::Color,
        U::Luminosity => BlendMode::Luminosity,
    }
}

fn rule(r: usvg::FillRule) -> FillRule {
    match r {
        usvg::FillRule::NonZero => FillRule::Nonzero,
        usvg::FillRule::EvenOdd => FillRule::EvenOdd,
    }
}

impl Conv<'_> {
    fn color(&self, c: usvg::Color, opacity: f32) -> Color4 {
        let base = Color4 {
            r: f32::from(c.red) / 255.0,
            g: f32::from(c.green) / 255.0,
            b: f32::from(c.blue) / 255.0,
            a: opacity,
        };
        match self.recolor.get(&[c.red, c.green, c.blue]) {
            Some(to) => Color4 {
                a: to.a * opacity,
                ..*to
            },
            None => base,
        }
    }

    fn stops(&self, s: &[usvg::Stop]) -> Vec<GradientStop> {
        s.iter()
            .map(|st| GradientStop {
                pos: st.offset().get(),
                color: self.color(st.color(), st.opacity().get()),
            })
            .collect()
    }

    /// Paint, or `None` for patterns (rasterized instead).
    fn paint(&self, p: &usvg::Paint, opacity: f32) -> Option<Paint> {
        let spread = |s: usvg::SpreadMethod| match s {
            usvg::SpreadMethod::Pad => Spread::Pad,
            usvg::SpreadMethod::Reflect => Spread::Reflect,
            usvg::SpreadMethod::Repeat => Spread::Repeat,
        };
        Some(match p {
            usvg::Paint::Color(c) => Paint::Solid(self.color(*c, opacity)),
            usvg::Paint::LinearGradient(g) => Paint::Linear {
                start: Point::new(f64::from(g.x1()), f64::from(g.y1())),
                end: Point::new(f64::from(g.x2()), f64::from(g.y2())),
                stops: self
                    .stops(g.stops())
                    .into_iter()
                    .map(|s| GradientStop {
                        color: s.color.with_alpha_mul(opacity),
                        ..s
                    })
                    .collect(),
                spread: spread(g.spread_method()),
                transform: from_ts(&g.transform()),
            },
            usvg::Paint::RadialGradient(g) => Paint::Radial {
                c0: Point::new(f64::from(g.fx()), f64::from(g.fy())),
                r0: f64::from(g.fr().get()),
                c1: Point::new(f64::from(g.cx()), f64::from(g.cy())),
                r1: f64::from(g.r().get()),
                stops: self
                    .stops(g.stops())
                    .into_iter()
                    .map(|s| GradientStop {
                        color: s.color.with_alpha_mul(opacity),
                        ..s
                    })
                    .collect(),
                spread: spread(g.spread_method()),
                transform: from_ts(&g.transform()),
            },
            usvg::Paint::Pattern(_) => return None,
        })
    }

    fn stroke_style(s: &usvg::Stroke) -> StrokeStyle {
        let dash = s.dasharray().and_then(|d| {
            let v: Vec<f64> = d.iter().map(|x| f64::from(*x)).collect();
            (v.len() >= 2 && v.iter().sum::<f64>() > 0.0).then(|| (v, f64::from(s.dashoffset())))
        });
        StrokeStyle {
            width: f64::from(s.width().get()),
            cap: match s.linecap() {
                usvg::LineCap::Butt => LineCap::Butt,
                usvg::LineCap::Round => LineCap::Round,
                usvg::LineCap::Square => LineCap::Square,
            },
            join: match s.linejoin() {
                usvg::LineJoin::Round => LineJoin::Round,
                usvg::LineJoin::Bevel => LineJoin::Bevel,
                usvg::LineJoin::Miter | usvg::LineJoin::MiterClip => LineJoin::Miter,
            },
            miter_limit: f64::from(s.miterlimit().get()),
            dash,
        }
    }

    /// Rasterizes one node with resvg into an image item in the parent's coordinates.
    fn raster_fallback(&mut self, node: &usvg::Node, local_bounds: Rect) -> Option<Item> {
        let ab = node.abs_layer_bounding_box()?;
        let k = (self.scale * 1.0).clamp(0.05, 16.0);
        let mut k_eff = k;
        let longest = local_bounds.w.max(local_bounds.h) * k;
        if longest > MAX_FALLBACK_SIDE {
            k_eff = k * MAX_FALLBACK_SIDE / longest;
        }
        let pw = (local_bounds.w * k_eff).ceil().max(1.0) as u32;
        let ph = (local_bounds.h * k_eff).ceil().max(1.0) as u32;
        let mut pix = tiny_skia::Pixmap::new(pw, ph)?;
        // resvg::render_node maps with `ts * translate(-abs_bbox)` and then the node's own transform; choose `ts`
        // so the result is `scale(k) * translate(-local_bounds)` in the parent's coordinates.
        let m = Affine::scale(k_eff, k_eff) * Affine::translate(-local_bounds.x, -local_bounds.y);
        let ts = geom::to_ts(&(m * Affine::translate(f64::from(ab.x()), f64::from(ab.y()))));
        resvg::render_node(node, ts, &mut pix.as_mut())?;
        let img = Arc::new(RasterImage::new(pix, None));
        let t = Affine::translate(local_bounds.x, local_bounds.y)
            * Affine::scale(1.0 / k_eff, 1.0 / k_eff);
        Some(Item::Image(ImageItem {
            image: img,
            transform: t,
            opacity: 1.0,
            blend: BlendMode::Normal,
            quality: Quality::Bilinear,
            bounds: local_bounds,
        }))
    }

    fn clip(&mut self, cp: &usvg::ClipPath) -> Option<Clip> {
        let mut bez = BezPath::new();
        let mut rules = Vec::new();
        collect_paths(cp.root(), &Affine::IDENTITY, &mut bez, &mut rules, 0);
        bez.apply_affine(from_ts(&cp.transform()).to_kurbo());
        let r = if rules.iter().all(|r| *r == FillRule::EvenOdd) && !rules.is_empty() {
            FillRule::EvenOdd
        } else {
            FillRule::Nonzero
        };
        let p = geom::bez_to_path(&bez)?;
        Some(Clip {
            path: Arc::new(p),
            rule: r,
            rect: None,
        })
    }

    fn group(&mut self, g: &usvg::Group, depth: usize) -> Vec<Item> {
        let mut out = Vec::new();
        if depth > MAX_SVG_DEPTH {
            return out;
        }
        for child in g.children() {
            match child {
                usvg::Node::Group(cg) => {
                    let t = from_ts(&cg.transform());
                    let saved = self.scale;
                    self.scale *= geom::mean_scale(&t);
                    if !cg.filters().is_empty() {
                        let lb = cg.layer_bounding_box();
                        let r = Rect::new(
                            f64::from(lb.x()),
                            f64::from(lb.y()),
                            f64::from(lb.width()),
                            f64::from(lb.height()),
                        );
                        let local = t.transform_rect_bbox(&r);
                        self.scale = saved;
                        if let Some(it) = self.raster_fallback(child, local) {
                            out.push(it);
                        }
                        continue;
                    }
                    let items = self.group(cg, depth + 1);
                    self.scale = saved;
                    let mut l = Layer::new(LayerKind::Group, None, t);
                    l.opacity = cg.opacity().get();
                    l.blend = blend(cg.blend_mode());
                    l.items = items;
                    if let Some(cp) = cg.clip_path() {
                        l.clip = self.clip(cp);
                        if let Some(inner) = cp.clip_path().and_then(|n| self.clip(n)) {
                            // Nested clip paths intersect: wrap in one more clipped layer.
                            let mut wrap = Layer::new(LayerKind::Group, None, Affine::IDENTITY);
                            wrap.clip = Some(inner);
                            wrap.items = std::mem::take(&mut l.items);
                            wrap.update_bounds();
                            l.items = vec![Item::Layer(Box::new(wrap))];
                        }
                    }
                    if let Some(m) = cg.mask() {
                        let mut ml = Layer::new(LayerKind::Group, None, Affine::IDENTITY);
                        ml.items = self.group(m.root(), depth + 1);
                        let r = m.rect();
                        let rr = Rect::new(
                            f64::from(r.x()),
                            f64::from(r.y()),
                            f64::from(r.width()),
                            f64::from(r.height()),
                        );
                        ml.clip = geom::rect_path(&rr).map(|p| Clip {
                            path: Arc::new(p),
                            rule: FillRule::Nonzero,
                            rect: Some(rr),
                        });
                        ml.update_bounds();
                        l.mask = Some(Box::new(LayerMask {
                            layer: ml,
                            kind: match m.kind() {
                                usvg::MaskType::Luminance => MaskKind::Luminance,
                                usvg::MaskType::Alpha => MaskKind::Alpha,
                            },
                        }));
                    }
                    l.update_bounds();
                    self.salt += 1;
                    l.key = crate::hash::combine(self.salt, out.len() as u64);
                    out.push(Item::Layer(Box::new(l)));
                }
                usvg::Node::Path(p) => {
                    if !p.is_visible() {
                        continue;
                    }
                    let pattern = p
                        .fill()
                        .is_some_and(|f| matches!(f.paint(), usvg::Paint::Pattern(_)))
                        || p.stroke()
                            .is_some_and(|s| matches!(s.paint(), usvg::Paint::Pattern(_)));
                    if pattern {
                        let b = p.stroke_bounding_box();
                        let r = Rect::new(
                            f64::from(b.x()),
                            f64::from(b.y()),
                            f64::from(b.width()),
                            f64::from(b.height()),
                        );
                        if let Some(it) = self.raster_fallback(child, r) {
                            out.push(it);
                        }
                        continue;
                    }
                    let path = Arc::new(p.data().clone());
                    let fill_item = p.fill().and_then(|f| {
                        let paint = self.paint(f.paint(), f.opacity().get())?;
                        Some(Item::Fill(FillItem {
                            bounds: path_bounds(&path),
                            path: path.clone(),
                            rule: rule(f.rule()),
                            paint,
                            opacity: 1.0,
                            blend: BlendMode::Normal,
                        }))
                    });
                    let stroke_item = p.stroke().and_then(|s| {
                        let paint = self.paint(s.paint(), s.opacity().get())?;
                        let style = Self::stroke_style(s);
                        Some(Item::Stroke(StrokeItem {
                            bounds: path_bounds(&path).inflate(style.outset()),
                            path: path.clone(),
                            stroke: style,
                            paint,
                            opacity: 1.0,
                            blend: BlendMode::Normal,
                        }))
                    });
                    let (a, b) = match p.paint_order() {
                        usvg::PaintOrder::FillAndStroke => (fill_item, stroke_item),
                        usvg::PaintOrder::StrokeAndFill => (stroke_item, fill_item),
                    };
                    out.extend(a);
                    out.extend(b);
                }
                usvg::Node::Image(img) => {
                    if !img.is_visible() {
                        continue;
                    }
                    let size = img.size();
                    let (w, h) = (f64::from(size.width()), f64::from(size.height()));
                    match img.kind() {
                        usvg::ImageKind::SVG(tree) => {
                            let ts = tree.size();
                            let t = Affine::scale(
                                w / f64::from(ts.width()),
                                h / f64::from(ts.height()),
                            );
                            let saved = self.scale;
                            self.scale *= geom::mean_scale(&t);
                            let items = self.group(tree.root(), depth + 1);
                            self.scale = saved;
                            let mut l = Layer::new(LayerKind::Group, None, t);
                            l.items = items;
                            l.update_bounds();
                            self.salt += 1;
                            l.key = self.salt;
                            out.push(Item::Layer(Box::new(l)));
                        }
                        usvg::ImageKind::JPEG(d)
                        | usvg::ImageKind::PNG(d)
                        | usvg::ImageKind::GIF(d)
                        | usvg::ImageKind::WEBP(d) => {
                            match crate::assets::decode_image(Arc::from(d.as_slice())) {
                                Ok(ri) => {
                                    let (iw, ih) = (f64::from(ri.width()), f64::from(ri.height()));
                                    let t = Affine::scale(w / iw, h / ih);
                                    out.push(Item::Image(ImageItem {
                                        image: Arc::new(ri),
                                        transform: t,
                                        opacity: 1.0,
                                        blend: BlendMode::Normal,
                                        quality: match img.rendering_mode() {
                                            usvg::ImageRendering::OptimizeSpeed
                                            | usvg::ImageRendering::CrispEdges
                                            | usvg::ImageRendering::Pixelated => Quality::Nearest,
                                            _ => Quality::Bicubic,
                                        },
                                        bounds: Rect::new(0.0, 0.0, w, h),
                                    }));
                                }
                                Err(e) => self.warnings.push(format!("embedded svg image: {e}")),
                            }
                        }
                    }
                }
                usvg::Node::Text(t) => out.extend(self.group(t.flattened(), depth + 1)),
            }
        }
        out
    }
}

/// Collects every path of a group (clip paths) into one path in the group's parent coordinates.
fn collect_paths(
    g: &usvg::Group,
    t: &Affine,
    out: &mut BezPath,
    rules: &mut Vec<FillRule>,
    depth: usize,
) {
    if depth > MAX_SVG_DEPTH {
        return;
    }
    for c in g.children() {
        match c {
            usvg::Node::Group(cg) => {
                let t2 = *t * from_ts(&cg.transform());
                collect_paths(cg, &t2, out, rules, depth + 1);
            }
            usvg::Node::Path(p) => {
                let mut b = path_to_bez(p.data());
                b.apply_affine(t.to_kurbo());
                out.extend(b);
                rules.push(
                    p.fill()
                        .map(|f| rule(f.rule()))
                        .unwrap_or(FillRule::Nonzero),
                );
            }
            usvg::Node::Text(tx) => collect_paths(tx.flattened(), t, out, rules, depth + 1),
            usvg::Node::Image(_) => {}
        }
    }
}

/// Every filled path of the converted items in layer coordinates (SVG outline strokes).
fn silhouette(items: &[Item], t: &Affine, out: &mut Vec<CoreShape>, depth: usize) {
    if depth > MAX_SVG_DEPTH {
        return;
    }
    for it in items {
        match it {
            Item::Fill(f) => {
                let mut b = path_to_bez(&f.path);
                b.apply_affine(t.to_kurbo());
                out.push(CoreShape {
                    path: b,
                    fill_rule: match f.rule {
                        FillRule::Nonzero => ModelRule::Nonzero,
                        FillRule::EvenOdd => ModelRule::Evenodd,
                    },
                });
            }
            Item::Layer(l) => silhouette(&l.items, &(*t * l.transform), out, depth + 1),
            _ => {}
        }
    }
}

impl DisplayListBuilder<'_> {
    /// SVG node items: the converted tree scaled to the node box, plus outline strokes.
    pub(super) fn svg_node_items(&mut self, s: &SvgNode) -> Vec<Item> {
        let (w, h) = (s.base.width.max(0.0), s.base.height.max(0.0));
        let tree = match (&s.markup, &s.asset_id) {
            (Some(m), _) if !m.trim().is_empty() => self.assets.svg_markup(m, self.text.db()),
            (_, Some(a)) => {
                let aref = self.design.assets.get(a);
                self.assets.svg_asset(a, aref, self.text.db())
            }
            _ => {
                self.warn("svg node without markup or asset".into());
                return Vec::new();
            }
        };
        let tree = match tree {
            Ok(t) => t,
            Err(AssetIssue::Missing) => {
                if let Some(a) = &s.asset_id {
                    self.note_missing(a);
                }
                return Vec::new();
            }
            Err(AssetIssue::Invalid(e)) => {
                self.warn(format!("svg: {e}"));
                return Vec::new();
            }
        };
        let size = tree.size();
        let t = Affine::scale(w / f64::from(size.width()), h / f64::from(size.height()));
        let recolor: HashMap<[u8; 3], Color4> = s
            .recolor
            .iter()
            .flatten()
            .map(|(from, to)| {
                let c = from.rgba8();
                ([c[0], c[1], c[2]], Color4::from_color(to))
            })
            .collect();
        let mut conv = Conv {
            recolor: &recolor,
            scale: self.opts.raster_scale * geom::mean_scale(&t),
            salt: self.cur_key,
            warnings: Vec::new(),
        };
        let items = conv.group(tree.root(), 0);
        for w in std::mem::take(&mut conv.warnings) {
            self.warn(w);
        }
        let layer = self.group(t, items, 0x0073_7667);
        let mut out = Vec::new();
        let strokes = s.strokes.as_deref().unwrap_or(&[]);
        if strokes.iter().any(|st| st.is_visible()) {
            let mut shapes = Vec::new();
            silhouette(&layer.items, &layer.transform, &mut shapes, 0);
            let outline = boolean(&shapes, BoolOp::Union, self.tol());
            out.push(Item::Layer(Box::new(layer)));
            if let Some(shape) = Shape::from_bez(outline, FillRule::Nonzero, ShapeKind::Other) {
                out.extend(self.stroke_items(&shape, strokes, w, h));
            }
        } else {
            out.push(Item::Layer(Box::new(layer)));
        }
        out
    }
}
