//! `cargo bench --bench describe`: describe of a generated catalog page (cards with image, title, price, button).

use criterion::{Criterion, criterion_group, criterion_main};
use desyn_core::{Color, Design, DesignKind, Fill, Node};
use desyn_describe::{DescribeOptions, describe};
use desyn_text::TextEngine;

fn catalog(cards: usize) -> Design {
    let mut d = Design::with_page(
        "bench0000001",
        "Catalog",
        DesignKind::Poster,
        "page00000001",
        2400.0,
        3000.0,
    );
    let cols = 8;
    for k in 0..cards {
        let (x, y) = (
            (k % cols) as f64 * 290.0 + 20.0,
            (k / cols) as f64 * 420.0 + 20.0,
        );
        let id = |s: &str| format!("{s}{k:07}");
        let mut bg = Node::rect(id("crd00"), "Card", x, y, 270.0, 400.0);
        if let Some(s) = bg.shaped_mut() {
            s.fills = vec![Fill::solid(Color::new("#f4f1ea").unwrap())];
        }
        d.push_child("page00000001", bg);
        d.push_child(
            "page00000001",
            Node::image(
                id("img00"),
                "Photo",
                "asset0000001",
                x + 10.0,
                y + 10.0,
                250.0,
                220.0,
            ),
        );
        d.push_child(
            "page00000001",
            Node::text(id("ttl00"), "Linen shirt", x + 10.0, y + 245.0, Some(250.0)),
        );
        d.push_child(
            "page00000001",
            Node::text(id("prc00"), "$49", x + 10.0, y + 285.0, Some(250.0)),
        );
        let mut btn = Node::rect(id("btn00"), "Button", x + 10.0, y + 330.0, 120.0, 44.0);
        if let Some(s) = btn.shaped_mut() {
            s.fills = vec![Fill::solid(Color::new("#111111").unwrap())];
        }
        d.push_child("page00000001", btn);
        d.push_child(
            "page00000001",
            Node::text(id("lbl00"), "Buy", x + 20.0, y + 340.0, Some(100.0)),
        );
    }
    d
}

fn bench(c: &mut Criterion) {
    let design = catalog(48);
    let mut engine = TextEngine::with_bundled_fonts();
    let opts = DescribeOptions::default();
    c.bench_function("describe 48-card catalog (288 nodes)", |b| {
        b.iter(|| describe(&design, &opts, &mut engine, None).unwrap())
    });
}

criterion_group!(benches, bench);
criterion_main!(benches);
