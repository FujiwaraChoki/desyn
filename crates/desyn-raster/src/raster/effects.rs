//! Offscreen layers and effects: drop / inner shadows (spread via dilation / erosion), glow, layer blur,
//! background blur (backdrop blurred inside the layer's shape), noise, layer caching.

use desyn_core::geometry::Affine;
use desyn_core::model::BlendMode;
use tiny_skia::{IntRect, Pixmap, PixmapPaint, Transform};

use super::blur::{Edge, blur_alpha, blur_rgba, morph_alpha};
use super::{Ctx, MAX_OFFSCREEN, Surface, composite, render_content};
use crate::display::{Layer, LayerEffect};
use crate::geom::{self, intersect, outset_int, round_out};
use crate::paint::Color4;

/// Device sigma of a CSS-like blur radius.
fn sigma(radius: f64, scale: f64) -> f64 {
    (radius.max(0.0) / 2.0 * scale).min(2000.0)
}

/// Pixels outside a region that influence it through an effect.
fn reach(e: &LayerEffect, s: f64) -> i32 {
    let v = match *e {
        LayerEffect::DropShadow {
            dx,
            dy,
            blur,
            spread,
            ..
        } => 3.0 * sigma(blur, s) + spread.abs() * s + dx.abs().max(dy.abs()) * s,
        LayerEffect::InnerShadow {
            dx,
            dy,
            blur,
            spread,
            ..
        } => 3.0 * sigma(blur, s) + spread.abs() * s + dx.abs().max(dy.abs()) * s,
        LayerEffect::LayerBlur { radius } | LayerEffect::BackgroundBlur { radius } => {
            3.0 * sigma(radius, s)
        }
        LayerEffect::Glow { radius, .. } => 3.0 * sigma(radius, s),
        LayerEffect::Noise { .. } => 0.0,
    };
    (v.ceil() as i32).clamp(0, 4096) + 1
}

fn alpha_of(p: &Pixmap) -> Vec<u8> {
    p.pixels().iter().map(|px| px.alpha()).collect()
}

fn rect(x: i32, y: i32, w: i64, h: i64) -> Option<IntRect> {
    if w <= 0 || h <= 0 || w > i64::from(MAX_OFFSCREEN) || h > i64::from(MAX_OFFSCREEN) {
        return None;
    }
    IntRect::from_xywh(x, y, w as u32, h as u32)
}

/// Colors an alpha buffer into a premultiplied pixmap.
fn colorize(alpha: &[u8], w: u32, h: u32, color: Color4, gain: f32) -> Option<Pixmap> {
    let mut p = Pixmap::new(w, h)?;
    let [r, g, b, _] = color.to_rgba8();
    let ca = color.a * gain;
    for (px, a) in p.data_mut().as_chunks_mut::<4>().0.iter_mut().zip(alpha) {
        let a = (f32::from(*a) * ca).clamp(0.0, 255.0) / 255.0;
        if a <= 0.0 {
            continue;
        }
        px[0] = (f32::from(r) * a + 0.5) as u8;
        px[1] = (f32::from(g) * a + 0.5) as u8;
        px[2] = (f32::from(b) * a + 0.5) as u8;
        px[3] = (a * 255.0 + 0.5) as u8;
    }
    Some(p)
}

/// Outer shadow of `content` (device rect `crect`).
#[allow(clippy::too_many_arguments)]
fn outer_shadow(
    content: &Pixmap,
    crect: &IntRect,
    dx: f64,
    dy: f64,
    sig: f64,
    spread: f64,
    color: Color4,
    gain: f32,
) -> Option<(Pixmap, IntRect)> {
    let pad = (3.0 * sig + spread.max(0.0)).ceil() as i32 + 1;
    let (ox, oy) = (dx.round() as i32, dy.round() as i32);
    let srect = rect(
        crect.x() + ox - pad,
        crect.y() + oy - pad,
        i64::from(crect.width()) + 2 * i64::from(pad),
        i64::from(crect.height()) + 2 * i64::from(pad),
    )?;
    let (w, h) = (srect.width() as usize, srect.height() as usize);
    let mut buf = vec![0u8; w * h];
    let src = alpha_of(content);
    let cw = crect.width() as usize;
    for y in 0..crect.height() as usize {
        let d0 = (y + pad as usize) * w + pad as usize;
        buf[d0..d0 + cw].copy_from_slice(&src[y * cw..(y + 1) * cw]);
    }
    morph_alpha(&mut buf, w, h, spread.round() as i32);
    blur_alpha(&mut buf, w, h, sig);
    let p = colorize(&buf, w as u32, h as u32, color, gain)?;
    Some((p, srect))
}

/// Inner shadow drawn inside `content` (same rect).
fn inner_shadow(
    content: &Pixmap,
    dx: f64,
    dy: f64,
    sig: f64,
    spread: f64,
    color: Color4,
) -> Option<Pixmap> {
    let (cw, ch) = (content.width() as usize, content.height() as usize);
    let pad = (3.0 * sig + spread.abs() + dx.abs().max(dy.abs())).ceil() as usize + 1;
    let (w, h) = (cw + 2 * pad, ch + 2 * pad);
    if w > MAX_OFFSCREEN as usize || h > MAX_OFFSCREEN as usize {
        return None;
    }
    let src = alpha_of(content);
    let (ox, oy) = (dx.round() as i64, dy.round() as i64);
    // Inverted alpha shifted by the offset; everything outside the content counts as "outside the shape".
    let mut inv = vec![255u8; w * h];
    for y in 0..ch {
        for x in 0..cw {
            let tx = x as i64 + pad as i64 + ox;
            let ty = y as i64 + pad as i64 + oy;
            if tx >= 0 && ty >= 0 && (tx as usize) < w && (ty as usize) < h {
                inv[ty as usize * w + tx as usize] = 255 - src[y * cw + x];
            }
        }
    }
    morph_alpha(&mut inv, w, h, spread.round() as i32);
    blur_alpha(&mut inv, w, h, sig);
    let mut out = vec![0u8; cw * ch];
    for y in 0..ch {
        for x in 0..cw {
            let a = u32::from(inv[(y + pad) * w + x + pad]) * u32::from(src[y * cw + x]) / 255;
            out[y * cw + x] = a as u8;
        }
    }
    colorize(&out, cw as u32, ch as u32, color, 1.0)
}

fn noise_hash(x: i64, y: i64, seed: u64, ch: u64) -> u8 {
    let mut z = (x as u64).wrapping_mul(0x9e37_79b9_7f4a_7c15)
        ^ (y as u64).wrapping_mul(0xc2b2_ae3d_27d4_eb4f)
        ^ seed
        ^ ch.wrapping_mul(0x1656_67b1_9e37_79f9);
    z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
    (z >> 56) as u8
}

/// Grain overlay masked by the content's alpha (device-anchored so panning keeps the grain stable).
#[allow(clippy::too_many_arguments)]
fn noise(
    result: &mut Pixmap,
    rrect: &IntRect,
    content: &Pixmap,
    crect: &IntRect,
    amount: f64,
    scale_px: f64,
    mono: bool,
    seed: u64,
) {
    let (w, h) = (rrect.width(), rrect.height());
    let Some(mut n) = Pixmap::new(w, h) else {
        return;
    };
    let cell = scale_px.max(0.5);
    let calpha = alpha_of(content);
    let cw = crect.width() as i64;
    let a_gain = (amount * 0.7).clamp(0.0, 1.0) as f32;
    {
        let data = n.data_mut();
        for y in 0..h as i64 {
            let dy = y + i64::from(rrect.y());
            let cy = dy - i64::from(crect.y());
            if cy < 0 || cy >= i64::from(crect.height()) {
                continue;
            }
            for x in 0..w as i64 {
                let dx = x + i64::from(rrect.x());
                let cx = dx - i64::from(crect.x());
                if cx < 0 || cx >= cw {
                    continue;
                }
                let ca = f32::from(calpha[(cy * cw + cx) as usize]) / 255.0;
                if ca <= 0.0 {
                    continue;
                }
                let gx = (dx as f64 / cell).floor() as i64;
                let gy = (dy as f64 / cell).floor() as i64;
                let a = ca * a_gain;
                let v0 = noise_hash(gx, gy, seed, 0);
                let (r, g, b) = if mono {
                    (v0, v0, v0)
                } else {
                    (v0, noise_hash(gx, gy, seed, 1), noise_hash(gx, gy, seed, 2))
                };
                let i = ((y * i64::from(w) + x) * 4) as usize;
                data[i] = (f32::from(r) * a) as u8;
                data[i + 1] = (f32::from(g) * a) as u8;
                data[i + 2] = (f32::from(b) * a) as u8;
                data[i + 3] = (a * 255.0) as u8;
            }
        }
    }
    super::draw_pixmap_blend(
        &mut result.as_mut(),
        0,
        0,
        &n,
        1.0,
        tiny_skia::BlendMode::Overlay,
        None,
    );
}

/// Places `b` (rect `br`) under / over `a` (rect `ar`) in a pixmap covering both.
fn merge(
    a: &Pixmap,
    ar: &IntRect,
    b: &Pixmap,
    br: &IntRect,
    b_below: bool,
) -> Option<(Pixmap, IntRect)> {
    let u = geom::union_int(ar, br);
    if u.width() > MAX_OFFSCREEN || u.height() > MAX_OFFSCREEN {
        return None;
    }
    let mut p = Pixmap::new(u.width(), u.height())?;
    let paint = PixmapPaint::default();
    let (first, fr, second, sr) = if b_below {
        (b, br, a, ar)
    } else {
        (a, ar, b, br)
    };
    p.draw_pixmap(
        fr.x() - u.x(),
        fr.y() - u.y(),
        first.as_ref(),
        &paint,
        Transform::identity(),
        None,
    );
    p.draw_pixmap(
        sr.x() - u.x(),
        sr.y() - u.y(),
        second.as_ref(),
        &paint,
        Transform::identity(),
        None,
    );
    Some((p, u))
}

/// Blurs the surface pixels under the layer's shape and draws them back (before the layer itself).
fn background_blur(
    surf: &mut Surface<'_, '_>,
    content: &Pixmap,
    crect: &IntRect,
    sig: f64,
    alpha: f32,
) {
    let srect = surf.rect();
    let Some(target) = intersect(crect, &srect) else {
        return;
    };
    let pad = (3.0 * sig).ceil() as i32 + 1;
    let Some(read) = intersect(&outset_int(&target, pad), &srect) else {
        return;
    };
    let local = IntRect::from_xywh(
        read.x() - srect.x(),
        read.y() - srect.y(),
        read.width(),
        read.height(),
    );
    let Some(mut back) = local.and_then(|l| surf.pix.as_ref().clone_rect(l)) else {
        return;
    };
    let (bw, bh) = (back.width() as usize, back.height() as usize);
    blur_rgba(back.data_mut(), bw, bh, sig, sig, Edge::Clamp);
    // Inside the shape the blurred backdrop *replaces* the sharp one (dst = lerp(dst, blurred, coverage)).
    // Drawing it source-over would let a translucent backdrop (e.g. an offscreen group without the page
    // background) show through unblurred.
    let calpha = alpha_of(content);
    let cw = crect.width() as i32;
    let k = alpha.clamp(0.0, 1.0);
    let sw = surf.pix.width() as usize;
    let (ox, oy) = (srect.x(), srect.y());
    let bdata = back.data();
    let ddata = surf.pix.data_mut();
    for y in 0..read.height() as i32 {
        let cy = y + read.y() - crect.y();
        if cy < 0 || cy >= crect.height() as i32 {
            continue;
        }
        for x in 0..read.width() as i32 {
            let cx = x + read.x() - crect.x();
            if cx < 0 || cx >= cw {
                continue;
            }
            let m = f32::from(calpha[(cy * cw + cx) as usize]) / 255.0 * k;
            if m <= 0.0 {
                continue;
            }
            let bi = (y as usize * bw + x as usize) * 4;
            let di = ((read.y() - oy + y) as usize * sw + (read.x() - ox + x) as usize) * 4;
            for c in 0..4 {
                let d = f32::from(ddata[di + c]);
                let b = f32::from(bdata[bi + c]);
                ddata[di + c] = (d + (b - d) * m).round().clamp(0.0, 255.0) as u8;
            }
        }
    }
}

/// Renders a layer through an offscreen (clip, mask, effects, group opacity / blend) and composites it.
#[allow(clippy::too_many_arguments)]
pub(super) fn draw_offscreen(
    ctx: &mut Ctx<'_>,
    surf: &mut Surface<'_, '_>,
    layer: &Layer,
    m: &Affine,
    visible: &IntRect,
    alpha: f32,
    blend: BlendMode,
) {
    let s = geom::mean_scale(m);
    let has_backdrop = layer
        .effects
        .iter()
        .any(|e| matches!(e, LayerEffect::BackgroundBlur { .. }));
    let total_reach: i32 = layer.effects.iter().map(|e| reach(e, s)).sum();
    let Some(content_dev) = round_out(&m.transform_rect_bbox(&layer.content_bounds).inflate(1.0))
    else {
        return;
    };
    let cacheable =
        ctx.cache.is_some() && !has_backdrop && (!layer.effects.is_empty() || layer.mask.is_some());
    if cacheable
        && let Some(cache) = ctx.cache.as_deref_mut()
        && let Some((pix, r)) = cache.get(layer.key, m)
    {
        composite(surf, &pix, &r, alpha, blend);
        return;
    }
    let whole = cacheable
        && u64::from(content_dev.width()) * u64::from(content_dev.height()) <= 4096 * 4096;
    let need = if whole {
        Some(content_dev)
    } else {
        intersect(&outset_int(visible, total_reach), &content_dev)
    };
    let Some(need) = need else { return };
    let Some((content, crect)) = render_content(ctx, layer, m, &need) else {
        return;
    };
    let mut result = content.clone();
    let mut rrect = crect;
    // Silhouette passes only need coverage: no effects.
    let effects: &[LayerEffect] = if ctx.silhouette { &[] } else { &layer.effects };
    for e in effects {
        match *e {
            LayerEffect::BackgroundBlur { radius } => {
                // The blur fills the layer's shape whatever the opacity of its paints.
                let prev = ctx.silhouette;
                ctx.silhouette = true;
                let shape = render_content(ctx, layer, m, &crect);
                ctx.silhouette = prev;
                if let Some((shape, srect)) = shape {
                    background_blur(surf, &shape, &srect, sigma(radius, s), alpha);
                }
            }
            LayerEffect::DropShadow {
                dx,
                dy,
                blur,
                spread,
                color,
            } => {
                if let Some((sh, sr)) = outer_shadow(
                    &content,
                    &crect,
                    dx * s,
                    dy * s,
                    sigma(blur, s),
                    spread * s,
                    color,
                    1.0,
                ) && let Some((p, r)) = merge(&result, &rrect, &sh, &sr, true)
                {
                    result = p;
                    rrect = r;
                }
            }
            LayerEffect::Glow {
                radius,
                strength,
                color,
            } => {
                let gain = (0.6 + 1.6 * strength as f32).min(2.2);
                if let Some((sh, sr)) = outer_shadow(
                    &content,
                    &crect,
                    0.0,
                    0.0,
                    sigma(radius, s),
                    0.0,
                    color,
                    gain,
                ) && let Some((p, r)) = merge(&result, &rrect, &sh, &sr, true)
                {
                    result = p;
                    rrect = r;
                }
            }
            LayerEffect::InnerShadow {
                dx,
                dy,
                blur,
                spread,
                color,
            } => {
                if let Some(sh) =
                    inner_shadow(&content, dx * s, dy * s, sigma(blur, s), spread * s, color)
                {
                    result.draw_pixmap(
                        crect.x() - rrect.x(),
                        crect.y() - rrect.y(),
                        sh.as_ref(),
                        &PixmapPaint::default(),
                        Transform::identity(),
                        None,
                    );
                }
            }
            LayerEffect::LayerBlur { radius } => {
                let sig = sigma(radius, s);
                let pad = (3.0 * sig).ceil() as i32 + 1;
                let grown = outset_int(&rrect, pad);
                if grown.width() <= MAX_OFFSCREEN
                    && grown.height() <= MAX_OFFSCREEN
                    && let Some(mut p) = Pixmap::new(grown.width(), grown.height())
                {
                    p.draw_pixmap(
                        pad,
                        pad,
                        result.as_ref(),
                        &PixmapPaint::default(),
                        Transform::identity(),
                        None,
                    );
                    let (w, h) = (p.width() as usize, p.height() as usize);
                    blur_rgba(p.data_mut(), w, h, sig, sig, Edge::Transparent);
                    result = p;
                    rrect = grown;
                }
            }
            LayerEffect::Noise {
                amount,
                scale,
                mono,
                seed,
            } => noise(
                &mut result,
                &rrect,
                &content,
                &crect,
                amount,
                scale * s,
                mono,
                seed,
            ),
        }
    }
    if cacheable
        && whole
        && let Some(cache) = ctx.cache.as_deref_mut()
    {
        cache.put(layer.key, m, result.clone(), rrect);
    }
    composite(surf, &result, &rrect, alpha, blend);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shadow_extends_and_offsets() {
        let mut c = Pixmap::new(10, 10).unwrap();
        c.fill(tiny_skia::Color::BLACK);
        let crect = IntRect::from_xywh(100, 100, 10, 10).unwrap();
        let (p, r) = outer_shadow(&c, &crect, 5.0, 5.0, 2.0, 0.0, Color4::BLACK, 1.0).unwrap();
        assert!(r.x() > 90 && r.right() > 115);
        let center = p
            .pixel((105 - r.x()) as u32 + 5, (105 - r.y()) as u32 + 5)
            .unwrap();
        assert!(center.alpha() > 200);
        let inner = inner_shadow(&c, 2.0, 2.0, 1.0, 0.0, Color4::BLACK).unwrap();
        assert!(inner.pixel(0, 0).unwrap().alpha() > inner.pixel(9, 9).unwrap().alpha());
    }
}
