//! Image adjustments (`ImageAdjust` / image-fill `adjust`), named filter presets and their pixel pipeline.
//!
//! Per-pixel operations run in this order on straight-alpha sRGB values: exposure, brightness, contrast,
//! highlights / shadows, temperature / tint, saturation, hue, grayscale, sepia, duotone. Neighbourhood operations
//! (blur, then sharpen as an unsharp mask) follow. Vignette and grain depend on the node box, not on the image,
//! and are drawn as overlays by the display-list builder.

use desyn_core::model::{Color, ImageAdjust, ImageAdjustPatch};
use serde_json::{Map, Value};
use tiny_skia::Pixmap;

use super::image::{RasterImage, demultiply, premultiply};
use crate::paint::Color4;
use crate::raster::blur::{Edge, blur_rgba};

/// Fully resolved adjustments (preset merged in). Every value is 0 when neutral.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Adjustments {
    /// -1..1 midtone brightness.
    pub brightness: f64,
    /// -1..1 contrast.
    pub contrast: f64,
    /// -1..1 saturation (-1 = grayscale).
    pub saturation: f64,
    /// Hue rotation in degrees.
    pub hue: f64,
    /// -1..1 (cool .. warm).
    pub temperature: f64,
    /// -1..1 (green .. magenta).
    pub tint: f64,
    /// -1..1 exposure (+-1.5 stops).
    pub exposure: f64,
    /// -1..1 highlight recovery / boost (extension key `highlights`).
    pub highlights: f64,
    /// -1..1 shadow lift / crush (extension key `shadows`).
    pub shadows: f64,
    /// 0..1 edge darkening (overlay).
    pub vignette: f64,
    /// Blur radius in node px.
    pub blur: f64,
    /// 0..1.
    pub grayscale: f64,
    /// 0..1.
    pub sepia: f64,
    /// 0..1 unsharp-mask amount.
    pub sharpen: f64,
    /// 0..1 film grain (overlay).
    pub grain: f64,
    /// Shadows / highlights colors.
    pub duotone: Option<[Color4; 2]>,
}

/// Named filter presets (`ImageAdjust.filter`). Preset values add to the explicit values.
pub const FILTER_PRESETS: &[&str] = &[
    "vivid", "warm", "cool", "mono", "noir", "vintage", "fade", "dramatic", "film", "sunset",
    "matte", "chrome", "lush", "dusk",
];

fn preset(name: &str) -> Option<Adjustments> {
    let a = Adjustments::default();
    Some(match name {
        "vivid" => Adjustments {
            saturation: 0.35,
            contrast: 0.15,
            ..a
        },
        "warm" => Adjustments {
            temperature: 0.35,
            saturation: 0.1,
            ..a
        },
        "cool" => Adjustments {
            temperature: -0.35,
            tint: -0.05,
            ..a
        },
        "mono" => Adjustments {
            grayscale: 1.0,
            contrast: 0.1,
            ..a
        },
        "noir" => Adjustments {
            grayscale: 1.0,
            contrast: 0.45,
            brightness: -0.1,
            vignette: 0.3,
            ..a
        },
        "vintage" => Adjustments {
            sepia: 0.45,
            contrast: -0.1,
            saturation: -0.2,
            vignette: 0.35,
            grain: 0.15,
            ..a
        },
        "fade" => Adjustments {
            contrast: -0.3,
            brightness: 0.1,
            saturation: -0.15,
            shadows: 0.25,
            ..a
        },
        "dramatic" => Adjustments {
            contrast: 0.4,
            saturation: -0.1,
            highlights: -0.2,
            vignette: 0.3,
            ..a
        },
        "film" => Adjustments {
            contrast: 0.1,
            saturation: -0.1,
            temperature: 0.1,
            grain: 0.25,
            ..a
        },
        "sunset" => Adjustments {
            temperature: 0.45,
            tint: 0.15,
            saturation: 0.2,
            ..a
        },
        "matte" => Adjustments {
            contrast: -0.2,
            brightness: 0.05,
            shadows: 0.35,
            ..a
        },
        "chrome" => Adjustments {
            contrast: 0.2,
            saturation: 0.2,
            exposure: 0.1,
            ..a
        },
        "lush" => Adjustments {
            saturation: 0.25,
            tint: -0.15,
            shadows: 0.1,
            ..a
        },
        "dusk" => Adjustments {
            temperature: -0.2,
            tint: 0.2,
            brightness: -0.1,
            vignette: 0.2,
            ..a
        },
        _ => return None,
    })
}

fn extra_f64(extra: &Map<String, Value>, key: &str) -> f64 {
    extra
        .get(key)
        .and_then(Value::as_f64)
        .filter(|v| v.is_finite())
        .unwrap_or(0.0)
}

fn fin(v: f64) -> f64 {
    if v.is_finite() { v } else { 0.0 }
}

fn duo(d: &Option<[Color; 2]>) -> Option<[Color4; 2]> {
    d.as_ref()
        .map(|[a, b]| [Color4::from_color(a), Color4::from_color(b)])
}

impl Adjustments {
    /// From a node's `adjust`.
    pub fn from_model(a: &ImageAdjust) -> Self {
        let base = Adjustments {
            brightness: fin(a.brightness),
            contrast: fin(a.contrast),
            saturation: fin(a.saturation),
            hue: fin(a.hue),
            temperature: fin(a.temperature),
            tint: fin(a.tint),
            exposure: fin(a.exposure),
            highlights: extra_f64(&a.extra, "highlights"),
            shadows: extra_f64(&a.extra, "shadows"),
            vignette: fin(a.vignette),
            blur: fin(a.blur),
            grayscale: fin(a.grayscale),
            sepia: fin(a.sepia),
            sharpen: fin(a.sharpen),
            grain: fin(a.grain),
            duotone: duo(&a.duotone),
        };
        base.with_preset(a.filter.as_deref())
    }

    /// From an image fill's partial `adjust`.
    pub fn from_patch(p: &ImageAdjustPatch) -> Self {
        let g = |v: Option<f64>| fin(v.unwrap_or(0.0));
        let base = Adjustments {
            brightness: g(p.brightness),
            contrast: g(p.contrast),
            saturation: g(p.saturation),
            hue: g(p.hue),
            temperature: g(p.temperature),
            tint: g(p.tint),
            exposure: g(p.exposure),
            highlights: extra_f64(&p.extra, "highlights"),
            shadows: extra_f64(&p.extra, "shadows"),
            vignette: g(p.vignette),
            blur: g(p.blur),
            grayscale: g(p.grayscale),
            sepia: g(p.sepia),
            sharpen: g(p.sharpen),
            grain: g(p.grain),
            duotone: duo(&p.duotone),
        };
        base.with_preset(p.filter.as_deref())
    }

    fn with_preset(mut self, filter: Option<&str>) -> Self {
        if let Some(p) = filter.and_then(|f| preset(f.trim())) {
            self.brightness += p.brightness;
            self.contrast += p.contrast;
            self.saturation += p.saturation;
            self.hue += p.hue;
            self.temperature += p.temperature;
            self.tint += p.tint;
            self.exposure += p.exposure;
            self.highlights += p.highlights;
            self.shadows += p.shadows;
            self.vignette += p.vignette;
            self.blur += p.blur;
            self.grayscale += p.grayscale;
            self.sepia += p.sepia;
            self.sharpen += p.sharpen;
            self.grain += p.grain;
        }
        self.brightness = self.brightness.clamp(-1.0, 1.0);
        self.contrast = self.contrast.clamp(-1.0, 1.0);
        self.saturation = self.saturation.clamp(-1.0, 1.0);
        self.hue = self.hue.clamp(-360.0, 360.0);
        self.temperature = self.temperature.clamp(-1.0, 1.0);
        self.tint = self.tint.clamp(-1.0, 1.0);
        self.exposure = self.exposure.clamp(-1.0, 1.0);
        self.highlights = self.highlights.clamp(-1.0, 1.0);
        self.shadows = self.shadows.clamp(-1.0, 1.0);
        self.vignette = self.vignette.clamp(-1.0, 1.0);
        self.blur = self.blur.clamp(0.0, 500.0);
        self.grayscale = self.grayscale.clamp(0.0, 1.0);
        self.sepia = self.sepia.clamp(0.0, 1.0);
        self.sharpen = self.sharpen.clamp(0.0, 1.0);
        self.grain = self.grain.clamp(0.0, 1.0);
        self
    }

    /// True when the per-pixel / neighbourhood pipeline changes nothing.
    pub fn is_pixel_identity(&self) -> bool {
        self.brightness == 0.0
            && self.contrast == 0.0
            && self.saturation == 0.0
            && self.hue == 0.0
            && self.temperature == 0.0
            && self.tint == 0.0
            && self.exposure == 0.0
            && self.highlights == 0.0
            && self.shadows == 0.0
            && self.blur <= 0.0
            && self.grayscale == 0.0
            && self.sepia == 0.0
            && self.sharpen == 0.0
            && self.duotone.is_none()
    }

    /// Stable key of the pixel-affecting part (`blur_px` = blur in image pixels).
    pub fn pixel_key(&self, blur_px: f64) -> u64 {
        let mut h = crate::hash::StableHasher::new();
        for v in [
            self.brightness,
            self.contrast,
            self.saturation,
            self.hue,
            self.temperature,
            self.tint,
            self.exposure,
            self.highlights,
            self.shadows,
            (blur_px * 4.0).round() / 4.0,
            self.grayscale,
            self.sepia,
            self.sharpen,
        ] {
            h.write_f64(v);
        }
        if let Some([a, b]) = self.duotone {
            for c in [a, b] {
                for v in c.to_rgba8() {
                    h.write_f64(f64::from(v));
                }
            }
        }
        std::hash::Hasher::finish(&h)
    }
}

/// Box-space overlays (vignette, grain) baked into the pixels of an image node whose picture covers its box,
/// so the frame draws one image instead of extra full-size gradient / noise passes.
#[derive(Debug, Clone, PartialEq)]
pub struct BoxOverlay {
    /// Image pixel space to box space.
    pub to_box: desyn_core::geometry::Affine,
    /// Box width.
    pub w: f64,
    /// Box height.
    pub h: f64,
    /// Vignette amount (-1..1; negative lightens).
    pub vignette: f64,
    /// Grain amount 0..1.
    pub grain: f64,
    /// Grain cell size in image pixels.
    pub grain_cell: f64,
}

impl BoxOverlay {
    /// Cache key.
    pub fn key(&self) -> u64 {
        let mut h = crate::hash::StableHasher::new();
        for v in self.to_box.as_coeffs() {
            h.write_f64((v * 1e4).round() / 1e4);
        }
        for v in [self.w, self.h, self.vignette, self.grain, self.grain_cell] {
            h.write_f64((v * 1e4).round() / 1e4);
        }
        std::hash::Hasher::finish(&h)
    }

    /// Applies the overlays to premultiplied RGBA8 pixels (`width` x `height` image pixels).
    pub fn apply(&self, data: &mut [u8], width: usize, height: usize) {
        let k = std::f64::consts::SQRT_2 / 2.0;
        let (rw, rh) = ((self.w * k).max(1e-6), (self.h * k).max(1e-6));
        let (cx, cy) = (self.w / 2.0, self.h / 2.0);
        let vig = self.vignette.clamp(-1.0, 1.0);
        let grain = (self.grain.clamp(0.0, 1.0) * 0.22 * 255.0) as f32;
        let cell = self.grain_cell.max(1.0);
        let t = self.to_box;
        // `f32::round` is a libm call on baseline x86-64: round non-negative values by truncating `v + 0.5`.
        let to_u8 = |v: f32| (v + 0.5) as u8;
        for y in 0..height {
            // Box position of pixel centers, advanced incrementally along the row.
            let yc = y as f64 + 0.5;
            let mut px = t.a * 0.5 + t.c * yc + t.e;
            let mut py = t.b * 0.5 + t.d * yc + t.f;
            for x in 0..width {
                let (bx, by) = (px, py);
                px += t.a;
                py += t.b;
                let i = (y * width + x) * 4;
                let a = data[i + 3];
                if a == 0 {
                    continue;
                }
                let af = f32::from(a);
                if vig != 0.0 {
                    let dx = (bx - cx) / rw;
                    let dy = (by - cy) / rh;
                    let d2 = dx * dx + dy * dy;
                    if d2 > 0.25 {
                        let d = d2.sqrt();
                        let m = (((d - 0.5) / 0.5).clamp(0.0, 1.0) * vig.abs() * 0.85) as f32;
                        for c in 0..3 {
                            let v = f32::from(data[i + c]);
                            data[i + c] = to_u8(if vig > 0.0 {
                                v * (1.0 - m)
                            } else {
                                v + (af - v) * m
                            });
                        }
                    }
                }
                if grain > 0.0 {
                    let gx = (x as f64 / cell) as u64;
                    let gy = (y as f64 / cell) as u64;
                    let mut z = gx.wrapping_mul(0x9e37_79b9_7f4a_7c15)
                        ^ gy.wrapping_mul(0xc2b2_ae3d_27d4_eb4f);
                    z = (z ^ (z >> 29)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
                    let n = ((z >> 40) as f32 / (1u64 << 24) as f32) * 2.0 - 1.0;
                    let delta = n * grain * (af / 255.0);
                    for c in 0..3 {
                        data[i + c] = to_u8((f32::from(data[i + c]) + delta).clamp(0.0, af));
                    }
                }
            }
        }
    }
}

const LUMA: [f32; 3] = [0.2126, 0.7152, 0.0722];

fn luma(r: f32, g: f32, b: f32) -> f32 {
    r * LUMA[0] + g * LUMA[1] + b * LUMA[2]
}

/// Per-pixel color transform on straight-alpha floats (0..1).
fn adjust_pixel(adj: &Adjustments, pre: &Precomputed, c: [f32; 3]) -> [f32; 3] {
    let [mut r, mut g, mut b] = c;
    if adj.exposure != 0.0 {
        let k = pre.exposure;
        r *= k;
        g *= k;
        b *= k;
    }
    if adj.brightness != 0.0 {
        let e = pre.brightness_exp;
        r = r.max(0.0).powf(e);
        g = g.max(0.0).powf(e);
        b = b.max(0.0).powf(e);
    }
    if adj.contrast != 0.0 {
        let k = pre.contrast;
        r = (r - 0.5) * k + 0.5;
        g = (g - 0.5) * k + 0.5;
        b = (b - 0.5) * k + 0.5;
    }
    if adj.highlights != 0.0 || adj.shadows != 0.0 {
        let l = luma(r, g, b).clamp(0.0, 1.0);
        let wh = l * l;
        let ws = (1.0 - l) * (1.0 - l);
        let d = 0.35 * (adj.highlights as f32 * wh + adj.shadows as f32 * ws);
        r += d;
        g += d;
        b += d;
    }
    if adj.temperature != 0.0 || adj.tint != 0.0 {
        let t = adj.temperature as f32;
        let ti = adj.tint as f32;
        r *= 1.0 + 0.18 * t + 0.06 * ti;
        b *= 1.0 - 0.18 * t + 0.06 * ti;
        g *= 1.0 - 0.12 * ti;
    }
    if adj.saturation != 0.0 {
        let l = luma(r, g, b);
        let k = 1.0 + adj.saturation as f32;
        r = l + (r - l) * k;
        g = l + (g - l) * k;
        b = l + (b - l) * k;
    }
    if adj.hue != 0.0 {
        let m = &pre.hue;
        let (r0, g0, b0) = (r, g, b);
        r = m[0] * r0 + m[1] * g0 + m[2] * b0;
        g = m[3] * r0 + m[4] * g0 + m[5] * b0;
        b = m[6] * r0 + m[7] * g0 + m[8] * b0;
    }
    if adj.grayscale > 0.0 {
        let l = luma(r, g, b);
        let k = adj.grayscale as f32;
        r += (l - r) * k;
        g += (l - g) * k;
        b += (l - b) * k;
    }
    if adj.sepia > 0.0 {
        let k = adj.sepia as f32;
        let sr = 0.393 * r + 0.769 * g + 0.189 * b;
        let sg = 0.349 * r + 0.686 * g + 0.168 * b;
        let sb = 0.272 * r + 0.534 * g + 0.131 * b;
        r += (sr - r) * k;
        g += (sg - g) * k;
        b += (sb - b) * k;
    }
    if let Some([lo, hi]) = adj.duotone {
        let l = luma(r, g, b).clamp(0.0, 1.0);
        r = lo.r + (hi.r - lo.r) * l;
        g = lo.g + (hi.g - lo.g) * l;
        b = lo.b + (hi.b - lo.b) * l;
    }
    [r.clamp(0.0, 1.0), g.clamp(0.0, 1.0), b.clamp(0.0, 1.0)]
}

struct Precomputed {
    exposure: f32,
    brightness_exp: f32,
    contrast: f32,
    hue: [f32; 9],
}

fn precompute(adj: &Adjustments) -> Precomputed {
    let (s, c) = (adj.hue.to_radians() as f32).sin_cos();
    // CSS hue-rotate matrix (Filter Effects Level 1).
    let hue = [
        0.213 + c * 0.787 - s * 0.213,
        0.715 - c * 0.715 - s * 0.715,
        0.072 - c * 0.072 + s * 0.928,
        0.213 - c * 0.213 + s * 0.143,
        0.715 + c * 0.285 + s * 0.140,
        0.072 - c * 0.072 - s * 0.283,
        0.213 - c * 0.213 - s * 0.787,
        0.715 - c * 0.715 + s * 0.715,
        0.072 + c * 0.928 + s * 0.072,
    ];
    let contrast =
        ((adj.contrast.clamp(-0.999, 0.999) + 1.0) * std::f64::consts::FRAC_PI_4).tan() as f32;
    Precomputed {
        exposure: 2f32.powf(adj.exposure as f32 * 1.5),
        brightness_exp: 2f32.powf(-(adj.brightness as f32)),
        contrast,
        hue,
    }
}

/// Applies the pixel pipeline. `blur_px` is the blur radius in image pixels; `overlay` bakes box-space
/// vignette / grain into the result.
pub fn apply_adjustments(
    img: &RasterImage,
    adj: &Adjustments,
    blur_px: f64,
    overlay: Option<&BoxOverlay>,
) -> RasterImage {
    let (w, h) = (img.width() as usize, img.height() as usize);
    let mut data = img.pixmap().data().to_vec();
    let color_ops = !Adjustments {
        blur: 0.0,
        sharpen: 0.0,
        vignette: 0.0,
        grain: 0.0,
        ..adj.clone()
    }
    .is_pixel_identity();
    if color_ops {
        demultiply(&mut data);
        let pre = precompute(adj);
        // A 3D lookup would be faster for huge images; images are capped at 8192 px and adjusted once per change.
        for px in data.as_chunks_mut::<4>().0 {
            if px[3] == 0 {
                continue;
            }
            let c = [
                f32::from(px[0]) / 255.0,
                f32::from(px[1]) / 255.0,
                f32::from(px[2]) / 255.0,
            ];
            let o = adjust_pixel(adj, &pre, c);
            px[0] = (o[0] * 255.0 + 0.5) as u8;
            px[1] = (o[1] * 255.0 + 0.5) as u8;
            px[2] = (o[2] * 255.0 + 0.5) as u8;
        }
        premultiply(&mut data);
    }
    if blur_px > 0.05 {
        // Node blur values are CSS-like radii: sigma = radius / 2.
        let sigma = blur_px / 2.0;
        blur_rgba(&mut data, w, h, sigma, sigma, Edge::Clamp);
    }
    if adj.sharpen > 0.0 {
        let mut soft = data.clone();
        let sigma = (w.max(h) as f64 / 900.0).clamp(1.0, 3.0);
        blur_rgba(&mut soft, w, h, sigma, sigma, Edge::Clamp);
        let k = (adj.sharpen * 1.5) as f32;
        for (px, s) in data
            .as_chunks_mut::<4>()
            .0
            .iter_mut()
            .zip(soft.as_chunks::<4>().0)
        {
            let a = px[3];
            for i in 0..3 {
                let v = f32::from(px[i]) + (f32::from(px[i]) - f32::from(s[i])) * k;
                px[i] = v.clamp(0.0, f32::from(a)) as u8;
            }
        }
    }
    if let Some(o) = overlay {
        o.apply(&mut data, w, h);
    }
    let size = tiny_skia::IntSize::from_wh(w as u32, h as u32).expect("non-empty image");
    let pixmap = Pixmap::from_vec(data, size).expect("same size as the source");
    RasterImage::new(pixmap, None)
}

/// `img` with box overlays (vignette, grain) applied.
pub fn apply_box_overlay(img: &RasterImage, overlay: &BoxOverlay) -> RasterImage {
    let (w, h) = (img.width() as usize, img.height() as usize);
    let mut data = img.pixmap().data().to_vec();
    overlay.apply(&mut data, w, h);
    let size = tiny_skia::IntSize::from_wh(w as u32, h as u32).expect("non-empty image");
    let pixmap = Pixmap::from_vec(data, size).expect("same size as the source");
    RasterImage::new(pixmap, None)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn img(rgba: [u8; 4]) -> RasterImage {
        RasterImage::from_rgba8(2, 2, rgba.repeat(4)).unwrap()
    }

    #[test]
    fn identity_and_presets() {
        let a = Adjustments::default();
        assert!(a.is_pixel_identity());
        let p: ImageAdjustPatch =
            serde_json::from_value(serde_json::json!({"filter": "mono"})).unwrap();
        let m = Adjustments::from_patch(&p);
        assert_eq!(m.grayscale, 1.0);
        let out = apply_adjustments(&img([200, 40, 40, 255]), &m, 0.0, None);
        let px = out.pixmap().pixel(0, 0).unwrap();
        assert!((i32::from(px.red()) - i32::from(px.green())).abs() <= 1);
        let p: ImageAdjustPatch =
            serde_json::from_value(serde_json::json!({"filter": "nope", "highlights": 0.5}))
                .unwrap();
        assert_eq!(Adjustments::from_patch(&p).highlights, 0.5);
        for name in FILTER_PRESETS {
            assert!(preset(name).is_some(), "{name}");
        }
    }

    #[test]
    fn brightness_and_duotone() {
        let up = Adjustments {
            brightness: 0.5,
            ..Default::default()
        };
        let out = apply_adjustments(&img([100, 100, 100, 255]), &up, 0.0, None);
        assert!(out.pixmap().pixel(0, 0).unwrap().red() > 100);
        let duo = Adjustments {
            duotone: Some([
                Color4::parse_hex("#000080").unwrap(),
                Color4::parse_hex("#ffff00").unwrap(),
            ]),
            ..Default::default()
        };
        let out = apply_adjustments(&img([255, 255, 255, 255]), &duo, 0.0, None);
        let px = out.pixmap().pixel(1, 1).unwrap();
        assert_eq!((px.red(), px.green(), px.blue()), (255, 255, 0));
        let t = Adjustments {
            temperature: 1.0,
            ..Default::default()
        };
        let out = apply_adjustments(&img([128, 128, 128, 255]), &t, 0.0, None);
        let px = out.pixmap().pixel(0, 0).unwrap();
        assert!(px.red() > px.blue());
    }
}
