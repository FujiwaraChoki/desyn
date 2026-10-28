//! Asset resolution: the [`AssetStore`] trait (bytes by asset id), built-in stores, and the [`AssetCache`] that
//! decodes images / parses SVGs once and keeps the results.

mod adjust;
mod image;
mod svg;

use std::collections::{BTreeSet, HashMap};
use std::sync::Arc;

use desyn_core::model::AssetRef;

pub use adjust::{Adjustments, BoxOverlay, FILTER_PRESETS, apply_adjustments};
pub use image::{
    DecodeError, EncodedImage, MAX_IMAGE_SIDE, RasterImage, SourceFormat, decode_image, demultiply,
    premultiply,
};
pub use svg::{MAX_SVG_BYTES, parse_svg};

/// Source of asset bytes (images, SVGs, fonts, video posters) by asset id.
///
/// Implementations must not perform blocking network I/O on render paths; hosts that fetch remotely (browser,
/// worker `assetUrls`) download first and then hand bytes to [`AssetCache::insert`] or a [`MemoryAssetStore`].
pub trait AssetStore: Send {
    /// Raw bytes of the asset, or `None` when unavailable. `asset` is the design's `AssetRef` when the design
    /// lists it (stores may use `storageKey` / `mime` to locate files).
    fn load(&self, id: &str, asset: Option<&AssetRef>) -> Option<Arc<[u8]>>;
}

/// An in-memory store.
#[derive(Debug, Default, Clone)]
pub struct MemoryAssetStore {
    map: HashMap<String, Arc<[u8]>>,
}

impl MemoryAssetStore {
    /// Empty store.
    pub fn new() -> Self {
        MemoryAssetStore::default()
    }

    /// Adds or replaces an asset.
    pub fn insert(&mut self, id: impl Into<String>, bytes: impl Into<Arc<[u8]>>) {
        self.map.insert(id.into(), bytes.into());
    }

    /// Removes an asset.
    pub fn remove(&mut self, id: &str) {
        self.map.remove(id);
    }

    /// Number of assets.
    pub fn len(&self) -> usize {
        self.map.len()
    }

    /// True when empty.
    pub fn is_empty(&self) -> bool {
        self.map.is_empty()
    }
}

impl AssetStore for MemoryAssetStore {
    fn load(&self, id: &str, _asset: Option<&AssetRef>) -> Option<Arc<[u8]>> {
        self.map.get(id).cloned()
    }
}

/// A store without assets.
#[derive(Debug, Default, Clone, Copy)]
pub struct NoAssets;

impl AssetStore for NoAssets {
    fn load(&self, _id: &str, _asset: Option<&AssetRef>) -> Option<Arc<[u8]>> {
        None
    }
}

/// Native store reading files from a directory: `<dir>/<id>`, `<dir>/<id>.<ext>` (any extension), or the file
/// named like the last segment of the asset's `storageKey`.
#[cfg(not(target_arch = "wasm32"))]
#[derive(Debug, Clone)]
pub struct DirAssetStore {
    dir: std::path::PathBuf,
}

#[cfg(not(target_arch = "wasm32"))]
impl DirAssetStore {
    /// Store over `dir`.
    pub fn new(dir: impl Into<std::path::PathBuf>) -> Self {
        DirAssetStore { dir: dir.into() }
    }

    fn safe_name(name: &str) -> bool {
        !name.is_empty()
            && !name.contains(['/', '\\'])
            && name != "."
            && name != ".."
            && !name.starts_with('.')
    }
}

#[cfg(not(target_arch = "wasm32"))]
impl AssetStore for DirAssetStore {
    fn load(&self, id: &str, asset: Option<&AssetRef>) -> Option<Arc<[u8]>> {
        if !Self::safe_name(id) {
            return None;
        }
        let read = |p: std::path::PathBuf| std::fs::read(p).ok().map(Arc::from);
        if let Some(b) = read(self.dir.join(id)) {
            return Some(b);
        }
        if let Ok(entries) = std::fs::read_dir(&self.dir) {
            let prefix = format!("{id}.");
            let mut names: Vec<std::path::PathBuf> = entries
                .filter_map(|e| e.ok())
                .map(|e| e.path())
                .filter(|p| {
                    p.file_name()
                        .and_then(|n| n.to_str())
                        .is_some_and(|n| n.starts_with(&prefix))
                })
                .collect();
            names.sort();
            if let Some(b) = names.into_iter().find_map(read) {
                return Some(b);
            }
        }
        let key = asset.and_then(|a| a.storage_key.as_deref())?;
        let base = key.rsplit('/').next()?;
        if !Self::safe_name(base) {
            return None;
        }
        read(self.dir.join(base))
    }
}

/// Why an asset could not be used.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AssetIssue {
    /// No bytes available (hosts should fetch it and rebuild).
    Missing,
    /// Bytes could not be decoded / parsed.
    Invalid(String),
}

enum Slot {
    Ready(Arc<RasterImage>, u64),
    Failed(AssetIssue),
}

/// Budget for decoded and adjusted images kept in memory.
pub const DEFAULT_IMAGE_BUDGET: usize = 768 << 20;

/// Decoding cache in front of an [`AssetStore`], plus bytes registered by the host.
pub struct AssetCache {
    store: Box<dyn AssetStore>,
    overrides: HashMap<String, Arc<[u8]>>,
    images: HashMap<String, Slot>,
    adjusted: HashMap<(u64, u64), (Arc<RasterImage>, u64)>,
    svgs: HashMap<u64, Option<Arc<usvg::Tree>>>,
    fontdb: Option<(u64, Arc<usvg::fontdb::Database>)>,
    tick: u64,
    generation: u64,
    budget: usize,
    missing: BTreeSet<String>,
}

impl std::fmt::Debug for AssetCache {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AssetCache")
            .field("images", &self.images.len())
            .field("adjusted", &self.adjusted.len())
            .field("svgs", &self.svgs.len())
            .field("generation", &self.generation)
            .finish()
    }
}

impl AssetCache {
    /// Cache over a store.
    pub fn new(store: Box<dyn AssetStore>) -> Self {
        AssetCache {
            store,
            overrides: HashMap::new(),
            images: HashMap::new(),
            adjusted: HashMap::new(),
            svgs: HashMap::new(),
            fontdb: None,
            tick: 0,
            generation: 0,
            budget: DEFAULT_IMAGE_BUDGET,
            missing: BTreeSet::new(),
        }
    }

    /// Replaces the store (drops every cached decode).
    pub fn set_store(&mut self, store: Box<dyn AssetStore>) {
        self.store = store;
        self.clear();
    }

    /// Registers bytes for an asset id (wins over the store) and invalidates its decodes.
    pub fn insert(&mut self, id: impl Into<String>, bytes: impl Into<Arc<[u8]>>) {
        let id = id.into();
        self.overrides.insert(id.clone(), bytes.into());
        self.invalidate(&id);
    }

    /// Forgets registered bytes and decodes of one asset.
    pub fn remove(&mut self, id: &str) {
        self.overrides.remove(id);
        self.invalidate(id);
    }

    /// Drops the decodes of one asset (e.g. after the store's bytes changed).
    pub fn invalidate(&mut self, id: &str) {
        if let Some(Slot::Ready(img, _)) = self.images.remove(id) {
            self.adjusted.retain(|(src, _), _| *src != img.id());
        }
        self.svgs.remove(&svg_asset_key(id));
        self.missing.remove(id);
        self.generation += 1;
    }

    /// Drops every decode.
    pub fn clear(&mut self) {
        self.images.clear();
        self.adjusted.clear();
        self.svgs.clear();
        self.missing.clear();
        self.generation += 1;
    }

    /// Changes whenever cached content may differ (part of display-list cache keys).
    pub fn generation(&self) -> u64 {
        self.generation
    }

    /// Sets the memory budget for decoded images (bytes).
    pub fn set_budget(&mut self, bytes: usize) {
        self.budget = bytes.max(16 << 20);
        self.evict();
    }

    /// Asset ids that were requested but had no bytes since the last [`AssetCache::take_missing`].
    pub fn take_missing(&mut self) -> Vec<String> {
        std::mem::take(&mut self.missing).into_iter().collect()
    }

    /// Raw bytes (host overrides first, then the store).
    pub fn bytes(&self, id: &str, asset: Option<&AssetRef>) -> Option<Arc<[u8]>> {
        self.overrides
            .get(id)
            .cloned()
            .or_else(|| self.store.load(id, asset))
    }

    /// Decoded image of an asset.
    pub fn image(
        &mut self,
        id: &str,
        asset: Option<&AssetRef>,
    ) -> Result<Arc<RasterImage>, AssetIssue> {
        self.tick += 1;
        let tick = self.tick;
        match self.images.get_mut(id) {
            Some(Slot::Ready(img, used)) => {
                *used = tick;
                return Ok(img.clone());
            }
            Some(Slot::Failed(issue)) => {
                if *issue == AssetIssue::Missing {
                    self.missing.insert(id.to_string());
                }
                return Err(issue.clone());
            }
            None => {}
        }
        let Some(bytes) = self.bytes(id, asset) else {
            self.missing.insert(id.to_string());
            self.images
                .insert(id.to_string(), Slot::Failed(AssetIssue::Missing));
            return Err(AssetIssue::Missing);
        };
        match decode_image(bytes) {
            Ok(img) => {
                let img = Arc::new(img);
                self.images
                    .insert(id.to_string(), Slot::Ready(img.clone(), tick));
                self.evict();
                Ok(img)
            }
            Err(e) => {
                let issue = AssetIssue::Invalid(e.to_string());
                self.images
                    .insert(id.to_string(), Slot::Failed(issue.clone()));
                Err(issue)
            }
        }
    }

    /// `img` with adjustments (and optionally box overlays) applied, cached per image and parameters.
    pub fn adjusted(
        &mut self,
        img: &Arc<RasterImage>,
        adj: &Adjustments,
        blur_px: f64,
        overlay: Option<&BoxOverlay>,
    ) -> Arc<RasterImage> {
        if adj.is_pixel_identity() && overlay.is_none() {
            return img.clone();
        }
        self.tick += 1;
        let key = (
            img.id(),
            crate::hash::combine(
                adj.pixel_key(blur_px),
                overlay.map(BoxOverlay::key).unwrap_or(0),
            ),
        );
        if let Some((hit, used)) = self.adjusted.get_mut(&key) {
            *used = self.tick;
            return hit.clone();
        }
        let out = match overlay {
            // Box overlays change with the box size (every frame of a resize gesture): reuse the cached
            // color / blur / sharpen result and only redo the cheap overlay pass.
            Some(o) => {
                let base = self.adjusted(img, adj, blur_px, None);
                Arc::new(adjust::apply_box_overlay(&base, o))
            }
            None => Arc::new(apply_adjustments(img, adj, blur_px, None)),
        };
        self.tick += 1;
        self.adjusted.insert(key, (out.clone(), self.tick));
        self.evict();
        out
    }

    /// Parsed, sanitized SVG of an asset.
    pub fn svg_asset(
        &mut self,
        id: &str,
        asset: Option<&AssetRef>,
        fonts: &desyn_text::FontDb,
    ) -> Result<Arc<usvg::Tree>, AssetIssue> {
        let key = svg_asset_key(id);
        if let Some(hit) = self.svgs.get(&key) {
            return hit
                .clone()
                .ok_or_else(|| AssetIssue::Invalid("svg parse failed".into()));
        }
        let Some(bytes) = self.bytes(id, asset) else {
            self.missing.insert(id.to_string());
            return Err(AssetIssue::Missing);
        };
        let db = self.svg_fontdb(fonts);
        let tree = parse_svg(&bytes, db).ok().map(Arc::new);
        self.svgs.insert(key, tree.clone());
        tree.ok_or_else(|| AssetIssue::Invalid("svg parse failed".into()))
    }

    /// Parsed, sanitized inline SVG markup.
    pub fn svg_markup(
        &mut self,
        markup: &str,
        fonts: &desyn_text::FontDb,
    ) -> Result<Arc<usvg::Tree>, AssetIssue> {
        let key = crate::hash::combine(0x0053_5647, crate::hash::hash_of(markup));
        if let Some(hit) = self.svgs.get(&key) {
            return hit
                .clone()
                .ok_or_else(|| AssetIssue::Invalid("svg parse failed".into()));
        }
        let db = self.svg_fontdb(fonts);
        let tree = parse_svg(markup.as_bytes(), db).ok().map(Arc::new);
        if self.svgs.len() > 512 {
            self.svgs.clear();
        }
        self.svgs.insert(key, tree.clone());
        tree.ok_or_else(|| AssetIssue::Invalid("svg parse failed".into()))
    }

    /// Font database for SVG `<text>`: the text engine's faces, rebuilt when its generation changes.
    fn svg_fontdb(&mut self, fonts: &desyn_text::FontDb) -> Arc<usvg::fontdb::Database> {
        let generation = fonts.generation();
        if let Some((g, db)) = &self.fontdb
            && *g == generation
        {
            return db.clone();
        }
        let mut db = usvg::fontdb::Database::new();
        let mut seen = BTreeSet::new();
        for face in fonts.faces() {
            if let Some((data, _)) = fonts.font_data(face.id)
                && seen.insert(data.as_ptr() as usize)
            {
                db.load_font_data(data.to_vec());
            }
        }
        db.set_sans_serif_family("Inter");
        db.set_serif_family("Instrument Serif");
        db.set_monospace_family("JetBrains Mono");
        let db = Arc::new(db);
        self.fontdb = Some((generation, db.clone()));
        db
    }

    fn evict(&mut self) {
        let size = |i: &RasterImage| (i.width() as usize) * (i.height() as usize) * 4;
        let mut total: usize = self
            .images
            .values()
            .map(|s| match s {
                Slot::Ready(i, _) => size(i),
                Slot::Failed(_) => 0,
            })
            .sum::<usize>()
            + self.adjusted.values().map(|(i, _)| size(i)).sum::<usize>();
        while total > self.budget {
            // Oldest entry across both maps.
            let oldest_img = self
                .images
                .iter()
                .filter_map(|(k, s)| match s {
                    Slot::Ready(i, t) => Some((*t, k.clone(), size(i))),
                    Slot::Failed(_) => None,
                })
                .min_by_key(|x| x.0);
            let oldest_adj = self
                .adjusted
                .iter()
                .map(|(k, (i, t))| (*t, *k, size(i)))
                .min_by_key(|x| x.0);
            match (oldest_img, oldest_adj) {
                (Some(a), Some(b)) if b.0 < a.0 => {
                    self.adjusted.remove(&b.1);
                    total -= b.2;
                }
                (Some(a), _) => {
                    self.images.remove(&a.1);
                    total -= a.2;
                }
                (None, Some(b)) => {
                    self.adjusted.remove(&b.1);
                    total -= b.2;
                }
                (None, None) => break,
            }
        }
    }
}

fn svg_asset_key(id: &str) -> u64 {
    crate::hash::combine(0x4153_5354, crate::hash::hash_of(id))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn png_1x1() -> Vec<u8> {
        crate::export::bitmap::encode_png_rgba(1, 1, &[255, 0, 0, 255], None).unwrap()
    }

    #[test]
    fn cache_decodes_once_and_reports_missing() {
        let mut store = MemoryAssetStore::new();
        store.insert("img000000001", png_1x1());
        let mut cache = AssetCache::new(Box::new(store));
        let a = cache.image("img000000001", None).unwrap();
        let b = cache.image("img000000001", None).unwrap();
        assert!(Arc::ptr_eq(&a, &b));
        assert!(matches!(
            cache.image("nope00000000", None),
            Err(AssetIssue::Missing)
        ));
        assert_eq!(cache.take_missing(), vec!["nope00000000".to_string()]);
        let g = cache.generation();
        cache.insert("nope00000000", png_1x1());
        assert!(cache.generation() > g);
        assert!(cache.image("nope00000000", None).is_ok());
        cache.insert("bad000000000", b"garbage".to_vec());
        assert!(matches!(
            cache.image("bad000000000", None),
            Err(AssetIssue::Invalid(_))
        ));
    }

    #[cfg(not(target_arch = "wasm32"))]
    #[test]
    fn dir_store_rejects_traversal() {
        let s = DirAssetStore::new(std::env::temp_dir());
        assert!(s.load("../etc/passwd", None).is_none());
        assert!(s.load("", None).is_none());
    }
}
