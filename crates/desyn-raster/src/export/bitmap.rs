//! PNG / JPEG / WebP encoding of rendered pixmaps (quality, DPI metadata, transparent or flattened backgrounds).

use std::io::Cursor;

use tiny_skia::Pixmap;

use crate::assets::demultiply;
use crate::error::RenderError;
use crate::paint::Color4;

/// Straight-alpha RGBA8 of a premultiplied pixmap.
pub fn pixmap_rgba(p: &Pixmap) -> Vec<u8> {
    let mut v = p.data().to_vec();
    demultiply(&mut v);
    v
}

/// Opaque RGB8 of a pixmap flattened onto `bg`.
pub fn pixmap_rgb_on(p: &Pixmap, bg: Color4) -> Vec<u8> {
    let [br, bgc, bb, _] = bg.to_rgba8();
    let mut out = Vec::with_capacity((p.width() * p.height() * 3) as usize);
    for px in p.pixels() {
        let a = u32::from(px.alpha());
        let inv = 255 - a;
        out.push(((u32::from(px.red()) * 255 + u32::from(br) * inv + 127) / 255) as u8);
        out.push(((u32::from(px.green()) * 255 + u32::from(bgc) * inv + 127) / 255) as u8);
        out.push(((u32::from(px.blue()) * 255 + u32::from(bb) * inv + 127) / 255) as u8);
    }
    out
}

/// PNG from straight RGBA8, with optional DPI (`pHYs`) and the sRGB chunk.
pub fn encode_png_rgba(
    width: u32,
    height: u32,
    rgba: &[u8],
    dpi: Option<f64>,
) -> Result<Vec<u8>, RenderError> {
    let mut out = Vec::new();
    {
        let mut enc = png::Encoder::new(&mut out, width, height);
        enc.set_color(png::ColorType::Rgba);
        enc.set_depth(png::BitDepth::Eight);
        enc.set_compression(png::Compression::Fast);
        enc.set_source_srgb(png::SrgbRenderingIntent::Perceptual);
        if let Some(d) = dpi.filter(|d| d.is_finite() && *d > 0.0) {
            let ppm = (d / 0.0254).round().clamp(1.0, f64::from(u32::MAX)) as u32;
            enc.set_pixel_dims(Some(png::PixelDimensions {
                xppu: ppm,
                yppu: ppm,
                unit: png::Unit::Meter,
            }));
        }
        let mut w = enc
            .write_header()
            .map_err(|e| RenderError::Encode(e.to_string()))?;
        w.write_image_data(rgba)
            .map_err(|e| RenderError::Encode(e.to_string()))?;
        w.finish().map_err(|e| RenderError::Encode(e.to_string()))?;
    }
    Ok(out)
}

/// PNG of a pixmap.
pub fn encode_png(p: &Pixmap, dpi: Option<f64>) -> Result<Vec<u8>, RenderError> {
    encode_png_rgba(p.width(), p.height(), &pixmap_rgba(p), dpi)
}

/// JPEG (baseline, quality 1..100) of a pixmap flattened onto `bg`, with JFIF density.
pub fn encode_jpeg(
    p: &Pixmap,
    quality: u8,
    bg: Color4,
    dpi: Option<f64>,
) -> Result<Vec<u8>, RenderError> {
    let rgb = pixmap_rgb_on(p, bg);
    let mut out = Vec::new();
    let mut enc = image::codecs::jpeg::JpegEncoder::new_with_quality(
        Cursor::new(&mut out),
        quality.clamp(1, 100),
    );
    if let Some(d) = dpi.filter(|d| d.is_finite() && *d > 0.0) {
        enc.set_pixel_density(image::codecs::jpeg::PixelDensity::dpi(
            d.round().clamp(1.0, 65535.0) as u16,
        ));
    }
    enc.encode(&rgb, p.width(), p.height(), image::ExtendedColorType::Rgb8)
        .map_err(|e| RenderError::Encode(e.to_string()))?;
    Ok(out)
}

/// Largest WebP side.
pub const MAX_WEBP_SIDE: u32 = 16383;

/// WebP of a pixmap. Quality 100 (or builds without the `webp-lossy` feature) encodes losslessly; otherwise lossy
/// through libwebp. Transparent pixels are kept either way.
pub fn encode_webp(p: &Pixmap, quality: u8) -> Result<Vec<u8>, RenderError> {
    if p.width() > MAX_WEBP_SIDE || p.height() > MAX_WEBP_SIDE {
        return Err(RenderError::TooLarge(format!(
            "webp is limited to {MAX_WEBP_SIDE} px per side ({}x{})",
            p.width(),
            p.height()
        )));
    }
    let rgba = pixmap_rgba(p);
    #[cfg(all(feature = "webp-lossy", not(target_arch = "wasm32")))]
    if quality < 100 {
        let enc = webp::Encoder::from_rgba(&rgba, p.width(), p.height());
        let mem = enc
            .encode_simple(false, f32::from(quality.clamp(1, 99)))
            .map_err(|e| RenderError::Encode(format!("{e:?}")))?;
        return Ok(mem.to_vec());
    }
    let _ = quality;
    let mut out = Vec::new();
    image::codecs::webp::WebPEncoder::new_lossless(Cursor::new(&mut out))
        .encode(
            &rgba,
            p.width(),
            p.height(),
            image::ExtendedColorType::Rgba8,
        )
        .map_err(|e| RenderError::Encode(e.to_string()))?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Pixmap {
        let mut p = Pixmap::new(4, 3).unwrap();
        p.fill(tiny_skia::Color::from_rgba8(255, 0, 0, 128));
        p
    }

    #[test]
    fn png_with_dpi_roundtrips() {
        let bytes = encode_png(&sample(), Some(300.0)).unwrap();
        let dec = png::Decoder::new(Cursor::new(&bytes));
        let reader = dec.read_info().unwrap();
        let info = reader.info();
        assert_eq!((info.width, info.height), (4, 3));
        let dims = info.pixel_dims.unwrap();
        assert_eq!(dims.xppu, 11811);
        let img = image::load_from_memory(&bytes).unwrap().to_rgba8();
        let px = img.get_pixel(0, 0).0;
        assert_eq!(px[0], 255);
        assert!((i32::from(px[3]) - 128).abs() <= 1);
    }

    #[test]
    fn jpeg_and_webp() {
        let j = encode_jpeg(&sample(), 90, Color4::WHITE, Some(144.0)).unwrap();
        assert_eq!(&j[..3], &[0xff, 0xd8, 0xff]);
        let img = image::load_from_memory(&j).unwrap().to_rgb8();
        let px = img.get_pixel(1, 1).0;
        assert!(px[0] > 240 && px[1] > 110 && px[1] < 145, "{px:?}");
        let w = encode_webp(&sample(), 100).unwrap();
        assert_eq!(&w[..4], b"RIFF");
        let img = image::load_from_memory(&w).unwrap().to_rgba8();
        assert_eq!(img.get_pixel(0, 0).0[0], 255);
    }
}
