//! Embedded assets: Lucide icons (`icons/<name>.svg`) and the UI fonts (Instrument Sans / Serif, JetBrains Mono,
//! all SIL OFL; licenses in `assets/fonts/licenses`).

use std::borrow::Cow;

use gpui::{App, AssetSource, SharedString};

include!(concat!(env!("OUT_DIR"), "/icons.rs"));

/// Asset source for GPUI (`svg().path("icons/x.svg")`).
pub struct Assets;

impl AssetSource for Assets {
    fn load(&self, path: &str) -> gpui::Result<Option<Cow<'static, [u8]>>> {
        Ok(ICONS
            .iter()
            .find(|(p, _)| *p == path)
            .map(|(_, b)| Cow::Borrowed(*b)))
    }

    fn list(&self, path: &str) -> gpui::Result<Vec<SharedString>> {
        Ok(ICONS
            .iter()
            .filter(|(p, _)| p.starts_with(path))
            .map(|(p, _)| SharedString::from(*p))
            .collect())
    }
}

/// UI font files.
pub const FONTS: [&[u8]; 5] = [
    include_bytes!("../../assets/fonts/InstrumentSans-VF.ttf"),
    include_bytes!("../../assets/fonts/InstrumentSans-Italic-VF.ttf"),
    include_bytes!("../../assets/fonts/InstrumentSerif-Regular.ttf"),
    include_bytes!("../../assets/fonts/InstrumentSerif-Italic.ttf"),
    include_bytes!("../../assets/fonts/JetBrainsMono-VF.ttf"),
];

/// Registers the UI fonts with GPUI's text system.
pub fn load_fonts(cx: &App) {
    let fonts = FONTS.iter().map(|b| Cow::Borrowed(*b)).collect();
    if let Err(e) = cx.text_system().add_fonts(fonts) {
        log::error!("fonts: {e:#}");
    }
}

/// Whether an icon exists (tests and debug assertions).
pub fn has_icon(path: &str) -> bool {
    ICONS.iter().any(|(p, _)| *p == path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn icons_are_embedded() {
        assert!(ICONS.len() > 90);
        assert!(has_icon("icons/pen-tool.svg"));
        for t in crate::canvas::Tool::ALL {
            assert!(has_icon(t.icon()), "{}", t.icon());
        }
        let (_, bytes) = ICONS[0];
        assert!(std::str::from_utf8(bytes).unwrap().starts_with("<svg"));
    }
}
