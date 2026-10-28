//! Performance budgets (DESIGN: 10k-node designs apply typical transactions in < 1 ms and hit-test in < 0.2 ms).
//! Timing assertions only run in release builds: `cargo test --release --test perf -- --nocapture`.

mod common;

use std::time::{Duration, Instant};

use common::big::*;
use desyn_core::geometry::Point;
use desyn_core::hit::{HitIndex, HitOptions, hit_test};
use desyn_core::*;
use serde_json::json;

fn median(mut v: Vec<Duration>) -> Duration {
    v.sort();
    v[v.len() / 2]
}

fn tx(ops: serde_json::Value) -> Transaction {
    serde_json::from_value(
        json!({"id": "tx0000000001", "label": "perf", "source": "user", "ts": 0, "ops": ops}),
    )
    .unwrap()
}

/// Applies `t` then its inverse `n` times; returns the median forward time.
fn time_tx(d: &mut Design, t: &Transaction, normalize: bool, n: usize) -> Duration {
    let mut times = Vec::with_capacity(n);
    for _ in 0..n {
        let start = Instant::now();
        let r = apply_transaction(
            d,
            t,
            ApplyOptions {
                normalize,
                ..Default::default()
            },
        );
        times.push(start.elapsed());
        assert!(r.dropped.is_empty(), "{:?}", r.dropped);
        let inv = apply_transaction(d, &r.inverse, ApplyOptions::default());
        assert!(inv.dropped.is_empty());
    }
    median(times)
}

fn budget(label: &str, took: Duration, max: Duration) {
    eprintln!(
        "{label:<48} {:>9.1} µs (budget {:>6.0} µs)",
        took.as_secs_f64() * 1e6,
        max.as_secs_f64() * 1e6
    );
    if !cfg!(debug_assertions) {
        assert!(took < max, "{label}: {took:?} exceeds {max:?}");
    }
}

#[test]
fn apply_budget_10k() {
    let mut d = big_design();
    desyn_core::layout::normalize_all(&mut d, &mut desyn_core::layout::ApproxMeasurer);
    assert_eq!(d.nodes.len(), 10_002);
    let n = if cfg!(debug_assertions) { 5 } else { 200 };
    let ms = Duration::from_millis(1);
    let cases = [
        ("update geometry (free frame child)", tx(json!([{"op": "update", "id": "c00001000005", "set": {"x": 40, "y": 41}}]))),
        ("update geometry (auto-layout frame child)", tx(json!([{"op": "update", "id": "c00000000005", "set": {"width": 20, "height": 12}}]))),
        ("patch fill color", tx(json!([{"op": "patch", "id": "c00001000004", "path": ["fills", 0, "color"], "value": "#ff0000"}]))),
        ("move between frames", tx(json!([{"op": "move", "id": "c00001000008", "parent": "f00000000003", "index": 0}]))),
        ("create rect", tx(json!([{"op": "create", "parent": "f00000000003", "nodes": [serde_json::to_value(Node::rect("newrect00001", "n", 1.0, 1.0, 5.0, 5.0)).unwrap()]}]))),
        ("delete frame subtree (100 nodes)", tx(json!([{"op": "delete", "id": "f00000000007"}]))),
        ("batch of 20 updates", tx(json!((0..20).map(|i| json!({"op": "update", "id": format!("c00005{:06}", i), "set": {"x": i}})).collect::<Vec<_>>()))),
    ];
    for (label, t) in &cases {
        budget(
            &format!("{label} (normalize)"),
            time_tx(&mut d, t, true, n),
            ms,
        );
        budget(
            &format!("{label} (no normalize)"),
            time_tx(&mut d, t, false, n),
            ms,
        );
    }
}

#[test]
fn hit_test_budget_10k() {
    let n = if cfg!(debug_assertions) { 5 } else { 500 };
    let o = HitOptions {
        tolerance: 2.0,
        deep: true,
        ..Default::default()
    };
    let nested = big_design();
    let flat = flat_design();
    let cases: [(&str, &Design, Point); 5] = [
        (
            "nested: miss between frames",
            &nested,
            Point::new(175.0, 175.0),
        ),
        (
            "nested: deep hit in a frame",
            &nested,
            Point::new(205.0, 205.0),
        ),
        (
            "flat 10k: miss (full scan)",
            &flat,
            Point::new(3995.0, 3995.0),
        ),
        ("flat 10k: bottom-most hit", &flat, Point::new(15.0, 15.0)),
        ("flat 10k: topmost hit", &flat, Point::new(3975.0, 3975.0)),
    ];
    for (label, d, p) in cases {
        // Indexed queries (interactive path): < 0.2 ms.
        let start = Instant::now();
        let idx = HitIndex::build(d, BIG_PAGE);
        let build = start.elapsed();
        budget(
            &format!("{label}: index build"),
            build,
            Duration::from_millis(5),
        );
        let mut times = Vec::with_capacity(n);
        for _ in 0..n {
            let start = Instant::now();
            let hit = idx.hit_test(d, p, &o);
            times.push(start.elapsed());
            assert_eq!(hit, hit_test(d, BIG_PAGE, p, &o));
        }
        budget(
            &format!("{label}: indexed query"),
            median(times),
            Duration::from_micros(200),
        );
        // Direct traversal (no index): one-off queries.
        let mut times = Vec::with_capacity(n);
        for _ in 0..n {
            let start = Instant::now();
            let _ = hit_test(d, BIG_PAGE, p, &o);
            times.push(start.elapsed());
        }
        budget(
            &format!("{label}: direct traversal"),
            median(times),
            Duration::from_micros(1000),
        );
    }
}
