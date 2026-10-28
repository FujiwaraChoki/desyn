//! Glyph outlines (for rasterization, SVG / PDF export and "convert text to outlines"), color glyph layers
//! (COLR v0 / v1) and embedded bitmaps (CBDT / sbix).

use std::collections::HashMap;
use std::sync::Arc;

use desyn_core::geometry::Affine as CoreAffine;
use desyn_core::model::{BoolOp, FillRule, StrokeCap, StrokeJoin};
use desyn_core::paths::kurbo::{Affine, BezPath, Rect as KRect, Shape as _};
use desyn_core::paths::{Shape, StrokeStyle, VectorPath, boolean, stroke_outline};
use serde::Serialize;
use skrifa::bitmap::{BitmapData, Origin};
use skrifa::color::{Brush, ColorPainter, ColorStop, CompositeMode, Extend, Transform};
use skrifa::instance::{LocationRef, Size};
use skrifa::outline::{DrawSettings, OutlinePen};
use skrifa::raw::types::BoundingBox;
use skrifa::{GlyphId, MetadataProvider};

use crate::engine::TextEngine;
use crate::font::InstanceId;
use crate::types::{DecorationKind, LaidOutText};

#[derive(Default)]
pub(crate) struct OutlineCache {
    map: HashMap<(InstanceId, u32), Option<Arc<BezPath>>>,
}

impl OutlineCache {
    pub fn clear(&mut self) {
        self.map.clear();
    }
    pub fn len(&self) -> usize {
        self.map.len()
    }
}

struct BezPen(BezPath);

impl OutlinePen for BezPen {
    fn move_to(&mut self, x: f32, y: f32) {
        self.0.move_to((f64::from(x), f64::from(y)));
    }
    fn line_to(&mut self, x: f32, y: f32) {
        self.0.line_to((f64::from(x), f64::from(y)));
    }
    fn quad_to(&mut self, cx0: f32, cy0: f32, x: f32, y: f32) {
        self.0.quad_to(
            (f64::from(cx0), f64::from(cy0)),
            (f64::from(x), f64::from(y)),
        );
    }
    fn curve_to(&mut self, cx0: f32, cy0: f32, cx1: f32, cy1: f32, x: f32, y: f32) {
        self.0.curve_to(
            (f64::from(cx0), f64::from(cy0)),
            (f64::from(cx1), f64::from(cy1)),
            (f64::from(x), f64::from(y)),
        );
    }
    fn close(&mut self) {
        self.0.close_path();
    }
}

/// What a glyph needs to be drawn.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum GlyphKind {
    /// Plain outline filled with the run's paint.
    Outline,
    /// COLR layers ([`TextEngine::color_glyph`]).
    Color,
    /// Embedded bitmap ([`TextEngine::bitmap_glyph`]).
    Bitmap,
}

/// Kind of a [`TextPath`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TextPathKind {
    /// Glyph outline.
    Glyph,
    /// Underline rectangle.
    Underline,
    /// Strikethrough rectangle.
    Strikethrough,
    /// Highlight background rectangle.
    Highlight,
}

/// A positioned piece of text geometry in box coordinates (px, y down).
#[derive(Debug, Clone, PartialEq)]
pub struct TextPath {
    /// Kind.
    pub kind: TextPathKind,
    /// Geometry (nonzero fill rule).
    pub path: BezPath,
    /// Span whose fills paint it.
    pub span: usize,
    /// Run index for glyphs.
    pub run: Option<usize>,
    /// Glyph index inside the run for glyphs.
    pub glyph_index: Option<usize>,
    /// Glyph id for glyphs.
    pub glyph: Option<u32>,
    /// The glyph is a color glyph (COLR / bitmap) and `path` is its single-color silhouette; renderers that
    /// support color draw [`TextEngine::color_glyph`] / [`TextEngine::bitmap_glyph`] instead. A bitmap-only glyph
    /// (CBDT / sbix, no outline) has its image rectangle as `path`.
    pub color_glyph: bool,
    /// Highlight color, or the span's solid color.
    pub color: Option<[u8; 4]>,
    /// Synthetic bold: also stroke the path with this width (px) in the same paint.
    pub stroke: f64,
}

/// Extend mode of a color glyph gradient.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum GradientExtend {
    /// Clamp to the end colors.
    Pad,
    /// Repeat.
    Repeat,
    /// Mirror.
    Reflect,
}

/// Gradient stop of a color glyph.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GradientStop {
    /// Offset 0..1.
    pub offset: f32,
    /// RGBA (straight alpha).
    pub color: [u8; 4],
}

/// Paint of a color glyph layer. Gradient geometry is in the layer's paint space; map it to glyph space with
/// [`ColorLayer::paint_transform`].
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum ColorPaint {
    /// Solid color.
    Solid {
        /// RGBA.
        color: [u8; 4],
    },
    /// Linear gradient from `p0` to `p1`.
    Linear {
        /// Start point.
        p0: (f64, f64),
        /// End point.
        p1: (f64, f64),
        /// Stops.
        stops: Vec<GradientStop>,
        /// Extend mode.
        extend: GradientExtend,
    },
    /// Two-circle radial gradient.
    Radial {
        /// Start center.
        c0: (f64, f64),
        /// Start radius.
        r0: f64,
        /// End center.
        c1: (f64, f64),
        /// End radius.
        r1: f64,
        /// Stops.
        stops: Vec<GradientStop>,
        /// Extend mode.
        extend: GradientExtend,
    },
    /// Sweep (conic) gradient, angles in degrees clockwise.
    Sweep {
        /// Center.
        center: (f64, f64),
        /// Start angle.
        start_angle: f64,
        /// End angle.
        end_angle: f64,
        /// Stops.
        stops: Vec<GradientStop>,
        /// Extend mode.
        extend: GradientExtend,
    },
}

/// One filled layer of a color glyph, painted bottom to top.
#[derive(Debug, Clone, PartialEq)]
pub struct ColorLayer {
    /// Clip / fill geometry in px relative to the glyph origin (y down).
    pub path: BezPath,
    /// Paint.
    pub paint: ColorPaint,
    /// Maps paint coordinates to glyph px space.
    pub paint_transform: CoreAffine,
}

/// Embedded bitmap glyph image.
#[derive(Debug, Clone, PartialEq)]
pub enum BitmapImage {
    /// PNG file bytes.
    Png(Vec<u8>),
    /// Premultiplied BGRA pixels.
    Bgra {
        /// Width in pixels.
        width: u32,
        /// Height in pixels.
        height: u32,
        /// Pixels.
        data: Vec<u8>,
    },
    /// 8-bit alpha mask.
    Mask {
        /// Width in pixels.
        width: u32,
        /// Height in pixels.
        height: u32,
        /// Coverage.
        data: Vec<u8>,
    },
}

/// A bitmap glyph with its placement.
#[derive(Debug, Clone, PartialEq)]
pub struct BitmapGlyphImage {
    /// Image data.
    pub image: BitmapImage,
    /// Destination rectangle in px relative to the glyph origin (y down).
    pub rect: desyn_core::geometry::Rect,
}

fn to_px(size: f64, upem: f64) -> Affine {
    let s = size / upem.max(1.0);
    Affine::new([s, 0.0, 0.0, -s, 0.0, 0.0])
}

fn kurbo_to_core(a: Affine) -> CoreAffine {
    let c = a.as_coeffs();
    CoreAffine::new(c)
}

impl TextEngine {
    /// Glyph outline in font units (y up), cached.
    pub(crate) fn outline_units(
        &mut self,
        instance: InstanceId,
        glyph: u32,
    ) -> Option<Arc<BezPath>> {
        if let Some(hit) = self.outlines.map.get(&(instance, glyph)) {
            return hit.clone();
        }
        let inst = self.db.instance_info(instance)?;
        let coords = inst.coords().to_vec();
        let face = inst.face();
        let path = self.db.font_ref(face).and_then(|font| {
            let outlines = font.outline_glyphs();
            let g = outlines.get(GlyphId::new(glyph))?;
            let mut pen = BezPen(BezPath::new());
            g.draw(
                DrawSettings::unhinted(Size::unscaled(), LocationRef::new(&coords)),
                &mut pen,
            )
            .ok()?;
            Some(Arc::new(pen.0))
        });
        if self.outlines.map.len() >= 65_536 {
            self.outlines.map.clear();
        }
        self.outlines.map.insert((instance, glyph), path.clone());
        path
    }

    /// Glyph outline in px for a font size, relative to the glyph origin (y down).
    pub fn glyph_path(&mut self, instance: InstanceId, glyph: u32, size: f64) -> Option<BezPath> {
        let upem = self.db.instance_info(instance)?.metrics().units_per_em;
        let p = self.outline_units(instance, glyph)?;
        Some(to_px(size, upem) * (*p).clone())
    }

    /// How a glyph is drawn: plain outline, COLR layers or an embedded bitmap.
    pub fn glyph_kind(&self, instance: InstanceId, glyph: u32) -> GlyphKind {
        let Some(inst) = self.db.instance_info(instance) else {
            return GlyphKind::Outline;
        };
        let Some(font) = self.db.font_ref(inst.face()) else {
            return GlyphKind::Outline;
        };
        let gid = GlyphId::new(glyph);
        if font.color_glyphs().get(gid).is_some() {
            return GlyphKind::Color;
        }
        let strikes = font.bitmap_strikes();
        if !strikes.is_empty() && strikes.glyph_for_size(Size::new(64.0), gid).is_some() {
            return GlyphKind::Bitmap;
        }
        GlyphKind::Outline
    }

    /// Every glyph (with synthetic oblique applied), underline, strikethrough and highlight as positioned paths in
    /// paint order: highlights, glyphs, underlines / strikethroughs.
    pub fn text_paths(&mut self, laid: &LaidOutText) -> Vec<TextPath> {
        let mut out = Vec::new();
        let deco = |kind: DecorationKind| match kind {
            DecorationKind::Highlight => TextPathKind::Highlight,
            DecorationKind::Underline => TextPathKind::Underline,
            DecorationKind::Strikethrough => TextPathKind::Strikethrough,
        };
        for d in laid
            .decorations
            .iter()
            .filter(|d| d.kind == DecorationKind::Highlight)
        {
            out.push(TextPath {
                kind: deco(d.kind),
                path: KRect::new(d.rect.x, d.rect.y, d.rect.x + d.rect.w, d.rect.y + d.rect.h)
                    .to_path(0.1),
                span: d.span,
                run: None,
                glyph_index: None,
                glyph: None,
                color_glyph: false,
                color: d.color,
                stroke: 0.0,
            });
        }
        for (ri, run) in laid.runs.iter().enumerate() {
            let Some(upem) = self
                .db
                .instance_info(run.instance)
                .map(|i| i.metrics().units_per_em)
            else {
                continue;
            };
            let s = run.size / upem;
            for (gi, g) in run.glyphs.iter().enumerate() {
                let kind = self.glyph_kind(run.instance, g.id);
                let outline = self
                    .outline_units(run.instance, g.id)
                    .filter(|p| !p.elements().is_empty());
                // Font units (y up) -> px (y down) with skew, then translate to the glyph origin.
                let place = Affine::new([s, 0.0, run.skew * s, -s, g.x, g.y]);
                let layers = if kind == GlyphKind::Color {
                    self.color_glyph(run.instance, g.id, run.size, [0, 0, 0, 255])
                } else {
                    None
                };
                let (path, special) = match (outline, kind, layers) {
                    (_, GlyphKind::Color, Some(layers)) => {
                        // Silhouette: every layer's geometry (nonzero union).
                        let mut sil = BezPath::new();
                        let t = Affine::new([1.0, 0.0, -run.skew, 1.0, g.x, g.y]);
                        for layer in layers {
                            sil.extend((t * layer.path).elements().iter().copied());
                        }
                        (sil, true)
                    }
                    // A bitmap glyph that also has an outline keeps it as its silhouette.
                    (Some(p), kind, _) => (place * (*p).clone(), kind == GlyphKind::Bitmap),
                    (None, GlyphKind::Bitmap, _) => {
                        // Bitmap-only glyphs (CBDT / sbix emoji) have no outline: their image rectangle stands in
                        // so renderers see the glyph and draw `bitmap_glyph` there.
                        let Some(img) = self.bitmap_glyph(run.instance, g.id, run.size) else {
                            continue;
                        };
                        let r = img.rect;
                        let t = Affine::new([1.0, 0.0, -run.skew, 1.0, g.x, g.y]);
                        (
                            t * KRect::new(r.x, r.y, r.x + r.w, r.y + r.h).to_path(0.1),
                            true,
                        )
                    }
                    (None, _, _) => continue,
                };
                if path.elements().is_empty() {
                    continue;
                }
                out.push(TextPath {
                    kind: TextPathKind::Glyph,
                    path,
                    span: run.span,
                    run: Some(ri),
                    glyph_index: Some(gi),
                    glyph: Some(g.id),
                    color_glyph: special,
                    color: run.color,
                    stroke: run.synthetic_bold,
                });
            }
        }
        for d in laid
            .decorations
            .iter()
            .filter(|d| d.kind != DecorationKind::Highlight)
        {
            out.push(TextPath {
                kind: deco(d.kind),
                path: KRect::new(d.rect.x, d.rect.y, d.rect.x + d.rect.w, d.rect.y + d.rect.h)
                    .to_path(0.1),
                span: d.span,
                run: None,
                glyph_index: None,
                glyph: None,
                color_glyph: false,
                color: d.color,
                stroke: 0.0,
            });
        }
        out
    }

    /// All glyphs and line decorations as one path in box coordinates ("convert text to outlines"). Synthetic bold
    /// is baked in by uniting each glyph with its stroke outline.
    pub fn text_outline(&mut self, laid: &LaidOutText) -> BezPath {
        let mut out = BezPath::new();
        for tp in self.text_paths(laid) {
            if tp.kind == TextPathKind::Highlight {
                continue;
            }
            // Bitmap-only glyphs have no geometry to convert (their path is just the image rectangle).
            if tp.color_glyph
                && let (Some(ri), Some(g)) = (tp.run, tp.glyph)
                && let Some(run) = laid.runs.get(ri)
                && self.glyph_kind(run.instance, g) == GlyphKind::Bitmap
                && self
                    .outline_units(run.instance, g)
                    .is_none_or(|p| p.elements().is_empty())
            {
                continue;
            }
            let path = if tp.stroke > 0.0 {
                let style = StrokeStyle {
                    width: tp.stroke,
                    cap: StrokeCap::Round,
                    join: StrokeJoin::Round,
                    miter_limit: 4.0,
                    dash: Vec::new(),
                };
                let stroke = stroke_outline(&tp.path, &style, 0.05);
                boolean(
                    &[
                        Shape {
                            path: tp.path,
                            fill_rule: FillRule::Nonzero,
                        },
                        Shape {
                            path: stroke,
                            fill_rule: FillRule::Nonzero,
                        },
                    ],
                    BoolOp::Union,
                    0.05,
                )
            } else {
                tp.path
            };
            out.extend(path.elements().iter().copied());
        }
        out
    }

    /// [`TextEngine::text_outline`] as SVG-backed path data.
    pub fn text_outline_vector(&mut self, laid: &LaidOutText) -> VectorPath {
        VectorPath::from_bez(&self.text_outline(laid))
    }

    /// Color layers of a COLR glyph at `size` (palette 0; `foreground` replaces the text-color entries).
    pub fn color_glyph(
        &mut self,
        instance: InstanceId,
        glyph: u32,
        size: f64,
        foreground: [u8; 4],
    ) -> Option<Vec<ColorLayer>> {
        let inst = self.db.instance_info(instance)?;
        let coords = inst.coords().to_vec();
        let upem = inst.metrics().units_per_em;
        let font = self.db.font_ref(inst.face())?;
        let cg = font.color_glyphs().get(GlyphId::new(glyph))?;
        let palette: Vec<[u8; 4]> = font
            .color_palettes()
            .get(0)
            .map(|p| {
                p.colors()
                    .iter()
                    .map(|c| [c.red, c.green, c.blue, c.alpha])
                    .collect()
            })
            .unwrap_or_default();
        let mut painter = LayerPainter {
            outlines: font.outline_glyphs(),
            coords: &coords,
            palette,
            foreground,
            to_px: to_px(size, upem),
            transforms: vec![Affine::IDENTITY],
            clips: Vec::new(),
            layers: Vec::new(),
        };
        cg.paint(LocationRef::new(&coords), &mut painter).ok()?;
        Some(painter.layers)
    }

    /// Embedded bitmap of a glyph for `size` (best strike), with its placement.
    pub fn bitmap_glyph(
        &mut self,
        instance: InstanceId,
        glyph: u32,
        size: f64,
    ) -> Option<BitmapGlyphImage> {
        let inst = self.db.instance_info(instance)?;
        let upem = inst.metrics().units_per_em;
        let font = self.db.font_ref(inst.face())?;
        let strikes = font.bitmap_strikes();
        let g = strikes.glyph_for_size(Size::new(size as f32), GlyphId::new(glyph))?;
        let img_scale = size / f64::from(g.ppem_x.max(1.0));
        let unit_scale = size / upem;
        let w = f64::from(g.width) * img_scale;
        let h = f64::from(g.height) * img_scale;
        let (x, y) = match g.placement_origin {
            Origin::TopLeft => (
                f64::from(g.bearing_x) * unit_scale + f64::from(g.inner_bearing_x) * img_scale,
                -(f64::from(g.bearing_y) * unit_scale) - f64::from(g.inner_bearing_y) * img_scale,
            ),
            Origin::BottomLeft => {
                let bottom = -(f64::from(g.bearing_y) * unit_scale
                    + f64::from(g.inner_bearing_y) * img_scale);
                (
                    f64::from(g.bearing_x) * unit_scale + f64::from(g.inner_bearing_x) * img_scale,
                    bottom - h,
                )
            }
        };
        let image = match g.data {
            BitmapData::Png(bytes) => BitmapImage::Png(bytes.to_vec()),
            BitmapData::Bgra(bytes) => BitmapImage::Bgra {
                width: g.width,
                height: g.height,
                data: bytes.to_vec(),
            },
            BitmapData::Mask(mask) => BitmapImage::Mask {
                width: g.width,
                height: g.height,
                data: mask.decode(g.width, g.height).ok()?,
            },
        };
        Some(BitmapGlyphImage {
            image,
            rect: desyn_core::geometry::Rect { x, y, w, h },
        })
    }
}

struct LayerPainter<'a> {
    outlines: skrifa::outline::OutlineGlyphCollection<'a>,
    coords: &'a [skrifa::instance::NormalizedCoord],
    palette: Vec<[u8; 4]>,
    foreground: [u8; 4],
    to_px: Affine,
    transforms: Vec<Affine>,
    /// Clip geometry in font units, already transformed.
    clips: Vec<BezPath>,
    layers: Vec<ColorLayer>,
}

fn color_transform(t: Transform) -> Affine {
    Affine::new([
        f64::from(t.xx),
        f64::from(t.yx),
        f64::from(t.xy),
        f64::from(t.yy),
        f64::from(t.dx),
        f64::from(t.dy),
    ])
}

fn extend(e: Extend) -> GradientExtend {
    match e {
        Extend::Repeat => GradientExtend::Repeat,
        Extend::Reflect => GradientExtend::Reflect,
        _ => GradientExtend::Pad,
    }
}

impl LayerPainter<'_> {
    fn color(&self, palette_index: u16, alpha: f32) -> [u8; 4] {
        let mut c = if palette_index == 0xFFFF {
            self.foreground
        } else {
            self.palette
                .get(usize::from(palette_index))
                .copied()
                .unwrap_or(self.foreground)
        };
        c[3] = (f32::from(c[3]) * alpha.clamp(0.0, 1.0)).round() as u8;
        c
    }

    fn stops(&self, stops: &[ColorStop]) -> Vec<GradientStop> {
        stops
            .iter()
            .map(|s| GradientStop {
                offset: s.offset,
                color: self.color(s.palette_index, s.alpha),
            })
            .collect()
    }

    fn current(&self) -> Affine {
        *self.transforms.last().unwrap_or(&Affine::IDENTITY)
    }
}

impl ColorPainter for LayerPainter<'_> {
    fn push_transform(&mut self, transform: Transform) {
        let t = self.current() * color_transform(transform);
        self.transforms.push(t);
    }

    fn pop_transform(&mut self) {
        if self.transforms.len() > 1 {
            self.transforms.pop();
        }
    }

    fn push_clip_glyph(&mut self, glyph_id: GlyphId) {
        let mut pen = BezPen(BezPath::new());
        if let Some(g) = self.outlines.get(glyph_id) {
            let _ = g.draw(
                DrawSettings::unhinted(Size::unscaled(), LocationRef::new(self.coords)),
                &mut pen,
            );
        }
        let path = self.current() * pen.0;
        self.clips.push(path);
    }

    fn push_clip_box(&mut self, clip_box: BoundingBox<f32>) {
        let r = KRect::new(
            f64::from(clip_box.x_min),
            f64::from(clip_box.y_min),
            f64::from(clip_box.x_max),
            f64::from(clip_box.y_max),
        );
        let path = self.current() * r.to_path(0.1);
        self.clips.push(path);
    }

    fn pop_clip(&mut self) {
        self.clips.pop();
    }

    fn fill(&mut self, brush: Brush<'_>) {
        // The innermost glyph clip is the painted shape (outer clip boxes only bound it).
        let Some(clip) = self.clips.iter().rev().find(|c| !c.elements().is_empty()) else {
            return;
        };
        let path = self.to_px * clip.clone();
        let paint_transform = kurbo_to_core(self.to_px * self.current());
        let pt = |p: skrifa::raw::types::Point<f32>| (f64::from(p.x), f64::from(p.y));
        let paint = match brush {
            Brush::Solid {
                palette_index,
                alpha,
            } => ColorPaint::Solid {
                color: self.color(palette_index, alpha),
            },
            Brush::LinearGradient {
                p0,
                p1,
                color_stops,
                extend: e,
            } => ColorPaint::Linear {
                p0: pt(p0),
                p1: pt(p1),
                stops: self.stops(color_stops),
                extend: extend(e),
            },
            Brush::RadialGradient {
                c0,
                r0,
                c1,
                r1,
                color_stops,
                extend: e,
            } => ColorPaint::Radial {
                c0: pt(c0),
                r0: f64::from(r0),
                c1: pt(c1),
                r1: f64::from(r1),
                stops: self.stops(color_stops),
                extend: extend(e),
            },
            Brush::SweepGradient {
                c0,
                start_angle,
                end_angle,
                color_stops,
                extend: e,
            } => ColorPaint::Sweep {
                center: pt(c0),
                start_angle: f64::from(start_angle),
                end_angle: f64::from(end_angle),
                stops: self.stops(color_stops),
                extend: extend(e),
            },
        };
        self.layers.push(ColorLayer {
            path,
            paint,
            paint_transform,
        });
    }

    fn push_layer(&mut self, _composite_mode: CompositeMode) {
        // Layers are composited source-over; COLRv1 blend modes are rare in emoji fonts.
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use desyn_core::paths::kurbo::Point;

    #[test]
    fn px_transform_flips_y() {
        let t = to_px(100.0, 1000.0);
        let p = t * Point::new(500.0, 700.0);
        assert!((p.x - 50.0).abs() < 1e-9 && (p.y + 70.0).abs() < 1e-9);
    }
}
