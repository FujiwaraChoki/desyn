//! Criterion benches for the hot paths on a 10k-node design: `cargo bench -p desyn-core`.
//! Budgets (asserted in `tests/perf.rs`): typical transactions < 1 ms, indexed hit tests < 0.2 ms.

use criterion::{Criterion, criterion_group, criterion_main};
use desyn_core::geometry::Point;
use desyn_core::hit::{HitIndex, HitOptions, hit_test};
use desyn_core::*;
use serde_json::json;

#[path = "../tests/common/big.rs"]
mod big;

use big::*;

fn tx(ops: serde_json::Value) -> Transaction {
    serde_json::from_value(
        json!({"id": "tx0000000001", "label": "bench", "source": "user", "ts": 0, "ops": ops}),
    )
    .unwrap()
}

fn bench_apply(c: &mut Criterion) {
    let mut d = big_design();
    desyn_core::layout::normalize_all(&mut d, &mut desyn_core::layout::ApproxMeasurer);
    let cases = [
        (
            "apply/update-geometry",
            tx(json!([{"op": "update", "id": "c00001000005", "set": {"x": 40, "y": 41}}])),
        ),
        (
            "apply/update-in-auto-layout",
            tx(json!([{"op": "update", "id": "c00000000005", "set": {"width": 20}}])),
        ),
        (
            "apply/move",
            tx(json!([{"op": "move", "id": "c00001000008", "parent": "f00000000003", "index": 0}])),
        ),
        (
            "apply/delete-frame",
            tx(json!([{"op": "delete", "id": "f00000000007"}])),
        ),
    ];
    for (name, t) in cases {
        c.bench_function(name, |b| {
            b.iter(|| {
                let r = apply_transaction(
                    &mut d,
                    &t,
                    ApplyOptions {
                        normalize: true,
                        ..Default::default()
                    },
                );
                apply_transaction(&mut d, &r.inverse, ApplyOptions::default());
            })
        });
    }
}

fn bench_hit(c: &mut Criterion) {
    let flat = flat_design();
    let o = HitOptions {
        deep: true,
        tolerance: 2.0,
        ..Default::default()
    };
    let idx = HitIndex::build(&flat, BIG_PAGE);
    c.bench_function("hit/index-build-10k", |b| {
        b.iter(|| HitIndex::build(&flat, BIG_PAGE))
    });
    c.bench_function("hit/indexed-miss-10k", |b| {
        b.iter(|| idx.hit_test(&flat, Point::new(3995.0, 3995.0), &o))
    });
    c.bench_function("hit/direct-miss-10k", |b| {
        b.iter(|| hit_test(&flat, BIG_PAGE, Point::new(3995.0, 3995.0), &o))
    });
}

fn bench_io(c: &mut Criterion) {
    let d = big_design();
    let json = d.to_json();
    c.bench_function("io/canonical-json-10k", |b| b.iter(|| d.canonical_json()));
    c.bench_function("io/parse-10k", |b| {
        b.iter(|| Design::from_json(&json).unwrap())
    });
    c.bench_function("layout/normalize-all-10k", |b| {
        b.iter(|| {
            let mut x = d.clone();
            desyn_core::layout::normalize_all(&mut x, &mut desyn_core::layout::ApproxMeasurer)
        })
    });
}

criterion_group! {
    name = benches;
    config = Criterion::default().sample_size(20);
    targets = bench_apply, bench_hit, bench_io
}
criterion_main!(benches);
