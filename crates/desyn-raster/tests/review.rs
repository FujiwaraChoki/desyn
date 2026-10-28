//! Regression tests from the independent review: EXIF orientation, link sanitizing, masks under `only`,
//! and hostile inputs to the vector exporters.
#![cfg(not(target_arch = "wasm32"))]

use std::sync::Arc;

use desyn_core::model::{Color, Design, DesignKind, Fill, Node};
use desyn_raster::assets::decode_image;
use desyn_raster::display::BuildOptions;
use desyn_raster::export::{self, ExportOptions, Format};
use desyn_raster::{MemoryAssetStore, NoAssets, PageRenderOptions, Renderer};
use desyn_text::TextEngine;

const PAGE: &str = "page00000001";

fn design() -> Design {
    Design::with_page(
        "design000001",
        "Review",
        DesignKind::SocialPost,
        PAGE,
        200.0,
        200.0,
    )
}

fn solid_rect(id: &str, x: f64, y: f64, w: f64, h: f64, color: &str) -> Node {
    let mut n = Node::rect(id, id, x, y, w, h);
    if let Some(s) = n.shaped_mut() {
        s.fills = vec![Fill::solid(Color::new(color).unwrap())];
    }
    n
}

fn data(name: &str) -> Vec<u8> {
    std::fs::read(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/data")
            .join(name),
    )
    .unwrap()
}

#[test]
fn jpeg_exif_orientation_is_applied() {
    // Stored 32x16 (left half red, right half blue) with orientation 6 (rotate 90 deg clockwise).
    let img = decode_image(Arc::from(data("exif-rot90-32x16.jpg"))).unwrap();
    assert_eq!((img.width(), img.height()), (16, 32));
    let px = |x: u32, y: u32| img.pixmap().pixel(x, y).unwrap();
    let top = px(8, 4);
    let bottom = px(8, 28);
    assert!(top.red() > 150 && top.blue() < 100, "top is red: {top:?}");
    assert!(
        bottom.blue() > 150 && bottom.red() < 100,
        "bottom is blue: {bottom:?}"
    );
    // The original bytes are not passed through (exporters would lose the orientation).
    assert!(img.source().is_none());
}

#[cfg(all(feature = "pdf", feature = "pptx"))]
#[test]
fn unsafe_link_schemes_are_dropped() {
    let mut d = design();
    let links = [
        ("rectlink0001", "javascript:alert(1)"),
        ("rectlink0002", " JaVaScRiPt:alert(1)"),
        ("rectlink0003", "data:text/html,<script>alert(1)</script>"),
        ("rectlink0004", "vbscript:msgbox(1)"),
        ("rectlink0005", "https://desyn.app/ok"),
        ("rectlink0006", "mailto:hi@desyn.app"),
        ("rectlink0007", "desyn.app/pricing"),
        ("rectlink0008", "file:///etc/passwd"),
    ];
    for (i, (id, link)) in links.iter().enumerate() {
        let mut n = solid_rect(id, 10.0 * i as f64, 0.0, 8.0, 8.0, "#ff0000");
        n.base_mut().link = Some((*link).into());
        d.push_child(PAGE, n);
    }
    let mut t = Node::text("textlink0001", "click", 0.0, 100.0, Some(150.0));
    if let Node::Text(tn) = &mut t {
        tn.runs[0].style = Some(
            serde_json::from_value(
                serde_json::json!({"link": "javascript:alert(document.domain)"}),
            )
            .unwrap(),
        );
    }
    d.push_child(PAGE, t);
    let mut r = Renderer::new(TextEngine::with_bundled_fonts(), Box::new(NoAssets));
    let dl = r.build(&d, &BuildOptions::default()).unwrap();
    let urls: Vec<String> = dl
        .links
        .iter()
        .filter_map(|l| match &l.target {
            desyn_raster::display::LinkTarget::Url(u) => Some(u.clone()),
            desyn_raster::display::LinkTarget::Page(_) => None,
        })
        .collect();
    assert_eq!(
        urls,
        vec![
            "https://desyn.app/ok".to_string(),
            "mailto:hi@desyn.app".to_string(),
            "https://desyn.app/pricing".to_string(),
        ]
    );
    for format in [Format::Svg, Format::Pptx, Format::Pdf] {
        let out = export::export(
            &mut r,
            &d,
            &ExportOptions {
                format,
                ..ExportOptions::default()
            },
        )
        .unwrap();
        let hay = if format == Format::Pptx {
            let mut z = zip::ZipArchive::new(std::io::Cursor::new(out.bytes)).unwrap();
            let mut all = String::new();
            for i in 0..z.len() {
                let mut f = z.by_index(i).unwrap();
                let mut s = String::new();
                if std::io::Read::read_to_string(&mut f, &mut s).is_ok() {
                    all.push_str(&s);
                }
            }
            all
        } else {
            String::from_utf8_lossy(&out.bytes).into_owned()
        };
        let lower = hay.to_ascii_lowercase();
        for bad in ["javascript:", "vbscript:", "file:///", "data:text/html"] {
            assert!(!lower.contains(bad), "{format:?} output contains {bad}");
        }
    }
}

#[test]
fn masked_members_render_under_only_and_without_their_mask() {
    let mut d = design();
    let mut mask = Node::ellipse("maskellipse1", "Mask", 50.0, 50.0, 100.0, 100.0);
    if let Some(s) = mask.shaped_mut() {
        s.fills = vec![Fill::solid(Color::new("#000000").unwrap())];
    }
    mask.base_mut().mask = Some(true);
    d.push_child(PAGE, mask);
    d.push_child(
        PAGE,
        solid_rect("maskedrect01", 0.0, 0.0, 200.0, 200.0, "#ff0000"),
    );
    let mut r = Renderer::new(TextEngine::new(), Box::new(NoAssets));
    let render = |r: &mut Renderer, opts: PageRenderOptions| {
        r.render_page(
            &d,
            &PageRenderOptions {
                transparent: true,
                ..opts
            },
        )
        .unwrap()
        .pixmap
    };
    // Normal render: masked to the circle.
    let p = render(&mut r, PageRenderOptions::default());
    assert_eq!(p.pixel(100, 100).unwrap().alpha(), 255);
    assert_eq!(p.pixel(5, 5).unwrap().alpha(), 0);
    // Selection preview of the masked rect keeps the mask.
    let p = render(
        &mut r,
        PageRenderOptions {
            only: Some(vec!["maskedrect01".into()]),
            ..PageRenderOptions::default()
        },
    );
    assert_eq!(
        p.pixel(100, 100).unwrap().alpha(),
        255,
        "selection preview drew nothing"
    );
    assert_eq!(p.pixel(5, 5).unwrap().alpha(), 0);
    // Hiding the mask node (e.g. while it is edited in an overlay) shows the members unmasked.
    let p = render(
        &mut r,
        PageRenderOptions {
            hidden: vec!["maskellipse1".into()],
            ..PageRenderOptions::default()
        },
    );
    assert_eq!(
        p.pixel(5, 5).unwrap().alpha(),
        255,
        "members vanished with their mask"
    );
}

#[test]
fn exif_rotated_photo_exports_upright() {
    let mut d = design();
    let img = Node::image(
        "imagephoto01",
        "Photo",
        "assetphoto01",
        0.0,
        0.0,
        100.0,
        200.0,
    );
    d.push_child(PAGE, img);
    let mut store = MemoryAssetStore::new();
    store.insert("assetphoto01", data("exif-rot90-32x16.jpg"));
    let mut r = Renderer::new(TextEngine::new(), Box::new(store));
    let p = r
        .render_page(&d, &PageRenderOptions::default())
        .unwrap()
        .pixmap;
    let top = p.pixel(50, 30).unwrap();
    let bottom = p.pixel(50, 170).unwrap();
    assert!(top.red() > 150 && top.blue() < 100, "{top:?}");
    assert!(bottom.blue() > 150 && bottom.red() < 100, "{bottom:?}");
}

fn fixture(name: &str) -> Design {
    let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../spec/fixtures/render")
        .join(format!("{name}.json"));
    Design::from_json(&std::fs::read_to_string(p).unwrap()).unwrap()
}

/// The SVG writer must reproduce background blur (it renders the backdrop as an image): rasterizing the SVG
/// with resvg gives the same frosted panel as the raster renderer.
#[test]
fn svg_export_keeps_background_blur() {
    let d = fixture("effects");
    let mut r = Renderer::new(TextEngine::with_bundled_fonts(), Box::new(NoAssets));
    let svg = export::export(
        &mut r,
        &d,
        &ExportOptions {
            format: Format::Svg,
            svg_text: export::SvgText::Outlines,
            ..ExportOptions::default()
        },
    )
    .unwrap();
    // Grain is rasterized like in the PNG / PDF exports (no turbulence filter that would look different).
    assert!(!String::from_utf8_lossy(&svg.bytes).contains("feTurbulence"));
    let tree = usvg::Tree::from_data(&svg.bytes, &usvg::Options::default()).unwrap();
    let mut from_svg = desyn_raster::tiny_skia::Pixmap::new(480, 480).unwrap();
    resvg::render(
        &tree,
        desyn_raster::tiny_skia::Transform::identity(),
        &mut from_svg.as_mut(),
    );
    let raster = r
        .render_page(&d, &PageRenderOptions::default())
        .unwrap()
        .pixmap;
    // The glass panel (60, 300, 360 x 150) over sharp circles and text.
    let mut total = 0u64;
    let mut n = 0u64;
    for y in 310..440 {
        for x in 70..410 {
            let a = raster.pixel(x, y).unwrap();
            let b = from_svg.pixel(x, y).unwrap();
            total += u64::from(a.red().abs_diff(b.red()))
                + u64::from(a.green().abs_diff(b.green()))
                + u64::from(a.blue().abs_diff(b.blue()));
            n += 3;
        }
    }
    let mean = total as f64 / n as f64;
    assert!(mean < 3.0, "glass panel differs by {mean:.2} on average");
}

#[cfg(feature = "pptx")]
#[test]
fn pptx_page_links_jump_to_slides() {
    let mut d = design();
    let second = "page00000002";
    let p2 = Node::page(second, "Two", 200.0, 200.0);
    d.push_child("root", p2);
    let mut n = solid_rect("rectjump0001", 0.0, 0.0, 50.0, 50.0, "#00ff00");
    n.base_mut().link = Some(format!("page:{second}"));
    d.push_child(PAGE, n);
    let mut r = Renderer::new(TextEngine::new(), Box::new(NoAssets));
    let out = export::export(
        &mut r,
        &d,
        &ExportOptions {
            format: Format::Pptx,
            pages: export::PageSelection::All,
            ..ExportOptions::default()
        },
    )
    .unwrap();
    let mut z = zip::ZipArchive::new(std::io::Cursor::new(out.bytes)).unwrap();
    let mut read = |name: &str| {
        let mut s = String::new();
        std::io::Read::read_to_string(&mut z.by_name(name).unwrap(), &mut s).unwrap();
        s
    };
    let slide = read("ppt/slides/slide1.xml");
    let rels = read("ppt/slides/_rels/slide1.xml.rels");
    assert!(
        slide.contains(r#"action="ppaction://hlinksldjump""#),
        "{slide}"
    );
    assert!(rels.contains(r#"Target="slide2.xml""#), "{rels}");
}

/// Exporters render a layer's backdrop with `render_region` at their own resolution; it must match a full page
/// render at that scale, also when the region reaches past the (clipping) page and the page content therefore
/// goes through an offscreen without the page background.
#[test]
fn truncated_backdrop_render_matches_raster_at_scale() {
    let d = fixture("effects");
    let mut r = Renderer::new(TextEngine::with_bundled_fonts(), Box::new(NoAssets));
    for scale in [1.0, 2.0, 3.125] {
        // As the vector exporters build it.
        let dl = r
            .build(
                &d,
                &BuildOptions {
                    vector: true,
                    raster_scale: scale,
                    ..BuildOptions::default()
                },
            )
            .unwrap();
        let glass = dl.find("glassxxx0016").expect("glass layer");
        let root = desyn_raster::raster::truncate_after(&dl.root, glass).unwrap();
        let region = glass.bounds;
        assert!(
            region.bottom() > 480.0,
            "the glass shadow reaches past the page"
        );
        let part = desyn_raster::raster::render_region(&root, &region, scale).unwrap();
        let full = r
            .render_page(
                &d,
                &PageRenderOptions {
                    scale,
                    ..PageRenderOptions::default()
                },
            )
            .unwrap()
            .pixmap;
        // Inside the panel (page px 70..410 x 310..440).
        let mut total = 0u64;
        let mut n = 0u64;
        for py in (310..440).step_by(2) {
            for px in (70..410).step_by(2) {
                let (fx, fy) = (
                    (f64::from(px) * scale) as u32,
                    (f64::from(py) * scale) as u32,
                );
                let (qx, qy) = (
                    ((f64::from(px) - region.x) * scale) as u32,
                    ((f64::from(py) - region.y) * scale) as u32,
                );
                let a = part.pixel(qx, qy).unwrap();
                let b = full.pixel(fx, fy).unwrap();
                total += u64::from(a.red().abs_diff(b.red()))
                    + u64::from(a.green().abs_diff(b.green()))
                    + u64::from(a.blue().abs_diff(b.blue()));
                n += 3;
            }
        }
        let mean = total as f64 / n as f64;
        assert!(
            mean < 2.0,
            "scale {scale}: backdrop render differs by {mean:.2}"
        );
    }
}

#[test]
fn parse_link_cases() {
    use desyn_raster::display::{LinkTarget, parse_link};
    let url = |s: &str| Some(LinkTarget::Url(s.to_string()));
    assert_eq!(parse_link("https://desyn.app"), url("https://desyn.app"));
    assert_eq!(parse_link("HTTP://desyn.app"), url("HTTP://desyn.app"));
    assert_eq!(parse_link("tel:+4930123"), url("tel:+4930123"));
    assert_eq!(
        parse_link("www.desyn.app:8080/x"),
        url("https://www.desyn.app:8080/x")
    );
    assert_eq!(
        parse_link("//cdn.desyn.app/a"),
        url("https://cdn.desyn.app/a")
    );
    assert_eq!(
        parse_link("https://desyn.app/a b"),
        url("https://desyn.app/a%20b")
    );
    assert_eq!(
        parse_link("page:page00000002"),
        Some(LinkTarget::Page("page00000002".into()))
    );
    for bad in [
        "",
        "   ",
        "page:",
        "java\tscript:alert(1)",
        "java\nscript:alert(1)",
        "javascript\u{0}:x",
        "/relative/path",
        "#anchor",
        "localhost",
        "blob:https://desyn.app/x",
        "//not a host",
    ] {
        assert_eq!(parse_link(bad), None, "{bad:?}");
    }
}
