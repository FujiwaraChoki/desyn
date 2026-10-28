//! The JavaScript-facing `Engine` inside a real wasm runtime (Node via wasm-bindgen-test-runner):
//! `CARGO_TARGET_WASM32_UNKNOWN_UNKNOWN_RUNNER=wasm-bindgen-test-runner cargo test --target wasm32-unknown-unknown --test wasm`
#![cfg(target_arch = "wasm32")]

use desyn_wasm::bindings::{Engine, engine_info};
use wasm_bindgen_test::wasm_bindgen_test;

const SHAPES: &str = include_str!("../../../spec/fixtures/render/shapes.json");
const TEXT: &str = include_str!("../../../spec/fixtures/render/text.json");

#[wasm_bindgen_test]
fn renders_and_answers_through_the_bindings() {
    let info: serde_json::Value = serde_json::from_str(&engine_info()).unwrap();
    assert!(
        info["formats"]
            .as_array()
            .unwrap()
            .iter()
            .any(|f| f == "png")
    );
    let mut e = Engine::new(&[5; 32]);
    let load: serde_json::Value = serde_json::from_str(&e.load(SHAPES).unwrap()).unwrap();
    assert_eq!(load["pages"][0]["width"], 480.0);
    let frame: serde_json::Value = serde_json::from_str(
        &e.render(r##"{"viewport":{"x":0,"y":0,"zoom":0.5,"width":240,"height":260,"dpr":1},"background":"#0e0e0e","budgetMs":8}"##)
            .unwrap(),
    )
    .unwrap();
    assert!(
        frame["pending"].as_u64().unwrap() == 0 || !frame["rects"].as_array().unwrap().is_empty()
    );
    assert_eq!(e.frame_len(), 240 * 260 * 4);
    assert!(e.frame_ptr() > 0);
    let hit: serde_json::Value =
        serde_json::from_str(&e.hit_test(r#"{"x":70,"y":55}"#).unwrap()).unwrap();
    assert_eq!(hit["id"], "rectplai0001");
    let r: serde_json::Value = serde_json::from_str(
        &e.apply_transaction(
            r#"{"id":"txwasm000001","label":"Move","source":"user","ts":0,"ops":[{"op":"update","id":"rectplai0001","set":{"x":200}}]}"#,
            true,
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(r["applied"].as_array().unwrap().len(), 1);
    let png = e.export(r#"{"format":"png","scale":0.25}"#).unwrap();
    assert_eq!(&png[..4], b"\x89PNG");
}

#[wasm_bindgen_test]
fn text_queries_and_relayout_without_fonts() {
    let mut e = Engine::new(&[6; 32]);
    e.load(TEXT).unwrap();
    let layout: serde_json::Value =
        serde_json::from_str(&e.text_layout("headline0001").unwrap()).unwrap();
    assert!(!layout["lines"].as_array().unwrap().is_empty());
    let q: serde_json::Value = serde_json::from_str(
        &e.text_query(r#"{"op":"move","nodeId":"headline0001","index":0,"direction":"right"}"#)
            .unwrap(),
    )
    .unwrap();
    assert_eq!(q["index"], 1);
    // Without fonts the engine asks for them.
    let req: serde_json::Value = serde_json::from_str(&e.take_requests()).unwrap();
    assert!(req["fontRequests"].is_array());
    assert!(e.relayout().is_ok());
}
