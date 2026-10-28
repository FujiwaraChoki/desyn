//! Exporters: PNG / JPEG / WebP (scale, quality, transparency, DPI), SVG (own writer), PDF (krilla), PPTX
//! (hand-written OOXML), animated GIF and RGBA frame sequences (MP4 is encoded by the worker from frames).

pub mod bitmap;
pub mod frames;
#[cfg(feature = "pdf")]
pub mod pdf;
#[cfg(feature = "pptx")]
pub mod pptx;
pub mod svg;
mod xml;

use std::str::FromStr;

use desyn_core::geometry::Rect;
use desyn_core::model::{Design, Id};

use crate::error::RenderError;
use crate::paint::Color4;
use crate::renderer::{PageRenderOptions, Renderer};

/// Output format.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Format {
    /// PNG.
    Png,
    /// JPEG.
    Jpeg,
    /// WebP.
    Webp,
    /// SVG.
    Svg,
    /// PDF.
    Pdf,
    /// PowerPoint.
    Pptx,
    /// Animated GIF.
    Gif,
}

impl Format {
    /// MIME type.
    pub fn mime(self) -> &'static str {
        match self {
            Format::Png => "image/png",
            Format::Jpeg => "image/jpeg",
            Format::Webp => "image/webp",
            Format::Svg => "image/svg+xml",
            Format::Pdf => "application/pdf",
            Format::Pptx => {
                "application/vnd.openxmlformats-officedocument.presentationml.presentation"
            }
            Format::Gif => "image/gif",
        }
    }

    /// File extension.
    pub fn extension(self) -> &'static str {
        match self {
            Format::Png => "png",
            Format::Jpeg => "jpg",
            Format::Webp => "webp",
            Format::Svg => "svg",
            Format::Pdf => "pdf",
            Format::Pptx => "pptx",
            Format::Gif => "gif",
        }
    }

    /// Raster single-page formats.
    pub fn is_raster(self) -> bool {
        matches!(self, Format::Png | Format::Jpeg | Format::Webp)
    }
}

impl FromStr for Format {
    type Err = RenderError;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Ok(match s.trim().to_ascii_lowercase().as_str() {
            "png" => Format::Png,
            "jpg" | "jpeg" => Format::Jpeg,
            "webp" => Format::Webp,
            "svg" => Format::Svg,
            "pdf" => Format::Pdf,
            "pptx" => Format::Pptx,
            "gif" => Format::Gif,
            other => {
                return Err(RenderError::InvalidOptions(format!(
                    "unknown format {other:?}"
                )));
            }
        })
    }
}

/// Which pages to export.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub enum PageSelection {
    /// The first page.
    #[default]
    First,
    /// A page by id.
    Id(Id),
    /// A page by 0-based index.
    Index(usize),
    /// Every page (PDF, PPTX, SVG / raster via [`export_pages`]).
    All,
}

impl PageSelection {
    /// Page ids selected in `design`.
    pub fn resolve(&self, design: &Design) -> Result<Vec<Id>, RenderError> {
        let pages = Renderer::page_ids(design);
        if pages.is_empty() {
            return Err(RenderError::NoPage("design has no pages".into()));
        }
        Ok(match self {
            PageSelection::First => vec![pages[0].clone()],
            PageSelection::All => pages,
            PageSelection::Index(i) => vec![
                pages
                    .get(*i)
                    .cloned()
                    .ok_or_else(|| RenderError::NoPage(format!("index {i}")))?,
            ],
            PageSelection::Id(id) => {
                if !pages.contains(id) {
                    return Err(RenderError::NoPage(id.clone()));
                }
                vec![id.clone()]
            }
        })
    }
}

/// Page background handling.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub enum Background {
    /// The page's own background.
    #[default]
    Page,
    /// No background (PNG / WebP / SVG keep transparency; JPEG and PDF flatten on white).
    Transparent,
    /// Replace the page background with a color.
    Color(Color4),
}

/// PDF options.
#[derive(Debug, Clone, PartialEq)]
pub struct PdfOptions {
    /// Include the page bleed.
    pub bleed: bool,
    /// Draw crop marks (adds a slug area around the bleed).
    pub crop_marks: bool,
    /// Convert colors to DeviceCMYK (naive conversion; images stay RGB).
    pub cmyk: bool,
    /// Flatten each page to one image (no transparency, PDF/X-1a style); text stays searchable as invisible
    /// text is not added, so prefer vector output unless the printer requires flattening.
    pub flatten: bool,
    /// Resolution of flattened pages and rasterized fallbacks (dots per inch).
    pub dpi: f64,
    /// Document title (defaults to the design name).
    pub title: Option<String>,
}

impl Default for PdfOptions {
    fn default() -> Self {
        PdfOptions {
            bleed: false,
            crop_marks: false,
            cmyk: false,
            flatten: false,
            dpi: 300.0,
            title: None,
        }
    }
}

/// How SVG exports write text.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SvgText {
    /// `<text>` elements; `embed_fonts` adds `@font-face` rules with the font files.
    Text {
        /// Embed the font files as data URLs.
        embed_fonts: bool,
    },
    /// Glyph outlines as paths (exact everywhere, not selectable).
    Outlines,
}

/// Animation options (GIF, frames).
#[derive(Debug, Clone, PartialEq)]
pub struct AnimOptions {
    /// Frames per second.
    pub fps: f64,
    /// Duration (default: the page duration).
    pub duration_ms: Option<f64>,
    /// Upper bound of frames (protects workers).
    pub max_frames: usize,
}

impl Default for AnimOptions {
    fn default() -> Self {
        AnimOptions {
            fps: 15.0,
            duration_ms: None,
            max_frames: 1800,
        }
    }
}

/// Export options.
#[derive(Debug, Clone, PartialEq)]
pub struct ExportOptions {
    /// Format.
    pub format: Format,
    /// Pages.
    pub pages: PageSelection,
    /// Device pixels per design px for raster output.
    pub scale: f64,
    /// DPI written into PNG / JPEG metadata (`None` = 96 x scale).
    pub dpi: Option<f64>,
    /// JPEG / WebP quality 1..100.
    pub quality: u8,
    /// Background.
    pub background: Background,
    /// Page-space region (raster / SVG; `None` = whole page).
    pub region: Option<Rect>,
    /// Animation time for still formats.
    pub time_ms: Option<f64>,
    /// PDF options.
    pub pdf: PdfOptions,
    /// SVG text mode.
    pub svg_text: SvgText,
    /// Animation options.
    pub anim: AnimOptions,
    /// Export only these subtrees.
    pub only: Option<Vec<Id>>,
    /// Never export these subtrees.
    pub hidden: Vec<Id>,
}

impl Default for ExportOptions {
    fn default() -> Self {
        ExportOptions {
            format: Format::Png,
            pages: PageSelection::First,
            scale: 1.0,
            dpi: None,
            quality: 90,
            background: Background::Page,
            region: None,
            time_ms: None,
            pdf: PdfOptions::default(),
            svg_text: SvgText::Text { embed_fonts: true },
            anim: AnimOptions::default(),
            only: None,
            hidden: Vec::new(),
        }
    }
}

/// An encoded export.
#[derive(Debug, Clone)]
pub struct ExportOutput {
    /// File bytes.
    pub bytes: Vec<u8>,
    /// MIME type.
    pub mime: &'static str,
    /// File extension.
    pub extension: &'static str,
    /// Pages included.
    pub pages: usize,
    /// Assets that had no bytes.
    pub missing_assets: Vec<String>,
    /// Font families that were not available.
    pub missing_fonts: Vec<String>,
    /// Non-fatal problems.
    pub warnings: Vec<String>,
}

fn validate(opts: &ExportOptions) -> Result<(), RenderError> {
    if !(opts.scale.is_finite() && opts.scale > 0.0 && opts.scale <= 64.0) {
        return Err(RenderError::InvalidOptions(format!(
            "scale {} (0 < scale <= 64)",
            opts.scale
        )));
    }
    if !(opts.anim.fps.is_finite() && opts.anim.fps > 0.0 && opts.anim.fps <= 120.0) {
        return Err(RenderError::InvalidOptions(format!(
            "fps {} (0 < fps <= 120)",
            opts.anim.fps
        )));
    }
    if !(opts.pdf.dpi.is_finite() && opts.pdf.dpi >= 36.0 && opts.pdf.dpi <= 2400.0) {
        return Err(RenderError::InvalidOptions(format!(
            "pdf dpi {}",
            opts.pdf.dpi
        )));
    }
    Ok(())
}

/// Page render options for a raster export of one page.
pub(crate) fn page_render_options(
    opts: &ExportOptions,
    page: &Id,
    bleed: bool,
) -> PageRenderOptions {
    let (transparent, background) = match opts.background {
        Background::Page => (false, None),
        Background::Transparent => (true, None),
        Background::Color(c) => (true, Some(c)),
    };
    PageRenderOptions {
        page: Some(page.clone()),
        scale: opts.scale,
        region: opts.region,
        transparent,
        background,
        time_ms: opts.time_ms,
        bleed,
        only: opts.only.clone(),
        hidden: opts.hidden.clone(),
        show_hidden: false,
    }
}

/// Exports a design.
pub fn export(
    renderer: &mut Renderer,
    design: &Design,
    opts: &ExportOptions,
) -> Result<ExportOutput, RenderError> {
    validate(opts)?;
    let pages = opts.pages.resolve(design)?;
    match opts.format {
        Format::Png | Format::Jpeg | Format::Webp => {
            if pages.len() != 1 {
                return Err(RenderError::InvalidOptions(
                    "raster formats export one page; use export_pages for several".into(),
                ));
            }
            let r = renderer.render_page(design, &page_render_options(opts, &pages[0], false))?;
            let dpi = Some(opts.dpi.unwrap_or(96.0 * opts.scale));
            let bytes = match opts.format {
                Format::Png => bitmap::encode_png(&r.pixmap, dpi)?,
                Format::Jpeg => {
                    let bg = match opts.background {
                        Background::Color(c) => c,
                        _ => Color4::WHITE,
                    };
                    bitmap::encode_jpeg(&r.pixmap, opts.quality, bg, dpi)?
                }
                _ => bitmap::encode_webp(&r.pixmap, opts.quality)?,
            };
            let dl = r.display_list;
            Ok(ExportOutput {
                bytes,
                mime: opts.format.mime(),
                extension: opts.format.extension(),
                pages: 1,
                missing_assets: dl.missing_assets,
                missing_fonts: dl.missing_fonts,
                warnings: dl.warnings,
            })
        }
        Format::Svg => {
            if pages.len() != 1 {
                return Err(RenderError::InvalidOptions("svg exports one page".into()));
            }
            svg::export_svg(renderer, design, &pages[0], opts)
        }
        Format::Pdf => {
            #[cfg(feature = "pdf")]
            {
                pdf::export_pdf(renderer, design, &pages, opts)
            }
            #[cfg(not(feature = "pdf"))]
            {
                Err(RenderError::Unsupported(
                    "pdf export (build with the `pdf` feature)".into(),
                ))
            }
        }
        Format::Pptx => {
            #[cfg(feature = "pptx")]
            {
                pptx::export_pptx(renderer, design, &pages, opts)
            }
            #[cfg(not(feature = "pptx"))]
            {
                Err(RenderError::Unsupported(
                    "pptx export (build with the `pptx` feature)".into(),
                ))
            }
        }
        Format::Gif => {
            if pages.len() != 1 {
                return Err(RenderError::InvalidOptions("gif exports one page".into()));
            }
            #[cfg(feature = "gif")]
            {
                frames::export_gif(renderer, design, &pages[0], opts)
            }
            #[cfg(not(feature = "gif"))]
            {
                Err(RenderError::Unsupported(
                    "gif export (build with the `gif` feature)".into(),
                ))
            }
        }
    }
}

/// Exports every selected page separately (raster / SVG formats); one output per page, in page order.
pub fn export_pages(
    renderer: &mut Renderer,
    design: &Design,
    opts: &ExportOptions,
) -> Result<Vec<(Id, ExportOutput)>, RenderError> {
    let pages = opts.pages.resolve(design)?;
    let mut out = Vec::with_capacity(pages.len());
    for p in pages {
        let o = ExportOptions {
            pages: PageSelection::Id(p.clone()),
            ..opts.clone()
        };
        out.push((p, export(renderer, design, &o)?));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_parse() {
        assert_eq!("JPG".parse::<Format>().unwrap(), Format::Jpeg);
        assert_eq!(Format::Pptx.extension(), "pptx");
        assert!("bmp".parse::<Format>().is_err());
    }
}
