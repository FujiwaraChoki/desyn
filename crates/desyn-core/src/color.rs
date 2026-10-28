//! Color utilities: CSS color parsing, conversions (HSL, HSV, OKLab / OKLCH), the 16 blend modes (W3C Compositing
//! and Blending Level 1, separable and non-separable), source-over compositing, WCAG contrast, gradient sampling and
//! `ColorRef` resolution.

use core::fmt;

use serde::{Deserialize, Serialize};

use crate::model::{BlendMode, Color, ColorRef, ColorValue, DesignStyles, Stop, VarValue};

/// Non-premultiplied sRGB color with channels in 0..1.
#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize)]
pub struct Rgba {
    /// Red.
    pub r: f64,
    /// Green.
    pub g: f64,
    /// Blue.
    pub b: f64,
    /// Alpha.
    pub a: f64,
}

impl Rgba {
    /// Opaque black.
    pub const BLACK: Rgba = Rgba {
        r: 0.0,
        g: 0.0,
        b: 0.0,
        a: 1.0,
    };
    /// Opaque white.
    pub const WHITE: Rgba = Rgba {
        r: 1.0,
        g: 1.0,
        b: 1.0,
        a: 1.0,
    };
    /// Fully transparent.
    pub const TRANSPARENT: Rgba = Rgba {
        r: 0.0,
        g: 0.0,
        b: 0.0,
        a: 0.0,
    };

    /// New color (channels clamped to 0..1).
    pub fn new(r: f64, g: f64, b: f64, a: f64) -> Self {
        let c = |v: f64| {
            if v.is_finite() {
                v.clamp(0.0, 1.0)
            } else {
                0.0
            }
        };
        Rgba {
            r: c(r),
            g: c(g),
            b: c(b),
            a: c(a),
        }
    }

    /// From a contract color.
    pub fn from_color(c: &Color) -> Self {
        let [r, g, b, a] = c.rgba_f64();
        Rgba { r, g, b, a }
    }

    /// To a contract color (rounded to 8 bits; alpha 1 gives the 6-digit form).
    pub fn to_color(self) -> Color {
        let q = |v: f64| (v.clamp(0.0, 1.0) * 255.0).round() as u8;
        Color::from_rgba8(q(self.r), q(self.g), q(self.b), q(self.a))
    }

    /// Same color with another alpha.
    pub fn with_alpha(self, a: f64) -> Self {
        Rgba {
            a: a.clamp(0.0, 1.0),
            ..self
        }
    }

    /// Linear interpolation in premultiplied space (as CSS gradients do).
    pub fn lerp(self, o: Rgba, t: f64) -> Rgba {
        let t = t.clamp(0.0, 1.0);
        let a = self.a + (o.a - self.a) * t;
        if a <= 0.0 {
            return Rgba::TRANSPARENT;
        }
        let pm = |c0: f64, c1: f64| (c0 * self.a + (c1 * o.a - c0 * self.a) * t) / a;
        Rgba::new(pm(self.r, o.r), pm(self.g, o.g), pm(self.b, o.b), a)
    }

    /// WCAG relative luminance (sRGB, alpha ignored).
    pub fn relative_luminance(self) -> f64 {
        let lin = |c: f64| {
            if c <= 0.04045 {
                c / 12.92
            } else {
                ((c + 0.055) / 1.055).powf(2.4)
            }
        };
        0.2126 * lin(self.r) + 0.7152 * lin(self.g) + 0.0722 * lin(self.b)
    }

    /// To HSL: hue degrees 0..360, saturation and lightness 0..1.
    pub fn to_hsl(self) -> (f64, f64, f64) {
        let max = self.r.max(self.g).max(self.b);
        let min = self.r.min(self.g).min(self.b);
        let l = (max + min) / 2.0;
        let d = max - min;
        if d == 0.0 {
            return (0.0, 0.0, l);
        }
        let s = if l > 0.5 {
            d / (2.0 - max - min)
        } else {
            d / (max + min)
        };
        (hue_of(self.r, self.g, self.b, max, d), s, l)
    }

    /// From HSL (hue degrees, saturation / lightness 0..1).
    pub fn from_hsl(h: f64, s: f64, l: f64, a: f64) -> Rgba {
        let s = s.clamp(0.0, 1.0);
        let l = l.clamp(0.0, 1.0);
        let c = (1.0 - (2.0 * l - 1.0).abs()) * s;
        let (r, g, b) = hue_to_rgb(h, c);
        let m = l - c / 2.0;
        Rgba::new(r + m, g + m, b + m, a)
    }

    /// To HSV: hue degrees 0..360, saturation and value 0..1.
    pub fn to_hsv(self) -> (f64, f64, f64) {
        let max = self.r.max(self.g).max(self.b);
        let min = self.r.min(self.g).min(self.b);
        let d = max - min;
        let s = if max == 0.0 { 0.0 } else { d / max };
        let h = if d == 0.0 {
            0.0
        } else {
            hue_of(self.r, self.g, self.b, max, d)
        };
        (h, s, max)
    }

    /// From HSV (hue degrees, saturation / value 0..1).
    pub fn from_hsv(h: f64, s: f64, v: f64, a: f64) -> Rgba {
        let s = s.clamp(0.0, 1.0);
        let v = v.clamp(0.0, 1.0);
        let c = v * s;
        let (r, g, b) = hue_to_rgb(h, c);
        let m = v - c;
        Rgba::new(r + m, g + m, b + m, a)
    }

    /// To OKLab `(L, a, b)`.
    pub fn to_oklab(self) -> (f64, f64, f64) {
        let lin = |c: f64| {
            if c <= 0.04045 {
                c / 12.92
            } else {
                ((c + 0.055) / 1.055).powf(2.4)
            }
        };
        let (r, g, b) = (lin(self.r), lin(self.g), lin(self.b));
        let l = (0.412_221_470_8 * r + 0.536_332_536_3 * g + 0.051_445_992_9 * b).cbrt();
        let m = (0.211_903_498_2 * r + 0.680_699_545_1 * g + 0.107_396_956_6 * b).cbrt();
        let s = (0.088_302_461_9 * r + 0.281_718_837_6 * g + 0.629_978_700_5 * b).cbrt();
        (
            0.210_454_255_3 * l + 0.793_617_785_0 * m - 0.004_072_046_8 * s,
            1.977_998_495_1 * l - 2.428_592_205_0 * m + 0.450_593_709_9 * s,
            0.025_904_037_1 * l + 0.782_771_766_2 * m - 0.808_675_766_0 * s,
        )
    }

    /// From OKLab.
    pub fn from_oklab(l: f64, a: f64, b: f64, alpha: f64) -> Rgba {
        let l_ = (l + 0.396_337_777_4 * a + 0.215_803_757_3 * b).powi(3);
        let m_ = (l - 0.105_561_345_8 * a - 0.063_854_172_8 * b).powi(3);
        let s_ = (l - 0.089_484_177_5 * a - 1.291_485_548_0 * b).powi(3);
        let r = 4.076_741_662_1 * l_ - 3.307_711_591_3 * m_ + 0.230_969_929_2 * s_;
        let g = -1.268_438_004_6 * l_ + 2.609_757_401_1 * m_ - 0.341_319_396_5 * s_;
        let bb = -0.004_196_086_3 * l_ - 0.703_418_614_7 * m_ + 1.707_614_701_0 * s_;
        let enc = |c: f64| {
            if c <= 0.003_130_8 {
                12.92 * c
            } else {
                1.055 * c.powf(1.0 / 2.4) - 0.055
            }
        };
        Rgba::new(enc(r), enc(g), enc(bb), alpha)
    }

    /// To OKLCH `(L, C, h degrees)`.
    pub fn to_oklch(self) -> (f64, f64, f64) {
        let (l, a, b) = self.to_oklab();
        let c = a.hypot(b);
        let h = if c < 1e-9 {
            0.0
        } else {
            b.atan2(a).to_degrees().rem_euclid(360.0)
        };
        (l, c, h)
    }

    /// From OKLCH.
    pub fn from_oklch(l: f64, c: f64, h: f64, alpha: f64) -> Rgba {
        let (s, co) = h.to_radians().sin_cos();
        Rgba::from_oklab(l, c * co, c * s, alpha)
    }
}

fn hue_of(r: f64, g: f64, b: f64, max: f64, d: f64) -> f64 {
    let h = if max == r {
        ((g - b) / d).rem_euclid(6.0)
    } else if max == g {
        (b - r) / d + 2.0
    } else {
        (r - g) / d + 4.0
    };
    (h * 60.0).rem_euclid(360.0)
}

fn hue_to_rgb(h: f64, c: f64) -> (f64, f64, f64) {
    let hp = h.rem_euclid(360.0) / 60.0;
    let x = c * (1.0 - (hp % 2.0 - 1.0).abs());
    match hp as u32 {
        0 => (c, x, 0.0),
        1 => (x, c, 0.0),
        2 => (0.0, c, x),
        3 => (0.0, x, c),
        4 => (x, 0.0, c),
        _ => (c, 0.0, x),
    }
}

/// Error parsing a CSS color.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CssColorError(pub String);

impl fmt::Display for CssColorError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "unsupported CSS color {:?}", self.0)
    }
}

impl std::error::Error for CssColorError {}

/// CSS named colors (CSS Color Module Level 4).
const NAMED: &[(&str, u32)] = &[
    ("aliceblue", 0xf0f8ff),
    ("antiquewhite", 0xfaebd7),
    ("aqua", 0x00ffff),
    ("aquamarine", 0x7fffd4),
    ("azure", 0xf0ffff),
    ("beige", 0xf5f5dc),
    ("bisque", 0xffe4c4),
    ("black", 0x000000),
    ("blanchedalmond", 0xffebcd),
    ("blue", 0x0000ff),
    ("blueviolet", 0x8a2be2),
    ("brown", 0xa52a2a),
    ("burlywood", 0xdeb887),
    ("cadetblue", 0x5f9ea0),
    ("chartreuse", 0x7fff00),
    ("chocolate", 0xd2691e),
    ("coral", 0xff7f50),
    ("cornflowerblue", 0x6495ed),
    ("cornsilk", 0xfff8dc),
    ("crimson", 0xdc143c),
    ("cyan", 0x00ffff),
    ("darkblue", 0x00008b),
    ("darkcyan", 0x008b8b),
    ("darkgoldenrod", 0xb8860b),
    ("darkgray", 0xa9a9a9),
    ("darkgreen", 0x006400),
    ("darkgrey", 0xa9a9a9),
    ("darkkhaki", 0xbdb76b),
    ("darkmagenta", 0x8b008b),
    ("darkolivegreen", 0x556b2f),
    ("darkorange", 0xff8c00),
    ("darkorchid", 0x9932cc),
    ("darkred", 0x8b0000),
    ("darksalmon", 0xe9967a),
    ("darkseagreen", 0x8fbc8f),
    ("darkslateblue", 0x483d8b),
    ("darkslategray", 0x2f4f4f),
    ("darkslategrey", 0x2f4f4f),
    ("darkturquoise", 0x00ced1),
    ("darkviolet", 0x9400d3),
    ("deeppink", 0xff1493),
    ("deepskyblue", 0x00bfff),
    ("dimgray", 0x696969),
    ("dimgrey", 0x696969),
    ("dodgerblue", 0x1e90ff),
    ("firebrick", 0xb22222),
    ("floralwhite", 0xfffaf0),
    ("forestgreen", 0x228b22),
    ("fuchsia", 0xff00ff),
    ("gainsboro", 0xdcdcdc),
    ("ghostwhite", 0xf8f8ff),
    ("gold", 0xffd700),
    ("goldenrod", 0xdaa520),
    ("gray", 0x808080),
    ("green", 0x008000),
    ("greenyellow", 0xadff2f),
    ("grey", 0x808080),
    ("honeydew", 0xf0fff0),
    ("hotpink", 0xff69b4),
    ("indianred", 0xcd5c5c),
    ("indigo", 0x4b0082),
    ("ivory", 0xfffff0),
    ("khaki", 0xf0e68c),
    ("lavender", 0xe6e6fa),
    ("lavenderblush", 0xfff0f5),
    ("lawngreen", 0x7cfc00),
    ("lemonchiffon", 0xfffacd),
    ("lightblue", 0xadd8e6),
    ("lightcoral", 0xf08080),
    ("lightcyan", 0xe0ffff),
    ("lightgoldenrodyellow", 0xfafad2),
    ("lightgray", 0xd3d3d3),
    ("lightgreen", 0x90ee90),
    ("lightgrey", 0xd3d3d3),
    ("lightpink", 0xffb6c1),
    ("lightsalmon", 0xffa07a),
    ("lightseagreen", 0x20b2aa),
    ("lightskyblue", 0x87cefa),
    ("lightslategray", 0x778899),
    ("lightslategrey", 0x778899),
    ("lightsteelblue", 0xb0c4de),
    ("lightyellow", 0xffffe0),
    ("lime", 0x00ff00),
    ("limegreen", 0x32cd32),
    ("linen", 0xfaf0e6),
    ("magenta", 0xff00ff),
    ("maroon", 0x800000),
    ("mediumaquamarine", 0x66cdaa),
    ("mediumblue", 0x0000cd),
    ("mediumorchid", 0xba55d3),
    ("mediumpurple", 0x9370db),
    ("mediumseagreen", 0x3cb371),
    ("mediumslateblue", 0x7b68ee),
    ("mediumspringgreen", 0x00fa9a),
    ("mediumturquoise", 0x48d1cc),
    ("mediumvioletred", 0xc71585),
    ("midnightblue", 0x191970),
    ("mintcream", 0xf5fffa),
    ("mistyrose", 0xffe4e1),
    ("moccasin", 0xffe4b5),
    ("navajowhite", 0xffdead),
    ("navy", 0x000080),
    ("oldlace", 0xfdf5e6),
    ("olive", 0x808000),
    ("olivedrab", 0x6b8e23),
    ("orange", 0xffa500),
    ("orangered", 0xff4500),
    ("orchid", 0xda70d6),
    ("palegoldenrod", 0xeee8aa),
    ("palegreen", 0x98fb98),
    ("paleturquoise", 0xafeeee),
    ("palevioletred", 0xdb7093),
    ("papayawhip", 0xffefd5),
    ("peachpuff", 0xffdab9),
    ("peru", 0xcd853f),
    ("pink", 0xffc0cb),
    ("plum", 0xdda0dd),
    ("powderblue", 0xb0e0e6),
    ("purple", 0x800080),
    ("rebeccapurple", 0x663399),
    ("red", 0xff0000),
    ("rosybrown", 0xbc8f8f),
    ("royalblue", 0x4169e1),
    ("saddlebrown", 0x8b4513),
    ("salmon", 0xfa8072),
    ("sandybrown", 0xf4a460),
    ("seagreen", 0x2e8b57),
    ("seashell", 0xfff5ee),
    ("sienna", 0xa0522d),
    ("silver", 0xc0c0c0),
    ("skyblue", 0x87ceeb),
    ("slateblue", 0x6a5acd),
    ("slategray", 0x708090),
    ("slategrey", 0x708090),
    ("snow", 0xfffafa),
    ("springgreen", 0x00ff7f),
    ("steelblue", 0x4682b4),
    ("tan", 0xd2b48c),
    ("teal", 0x008080),
    ("thistle", 0xd8bfd8),
    ("tomato", 0xff6347),
    ("turquoise", 0x40e0d0),
    ("violet", 0xee82ee),
    ("wheat", 0xf5deb3),
    ("white", 0xffffff),
    ("whitesmoke", 0xf5f5f5),
    ("yellow", 0xffff00),
    ("yellowgreen", 0x9acd32),
];

fn parse_component(s: &str, scale: f64) -> Option<f64> {
    let s = s.trim();
    if let Some(p) = s.strip_suffix('%') {
        return p.trim().parse::<f64>().ok().map(|v| v / 100.0);
    }
    s.parse::<f64>().ok().map(|v| v / scale)
}

fn parse_hue(s: &str) -> Option<f64> {
    let s = s.trim();
    let (num, mul) = if let Some(v) = s.strip_suffix("deg") {
        (v, 1.0)
    } else if let Some(v) = s.strip_suffix("grad") {
        (v, 0.9)
    } else if let Some(v) = s.strip_suffix("rad") {
        (v, 180.0 / std::f64::consts::PI)
    } else if let Some(v) = s.strip_suffix("turn") {
        (v, 360.0)
    } else {
        (s, 1.0)
    };
    num.trim().parse::<f64>().ok().map(|v| v * mul)
}

/// Splits `rgb(...)` arguments in comma or space syntax with an optional `/ alpha`.
fn split_args(inner: &str) -> Option<(Vec<String>, Option<String>)> {
    let (main, alpha) = match inner.split_once('/') {
        Some((m, a)) => (m, Some(a.trim().to_string())),
        None => (inner, None),
    };
    let parts: Vec<String> = if main.contains(',') {
        main.split(',').map(|p| p.trim().to_string()).collect()
    } else {
        main.split_whitespace().map(str::to_string).collect()
    };
    match (parts.len(), alpha) {
        (3, a) => Some((parts, a)),
        (4, None) => {
            let mut p = parts;
            let a = p.pop();
            Some((p, a))
        }
        _ => None,
    }
}

/// Parses any common CSS color: hex (`#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, any case), `rgb()/rgba()`,
/// `hsl()/hsla()` (comma or space syntax, percentages, `/ alpha`), named colors and `transparent`.
pub fn parse_css_color(input: &str) -> Result<Rgba, CssColorError> {
    let s = input.trim().to_ascii_lowercase();
    let err = || CssColorError(input.to_string());
    if let Some(hex) = s.strip_prefix('#') {
        let digits: Vec<u8> = hex
            .bytes()
            .map(|b| (b as char).to_digit(16).map(|d| d as u8))
            .collect::<Option<_>>()
            .ok_or_else(err)?;
        let (r, g, b, a) = match digits.len() {
            3 => (digits[0] * 17, digits[1] * 17, digits[2] * 17, 255),
            4 => (
                digits[0] * 17,
                digits[1] * 17,
                digits[2] * 17,
                digits[3] * 17,
            ),
            6 => (
                digits[0] * 16 + digits[1],
                digits[2] * 16 + digits[3],
                digits[4] * 16 + digits[5],
                255,
            ),
            8 => (
                digits[0] * 16 + digits[1],
                digits[2] * 16 + digits[3],
                digits[4] * 16 + digits[5],
                digits[6] * 16 + digits[7],
            ),
            _ => return Err(err()),
        };
        return Ok(Rgba::new(
            r as f64 / 255.0,
            g as f64 / 255.0,
            b as f64 / 255.0,
            a as f64 / 255.0,
        ));
    }
    if s == "transparent" {
        return Ok(Rgba::TRANSPARENT);
    }
    if let Some((_, v)) = NAMED.iter().find(|(n, _)| *n == s) {
        let v = *v;
        return Ok(Rgba::new(
            ((v >> 16) & 255) as f64 / 255.0,
            ((v >> 8) & 255) as f64 / 255.0,
            (v & 255) as f64 / 255.0,
            1.0,
        ));
    }
    let (func, rest) = s.split_once('(').ok_or_else(err)?;
    let inner = rest.strip_suffix(')').ok_or_else(err)?;
    let (parts, alpha) = split_args(inner).ok_or_else(err)?;
    let a = match alpha {
        Some(a) => parse_component(&a, 1.0).ok_or_else(err)?,
        None => 1.0,
    };
    match func.trim() {
        "rgb" | "rgba" => {
            let c: Vec<f64> = parts
                .iter()
                .map(|p| parse_component(p, 255.0))
                .collect::<Option<_>>()
                .ok_or_else(err)?;
            Ok(Rgba::new(c[0], c[1], c[2], a))
        }
        "hsl" | "hsla" => {
            let h = parse_hue(&parts[0]).ok_or_else(err)?;
            let sat = parse_component(&parts[1], 100.0).ok_or_else(err)?;
            let l = parse_component(&parts[2], 100.0).ok_or_else(err)?;
            Ok(Rgba::from_hsl(h, sat, l, a))
        }
        _ => Err(err()),
    }
}

/// Parses a CSS color straight to a contract color.
pub fn css_to_color(input: &str) -> Result<Color, CssColorError> {
    parse_css_color(input).map(Rgba::to_color)
}

/// Resolves `Color | ColorRef` against the design styles: `$style` -> color style value, `$var` -> variable parsed
/// as a CSS color. `None` when the reference does not resolve.
pub fn resolve_color(v: &ColorValue, styles: &DesignStyles) -> Option<Color> {
    match v {
        ColorValue::Color(c) => Some(c.clone()),
        ColorValue::Ref(ColorRef::Style { style, .. }) => {
            styles.colors.get(style).map(|s| s.value.clone())
        }
        ColorValue::Ref(ColorRef::Var { var, .. }) => match styles.variables.get(var)? {
            VarValue::String(s) => css_to_color(s).ok(),
            _ => None,
        },
    }
}

#[inline]
fn separable(mode: BlendMode, cb: f64, cs: f64) -> f64 {
    match mode {
        BlendMode::Normal => cs,
        BlendMode::Multiply => cb * cs,
        BlendMode::Screen => cb + cs - cb * cs,
        BlendMode::Overlay => separable(BlendMode::HardLight, cs, cb),
        BlendMode::Darken => cb.min(cs),
        BlendMode::Lighten => cb.max(cs),
        BlendMode::ColorDodge => {
            if cb == 0.0 {
                0.0
            } else if cs >= 1.0 {
                1.0
            } else {
                (cb / (1.0 - cs)).min(1.0)
            }
        }
        BlendMode::ColorBurn => {
            if cb >= 1.0 {
                1.0
            } else if cs <= 0.0 {
                0.0
            } else {
                1.0 - ((1.0 - cb) / cs).min(1.0)
            }
        }
        BlendMode::HardLight => {
            if cs <= 0.5 {
                cb * 2.0 * cs
            } else {
                let s = 2.0 * cs - 1.0;
                cb + s - cb * s
            }
        }
        BlendMode::SoftLight => {
            if cs <= 0.5 {
                cb - (1.0 - 2.0 * cs) * cb * (1.0 - cb)
            } else {
                let d = if cb <= 0.25 {
                    ((16.0 * cb - 12.0) * cb + 4.0) * cb
                } else {
                    cb.sqrt()
                };
                cb + (2.0 * cs - 1.0) * (d - cb)
            }
        }
        BlendMode::Difference => (cb - cs).abs(),
        BlendMode::Exclusion => cb + cs - 2.0 * cb * cs,
        BlendMode::Hue | BlendMode::Saturation | BlendMode::Color | BlendMode::Luminosity => cs,
    }
}

/// Unpremultiplied `(r, g, b)` channels in 0..1.
pub type Rgb = (f64, f64, f64);

fn lum(c: Rgb) -> f64 {
    0.3 * c.0 + 0.59 * c.1 + 0.11 * c.2
}

fn clip_color(c: Rgb) -> Rgb {
    let l = lum(c);
    let n = c.0.min(c.1).min(c.2);
    let x = c.0.max(c.1).max(c.2);
    let mut out = c;
    if n < 0.0 {
        let f = |v: f64| l + (v - l) * l / (l - n);
        out = (f(out.0), f(out.1), f(out.2));
    }
    if x > 1.0 {
        let f = |v: f64| l + (v - l) * (1.0 - l) / (x - l);
        out = (f(out.0), f(out.1), f(out.2));
    }
    out
}

fn set_lum(c: Rgb, l: f64) -> Rgb {
    let d = l - lum(c);
    clip_color((c.0 + d, c.1 + d, c.2 + d))
}

fn sat(c: Rgb) -> f64 {
    c.0.max(c.1).max(c.2) - c.0.min(c.1).min(c.2)
}

fn set_sat(c: Rgb, s: f64) -> Rgb {
    let mut v = [c.0, c.1, c.2];
    let mut idx = [0usize, 1, 2];
    idx.sort_by(|a, b| v[*a].total_cmp(&v[*b]));
    let (lo, mid, hi) = (idx[0], idx[1], idx[2]);
    if v[hi] > v[lo] {
        v[mid] = (v[mid] - v[lo]) * s / (v[hi] - v[lo]);
        v[hi] = s;
    } else {
        v[mid] = 0.0;
        v[hi] = 0.0;
    }
    v[lo] = 0.0;
    (v[0], v[1], v[2])
}

/// The blend function `B(Cb, Cs)` of a mode applied to unpremultiplied colors (backdrop, source).
pub fn blend_rgb(mode: BlendMode, cb: Rgb, cs: Rgb) -> Rgb {
    match mode {
        BlendMode::Hue => set_lum(set_sat(cs, sat(cb)), lum(cb)),
        BlendMode::Saturation => set_lum(set_sat(cb, sat(cs)), lum(cb)),
        BlendMode::Color => set_lum(cs, lum(cb)),
        BlendMode::Luminosity => set_lum(cb, lum(cs)),
        _ => (
            separable(mode, cb.0, cs.0),
            separable(mode, cb.1, cs.1),
            separable(mode, cb.2, cs.2),
        ),
    }
}

/// Composites `source` over `backdrop` with the blend mode (W3C: `Cs' = (1 - ab) * Cs + ab * B(Cb, Cs)`, then
/// source-over). Inputs and output are unpremultiplied.
pub fn blend(mode: BlendMode, backdrop: Rgba, source: Rgba) -> Rgba {
    let ab = backdrop.a;
    let as_ = source.a;
    let ao = as_ + ab * (1.0 - as_);
    if ao <= 0.0 {
        return Rgba::TRANSPARENT;
    }
    let b = blend_rgb(
        mode,
        (backdrop.r, backdrop.g, backdrop.b),
        (source.r, source.g, source.b),
    );
    let mix = |cs: f64, cb: f64, bl: f64| {
        let cs2 = (1.0 - ab) * cs + ab * bl;
        (as_ * cs2 + (1.0 - as_) * ab * cb) / ao
    };
    Rgba::new(
        mix(source.r, backdrop.r, b.0),
        mix(source.g, backdrop.g, b.1),
        mix(source.b, backdrop.b, b.2),
        ao,
    )
}

/// WCAG contrast ratio (1..21) of two colors (alpha ignored; composite first when needed).
pub fn contrast_ratio(a: Rgba, b: Rgba) -> f64 {
    let (la, lb) = (a.relative_luminance(), b.relative_luminance());
    let (hi, lo) = if la > lb { (la, lb) } else { (lb, la) };
    (hi + 0.05) / (lo + 0.05)
}

/// WCAG conformance level of a contrast ratio.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum WcagLevel {
    /// Fails AA.
    Fail,
    /// AA (4.5:1, or 3:1 for large text).
    AA,
    /// AAA (7:1, or 4.5:1 for large text).
    AAA,
}

/// WCAG level for text of the given kind (`large` = >= 24px regular or >= 18.66px bold).
pub fn wcag_level(ratio: f64, large: bool) -> WcagLevel {
    let (aa, aaa) = if large { (3.0, 4.5) } else { (4.5, 7.0) };
    if ratio >= aaa {
        WcagLevel::AAA
    } else if ratio >= aa {
        WcagLevel::AA
    } else {
        WcagLevel::Fail
    }
}

/// Samples gradient stops at `t` (0..1). Stops are sorted by position; positions outside the stops clamp to the
/// end colors; interpolation is premultiplied. Unresolvable references fall back to transparent.
pub fn sample_stops(stops: &[Stop], styles: &DesignStyles, t: f64) -> Rgba {
    let mut s: Vec<(f64, Rgba)> = stops
        .iter()
        .map(|st| {
            (
                st.pos,
                resolve_color(&st.color, styles)
                    .map(|c| Rgba::from_color(&c))
                    .unwrap_or(Rgba::TRANSPARENT),
            )
        })
        .collect();
    sample_resolved(&mut s, t)
}

/// [`sample_stops`] on already resolved `(pos, color)` pairs (sorted in place).
pub fn sample_resolved(stops: &mut [(f64, Rgba)], t: f64) -> Rgba {
    if stops.is_empty() {
        return Rgba::TRANSPARENT;
    }
    stops.sort_by(|a, b| a.0.total_cmp(&b.0));
    let t = if t.is_finite() { t } else { 0.0 };
    if t <= stops[0].0 {
        return stops[0].1;
    }
    let last = stops[stops.len() - 1];
    if t >= last.0 {
        return last.1;
    }
    for w in stops.windows(2) {
        let (p0, c0) = w[0];
        let (p1, c1) = w[1];
        if t >= p0 && t <= p1 {
            if p1 - p0 <= 1e-12 {
                return c1;
            }
            return c0.lerp(c1, (t - p0) / (p1 - p0));
        }
    }
    last.1
}

/// Gradient parameter of a point for a CSS-style linear gradient over a `w x h` box (`angle` degrees: 0 = to top,
/// 90 = to right); the gradient line length makes corners land exactly on 0 / 1.
pub fn linear_gradient_t(angle: f64, w: f64, h: f64, x: f64, y: f64) -> f64 {
    let (s, c) = angle.to_radians().sin_cos();
    let dir = (s, -c);
    let len = (w * s).abs() + (h * c).abs();
    if len <= 0.0 {
        return 0.0;
    }
    let (cx, cy) = (w / 2.0, h / 2.0);
    ((x - cx) * dir.0 + (y - cy) * dir.1) / len + 0.5
}

/// Gradient parameter of a point for a radial gradient (center and radii normalized to the box).
#[allow(clippy::too_many_arguments)]
pub fn radial_gradient_t(
    cx: f64,
    cy: f64,
    rx: f64,
    ry: f64,
    w: f64,
    h: f64,
    x: f64,
    y: f64,
) -> f64 {
    let (rx, ry) = (rx * w, ry * h);
    if rx <= 0.0 || ry <= 0.0 {
        return 1.0;
    }
    let dx = (x - cx * w) / rx;
    let dy = (y - cy * h) / ry;
    dx.hypot(dy)
}

/// Gradient parameter of a point for a conic gradient (center normalized; `angle` = start, clockwise from 12
/// o'clock as in CSS).
pub fn conic_gradient_t(cx: f64, cy: f64, angle: f64, w: f64, h: f64, x: f64, y: f64) -> f64 {
    let dx = x - cx * w;
    let dy = y - cy * h;
    // atan2 measured clockwise from 12 o'clock.
    let a = dx.atan2(-dy).to_degrees();
    ((a - angle).rem_euclid(360.0)) / 360.0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn close(a: Rgba, b: Rgba) -> bool {
        (a.r - b.r).abs() < 1e-3
            && (a.g - b.g).abs() < 1e-3
            && (a.b - b.b).abs() < 1e-3
            && (a.a - b.a).abs() < 1e-3
    }

    #[test]
    fn parsing() {
        assert_eq!(css_to_color("#FFB02E").unwrap().as_str(), "#ffb02e");
        assert_eq!(css_to_color("#fff").unwrap().as_str(), "#ffffff");
        assert_eq!(css_to_color("#0008").unwrap().as_str(), "#00000088");
        assert_eq!(css_to_color("rgb(255, 0, 0)").unwrap().as_str(), "#ff0000");
        assert_eq!(
            css_to_color("rgba(0 128 255 / 50%)").unwrap().as_str(),
            "#0080ff80"
        );
        assert_eq!(
            css_to_color("hsl(120, 100%, 50%)").unwrap().as_str(),
            "#00ff00"
        );
        assert_eq!(
            css_to_color("hsl(0.5turn 100% 50% / 0.25)")
                .unwrap()
                .as_str(),
            "#00ffff40"
        );
        assert_eq!(css_to_color("RebeccaPurple").unwrap().as_str(), "#663399");
        assert_eq!(css_to_color("transparent").unwrap().as_str(), "#00000000");
        assert!(parse_css_color("nope").is_err());
        assert!(parse_css_color("rgb(1,2)").is_err());
        assert!(parse_css_color("#12345").is_err());
    }

    #[test]
    fn conversions_roundtrip() {
        let c = Rgba::new(0.8, 0.3, 0.1, 1.0);
        let (h, s, l) = c.to_hsl();
        assert!(close(Rgba::from_hsl(h, s, l, 1.0), c));
        let (h, s, v) = c.to_hsv();
        assert!(close(Rgba::from_hsv(h, s, v, 1.0), c));
        let (l, a, b) = c.to_oklab();
        assert!(close(Rgba::from_oklab(l, a, b, 1.0), c));
        let (l, ch, hh) = c.to_oklch();
        assert!(close(Rgba::from_oklch(l, ch, hh, 1.0), c));
        let (l, _, _) = Rgba::WHITE.to_oklab();
        assert!((l - 1.0).abs() < 1e-4);
    }

    #[test]
    fn blend_modes() {
        let b = Rgba::new(0.2, 0.4, 0.6, 1.0);
        let s = Rgba::new(0.5, 0.5, 0.5, 1.0);
        assert!(close(blend(BlendMode::Normal, b, s), s));
        assert!(close(
            blend(BlendMode::Multiply, b, s),
            Rgba::new(0.1, 0.2, 0.3, 1.0)
        ));
        assert!(close(
            blend(BlendMode::Screen, b, s),
            Rgba::new(0.6, 0.7, 0.8, 1.0)
        ));
        assert!(close(
            blend(BlendMode::Difference, b, s),
            Rgba::new(0.3, 0.1, 0.1, 1.0)
        ));
        assert!(close(
            blend(BlendMode::Exclusion, b, s),
            Rgba::new(0.5, 0.5, 0.5, 1.0)
        ));
        assert!(close(
            blend(BlendMode::Darken, b, s),
            Rgba::new(0.2, 0.4, 0.5, 1.0)
        ));
        assert!(close(
            blend(BlendMode::Lighten, b, s),
            Rgba::new(0.5, 0.5, 0.6, 1.0)
        ));
        // Overlay = hard-light with swapped inputs.
        let o = blend(BlendMode::Overlay, b, s);
        assert!(close(o, Rgba::new(0.2, 0.4, 0.6, 1.0)));
        // Luminosity keeps the backdrop hue; gray source -> gray result with the source luminance.
        let l = blend(BlendMode::Luminosity, b, s);
        assert!((lum((l.r, l.g, l.b)) - 0.5).abs() < 1e-9);
        let col = blend(BlendMode::Color, s, b);
        assert!((lum((col.r, col.g, col.b)) - 0.5).abs() < 1e-9);
        // Every mode keeps results in range and transparent sources leave the backdrop.
        for m in BlendMode::ALL {
            let r = blend(*m, b, Rgba::new(0.9, 0.1, 0.7, 0.6));
            assert!(
                r.r >= 0.0 && r.r <= 1.0 && r.g >= 0.0 && r.b <= 1.0,
                "{m:?}"
            );
            assert!(close(blend(*m, b, Rgba::TRANSPARENT), b), "{m:?}");
        }
        // Over a transparent backdrop the source shows unblended.
        assert!(close(blend(BlendMode::Multiply, Rgba::TRANSPARENT, s), s));
    }

    #[test]
    fn contrast_and_gradients() {
        assert!((contrast_ratio(Rgba::BLACK, Rgba::WHITE) - 21.0).abs() < 1e-9);
        assert_eq!(wcag_level(4.6, false), WcagLevel::AA);
        assert_eq!(wcag_level(3.1, true), WcagLevel::AA);
        assert_eq!(wcag_level(2.0, true), WcagLevel::Fail);
        let mut stops = vec![(0.0, Rgba::BLACK), (1.0, Rgba::WHITE)];
        assert!(close(
            sample_resolved(&mut stops, 0.5),
            Rgba::new(0.5, 0.5, 0.5, 1.0)
        ));
        let mut fade = vec![
            (0.0, Rgba::new(1.0, 0.0, 0.0, 1.0)),
            (1.0, Rgba::new(0.0, 0.0, 1.0, 0.0)),
        ];
        let mid = sample_resolved(&mut fade, 0.5);
        assert!(
            close(mid, Rgba::new(1.0, 0.0, 0.0, 0.5)),
            "premultiplied keeps red: {mid:?}"
        );
        assert!((linear_gradient_t(90.0, 100.0, 50.0, 0.0, 25.0)).abs() < 1e-9);
        assert!((linear_gradient_t(90.0, 100.0, 50.0, 100.0, 25.0) - 1.0).abs() < 1e-9);
        assert!((linear_gradient_t(180.0, 100.0, 50.0, 50.0, 50.0) - 1.0).abs() < 1e-9);
        assert!(
            (radial_gradient_t(0.5, 0.5, 0.5, 0.5, 100.0, 100.0, 100.0, 50.0) - 1.0).abs() < 1e-9
        );
        assert!((conic_gradient_t(0.5, 0.5, 0.0, 100.0, 100.0, 100.0, 50.0) - 0.25).abs() < 1e-9);
    }

    #[test]
    fn refs() {
        let mut styles = DesignStyles::default();
        styles
            .variables
            .insert("brand.primary".into(), VarValue::String("#FFB02E".into()));
        styles.colors.insert(
            "color0000001".into(),
            crate::model::ColorStyle {
                name: "Sun".into(),
                value: Color::new("#d27400").unwrap(),
                extra: Default::default(),
            },
        );
        assert_eq!(
            resolve_color(&ColorValue::Ref(ColorRef::var("brand.primary")), &styles)
                .unwrap()
                .as_str(),
            "#ffb02e"
        );
        assert_eq!(
            resolve_color(&ColorValue::Ref(ColorRef::style("color0000001")), &styles)
                .unwrap()
                .as_str(),
            "#d27400"
        );
        assert!(resolve_color(&ColorValue::Ref(ColorRef::var("missing")), &styles).is_none());
    }
}
