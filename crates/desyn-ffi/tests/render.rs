//! Rendering through the facade: golden parity with the renderer, damage-tracked frames, caller buffers with
//! stride, one-shot page renders and every export format.

mod common;

use std::sync::Arc;

use common::*;
use desyn_ffi::{
    DesignRect, Engine, EngineError, ExportBackground, ExportFormat, ExportPages, ExportRequest,
    PageImageRequest, PdfExportOptions,
};
use desyn_raster::assets::decode_image;

fn page_request(scale: f64) -> PageImageRequest {
    PageImageRequest {
        page_id: None,
        scale,
        region: None,
        transparent: false,
        background: None,
        time_ms: None,
        bleed: false,
        only: None,
        hidden: Vec::new(),
    }
}

fn export_request(format: ExportFormat, pages: ExportPages) -> ExportRequest {
    ExportRequest {
        format,
        pages,
        scale: 1.0,
        dpi: None,
        quality: 90,
        background: ExportBackground::Page,
        region: None,
        time_ms: None,
        pdf: None,
        svg_outlines: false,
        svg_embed_fonts: true,
        fps: 15.0,
        duration_ms: None,
        only: None,
        hidden: Vec::new(),
    }
}

/// Fraction of channels differing by more than 3 between two premultiplied buffers.
fn diff_share(a: &[u8], b: &[u8]) -> f64 {
    assert_eq!(a.len(), b.len());
    let bad = a.iter().zip(b).filter(|(x, y)| x.abs_diff(**y) > 3).count();
    bad as f64 / a.len() as f64
}

#[test]
fn page_render_matches_the_golden_image() {
    let engine = social_engine();
    // spec/fixtures/render/social.png is the 0.5x render (README of the fixtures).
    let frame = engine.render_page(page_request(0.5)).unwrap();
    assert_eq!(
        (frame.width, frame.height, frame.stride),
        (540, 540, 540 * 4)
    );
    assert!(
        frame.info.missing_assets.is_empty(),
        "{:?}",
        frame.info.missing_assets
    );
    assert!(frame.info.warnings.is_empty(), "{:?}", frame.info.warnings);
    let golden = std::fs::read(render_fixtures().join("social.png")).unwrap();
    let expected = decode_image(golden.into()).unwrap();
    assert_eq!((expected.width(), expected.height()), (540, 540));
    let share = diff_share(&frame.pixels, expected.pixmap().data());
    assert!(
        share < 0.003,
        "{share} of channels differ from the golden image"
    );
}

#[test]
fn interactive_frame_redraws_only_damage_and_matches_a_full_render() {
    let engine = simple_engine();
    let vp = viewport(400, 300, 1.0);
    let first = engine.render(request(vp)).unwrap();
    assert!(first.info.full);
    assert_eq!(first.info.damage.len(), 1);
    assert_eq!(first.pixels.len(), 400 * 300 * 4);

    // Unchanged design: nothing to redraw.
    let same = engine.render(request(vp)).unwrap();
    assert!(!same.info.full);
    assert!(same.info.damage.is_empty(), "{:?}", same.info.damage);
    assert_eq!(same.pixels, first.pixels);

    // Move one rect: only its old and new areas are redrawn.
    engine
        .apply_transaction(
            tx(
                "txmove000001",
                serde_json::json!([{ "op": "update", "id": "rectb0000001", "set": { "x": 260 } }]),
            ),
            true,
        )
        .unwrap();
    let moved = engine.render(request(vp)).unwrap();
    assert!(!moved.info.full);
    let area: u32 = moved.info.damage.iter().map(|r| r.width * r.height).sum();
    assert!(
        area > 0 && area < 400 * 300 / 2,
        "damage {:?}",
        moved.info.damage
    );
    assert_ne!(moved.pixels, first.pixels);

    let mut full = request(vp);
    full.full_redraw = true;
    let reference = engine.render(full).unwrap();
    assert!(reference.info.full);
    assert_eq!(moved.pixels, reference.pixels);
}

#[test]
fn viewport_changes_trigger_full_redraws() {
    let engine = simple_engine();
    engine.render(request(viewport(200, 150, 0.5))).unwrap();
    let zoomed = engine.render(request(viewport(200, 150, 1.0))).unwrap();
    assert!(zoomed.info.full);
    let resized = engine.render(request(viewport(220, 150, 1.0))).unwrap();
    assert!(resized.info.full);
    assert_eq!(resized.pixels.len(), 220 * 150 * 4);
    let mut other_bg = request(viewport(220, 150, 1.0));
    other_bg.background = Some("#ffffff".into());
    assert!(engine.render(other_bg).unwrap().info.full);
}

#[test]
fn render_into_writes_rows_at_the_callers_stride() {
    let engine = simple_engine();
    let vp = viewport(120, 90, 0.5);
    let stride = 120 * 4 + 64;
    let len = stride * 90;
    let mut buffer = vec![0xabu8; len];
    let ptr = buffer.as_mut_ptr() as u64;
    let into = |seq: u64| {
        engine
            .render_into(request(vp), ptr, len as u64, stride as u32, seq)
            .unwrap()
    };
    let same_rows = |buffer: &[u8], reference: &[u8]| {
        (0..90).all(|y| buffer[y * stride..y * stride + 480] == reference[y * 480..(y + 1) * 480])
    };

    let info = into(0);
    assert!(info.full);
    assert_eq!(info.sequence, 1);
    let reference = engine.render(request(vp)).unwrap();
    assert_eq!(reference.info.sequence, 2);
    assert!(same_rows(&buffer, &reference.pixels));
    // Row padding is never written.
    for y in 0..90 {
        assert!(
            buffer[y * stride + 480..(y + 1) * stride]
                .iter()
                .all(|b| *b == 0xab)
        );
    }

    // The buffer shows frame 1 but the engine's previous frame is 2: the whole frame is copied.
    engine
        .apply_transaction(
            tx("txcolor00001", serde_json::json!([{ "op": "update", "id": "recta0000001", "set": { "fills": [{ "type": "solid", "color": "#ff3300" }] } }])),
            true,
        )
        .unwrap();
    let info = into(1);
    assert_eq!(info.sequence, 3);
    assert!(!info.full && !info.damage.is_empty());
    let mut full = request(vp);
    full.full_redraw = true;
    let reference = engine.render(full).unwrap();
    assert!(same_rows(&buffer, &reference.pixels));

    // The buffer holds frame 5 = the engine's previous frame: only the damage is copied.
    let info = into(0);
    assert_eq!(info.sequence, 5);
    engine
        .apply_transaction(
            tx(
                "txnudge00001",
                serde_json::json!([{ "op": "update", "id": "recta0000001", "set": { "x": 24 } }]),
            ),
            true,
        )
        .unwrap();
    // Poison a pixel far from the change: a damage-only copy leaves it alone.
    let far = 85 * stride + 115 * 4;
    let poisoned = buffer[far] ^ 0xff;
    buffer[far] = poisoned;
    let info = into(5);
    assert_eq!(info.sequence, 6);
    assert!(!info.full && !info.damage.is_empty());
    assert_eq!(
        buffer[far], poisoned,
        "pixels outside the damage are not rewritten"
    );
    buffer[far] ^= 0xff;
    let reference = engine.render(request(vp)).unwrap();
    assert!(same_rows(&buffer, &reference.pixels));
}

#[test]
fn render_into_rejects_bad_buffers() {
    let engine = simple_engine();
    let vp = viewport(64, 64, 1.0);
    let mut buffer = vec![0u8; 64 * 64 * 4];
    let ptr = buffer.as_mut_ptr() as u64;
    let short = engine.render_into(request(vp), ptr, (64 * 64 * 4 - 1) as u64, 256, 0);
    assert!(matches!(short, Err(EngineError::InvalidArgument { .. })));
    let narrow = engine.render_into(request(vp), ptr, buffer.len() as u64, 255, 0);
    assert!(matches!(narrow, Err(EngineError::InvalidArgument { .. })));
    let null = engine.render_into(request(vp), 0, buffer.len() as u64, 256, 0);
    assert!(matches!(null, Err(EngineError::InvalidArgument { .. })));
    assert!(
        engine
            .render_into(request(vp), ptr, buffer.len() as u64, 256, 0)
            .is_ok()
    );
}

#[test]
fn render_arguments_are_validated() {
    let engine = simple_engine();
    let mut bad_zoom = request(viewport(10, 10, 0.0));
    assert!(matches!(
        engine.render(bad_zoom.clone()),
        Err(EngineError::InvalidArgument { .. })
    ));
    bad_zoom.viewport.zoom = f64::NAN;
    assert!(matches!(
        engine.render(bad_zoom),
        Err(EngineError::InvalidArgument { .. })
    ));
    assert!(matches!(
        engine.render(request(viewport(0, 10, 1.0))),
        Err(EngineError::InvalidArgument { .. })
    ));
    assert!(matches!(
        engine.render(request(viewport(20000, 10, 1.0))),
        Err(EngineError::InvalidArgument { .. })
    ));
    let mut bad_color = request(viewport(10, 10, 1.0));
    bad_color.background = Some("red".into());
    assert!(matches!(
        engine.render(bad_color),
        Err(EngineError::InvalidArgument { .. })
    ));
    let mut bad_page = request(viewport(10, 10, 1.0));
    bad_page.page_id = Some("nope00000000".into());
    assert!(matches!(
        engine.render(bad_page),
        Err(EngineError::PageNotFound { .. })
    ));
    let empty = Engine::new();
    assert_eq!(
        empty.render(request(viewport(10, 10, 1.0))).unwrap_err(),
        EngineError::NoDesign
    );
}

#[test]
fn hidden_nodes_are_left_out_of_the_frame() {
    let engine = simple_engine();
    let vp = viewport(400, 300, 1.0);
    let with = engine.render(request(vp)).unwrap();
    let mut req = request(vp);
    req.hidden = vec!["recta0000001".into()];
    let without = engine.render(req).unwrap();
    assert!(!without.info.full);
    // The damage covers the hidden rect (20, 20, 100 x 50).
    assert!(
        without
            .info
            .damage
            .iter()
            .any(|r| r.x <= 20 && r.y <= 20 && r.x + r.width >= 120 && r.y + r.height >= 70)
    );
    let px = |f: &desyn_ffi::RenderedFrame| {
        f.pixels[(40 * 400 + 60) * 4..(40 * 400 + 60) * 4 + 4].to_vec()
    };
    assert_ne!(px(&with), px(&without));
}

#[test]
fn page_render_regions_and_transparency() {
    let engine = simple_engine();
    let mut req = page_request(2.0);
    req.region = Some(DesignRect {
        x: 20.0,
        y: 20.0,
        width: 100.0,
        height: 50.0,
    });
    let region = engine.render_page(req).unwrap();
    assert_eq!((region.width, region.height), (200, 100));
    // Inside the default gray rect: opaque.
    assert_eq!(region.pixels[3], 255);

    let mut transparent = page_request(1.0);
    transparent.transparent = true;
    let t = engine.render_page(transparent).unwrap();
    // A corner of the page with no content is fully transparent.
    assert_eq!(&t.pixels[..4], &[0, 0, 0, 0]);
}

#[test]
fn exports_every_format() {
    let engine = social_engine();
    let cases: [(ExportFormat, &[u8], &str); 7] = [
        (ExportFormat::Png, b"\x89PNG", "image/png"),
        (ExportFormat::Jpeg, b"\xff\xd8\xff", "image/jpeg"),
        (ExportFormat::Webp, b"RIFF", "image/webp"),
        (ExportFormat::Svg, b"<svg", "image/svg+xml"),
        (ExportFormat::Pdf, b"%PDF", "application/pdf"),
        (
            ExportFormat::Pptx,
            b"PK",
            "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        ),
        (ExportFormat::Gif, b"GIF8", "image/gif"),
    ];
    for (format, magic, mime) in cases {
        let mut req = export_request(format, ExportPages::First);
        req.scale = 0.25;
        let out = engine.export(req).unwrap();
        let head = if format == ExportFormat::Svg {
            let text = String::from_utf8_lossy(&out.bytes);
            let at = text.find("<svg").expect("svg root");
            out.bytes[at..at + 4].to_vec()
        } else {
            out.bytes[..magic.len()].to_vec()
        };
        assert_eq!(head, magic, "{format:?}");
        assert_eq!(out.mime, mime);
        assert_eq!(out.pages, 1);
        assert!(
            out.missing_assets.is_empty(),
            "{format:?}: {:?}",
            out.missing_assets
        );
    }

    let mut pdf = export_request(ExportFormat::Pdf, ExportPages::All);
    pdf.pdf = Some(PdfExportOptions {
        bleed: true,
        crop_marks: true,
        cmyk: false,
        flatten: false,
        dpi: 150.0,
        title: Some("Social".into()),
    });
    assert!(engine.export(pdf).unwrap().bytes.starts_with(b"%PDF"));

    let mut transparent = export_request(ExportFormat::Png, ExportPages::Index { index: 0 });
    transparent.background = ExportBackground::Color {
        hex: "#ffb02e".into(),
    };
    assert!(engine.export(transparent).is_ok());

    let pages = engine
        .export_pages(export_request(ExportFormat::Png, ExportPages::All))
        .unwrap();
    assert_eq!(pages.len(), 1);
    assert_eq!(pages[0].page_id, "socialpa0010");

    let missing = engine.export(export_request(
        ExportFormat::Png,
        ExportPages::Page {
            id: "nope00000000".into(),
        },
    ));
    assert!(matches!(missing, Err(EngineError::PageNotFound { .. })));
    let mut bad_scale = export_request(ExportFormat::Png, ExportPages::First);
    bad_scale.scale = 0.0;
    assert!(matches!(
        engine.export(bad_scale),
        Err(EngineError::InvalidArgument { .. })
    ));
}

#[test]
fn missing_assets_are_reported_and_fetched() {
    let dir = render_fixtures();
    let engine = Engine::new();
    engine
        .load(
            std::fs::read_to_string(dir.join("social.json")).unwrap(),
            false,
        )
        .unwrap();
    let frame = engine.render(request(viewport(270, 270, 0.25))).unwrap();
    let mut missing = frame.info.missing_assets.clone();
    missing.sort();
    assert_eq!(missing, ["icon00000001", "photo0000001"]);
    engine.set_asset(
        "photo0000001".into(),
        std::fs::read(dir.join("assets/photo0000001.jpg")).unwrap(),
    );
    engine.set_asset(
        "icon00000001".into(),
        std::fs::read(dir.join("assets/icon00000001.svg")).unwrap(),
    );
    let frame = engine.render(request(viewport(270, 270, 0.25))).unwrap();
    assert!(frame.info.missing_assets.is_empty());
    assert!(!frame.info.damage.is_empty());
}

#[test]
fn engine_is_shared_across_threads() {
    fn assert_send_sync<T: Send + Sync>() {}
    assert_send_sync::<Engine>();
    let engine: Arc<Engine> = simple_engine();
    let workers: Vec<_> = (0..4)
        .map(|i| {
            let e = engine.clone();
            std::thread::spawn(move || {
                for k in 0..10 {
                    if i % 2 == 0 {
                        let f = e.render(request(viewport(200, 150, 0.5))).unwrap();
                        assert_eq!(f.pixels.len(), 200 * 150 * 4);
                    } else {
                        let id = format!("txthread{i}{k:03}");
                        e.apply_transaction(
                            tx(&id, serde_json::json!([{ "op": "update", "id": "rectb0000001", "set": { "x": 200 + k } }])),
                            true,
                        )
                        .unwrap();
                        e.hit_test(None, desyn_ffi::DesignPoint { x: 30.0, y: 30.0 }, hit_options()).unwrap();
                    }
                }
            })
        })
        .collect();
    for w in workers {
        w.join().unwrap();
    }
    assert!(engine.revision() > 0);
}
