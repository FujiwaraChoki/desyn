//! `desyn-render`: render / export a design JSON file (plus an asset directory) to PNG, JPEG, WebP, SVG, PDF,
//! PPTX, GIF or a PNG frame sequence. Used by the templates pipeline, tests and operators.

use std::io::Read as _;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use desyn_core::geometry::Rect;
use desyn_core::model::Design;
use desyn_raster::export::{
    self, AnimOptions, Background, ExportOptions, Format, PageSelection, PdfOptions, SvgText,
    frames,
};
use desyn_raster::{Color4, DirAssetStore, NoAssets, RenderError, Renderer};
use desyn_text::TextEngine;

const HELP: &str = "\
desyn-render: render a Desyn design

USAGE:
    desyn-render [OPTIONS] <design.json | ->

OPTIONS:
    -o, --out <path>          Output file (directory for --format frames or multi-page raster exports).
                              Default: <design>.<ext> next to the input, or stdout when the input is stdin.
    -f, --format <fmt>        png | jpeg | webp | svg | pdf | pptx | gif | frames (default: from --out, else png)
    -p, --page <sel>          Page id, 0-based index, or `all` (default: first page)
    -s, --scale <n>           Device pixels per design px (default 1)
        --dpi <n>             DPI metadata for PNG / JPEG (default 96 x scale); resolution of flattened PDFs
    -q, --quality <n>         JPEG / WebP quality 1..100 (default 90)
    -b, --background <bg>     page | transparent | #rrggbb[aa] (default page)
        --assets <dir>        Directory with asset files named by asset id (`<id>` or `<id>.<ext>`)
        --fonts <dir>         Extra font directory (TTF / OTF / WOFF / WOFF2)
        --region <x,y,w,h>    Page-space region (raster / SVG)
        --time <ms>           Animation time for still formats
        --fps <n>             Frames per second (gif, frames; default 15)
        --duration <ms>       Timeline duration (gif, frames; default: page duration)
        --bleed               PDF: include the page bleed
        --crop-marks          PDF: crop marks (implies a slug area)
        --cmyk                PDF: DeviceCMYK colors
        --flatten             PDF: one image per page (no transparency)
        --svg-text <mode>     text (default, fonts embedded) | text-no-embed | outlines
        --only <ids>          Comma-separated node ids to render (with their subtrees)
        --hide <ids>          Comma-separated node ids to leave out
        --info                Print a JSON summary (missing assets / fonts, warnings) to stderr
    -h, --help                Show this help
    -V, --version             Show the version
";

struct Args {
    input: String,
    out: Option<PathBuf>,
    format: Option<String>,
    opts: ExportOptions,
    assets: Option<PathBuf>,
    fonts: Option<PathBuf>,
    info: bool,
}

fn parse_bg(s: &str) -> Result<Background, RenderError> {
    match s {
        "page" => Ok(Background::Page),
        "transparent" | "none" => Ok(Background::Transparent),
        hex => Color4::parse_hex(hex)
            .map(Background::Color)
            .ok_or_else(|| RenderError::InvalidOptions(format!("background {hex:?}"))),
    }
}

fn num(name: &str, v: Option<String>) -> Result<f64, RenderError> {
    let v = v.ok_or_else(|| RenderError::InvalidOptions(format!("{name} needs a value")))?;
    v.parse::<f64>()
        .ok()
        .filter(|x| x.is_finite())
        .ok_or_else(|| RenderError::InvalidOptions(format!("{name}: not a number: {v:?}")))
}

fn parse_args() -> Result<Option<Args>, RenderError> {
    let mut it = std::env::args().skip(1);
    let mut a = Args {
        input: String::new(),
        out: None,
        format: None,
        opts: ExportOptions::default(),
        assets: None,
        fonts: None,
        info: false,
    };
    let mut pdf = PdfOptions::default();
    let mut anim = AnimOptions::default();
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "-h" | "--help" => {
                print!("{HELP}");
                return Ok(None);
            }
            "-V" | "--version" => {
                println!("desyn-render {}", env!("CARGO_PKG_VERSION"));
                return Ok(None);
            }
            "-o" | "--out" => a.out = it.next().map(PathBuf::from),
            "-f" | "--format" => a.format = it.next(),
            "-p" | "--page" => {
                let v = it.next().unwrap_or_default();
                a.opts.pages = if v == "all" {
                    PageSelection::All
                } else if let Ok(i) = v.parse::<usize>() {
                    PageSelection::Index(i)
                } else {
                    PageSelection::Id(v)
                };
            }
            "-s" | "--scale" => a.opts.scale = num("--scale", it.next())?,
            "--dpi" => {
                let d = num("--dpi", it.next())?;
                a.opts.dpi = Some(d);
                pdf.dpi = d;
            }
            "-q" | "--quality" => {
                a.opts.quality = num("--quality", it.next())?.clamp(1.0, 100.0) as u8
            }
            "-b" | "--background" => a.opts.background = parse_bg(&it.next().unwrap_or_default())?,
            "--assets" => a.assets = it.next().map(PathBuf::from),
            "--fonts" => a.fonts = it.next().map(PathBuf::from),
            "--region" => {
                let v = it.next().unwrap_or_default();
                let p: Vec<f64> = v.split(',').filter_map(|x| x.trim().parse().ok()).collect();
                if p.len() != 4 {
                    return Err(RenderError::InvalidOptions(format!(
                        "--region x,y,w,h: {v:?}"
                    )));
                }
                a.opts.region = Some(Rect::new(p[0], p[1], p[2], p[3]));
            }
            "--time" => a.opts.time_ms = Some(num("--time", it.next())?),
            "--fps" => anim.fps = num("--fps", it.next())?,
            "--duration" => anim.duration_ms = Some(num("--duration", it.next())?),
            "--bleed" => pdf.bleed = true,
            "--crop-marks" => pdf.crop_marks = true,
            "--cmyk" => pdf.cmyk = true,
            "--flatten" => pdf.flatten = true,
            "--svg-text" => {
                a.opts.svg_text = match it.next().as_deref() {
                    Some("text") => SvgText::Text { embed_fonts: true },
                    Some("text-no-embed") => SvgText::Text { embed_fonts: false },
                    Some("outlines") => SvgText::Outlines,
                    other => {
                        return Err(RenderError::InvalidOptions(format!("--svg-text {other:?}")));
                    }
                }
            }
            "--only" => {
                a.opts.only = Some(
                    it.next()
                        .unwrap_or_default()
                        .split(',')
                        .map(|s| s.trim().to_string())
                        .collect(),
                )
            }
            "--hide" => {
                a.opts.hidden = it
                    .next()
                    .unwrap_or_default()
                    .split(',')
                    .map(|s| s.trim().to_string())
                    .collect()
            }
            "--info" => a.info = true,
            s if s.starts_with('-') && s != "-" => {
                return Err(RenderError::InvalidOptions(format!("unknown option {s}")));
            }
            s => {
                if !a.input.is_empty() {
                    return Err(RenderError::InvalidOptions("more than one input".into()));
                }
                a.input = s.to_string();
            }
        }
    }
    if a.input.is_empty() {
        return Err(RenderError::InvalidOptions(
            "missing <design.json> (see --help)".into(),
        ));
    }
    a.opts.pdf = pdf;
    a.opts.anim = anim;
    Ok(Some(a))
}

fn read_design(input: &str) -> Result<Design, RenderError> {
    let text = if input == "-" {
        let mut s = String::new();
        std::io::stdin()
            .read_to_string(&mut s)
            .map_err(|e| RenderError::Io(e.to_string()))?;
        s
    } else {
        std::fs::read_to_string(input).map_err(|e| RenderError::Io(format!("{input}: {e}")))?
    };
    // Accept a bare design or a worker request body `{ "design": ... }`.
    let v: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| RenderError::Parse(e.to_string()))?;
    let d = match v.get("design") {
        Some(d) if v.get("nodes").is_none() => d.clone(),
        _ => v,
    };
    serde_json::from_value(d).map_err(|e| RenderError::Parse(e.to_string()))
}

fn write_out(path: Option<&Path>, bytes: &[u8]) -> Result<(), RenderError> {
    match path {
        Some(p) => {
            std::fs::write(p, bytes).map_err(|e| RenderError::Io(format!("{}: {e}", p.display())))
        }
        None => {
            use std::io::Write as _;
            std::io::stdout()
                .write_all(bytes)
                .map_err(|e| RenderError::Io(e.to_string()))
        }
    }
}

fn summary(
    missing_assets: &[String],
    missing_fonts: &[String],
    warnings: &[String],
    extra: serde_json::Value,
) {
    let v = serde_json::json!({
        "missingAssets": missing_assets,
        "missingFonts": missing_fonts,
        "warnings": warnings,
        "output": extra,
    });
    eprintln!("{v}");
}

fn run() -> Result<(), RenderError> {
    let Some(mut a) = parse_args()? else {
        return Ok(());
    };
    let design = read_design(&a.input)?;
    let fmt_name = a
        .format
        .clone()
        .or_else(|| {
            a.out
                .as_ref()
                .and_then(|p| p.extension())
                .map(|e| e.to_string_lossy().to_string())
        })
        .unwrap_or_else(|| "png".into());
    let mut text = TextEngine::with_bundled_fonts();
    if let Some(dir) = &a.fonts {
        text.db_mut().load_dir(dir);
    }
    let store: Box<dyn desyn_raster::AssetStore> = match &a.assets {
        Some(d) => Box::new(DirAssetStore::new(d)),
        None => Box::new(NoAssets),
    };
    let mut renderer = Renderer::new(text, store);
    let default_out = |ext: &str| -> Option<PathBuf> {
        (a.input != "-").then(|| Path::new(&a.input).with_extension(ext))
    };
    if fmt_name == "frames" {
        let dir = a
            .out
            .clone()
            .or_else(|| default_out("frames"))
            .ok_or_else(|| {
                RenderError::InvalidOptions("--out <dir> is required for frames".into())
            })?;
        std::fs::create_dir_all(&dir).map_err(|e| RenderError::Io(e.to_string()))?;
        let pages = a.opts.pages.resolve(&design)?;
        let mut times = Vec::new();
        let seq = frames::render_frames(&mut renderer, &design, &pages, &a.opts, |f| {
            let name = format!("frame-{:05}.png", f.index + 1);
            let bytes = export::bitmap::encode_png(f.pixmap, None)?;
            std::fs::write(dir.join(&name), bytes).map_err(|e| RenderError::Io(e.to_string()))?;
            times.push(serde_json::json!({ "file": name, "timeMs": f.time_ms }));
            Ok(())
        })?;
        let manifest = serde_json::json!({
            "width": seq.width, "height": seq.height, "fps": seq.fps,
            "frames": times, "durationMs": seq.duration_ms,
        });
        std::fs::write(dir.join("frames.json"), manifest.to_string())
            .map_err(|e| RenderError::Io(e.to_string()))?;
        if a.info {
            summary(
                &[],
                &[],
                &[],
                serde_json::json!({ "dir": dir, "frames": seq.frames }),
            );
        }
        return Ok(());
    }
    let format: Format = fmt_name.parse()?;
    a.opts.format = format;
    let multi =
        matches!(a.opts.pages, PageSelection::All) && !matches!(format, Format::Pdf | Format::Pptx);
    if multi {
        let base = a
            .out
            .clone()
            .or_else(|| default_out(format.extension()))
            .ok_or_else(|| {
                RenderError::InvalidOptions("--out is required for multi-page exports".into())
            })?;
        let outs = export::export_pages(&mut renderer, &design, &a.opts)?;
        let stem = base
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| "page".into());
        let parent = base.parent().map(Path::to_path_buf).unwrap_or_default();
        let mut files = Vec::new();
        for (i, (_, o)) in outs.iter().enumerate() {
            let p = parent.join(format!("{stem}-{}.{}", i + 1, o.extension));
            write_out(Some(&p), &o.bytes)?;
            files.push(p);
        }
        if a.info {
            let w: Vec<String> = outs.iter().flat_map(|(_, o)| o.warnings.clone()).collect();
            let ma: Vec<String> = outs
                .iter()
                .flat_map(|(_, o)| o.missing_assets.clone())
                .collect();
            let mf: Vec<String> = outs
                .iter()
                .flat_map(|(_, o)| o.missing_fonts.clone())
                .collect();
            summary(&ma, &mf, &w, serde_json::json!({ "files": files }));
        }
        return Ok(());
    }
    let out = export::export(&mut renderer, &design, &a.opts)?;
    let path = a.out.clone().or_else(|| default_out(out.extension));
    write_out(path.as_deref(), &out.bytes)?;
    if a.info {
        summary(
            &out.missing_assets,
            &out.missing_fonts,
            &out.warnings,
            serde_json::json!({ "file": path, "bytes": out.bytes.len(), "mime": out.mime, "pages": out.pages }),
        );
    }
    Ok(())
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("desyn-render: {e}");
            ExitCode::from(match e {
                RenderError::InvalidOptions(_) => 2,
                RenderError::Parse(_) | RenderError::NoPage(_) => 3,
                _ => 1,
            })
        }
    }
}
