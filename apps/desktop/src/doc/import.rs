//! Importing files into a design: SVG (as an `svg` node backed by an asset), raster images (an `image` node),
//! and JSON (a whole `Design`, a Desyn clipboard payload, or nodes). Used by File > Import, drag and drop onto
//! the canvas, paste and the `Import` launch request.

use std::io::Cursor;
use std::path::Path;
use std::sync::Arc;

use desyn_core::Op;
use desyn_core::clipboard::{ClipboardPayload, PasteOptions, paste_ops};
use desyn_core::geometry::Point;
use desyn_core::model::{AssetKind, Design, Node};

use super::document::Document;

/// Largest file accepted for import.
pub const MAX_IMPORT_BYTES: usize = 256 << 20;

/// What a file contains.
#[derive(Debug, Clone, PartialEq)]
pub enum Importable {
    /// A raster image with its MIME type and pixel size.
    Image {
        mime: &'static str,
        width: u32,
        height: u32,
    },
    /// An SVG document with its intrinsic size.
    Svg { width: f64, height: f64 },
    /// A complete design (opens as a new document).
    Design(Box<Design>),
    /// Desyn clipboard JSON.
    Payload(Box<ClipboardPayload>),
    /// One node or a list of nodes (each a subtree root without children, or a flat list in pre-order).
    Nodes(Vec<Node>),
}

/// Import failure with a message for people.
#[derive(Debug, Clone, PartialEq)]
pub struct ImportError(pub String);

impl std::fmt::Display for ImportError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

/// Sniffs bytes (the file name only breaks ties).
pub fn sniff(bytes: &[u8], name: Option<&str>) -> Result<Importable, ImportError> {
    if bytes.len() > MAX_IMPORT_BYTES {
        return Err(ImportError("This file is larger than 256 MB.".into()));
    }
    if let Ok(reader) = image::ImageReader::new(Cursor::new(bytes)).with_guessed_format()
        && let Some(fmt) = reader.format()
    {
        let mime = match fmt {
            image::ImageFormat::Png => "image/png",
            image::ImageFormat::Jpeg => "image/jpeg",
            image::ImageFormat::WebP => "image/webp",
            image::ImageFormat::Gif => "image/gif",
            image::ImageFormat::Bmp => "image/bmp",
            _ => {
                return Err(ImportError(
                    "This image format isn't supported. Use PNG, JPEG, WebP, GIF or BMP.".into(),
                ));
            }
        };
        let (width, height) = reader
            .into_dimensions()
            .map_err(|e| ImportError(format!("This image can't be read ({e}).")))?;
        if width == 0 || height == 0 {
            return Err(ImportError("This image is empty.".into()));
        }
        return Ok(Importable::Image {
            mime,
            width,
            height,
        });
    }
    let text = std::str::from_utf8(bytes)
        .map_err(|_| ImportError("This file type can't be imported.".into()))?;
    let trimmed = text.trim_start_matches('\u{feff}').trim_start();
    let is_svg_name = name.is_some_and(|n| n.to_ascii_lowercase().ends_with(".svg"));
    if trimmed.starts_with('<') || is_svg_name {
        let (width, height) = svg_size(trimmed)
            .ok_or_else(|| ImportError("This SVG has no <svg> element.".into()))?;
        return Ok(Importable::Svg { width, height });
    }
    if trimmed.starts_with('{') || trimmed.starts_with('[') {
        return sniff_json(trimmed);
    }
    Err(ImportError(
        "This file type can't be imported. Use SVG, PNG, JPEG, WebP, GIF or JSON.".into(),
    ))
}

fn sniff_json(text: &str) -> Result<Importable, ImportError> {
    if let Some(p) = ClipboardPayload::from_json(text) {
        return Ok(Importable::Payload(Box::new(p)));
    }
    let v: serde_json::Value = serde_json::from_str(text)
        .map_err(|e| ImportError(format!("This JSON can't be read ({e}).")))?;
    if v.get("nodes").is_some() && v.get("schema").is_some() {
        let d: Design = serde_json::from_value(v)
            .map_err(|e| ImportError(format!("This design JSON is invalid ({e}).")))?;
        if d.root().is_none() || d.page_ids().is_empty() {
            return Err(ImportError("This design has no pages.".into()));
        }
        return Ok(Importable::Design(Box::new(d)));
    }
    // A request body like {"design": {...}} (worker / API format).
    if let Some(inner) = v.get("design").filter(|d| d.get("nodes").is_some()) {
        return sniff_json(&inner.to_string());
    }
    let list = match v {
        serde_json::Value::Array(a) => a,
        other => vec![other],
    };
    let nodes: Result<Vec<Node>, _> = list
        .into_iter()
        .map(serde_json::from_value::<Node>)
        .collect();
    match nodes {
        Ok(n)
            if !n.is_empty()
                && n.iter()
                    .all(|x| !matches!(x, Node::Root(_) | Node::Page(_))) =>
        {
            Ok(Importable::Nodes(n))
        }
        _ => Err(ImportError(
            "This JSON is not a Desyn design, layer or clipboard payload.".into(),
        )),
    }
}

/// Intrinsic size of an SVG from its root `width` / `height` / `viewBox` (300 × 150 like browsers when absent).
pub fn svg_size(svg: &str) -> Option<(f64, f64)> {
    let start = svg.find("<svg")?;
    let end = start + svg[start..].find('>')?;
    let tag = &svg[start..end];
    let attr = |name: &str| -> Option<String> {
        let mut rest = tag;
        while let Some(i) = rest.find(name) {
            let before = rest[..i].chars().last();
            let after = &rest[i + name.len()..];
            let after_trim = after.trim_start();
            if before.is_some_and(|c| c.is_whitespace()) && after_trim.starts_with('=') {
                let v = after_trim[1..].trim_start();
                let q = v.chars().next()?;
                if q == '"' || q == '\'' {
                    let close = v[1..].find(q)?;
                    return Some(v[1..1 + close].to_string());
                }
            }
            rest = &rest[i + name.len()..];
        }
        None
    };
    let len = |s: String| -> Option<f64> {
        let s = s.trim();
        if s.ends_with('%') {
            return None;
        }
        let (num, unit) = s.split_at(s.find(|c: char| c.is_ascii_alphabetic()).unwrap_or(s.len()));
        let n: f64 = num.trim().parse().ok()?;
        let f = match unit {
            "" | "px" => 1.0,
            "pt" => 96.0 / 72.0,
            "pc" => 16.0,
            "mm" => 96.0 / 25.4,
            "cm" => 96.0 / 2.54,
            "in" => 96.0,
            "em" => 16.0,
            _ => return None,
        };
        (n.is_finite() && n > 0.0).then_some(n * f)
    };
    let vb = attr("viewBox").and_then(|v| {
        let n: Vec<f64> = v
            .split(|c: char| c.is_whitespace() || c == ',')
            .filter_map(|p| p.parse().ok())
            .collect();
        (n.len() == 4 && n[2] > 0.0 && n[3] > 0.0).then(|| (n[2], n[3]))
    });
    let w = attr("width").and_then(len);
    let h = attr("height").and_then(len);
    Some(match (w, h, vb) {
        (Some(w), Some(h), _) => (w, h),
        (Some(w), None, Some((vw, vh))) => (w, w * vh / vw),
        (None, Some(h), Some((vw, vh))) => (h * vw / vh, h),
        (None, None, Some(v)) => v,
        _ => (300.0, 150.0),
    })
}

/// Fits `w × h` inside 80 % of the page (never upscales) and centers it at `at` (page center by default).
pub fn place_box(page: (f64, f64), w: f64, h: f64, at: Option<Point>) -> (f64, f64, f64, f64) {
    let max_w = page.0 * 0.8;
    let max_h = page.1 * 0.8;
    let s = (max_w / w).min(max_h / h).min(1.0);
    let (nw, nh) = ((w * s).max(1.0), (h * s).max(1.0));
    let c = at.unwrap_or(Point::new(page.0 / 2.0, page.1 / 2.0));
    (
        round2(c.x - nw / 2.0),
        round2(c.y - nh / 2.0),
        round2(nw),
        round2(nh),
    )
}

fn round2(v: f64) -> f64 {
    (v * 100.0).round() / 100.0
}

/// Ops that add imported content to `parent` (a page or frame) of `doc`, centered at `at` (page coordinates).
/// Returns the ops and the ids of the created top-level nodes.
pub fn import_ops(
    doc: &mut Document,
    bytes: Arc<[u8]>,
    name: Option<&str>,
    parent: &str,
    at: Option<Point>,
) -> Result<(Vec<Op>, Vec<String>), ImportError> {
    let kind = sniff(&bytes, name)?;
    let page_size = doc
        .design
        .page_of(parent)
        .or(Some(parent))
        .and_then(|p| doc.design.node(p))
        .map(|n| (n.base().width, n.base().height))
        .unwrap_or((1080.0, 1080.0));
    let label = name
        .map(|n| {
            Path::new(n)
                .file_stem()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_else(|| n.to_string())
        })
        .filter(|s| !s.is_empty());
    match kind {
        Importable::Image {
            mime,
            width,
            height,
        } => {
            let (aid, mut ops) = doc.add_asset(
                bytes,
                Document::asset_meta(AssetKind::Image, mime, name, Some((width, height))),
            );
            let (x, y, w, h) = place_box(page_size, width as f64, height as f64, at);
            let id = doc.new_id();
            let node = Node::image(
                id.clone(),
                label.unwrap_or_else(|| "Image".into()),
                aid,
                x,
                y,
                w,
                h,
            );
            ops.push(Op::create(vec![node], parent, None));
            Ok((ops, vec![id]))
        }
        Importable::Svg { width, height } => {
            let size = Some((
                width.round().max(1.0) as u32,
                height.round().max(1.0) as u32,
            ));
            let (aid, mut ops) = doc.add_asset(
                bytes,
                Document::asset_meta(AssetKind::Svg, "image/svg+xml", name, size),
            );
            let (x, y, w, h) = place_box(page_size, width, height, at);
            let id = doc.new_id();
            let node = Node::svg(
                id.clone(),
                label.unwrap_or_else(|| "Vector".into()),
                aid,
                x,
                y,
                w,
                h,
            );
            ops.push(Op::create(vec![node], parent, None));
            Ok((ops, vec![id]))
        }
        Importable::Payload(p) => Ok(paste_payload(doc, &p, parent, at)),
        Importable::Nodes(nodes) => {
            let payload = payload_from_nodes(&doc.design.id, nodes);
            Ok(paste_payload(doc, &payload, parent, at))
        }
        Importable::Design(_) => Err(ImportError(
            "This is a whole design. Open it with File > Open.".into(),
        )),
    }
}

/// Paste ops for a payload; returns the ops and the created root ids.
pub fn paste_payload(
    doc: &mut Document,
    p: &ClipboardPayload,
    parent: &str,
    at: Option<Point>,
) -> (Vec<Op>, Vec<String>) {
    let opts = PasteOptions {
        offset: (0.0, 0.0),
        center_at: at,
        index: None,
    };
    let design = doc.design.clone();
    let ops = paste_ops(&design, p, parent, doc.id_gen(), &opts);
    let roots = ops
        .iter()
        .filter_map(|o| match o {
            Op::Create(c) => c.nodes.first().map(|n| n.id().to_string()),
            _ => None,
        })
        .collect();
    (ops, roots)
}

/// Wraps loose nodes (pre-order subtrees or single nodes) into a clipboard payload.
pub fn payload_from_nodes(design_id: &str, nodes: Vec<Node>) -> ClipboardPayload {
    use std::collections::BTreeSet;
    let ids: BTreeSet<String> = nodes.iter().map(|n| n.id().to_string()).collect();
    let mut subtrees: Vec<Vec<Node>> = Vec::new();
    for n in nodes {
        let is_root = n.parent().is_none_or(|p| !ids.contains(p));
        if is_root || subtrees.is_empty() {
            subtrees.push(vec![n]);
        } else if let Some(last) = subtrees.last_mut() {
            last.push(n);
        }
    }
    let boxes: Vec<desyn_core::geometry::Rect> = subtrees
        .iter()
        .filter_map(|s| s.first())
        .map(|n| {
            let b = n.base();
            desyn_core::geometry::Rect {
                x: b.x,
                y: b.y,
                w: b.width,
                h: b.height,
            }
        })
        .collect();
    ClipboardPayload {
        kind: "desyn/clipboard".into(),
        version: 1,
        source_design: design_id.to_string(),
        subtrees,
        assets: Default::default(),
        color_styles: Default::default(),
        text_styles: Default::default(),
        variables: Default::default(),
        bounds: desyn_core::geometry::union_bounds(boxes.iter()).unwrap_or_default(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use desyn_core::layout::ApproxMeasurer;
    use desyn_core::model::DesignKind;

    fn png(w: u32, h: u32) -> Vec<u8> {
        let img = image::RgbaImage::from_pixel(w, h, image::Rgba([255, 176, 46, 255]));
        let mut out = Cursor::new(Vec::new());
        img.write_to(&mut out, image::ImageFormat::Png).unwrap();
        out.into_inner()
    }

    #[test]
    fn sniffs_formats() {
        assert_eq!(
            sniff(&png(3, 2), None),
            Ok(Importable::Image {
                mime: "image/png",
                width: 3,
                height: 2
            })
        );
        let svg = br#"<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="10mm" viewBox="0 0 20 10"></svg>"#;
        match sniff(svg, Some("a.svg")).unwrap() {
            Importable::Svg { width, height } => {
                assert!((width - 37.795).abs() < 0.01);
                assert!((height - 18.897).abs() < 0.01);
            }
            o => panic!("{o:?}"),
        }
        assert!(sniff(b"hello", None).is_err());
        let d = Document::blank("x", DesignKind::Poster, 10.0, 10.0);
        assert!(matches!(
            sniff(d.design.to_json().as_bytes(), None),
            Ok(Importable::Design(_))
        ));
        let r = Node::rect("aaaaaaaaaaaa", "R", 0.0, 0.0, 5.0, 5.0);
        let json = serde_json::to_string(&r).unwrap();
        assert!(matches!(sniff(json.as_bytes(), None), Ok(Importable::Nodes(n)) if n.len() == 1));
    }

    #[test]
    fn svg_sizes() {
        assert_eq!(
            svg_size(r#"<svg width="100" height="50">"#),
            Some((100.0, 50.0))
        );
        assert_eq!(
            svg_size(r#"<svg viewBox="0 0 24 24" stroke-width="2">"#),
            Some((24.0, 24.0))
        );
        assert_eq!(
            svg_size(r#"<svg width="100%" height="100%">"#),
            Some((300.0, 150.0))
        );
        assert_eq!(
            svg_size(r#"<svg data-width="5" width='48' viewBox="0,0,24,12">"#),
            Some((48.0, 24.0))
        );
        assert_eq!(svg_size("<div/>"), None);
    }

    #[test]
    fn imports_into_page() {
        let mut d = Document::blank("x", DesignKind::Poster, 1000.0, 1000.0);
        let page = d.design.page_ids()[0].clone();
        let (ops, ids) = import_ops(
            &mut d,
            Arc::from(png(2000, 1000)),
            Some("photo.png"),
            &page,
            None,
        )
        .unwrap();
        d.apply(ops, "Import", &mut ApproxMeasurer).unwrap();
        let n = d.design.node(&ids[0]).unwrap();
        assert_eq!((n.base().width, n.base().height), (800.0, 400.0));
        assert_eq!((n.base().x, n.base().y), (100.0, 300.0));
        assert_eq!(n.base().name, "photo");
        let svg = br#"<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20"/></svg>"#;
        let (ops, ids) = import_ops(
            &mut d,
            Arc::from(&svg[..]),
            Some("logo.svg"),
            &page,
            Some(Point::new(50.0, 50.0)),
        )
        .unwrap();
        d.apply(ops, "Import", &mut ApproxMeasurer).unwrap();
        let n = d.design.node(&ids[0]).unwrap();
        assert_eq!((n.base().x, n.base().y, n.base().width), (30.0, 40.0, 40.0));
        assert_eq!(d.design.assets.len(), 2);
    }

    #[test]
    fn imports_nodes_with_fresh_ids() {
        let mut d = Document::blank("x", DesignKind::Poster, 500.0, 500.0);
        let page = d.design.page_ids()[0].clone();
        let r = Node::rect("aaaaaaaaaaaa", "R", 0.0, 0.0, 50.0, 50.0);
        let json = serde_json::to_vec(&vec![r]).unwrap();
        let (ops, ids) = import_ops(
            &mut d,
            Arc::from(json),
            Some("n.json"),
            &page,
            Some(Point::new(100.0, 100.0)),
        )
        .unwrap();
        d.apply(ops, "Import", &mut ApproxMeasurer).unwrap();
        assert_ne!(ids[0], "aaaaaaaaaaaa");
        let n = d.design.node(&ids[0]).unwrap();
        assert_eq!((n.base().x, n.base().y), (75.0, 75.0));
    }
}
