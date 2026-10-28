//! Web fonts split into unicode-range subsets (one face per subset, same family): a character missing from the
//! matched face comes from the family's other faces before any other family.

mod common;

use common::*;
use desyn_text::content::{ParagraphFormat, SpanStyle, TextContent};
use desyn_text::{LayoutOptions, TextEngine};

const SERIF_ASCII: &[u8] = include_bytes!("fonts/InstrumentSerif-ascii.woff2");

#[test]
fn characters_missing_from_one_subset_come_from_the_same_family() {
    let mut e = TextEngine::new();
    // ASCII-only subset first (the face plain text matches), then an unrelated family that covers Latin-1 (what a
    // database scan would find first), then the family's Latin-1 file.
    e.add_font_as(SERIF_ASCII.to_vec(), "Web Serif").unwrap();
    let other = e.add_font_as(INTER.to_vec(), "Other").unwrap()[0];
    let full = e.add_font_as(SERIF.to_vec(), "Web Serif").unwrap()[0];
    let style = SpanStyle {
        families: vec!["Web Serif".into()],
        ..Default::default()
    };
    let laid = e.layout(
        &TextContent::plain("Café", style, ParagraphFormat::default()),
        &LayoutOptions::wrapping(400.0),
    );
    let accent = "Caf".len();
    let face_of = |byte: usize| {
        laid.runs
            .iter()
            .find(|r| r.glyphs.iter().any(|g| g.cluster == byte))
            .map(|r| r.face)
    };
    assert_eq!(
        face_of(accent),
        Some(full),
        "é comes from the family's Latin-1 subset"
    );
    assert_ne!(face_of(accent), Some(other));
    assert!(e.take_font_requests().is_empty());
}
