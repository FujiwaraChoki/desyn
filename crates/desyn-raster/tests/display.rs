//! Display-list behaviour: stable layer keys, damage rectangles, build options, links, vector runs and
//! robustness against hostile (schema-valid) documents.
#![cfg(not(target_arch = "wasm32"))]

use desyn_core::geometry::{Affine, Rect};
use desyn_core::model::{Color, Design, DesignKind, Fill, Node};
use desyn_raster::display::{BuildOptions, Item, Layer, LinkTarget, damage, damage_rects};
use desyn_raster::tiny_skia::{IntRect, Pixmap};
use desyn_raster::{NoAssets, PageRenderOptions, RasterOptions, Renderer};
use desyn_text::TextEngine;

const PAGE: &str = "page00000001";

fn base_design() -> Design {
    let mut d = Design::with_page(
        "design000001",
        "Test",
        DesignKind::SocialPost,
        PAGE,
        400.0,
        300.0,
    );
    let mut a = Node::rect("rectaaaaaaaa", "A", 20.0, 20.0, 100.0, 80.0);
    if let Some(s) = a.shaped_mut() {
        s.fills = vec![Fill::solid(Color::new("#4f8cff").unwrap())];
    }
    d.push_child(PAGE, a);
    let mut b = Node::ellipse("ellipsebbbbb", "B", 200.0, 120.0, 120.0, 120.0);
    b.base_mut().link = Some("https://desyn.app/b".into());
    d.push_child(PAGE, b);
    let mut t = Node::text("textcccccccc", "Hello links", 20.0, 200.0, Some(300.0));
    if let Node::Text(tn) = &mut t {
        tn.runs[0].style =
            Some(serde_json::from_value(serde_json::json!({"link": "page:page00000001"})).unwrap());
    }
    d.push_child(PAGE, t);
    d
}

fn renderer() -> Renderer {
    Renderer::new(TextEngine::with_bundled_fonts(), Box::new(NoAssets))
}

fn keys(l: &Layer, out: &mut Vec<(Option<String>, u64)>) {
    out.push((l.node.clone(), l.key));
    for it in &l.items {
        if let Item::Layer(c) = it {
            keys(c, out);
        }
    }
}

#[test]
fn keys_are_stable_and_local() {
    let mut d = base_design();
    let mut r = renderer();
    let a = r.build(&d, &BuildOptions::default()).unwrap();
    let a2 = r.build(&d, &BuildOptions::default()).unwrap();
    let (mut ka, mut ka2) = (Vec::new(), Vec::new());
    keys(&a.root, &mut ka);
    keys(&a2.root, &mut ka2);
    assert_eq!(ka, ka2, "same design, same keys");
    // A fresh renderer (no caches) produces the same keys.
    let mut kf = Vec::new();
    keys(
        &renderer().build(&d, &BuildOptions::default()).unwrap().root,
        &mut kf,
    );
    assert_eq!(ka, kf);
    d.node_mut("rectaaaaaaaa").unwrap().base_mut().x = 40.0;
    let b = r.build(&d, &BuildOptions::default()).unwrap();
    let mut kb = Vec::new();
    keys(&b.root, &mut kb);
    let changed: Vec<_> = ka
        .iter()
        .zip(&kb)
        .filter(|(x, y)| x.1 != y.1)
        .map(|(x, _)| x.0.clone())
        .collect();
    assert!(changed.contains(&Some("rectaaaaaaaa".into())));
    assert!(changed.contains(&Some(PAGE.into())), "ancestors change too");
    assert!(!changed.contains(&Some("ellipsebbbbb".into())));
    assert!(!changed.contains(&Some("textcccccccc".into())));
}

#[test]
fn damage_covers_old_and_new_positions_only() {
    let mut d = base_design();
    let mut r = renderer();
    let a = r.build(&d, &BuildOptions::default()).unwrap();
    d.node_mut("rectaaaaaaaa").unwrap().base_mut().x = 60.0;
    let b = r.build(&d, &BuildOptions::default()).unwrap();
    let rects = damage(&a, &b);
    let u = rects.iter().skip(1).fold(rects[0], |acc, r| acc.union(r));
    assert!(u.x <= 20.0 && u.right() >= 160.0, "{u:?}");
    assert!(u.w < 200.0, "damage stays local: {u:?}");
    assert!(damage(&b, &b).is_empty());
    let dev = damage_rects(
        &a,
        &b,
        &Affine::scale(2.0, 2.0),
        IntRect::from_xywh(0, 0, 800, 600).unwrap(),
        8,
    );
    assert!(!dev.is_empty() && dev.iter().all(|r| r.right() <= 800));
    // Page background change damages the whole page.
    if let Some(Node::Page(p)) = d.node_mut(PAGE) {
        p.background = vec![Fill::solid(Color::new("#000000").unwrap())];
    }
    let c = r.build(&d, &BuildOptions::default()).unwrap();
    let all = damage(&b, &c);
    assert!(all.iter().any(|r| r.w >= 400.0 && r.h >= 300.0));
}

#[test]
fn links_hidden_only_and_vector_runs() {
    let d = base_design();
    let mut r = renderer();
    let dl = r
        .build(
            &d,
            &BuildOptions {
                vector: true,
                ..BuildOptions::default()
            },
        )
        .unwrap();
    assert!(
        dl.links
            .iter()
            .any(|l| l.target == LinkTarget::Url("https://desyn.app/b".into()))
    );
    assert!(
        dl.links
            .iter()
            .any(|l| l.target == LinkTarget::Page(PAGE.into()))
    );
    assert!(!dl.fonts.entries.is_empty(), "vector builds collect fonts");
    let text = dl.find("textcccccccc").unwrap();
    let has_runs = text
        .items
        .iter()
        .any(|i| matches!(i, Item::Text(t) if !t.runs.is_empty()));
    assert!(has_runs);
    let hidden = r
        .build(
            &d,
            &BuildOptions {
                hidden: vec!["ellipsebbbbb".into()],
                ..BuildOptions::default()
            },
        )
        .unwrap();
    assert!(hidden.find("ellipsebbbbb").is_none());
    let only = r
        .build(
            &d,
            &BuildOptions {
                only: Some(vec!["rectaaaaaaaa".into()]),
                ..BuildOptions::default()
            },
        )
        .unwrap();
    assert!(only.find("rectaaaaaaaa").is_some() && only.find("textcccccccc").is_none());
    // Only a region of the page: the ellipse is the only thing in its rectangle.
    let out = r
        .render_page(
            &d,
            &PageRenderOptions {
                region: Some(Rect::new(200.0, 120.0, 120.0, 120.0)),
                transparent: true,
                ..PageRenderOptions::default()
            },
        )
        .unwrap();
    assert_eq!(out.pixmap.width(), 120);
    assert!(out.pixmap.pixel(60, 60).unwrap().alpha() == 255);
    assert!(out.pixmap.pixel(2, 2).unwrap().alpha() == 0);
}

#[test]
fn region_redraw_matches_full_render() {
    let mut d = base_design();
    let mut r = renderer();
    let view = Affine::scale(1.5, 1.5);
    let mut pix = Pixmap::new(600, 450).unwrap();
    let a = r.build(&d, &BuildOptions::default()).unwrap();
    r.rasterize(&a, &mut pix.as_mut(), &RasterOptions::new(view));
    d.node_mut("ellipsebbbbb").unwrap().base_mut().y = 40.0;
    let b = r.build(&d, &BuildOptions::default()).unwrap();
    let full = IntRect::from_xywh(0, 0, 600, 450).unwrap();
    for rect in damage_rects(&a, &b, &view, full, 8) {
        r.rasterize(
            &b,
            &mut pix.as_mut(),
            &RasterOptions {
                transform: view,
                region: Some(rect),
                background: None,
            },
        );
    }
    let mut fresh = Pixmap::new(600, 450).unwrap();
    r.rasterize(&b, &mut fresh.as_mut(), &RasterOptions::new(view));
    let diff = pix
        .data()
        .iter()
        .zip(fresh.data())
        .filter(|(x, y)| x.abs_diff(**y) > 2)
        .count();
    assert!(diff < 16, "{diff} bytes differ");
}

/// Schema-valid but hostile documents must render without panics, hangs or huge allocations.
#[test]
fn hostile_documents() {
    let mut d = Design::with_page(
        "design000002",
        "Hostile",
        DesignKind::Poster,
        PAGE,
        500.0,
        500.0,
    );
    let mut poly = Node::polygon(
        "polygonxxxxx",
        "P",
        1_000_000_000_000,
        0.0,
        0.0,
        100.0,
        100.0,
    );
    poly.base_mut().rotation = 1e12;
    d.push_child(PAGE, poly);
    d.push_child(
        PAGE,
        Node::rect("hugerectxxxx", "Huge", -1e300, -1e300, 1e300, 1e300),
    );
    let table: Node = serde_json::from_value(serde_json::json!({
        "id": "tablexxxxxxx", "type": "table", "name": "T", "parent": PAGE, "x": 0, "y": 0, "width": 300, "height": 300,
        "rotation": 0, "opacity": 1, "blend": "normal", "visible": true, "locked": false, "effects": [],
        "rows": 9_007_199_254_740_991u64, "cols": 4_000_000_000u64, "colWidths": [], "rowHeights": [],
        "cells": [{"r": 9_000_000_000u64, "c": 1, "text": "x"}], "header": true, "stripe": true,
        "borderColor": "#000000", "borderWidth": 1, "cellPadding": 4,
        "defaultStyle": {"fontFamily": "Inter", "fontWeight": 400, "fontStyle": "normal", "fontSize": 12, "fills": [],
            "letterSpacing": 0, "textCase": "none", "decoration": "none"}
    }))
    .unwrap();
    d.push_child(PAGE, table);
    let chart: Node = serde_json::from_value(serde_json::json!({
        "id": "chartxxxxxxx", "type": "chart", "name": "C", "parent": PAGE, "x": 0, "y": 0, "width": 300, "height": 200,
        "rotation": 0, "opacity": 1, "blend": "normal", "visible": true, "locked": false, "effects": [
            {"type": "dropShadow", "x": 1e9, "y": -1e9, "blur": 1e12, "spread": 1e12, "color": "#000000"},
            {"type": "layerBlur", "radius": 1e15}
        ],
        "chart": "line", "data": {"labels": ["a"], "series": [{"name": "s", "values": (0..200_000).map(f64::from).collect::<Vec<_>>()}]},
        "options": {"legend": true, "grid": true, "labels": true, "palette": [], "fontFamily": "Inter", "fontSize": 1e9,
            "textColor": "#000000", "min": 1e300, "max": -1e300}
    }))
    .unwrap();
    d.push_child(PAGE, chart);
    // Deep nesting: 20,000 groups.
    let mut parent = PAGE.to_string();
    for i in 0..20_000 {
        let id = format!("g{i:011}");
        d.push_child(&parent, Node::group(&id, "G", 0.0, 0.0, 10.0, 10.0));
        parent = id;
    }
    d.push_child(
        &parent,
        Node::rect("deeprectxxxx", "Deep", 0.0, 0.0, 10.0, 10.0),
    );
    // wasm hosts run with about 1 MiB of stack; unoptimized builds need larger frames.
    let stack = if cfg!(debug_assertions) {
        8 << 20
    } else {
        1 << 20
    };
    let handle = std::thread::Builder::new()
        .stack_size(stack)
        .spawn(move || {
            let mut r = renderer();
            let t = std::time::Instant::now();
            let out = r
                .render_page(&d, &PageRenderOptions::default())
                .expect("renders");
            assert_eq!(out.pixmap.width(), 500);
            t.elapsed()
        })
        .unwrap();
    let took = handle.join().expect("no stack overflow or panic");
    assert!(took.as_secs() < 60, "took {took:?}");
}

#[test]
fn animation_time_changes_the_list() {
    let mut d = base_design();
    let anim = serde_json::json!([{"id": "anim00000001", "preset": "fade", "phase": "in", "startMs": 0, "durationMs": 1000, "easing": "linear"}]);
    d.node_mut("rectaaaaaaaa").unwrap().base_mut().anim =
        Some(serde_json::from_value(anim).unwrap());
    let mut r = renderer();
    let at = |r: &mut Renderer, t: Option<f64>| {
        r.build(
            &d,
            &BuildOptions {
                time_ms: t,
                ..BuildOptions::default()
            },
        )
        .unwrap()
    };
    assert!(
        at(&mut r, Some(0.0)).find("rectaaaaaaaa").is_none(),
        "fully transparent at t=0"
    );
    let half = at(&mut r, Some(500.0));
    assert!((half.find("rectaaaaaaaa").unwrap().opacity - 0.5).abs() < 1e-6);
    assert_eq!(at(&mut r, None).find("rectaaaaaaaa").unwrap().opacity, 1.0);
}

/// Vector exporters reproduce background blur by rendering the page region with everything below the layer.
#[test]
fn truncated_backdrop_render_matches_raster() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../spec/fixtures/render/effects.json");
    let d = Design::from_json(&std::fs::read_to_string(path).unwrap()).unwrap();
    let mut r = renderer();
    let dl = r.build(&d, &BuildOptions::default()).unwrap();
    let glass = dl.find("glassxxx0016").expect("glass layer");
    let root = desyn_raster::raster::truncate_after(&dl.root, glass).expect("found by identity");
    let region = glass.bounds;
    let part = desyn_raster::raster::render_region(&root, &region, 1.0).unwrap();
    let full = r
        .render_page(
            &d,
            &PageRenderOptions {
                region: Some(region),
                ..PageRenderOptions::default()
            },
        )
        .unwrap()
        .pixmap;
    assert_eq!((part.width(), part.height()), (full.width(), full.height()));
    let diff = part
        .data()
        .iter()
        .zip(full.data())
        .filter(|(a, b)| a.abs_diff(**b) > 3)
        .count();
    assert!(diff < part.data().len() / 100, "{diff} bytes differ");
}
