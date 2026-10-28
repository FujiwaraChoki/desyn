//! Gaussian blur approximated by three box blurs (W3C filter effects), dilation / erosion for shadow spread.
//!
//! Box blurs use running sums, so the cost per pixel does not depend on the radius.

/// How pixels beyond the buffer edges are treated.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Edge {
    /// Transparent (shadows, layer blurs: content fades out at the edges).
    Transparent,
    /// Repeat the edge pixel (photo blur: no dark fringe).
    Clamp,
}

/// Box sizes (odd widths) for `n` passes approximating a gaussian with `sigma`.
fn box_sizes(sigma: f64, n: usize) -> Vec<usize> {
    let w_ideal = (12.0 * sigma * sigma / n as f64 + 1.0).sqrt();
    let mut wl = w_ideal.floor() as i64;
    if wl % 2 == 0 {
        wl -= 1;
    }
    let wl = wl.max(1);
    let wu = wl + 2;
    let m_ideal = (12.0 * sigma * sigma
        - (n as f64) * (wl * wl) as f64
        - 4.0 * n as f64 * wl as f64
        - 3.0 * n as f64)
        / (-4.0 * wl as f64 - 4.0);
    let m = m_ideal.round().max(0.0) as usize;
    (0..n)
        .map(|i| if i < m { wl as usize } else { wu as usize })
        .collect()
}

/// One box pass over `len` samples with `ch` interleaved channels and the given stride between samples.
#[allow(clippy::too_many_arguments)]
fn box_pass(
    src: &[u8],
    dst: &mut [u8],
    len: usize,
    ch: usize,
    radius: usize,
    edge: Edge,
    acc: &mut [u32],
) {
    let w = 2 * radius + 1;
    let div = w as u32;
    let half = div / 2;
    acc.fill(0);
    let at = |i: isize, c: usize| -> u32 {
        if i < 0 {
            match edge {
                Edge::Transparent => 0,
                Edge::Clamp => u32::from(src[c]),
            }
        } else if i as usize >= len {
            match edge {
                Edge::Transparent => 0,
                Edge::Clamp => u32::from(src[(len - 1) * ch + c]),
            }
        } else {
            u32::from(src[i as usize * ch + c])
        }
    };
    let r = radius as isize;
    for i in -r..=r {
        for (c, a) in acc.iter_mut().enumerate() {
            *a += at(i, c);
        }
    }
    for (x, out) in dst.chunks_mut(ch).take(len).enumerate() {
        for (o, a) in out.iter_mut().zip(acc.iter()) {
            *o = ((a + half) / div).min(255) as u8;
        }
        let add = x as isize + r + 1;
        let sub = x as isize - r;
        for (c, a) in acc.iter_mut().enumerate() {
            *a = *a + at(add, c) - at(sub, c);
        }
    }
}

fn blur_lines(
    data: &mut [u8],
    width: usize,
    height: usize,
    ch: usize,
    sigma_x: f64,
    sigma_y: f64,
    edge: Edge,
) {
    let mut acc = vec![0u32; ch];
    if sigma_x > 0.05 {
        let sizes = box_sizes(sigma_x, 3);
        let mut a = vec![0u8; width * ch];
        let mut b = vec![0u8; width * ch];
        for y in 0..height {
            let row = &mut data[y * width * ch..(y + 1) * width * ch];
            a.copy_from_slice(row);
            for (k, s) in sizes.iter().enumerate() {
                if k % 2 == 0 {
                    box_pass(&a, &mut b, width, ch, s / 2, edge, &mut acc);
                } else {
                    box_pass(&b, &mut a, width, ch, s / 2, edge, &mut acc);
                }
            }
            if sizes.len() % 2 == 1 {
                row.copy_from_slice(&b);
            } else {
                row.copy_from_slice(&a);
            }
        }
    }
    if sigma_y > 0.05 {
        let sizes = box_sizes(sigma_y, 3);
        let mut a = vec![0u8; height * ch];
        let mut b = vec![0u8; height * ch];
        for x in 0..width {
            for y in 0..height {
                let s = (y * width + x) * ch;
                a[y * ch..y * ch + ch].copy_from_slice(&data[s..s + ch]);
            }
            for (k, s) in sizes.iter().enumerate() {
                if k % 2 == 0 {
                    box_pass(&a, &mut b, height, ch, s / 2, edge, &mut acc);
                } else {
                    box_pass(&b, &mut a, height, ch, s / 2, edge, &mut acc);
                }
            }
            let out = if sizes.len() % 2 == 1 { &b } else { &a };
            for y in 0..height {
                let s = (y * width + x) * ch;
                data[s..s + ch].copy_from_slice(&out[y * ch..y * ch + ch]);
            }
        }
    }
}

/// Blurs premultiplied RGBA8 in place.
pub fn blur_rgba(
    data: &mut [u8],
    width: usize,
    height: usize,
    sigma_x: f64,
    sigma_y: f64,
    edge: Edge,
) {
    if width == 0 || height == 0 || data.len() < width * height * 4 {
        return;
    }
    blur_lines(data, width, height, 4, sigma_x, sigma_y, edge);
}

/// Blurs an 8-bit coverage / alpha buffer in place.
pub fn blur_alpha(data: &mut [u8], width: usize, height: usize, sigma: f64) {
    if width == 0 || height == 0 || data.len() < width * height {
        return;
    }
    blur_lines(data, width, height, 1, sigma, sigma, Edge::Transparent);
}

/// Grows (`radius > 0`, max filter) or shrinks (`radius < 0`, min filter) an alpha buffer by a square of
/// `|radius|` pixels.
pub fn morph_alpha(data: &mut [u8], width: usize, height: usize, radius: i32) {
    if radius == 0 || width == 0 || height == 0 {
        return;
    }
    let grow = radius > 0;
    let r = radius.unsigned_abs() as usize;
    let pick = |a: u8, b: u8| if grow { a.max(b) } else { a.min(b) };
    let outside: u8 = 0;
    let mut line = vec![0u8; width.max(height)];
    // Horizontal pass, then vertical pass (separable square structuring element).
    for y in 0..height {
        let row = &mut data[y * width..(y + 1) * width];
        line[..width].copy_from_slice(row);
        for (x, out) in row.iter_mut().enumerate() {
            let lo = x.saturating_sub(r);
            let hi = (x + r).min(width - 1);
            let mut v = if grow { 0 } else { 255 };
            if !grow && (x < r || x + r >= width) {
                v = outside;
            }
            for item in line.iter().take(hi + 1).skip(lo) {
                v = pick(v, *item);
            }
            *out = v;
        }
    }
    for x in 0..width {
        for y in 0..height {
            line[y] = data[y * width + x];
        }
        for y in 0..height {
            let lo = y.saturating_sub(r);
            let hi = (y + r).min(height - 1);
            let mut v = if grow { 0 } else { 255 };
            if !grow && (y < r || y + r >= height) {
                v = outside;
            }
            for item in line.iter().take(hi + 1).skip(lo) {
                v = pick(v, *item);
            }
            data[y * width + x] = v;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn box_sizes_match_variance() {
        for sigma in [0.5, 1.0, 3.0, 10.0, 40.0] {
            let sizes = box_sizes(sigma, 3);
            let var: f64 = sizes.iter().map(|w| ((w * w) as f64 - 1.0) / 12.0).sum();
            assert!(
                (var.sqrt() - sigma).abs() < 0.6,
                "sigma {sigma} -> {}",
                var.sqrt()
            );
        }
    }

    #[test]
    fn blur_preserves_mass_and_spreads() {
        let (w, h) = (41, 41);
        let mut a = vec![0u8; w * h];
        a[20 * w + 20] = 255;
        a[20 * w + 21] = 255;
        a[21 * w + 20] = 255;
        a[21 * w + 21] = 255;
        blur_alpha(&mut a, w, h, 3.0);
        let sum: u32 = a.iter().map(|v| u32::from(*v)).sum();
        assert!((sum as i64 - 1020).abs() < 120, "mass {sum}");
        assert!(a[20 * w + 25] > 0);
        assert!(a[20 * w + 20] < 255);
    }

    #[test]
    fn clamp_edges_keep_flat_images_flat() {
        let (w, h) = (16, 8);
        let mut px = vec![0u8; w * h * 4];
        for p in px.as_chunks_mut::<4>().0 {
            p.copy_from_slice(&[120, 60, 30, 255]);
        }
        blur_rgba(&mut px, w, h, 4.0, 4.0, Edge::Clamp);
        assert!(
            px.as_chunks::<4>()
                .0
                .iter()
                .all(|p| *p == [120, 60, 30, 255])
        );
    }

    #[test]
    fn morph_grows_and_shrinks() {
        let (w, h) = (9, 9);
        let mut a = vec![0u8; w * h];
        a[4 * w + 4] = 255;
        morph_alpha(&mut a, w, h, 2);
        assert_eq!(a.iter().filter(|v| **v == 255).count(), 25);
        morph_alpha(&mut a, w, h, -2);
        assert_eq!(a.iter().filter(|v| **v == 255).count(), 1);
    }
}
