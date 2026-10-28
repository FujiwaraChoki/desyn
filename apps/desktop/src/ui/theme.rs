//! Theme tokens (DESIGN_SYSTEM.md §1-3, "Atmospheric Minimalism", sun edition) as GPUI colors. Dark-first; the
//! light theme is designed, not inverted. `System` follows the OS appearance per window.

use gpui::{App, Global, Hsla, Rgba, WindowAppearance, rgb, rgba};

use crate::settings::ThemePref;

/// Font families bundled with the app (`assets/fonts`).
pub const SANS: &str = "Instrument Sans";
/// Serif for headings, empty states, dialog titles and big numbers.
pub const SERIF: &str = "Instrument Serif";
/// Mono for ids, numbers, shortcuts.
pub const MONO: &str = "JetBrains Mono";

/// Resolved colors for one appearance.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Theme {
    /// Dark appearance.
    pub dark: bool,
    /// App background.
    pub bg: Hsla,
    /// Foreground text.
    pub fg: Hsla,
    /// Secondary text (62 % foreground).
    pub muted: Hsla,
    /// Tertiary text / disabled (40 %).
    pub faint: Hsla,
    /// Panels.
    pub surface1: Hsla,
    /// Raised surfaces, inputs.
    pub surface2: Hsla,
    /// Hover.
    pub surface3: Hsla,
    /// Glass surfaces over the canvas (72 % surface).
    pub glass: Hsla,
    /// Border 10 %.
    pub border_subtle: Hsla,
    /// Border 20 %.
    pub border: Hsla,
    /// Border 40 % (hover).
    pub border_strong: Hsla,
    /// The sun (accent for marks, selection, focus).
    pub accent: Hsla,
    /// Accent text on surfaces (contrast-safe).
    pub accent_text: Hsla,
    /// Primary button fill.
    pub accent_solid: Hsla,
    /// Text on the accent fill.
    pub accent_ink: Hsla,
    /// Accent at 15 % (selected rows, active tool).
    pub accent_soft: Hsla,
    /// Accent at 30 % (glows).
    pub accent_glow: Hsla,
    /// Sun gradient hi.
    pub sun_hi: Hsla,
    /// Sun gradient lo (ember).
    pub sun_lo: Hsla,
    /// Editor canvas background.
    pub canvas: Hsla,
    /// Canvas dot grid.
    pub canvas_dot: Hsla,
    /// Snap lines and measurements.
    pub snap: Hsla,
    /// Ruler guides.
    pub guide: Hsla,
    /// Success.
    pub success: Hsla,
    /// Danger.
    pub danger: Hsla,
    /// Info.
    pub info: Hsla,
    /// Page drop shadow.
    pub page_shadow: Hsla,
}

fn c(hex: u32) -> Hsla {
    rgb(hex).into()
}

fn ca(hex: u32, alpha: f32) -> Hsla {
    let mut h: Hsla = rgb(hex).into();
    h.a = alpha;
    h
}

impl Theme {
    /// Dark theme (the default).
    pub fn dark() -> Theme {
        let fg = 0xEDEDED;
        Theme {
            dark: true,
            bg: c(0x0A0A0A),
            fg: c(fg),
            muted: ca(fg, 0.62),
            faint: ca(fg, 0.40),
            surface1: c(0x111111),
            surface2: c(0x171717),
            surface3: c(0x1F1F1F),
            glass: ca(0x151515, 0.97),
            border_subtle: ca(fg, 0.10),
            border: ca(fg, 0.20),
            border_strong: ca(fg, 0.40),
            accent: c(0xFFB02E),
            accent_text: c(0xFFB02E),
            accent_solid: c(0xFFB02E),
            accent_ink: c(0x0A0A0A),
            accent_soft: ca(0xFFB02E, 0.15),
            accent_glow: ca(0xFFB02E, 0.30),
            sun_hi: c(0xFFD66B),
            sun_lo: c(0xFF6A1F),
            canvas: c(0x0E0E0E),
            canvas_dot: ca(fg, 0.07),
            snap: c(0xFF6A1F),
            guide: c(0x7AB8FF),
            success: c(0x4ADE80),
            danger: c(0xFF5C5C),
            info: c(0x7AB8FF),
            page_shadow: Hsla {
                h: 0.0,
                s: 0.0,
                l: 0.0,
                a: 0.55,
            },
        }
    }

    /// Light theme.
    pub fn light() -> Theme {
        let fg = 0x171717;
        Theme {
            dark: false,
            bg: c(0xFFFFFF),
            fg: c(fg),
            muted: ca(fg, 0.62),
            faint: ca(fg, 0.40),
            surface1: c(0xFAF8F4),
            surface2: c(0xF3EFE7),
            surface3: c(0xEAE4D8),
            glass: ca(0xFCFBF8, 0.97),
            border_subtle: ca(fg, 0.10),
            border: ca(fg, 0.20),
            border_strong: ca(fg, 0.40),
            accent: c(0xD27400),
            accent_text: c(0xA35800),
            accent_solid: c(0xFFB02E),
            accent_ink: c(0x171717),
            accent_soft: ca(0xD27400, 0.14),
            accent_glow: ca(0xFFB02E, 0.35),
            sun_hi: c(0xFFD66B),
            sun_lo: c(0xFF6A1F),
            canvas: c(0xECE8DF),
            canvas_dot: ca(fg, 0.10),
            snap: c(0xE0531A),
            guide: c(0x1D5FBF),
            success: c(0x147A3A),
            danger: c(0xC62828),
            info: c(0x1D5FBF),
            page_shadow: Hsla {
                h: 0.0,
                s: 0.0,
                l: 0.0,
                a: 0.18,
            },
        }
    }

    /// Theme for a preference and the window's appearance.
    pub fn resolve(pref: ThemePref, appearance: WindowAppearance) -> Theme {
        match pref {
            ThemePref::Dark => Theme::dark(),
            ThemePref::Light => Theme::light(),
            ThemePref::System => match appearance {
                WindowAppearance::Light | WindowAppearance::VibrantLight => Theme::light(),
                _ => Theme::dark(),
            },
        }
    }
}

/// The user's theme preference (global; windows resolve it with their appearance).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ThemeSetting(pub ThemePref);

impl Global for ThemeSetting {}

/// Theme for the current app state and a window appearance.
pub fn theme(cx: &App, appearance: WindowAppearance) -> Theme {
    let pref = cx
        .try_global::<ThemeSetting>()
        .map(|t| t.0)
        .unwrap_or_default();
    Theme::resolve(pref, appearance)
}

/// `rgba` helper for literal colors with alpha.
pub fn alpha(c: Hsla, a: f32) -> Hsla {
    Hsla { a: c.a * a, ..c }
}

/// Converts a theme color to `Rgba` (canvas painting helpers).
pub fn to_rgba(c: Hsla) -> Rgba {
    c.to_rgb()
}

/// Transparent.
pub fn clear() -> Hsla {
    rgba(0x00000000).into()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lum(c: Hsla) -> f64 {
        let r = c.to_rgb();
        let f = |v: f32| {
            let v = v as f64;
            if v <= 0.03928 {
                v / 12.92
            } else {
                ((v + 0.055) / 1.055).powf(2.4)
            }
        };
        0.2126 * f(r.r) + 0.7152 * f(r.g) + 0.0722 * f(r.b)
    }

    fn contrast(a: Hsla, b: Hsla) -> f64 {
        let (la, lb) = (lum(a), lum(b));
        (la.max(lb) + 0.05) / (la.min(lb) + 0.05)
    }

    #[test]
    fn text_contrast_is_aa() {
        for t in [Theme::dark(), Theme::light()] {
            assert!(contrast(t.fg, t.bg) >= 7.0);
            assert!(contrast(t.fg, t.surface2) >= 7.0);
            assert!(contrast(t.accent_ink, t.accent_solid) >= 4.5, "ink on sun");
            assert!(contrast(t.accent_text, t.surface1) >= 4.5, "accent text");
        }
        assert!(!Theme::resolve(ThemePref::System, WindowAppearance::Light).dark);
        assert!(Theme::resolve(ThemePref::System, WindowAppearance::Dark).dark);
    }
}
