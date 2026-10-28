//! Local exports with the shared renderer (desyn-raster): every still format, multi-page PDF / PPTX / GIF, one file
//! per page for raster and SVG, scale, quality, transparent backgrounds, print bleed / crop marks / CMYK / flatten.
//! Runs on a background thread with its own renderer (bundled fonts plus the fonts the session downloaded).

use std::path::{Path, PathBuf};
use std::sync::Arc;

use desyn_core::model::{Design, Id};
use desyn_raster::export::{
    AnimOptions, Background, ExportOptions, Format, PageSelection, PdfOptions, SvgText, export,
    export_pages,
};
use desyn_raster::{MemoryAssetStore, Renderer};
use desyn_text::TextEngine;

use crate::doc::AssetBytes;

/// What to export.
#[derive(Debug, Clone, PartialEq)]
pub struct Settings {
    /// Format.
    pub format: Format,
    /// Pages in output order.
    pub pages: Vec<Id>,
    /// Raster scale.
    pub scale: f64,
    /// JPEG / WebP quality.
    pub quality: u8,
    /// Transparent background (PNG / WebP / SVG).
    pub transparent: bool,
    /// PDF print options.
    pub pdf: PdfOptions,
    /// SVG text as outlines.
    pub svg_outlines: bool,
    /// GIF frames per second.
    pub fps: f64,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            format: Format::Png,
            pages: Vec::new(),
            scale: 2.0,
            quality: 90,
            transparent: false,
            pdf: PdfOptions::default(),
            svg_outlines: false,
            fps: 15.0,
        }
    }
}

/// File extension of a format.
pub fn extension(f: Format) -> &'static str {
    match f {
        Format::Png => "png",
        Format::Jpeg => "jpg",
        Format::Webp => "webp",
        Format::Svg => "svg",
        Format::Pdf => "pdf",
        Format::Pptx => "pptx",
        Format::Gif => "gif",
    }
}

/// Whether the format puts every page in one file.
pub fn single_file(f: Format) -> bool {
    matches!(f, Format::Pdf | Format::Pptx)
}

/// Output file names: `<base>.<ext>` for one file, `<base> - <n>.<ext>` per page otherwise.
pub fn file_names(base: &str, s: &Settings, page_numbers: &[usize]) -> Vec<String> {
    let ext = extension(s.format);
    let stem = crate::paths::sanitize_file_stem(base);
    if single_file(s.format) || page_numbers.len() <= 1 {
        vec![format!("{stem}.{ext}")]
    } else {
        page_numbers
            .iter()
            .map(|n| format!("{stem} - {n}.{ext}"))
            .collect()
    }
}

fn options(s: &Settings, pages: PageSelection) -> ExportOptions {
    let mut o = ExportOptions {
        format: s.format,
        pages,
        scale: s.scale,
        quality: s.quality,
        background: if s.transparent {
            Background::Transparent
        } else {
            Background::Page
        },
        pdf: s.pdf.clone(),
        svg_text: if s.svg_outlines {
            SvgText::Outlines
        } else {
            SvgText::Text { embed_fonts: true }
        },
        anim: AnimOptions {
            fps: s.fps,
            ..Default::default()
        },
        ..Default::default()
    };
    if s.format != Format::Png && s.format != Format::Webp && s.format != Format::Svg {
        o.background = Background::Page;
    }
    o
}

/// A renderer with the bundled fonts, extra font files and the design's asset bytes.
pub fn renderer(assets: &AssetBytes, fonts: &[Arc<Vec<u8>>]) -> Renderer {
    let mut text = TextEngine::with_bundled_fonts();
    for f in fonts {
        let _ = text.add_font(f.as_ref().clone());
    }
    let mut store = MemoryAssetStore::new();
    for (id, b) in assets {
        store.insert(id.clone(), b.clone());
    }
    Renderer::new(text, Box::new(store))
}

/// Exports to bytes: `(file name, bytes)` per output file.
pub fn render(
    design: &Design,
    assets: &AssetBytes,
    fonts: &[Arc<Vec<u8>>],
    base: &str,
    s: &Settings,
) -> Result<Vec<(String, Vec<u8>)>, String> {
    let all = design.page_ids().to_vec();
    let pages: Vec<Id> = if s.pages.is_empty() {
        all.clone()
    } else {
        s.pages
            .iter()
            .filter(|p| all.contains(p))
            .cloned()
            .collect()
    };
    if pages.is_empty() {
        return Err("Choose at least one page.".into());
    }
    let numbers: Vec<usize> = pages
        .iter()
        .filter_map(|p| all.iter().position(|a| a == p).map(|i| i + 1))
        .collect();
    let names = file_names(base, s, &numbers);
    let mut r = renderer(assets, fonts);
    // Multi-file formats render the chosen pages; single-file formats need a design with only those pages.
    if single_file(s.format) {
        let d = if pages.len() == all.len() {
            design.clone()
        } else {
            only_pages(design, &pages)
        };
        let out = export(&mut r, &d, &options(s, PageSelection::All)).map_err(|e| e.to_string())?;
        return Ok(vec![(names[0].clone(), out.bytes)]);
    }
    if pages.len() == 1 {
        let out = export(
            &mut r,
            design,
            &options(s, PageSelection::Id(pages[0].clone())),
        )
        .map_err(|e| e.to_string())?;
        return Ok(vec![(names[0].clone(), out.bytes)]);
    }
    let d = only_pages(design, &pages);
    let outs =
        export_pages(&mut r, &d, &options(s, PageSelection::All)).map_err(|e| e.to_string())?;
    Ok(outs
        .into_iter()
        .zip(names)
        .map(|((_, o), n)| (n, o.bytes))
        .collect())
}

/// A copy of the design with only `pages`, in that order.
pub fn only_pages(design: &Design, pages: &[Id]) -> Design {
    let mut d = design.clone();
    let all = d.page_ids().to_vec();
    for p in all.iter().filter(|p| !pages.contains(p)) {
        for id in d.subtree_ids(p) {
            d.nodes.shift_remove(&id);
        }
    }
    if let Some(root) = d.node_mut(desyn_core::model::ROOT_ID)
        && let Some(ch) = root.children_mut()
    {
        *ch = pages.to_vec();
    }
    d
}

/// Writes outputs into a folder (or the single file path) and returns the written paths.
pub fn write(
    outputs: Vec<(String, Vec<u8>)>,
    dest: &Path,
    single_target: bool,
) -> Result<Vec<PathBuf>, String> {
    let mut written = Vec::new();
    if single_target && outputs.len() == 1 {
        let (_, bytes) = outputs.into_iter().next().expect("one");
        crate::paths::write_atomic(dest, &bytes).map_err(|e| format!("{}: {e}", dest.display()))?;
        written.push(dest.to_path_buf());
        return Ok(written);
    }
    std::fs::create_dir_all(dest).map_err(|e| format!("{}: {e}", dest.display()))?;
    for (name, bytes) in outputs {
        let stem = Path::new(&name)
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| "export".into());
        let ext = Path::new(&name)
            .extension()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default();
        let p = crate::paths::unique_path(dest, &stem, &ext);
        crate::paths::write_atomic(&p, &bytes).map_err(|e| format!("{}: {e}", p.display()))?;
        written.push(p);
    }
    Ok(written)
}

/// Pixel size of a page at a scale ("2160 × 2160 px").
pub fn pixel_size(design: &Design, page: &str, scale: f64) -> Option<(u32, u32)> {
    let n = design.node(page)?;
    let b = n.base();
    Some((
        (b.width * scale).round().max(1.0) as u32,
        (b.height * scale).round().max(1.0) as u32,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use desyn_core::model::{DesignKind, Node};

    fn design() -> Design {
        let mut d = Design::with_page(
            "design000001",
            "Poster",
            DesignKind::Poster,
            "page00000001",
            120.0,
            80.0,
        );
        d.push_child(
            "page00000001",
            Node::rect("rect00000001", "R", 10.0, 10.0, 50.0, 40.0),
        );
        d.push_child("root", Node::page("page00000002", "Two", 120.0, 80.0));
        d
    }

    #[test]
    fn names_and_page_subsets() {
        let s = Settings::default();
        assert_eq!(
            file_names("My / Poster", &s, &[1, 2]),
            vec!["My - Poster - 1.png", "My - Poster - 2.png"]
        );
        let pdf = Settings {
            format: Format::Pdf,
            ..Default::default()
        };
        assert_eq!(file_names("Poster", &pdf, &[1, 2]), vec!["Poster.pdf"]);
        let d = only_pages(&design(), &["page00000002".into()]);
        assert_eq!(d.page_ids(), &["page00000002".to_string()]);
        assert!(d.node("rect00000001").is_none());
        assert_eq!(pixel_size(&design(), "page00000001", 2.0), Some((240, 160)));
    }

    #[test]
    fn renders_every_format() {
        let d = design();
        let assets = AssetBytes::new();
        for f in [
            Format::Png,
            Format::Jpeg,
            Format::Webp,
            Format::Svg,
            Format::Pdf,
            Format::Pptx,
            Format::Gif,
        ] {
            let s = Settings {
                format: f,
                scale: 1.0,
                ..Default::default()
            };
            let out =
                render(&d, &assets, &[], "Poster", &s).unwrap_or_else(|e| panic!("{f:?}: {e}"));
            let expect = if single_file(f) { 1 } else { 2 };
            assert_eq!(out.len(), expect, "{f:?}");
            assert!(out.iter().all(|(_, b)| b.len() > 20), "{f:?}");
        }
        let one = Settings {
            pages: vec!["page00000001".into()],
            transparent: true,
            ..Default::default()
        };
        let out = render(&d, &assets, &[], "Poster", &one).unwrap();
        assert_eq!(out[0].0, "Poster.png");
        assert!(out[0].1.starts_with(&[0x89, b'P', b'N', b'G']));
        let print = Settings {
            format: Format::Pdf,
            pdf: PdfOptions {
                bleed: true,
                crop_marks: true,
                ..Default::default()
            },
            ..Default::default()
        };
        let pdf = render(&d, &assets, &[], "Poster", &print).unwrap();
        assert!(pdf[0].1.starts_with(b"%PDF"));
        let tmp = crate::paths::test_dir::TempDir::new("export");
        let files = write(out, &tmp.0.join("x.png"), true).unwrap();
        assert!(files[0].exists());
    }
}
