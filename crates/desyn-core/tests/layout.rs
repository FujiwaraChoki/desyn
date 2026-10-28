mod common;

use common::*;
use desyn_core::layout::*;
use desyn_core::*;
use serde_json::json;

fn row_frame(id: &str, sizing: Sizing, l: AutoLayout) -> Node {
    let mut f = Node::frame(id, "f", 0.0, 0.0, 300.0, 100.0);
    if let Node::Frame(fr) = &mut f {
        fr.container.layout = Some(l);
    }
    f.base_mut().sizing = Some(sizing);
    f
}

fn al(mode: LayoutMode, gap: f64, cross: CrossAlign) -> AutoLayout {
    AutoLayout {
        mode,
        gap,
        row_gap: None,
        padding: [0.0; 4],
        main_align: MainAlign::Start,
        cross_align: cross,
        wrap: None,
        columns: None,
        reverse: None,
        extra: Default::default(),
    }
}

fn hug() -> Sizing {
    Sizing {
        h: SizingMode::Hug,
        v: SizingMode::Hug,
        extra: Default::default(),
    }
}

#[test]
fn text_children_hug_and_baseline() {
    let mut d = design();
    d.push_child(
        PAGE,
        row_frame(
            "frame0000001",
            hug(),
            al(LayoutMode::Row, 8.0, CrossAlign::Baseline),
        ),
    );
    let mut big = Node::text("text00000001", "Big", 0.0, 0.0, None);
    if let Node::Text(t) = &mut big {
        t.style.font_size = 40.0;
    }
    let mut small = Node::text("text00000002", "small", 0.0, 0.0, None);
    if let Node::Text(t) = &mut small {
        t.style.font_size = 10.0;
    }
    d.push_child("frame0000001", big);
    d.push_child("frame0000001", small);
    let changes = normalize_all(&mut d, &mut ApproxMeasurer);
    assert!(!changes.is_empty());
    // Baselines line up: 40px text baseline at (48-40)/2 + 32 = 36; 10px text baseline at 1 + 8 = 9 -> y = 27.
    let (_, y1, _, h1) = geo(&d, "text00000001");
    let (x2, y2, _, h2) = geo(&d, "text00000002");
    assert_eq!(y1, 0.0);
    assert!((y2 - 27.0).abs() < 1e-9, "y2 = {y2}");
    assert_eq!(h1, 48.0);
    assert_eq!(h2, 12.0);
    let (_, _, w1, _) = geo(&d, "text00000001");
    assert!((x2 - (w1 + 8.0)).abs() < 1e-9);
    // Frame hugs: height = max(baseline + descent) = 36 + 12 = 48 (big) vs 27 + 12 = 39.
    let (_, _, fw, fh) = geo(&d, "frame0000001");
    assert_eq!(fh, 48.0);
    assert!((fw - (w1 + 8.0 + geo(&d, "text00000002").2)).abs() < 1e-9);
    // Idempotent.
    assert!(normalize_all(&mut d, &mut ApproxMeasurer).is_empty());
}

#[test]
fn plan_api_and_nested_hug() {
    let mut d = design();
    d.push_child(
        PAGE,
        row_frame(
            "frame0000001",
            hug(),
            AutoLayout {
                padding: [10.0; 4],
                ..al(LayoutMode::Column, 4.0, CrossAlign::Stretch)
            },
        ),
    );
    d.push_child(
        "frame0000001",
        row_frame(
            "frame0000002",
            hug(),
            al(LayoutMode::Row, 2.0, CrossAlign::Start),
        ),
    );
    d.push_child(
        "frame0000002",
        Node::rect("rect00000001", "a", 0.0, 0.0, 30.0, 10.0),
    );
    d.push_child(
        "frame0000002",
        Node::rect("rect00000002", "b", 0.0, 0.0, 20.0, 15.0),
    );
    d.push_child(
        "frame0000001",
        Node::rect("rect00000003", "c", 0.0, 0.0, 10.0, 10.0),
    );
    normalize_all(&mut d, &mut ApproxMeasurer);
    // Inner row hugs 30 + 2 + 20 = 52 x 15; the outer column stretches children to the widest (52).
    assert_close(geo(&d, "frame0000002"), (10.0, 10.0, 52.0, 15.0));
    assert_close(geo(&d, "rect00000003"), (10.0, 29.0, 52.0, 10.0));
    assert_close(geo(&d, "frame0000001"), (0.0, 0.0, 72.0, 49.0));
    let plan =
        plan_auto_layout(&d, &mut ApproxMeasurer, "frame0000001", Some(100.0), None).unwrap();
    assert_eq!(plan.items.len(), 2);
    assert_eq!(
        plan.items[1].width, 100.0,
        "stretch follows the given inner width"
    );
    assert!(plan_auto_layout(&d, &mut ApproxMeasurer, "rect00000001", None, None).is_none());
}

#[test]
fn normalization_changes_are_in_applied_and_undoable() {
    let mut d = design();
    d.push_child(
        PAGE,
        row_frame(
            "frame0000001",
            hug(),
            al(LayoutMode::Row, 10.0, CrossAlign::Start),
        ),
    );
    d.push_child(
        "frame0000001",
        Node::rect("rect00000001", "a", 0.0, 0.0, 30.0, 10.0),
    );
    normalize_all(&mut d, &mut ApproxMeasurer);
    let before = d.canonical_json();
    let t = tx_json(
        json!([{"op": "create", "parent": "frame0000001", "nodes": [serde_json::to_value(Node::rect("rect00000002", "b", 0.0, 0.0, 20.0, 20.0)).unwrap()]}]),
    );
    let r = apply_norm(&mut d, &t);
    assert!(r.dropped.is_empty());
    assert_close(geo(&d, "rect00000002"), (40.0, 0.0, 20.0, 20.0));
    assert_close(geo(&d, "frame0000001"), (0.0, 0.0, 60.0, 20.0));
    // applied = the create + derived updates (rect x and frame size).
    assert_eq!(r.applied.len(), 3);
    let after = d.canonical_json();
    // A TS server replays `applied` verbatim (no layout) and reaches the same state.
    let mut server: Design = serde_json::from_str(&before).unwrap();
    let rr = apply(
        &mut server,
        &Transaction {
            ops: r.applied.clone(),
            ..t.clone()
        },
    );
    assert!(rr.dropped.is_empty());
    assert_eq!(server.canonical_json(), after);
    // Undo restores everything, including derived geometry.
    let u = apply(&mut d, &r.inverse);
    assert!(u.dropped.is_empty());
    assert_eq!(d.canonical_json(), before);
}

#[test]
fn constraints_cascade_into_nested_frames_and_text() {
    let mut d = design();
    d.push_child(
        PAGE,
        Node::frame("frame0000001", "outer", 0.0, 0.0, 200.0, 200.0),
    );
    let mut inner = Node::frame("frame0000002", "inner", 10.0, 10.0, 180.0, 50.0);
    inner.base_mut().constraints = Some(Constraints {
        h: HConstraint::Stretch,
        v: VConstraint::Top,
        extra: Default::default(),
    });
    d.push_child("frame0000001", inner);
    let mut t = Node::text(
        "text00000001",
        "word word word word word word",
        0.0,
        0.0,
        Some(180.0),
    );
    t.base_mut().constraints = Some(Constraints {
        h: HConstraint::Stretch,
        v: VConstraint::Top,
        extra: Default::default(),
    });
    d.push_child("frame0000002", t);
    normalize_all(&mut d, &mut ApproxMeasurer);
    let h_wide = geo(&d, "text00000001").3;
    let r = apply_norm(
        &mut d,
        &tx_json(json!([{"op": "update", "id": "frame0000001", "set": {"width": 100}}])),
    );
    assert!(r.dropped.is_empty());
    assert_close(geo(&d, "frame0000002"), (10.0, 10.0, 80.0, 50.0));
    let (_, _, tw, th) = geo(&d, "text00000001");
    assert_eq!(tw, 80.0);
    assert!(th > h_wide, "narrower text wraps to more lines");
}

#[test]
fn unknown_nested_keys_survive_edits() {
    let mut d = design();
    let t = tx_json(json!([{"op": "create", "parent": PAGE, "nodes": [{
        "id": "rect00000001", "type": "rect", "name": "r", "parent": PAGE, "x": 0, "y": 0, "width": 10, "height": 10,
        "rotation": 0, "opacity": 1, "blend": "normal", "visible": true, "locked": false, "effects": [],
        "fills": [{"type": "solid", "color": "#ff0000", "futureFill": {"a": 1}}], "strokes": [], "cornerRadius": 0,
        "constraints": {"h": "left", "v": "top", "lock": true}, "futureTop": [1, 2]
    }]}, {"op": "update", "id": "rect00000001", "set": {"x": 5}}]));
    let r = apply_norm(&mut d, &t);
    assert!(r.dropped.is_empty(), "{:?}", r.dropped);
    let v = serde_json::to_value(d.node("rect00000001").unwrap()).unwrap();
    assert_eq!(v["fills"][0]["futureFill"], json!({"a": 1}));
    assert_eq!(v["constraints"]["lock"], json!(true));
    assert_eq!(v["futureTop"], json!([1, 2]));
}

#[test]
fn fill_children_respect_minimum_content() {
    let mut d = design();
    let fixed = Sizing {
        h: SizingMode::Fixed,
        v: SizingMode::Fixed,
        extra: Default::default(),
    };
    d.push_child(
        PAGE,
        row_frame(
            "frame0000001",
            fixed.clone(),
            al(LayoutMode::Row, 0.0, CrossAlign::Start),
        ),
    );
    d.node_mut("frame0000001").unwrap().base_mut().width = 100.0;
    // An auto-layout child whose content is 80 wide, and a plain fill rect.
    let mut inner = row_frame(
        "frame0000002",
        fixed,
        al(LayoutMode::Row, 0.0, CrossAlign::Start),
    );
    inner.base_mut().sizing = Some(Sizing {
        h: SizingMode::Fill,
        v: SizingMode::Fixed,
        extra: Default::default(),
    });
    d.push_child("frame0000001", inner);
    d.push_child(
        "frame0000002",
        Node::rect("rect00000001", "a", 0.0, 0.0, 80.0, 10.0),
    );
    let mut r = Node::rect("rect00000002", "b", 0.0, 0.0, 10.0, 10.0);
    r.base_mut().sizing = Some(Sizing {
        h: SizingMode::Fill,
        v: SizingMode::Fixed,
        extra: Default::default(),
    });
    d.push_child("frame0000001", r);
    normalize_all(&mut d, &mut ApproxMeasurer);
    // Equal share would be 50 each; the container keeps its 80 minimum, the rect gets the remaining 20.
    assert_eq!(geo(&d, "frame0000002").2, 80.0);
    assert_close(geo(&d, "rect00000002"), (80.0, 0.0, 20.0, 10.0));
}

/// Nested auto-layout containers whose children fill / hug: layout must stay polynomial in the nesting depth (each
/// level used to re-plan its whole subtree several times, which grew exponentially).
#[test]
fn deeply_nested_fill_containers_normalize_quickly() {
    let mut d = design();
    let mut parent = PAGE.to_string();
    for k in 0..60 {
        let id = format!("f{k:011}");
        let mode = if k % 2 == 0 {
            LayoutMode::Row
        } else {
            LayoutMode::Column
        };
        let sizing = Sizing {
            h: if k > 0 {
                SizingMode::Fill
            } else {
                SizingMode::Hug
            },
            v: SizingMode::Hug,
            extra: Default::default(),
        };
        d.push_child(
            &parent,
            row_frame(&id, sizing, al(mode, 4.0, CrossAlign::Center)),
        );
        for j in 0..2 {
            d.push_child(
                &id,
                Node::text(format!("t{k:05}{j:06}"), "Hello world", 0.0, 0.0, None),
            );
        }
        parent = id;
    }
    let start = std::time::Instant::now();
    let changes = normalize_all(&mut d, &mut ApproxMeasurer);
    assert!(!changes.is_empty());
    assert!(
        start.elapsed() < std::time::Duration::from_secs(5),
        "took {:?}",
        start.elapsed()
    );
    // Already normalized: a second pass changes nothing.
    assert!(normalize_all(&mut d, &mut ApproxMeasurer).is_empty());
}
