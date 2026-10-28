//! Separable image resampling on premultiplied pixels with the Mitchell-Netravali filter (B = C = 1/3, the
//! kernel tiny-skia's bicubic sampling uses), widened when shrinking so downscales are antialiased. Results
//! match direct bicubic drawing closely, so frames drawn from a cached resample and frames drawn directly look
//! the same.

use tiny_skia::Pixmap;

/// How pixels beyond the source edges are treated.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ResampleEdge {
    /// Repeat the edge pixels (pictures that cover their shape).
    Clamp,
    /// Transparent beyond the edges (images that must not paint outside themselves).
    Transparent,
}

fn mitchell(x: f32) -> f32 {
    const B: f32 = 1.0 / 3.0;
    const C: f32 = 1.0 / 3.0;
    let x = x.abs();
    if x < 1.0 {
        ((12.0 - 9.0 * B - 6.0 * C) * x * x * x
            + (-18.0 + 12.0 * B + 6.0 * C) * x * x
            + (6.0 - 2.0 * B))
            / 6.0
    } else if x < 2.0 {
        ((-B - 6.0 * C) * x * x * x
            + (6.0 * B + 30.0 * C) * x * x
            + (-12.0 * B - 48.0 * C) * x
            + (8.0 * B + 24.0 * C))
            / 6.0
    } else {
        0.0
    }
}

/// Filter taps of one axis: for each output position, `(first source index, weights)`; indices are clamped or
/// dropped according to the edge mode.
struct Taps {
    index: Vec<u32>,
    weight: Vec<f32>,
    offsets: Vec<usize>,
}

fn taps(src: usize, dst: usize, edge: ResampleEdge) -> Taps {
    let scale = dst as f32 / src as f32;
    let widen = (1.0 / scale).max(1.0);
    let support = 2.0 * widen;
    let mut t = Taps {
        index: Vec::new(),
        weight: Vec::new(),
        offsets: Vec::with_capacity(dst + 1),
    };
    for d in 0..dst {
        t.offsets.push(t.index.len());
        let center = (d as f32 + 0.5) / scale - 0.5;
        let lo = (center - support).floor() as i64 + 1;
        let hi = (center + support).ceil() as i64 - 1;
        let start = t.index.len();
        let mut total = 0.0;
        for i in lo..=hi {
            let w = mitchell((i as f32 - center) / widen);
            if w == 0.0 {
                continue;
            }
            total += w;
            match edge {
                ResampleEdge::Clamp => {
                    t.index.push(i.clamp(0, src as i64 - 1) as u32);
                    t.weight.push(w);
                }
                ResampleEdge::Transparent => {
                    if i >= 0 && (i as usize) < src {
                        t.index.push(i as u32);
                        t.weight.push(w);
                    }
                }
            }
        }
        if total.abs() > 1e-6 {
            for w in &mut t.weight[start..] {
                *w /= total;
            }
        }
    }
    t.offsets.push(t.index.len());
    t
}

/// True when resampling `sw x sh` to `dw x dh` costs at most about as many filter taps as sampling every output
/// pixel bicubically (16 taps), i.e. for upscales and mild downscales.
pub(crate) fn cheap(sw: u32, sh: u32, dw: u32, dh: u32) -> bool {
    let (sw, sh, dw, dh) = (
        f64::from(sw),
        f64::from(sh),
        f64::from(dw).max(1.0),
        f64::from(dh).max(1.0),
    );
    let horizontal = sh * dw * 4.0 * (sw / dw).max(1.0);
    let vertical = dw * dh * 4.0 * (sh / dh).max(1.0);
    horizontal + vertical <= 12.0 * dw * dh
}

/// `src` resampled to `w x h`; with `padded`, the result gets a one pixel transparent border (`w+2 x h+2`).
pub(crate) fn resample(
    src: &Pixmap,
    w: u32,
    h: u32,
    edge: ResampleEdge,
    padded: bool,
) -> Option<Pixmap> {
    let (sw, sh) = (src.width() as usize, src.height() as usize);
    let (dw, dh) = (w as usize, h as usize);
    if sw == 0 || sh == 0 || dw == 0 || dh == 0 {
        return None;
    }
    let tx = taps(sw, dw, edge);
    let ty = taps(sh, dh, edge);
    let data = src.data();
    // Horizontal pass into f32 rows (one pixel = 4 lanes, so each tap is a single 4-wide multiply-add).
    let mut mid = vec![0f32; dw * sh * 4];
    let mut rowf = vec![[0f32; 4]; sw];
    for y in 0..sh {
        let row = data[y * sw * 4..(y + 1) * sw * 4].as_chunks::<4>().0;
        for (f, p) in rowf.iter_mut().zip(row) {
            *f = [
                f32::from(p[0]),
                f32::from(p[1]),
                f32::from(p[2]),
                f32::from(p[3]),
            ];
        }
        let out = mid[y * dw * 4..(y + 1) * dw * 4].as_chunks_mut::<4>().0;
        for (x, o) in out.iter_mut().enumerate() {
            let (a, b) = (tx.offsets[x], tx.offsets[x + 1]);
            let mut acc = [0f32; 4];
            for (&i, &wgt) in tx.index[a..b].iter().zip(&tx.weight[a..b]) {
                let p = rowf[i as usize];
                for c in 0..4 {
                    acc[c] += p[c] * wgt;
                }
            }
            *o = acc;
        }
    }
    // Vertical pass into the (optionally padded) destination.
    let pad = usize::from(padded);
    let (ow, oh) = (dw + 2 * pad, dh + 2 * pad);
    let mut out = Pixmap::new(ow as u32, oh as u32)?;
    let od = out.data_mut();
    // Whole rows at a time: contiguous multiply-adds the compiler vectorizes.
    let mut acc = vec![0f32; dw * 4];
    for y in 0..dh {
        let (a, b) = (ty.offsets[y], ty.offsets[y + 1]);
        acc.fill(0.0);
        for k in a..b {
            let row = ty.index[k] as usize * dw * 4;
            let wgt = ty.weight[k];
            for (o, v) in acc.iter_mut().zip(&mid[row..row + dw * 4]) {
                *o += v * wgt;
            }
        }
        let dst_row = &mut od[((y + pad) * ow + pad) * 4..((y + pad) * ow + pad + dw) * 4];
        for (px, c) in dst_row
            .as_chunks_mut::<4>()
            .0
            .iter_mut()
            .zip(acc.as_chunks::<4>().0)
        {
            // Round half up by truncation (`f32::round` is a libm call on baseline x86-64). Negative lobes can
            // overshoot: keep valid premultiplied color.
            let alpha = (c[3] + 0.5).clamp(0.0, 255.0) as u8;
            px[0] = ((c[0] + 0.5).max(0.0) as u8).min(alpha);
            px[1] = ((c[1] + 0.5).max(0.0) as u8).min(alpha);
            px[2] = ((c[2] + 0.5).max(0.0) as u8).min(alpha);
            px[3] = alpha;
        }
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sizes_edges_and_validity() {
        let mut p = Pixmap::new(8, 8).unwrap();
        p.fill(tiny_skia::Color::from_rgba8(255, 0, 0, 128));
        let r = resample(&p, 20, 10, ResampleEdge::Clamp, false).unwrap();
        assert_eq!((r.width(), r.height()), (20, 10));
        assert!(r.pixels().iter().all(|px| px.red() <= px.alpha()));
        // Flat input stays flat with clamped edges.
        assert!(
            r.pixels()
                .iter()
                .all(|px| px.alpha() == 128 && px.red() == 128)
        );
        let t = resample(&p, 20, 10, ResampleEdge::Transparent, false).unwrap();
        assert!(
            t.pixel(0, 0).unwrap().alpha() < 128,
            "edges fade with transparent extension"
        );
        let padded = resample(&p, 4, 4, ResampleEdge::Clamp, true).unwrap();
        assert_eq!((padded.width(), padded.height()), (6, 6));
        assert_eq!(padded.pixel(0, 0).unwrap().alpha(), 0);
        assert_eq!(padded.pixel(2, 2).unwrap().alpha(), 128);
    }

    #[test]
    fn first_sight_policy() {
        assert!(cheap(960, 640, 1823, 1080), "upscale");
        assert!(cheap(1000, 1000, 800, 800), "mild downscale");
        assert!(
            !cheap(4000, 3000, 1000, 750),
            "strong downscale waits for a repeat"
        );
    }

    #[test]
    fn kernel_partition_of_unity() {
        for f in [0.0f32, 0.25, 0.5, 0.75] {
            let s: f32 = (-2..=2).map(|i| mitchell(i as f32 - f)).sum();
            assert!((s - 1.0).abs() < 1e-5);
        }
    }
}
