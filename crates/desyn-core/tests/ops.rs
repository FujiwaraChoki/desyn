mod common;

use common::*;
use desyn_core::*;
use serde_json::json;

fn with_shapes() -> Design {
    let mut d = design();
    d.push_child(
        PAGE,
        Node::rect("rect00000001", "A", 10.0, 10.0, 100.0, 50.0),
    );
    d.push_child(
        PAGE,
        Node::frame("frame0000001", "F", 200.0, 200.0, 300.0, 300.0),
    );
    d.push_child(
        "frame0000001",
        Node::ellipse("ellip0000001", "E", 0.0, 0.0, 50.0, 50.0),
    );
    d
}

#[test]
fn create_inserts_subtree_and_inverse_deletes() {
    let mut d = with_shapes();
    let mut g = Node::group("group0000001", "G", 0.0, 0.0, 10.0, 10.0);
    if let Node::Group(gr) = &mut g {
        gr.container.children = vec!["rect00000002".into()];
    }
    let r2 = Node::rect("rect00000002", "R", 0.0, 0.0, 10.0, 10.0).with_parent("group0000001");
    let t = tx(vec![Op::create(
        vec![g.with_parent("root"), r2],
        PAGE,
        Some(99),
    )]);
    let r = roundtrip(&mut d, &t, false);
    assert!(r.dropped.is_empty());
    assert_eq!(
        d.node(PAGE).unwrap().child_ids().last().unwrap(),
        "group0000001"
    );
    assert_eq!(d.node("group0000001").unwrap().parent(), Some(PAGE));
    let Op::Create(c) = &r.applied[0] else {
        panic!()
    };
    assert_eq!(c.index, Some(2), "index clamped in applied");
    assert_eq!(
        c.nodes[0].parent(),
        Some(PAGE),
        "subtree root parent overwritten"
    );
    assert!(validate_design(&d).is_empty(), "{:?}", validate_design(&d));
}

#[test]
fn create_drop_reasons() {
    let mut d = with_shapes();
    let cases = vec![
        (
            Op::create(
                vec![Node::rect("rect00000001", "dup", 0.0, 0.0, 1.0, 1.0)],
                PAGE,
                None,
            ),
            DropReason::DuplicateId,
        ),
        (
            Op::create(
                vec![Node::rect("rect00000009", "x", 0.0, 0.0, 1.0, 1.0)],
                "missing00001",
                None,
            ),
            DropReason::MissingParent,
        ),
        (
            Op::create(
                vec![Node::rect("rect00000009", "x", 0.0, 0.0, 1.0, 1.0)],
                "rect00000001",
                None,
            ),
            DropReason::NotContainer,
        ),
        (
            Op::create(
                vec![Node::rect("rect00000009", "x", 0.0, 0.0, 1.0, 1.0)],
                ROOT_ID,
                None,
            ),
            DropReason::PageNesting,
        ),
        (
            Op::create(
                vec![Node::page("page00000002", "P", 10.0, 10.0)],
                PAGE,
                None,
            ),
            DropReason::PageNesting,
        ),
        (
            Op::create(vec![Node::rect("bad", "x", 0.0, 0.0, 1.0, 1.0)], PAGE, None),
            DropReason::InvalidNode,
        ),
        (
            Op::create(
                vec![
                    Node::rect("rect00000009", "x", 0.0, 0.0, 1.0, 1.0),
                    Node::rect("rect00000008", "orphan", 0.0, 0.0, 1.0, 1.0)
                        .with_parent("rect00000009"),
                ],
                PAGE,
                None,
            ),
            DropReason::InvalidNode,
        ),
    ];
    for (op, reason) in cases {
        let r = apply(&mut d, &tx(vec![op.clone()]));
        assert_eq!(r.dropped, vec![Dropped { index: 0, reason }], "{op:?}");
        assert!(r.applied.is_empty());
    }
    // Invalid node values are rejected.
    let mut bad = Node::rect("rect00000009", "x", 0.0, 0.0, 1.0, 1.0);
    bad.base_mut().opacity = 2.0;
    assert_eq!(
        apply(&mut d, &tx(vec![Op::create(vec![bad], PAGE, None)])).dropped[0].reason,
        DropReason::InvalidNode
    );
    // Raw (untyped) failures keep the reference check order.
    let r = apply(
        &mut d,
        &tx_json(json!([
            {"op": "create", "parent": "missing00001", "nodes": [{"id": "rect00000009", "type": "rect"}]},
            {"op": "create", "parent": PAGE, "nodes": [{"id": "rect00000001", "type": "rect"}]},
            {"op": "create", "parent": PAGE, "nodes": [{"id": "rect00000009", "type": "rect"}]},
            {"op": "create", "parent": PAGE, "nodes": []},
            {"op": "create", "parent": PAGE, "nodes": [{"type": "rect"}]},
            {"op": "create", "parent": ROOT_ID, "nodes": [{"id": "rect00000009", "type": "rect"}]}
        ])),
    );
    let reasons: Vec<_> = r.dropped.iter().map(|x| x.reason).collect();
    assert_eq!(
        reasons,
        vec![
            DropReason::MissingParent,
            DropReason::DuplicateId,
            DropReason::InvalidNode,
            DropReason::InvalidOp,
            DropReason::InvalidNode,
            DropReason::PageNesting
        ]
    );
}

#[test]
fn update_set_unset_and_inverse() {
    let mut d = with_shapes();
    let t = tx_json(json!([
        {"op": "update", "id": "rect00000001", "set": {"x": 42, "role": "cta", "futureKey": {"a": 1}}, "unset": ["name"]}
    ]));
    // name is required: the whole op is dropped.
    let r = apply(&mut d, &t);
    assert_eq!(r.dropped[0].reason, DropReason::InvalidNode);
    let t = tx_json(json!([
        {"op": "update", "id": "rect00000001", "set": {"x": 42, "role": "cta", "futureKey": {"a": 1}}},
        {"op": "update", "id": "rect00000001", "unset": ["role"]}
    ]));
    let r = roundtrip(&mut d, &t, false);
    assert!(r.dropped.is_empty());
    let n = d.node("rect00000001").unwrap();
    assert_eq!(n.base().x, 42.0);
    assert!(n.base().role.is_none());
    assert_eq!(n.extra()["futureKey"], json!({"a": 1}));
}

#[test]
fn update_drop_reasons() {
    let mut d = with_shapes();
    let r = apply(
        &mut d,
        &tx_json(json!([
            {"op": "update", "id": "rect00000001", "set": {"type": "ellipse"}},
            {"op": "update", "id": "rect00000001", "unset": ["children"]},
            {"op": "update", "id": "missing00001", "set": {"x": 1}},
            {"op": "update", "id": "rect00000001", "set": {"opacity": 3}},
            {"op": "update", "id": "rect00000001", "set": {"width": -1}},
            {"op": "update", "id": "rect00000001", "set": {"fills": "red"}},
            {"op": "nope"}
        ])),
    );
    let reasons: Vec<_> = r.dropped.iter().map(|x| x.reason).collect();
    assert_eq!(
        reasons,
        vec![
            DropReason::ImmutableField,
            DropReason::ImmutableField,
            DropReason::MissingNode,
            DropReason::InvalidNode,
            DropReason::InvalidNode,
            DropReason::InvalidNode,
            DropReason::InvalidOp
        ]
    );
}

#[test]
fn patch_deep_set_and_inverse() {
    let mut d = with_shapes();
    let t = tx_json(json!([
        {"op": "patch", "id": "rect00000001", "path": ["fills", 0, "color"], "value": "#ff0000"},
        {"op": "patch", "id": "rect00000001", "path": ["fills", 1], "value": {"type": "solid", "color": "#00ff00"}},
        {"op": "patch", "id": "rect00000001", "path": ["meta"], "value": {"slot": "headline"}},
        {"op": "patch", "id": "rect00000001", "path": ["meta", "aiNote"], "value": "x"},
        {"op": "patch", "id": "frame0000001", "path": ["layout"], "value": {"mode": "row", "gap": 8, "padding": [0,0,0,0], "mainAlign": "start", "crossAlign": "start"}},
        {"op": "patch", "id": "frame0000001", "path": ["layout", "gap"], "value": 16}
    ]));
    let r = roundtrip(&mut d, &t, false);
    assert!(r.dropped.is_empty(), "{:?}", r.dropped);
    assert_eq!(d.node("frame0000001").unwrap().layout().unwrap().gap, 16.0);
    let fills = d.node("rect00000001").unwrap().fills();
    assert_eq!(fills.len(), 2);
    let r = apply(
        &mut d,
        &tx_json(json!([
            {"op": "patch", "id": "rect00000001", "path": ["fills", 5], "value": 1},
            {"op": "patch", "id": "rect00000001", "path": [], "value": 1},
            {"op": "patch", "id": "rect00000001", "path": ["parent"], "value": "x"},
            {"op": "patch", "id": "rect00000001", "path": ["fills", 0, "color"], "value": "nope"},
            {"op": "patch", "id": "rect00000001", "path": ["nothing", "deep"], "value": 1},
            {"op": "patch", "id": "rect00000001", "path": [0], "value": 1}
        ])),
    );
    let reasons: Vec<_> = r.dropped.iter().map(|x| x.reason).collect();
    assert_eq!(
        reasons,
        vec![
            DropReason::InvalidPath,
            DropReason::InvalidPath,
            DropReason::ImmutableField,
            DropReason::InvalidNode,
            DropReason::InvalidPath,
            DropReason::InvalidPath
        ]
    );
}

#[test]
fn delete_subtree_and_restore() {
    let mut d = with_shapes();
    let t = tx(vec![Op::delete("frame0000001"), Op::delete("missing00001")]);
    let r = roundtrip(&mut d, &t, false);
    assert_eq!(
        r.dropped,
        vec![Dropped {
            index: 1,
            reason: DropReason::MissingNode
        }]
    );
    assert_eq!(r.applied.len(), 1);
    assert!(d.node("ellip0000001").is_none());
    let r = apply(&mut d, &tx(vec![Op::delete(ROOT_ID)]));
    assert_eq!(r.dropped[0].reason, DropReason::RootProtected);
}

#[test]
fn move_reorder_reparent_and_errors() {
    let mut d = with_shapes();
    let t = tx(vec![
        Op::move_to("rect00000001", "frame0000001", Some(0)),
        Op::move_to("ellip0000001", PAGE, None),
    ]);
    let r = roundtrip(&mut d, &t, false);
    assert!(r.dropped.is_empty());
    assert_eq!(
        d.node("frame0000001").unwrap().child_ids(),
        &["rect00000001".to_string()]
    );
    assert_eq!(
        d.node(PAGE).unwrap().child_ids().last().unwrap(),
        "ellip0000001"
    );
    let r = apply(
        &mut d,
        &tx(vec![
            Op::move_to("frame0000001", "rect00000001", None),
            Op::move_to("frame0000001", "frame0000001", None),
            Op::move_to("rect00000001", ROOT_ID, None),
            Op::move_to(PAGE, "frame0000001", None),
            Op::move_to(ROOT_ID, PAGE, None),
            Op::move_to("missing00001", PAGE, None),
            Op::move_to("rect00000001", "missing00001", None),
        ]),
    );
    let reasons: Vec<_> = r.dropped.iter().map(|x| x.reason).collect();
    assert_eq!(
        reasons,
        vec![
            DropReason::NotContainer,
            DropReason::Cycle,
            DropReason::PageNesting,
            DropReason::Cycle,
            DropReason::RootProtected,
            DropReason::MissingNode,
            DropReason::MissingParent
        ]
    );
    // Reorder within the same parent: index is relative to the list without the node.
    let mut d = with_shapes();
    apply(&mut d, &tx(vec![Op::move_to("rect00000001", PAGE, None)]));
    assert_eq!(
        d.node(PAGE).unwrap().child_ids(),
        &["frame0000001".to_string(), "rect00000001".to_string()]
    );
    let r = apply(
        &mut d,
        &tx(vec![Op::move_to("rect00000001", PAGE, Some(-5))]),
    );
    assert_eq!(d.node(PAGE).unwrap().child_ids()[0], "rect00000001");
    let Op::Move(m) = &r.applied[0] else { panic!() };
    assert_eq!(m.index, Some(0));
}

#[test]
fn asset_styles_doc_ops() {
    let mut d = with_shapes();
    d.brand_kit_id = Some("kit".into());
    let t = tx_json(json!([
        {"op": "asset", "set": {"asset0000001": {"id": "asset0000001", "kind": "image", "mime": "image/png", "width": 10, "height": 10}}},
        {"op": "styles", "path": ["colors", "color0000001"], "value": {"name": "Brand", "value": "#ffb02e"}},
        {"op": "styles", "path": ["variables", "brand.primary"], "value": "#ffb02e"},
        {"op": "styles", "path": ["colors", "color0000001", "name"], "value": "Sun"},
        {"op": "doc", "set": {"name": "Renamed", "kind": "flyer", "meta": {"tags": ["a"]}}, "unset": ["brandKitId"]}
    ]));
    let r = roundtrip(&mut d, &t, false);
    assert!(r.dropped.is_empty(), "{:?}", r.dropped);
    assert_eq!(d.name, "Renamed");
    assert!(d.brand_kit_id.is_none());
    assert_eq!(d.styles.colors["color0000001"].name, "Sun");
    let t = tx_json(
        json!([{"op": "doc", "set": {"brandKitId": "newkit"}}, {"op": "asset", "remove": ["asset0000001"]}]),
    );
    roundtrip(&mut d, &t, false);
    let r = apply(
        &mut d,
        &tx_json(json!([
            {"op": "asset", "set": {"asset0000002": {"id": "asset0000003", "kind": "image", "mime": "image/png"}}},
            {"op": "styles", "path": ["colors", "color0000001", "value"], "value": "red"},
            {"op": "styles", "path": ["colors", "x", "y"], "value": 1}
        ])),
    );
    let reasons: Vec<_> = r.dropped.iter().map(|x| x.reason).collect();
    assert_eq!(
        reasons,
        vec![
            DropReason::InvalidOp,
            DropReason::InvalidValue,
            DropReason::InvalidPath
        ]
    );
    let r = apply(
        &mut d,
        &tx_json(json!([
            {"op": "asset", "set": {"asset0000002": {"id": "asset0000002", "kind": "bogus", "mime": "image/png"}}},
            {"op": "doc", "set": {"name": 5}},
            {"op": "doc", "set": {"color": "red"}},
            {"op": "doc", "set": {"brandKitId": "x"}, "unset": ["brandKitId"]},
            {"op": "styles", "path": ["extraKey"], "value": 1}
        ])),
    );
    let reasons: Vec<_> = r.dropped.iter().map(|x| x.reason).collect();
    assert_eq!(
        reasons,
        vec![
            DropReason::InvalidValue,
            DropReason::InvalidValue,
            DropReason::InvalidOp,
            DropReason::InvalidOp
        ]
    );
    assert_eq!(
        d.styles.extra["extraKey"],
        json!(1),
        "styles are loose objects"
    );
}

#[test]
fn compose_merges_updates() {
    let a =
        tx_json(json!([{"op": "update", "id": "rect00000001", "set": {"x": 1, "role": "cta"}}]));
    let b = tx_json(json!([
        {"op": "update", "id": "rect00000001", "set": {"y": 2}, "unset": ["role"]},
        {"op": "patch", "id": "rect00000002", "path": ["x"], "value": 1},
        {"op": "patch", "id": "rect00000002", "path": ["x"], "value": 2},
        {"op": "update", "id": "rect00000003", "set": {"x": 1}},
        {"op": "delete", "id": "rect00000003"}
    ]));
    let c = desyn_core::ops::compose(&[a, b], Default::default()).unwrap();
    let v = serde_json::to_value(&c.ops).unwrap();
    assert_eq!(
        v,
        json!([
            {"op": "update", "id": "rect00000001", "set": {"x": 1, "y": 2}, "unset": ["role"]},
            {"op": "patch", "id": "rect00000002", "path": ["x"], "value": 2},
            {"op": "delete", "id": "rect00000003"}
        ])
    );
    assert_eq!(c.id.len(), 12);
}

#[test]
fn invert_without_mutation() {
    let d = with_shapes();
    let t = tx(vec![Op::delete("rect00000001")]);
    let inv = desyn_core::ops::invert(&d, &t);
    assert!(d.node("rect00000001").is_some());
    assert!(matches!(inv.ops[0], Op::Create(_)));
}

/// `create` overwrites the subtree root's `parent`, so whatever the root carries there (even a non-string) is
/// accepted, as in `@desyn/doc-ops`.
#[test]
fn create_ignores_the_subtree_roots_own_parent_value() {
    for bogus in [json!(3.5), json!([1, 2]), json!({"a": 1}), json!(true)] {
        let mut d = with_shapes();
        let mut node =
            serde_json::to_value(Node::rect("rectnew00001", "n", 1.0, 2.0, 3.0, 4.0)).unwrap();
        node["parent"] = bogus.clone();
        let r = roundtrip(
            &mut d,
            &tx_json(json!([{"op": "create", "parent": PAGE, "nodes": [node]}])),
            false,
        );
        assert!(
            r.dropped.is_empty(),
            "parent {bogus} dropped: {:?}",
            r.dropped
        );
        assert_eq!(d.node("rectnew00001").unwrap().parent(), Some(PAGE));
        let applied = serde_json::to_value(&r.applied).unwrap();
        assert_eq!(applied[0]["nodes"][0]["parent"], PAGE);
    }
}

/// Every integral double is an integer for JavaScript (`Number.isInteger(1e21)`), so huge indices clamp instead of
/// being rejected; huge path indices never resolve.
#[test]
fn huge_integral_indices_clamp_like_javascript() {
    let mut d = with_shapes();
    let last = d.node(PAGE).unwrap().child_ids().len() - 1;
    let r = roundtrip(
        &mut d,
        &tx_json(json!([
            {"op": "move", "id": "rect00000001", "parent": PAGE, "index": 1e21},
            {"op": "move", "id": "frame0000001", "parent": PAGE, "index": -1e300},
            {"op": "patch", "id": "rect00000001", "path": ["fills", 1e21], "value": 1}
        ])),
        false,
    );
    assert_eq!(
        serde_json::to_value(&r.dropped).unwrap(),
        json!([{"index": 2, "reason": "invalid-path"}])
    );
    let applied = serde_json::to_value(&r.applied).unwrap();
    assert_eq!(applied[0]["index"], last);
    assert_eq!(applied[1]["index"], 0);
}
