//! Live gesture previews on top of the committed state (the wasm engine's preview / commit / cancel), and text
//! converted to outlines.

mod common;

use common::*;
use desyn_ffi::{
    DesignPoint, DesignRect, Engine, EngineError, HandleKind, ResizeOptions, SnapOptions,
};

fn node(engine: &Engine, id: &str) -> serde_json::Value {
    serde_json::from_str(&engine.node_json(id.into()).unwrap().expect("node exists")).unwrap()
}

fn move_to(id: &str, x: f64) -> serde_json::Value {
    serde_json::json!([{ "op": "update", "id": id, "set": { "x": x } }])
}

fn snap_options() -> SnapOptions {
    SnapOptions {
        threshold: 6.0,
        objects: true,
        page: true,
        guides: true,
        grid: true,
        spacing: true,
    }
}

#[test]
fn previews_replace_each_other_and_cancel_to_the_committed_state() {
    let engine = simple_engine();
    let committed = engine.design_hash().unwrap();
    assert!(!engine.has_preview());
    assert!(!engine.cancel_preview());
    assert!(engine.commit_preview().is_none());

    let r0 = engine.revision();
    engine
        .preview(tx("txprev000001", move_to("recta0000001", 40.0)), true)
        .unwrap();
    assert!(engine.has_preview());
    assert!(engine.revision() > r0);
    assert_eq!(node(&engine, "recta0000001")["x"], 40.0);
    // The next step replaces the previous one; its outcome is relative to the committed state.
    let step = engine
        .preview(tx("txprev000002", move_to("recta0000001", 60.0)), true)
        .unwrap();
    assert_eq!(node(&engine, "recta0000001")["x"], 60.0);
    let inverse: serde_json::Value = serde_json::from_str(&step.inverse_json).unwrap();
    assert_eq!(inverse["ops"][0]["set"]["x"], 20.0);

    assert!(engine.cancel_preview());
    assert!(!engine.has_preview());
    assert_eq!(engine.design_hash().unwrap(), committed);
}

#[test]
fn commit_keeps_the_preview_and_returns_its_outcome() {
    let engine = simple_engine();
    let committed = engine.design_hash().unwrap();
    engine
        .preview(tx("txprev000001", move_to("recta0000001", 50.0)), true)
        .unwrap();
    let out = engine.commit_preview().expect("a preview was active");
    assert!(!engine.has_preview());
    assert!(out.dropped.is_empty());
    assert_eq!(node(&engine, "recta0000001")["x"], 50.0);
    let applied: serde_json::Value = serde_json::from_str(&out.applied_json).unwrap();
    assert_eq!(applied[0]["set"]["x"], 50.0);
    // Undo with the returned inverse.
    engine.apply_transaction(out.inverse_json, false).unwrap();
    assert_eq!(engine.design_hash().unwrap(), committed);
}

#[test]
fn remote_transactions_apply_under_an_active_preview() {
    let engine = simple_engine();
    engine
        .preview(tx("txprev000001", move_to("recta0000001", 70.0)), true)
        .unwrap();
    // A collaborator moves another node and renames the dragged one.
    let remote = serde_json::json!([
        { "op": "update", "id": "rectb0000001", "set": { "y": 10 } },
        { "op": "update", "id": "recta0000001", "set": { "name": "Card" } },
    ]);
    let out = engine
        .apply_transaction(tx("txremote0001", remote), false)
        .unwrap();
    assert!(out.dropped.is_empty());
    assert!(engine.has_preview());
    let a = node(&engine, "recta0000001");
    assert_eq!(
        (a["x"].as_f64(), a["name"].as_str()),
        (Some(70.0), Some("Card"))
    );
    assert_eq!(node(&engine, "rectb0000001")["y"], 10.0);

    // Cancelling the drag leaves exactly the committed state with the remote change.
    assert!(engine.cancel_preview());
    let a = node(&engine, "recta0000001");
    assert_eq!(
        (a["x"].as_f64(), a["name"].as_str()),
        (Some(20.0), Some("Card"))
    );
    assert_eq!(node(&engine, "rectb0000001")["y"], 10.0);
}

#[test]
fn a_preview_whose_node_was_deleted_remotely_drops_its_ops() {
    let engine = simple_engine();
    engine
        .preview(tx("txprev000001", move_to("recta0000001", 70.0)), true)
        .unwrap();
    engine
        .apply_transaction(
            tx(
                "txremote0001",
                serde_json::json!([{ "op": "delete", "id": "recta0000001" }]),
            ),
            false,
        )
        .unwrap();
    assert!(engine.node_json("recta0000001".into()).unwrap().is_none());
    let out = engine.commit_preview().expect("still active");
    assert_eq!(out.dropped.len(), 1);
    assert_eq!(out.dropped[0].reason, "missing-node");
}

#[test]
fn gestures_are_computed_against_the_committed_state() {
    let engine = simple_engine();
    let ids = vec!["recta0000001".to_string()];
    let start = engine.selection_bounds(ids.clone()).unwrap().unwrap().obb;
    // Two resize steps, each previewed; the second must not compound the first.
    for (i, pointer) in [(140.0, 90.0), (170.0, 120.0)].into_iter().enumerate() {
        let to = resize_box_to(start, pointer);
        let ops: serde_json::Value = serde_json::from_str(
            &engine
                .transform_selection(ids.clone(), start, to, false, false)
                .unwrap(),
        )
        .unwrap();
        engine
            .preview(tx(&format!("txgesture{i:03}"), ops), true)
            .unwrap();
    }
    let a = node(&engine, "recta0000001");
    assert_eq!(
        (a["width"].as_f64(), a["height"].as_f64()),
        (Some(150.0), Some(100.0))
    );
    engine.commit_preview().unwrap();
    let a = node(&engine, "recta0000001");
    assert_eq!(
        (a["x"].as_f64(), a["width"].as_f64()),
        (Some(20.0), Some(150.0))
    );
}

fn resize_box_to(start: desyn_ffi::OrientedBox, (x, y): (f64, f64)) -> desyn_ffi::OrientedBox {
    desyn_ffi::resize_box(
        start,
        HandleKind::BottomRight,
        DesignPoint { x, y },
        ResizeOptions {
            keep_aspect: false,
            from_center: false,
        },
    )
    .bounds
}

#[test]
fn snapping_ignores_the_preview_and_leaves_it_intact() {
    let engine = simple_engine();
    let exclude = vec!["recta0000001".to_string()];
    // Preview rectb (committed at x 200..280) onto x = 300: a box whose right edge is at 277 snaps to the
    // committed right edge 280, not to the preview.
    engine
        .preview(tx("txprev000001", move_to("rectb0000001", 300.0)), true)
        .unwrap();
    let previewed = engine.design_hash().unwrap();
    let r = engine.revision();
    let snap = engine
        .snap_move(
            None,
            DesignRect {
                x: 227.0,
                y: 150.0,
                width: 50.0,
                height: 50.0,
            },
            exclude,
            snap_options(),
        )
        .unwrap();
    assert!((snap.dx - 3.0).abs() < 1e-9, "{snap:?}");
    // The preview is back exactly, and no revision-keyed cache was invalidated.
    assert_eq!(engine.design_hash().unwrap(), previewed);
    assert_eq!(engine.revision(), r);
    assert_eq!(node(&engine, "rectb0000001")["x"], 300.0);
}

#[test]
fn loading_drops_the_preview() {
    let engine = simple_engine();
    engine
        .preview(tx("txprev000001", move_to("recta0000001", 70.0)), true)
        .unwrap();
    engine.load(simple_design().to_json(), true).unwrap();
    assert!(!engine.has_preview());
    assert_eq!(node(&engine, "recta0000001")["x"], 20.0);
    assert!(matches!(
        Engine::new().preview(tx("txprev000002", move_to("recta0000001", 1.0)), true),
        Err(EngineError::NoDesign)
    ));
}

#[test]
fn text_converts_to_outlines() {
    let engine = simple_engine();
    let outline = engine.text_outline("text00000001".into()).unwrap();
    assert!(
        outline.d.starts_with('M'),
        "{}",
        &outline.d[..outline.d.len().min(40)]
    );
    assert_eq!(outline.fill_rule, "nonzero");
    assert_eq!(outline.width, 150.0);
    let b = outline.bounds.expect("visible glyphs");
    assert!(b.width > 50.0 && b.height > 10.0, "{b:?}");
    assert!(b.x >= -1.0 && b.x + b.width <= 151.0, "{b:?}");

    // Text on an arc is placed along it: different geometry, same box.
    engine
        .apply_transaction(
            tx(
                "txcurve00001",
                serde_json::json!([{ "op": "update", "id": "text00000001", "set": { "curve": 120 } }]),
            ),
            true,
        )
        .unwrap();
    let curved = engine.text_outline("text00000001".into()).unwrap();
    assert_ne!(curved.d, outline.d);
    assert!(curved.bounds.is_some());

    assert!(matches!(
        engine.text_outline("recta0000001".into()),
        Err(EngineError::NotText { .. })
    ));
    assert!(matches!(
        engine.text_outline("nope00000000".into()),
        Err(EngineError::NodeNotFound { .. })
    ));
}
