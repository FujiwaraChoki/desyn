//! Engine behavior on the shared fixtures (native): loading, incremental rendering (damage, scroll reuse,
//! progressive tiles) against full renders, previews, hit testing, snapping, text geometry, assets, export,
//! describe and measuring.

use desyn_wasm::EngineCore;
use desyn_wasm::protocol::{
    HandlesRequest, HitRequest, MeasureItem, RenderRequest, SnapRequest, TextQuery, ViewportSpec,
};
use serde_json::{Value, json};

const FIXTURES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../spec/fixtures/render");

fn fixture(name: &str) -> String {
    std::fs::read_to_string(format!("{FIXTURES}/{name}.json")).expect("fixture")
}

fn engine(name: &str) -> EngineCore {
    let mut e = EngineCore::new(&[7; 32]);
    for f in desyn_text::font::bundled::fonts() {
        e.set_font(f.bytes, Some(f.family)).expect("bundled font");
    }
    e.load(&fixture(name)).expect("load");
    for entry in std::fs::read_dir(format!("{FIXTURES}/assets")).unwrap() {
        let path = entry.unwrap().path();
        let id = path.file_stem().unwrap().to_str().unwrap().to_string();
        let bytes = std::fs::read(&path).unwrap();
        if e.design().assets.contains_key(&id) {
            e.set_asset(&id, &bytes).expect("fixture asset");
        }
    }
    e
}

fn view(x: f64, y: f64, zoom: f64, w: u32, h: u32) -> ViewportSpec {
    ViewportSpec {
        x,
        y,
        zoom,
        width: w,
        height: h,
        dpr: 1.0,
    }
}

fn request(v: ViewportSpec) -> RenderRequest {
    RenderRequest {
        viewport: Some(v),
        background: Some("#0e0e0e".into()),
        page_shadow: true,
        ..Default::default()
    }
}

fn full_render(name: &str, v: ViewportSpec, tx: Option<&str>) -> Vec<u8> {
    let mut e = engine(name);
    if let Some(tx) = tx {
        e.apply(tx, true).unwrap();
    }
    let info = e.render(&request(v)).unwrap();
    assert_eq!(info.pending, 0);
    e.frame_bytes().to_vec()
}

/// Fraction of pixels whose channels differ by more than `tol`.
fn diff_ratio(a: &[u8], b: &[u8], tol: u8) -> f64 {
    assert_eq!(a.len(), b.len());
    let px = a.len() / 4;
    let bad = a
        .as_chunks::<4>()
        .0
        .iter()
        .zip(b.as_chunks::<4>().0.iter())
        .filter(|(p, q)| p.iter().zip(q.iter()).any(|(x, y)| x.abs_diff(*y) > tol))
        .count();
    bad as f64 / px as f64
}

/// Writes a frame as PNG into `DESYN_WASM_TEST_OUT` (when set) for inspection.
fn dump(name: &str, rgba: &[u8], w: u32, h: u32) {
    let Ok(dir) = std::env::var("DESYN_WASM_TEST_OUT") else {
        return;
    };
    let png = desyn_raster::export::bitmap::encode_png_rgba(w, h, rgba, None).expect("png");
    std::fs::write(format!("{dir}/{name}.png"), png).expect("write");
}

fn move_tx(id: &str, x: f64, y: f64) -> String {
    json!({
        "id": "txmove000001",
        "label": "Move",
        "ops": [{ "op": "update", "id": id, "set": { "x": x, "y": y } }],
        "source": "user",
        "ts": 0
    })
    .to_string()
}

#[test]
fn loads_and_reports_pages() {
    let e = engine("social");
    let pages = e.pages();
    assert_eq!(pages.len(), 1);
    assert_eq!((pages[0].width, pages[0].height), (1080.0, 1080.0));
    let mut bad = EngineCore::new(&[]);
    assert!(bad.load("{\"schema\":1}").is_err());
    assert!(bad.render(&request(view(0.0, 0.0, 1.0, 10, 10))).is_err());
}

#[test]
fn unchanged_frames_draw_nothing() {
    let mut e = engine("shapes");
    let v = view(-40.0, -30.0, 1.0, 560, 600);
    let first = e.render(&request(v)).unwrap();
    assert!(first.full && first.built);
    assert_eq!(first.pending, 0);
    assert_eq!(first.rects, vec![[0, 0, 560, 600]]);
    let again = e.render(&request(v)).unwrap();
    assert!(again.rects.is_empty() && !again.built && !again.full);
    // Opaque pasteboard: every presented pixel is opaque.
    assert!(
        e.frame_bytes()
            .as_chunks::<4>()
            .0
            .iter()
            .all(|p| p[3] == 255)
    );
}

#[test]
fn damage_redraw_matches_a_full_render() {
    let v = view(-40.0, -30.0, 1.25, 640, 700);
    let mut e = engine("shapes");
    e.render(&request(v)).unwrap();
    let tx = move_tx("rectplai0001", 60.0, 300.0);
    e.apply(&tx, true).unwrap();
    let info = e.render(&request(v)).unwrap();
    assert!(!info.full);
    let area: i64 = info
        .rects
        .iter()
        .map(|r| i64::from(r[2]) * i64::from(r[3]))
        .sum();
    assert!(
        area > 0 && area < 640 * 700 / 2,
        "only the damage is redrawn: {area}"
    );
    let expect = full_render("shapes", v, Some(&tx));
    assert!(diff_ratio(e.frame_bytes(), &expect, 2) < 0.0005);
}

#[test]
fn whole_pixel_pans_scroll_and_match_a_full_render() {
    let mut e = engine("social");
    let v0 = view(100.0, 80.0, 0.5, 480, 360);
    e.render(&request(v0)).unwrap();
    // 0.5 zoom: 34 design px = 17 device px.
    let v1 = view(66.0, 96.0, 0.5, 480, 360);
    let info = e.render(&request(v1)).unwrap();
    assert_eq!(info.scroll, Some([17, -8]));
    let area: i64 = info
        .rects
        .iter()
        .map(|r| i64::from(r[2]) * i64::from(r[3]))
        .sum();
    assert!(area < 480 * 360 / 4, "only exposed strips: {area}");
    let expect = full_render("social", v1, None);
    // The noise effect is anchored to device pixels, everything else must match.
    let ratio = diff_ratio(e.frame_bytes(), &expect, 3);
    if ratio >= 0.01 {
        dump("scroll-actual", e.frame_bytes(), 480, 360);
        dump("scroll-expect", &expect, 480, 360);
    }
    assert!(ratio < 0.01, "{ratio}");
    // A fractional pan redraws everything.
    let info = e.render(&request(view(66.3, 96.0, 0.5, 480, 360))).unwrap();
    assert!(info.full && info.scroll.is_none());
}

#[test]
fn budgets_render_progressively_and_converge() {
    let mut e = engine("social");
    let v = ViewportSpec {
        dpr: 2.0,
        ..view(0.0, 0.0, 1.0, 1800, 1600)
    };
    let mut req = request(v);
    req.budget_ms = Some(0.0001);
    let first = e.render(&req).unwrap();
    assert!(first.full);
    assert_eq!(
        first.rects.len(),
        1,
        "one tile per call under a tiny budget"
    );
    assert!(first.pending > 0);
    // The first tile is the one nearest the viewport center.
    let t = first.rects[0];
    assert!(t[0] <= 900 && t[0] + t[2] >= 900 && t[1] <= 800 && t[1] + t[3] >= 800);
    let mut calls = 1;
    let mut last = first;
    while last.pending > 0 {
        last = e.render(&req).unwrap();
        calls += 1;
        assert!(calls < 200);
    }
    assert!(calls > 4);
    let expect = full_render("social", v, None);
    assert!(diff_ratio(e.frame_bytes(), &expect, 3) < 0.01);
}

#[test]
fn translucent_pasteboard_presents_straight_alpha() {
    let mut e = engine("shapes");
    let mut req = request(view(-50.0, -50.0, 1.0, 600, 640));
    req.background = None;
    req.page_shadow = true;
    e.render(&req).unwrap();
    let bytes = e.frame_bytes();
    // Top-left corner is outside the page and its shadow: fully transparent.
    assert_eq!(&bytes[..4], &[0, 0, 0, 0]);
    // A shadow pixel just below the page: black with partial alpha, stored unpremultiplied.
    let (w, x, y) = (600usize, 300usize, 50 + 520 + 10);
    let p = &bytes[(y * w + x) * 4..(y * w + x) * 4 + 4];
    assert!(p[3] > 0 && p[3] < 255 && p[0] == 0, "{p:?}");
}

#[test]
fn previews_revert_commit_and_survive_remote_changes() {
    let mut e = engine("shapes");
    let original = e.snapshot();
    let r = e
        .preview(&move_tx("rectplai0001", 200.0, 200.0), true)
        .unwrap();
    assert!(!r.applied.is_empty());
    assert!(e.snapshot().contains("\"x\":200"));
    // Another preview replaces the first (relative to the committed state).
    e.preview(&move_tx("rectplai0001", 210.0, 220.0), true)
        .unwrap();
    assert!(e.cancel_preview());
    assert_eq!(e.snapshot(), original);
    // A remote change while dragging keeps the drag on top.
    e.preview(&move_tx("rectplai0001", 300.0, 310.0), true)
        .unwrap();
    let remote = json!({
        "id": "txremote0001", "label": "Remote", "source": "user", "ts": 0,
        "ops": [{ "op": "update", "id": "rectradi0002", "set": { "opacity": 0.5 } }]
    })
    .to_string();
    e.apply(&remote, true).unwrap();
    let d: Value = serde_json::from_str(&e.snapshot()).unwrap();
    assert_eq!(d["nodes"]["rectplai0001"]["x"], json!(300.0));
    assert_eq!(d["nodes"]["rectradi0002"]["opacity"], json!(0.5));
    let committed = e.commit_preview().expect("preview active");
    assert!(!committed.applied.is_empty());
    assert!(e.commit_preview().is_none());
    // Undo of the drag restores the position.
    let inverse = serde_json::to_string(&committed.inverse).unwrap();
    e.apply(&inverse, false).unwrap();
    let d: Value = serde_json::from_str(&e.snapshot()).unwrap();
    assert_eq!(d["nodes"]["rectplai0001"]["x"], json!(20.0));
}

#[test]
fn hit_tests_marquee_handles_and_snapping() {
    let mut e = engine("shapes");
    let hit = e
        .hit_test(&HitRequest {
            page_id: None,
            x: 70.0,
            y: 55.0,
            options: Default::default(),
            all: false,
        })
        .unwrap();
    assert_eq!(hit.id.as_deref(), Some("rectplai0001"));
    let miss = e
        .hit_test(&HitRequest {
            page_id: None,
            x: -10.0,
            y: -10.0,
            options: Default::default(),
            all: false,
        })
        .unwrap();
    assert!(miss.id.is_none() && miss.path.is_empty());
    let ids = e
        .marquee(
            &serde_json::from_value(json!({ "rect": { "x": 0, "y": 0, "w": 250, "h": 100 } }))
                .unwrap(),
        )
        .unwrap();
    assert!(ids.contains(&"rectplai0001".to_string()) && ids.contains(&"rectradi0002".to_string()));
    let h = e.handles(&HandlesRequest {
        ids: vec!["rectplai0001".into()],
        zoom: 1.0,
        style: Default::default(),
        point: Some(desyn_core::geometry::Point::new(20.0, 20.0)),
    });
    assert_eq!(h.handles.unwrap().resize.len(), 8);
    assert!(matches!(h.hit, Some(desyn_core::hit::HandleHit::Resize(_))));
    // Dragging the rect so its left edge is 3 px off the neighbour's left edge snaps onto it.
    let s = e
        .snap(&SnapRequest {
            page_id: None,
            ids: vec!["rectplai0001".into()],
            rect: desyn_core::geometry::Rect::new(143.0, 230.0, 100.0, 70.0),
            edges: None,
            options: Default::default(),
            distances: true,
        })
        .unwrap();
    assert_eq!(s["dx"], json!(-3.0));
    assert!(s["guides"].as_array().is_some_and(|g| !g.is_empty()));
    assert!(s["distances"].is_array());
}

#[test]
fn text_geometry_for_the_editing_overlay() {
    let mut e = engine("text");
    let layout = e.text_layout("headline0001").unwrap();
    assert!(!layout.lines.is_empty());
    assert_eq!(layout.length, layout.text.encode_utf16().count());
    let caret = e
        .text_query(&TextQuery::Caret {
            node_id: "headline0001".into(),
            index: 0,
            affinity: Default::default(),
        })
        .unwrap();
    let seg = caret.caret_page.unwrap();
    // Clicking just right of the caret's page position lands at index 0 or 1.
    let hit = e
        .text_query(&TextQuery::Hit {
            node_id: "headline0001".into(),
            x: seg[0] + 1.0,
            y: (seg[1] + seg[3]) / 2.0,
        })
        .unwrap();
    assert!(hit.index.unwrap() <= 1);
    let sel = e
        .text_query(&TextQuery::Selection {
            node_id: "headline0001".into(),
            start: 0,
            end: layout.length,
        })
        .unwrap();
    assert_eq!(sel.rects.len(), sel.quads.len());
    assert!(!sel.rects.is_empty());
    let moved = e
        .text_query(&TextQuery::Move {
            node_id: "headline0001".into(),
            index: 0,
            affinity: Default::default(),
            direction: "right".into(),
            x: None,
        })
        .unwrap();
    assert_eq!(moved.index, Some(1));
    let word = e
        .text_query(&TextQuery::Range {
            node_id: "headline0001".into(),
            index: 1,
            unit: "word".into(),
        })
        .unwrap();
    assert_eq!(word.start, Some(0));
    assert!(word.end.unwrap() > 1);
    let outline = e.outline_text("headline0001").unwrap();
    assert!(outline.d.len() > 100 && outline.bounds.is_some());
    assert!(e.text_layout("textpage0009").is_err());
}

#[test]
fn assets_surface_decode_errors() {
    let mut e = engine("images");
    let err = e.set_asset("photo0000001", b"not an image").unwrap_err();
    assert!(err.0.contains("photo0000001"), "{err}");
    let png = std::fs::read(format!("{FIXTURES}/assets/tile00000001.png")).unwrap();
    let ok = e.set_asset("photo0000001", &png).unwrap();
    assert_eq!(ok.kind, "image");
    assert!(ok.width.unwrap() > 0);
    // An unknown id with bytes is sniffed as an image.
    assert_eq!(e.set_asset("newasset0001", &png).unwrap().kind, "image");
    assert!(e.set_font(b"garbage", Some("X")).is_err());
}

#[test]
fn missing_assets_are_reported_once() {
    let mut e = EngineCore::new(&[1; 32]);
    e.load(&fixture("images")).unwrap();
    let info = e.render(&request(view(0.0, 0.0, 0.5, 300, 300))).unwrap();
    assert!(info.missing_assets.contains(&"photo0000001".to_string()));
    e.apply(&move_tx("imgfillx0001", 1.0, 1.0), true).ok();
    let again = e.render(&request(view(0.0, 0.0, 0.5, 300, 300))).unwrap();
    assert!(!again.missing_assets.contains(&"photo0000001".to_string()));
}

#[test]
fn exports_and_describe() {
    let mut e = engine("social");
    let png = e.export(r#"{"format":"png","scale":0.25}"#).unwrap();
    assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");
    assert_eq!(e.last_export().unwrap().mime, "image/png");
    let svg = e
        .export(r#"{"format":"svg","svgText":"outlines"}"#)
        .unwrap();
    assert!(String::from_utf8_lossy(&svg[..200]).contains("<svg"));
    let pdf = e.export(r#"{"format":"pdf"}"#);
    if cfg!(feature = "exporters") {
        assert_eq!(&pdf.unwrap()[..5], b"%PDF-");
    } else {
        assert!(pdf.unwrap_err().0.contains("exporters"));
    }
    let d = e.describe(r#"{"detail":"summary"}"#).unwrap();
    assert_eq!(d["design"]["pageCount"], json!(1));
    assert!(d["tree"].as_array().is_some_and(|t| !t.is_empty()));
    let issues = e.lint("{}").unwrap();
    assert!(issues.is_array());
    let compact = e.describe_compact("{}", 800).unwrap();
    assert!(!compact.is_empty());
}

#[test]
fn measuring_and_relayout() {
    let mut e = engine("text");
    let item: MeasureItem = serde_json::from_value(json!({
        "text": [{ "text": "Hello world, this wraps across lines" }],
        "style": {
            "fontFamily": "Inter", "fontWeight": 400, "fontStyle": "normal", "fontSize": 24,
            "fills": [{ "type": "solid", "color": "#111111" }], "letterSpacing": 0, "textCase": "none",
            "decoration": "none"
        },
        "paragraph": {
            "align": "left", "direction": "ltr", "lineHeight": { "unit": "percent", "value": 120 },
            "spacing": 0, "indent": 0, "list": "none"
        },
        "width": 120
    }))
    .unwrap();
    let m = e.measure(&[item]);
    assert!(m[0].lines >= 3 && m[0].w <= 120.0 && m[0].h > 60.0);
    let r = e.relayout().unwrap();
    // Fixture boxes were computed with these fonts: relayout is (near) idempotent.
    assert!(r.applied.len() <= e.design().nodes.len());
    let again = e.relayout().unwrap();
    assert!(again.applied.is_empty());
}

#[test]
fn late_assets_and_fonts_redraw_what_uses_them() {
    let mut e = EngineCore::new(&[2; 32]);
    e.load(&fixture("images")).unwrap();
    let v = view(0.0, 0.0, 0.5, 300, 300);
    e.render(&request(v)).unwrap();
    let before = e.frame_bytes().to_vec();
    let jpg = std::fs::read(format!("{FIXTURES}/assets/photo0000001.jpg")).unwrap();
    e.set_asset("photo0000001", &jpg).unwrap();
    let info = e.render(&request(v)).unwrap();
    assert!(info.built && !info.rects.is_empty());
    assert!(diff_ratio(&before, e.frame_bytes(), 3) > 0.05);
}
