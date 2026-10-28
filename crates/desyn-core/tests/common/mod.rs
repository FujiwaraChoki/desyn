//! Shared helpers for integration tests.
#![allow(dead_code)]

pub mod big;

use desyn_core::*;

pub const DESIGN: &str = "design000001";
pub const PAGE: &str = "page00000001";

/// A design with one 1000x1000 page.
pub fn design() -> Design {
    Design::with_page(DESIGN, "Test", DesignKind::Poster, PAGE, 1000.0, 1000.0)
}

pub fn tx(ops: Vec<Op>) -> Transaction {
    Transaction::new("tx0000000001", "test", ops)
}

pub fn tx_json(ops: serde_json::Value) -> Transaction {
    serde_json::from_value(serde_json::json!({
        "id": "tx0000000001", "label": "test", "source": "user", "ts": 0, "ops": ops
    }))
    .unwrap()
}

pub fn apply(d: &mut Design, t: &Transaction) -> ApplyResult {
    apply_transaction(d, t, ApplyOptions::default())
}

pub fn apply_norm(d: &mut Design, t: &Transaction) -> ApplyResult {
    apply_transaction(
        d,
        t,
        ApplyOptions {
            normalize: true,
            ..Default::default()
        },
    )
}

pub fn geo(d: &Design, id: &str) -> (f64, f64, f64, f64) {
    let b = d.node(id).unwrap().base();
    (b.x, b.y, b.width, b.height)
}

pub fn assert_close(a: (f64, f64, f64, f64), b: (f64, f64, f64, f64)) {
    let ok = (a.0 - b.0).abs() < 1e-6
        && (a.1 - b.1).abs() < 1e-6
        && (a.2 - b.2).abs() < 1e-6
        && (a.3 - b.3).abs() < 1e-6;
    assert!(ok, "{a:?} != {b:?}");
}

/// Applies `t`, then its inverse, and checks the design is canonically identical to the original.
pub fn roundtrip(d: &mut Design, t: &Transaction, normalize: bool) -> ApplyResult {
    let before = d.canonical_json();
    let r = apply_transaction(
        d,
        t,
        ApplyOptions {
            normalize,
            ..Default::default()
        },
    );
    let inv = apply(d, &r.inverse);
    assert!(
        inv.dropped.is_empty(),
        "inverse dropped ops: {:?}\ninverse: {}",
        inv.dropped,
        serde_json::to_string(&r.inverse).unwrap()
    );
    assert_eq!(
        d.canonical_json(),
        before,
        "inverse did not restore the design"
    );
    // Re-apply forward to leave the design in the post state.
    let again = apply_transaction(
        d,
        t,
        ApplyOptions {
            normalize,
            ..Default::default()
        },
    );
    assert_eq!(again.dropped, r.dropped);
    r
}
