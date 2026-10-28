//! Image sampling hook: lets the contrast lint see what is behind text that sits on a photo.
//!
//! Hosts that have decoded pixels (wasm engine asset cache, the render worker, desktop) implement
//! [`ImageSampler`] or feed RGBA buffers into [`PixelSampler`]. Without a sampler, text on images is flagged
//! `on-image` and skipped by the contrast check.

use std::collections::HashMap;

use desyn_core::color::Rgba;
use desyn_core::geometry::Rect;

/// Color statistics of an image region.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ImageSample {
    /// Mean color (alpha-weighted, unpremultiplied).
    pub average: Rgba,
    /// Darkest pixel (by relative luminance) among the sampled pixels.
    pub darkest: Rgba,
    /// Lightest pixel among the sampled pixels.
    pub lightest: Rgba,
}

/// Source of image statistics.
pub trait ImageSampler {
    /// Statistics of `region` of the image asset, in normalized source coordinates (0..1 of the image width and
    /// height, already clamped). `None` when the asset is not available.
    fn sample(&mut self, asset_id: &str, region: Rect) -> Option<ImageSample>;
}

/// Decoded RGBA8 images keyed by asset id (straight alpha, row-major, `width * height * 4` bytes).
#[derive(Debug, Default, Clone)]
pub struct PixelSampler {
    images: HashMap<String, Pixels>,
}

#[derive(Debug, Clone)]
struct Pixels {
    width: usize,
    height: usize,
    rgba: Vec<u8>,
}

/// At most this many pixels are read per sample (a regular sub-grid of the region).
const MAX_SAMPLES: usize = 4096;

impl PixelSampler {
    /// Empty sampler.
    pub fn new() -> Self {
        Self::default()
    }

    /// Registers decoded pixels for an asset. Returns `false` (and keeps nothing) when the buffer size does not
    /// match `width * height * 4`.
    pub fn insert(
        &mut self,
        asset_id: impl Into<String>,
        width: usize,
        height: usize,
        rgba: Vec<u8>,
    ) -> bool {
        if width == 0
            || height == 0
            || width.checked_mul(height).and_then(|n| n.checked_mul(4)) != Some(rgba.len())
        {
            return false;
        }
        self.images.insert(
            asset_id.into(),
            Pixels {
                width,
                height,
                rgba,
            },
        );
        true
    }

    /// Forgets an asset.
    pub fn remove(&mut self, asset_id: &str) {
        self.images.remove(asset_id);
    }

    /// Whether pixels are registered for the asset.
    pub fn contains(&self, asset_id: &str) -> bool {
        self.images.contains_key(asset_id)
    }
}

impl ImageSampler for PixelSampler {
    fn sample(&mut self, asset_id: &str, region: Rect) -> Option<ImageSample> {
        let img = self.images.get(asset_id)?;
        let (w, h) = (img.width as f64, img.height as f64);
        let x0 = ((region.x.clamp(0.0, 1.0) * w).floor() as usize).min(img.width - 1);
        let y0 = ((region.y.clamp(0.0, 1.0) * h).floor() as usize).min(img.height - 1);
        let x1 =
            (((region.x + region.w).clamp(0.0, 1.0) * w).ceil() as usize).clamp(x0 + 1, img.width);
        let y1 =
            (((region.y + region.h).clamp(0.0, 1.0) * h).ceil() as usize).clamp(y0 + 1, img.height);
        let (rw, rh) = (x1 - x0, y1 - y0);
        let step = ((rw * rh) as f64 / MAX_SAMPLES as f64)
            .sqrt()
            .ceil()
            .max(1.0) as usize;
        let (mut sr, mut sg, mut sb, mut sa) = (0.0, 0.0, 0.0, 0.0);
        let mut n = 0.0;
        let mut darkest: Option<(f64, Rgba)> = None;
        let mut lightest: Option<(f64, Rgba)> = None;
        let mut y = y0;
        while y < y1 {
            let mut x = x0;
            while x < x1 {
                let i = (y * img.width + x) * 4;
                let px = &img.rgba[i..i + 4];
                let c = Rgba::new(
                    px[0] as f64 / 255.0,
                    px[1] as f64 / 255.0,
                    px[2] as f64 / 255.0,
                    px[3] as f64 / 255.0,
                );
                sr += c.r * c.a;
                sg += c.g * c.a;
                sb += c.b * c.a;
                sa += c.a;
                n += 1.0;
                if c.a > 0.5 {
                    let l = c.relative_luminance();
                    if darkest.is_none_or(|(d, _)| l < d) {
                        darkest = Some((l, c));
                    }
                    if lightest.is_none_or(|(d, _)| l > d) {
                        lightest = Some((l, c));
                    }
                }
                x += step;
            }
            y += step;
        }
        if n == 0.0 {
            return None;
        }
        let average = if sa > 0.0 {
            Rgba::new(sr / sa, sg / sa, sb / sa, sa / n)
        } else {
            Rgba::TRANSPARENT
        };
        Some(ImageSample {
            average,
            darkest: darkest.map(|d| d.1).unwrap_or(average),
            lightest: lightest.map(|d| d.1).unwrap_or(average),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn samples_halves() {
        // 4x2: left half black, right half white.
        let mut rgba = Vec::new();
        for _y in 0..2 {
            for x in 0..4 {
                let v = if x < 2 { 0 } else { 255 };
                rgba.extend_from_slice(&[v, v, v, 255]);
            }
        }
        let mut s = PixelSampler::new();
        assert!(s.insert("a", 4, 2, rgba));
        let left = s.sample("a", Rect::new(0.0, 0.0, 0.5, 1.0)).unwrap();
        assert!(left.average.r < 0.01 && left.lightest.r < 0.01);
        let all = s.sample("a", Rect::new(0.0, 0.0, 1.0, 1.0)).unwrap();
        assert!((all.average.r - 0.5).abs() < 0.01);
        assert!(all.darkest.r < 0.01 && all.lightest.r > 0.99);
        assert!(s.sample("missing", Rect::new(0.0, 0.0, 1.0, 1.0)).is_none());
        assert!(!s.insert("bad", 3, 3, vec![0; 5]));
    }
}
