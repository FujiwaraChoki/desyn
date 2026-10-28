//! Page-size presets, generated from `@desyn/schema` `PAGE_PRESETS` (`scripts/gen-presets.mjs`) so desktop and
//! web offer the same sizes.

use std::sync::OnceLock;

use desyn_core::model::DesignKind;
use serde::Deserialize;

/// One page-size preset.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Preset {
    /// Stable id (`instagram-post`, `a4-portrait`, ...).
    pub id: String,
    /// Human label.
    pub label: String,
    /// Design kind (`DesignKind` string).
    pub kind: String,
    /// `social`, `video`, `print`, `presentation`, `web`, `ads`, `other`.
    pub category: String,
    /// Platform name when the preset belongs to one.
    pub platform: Option<String>,
    /// Width in design px.
    pub width: f64,
    /// Height in design px.
    pub height: f64,
    /// Display unit.
    pub unit: String,
    /// Print bleed in px.
    pub bleed: f64,
}

impl Preset {
    /// Parsed design kind (`custom` when unknown).
    pub fn design_kind(&self) -> DesignKind {
        self.kind.parse().unwrap_or(DesignKind::Custom)
    }

    /// "1080 × 1080 px" (or the physical size for print units).
    pub fn size_label(&self) -> String {
        format_size(self.width, self.height, &self.unit)
    }
}

/// "W × H unit" with the conversion from design px (1 px = 1/96 in).
pub fn format_size(w: f64, h: f64, unit: &str) -> String {
    let (f, suffix) = match unit {
        "mm" => (25.4 / 96.0, "mm"),
        "in" => (1.0 / 96.0, "in"),
        "pt" => (72.0 / 96.0, "pt"),
        _ => (1.0, "px"),
    };
    let fmt = |v: f64| {
        let v = v * f;
        if (v - v.round()).abs() < 0.05 {
            format!("{}", v.round() as i64)
        } else {
            format!("{v:.1}")
        }
    };
    format!("{} × {} {suffix}", fmt(w), fmt(h))
}

/// Every preset, in the schema's order.
pub fn all() -> &'static [Preset] {
    static PRESETS: OnceLock<Vec<Preset>> = OnceLock::new();
    PRESETS.get_or_init(|| {
        serde_json::from_str(include_str!("../assets/presets.json"))
            .expect("assets/presets.json is valid")
    })
}

/// Preset by id.
pub fn get(id: &str) -> Option<&'static Preset> {
    all().iter().find(|p| p.id == id)
}

/// The presets shown first on the start screen.
pub fn featured() -> Vec<&'static Preset> {
    const IDS: [&str; 8] = [
        "instagram-post",
        "instagram-story",
        "presentation-16-9",
        "youtube-thumbnail",
        "document-a4",
        "poster-18x24",
        "flyer-letter",
        "business-card-us",
    ];
    let mut out: Vec<&Preset> = IDS.iter().filter_map(|id| get(id)).collect();
    // Fill with the first presets of other categories if some ids were renamed upstream.
    for p in all() {
        if out.len() >= 8 {
            break;
        }
        if !out.iter().any(|o| o.id == p.id || o.category == p.category) {
            out.push(p);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn presets_load() {
        assert!(all().len() > 100);
        let p = get("instagram-post").expect("instagram post");
        assert_eq!((p.width, p.height), (1080.0, 1080.0));
        assert_eq!(p.design_kind(), DesignKind::SocialPost);
        assert_eq!(featured().len(), 8);
        for p in all() {
            assert!(p.width > 0.0 && p.height > 0.0, "{}", p.id);
        }
    }

    #[test]
    fn formats_sizes() {
        assert_eq!(format_size(1080.0, 1080.0, "px"), "1080 × 1080 px");
        assert_eq!(format_size(793.7007874, 1122.519685, "mm"), "210 × 297 mm");
        assert_eq!(format_size(96.0 * 8.5, 96.0 * 11.0, "in"), "8.5 × 11 in");
    }
}
