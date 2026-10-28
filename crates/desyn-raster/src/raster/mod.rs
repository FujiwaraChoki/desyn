//! tiny-skia rasterizer for display lists: paints, strokes, images (mip-mapped), text, group opacity, the 16
//! blend modes, clips, alpha / luminance masks, effects (shadows, blurs, glow, noise) and damage-region redraws.

pub mod blur;
mod cache;
mod effects;
mod resample;

use desyn_core::geometry::{Affine, Rect};
use desyn_core::model::BlendMode;
use tiny_skia::{
    FilterQuality, GradientStop as SkStop, IntRect, Mask, MaskType, PathSegment, Pixmap, PixmapMut,
    PixmapPaint, Shader, SpreadMode, Transform,
};

pub use cache::LayerCache;

use crate::assets::RasterImage;
use crate::display::{DisplayList, Item, Layer, LayerEffect, MaskKind};
use crate::geom::{self, intersect, round_out, to_ts};
use crate::paint::{Color4, ImageExtend, Paint, Quality, Spread};

/// How to rasterize a display list.
#[derive(Debug, Clone, PartialEq)]
pub struct RasterOptions {
    /// Page coordinates to device pixels.
    pub transform: Affine,
    /// Device rectangle to (re)draw; `None` = the whole target. Pixels outside are left untouched.
    pub region: Option<IntRect>,
    /// Color the region is cleared to (`None` = transparent).
    pub background: Option<Color4>,
}

impl RasterOptions {
    /// Whole-target render with a page-to-device transform.
    pub fn new(transform: Affine) -> Self {
        RasterOptions {
            transform,
            region: None,
            background: None,
        }
    }
}

/// tiny-skia blend mode.
pub fn skia_blend(b: BlendMode) -> tiny_skia::BlendMode {
    use tiny_skia::BlendMode as S;
    match b {
        BlendMode::Normal => S::SourceOver,
        BlendMode::Multiply => S::Multiply,
        BlendMode::Screen => S::Screen,
        BlendMode::Overlay => S::Overlay,
        BlendMode::Darken => S::Darken,
        BlendMode::Lighten => S::Lighten,
        BlendMode::ColorDodge => S::ColorDodge,
        BlendMode::ColorBurn => S::ColorBurn,
        BlendMode::HardLight => S::HardLight,
        BlendMode::SoftLight => S::SoftLight,
        BlendMode::Difference => S::Difference,
        BlendMode::Exclusion => S::Exclusion,
        BlendMode::Hue => S::Hue,
        BlendMode::Saturation => S::Saturation,
        BlendMode::Color => S::Color,
        BlendMode::Luminosity => S::Luminosity,
    }
}

/// tiny-skia's low-precision pipeline overflows u16 math for overlay / hard-light (the unused branch is computed
/// too); the float pipeline is exact.
pub(crate) fn needs_hq(b: tiny_skia::BlendMode) -> bool {
    matches!(
        b,
        tiny_skia::BlendMode::Overlay | tiny_skia::BlendMode::HardLight
    )
}

/// Draws a pixmap at an integer offset with opacity and blend mode (safe for every blend mode).
pub(crate) fn draw_pixmap_blend(
    dst: &mut PixmapMut<'_>,
    x: i32,
    y: i32,
    src: &Pixmap,
    opacity: f32,
    blend: tiny_skia::BlendMode,
    mask: Option<&Mask>,
) {
    let Some(rect) =
        tiny_skia::Rect::from_xywh(x as f32, y as f32, src.width() as f32, src.height() as f32)
    else {
        return;
    };
    let paint = tiny_skia::Paint {
        shader: tiny_skia::Pattern::new(
            src.as_ref(),
            SpreadMode::Pad,
            FilterQuality::Nearest,
            opacity.clamp(0.0, 1.0),
            Transform::from_translate(x as f32, y as f32),
        ),
        blend_mode: blend,
        anti_alias: false,
        force_hq_pipeline: needs_hq(blend),
        ..Default::default()
    };
    dst.fill_rect(rect, &paint, Transform::identity(), mask);
}

fn spread(s: Spread) -> SpreadMode {
    match s {
        Spread::Pad => SpreadMode::Pad,
        Spread::Repeat => SpreadMode::Repeat,
        Spread::Reflect => SpreadMode::Reflect,
    }
}

fn stops(s: &[crate::paint::GradientStop]) -> Vec<SkStop> {
    s.iter()
        .map(|g| SkStop::new(g.pos.clamp(0.0, 1.0), g.color.to_skia()))
        .collect()
}

fn quality(q: Quality, device: &Affine) -> FilterQuality {
    // Integer-translated 1:1 images need no filtering.
    if device.a == 1.0
        && device.d == 1.0
        && device.b == 0.0
        && device.c == 0.0
        && device.e.fract() == 0.0
        && device.f.fract() == 0.0
    {
        return FilterQuality::Nearest;
    }
    match q {
        Quality::Nearest => FilterQuality::Nearest,
        Quality::Bilinear => FilterQuality::Bilinear,
        Quality::Bicubic => FilterQuality::Bicubic,
    }
}

/// Pixels to sample for an image and how they map to image pixel space.
struct ImgSrc<'a> {
    pix: PixRef<'a>,
    /// Source pixel space to image pixel space.
    to_image: Affine,
    quality: FilterQuality,
}

enum PixRef<'a> {
    Borrowed(&'a Pixmap),
    Shared(std::sync::Arc<Pixmap>),
}

impl PixRef<'_> {
    fn as_ref(&self) -> tiny_skia::PixmapRef<'_> {
        match self {
            PixRef::Borrowed(p) => p.as_ref(),
            PixRef::Shared(p) => p.as_ref().as_ref(),
        }
    }
}

/// Chooses the pixels for drawing `img` with `full` (image px -> device px): a cached high-quality resample at
/// the exact device size for axis-aligned draws that repeat (interactive frames, re-exports), otherwise a mip
/// level. Transparent extension samples copies with a transparent border.
fn image_source<'a>(
    ctx: &mut Ctx<'_>,
    img: &'a RasterImage,
    full: &Affine,
    q: Quality,
    extend: ImageExtend,
) -> Option<ImgSrc<'a>> {
    let (iw, ih) = (f64::from(img.width()), f64::from(img.height()));
    let padded = extend == ImageExtend::Transparent;
    let aligned = full.b.abs() < 1e-9 && full.c.abs() < 1e-9 && full.a > 0.0 && full.d > 0.0;
    if aligned
        && extend != ImageExtend::Repeat
        && q != Quality::Nearest
        && ((full.a - 1.0).abs() > 1e-3 || (full.d - 1.0).abs() > 1e-3)
    {
        let dw = (iw * full.a).round();
        let dh = (ih * full.d).round();
        if dw >= 1.0
            && dh >= 1.0
            && dw * dh <= 64.0e6
            && dw <= 16384.0
            && dh <= 16384.0
            && let Some(cache) = ctx.cache.as_deref_mut()
            && let Some(pix) = cache.resampled(img, dw as u32, dh as u32, padded)
        {
            let pad = if padded {
                Affine::translate(-1.0, -1.0)
            } else {
                Affine::IDENTITY
            };
            let to_image = Affine::scale(iw / dw, ih / dh) * pad;
            let dev = *full * to_image;
            let integer = (dev.a - 1.0).abs() < 1e-6
                && (dev.d - 1.0).abs() < 1e-6
                && (dev.e - dev.e.round()).abs() < 1e-3
                && (dev.f - dev.f.round()).abs() < 1e-3;
            return Some(ImgSrc {
                pix: PixRef::Shared(pix),
                to_image,
                quality: if integer {
                    FilterQuality::Nearest
                } else {
                    FilterQuality::Bilinear
                },
            });
        }
    }
    let scale = geom::mean_scale(full);
    let quality = quality(q, full);
    if padded {
        let (pix, f) = img.padded_level_for_scale(scale)?;
        Some(ImgSrc {
            pix: PixRef::Borrowed(pix),
            to_image: Affine::scale(1.0 / f, 1.0 / f) * Affine::translate(-1.0, -1.0),
            quality,
        })
    } else {
        let (pix, f) = img.level_for_scale(scale);
        Some(ImgSrc {
            pix: PixRef::Borrowed(pix),
            to_image: Affine::scale(1.0 / f, 1.0 / f),
            quality,
        })
    }
}

/// Shader of a paint in item-local space (`src`: the chosen pixels of an image paint).
fn shader<'a>(p: &'a Paint, opacity: f32, src: Option<&'a ImgSrc<'a>>) -> Option<Shader<'a>> {
    let mut s = match p {
        Paint::Solid(c) => return Some(Shader::SolidColor(c.with_alpha_mul(opacity).to_skia())),
        Paint::Linear {
            start,
            end,
            stops: st,
            spread: sp,
            transform,
        } => tiny_skia::LinearGradient::new(
            tiny_skia::Point::from_xy(start.x as f32, start.y as f32),
            tiny_skia::Point::from_xy(end.x as f32, end.y as f32),
            stops(st),
            spread(*sp),
            to_ts(transform),
        )
        .or_else(|| st.last().map(|l| Shader::SolidColor(l.color.to_skia())))?,
        Paint::Radial {
            c0,
            r0,
            c1,
            r1,
            stops: st,
            spread: sp,
            transform,
        } => tiny_skia::RadialGradient::new(
            tiny_skia::Point::from_xy(c0.x as f32, c0.y as f32),
            r0.max(0.0) as f32,
            tiny_skia::Point::from_xy(c1.x as f32, c1.y as f32),
            r1.max(0.0) as f32,
            stops(st),
            spread(*sp),
            to_ts(transform),
        )
        .or_else(|| st.last().map(|l| Shader::SolidColor(l.color.to_skia())))?,
        Paint::Conic {
            center,
            start_deg,
            end_deg,
            stops: st,
            spread: sp,
            transform,
        } => tiny_skia::SweepGradient::new(
            tiny_skia::Point::from_xy(center.x as f32, center.y as f32),
            start_deg.max(0.0) as f32,
            end_deg.clamp(*start_deg, 360.0) as f32,
            stops(st),
            spread(*sp),
            to_ts(transform),
        )
        .or_else(|| st.last().map(|l| Shader::SolidColor(l.color.to_skia())))?,
        Paint::Image(ip) => {
            let src = src?;
            let spread = if ip.extend == ImageExtend::Repeat {
                SpreadMode::Repeat
            } else {
                SpreadMode::Pad
            };
            let t = ip.transform * src.to_image;
            return Some(tiny_skia::Pattern::new(
                src.pix.as_ref(),
                spread,
                src.quality,
                opacity,
                to_ts(&t),
            ));
        }
    };
    if opacity < 1.0 {
        s.apply_opacity(opacity);
    }
    Some(s)
}

fn sk_paint<'a>(
    p: &'a Paint,
    opacity: f32,
    blend: BlendMode,
    src: Option<&'a ImgSrc<'a>>,
) -> Option<tiny_skia::Paint<'a>> {
    if opacity <= 0.0 {
        return None;
    }
    let blend_mode = skia_blend(blend);
    Some(tiny_skia::Paint {
        shader: shader(p, opacity.min(1.0), src)?,
        blend_mode,
        anti_alias: true,
        force_hq_pipeline: needs_hq(blend_mode),
        ..Default::default()
    })
}

/// Image source of an image paint drawn with item-to-surface transform `lm`.
fn paint_source<'a>(ctx: &mut Ctx<'_>, p: &'a Paint, lm: &Affine) -> Option<ImgSrc<'a>> {
    match p {
        Paint::Image(ip) => {
            image_source(ctx, &ip.image, &(*lm * ip.transform), ip.quality, ip.extend)
        }
        _ => None,
    }
}

/// A drawing surface: a pixmap whose pixel (0, 0) is device pixel `origin`.
struct Surface<'s, 'p> {
    pix: &'s mut PixmapMut<'p>,
    origin: (i32, i32),
}

impl Surface<'_, '_> {
    fn rect(&self) -> IntRect {
        IntRect::from_xywh(
            self.origin.0,
            self.origin.1,
            self.pix.width(),
            self.pix.height(),
        )
        .expect("non-empty surface")
    }

    fn local(&self, m: &Affine) -> Affine {
        Affine::translate(-f64::from(self.origin.0), -f64::from(self.origin.1)) * *m
    }
}

struct Ctx<'c> {
    cache: Option<&'c mut LayerCache>,
    depth: usize,
    /// Draw every leaf opaque black (shape coverage for background blur masks).
    silhouette: bool,
}

const MAX_LAYER_DEPTH: usize = 512;
/// Largest offscreen layer side (device px); bigger layers are clipped to the visible region anyway.
const MAX_OFFSCREEN: u32 = 16384;

fn layer_needs_offscreen(
    l: &Layer,
    alpha: f32,
    inherited_blend: BlendMode,
    clip_trivial: bool,
) -> bool {
    if l.mask.is_some() || !l.effects.is_empty() || !clip_trivial {
        return true;
    }
    let group_alpha = alpha * l.opacity < 0.999;
    let group_blend = l.blend != BlendMode::Normal || inherited_blend != BlendMode::Normal;
    (group_alpha || group_blend) && l.leaf_count(2) > 1
}

fn draw_item(
    ctx: &mut Ctx<'_>,
    surf: &mut Surface<'_, '_>,
    it: &Item,
    m: &Affine,
    vis: &IntRect,
    alpha: f32,
    blend: BlendMode,
) {
    if let Item::Layer(l) = it {
        draw_layer(ctx, surf, l, m, vis, alpha, blend);
        return;
    }
    let b = it.bounds();
    let Some(dev) = round_out(&m.transform_rect_bbox(&b).inflate(1.0)) else {
        // Zero-area bounds: hairline geometry still paints when stroked.
        if !matches!(it, Item::Stroke(_)) {
            return;
        }
        return draw_leaf(ctx, surf, it, m, alpha, blend);
    };
    if intersect(&dev, vis).is_none() {
        return;
    }
    draw_leaf(ctx, surf, it, m, alpha, blend);
}

/// Opaque black: the paint of silhouette passes.
static SILHOUETTE: Paint = Paint::Solid(Color4::BLACK);

fn draw_leaf(
    ctx: &mut Ctx<'_>,
    surf: &mut Surface<'_, '_>,
    it: &Item,
    m: &Affine,
    alpha: f32,
    blend: BlendMode,
) {
    let lm = surf.local(m);
    let ts = to_ts(&lm);
    match it {
        Item::Fill(f) if ctx.silhouette => {
            if let Some(p) = sk_paint(&SILHOUETTE, 1.0, BlendMode::Normal, None) {
                surf.pix.fill_path(&f.path, &p, f.rule.to_skia(), ts, None);
            }
        }
        Item::Stroke(s) if ctx.silhouette => {
            if let Some(p) = sk_paint(&SILHOUETTE, 1.0, BlendMode::Normal, None) {
                surf.pix
                    .stroke_path(&s.path, &p, &s.stroke.to_skia(), ts, None);
            }
        }
        Item::Text(t) if ctx.silhouette => {
            if let Some(p) = sk_paint(&SILHOUETTE, 1.0, BlendMode::Normal, None) {
                surf.pix
                    .fill_path(&t.outline, &p, tiny_skia::FillRule::Winding, ts, None);
            }
        }
        Item::Fill(f) => {
            let mode = if f.blend != BlendMode::Normal {
                f.blend
            } else {
                blend
            };
            let src = paint_source(ctx, &f.paint, &lm);
            if mode == BlendMode::Normal
                && f.opacity * alpha >= 0.999
                && let (Paint::Image(ip), Some(src)) = (&f.paint, src.as_ref())
                && ip.image.is_opaque()
                && blit_image_rect(surf, &f.path, &lm, &(lm * ip.transform * src.to_image), src)
            {
                return;
            }
            if let Some(p) = sk_paint(&f.paint, f.opacity * alpha, mode, src.as_ref()) {
                surf.pix.fill_path(&f.path, &p, f.rule.to_skia(), ts, None);
            }
        }
        Item::Stroke(s) => {
            let mode = if s.blend != BlendMode::Normal {
                s.blend
            } else {
                blend
            };
            let src = paint_source(ctx, &s.paint, &lm);
            if let Some(p) = sk_paint(&s.paint, s.opacity * alpha, mode, src.as_ref()) {
                surf.pix
                    .stroke_path(&s.path, &p, &s.stroke.to_skia(), ts, None);
            }
        }
        Item::Text(t) => {
            let mode = if t.blend != BlendMode::Normal {
                t.blend
            } else {
                blend
            };
            let src = paint_source(ctx, &t.paint, &lm);
            if let Some(p) = sk_paint(&t.paint, t.opacity * alpha, mode, src.as_ref()) {
                surf.pix
                    .fill_path(&t.outline, &p, tiny_skia::FillRule::Winding, ts, None);
                if t.bold > 0.0 {
                    let st = tiny_skia::Stroke {
                        width: t.bold as f32,
                        line_join: tiny_skia::LineJoin::Round,
                        line_cap: tiny_skia::LineCap::Round,
                        ..Default::default()
                    };
                    surf.pix.stroke_path(&t.outline, &p, &st, ts, None);
                }
            }
        }
        Item::Image(i) => {
            let mode = if i.blend != BlendMode::Normal {
                i.blend
            } else {
                blend
            };
            let full = lm * i.transform;
            let Some(src) = image_source(ctx, &i.image, &full, i.quality, ImageExtend::Transparent)
            else {
                return;
            };
            let pattern = tiny_skia::Pattern::new(
                src.pix.as_ref(),
                SpreadMode::Pad,
                src.quality,
                (if ctx.silhouette {
                    1.0
                } else {
                    i.opacity * alpha
                })
                .clamp(0.0, 1.0),
                to_ts(&src.to_image),
            );
            let blend_mode = skia_blend(mode);
            let paint = tiny_skia::Paint {
                shader: pattern,
                blend_mode,
                anti_alias: true,
                force_hq_pipeline: needs_hq(blend_mode),
                ..Default::default()
            };
            if let Some(r) = tiny_skia::Rect::from_xywh(
                0.0,
                0.0,
                i.image.width() as f32,
                i.image.height() as f32,
            ) {
                surf.pix.fill_rect(r, &paint, to_ts(&full), None);
            }
        }
        Item::Layer(_) => {}
    }
}

/// The rectangle a path describes, when it is exactly an axis-aligned rectangle.
fn path_rect(p: &tiny_skia::Path) -> Option<tiny_skia::Rect> {
    let b = p.bounds();
    let mut n = 0;
    for seg in p.segments() {
        let pt = match seg {
            PathSegment::MoveTo(a) | PathSegment::LineTo(a) => a,
            PathSegment::Close => continue,
            _ => return None,
        };
        let on_x = (pt.x - b.left()).abs() < 1e-4 || (pt.x - b.right()).abs() < 1e-4;
        let on_y = (pt.y - b.top()).abs() < 1e-4 || (pt.y - b.bottom()).abs() < 1e-4;
        if !(on_x && on_y) {
            return None;
        }
        n += 1;
    }
    (4..=5).contains(&n).then_some(b)
}

/// Copies an opaque image 1:1 into a pixel-aligned rectangle (the common "photo fills its frame" case).
/// `total` maps source pixels to surface pixels; returns false when the fast path does not apply.
fn blit_image_rect(
    surf: &mut Surface<'_, '_>,
    path: &tiny_skia::Path,
    lm: &Affine,
    total: &Affine,
    src: &ImgSrc<'_>,
) -> bool {
    if src.quality != FilterQuality::Nearest
        || (total.a - 1.0).abs() > 1e-9
        || (total.d - 1.0).abs() > 1e-9
        || total.b != 0.0
        || total.c != 0.0
        || !geom::is_axis_aligned(lm)
    {
        return false;
    }
    let Some(r) = path_rect(path) else {
        return false;
    };
    let d = lm.transform_rect_bbox(&desyn_core::geometry::Rect::new(
        f64::from(r.x()),
        f64::from(r.y()),
        f64::from(r.width()),
        f64::from(r.height()),
    ));
    let int = |v: f64| (v - v.round()).abs() < 1e-3;
    if !(int(d.x) && int(d.y) && int(d.right()) && int(d.bottom()) && int(total.e) && int(total.f))
    {
        return false;
    }
    let (sw, sh) = (surf.pix.width() as i64, surf.pix.height() as i64);
    let x0 = (d.x.round() as i64).max(0);
    let y0 = (d.y.round() as i64).max(0);
    let x1 = (d.right().round() as i64).min(sw);
    let y1 = (d.bottom().round() as i64).min(sh);
    if x1 <= x0 || y1 <= y0 {
        return true;
    }
    let (ox, oy) = (total.e.round() as i64, total.f.round() as i64);
    let sp = src.pix.as_ref();
    let (pw, ph) = (i64::from(sp.width()), i64::from(sp.height()));
    if x0 - ox < 0 || y0 - oy < 0 || x1 - ox > pw || y1 - oy > ph {
        return false;
    }
    let sdata = sp.data();
    let width = (x1 - x0) as usize * 4;
    let ddata = surf.pix.data_mut();
    for y in y0..y1 {
        let si = (((y - oy) * pw + (x0 - ox)) * 4) as usize;
        let di = ((y * sw + x0) * 4) as usize;
        ddata[di..di + width].copy_from_slice(&sdata[si..si + width]);
    }
    true
}

/// True when clipping to `clip` cannot change the drawn pixels of `layer` within `vis`.
fn clip_is_trivial(layer: &Layer, m: &Affine, vis: &IntRect) -> bool {
    let Some(clip) = &layer.clip else { return true };
    let Some(r) = clip.rect else { return false };
    if !geom::is_axis_aligned(m) {
        return false;
    }
    // Content entirely inside the clip rectangle.
    let content = layer.items.iter().fold(None, |acc: Option<Rect>, it| {
        geom::union_rect(acc, &it.bounds())
    });
    if let Some(c) = content
        && c.x >= r.x - 1e-9
        && c.y >= r.y - 1e-9
        && c.right() <= r.right() + 1e-9
        && c.bottom() <= r.bottom() + 1e-9
    {
        return true;
    }
    // The visible region lies inside the device clip rectangle with pixel-aligned edges.
    let d = m.transform_rect_bbox(&r);
    let aligned = |v: f64| (v - v.round()).abs() < 1e-3;
    aligned(d.x)
        && aligned(d.y)
        && aligned(d.right())
        && aligned(d.bottom())
        && d.x <= f64::from(vis.left())
        && d.y <= f64::from(vis.top())
        && d.right() >= f64::from(vis.right())
        && d.bottom() >= f64::from(vis.bottom())
}

/// Pixel-aligned device rectangle of an axis-aligned rect clip (cheap clipping by offscreen bounds).
fn aligned_clip_rect(layer: &Layer, m: &Affine) -> Option<IntRect> {
    let r = layer.clip.as_ref()?.rect?;
    if !geom::is_axis_aligned(m) {
        return None;
    }
    let d = m.transform_rect_bbox(&r);
    let aligned = |v: f64| (v - v.round()).abs() < 1e-3;
    if aligned(d.x) && aligned(d.y) && aligned(d.right()) && aligned(d.bottom()) {
        IntRect::from_ltrb(
            d.x.round() as i32,
            d.y.round() as i32,
            d.right().round() as i32,
            d.bottom().round() as i32,
        )
    } else {
        None
    }
}

fn draw_layer(
    ctx: &mut Ctx<'_>,
    surf: &mut Surface<'_, '_>,
    layer: &Layer,
    parent: &Affine,
    vis: &IntRect,
    alpha: f32,
    blend: BlendMode,
) {
    if ctx.depth > MAX_LAYER_DEPTH {
        return;
    }
    let alpha_total = if ctx.silhouette {
        1.0
    } else {
        alpha * layer.opacity
    };
    let has_backdrop_effect = layer
        .effects
        .iter()
        .any(|e| matches!(e, LayerEffect::BackgroundBlur { .. }));
    if alpha_total <= 0.0 && !has_backdrop_effect {
        return;
    }
    let Some(dev) = round_out(&parent.transform_rect_bbox(&layer.bounds).inflate(1.0)) else {
        return;
    };
    let Some(visible) = intersect(&dev, vis) else {
        return;
    };
    let m = *parent * layer.transform;
    let trivial = clip_is_trivial(layer, &m, &visible);
    if !layer_needs_offscreen(layer, alpha, blend, trivial) {
        let mode = if layer.blend != BlendMode::Normal {
            layer.blend
        } else {
            blend
        };
        ctx.depth += 1;
        for it in &layer.items {
            draw_item(ctx, surf, it, &m, &visible, alpha_total, mode);
        }
        ctx.depth -= 1;
        return;
    }
    let mode = if layer.blend != BlendMode::Normal {
        layer.blend
    } else {
        blend
    };
    effects::draw_offscreen(ctx, surf, layer, &m, &visible, alpha_total, mode);
}

/// Renders layer content (children, clip, mask) into a new pixmap covering `rect` (device px).
fn render_content(
    ctx: &mut Ctx<'_>,
    layer: &Layer,
    m: &Affine,
    rect: &IntRect,
) -> Option<(Pixmap, IntRect)> {
    let rect = match aligned_clip_rect(layer, m) {
        Some(c) => intersect(rect, &c)?,
        None => *rect,
    };
    if rect.width() > MAX_OFFSCREEN || rect.height() > MAX_OFFSCREEN {
        return None;
    }
    let mut pix = Pixmap::new(rect.width(), rect.height())?;
    {
        let mut pm = pix.as_mut();
        let mut s = Surface {
            pix: &mut pm,
            origin: (rect.x(), rect.y()),
        };
        ctx.depth += 1;
        for it in &layer.items {
            draw_item(ctx, &mut s, it, m, &rect, 1.0, BlendMode::Normal);
        }
        ctx.depth -= 1;
    }
    let origin = Affine::translate(-f64::from(rect.x()), -f64::from(rect.y()));
    if let Some(clip) = &layer.clip
        && aligned_clip_rect(layer, m).is_none()
        && !clip_is_trivial(layer, m, &rect)
    {
        let mut mask = Mask::new(rect.width(), rect.height())?;
        mask.fill_path(&clip.path, clip.rule.to_skia(), true, to_ts(&(origin * *m)));
        pix.apply_mask(&mask);
    }
    if let Some(lm) = &layer.mask {
        let mut mp = Pixmap::new(rect.width(), rect.height())?;
        {
            let mut pm = mp.as_mut();
            let mut s = Surface {
                pix: &mut pm,
                origin: (rect.x(), rect.y()),
            };
            draw_layer(ctx, &mut s, &lm.layer, m, &rect, 1.0, BlendMode::Normal);
        }
        let kind = match lm.kind {
            MaskKind::Alpha => MaskType::Alpha,
            MaskKind::Luminance => MaskType::Luminance,
        };
        pix.apply_mask(&Mask::from_pixmap(mp.as_ref(), kind));
    }
    Some((pix, rect))
}

/// Draws `pix` (device rect `rect`) onto the surface.
fn composite(
    surf: &mut Surface<'_, '_>,
    pix: &Pixmap,
    rect: &IntRect,
    alpha: f32,
    blend: BlendMode,
) {
    let mode = skia_blend(blend);
    if !needs_hq(mode) {
        let paint = PixmapPaint {
            opacity: alpha.clamp(0.0, 1.0),
            blend_mode: mode,
            quality: FilterQuality::Nearest,
        };
        surf.pix.draw_pixmap(
            rect.x() - surf.origin.0,
            rect.y() - surf.origin.1,
            pix.as_ref(),
            &paint,
            Transform::identity(),
            None,
        );
        return;
    }
    draw_pixmap_blend(
        surf.pix,
        rect.x() - surf.origin.0,
        rect.y() - surf.origin.1,
        pix,
        alpha,
        mode,
        None,
    );
}

/// Rasterizes a display list into `target` (premultiplied RGBA8).
pub fn rasterize(
    dl: &DisplayList,
    target: &mut PixmapMut<'_>,
    opts: &RasterOptions,
    cache: Option<&mut LayerCache>,
) {
    let Some(full) = IntRect::from_xywh(0, 0, target.width(), target.height()) else {
        return;
    };
    let region = match opts.region {
        Some(r) => match intersect(&r, &full) {
            Some(r) => r,
            None => return,
        },
        None => full,
    };
    if !geom::affine_finite(&opts.transform) {
        return;
    }
    let bg = opts.background.unwrap_or(Color4::TRANSPARENT).to_skia();
    if region == full {
        target.fill(bg);
        let mut surf = Surface {
            pix: target,
            origin: (0, 0),
        };
        let mut ctx = Ctx {
            cache,
            depth: 0,
            silhouette: false,
        };
        draw_layer(
            &mut ctx,
            &mut surf,
            &dl.root,
            &opts.transform,
            &region,
            1.0,
            BlendMode::Normal,
        );
        return;
    }
    // A strict part of the target: draw into an offscreen of the region and copy it back (replacing pixels).
    let Some(mut sub) = Pixmap::new(region.width(), region.height()) else {
        return;
    };
    sub.fill(bg);
    {
        let mut pm = sub.as_mut();
        let mut surf = Surface {
            pix: &mut pm,
            origin: (region.x(), region.y()),
        };
        let mut ctx = Ctx {
            cache,
            depth: 0,
            silhouette: false,
        };
        draw_layer(
            &mut ctx,
            &mut surf,
            &dl.root,
            &opts.transform,
            &region,
            1.0,
            BlendMode::Normal,
        );
    }
    let tw = target.width() as usize;
    let rw = region.width() as usize;
    let data = target.data_mut();
    let src = sub.data();
    for row in 0..region.height() as usize {
        let ty = region.y() as usize + row;
        let d0 = (ty * tw + region.x() as usize) * 4;
        let s0 = row * rw * 4;
        data[d0..d0 + rw * 4].copy_from_slice(&src[s0..s0 + rw * 4]);
    }
}

/// A copy of `root` holding everything painted up to and including `target` (found by identity), or `None`
/// when `target` is not in the tree. Vector exporters render it to reproduce effects that read the backdrop
/// (background blur) exactly.
pub fn truncate_after(root: &Layer, target: &Layer) -> Option<Layer> {
    fn walk(l: &Layer, target: &Layer, depth: usize) -> (Layer, bool) {
        let mut out = Layer {
            items: Vec::new(),
            ..l.clone_header()
        };
        if depth > MAX_LAYER_DEPTH {
            return (out, false);
        }
        for it in &l.items {
            match it {
                Item::Layer(c) if std::ptr::eq(c.as_ref(), target) => {
                    out.items.push(it.clone());
                    return (out, true);
                }
                Item::Layer(c) => {
                    let (tc, found) = walk(c, target, depth + 1);
                    if found {
                        out.items.push(Item::Layer(Box::new(tc)));
                        return (out, true);
                    }
                    out.items.push(it.clone());
                }
                _ => out.items.push(it.clone()),
            }
        }
        (out, false)
    }
    let (t, found) = walk(root, target, 0);
    found.then_some(t)
}

/// Renders a page-space `region` of a (possibly truncated) root layer at `scale` device px per design px.
pub fn render_region(
    root: &Layer,
    region: &desyn_core::geometry::Rect,
    scale: f64,
) -> Option<Pixmap> {
    let w = (region.w * scale).ceil().max(1.0) as u32;
    let h = (region.h * scale).ceil().max(1.0) as u32;
    if w > MAX_OFFSCREEN || h > MAX_OFFSCREEN {
        return None;
    }
    render_layer(
        root,
        w,
        h,
        Affine::scale(scale, scale) * Affine::translate(-region.x, -region.y),
    )
}

/// Renders a single layer (and its descendants) into a new transparent pixmap (`transform` maps the layer's
/// parent space to the pixmap). Used by exporters for rasterized fallbacks.
pub fn render_layer(layer: &Layer, width: u32, height: u32, transform: Affine) -> Option<Pixmap> {
    let mut pix = Pixmap::new(width, height)?;
    {
        let mut pm = pix.as_mut();
        let mut surf = Surface {
            pix: &mut pm,
            origin: (0, 0),
        };
        let full = IntRect::from_xywh(0, 0, width, height)?;
        let mut ctx = Ctx {
            cache: None,
            depth: 0,
            silhouette: false,
        };
        draw_layer(
            &mut ctx,
            &mut surf,
            layer,
            &transform,
            &full,
            1.0,
            BlendMode::Normal,
        );
    }
    Some(pix)
}

/// Renders a display list into a new pixmap of `width x height` device pixels.
pub fn render_to_pixmap(
    dl: &DisplayList,
    width: u32,
    height: u32,
    transform: Affine,
    background: Option<Color4>,
    cache: Option<&mut LayerCache>,
) -> Option<Pixmap> {
    let mut pix = Pixmap::new(width, height)?;
    let opts = RasterOptions {
        transform,
        region: None,
        background,
    };
    rasterize(dl, &mut pix.as_mut(), &opts, cache);
    Some(pix)
}
