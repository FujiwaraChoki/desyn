//! Property tests: random op sequences keep every invariant, `inverse` restores the design exactly, replaying
//! `applied` reproduces the result, and `diff` reconstructs the target.

mod common;

use common::*;
use desyn_core::diff::diff_designs;
use desyn_core::*;
use proptest::prelude::*;
use proptest::strategy::ValueTree;
use serde_json::{Value, json};

/// Raw op recipe; interpreted against the evolving design so ids hit existing nodes most of the time.
#[derive(Debug, Clone)]
struct Recipe {
    kind: u8,
    a: u32,
    b: u32,
    c: i32,
    v: f64,
}

fn recipe() -> impl Strategy<Value = Recipe> {
    (
        0u8..14,
        any::<u32>(),
        any::<u32>(),
        -3i32..12,
        -50.0f64..400.0,
    )
        .prop_map(|(kind, a, b, c, v)| Recipe { kind, a, b, c, v })
}

fn ids(d: &Design) -> Vec<String> {
    let mut v: Vec<String> = d.nodes.keys().cloned().collect();
    v.sort();
    v
}

fn containers(d: &Design) -> Vec<String> {
    let mut v: Vec<String> = d
        .nodes
        .iter()
        .filter(|(_, n)| n.is_container())
        .map(|(k, _)| k.clone())
        .collect();
    v.sort();
    v
}

fn new_id(n: u32) -> String {
    format!("n{:011}", n % 100_000)
}

fn make_node(kind: u32, id: &str, v: f64) -> Node {
    let v = v.abs();
    match kind % 6 {
        0 => Node::rect(id, "r", v, v / 2.0, 10.0 + v, 20.0),
        1 => Node::ellipse(id, "e", v, 0.0, 30.0, 30.0 + v),
        2 => Node::frame(id, "f", 0.0, v, 100.0, 80.0),
        3 => Node::group(id, "g", v, v, 10.0, 10.0),
        4 => Node::text(id, "hello world", v, 0.0, Some(120.0)),
        _ => Node::page(id, "p", 200.0, 200.0),
    }
}

fn to_op(d: &Design, r: &Recipe) -> Value {
    let all = ids(d);
    let conts = containers(d);
    let pick = |n: u32, list: &[String]| -> String {
        if list.is_empty() || n.is_multiple_of(17) {
            new_id(n)
        } else {
            list[n as usize % list.len()].clone()
        }
    };
    match r.kind {
        0 | 1 => {
            let parent = pick(r.a, &conts);
            let id = new_id(r.b);
            let mut node = serde_json::to_value(make_node(r.b, &id, r.v)).unwrap();
            if r.b.is_multiple_of(5) {
                // Nested create: a frame with a child.
                let child = new_id(r.b.wrapping_add(7));
                node = serde_json::to_value(Node::frame(&id, "f", 0.0, 0.0, 50.0, 50.0)).unwrap();
                node["children"] = json!([child]);
                let c = serde_json::to_value(
                    Node::rect(&child, "c", 1.0, 1.0, 5.0, 5.0).with_parent(id.as_str()),
                )
                .unwrap();
                return json!({"op": "create", "parent": parent, "index": r.c, "nodes": [node, c]});
            }
            json!({"op": "create", "parent": parent, "index": r.c, "nodes": [node]})
        }
        2 => {
            json!({"op": "update", "id": pick(r.a, &all), "set": {"x": r.v, "y": r.v / 3.0, "name": format!("n{}", r.b)}})
        }
        3 => {
            json!({"op": "update", "id": pick(r.a, &all), "set": {"opacity": (r.v / 400.0)}, "unset": ["role"]})
        }
        4 => {
            json!({"op": "update", "id": pick(r.a, &all), "set": {"width": r.v, "rotation": r.c * 15}})
        }
        5 => {
            json!({"op": "patch", "id": pick(r.a, &all), "path": ["fills", 0, "color"], "value": "#ff0000"})
        }
        6 => {
            json!({"op": "patch", "id": pick(r.a, &all), "path": ["meta"], "value": {"slot": r.b}})
        }
        7 => json!({"op": "delete", "id": pick(r.a, &all)}),
        8 | 9 => {
            json!({"op": "move", "id": pick(r.a, &all), "parent": pick(r.b, &conts), "index": r.c})
        }
        10 => {
            json!({"op": "asset", "set": {new_id(r.a): {"id": new_id(r.a), "kind": "image", "mime": "image/png"}}})
        }
        11 => json!({"op": "styles", "path": ["variables", format!("v{}", r.a % 5)], "value": r.v}),
        12 => json!({"op": "doc", "set": {"name": format!("Design {}", r.a)}}),
        _ => {
            json!({"op": "update", "id": pick(r.a, &all), "set": {"layout": {"mode": "row", "gap": r.c, "padding": [1, 2, 3, 4], "mainAlign": "start", "crossAlign": "center"}}})
        }
    }
}

fn start() -> Design {
    let mut d = design();
    d.push_child(
        PAGE,
        Node::frame("frame0000001", "f", 10.0, 10.0, 300.0, 300.0),
    );
    d.push_child(
        "frame0000001",
        Node::rect("rect00000001", "r", 0.0, 0.0, 50.0, 50.0),
    );
    d.push_child(
        PAGE,
        Node::group("group0000001", "g", 400.0, 400.0, 20.0, 20.0),
    );
    d.push_child(
        "group0000001",
        Node::rect("rect00000002", "r", 0.0, 0.0, 20.0, 20.0),
    );
    d
}

fn run(recipes: &[Recipe], normalize: bool) -> Result<(), TestCaseError> {
    let mut d = start();
    // Build a transaction incrementally (each op is interpreted against the state after the previous ones).
    let mut ops = Vec::new();
    let mut scratch = d.clone();
    for r in recipes {
        let op: Op = serde_json::from_value(to_op(&scratch, r)).unwrap();
        let _ = apply_transaction(
            &mut scratch,
            &Transaction::new("tx0000000002", "s", vec![op.clone()]),
            ApplyOptions::default(),
        );
        ops.push(op);
    }
    let tx = Transaction::new("tx0000000001", "random", ops);
    let before = d.clone();
    let res = apply_transaction(
        &mut d,
        &tx,
        ApplyOptions {
            normalize,
            ..Default::default()
        },
    );
    let v = validate_design(&d);
    prop_assert!(v.is_empty(), "invariants violated: {:?}", v);
    // Inverse restores exactly.
    let mut undone = d.clone();
    let inv = apply_transaction(&mut undone, &res.inverse, ApplyOptions::default());
    prop_assert!(inv.dropped.is_empty(), "inverse dropped {:?}", inv.dropped);
    prop_assert_eq!(undone.canonical_json(), before.canonical_json());
    // Replaying `applied` without normalization reproduces the state (servers replay verbatim).
    let mut replay = before.clone();
    let rr = apply_transaction(
        &mut replay,
        &Transaction {
            ops: res.applied.clone(),
            ..tx.clone()
        },
        ApplyOptions::default(),
    );
    prop_assert!(rr.dropped.is_empty(), "replay dropped {:?}", rr.dropped);
    prop_assert_eq!(replay.canonical_json(), d.canonical_json());
    // Normalization is idempotent: re-normalizing the result changes nothing.
    if normalize {
        let mut again = d.clone();
        let changes =
            desyn_core::layout::normalize_all(&mut again, &mut desyn_core::layout::ApproxMeasurer);
        let _ = changes;
        let mut twice = again.clone();
        let changes2 =
            desyn_core::layout::normalize_all(&mut twice, &mut desyn_core::layout::ApproxMeasurer);
        prop_assert!(
            changes2.is_empty(),
            "normalize_all not idempotent: {:?}",
            changes2
        );
    }
    // Diff reconstructs the result from the start state.
    let diff = diff_designs(&before, &d, "tx0000000003");
    let mut rebuilt = before.clone();
    let dr = apply_transaction(&mut rebuilt, &diff, ApplyOptions::default());
    prop_assert!(dr.dropped.is_empty(), "diff dropped {:?}", dr.dropped);
    prop_assert_eq!(rebuilt.canonical_json(), d.canonical_json());
    Ok(())
}

proptest! {
    #![proptest_config(ProptestConfig { cases: 256, ..ProptestConfig::default() })]

    #[test]
    fn random_ops_roundtrip(recipes in prop::collection::vec(recipe(), 1..25)) {
        run(&recipes, false)?;
    }

    #[test]
    fn random_ops_roundtrip_with_layout(recipes in prop::collection::vec(recipe(), 1..25)) {
        run(&recipes, true)?;
    }

    #[test]
    // While a double's spacing is far below 1e-6 (|x| < 1e7) the 6-decimal rounding is a fixed point, so canonical
    // text re-canonicalizes to itself. (For larger magnitudes the reference algorithm `round(|x| * 1e6) / 1e6` can
    // move a value by an ulp per application, in TypeScript as well.)
    fn canonical_is_stable(x in -1e7f64..1e7, y in -1.0f64..1.0) {
        let v = json!({"b": x, "a": [y, x * y]});
        let c = desyn_core::canonical::canonical_json(&v);
        let reparsed: Value = serde_json::from_str(&c).unwrap();
        prop_assert_eq!(desyn_core::canonical::canonical_json(&reparsed), c);
    }
}

/// Guards the generator itself: most random ops must actually apply, otherwise the properties above prove little.
#[test]
fn generator_produces_mostly_applicable_ops() {
    let mut runner = proptest::test_runner::TestRunner::deterministic();
    let strat = prop::collection::vec(recipe(), 20..25);
    let (mut applied, mut total) = (0usize, 0usize);
    let mut kinds = std::collections::BTreeMap::new();
    for _ in 0..200 {
        let recipes = strat.new_tree(&mut runner).unwrap().current();
        let mut d = start();
        for r in &recipes {
            let op: Op = serde_json::from_value(to_op(&d, r)).unwrap();
            let res = apply_transaction(
                &mut d,
                &Transaction::new("tx0000000002", "s", vec![op.clone()]),
                ApplyOptions::default(),
            );
            total += 1;
            if res.dropped.is_empty() {
                applied += 1;
                *kinds.entry(op.kind()).or_insert(0usize) += 1;
            }
        }
    }
    assert!(
        applied * 10 >= total * 6,
        "only {applied}/{total} random ops applied"
    );
    for k in [
        "create", "update", "patch", "delete", "move", "asset", "styles", "doc",
    ] {
        assert!(
            kinds.get(k).copied().unwrap_or(0) > 20,
            "too few applied {k} ops: {kinds:?}"
        );
    }
}
