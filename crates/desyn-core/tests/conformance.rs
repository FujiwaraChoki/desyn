//! Conformance runner over `spec/fixtures/{canonical,nodes,ops,layout}` (see `spec/fixtures/README.md`).

use std::path::{Path, PathBuf};

use desyn_core::canonical::{canonical_json, canonical_string};
use desyn_core::*;
use serde::de::DeserializeOwned;
use serde_json::Value;

fn fixtures(dir: &str) -> Vec<(String, Value)> {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../spec/fixtures")
        .join(dir);
    let mut files: Vec<PathBuf> = match std::fs::read_dir(&root) {
        Ok(rd) => rd
            .filter_map(|e| e.ok().map(|e| e.path()))
            .filter(|p| p.extension().is_some_and(|x| x == "json"))
            .collect(),
        Err(_) => return Vec::new(),
    };
    files.sort();
    files
        .into_iter()
        .map(|p| {
            let text = std::fs::read_to_string(&p).unwrap();
            let v: Value =
                serde_json::from_str(&text).unwrap_or_else(|e| panic!("{}: {e}", p.display()));
            (p.file_name().unwrap().to_string_lossy().into_owned(), v)
        })
        .collect()
}

#[test]
fn canonical_fixtures() {
    let cases = fixtures("canonical");
    let mut failures = Vec::new();
    for (name, case) in &cases {
        let text = case["inputText"].as_str().unwrap();
        let input: Value = serde_json::from_str(text).unwrap();
        let got = canonical_json(&input);
        let want = case["canonical"].as_str().unwrap();
        if got != want {
            failures.push(format!("{name}:\n  got  {got}\n  want {want}"));
        }
    }
    assert!(
        failures.is_empty(),
        "{} canonical failures:\n{}",
        failures.len(),
        failures.join("\n")
    );
    eprintln!("canonical fixtures: {} passed", cases.len());
}

/// Parses `value` as `T`, runs `check`, and verifies a canonical round trip.
fn model_case<T: DeserializeOwned + serde::Serialize>(
    value: &Value,
    check: impl Fn(&T) -> Result<(), String>,
) -> Result<(), String> {
    let t: T = serde_json::from_value(value.clone()).map_err(|e| format!("parse: {e}"))?;
    check(&t)?;
    let back = canonical_string(&t);
    if back != canonical_json(value) {
        return Err(format!(
            "round trip differs:\n  got  {back}\n  want {}",
            canonical_json(value)
        ));
    }
    Ok(())
}

fn node_check(n: &Node) -> Result<(), String> {
    validate_node(n).map_err(|v| v.message)
}

fn typed_node(expected: NodeType) -> impl Fn(&Node) -> Result<(), String> {
    move |n: &Node| {
        if n.node_type() != expected {
            return Err(format!("expected {expected}, got {}", n.node_type()));
        }
        node_check(n)
    }
}

fn run_node_case(schema: &str, value: &Value) -> Result<(), String> {
    match schema {
        "Design" => model_case::<Design>(value, |d| {
            let v = validate_design(d);
            if v.is_empty() {
                Ok(())
            } else {
                Err(format!("{v:?}"))
            }
        }),
        "Transaction" => model_case::<Transaction>(value, |t| {
            for op in &t.ops {
                desyn_core::ops::check_op_schema(op)?;
            }
            Ok(())
        }),
        "AssetRef" => model_case::<AssetRef>(value, check_asset_schema),
        "Fill" => model_case::<Fill>(value, check_fill),
        "Effect" => model_case::<Effect>(value, |_| Ok(())),
        "Stroke" => model_case::<Stroke>(value, |s| {
            s.fills.iter().try_for_each(check_fill)?;
            if s.width < 0.0 {
                Err("negative width".into())
            } else {
                Ok(())
            }
        }),
        "Animation" => model_case::<Animation>(value, |a| {
            if is_id(&a.id) {
                Ok(())
            } else {
                Err("bad id".into())
            }
        }),
        "TextStyle" => model_case::<TextStyle>(value, |s| {
            if s.font_size >= 0.0 {
                Ok(())
            } else {
                Err("fontSize".into())
            }
        }),
        "ParagraphStyle" => model_case::<ParagraphStyle>(value, |_| Ok(())),
        s if s.ends_with("Node") => {
            let ty: NodeType = s
                .trim_end_matches("Node")
                .to_lowercase()
                .parse()
                .map_err(|e: String| e)?;
            model_case::<Node>(value, typed_node(ty))
        }
        other => Err(format!("unknown schema {other}")),
    }
}

#[test]
fn node_fixtures() {
    let cases = fixtures("nodes");
    let mut failures = Vec::new();
    for (name, case) in &cases {
        let schema = case["schema"].as_str().unwrap();
        let valid = case["valid"].as_bool().unwrap();
        let res = run_node_case(schema, &case["value"]);
        match (valid, res) {
            (true, Err(e)) => failures.push(format!("{name}: expected valid, got {e}")),
            (false, Ok(())) => failures.push(format!("{name}: expected invalid, accepted")),
            _ => {}
        }
    }
    assert!(
        failures.is_empty(),
        "{} node failures:\n{}",
        failures.len(),
        failures.join("\n")
    );
    eprintln!("node fixtures: {} passed", cases.len());
}

fn run_op_case(case: &Value) -> Result<(), String> {
    let before: Design =
        serde_json::from_value(case["before"].clone()).map_err(|e| format!("before: {e}"))?;
    let tx: Transaction =
        serde_json::from_value(case["tx"].clone()).map_err(|e| format!("tx: {e}"))?;
    let mut d = before.clone();
    let r = apply_transaction(&mut d, &tx, ApplyOptions::default());
    let want_after = canonical_json(&case["after"]);
    let got_after = d.canonical_json();
    if got_after != want_after {
        return Err(format!(
            "design differs:\n  got  {got_after}\n  want {want_after}"
        ));
    }
    let got_applied = canonical_string(&r.applied);
    let want_applied = canonical_json(&case["applied"]);
    if got_applied != want_applied {
        return Err(format!(
            "applied differs:\n  got  {got_applied}\n  want {want_applied}"
        ));
    }
    let got_dropped = canonical_string(&r.dropped);
    let want_dropped = canonical_json(&case["dropped"]);
    if got_dropped != want_dropped {
        return Err(format!(
            "dropped differs:\n  got  {got_dropped}\n  want {want_dropped}"
        ));
    }
    let mut undo = d.clone();
    let inv = apply_transaction(&mut undo, &r.inverse, ApplyOptions::default());
    if !inv.dropped.is_empty() {
        return Err(format!(
            "inverse dropped {:?}: {}",
            inv.dropped,
            serde_json::to_string(&r.inverse).unwrap()
        ));
    }
    if undo.canonical_json() != before.canonical_json() {
        return Err(format!(
            "inverse does not restore before:\n  got  {}\n  want {}",
            undo.canonical_json(),
            before.canonical_json()
        ));
    }
    if r.inverse.id != desyn_core::ops::inverse_tx_id(&tx.id) {
        return Err("inverse id".into());
    }
    if let Some(want_inverse) = case.get("inverse") {
        let got = canonical_string(&r.inverse);
        let want = canonical_json(want_inverse);
        if got != want {
            return Err(format!("inverse differs:\n  got  {got}\n  want {want}"));
        }
    }
    let mut replay = before.clone();
    let replay_tx = Transaction {
        ops: r.applied.clone(),
        ..tx.clone()
    };
    let rr = apply_transaction(&mut replay, &replay_tx, ApplyOptions::default());
    if !rr.dropped.is_empty() || replay.canonical_json() != want_after {
        return Err(format!("replaying applied failed: {:?}", rr.dropped));
    }
    Ok(())
}

#[test]
fn op_fixtures() {
    let cases = fixtures("ops");
    let mut failures = Vec::new();
    for (name, case) in &cases {
        if let Err(e) = run_op_case(case) {
            failures.push(format!("{name}: {e}"));
        }
    }
    assert!(
        failures.is_empty(),
        "{}/{} op failures:\n{}",
        failures.len(),
        cases.len(),
        failures.join("\n\n")
    );
    eprintln!("op fixtures: {} passed", cases.len());
}

/// Rust-only layout fixtures: `{ name, before, tx, after }` applied with normalization (ApproxMeasurer).
#[test]
fn layout_fixtures() {
    let cases = fixtures("layout");
    let mut failures = Vec::new();
    for (name, case) in &cases {
        let mut d: Design = serde_json::from_value(case["before"].clone()).unwrap();
        let tx: Transaction = serde_json::from_value(case["tx"].clone()).unwrap();
        let r = apply_transaction(
            &mut d,
            &tx,
            ApplyOptions {
                normalize: true,
                ..Default::default()
            },
        );
        let want = canonical_json(&case["after"]);
        if d.canonical_json() != want {
            failures.push(format!(
                "{name}:\n  got  {}\n  want {want}",
                d.canonical_json()
            ));
            continue;
        }
        if let Some(dropped) = case.get("dropped")
            && canonical_string(&r.dropped) != canonical_json(dropped)
        {
            failures.push(format!("{name}: dropped {:?}", r.dropped));
        }
    }
    assert!(
        failures.is_empty(),
        "{} layout failures:\n{}",
        failures.len(),
        failures.join("\n")
    );
    eprintln!("layout fixtures: {} passed", cases.len());
}
