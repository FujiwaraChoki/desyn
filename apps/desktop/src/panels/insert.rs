//! Inserting content from the panels: nodes built from the core factories (tweaked as JSON), placed at the center
//! of what the user is looking at on the current page, inserted as one transaction and selected; images and SVGs
//! from bytes become assets of the design.

use std::sync::Arc;

use desyn_core::geometry::Point;
use desyn_core::model::{AssetKind, AssetRef, AssetSource, Attribution, Id, Node, Op};
use gpui::{App, Entity};
use serde_json::{Map, Value, json};

use crate::doc::Document;
use crate::ui::editor::EditorView;

/// Builds a node from a factory node and JSON fields to override (`None` when the result is not a valid node).
pub fn tweak(node: Node, fields: Value) -> Option<Node> {
    let mut v = serde_json::to_value(&node).ok()?;
    if let (Some(o), Value::Object(f)) = (v.as_object_mut(), fields) {
        for (k, val) in f {
            if val.is_null() {
                o.remove(&k);
            } else {
                o.insert(k, val);
            }
        }
    }
    serde_json::from_value(v).ok()
}

/// The page point at the center of the viewport, kept inside the page.
pub fn view_center(e: &EditorView) -> Point {
    let s = &e.session;
    let c = s.camera.to_page(Point::new(
        s.camera.width / 2.0,
        (s.camera.height - s.camera.bottom_inset) / 2.0,
    ));
    let r = s.page_rect();
    if r.w <= 0.0 || r.h <= 0.0 {
        return c;
    }
    Point::new(c.x.clamp(r.x, r.x + r.w), c.y.clamp(r.y, r.y + r.h))
}

/// The page size.
pub fn page_size(e: &EditorView) -> (f64, f64) {
    let r = e.session.page_rect();
    (r.w.max(1.0), r.h.max(1.0))
}

/// A size that fits `(w, h)` into `frac` of the page, keeping the aspect ratio.
pub fn fit(e: &EditorView, w: f64, h: f64, frac: f64) -> (f64, f64) {
    let (pw, ph) = page_size(e);
    let s = ((pw * frac) / w.max(1.0))
        .min((ph * frac) / h.max(1.0))
        .min(1.0);
    ((w * s).max(1.0).round(), (h * s).max(1.0).round())
}

/// Inserts subtrees (each `Vec<Node>` = root first, then descendants) centered at the viewport, as one undo step,
/// and selects their roots. Returns the root ids.
pub fn insert(
    editor: &Entity<EditorView>,
    subtrees: Vec<Vec<Node>>,
    extra_ops: Vec<Op>,
    label: &str,
    cx: &mut App,
) -> Vec<Id> {
    editor.update(cx, |e, cx| {
        let page = e.session.page.clone();
        if e.session.doc.design.node(&page).is_none() {
            return Vec::new();
        }
        // Center the union of the roots on the viewport center.
        let (mut x0, mut y0, mut x1, mut y1) = (f64::MAX, f64::MAX, f64::MIN, f64::MIN);
        for st in &subtrees {
            if let Some(r) = st.first() {
                let b = r.base();
                x0 = x0.min(b.x);
                y0 = y0.min(b.y);
                x1 = x1.max(b.x + b.width);
                y1 = y1.max(b.y + b.height);
            }
        }
        let c = view_center(e);
        let (dx, dy) = if x0 <= x1 {
            (
                (c.x - (x0 + x1) / 2.0).round(),
                (c.y - (y0 + y1) / 2.0).round(),
            )
        } else {
            (0.0, 0.0)
        };
        let mut ops = extra_ops;
        let mut roots = Vec::new();
        for mut st in subtrees {
            if st.is_empty() {
                continue;
            }
            {
                let b = st[0].base_mut();
                b.x += dx;
                b.y += dy;
                b.parent = Some(page.clone());
                roots.push(b.id.clone());
            }
            ops.push(Op::create(st, page.clone(), None));
        }
        if ops.is_empty() {
            return Vec::new();
        }
        e.session.set_tool(crate::canvas::Tool::Select);
        let ok = e.session.commit(ops, label, Some(roots.clone()));
        e.after(cx);
        if ok { roots } else { Vec::new() }
    })
}

/// A fresh node id from the editor's generator.
pub fn new_id(editor: &Entity<EditorView>, cx: &mut App) -> Id {
    editor.update(cx, |e, _| e.session.doc.new_id())
}

/// Optional provenance of inserted media.
#[derive(Debug, Clone, Default)]
pub struct MediaInfo {
    /// Where it came from.
    pub source: Option<AssetSource>,
    /// Credit.
    pub attribution: Option<Attribution>,
    /// Alt text.
    pub alt: Option<String>,
}

/// Inserts an image (PNG / JPEG / WebP / GIF / SVG bytes) as a layer fitted to the page.
pub fn insert_image(
    editor: &Entity<EditorView>,
    bytes: Vec<u8>,
    name: &str,
    info: MediaInfo,
    cx: &mut App,
) -> Option<Id> {
    let kind = crate::doc::import::sniff(&bytes, Some(name)).ok()?;
    let (w, h, is_svg, meta) = match kind {
        crate::doc::import::Importable::Image {
            width,
            height,
            mime,
        } => (
            width as f64,
            height as f64,
            false,
            Document::asset_meta(AssetKind::Image, mime, Some(name), Some((width, height))),
        ),
        crate::doc::import::Importable::Svg { width, height } => (
            width,
            height,
            true,
            Document::asset_meta(AssetKind::Svg, "image/svg+xml", Some(name), None),
        ),
        _ => return None,
    };
    let bytes: Arc<[u8]> = Arc::from(bytes);
    let (asset_id, asset_ops, node) = editor.update(cx, |e, _| {
        let mut meta: AssetRef = meta;
        if is_svg {
            meta.width = Some(w);
            meta.height = Some(h);
        }
        meta.source = info.source.or(meta.source);
        meta.attribution = info.attribution.clone();
        let (aid, ops) = e.add_asset(bytes.clone(), meta);
        let (fw, fh) = fit(e, w, h, 0.6);
        let id = e.session.doc.new_id();
        let node = if is_svg {
            Node::svg(id, name.to_string(), aid.clone(), 0.0, 0.0, fw, fh)
        } else {
            Node::image(id, name.to_string(), aid.clone(), 0.0, 0.0, fw, fh)
        };
        let node = match &info.alt {
            Some(a) if !a.is_empty() => tweak(node.clone(), json!({ "alt": a })).unwrap_or(node),
            _ => node,
        };
        Some((aid, ops, node))
    })?;
    let _ = asset_id;
    insert(editor, vec![vec![node]], asset_ops, "Add image", cx)
        .into_iter()
        .next()
}

/// Builds an inline SVG node (sanitized markup) of the given size.
pub fn svg_node(id: Id, name: &str, markup: &str, w: f64, h: f64) -> Option<Node> {
    let base = Node::svg(id, name.to_string(), "placeholder", 0.0, 0.0, w, h);
    let mut f = Map::new();
    f.insert("assetId".into(), Value::Null);
    f.insert("markup".into(), json!(markup));
    tweak(base, Value::Object(f))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tweaks_and_svg_nodes() {
        let r = tweak(
            Node::rect("rect00000001", "R", 0.0, 0.0, 10.0, 10.0),
            json!({ "cornerRadius": 4, "name": "Card" }),
        )
        .unwrap();
        assert_eq!(r.base().name, "Card");
        assert_eq!(r.corner_radii(), [4.0; 4]);
        let s = svg_node(
            "svg000000001".into(),
            "Icon",
            "<svg xmlns='http://www.w3.org/2000/svg'/>",
            24.0,
            24.0,
        )
        .unwrap();
        let v = serde_json::to_value(&s).unwrap();
        assert!(v.get("assetId").is_none());
        assert!(v["markup"].as_str().unwrap().starts_with("<svg"));
        assert!(
            tweak(
                Node::rect("rect00000001", "R", 0.0, 0.0, 1.0, 1.0),
                json!({ "opacity": "nope" })
            )
            .is_none()
        );
    }
}
