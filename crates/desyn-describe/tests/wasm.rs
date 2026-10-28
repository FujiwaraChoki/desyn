//! Runs describe inside a real wasm runtime (Node via wasm-bindgen-test-runner):
//! `CARGO_TARGET_WASM32_UNKNOWN_UNKNOWN_RUNNER=wasm-bindgen-test-runner cargo test --target wasm32-unknown-unknown --test wasm`
#![cfg(target_arch = "wasm32")]

mod support;

use desyn_describe::{CompactOptions, compact_text};
use support::*;
use wasm_bindgen_test::wasm_bindgen_test;

fn fixture(json: &str) -> Fixture {
    serde_json::from_str(json).expect("fixture")
}

#[wasm_bindgen_test]
fn fixtures_pass_in_wasm() {
    let all = [
        ("shop-page", include_str!("fixtures/shop-page.json")),
        ("contrast", include_str!("fixtures/contrast.json")),
        ("text-fit", include_str!("fixtures/text-fit.json")),
        ("layout", include_str!("fixtures/layout.json")),
        ("patterns", include_str!("fixtures/patterns.json")),
        ("rtl", include_str!("fixtures/rtl.json")),
    ];
    for (name, json) in all {
        let f = fixture(json);
        let desc = run_fixture(&f);
        let fails = check(name, &desc, &f.expect);
        assert!(fails.is_empty(), "{}", fails.join("\n"));
        assert!(!compact_text(&desc, &CompactOptions::default()).is_empty());
    }
}
