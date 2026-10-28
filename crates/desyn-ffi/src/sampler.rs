//! Image statistics for `describe` / `lint` (contrast of text over photos), taken from the images the renderer
//! already decoded.
//!
//! Each image asset is reduced once to a small straight-alpha thumbnail (at most [`THUMB_SIDE`] px per side) and
//! cached until the asset cache changes. `describe` reads at most 4096 pixels per sample anyway, so the
//! thumbnail keeps the statistics while bounding memory for large photos.

use std::collections::HashMap;

use desyn_core::model::{AssetKind, Design};
use desyn_describe::PixelSampler;
use desyn_raster::Renderer;
use desyn_raster::tiny_skia::Pixmap;

/// Longest side of a sampling thumbnail.
pub(crate) const THUMB_SIDE: u32 = 256;

/// Straight-alpha RGBA thumbnails keyed by asset id.
#[derive(Default)]
pub(crate) struct SampleCache {
    generation: u64,
    thumbs: HashMap<String, Option<(usize, usize, Vec<u8>)>>,
}

impl SampleCache {
    /// Builds a sampler over every image asset of `design` that has bytes.
    pub(crate) fn sampler(&mut self, design: &Design, renderer: &mut Renderer) -> PixelSampler {
        let generation = renderer.assets_mut().generation();
        if generation != self.generation {
            self.thumbs.clear();
            self.generation = generation;
        }
        let mut sampler = PixelSampler::new();
        for (id, asset) in &design.assets {
            if asset.kind != AssetKind::Image {
                continue;
            }
            let entry = self.thumbs.entry(id.clone()).or_insert_with(|| {
                renderer
                    .assets_mut()
                    .image(id, Some(asset))
                    .ok()
                    .map(|img| thumbnail(img.pixmap()))
            });
            if let Some((w, h, rgba)) = entry {
                sampler.insert(id.clone(), *w, *h, rgba.clone());
            }
        }
        sampler
    }
}

/// Nearest-neighbor reduction of a premultiplied pixmap to straight RGBA8.
pub(crate) fn thumbnail(p: &Pixmap) -> (usize, usize, Vec<u8>) {
    let (sw, sh) = (p.width().max(1), p.height().max(1));
    let k = (f64::from(sw.max(sh)) / f64::from(THUMB_SIDE)).max(1.0);
    let w = ((f64::from(sw) / k).round() as u32).clamp(1, sw);
    let h = ((f64::from(sh) / k).round() as u32).clamp(1, sh);
    let src = p.data();
    let mut out = Vec::with_capacity(w as usize * h as usize * 4);
    for y in 0..h {
        let sy = ((u64::from(y) * u64::from(sh)) / u64::from(h)) as usize;
        for x in 0..w {
            let sx = ((u64::from(x) * u64::from(sw)) / u64::from(w)) as usize;
            let i = (sy * sw as usize + sx) * 4;
            let a = src[i + 3];
            if a == 0 {
                out.extend_from_slice(&[0, 0, 0, 0]);
            } else {
                let un =
                    |c: u8| ((u32::from(c) * 255 + u32::from(a) / 2) / u32::from(a)).min(255) as u8;
                out.extend_from_slice(&[un(src[i]), un(src[i + 1]), un(src[i + 2]), a]);
            }
        }
    }
    (w as usize, h as usize, out)
}
