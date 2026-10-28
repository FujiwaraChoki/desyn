//! Editing through the facade: loading, transactions (drops, inverses, normalization), picking, handles,
//! selection transforms and snapping.

mod common;

use common::*;
use desyn_core::model::Design;
use desyn_ffi::{
    Affine, DesignPoint, DesignRect, Engine, EngineError, HandleHit, HandleKind, HandleStyle,
    MarqueeMode, OrientedBox, ResizeEdges, ResizeOptions, SnapAxis, SnapKind, SnapOptions,
    box_corners, handles_for_box, resize_box, rotation_delta,
};

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

fn handle_style() -> HandleStyle {
    HandleStyle {
        size: 8.0,
        slop: 4.0,
        rotate_radius: 12.0,
        min_side_for_edges: 24.0,
    }
}

fn approx(a: f64, b: f64) -> bool {
    (a - b).abs() < 1e-6
}

fn node(engine: &Engine, id: &str) -> serde_json::Value {
    serde_json::from_str(&engine.node_json(id.into()).unwrap().expect("node exists")).unwrap()
}

/// Applies the ops returned by `transform_selection` as a transaction.
fn apply_ops(engine: &Engine, id: &str, ops_json: &str) {
    let ops: serde_json::Value = serde_json::from_str(ops_json).unwrap();
    let out = engine.apply_transaction(tx(id, ops), true).unwrap();
    assert!(out.dropped.is_empty(), "{:?}", out.dropped);
}

#[test]
fn load_reports_pages_and_snapshot_round_trips() {
    let source = std::fs::read_to_string(render_fixtures().join("social.json")).unwrap();
    let engine = Engine::new();
    assert!(!engine.is_loaded());
    let r0 = engine.revision();
    let loaded = engine.load(source.clone(), false).unwrap();
    assert!(loaded.revision > r0);
    assert_eq!(loaded.layout_ops_json, "[]");
    assert_eq!(loaded.pages.len(), 1);
    let page = &loaded.pages[0];
    assert_eq!(
        (page.id.as_str(), page.index, page.width, page.height),
        ("socialpa0010", 0, 1080.0, 1080.0)
    );
    assert_eq!(engine.pages().unwrap(), loaded.pages);

    let expected = Design::from_json(&source).unwrap();
    assert_eq!(engine.snapshot(true).unwrap(), expected.canonical_json());
    assert_eq!(engine.design_hash().unwrap(), expected.hash());
    let plain: Design = Design::from_json(&engine.snapshot(false).unwrap()).unwrap();
    assert_eq!(plain.canonical_json(), expected.canonical_json());

    assert_eq!(node(&engine, "socialct0006")["type"], "frame");
    assert!(engine.node_json("missing00000".into()).unwrap().is_none());

    engine.unload();
    assert!(!engine.is_loaded());
    assert_eq!(engine.snapshot(false).unwrap_err(), EngineError::NoDesign);
}

#[test]
fn load_rejects_invalid_json_and_reports_violations() {
    let engine = Engine::new();
    assert!(matches!(
        engine.load("{".into(), false),
        Err(EngineError::InvalidJson { .. })
    ));
    // A child listed twice violates the tree invariants; the engine still loads it.
    let mut d = simple_design();
    if let Some(desyn_core::model::Node::Page(p)) = d.nodes.get_mut("page00000001") {
        p.container.children.push("recta0000001".into());
    }
    let loaded = engine.load(d.to_json(), false).unwrap();
    assert!(!loaded.violations.is_empty());
}

#[test]
fn load_with_normalize_returns_derived_geometry_ops() {
    // The text factory guesses its height (1.2 x font size); real layout of a wrapping text differs.
    let engine = Engine::new();
    let loaded = engine.load(simple_design().to_json(), true).unwrap();
    let ops: Vec<serde_json::Value> = serde_json::from_str(&loaded.layout_ops_json).unwrap();
    assert!(
        ops.iter().any(|o| o["op"] == "update"
            && o["id"] == "text00000001"
            && o["set"]["height"].is_number()),
        "{ops:?}"
    );
    // Already normalized: a relayout finds nothing.
    let again = engine.relayout().unwrap();
    assert_eq!(again.ops_json, "[]");
    assert_eq!(again.inverse_ops_json, "[]");
}

#[test]
fn transactions_report_drops_and_invert_exactly() {
    let engine = simple_engine();
    let before = engine.design_hash().unwrap();
    let out = engine
        .apply_transaction(
            tx(
                "txedit000001",
                serde_json::json!([
                    { "op": "update", "id": "recta0000001", "set": { "x": 50, "opacity": 0.5 } },
                    { "op": "delete", "id": "missing00000" },
                    { "op": "move", "id": "rectb0000001", "parent": "page00000001", "index": 0 }
                ]),
            ),
            true,
        )
        .unwrap();
    assert_eq!(out.dropped.len(), 1);
    assert_eq!(
        (out.dropped[0].index, out.dropped[0].reason.as_str()),
        (1, "missing-node")
    );
    let applied: Vec<serde_json::Value> = serde_json::from_str(&out.applied_json).unwrap();
    assert_eq!(applied.len(), 2);
    assert_eq!(node(&engine, "recta0000001")["x"], 50.0);
    assert_ne!(engine.design_hash().unwrap(), before);

    let inverse: serde_json::Value = serde_json::from_str(&out.inverse_json).unwrap();
    assert_eq!(inverse["ops"].as_array().unwrap().len(), 2);
    let undo = engine
        .apply_transaction(out.inverse_json.clone(), false)
        .unwrap();
    assert!(undo.dropped.is_empty());
    assert_eq!(engine.design_hash().unwrap(), before);
    assert!(undo.revision > out.revision);

    assert!(matches!(
        engine.apply_transaction("[]".into(), true),
        Err(EngineError::InvalidJson { .. })
    ));
    assert_eq!(
        Engine::new()
            .apply_transaction(tx("txnone000001", serde_json::json!([])), true)
            .unwrap_err(),
        EngineError::NoDesign
    );
}

#[test]
fn hit_testing_and_marquee() {
    let engine = social_engine();
    let cta = DesignPoint { x: 800.0, y: 950.0 };
    assert_eq!(
        engine
            .hit_test(None, cta, hit_options())
            .unwrap()
            .as_deref(),
        Some("socialct0006")
    );
    let mut deep = hit_options();
    deep.deep = true;
    assert_eq!(
        engine.hit_test(None, cta, deep).unwrap().as_deref(),
        Some("socialct0007")
    );
    assert_eq!(
        engine.hit_path(None, cta, hit_options()).unwrap(),
        ["socialct0006", "socialct0007"]
    );
    let under = engine.nodes_at(None, cta, hit_options()).unwrap();
    assert_eq!(under.first().map(String::as_str), Some("socialct0006"));
    assert!(under.iter().any(|id| id == "socialph0001"));
    // Off the page.
    assert_eq!(
        engine
            .hit_test(None, DesignPoint { x: -50.0, y: -50.0 }, hit_options())
            .unwrap(),
        None
    );
    assert!(matches!(
        engine.hit_test(
            None,
            DesignPoint {
                x: f64::NAN,
                y: 0.0
            },
            hit_options()
        ),
        Err(EngineError::InvalidArgument { .. })
    ));

    let logo = engine
        .marquee(
            None,
            DesignRect {
                x: 60.0,
                y: 60.0,
                width: 120.0,
                height: 120.0,
            },
            MarqueeMode::Contain,
            hit_options(),
        )
        .unwrap();
    assert_eq!(logo, ["sociallo0008"]);
    let touching = engine
        .marquee(
            None,
            DesignRect {
                x: 60.0,
                y: 60.0,
                width: 120.0,
                height: 120.0,
            },
            MarqueeMode::Intersect,
            hit_options(),
        )
        .unwrap();
    assert!(
        touching.contains(&"socialph0001".to_string())
            && touching.contains(&"sociallo0008".to_string())
    );

    // The index follows edits.
    engine
        .apply_transaction(tx("txhide000001", serde_json::json!([{ "op": "update", "id": "socialct0006", "set": { "visible": false } }])), true)
        .unwrap();
    assert_ne!(
        engine
            .hit_test(None, cta, hit_options())
            .unwrap()
            .as_deref(),
        Some("socialct0006")
    );
}

#[test]
fn handles_resize_and_rotation_math() {
    let engine = simple_engine();
    let ids = vec!["recta0000001".to_string()];
    let bounds = engine.selection_bounds(ids.clone()).unwrap().unwrap();
    assert_eq!(
        bounds.aabb,
        DesignRect {
            x: 20.0,
            y: 20.0,
            width: 100.0,
            height: 50.0
        }
    );
    let handles = engine
        .handles(ids.clone(), 1.0, handle_style())
        .unwrap()
        .unwrap();
    assert_eq!(handles.resize.len(), 8);
    assert_eq!(handles.rotate.len(), 4);
    let br = handles
        .resize
        .iter()
        .find(|h| h.kind == HandleKind::BottomRight)
        .unwrap();
    assert_eq!(br.center, DesignPoint { x: 120.0, y: 70.0 });
    assert_eq!(
        engine
            .hit_handles(
                ids.clone(),
                1.0,
                handle_style(),
                DesignPoint { x: 121.0, y: 71.0 }
            )
            .unwrap(),
        Some(HandleHit::Resize {
            kind: HandleKind::BottomRight
        })
    );
    assert_eq!(
        engine
            .hit_handles(
                ids.clone(),
                1.0,
                handle_style(),
                DesignPoint { x: 70.0, y: 45.0 }
            )
            .unwrap(),
        None
    );
    assert!(
        engine
            .selection_bounds(vec!["missing00000".into()])
            .unwrap()
            .is_none()
    );

    let same = handles_for_box(bounds.obb, 1.0, handle_style());
    assert_eq!(same, handles);
    let corners = box_corners(bounds.obb);
    assert_eq!(corners[2], DesignPoint { x: 120.0, y: 70.0 });

    let resized = resize_box(
        bounds.obb,
        HandleKind::BottomRight,
        DesignPoint { x: 170.0, y: 120.0 },
        ResizeOptions {
            keep_aspect: false,
            from_center: false,
        },
    );
    assert!(approx(resized.bounds.width, 150.0) && approx(resized.bounds.height, 100.0));
    assert!(!resized.flip_x && !resized.flip_y);

    let r = rotation_delta(
        DesignPoint { x: 0.0, y: 0.0 },
        DesignPoint { x: 10.0, y: 0.0 },
        DesignPoint { x: 0.0, y: 10.0 },
        None,
    );
    assert!(approx(r, 90.0), "{r}");
    let snapped = rotation_delta(
        DesignPoint { x: 0.0, y: 0.0 },
        DesignPoint { x: 10.0, y: 0.0 },
        DesignPoint { x: 10.0, y: 3.0 },
        Some(15.0),
    );
    assert!(approx(snapped, 15.0), "{snapped}");
}

#[test]
fn transform_selection_resizes_moves_and_rotates() {
    let engine = simple_engine();
    let ids = vec!["recta0000001".to_string()];
    let from = engine.selection_bounds(ids.clone()).unwrap().unwrap().obb;
    let to = resize_box(
        from,
        HandleKind::BottomRight,
        DesignPoint { x: 170.0, y: 120.0 },
        ResizeOptions {
            keep_aspect: false,
            from_center: false,
        },
    )
    .bounds;
    let before = engine.design_hash().unwrap();
    let ops = engine
        .transform_selection(ids.clone(), from, to, false, false)
        .unwrap();
    // The design itself is unchanged until the ops are applied.
    assert_eq!(engine.design_hash().unwrap(), before);
    apply_ops(&engine, "txresize0001", &ops);
    let a = node(&engine, "recta0000001");
    assert_eq!(
        (
            a["x"].as_f64(),
            a["y"].as_f64(),
            a["width"].as_f64(),
            a["height"].as_f64()
        ),
        (Some(20.0), Some(20.0), Some(150.0), Some(100.0))
    );

    // Rotate 90 degrees about the box center.
    let from = engine.node_bounds("recta0000001".into()).unwrap().unwrap();
    let (cx, cy) = (20.0 + 75.0, 20.0 + 50.0);
    let rot = Affine {
        a: 0.0,
        b: 1.0,
        c: -1.0,
        d: 0.0,
        tx: cx + cy,
        ty: cy - cx,
    };
    let to = OrientedBox {
        transform: compose(rot, from.transform),
        width: from.width,
        height: from.height,
    };
    apply_ops(
        &engine,
        "txrotate0001",
        &engine
            .transform_selection(ids.clone(), from, to, false, false)
            .unwrap(),
    );
    let a = node(&engine, "recta0000001");
    assert!(approx(a["rotation"].as_f64().unwrap(), 90.0), "{a}");
    assert!(
        approx(a["x"].as_f64().unwrap(), 20.0) && approx(a["y"].as_f64().unwrap(), 20.0),
        "{a}"
    );
    let now = engine.node_bounds("recta0000001".into()).unwrap().unwrap();
    for (p, q) in box_corners(now).iter().zip(box_corners(to).iter()) {
        assert!(approx(p.x, q.x) && approx(p.y, q.y), "{p:?} vs {q:?}");
    }

    // Moving a group moves its children; the group refits around them.
    let gids = vec!["group0000001".to_string()];
    let from = engine.selection_bounds(gids.clone()).unwrap().unwrap().obb;
    let mut to = from;
    to.transform.tx += 30.0;
    to.transform.ty -= 10.0;
    apply_ops(
        &engine,
        "txmovegrp001",
        &engine
            .transform_selection(gids.clone(), from, to, false, false)
            .unwrap(),
    );
    let g = engine.selection_bounds(gids).unwrap().unwrap();
    assert_eq!(
        g.aabb,
        DesignRect {
            x: 70.0,
            y: 190.0,
            width: 120.0,
            height: 60.0
        }
    );
    let kid = engine.node_bounds("grpkid000002".into()).unwrap().unwrap();
    assert_eq!(box_corners(kid)[0], DesignPoint { x: 140.0, y: 190.0 });

    // Mirroring past the opposite edge sets flipX.
    let ids_b = vec!["rectb0000001".to_string()];
    let from = engine.node_bounds("rectb0000001".into()).unwrap().unwrap();
    let flipped = resize_box(
        from,
        HandleKind::Right,
        DesignPoint { x: 150.0, y: 190.0 },
        ResizeOptions {
            keep_aspect: false,
            from_center: false,
        },
    );
    assert!(flipped.flip_x);
    apply_ops(
        &engine,
        "txflip000001",
        &engine
            .transform_selection(ids_b, from, flipped.bounds, flipped.flip_x, flipped.flip_y)
            .unwrap(),
    );
    let b = node(&engine, "rectb0000001");
    assert_eq!(b["flipX"], true);
    assert_eq!(
        (b["x"].as_f64(), b["width"].as_f64(), b["rotation"].as_f64()),
        (Some(150.0), Some(50.0), Some(0.0))
    );
}

/// `a * b` (apply `b` first).
fn compose(a: Affine, b: Affine) -> Affine {
    Affine {
        a: a.a * b.a + a.c * b.b,
        b: a.b * b.a + a.d * b.b,
        c: a.a * b.c + a.c * b.d,
        d: a.b * b.c + a.d * b.d,
        tx: a.a * b.tx + a.c * b.ty + a.tx,
        ty: a.b * b.tx + a.d * b.ty + a.ty,
    }
}

#[test]
fn resizing_text_and_paths_updates_dependent_properties() {
    let mut d = simple_design();
    d.push_child(
        "page00000001",
        desyn_core::model::Node::path(
            "path00000001",
            "P",
            "M0 0L10 0L10 10Z",
            300.0,
            200.0,
            10.0,
            10.0,
        ),
    );
    let engine = Engine::new();
    engine.load(d.to_json(), true).unwrap();

    let ids = vec!["path00000001".to_string()];
    let from = engine.node_bounds(ids[0].clone()).unwrap().unwrap();
    let to = resize_box(
        from,
        HandleKind::BottomRight,
        DesignPoint { x: 320.0, y: 230.0 },
        ResizeOptions {
            keep_aspect: false,
            from_center: false,
        },
    )
    .bounds;
    apply_ops(
        &engine,
        "txpath000001",
        &engine
            .transform_selection(ids, from, to, false, false)
            .unwrap(),
    );
    let p = node(&engine, "path00000001");
    assert_eq!(p["width"], 20.0);
    assert_eq!(p["height"], 30.0);
    assert_eq!(p["paths"][0]["d"], "M0 0L20 0L20 30Z");

    // Dragging the height of an auto-height text fixes its box.
    let ids = vec!["text00000001".to_string()];
    let from = engine.node_bounds(ids[0].clone()).unwrap().unwrap();
    let to = resize_box(
        from,
        HandleKind::Bottom,
        DesignPoint { x: 0.0, y: 200.0 },
        ResizeOptions {
            keep_aspect: false,
            from_center: false,
        },
    )
    .bounds;
    apply_ops(
        &engine,
        "txtext000001",
        &engine
            .transform_selection(ids, from, to, false, false)
            .unwrap(),
    );
    let t = node(&engine, "text00000001");
    assert_eq!(t["autoResize"], "none");
    assert_eq!(t["height"], 180.0);
}

#[test]
fn locked_nodes_do_not_move() {
    let engine = simple_engine();
    engine
        .apply_transaction(tx("txlock000001", serde_json::json!([{ "op": "update", "id": "recta0000001", "set": { "locked": true } }])), true)
        .unwrap();
    let ids = vec!["recta0000001".to_string(), "rectb0000001".to_string()];
    let from = engine.selection_bounds(ids.clone()).unwrap().unwrap().obb;
    let mut to = from;
    to.transform.tx += 5.0;
    let ops: Vec<serde_json::Value> = serde_json::from_str(
        &engine
            .transform_selection(ids, from, to, false, false)
            .unwrap(),
    )
    .unwrap();
    assert_eq!(ops.len(), 1);
    assert_eq!(ops[0]["id"], "rectb0000001");
}

#[test]
fn snapping_to_the_page_and_objects() {
    let engine = simple_engine();
    let exclude = vec!["recta0000001".to_string()];
    // A 100x50 box whose center is 3 px right of the page center (200, 150).
    let moving = DesignRect {
        x: 153.0,
        y: 40.0,
        width: 100.0,
        height: 50.0,
    };
    let snap = engine
        .snap_move(None, moving, exclude.clone(), snap_options())
        .unwrap();
    assert!(approx(snap.dx, -3.0), "{snap:?}");
    // DesignRect B's left edge is at the page center too; without B the page center is the source.
    assert!(
        snap.guides
            .iter()
            .any(|g| g.axis == SnapAxis::X && approx(g.pos, 200.0))
    );
    let only_page = vec!["recta0000001".to_string(), "rectb0000001".to_string()];
    let snap = engine
        .snap_move(None, moving, only_page, snap_options())
        .unwrap();
    assert!(approx(snap.dx, -3.0), "{snap:?}");
    assert!(
        snap.guides.iter().any(|g| g.axis == SnapAxis::X
            && approx(g.pos, 200.0)
            && g.kind == SnapKind::PageCenter),
        "{snap:?}"
    );

    // Left edge 2 px away from rect B's left edge (200).
    let near_b = DesignRect {
        x: 202.0,
        y: 100.0,
        width: 30.0,
        height: 20.0,
    };
    let snap = engine
        .snap_move(None, near_b, exclude.clone(), snap_options())
        .unwrap();
    assert!(approx(snap.dx, -2.0), "{snap:?}");

    let mut off = snap_options();
    off.objects = false;
    off.page = false;
    off.spacing = false;
    let none = engine
        .snap_move(None, near_b, exclude.clone(), off)
        .unwrap();
    assert_eq!((none.dx, none.dy), (0.0, 0.0));

    let resize = engine
        .snap_resize(
            None,
            DesignRect {
                x: 20.0,
                y: 20.0,
                width: 78.0,
                height: 50.0,
            },
            ResizeEdges {
                left: false,
                right: true,
                top: false,
                bottom: false,
            },
            exclude.clone(),
            snap_options(),
        )
        .unwrap();
    // Width 78 snaps to rect B's width 80.
    assert!(approx(resize.dx, 2.0), "{resize:?}");
    assert!(
        resize
            .sizes
            .iter()
            .any(|m| m.axis == SnapAxis::X && approx(m.size, 80.0)),
        "{resize:?}"
    );

    let labels = engine
        .distance_labels(
            None,
            DesignRect {
                x: 20.0,
                y: 20.0,
                width: 100.0,
                height: 50.0,
            },
            exclude,
        )
        .unwrap();
    assert!(labels.iter().any(|l| approx(l.value, 20.0)), "{labels:?}");
}
