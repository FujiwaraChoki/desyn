//! Per-kind thresholds: safe areas (from the `@desyn/schema` page presets), minimum readable text sizes and print
//! detection.

use desyn_core::{DesignKind, PageNode, Unit};

/// Insets `[top, right, bottom, left]` in px.
pub type Insets = [f64; 4];

/// Page presets that define a safe area: `(preset id, kind, width, height, [t, r, b, l])`.
///
/// Generated from `packages/schema/src/presets.ts` (`PAGE_PRESETS` entries with `safeArea`, in table order) by
/// `crates/desyn-describe/scripts/safe-areas.ts`; regenerate when the presets change.
#[rustfmt::skip]
pub const SAFE_AREA_PRESETS: &[(&str, DesignKind, f64, f64, Insets)] = &[
    ("instagram-story", DesignKind::Story, 1080.00, 1920.00, [250.00, 0.00, 250.00, 0.00]),
    ("instagram-reel-cover", DesignKind::Story, 1080.00, 1920.00, [240.00, 0.00, 240.00, 0.00]),
    ("facebook-story", DesignKind::Story, 1080.00, 1920.00, [250.00, 0.00, 250.00, 0.00]),
    ("youtube-banner", DesignKind::Banner, 2560.00, 1440.00, [508.50, 507.00, 508.50, 507.00]),
    ("poster-a0", DesignKind::Poster, 3178.58, 4493.86, [37.80, 37.80, 37.80, 37.80]),
    ("poster-a1", DesignKind::Poster, 2245.04, 3178.58, [37.80, 37.80, 37.80, 37.80]),
    ("poster-a2", DesignKind::Poster, 1587.40, 2245.04, [30.24, 30.24, 30.24, 30.24]),
    ("poster-a3", DesignKind::Poster, 1122.52, 1587.40, [18.90, 18.90, 18.90, 18.90]),
    ("poster-a4", DesignKind::Poster, 793.70, 1122.52, [18.90, 18.90, 18.90, 18.90]),
    ("poster-tabloid", DesignKind::Poster, 1056.00, 1632.00, [24.00, 24.00, 24.00, 24.00]),
    ("poster-18x24", DesignKind::Poster, 1728.00, 2304.00, [48.00, 48.00, 48.00, 48.00]),
    ("poster-24x36", DesignKind::Poster, 2304.00, 3456.00, [48.00, 48.00, 48.00, 48.00]),
    ("flyer-a4", DesignKind::Flyer, 793.70, 1122.52, [18.90, 18.90, 18.90, 18.90]),
    ("flyer-a5", DesignKind::Flyer, 559.37, 793.70, [18.90, 18.90, 18.90, 18.90]),
    ("flyer-a6", DesignKind::Flyer, 396.85, 559.37, [15.12, 15.12, 15.12, 15.12]),
    ("flyer-dl", DesignKind::Flyer, 374.17, 793.70, [15.12, 15.12, 15.12, 15.12]),
    ("flyer-letter", DesignKind::Flyer, 816.00, 1056.00, [24.00, 24.00, 24.00, 24.00]),
    ("flyer-half-letter", DesignKind::Flyer, 528.00, 816.00, [24.00, 24.00, 24.00, 24.00]),
    ("flyer-legal", DesignKind::Flyer, 816.00, 1344.00, [24.00, 24.00, 24.00, 24.00]),
    ("rack-card", DesignKind::Flyer, 384.00, 864.00, [12.00, 12.00, 12.00, 12.00]),
    ("brochure-trifold", DesignKind::Flyer, 1056.00, 816.00, [24.00, 24.00, 24.00, 24.00]),
    ("rollup-banner", DesignKind::Banner, 3212.60, 7559.06, [113.39, 113.39, 113.39, 113.39]),
    ("business-card-us", DesignKind::BusinessCard, 336.00, 192.00, [12.00, 12.00, 12.00, 12.00]),
    ("business-card-us-vertical", DesignKind::BusinessCard, 192.00, 336.00, [12.00, 12.00, 12.00, 12.00]),
    ("business-card-eu", DesignKind::BusinessCard, 321.26, 207.87, [11.34, 11.34, 11.34, 11.34]),
    ("business-card-jp", DesignKind::BusinessCard, 343.94, 207.87, [11.34, 11.34, 11.34, 11.34]),
    ("document-a4", DesignKind::Document, 793.70, 1122.52, [75.59, 75.59, 75.59, 75.59]),
    ("document-letter", DesignKind::Document, 816.00, 1056.00, [72.00, 72.00, 72.00, 72.00]),
    ("resume-a4", DesignKind::Resume, 793.70, 1122.52, [56.69, 56.69, 56.69, 56.69]),
    ("resume-letter", DesignKind::Resume, 816.00, 1056.00, [48.00, 48.00, 48.00, 48.00]),
    ("newsletter-a4", DesignKind::Newsletter, 793.70, 1122.52, [45.35, 45.35, 45.35, 45.35]),
    ("newsletter-letter", DesignKind::Newsletter, 816.00, 1056.00, [48.00, 48.00, 48.00, 48.00]),
    ("invitation-5x7", DesignKind::Invitation, 480.00, 672.00, [24.00, 24.00, 24.00, 24.00]),
    ("invitation-square", DesignKind::Invitation, 528.00, 528.00, [24.00, 24.00, 24.00, 24.00]),
    ("invitation-a6", DesignKind::Invitation, 396.85, 559.37, [18.90, 18.90, 18.90, 18.90]),
    ("postcard", DesignKind::Invitation, 576.00, 384.00, [12.00, 12.00, 12.00, 12.00]),
    ("menu-a4", DesignKind::Menu, 793.70, 1122.52, [37.80, 37.80, 37.80, 37.80]),
    ("menu-letter", DesignKind::Menu, 816.00, 1056.00, [36.00, 36.00, 36.00, 36.00]),
    ("menu-legal", DesignKind::Menu, 816.00, 1344.00, [36.00, 36.00, 36.00, 36.00]),
    ("menu-tall", DesignKind::Menu, 408.00, 1056.00, [24.00, 24.00, 24.00, 24.00]),
    ("certificate-letter", DesignKind::Certificate, 1056.00, 816.00, [48.00, 48.00, 48.00, 48.00]),
    ("certificate-a4", DesignKind::Certificate, 1122.52, 793.70, [45.35, 45.35, 45.35, 45.35]),
    ("book-cover-6x9", DesignKind::BookCover, 576.00, 864.00, [24.00, 24.00, 24.00, 24.00]),
    ("book-cover-5x8", DesignKind::BookCover, 480.00, 768.00, [24.00, 24.00, 24.00, 24.00]),
    ("book-cover-5.5x8.5", DesignKind::BookCover, 528.00, 816.00, [24.00, 24.00, 24.00, 24.00]),
    ("sticker-3in", DesignKind::Sticker, 288.00, 288.00, [12.00, 12.00, 12.00, 12.00]),
    ("sticker-2in", DesignKind::Sticker, 192.00, 192.00, [6.00, 6.00, 6.00, 6.00]),
    ("label-4x6", DesignKind::Sticker, 384.00, 576.00, [12.00, 12.00, 12.00, 12.00]),
];

/// Whether the page is meant for print (physical unit or a bleed).
pub fn is_print(page: &PageNode) -> bool {
    page.unit != Unit::Px || page.bleed > 0.0
}

/// Safe-area insets of a page: the preset of the same size and kind, else the first preset of that size (the
/// TypeScript describe picks the first size match), else 4% of the shorter side.
pub fn safe_insets(kind: DesignKind, width: f64, height: f64) -> (Insets, &'static str) {
    let eq = |a: f64, b: f64| (a - b).abs() < 0.5;
    let sized = || {
        SAFE_AREA_PRESETS
            .iter()
            .filter(|p| eq(p.2, width) && eq(p.3, height))
    };
    if let Some(p) = sized().find(|p| p.1 == kind).or_else(|| sized().next()) {
        return (p.4, p.0);
    }
    let m = (width.min(height) * 0.04).round();
    ([m; 4], "default")
}

/// Smallest comfortably readable font size in px for text on this page.
///
/// Screen kinds scale with the page (a 1080 px post is viewed shrunk on a phone); print kinds use physical point
/// sizes (6 pt for cards and stickers, 7 pt for most print, larger for posters viewed from a distance).
pub fn min_text_size(kind: DesignKind, page: &PageNode) -> f64 {
    let short = page.base.width.min(page.base.height);
    let pt = 96.0 / 72.0;
    if is_print(page) {
        return match kind {
            DesignKind::BusinessCard | DesignKind::Sticker => 6.0 * pt,
            DesignKind::Poster | DesignKind::Banner => (7.0 * pt).max(short * 0.011),
            _ => 7.0 * pt,
        };
    }
    let size = match kind {
        DesignKind::Presentation => (short * 0.018).max(14.0),
        DesignKind::Story | DesignKind::Video => (short * 0.02).max(12.0),
        DesignKind::Thumbnail => (short * 0.03).max(14.0),
        DesignKind::Website
        | DesignKind::Document
        | DesignKind::Newsletter
        | DesignKind::Resume => 12.0,
        DesignKind::Whiteboard => 12.0,
        DesignKind::Logo => (short * 0.03).max(8.0),
        _ => (short * 0.016).round().max(10.0),
    };
    (size * 10.0).round() / 10.0
}

/// Target print resolution in dots per inch.
pub const PRINT_DPI: f64 = 300.0;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safe_area_lookup() {
        let (s, id) = safe_insets(DesignKind::Story, 1080.0, 1920.0);
        assert_eq!((s, id), ([250.0, 0.0, 250.0, 0.0], "instagram-story"));
        let (s, id) = safe_insets(DesignKind::Document, 793.7, 1122.52);
        assert_eq!((s[0], id), (75.59, "document-a4"));
        let (s, id) = safe_insets(DesignKind::SocialPost, 793.7, 1122.52);
        assert_eq!((s[0], id), (18.9, "poster-a4"));
        let (s, id) = safe_insets(DesignKind::SocialPost, 1080.0, 1080.0);
        assert_eq!((s, id), ([43.0; 4], "default"));
    }
}
