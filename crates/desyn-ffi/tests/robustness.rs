//! Malformed designs must never crash the host app: the engine reports violations and keeps working.

mod common;

use common::*;
use desyn_ffi::{DesignPoint, Engine};

fn cyclic_design() -> String {
    let mut v: serde_json::Value = serde_json::from_str(&simple_design().to_json()).unwrap();
    let nodes = v["nodes"].as_object_mut().unwrap();
    // group0000001 -> grpkid000001 (made a group) -> group0000001
    let mut kid = nodes["group0000001"].clone();
    kid["id"] = "grpkid000001".into();
    kid["parent"] = "group0000001".into();
    kid["children"] = serde_json::json!(["group0000001"]);
    nodes.insert("grpkid000001".into(), kid);
    nodes["group0000001"]["parent"] = "grpkid000001".into();
    v.to_string()
}

#[test]
fn cyclic_designs_load_render_and_hit_test() {
    let engine = Engine::new();
    let loaded = engine.load(cyclic_design(), true).unwrap();
    assert!(!loaded.violations.is_empty());
    let f = engine.render(request(viewport(200, 150, 0.5))).unwrap();
    assert_eq!(f.pixels.len(), 200 * 150 * 4);
    engine
        .hit_test(None, DesignPoint { x: 60.0, y: 220.0 }, hit_options())
        .unwrap();
    engine.describe(String::new()).unwrap();
    engine.lint(String::new()).unwrap();
    for format in [
        desyn_ffi::ExportFormat::Png,
        desyn_ffi::ExportFormat::Svg,
        desyn_ffi::ExportFormat::Pdf,
        desyn_ffi::ExportFormat::Pptx,
    ] {
        let mut req = export_png();
        req.format = format;
        engine.export(req).unwrap();
    }
    engine.describe_text(String::new(), 500).unwrap();
    engine.design_tokens(None).unwrap();
    engine.relayout().unwrap();
    let p = DesignPoint { x: 60.0, y: 220.0 };
    engine.hit_path(None, p, hit_options()).unwrap();
    engine.nodes_at(None, p, hit_options()).unwrap();
    let all = desyn_ffi::DesignRect {
        x: 0.0,
        y: 0.0,
        width: 400.0,
        height: 300.0,
    };
    engine
        .marquee(None, all, desyn_ffi::MarqueeMode::Intersect, hit_options())
        .unwrap();
    let snap = desyn_ffi::SnapOptions {
        threshold: 6.0,
        objects: true,
        page: true,
        guides: true,
        grid: true,
        spacing: true,
    };
    engine.snap_move(None, all, Vec::new(), snap).unwrap();
    engine.distance_labels(None, all, Vec::new()).unwrap();
    engine.snapshot(true).unwrap();
    // Edits inside the cycle apply (or drop) without hanging.
    engine
        .preview(
            tx(
                "txcycle00001",
                serde_json::json!([{ "op": "move", "id": "recta0000001", "parent": "group0000001" }]),
            ),
            true,
        )
        .unwrap();
    engine.cancel_preview();
    // Gestures on a group inside the cycle terminate too.
    let ids = vec!["group0000001".to_string()];
    if let Some(b) = engine.selection_bounds(ids.clone()).unwrap() {
        let mut to = b.obb;
        to.transform.tx += 10.0;
        engine
            .transform_selection(ids.clone(), b.obb, to, false, false)
            .unwrap();
        engine
            .handles(
                ids,
                1.0,
                desyn_ffi::HandleStyle {
                    size: 8.0,
                    slop: 4.0,
                    rotate_radius: 12.0,
                    min_side_for_edges: 24.0,
                },
            )
            .unwrap();
    }
}

/// `depth` groups nested inside each other on the page, a rect in the innermost one.
fn nested_design(depth: usize) -> String {
    use desyn_core::model::Node;
    let mut d = simple_design();
    let mut parent = "page00000001".to_string();
    for i in 0..depth {
        let id = format!("nest{i:08}");
        d.push_child(&parent, Node::group(&id, "N", 0.0, 0.0, 10.0, 10.0));
        parent = id;
    }
    d.push_child(&parent, Node::rect("deeprect0001", "R", 1.0, 1.0, 8.0, 8.0));
    d.to_json()
}

#[test]
fn deep_nesting_fits_a_dispatch_queue_stack() {
    // Secondary threads on iOS (the DesynEngine actor's dispatch queue) get 512 KB of stack.
    let json = nested_design(depth());
    let t = std::thread::Builder::new()
        .stack_size(512 * 1024)
        .spawn(move || {
            let engine = Engine::new();
            engine.load(json, true).unwrap();
            engine.render(request(viewport(200, 150, 0.5))).unwrap();
            engine
                .hit_test(None, DesignPoint { x: 2.0, y: 2.0 }, hit_options())
                .unwrap();
            engine.describe(String::new()).unwrap();
            engine.lint(String::new()).unwrap();
            engine.export(export_png()).unwrap();
            let ids = vec!["nest00000000".to_string()];
            let from = engine.selection_bounds(ids.clone()).unwrap().unwrap().obb;
            let mut to = from;
            to.transform.tx += 5.0;
            let ops = engine
                .transform_selection(ids, from, to, false, false)
                .unwrap();
            let ops: serde_json::Value = serde_json::from_str(&ops).unwrap();
            engine.preview(tx("txdeep000001", ops), true).unwrap();
            engine.commit_preview().unwrap();
        })
        .unwrap();
    t.join().unwrap();
}
/// Nesting the engine handles on a 512 KB stack: unoptimized builds use far bigger frames (they overflow
/// near 64 levels), release builds pass beyond the renderer's own depth limit. `NEST_DEPTH` overrides it.
fn depth() -> usize {
    let default = if cfg!(debug_assertions) { 32 } else { 1024 };
    std::env::var("NEST_DEPTH")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}

fn export_png() -> desyn_ffi::ExportRequest {
    desyn_ffi::ExportRequest {
        format: desyn_ffi::ExportFormat::Png,
        pages: desyn_ffi::ExportPages::First,
        scale: 0.5,
        dpi: None,
        quality: 90,
        background: desyn_ffi::ExportBackground::Page,
        region: None,
        time_ms: None,
        pdf: None,
        svg_outlines: false,
        svg_embed_fonts: true,
        fps: 15.0,
        duration_ms: None,
        only: None,
        hidden: Vec::new(),
    }
}
