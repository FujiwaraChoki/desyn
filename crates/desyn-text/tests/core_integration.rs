//! `TextMeasurer` integration: core normalization (auto-resize, auto-layout hug, baseline alignment) and
//! transactions use real font metrics.

mod common;

use common::*;
use desyn_core::layout::{ApproxMeasurer, TextMeasurer, measure_text_node, normalize_all};
use desyn_core::model::{
    AutoLayout, AutoResize, CrossAlign, Design, DesignKind, LayoutMode, MainAlign, Node, Sizing,
    SizingMode, TextNode,
};
use desyn_core::{ApplyOptions, Op, Transaction, apply_transaction};
use desyn_text::{LayoutOptions, TextContent};

const PAGE: &str = "page00000001";

fn design() -> Design {
    Design::with_page(
        "design000001",
        "Test",
        DesignKind::Poster,
        PAGE,
        800.0,
        600.0,
    )
}

fn text_node(id: &str, text: &str, width: Option<f64>, family: &str, size: f64) -> Node {
    let mut n = Node::text(id, text, 0.0, 0.0, width);
    if let Node::Text(t) = &mut n {
        t.style.font_family = family.into();
        t.style.font_size = size;
    }
    n
}

fn geo(d: &Design, id: &str) -> (f64, f64, f64, f64) {
    let b = d.node(id).unwrap().base();
    (b.x, b.y, b.width, b.height)
}

fn as_text(d: &Design, id: &str) -> TextNode {
    match d.node(id).unwrap() {
        Node::Text(t) => t.clone(),
        _ => unreachable!(),
    }
}

#[test]
fn auto_resize_width_and_height_use_real_metrics() {
    let mut e = engine();
    let mut d = design();
    d.push_child(
        PAGE,
        text_node("text00000001", "HHHH HHHH", None, "JetBrains Mono", 10.0),
    );
    d.push_child(
        PAGE,
        text_node(
            "text00000002",
            "aaaa bbbb cccc dddd",
            Some(60.0),
            "JetBrains Mono",
            10.0,
        ),
    );
    let changes = normalize_all(&mut d, &mut e);
    assert!(!changes.is_empty());
    // Width mode: 9 monospace cells of 6 px; one 12 px line.
    let (_, _, w, h) = geo(&d, "text00000001");
    assert!(
        (w - 54.0).abs() < 1e-9 && (h - 12.0).abs() < 1e-9,
        "{w} x {h}"
    );
    // Height mode: two lines at width 60.
    let (_, _, w, h) = geo(&d, "text00000002");
    assert!(
        (w - 60.0).abs() < 1e-9 && (h - 24.0).abs() < 1e-9,
        "{w} x {h}"
    );
    // The approximate measurer disagrees (that is why the real one matters).
    let approx = measure_text_node(&mut ApproxMeasurer, &as_text(&d, "text00000001"), None);
    assert!((approx.width - 54.0).abs() > 1.0);
    // Idempotent with the real measurer.
    assert!(normalize_all(&mut d, &mut e).is_empty());
    // The laid out node fills its normalized box exactly.
    let t = as_text(&d, "text00000002");
    let l = e.layout_node(&t, Some(&d.styles));
    assert_eq!(l.lines.len(), 2);
    assert!((l.content_height - t.base.height).abs() < 1e-9);
}

#[test]
fn auto_layout_hugs_and_aligns_baselines_with_real_fonts() {
    let mut e = engine();
    let mut d = design();
    let mut f = Node::frame("frame0000001", "row", 0.0, 0.0, 300.0, 100.0);
    if let Node::Frame(fr) = &mut f {
        fr.container.layout = Some(AutoLayout {
            mode: LayoutMode::Row,
            gap: 8.0,
            row_gap: None,
            padding: [0.0; 4],
            main_align: MainAlign::Start,
            cross_align: CrossAlign::Baseline,
            wrap: None,
            columns: None,
            reverse: None,
            extra: Default::default(),
        });
    }
    f.base_mut().sizing = Some(Sizing {
        h: SizingMode::Hug,
        v: SizingMode::Hug,
        extra: Default::default(),
    });
    d.push_child(PAGE, f);
    d.push_child(
        "frame0000001",
        text_node("text00000001", "Big", None, "Instrument Serif", 40.0),
    );
    d.push_child(
        "frame0000001",
        text_node("text00000002", "small", None, "Inter", 12.0),
    );
    normalize_all(&mut d, &mut e);
    let big = as_text(&d, "text00000001");
    let small = as_text(&d, "text00000002");
    let mb = measure_text_node(&mut e, &big, None);
    let ms = measure_text_node(&mut e, &small, None);
    let (_, y1, w1, _) = geo(&d, "text00000001");
    let (x2, y2, _, _) = geo(&d, "text00000002");
    assert!((x2 - (w1 + 8.0)).abs() < 1e-9);
    assert!(
        ((y1 + mb.baseline) - (y2 + ms.baseline)).abs() < 1e-9,
        "baselines align"
    );
    let (_, _, fw, _) = geo(&d, "frame0000001");
    assert!((fw - (mb.width + 8.0 + ms.width)).abs() < 1e-9);
}

#[test]
fn transactions_normalize_text_edits() {
    let mut e = engine();
    let mut d = design();
    d.push_child(
        PAGE,
        text_node("text00000001", "Hi", Some(100.0), "Inter", 20.0),
    );
    normalize_all(&mut d, &mut e);
    let h0 = geo(&d, "text00000001").3;
    let tx = Transaction::new(
        "tx0000000001",
        "Type",
        vec![Op::update_set(
            "text00000001",
            [(
                "runs".to_string(),
                serde_json::json!([{ "text": "A much longer line of text that has to wrap" }]),
            )]
            .into_iter()
            .collect(),
        )],
    );
    let res = apply_transaction(
        &mut d,
        &tx,
        ApplyOptions {
            normalize: true,
            measurer: Some(&mut e),
            inverse_id: None,
        },
    );
    assert!(res.dropped.is_empty());
    let h1 = geo(&d, "text00000001").3;
    assert!(h1 > h0 * 2.0, "{h0} -> {h1}");
    // The derived height is reported in `applied` so servers without a shaper converge.
    assert!(
        res.applied
            .iter()
            .any(|op| serde_json::to_string(op).unwrap().contains("height"))
    );
}

#[test]
fn measurer_honors_max_lines_and_paragraph_spacing() {
    let mut e = engine();
    let mut t = match text_node("text00000001", "a\nb\nc", None, "JetBrains Mono", 10.0) {
        Node::Text(t) => t,
        _ => unreachable!(),
    };
    t.paragraph.spacing = 5.0;
    let m = measure_text_node(&mut e, &t, None);
    assert_eq!(m.lines, 3);
    assert!((m.height - (36.0 + 10.0)).abs() < 1e-9);
    t.max_lines = Some(2);
    let m = measure_text_node(&mut e, &t, None);
    assert_eq!(m.lines, 2);
    // Cached: identical requests hit the measure cache.
    let before = e.cache_stats().measure_entries;
    let _ = measure_text_node(&mut e, &t, None);
    assert_eq!(e.cache_stats().measure_entries, before);
    // The measurer and full layout agree.
    let c = TextContent::from_node(&t, None);
    let l = e.layout(
        &c,
        &LayoutOptions {
            max_lines: Some(2),
            auto_resize: AutoResize::Width,
            ..Default::default()
        },
    );
    assert!((l.content_height - m.height).abs() < 1e-9);
    let m2 = e.measure(&desyn_core::layout::TextMeasureRequest {
        runs: &t.runs,
        style: &t.style,
        paragraph: &t.paragraph,
        max_width: None,
        max_lines: None,
    });
    assert_eq!(m2.lines, 3);
}
