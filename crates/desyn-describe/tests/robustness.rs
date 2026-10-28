//! Hostile but schema-valid documents: deep nesting, extreme coordinates, rotations / flips, empty pages, many
//! nodes. `describe` must never panic, overflow a wasm-sized stack or hang.

mod support;

use std::time::Instant;

use desyn_core::{Design, DesignKind, Fill, Node};
use desyn_describe::{CompactOptions, DescribeOptions, compact_text, describe};
use desyn_text::TextEngine;
use support::*;

fn run_on_small_stack<F: FnOnce() + Send + 'static>(f: F) {
    // Release builds get a wasm-like 1 MiB stack; debug frames are several times larger.
    let stack = if cfg!(debug_assertions) {
        16 << 20
    } else {
        1 << 20
    };
    std::thread::Builder::new()
        .stack_size(stack)
        .spawn(f)
        .expect("thread")
        .join()
        .expect("no panic / overflow");
}

fn chain(depth: usize) -> Design {
    let mut d = Design::with_page(
        "design000001",
        "Deep",
        DesignKind::Poster,
        PAGE,
        1000.0,
        1000.0,
    );
    let mut parent = PAGE.to_string();
    for k in 0..depth {
        let id = format!("g{k:011}");
        let mut g = Node::group(id.clone(), format!("Level {k}"), 1.0, 1.0, 500.0, 500.0);
        g.base_mut().rotation = if k % 7 == 0 { 3.0 } else { 0.0 };
        d.push_child(&parent, g);
        parent = id;
    }
    d.push_child(
        &parent,
        Node::text("deepest00000", "Bottom of the well", 0.0, 0.0, Some(300.0)),
    );
    d
}

#[test]
fn deep_chains_fit_a_small_stack() {
    run_on_small_stack(|| {
        let d = chain(20_000);
        let mut e = TextEngine::new();
        let t = Instant::now();
        let desc = describe(
            &d,
            &DescribeOptions {
                max_depth: Some(10_000),
                ..Default::default()
            },
            &mut e,
            None,
        )
        .unwrap();
        assert!(t.elapsed().as_secs_f64() < 60.0);
        assert!(
            desc.omitted > 19_000,
            "the tree is capped at the maximum depth"
        );
        let text = compact_text(&desc, &CompactOptions::default());
        assert!(!text.is_empty());
        serde_json::to_string(&desc).expect("serializes");
    });
}

#[test]
fn extreme_geometry_never_panics() {
    let mut b = B::new(DesignKind::Custom, 1000.0, 1000.0);
    b.rect("", "Huge", -1e150, -1e150, 1e151, 1e151, "#ff0000");
    b.rect("", "Zero", 10.0, 10.0, 0.0, 0.0, "#00ff00");
    b.rect("", "Far", 1e300, 1e300, 1.0, 1.0, "#0000ff");
    b.text(
        "",
        "Rotated",
        "Spinning text",
        400.0,
        400.0,
        200.0,
        24.0,
        400.0,
        "#111111",
    );
    b.node("Rotated").base_mut().rotation = 133.0;
    b.text(
        "",
        "Flipped",
        "Mirrored text",
        400.0,
        600.0,
        200.0,
        24.0,
        400.0,
        "#111111",
    );
    b.node("Flipped").base_mut().flip_x = Some(true);
    b.text(
        "",
        "Empty box",
        "x",
        100.0,
        100.0,
        0.0,
        0.0,
        400.0,
        "#111111",
    );
    b.text(
        "",
        "Long",
        &"lorem ipsum ".repeat(5000),
        100.0,
        800.0,
        300.0,
        12.0,
        400.0,
        "#111111",
    );
    let mut star = Node::star(
        nid("Star"),
        "Star",
        1_000_000_000_000,
        0.5,
        10.0,
        10.0,
        100.0,
        100.0,
    );
    star.shaped_mut().unwrap().fills = solid("#123456");
    b.d.push_child(PAGE, star);
    b.text(
        "",
        "Over star",
        "On the star",
        20.0,
        40.0,
        80.0,
        12.0,
        400.0,
        "#ffffff",
    );
    let mut poly = Node::polygon(nid("Polygon"), "Polygon", 7, 600.0, 10.0, 1e-9, 1e-9);
    poly.shaped_mut().unwrap().fills = vec![Fill::solid(color("#00000000"))];
    b.d.push_child(PAGE, poly);
    let d = b.d;
    run_on_small_stack(move || {
        let mut e = TextEngine::new();
        let desc = describe(&d, &DescribeOptions::default(), &mut e, None).unwrap();
        assert!(desc.issues.iter().any(|i| i.rule == "off-page"));
        let json = serde_json::to_string(&desc).unwrap();
        assert!(!json.contains("NaN") && !json.contains("inf"));
    });
}

#[test]
fn empty_page_and_textless_pages() {
    let d = Design::with_page(
        "design000001",
        "Blank",
        DesignKind::Presentation,
        PAGE,
        1920.0,
        1080.0,
    );
    let mut e = TextEngine::new();
    let desc = describe(&d, &DescribeOptions::default(), &mut e, None).unwrap();
    assert!(desc.tree.is_empty() && desc.issues.is_empty() && desc.reading_order.is_empty());
    assert_eq!(desc.palette.len(), 1, "the page background");
    assert!(desc.typography.scale.is_empty());
}

#[test]
fn many_overlapping_nodes_stay_fast() {
    // 3,000 texts stacked on the same spot: the worst case for overlap and alignment checks.
    let mut b = B::new(DesignKind::Poster, 1000.0, 1000.0);
    for k in 0..3000 {
        b.text(
            "",
            &format!("t{k}"),
            "Same place",
            100.0 + (k % 5) as f64,
            100.0,
            400.0,
            20.0,
            400.0,
            "#111111",
        );
    }
    let d = b.d;
    let mut e = TextEngine::new();
    let t = Instant::now();
    let desc = describe(
        &d,
        &DescribeOptions {
            max_nodes: Some(200),
            ..Default::default()
        },
        &mut e,
        None,
    )
    .unwrap();
    let secs = t.elapsed().as_secs_f64();
    assert!(desc.issues.iter().any(|i| i.rule == "overlap"));
    let budget = if cfg!(debug_assertions) { 120.0 } else { 10.0 };
    assert!(secs < budget, "{secs:.2}s");
}
