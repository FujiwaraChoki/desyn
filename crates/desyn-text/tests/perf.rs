//! Performance budgets, asserted in release builds (`cargo test --release --test perf -- --nocapture`).

mod common;

use std::time::Instant;

use common::*;
use desyn_text::LayoutOptions;

fn paragraph(base: &str, chars: usize) -> String {
    base.chars().cycle().take(chars).collect()
}

#[test]
fn shaping_a_2k_char_paragraph_is_under_2ms() {
    let mut e = engine();
    let cases = [
        (
            "latin",
            plain(
                &paragraph(
                    "Design is not just what it looks like and feels like. Design is how it works. ",
                    2000,
                ),
                "Inter",
                18.0,
            ),
        ),
        (
            "arabic",
            plain(
                &paragraph(
                    "مرحبا بالعالم هذا نص عربي طويل لاختبار الأداء والتشكيل. ",
                    2000,
                ),
                "Noto Sans Arabic",
                18.0,
            ),
        ),
        (
            "cjk",
            plain(
                &paragraph(
                    "中文文本排版需要正确的换行规则。标点符号不能出现在行首，例如逗号、句号和问号？",
                    2000,
                ),
                "Noto Sans SC",
                18.0,
            ),
        ),
    ];
    let opts = LayoutOptions::wrapping(600.0);
    for (name, c) in &cases {
        // Warm the plan / outline-independent state once, then time cold shape caches.
        e.layout(c, &opts);
        let iters = if cfg!(debug_assertions) { 3 } else { 50 };
        let start = Instant::now();
        for _ in 0..iters {
            e.clear_caches();
            std::hint::black_box(e.layout(c, &opts));
        }
        let cold = start.elapsed().as_secs_f64() * 1000.0 / f64::from(iters);
        let start = Instant::now();
        for _ in 0..iters {
            std::hint::black_box(e.layout(c, &opts));
        }
        let warm = start.elapsed().as_secs_f64() * 1000.0 / f64::from(iters);
        println!("{name}: 2k chars cold {cold:.3} ms, warm {warm:.3} ms");
        if !cfg!(debug_assertions) {
            assert!(
                cold < 2.0,
                "{name} cold layout {cold:.3} ms exceeds the 2 ms budget"
            );
        }
    }
}
