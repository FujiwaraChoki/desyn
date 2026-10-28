//! Image nodes, image fills and video poster frames: fit modes (fill / fit / crop / tile / stretch), adjustments,
//! vignette and grain overlays, alpha mattes, clip shapes and strokes.

use std::sync::{Arc, OnceLock};

use desyn_core::geometry::{Affine, Point, Rect};
use desyn_core::model::{
    BlendMode, Crop, ImageFill, ImageFillMode, ImageFit, ImageNode, Node, VideoFit, VideoNode,
};
use desyn_core::paths::kurbo::{self, Shape as _};

use super::build::DisplayListBuilder;
use super::{FillItem, FillRule, ImageItem, Item, Layer, LayerKind, LayerMask, MaskKind};
use crate::assets::{Adjustments, RasterImage};
use crate::geom::{bez_to_path, path_bounds};
use crate::paint::{Color4, GradientStop, ImageExtend, ImagePaint, Paint, Quality, Spread};

/// How an image maps into a `w x h` box.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Fit<'a> {
    /// Cover, centered.
    Fill,
    /// Contain, centered.
    Fit,
    /// Normalized source rectangle (+ zoom) covering the box.
    Crop(Option<&'a Crop>),
    /// Natural size, repeated (`scale` multiplies the tile size).
    Tile(f64),
    /// Stretched to the box.
    Stretch,
}

/// Image pixel space -> box space, and whether the image repeats.
///
/// The pattern extension (repeat / clamp / transparent) follows from the result and the box.
pub fn placement(
    fit: Fit<'_>,
    iw: f64,
    ih: f64,
    natural: (f64, f64),
    w: f64,
    h: f64,
) -> (Affine, bool) {
    let iw = iw.max(1.0);
    let ih = ih.max(1.0);
    let centered =
        |s: f64| Affine::translate((w - iw * s) / 2.0, (h - ih * s) / 2.0) * Affine::scale(s, s);
    match fit {
        Fit::Fill => (centered((w / iw).max(h / ih)), false),
        Fit::Fit => (centered((w / iw).min(h / ih)), false),
        Fit::Stretch => (Affine::scale(w / iw, h / ih), false),
        Fit::Tile(scale) => {
            let scale = if scale.is_finite() && scale > 0.0 {
                scale
            } else {
                1.0
            };
            let (nw, nh) = natural;
            (Affine::scale(nw / iw * scale, nh / ih * scale), true)
        }
        Fit::Crop(crop) => {
            let Some(c) =
                crop.filter(|c| c.w.is_finite() && c.h.is_finite() && c.w > 0.0 && c.h > 0.0)
            else {
                return (centered((w / iw).max(h / ih)), false);
            };
            let (sx, sy, sw, sh) = (
                c.x.clamp(0.0, 1.0) * iw,
                c.y.clamp(0.0, 1.0) * ih,
                c.w.min(1.0) * iw,
                c.h.min(1.0) * ih,
            );
            let zoom = c
                .zoom
                .filter(|z| z.is_finite() && *z > 0.0)
                .unwrap_or(1.0)
                .clamp(0.01, 100.0);
            let s = (w / sw).max(h / sh) * zoom;
            let t = Affine::translate(w / 2.0, h / 2.0)
                * Affine::scale(s, s)
                * Affine::translate(-(sx + sw / 2.0), -(sy + sh / 2.0));
            (t, false)
        }
    }
}

/// Extension of an image placed by `t` in a `w x h` box: tiles repeat; pictures covering the box clamp their
/// edges; anything else is transparent outside the image.
pub(super) fn extend_for(
    repeat: bool,
    t: &Affine,
    iw: f64,
    ih: f64,
    w: f64,
    h: f64,
) -> ImageExtend {
    if repeat {
        return ImageExtend::Repeat;
    }
    let r = t.transform_rect_bbox(&Rect::new(0.0, 0.0, iw, ih));
    let aligned = t.b.abs() < 1e-9 && t.c.abs() < 1e-9;
    if aligned && r.x <= 1e-6 && r.y <= 1e-6 && r.right() >= w - 1e-6 && r.bottom() >= h - 1e-6 {
        ImageExtend::Clamp
    } else {
        ImageExtend::Transparent
    }
}

/// 128 x 128 monochrome grain tile (alpha noise around mid gray), generated once.
fn grain_tile() -> Arc<RasterImage> {
    static TILE: OnceLock<Arc<RasterImage>> = OnceLock::new();
    TILE.get_or_init(|| {
        let n = 128u32;
        let mut px = Vec::with_capacity((n * n * 4) as usize);
        let mut s: u64 = 0x9e37_79b9_7f4a_7c15;
        for _ in 0..n * n {
            s ^= s << 13;
            s ^= s >> 7;
            s ^= s << 17;
            let v = (s >> 32) as u32;
            let g = if v & 1 == 0 { 0u8 } else { 255u8 };
            let a = ((v >> 8) % 256) as u8;
            px.extend_from_slice(&[g, g, g, a]);
        }
        Arc::new(RasterImage::from_rgba8(n, n, px).expect("valid tile"))
    })
    .clone()
}

/// Vignette (radial darkening, or lightening for negative amounts) and grain overlays for a `w x h` box.
/// An overlay paint drawn with the shape of an image: paint, opacity, blend mode.
pub(super) type Overlay = (Paint, f32, BlendMode);

pub(super) fn overlays(
    adj: &Adjustments,
    w: f64,
    h: f64,
    raster_scale: f64,
) -> Vec<(Paint, f32, BlendMode)> {
    let mut out = Vec::new();
    if adj.vignette.abs() > 1e-3 {
        let c = if adj.vignette > 0.0 {
            Color4::BLACK
        } else {
            Color4::WHITE
        };
        let a = (adj.vignette.abs() * 0.85) as f32;
        let k = std::f64::consts::SQRT_2 / 2.0;
        out.push((
            Paint::Radial {
                c0: Point::ZERO,
                r0: 0.0,
                c1: Point::ZERO,
                r1: 1.0,
                stops: vec![
                    GradientStop {
                        pos: 0.0,
                        color: c.with_alpha_mul(0.0),
                    },
                    GradientStop {
                        pos: 0.5,
                        color: c.with_alpha_mul(0.0),
                    },
                    GradientStop {
                        pos: 1.0,
                        color: c.with_alpha_mul(a),
                    },
                ],
                spread: Spread::Pad,
                transform: Affine::translate(w / 2.0, h / 2.0) * Affine::scale(w * k, h * k),
            },
            1.0,
            BlendMode::Normal,
        ));
    }
    if adj.grain > 1e-3 {
        let s = 1.0 / raster_scale.max(0.25);
        out.push((
            Paint::Image(ImagePaint {
                image: grain_tile(),
                transform: Affine::scale(s, s),
                extend: ImageExtend::Repeat,
                quality: Quality::Nearest,
            }),
            (adj.grain * 0.55) as f32,
            BlendMode::Overlay,
        ));
    }
    out
}

impl DisplayListBuilder<'_> {
    fn natural_size(&self, asset_id: &str, img: &RasterImage) -> (f64, f64) {
        let a = self.design.assets.get(asset_id);
        let w = a
            .and_then(|a| a.width)
            .filter(|v| v.is_finite() && *v > 0.0);
        let h = a
            .and_then(|a| a.height)
            .filter(|v| v.is_finite() && *v > 0.0);
        (
            w.unwrap_or(f64::from(img.width())),
            h.unwrap_or(f64::from(img.height())),
        )
    }

    /// Paint of an image fill over a `w x h` box plus its overlays.
    pub(super) fn image_fill_paint(
        &mut self,
        f: &ImageFill,
        w: f64,
        h: f64,
    ) -> Option<(Paint, Vec<Overlay>)> {
        let img = self.image_asset(&f.asset_id)?;
        let natural = self.natural_size(&f.asset_id, &img);
        let fit = match f.mode {
            ImageFillMode::Fill => Fit::Fill,
            ImageFillMode::Fit => Fit::Fit,
            ImageFillMode::Stretch => Fit::Stretch,
            ImageFillMode::Tile => Fit::Tile(f.scale.unwrap_or(1.0)),
        };
        let (iw, ih) = (f64::from(img.width()), f64::from(img.height()));
        let (mut t, repeat) = placement(fit, iw, ih, natural, w, h);
        if f.mode != ImageFillMode::Tile
            && let Some(s) = f
                .scale
                .filter(|s| s.is_finite() && *s > 0.0 && (*s - 1.0).abs() > 1e-9)
        {
            t = Affine::translate(w / 2.0, h / 2.0)
                * Affine::scale(s, s)
                * Affine::translate(-w / 2.0, -h / 2.0)
                * t;
        }
        let ox = f.offset_x.filter(|v| v.is_finite()).unwrap_or(0.0) * w;
        let oy = f.offset_y.filter(|v| v.is_finite()).unwrap_or(0.0) * h;
        let rot = f.rotation.filter(|v| v.is_finite()).unwrap_or(0.0);
        if rot != 0.0 {
            t = Affine::rotate_about(rot, Point::new(w / 2.0, h / 2.0)) * t;
        }
        t = Affine::translate(ox, oy) * t;
        let adj = f
            .adjust
            .as_deref()
            .map(Adjustments::from_patch)
            .unwrap_or_default();
        let scale = crate::geom::mean_scale(&t);
        let img = self
            .assets
            .adjusted(&img, &adj, adj.blur / scale.max(1e-6), None);
        let paint = Paint::Image(ImagePaint {
            image: img,
            transform: t,
            extend: extend_for(repeat, &t, iw, ih, w, h),
            quality: Quality::Bicubic,
        });
        Some((paint, overlays(&adj, w, h, self.opts.raster_scale)))
    }

    /// Image node: clip shape filled with the image pattern, overlays, matte and strokes.
    pub(super) fn image_node_items(&mut self, n: &ImageNode) -> Vec<Item> {
        let node = Node::Image(n.clone());
        let (w, h) = (n.base.width.max(0.0), n.base.height.max(0.0));
        let Some(shape) = self.node_shape(&node) else {
            return Vec::new();
        };
        let mut out = Vec::new();
        if let Some(img) = self.image_asset(&n.asset_id) {
            let natural = self.natural_size(&n.asset_id, &img);
            let fit = match n.fit {
                ImageFit::Fill => Fit::Fill,
                ImageFit::Fit => Fit::Fit,
                ImageFit::Crop => Fit::Crop(n.crop.as_ref()),
                ImageFit::Tile => Fit::Tile(1.0),
            };
            let (iw, ih) = (f64::from(img.width()), f64::from(img.height()));
            let (t, repeat) = placement(fit, iw, ih, natural, w, h);
            let adj = n
                .adjust
                .as_ref()
                .map(Adjustments::from_model)
                .unwrap_or_default();
            let scale = crate::geom::mean_scale(&t);
            // When the picture covers its box, vignette and grain are baked into the pixels.
            let covers = matches!(n.fit, ImageFit::Fill | ImageFit::Crop);
            let baked = (covers && (adj.vignette != 0.0 || adj.grain != 0.0)).then(|| {
                crate::assets::BoxOverlay {
                    to_box: t,
                    w,
                    h,
                    vignette: adj.vignette,
                    grain: adj.grain,
                    grain_cell: 1.0 / (scale * self.opts.raster_scale).max(1e-6),
                }
            });
            let img = self
                .assets
                .adjusted(&img, &adj, adj.blur / scale.max(1e-6), baked.as_ref());
            let bounds = shape.bounds();
            let mut fills = vec![Item::Fill(FillItem {
                path: shape.path.clone(),
                rule: shape.rule,
                paint: Paint::Image(ImagePaint {
                    image: img,
                    transform: t,
                    extend: extend_for(repeat, &t, iw, ih, w, h),
                    quality: Quality::Bicubic,
                }),
                opacity: 1.0,
                blend: BlendMode::Normal,
                bounds,
            })];
            let extra = if baked.is_some() {
                Vec::new()
            } else {
                overlays(&adj, w, h, self.opts.raster_scale)
            };
            for (paint, opacity, blend) in extra {
                fills.push(Item::Fill(FillItem {
                    path: shape.path.clone(),
                    rule: shape.rule,
                    paint,
                    opacity,
                    blend,
                    bounds,
                }));
            }
            let matte = n.mask_asset_id.as_deref().and_then(|m| self.image_asset(m));
            match matte {
                Some(matte) => {
                    let (mw, mh) = (f64::from(matte.width()), f64::from(matte.height()));
                    let mt = t * Affine::scale(iw / mw.max(1.0), ih / mh.max(1.0));
                    let mask_item = Item::Image(ImageItem {
                        bounds: mt.transform_rect_bbox(&Rect::new(0.0, 0.0, mw, mh)),
                        image: matte,
                        transform: mt,
                        opacity: 1.0,
                        blend: BlendMode::Normal,
                        quality: Quality::Bicubic,
                    });
                    let mask_layer = self.group(Affine::IDENTITY, vec![mask_item], 0x6d61_7474);
                    let mut g = Layer::new(LayerKind::Group, None, Affine::IDENTITY);
                    g.items = fills;
                    g.mask = Some(Box::new(LayerMask {
                        layer: mask_layer,
                        kind: MaskKind::Alpha,
                    }));
                    g.update_bounds();
                    g.key = self.group_key(&g, crate::hash::combine(self.cur_key, 0x6d61_736b));
                    out.push(Item::Layer(Box::new(g)));
                }
                None => out.extend(fills),
            }
        }
        out.extend(self.stroke_items(&shape, &n.strokes, w, h));
        out
    }

    /// Video node: its poster frame (or a neutral frame with a play badge when no poster exists).
    pub(super) fn video_node_items(&mut self, v: &VideoNode) -> Vec<Item> {
        let node = Node::Video(v.clone());
        let (w, h) = (v.base.width.max(0.0), v.base.height.max(0.0));
        let Some(shape) = self.node_shape(&node) else {
            return Vec::new();
        };
        let bounds = shape.bounds();
        let poster = v
            .poster_asset_id
            .as_deref()
            .and_then(|p| self.image_asset(p));
        if let Some(img) = poster {
            let fit = match v.fit {
                VideoFit::Fill | VideoFit::Crop => Fit::Fill,
                VideoFit::Fit => Fit::Fit,
            };
            let (iw, ih) = (f64::from(img.width()), f64::from(img.height()));
            let (t, repeat) = placement(fit, iw, ih, (iw, ih), w, h);
            return vec![Item::Fill(FillItem {
                path: shape.path.clone(),
                rule: shape.rule,
                paint: Paint::Image(ImagePaint {
                    image: img,
                    transform: t,
                    extend: extend_for(repeat, &t, iw, ih, w, h),
                    quality: Quality::Bicubic,
                }),
                opacity: 1.0,
                blend: BlendMode::Normal,
                bounds,
            })];
        }
        let mut out = vec![Item::Fill(FillItem {
            path: shape.path.clone(),
            rule: shape.rule,
            paint: Paint::Solid(Color4::parse_hex("#141416").expect("valid hex")),
            opacity: 1.0,
            blend: BlendMode::Normal,
            bounds,
        })];
        // Play badge: a translucent disc with a triangle, sized to the frame.
        let d = (w.min(h) * 0.22).clamp(16.0, 120.0);
        if d < w && d < h {
            let (cx, cy) = (w / 2.0, h / 2.0);
            let disc = kurbo::Circle::new((cx, cy), d / 2.0).to_path(0.05);
            let mut tri = kurbo::BezPath::new();
            let r = d * 0.22;
            tri.move_to((cx - r * 0.7, cy - r));
            tri.line_to((cx + r, cy));
            tri.line_to((cx - r * 0.7, cy + r));
            tri.close_path();
            for (p, c) in [(disc, "#ffffffe6"), (tri, "#141416")] {
                if let Some(p) = bez_to_path(&p) {
                    out.push(Item::Fill(FillItem {
                        bounds: path_bounds(&p),
                        path: Arc::new(p),
                        rule: FillRule::Nonzero,
                        paint: Paint::Solid(Color4::parse_hex(c).expect("valid hex")),
                        opacity: 1.0,
                        blend: BlendMode::Normal,
                    }));
                }
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fit_modes() {
        // 200 x 100 image into a 100 x 100 box.
        let (t, _) = placement(Fit::Fill, 200.0, 100.0, (200.0, 100.0), 100.0, 100.0);
        assert_eq!(t.apply(Point::new(0.0, 0.0)), Point::new(-50.0, 0.0));
        let (t, _) = placement(Fit::Fit, 200.0, 100.0, (200.0, 100.0), 100.0, 100.0);
        assert_eq!(t.apply(Point::new(200.0, 100.0)), Point::new(100.0, 75.0));
        let crop: Crop =
            serde_json::from_value(serde_json::json!({"x": 0.5, "y": 0, "w": 0.5, "h": 1}))
                .unwrap();
        let (t, _) = placement(
            Fit::Crop(Some(&crop)),
            200.0,
            100.0,
            (200.0, 100.0),
            100.0,
            100.0,
        );
        assert_eq!(t.apply(Point::new(100.0, 0.0)), Point::new(0.0, 0.0));
        assert_eq!(t.apply(Point::new(200.0, 100.0)), Point::new(100.0, 100.0));
        let (t, rep) = placement(Fit::Tile(2.0), 10.0, 10.0, (20.0, 20.0), 100.0, 100.0);
        assert!(rep);
        assert_eq!(t.apply(Point::new(10.0, 10.0)), Point::new(40.0, 40.0));
        assert_eq!(grain_tile().width(), 128);
    }
}
