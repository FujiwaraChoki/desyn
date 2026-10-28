//! Decoded raster images: premultiplied pixmaps with lazily built mip levels and a transparent-border copy.

use std::io::Cursor;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};

use tiny_skia::{IntSize, Pixmap};

/// Largest decoded side; larger images are downscaled at decode time (no design needs more pixels).
pub const MAX_IMAGE_SIDE: u32 = 8192;

/// Encoded container format of an image's original bytes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SourceFormat {
    /// PNG.
    Png,
    /// JPEG.
    Jpeg,
    /// GIF (first frame).
    Gif,
    /// WebP.
    Webp,
    /// Anything else (BMP, AVIF, ...); exporters re-encode.
    Other,
}

impl SourceFormat {
    /// Guesses the format from magic bytes.
    pub fn sniff(bytes: &[u8]) -> SourceFormat {
        if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
            SourceFormat::Png
        } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
            SourceFormat::Jpeg
        } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
            SourceFormat::Gif
        } else if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
            SourceFormat::Webp
        } else {
            SourceFormat::Other
        }
    }

    /// MIME type.
    pub fn mime(self) -> &'static str {
        match self {
            SourceFormat::Png => "image/png",
            SourceFormat::Jpeg => "image/jpeg",
            SourceFormat::Gif => "image/gif",
            SourceFormat::Webp => "image/webp",
            SourceFormat::Other => "application/octet-stream",
        }
    }
}

/// Original encoded bytes of an image that was not modified after decoding (exporters embed them as is).
#[derive(Debug, Clone)]
pub struct EncodedImage {
    /// Bytes.
    pub bytes: Arc<[u8]>,
    /// Format.
    pub format: SourceFormat,
}

static NEXT_ID: AtomicU64 = AtomicU64::new(1);

/// A decoded image (premultiplied RGBA8).
pub struct RasterImage {
    id: u64,
    pixmap: Pixmap,
    source: Option<EncodedImage>,
    opaque: bool,
    mips: OnceLock<Vec<Pixmap>>,
    padded: OnceLock<Option<Pixmap>>,
    padded_mips: OnceLock<Vec<Option<Pixmap>>>,
}

impl std::fmt::Debug for RasterImage {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RasterImage")
            .field("id", &self.id)
            .field("width", &self.pixmap.width())
            .field("height", &self.pixmap.height())
            .field("opaque", &self.opaque)
            .finish()
    }
}

impl RasterImage {
    /// Wraps a premultiplied pixmap.
    pub fn new(pixmap: Pixmap, source: Option<EncodedImage>) -> Self {
        let opaque = pixmap.pixels().iter().all(|p| p.alpha() == 255);
        RasterImage {
            id: NEXT_ID.fetch_add(1, Ordering::Relaxed),
            pixmap,
            source,
            opaque,
            mips: OnceLock::new(),
            padded: OnceLock::new(),
            padded_mips: OnceLock::new(),
        }
    }

    /// From straight-alpha RGBA8 pixels.
    pub fn from_rgba8(width: u32, height: u32, mut rgba: Vec<u8>) -> Option<Self> {
        if rgba.len() != (width as usize) * (height as usize) * 4 {
            return None;
        }
        premultiply(&mut rgba);
        let pixmap = Pixmap::from_vec(rgba, IntSize::from_wh(width, height)?)?;
        Some(RasterImage::new(pixmap, None))
    }

    /// Process-unique identity (stable for the lifetime of this decoded image).
    pub fn id(&self) -> u64 {
        self.id
    }

    /// Width in pixels.
    pub fn width(&self) -> u32 {
        self.pixmap.width()
    }

    /// Height in pixels.
    pub fn height(&self) -> u32 {
        self.pixmap.height()
    }

    /// The premultiplied pixels.
    pub fn pixmap(&self) -> &Pixmap {
        &self.pixmap
    }

    /// Original encoded bytes when the pixels are an unmodified decode.
    pub fn source(&self) -> Option<&EncodedImage> {
        self.source.as_ref()
    }

    /// Every pixel is opaque.
    pub fn is_opaque(&self) -> bool {
        self.opaque
    }

    /// Straight-alpha RGBA8 pixels.
    pub fn to_rgba8(&self) -> Vec<u8> {
        let mut v = self.pixmap.data().to_vec();
        demultiply(&mut v);
        v
    }

    /// PNG encoding of the pixels (exporters use it when no original bytes exist).
    pub fn encode_png(&self) -> Vec<u8> {
        crate::export::bitmap::encode_png_rgba(self.width(), self.height(), &self.to_rgba8(), None)
            .unwrap_or_default()
    }

    /// Mip level to sample for a given image-to-device scale: returns the pixmap and the factor its pixel
    /// coordinates are scaled by relative to level 0 (1, 0.5, 0.25, ...).
    pub fn level_for_scale(&self, scale: f64) -> (&Pixmap, f64) {
        if !(scale.is_finite() && scale > 0.0 && scale < 0.5) {
            return (&self.pixmap, 1.0);
        }
        let mips = self.mips.get_or_init(|| build_mips(&self.pixmap));
        let mut factor = 1.0;
        let mut chosen = &self.pixmap;
        for m in mips {
            if scale / (factor * 0.5) > 1.0 {
                break;
            }
            factor *= 0.5;
            chosen = m;
        }
        (chosen, factor)
    }

    /// A copy with a one pixel transparent border (offset by 1): sampled with pad spread it paints nothing
    /// outside the image, which gives "no repeat" patterns without clipping.
    pub fn padded(&self) -> Option<&Pixmap> {
        self.padded.get_or_init(|| pad(&self.pixmap)).as_ref()
    }

    /// [`RasterImage::level_for_scale`] on transparent-bordered copies (pixel `p` of the level sits at
    /// `p + 1` of the returned pixmap).
    pub fn padded_level_for_scale(&self, scale: f64) -> Option<(&Pixmap, f64)> {
        let (_, factor) = self.level_for_scale(scale);
        if factor >= 1.0 {
            return self.padded().map(|p| (p, 1.0));
        }
        let padded = self.padded_mips.get_or_init(|| {
            self.mips
                .get_or_init(|| build_mips(&self.pixmap))
                .iter()
                .map(pad)
                .collect()
        });
        let index = (-factor.log2()).round() as usize;
        padded
            .get(index.checked_sub(1)?)
            .and_then(|p| p.as_ref())
            .map(|p| (p, factor))
    }
}

fn pad(src: &Pixmap) -> Option<Pixmap> {
    let mut p = Pixmap::new(src.width() + 2, src.height() + 2)?;
    p.draw_pixmap(
        1,
        1,
        src.as_ref(),
        &tiny_skia::PixmapPaint::default(),
        tiny_skia::Transform::identity(),
        None,
    );
    Some(p)
}

fn build_mips(base: &Pixmap) -> Vec<Pixmap> {
    let mut out: Vec<Pixmap> = Vec::new();
    let mut cur = base;
    loop {
        let (w, h) = (cur.width(), cur.height());
        if w <= 1 && h <= 1 {
            break;
        }
        let (nw, nh) = (w.div_ceil(2).max(1), h.div_ceil(2).max(1));
        let Some(mut next) = Pixmap::new(nw, nh) else {
            break;
        };
        let src = cur.data();
        let dst = next.data_mut();
        let sw = w as usize;
        for y in 0..nh as usize {
            let y0 = (2 * y).min(h as usize - 1);
            let y1 = (2 * y + 1).min(h as usize - 1);
            for x in 0..nw as usize {
                let x0 = (2 * x).min(sw - 1);
                let x1 = (2 * x + 1).min(sw - 1);
                for c in 0..4 {
                    let s = u32::from(src[(y0 * sw + x0) * 4 + c])
                        + u32::from(src[(y0 * sw + x1) * 4 + c])
                        + u32::from(src[(y1 * sw + x0) * 4 + c])
                        + u32::from(src[(y1 * sw + x1) * 4 + c]);
                    dst[(y * nw as usize + x) * 4 + c] = ((s + 2) / 4) as u8;
                }
            }
        }
        out.push(next);
        cur = out.last().expect("just pushed");
        if out.len() >= 16 {
            break;
        }
    }
    out
}

/// Premultiplies straight RGBA8 in place.
pub fn premultiply(rgba: &mut [u8]) {
    for px in rgba.as_chunks_mut::<4>().0 {
        let a = u32::from(px[3]);
        if a == 255 {
            continue;
        }
        for c in &mut px[..3] {
            *c = ((u32::from(*c) * a + 127) / 255) as u8;
        }
    }
}

/// Converts premultiplied RGBA8 to straight alpha in place.
pub fn demultiply(rgba: &mut [u8]) {
    for px in rgba.as_chunks_mut::<4>().0 {
        let a = u32::from(px[3]);
        if a == 255 {
            continue;
        }
        if a == 0 {
            px[0] = 0;
            px[1] = 0;
            px[2] = 0;
            continue;
        }
        for c in &mut px[..3] {
            *c = ((u32::from(*c) * 255 + a / 2) / a).min(255) as u8;
        }
    }
}

/// Image decoding failure.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DecodeError(pub String);

impl std::fmt::Display for DecodeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "image decode failed: {}", self.0)
    }
}

impl std::error::Error for DecodeError {}

/// Decodes PNG / JPEG / GIF (first frame) / WebP / BMP (and AVIF with the `avif` feature) into a premultiplied
/// image. Bombs are refused (`MAX_IMAGE_SIDE` x 4 per side before downscaling, 1 GiB allocation budget) and
/// oversized images are downscaled to `MAX_IMAGE_SIDE`.
pub fn decode_image(bytes: Arc<[u8]>) -> Result<RasterImage, DecodeError> {
    let format = SourceFormat::sniff(&bytes);
    let mut reader = image::ImageReader::new(Cursor::new(&bytes[..]))
        .with_guessed_format()
        .map_err(|e| DecodeError(e.to_string()))?;
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(MAX_IMAGE_SIDE * 4);
    limits.max_image_height = Some(MAX_IMAGE_SIDE * 4);
    limits.max_alloc = Some(1 << 30);
    reader.limits(limits.clone());
    let err = |e: image::ImageError| DecodeError(e.to_string());
    let mut decoder = reader.into_decoder().map_err(err)?;
    // `into_decoder` does not account for the output buffer the way `decode` does.
    limits
        .reserve(image::ImageDecoder::total_bytes(&decoder))
        .map_err(err)?;
    // Camera photos store their rotation in EXIF; browsers apply it, so the renderer must too.
    let orientation = image::ImageDecoder::orientation(&mut decoder)
        .unwrap_or(image::metadata::Orientation::NoTransforms);
    let mut img = image::DynamicImage::from_decoder(decoder).map_err(err)?;
    let oriented = orientation != image::metadata::Orientation::NoTransforms;
    if oriented {
        img.apply_orientation(orientation);
    }
    let (w, h) = (img.width(), img.height());
    if w == 0 || h == 0 {
        return Err(DecodeError("empty image".into()));
    }
    let resized = w.max(h) > MAX_IMAGE_SIDE;
    let img = if resized {
        img.resize(
            MAX_IMAGE_SIDE,
            MAX_IMAGE_SIDE,
            image::imageops::FilterType::Triangle,
        )
    } else {
        img
    };
    let rgba = img.into_rgba8();
    let (w, h) = (rgba.width(), rgba.height());
    let mut data = rgba.into_raw();
    premultiply(&mut data);
    let pixmap = Pixmap::from_vec(
        data,
        IntSize::from_wh(w, h).ok_or_else(|| DecodeError("bad size".into()))?,
    )
    .ok_or_else(|| DecodeError("bad pixel buffer".into()))?;
    // Pass-through bytes must decode to these exact pixels: viewers of exported PDFs ignore EXIF orientation.
    let source = (!resized && !oriented && format != SourceFormat::Other).then(|| EncodedImage {
        bytes: bytes.clone(),
        format,
    });
    Ok(RasterImage::new(pixmap, source))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn premultiply_roundtrip_and_mips() {
        let mut px = vec![
            200, 100, 50, 128, 10, 20, 30, 255, 0, 0, 0, 0, 255, 255, 255, 255,
        ];
        let orig = px.clone();
        premultiply(&mut px);
        assert_eq!(&px[4..8], &orig[4..8]);
        demultiply(&mut px);
        for (a, b) in px.iter().zip(orig.iter()) {
            assert!((i32::from(*a) - i32::from(*b)).abs() <= 2);
        }
        let img = RasterImage::from_rgba8(2, 2, orig).unwrap();
        let (lvl, f) = img.level_for_scale(0.2);
        assert_eq!((lvl.width(), f), (1, 0.5));
        let (lvl, f) = img.level_for_scale(1.0);
        assert_eq!((lvl.width(), f), (2, 1.0));
        assert_eq!(img.padded().unwrap().width(), 4);
        assert!(!img.is_opaque());
    }

    #[test]
    fn sniff_formats() {
        assert_eq!(
            SourceFormat::sniff(b"\x89PNG\r\n\x1a\n...."),
            SourceFormat::Png
        );
        assert_eq!(
            SourceFormat::sniff(&[0xff, 0xd8, 0xff, 0xe0]),
            SourceFormat::Jpeg
        );
        assert_eq!(
            SourceFormat::sniff(b"RIFF\0\0\0\0WEBPVP8 "),
            SourceFormat::Webp
        );
        assert!(decode_image(Arc::from(&b"not an image"[..])).is_err());
    }
}
