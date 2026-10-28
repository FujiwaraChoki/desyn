//! Page thumbnails (cover for the library, per page for the pages strip and the file manifest), rendered by
//! desyn-raster so they match every other client.

use desyn_core::model::{Design, Id};
use desyn_raster::export::bitmap::encode_png;
use desyn_raster::{PageRenderOptions, Renderer};

use std::collections::HashSet;
use std::sync::{Mutex, OnceLock};

use desyn_raster::NoAssets;
use desyn_text::TextEngine;

use super::format::Thumbnails;
use crate::doc::AssetBytes;

/// Longest side of the cover thumbnail.
pub const COVER_PX: f64 = 512.0;
/// Longest side of page thumbnails.
pub const PAGE_PX: f64 = 256.0;
/// Page thumbnails are written for at most this many pages.
pub const MAX_PAGE_THUMBS: usize = 64;

/// Renders a page so its longest side is `px`; returns straight-alpha PNG bytes.
pub fn render_png(r: &mut Renderer, design: &Design, page: &Id, px: f64) -> Option<Vec<u8>> {
    let n = design.node(page)?;
    let (w, h) = (n.base().width, n.base().height);
    let longest = w.max(h);
    if !(longest.is_finite() && longest > 0.0) {
        return None;
    }
    let scale = (px / longest).min(4.0);
    let opts = PageRenderOptions {
        page: Some(page.clone()),
        scale,
        ..Default::default()
    };
    let rendered = r.render_page(design, &opts).ok()?;
    encode_png(&rendered.pixmap, None).ok()
}

/// Renders the cover and page thumbnails for a file.
pub fn render_all(r: &mut Renderer, design: &Design) -> Thumbnails {
    let pages: Vec<Id> = Renderer::page_ids(design);
    let cover = pages
        .first()
        .and_then(|p| render_png(r, design, p, COVER_PX));
    let pages = pages
        .iter()
        .take(MAX_PAGE_THUMBS)
        .filter_map(|p| render_png(r, design, p, PAGE_PX).map(|png| (p.clone(), png)))
        .collect();
    Thumbnails { cover, pages }
}

/// Renders the thumbnails of a file off the UI thread (background saves). One renderer is shared by every
/// background save so the bundled fonts load once; it holds exactly the asset bytes of the design it renders
/// last, so closed designs do not stay in memory.
pub fn render_all_shared(design: &Design, assets: &AssetBytes) -> Thumbnails {
    static SHARED: OnceLock<Mutex<(Renderer, HashSet<Id>)>> = OnceLock::new();
    let m = SHARED.get_or_init(|| {
        Mutex::new((
            Renderer::new(TextEngine::with_bundled_fonts(), Box::new(NoAssets)),
            HashSet::new(),
        ))
    });
    let mut guard = m.lock().unwrap_or_else(|e| e.into_inner());
    let (r, loaded) = &mut *guard;
    let stale: Vec<Id> = loaded
        .iter()
        .filter(|id| !assets.contains_key(*id))
        .cloned()
        .collect();
    for id in stale {
        r.assets_mut().remove(&id);
        loaded.remove(&id);
    }
    for (id, bytes) in assets {
        if loaded.insert(id.clone()) {
            r.assets_mut().insert(id.clone(), bytes.clone());
        }
    }
    render_all(r, design)
}

#[cfg(test)]
mod tests {
    use super::*;
    use desyn_core::Op;
    use desyn_core::layout::ApproxMeasurer;
    use desyn_core::model::{DesignKind, Node};

    #[test]
    fn renders_pngs() {
        let mut d = crate::doc::Document::blank("T", DesignKind::Poster, 800.0, 400.0);
        let page = d.design.page_ids()[0].clone();
        let id = d.new_id();
        d.apply(
            vec![Op::create(
                vec![Node::rect(id, "R", 0.0, 0.0, 400.0, 400.0)],
                page,
                None,
            )],
            "a",
            &mut ApproxMeasurer,
        );
        let mut r = Renderer::empty();
        let t = render_all(&mut r, &d.design);
        let cover = t.cover.expect("cover");
        assert_eq!(&cover[1..4], b"PNG");
        let img = image::load_from_memory(&cover).unwrap();
        assert_eq!((img.width(), img.height()), (512, 256));
        assert_eq!(t.pages.len(), 1);
        // The background renderer gives the same pictures and works from any thread.
        let design = d.design.clone();
        let assets = d.assets.clone();
        let shared = std::thread::spawn(move || render_all_shared(&design, &assets))
            .join()
            .unwrap();
        assert_eq!(shared.pages.len(), 1);
        assert_eq!(shared.cover.as_deref(), Some(&cover[..]));
    }
}
