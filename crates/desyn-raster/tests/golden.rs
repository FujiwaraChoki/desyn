//! Golden image tests: every `spec/fixtures/render/<name>.json` is rendered and compared with `<name>.png`.
//!
//! * `DESYN_UPDATE_GOLDENS=1` rewrites the expected PNGs (inspect them before committing).
//! * `DESYN_GOLDEN_OUT=<dir>` also writes the actual renders (and diffs of failures) there.
//!
//! Per-fixture settings live in the design's `meta.render`: `scale` (default 1) and `timeMs` (animation time).
#![cfg(not(target_arch = "wasm32"))]

use std::path::{Path, PathBuf};

use desyn_core::model::Design;
use desyn_raster::export::bitmap::pixmap_rgba;
use desyn_raster::{DirAssetStore, PageRenderOptions, Renderer};
use desyn_text::TextEngine;

/// Channel difference treated as equal (antialiasing / float rounding).
const CHANNEL_TOLERANCE: u8 = 3;
/// Share of pixels allowed to exceed the channel tolerance.
const PIXEL_TOLERANCE: f64 = 0.003;

fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../spec/fixtures/render")
}

fn renderer() -> Renderer {
    Renderer::new(
        TextEngine::with_bundled_fonts(),
        Box::new(DirAssetStore::new(fixtures().join("assets"))),
    )
}

/// Renders a fixture with its settings.
pub fn render_fixture(name: &str) -> (u32, u32, Vec<u8>) {
    let path = fixtures().join(format!("{name}.json"));
    let design = Design::from_json(&std::fs::read_to_string(&path).unwrap()).unwrap();
    let settings = design.meta.get("render").cloned().unwrap_or_default();
    let scale = settings
        .get("scale")
        .and_then(|v| v.as_f64())
        .unwrap_or(1.0);
    let time = settings.get("timeMs").and_then(|v| v.as_f64());
    let mut r = renderer();
    let out = r
        .render_page(
            &design,
            &PageRenderOptions {
                scale,
                time_ms: time,
                ..PageRenderOptions::default()
            },
        )
        .unwrap();
    assert!(
        out.display_list.missing_assets.is_empty(),
        "{name}: missing assets {:?}",
        out.display_list.missing_assets
    );
    assert!(
        out.display_list.warnings.is_empty(),
        "{name}: warnings {:?}",
        out.display_list.warnings
    );
    (
        out.pixmap.width(),
        out.pixmap.height(),
        pixmap_rgba(&out.pixmap),
    )
}

fn decode(path: &Path) -> Option<(u32, u32, Vec<u8>)> {
    let img = image::load_from_memory(&std::fs::read(path).ok()?)
        .ok()?
        .to_rgba8();
    Some((img.width(), img.height(), img.into_raw()))
}

#[test]
fn golden_images() {
    let dir = fixtures();
    let update = std::env::var("DESYN_UPDATE_GOLDENS").is_ok_and(|v| v == "1");
    let out_dir = std::env::var("DESYN_GOLDEN_OUT").ok().map(PathBuf::from);
    let mut names: Vec<String> = std::fs::read_dir(&dir)
        .unwrap()
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|e| e == "json"))
        .filter_map(|p| p.file_stem().map(|s| s.to_string_lossy().to_string()))
        .collect();
    names.sort();
    assert!(names.len() >= 10, "fixtures missing: {names:?}");
    let mut failures = Vec::new();
    for name in &names {
        let (w, h, rgba) = render_fixture(name);
        let png = desyn_raster::export::bitmap::encode_png_rgba(w, h, &rgba, None).unwrap();
        if let Some(o) = &out_dir {
            std::fs::create_dir_all(o).unwrap();
            std::fs::write(o.join(format!("{name}.png")), &png).unwrap();
        }
        let expected = dir.join(format!("{name}.png"));
        if update {
            std::fs::write(&expected, &png).unwrap();
            continue;
        }
        let Some((ew, eh, exp)) = decode(&expected) else {
            failures.push(format!(
                "{name}: no expected image (run with DESYN_UPDATE_GOLDENS=1)"
            ));
            continue;
        };
        if (ew, eh) != (w, h) {
            failures.push(format!("{name}: size {w}x{h}, expected {ew}x{eh}"));
            continue;
        }
        let mut bad = 0usize;
        let mut max = 0u8;
        let mut diff = vec![0u8; rgba.len()];
        for (i, (a, b)) in rgba
            .as_chunks::<4>()
            .0
            .iter()
            .zip(exp.as_chunks::<4>().0)
            .enumerate()
        {
            let d = a
                .iter()
                .zip(b)
                .map(|(x, y)| x.abs_diff(*y))
                .max()
                .unwrap_or(0);
            max = max.max(d);
            if d > CHANNEL_TOLERANCE {
                bad += 1;
                diff[i * 4..i * 4 + 4].copy_from_slice(&[255, 0, 0, 255]);
            } else {
                diff[i * 4 + 3] = 40;
            }
        }
        let share = bad as f64 / (w as f64 * h as f64);
        if share > PIXEL_TOLERANCE {
            failures.push(format!(
                "{name}: {bad} pixels differ ({:.3}%), max channel diff {max}",
                share * 100.0
            ));
            if let Some(o) = &out_dir {
                let d = desyn_raster::export::bitmap::encode_png_rgba(w, h, &diff, None).unwrap();
                std::fs::write(o.join(format!("{name}.diff.png")), d).unwrap();
            }
        }
    }
    assert!(
        failures.is_empty(),
        "golden mismatches:\n{}",
        failures.join("\n")
    );
}
