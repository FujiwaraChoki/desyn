//! Text through the facade: layout records, UTF-16 caret geometry and movement, measuring, fonts.

mod common;

use common::*;
use desyn_ffi::{
    DesignPoint, Engine, EngineError, FontRequestReason, TextAffinity, TextMovement, TextPosition,
    TextRange,
};

const TEXT: &str = "text00000001";

fn pos(index: u32) -> TextPosition {
    TextPosition {
        index,
        affinity: TextAffinity::Downstream,
    }
}

fn utf16_len(s: &str) -> u32 {
    s.encode_utf16().count() as u32
}

#[test]
fn layout_record_describes_lines_in_utf16() {
    let engine = simple_engine();
    let layout = engine.text_layout(TEXT.into()).unwrap();
    assert_eq!(layout.text, "Hello wide world 👋 again");
    assert_eq!(layout.length, utf16_len(&layout.text));
    assert_eq!(layout.width, 150.0);
    // Wrapped into several lines inside 150 px at 24 px Inter.
    assert!(layout.lines.len() >= 2, "{:?}", layout.lines);
    assert_eq!(layout.lines[0].range.start, 0);
    assert_eq!(layout.lines.last().unwrap().range.end, layout.length);
    for pair in layout.lines.windows(2) {
        assert_eq!(pair[0].range.end, pair[1].range.start);
        assert!(pair[1].top > pair[0].top);
    }
    // Box at (220, 20), no rotation.
    assert_eq!((layout.transform.tx, layout.transform.ty), (220.0, 20.0));
    assert!(!layout.overflows && !layout.truncated);

    assert!(matches!(
        engine.text_layout("recta0000001".into()),
        Err(EngineError::NotText { .. })
    ));
    assert!(matches!(
        engine.text_layout("missing00000".into()),
        Err(EngineError::NodeNotFound { .. })
    ));
}

#[test]
fn caret_movement_steps_over_surrogate_pairs() {
    let engine = simple_engine();
    let text = engine.text_layout(TEXT.into()).unwrap().text;
    let wave = text.find('👋').unwrap();
    let before = utf16_len(&text[..wave]);
    let after = engine
        .text_move(
            TEXT.into(),
            pos(before),
            TextMovement::GraphemeForward,
            None,
        )
        .unwrap();
    assert_eq!(
        after.index,
        before + 2,
        "the emoji is one grapheme, two UTF-16 units"
    );
    let back = engine
        .text_move(TEXT.into(), after, TextMovement::GraphemeBackward, None)
        .unwrap();
    assert_eq!(back.index, before);
    // An offset inside the surrogate pair rounds down.
    let inside = engine.text_caret(TEXT.into(), pos(before + 1)).unwrap();
    let at = engine.text_caret(TEXT.into(), pos(before)).unwrap();
    assert_eq!(inside, at);

    let word = engine.text_word_range(TEXT.into(), 1).unwrap();
    assert_eq!(word, TextRange { start: 0, end: 5 });
    let next_word = engine
        .text_move(TEXT.into(), pos(0), TextMovement::WordForward, None)
        .unwrap();
    assert_eq!(next_word.index, 5);
    let para = engine.text_paragraph_range(TEXT.into(), 3).unwrap();
    assert_eq!(
        para,
        TextRange {
            start: 0,
            end: utf16_len(&text)
        }
    );

    let line = engine.text_line_range(TEXT.into(), pos(0)).unwrap();
    assert_eq!(line.start, 0);
    let end = engine
        .text_move(TEXT.into(), pos(0), TextMovement::LineEnd, None)
        .unwrap();
    assert_eq!(end.index, line.end);
    assert_eq!(end.affinity, TextAffinity::Upstream);
    let start = engine
        .text_move(TEXT.into(), end, TextMovement::LineStart, None)
        .unwrap();
    assert_eq!(start.index, 0);

    // Down then up returns to the first line.
    let down = engine
        .text_move(TEXT.into(), pos(2), TextMovement::Down, None)
        .unwrap();
    assert!(down.index > line.end.saturating_sub(1));
    let up = engine
        .text_move(TEXT.into(), down, TextMovement::Up, None)
        .unwrap();
    assert!(up.index <= line.end);
    let right = engine
        .text_move(TEXT.into(), pos(0), TextMovement::Right, None)
        .unwrap();
    assert_eq!(right.index, 1);
    let left = engine
        .text_move(TEXT.into(), right, TextMovement::Left, None)
        .unwrap();
    assert_eq!(left.index, 0);
}

#[test]
fn hit_testing_and_selection_geometry() {
    let engine = simple_engine();
    let layout = engine.text_layout(TEXT.into()).unwrap();
    // Left of the first glyph in page coordinates.
    let first = engine
        .text_hit_test(
            TEXT.into(),
            DesignPoint {
                x: 220.0 + 1.0,
                y: 20.0 + layout.lines[0].baseline,
            },
        )
        .unwrap();
    assert_eq!(first.index, 0);
    // Below the last line: end of the text.
    let last = engine
        .text_hit_test(
            TEXT.into(),
            DesignPoint {
                x: 220.0 + 149.0,
                y: 20.0 + layout.height + 50.0,
            },
        )
        .unwrap();
    assert_eq!(last.index, layout.length);

    let caret = engine.text_caret(TEXT.into(), pos(0)).unwrap();
    assert_eq!(caret.line, 0);
    assert!(caret.height > 0.0);
    let rects = engine
        .text_selection_rects(
            TEXT.into(),
            TextRange {
                start: 0,
                end: layout.length,
            },
        )
        .unwrap();
    assert_eq!(rects.len(), layout.lines.len());
    // Reversed ranges select the same text.
    let reversed = engine
        .text_selection_rects(
            TEXT.into(),
            TextRange {
                start: layout.length,
                end: 0,
            },
        )
        .unwrap();
    assert_eq!(rects, reversed);
}

#[test]
fn layout_follows_edits() {
    let engine = simple_engine();
    let before = engine.text_layout(TEXT.into()).unwrap();
    engine
        .apply_transaction(
            tx("txtext000001", serde_json::json!([{ "op": "update", "id": TEXT, "set": { "runs": [{ "text": "Hi" }] } }])),
            true,
        )
        .unwrap();
    let after = engine.text_layout(TEXT.into()).unwrap();
    assert_eq!(after.text, "Hi");
    assert_eq!(after.lines.len(), 1);
    assert!(after.height < before.height);
}

#[test]
fn measure_accepts_the_worker_body() {
    let engine = simple_engine();
    let style = serde_json::json!({
        "fontFamily": "Inter", "fontWeight": 400, "fontStyle": "normal", "fontSize": 20,
        "fills": [{ "type": "solid", "color": "#111111" }], "letterSpacing": 0, "textCase": "none",
        "decoration": "none"
    });
    let paragraph = serde_json::json!({
        "align": "left", "direction": "ltr", "lineHeight": { "unit": "percent", "value": 120 },
        "spacing": 0, "indent": 0, "list": "none"
    });
    let body = serde_json::json!({ "items": [
        { "text": [{ "text": "One line" }], "style": style, "paragraph": paragraph },
        { "text": [{ "text": "A much longer sentence that has to wrap" }], "style": style, "paragraph": paragraph, "width": 120 }
    ]});
    let sizes = engine.measure(body.to_string()).unwrap();
    assert_eq!(sizes.len(), 2);
    assert_eq!(sizes[0].lines, 1);
    assert!((sizes[0].height - 24.0).abs() < 0.01, "{:?}", sizes[0]);
    assert!(
        sizes[1].lines >= 3 && sizes[1].width <= 120.0,
        "{:?}",
        sizes[1]
    );
    let bare = serde_json::json!([{ "text": [{ "text": "One line" }], "style": style, "paragraph": paragraph }]);
    assert_eq!(engine.measure(bare.to_string()).unwrap()[0], sizes[0]);
    // Measuring needs no design.
    assert_eq!(Engine::new().measure(body.to_string()).unwrap(), sizes);
    assert!(matches!(
        engine.measure("{}".into()),
        Err(EngineError::InvalidJson { .. })
    ));
}

#[test]
fn fonts_register_and_missing_families_are_requested() {
    let engine = Engine::with_options(false, 64);
    assert!(engine.font_families().is_empty());
    let bytes = std::fs::read(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../desyn-text/fonts/InstrumentSerif-Regular.ttf"),
    )
    .unwrap();
    let faces = engine.set_font(bytes, Some("Brand Serif".into())).unwrap();
    assert_eq!(faces.len(), 1);
    assert_eq!(faces[0].family, "Brand Serif");
    assert!(!faces[0].italic);
    assert_eq!(faces[0].weight, 400.0);
    assert_eq!(engine.font_families(), ["Brand Serif"]);
    assert!(matches!(
        engine.set_font(vec![1, 2, 3], None),
        Err(EngineError::Font { .. })
    ));

    // Text asking for a family nobody registered produces a request after layout.
    let mut design = simple_design();
    if let Some(desyn_core::model::Node::Text(t)) = design.nodes.get_mut(TEXT) {
        t.style.font_family = "Playfair Display".into();
    }
    engine.load(design.to_json(), false).unwrap();
    engine.text_layout(TEXT.into()).unwrap();
    let requests = engine.take_font_requests();
    assert!(
        requests
            .iter()
            .any(|r| r.family == "Playfair Display" && r.reason == FontRequestReason::Family),
        "{requests:?}"
    );
    assert!(engine.take_font_requests().is_empty());
}

#[test]
fn bundled_fonts_are_available_by_default() {
    let families = Engine::new().font_families();
    for f in [
        "Inter",
        "Instrument Sans",
        "Instrument Serif",
        "JetBrains Mono",
    ] {
        assert!(
            families.iter().any(|x| x == f),
            "{f} missing from {families:?}"
        );
    }
}
