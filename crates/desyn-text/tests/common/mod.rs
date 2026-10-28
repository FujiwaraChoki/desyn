//! Shared test helpers: an engine with the repository's fonts registered (independent of cargo features).
#![allow(dead_code)]

use desyn_text::content::{ParagraphFormat, SpanStyle, TextContent};
use desyn_text::{LaidOutText, LayoutOptions, TextEngine};

pub const INTER: &[u8] = include_bytes!("../../fonts/Inter-VF.ttf");
pub const INTER_ITALIC: &[u8] = include_bytes!("../../fonts/Inter-Italic-VF.ttf");
pub const SERIF: &[u8] = include_bytes!("../../fonts/InstrumentSerif-Regular.ttf");
pub const SERIF_ITALIC: &[u8] = include_bytes!("../../fonts/InstrumentSerif-Italic.ttf");
pub const SANS: &[u8] = include_bytes!("../../fonts/InstrumentSans-VF.ttf");
pub const MONO: &[u8] = include_bytes!("../../fonts/JetBrainsMono-VF.ttf");
pub const ARABIC: &[u8] = include_bytes!("../../fonts/NotoSansArabic-VF.ttf");
pub const HEBREW: &[u8] = include_bytes!("../../fonts/NotoSansHebrew-VF.ttf");
pub const EMOJI: &[u8] = include_bytes!("../../fonts/NotoEmoji-VF.ttf");
pub const CJK: &[u8] = include_bytes!("../fonts/NotoSansSC-subset.ttf");
pub const COLOR_EMOJI: &[u8] = include_bytes!("../fonts/NotoColorEmoji-subset.ttf");

pub fn engine() -> TextEngine {
    let mut e = TextEngine::new();
    for bytes in [
        INTER,
        INTER_ITALIC,
        SERIF,
        SERIF_ITALIC,
        SANS,
        MONO,
        ARABIC,
        HEBREW,
        EMOJI,
        CJK,
        COLOR_EMOJI,
    ] {
        e.db_mut().add_static_font(bytes).expect("font registers");
    }
    e
}

pub fn style(family: &str, size: f64) -> SpanStyle {
    SpanStyle {
        families: vec![family.to_string()],
        size,
        ..SpanStyle::default()
    }
}

pub fn plain(text: &str, family: &str, size: f64) -> TextContent {
    TextContent::plain(text, style(family, size), ParagraphFormat::default())
}

pub fn lay(e: &mut TextEngine, c: &TextContent, width: Option<f64>) -> LaidOutText {
    let opts = match width {
        Some(w) => LayoutOptions::wrapping(w),
        None => LayoutOptions::default(),
    };
    e.layout(c, &opts)
}

/// Visible text of each line (source slices, trailing whitespace trimmed).
pub fn line_texts(l: &LaidOutText) -> Vec<String> {
    l.lines
        .iter()
        .map(|line| l.text[line.range.clone()].trim_end().to_string())
        .collect()
}
