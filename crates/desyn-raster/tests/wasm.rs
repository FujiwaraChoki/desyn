//! Runs the renderer and exporters inside a real wasm runtime (Node via wasm-bindgen-test-runner):
//! `CARGO_TARGET_WASM32_UNKNOWN_UNKNOWN_RUNNER=wasm-bindgen-test-runner cargo test --target wasm32-unknown-unknown --test wasm`
#![cfg(target_arch = "wasm32")]

use desyn_core::model::Design;
use desyn_raster::export::{self, ExportOptions, Format, SvgText};
use desyn_raster::{MemoryAssetStore, PageRenderOptions, Renderer};
use desyn_text::TextEngine;
use wasm_bindgen_test::wasm_bindgen_test;

const SOCIAL: &str = include_str!("../../../spec/fixtures/render/social.json");
const PHOTO: &[u8] = include_bytes!("../../../spec/fixtures/render/assets/photo0000001.jpg");
const ICON: &[u8] = include_bytes!("../../../spec/fixtures/render/assets/icon00000001.svg");
const EFFECTS: &str = include_str!("../../../spec/fixtures/render/effects.json");

fn renderer() -> Renderer {
    let mut store = MemoryAssetStore::new();
    store.insert("photo0000001", PHOTO.to_vec());
    store.insert("icon00000001", ICON.to_vec());
    Renderer::new(TextEngine::with_bundled_fonts(), Box::new(store))
}

#[wasm_bindgen_test]
fn renders_and_exports_in_wasm() {
    let design = Design::from_json(SOCIAL).unwrap();
    let mut r = renderer();
    let page = r
        .render_page(
            &design,
            &PageRenderOptions {
                scale: 0.25,
                ..PageRenderOptions::default()
            },
        )
        .unwrap();
    assert_eq!((page.pixmap.width(), page.pixmap.height()), (270, 270));
    assert!(page.display_list.missing_assets.is_empty());
    // The photo, the headline and the button all paint.
    assert!(
        page.pixmap
            .pixels()
            .iter()
            .filter(|p| p.alpha() == 255)
            .count()
            > 270 * 260
    );
    for (format, magic) in [
        (Format::Png, &b"\x89PNG"[..]),
        (Format::Webp, &b"RIFF"[..]),
        (Format::Svg, &b"<svg"[..]),
        (Format::Pdf, &b"%PDF"[..]),
        (Format::Pptx, &b"PK"[..]),
    ] {
        let out = export::export(
            &mut r,
            &design,
            &ExportOptions {
                format,
                scale: 0.25,
                svg_text: SvgText::Outlines,
                ..ExportOptions::default()
            },
        )
        .unwrap();
        assert!(out.bytes.starts_with(magic), "{format:?}");
    }
    let effects = Design::from_json(EFFECTS).unwrap();
    let out = r
        .render_page(&effects, &PageRenderOptions::default())
        .unwrap();
    assert_eq!(out.pixmap.width(), 480);
}
