//! Copy / paste of layers. The system clipboard carries the Desyn clipboard JSON (`desyn_core::clipboard`, the
//! same payload the web editor writes, so layers move between desktop and browser) and, for other apps, a PNG
//! of the copied layers. Asset bytes travel through a process-wide stash so pasting into another open design
//! keeps images even though the JSON only carries asset references.

use std::sync::{Arc, Mutex, OnceLock};

use desyn_core::Op;
use desyn_core::clipboard::{ClipboardPayload, copy};
use desyn_core::geometry::Point;
use desyn_core::model::{Id, Node};

use super::document::{AssetBytes, Document};
use super::import;

fn stash() -> &'static Mutex<AssetBytes> {
    static STASH: OnceLock<Mutex<AssetBytes>> = OnceLock::new();
    STASH.get_or_init(|| Mutex::new(AssetBytes::new()))
}

/// What was copied.
#[derive(Debug, Clone)]
pub struct Copied {
    /// Payload JSON for the system clipboard.
    pub json: String,
    /// The payload.
    pub payload: ClipboardPayload,
}

/// Copies the selection; asset bytes go to the stash.
pub fn copy_selection(doc: &Document, ids: &[Id]) -> Option<Copied> {
    let payload = copy(&doc.design, ids)?;
    if let Ok(mut s) = stash().lock() {
        for id in payload.assets.keys() {
            if let Some(b) = doc.assets.get(id) {
                s.insert(id.clone(), b.clone());
            }
        }
        // Keep the stash bounded: drop entries no longer referenced by the newest copy when it grows large.
        let total: usize = s.values().map(|b| b.len()).sum();
        if total > 512 << 20 {
            s.retain(|k, _| payload.assets.contains_key(k));
        }
    }
    Some(Copied {
        json: payload.to_json(),
        payload,
    })
}

/// What a paste produced.
#[derive(Debug, Clone, Default)]
pub struct Pasted {
    /// Ops to apply.
    pub ops: Vec<Op>,
    /// New top-level layers (the new selection).
    pub roots: Vec<Id>,
    /// Asset ids whose bytes are unknown (pasted from another machine or the web); the canvas shows them as
    /// missing until a sync module provides them.
    pub missing_assets: Vec<Id>,
}

/// Pastes clipboard text into `parent`. `at` = page point to center on (None = keep the copied position, i.e.
/// paste in place). Returns `None` when the text is not Desyn JSON.
pub fn paste_payload_text(
    doc: &mut Document,
    text: &str,
    parent: &str,
    at: Option<Point>,
    offset: (f64, f64),
) -> Option<Pasted> {
    let mut payload = ClipboardPayload::from_json(text)?;
    if offset != (0.0, 0.0) {
        for s in &mut payload.subtrees {
            if let Some(n) = s.first_mut() {
                n.base_mut().x += offset.0;
                n.base_mut().y += offset.1;
            }
        }
    }
    let mut missing = Vec::new();
    if let Ok(s) = stash().lock() {
        for id in payload.assets.keys() {
            if doc.assets.contains_key(id) {
                continue;
            }
            match s.get(id) {
                Some(b) => {
                    doc.assets.insert(id.clone(), b.clone());
                }
                None => missing.push(id.clone()),
            }
        }
    }
    let (ops, roots) = import::paste_payload(doc, &payload, parent, at);
    Some(Pasted {
        ops,
        roots,
        missing_assets: missing,
    })
}

/// Pastes plain text as a text layer centered at `at`.
pub fn paste_plain_text(doc: &mut Document, text: &str, parent: &str, at: Point) -> Pasted {
    let text: String = text.replace("\r\n", "\n").chars().take(20_000).collect();
    let id = doc.new_id();
    let lines = text.lines().count().max(1) as f64;
    let longest = text.lines().map(|l| l.chars().count()).max().unwrap_or(1) as f64;
    // Approximate the default 24 px Inter box so the layer lands centered; layout normalization measures it.
    let (w, h) = ((longest * 12.0).clamp(20.0, 800.0), lines * 29.0);
    let wrap = (longest * 12.0 > 800.0).then_some(800.0);
    let mut node = Node::text(id.clone(), text, at.x - w / 2.0, at.y - h / 2.0, wrap);
    node.base_mut().name = node
        .base()
        .name
        .lines()
        .next()
        .unwrap_or("Text")
        .to_string();
    Pasted {
        ops: vec![Op::create(vec![node], parent, None)],
        roots: vec![id],
        missing_assets: Vec::new(),
    }
}

/// Pastes image or SVG bytes (from the clipboard or a drop) centered at `at`.
pub fn paste_bytes(
    doc: &mut Document,
    bytes: Arc<[u8]>,
    name: Option<&str>,
    parent: &str,
    at: Point,
) -> Result<Pasted, import::ImportError> {
    let (ops, roots) = import::import_ops(doc, bytes, name, parent, Some(at))?;
    Ok(Pasted {
        ops,
        roots,
        missing_assets: Vec::new(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use desyn_core::layout::ApproxMeasurer;
    use desyn_core::model::{AssetKind, DesignKind};

    #[test]
    fn copy_paste_across_documents_keeps_asset_bytes() {
        let mut a = Document::blank("A", DesignKind::Poster, 500.0, 500.0);
        let pa = a.design.page_ids()[0].clone();
        let bytes: Arc<[u8]> = Arc::from(&b"fake png bytes for the stash"[..]);
        let (aid, mut ops) = a.add_asset(
            bytes.clone(),
            Document::asset_meta(AssetKind::Image, "image/png", None, Some((10, 10))),
        );
        let img = a.new_id();
        ops.push(Op::create(
            vec![Node::image(
                img.clone(),
                "Photo",
                aid.clone(),
                10.0,
                20.0,
                100.0,
                100.0,
            )],
            pa,
            None,
        ));
        a.apply(ops, "add", &mut ApproxMeasurer);
        let c = copy_selection(&a, std::slice::from_ref(&img)).unwrap();

        let mut b = Document::blank("B", DesignKind::Poster, 500.0, 500.0);
        let pb = b.design.page_ids()[0].clone();
        let p = paste_payload_text(&mut b, &c.json, &pb, None, (16.0, 16.0)).unwrap();
        assert!(p.missing_assets.is_empty());
        assert_eq!(b.assets.get(&aid), Some(&bytes));
        b.apply(p.ops, "paste", &mut ApproxMeasurer).unwrap();
        let n = b.design.node(&p.roots[0]).unwrap();
        assert_eq!(
            (n.base().x, n.base().y),
            (26.0, 36.0),
            "pasted in place plus the offset"
        );
        assert!(paste_payload_text(&mut b, "just text", &pb, None, (0.0, 0.0)).is_none());
    }

    #[test]
    fn plain_text_becomes_a_text_layer() {
        let mut d = Document::blank("A", DesignKind::Poster, 500.0, 500.0);
        let p = d.design.page_ids()[0].clone();
        let r = paste_plain_text(&mut d, "Hello\r\nworld", &p, Point::new(250.0, 250.0));
        d.apply(r.ops, "paste", &mut ApproxMeasurer).unwrap();
        match d.design.node(&r.roots[0]) {
            Some(Node::Text(t)) => {
                assert_eq!(t.runs[0].text, "Hello\nworld");
                assert_eq!(t.base.name, "Hello");
            }
            o => panic!("{o:?}"),
        }
    }
}
