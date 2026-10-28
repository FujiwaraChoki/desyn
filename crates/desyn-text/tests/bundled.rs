//! The bundled font set (`--features bundled,bundled-noto,bundled-emoji`).
#![cfg(all(
    feature = "bundled",
    feature = "bundled-noto",
    feature = "bundled-emoji"
))]

use desyn_text::content::{ParagraphFormat, SpanStyle, TextContent};
use desyn_text::font::bundled;
use desyn_text::{LayoutOptions, TextEngine};

#[test]
fn bundled_families_register_and_cover_the_design_system() {
    let e = TextEngine::with_bundled_fonts();
    let families: Vec<String> = e.db().families().into_iter().map(|f| f.name).collect();
    for f in [
        "Inter",
        "Instrument Sans",
        "Instrument Serif",
        "JetBrains Mono",
        "Noto Sans Arabic",
        "Noto Sans Hebrew",
        "Noto Emoji",
    ] {
        assert!(families.iter().any(|x| x == f), "{f} missing: {families:?}");
    }
    assert_eq!(bundled::fonts().count(), 11);
    assert_eq!(e.db().len(), 11);
}

#[test]
fn generic_families_and_mixed_scripts_render_without_requests() {
    let mut e = TextEngine::with_bundled_fonts();
    for (family, expect) in [
        ("serif", "Instrument Serif"),
        ("sans-serif", "Inter"),
        ("monospace", "JetBrains Mono"),
    ] {
        let c = TextContent::plain(
            "Desyn",
            SpanStyle {
                families: vec![family.into()],
                ..SpanStyle::default()
            },
            ParagraphFormat::default(),
        );
        let l = e.layout(&c, &LayoutOptions::default());
        assert_eq!(e.db().face(l.runs[0].face).unwrap().family, expect);
    }
    let c = TextContent::plain(
        "Hello שלום مرحبا 😀",
        SpanStyle {
            families: vec!["Instrument Sans".into()],
            ..SpanStyle::default()
        },
        ParagraphFormat::default(),
    );
    let l = e.layout(&c, &LayoutOptions::default());
    let fams: Vec<String> = l
        .runs
        .iter()
        .map(|r| e.db().face(r.face).unwrap().family.clone())
        .collect();
    assert!(fams.contains(&"Noto Sans Hebrew".to_string()));
    assert!(fams.contains(&"Noto Sans Arabic".to_string()));
    assert!(fams.contains(&"Noto Emoji".to_string()));
    assert!(e.font_requests().is_empty(), "{:?}", e.font_requests());
}
