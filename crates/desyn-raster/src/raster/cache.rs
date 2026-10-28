//! Cache of rendered layers with effects / masks (the expensive ones), keyed by layer content key and device
//! transform. A pure integer translation of the transform (panning) reuses the entry with an offset.

use std::collections::HashMap;
use std::sync::Arc;

use desyn_core::geometry::Affine;
use tiny_skia::{IntRect, Pixmap};

/// Image id, width, height, padded.
type ResampleKey = (u64, u32, u32, bool);

struct Entry {
    linear: [f64; 4],
    frac: (f64, f64),
    base: (f64, f64),
    rect: IntRect,
    pix: Arc<Pixmap>,
    used: u64,
}

/// Rendered-layer cache (kept by the [`crate::Renderer`] across frames). It also keeps images resampled to the
/// exact device size they are drawn at, so repeated frames sample them 1:1.
pub struct LayerCache {
    entries: HashMap<u64, Entry>,
    resampled: HashMap<ResampleKey, (Arc<Pixmap>, u64)>,
    requests: HashMap<ResampleKey, u64>,
    resampled_bytes: usize,
    bytes: usize,
    budget: usize,
    tick: u64,
    hits: u64,
    misses: u64,
}

impl std::fmt::Debug for LayerCache {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LayerCache")
            .field("entries", &self.entries.len())
            .field("bytes", &self.bytes)
            .field("hits", &self.hits)
            .field("misses", &self.misses)
            .finish()
    }
}

impl Default for LayerCache {
    fn default() -> Self {
        LayerCache::new(128 << 20)
    }
}

impl LayerCache {
    /// Cache with a memory budget in bytes.
    pub fn new(budget: usize) -> Self {
        LayerCache {
            entries: HashMap::new(),
            resampled: HashMap::new(),
            requests: HashMap::new(),
            resampled_bytes: 0,
            bytes: 0,
            budget,
            tick: 0,
            hits: 0,
            misses: 0,
        }
    }

    /// Drops every entry.
    pub fn clear(&mut self) {
        self.entries.clear();
        self.bytes = 0;
        self.resampled.clear();
        self.requests.clear();
        self.resampled_bytes = 0;
    }

    /// `img` resampled to `w x h` (with a one pixel transparent border when `padded`). Upscales and mild
    /// downscales resample on the first request (cheaper than direct bicubic sampling, so a one-off render or
    /// a resize gesture also benefits); strong downscales (wide kernels over many source pixels) only on the
    /// second request for the same size, so zoom gestures never pay for them.
    pub(crate) fn resampled(
        &mut self,
        img: &crate::assets::RasterImage,
        w: u32,
        h: u32,
        padded: bool,
    ) -> Option<Arc<Pixmap>> {
        self.tick += 1;
        let key = (img.id(), w, h, padded);
        if let Some((p, used)) = self.resampled.get_mut(&key) {
            *used = self.tick;
            return Some(p.clone());
        }
        // A resample too large to stay cached would be recomputed in full for every region (tile) drawn;
        // direct sampling costs only the region.
        if (w as usize) * (h as usize) * 4 > self.budget / 2 {
            return None;
        }
        let seen = self.requests.entry(key).or_insert(0);
        *seen += 1;
        if *seen < 2 && !super::resample::cheap(img.width(), img.height(), w, h) {
            if self.requests.len() > 4096 {
                self.requests.clear();
            }
            return None;
        }
        self.requests.remove(&key);
        let edge = if padded {
            super::resample::ResampleEdge::Transparent
        } else {
            super::resample::ResampleEdge::Clamp
        };
        let pix = Arc::new(super::resample::resample(img.pixmap(), w, h, edge, padded)?);
        let size = pix.data().len();
        if size > self.budget / 2 {
            return Some(pix);
        }
        self.resampled_bytes += size;
        self.resampled.insert(key, (pix.clone(), self.tick));
        while self.resampled_bytes > self.budget / 2 {
            let Some((&k, _)) = self.resampled.iter().min_by_key(|(_, e)| e.1) else {
                break;
            };
            if let Some((p, _)) = self.resampled.remove(&k) {
                self.resampled_bytes -= p.data().len();
            }
        }
        Some(pix)
    }

    /// `(hits, misses)` since creation.
    pub fn stats(&self) -> (u64, u64) {
        (self.hits, self.misses)
    }

    /// Number of entries.
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// True when empty.
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub(crate) fn get(&mut self, key: u64, m: &Affine) -> Option<(Arc<Pixmap>, IntRect)> {
        self.tick += 1;
        let e = self.entries.get_mut(&key);
        let Some(e) = e else {
            self.misses += 1;
            return None;
        };
        let lin = [m.a, m.b, m.c, m.d];
        let frac = (m.e - m.e.floor(), m.f - m.f.floor());
        let same = lin
            .iter()
            .zip(e.linear.iter())
            .all(|(a, b)| (a - b).abs() < 1e-9)
            && (frac.0 - e.frac.0).abs() < 1e-6
            && (frac.1 - e.frac.1).abs() < 1e-6;
        if !same {
            self.misses += 1;
            return None;
        }
        e.used = self.tick;
        self.hits += 1;
        let dx = (m.e.floor() - e.base.0) as i32;
        let dy = (m.f.floor() - e.base.1) as i32;
        let r = IntRect::from_xywh(
            e.rect.x() + dx,
            e.rect.y() + dy,
            e.rect.width(),
            e.rect.height(),
        )?;
        Some((e.pix.clone(), r))
    }

    pub(crate) fn put(&mut self, key: u64, m: &Affine, pix: Pixmap, rect: IntRect) {
        let size = pix.data().len();
        if size > self.budget / 4 {
            return;
        }
        self.tick += 1;
        if let Some(old) = self.entries.remove(&key) {
            self.bytes -= old.pix.data().len();
        }
        self.bytes += size;
        self.entries.insert(
            key,
            Entry {
                linear: [m.a, m.b, m.c, m.d],
                frac: (m.e - m.e.floor(), m.f - m.f.floor()),
                base: (m.e.floor(), m.f.floor()),
                rect,
                pix: Arc::new(pix),
                used: self.tick,
            },
        );
        while self.bytes > self.budget {
            let Some((&k, _)) = self.entries.iter().min_by_key(|(_, e)| e.used) else {
                break;
            };
            if let Some(e) = self.entries.remove(&k) {
                self.bytes -= e.pix.data().len();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn translation_reuse_and_eviction() {
        let mut c = LayerCache::new(4 * 100 * 100 * 8);
        let m = Affine::translate(10.25, 20.0);
        c.put(
            1,
            &m,
            Pixmap::new(100, 100).unwrap(),
            IntRect::from_xywh(10, 20, 100, 100).unwrap(),
        );
        let (_, r) = c.get(1, &Affine::translate(15.25, 22.0)).unwrap();
        assert_eq!((r.x(), r.y()), (15, 22));
        assert!(c.get(1, &Affine::translate(15.5, 22.0)).is_none());
        assert!(c.get(1, &Affine::scale(2.0, 2.0)).is_none());
        for k in 2..20 {
            c.put(
                k,
                &m,
                Pixmap::new(100, 100).unwrap(),
                IntRect::from_xywh(0, 0, 100, 100).unwrap(),
            );
        }
        assert!(c.len() <= 8);
    }

    #[test]
    fn resamples_that_cannot_stay_cached_are_not_computed() {
        let img = crate::assets::RasterImage::from_rgba8(4, 4, vec![255; 64]).unwrap();
        let mut c = LayerCache::new(4 * 64 * 64);
        // 64x64 needs 16 KiB, more than half of the 16 KiB budget: every request falls back to direct sampling
        // instead of computing a resample that would be thrown away.
        for _ in 0..3 {
            assert!(c.resampled(&img, 64, 64, false).is_none());
        }
        // Sizes that fit are computed and then served from the cache.
        let a = c.resampled(&img, 16, 16, false).unwrap();
        let b = c.resampled(&img, 16, 16, false).unwrap();
        assert!(Arc::ptr_eq(&a, &b));
    }
}
