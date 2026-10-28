//! Runs the engine inside a real wasm runtime (Node via wasm-bindgen-test-runner):
//! `CARGO_TARGET_WASM32_UNKNOWN_UNKNOWN_RUNNER=wasm-bindgen-test-runner cargo test --target wasm32-unknown-unknown --test wasm`
#![cfg(target_arch = "wasm32")]

mod common;

use common::*;
use desyn_core::layout::normalize_all;
use desyn_core::model::{Design, DesignKind, Node};
use desyn_text::{LayoutOptions, TextPosition};
use wasm_bindgen_test::wasm_bindgen_test;

#[wasm_bindgen_test]
fn layout_measure_caret_and_outlines_in_wasm() {
    let mut e = engine();
    let c = plain("Hello مرحبا 中文 😀 שלום", "Inter", 24.0);
    let l = e.layout(&c, &LayoutOptions::wrapping(160.0));
    assert!(l.lines.len() >= 2);
    let families: Vec<String> = l
        .runs
        .iter()
        .map(|r| e.db().face(r.face).unwrap().family.clone())
        .collect();
    for f in [
        "Inter",
        "Noto Sans Arabic",
        "Noto Sans SC",
        "Noto Color Emoji",
        "Noto Sans Hebrew",
    ] {
        assert!(
            families.iter().any(|x| x == f),
            "{f} missing from {families:?}"
        );
    }
    let caret = l.caret_rect(TextPosition::new(3));
    let hit = l.hit_test_point(caret.x, caret.y + caret.height / 2.0);
    assert_eq!(hit.index, 3);
    let outline = e.text_outline(&l);
    assert!(!outline.elements().is_empty());

    let mut d = Design::with_page(
        "design000001",
        "T",
        DesignKind::Poster,
        "page00000001",
        400.0,
        400.0,
    );
    let mut n = Node::text("text00000001", "HHHH", 0.0, 0.0, None);
    if let Node::Text(t) = &mut n {
        t.style.font_family = "JetBrains Mono".into();
        t.style.font_size = 10.0;
    }
    d.push_child("page00000001", n);
    normalize_all(&mut d, &mut e);
    let b = d.node("text00000001").unwrap().base();
    assert!((b.width - 24.0).abs() < 1e-9 && (b.height - 12.0).abs() < 1e-9);
}
