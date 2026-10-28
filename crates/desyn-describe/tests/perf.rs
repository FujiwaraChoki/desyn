//! Performance budgets (asserted in release builds; debug builds only report). Run
//! `cargo test --release --test perf -- --nocapture` for the numbers.

mod support;

use std::time::Instant;

use desyn_core::{AssetKind, DesignKind};
use desyn_describe::{CompactOptions, DescribeOptions, compact_text, describe};
use desyn_text::TextEngine;
use support::*;

/// A catalog page: `cards` cards of six nodes (surface, photo, title, price, button, label).
fn catalog(cards: usize, cols: usize) -> desyn_core::Design {
    let rows = cards.div_ceil(cols);
    let mut b = B::new(
        DesignKind::Website,
        cols as f64 * 300.0,
        rows as f64 * 220.0,
    );
    b.asset("shot", AssetKind::Image, 800.0, 600.0);
    for k in 0..cards {
        let (x, y) = ((k % cols) as f64 * 300.0, (k / cols) as f64 * 220.0);
        let n = |s: &str| format!("{s}{k:05}");
        b.rect("", &n("c"), x + 5.0, y + 5.0, 290.0, 210.0, "#f4f1ea");
        b.image("", &n("i"), "shot", x + 10.0, y + 10.0, 120.0, 90.0);
        b.alt(&n("i"), "Shirt");
        b.text(
            "",
            &n("t"),
            "Linen shirt",
            x + 140.0,
            y + 10.0,
            150.0,
            18.0,
            600.0,
            "#111111",
        );
        b.text(
            "",
            &n("p"),
            "$49",
            x + 140.0,
            y + 40.0,
            150.0,
            16.0,
            400.0,
            "#333333",
        );
        b.rect("", &n("b"), x + 140.0, y + 150.0, 100.0, 40.0, "#111111");
        b.text(
            "",
            &n("l"),
            "Buy",
            x + 150.0,
            y + 160.0,
            80.0,
            16.0,
            600.0,
            "#ffffff",
        );
    }
    b.d
}

fn time<T>(f: impl FnOnce() -> T) -> (T, f64) {
    let t = Instant::now();
    let r = f();
    (r, t.elapsed().as_secs_f64() * 1000.0)
}

#[test]
fn describe_budgets() {
    let release = !cfg!(debug_assertions);
    let mut engine = TextEngine::with_bundled_fonts();
    for (cards, budget_ms) in [(50usize, 15.0), (400, 80.0), (1600, 400.0)] {
        let d = catalog(cards, 40.min(cards));
        let opts = DescribeOptions::default();
        // Warm the text caches once (hosts keep one engine per document).
        describe(&d, &opts, &mut engine, None).unwrap();
        let (desc, ms) = time(|| describe(&d, &opts, &mut engine, None).unwrap());
        let (_, compact_ms) = time(|| compact_text(&desc, &CompactOptions::default()));
        println!(
            "{} nodes: describe {ms:.1} ms, compact {compact_ms:.2} ms, {} groups, {} issues",
            cards * 6,
            desc.groups.len(),
            desc.issues.len()
        );
        let found = desc
            .groups
            .iter()
            .filter(|g| g.kind == desyn_describe::GroupKind::ProductCard)
            .count();
        let others: Vec<&String> = desc
            .groups
            .iter()
            .filter(|g| {
                !matches!(
                    g.kind,
                    desyn_describe::GroupKind::ProductCard | desyn_describe::GroupKind::Button
                )
            })
            .map(|g| &g.label)
            .collect();
        assert_eq!(found, cards, "{others:?}");
        if release {
            assert!(
                ms < budget_ms,
                "{} nodes took {ms:.1} ms (budget {budget_ms} ms)",
                cards * 6
            );
        }
    }
}
