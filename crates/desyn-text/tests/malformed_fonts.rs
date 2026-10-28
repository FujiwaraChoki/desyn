//! Malformed font bytes (user uploads are untrusted) never panic: registration fails cleanly or the damaged face
//! still lays out, outlines and paints.

mod common;

use common::*;
use desyn_text::{LayoutOptions, TextEngine};

/// xorshift64*.
fn rng(state: &mut u64) -> u64 {
    *state ^= *state >> 12;
    *state ^= *state << 25;
    *state ^= *state >> 27;
    state.wrapping_mul(0x2545_f491_4f6c_dd1d)
}

#[test]
fn corrupted_fonts_do_not_panic() {
    let cases: usize = std::env::var("MALFORMED_CASES")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(60);
    let mut state = 0x1234_5678_9abc_def0u64;
    let mut registered = 0usize;
    let sources: [&[u8]; 4] = [
        SERIF,
        COLOR_EMOJI,
        ARABIC,
        include_bytes!("fonts/InstrumentSerif-ascii.woff2"),
    ];
    for case in 0..cases {
        let src = sources[case % sources.len()];
        let mut bytes = src.to_vec();
        // Damage the table directory and a few random places (header fields drive most parsing).
        let flips = 1 + (rng(&mut state) % 24) as usize;
        for _ in 0..flips {
            let pos = if rng(&mut state).is_multiple_of(2) {
                (rng(&mut state) % 512.min(bytes.len() as u64)) as usize
            } else {
                (rng(&mut state) % bytes.len() as u64) as usize
            };
            bytes[pos] = rng(&mut state) as u8;
        }
        if rng(&mut state).is_multiple_of(5) {
            let cut = (rng(&mut state) % bytes.len() as u64) as usize;
            bytes.truncate(cut);
        }
        let mut e = TextEngine::new();
        if e.add_font_as(bytes, "Broken").is_err() {
            continue;
        }
        registered += 1;
        let mut c = plain("Hamburgefonstiv مرحبا 😀 ﬁ", "Broken", 32.0);
        c.spans[0].style.weight = 700.0;
        let l = e.layout(&c, &LayoutOptions::wrapping(200.0));
        let _ = e.text_paths(&l);
        let _ = e.text_outline(&l);
        for run in &l.runs {
            for g in &run.glyphs {
                let _ = e.color_glyph(run.instance, g.id, run.size, [0, 0, 0, 255]);
                let _ = e.bitmap_glyph(run.instance, g.id, run.size);
            }
        }
    }
    // Most damaged files still register, so layout / outline / paint paths are exercised.
    assert!(
        registered * 3 >= cases,
        "only {registered} of {cases} registered"
    );
}
