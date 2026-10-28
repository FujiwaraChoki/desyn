//! The viewport frame buffer: one RGBA surface the host copies to its canvas, kept up to date incrementally.
//!
//! * Damage: when the design changes, only the device rectangles whose layers changed are redrawn.
//! * Scrolling: a pan by whole device pixels shifts the existing pixels and draws only the exposed strips.
//! * Progressive rendering: with a time budget, invalid areas are split into tiles drawn nearest to the viewport
//!   center first; the rest stays pending for the next call.
//! * Presentation: with an opaque pasteboard every pixel is opaque, so the premultiplied buffer is already
//!   straight RGBA and the host reads it in place. With a translucent pasteboard a straight-alpha copy is kept
//!   for the redrawn rectangles only.

use desyn_core::geometry::Rect;
use desyn_raster::tiny_skia::{self, BlendMode, IntRect, Paint, Pixmap, Transform};
use desyn_raster::{Color4, Viewport};

/// Tile side for progressive rendering (device px).
pub const TILE: i32 = 512;

/// Largest frame side (device px).
pub const MAX_FRAME_SIDE: u32 = 8192;

/// Damage rectangles kept apart; beyond this a new one is folded into the rectangle it grows least.
const MAX_PENDING: usize = 24;

/// Pixel surface + invalid regions.
#[derive(Default)]
pub struct Frame {
    pixmap: Option<Pixmap>,
    straight: Vec<u8>,
    view: Option<Viewport>,
    pending: Vec<IntRect>,
    /// Tiles a progressive render has not drawn yet. Kept apart from `pending` and never merged: folding them
    /// into bounding boxes would cover tiles that were already drawn, so damage arriving during a progressive
    /// render (a drag) would restart it on every frame and the outer tiles would never be drawn.
    leftover: Vec<IntRect>,
}

/// How the frame changed for a new viewport.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ViewChange {
    /// Same viewport.
    None,
    /// Content moved by whole device pixels (`dx`, `dy`); exposed strips are pending.
    Scrolled(i32, i32),
    /// Everything is invalid (first frame, resize, zoom, fractional pan).
    Full,
}

impl Frame {
    /// Current viewport.
    pub fn view(&self) -> Option<&Viewport> {
        self.view.as_ref()
    }

    /// Frame size in device pixels.
    pub fn size(&self) -> (u32, u32) {
        self.pixmap
            .as_ref()
            .map(|p| (p.width(), p.height()))
            .unwrap_or((0, 0))
    }

    /// Whole-frame rectangle.
    pub fn bounds(&self) -> Option<IntRect> {
        let (w, h) = self.size();
        IntRect::from_xywh(0, 0, w, h)
    }

    /// Pixmap (premultiplied RGBA).
    pub fn pixmap_mut(&mut self) -> Option<&mut Pixmap> {
        self.pixmap.as_mut()
    }

    /// Pixmap.
    pub fn pixmap(&self) -> Option<&Pixmap> {
        self.pixmap.as_ref()
    }

    /// Pending rectangles (damage, then undrawn progressive tiles).
    pub fn pending(&self) -> Vec<IntRect> {
        self.pending.iter().chain(&self.leftover).copied().collect()
    }

    /// Bytes the host copies: straight RGBA (`width * height * 4`).
    pub fn present(&self, straight: bool) -> &[u8] {
        match (&self.pixmap, straight) {
            (Some(_), true) => &self.straight,
            (Some(p), false) => p.data(),
            (None, _) => &[],
        }
    }

    /// Adopts a viewport, reusing pixels where possible.
    pub fn set_view(&mut self, view: Viewport, straight: bool) -> ViewChange {
        let size_ok = self
            .pixmap
            .as_ref()
            .is_some_and(|p| p.width() == view.width && p.height() == view.height);
        if !size_ok {
            self.pixmap = Pixmap::new(view.width, view.height);
            self.view = Some(view);
            self.sync_straight_len(straight);
            self.invalidate_all();
            return ViewChange::Full;
        }
        self.sync_straight_len(straight);
        let Some(old) = self.view.replace(view) else {
            self.invalidate_all();
            return ViewChange::Full;
        };
        if old == view {
            return ViewChange::None;
        }
        if old.zoom != view.zoom || old.device_scale != view.device_scale {
            self.invalidate_all();
            return ViewChange::Full;
        }
        let s = view.scale();
        let fx = (old.x - view.x) * s;
        let fy = (old.y - view.y) * s;
        let (dx, dy) = (fx.round(), fy.round());
        let whole = (fx - dx).abs() < 1e-3 && (fy - dy).abs() < 1e-3;
        let (w, h) = (f64::from(view.width), f64::from(view.height));
        if !whole || dx.abs() >= w || dy.abs() >= h {
            self.invalidate_all();
            return ViewChange::Full;
        }
        let (dx, dy) = (dx as i32, dy as i32);
        if dx == 0 && dy == 0 {
            return ViewChange::None;
        }
        self.scroll(dx, dy, straight);
        ViewChange::Scrolled(dx, dy)
    }

    fn sync_straight_len(&mut self, straight: bool) {
        let want = if straight {
            self.pixmap.as_ref().map(|p| p.data().len()).unwrap_or(0)
        } else {
            0
        };
        if self.straight.len() != want {
            self.straight = vec![0; want];
            if want > 0 {
                self.invalidate_all();
            }
        }
    }

    /// Marks the whole frame invalid.
    pub fn invalidate_all(&mut self) {
        self.pending.clear();
        self.leftover.clear();
        if let Some(b) = self.bounds() {
            self.pending.push(b);
        }
    }

    /// Marks a device rectangle invalid.
    pub fn invalidate(&mut self, r: IntRect) {
        let Some(b) = self.bounds() else {
            return;
        };
        let Some(r) = intersect(&r, &b) else {
            return;
        };
        // Merge with pending rectangles when the union wastes little area (keeps the list short and avoids
        // drawing overlaps twice); L-shaped pairs such as the two strips of a diagonal pan stay separate.
        let mut merged = r;
        let mut i = 0;
        while i < self.pending.len() {
            if touches(&self.pending[i], &merged) && cheap_union(&self.pending[i], &merged) {
                merged = union(&merged, &self.pending.swap_remove(i));
                i = 0;
            } else {
                i += 1;
            }
        }
        if self.pending.len() >= MAX_PENDING {
            // Too many rectangles: fold the new one into the rectangle it grows least. Collapsing everything
            // into one bounding box would re-cover tiles of an in-progress progressive render (often the whole
            // frame), so a drag during a progressive render would restart it on every frame and the outer
            // tiles would never be drawn.
            let growth = |p: &IntRect| area(&union(p, &merged)) - area(p);
            if let Some(best) = (0..self.pending.len())
                .min_by(|&a, &b| growth(&self.pending[a]).total_cmp(&growth(&self.pending[b])))
            {
                let target = self.pending.swap_remove(best);
                let grown = union(&target, &merged);
                self.pending.push(grown);
                return;
            }
        }
        self.pending.push(merged);
    }

    /// Shifts the pixels by `(dx, dy)` and invalidates the exposed strips.
    fn scroll(&mut self, dx: i32, dy: i32, straight: bool) {
        let Some(p) = self.pixmap.as_mut() else {
            return;
        };
        let (w, h) = (p.width() as i32, p.height() as i32);
        shift(p.data_mut(), w, h, dx, dy);
        if straight && self.straight.len() == (w * h * 4) as usize {
            shift(&mut self.straight, w, h, dx, dy);
        }
        // Pending rectangles move with the content.
        let bounds = IntRect::from_xywh(0, 0, w as u32, h as u32);
        let shift_all = |rects: &[IntRect]| -> Vec<IntRect> {
            rects
                .iter()
                .filter_map(|r| IntRect::from_xywh(r.x() + dx, r.y() + dy, r.width(), r.height()))
                .filter_map(|r| bounds.and_then(|b| intersect(&r, &b)))
                .collect()
        };
        self.pending = shift_all(&self.pending);
        self.leftover = shift_all(&self.leftover);
        if dx > 0 {
            self.invalidate_xywh(0, 0, dx, h);
        } else if dx < 0 {
            self.invalidate_xywh(w + dx, 0, -dx, h);
        }
        if dy > 0 {
            self.invalidate_xywh(0, 0, w, dy);
        } else if dy < 0 {
            self.invalidate_xywh(0, h + dy, w, -dy);
        }
    }

    fn invalidate_xywh(&mut self, x: i32, y: i32, w: i32, h: i32) {
        if w > 0
            && h > 0
            && let Some(r) = IntRect::from_xywh(x, y, w as u32, h as u32)
        {
            self.invalidate(r);
        }
    }

    /// Takes the next rectangles to draw. Without tiling everything pending is returned; with tiling, pending
    /// rectangles are cut into tiles ordered by distance to the viewport center and all are returned (the caller
    /// stops when its budget runs out and puts the rest back with [`Frame::restore`]).
    pub fn take_work(&mut self, tiled: bool) -> Vec<IntRect> {
        let mut work = std::mem::take(&mut self.pending);
        work.append(&mut self.leftover);
        if !tiled {
            return work;
        }
        let (w, h) = self.size();
        let (cx, cy) = (w as f64 / 2.0, h as f64 / 2.0);
        let mut tiles: Vec<IntRect> = work.iter().flat_map(|r| split_tiles(r, TILE)).collect();
        tiles.sort_by(|a, b| {
            let da = center_distance(a, cx, cy);
            let db = center_distance(b, cx, cy);
            da.total_cmp(&db)
        });
        tiles
    }

    /// Puts undrawn work back. Tiles are disjoint and stay as they are: merging them into bounding boxes would
    /// cover tiles that were already drawn and make progressive rendering redo work forever.
    pub fn restore(&mut self, rest: Vec<IntRect>) {
        self.leftover.extend(rest);
    }

    /// Copies a redrawn rectangle into the straight-alpha buffer.
    pub fn demultiply_rect(&mut self, r: &IntRect) {
        let Some(p) = self.pixmap.as_ref() else {
            return;
        };
        let w = p.width() as usize;
        if self.straight.len() != p.data().len() {
            return;
        }
        let src = p.data();
        for y in r.y() as usize..(r.y() as usize + r.height() as usize) {
            let start = (y * w + r.x() as usize) * 4;
            let end = start + r.width() as usize * 4;
            let (s, d) = (&src[start..end], &mut self.straight[start..end]);
            for (sp, dp) in s
                .as_chunks::<4>()
                .0
                .iter()
                .zip(d.as_chunks_mut::<4>().0.iter_mut())
            {
                let a = u32::from(sp[3]);
                if a == 255 || a == 0 {
                    dp.copy_from_slice(sp);
                    if a == 0 {
                        dp[..3].fill(0);
                    }
                } else {
                    for k in 0..3 {
                        dp[k] = ((u32::from(sp[k]) * 255 + a / 2) / a).min(255) as u8;
                    }
                    dp[3] = sp[3];
                }
            }
        }
    }
}

/// Shifts an RGBA buffer by whole pixels (content at `(x, y)` moves to `(x + dx, y + dy)`).
fn shift(data: &mut [u8], w: i32, h: i32, dx: i32, dy: i32) {
    let row = (w * 4) as usize;
    let copy_w = (w - dx.abs()).max(0) as usize * 4;
    if copy_w == 0 {
        return;
    }
    let src_x = (-dx).max(0) as usize * 4;
    let dst_x = dx.max(0) as usize * 4;
    let rows: Box<dyn Iterator<Item = i32>> = if dy > 0 {
        Box::new((dy..h).rev())
    } else {
        Box::new(0..(h + dy))
    };
    for y in rows {
        let sy = (y - dy) as usize;
        let src = sy * row + src_x;
        let dst = y as usize * row + dst_x;
        data.copy_within(src..src + copy_w, dst);
    }
}

fn split_tiles(r: &IntRect, t: i32) -> Vec<IntRect> {
    let mut out = Vec::new();
    let mut y = r.y();
    let bottom = r.y() + r.height() as i32;
    let right = r.x() + r.width() as i32;
    while y < bottom {
        let th = t.min(bottom - y);
        let mut x = r.x();
        while x < right {
            let tw = t.min(right - x);
            if let Some(tile) = IntRect::from_xywh(x, y, tw as u32, th as u32) {
                out.push(tile);
            }
            x += tw;
        }
        y += th;
    }
    out
}

fn center_distance(r: &IntRect, cx: f64, cy: f64) -> f64 {
    let x = f64::from(r.x()) + f64::from(r.width()) / 2.0 - cx;
    let y = f64::from(r.y()) + f64::from(r.height()) / 2.0 - cy;
    x * x + y * y
}

/// Intersection of two rectangles.
pub fn intersect(a: &IntRect, b: &IntRect) -> Option<IntRect> {
    let x0 = a.x().max(b.x());
    let y0 = a.y().max(b.y());
    let x1 = (a.x() + a.width() as i32).min(b.x() + b.width() as i32);
    let y1 = (a.y() + a.height() as i32).min(b.y() + b.height() as i32);
    if x1 <= x0 || y1 <= y0 {
        return None;
    }
    IntRect::from_xywh(x0, y0, (x1 - x0) as u32, (y1 - y0) as u32)
}

/// Bounding union of two rectangles.
pub fn union(a: &IntRect, b: &IntRect) -> IntRect {
    let x0 = a.x().min(b.x());
    let y0 = a.y().min(b.y());
    let x1 = (a.x() + a.width() as i32).max(b.x() + b.width() as i32);
    let y1 = (a.y() + a.height() as i32).max(b.y() + b.height() as i32);
    IntRect::from_xywh(x0, y0, (x1 - x0) as u32, (y1 - y0) as u32).unwrap_or(*a)
}

fn area(r: &IntRect) -> f64 {
    f64::from(r.width()) * f64::from(r.height())
}

/// The bounding union costs at most 30% more pixels than the two rectangles.
fn cheap_union(a: &IntRect, b: &IntRect) -> bool {
    area(&union(a, b)) <= (area(a) + area(b)) * 1.3
}

/// Overlapping or edge-adjacent.
fn touches(a: &IntRect, b: &IntRect) -> bool {
    a.x() <= b.x() + b.width() as i32
        && b.x() <= a.x() + a.width() as i32
        && a.y() <= b.y() + b.height() as i32
        && b.y() <= a.y() + a.height() as i32
}

/// One Gaussian-blurred copy of the page rectangle (CSS `box-shadow` without spread), in device px.
#[derive(Debug, Clone, Copy)]
struct ShadowLayer {
    sigma: f64,
    offset_y: f64,
    alpha: f64,
}

/// `erf` (Abramowitz & Stegun 7.1.26, |error| < 1.5e-7).
fn erf(x: f64) -> f64 {
    let t = 1.0 / (1.0 + 0.327_591_1 * x.abs());
    let poly = ((((1.061_405_429 * t - 1.453_152_027) * t + 1.421_413_741) * t - 0.284_496_736)
        * t
        + 0.254_829_592)
        * t;
    let y = 1.0 - poly * (-x * x).exp();
    if x < 0.0 { -y } else { y }
}

/// Coverage of pixels `start..start + n` by the interval `[lo, hi]` blurred with a Gaussian of `sigma` (the
/// separable factor of a blurred rectangle).
fn blurred_span(start: i32, n: usize, lo: f64, hi: f64, sigma: f64) -> Vec<f32> {
    let k = 1.0 / (sigma.max(1e-3) * std::f64::consts::SQRT_2);
    (0..n)
        .map(|i| {
            let c = f64::from(start) + i as f64 + 0.5;
            (0.5 * (erf((c - lo) * k) - erf((c - hi) * k))) as f32
        })
        .collect()
}

/// Shadow layers for a pasteboard: an ambient shadow plus a tight contact shadow, softer on light pasteboards
/// (where a dark-mode strength reads as a grey halo).
fn shadow_layers(dpr: f64, background: Option<Color4>) -> [ShadowLayer; 2] {
    let lum = background.map_or(0.0, |c| {
        f64::from(0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) * f64::from(c.a)
    });
    let lum = lum.clamp(0.0, 1.0);
    [
        ShadowLayer {
            sigma: 18.0 * dpr,
            offset_y: 12.0 * dpr,
            alpha: 0.5 - 0.36 * lum,
        },
        ShadowLayer {
            sigma: 1.5 * dpr,
            offset_y: 1.0 * dpr,
            alpha: 0.32 - 0.2 * lum,
        },
    ]
}

impl Frame {
    /// Paints the pasteboard under what is already in `region`: an optional soft page shadow, then the
    /// background color (both destination-over, so the rendered page stays on top). The shadow is analytic (a
    /// Gaussian-blurred rectangle is separable into two `erf` factors), so it has no banding at any strength.
    pub fn paint_under(
        &mut self,
        region: &IntRect,
        page_device: Option<Rect>,
        dpr: f64,
        background: Option<Color4>,
    ) {
        let Some(clip_rect) = tiny_skia::Rect::from_xywh(
            region.x() as f32,
            region.y() as f32,
            region.width() as f32,
            region.height() as f32,
        ) else {
            return;
        };
        let dpr = dpr.max(0.5);
        let layers = shadow_layers(dpr, background);
        // Three sigmas of the ambient layer plus its offset: beyond that the shadow is below 1/255.
        let reach = 3.0 * layers[0].sigma + layers[0].offset_y;
        let r = Rect::new(
            f64::from(region.x()),
            f64::from(region.y()),
            f64::from(region.width()),
            f64::from(region.height()),
        );
        let shadow = page_device.filter(|p| {
            let outer = Rect::new(
                p.x - reach,
                p.y - reach,
                p.w + 2.0 * reach,
                p.h + 2.0 * reach,
            );
            p.w > 0.0 && p.h > 0.0 && outer.intersects(&r) && !p.contains_rect(&r)
        });
        if let (Some(page), Some(pixmap)) = (shadow, self.pixmap.as_mut()) {
            let (rw, rh) = (region.width() as usize, region.height() as usize);
            let factors: Vec<(Vec<f32>, Vec<f32>, f32)> = layers
                .iter()
                .map(|l| {
                    let fx = blurred_span(region.x(), rw, page.x, page.x + page.w, l.sigma);
                    let fy = blurred_span(
                        region.y(),
                        rh,
                        page.y + l.offset_y,
                        page.y + page.h + l.offset_y,
                        l.sigma,
                    );
                    (fx, fy, l.alpha as f32)
                })
                .collect();
            // Pixels the page covers entirely get no shadow (a translucent page must not darken itself).
            let (ix0, ix1) = (page.x.ceil() as i64, (page.x + page.w).floor() as i64);
            let (iy0, iy1) = (page.y.ceil() as i64, (page.y + page.h).floor() as i64);
            let w = pixmap.width() as usize;
            let data = pixmap.data_mut();
            for j in 0..rh {
                let y = i64::from(region.y()) + j as i64;
                let row_inside = y >= iy0 && y < iy1;
                let row = (y as usize * w + region.x() as usize) * 4;
                for i in 0..rw {
                    let x = i64::from(region.x()) + i as i64;
                    if row_inside && x >= ix0 && x < ix1 {
                        continue;
                    }
                    let mut clear = 1.0f32;
                    for (fx, fy, alpha) in &factors {
                        clear *= 1.0 - alpha * fx[i] * fy[j];
                    }
                    let a = 1.0 - clear;
                    if a < 0.5 / 255.0 {
                        continue;
                    }
                    // Destination-over with premultiplied black: only alpha grows.
                    let px = row + i * 4 + 3;
                    let da = f32::from(data[px]) / 255.0;
                    data[px] = ((da + a * (1.0 - da)) * 255.0).round().min(255.0) as u8;
                }
            }
        }
        if let (Some(bg), Some(pixmap)) = (background, self.pixmap.as_mut()) {
            let mut paint = Paint::default();
            paint.set_color(bg.to_skia());
            paint.blend_mode = BlendMode::DestinationOver;
            pixmap.fill_rect(clip_rect, &paint, Transform::identity(), None);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn view(x: f64, y: f64) -> Viewport {
        Viewport {
            x,
            y,
            zoom: 1.0,
            width: 8,
            height: 6,
            device_scale: 1.0,
        }
    }

    #[test]
    fn shift_moves_pixels() {
        let (w, h) = (4, 3);
        let mut data: Vec<u8> = (0..(w * h)).flat_map(|i| [i as u8, 0, 0, 255]).collect();
        shift(&mut data, w, h, 1, 1);
        // Pixel (0, 0) moved to (1, 1).
        assert_eq!(data[(w + 1) as usize * 4], 0);
        // Pixel (2, 1) (value 6) moved to (3, 2).
        assert_eq!(data[(2 * w + 3) as usize * 4], 6);
        let mut back: Vec<u8> = (0..(w * h)).flat_map(|i| [i as u8, 0, 0, 255]).collect();
        shift(&mut back, w, h, -2, -1);
        // Pixel (2, 1) (value 6) moved to (0, 0).
        assert_eq!(back[0], 6);
    }

    #[test]
    fn pan_by_whole_pixels_scrolls_and_exposes_strips() {
        let mut f = Frame::default();
        assert_eq!(f.set_view(view(0.0, 0.0), false), ViewChange::Full);
        let _ = f.take_work(false);
        assert_eq!(
            f.set_view(view(-2.0, 1.0), false),
            ViewChange::Scrolled(2, -1)
        );
        let pending = f.pending().to_vec();
        let area: u32 = pending.iter().map(|r| r.width() * r.height()).sum();
        // Left strip 2x6 plus bottom strip 8x1, merged into rectangles that cover both.
        assert!(area >= 2 * 6 + 8 - 2);
        assert_eq!(f.set_view(view(-2.5, 1.0), false), ViewChange::Full);
    }

    #[test]
    fn tiles_cover_the_rectangle_center_first() {
        let r = IntRect::from_xywh(0, 0, 1000, 500).unwrap();
        let tiles = split_tiles(&r, TILE);
        let area: u64 = tiles
            .iter()
            .map(|t| u64::from(t.width()) * u64::from(t.height()))
            .sum();
        assert_eq!(area, 500_000);
        let mut f = Frame::default();
        f.set_view(
            Viewport {
                x: 0.0,
                y: 0.0,
                zoom: 1.0,
                width: 1000,
                height: 500,
                device_scale: 1.0,
            },
            false,
        );
        let work = f.take_work(true);
        assert!(work.len() > 1);
        let first = work[0];
        assert!(first.x() <= 500 && first.x() + first.width() as i32 >= 500);
    }

    #[test]
    fn many_invalidations_do_not_collapse_progressive_tiles() {
        let mut f = Frame::default();
        f.set_view(
            Viewport {
                x: 0.0,
                y: 0.0,
                zoom: 1.0,
                width: 4096,
                height: 4096,
                device_scale: 1.0,
            },
            false,
        );
        // A progressive render drew the center tile and put 63 tiles back.
        let mut tiles = f.take_work(true);
        assert_eq!(tiles.len(), 64);
        tiles.remove(0);
        f.restore(tiles);
        // A drag damages a small rectangle every frame.
        for i in 0..40 {
            f.invalidate(IntRect::from_xywh(2000 + i, 2000, 40, 40).unwrap());
        }
        let pending = f.pending();
        let pending_area: f64 = pending.iter().map(area).sum();
        // The 63 undrawn tiles plus the small damage; the drawn center tile is not covered again.
        assert!(
            pending_area < 63.0 * 512.0 * 512.0 + 10_000.0,
            "pending area {pending_area}"
        );
        assert!(pending.len() <= 63 + MAX_PENDING);
        // The next progressive pass draws the damage and the remaining tiles, never the whole frame.
        let work = f.take_work(true);
        let drawn: f64 = work.iter().map(area).sum();
        assert!(drawn < 63.0 * 512.0 * 512.0 + 10_000.0);
    }

    #[test]
    fn page_shadow_is_smooth_and_softer_on_light_pasteboards() {
        let view = Viewport {
            x: 0.0,
            y: 0.0,
            zoom: 1.0,
            width: 200,
            height: 200,
            device_scale: 1.0,
        };
        let page = Some(Rect::new(50.0, 50.0, 100.0, 100.0));
        let region = IntRect::from_xywh(0, 0, 200, 200).unwrap();
        let column_below = || {
            let mut f = Frame::default();
            f.set_view(view, true);
            f.paint_under(&region, page, 1.0, None);
            let p = f.pixmap().unwrap();
            // Alpha of column x = 100 below the page, y = 150..200.
            (150..200)
                .map(|y| p.data()[(y * 200 + 100) * 4 + 3])
                .collect::<Vec<u8>>()
        };
        let col = column_below();
        // Monotonic falloff below the page.
        assert!(col.windows(2).all(|w| w[0] >= w[1]), "{col:?}");
        assert!(col[0] > 60 && *col.last().unwrap() < 20, "{col:?}");
        let mut f = Frame::default();
        f.set_view(view, true);
        f.paint_under(&region, page, 1.0, None);
        let dark = f.pixmap().unwrap().data()[(160 * 200 + 100) * 4 + 3];
        let mut f = Frame::default();
        f.set_view(view, true);
        let light = Color4::parse_hex("#ece8df");
        f.paint_under(&region, page, 1.0, light);
        // Composite over the light pasteboard: the darkening at the same spot must be smaller than on dark.
        let px = &f.pixmap().unwrap().data()[(160 * 200 + 100) * 4..(160 * 200 + 100) * 4 + 4];
        let darkening = 236 - i32::from(px[0]);
        assert!(
            darkening > 3 && darkening < i32::from(dark) / 2,
            "{darkening} vs {dark}"
        );
        // Inside the page only the pasteboard color lands (no shadow under a translucent page).
        assert_eq!(f.pixmap().unwrap().data()[(100 * 200 + 100) * 4], 236);
    }

    #[test]
    fn invalidations_merge() {
        let mut f = Frame::default();
        f.set_view(view(0.0, 0.0), false);
        let _ = f.take_work(false);
        f.invalidate(IntRect::from_xywh(0, 0, 2, 2).unwrap());
        f.invalidate(IntRect::from_xywh(1, 1, 2, 2).unwrap());
        f.invalidate(IntRect::from_xywh(6, 4, 1, 1).unwrap());
        assert_eq!(f.pending().len(), 2);
    }
}
