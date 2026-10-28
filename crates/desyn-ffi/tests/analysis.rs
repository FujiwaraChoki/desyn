//! Describe, lint and design tokens through the facade.

mod common;

use common::*;
use desyn_core::model::{AssetKind, AssetRef, Color, Fill, Node};
use desyn_ffi::{Engine, EngineError};

#[test]
fn describe_returns_the_contract_description() {
    let engine = social_engine();
    let json = engine.describe(String::new()).unwrap();
    let d: serde_json::Value = serde_json::from_str(&json).unwrap();
    assert_eq!(d["design"]["name"], "social");
    assert_eq!(d["page"]["id"], "socialpa0010");
    assert_eq!(d["page"]["width"], 1080.0);
    let tree = d["tree"].as_array().unwrap();
    assert!(
        tree.iter()
            .any(|n| n["id"] == "socialhe0004" && n["text"].is_string())
    );
    assert!(d["palette"].as_array().is_some_and(|p| !p.is_empty()));
    assert!(d["fonts"].as_array().is_some_and(|f| !f.is_empty()));
    assert!(d["issues"].is_array());

    let opts =
        serde_json::json!({ "selection": ["socialct0006"], "detail": "summary", "lint": false });
    let s: serde_json::Value =
        serde_json::from_str(&engine.describe(opts.to_string()).unwrap()).unwrap();
    assert_eq!(s["selection"], serde_json::json!(["socialct0006"]));
    assert_eq!(s["issues"], serde_json::json!([]));

    let missing = engine.describe(serde_json::json!({ "pageId": "nope00000000" }).to_string());
    assert!(matches!(missing, Err(EngineError::PageNotFound { .. })));
    assert!(matches!(
        engine.describe("{".into()),
        Err(EngineError::InvalidJson { .. })
    ));
    assert_eq!(
        Engine::new().describe(String::new()).unwrap_err(),
        EngineError::NoDesign
    );
}

#[test]
fn lint_reports_fixable_issues() {
    let engine = simple_engine();
    // A text box pushed off the page is an error with a fix.
    engine
        .apply_transaction(
            tx(
                "txoffpage001",
                serde_json::json!([{ "op": "update", "id": "text00000001", "set": { "x": 900 } }]),
            ),
            true,
        )
        .unwrap();
    let issues: Vec<serde_json::Value> =
        serde_json::from_str(&engine.lint(String::new()).unwrap()).unwrap();
    let off = issues
        .iter()
        .find(|i| i["code"] == "off-page" && i["ids"][0] == "text00000001")
        .expect("off-page issue");
    let fix = off["fix"].as_array().expect("fix ops").clone();
    let applied = engine
        .apply_transaction(tx("txfix0000001", serde_json::Value::Array(fix)), true)
        .unwrap();
    assert!(applied.dropped.is_empty());
    let issues: Vec<serde_json::Value> =
        serde_json::from_str(&engine.lint(String::new()).unwrap()).unwrap();
    assert!(
        !issues
            .iter()
            .any(|i| i["code"] == "off-page" && i["ids"][0] == "text00000001")
    );
}

#[test]
fn contrast_over_photos_uses_the_decoded_pixels() {
    // White text on a white photo: only the photo's pixels reveal the problem.
    let mut design = simple_design();
    let mut photo = AssetRef::new("photo0000001", AssetKind::Image, "image/png");
    photo.width = Some(64.0);
    photo.height = Some(64.0);
    design.assets.insert(photo.id.clone(), photo);
    design.push_child(
        "page00000001",
        Node::image(
            "image0000001",
            "Photo",
            "photo0000001",
            0.0,
            0.0,
            400.0,
            300.0,
        ),
    );
    design.push_child(
        "page00000001",
        Node::text("label0000001", "Summer sale", 40.0, 120.0, Some(300.0)),
    );
    if let Some(Node::Text(t)) = design.nodes.get_mut("label0000001") {
        t.style.fills = vec![Fill::solid(Color::new("#ffffff").unwrap())];
    }
    let engine = Engine::new();
    engine.load(design.to_json(), true).unwrap();
    let low_contrast = |engine: &Engine| {
        let issues: Vec<serde_json::Value> =
            serde_json::from_str(&engine.lint(String::new()).unwrap()).unwrap();
        issues
            .iter()
            .any(|i| i["code"] == "low-contrast" && i["ids"][0] == "label0000001")
    };
    // Without bytes the backdrop is unknown: no verdict.
    assert!(!low_contrast(&engine));
    let white = vec![255u8; 64 * 64 * 4];
    let png = desyn_raster::export::bitmap::encode_png_rgba(64, 64, &white, None).unwrap();
    engine.set_asset("photo0000001".into(), png);
    assert!(low_contrast(&engine));
}

#[test]
fn compact_text_and_tokens() {
    let engine = social_engine();
    let text = engine.describe_text(String::new(), 400).unwrap();
    assert!(text.len() > 40);
    assert!(
        text.len() / 4 <= 400 + 50,
        "{} bytes exceed the budget",
        text.len()
    );
    let tokens: serde_json::Value =
        serde_json::from_str(&engine.design_tokens(None).unwrap()).unwrap();
    assert!(tokens["palette"].as_array().is_some_and(|p| !p.is_empty()));
    assert!(
        tokens["typeScale"]
            .as_array()
            .is_some_and(|t| !t.is_empty())
    );
    let page: serde_json::Value =
        serde_json::from_str(&engine.design_tokens(Some("socialpa0010".into())).unwrap()).unwrap();
    assert_eq!(page["typeScale"], tokens["typeScale"]);
}
