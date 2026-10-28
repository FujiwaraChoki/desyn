//! Backend-neutral paints (solid colors, gradients, image patterns) and their resolution from model fills.

use std::sync::Arc;

use desyn_core::color::resolve_color;
use desyn_core::geometry::{Affine, Point};
use desyn_core::model::{Color, ColorValue, ConicFill, DesignStyles, LinearFill, RadialFill, Stop};

use crate::assets::RasterImage;

/// Straight-alpha sRGB color with components in 0..1.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Color4 {
    /// Red.
    pub r: f32,
    /// Green.
    pub g: f32,
    /// Blue.
    pub b: f32,
    /// Alpha.
    pub a: f32,
}

impl Color4 {
    /// Opaque black.
    pub const BLACK: Color4 = Color4 {
        r: 0.0,
        g: 0.0,
        b: 0.0,
        a: 1.0,
    };
    /// Opaque white.
    pub const WHITE: Color4 = Color4 {
        r: 1.0,
        g: 1.0,
        b: 1.0,
        a: 1.0,
    };
    /// Fully transparent.
    pub const TRANSPARENT: Color4 = Color4 {
        r: 0.0,
        g: 0.0,
        b: 0.0,
        a: 0.0,
    };

    /// From 8-bit straight RGBA.
    pub fn from_rgba8(c: [u8; 4]) -> Self {
        Color4 {
            r: f32::from(c[0]) / 255.0,
            g: f32::from(c[1]) / 255.0,
            b: f32::from(c[2]) / 255.0,
            a: f32::from(c[3]) / 255.0,
        }
    }

    /// From a model color.
    pub fn from_color(c: &Color) -> Self {
        Color4::from_rgba8(c.rgba8())
    }

    /// Parses `#rrggbb` / `#rrggbbaa` (lowercase or uppercase).
    pub fn parse_hex(s: &str) -> Option<Self> {
        let lower = s.trim().to_ascii_lowercase();
        Color::new(lower).ok().map(|c| Color4::from_color(&c))
    }

    /// To 8-bit straight RGBA.
    pub fn to_rgba8(self) -> [u8; 4] {
        let q = |v: f32| (v.clamp(0.0, 1.0) * 255.0).round() as u8;
        [q(self.r), q(self.g), q(self.b), q(self.a)]
    }

    /// `#rrggbb` (alpha dropped).
    pub fn to_hex_rgb(self) -> String {
        let c = self.to_rgba8();
        format!("#{:02x}{:02x}{:02x}", c[0], c[1], c[2])
    }

    /// Multiplies the alpha.
    pub fn with_alpha_mul(self, k: f32) -> Self {
        Color4 {
            a: (self.a * k).clamp(0.0, 1.0),
            ..self
        }
    }

    /// tiny-skia color.
    pub fn to_skia(self) -> tiny_skia::Color {
        tiny_skia::Color::from_rgba(
            self.r.clamp(0.0, 1.0),
            self.g.clamp(0.0, 1.0),
            self.b.clamp(0.0, 1.0),
            self.a.clamp(0.0, 1.0),
        )
        .unwrap_or(tiny_skia::Color::TRANSPARENT)
    }

    /// Linear interpolation in premultiplied space.
    pub fn lerp(self, o: Color4, t: f32) -> Color4 {
        let a = self.a + (o.a - self.a) * t;
        if a <= 0.0 {
            return Color4::TRANSPARENT;
        }
        let pm = |c0: f32, c1: f32| ((c0 * self.a) + (c1 * o.a - c0 * self.a) * t) / a;
        Color4 {
            r: pm(self.r, o.r),
            g: pm(self.g, o.g),
            b: pm(self.b, o.b),
            a,
        }
    }
}

/// Gradient stop (position 0..1, straight-alpha color).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct GradientStop {
    /// Position along the gradient.
    pub pos: f32,
    /// Color.
    pub color: Color4,
}

/// What happens outside the gradient's 0..1 range.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Spread {
    /// Clamp to the end colors.
    #[default]
    Pad,
    /// Repeat.
    Repeat,
    /// Mirror.
    Reflect,
}

/// Image sampling quality.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Quality {
    /// Nearest neighbour (pixel art, QR-like content).
    Nearest,
    /// Bilinear.
    Bilinear,
    /// Bicubic (default; mip levels are used for downscaling).
    #[default]
    Bicubic,
}

/// What an image pattern paints outside the image.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImageExtend {
    /// Tiles.
    Repeat,
    /// Edge pixels extend (pictures that cover their shape: no translucent fringe at the edges).
    Clamp,
    /// Nothing (contained pictures leave the rest of the shape empty).
    Transparent,
}

/// An image pattern.
#[derive(Debug, Clone)]
pub struct ImagePaint {
    /// Decoded (and possibly adjusted) image.
    pub image: Arc<RasterImage>,
    /// Maps image pixel coordinates to the item's local coordinates.
    pub transform: Affine,
    /// Outside the image.
    pub extend: ImageExtend,
    /// Sampling quality.
    pub quality: Quality,
}

/// A paint, in the local coordinates of the item that uses it.
#[derive(Debug, Clone)]
pub enum Paint {
    /// Solid color.
    Solid(Color4),
    /// Linear gradient from `start` to `end` (gradient space, mapped by `transform`).
    Linear {
        /// Start point.
        start: Point,
        /// End point.
        end: Point,
        /// Stops (sorted).
        stops: Vec<GradientStop>,
        /// Spread.
        spread: Spread,
        /// Gradient space to local.
        transform: Affine,
    },
    /// Two-circle radial gradient (gradient space, mapped by `transform`).
    Radial {
        /// Focal (start) center.
        c0: Point,
        /// Focal radius.
        r0: f64,
        /// End center.
        c1: Point,
        /// End radius.
        r1: f64,
        /// Stops (sorted).
        stops: Vec<GradientStop>,
        /// Spread.
        spread: Spread,
        /// Gradient space to local.
        transform: Affine,
    },
    /// Conic (sweep) gradient around `center`; `t = 0` points along the gradient-space +x axis and grows clockwise
    /// (y down) over `start_deg..end_deg`.
    Conic {
        /// Center.
        center: Point,
        /// Start angle in degrees.
        start_deg: f64,
        /// End angle in degrees.
        end_deg: f64,
        /// Stops (sorted).
        stops: Vec<GradientStop>,
        /// Spread.
        spread: Spread,
        /// Gradient space to local.
        transform: Affine,
    },
    /// Image pattern.
    Image(ImagePaint),
}

impl Paint {
    /// Solid paint from a model color.
    pub fn solid(c: &Color) -> Paint {
        Paint::Solid(Color4::from_color(c))
    }

    /// True for a fully transparent solid color.
    pub fn is_invisible(&self) -> bool {
        match self {
            Paint::Solid(c) => c.a <= 0.0,
            Paint::Linear { stops, .. }
            | Paint::Radial { stops, .. }
            | Paint::Conic { stops, .. } => stops.iter().all(|s| s.color.a <= 0.0),
            Paint::Image(_) => false,
        }
    }

    /// The paint's average color (vector exporters that cannot express a paint fall back to it).
    pub fn average_color(&self) -> Color4 {
        match self {
            Paint::Solid(c) => *c,
            Paint::Linear { stops, .. }
            | Paint::Radial { stops, .. }
            | Paint::Conic { stops, .. } => average_stops(stops),
            Paint::Image(_) => Color4::new_gray(0.5),
        }
    }
}

impl Color4 {
    /// Opaque gray.
    pub fn new_gray(v: f32) -> Color4 {
        Color4 {
            r: v,
            g: v,
            b: v,
            a: 1.0,
        }
    }
}

fn average_stops(stops: &[GradientStop]) -> Color4 {
    if stops.is_empty() {
        return Color4::TRANSPARENT;
    }
    let n = stops.len() as f32;
    let mut acc = Color4::TRANSPARENT;
    for s in stops {
        acc.r += s.color.r * s.color.a / n;
        acc.g += s.color.g * s.color.a / n;
        acc.b += s.color.b * s.color.a / n;
        acc.a += s.color.a / n;
    }
    if acc.a > 0.0 {
        acc.r /= acc.a;
        acc.g /= acc.a;
        acc.b /= acc.a;
    }
    acc
}

/// Resolves a `Color | ColorRef` (unresolvable references paint nothing).
pub fn resolve(v: &ColorValue, styles: &DesignStyles) -> Option<Color4> {
    resolve_color(v, styles).map(|c| Color4::from_color(&c))
}

/// Resolves and sorts gradient stops; unresolvable references become transparent (as `sample_stops` does).
pub fn resolve_stops(stops: &[Stop], styles: &DesignStyles) -> Vec<GradientStop> {
    let mut out: Vec<GradientStop> = stops
        .iter()
        .filter(|s| s.pos.is_finite())
        .map(|s| GradientStop {
            pos: s.pos.clamp(0.0, 1.0) as f32,
            color: resolve(&s.color, styles).unwrap_or(Color4::TRANSPARENT),
        })
        .collect();
    out.sort_by(|a, b| a.pos.total_cmp(&b.pos));
    out
}

/// CSS linear gradient over a `w x h` box (0 = to top, 90 = to right); the gradient line passes through the box
/// center and its length makes the corners land on 0 / 1 (same as `desyn_core::color::linear_gradient_t`).
pub fn linear_paint(f: &LinearFill, styles: &DesignStyles, w: f64, h: f64) -> Paint {
    let angle = if f.angle.is_finite() { f.angle } else { 180.0 };
    let (s, c) = angle.to_radians().sin_cos();
    let len = (w * s).abs() + (h * c).abs();
    let half = len / 2.0;
    let (cx, cy) = (w / 2.0, h / 2.0);
    let dir = (s, -c);
    Paint::Linear {
        start: Point::new(cx - dir.0 * half, cy - dir.1 * half),
        end: Point::new(cx + dir.0 * half, cy + dir.1 * half),
        stops: resolve_stops(&f.stops, styles),
        spread: Spread::Pad,
        transform: Affine::IDENTITY,
    }
}

/// Radial gradient with center / radii normalized to the box (an ellipse in local space).
pub fn radial_paint(f: &RadialFill, styles: &DesignStyles, w: f64, h: f64) -> Paint {
    let rx = (f.rx * w).abs().max(1e-6);
    let ry = (f.ry * h).abs().max(1e-6);
    Paint::Radial {
        c0: Point::ZERO,
        r0: 0.0,
        c1: Point::ZERO,
        r1: 1.0,
        stops: resolve_stops(&f.stops, styles),
        spread: Spread::Pad,
        transform: Affine::translate(f.cx * w, f.cy * h) * Affine::scale(rx, ry),
    }
}

/// CSS conic gradient: `angle` is the start direction, clockwise from 12 o'clock.
pub fn conic_paint(f: &ConicFill, styles: &DesignStyles, w: f64, h: f64) -> Paint {
    let angle = if f.angle.is_finite() { f.angle } else { 0.0 };
    Paint::Conic {
        center: Point::ZERO,
        start_deg: 0.0,
        end_deg: 360.0,
        stops: resolve_stops(&f.stops, styles),
        spread: Spread::Pad,
        transform: Affine::translate(f.cx * w, f.cy * h) * Affine::rotate_deg(angle - 90.0),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn linear_to_right_spans_the_box() {
        let f: LinearFill = serde_json::from_value(serde_json::json!({
            "angle": 90, "stops": [{"pos": 0, "color": "#000000"}, {"pos": 1, "color": "#ffffff"}]
        }))
        .unwrap();
        let Paint::Linear { start, end, .. } =
            linear_paint(&f, &DesignStyles::default(), 200.0, 100.0)
        else {
            panic!()
        };
        assert!((start.x - 0.0).abs() < 1e-9 && (start.y - 50.0).abs() < 1e-9);
        assert!((end.x - 200.0).abs() < 1e-9 && (end.y - 50.0).abs() < 1e-9);
    }

    #[test]
    fn color_helpers() {
        let c = Color4::parse_hex("#FF000080").unwrap();
        assert_eq!(c.to_rgba8(), [255, 0, 0, 128]);
        assert_eq!(c.to_hex_rgb(), "#ff0000");
        let m = Color4::BLACK.lerp(Color4::TRANSPARENT, 0.5);
        assert!((m.a - 0.5).abs() < 1e-6 && m.r == 0.0);
    }
}
