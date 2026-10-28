//! Shared helpers for the facade tests.
#![allow(dead_code)]

use std::path::{Path, PathBuf};
use std::sync::Arc;

use desyn_core::model::{Design, DesignKind, Node};
use desyn_ffi::{Engine, HitOptions, RenderRequest, Viewport};

pub fn render_fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../spec/fixtures/render")
}

/// The 1080x1080 social fixture loaded with its assets.
pub fn social_engine() -> Arc<Engine> {
    let dir = render_fixtures();
    let engine = Engine::new();
    engine
        .load(
            std::fs::read_to_string(dir.join("social.json")).unwrap(),
            false,
        )
        .unwrap();
    engine.set_asset(
        "photo0000001".into(),
        std::fs::read(dir.join("assets/photo0000001.jpg")).unwrap(),
    );
    engine.set_asset(
        "icon00000001".into(),
        std::fs::read(dir.join("assets/icon00000001.svg")).unwrap(),
    );
    engine
}

/// A 400x300 page `page00000001` with two rects, a group of two rects and a text box.
pub fn simple_design() -> Design {
    let mut d = Design::with_page(
        "design000001",
        "Simple",
        DesignKind::SocialPost,
        "page00000001",
        400.0,
        300.0,
    );
    d.push_child(
        "page00000001",
        Node::rect("recta0000001", "A", 20.0, 20.0, 100.0, 50.0),
    );
    d.push_child(
        "page00000001",
        Node::rect("rectb0000001", "B", 200.0, 150.0, 80.0, 80.0),
    );
    d.push_child(
        "page00000001",
        Node::group("group0000001", "G", 40.0, 200.0, 120.0, 60.0),
    );
    d.push_child(
        "group0000001",
        Node::rect("grpkid000001", "G1", 0.0, 0.0, 50.0, 60.0),
    );
    d.push_child(
        "group0000001",
        Node::rect("grpkid000002", "G2", 70.0, 0.0, 50.0, 60.0),
    );
    d.push_child(
        "page00000001",
        Node::text(
            "text00000001",
            "Hello wide world 👋 again",
            220.0,
            20.0,
            Some(150.0),
        ),
    );
    d
}

pub fn simple_engine() -> Arc<Engine> {
    let engine = Engine::new();
    engine.load(simple_design().to_json(), true).unwrap();
    engine
}

pub fn viewport(width: u32, height: u32, zoom: f64) -> Viewport {
    Viewport {
        x: 0.0,
        y: 0.0,
        zoom,
        width,
        height,
        device_scale: 1.0,
    }
}

pub fn request(viewport: Viewport) -> RenderRequest {
    RenderRequest {
        page_id: None,
        viewport,
        background: Some("#202020".into()),
        hidden: Vec::new(),
        show_hidden: false,
        time_ms: None,
        bleed: false,
        full_redraw: false,
    }
}

pub fn hit_options() -> HitOptions {
    HitOptions {
        deep: false,
        include_locked: false,
        include_hidden: false,
        tolerance: 0.0,
    }
}

/// A transaction JSON with the given ops.
pub fn tx(id: &str, ops: serde_json::Value) -> String {
    serde_json::json!({ "id": id, "label": "test", "ops": ops, "source": "user", "ts": 0 })
        .to_string()
}
