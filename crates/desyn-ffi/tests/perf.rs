//! Interactive-path timings through the facade (budgets asserted in release builds only):
//! `cargo test --release --test perf -- --nocapture`.

mod common;

use std::time::{Duration, Instant};

use common::*;
use desyn_ffi::{DesignPoint, OrientedBox, Viewport};

fn median(mut v: Vec<Duration>) -> Duration {
    v.sort();
    v[v.len() / 2]
}

#[test]
fn interactive_frames_stay_within_budget() {
    let engine = social_engine();
    // An iPhone-sized frame (1179 x 1179 device px showing the 1080 x 1080 post at 3x).
    let vp = Viewport {
        x: 0.0,
        y: 0.0,
        zoom: 393.0 / 1080.0,
        width: 1179,
        height: 1179,
        device_scale: 3.0,
    };
    let mut full = request(vp);
    full.full_redraw = true;
    // Warm caches (decoded photo, resampled image, glyph outlines).
    for _ in 0..3 {
        engine.render(full.clone()).unwrap();
    }
    let full_times: Vec<Duration> = (0..5)
        .map(|_| {
            let t = Instant::now();
            engine.render(full.clone()).unwrap();
            t.elapsed()
        })
        .collect();

    let mut buffer = vec![0u8; 1179 * 1179 * 4];
    let ptr = buffer.as_mut_ptr() as u64;
    let mut seq = engine
        .render_into(request(vp), ptr, buffer.len() as u64, 1179 * 4, 0)
        .unwrap()
        .sequence;
    let drag_times: Vec<Duration> = (0..20)
        .map(|i| {
            let t = Instant::now();
            engine
                .apply_transaction(
                    tx(
                        &format!("txdrag{i:06}"),
                        serde_json::json!([{ "op": "update", "id": "socialct0006", "set": { "x": 700 + i * 3 } }]),
                    ),
                    true,
                )
                .unwrap();
            let info = engine
                .render_into(request(vp), ptr, buffer.len() as u64, 1179 * 4, seq)
                .unwrap();
            seq = info.sequence;
            t.elapsed()
        })
        .collect();
    // A previewed gesture step: ops from the selection box against the committed state, preview, damage render.
    let ids = vec!["socialct0006".to_string()];
    let start = engine.selection_bounds(ids.clone()).unwrap().unwrap().obb;
    let preview_times: Vec<Duration> = (0..20)
        .map(|i| {
            let t = Instant::now();
            let mut to: OrientedBox = start;
            to.transform.tx += f64::from(i) * 4.0;
            let ops = engine
                .transform_selection(ids.clone(), start, to, false, false)
                .unwrap();
            let ops: serde_json::Value = serde_json::from_str(&ops).unwrap();
            engine
                .preview(tx(&format!("txprev{i:06}"), ops), true)
                .unwrap();
            let info = engine
                .render_into(request(vp), ptr, buffer.len() as u64, 1179 * 4, seq)
                .unwrap();
            seq = info.sequence;
            t.elapsed()
        })
        .collect();
    assert!(engine.commit_preview().is_some());
    let hit_times: Vec<Duration> = (0..50)
        .map(|i| {
            let t = Instant::now();
            engine
                .hit_test(
                    None,
                    DesignPoint {
                        x: 100.0 + f64::from(i) * 15.0,
                        y: 500.0,
                    },
                    hit_options(),
                )
                .unwrap();
            t.elapsed()
        })
        .collect();
    let (full_ms, drag_ms, preview_ms, hit_us) = (
        median(full_times).as_secs_f64() * 1e3,
        median(drag_times).as_secs_f64() * 1e3,
        median(preview_times).as_secs_f64() * 1e3,
        median(hit_times).as_secs_f64() * 1e6,
    );
    println!(
        "full frame 1179x1179: {full_ms:.2} ms; drag (apply + damage render + copy): {drag_ms:.2} ms; \
         preview step (transform + preview + damage render + copy): {preview_ms:.2} ms; hit test: {hit_us:.1} us"
    );
    if !cfg!(debug_assertions) {
        assert!(full_ms < 40.0, "full frame {full_ms} ms");
        assert!(drag_ms < 8.0, "drag frame {drag_ms} ms");
        assert!(preview_ms < 8.0, "preview step {preview_ms} ms");
        assert!(hit_us < 200.0, "hit test {hit_us} us");
    }
}
