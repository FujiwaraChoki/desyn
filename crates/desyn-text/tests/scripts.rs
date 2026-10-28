//! Bidi (Arabic, Hebrew), Arabic joining, CJK line breaking, emoji fallback, soft hyphens and hyphenation.

mod common;

use common::*;
use desyn_core::model::{TextAlign, TextDirection};
use desyn_text::{Hyphenator, LayoutOptions, RunKind, TextEngine};

#[test]
fn rtl_paragraph_detection_and_alignment() {
    let mut e = engine();
    let l = lay(&mut e, &plain("שלום עולם", "Inter", 20.0), Some(300.0));
    assert!(l.paragraphs[0].rtl && l.lines[0].rtl);
    assert_eq!(
        e.db().face(l.runs[0].face).unwrap().family,
        "Noto Sans Hebrew"
    );
    assert!(l.runs[0].rtl);
    // Default left alignment is visual: flush left even in RTL.
    assert!(l.lines[0].x.abs() < 1e-9);
    let mut c = plain("שלום עולם", "Inter", 20.0);
    c.paragraph.align = TextAlign::Right;
    let l = lay(&mut e, &c, Some(300.0));
    assert!((l.lines[0].x + l.lines[0].width - 300.0).abs() < 1e-6);
    // Forced LTR on Hebrew text still renders the Hebrew run right-to-left.
    c.paragraph.direction = TextDirection::Ltr;
    let l = lay(&mut e, &c, Some(300.0));
    assert!(!l.paragraphs[0].rtl && l.runs[0].rtl);
}

#[test]
fn mixed_direction_visual_order() {
    let mut e = engine();
    // LTR paragraph with an embedded Hebrew phrase: the Hebrew words are reversed as a block.
    let text = "abc אבג דהו xyz";
    let l = lay(&mut e, &plain(text, "Inter", 20.0), None);
    assert!(!l.paragraphs[0].rtl);
    let order: Vec<&str> = l.clusters.iter().map(|c| &text[c.range.clone()]).collect();
    // Visual left-to-right: abc, space, then the Hebrew block from its logical end, space, xyz.
    let joined: String = order.concat();
    assert_eq!(joined, "abc והד גבא xyz");
    // Runs alternate fonts / directions and tile the line without gaps.
    let mut x = 0.0;
    for r in &l.runs {
        assert!((r.x - x).abs() < 1e-6, "runs tile: {} vs {}", r.x, x);
        x = r.x + r.width;
    }
    // RTL paragraph with embedded English: English stays left-to-right inside the right-to-left flow.
    let text = "שלום world עולם";
    let l = lay(&mut e, &plain(text, "Inter", 20.0), None);
    assert!(l.paragraphs[0].rtl);
    let joined: String = l.clusters.iter().map(|c| &text[c.range.clone()]).collect();
    assert_eq!(joined, "םלוע world םולש");
}

#[test]
fn arabic_shapes_with_joining_forms() {
    let mut e = engine();
    let isolated = lay(&mut e, &plain("ب", "Noto Sans Arabic", 40.0), None);
    let joined = lay(&mut e, &plain("ببب", "Noto Sans Arabic", 40.0), None);
    let iso: Vec<u32> = isolated.runs[0].glyphs.iter().map(|g| g.id).collect();
    let ids: Vec<u32> = joined.runs[0].glyphs.iter().map(|g| g.id).collect();
    assert_ne!(
        ids,
        iso.repeat(3),
        "initial / medial / final forms differ from the isolated form"
    );
    // Visual order is right-to-left: the logically first letter is rightmost.
    let mean_x = |cluster: usize| {
        let xs: Vec<f64> = joined.runs[0]
            .glyphs
            .iter()
            .filter(|g| g.cluster == cluster)
            .map(|g| g.x)
            .collect();
        xs.iter().sum::<f64>() / xs.len() as f64
    };
    assert!(mean_x(0) > mean_x(2) && mean_x(2) > mean_x(4));

    // A line break inside an Arabic phrase reshapes both halves (no dangling joining forms at the break).
    let text = "مرحبا بالعالم مرحبا بالعالم";
    let wide = lay(&mut e, &plain(text, "Noto Sans Arabic", 30.0), None);
    let narrow = lay(
        &mut e,
        &plain(text, "Noto Sans Arabic", 30.0),
        Some(wide.content_width * 0.6),
    );
    assert!(narrow.lines.len() >= 2);
    assert!(narrow.lines.iter().all(|l| l.rtl));
}

#[test]
fn cjk_line_breaking_respects_punctuation() {
    let mut e = engine();
    let text = "中文文本排版需要正确的换行规则。标点符号不能出现在行首，例如逗号、句号和问号？";
    let l = lay(&mut e, &plain(text, "Inter", 20.0), Some(150.0));
    assert!(l.lines.len() > 3);
    let face = e.db().face(l.runs[0].face).unwrap();
    assert_eq!(
        face.family, "Noto Sans SC",
        "Han falls back to the CJK face"
    );
    for (i, line) in l.lines.iter().enumerate() {
        let t = &l.text[line.range.clone()];
        let first = t.chars().next().unwrap();
        assert!(
            !"。，、？".contains(first),
            "line {i} starts with closing punctuation: {t}"
        );
        assert!(line.width <= 150.0 + 1e-6);
    }
    // Lines break between ideographs: the first line is nearly full.
    assert!(l.lines[0].width > 150.0 - 20.0 - 1e-6);
    // Japanese kana and the language hint route Han to the Japanese face when present (here: the SC subset).
    let mut c = plain(
        "日本語の文章は、文字と文字の間で改行できます。",
        "Inter",
        20.0,
    );
    c.spans[0].style.language = Some("ja".into());
    let l = lay(&mut e, &c, Some(120.0));
    assert!(l.lines.len() >= 2);
    // Inter-character justification for CJK lines without spaces.
    let mut c = plain(text, "Inter", 20.0);
    c.paragraph.align = TextAlign::Justify;
    let l = lay(&mut e, &c, Some(155.0));
    for line in &l.lines[..l.lines.len() - 1] {
        assert!((line.width - 155.0).abs() < 1e-6, "{}", line.width);
    }
}

#[test]
fn emoji_fallback_prefers_color_fonts() {
    let mut e = engine();
    let l = lay(&mut e, &plain("Hi 😀 ❤\u{FE0F}", "Inter", 24.0), None);
    let families: Vec<String> = l
        .runs
        .iter()
        .map(|r| e.db().face(r.face).unwrap().family.clone())
        .collect();
    assert_eq!(
        families,
        vec!["Inter", "Noto Color Emoji", "Inter", "Noto Color Emoji"]
    );
    // ZWJ sequence: one glyph (ligature) and one caret stop.
    let family = "👨\u{200D}👩\u{200D}👧";
    let l = lay(&mut e, &plain(family, "Inter", 24.0), None);
    assert_eq!(l.runs.len(), 1);
    assert_eq!(l.runs[0].glyphs.len(), 1, "family emoji is a single glyph");
    assert_eq!(l.clusters.len(), 1);
    assert_eq!(l.clusters[0].range, 0..family.len());
    // Flags.
    let l = lay(&mut e, &plain("🇩🇪", "Inter", 24.0), None);
    assert_eq!(l.runs[0].glyphs.len(), 1);

    // Without a color font, the monochrome Noto Emoji is used.
    let mut e = TextEngine::new();
    e.db_mut().add_static_font(INTER).unwrap();
    e.db_mut().add_static_font(EMOJI).unwrap();
    let l = lay(&mut e, &plain("Hi 😀", "Inter", 24.0), None);
    assert_eq!(e.db().face(l.runs[1].face).unwrap().family, "Noto Emoji");
    // Text presentation selector keeps a text-style glyph when the text font has one.
    let l = lay(&mut e, &plain("©\u{FE0E}", "Inter", 24.0), None);
    assert_eq!(e.db().face(l.runs[0].face).unwrap().family, "Inter");
    // No emoji font at all: the request names the color emoji family.
    let mut e = TextEngine::new();
    e.db_mut().add_static_font(INTER).unwrap();
    lay(&mut e, &plain("😀", "Inter", 24.0), None);
    assert!(
        e.take_font_requests()
            .iter()
            .any(|r| r.family == "Noto Color Emoji")
    );
}

#[test]
fn soft_hyphen_breaks_with_a_visible_hyphen() {
    let mut e = engine();
    let text = "extra\u{AD}ordinary";
    let one = lay(&mut e, &plain(text, "JetBrains Mono", 10.0), None);
    assert_eq!(one.lines.len(), 1);
    assert!(
        one.runs.iter().all(|r| r.kind == RunKind::Text),
        "no hyphen when not broken"
    );
    let l = lay(&mut e, &plain(text, "JetBrains Mono", 10.0), Some(40.0));
    assert_eq!(line_texts(&l)[0].trim_end_matches('\u{AD}'), "extra");
    assert!(l.lines[0].hyphenated);
    let hy = l.runs.iter().find(|r| r.kind == RunKind::Hyphen).unwrap();
    assert_eq!(hy.line, 0);
    assert!(
        (hy.x - 30.0).abs() < 1e-6,
        "hyphen follows 'extra' (5 x 6 px)"
    );
}

struct EveryTwo;
impl Hyphenator for EveryTwo {
    fn hyphenate(&self, word: &str, _lang: Option<&str>) -> Vec<usize> {
        word.char_indices()
            .map(|(i, _)| i)
            .filter(|i| *i > 0 && i % 2 == 0)
            .collect()
    }
}

#[test]
fn hyphenation_hook_is_used_for_overflowing_words() {
    let mut e = engine();
    e.set_hyphenator(Some(Box::new(EveryTwo)));
    let c = plain("aa bbbbbbbbbb", "JetBrains Mono", 10.0);
    let opts = LayoutOptions {
        hyphenate: true,
        ..LayoutOptions::wrapping(60.0)
    };
    let l = e.layout(&c, &opts);
    // "aa " (18) + "bb" (12) + hyphen (6) = 36; "aa bbbb" + hyphen = 48; "aa bbbbbb" + hyphen = 60 fits exactly.
    assert_eq!(&l.text[l.lines[0].range.clone()], "aa bbbbbb");
    assert!(l.lines[0].hyphenated);
    assert!(
        l.lines
            .iter()
            .all(|line| line.x + line.width <= 60.0 + 1e-6)
    );
    // Without the option the word moves to the next line whole.
    let l = e.layout(&c, &LayoutOptions::wrapping(60.0));
    assert_eq!(line_texts(&l)[0], "aa");
}

#[test]
fn mandatory_breaks_inside_a_paragraph() {
    let mut e = engine();
    let l = lay(&mut e, &plain("one\u{2028}two", "Inter", 20.0), Some(500.0));
    assert_eq!(l.lines.len(), 2);
    assert_eq!(l.paragraphs.len(), 1);
    assert!(!l.lines[0].ends_paragraph && l.lines[1].ends_paragraph);
}
