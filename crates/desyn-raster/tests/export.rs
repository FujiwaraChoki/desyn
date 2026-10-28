//! Exporter tests: every format decodes / parses, honours its options, and reports problems.
#![cfg(not(target_arch = "wasm32"))]

use std::io::Cursor;
use std::path::{Path, PathBuf};

use desyn_core::geometry::Rect;
use desyn_core::model::{Color, Design, Fill, Node};
use desyn_raster::export::{
    self, AnimOptions, Background, ExportOptions, Format, PageSelection, SvgText, frames,
};
use desyn_raster::{Color4, DirAssetStore, Renderer};
use desyn_text::TextEngine;

fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../spec/fixtures/render")
}

fn load(name: &str) -> Design {
    Design::from_json(&std::fs::read_to_string(fixtures().join(format!("{name}.json"))).unwrap())
        .unwrap()
}

fn renderer() -> Renderer {
    Renderer::new(
        TextEngine::with_bundled_fonts(),
        Box::new(DirAssetStore::new(fixtures().join("assets"))),
    )
}

/// The text fixture plus a second page with a URL link and a page link back to page 1.
fn two_pages() -> Design {
    let mut d = load("text");
    let first = d.page_ids()[0].clone();
    let mut page = Node::page("page00000002", "Page 2", 480.0, 480.0);
    if let Node::Page(p) = &mut page {
        p.background = vec![Fill::solid(Color::new("#1b1446").unwrap())];
        p.base.notes = Some("Speaker notes for page two".into());
    }
    d.push_child("root", page);
    let mut link = Node::rect("linkrect0001", "Link", 40.0, 40.0, 200.0, 60.0);
    link.base_mut().link = Some("https://desyn.app".into());
    d.push_child("page00000002", link);
    let mut back = Node::rect("backlink0001", "Back", 40.0, 140.0, 200.0, 60.0);
    back.base_mut().link = Some(format!("page:{first}"));
    d.push_child("page00000002", back);
    let mut t = Node::text("pagetwotext1", "Second page", 40.0, 240.0, Some(400.0));
    if let Node::Text(tn) = &mut t {
        tn.style.fills = vec![Fill::solid(Color::new("#ffb02e").unwrap())];
        tn.style.font_size = 40.0;
    }
    d.push_child("page00000002", t);
    d
}

fn opts(format: Format) -> ExportOptions {
    ExportOptions {
        format,
        ..ExportOptions::default()
    }
}

#[test]
fn png_jpeg_webp() {
    let d = load("paints");
    let mut r = renderer();
    let png = export::export(
        &mut r,
        &d,
        &ExportOptions {
            scale: 2.0,
            ..opts(Format::Png)
        },
    )
    .unwrap();
    assert_eq!(png.mime, "image/png");
    let img = image::load_from_memory(&png.bytes).unwrap();
    assert_eq!((img.width(), img.height()), (960, 960));
    // DPI follows the scale (96 x 2).
    let reader = png::Decoder::new(Cursor::new(&png.bytes))
        .read_info()
        .unwrap();
    assert_eq!(
        reader.info().pixel_dims.unwrap().xppu,
        (192.0f64 / 0.0254).round() as u32
    );

    let t = export::export(
        &mut r,
        &d,
        &ExportOptions {
            background: Background::Transparent,
            region: Some(Rect::new(0.0, 0.0, 240.0, 120.0)),
            ..opts(Format::Png)
        },
    )
    .unwrap();
    let img = image::load_from_memory(&t.bytes).unwrap().to_rgba8();
    assert_eq!((img.width(), img.height()), (240, 120));
    assert_eq!(
        img.get_pixel(5, 5).0[3],
        0,
        "transparent background outside shapes"
    );
    assert_eq!(img.get_pixel(60, 60).0[3], 255);

    let j = export::export(
        &mut r,
        &d,
        &ExportOptions {
            quality: 80,
            background: Background::Transparent,
            ..opts(Format::Jpeg)
        },
    )
    .unwrap();
    let img = image::load_from_memory(&j.bytes).unwrap().to_rgb8();
    let px = img.get_pixel(5, 5).0;
    assert!(
        px.iter().all(|c| *c > 245),
        "jpeg flattens transparency on white: {px:?}"
    );

    let w = export::export(
        &mut r,
        &d,
        &ExportOptions {
            quality: 100,
            ..opts(Format::Webp)
        },
    )
    .unwrap();
    assert_eq!(&w.bytes[..4], b"RIFF");
    let img = image::load_from_memory(&w.bytes).unwrap();
    assert_eq!(img.width(), 480);
    let lossy = export::export(
        &mut r,
        &d,
        &ExportOptions {
            quality: 70,
            ..opts(Format::Webp)
        },
    )
    .unwrap();
    assert!(image::load_from_memory(&lossy.bytes).is_ok());

    let c = export::export(
        &mut r,
        &d,
        &ExportOptions {
            background: Background::Color(Color4::parse_hex("#ff0000").unwrap()),
            ..opts(Format::Png)
        },
    )
    .unwrap();
    let img = image::load_from_memory(&c.bytes).unwrap().to_rgba8();
    assert_eq!(img.get_pixel(5, 5).0, [255, 0, 0, 255]);
}

#[test]
fn svg_text_and_outlines() {
    let d = load("text");
    let mut r = renderer();
    let s = export::export(&mut r, &d, &opts(Format::Svg)).unwrap();
    let text = String::from_utf8(s.bytes).unwrap();
    assert!(text.starts_with("<svg"));
    assert!(text.contains("<text") && text.contains("Atmospheric Minimalism"));
    assert!(text.contains("@font-face"));
    usvg::roxmltree::Document::parse(&text).expect("well-formed svg");
    let o = export::export(
        &mut r,
        &d,
        &ExportOptions {
            svg_text: SvgText::Outlines,
            ..opts(Format::Svg)
        },
    )
    .unwrap();
    let outlined = String::from_utf8(o.bytes).unwrap();
    assert!(!outlined.contains("<text"));
    assert!(
        outlined.len() < text.len() / 4,
        "outlines do not embed fonts"
    );
    let n = export::export(
        &mut r,
        &d,
        &ExportOptions {
            svg_text: SvgText::Text { embed_fonts: false },
            ..opts(Format::Svg)
        },
    )
    .unwrap();
    assert!(!String::from_utf8(n.bytes).unwrap().contains("@font-face"));
    // Effects, masks, gradients and SVG nodes round-trip into a parsable document.
    for name in [
        "effects", "masks", "paints", "svg", "blend", "images", "charts", "table_qr", "strokes",
        "shapes",
    ] {
        let s = export::export(&mut r, &load(name), &opts(Format::Svg)).unwrap();
        let t = String::from_utf8(s.bytes).unwrap();
        usvg::roxmltree::Document::parse(&t).unwrap_or_else(|e| panic!("{name}: {e}"));
        let tree = usvg::Tree::from_str(&t, &usvg::Options::default());
        assert!(tree.is_ok(), "{name}: usvg rejects the export");
    }
}

#[cfg(feature = "pdf")]
#[test]
fn pdf_pages_links_bleed_marks() {
    use desyn_raster::export::PdfOptions;
    let d = two_pages();
    let mut r = renderer();
    let p = export::export(
        &mut r,
        &d,
        &ExportOptions {
            pages: PageSelection::All,
            ..opts(Format::Pdf)
        },
    )
    .unwrap();
    assert!(p.bytes.starts_with(b"%PDF-"));
    assert_eq!(p.pages, 2);
    let body = String::from_utf8_lossy(&p.bytes);
    assert!(
        body.contains("/URI") && body.contains("desyn.app"),
        "url link annotation"
    );
    assert!(
        body.contains("/FontFile2") || body.contains("/FontFile3"),
        "embedded font subset"
    );
    let marks = export::export(
        &mut r,
        &d,
        &ExportOptions {
            pdf: PdfOptions {
                bleed: true,
                crop_marks: true,
                cmyk: true,
                ..PdfOptions::default()
            },
            ..opts(Format::Pdf)
        },
    )
    .unwrap();
    let body = String::from_utf8_lossy(&marks.bytes);
    assert!(body.contains("/TrimBox") && body.contains("/BleedBox"));
    assert!(body.contains("DeviceCMYK"));
    let flat = export::export(
        &mut r,
        &load("effects"),
        &ExportOptions {
            pdf: PdfOptions {
                flatten: true,
                dpi: 150.0,
                ..PdfOptions::default()
            },
            ..opts(Format::Pdf)
        },
    )
    .unwrap();
    let body = String::from_utf8_lossy(&flat.bytes);
    assert!(body.contains("/Image") && !body.contains("/FontFile"));
    assert!(
        flat.warnings.is_empty(),
        "flattened output is exact: {:?}",
        flat.warnings
    );
}

#[cfg(feature = "pptx")]
#[test]
fn pptx_structure() {
    use std::io::Read;
    let d = two_pages();
    let mut r = renderer();
    let out = export::export(
        &mut r,
        &d,
        &ExportOptions {
            pages: PageSelection::All,
            ..opts(Format::Pptx)
        },
    )
    .unwrap();
    assert_eq!(out.pages, 2);
    let mut zip = zip::ZipArchive::new(Cursor::new(out.bytes)).unwrap();
    let names: Vec<String> = zip.file_names().map(|n| n.unwrap().to_string()).collect();
    for required in [
        "[Content_Types].xml",
        "_rels/.rels",
        "ppt/presentation.xml",
        "ppt/slides/slide1.xml",
        "ppt/slides/slide2.xml",
        "ppt/slideMasters/slideMaster1.xml",
        "ppt/slideLayouts/slideLayout1.xml",
        "ppt/theme/theme1.xml",
        "ppt/notesSlides/notesSlide2.xml",
        "ppt/notesMasters/notesMaster1.xml",
    ] {
        assert!(
            names.iter().any(|n| n == required),
            "missing {required}: {names:?}"
        );
    }
    for n in names
        .iter()
        .filter(|n| n.ends_with(".xml") || n.ends_with(".rels"))
    {
        let mut s = String::new();
        zip.by_name(n).unwrap().read_to_string(&mut s).unwrap();
        usvg::roxmltree::Document::parse(&s).unwrap_or_else(|e| panic!("{n}: {e}"));
    }
    let mut slide = String::new();
    zip.by_name("ppt/slides/slide1.xml")
        .unwrap()
        .read_to_string(&mut slide)
        .unwrap();
    assert!(
        slide.contains("Atmospheric Minimalism"),
        "text stays editable"
    );
    assert!(
        slide.contains("<p:pic>"),
        "curved / outlined text falls back to pictures"
    );
    let mut rels = String::new();
    zip.by_name("ppt/slides/_rels/slide2.xml.rels")
        .unwrap()
        .read_to_string(&mut rels)
        .unwrap();
    assert!(rels.contains("https://desyn.app") && rels.contains("TargetMode=\"External\""));
}

#[cfg(feature = "gif")]
#[test]
fn gif_and_frames() {
    let d = load("anim");
    let mut r = renderer();
    let o = ExportOptions {
        anim: AnimOptions {
            fps: 10.0,
            ..AnimOptions::default()
        },
        scale: 0.5,
        ..opts(Format::Gif)
    };
    let g = export::export(&mut r, &d, &o).unwrap();
    let mut dec = gif::DecodeOptions::new();
    dec.set_color_output(gif::ColorOutput::RGBA);
    let mut dec = dec.read_info(Cursor::new(&g.bytes)).unwrap();
    let mut n = 0;
    while dec.read_next_frame().unwrap().is_some() {
        n += 1;
    }
    assert_eq!(n, 24, "2.4 s at 10 fps");
    let mut times = Vec::new();
    let mut first: Option<Vec<u8>> = None;
    let mut last = Vec::new();
    let pages = d.page_ids().to_vec();
    let seq = frames::render_frames(&mut r, &d, &pages, &o, |f| {
        times.push(f.time_ms);
        if first.is_none() {
            first = Some(f.pixmap.data().to_vec());
        }
        last = f.pixmap.data().to_vec();
        Ok(())
    })
    .unwrap();
    assert_eq!((seq.width, seq.height, seq.frames), (240, 240, 24));
    assert_eq!(times[1], 100.0);
    assert_ne!(first.unwrap(), last, "the timeline animates");
}

#[test]
fn multi_page_timeline_with_transition() {
    let mut d = two_pages();
    if let Some(Node::Page(p)) = d.node_mut("page00000002") {
        p.duration_ms = Some(1000.0);
        p.transition = Some(
            serde_json::from_value(serde_json::json!({"kind": "fade", "durationMs": 400})).unwrap(),
        );
    }
    let first = d.page_ids()[0].clone();
    if let Some(Node::Page(p)) = d.node_mut(&first) {
        p.duration_ms = Some(1000.0);
    }
    let mut r = renderer();
    let o = ExportOptions {
        anim: AnimOptions {
            fps: 10.0,
            ..AnimOptions::default()
        },
        scale: 0.25,
        ..ExportOptions::default()
    };
    let pages = d.page_ids().to_vec();
    let mut mid = None;
    let mut end = None;
    let seq = frames::render_frames(&mut r, &d, &pages, &o, |f| {
        if f.index == 12 {
            mid = Some(f.pixmap.pixel(110, 110).unwrap());
        }
        if f.index == 19 {
            end = Some(f.pixmap.pixel(110, 110).unwrap());
        }
        Ok(())
    })
    .unwrap();
    assert_eq!(seq.frames, 20);
    // Halfway through the fade the pixel is between page 1 (light) and page 2 (dark navy).
    let (m, e) = (mid.unwrap(), end.unwrap());
    assert!(m.red() > e.red() + 40, "fade in progress: {m:?} vs {e:?}");
}

#[test]
fn missing_assets_are_reported_not_fatal() {
    let d = load("images");
    let mut r = Renderer::new(
        TextEngine::with_bundled_fonts(),
        Box::new(desyn_raster::NoAssets),
    );
    let out = export::export(&mut r, &d, &opts(Format::Png)).unwrap();
    assert!(out.missing_assets.contains(&"photo0000001".to_string()));
    // Bytes registered later are picked up by the next export.
    r.assets_mut().insert(
        "photo0000001",
        std::fs::read(fixtures().join("assets/photo0000001.jpg")).unwrap(),
    );
    let out = export::export(&mut r, &d, &opts(Format::Png)).unwrap();
    assert!(!out.missing_assets.contains(&"photo0000001".to_string()));
}

#[test]
fn invalid_options_are_rejected() {
    let d = load("shapes");
    let mut r = renderer();
    assert!(
        export::export(
            &mut r,
            &d,
            &ExportOptions {
                scale: 0.0,
                ..opts(Format::Png)
            }
        )
        .is_err()
    );
    assert!(
        export::export(
            &mut r,
            &d,
            &ExportOptions {
                scale: 1000.0,
                ..opts(Format::Png)
            }
        )
        .is_err()
    );
    assert!(
        export::export(
            &mut r,
            &d,
            &ExportOptions {
                pages: PageSelection::Id("nope".into()),
                ..opts(Format::Png)
            }
        )
        .is_err()
    );
    assert!(
        export::export(
            &mut r,
            &two_pages(),
            &ExportOptions {
                pages: PageSelection::All,
                ..opts(Format::Png)
            }
        )
        .is_err(),
        "one raster file cannot hold two pages"
    );
    let all = export::export_pages(
        &mut r,
        &two_pages(),
        &ExportOptions {
            pages: PageSelection::All,
            ..opts(Format::Png)
        },
    )
    .unwrap();
    assert_eq!(all.len(), 2);
}

/// AVIF decoding through dav1d (feature `avif`): a 16 x 8 orange image made with Pillow / libavif.
#[cfg(feature = "avif")]
#[test]
fn avif_decodes() {
    let bytes =
        std::fs::read(Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/data/orange-16x8.avif"))
            .unwrap();
    let img = desyn_raster::assets::decode_image(bytes.into()).unwrap();
    assert_eq!((img.width(), img.height()), (16, 8));
    let px = img.pixmap().pixel(8, 4).unwrap();
    assert!(
        px.red() > 240 && px.green() > 110 && px.green() < 145 && px.blue() < 15,
        "{px:?}"
    );
}
