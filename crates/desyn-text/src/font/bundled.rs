//! The bundled OFL font set (see `fonts/README.md` for sources, versions and licenses).
//!
//! * feature `bundled`: Instrument Serif (regular, italic), Instrument Sans (variable wdth / wght, upright and
//!   italic), Inter (variable opsz / wght, upright and italic), JetBrains Mono (variable wght, upright and italic).
//! * feature `bundled-noto`: Noto Sans Arabic and Noto Sans Hebrew (variable) for right-to-left fallback.
//! * feature `bundled-emoji`: Noto Emoji (monochrome outline emoji, variable wght), so emoji render, export to
//!   SVG / PDF and convert to outlines without a color font.
//!
//! Without these features the list is empty and hosts register fonts themselves.

use super::db::{FontDb, FontError};
use super::face::FontId;

/// One embedded font file.
#[derive(Debug, Clone, Copy)]
pub struct BundledFont {
    /// File name under `crates/desyn-text/fonts/`.
    pub file: &'static str,
    /// Family name inside the file.
    pub family: &'static str,
    /// SFNT bytes.
    pub bytes: &'static [u8],
}

#[allow(unused_macros)] // unused when no bundled feature is enabled
macro_rules! font {
    ($file:literal, $family:literal) => {
        BundledFont {
            file: $file,
            family: $family,
            bytes: include_bytes!(concat!("../../fonts/", $file)),
        }
    };
}

#[cfg(feature = "bundled")]
const CORE: &[BundledFont] = &[
    font!("Inter-VF.ttf", "Inter"),
    font!("Inter-Italic-VF.ttf", "Inter"),
    font!("InstrumentSans-VF.ttf", "Instrument Sans"),
    font!("InstrumentSans-Italic-VF.ttf", "Instrument Sans"),
    font!("InstrumentSerif-Regular.ttf", "Instrument Serif"),
    font!("InstrumentSerif-Italic.ttf", "Instrument Serif"),
    font!("JetBrainsMono-VF.ttf", "JetBrains Mono"),
    font!("JetBrainsMono-Italic-VF.ttf", "JetBrains Mono"),
];
#[cfg(not(feature = "bundled"))]
const CORE: &[BundledFont] = &[];

#[cfg(feature = "bundled-noto")]
const NOTO: &[BundledFont] = &[
    font!("NotoSansArabic-VF.ttf", "Noto Sans Arabic"),
    font!("NotoSansHebrew-VF.ttf", "Noto Sans Hebrew"),
];
#[cfg(not(feature = "bundled-noto"))]
const NOTO: &[BundledFont] = &[];

#[cfg(feature = "bundled-emoji")]
const EMOJI: &[BundledFont] = &[font!("NotoEmoji-VF.ttf", "Noto Emoji")];
#[cfg(not(feature = "bundled-emoji"))]
const EMOJI: &[BundledFont] = &[];

/// Every font compiled in through the enabled features.
pub fn fonts() -> impl Iterator<Item = &'static BundledFont> {
    CORE.iter().chain(NOTO).chain(EMOJI)
}

/// Registers every compiled-in font (zero-copy). Returns the face ids.
pub fn register(db: &mut FontDb) -> Result<Vec<FontId>, FontError> {
    let mut ids = Vec::new();
    for f in fonts() {
        ids.extend(db.add_static_font(f.bytes)?);
    }
    Ok(ids)
}
