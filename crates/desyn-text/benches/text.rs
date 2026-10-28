//! Text engine benchmarks: `cargo bench --bench text`.

use criterion::{Criterion, criterion_group, criterion_main};
use desyn_text::content::{ParagraphFormat, SpanStyle, TextContent};
use desyn_text::{LayoutOptions, TextEngine};
use std::hint::black_box;

const INTER: &[u8] = include_bytes!("../fonts/Inter-VF.ttf");
const ARABIC: &[u8] = include_bytes!("../fonts/NotoSansArabic-VF.ttf");

fn paragraph(chars: usize) -> String {
    let base = "Design is not just what it looks like and feels like. Design is how it works. ";
    base.chars().cycle().take(chars).collect()
}

fn content(text: String, family: &str) -> TextContent {
    TextContent::plain(
        text,
        SpanStyle {
            families: vec![family.into()],
            size: 18.0,
            ..SpanStyle::default()
        },
        ParagraphFormat::default(),
    )
}

fn bench(c: &mut Criterion) {
    let mut e = TextEngine::new();
    e.db_mut().add_static_font(INTER).unwrap();
    e.db_mut().add_static_font(ARABIC).unwrap();
    let latin = content(paragraph(2000), "Inter");
    let arabic = content(
        "مرحبا بالعالم هذا نص عربي طويل لاختبار الأداء والتشكيل. "
            .chars()
            .cycle()
            .take(2000)
            .collect(),
        "Noto Sans Arabic",
    );
    let opts = LayoutOptions::wrapping(600.0);
    c.bench_function("layout 2k latin (cold caches)", |b| {
        b.iter(|| {
            e.clear_caches();
            black_box(e.layout(black_box(&latin), &opts))
        })
    });
    c.bench_function("layout 2k latin (warm shape cache)", |b| {
        b.iter(|| black_box(e.layout(black_box(&latin), &opts)))
    });
    c.bench_function("layout 2k arabic (cold caches)", |b| {
        b.iter(|| {
            e.clear_caches();
            black_box(e.layout(black_box(&arabic), &opts))
        })
    });
    c.bench_function("measure 2k latin (cold caches)", |b| {
        b.iter(|| {
            e.clear_caches();
            black_box(e.measure_content(black_box(&latin), &opts))
        })
    });
}

criterion_group!(benches, bench);
criterion_main!(benches);
