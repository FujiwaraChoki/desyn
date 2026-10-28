//! PDF export through krilla: vector paths and gradients, real text with embedded font subsets (searchable,
//! copyable), images (JPEG / PNG / WebP passed through when unmodified), clips, alpha / luminance masks, opacity
//! and blend modes, URL and page links, multi-page documents, print bleed, crop marks, a DeviceCMYK option and
//! a flatten option. Layers with effects (shadows, blurs, glow, noise) and conic gradients are embedded as images
//! rendered at the export resolution.

use std::collections::HashMap;
use std::sync::Arc;

use desyn_core::geometry::{Affine, Rect};
use desyn_core::model::{BlendMode, Design, Id};
use krilla::Document;
use krilla::action::LinkAction;
use krilla::annotation::{Annotation, LinkAnnotation, Target};
use krilla::color::{cmyk, rgb};
use krilla::destination::XyzDestination;
use krilla::geom::{
    Path as KPath, PathBuilder, Point as KPoint, Rect as KRect, Size, Transform as KTransform,
};
use krilla::image::Image as KImage;
use krilla::mask::{Mask, MaskType};
use krilla::metadata::Metadata;
use krilla::num::NormalizedF32;
use krilla::page::PageSettings;
use krilla::paint::{
    Fill, FillRule as KRule, LineCap as KCap, LineJoin as KJoin, LinearGradient, Pattern,
    RadialGradient, SpreadMethod, Stop, Stroke, StrokeDash, SweepGradient,
};
use krilla::surface::Surface;
use krilla::text::{Font, GlyphId};
use tiny_skia::PathSegment;

use super::svg::prepend_background;
use super::{Background, ExportOptions, ExportOutput, Format, page_render_options};
use crate::assets::{RasterImage, SourceFormat};
use crate::display::{
    BuildOptions, DisplayList, FillItem, FillRule, GlyphRunItem, ImageItem, Item, Layer, LayerKind,
    LineCap, LineJoin, LinkTarget, MaskKind, StrokeItem, TextItem,
};
use crate::error::RenderError;
use crate::geom;
use crate::paint::{Color4, GradientStop, Paint, Spread};
use crate::raster::render_layer;
use crate::renderer::Renderer;

/// Points per design pixel (1 px = 1/96 in, 1 pt = 1/72 in).
pub const PT_PER_PX: f64 = 0.75;
/// Slug area around the bleed when crop marks are drawn (px).
const SLUG_PX: f64 = 32.0;
/// Largest side of an image rendered for a fallback (px).
const MAX_FALLBACK_PX: f64 = 6000.0;

fn kt(a: &Affine) -> KTransform {
    KTransform::from_row(
        a.a as f32, a.b as f32, a.c as f32, a.d as f32, a.e as f32, a.f as f32,
    )
}

fn kpath(p: &tiny_skia::Path) -> Option<KPath> {
    let mut b = PathBuilder::new();
    for seg in p.segments() {
        match seg {
            PathSegment::MoveTo(a) => b.move_to(a.x, a.y),
            PathSegment::LineTo(a) => b.line_to(a.x, a.y),
            PathSegment::QuadTo(a, c) => b.quad_to(a.x, a.y, c.x, c.y),
            PathSegment::CubicTo(a, c, d) => b.cubic_to(a.x, a.y, c.x, c.y, d.x, d.y),
            PathSegment::Close => b.close(),
        }
    }
    b.finish()
}

fn norm(v: f32) -> NormalizedF32 {
    NormalizedF32::new(v.clamp(0.0, 1.0)).unwrap_or(NormalizedF32::ONE)
}

/// A glyph positioned by the text engine; advance and offset are stored per em (krilla scales them by the size).
struct PlacedGlyph {
    id: u32,
    range: std::ops::Range<usize>,
    advance: f32,
    y_offset: f32,
}

impl krilla::text::Glyph for PlacedGlyph {
    fn glyph_id(&self) -> GlyphId {
        GlyphId::new(self.id)
    }
    fn text_range(&self) -> std::ops::Range<usize> {
        self.range.clone()
    }
    fn x_advance(&self, size: f32) -> f32 {
        self.advance * size
    }
    fn x_offset(&self, _size: f32) -> f32 {
        0.0
    }
    fn y_offset(&self, size: f32) -> f32 {
        self.y_offset * size
    }
    fn y_advance(&self, _size: f32) -> f32 {
        0.0
    }
    fn location(&self) -> Option<krilla::surface::Location> {
        None
    }
}

/// Shared state while writing one document.
struct Ctx<'d> {
    dl: &'d DisplayList,
    cmyk: bool,
    /// Device pixels per design px for rendered fallbacks.
    raster_scale: f64,
    fonts: HashMap<usize, Option<Font>>,
    images: HashMap<u64, KImage>,
    warnings: Vec<String>,
}

impl Ctx<'_> {
    fn color(&self, c: Color4) -> krilla::color::Color {
        if self.cmyk {
            let (r, g, b) = (
                c.r.clamp(0.0, 1.0),
                c.g.clamp(0.0, 1.0),
                c.b.clamp(0.0, 1.0),
            );
            let k = 1.0 - r.max(g).max(b);
            let (cc, m, y) = if k >= 1.0 {
                (0.0, 0.0, 0.0)
            } else {
                (
                    (1.0 - r - k) / (1.0 - k),
                    (1.0 - g - k) / (1.0 - k),
                    (1.0 - b - k) / (1.0 - k),
                )
            };
            let q = |v: f32| (v * 255.0).round().clamp(0.0, 255.0) as u8;
            cmyk::Color::new(q(cc), q(m), q(y), q(k)).into()
        } else {
            let [r, g, b, _] = c.to_rgba8();
            rgb::Color::new(r, g, b).into()
        }
    }

    fn stops(&self, s: &[GradientStop], opacity: f32) -> Vec<Stop> {
        s.iter()
            .map(|st| Stop {
                offset: norm(st.pos),
                color: self.color(st.color),
                opacity: norm(st.color.a * opacity),
            })
            .collect()
    }

    /// krilla paint and fill opacity, or `None` for paints drawn through a fallback.
    fn paint(&self, p: &Paint, opacity: f32) -> Option<(krilla::paint::Paint, f32)> {
        let spread = |s: Spread| match s {
            Spread::Pad => SpreadMethod::Pad,
            Spread::Repeat => SpreadMethod::Repeat,
            Spread::Reflect => SpreadMethod::Reflect,
        };
        Some(match p {
            Paint::Solid(c) => (self.color(*c).into(), c.a * opacity),
            Paint::Linear {
                start,
                end,
                stops,
                spread: sp,
                transform,
            } => (
                LinearGradient {
                    x1: start.x as f32,
                    y1: start.y as f32,
                    x2: end.x as f32,
                    y2: end.y as f32,
                    transform: kt(transform),
                    spread_method: spread(*sp),
                    stops: self.stops(stops, 1.0),
                    anti_alias: true,
                }
                .into(),
                opacity,
            ),
            Paint::Radial {
                c0,
                r0,
                c1,
                r1,
                stops,
                spread: sp,
                transform,
            } => (
                RadialGradient {
                    fx: c0.x as f32,
                    fy: c0.y as f32,
                    fr: r0.max(0.0) as f32,
                    cx: c1.x as f32,
                    cy: c1.y as f32,
                    cr: r1.max(0.0) as f32,
                    transform: kt(transform),
                    spread_method: spread(*sp),
                    stops: self.stops(stops, 1.0),
                    anti_alias: true,
                }
                .into(),
                opacity,
            ),
            Paint::Conic {
                center,
                start_deg,
                end_deg,
                stops,
                spread: sp,
                transform,
            } => (
                SweepGradient {
                    cx: center.x as f32,
                    cy: center.y as f32,
                    start_angle: *start_deg as f32,
                    end_angle: *end_deg as f32,
                    transform: kt(transform),
                    spread_method: spread(*sp),
                    stops: self.stops(stops, 1.0),
                    anti_alias: true,
                }
                .into(),
                opacity,
            ),
            Paint::Image(_) => return None,
        })
    }

    fn image(&mut self, img: &RasterImage) -> Option<KImage> {
        if let Some(i) = self.images.get(&img.id()) {
            return Some(i.clone());
        }
        let passthrough = img.source().and_then(|s| {
            let data: krilla::Data = Arc::new(s.bytes.to_vec()).into();
            match s.format {
                SourceFormat::Jpeg => KImage::from_jpeg(data, true).ok(),
                SourceFormat::Png => KImage::from_png(data, true).ok(),
                SourceFormat::Webp => KImage::from_webp(data, true).ok(),
                SourceFormat::Gif => KImage::from_gif(data, true).ok(),
                SourceFormat::Other => None,
            }
        });
        let k = passthrough
            .unwrap_or_else(|| KImage::from_rgba8(img.to_rgba8(), img.width(), img.height()));
        self.images.insert(img.id(), k.clone());
        Some(k)
    }

    fn font(&mut self, idx: usize) -> Option<Font> {
        if let Some(f) = self.fonts.get(&idx) {
            return f.clone();
        }
        let entry = self.dl.fonts.entries.get(idx)?;
        let data: krilla::Data = Arc::new(entry.data.to_vec()).into();
        let coords: Vec<(krilla::text::Tag, f32)> = entry
            .variations
            .iter()
            .filter_map(|(t, v)| krilla::text::Tag::try_from_str(t).map(|tag| (tag, *v)))
            .collect();
        let f = if coords.is_empty() {
            Font::new(data, entry.index)
        } else {
            Font::new_variable(data, entry.index, &coords)
        };
        if f.is_none() {
            self.warnings.push(format!(
                "font {}: not embeddable, text drawn as outlines",
                entry.family
            ));
        }
        self.fonts.insert(idx, f.clone());
        f
    }
}

/// Draws a fill whose paint krilla cannot express (images, conic) clipped to the path.
fn fallback_fill(
    ctx: &mut Ctx<'_>,
    s: &mut Surface<'_>,
    path: &tiny_skia::Path,
    rule: FillRule,
    paint: &Paint,
    opacity: f32,
) {
    let Some(kp) = kpath(path) else { return };
    s.push_clip_path(&kp, &krule(rule));
    if opacity < 0.999 {
        s.push_opacity(norm(opacity));
    }
    match paint {
        Paint::Image(ip) if ip.extend != crate::paint::ImageExtend::Repeat => {
            if let Some(img) = ctx.image(&ip.image)
                && let Some(size) = Size::from_wh(ip.image.width() as f32, ip.image.height() as f32)
            {
                s.push_transform(&kt(&ip.transform));
                s.draw_image(img, size);
                s.pop();
            }
        }
        Paint::Image(ip) => {
            // Repeated image: a tiling pattern built from the image.
            if let Some(img) = ctx.image(&ip.image)
                && let Some(size) = Size::from_wh(ip.image.width() as f32, ip.image.height() as f32)
            {
                let stream = {
                    let mut sb = s.stream_builder();
                    let mut ps = sb.surface();
                    ps.draw_image(img, size);
                    ps.finish();
                    sb.finish()
                };
                let pattern = Pattern {
                    stream,
                    transform: kt(&ip.transform),
                    width: ip.image.width() as f32,
                    height: ip.image.height() as f32,
                };
                s.set_stroke(None);
                s.set_fill(Some(Fill {
                    paint: pattern.into(),
                    opacity: NormalizedF32::ONE,
                    rule: krule(rule),
                }));
                s.draw_path(&kp);
            }
        }
        _ => {
            let b = geom::path_bounds(path);
            let k = ctx
                .raster_scale
                .min(MAX_FALLBACK_PX / b.w.max(b.h).max(1.0));
            let mut layer = Layer::new(LayerKind::Group, None, Affine::IDENTITY);
            if let Some(rp) = geom::rect_path(&b) {
                layer.items.push(Item::Fill(FillItem {
                    path: Arc::new(rp),
                    rule: FillRule::Nonzero,
                    paint: paint.clone(),
                    opacity: 1.0,
                    blend: BlendMode::Normal,
                    bounds: b,
                }));
            }
            layer.update_bounds();
            let (w, h) = (
                (b.w * k).ceil().max(1.0) as u32,
                (b.h * k).ceil().max(1.0) as u32,
            );
            if let Some(pix) = render_layer(
                &layer,
                w,
                h,
                Affine::scale(k, k) * Affine::translate(-b.x, -b.y),
            ) {
                let img = RasterImage::new(pix, None);
                if let Some(size) = Size::from_wh(b.w as f32, b.h as f32) {
                    s.push_transform(&KTransform::from_translate(b.x as f32, b.y as f32));
                    s.draw_image(KImage::from_rgba8(img.to_rgba8(), w, h), size);
                    s.pop();
                }
            }
        }
    }
    if opacity < 0.999 {
        s.pop();
    }
    s.pop();
}

fn krule(r: FillRule) -> KRule {
    match r {
        FillRule::Nonzero => KRule::NonZero,
        FillRule::EvenOdd => KRule::EvenOdd,
    }
}

fn kblend(b: BlendMode) -> krilla::blend::BlendMode {
    use krilla::blend::BlendMode as K;
    match b {
        BlendMode::Normal => K::Normal,
        BlendMode::Multiply => K::Multiply,
        BlendMode::Screen => K::Screen,
        BlendMode::Overlay => K::Overlay,
        BlendMode::Darken => K::Darken,
        BlendMode::Lighten => K::Lighten,
        BlendMode::ColorDodge => K::ColorDodge,
        BlendMode::ColorBurn => K::ColorBurn,
        BlendMode::HardLight => K::HardLight,
        BlendMode::SoftLight => K::SoftLight,
        BlendMode::Difference => K::Difference,
        BlendMode::Exclusion => K::Exclusion,
        BlendMode::Hue => K::Hue,
        BlendMode::Saturation => K::Saturation,
        BlendMode::Color => K::Color,
        BlendMode::Luminosity => K::Luminosity,
    }
}

fn with_blend(s: &mut Surface<'_>, b: BlendMode, f: impl FnOnce(&mut Surface<'_>)) {
    if b != BlendMode::Normal {
        s.push_blend_mode(kblend(b));
        f(s);
        s.pop();
    } else {
        f(s);
    }
}

fn fill(ctx: &mut Ctx<'_>, s: &mut Surface<'_>, f: &FillItem) {
    with_blend(s, f.blend, |s| match ctx.paint(&f.paint, f.opacity) {
        Some((paint, op)) => {
            let Some(kp) = kpath(&f.path) else { return };
            s.set_stroke(None);
            s.set_fill(Some(Fill {
                paint,
                opacity: norm(op),
                rule: krule(f.rule),
            }));
            s.draw_path(&kp);
        }
        None => fallback_fill(ctx, s, &f.path, f.rule, &f.paint, f.opacity),
    });
}

fn kstroke(ctx: &Ctx<'_>, st: &crate::display::StrokeStyle, paint: &Paint, opacity: f32) -> Stroke {
    let (p, op) = ctx.paint(paint, opacity).unwrap_or_else(|| {
        (
            ctx.color(paint.average_color()).into(),
            opacity * paint.average_color().a,
        )
    });
    Stroke {
        paint: p,
        width: st.width as f32,
        miter_limit: st.miter_limit as f32,
        line_cap: match st.cap {
            LineCap::Butt => KCap::Butt,
            LineCap::Round => KCap::Round,
            LineCap::Square => KCap::Square,
        },
        line_join: match st.join {
            LineJoin::Miter => KJoin::Miter,
            LineJoin::Round => KJoin::Round,
            LineJoin::Bevel => KJoin::Bevel,
        },
        opacity: norm(op),
        dash: st.dash.as_ref().map(|(d, off)| StrokeDash {
            array: d.iter().map(|v| *v as f32).collect(),
            offset: *off as f32,
        }),
    }
}

fn stroke(ctx: &mut Ctx<'_>, s: &mut Surface<'_>, it: &StrokeItem) {
    let Some(kp) = kpath(&it.path) else { return };
    let st = kstroke(ctx, &it.stroke, &it.paint, it.opacity);
    with_blend(s, it.blend, |s| {
        s.set_fill(None);
        s.set_stroke(Some(st));
        s.draw_path(&kp);
    });
}

fn image(ctx: &mut Ctx<'_>, s: &mut Surface<'_>, i: &ImageItem) {
    let Some(img) = ctx.image(&i.image) else {
        return;
    };
    let Some(size) = Size::from_wh(i.image.width() as f32, i.image.height() as f32) else {
        return;
    };
    with_blend(s, i.blend, |s| {
        s.push_transform(&kt(&i.transform));
        if i.opacity < 0.999 {
            s.push_opacity(norm(i.opacity));
        }
        s.draw_image(img, size);
        if i.opacity < 0.999 {
            s.pop();
        }
        s.pop();
    });
}

fn run(
    ctx: &mut Ctx<'_>,
    s: &mut Surface<'_>,
    r: &GlyphRunItem,
    fill: &Fill,
    bold: Option<Stroke>,
) -> bool {
    let Some(font) = ctx.font(r.font) else {
        return false;
    };
    if r.glyphs.is_empty() {
        return true;
    }
    let y0 = r.glyphs[0].y;
    let em = r.size.max(1e-6);
    let glyphs: Vec<PlacedGlyph> = r
        .glyphs
        .iter()
        .enumerate()
        .map(|(i, g)| PlacedGlyph {
            id: g.id,
            range: g.text.clone(),
            advance: (r.glyphs.get(i + 1).map(|n| n.x - g.x).unwrap_or(g.advance) / em) as f32,
            y_offset: ((y0 - g.y) / em) as f32,
        })
        .collect();
    let skewed = r.skew != 0.0;
    if skewed {
        let t = Affine::translate(0.0, y0)
            * Affine::new([1.0, 0.0, -r.skew, 1.0, 0.0, 0.0])
            * Affine::translate(0.0, -y0);
        s.push_transform(&kt(&t));
    }
    s.set_fill(Some(fill.clone()));
    s.set_stroke(bold);
    s.draw_glyphs(
        KPoint::from_xy(r.glyphs[0].x as f32, y0 as f32),
        &glyphs,
        font,
        &r.text,
        r.size as f32,
        false,
    );
    if skewed {
        s.pop();
    }
    true
}

fn text(ctx: &mut Ctx<'_>, s: &mut Surface<'_>, t: &TextItem) {
    let outline = |ctx: &mut Ctx<'_>, s: &mut Surface<'_>| {
        fill(
            ctx,
            s,
            &FillItem {
                path: t.outline.clone(),
                rule: FillRule::Nonzero,
                paint: t.paint.clone(),
                opacity: t.opacity,
                blend: t.blend,
                bounds: t.bounds,
            },
        );
        if t.bold > 0.0 {
            stroke(
                ctx,
                s,
                &StrokeItem {
                    path: t.outline.clone(),
                    stroke: crate::display::StrokeStyle {
                        width: t.bold,
                        cap: LineCap::Round,
                        join: LineJoin::Round,
                        miter_limit: 4.0,
                        dash: None,
                    },
                    paint: t.paint.clone(),
                    opacity: t.opacity,
                    blend: t.blend,
                    bounds: t.bounds,
                },
            );
        }
    };
    let Some((paint, op)) = ctx.paint(&t.paint, t.opacity) else {
        outline(ctx, s);
        return;
    };
    if t.runs.is_empty() {
        outline(ctx, s);
        return;
    }
    let f = Fill {
        paint,
        opacity: norm(op),
        rule: KRule::NonZero,
    };
    let bold = (t.bold > 0.0).then(|| {
        kstroke(
            ctx,
            &crate::display::StrokeStyle {
                width: t.bold,
                cap: LineCap::Round,
                join: LineJoin::Round,
                miter_limit: 4.0,
                dash: None,
            },
            &t.paint,
            t.opacity,
        )
    });
    let mut all = true;
    if t.blend != BlendMode::Normal {
        s.push_blend_mode(kblend(t.blend));
    }
    for r in &t.runs {
        all &= run(ctx, s, r, &f, bold.clone());
    }
    if t.blend != BlendMode::Normal {
        s.pop();
    }
    if !all {
        // A font could not be embedded: the outline stands in for the whole item (drawn once).
        outline(ctx, s);
    }
}

/// Draws a layer whose effects PDF cannot express as an image rendered at the export resolution.
fn layer_as_image(ctx: &mut Ctx<'_>, s: &mut Surface<'_>, l: &Layer) {
    let b = l.bounds;
    if !(b.w > 0.0 && b.h > 0.0) {
        return;
    }
    let k = ctx.raster_scale.min(MAX_FALLBACK_PX / b.w.max(b.h));
    let (w, h) = (
        (b.w * k).ceil().max(1.0) as u32,
        (b.h * k).ceil().max(1.0) as u32,
    );
    let Some(pix) = render_layer(l, w, h, Affine::scale(k, k) * Affine::translate(-b.x, -b.y))
    else {
        return;
    };
    let img = RasterImage::new(pix, None);
    if let Some(size) = Size::from_wh(b.w as f32, b.h as f32) {
        s.push_transform(&KTransform::from_translate(b.x as f32, b.y as f32));
        s.draw_image(KImage::from_rgba8(img.to_rgba8(), w, h), size);
        s.pop();
    }
}

/// A layer with a background blur: the page region it covers is rendered with everything below it (the
/// backdrop it blurs) and drawn as an image in page space.
fn backdrop_layer_as_image(ctx: &mut Ctx<'_>, s: &mut Surface<'_>, l: &Layer, page_t: &Affine) {
    let region = page_t.transform_rect_bbox(&l.bounds);
    let Some(root) = crate::raster::truncate_after(&ctx.dl.root, l) else {
        return layer_as_image(ctx, s, l);
    };
    let k = ctx
        .raster_scale
        .min(MAX_FALLBACK_PX / region.w.max(region.h).max(1.0));
    let Some(pix) = crate::raster::render_region(&root, &region, k) else {
        return;
    };
    let Some(inv) = page_t.inverse() else { return };
    let img = RasterImage::new(pix, None);
    if let Some(size) = Size::from_wh(region.w as f32, region.h as f32) {
        s.push_transform(&kt(&(inv * Affine::translate(region.x, region.y))));
        s.draw_image(
            KImage::from_rgba8(img.to_rgba8(), img.width(), img.height()),
            size,
        );
        s.pop();
    }
}

/// `page_t` maps the layer's parent space to page space.
fn layer(ctx: &mut Ctx<'_>, s: &mut Surface<'_>, l: &Layer, depth: usize, page_t: &Affine) {
    if depth > crate::display::MAX_RENDER_DEPTH * 2 {
        return;
    }
    if !l.effects.is_empty() {
        if l.effects
            .iter()
            .any(|e| matches!(e, crate::display::LayerEffect::BackgroundBlur { .. }))
        {
            backdrop_layer_as_image(ctx, s, l, page_t);
        } else {
            with_blend(s, l.blend, |s| layer_as_image(ctx, s, l));
        }
        return;
    }
    let inner_t = *page_t * l.transform;
    let mut pushes = 0;
    if l.transform != Affine::IDENTITY {
        s.push_transform(&kt(&l.transform));
        pushes += 1;
    }
    if l.blend != BlendMode::Normal {
        s.push_blend_mode(kblend(l.blend));
        pushes += 1;
    }
    if l.opacity < 0.999 {
        s.push_opacity(norm(l.opacity));
        pushes += 1;
    }
    if let Some(c) = &l.clip
        && let Some(kp) = kpath(&c.path)
    {
        s.push_clip_path(&kp, &krule(c.rule));
        pushes += 1;
    }
    if let Some(m) = &l.mask {
        let stream = {
            let mut sb = s.stream_builder();
            let mut ms = sb.surface();
            layer(ctx, &mut ms, &m.layer, depth + 1, &inner_t);
            ms.finish();
            sb.finish()
        };
        s.push_mask(Mask::new(
            stream,
            match m.kind {
                MaskKind::Alpha => MaskType::Alpha,
                MaskKind::Luminance => MaskType::Luminosity,
            },
        ));
        pushes += 1;
    }
    for it in &l.items {
        match it {
            Item::Fill(f) => fill(ctx, s, f),
            Item::Stroke(st) => stroke(ctx, s, st),
            Item::Image(i) => image(ctx, s, i),
            Item::Text(t) => text(ctx, s, t),
            Item::Layer(c) => layer(ctx, s, c, depth + 1, &inner_t),
        }
    }
    for _ in 0..pushes {
        s.pop();
    }
}

fn crop_marks(ctx: &Ctx<'_>, s: &mut Surface<'_>, w: f64, h: f64, bleed: f64) {
    // Registration color: every ink at 100 % (black in RGB output).
    let paint: krilla::paint::Paint = if ctx.cmyk {
        cmyk::Color::new(255, 255, 255, 255).into()
    } else {
        rgb::Color::new(0, 0, 0).into()
    };
    let gap = bleed + 4.0;
    let len = (SLUG_PX - 6.0).max(8.0);
    let mut pb = PathBuilder::new();
    for (x, y, dx, dy) in [
        (0.0, 0.0, -1.0, -1.0),
        (w, 0.0, 1.0, -1.0),
        (w, h, 1.0, 1.0),
        (0.0, h, -1.0, 1.0),
    ] {
        // Horizontal mark at the trim line y, vertical mark at the trim line x, outside the bleed.
        pb.move_to((x + dx * gap) as f32, y as f32);
        pb.line_to((x + dx * (gap + len)) as f32, y as f32);
        pb.move_to(x as f32, (y + dy * gap) as f32);
        pb.line_to(x as f32, (y + dy * (gap + len)) as f32);
    }
    if let Some(p) = pb.finish() {
        s.set_fill(None);
        s.set_stroke(Some(Stroke {
            paint,
            width: (0.25 / PT_PER_PX) as f32,
            miter_limit: 4.0,
            line_cap: KCap::Butt,
            line_join: KJoin::Miter,
            opacity: NormalizedF32::ONE,
            dash: None,
        }));
        s.draw_path(&p);
    }
}

fn krect(r: &Rect, k: f64) -> Option<KRect> {
    KRect::from_xywh(
        (r.x * k) as f32,
        (r.y * k) as f32,
        (r.w * k) as f32,
        (r.h * k) as f32,
    )
}

/// Exports pages as one PDF.
pub fn export_pdf(
    renderer: &mut Renderer,
    design: &Design,
    pages: &[Id],
    opts: &ExportOptions,
) -> Result<ExportOutput, RenderError> {
    let po = &opts.pdf;
    let raster_scale = (po.dpi / 96.0).clamp(0.5, 25.0);
    let mut doc = Document::new();
    let title = po.title.clone().unwrap_or_else(|| design.name.clone());
    doc.set_metadata(
        Metadata::new()
            .title(title)
            .creator("Desyn".into())
            .producer("desyn-raster".into()),
    );
    let page_index: HashMap<&str, usize> = pages
        .iter()
        .enumerate()
        .map(|(i, p)| (p.as_str(), i))
        .collect();
    let mut warnings = Vec::new();
    let mut missing_assets = Vec::new();
    let mut missing_fonts = Vec::new();
    for page in pages {
        let build = BuildOptions {
            page: Some(page.clone()),
            background: matches!(opts.background, Background::Page),
            only: opts.only.clone(),
            hidden: opts.hidden.clone(),
            time_ms: opts.time_ms,
            vector: !po.flatten,
            bleed: po.bleed,
            raster_scale,
            ..BuildOptions::default()
        };
        let mut dl = renderer.build(design, &build)?;
        if let Background::Color(c) = opts.background {
            prepend_background(&mut dl, c);
        }
        let (w, h) = (dl.width.max(1.0), dl.height.max(1.0));
        let bleed = if po.bleed { dl.bleed } else { 0.0 };
        let slug = if po.crop_marks { SLUG_PX } else { 0.0 };
        let m = bleed + slug;
        let media = (w + 2.0 * m, h + 2.0 * m);
        let mut settings =
            PageSettings::from_wh((media.0 * PT_PER_PX) as f32, (media.1 * PT_PER_PX) as f32)
                .ok_or_else(|| RenderError::InvalidOptions(format!("page size {w}x{h}")))?;
        if m > 0.0 {
            settings = settings
                .with_trim_box(krect(&Rect::new(m, m, w, h), PT_PER_PX))
                .with_bleed_box(krect(
                    &Rect::new(slug, slug, w + 2.0 * bleed, h + 2.0 * bleed),
                    PT_PER_PX,
                ));
        }
        let mut kpage = doc.start_page_with(settings);
        let mut ctx = Ctx {
            dl: &dl,
            cmyk: po.cmyk,
            raster_scale,
            fonts: HashMap::new(),
            images: HashMap::new(),
            warnings: Vec::new(),
        };
        {
            let mut s = kpage.surface();
            s.push_transform(&kt(
                &(Affine::scale(PT_PER_PX, PT_PER_PX) * Affine::translate(m, m))
            ));
            if po.flatten {
                let mut ro = page_render_options(opts, page, po.bleed);
                ro.scale = raster_scale;
                ro.region = Some(if po.bleed {
                    dl.bleed_rect()
                } else {
                    dl.page_rect()
                });
                if let Background::Transparent = opts.background {
                    ro.background = Some(Color4::WHITE);
                }
                let r = renderer.render_page(design, &ro)?;
                let img = RasterImage::new(r.pixmap, None);
                if let Some(size) = Size::from_wh(r.region.w as f32, r.region.h as f32) {
                    s.push_transform(&KTransform::from_translate(
                        r.region.x as f32,
                        r.region.y as f32,
                    ));
                    s.draw_image(
                        KImage::from_rgba8(img.to_rgba8(), img.width(), img.height()),
                        size,
                    );
                    s.pop();
                }
            } else {
                // Content outside the trim (or bleed) box is clipped like the page itself.
                let area = if po.bleed {
                    dl.bleed_rect()
                } else {
                    dl.page_rect()
                };
                let clip = geom::rect_path(&area).and_then(|p| kpath(&p));
                if let Some(c) = &clip {
                    s.push_clip_path(c, &KRule::NonZero);
                }
                layer(&mut ctx, &mut s, &dl.root, 0, &Affine::IDENTITY);
                if clip.is_some() {
                    s.pop();
                }
            }
            if po.crop_marks {
                crop_marks(&ctx, &mut s, w, h, bleed);
            }
            s.pop();
            s.finish();
        }
        for l in &dl.links {
            let r = Rect::new(l.rect.x + m, l.rect.y + m, l.rect.w, l.rect.h);
            let Some(rect) = krect(&r, PT_PER_PX) else {
                continue;
            };
            let target = match &l.target {
                LinkTarget::Url(u) => Target::Action(LinkAction::new(u.clone()).into()),
                LinkTarget::Page(p) => match page_index.get(p.as_str()) {
                    Some(i) => Target::Destination(
                        XyzDestination::new(*i, KPoint::from_xy(0.0, 0.0)).into(),
                    ),
                    None => continue,
                },
            };
            kpage.add_annotation(Annotation::new_link(
                LinkAnnotation::new(rect, target),
                None,
            ));
        }
        kpage.finish();
        warnings.append(&mut ctx.warnings);
        warnings.extend(dl.warnings.iter().cloned());
        missing_assets.extend(dl.missing_assets.iter().cloned());
        missing_fonts.extend(dl.missing_fonts.iter().cloned());
    }
    let bytes = doc
        .finish()
        .map_err(|e| RenderError::Encode(format!("pdf: {e:?}")))?;
    missing_assets.sort();
    missing_assets.dedup();
    missing_fonts.sort();
    missing_fonts.dedup();
    Ok(ExportOutput {
        bytes,
        mime: Format::Pdf.mime(),
        extension: "pdf",
        pages: pages.len(),
        missing_assets,
        missing_fonts,
        warnings,
    })
}
