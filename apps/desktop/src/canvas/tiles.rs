//! Tile cache for the canvas. The page is rasterized by desyn-raster into 256 × 256 device-pixel tiles anchored
//! at the page origin (device px = page px × zoom × window scale), so panning reuses tiles and only newly
//! exposed tiles render. Edits rebuild the display list (incremental in desyn-raster) and redraw only the
//! damaged region of the affected tiles. Zooming keeps the previous zoom's tiles as a scaled stand-in until the
//! new tiles are ready, and tile rendering is budgeted per frame so interaction stays at display refresh rate.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use desyn_core::geometry::{Affine, Rect};
use desyn_core::model::{Design, Id};
use desyn_raster::display::{BuildOptions, DisplayList, damage};
use desyn_raster::tiny_skia::{IntRect, Pixmap};
use desyn_raster::{RasterOptions, Renderer};

/// Tile side in device px.
pub const TILE: u32 = 256;
/// Tiles kept per zoom level before far ones are evicted.
pub const MAX_TILES: usize = 600;

/// Tile coordinates (column, row) in the device-pixel grid anchored at page (0, 0).
pub type TileKey = (i32, i32);

static NEXT_UID: AtomicU64 = AtomicU64::new(1);

fn next_uid() -> u64 {
    NEXT_UID.fetch_add(1, Ordering::Relaxed)
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum Dirty {
    Clean,
    Full,
    Region(IntRect),
}

/// One rendered tile.
#[derive(Debug)]
pub struct Tile {
    /// Premultiplied RGBA pixels.
    pub pixmap: Pixmap,
    /// Changes whenever the pixels change (UI texture cache key).
    pub uid: u64,
    dirty: Dirty,
    last_used: u64,
}

/// Tiles of one zoom level.
#[derive(Debug, Default)]
pub struct TileSet {
    /// Device px per design px.
    pub scale: f64,
    /// Tiles by key.
    pub tiles: HashMap<TileKey, Tile>,
}

impl TileSet {
    /// Page-space rect covered by a tile.
    pub fn tile_rect(&self, k: TileKey) -> Rect {
        let s = TILE as f64 / self.scale;
        Rect {
            x: k.0 as f64 * s,
            y: k.1 as f64 * s,
            w: s,
            h: s,
        }
    }
}

/// What a render pass did.
#[derive(Debug, Default, Clone, PartialEq)]
pub struct RenderPass {
    /// Tiles rendered or updated.
    pub rendered: usize,
    /// Visible tiles still missing or dirty (render again next frame).
    pub pending: usize,
}

/// The cache.
pub struct TileCache {
    current: TileSet,
    previous: Option<TileSet>,
    page: Option<Id>,
    revision: Option<u64>,
    dl: Option<DisplayList>,
    clock: u64,
    /// Extra build options (hidden nodes while an overlay edits them, animation time).
    pub hidden: Vec<Id>,
}

impl Default for TileCache {
    fn default() -> Self {
        TileCache {
            current: TileSet {
                scale: 1.0,
                tiles: HashMap::new(),
            },
            previous: None,
            page: None,
            revision: None,
            dl: None,
            clock: 0,
            hidden: Vec::new(),
        }
    }
}

/// Tiles intersecting a page rect at `scale`.
pub fn keys_for(r: &Rect, scale: f64) -> impl Iterator<Item = TileKey> + use<> {
    let t = TILE as f64;
    let x0 = (r.x * scale / t).floor() as i32;
    let y0 = (r.y * scale / t).floor() as i32;
    let x1 = ((r.x + r.w) * scale / t).ceil() as i32;
    let y1 = ((r.y + r.h) * scale / t).ceil() as i32;
    (y0..y1.max(y0 + 1)).flat_map(move |j| (x0..x1.max(x0 + 1)).map(move |i| (i, j)))
}

impl TileCache {
    /// Current tiles.
    pub fn current(&self) -> &TileSet {
        &self.current
    }

    /// The previous zoom's tiles (drawn scaled under missing current tiles).
    pub fn previous(&self) -> Option<&TileSet> {
        self.previous.as_ref()
    }

    /// Display list of the page as last built.
    pub fn display_list(&self) -> Option<&DisplayList> {
        self.dl.as_ref()
    }

    /// Forgets everything (another document).
    pub fn clear(&mut self) {
        *self = TileCache {
            hidden: std::mem::take(&mut self.hidden),
            ..TileCache::default()
        };
    }

    /// Brings the display list up to date for `page` at `revision` and marks damaged tiles. Returns whether
    /// anything changed. `scale` = zoom × device scale.
    pub fn sync(
        &mut self,
        r: &mut Renderer,
        design: &Design,
        page: &Id,
        revision: u64,
        scale: f64,
    ) -> bool {
        let scale = if scale.is_finite() && scale > 0.0 {
            scale
        } else {
            1.0
        };
        let page_changed = self.page.as_deref() != Some(page.as_str());
        let scale_changed = (self.current.scale - scale).abs() > 1e-9;
        if scale_changed {
            let old = std::mem::replace(
                &mut self.current,
                TileSet {
                    scale,
                    tiles: HashMap::new(),
                },
            );
            // Keep the closest older level only; it is a stand-in, not a cache.
            if !old.tiles.is_empty() && !page_changed {
                self.previous = Some(old);
            }
        }
        if page_changed {
            self.current.tiles.clear();
            self.previous = None;
        }
        if !page_changed && !scale_changed && self.revision == Some(revision) && self.dl.is_some() {
            return false;
        }
        let opts = BuildOptions {
            page: Some(page.clone()),
            background: true,
            hidden: self.hidden.clone(),
            raster_scale: scale,
            ..Default::default()
        };
        let dl = match r.build(design, &opts) {
            Ok(dl) => dl,
            Err(e) => {
                log::warn!("canvas: display list for page {page}: {e}");
                return false;
            }
        };
        if !page_changed
            && !scale_changed
            && let Some(old) = &self.dl
        {
            let rects = damage(old, &dl);
            self.mark_damage(&rects);
            if let Some(prev) = &mut self.previous {
                // Stand-ins under damage are wrong now: drop them.
                prev.tiles.retain(|k, _| {
                    let tr = TileSet {
                        scale: prev.scale,
                        tiles: HashMap::new(),
                    }
                    .tile_rect(*k);
                    !rects.iter().any(|d| d.intersects(&tr))
                });
            }
        } else if !scale_changed {
            for t in self.current.tiles.values_mut() {
                t.dirty = Dirty::Full;
            }
        }
        self.dl = Some(dl);
        self.page = Some(page.clone());
        self.revision = Some(revision);
        true
    }

    fn mark_damage(&mut self, rects: &[Rect]) {
        let scale = self.current.scale;
        for d in rects {
            let dev = Rect {
                x: d.x * scale,
                y: d.y * scale,
                w: d.w * scale,
                h: d.h * scale,
            };
            for k in keys_for(d, scale) {
                let Some(t) = self.current.tiles.get_mut(&k) else {
                    continue;
                };
                let ox = k.0 as f64 * TILE as f64;
                let oy = k.1 as f64 * TILE as f64;
                let x0 = ((dev.x - ox).floor() - 1.0).clamp(0.0, TILE as f64) as i32;
                let y0 = ((dev.y - oy).floor() - 1.0).clamp(0.0, TILE as f64) as i32;
                let x1 = ((dev.x + dev.w - ox).ceil() + 1.0).clamp(0.0, TILE as f64) as i32;
                let y1 = ((dev.y + dev.h - oy).ceil() + 1.0).clamp(0.0, TILE as f64) as i32;
                let Some(region) = IntRect::from_ltrb(x0, y0, x1, y1) else {
                    continue;
                };
                t.dirty = match t.dirty {
                    Dirty::Clean => Dirty::Region(region),
                    Dirty::Full => Dirty::Full,
                    Dirty::Region(r) => IntRect::from_ltrb(
                        r.left().min(region.left()),
                        r.top().min(region.top()),
                        r.right().max(region.right()),
                        r.bottom().max(region.bottom()),
                    )
                    .map(Dirty::Region)
                    .unwrap_or(Dirty::Full),
                };
            }
        }
    }

    /// Renders missing and dirty tiles among `visible` (page rect), nearest to `focus` first, until `budget`
    /// runs out.
    pub fn render(&mut self, r: &mut Renderer, visible: &Rect, budget: Duration) -> RenderPass {
        let Some(dl) = self.dl.as_ref() else {
            return RenderPass::default();
        };
        self.clock += 1;
        let scale = self.current.scale;
        let center = visible.center();
        let mut keys: Vec<TileKey> = keys_for(visible, scale).collect();
        let tile_page = TILE as f64 / scale;
        keys.sort_by(|a, b| {
            let da = ((a.0 as f64 + 0.5) * tile_page - center.x)
                .hypot((a.1 as f64 + 0.5) * tile_page - center.y);
            let db = ((b.0 as f64 + 0.5) * tile_page - center.x)
                .hypot((b.1 as f64 + 0.5) * tile_page - center.y);
            da.total_cmp(&db)
        });
        let start = Instant::now();
        let mut pass = RenderPass::default();
        for k in keys {
            let needs = match self.current.tiles.get(&k) {
                None => Some(Dirty::Full),
                Some(t) if t.dirty != Dirty::Clean => Some(t.dirty),
                Some(_) => None,
            };
            if let Some(t) = self.current.tiles.get_mut(&k) {
                t.last_used = self.clock;
            }
            let Some(dirty) = needs else { continue };
            if pass.rendered > 0 && start.elapsed() >= budget {
                pass.pending += 1;
                continue;
            }
            let transform =
                Affine::translate(-(k.0 as f64) * TILE as f64, -(k.1 as f64) * TILE as f64)
                    * Affine::scale(scale, scale);
            let region = match dirty {
                Dirty::Region(rg) => Some(rg),
                _ => None,
            };
            let tile = self.current.tiles.entry(k).or_insert_with(|| Tile {
                pixmap: Pixmap::new(TILE, TILE).expect("tile pixmap"),
                uid: 0,
                dirty: Dirty::Full,
                last_used: 0,
            });
            if region.is_none() {
                tile.pixmap
                    .fill(desyn_raster::tiny_skia::Color::TRANSPARENT);
            }
            let opts = RasterOptions {
                transform,
                region,
                background: None,
            };
            r.rasterize(dl, &mut tile.pixmap.as_mut(), &opts);
            tile.uid = next_uid();
            tile.dirty = Dirty::Clean;
            tile.last_used = self.clock;
            pass.rendered += 1;
        }
        if pass.pending == 0 && self.previous.is_some() {
            // Every visible tile of the new level exists: the stand-in level is no longer needed.
            let all_ready = keys_for(visible, scale).all(|k| self.current.tiles.contains_key(&k));
            if all_ready {
                self.previous = None;
            }
        }
        self.evict();
        pass
    }

    fn evict(&mut self) {
        if self.current.tiles.len() <= MAX_TILES {
            return;
        }
        let mut ages: Vec<(TileKey, u64)> = self
            .current
            .tiles
            .iter()
            .map(|(k, t)| (*k, t.last_used))
            .collect();
        ages.sort_by_key(|a| a.1);
        let drop = self.current.tiles.len() - MAX_TILES * 3 / 4;
        for (k, _) in ages.into_iter().take(drop) {
            self.current.tiles.remove(&k);
        }
    }

    /// Uids of every tile that may be drawn (UI texture garbage collection).
    pub fn live_uids(&self) -> impl Iterator<Item = u64> + '_ {
        self.current
            .tiles
            .values()
            .chain(self.previous.iter().flat_map(|p| p.tiles.values()))
            .map(|t| t.uid)
    }

    /// Whether any visible tile is missing or dirty.
    pub fn needs_render(&self, visible: &Rect) -> bool {
        self.dl.is_some()
            && keys_for(visible, self.current.scale).any(|k| {
                self.current
                    .tiles
                    .get(&k)
                    .is_none_or(|t| t.dirty != Dirty::Clean)
            })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use desyn_core::Op;
    use desyn_core::layout::ApproxMeasurer;
    use desyn_core::model::{DesignKind, Node};
    use desyn_raster::tiny_skia::PremultipliedColorU8;

    fn pixel(c: &TileCache, k: TileKey, x: u32, y: u32) -> PremultipliedColorU8 {
        c.current().tiles[&k].pixmap.pixel(x, y).unwrap()
    }

    #[test]
    fn renders_tiles_and_redraws_damage_only() {
        let mut doc = crate::doc::Document::blank("T", DesignKind::Poster, 600.0, 300.0);
        let page = doc.design.page_ids()[0].clone();
        let id = doc.new_id();
        let mut rect = Node::rect(id.clone(), "R", 10.0, 10.0, 50.0, 50.0);
        if let Some(s) = rect.shaped_mut() {
            s.fills = vec![desyn_core::model::Fill::solid(
                desyn_core::model::Color::new("#ff0000").unwrap(),
            )];
        }
        doc.apply(
            vec![Op::create(vec![rect], page.clone(), None)],
            "add",
            &mut ApproxMeasurer,
        );
        let mut r = Renderer::empty();
        let mut c = TileCache::default();
        assert!(c.sync(&mut r, &doc.design, &page, doc.revision(), 1.0));
        let visible = Rect {
            x: 0.0,
            y: 0.0,
            w: 600.0,
            h: 300.0,
        };
        let pass = c.render(&mut r, &visible, Duration::from_secs(5));
        assert_eq!(
            pass,
            RenderPass {
                rendered: 6,
                pending: 0
            }
        );
        assert_eq!(pixel(&c, (0, 0), 20, 20).red(), 255);
        assert_eq!(
            pixel(&c, (0, 0), 100, 100).red(),
            255,
            "white page background"
        );
        assert_eq!(pixel(&c, (0, 0), 100, 100).green(), 255);
        let uid_far = c.current().tiles[&(2, 1)].uid;
        // Move the rect: only tile (0,0) changes.
        let mut set = serde_json::Map::new();
        set.insert("x".into(), serde_json::json!(100.0));
        doc.apply(vec![Op::update_set(id, set)], "move", &mut ApproxMeasurer);
        assert!(c.sync(&mut r, &doc.design, &page, doc.revision(), 1.0));
        assert!(c.needs_render(&visible));
        let pass = c.render(&mut r, &visible, Duration::from_secs(5));
        assert_eq!(pass.rendered, 1);
        assert_eq!(c.current().tiles[&(2, 1)].uid, uid_far);
        assert_eq!(
            pixel(&c, (0, 0), 20, 20).green(),
            255,
            "old position repainted"
        );
        assert_eq!(pixel(&c, (0, 0), 120, 20).green(), 0);
        assert!(
            !c.sync(&mut r, &doc.design, &page, doc.revision(), 1.0),
            "unchanged"
        );
        // Zoom: the old level becomes the stand-in until the new tiles are complete.
        assert!(c.sync(&mut r, &doc.design, &page, doc.revision(), 2.0));
        assert!(c.previous().is_some());
        c.render(&mut r, &visible, Duration::from_secs(5));
        assert!(c.previous().is_none());
        assert_eq!(c.current().tiles.len(), 15);
    }

    #[test]
    fn budget_defers_tiles() {
        let doc = crate::doc::Document::blank("T", DesignKind::Poster, 2000.0, 2000.0);
        let page = doc.design.page_ids()[0].clone();
        let mut r = Renderer::empty();
        let mut c = TileCache::default();
        c.sync(&mut r, &doc.design, &page, 0, 1.0);
        let visible = Rect {
            x: 0.0,
            y: 0.0,
            w: 2000.0,
            h: 2000.0,
        };
        let pass = c.render(&mut r, &visible, Duration::ZERO);
        assert_eq!(pass.rendered, 1, "at least one tile per frame");
        assert!(pass.pending > 0);
        let keys: Vec<_> = keys_for(
            &Rect {
                x: 0.0,
                y: 0.0,
                w: 300.0,
                h: 10.0,
            },
            1.0,
        )
        .collect();
        assert_eq!(keys, vec![(0, 0), (1, 0)]);
    }
}
