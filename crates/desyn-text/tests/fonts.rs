//! Font database: registration formats, names, axes, named instances, CSS matching, fallback, providers.

mod common;

use common::*;
use desyn_text::font::{
    FaceStyle, FontDb, FontError, FontProvider, FontRequest, MatchRequest, MemoryProvider,
    ProviderError, RequestReason, StyleQuery,
};
use desyn_text::{LayoutOptions, TextEngine};

#[test]
fn registers_ttf_and_reads_names_and_attributes() {
    let mut db = FontDb::new();
    let ids = db.add_static_font(INTER).unwrap();
    assert_eq!(ids.len(), 1);
    let f = db.face(ids[0]).unwrap();
    assert_eq!(f.family, "Inter");
    assert_eq!(f.units_per_em, 2048);
    assert_eq!(f.weight_range, (100.0, 900.0));
    assert_eq!(f.style, FaceStyle::Normal);
    assert_eq!(f.opsz_range, Some((14.0, 32.0)));
    let axes: Vec<&str> = f.axes.iter().map(|a| a.tag.as_str()).collect();
    assert_eq!(axes, vec!["opsz", "wght"]);
    let names: Vec<&str> = f.named_instances.iter().map(|i| i.name.as_str()).collect();
    assert!(names.contains(&"Bold") && names.contains(&"Thin") && names.contains(&"Black"));
    let bold = f.named_instances.iter().find(|i| i.name == "Bold").unwrap();
    assert!(bold.coords.iter().any(|(t, v)| t == "wght" && *v == 700.0));
    assert_eq!((f.ascent, f.descent, f.line_gap), (1984.0, 494.0, 0.0));
    assert!(!f.monospace);

    let mono = db.add_static_font(MONO).unwrap()[0];
    assert!(db.face(mono).unwrap().monospace);

    let italic = db.add_static_font(SERIF_ITALIC).unwrap()[0];
    let it = db.face(italic).unwrap();
    assert_eq!(it.family, "Instrument Serif");
    assert!(matches!(it.style, FaceStyle::Italic));
    // Re-registering identical bytes returns the same ids.
    assert_eq!(db.add_static_font(SERIF_ITALIC).unwrap(), vec![italic]);
    assert_eq!(db.len(), 3);
}

#[test]
fn decodes_woff_and_woff2() {
    let mut db = FontDb::new();
    let woff = include_bytes!("fonts/InstrumentSerif-ascii.woff").to_vec();
    let woff2 = include_bytes!("fonts/InstrumentSerif-ascii.woff2").to_vec();
    let a = db.add_font(woff).unwrap()[0];
    let b = db.add_font(woff2).unwrap()[0];
    for id in [a, b] {
        let f = db.face(id).unwrap();
        assert_eq!(f.family, "Instrument Serif");
        assert!(db.covers(id, 'H'));
        assert!(!db.covers(id, 'é'), "subset is ASCII only");
    }
    // Both decode to the same glyph data: same advance for H.
    let ia = db.instance(a, &[]);
    let ib = db.instance(b, &[]);
    let ga = db.glyph_index(a, 'H').unwrap();
    let gb = db.glyph_index(b, 'H').unwrap();
    assert_eq!(db.advance(ia, ga), 546.0);
    assert_eq!(db.advance(ib, gb), 546.0);
    assert_eq!(
        db.add_font(vec![0, 1, 0, 0, 9, 9]),
        Err(FontError::Unsupported)
    );
}

#[test]
fn css_matching_against_real_families() {
    let mut db = FontDb::new();
    db.add_static_font(SERIF).unwrap();
    db.add_static_font(SERIF_ITALIC).unwrap();
    db.add_static_font(INTER).unwrap();
    db.add_static_font(INTER_ITALIC).unwrap();
    let req = |w: f32, italic: bool| MatchRequest {
        weight: w,
        style: if italic {
            StyleQuery::Italic
        } else {
            StyleQuery::Normal
        },
        stretch: 100.0,
    };
    // Static family without bold: regular face, synthetic bold.
    let m = db
        .match_family("instrument serif", &req(700.0, false))
        .unwrap();
    assert_eq!(db.face(m.face).unwrap().style, FaceStyle::Normal);
    assert!(m.synthetic_bold && !m.synthetic_italic);
    // Italic request picks the italic face.
    let m = db
        .match_family("'Instrument Serif'", &req(400.0, true))
        .unwrap();
    assert!(matches!(db.face(m.face).unwrap().style, FaceStyle::Italic));
    assert!(!m.synthetic_italic);
    // Variable family: exact weight from the axis, italic from the italic file.
    let m = db.match_family("Inter", &req(650.0, true)).unwrap();
    assert_eq!(m.weight, 650.0);
    assert!(matches!(db.face(m.face).unwrap().style, FaceStyle::Italic));
    assert!(!m.synthetic_bold);
    let vars = db.variations_for(&m, 18.0, &[("wght".into(), 720.0), ("zzzz".into(), 1.0)]);
    assert!(
        vars.contains(&("wght".to_string(), 720.0)),
        "explicit variations win: {vars:?}"
    );
    assert!(vars.contains(&("opsz".to_string(), 18.0)));
    assert!(!vars.iter().any(|(t, _)| t == "zzzz"));
    // Generic families expand through the fallback config.
    assert!(db.match_family("sans-serif", &req(400.0, false)).is_some());
    assert!(db.match_family("serif", &req(400.0, false)).is_some());
    assert!(
        db.match_family("Unknown Family", &req(400.0, false))
            .is_none()
    );
}

#[test]
fn variable_instances_change_metrics_and_advances() {
    let mut e = engine();
    let regular = lay(&mut e, &plain("Hamburgefonstiv", "Inter", 40.0), None);
    let mut bold_c = plain("Hamburgefonstiv", "Inter", 40.0);
    bold_c.spans[0].style.weight = 800.0;
    let bold = lay(&mut e, &bold_c, None);
    assert!(bold.content_width > regular.content_width * 1.03);
    assert_eq!(
        bold.runs[0]
            .variations
            .iter()
            .find(|(t, _)| t == "wght")
            .unwrap()
            .1,
        800.0
    );
    assert_ne!(bold.runs[0].instance, regular.runs[0].instance);
    // Optical size follows the font size (clamped to the axis).
    assert_eq!(
        regular.runs[0]
            .variations
            .iter()
            .find(|(t, _)| t == "opsz")
            .unwrap()
            .1,
        32.0
    );
}

#[test]
fn fallback_requests_and_memory_provider() {
    // No provider: the missing family is reported, layout falls back to a registered face.
    let mut e = TextEngine::new();
    e.db_mut().add_static_font(INTER).unwrap();
    let c = plain("Hello", "Montserrat", 20.0);
    let l = e.layout(&c, &LayoutOptions::default());
    assert_eq!(e.db().face(l.runs[0].face).unwrap().family, "Inter");
    let reqs = e.take_font_requests();
    assert_eq!(reqs.len(), 1);
    assert_eq!(reqs[0].family, "Montserrat");
    assert_eq!(reqs[0].reason, RequestReason::Family);
    // Requests are reported once.
    e.layout(&c, &LayoutOptions::default());
    assert!(e.take_font_requests().is_empty());

    // Missing script fallback is requested by its default family.
    let l = e.layout(&plain("שלום", "Inter", 20.0), &LayoutOptions::default());
    assert_eq!(l.lines.len(), 1);
    let reqs = e.take_font_requests();
    assert!(
        reqs.iter()
            .any(|r| r.family == "Noto Sans Hebrew" && r.reason == RequestReason::Fallback),
        "{reqs:?}"
    );

    // A memory provider serves the family synchronously.
    let mut e = TextEngine::new();
    e.db_mut().add_static_font(INTER).unwrap();
    let mut p = MemoryProvider::new();
    p.insert("Instrument Serif", SERIF.to_vec());
    e.set_provider(Some(Box::new(p)));
    let l = e.layout(
        &plain("Hello", "Instrument Serif", 20.0),
        &LayoutOptions::default(),
    );
    assert_eq!(
        e.db().face(l.runs[0].face).unwrap().family,
        "Instrument Serif"
    );
    assert!(e.font_requests().is_empty());
}

struct FailingProvider;
impl FontProvider for FailingProvider {
    fn load(&mut self, _: &FontRequest) -> Result<Vec<Vec<u8>>, ProviderError> {
        Err(ProviderError::new("offline"))
    }
}

#[test]
fn provider_errors_do_not_break_layout() {
    let mut e = TextEngine::new();
    e.db_mut().add_static_font(INTER).unwrap();
    e.set_provider(Some(Box::new(FailingProvider)));
    let l = e.layout(&plain("Hi", "Lobster", 20.0), &LayoutOptions::default());
    assert_eq!(l.runs.len(), 1);
    let errs = e.take_provider_errors();
    assert_eq!(errs.len(), 1);
    assert!(errs[0].contains("offline"));
}

/// Serves every family with Instrument Serif and counts the calls.
struct CountingProvider(std::sync::Arc<std::sync::atomic::AtomicUsize>);
impl FontProvider for CountingProvider {
    fn load(&mut self, _: &FontRequest) -> Result<Vec<Vec<u8>>, ProviderError> {
        self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Ok(vec![SERIF.to_vec()])
    }
}

/// A document naming many unknown families loads at most 8 per layout call; measurements taken while fonts are
/// still owed are not cached, later calls pick up the rest and then settle.
#[test]
fn provider_loads_are_budgeted_per_call() {
    use desyn_text::content::{Span, TextContent};
    let calls = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let mut e = TextEngine::new();
    e.db_mut().add_static_font(INTER).unwrap();
    e.set_provider(Some(Box::new(CountingProvider(calls.clone()))));
    let mut text = String::new();
    let mut spans = Vec::new();
    for i in 0..12 {
        let start = text.len();
        text.push_str("ab ");
        spans.push(Span {
            range: start..text.len(),
            style: style(&format!("Family {i}"), 20.0),
        });
    }
    let c = TextContent {
        default_style: spans[0].style.clone(),
        text,
        spans,
        paragraph: Default::default(),
        paragraph_overrides: Default::default(),
    };
    let opts = LayoutOptions::default();
    let count = || calls.load(std::sync::atomic::Ordering::SeqCst);
    e.measure_content(&c, &opts);
    assert_eq!(count(), 8, "first call stops at the budget");
    assert_eq!(
        e.cache_stats().measure_entries,
        0,
        "not cached while fonts are owed"
    );
    e.measure_content(&c, &opts);
    assert_eq!(count(), 12, "the next call loads the rest");
    e.measure_content(&c, &opts);
    e.layout(&c, &opts);
    assert_eq!(count(), 12, "every family is attempted once");
    assert_eq!(e.cache_stats().measure_entries, 1);
    assert!(e.take_provider_errors().is_empty());
}

#[test]
fn directory_provider_and_load_dir() {
    let dir = std::env::temp_dir().join(format!("desyn-text-fonts-{}", std::process::id()));
    std::fs::create_dir_all(dir.join("nested")).unwrap();
    std::fs::write(dir.join("nested/serif.ttf"), SERIF).unwrap();
    std::fs::write(dir.join("readme.txt"), b"not a font").unwrap();
    let mut db = FontDb::new();
    assert_eq!(db.load_dir(&dir), 1);
    let mut e = TextEngine::new();
    e.db_mut().add_static_font(INTER).unwrap();
    e.set_provider(Some(Box::new(desyn_text::font::DirectoryProvider::new(
        &dir,
    ))));
    let l = e.layout(
        &plain("Hello", "Instrument Serif", 20.0),
        &LayoutOptions::default(),
    );
    assert_eq!(
        e.db().face(l.runs[0].face).unwrap().family,
        "Instrument Serif"
    );
    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn engine_is_send() {
    fn assert_send<T: Send>() {}
    assert_send::<TextEngine>();
}
