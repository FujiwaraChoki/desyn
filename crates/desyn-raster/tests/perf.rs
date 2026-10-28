//! Performance budgets (asserted in release builds only; debug builds just run the code paths):
//! * a typical 1080x1080 social design (photo with adjustments, gradient scrim, text, shadowed button, SVG logo)
//!   renders in < 8 ms (warm caches: decoded assets and node paints, i.e. the interactive / re-export case);
//! * moving one rectangle and redrawing only the damaged region takes < 2 ms (rebuild + damage + redraw).
#![cfg(not(target_arch = "wasm32"))]

use std::path::Path;
use std::time::{Duration, Instant};

use desyn_core::geometry::Affine;
use desyn_core::model::{Design, Fill, Node};
use desyn_raster::display::{BuildOptions, damage_rects};
use desyn_raster::tiny_skia::{IntRect, Pixmap};
use desyn_raster::{DirAssetStore, RasterOptions, Renderer};
use desyn_text::TextEngine;

fn fixtures() -> std::path::PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../spec/fixtures/render")
}

fn social() -> Design {
    Design::from_json(&std::fs::read_to_string(fixtures().join("social.json")).unwrap()).unwrap()
}

fn best_of(n: usize, mut f: impl FnMut()) -> Duration {
    let mut best = Duration::MAX;
    for _ in 0..n {
        let t = Instant::now();
        f();
        best = best.min(t.elapsed());
    }
    best
}

fn release() -> bool {
    !cfg!(debug_assertions)
}

#[test]
fn social_1080_full_render() {
    let design = social();
    let mut r = Renderer::new(
        TextEngine::with_bundled_fonts(),
        Box::new(DirAssetStore::new(fixtures().join("assets"))),
    );
    let opts = BuildOptions::default();
    let mut pix = Pixmap::new(1080, 1080).unwrap();
    let ro = RasterOptions::new(Affine::IDENTITY);
    // Warm-up: decode assets, shape text, fill caches.
    let dl = r.build(&design, &opts).unwrap();
    r.rasterize(&dl, &mut pix.as_mut(), &ro);
    let build = best_of(20, || {
        r.build(&design, &opts).unwrap();
    });
    let raster = best_of(20, || {
        let dl = r.build(&design, &opts).unwrap();
        r.rasterize(&dl, &mut pix.as_mut(), &ro);
    });
    eprintln!("social 1080x1080: build {build:?}, build + rasterize {raster:?}");
    if release() {
        assert!(
            raster < Duration::from_millis(8),
            "full render took {raster:?}"
        );
    }
}

#[test]
fn moved_rect_damage_redraw() {
    let mut design = social();
    let page = design.page_ids()[0].clone();
    // A plain card to drag around.
    let mut card =
        Node::rect("dragcard0001", "Drag", 300.0, 300.0, 160.0, 120.0).with_parent(page.clone());
    if let Some(s) = card.shaped_mut() {
        s.fills = vec![Fill::solid(
            desyn_core::model::Color::new("#4f8cff").unwrap(),
        )];
    }
    design.push_child(&page, card);
    let mut r = Renderer::new(
        TextEngine::with_bundled_fonts(),
        Box::new(DirAssetStore::new(fixtures().join("assets"))),
    );
    let opts = BuildOptions::default();
    let mut pix = Pixmap::new(1080, 1080).unwrap();
    let view = Affine::IDENTITY;
    let mut old = r.build(&design, &opts).unwrap();
    r.rasterize(&old, &mut pix.as_mut(), &RasterOptions::new(view));
    let full = IntRect::from_xywh(0, 0, 1080, 1080).unwrap();
    let mut x = 300.0;
    let mut redrawn_px = 0u64;
    let t = best_of(30, || {
        x += 3.0;
        if let Some(n) = design.node_mut("dragcard0001") {
            n.base_mut().x = x;
        }
        let new = r.build(&design, &opts).unwrap();
        let rects = damage_rects(&old, &new, &view, full, 8);
        for rect in &rects {
            redrawn_px += u64::from(rect.width()) * u64::from(rect.height());
            let ro = RasterOptions {
                transform: view,
                region: Some(*rect),
                background: None,
            };
            r.rasterize(&new, &mut pix.as_mut(), &ro);
        }
        old = new;
    });
    eprintln!(
        "moved rect: rebuild + damage + redraw {t:?} ({} px redrawn per frame)",
        redrawn_px / 30
    );
    // The damaged area is the union of old and new rectangle bounds, not the page.
    assert!(redrawn_px / 30 < 1080 * 1080 / 4);
    if release() {
        assert!(t < Duration::from_millis(2), "damage redraw took {t:?}");
    }
    // The incremental result equals a full render.
    let mut fresh = Pixmap::new(1080, 1080).unwrap();
    let dl = r.build(&design, &opts).unwrap();
    r.rasterize(&dl, &mut fresh.as_mut(), &RasterOptions::new(view));
    let diff = pix
        .data()
        .iter()
        .zip(fresh.data())
        .filter(|(a, b)| a.abs_diff(**b) > 2)
        .count();
    assert!(
        diff < 64,
        "incremental redraw differs from a full render in {diff} bytes"
    );
}

/// Interactive resize of the full-bleed photo: every frame draws the picture at a new device size, so the
/// resample cache cannot help; damage covers most of the page.
#[test]
fn photo_resize_frames() {
    let mut design = social();
    let mut r = Renderer::new(
        TextEngine::with_bundled_fonts(),
        Box::new(DirAssetStore::new(fixtures().join("assets"))),
    );
    let opts = BuildOptions::default();
    let mut pix = Pixmap::new(1080, 1080).unwrap();
    let view = Affine::IDENTITY;
    let mut old = r.build(&design, &opts).unwrap();
    r.rasterize(&old, &mut pix.as_mut(), &RasterOptions::new(view));
    let full = IntRect::from_xywh(0, 0, 1080, 1080).unwrap();
    let mut w = design.node("socialph0001").unwrap().base().width;
    let t = best_of(15, || {
        w -= 3.0;
        if let Some(n) = design.node_mut("socialph0001") {
            n.base_mut().width = w;
        }
        let new = r.build(&design, &opts).unwrap();
        for rect in damage_rects(&old, &new, &view, full, 8) {
            let ro = RasterOptions {
                transform: view,
                region: Some(rect),
                background: None,
            };
            r.rasterize(&new, &mut pix.as_mut(), &ro);
        }
        old = new;
    });
    eprintln!("photo resize: rebuild + damage + redraw {t:?}");
    if release() {
        assert!(
            t < Duration::from_millis(24),
            "photo resize frame took {t:?}"
        );
    }
}
