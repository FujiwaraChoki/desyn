//! Layout: metrics against known fonts, line heights, alignment, justification, lists, ellipsis, vertical
//! alignment, spacing, indent, decorations, tracking, case transforms, baseline shift, tabs.

mod common;

use common::*;
use desyn_core::model::{AutoResize, ListStyle, TextAlign, TextCase, TextDirection, VerticalAlign};
use desyn_text::content::{LineHeightSpec, ParagraphFormat, Span, TextContent};
use desyn_text::{DecorationKind, LayoutOptions, RunKind};

fn close(a: f64, b: f64) -> bool {
    (a - b).abs() < 1e-6
}

#[test]
fn metrics_match_font_tables() {
    let mut e = engine();
    // JetBrains Mono: every advance is 600/1000 em; hhea 1020 / -300, no gap.
    let l = lay(&mut e, &plain("HHHH", "JetBrains Mono", 10.0), None);
    assert!(close(l.content_width, 24.0), "{}", l.content_width);
    assert_eq!(l.runs[0].glyphs.len(), 4);
    for (i, g) in l.runs[0].glyphs.iter().enumerate() {
        assert!(close(g.x, 6.0 * i as f64) && close(g.advance, 6.0));
    }
    let line = &l.lines[0];
    assert!(close(line.ascent, 10.2) && close(line.descent, 3.0));
    // 120% line height with half-leading: (12 - 13.2) / 2 = -0.6 above the ascent.
    assert!(close(line.height, 12.0));
    assert!(close(line.baseline, 10.2 - 0.6));
    assert!(close(l.first_baseline, line.baseline));

    // Instrument Serif (static): H = 546 units.
    let l = lay(&mut e, &plain("HHH", "Instrument Serif", 100.0), None);
    assert!(close(l.content_width, 3.0 * 54.6), "{}", l.content_width);

    // Auto line height = ascent + descent + gap = 1.3 em for Instrument Serif.
    let mut c = plain("H", "Instrument Serif", 100.0);
    c.paragraph.line_height = LineHeightSpec::Auto;
    let l = lay(&mut e, &c, None);
    assert!(close(l.content_height, 130.0));
    assert!(close(l.first_baseline, 99.0));
    c.paragraph.line_height = LineHeightSpec::Px(50.0);
    let l = lay(&mut e, &c, None);
    assert!(close(l.content_height, 50.0));
}

#[test]
fn wrapping_alignment_and_widths() {
    let mut e = engine();
    let c = plain("aaaa bbbb cccc dddd", "JetBrains Mono", 10.0);
    // Each word is 24 px, a space 6 px: "aaaa bbbb" = 54 px fits 60.
    let l = lay(&mut e, &c, Some(60.0));
    assert_eq!(line_texts(&l), vec!["aaaa bbbb", "cccc dddd"]);
    assert!(close(l.lines[0].width, 54.0));
    assert!(close(l.width, 60.0));
    assert!(close(l.content_width, 54.0));
    for (align, x) in [
        (TextAlign::Left, 0.0),
        (TextAlign::Center, 3.0),
        (TextAlign::Right, 6.0),
    ] {
        let mut c2 = c.clone();
        c2.paragraph.align = align;
        let l = lay(&mut e, &c2, Some(60.0));
        assert!(close(l.lines[0].x, x), "{align:?}: {}", l.lines[0].x);
        assert!(close(l.runs[0].glyphs[0].x, x));
    }
    // Measured width re-laid at exactly that width does not wrap.
    let one = lay(&mut e, &c, None);
    let again = lay(&mut e, &c, Some(one.content_width));
    assert_eq!(again.lines.len(), 1);
    // A word longer than the line breaks inside the word.
    let l = lay(
        &mut e,
        &plain("abcdefghij", "JetBrains Mono", 10.0),
        Some(35.0),
    );
    assert_eq!(line_texts(&l), vec!["abcde", "fghij"]);
}

#[test]
fn justify_stretches_all_but_the_last_line() {
    let mut e = engine();
    let mut c = plain("aa bb cc dd ee ff gg hh ii", "JetBrains Mono", 10.0);
    c.paragraph.align = TextAlign::Justify;
    let l = lay(&mut e, &c, Some(100.0));
    assert!(l.lines.len() >= 2);
    for line in &l.lines[..l.lines.len() - 1] {
        assert!(
            close(line.width, 100.0),
            "justified line width {}",
            line.width
        );
        let run = &l.runs[line.runs.start];
        let last = run
            .glyphs
            .iter()
            .rfind(|g| !l.text[g.cluster..].starts_with(' '))
            .unwrap();
        assert!(close(last.x + last.advance, 100.0));
    }
    let last = l.lines.last().unwrap();
    assert!(last.width < 100.0 && close(last.x, 0.0));
}

#[test]
fn paragraphs_spacing_and_indent() {
    let mut e = engine();
    let mut c = plain("one\ntwo\n\nfour", "JetBrains Mono", 10.0);
    c.paragraph.space_after = 5.0;
    c.paragraph.space_before = 2.0;
    c.paragraph.indent = 12.0;
    let l = lay(&mut e, &c, Some(200.0));
    assert_eq!(l.lines.len(), 4);
    assert_eq!(l.paragraphs.len(), 4);
    assert!(close(l.lines[1].top - l.lines[0].top, 12.0 + 7.0));
    assert!(close(l.content_height, 4.0 * 12.0 + 3.0 * 7.0));
    assert!(close(l.lines[0].x, 12.0), "first-line indent");
    assert_eq!(l.lines[2].range, 8..8, "empty paragraph keeps a line");
    assert!(l.lines.iter().all(|line| line.ends_paragraph));
}

#[test]
fn lists_with_nesting_and_numbering() {
    let mut e = engine();
    let mut c = plain(
        "first\n\tnested\n\tnested two\nsecond\n\t\tdeep",
        "JetBrains Mono",
        10.0,
    );
    c.paragraph.list = ListStyle::Number;
    let l = lay(&mut e, &c, Some(300.0));
    let markers: Vec<String> = l
        .paragraphs
        .iter()
        .map(|p| p.marker.clone().unwrap())
        .collect();
    assert_eq!(markers, vec!["1.", "a.", "b.", "2.", "i."]);
    let levels: Vec<u8> = l.paragraphs.iter().map(|p| p.list_level).collect();
    assert_eq!(levels, vec![0, 1, 1, 0, 2]);
    // Gutter: 1.5 em per level; tabs are not drawn.
    assert!(close(l.lines[0].x, 15.0) && close(l.lines[1].x, 30.0) && close(l.lines[4].x, 45.0));
    assert_eq!(&l.text[l.lines[1].range.clone()], "nested");
    let marker_runs: Vec<_> = l
        .runs
        .iter()
        .filter(|r| r.kind == RunKind::ListMarker)
        .collect();
    assert_eq!(marker_runs.len(), 5);
    // Marker ends 0.4 em before the text.
    let m0 = marker_runs[0];
    assert!(close(m0.x + m0.width, 15.0 - 4.0));

    let mut b = plain("alpha\nbeta", "Inter", 20.0);
    b.paragraph.list = ListStyle::Bullet;
    b.paragraph.direction = TextDirection::Rtl;
    b.paragraph.align = TextAlign::Right;
    let l = lay(&mut e, &b, Some(300.0));
    assert_eq!(l.paragraphs[0].marker.as_deref(), Some("\u{2022}"));
    let marker = l
        .runs
        .iter()
        .find(|r| r.kind == RunKind::ListMarker)
        .unwrap();
    assert!(
        marker.x > l.lines[0].x + l.lines[0].width,
        "RTL markers sit on the right"
    );
    assert!(close(l.lines[0].x + l.lines[0].width, 300.0 - 30.0));
}

#[test]
fn max_lines_truncates_with_ellipsis() {
    let mut e = engine();
    let c = plain(
        "one two three four five six seven eight nine ten",
        "Inter",
        20.0,
    );
    let opts = LayoutOptions {
        width: Some(120.0),
        auto_resize: AutoResize::Height,
        max_lines: Some(2),
        ..Default::default()
    };
    let l = e.layout(&c, &opts);
    assert_eq!(l.lines.len(), 2);
    assert!(l.truncated && l.lines[1].ellipsis);
    let ell = l.runs.iter().find(|r| r.kind == RunKind::Ellipsis).unwrap();
    assert_eq!(ell.line, 1);
    assert!(ell.x + ell.width <= 120.0 + 1e-6);
    assert!(
        l.lines
            .iter()
            .all(|line| line.x + line.width <= 120.0 + 1e-6)
    );
    // Fits: no ellipsis.
    let l = e.layout(&plain("short", "Inter", 20.0), &opts);
    assert!(!l.truncated && !l.lines[0].ellipsis);
    // Truncation at a paragraph boundary also marks the cut.
    let l = e.layout(&plain("a\nb\nc", "Inter", 20.0), &opts);
    assert_eq!(l.lines.len(), 2);
    assert!(l.truncated && l.lines[1].ellipsis);
}

#[test]
fn vertical_alignment_and_overflow() {
    let mut e = engine();
    let c = plain("Hi", "JetBrains Mono", 10.0);
    for (va, top) in [
        (VerticalAlign::Top, 0.0),
        (VerticalAlign::Middle, 44.0),
        (VerticalAlign::Bottom, 88.0),
    ] {
        let opts = LayoutOptions {
            width: Some(50.0),
            height: Some(100.0),
            auto_resize: AutoResize::None,
            vertical_align: va,
            ..Default::default()
        };
        let l = e.layout(&c, &opts);
        assert!(close(l.content_top, top), "{va:?} {}", l.content_top);
        assert!(close(l.lines[0].top, top));
        assert!(close(l.height, 100.0) && close(l.width, 50.0));
        assert!(!l.overflows);
    }
    let opts = LayoutOptions {
        width: Some(10.0),
        height: Some(5.0),
        auto_resize: AutoResize::None,
        ..Default::default()
    };
    assert!(
        e.layout(&plain("long text here", "Inter", 20.0), &opts)
            .overflows
    );
}

#[test]
fn decorations_geometry() {
    let mut e = engine();
    let mut c = plain("Under", "JetBrains Mono", 100.0);
    c.spans[0].style.underline = true;
    c.spans[0].style.highlight = Some([255, 176, 46, 255]);
    let l = lay(&mut e, &c, None);
    let base = l.lines[0].baseline;
    let u = l
        .decorations
        .iter()
        .find(|d| d.kind == DecorationKind::Underline)
        .unwrap();
    // post.underlinePosition -155, thickness 50 (units of 1000).
    assert!(close(u.rect.y, base + 15.5) && close(u.rect.h, 5.0));
    assert!(close(u.rect.w, 300.0));
    let h = l
        .decorations
        .iter()
        .find(|d| d.kind == DecorationKind::Highlight)
        .unwrap();
    assert!(close(h.rect.y, l.lines[0].top) && close(h.rect.h, l.lines[0].height));
    assert_eq!(h.color, Some([255, 176, 46, 255]));
    c.spans[0].style.underline = false;
    c.spans[0].style.strikethrough = true;
    let l = lay(&mut e, &c, None);
    let s = l
        .decorations
        .iter()
        .find(|d| d.kind == DecorationKind::Strikethrough)
        .unwrap();
    // OS/2 strikeout position 320, size 50.
    assert!(close(s.rect.y, base - 32.0) && close(s.rect.h, 5.0));
}

/// Hanging spaces at soft wraps carry no decoration: underlines and highlights end at the last visible glyph and
/// stay inside the box for every alignment and direction.
#[test]
fn decorations_stop_at_hanging_whitespace() {
    let mut e = engine();
    for (text, family) in [
        ("alpha beta gamma delta epsilon zeta", "JetBrains Mono"),
        ("שלום עולם שלום עולם שלום עולם", "Noto Sans Hebrew"),
    ] {
        for align in [
            TextAlign::Left,
            TextAlign::Center,
            TextAlign::Right,
            TextAlign::Justify,
        ] {
            let mut c = plain(text, family, 20.0);
            c.paragraph.align = align;
            c.spans[0].style.underline = true;
            c.spans[0].style.highlight = Some([255, 176, 46, 255]);
            let w = 130.0;
            let l = lay(&mut e, &c, Some(w));
            assert!(l.lines.len() >= 3);
            for d in &l.decorations {
                let line = &l.lines[d.line];
                assert!(
                    d.rect.x >= line.x - 1e-6 && d.rect.x + d.rect.w <= line.x + line.width + 1e-6,
                    "{align:?} {text:?}: {:?} outside line {} + {}",
                    d.rect,
                    line.x,
                    line.width
                );
                assert!(d.rect.x >= -1e-6 && d.rect.x + d.rect.w <= w + 1e-6);
            }
        }
    }
}

/// A soft hyphen only breaks where the drawn hyphen still fits the line.
#[test]
fn soft_hyphen_break_leaves_room_for_the_hyphen() {
    let mut e = engine();
    // JetBrains Mono at 20 px: 12 px per cell.
    let c = plain("abcd\u{ad}efgh", "JetBrains Mono", 20.0);
    // Exactly "abcd" fits; "abcd-" does not, so the word breaks earlier (emergency) instead of overflowing.
    let l = lay(&mut e, &c, Some(48.0 + 6.0));
    for line in &l.lines {
        assert!(line.x + line.width <= 54.0 + 1e-6, "{line:?}");
    }
    // With room for the hyphen the soft hyphen is used.
    let l = lay(&mut e, &c, Some(60.0));
    assert!(l.lines[0].hyphenated);
    assert!(close(l.lines[0].width, 60.0));
}

#[test]
fn tracking_case_and_baseline_shift() {
    let mut e = engine();
    let mut c = plain("HHHH", "JetBrains Mono", 10.0);
    c.spans[0].style.letter_spacing = 0.1;
    let l = lay(&mut e, &c, None);
    assert!(close(l.content_width, 24.0 + 4.0));
    assert!(close(l.runs[0].glyphs[1].x, 7.0));
    // Cursive scripts ignore tracking.
    let mut a = plain("سلام", "Noto Sans Arabic", 20.0);
    let w0 = lay(&mut e, &a, None).content_width;
    a.spans[0].style.letter_spacing = 0.2;
    assert!(close(lay(&mut e, &a, None).content_width, w0));

    let mut c = plain("straße", "Inter", 20.0);
    c.spans[0].style.case = TextCase::Upper;
    let l = lay(&mut e, &c, None);
    assert_eq!(l.runs[0].glyphs.len(), 7, "ß uppercases to SS");
    assert_eq!(l.runs[0].glyphs[4].cluster, 4);
    assert_eq!(l.runs[0].glyphs[5].cluster, 4);
    let ss: Vec<_> = l.clusters.iter().filter(|c| c.range == (4..6)).collect();
    assert_eq!(ss.len(), 1, "one caret box for the expanded ß");
    let g = &l.runs[0].glyphs;
    assert!(close(ss[0].x0, g[4].x) && close(ss[0].x1, g[6].x));
    let mut t = plain("hello world", "Inter", 20.0);
    t.spans[0].style.case = TextCase::Title;
    let up = lay(&mut e, &t, None).content_width;
    assert!(up > lay(&mut e, &plain("hello world", "Inter", 20.0), None).content_width);

    let text = "x2";
    let mut c = TextContent::plain(text, style("Inter", 20.0), ParagraphFormat::default());
    let mut sup = style("Inter", 12.0);
    sup.baseline_shift = 8.0;
    c.spans = vec![
        Span {
            range: 0..1,
            style: style("Inter", 20.0),
        },
        Span {
            range: 1..2,
            style: sup,
        },
    ];
    let l = lay(&mut e, &c, None);
    let y0 = l.runs[0].glyphs[0].y;
    let y1 = l.runs[1].glyphs[0].y;
    assert!(close(y0 - y1, 8.0));
    assert!(close(l.runs[1].baseline, l.lines[0].baseline - 8.0));
}

#[test]
fn tabs_and_mixed_spans() {
    let mut e = engine();
    let l = lay(&mut e, &plain("a\tb", "JetBrains Mono", 10.0), None);
    assert!(close(l.content_width, 6.0 * 6.0), "tab = four spaces");
    // Clusters map back to source bytes: the tab is one caret stop.
    let tab_boxes: Vec<_> = l.clusters.iter().filter(|c| c.range == (1..2)).collect();
    assert_eq!(tab_boxes.len(), 1);
    assert!(close(tab_boxes[0].x1 - tab_boxes[0].x0, 24.0));

    let text = "Bold and regular";
    let mut bold = style("Inter", 20.0);
    bold.weight = 700.0;
    let c = TextContent {
        spans: vec![
            Span {
                range: 0..4,
                style: bold,
            },
            Span {
                range: 4..text.len(),
                style: style("Inter", 20.0),
            },
        ],
        ..TextContent::plain(text, style("Inter", 20.0), ParagraphFormat::default())
    };
    let l = lay(&mut e, &c, None);
    assert_eq!(l.runs.len(), 2);
    assert_eq!(l.runs[0].range, 0..4);
    assert!(close(l.runs[1].x, l.runs[0].x + l.runs[0].width));
}

#[test]
fn empty_text_has_one_line_and_a_baseline() {
    let mut e = engine();
    let l = lay(&mut e, &plain("", "Inter", 20.0), Some(100.0));
    assert_eq!(l.lines.len(), 1);
    assert!(close(l.content_height, 24.0));
    assert!(l.first_baseline > 0.0);
    assert!(l.runs.is_empty());
    let opts = LayoutOptions {
        max_lines: Some(0),
        ..LayoutOptions::wrapping(100.0)
    };
    let l = e.layout(&plain("text", "Inter", 20.0), &opts);
    assert!(l.lines.is_empty() && l.truncated && close(l.content_height, 0.0));
}

#[test]
fn no_fonts_falls_back_to_approximate_metrics() {
    let mut e = desyn_text::TextEngine::new();
    let l = lay(&mut e, &plain("Hello world", "Inter", 10.0), Some(1000.0));
    assert_eq!(l.lines.len(), 1);
    assert!(l.runs.is_empty());
    assert!(close(l.content_height, 12.0));
    assert!(l.content_width > 30.0 && l.content_width < 80.0);
    assert!(!l.clusters.is_empty(), "carets still work");
}
