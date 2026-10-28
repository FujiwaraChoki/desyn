//! Caret / selection geometry and navigation round trips (LTR, RTL, mixed, wrapped, multi-paragraph).

mod common;

use common::*;
use desyn_text::{Affinity, LaidOutText, Movement, TextPosition};
use unicode_segmentation::UnicodeSegmentation;

fn boundaries(text: &str) -> Vec<usize> {
    let mut b: Vec<usize> = text.grapheme_indices(true).map(|(i, _)| i).collect();
    b.push(text.len());
    b
}

/// Every grapheme boundary: caret -> hit test at the caret returns the same index.
fn assert_round_trip(l: &LaidOutText) {
    for idx in boundaries(&l.text) {
        for affinity in [Affinity::Downstream, Affinity::Upstream] {
            let pos = TextPosition {
                index: idx,
                affinity,
            };
            let caret = l.caret_rect(pos);
            let hit = l.hit_test_point(caret.x, caret.y + caret.height / 2.0);
            let same_line_end =
                l.lines[caret.line].range.end == idx || l.lines[caret.line].range.start == idx;
            // At a bidi boundary two indices share an x; accept either neighbour only there.
            if hit.index != idx {
                let alt = l.caret_rect(hit);
                assert!(
                    (alt.x - caret.x).abs() < 1e-6 && alt.line == caret.line,
                    "index {idx} ({affinity:?}) caret x {:.2} hit {} (x {:.2}) in {:?}",
                    caret.x,
                    hit.index,
                    alt.x,
                    l.text
                );
            } else if same_line_end {
                assert_eq!(l.caret_rect(hit).line, caret.line);
            }
        }
    }
}

#[test]
fn ltr_wrapped_round_trip_and_affinity() {
    let mut e = engine();
    let l = lay(
        &mut e,
        &plain("The quick brown fox jumps over the lazy dog", "Inter", 20.0),
        Some(120.0),
    );
    assert!(l.lines.len() >= 3);
    assert_round_trip(&l);
    // The soft wrap boundary has two carets.
    let b = l.lines[1].range.start;
    let up = l.caret_rect(TextPosition {
        index: b,
        affinity: Affinity::Upstream,
    });
    let down = l.caret_rect(TextPosition {
        index: b,
        affinity: Affinity::Downstream,
    });
    assert_eq!(up.line, 0);
    assert_eq!(down.line, 1);
    assert!(down.x.abs() < 1e-6);
    // Clicking far right on line 0 gives its end with upstream affinity.
    let hit = l.hit_test_point(1000.0, l.lines[0].baseline);
    assert_eq!(
        hit,
        TextPosition {
            index: b,
            affinity: Affinity::Upstream
        }
    );
    let hit = l.hit_test_point(-10.0, l.lines[1].baseline);
    assert_eq!(hit.index, b);
    // Above / below the text clamps to the first / last line.
    assert_eq!(l.hit_test_point(-5.0, -50.0).index, 0);
    assert_eq!(l.hit_test_point(1e6, 1e6).index, l.text.len());
}

#[test]
fn rtl_and_mixed_round_trip() {
    let mut e = engine();
    for text in [
        "שלום עולם יפה",
        "مرحبا بالعالم",
        "abc אבג דהו xyz",
        "שלום world 123 עולם",
    ] {
        let l = lay(&mut e, &plain(text, "Inter", 22.0), None);
        assert_round_trip(&l);
    }
    // In RTL text the caret at index 0 sits at the right edge.
    let l = lay(&mut e, &plain("שלום", "Inter", 22.0), None);
    let c0 = l.caret_rect(TextPosition::new(0));
    let cend = l.caret_rect(TextPosition::new(l.text.len()));
    assert!(c0.x > cend.x);
    assert!((c0.x - (l.lines[0].x + l.lines[0].width)).abs() < 1e-6);
    assert!(c0.rtl);
}

#[test]
fn selection_rectangles() {
    let mut e = engine();
    let l = lay(
        &mut e,
        &plain("aaaa bbbb\ncccc", "JetBrains Mono", 10.0),
        Some(1000.0),
    );
    let r = l.selection_rects(0..4);
    assert_eq!(r.len(), 1);
    assert!(r[0].x.abs() < 1e-6 && (r[0].w - 24.0).abs() < 1e-6);
    assert!((r[0].h - l.lines[0].height).abs() < 1e-6);
    // Across the paragraph break: line 0 plus a newline marker, and line 1.
    let r = l.selection_rects(5..12);
    assert_eq!(r.len(), 2);
    assert!(
        r[0].x + 1e-6 >= 30.0 && r[0].x + r[0].w > 54.0,
        "newline marker extends past the text"
    );
    assert!((r[1].y - l.lines[1].top).abs() < 1e-6);
    // Reversed ranges work; empty ranges give nothing.
    // Anchor after focus (a backwards drag) gives the same rectangles.
    let (anchor, focus) = (12, 5);
    assert_eq!(l.selection_rects(anchor..focus), r);
    assert!(l.selection_rects(3..3).is_empty());
    // Mixed direction: a logical range can be visually discontiguous.
    let text = "abc אבג xyz";
    let l = lay(&mut e, &plain(text, "Inter", 20.0), None);
    let start = text.find('ב').unwrap();
    let r = l.selection_rects(2..start);
    assert_eq!(r.len(), 2, "{r:?}");
}

#[test]
fn word_line_paragraph_boundaries() {
    let mut e = engine();
    let text = "Hello, wide world.\nSecond para";
    let l = lay(&mut e, &plain(text, "Inter", 20.0), Some(90.0));
    assert_eq!(l.word_range(1), 0..5);
    assert_eq!(l.word_range(5), 0..5, "end of a word selects the word");
    assert_eq!(&text[l.word_range(9)], "wide");
    assert_eq!(l.next_word_boundary(0), 5);
    assert_eq!(l.next_word_boundary(5), 11);
    assert_eq!(l.prev_word_boundary(11), 7);
    assert_eq!(l.prev_word_boundary(7), 0);
    assert_eq!(l.paragraph_range(3), 0..18);
    assert_eq!(l.paragraph_range(22), 19..text.len());
    let line = l.line_range(TextPosition::new(1));
    assert_eq!(line.start, 0);
    assert!(line.end < 18);
    assert_eq!(l.next_grapheme(0), 1);
    assert_eq!(l.prev_grapheme(1), 0);
    let emoji = lay(&mut e, &plain("a👍🏽b", "Inter", 20.0), None);
    assert_eq!(emoji.next_grapheme(1), 1 + "👍🏽".len());
    assert_eq!(emoji.prev_grapheme(1 + "👍🏽".len()), 1);
}

#[test]
fn visual_and_vertical_movement() {
    let mut e = engine();
    let l = lay(&mut e, &plain("abc def", "Inter", 20.0), None);
    let mut pos = TextPosition::new(0);
    let mut seen = vec![0];
    for _ in 0..7 {
        pos = l.move_visual(pos, Movement::Right);
        seen.push(pos.index);
    }
    assert_eq!(seen, vec![0, 1, 2, 3, 4, 5, 6, 7]);
    assert_eq!(
        l.move_visual(pos, Movement::Right).index,
        7,
        "stays at the end"
    );
    // RTL: moving right walks towards the logical start.
    let text = "אבג";
    let l = lay(&mut e, &plain(text, "Inter", 20.0), None);
    let end = TextPosition::new(text.len());
    let step = l.move_visual(end, Movement::Right);
    assert_eq!(step.index, text.len() - 'ג'.len_utf8());
    // Vertical movement keeps x.
    let l = lay(
        &mut e,
        &plain("aaaa aaaa aaaa", "JetBrains Mono", 10.0),
        Some(30.0),
    );
    let p = TextPosition::new(2);
    let down = l.move_vertical(p, 1, None);
    assert_eq!(down.index, 7);
    assert_eq!(l.move_vertical(down, -1, None).index, 2);
    assert_eq!(l.move_vertical(p, -1, None).index, 0);
    assert_eq!(l.move_vertical(p, 10, None).index, l.text.len());
}

#[test]
fn utf16_indices_for_web_hosts() {
    let text = "a😀b";
    assert_eq!(desyn_text::utf8_to_utf16(text, 5), 3);
    assert_eq!(desyn_text::utf16_to_utf8(text, 3), 5);
}
