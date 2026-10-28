//! Randomized robustness: arbitrary mixed-script text, styles and options must lay out without panics and keep
//! the output geometry consistent (finite numbers, caret round trips on char boundaries, measurement equal to
//! layout).

mod common;

use common::*;
use desyn_core::model::{AutoResize, ListStyle, TextAlign, TextCase, TextDirection, VerticalAlign};
use desyn_text::content::{LineHeightSpec, ParagraphFormat, Span, SpanStyle, TextContent};
use desyn_text::{Affinity, LayoutOptions, Movement, TextPosition};

/// xorshift64*: deterministic, dependency free.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_f491_4f6c_dd1d)
    }
    fn below(&mut self, n: usize) -> usize {
        (self.next() % n as u64) as usize
    }
    fn f(&mut self, lo: f64, hi: f64) -> f64 {
        lo + (self.next() >> 11) as f64 / (1u64 << 53) as f64 * (hi - lo)
    }
}

const PIECES: &[&str] = &[
    "hello",
    "world",
    " ",
    "  ",
    "\n",
    "\t",
    "\r\n",
    "\u{2029}",
    "\u{2028}",
    "\u{ad}",
    "\u{200b}",
    "\u{a0}",
    "مرحبا",
    "بالعالم",
    "שלום",
    "עולם",
    "中文",
    "漢字。",
    "「引用」",
    "日本語",
    "😀",
    "👩‍💻",
    "❤️",
    "👍🏽",
    "e\u{301}",
    "ﬁ",
    "123",
    "-",
    "—",
    ".",
    "!",
    "(",
    ")",
    "Straße",
    "x",
    "WWWWWWWWWWWWWWWWWWWW",
    "\u{202e}",
    "\u{2066}",
    "\u{2069}",
    "a\u{300}\u{301}\u{302}",
    "\u{feff}",
    "ǅ",
    "İ",
];

fn random_text(rng: &mut Rng) -> String {
    let n = rng.below(24);
    (0..n).map(|_| PIECES[rng.below(PIECES.len())]).collect()
}

fn random_style(rng: &mut Rng) -> SpanStyle {
    let families = [
        "Inter",
        "Instrument Serif",
        "JetBrains Mono",
        "Noto Sans Arabic",
        "Missing Family",
        "sans-serif",
    ];
    SpanStyle {
        families: vec![families[rng.below(families.len())].to_string()],
        weight: [100.0, 400.0, 700.0, 950.0][rng.below(4)],
        italic: rng.below(3) == 0,
        size: [0.0, 1.0, 12.0, 24.0, 96.0][rng.below(5)],
        letter_spacing: rng.f(-0.2, 0.5),
        word_spacing: rng.f(0.0, 0.3),
        case: [
            TextCase::None,
            TextCase::Upper,
            TextCase::Lower,
            TextCase::Title,
        ][rng.below(4)],
        underline: rng.below(3) == 0,
        strikethrough: rng.below(5) == 0,
        highlight: (rng.below(4) == 0).then_some([255, 176, 46, 255]),
        baseline_shift: [0.0, 0.0, 4.0, -3.0][rng.below(4)],
        ..SpanStyle::default()
    }
}

fn random_content(rng: &mut Rng) -> TextContent {
    let text = random_text(rng);
    let mut spans = Vec::new();
    let mut i = 0;
    while i < text.len() {
        let mut end = (i + 1 + rng.below(12)).min(text.len());
        while !text.is_char_boundary(end) {
            end += 1;
        }
        spans.push(Span {
            range: i..end,
            style: random_style(rng),
        });
        i = end;
    }
    let paragraph = ParagraphFormat {
        align: [
            TextAlign::Left,
            TextAlign::Center,
            TextAlign::Right,
            TextAlign::Justify,
        ][rng.below(4)],
        direction: [TextDirection::Ltr, TextDirection::Rtl, TextDirection::Auto][rng.below(3)],
        line_height: [
            LineHeightSpec::Auto,
            LineHeightSpec::Px(20.0),
            LineHeightSpec::Percent(150.0),
            LineHeightSpec::Percent(0.0),
        ][rng.below(4)],
        space_before: rng.f(0.0, 10.0),
        space_after: rng.f(0.0, 10.0),
        indent: [0.0, 20.0, -10.0][rng.below(3)],
        list: [ListStyle::None, ListStyle::Bullet, ListStyle::Number][rng.below(3)],
        ..ParagraphFormat::default()
    };
    TextContent {
        default_style: random_style(rng),
        text,
        spans,
        paragraph,
        paragraph_overrides: Default::default(),
    }
}

fn random_options(rng: &mut Rng) -> LayoutOptions {
    LayoutOptions {
        width: [
            None,
            Some(0.0),
            Some(1.0),
            Some(37.5),
            Some(120.0),
            Some(600.0),
        ][rng.below(6)],
        height: [None, Some(0.0), Some(50.0), Some(400.0)][rng.below(4)],
        auto_resize: [AutoResize::None, AutoResize::Height, AutoResize::Width][rng.below(3)],
        max_lines: [None, None, Some(0), Some(1), Some(2), Some(5)][rng.below(6)],
        vertical_align: [
            VerticalAlign::Top,
            VerticalAlign::Middle,
            VerticalAlign::Bottom,
        ][rng.below(3)],
        hyphenate: false,
    }
}

fn finite(v: f64, what: &str, text: &str) {
    assert!(v.is_finite(), "{what} is not finite ({v}) for {text:?}");
}

#[test]
fn random_layouts_are_consistent() {
    let mut e = engine();
    let seed: u64 = std::env::var("ROBUST_SEED")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(0x9e37_79b9_7f4a_7c15);
    let mut rng = Rng(seed);
    let cases: usize = std::env::var("ROBUST_CASES")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(1500);
    for case in 0..cases {
        let content = random_content(&mut rng);
        let opts = random_options(&mut rng);
        let text = content.text.clone();
        let l = e.layout(&content, &opts);
        let m = e.measure_content(&content, &opts);
        assert!(
            (m.width - l.content_width).abs() < 1e-9 && (m.height - l.content_height).abs() < 1e-9,
            "case {case}: measure {m:?} != layout {} x {} for {text:?}",
            l.content_width,
            l.content_height
        );
        assert_eq!(m.lines as usize, l.lines.len(), "case {case}");
        if opts.max_lines != Some(0) {
            assert!(!l.lines.is_empty(), "case {case}: no lines for {text:?}");
        }
        for v in [
            l.width,
            l.height,
            l.content_width,
            l.content_height,
            l.content_top,
            l.first_baseline,
        ] {
            finite(v, "box", &text);
        }
        for line in &l.lines {
            for v in [line.top, line.height, line.baseline, line.x, line.width] {
                finite(v, "line", &text);
            }
            assert!(
                text.is_char_boundary(line.range.start) && text.is_char_boundary(line.range.end)
            );
            assert!(line.range.start <= line.range.end, "case {case}: {line:?}");
        }
        for run in &l.runs {
            for g in &run.glyphs {
                finite(g.x, "glyph x", &text);
                finite(g.y, "glyph y", &text);
                assert!(g.cluster <= text.len());
            }
        }
        for c in &l.clusters {
            assert!(c.x0 <= c.x1 + 1e-9, "case {case}: box {c:?}");
            assert!(text.is_char_boundary(c.range.start) && text.is_char_boundary(c.range.end));
        }
        // Caret / selection / navigation over every char boundary.
        let mut idx = 0;
        loop {
            for affinity in [Affinity::Upstream, Affinity::Downstream] {
                let pos = TextPosition {
                    index: idx,
                    affinity,
                };
                let caret = l.caret_rect(pos);
                finite(caret.x, "caret x", &text);
                finite(caret.y, "caret y", &text);
                let hit = l.hit_test_point(caret.x, caret.y + caret.height / 2.0);
                assert!(text.is_char_boundary(hit.index) && hit.index <= text.len());
                for dir in [Movement::Left, Movement::Right] {
                    let p = l.move_visual(pos, dir);
                    assert!(text.is_char_boundary(p.index) && p.index <= text.len());
                }
                for d in [-1, 1] {
                    let p = l.move_vertical(pos, d, None);
                    assert!(text.is_char_boundary(p.index) && p.index <= text.len());
                }
            }
            for r in l.selection_rects(idx..text.len()) {
                finite(r.x, "selection", &text);
                finite(r.w, "selection", &text);
            }
            let w = l.word_range(idx);
            assert!(w.start <= w.end && w.end <= text.len());
            if idx >= text.len() {
                break;
            }
            idx = l.next_grapheme(idx);
        }
        let _ = e.text_paths(&l);
    }
}

/// Lines never exceed the wrap width unless a single grapheme is wider than the box.
#[test]
fn wrapped_lines_fit_their_box() {
    let mut e = engine();
    let mut rng = Rng(42);
    let words = [
        "lorem",
        "ipsum",
        "dolor",
        "sit",
        "amet,",
        "consec\u{ad}tetur",
        "adi\u{ad}pisc\u{ad}ing",
        "elit.",
        "Sed",
        "do",
        "eius\u{ad}mod",
        "tempor",
        "WWWWWW",
        "—",
        "(paren)",
        "中文字",
        "مرحبا",
        "שלום",
        "😀",
    ];
    for case in 0..3000 {
        let n = 1 + rng.below(30);
        let text: Vec<&str> = (0..n).map(|_| words[rng.below(words.len())]).collect();
        let text = text.join(" ");
        let size = 8.0 + rng.f(0.0, 40.0);
        let mut content = plain(
            &text,
            ["Inter", "Instrument Serif", "JetBrains Mono"][rng.below(3)],
            size,
        );
        content.paragraph.list =
            [ListStyle::None, ListStyle::Bullet, ListStyle::Number][rng.below(3)];
        content.paragraph.indent = [0.0, 15.0][rng.below(2)];
        content.paragraph.direction =
            [TextDirection::Ltr, TextDirection::Rtl, TextDirection::Auto][rng.below(3)];
        content.spans[0].style.letter_spacing = rng.f(0.0, 0.2);
        // At least the list gutter plus indent plus a few glyphs.
        let w = rng.f(size * 3.0 + 15.0, 500.0);
        let mut opts = LayoutOptions::wrapping(w);
        opts.max_lines = [None, Some(1), Some(3)][rng.below(3)];
        let l = e.layout(&content, &opts);
        for line in &l.lines {
            if line.clusters.len() < 2 {
                continue;
            }
            assert!(
                line.x >= -1e-6 && line.x + line.width <= w + 1e-3,
                "case {case}: line {:?} at x {} width {} exceeds {w} in {text:?} ({:?} {:?} hyph {})",
                &l.text[line.range.clone()],
                line.x,
                line.width,
                content.paragraph,
                content.spans[0].style.size,
                line.hyphenated
            );
        }
    }
}
