//! `POST /v1/render` (every export format) and `POST /v1/thumbnail`.

use std::collections::BTreeMap;

use desyn_core::geometry::Rect;
use desyn_core::model::{AssetKind, Color, Design, Id, Node};
use desyn_raster::anim::page_duration;
use desyn_raster::export::{
    self, AnimOptions, Background, ExportOptions, Format, PageSelection, PdfOptions, SvgText,
    bitmap, frames,
};
use desyn_raster::{Color4, MemoryAssetStore, PageRenderOptions, Renderer, output_size};
use serde::Deserialize;

use super::video::{self, AudioClip, FfmpegInfo, VideoCodec, VideoEnv};
use super::{Output, StillMeta};
use crate::config::{AssetConfig, Limits};
use crate::error::{ApiError, ApiResult};
use crate::fonts::FontService;
use crate::net::FetchReport;
use crate::plan::{self, AssetNeeds, Want};
use crate::runtime::Cancel;

/// Largest side of a video frame (H.264 / VP9 encoders and players handle 4K reliably).
pub const MAX_VIDEO_SIDE: u32 = 4096;

/// Page-space region.
#[derive(Debug, Clone, Copy, Deserialize)]
pub struct Region {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

/// PDF options of the request.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PdfRequest {
    bleed: bool,
    crop_marks: bool,
    cmyk: bool,
    /// Additive: flatten each page into one image (some print shops ask for it).
    flatten: bool,
    /// Additive: resolution of rasterized effects / flattened pages (default 300).
    dpi: Option<f64>,
}

/// `POST /v1/render` body (DOCUMENT_MODEL section 8, plus additive optional keys).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderRequest {
    design: Design,
    #[serde(default)]
    page_id: Option<String>,
    #[serde(default)]
    region: Option<Region>,
    #[serde(default)]
    scale: Option<f64>,
    format: String,
    #[serde(default)]
    quality: Option<f64>,
    #[serde(default)]
    background: Option<String>,
    #[serde(default)]
    pdf: Option<PdfRequest>,
    #[serde(default)]
    asset_urls: Option<BTreeMap<String, String>>,
    /// Additive: animation time of a still export.
    #[serde(default)]
    time_ms: Option<f64>,
    /// Additive: frames per second of gif / mp4 / webm (default 15 for gif, 30 for video).
    #[serde(default)]
    fps: Option<f64>,
    /// Additive: duration of a single-page animation (default: the page duration).
    #[serde(default)]
    duration_ms: Option<f64>,
    /// Additive: SVG text mode, `"text"` (default, fonts embedded), `"text-system"` (no embedding), `"outlines"`.
    #[serde(default)]
    svg_text: Option<String>,
    /// Additive: fail when an asset cannot be fetched (default: render without it and report it in headers).
    #[serde(default)]
    strict_assets: Option<bool>,
    /// Additive: mix audio and video sound into mp4 / webm (default true).
    #[serde(default)]
    audio: Option<bool>,
}

/// What a render produces.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    /// One file through the raster exporters (png / jpeg / webp / svg / pdf / pptx, single-page gif).
    Export(Format),
    /// Animated GIF of several pages (timeline with transitions).
    GifTimeline,
    /// MP4 / WebM through ffmpeg.
    Video(VideoCodec),
}

/// A validated render, ready to fetch assets and run.
pub struct PreparedRender {
    design: Design,
    pages: Vec<Id>,
    kind: Kind,
    opts: ExportOptions,
    /// Assets to fetch.
    pub needs: AssetNeeds,
    /// `strictAssets`.
    pub strict: bool,
    audio: bool,
    warnings: Vec<String>,
}

impl PreparedRender {
    /// Video exports get the longer deadline.
    pub fn is_video(&self) -> bool {
        matches!(self.kind, Kind::Video(_))
    }

    /// Format label for metrics.
    pub fn format_label(&self) -> &'static str {
        match self.kind {
            Kind::Export(f) => f.extension(),
            Kind::GifTimeline => "gif",
            Kind::Video(c) => c.extension(),
        }
    }
}

/// Parses `"transparent"` or a `#rrggbb[aa]` color.
pub fn parse_background(s: Option<&str>) -> ApiResult<Background> {
    match s.map(str::trim) {
        None | Some("") => Ok(Background::Page),
        Some(t) if t.eq_ignore_ascii_case("transparent") => Ok(Background::Transparent),
        Some(c) => Color::new(c.to_ascii_lowercase())
            .map(|c| Background::Color(Color4::from_color(&c)))
            .map_err(|_| {
                ApiError::bad_request(
                    "invalid_options",
                    format!("background must be \"transparent\" or #rrggbb(aa), got {c:?}"),
                )
            }),
    }
}

fn invalid(msg: impl Into<String>) -> ApiError {
    ApiError::bad_request("invalid_options", msg)
}

fn finite_positive(name: &str, v: f64, max: f64) -> ApiResult<f64> {
    if v.is_finite() && v > 0.0 && v <= max {
        Ok(v)
    } else {
        Err(invalid(format!(
            "{name} must be > 0 and <= {max} (got {v})"
        )))
    }
}

fn pixels(name: &str, rect: &Rect, scale: f64, limits: &Limits) -> ApiResult<(u32, u32)> {
    let (w, h) = output_size(rect, scale)?;
    if u64::from(w) * u64::from(h) > limits.max_pixels {
        return Err(ApiError::too_large(
            "too_many_pixels",
            format!(
                "{name} would be {w}x{h} px (limit {} px)",
                limits.max_pixels
            ),
        ));
    }
    Ok((w, h))
}

fn page_rect(design: &Design, page: &str) -> ApiResult<Rect> {
    match design.node(page) {
        Some(Node::Page(p)) => Ok(Rect::new(0.0, 0.0, p.base.width, p.base.height)),
        _ => Err(ApiError::bad_request(
            "page_not_found",
            format!("no such page: {page}"),
        )),
    }
}

fn page_bleed(design: &Design, page: &str) -> f64 {
    match design.node(page) {
        Some(Node::Page(p)) if p.bleed.is_finite() && p.bleed > 0.0 => p.bleed,
        _ => 0.0,
    }
}

/// Timeline of the selected pages: `(page, start, duration)` and the total (same rules as the frame renderer).
pub fn timeline(
    design: &Design,
    pages: &[Id],
    single_duration: Option<f64>,
) -> (Vec<(Id, f64, f64)>, f64) {
    let mut out = Vec::new();
    let mut t = 0.0;
    for p in pages {
        let d = match (single_duration, pages.len()) {
            (Some(d), 1) => d,
            _ => page_duration(design, p),
        };
        out.push((p.clone(), t, d));
        t += d;
    }
    (out, t)
}

/// Validates a render request against the limits and plans its assets. CPU work (runs in a job).
pub fn prepare(
    req: RenderRequest,
    limits: &Limits,
    acfg: &AssetConfig,
    ffmpeg: Option<&FfmpegInfo>,
) -> ApiResult<PreparedRender> {
    let mut warnings = plan::check_design(&req.design, limits, false)?;
    let format = req.format.trim().to_ascii_lowercase();
    let kind = match format.as_str() {
        "mp4" => Kind::Video(VideoCodec::Mp4),
        "webm" => Kind::Video(VideoCodec::Webm),
        "gif" => Kind::Export(Format::Gif),
        other => Kind::Export(other.parse::<Format>().map_err(|_| {
            ApiError::bad_request(
                "unsupported_format",
                format!("format must be png, jpeg, webp, svg, pdf, pptx, gif, mp4 or webm (got {other:?})"),
            )
        })?),
    };
    if let Kind::Video(codec) = kind
        && !ffmpeg.is_some_and(|f| f.supports(codec))
    {
        return Err(ApiError::new(
            axum::http::StatusCode::NOT_IMPLEMENTED,
            "video_unavailable",
            format!(
                "{} export needs ffmpeg with {} (FFMPEG_PATH), which this worker does not have",
                codec.extension(),
                match codec {
                    VideoCodec::Mp4 => "libx264 and aac",
                    VideoCodec::Webm => "libvpx-vp9 and libopus",
                }
            ),
        ));
    }
    let selection = match req.page_id.as_deref().map(str::trim) {
        None | Some("") => PageSelection::First,
        Some("all") => PageSelection::All,
        Some(id) => PageSelection::Id(id.to_string()),
    };
    let pages = selection.resolve(&req.design)?;
    if pages.len() > limits.max_pages {
        return Err(ApiError::too_large(
            "too_many_pages",
            format!(
                "{} pages selected (limit {})",
                pages.len(),
                limits.max_pages
            ),
        ));
    }
    let multi_ok = matches!(
        kind,
        Kind::Export(Format::Pdf | Format::Pptx | Format::Gif) | Kind::Video(_)
    );
    if pages.len() > 1 && !multi_ok {
        return Err(ApiError::bad_request(
            "multi_page_unsupported",
            format!(
                "pageId \"all\" with several pages needs pdf, pptx, gif, mp4 or webm (format {format}); request one page per call"
            ),
        ));
    }
    // Every GIF goes through the worker's encoder, which checks the deadline between frames (the raster exporter
    // cannot be cancelled); for one page it produces the same file.
    let kind = match kind {
        Kind::Export(Format::Gif) => Kind::GifTimeline,
        k => k,
    };

    let scale = finite_positive("scale", req.scale.unwrap_or(1.0), 64.0)?;
    let quality = match req.quality {
        None => 90,
        Some(q) if q.is_finite() && (1.0..=100.0).contains(&q) => q.round() as u8,
        Some(q) => {
            return Err(invalid(format!(
                "quality must be between 1 and 100 (got {q})"
            )));
        }
    };
    let background = parse_background(req.background.as_deref())?;
    let region = match req.region {
        None => None,
        Some(r) => {
            if !matches!(
                kind,
                Kind::Export(Format::Png | Format::Jpeg | Format::Webp | Format::Svg)
            ) {
                return Err(invalid("region applies to png, jpeg, webp and svg"));
            }
            if ![r.x, r.y, r.w, r.h].iter().all(|v| v.is_finite()) || r.w <= 0.0 || r.h <= 0.0 {
                return Err(invalid("region needs finite x, y and positive w, h"));
            }
            Some(Rect::new(r.x, r.y, r.w, r.h))
        }
    };
    let time_ms = match req.time_ms {
        None => None,
        Some(t) if t.is_finite() && t >= 0.0 => Some(t),
        Some(t) => return Err(invalid(format!("timeMs must be >= 0 (got {t})"))),
    };
    let svg_text = match req.svg_text.as_deref() {
        None | Some("text") => SvgText::Text { embed_fonts: true },
        Some("text-system") => SvgText::Text { embed_fonts: false },
        Some("outlines") => SvgText::Outlines,
        Some(other) => {
            return Err(invalid(format!(
                "svgText must be text, text-system or outlines (got {other:?})"
            )));
        }
    };
    let pdf_req = req.pdf.unwrap_or_default();
    let mut pdf = PdfOptions {
        bleed: pdf_req.bleed,
        crop_marks: pdf_req.crop_marks,
        cmyk: pdf_req.cmyk,
        flatten: pdf_req.flatten,
        dpi: match pdf_req.dpi {
            None => 300.0,
            Some(d) if d.is_finite() && (36.0..=2400.0).contains(&d) => d,
            Some(d) => {
                return Err(invalid(format!(
                    "pdf.dpi must be between 36 and 2400 (got {d})"
                )));
            }
        },
        title: None,
    };

    let mut anim = AnimOptions::default();
    match kind {
        Kind::Export(Format::Png | Format::Jpeg | Format::Webp | Format::Svg) => {
            let rect = match region {
                Some(r) => r,
                None => page_rect(&req.design, &pages[0])?,
            };
            pixels("the output", &rect, scale, limits)?;
        }
        Kind::Export(Format::Pdf) => {
            // Effects and flattened pages are rasterized at the PDF resolution; lower it for huge pages instead of
            // failing (vector content is unaffected).
            for p in &pages {
                let mut rect = page_rect(&req.design, p)?;
                if pdf.bleed {
                    let b = page_bleed(&req.design, p);
                    rect = Rect::new(rect.x - b, rect.y - b, rect.w + 2.0 * b, rect.h + 2.0 * b);
                }
                let px = (rect.w * pdf.dpi / 96.0) * (rect.h * pdf.dpi / 96.0);
                if px > limits.max_pixels as f64 {
                    let dpi = (pdf.dpi * (limits.max_pixels as f64 / px).sqrt())
                        .floor()
                        .max(36.0);
                    warnings.push(format!(
                        "pdf resolution lowered from {} to {dpi} dpi for page {p}",
                        pdf.dpi
                    ));
                    pdf.dpi = dpi;
                }
            }
        }
        Kind::Export(Format::Pptx) => {}
        Kind::Export(Format::Gif) | Kind::GifTimeline | Kind::Video(_) => {
            let video = matches!(kind, Kind::Video(_));
            let fps = finite_positive(
                "fps",
                req.fps.unwrap_or(if video { 30.0 } else { 15.0 }),
                limits.max_fps,
            )?;
            let duration = match req.duration_ms {
                None => None,
                Some(d) => Some(finite_positive("durationMs", d, limits.max_video_ms)?),
            };
            let (_, total) = timeline(&req.design, &pages, duration);
            if total > limits.max_video_ms {
                return Err(ApiError::too_large(
                    "too_long",
                    format!(
                        "the timeline is {:.1} s (limit {:.0} s)",
                        total / 1000.0,
                        limits.max_video_ms / 1000.0
                    ),
                ));
            }
            let first = page_rect(&req.design, &pages[0])?;
            let (w, h) = output_size(&first, scale)?;
            // 4:2:0 video needs at least 2 x 2 pixels (odd sizes are cropped by one row / column).
            if video && (w < 2 || h < 2) {
                return Err(invalid(format!(
                    "video frames would be {w}x{h} px; at least 2x2 px are needed (raise the scale)"
                )));
            }
            if video && (w > MAX_VIDEO_SIDE || h > MAX_VIDEO_SIDE) {
                return Err(ApiError::too_large(
                    "too_many_pixels",
                    format!(
                        "video frames would be {w}x{h} px (limit {MAX_VIDEO_SIDE} px per side); lower the scale"
                    ),
                ));
            }
            let frames_n = ((total / 1000.0 * fps).round() as u64).max(1);
            let budget = u64::from(w) * u64::from(h) * frames_n;
            if u64::from(w) * u64::from(h) > limits.max_pixels || budget > limits.max_frame_pixels {
                return Err(ApiError::too_large(
                    "too_many_pixels",
                    format!(
                        "{frames_n} frames of {w}x{h} px exceed the frame budget ({} px); lower the scale, fps or duration",
                        limits.max_frame_pixels
                    ),
                ));
            }
            anim = AnimOptions {
                fps,
                duration_ms: duration,
                max_frames: frames_n as usize,
            };
        }
    }

    let opts = ExportOptions {
        format: match kind {
            Kind::Export(f) => f,
            _ => Format::Gif,
        },
        pages: match kind {
            Kind::Export(Format::Pdf | Format::Pptx) => selection,
            _ => PageSelection::Id(pages[0].clone()),
        },
        scale,
        dpi: None,
        quality,
        background,
        region,
        time_ms,
        pdf,
        svg_text,
        anim,
        only: None,
        hidden: Vec::new(),
    };
    let audio = req.audio.unwrap_or(true);
    let urls = req.asset_urls.unwrap_or_default();
    let want = Want {
        images: true,
        fonts: true,
        media: matches!(kind, Kind::Video(_)) && audio,
    };
    let needs = plan::plan(&req.design, Some(&pages), &urls, want, acfg);
    Ok(PreparedRender {
        design: req.design,
        pages,
        kind,
        opts,
        needs,
        strict: req.strict_assets.unwrap_or(false),
        audio,
        warnings,
    })
}

/// Runs a prepared render with the fetched assets. CPU work (runs in a job).
pub fn execute(
    p: PreparedRender,
    report: FetchReport,
    fonts: &FontService,
    video_env: &VideoEnv,
    cancel: &Cancel,
) -> ApiResult<Output> {
    let mut store = MemoryAssetStore::new();
    let mut media = BTreeMap::new();
    for (id, bytes) in report.bytes {
        match p.design.assets.get(&id).map(|a| a.kind) {
            Some(AssetKind::Audio | AssetKind::Video) => {
                media.insert(id, bytes);
            }
            _ => store.insert(id, bytes),
        }
    }
    let mut renderer = Renderer::new(fonts.engine(cancel.deadline()), Box::new(store));
    let mut meta = StillMeta {
        pages: p.pages.len(),
        missing_assets: p.needs.unresolved.clone(),
        failed_assets: report.failed.iter().map(|f| f.id.clone()).collect(),
        missing_fonts: Vec::new(),
        warnings: p.warnings.clone(),
    };
    let (bytes, mime) = match p.kind {
        Kind::Export(_) => {
            let out = export::export(&mut renderer, &p.design, &p.opts)?;
            meta.pages = out.pages;
            meta.missing_assets.extend(out.missing_assets);
            meta.missing_fonts = out.missing_fonts;
            meta.warnings.extend(out.warnings);
            (out.bytes, out.mime)
        }
        Kind::GifTimeline => (
            gif_timeline(&mut renderer, &p.design, &p.pages, &p.opts, cancel)?,
            Format::Gif.mime(),
        ),
        Kind::Video(codec) => {
            let (_, total) = timeline(&p.design, &p.pages, p.opts.anim.duration_ms);
            let clips = if p.audio {
                video::audio_clips(&p.design, &p.pages, p.opts.anim.duration_ms, &media)
            } else {
                Vec::<AudioClip>::new()
            };
            let bytes = video::encode(
                &mut renderer,
                &p.design,
                &p.pages,
                &p.opts,
                codec,
                total,
                &clips,
                video_env,
                cancel,
            )?;
            (bytes, codec.mime())
        }
    };
    if !matches!(p.kind, Kind::Export(_)) {
        meta.missing_assets
            .extend(renderer.assets_mut().take_missing());
        meta.missing_fonts = renderer
            .text_mut()
            .take_font_requests()
            .into_iter()
            .map(|r| r.family)
            .collect();
    }
    meta.missing_assets.sort();
    meta.missing_assets.dedup();
    meta.missing_fonts.sort();
    meta.missing_fonts.dedup();
    Ok(Output { bytes, mime, meta })
}

/// Animated GIF of several pages played in order with their transitions (looping).
fn gif_timeline(
    renderer: &mut Renderer,
    design: &Design,
    pages: &[Id],
    opts: &ExportOptions,
    cancel: &Cancel,
) -> ApiResult<Vec<u8>> {
    let first = page_rect(design, &pages[0])?;
    let (w, h) = output_size(&first, opts.scale)?;
    if w > u32::from(u16::MAX) || h > u32::from(u16::MAX) {
        return Err(ApiError::too_large(
            "too_many_pixels",
            format!("gif is limited to 65535 px ({w}x{h})"),
        ));
    }
    let delay = (100.0 / opts.anim.fps).round().clamp(2.0, 65535.0) as u16;
    let transparent = matches!(opts.background, Background::Transparent);
    let mut out = Vec::new();
    {
        let mut enc = gif::Encoder::new(&mut out, w as u16, h as u16, &[])
            .map_err(|e| ApiError::internal(format!("gif: {e}")))?;
        enc.set_repeat(gif::Repeat::Infinite)
            .map_err(|e| ApiError::internal(format!("gif: {e}")))?;
        frames::render_frames(renderer, design, pages, opts, |fr| {
            if cancel.is_cancelled() {
                return Err(desyn_raster::RenderError::Encode("cancelled".into()));
            }
            let mut rgba = if transparent {
                bitmap::pixmap_rgba(fr.pixmap)
            } else {
                bitmap::pixmap_rgb_on(fr.pixmap, Color4::WHITE)
                    .as_chunks::<3>()
                    .0
                    .iter()
                    .flat_map(|c| [c[0], c[1], c[2], 255])
                    .collect()
            };
            let mut frame = gif::Frame::from_rgba_speed(w as u16, h as u16, &mut rgba, 10);
            frame.delay = delay;
            frame.dispose = gif::DisposalMethod::Background;
            enc.write_frame(&frame)
                .map_err(|e| desyn_raster::RenderError::Encode(e.to_string()))
        })
        .map_err(|e| {
            if cancel.is_cancelled() {
                ApiError::timeout()
            } else {
                ApiError::from(e)
            }
        })?;
    }
    Ok(out)
}

/// `POST /v1/thumbnail` body: `{ design, pageId, width }` plus additive optional keys.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThumbnailRequest {
    design: Design,
    #[serde(default)]
    page_id: Option<String>,
    #[serde(default)]
    width: Option<f64>,
    #[serde(default)]
    asset_urls: Option<BTreeMap<String, String>>,
    /// Additive: `webp` (default), `png` or `jpeg`.
    #[serde(default)]
    format: Option<String>,
    /// Additive: quality 1..100 (default 82).
    #[serde(default)]
    quality: Option<f64>,
    /// Additive: `"transparent"` or a color.
    #[serde(default)]
    background: Option<String>,
}

/// A validated thumbnail.
pub struct PreparedThumbnail {
    design: Design,
    page: Id,
    scale: f64,
    format: Format,
    quality: u8,
    background: Background,
    warnings: Vec<String>,
    /// Assets to fetch.
    pub needs: AssetNeeds,
}

/// Default thumbnail width (the Convex thumbnail action asks for 640).
pub const DEFAULT_THUMBNAIL_WIDTH: f64 = 640.0;

/// Validates a thumbnail request.
pub fn prepare_thumbnail(
    req: ThumbnailRequest,
    limits: &Limits,
    acfg: &AssetConfig,
) -> ApiResult<PreparedThumbnail> {
    let warnings = plan::check_design(&req.design, limits, false)?;
    let page = match req.page_id.as_deref().map(str::trim) {
        None | Some("") => PageSelection::First,
        Some(id) => PageSelection::Id(id.to_string()),
    }
    .resolve(&req.design)?
    .remove(0);
    let rect = page_rect(&req.design, &page)?;
    let width = finite_positive(
        "width",
        req.width.unwrap_or(DEFAULT_THUMBNAIL_WIDTH),
        f64::from(limits.max_thumbnail_width),
    )?;
    if rect.w <= 0.0 || rect.h <= 0.0 {
        return Err(invalid("the page has no area"));
    }
    let scale = width / rect.w;
    pixels("the thumbnail", &rect, scale, limits)?;
    let format = match req
        .format
        .as_deref()
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        None | Some("webp") => Format::Webp,
        Some("png") => Format::Png,
        Some("jpg" | "jpeg") => Format::Jpeg,
        Some(other) => {
            return Err(invalid(format!(
                "thumbnail format must be webp, png or jpeg (got {other:?})"
            )));
        }
    };
    let quality = match req.quality {
        None => 82,
        Some(q) if q.is_finite() && (1.0..=100.0).contains(&q) => q.round() as u8,
        Some(q) => {
            return Err(invalid(format!(
                "quality must be between 1 and 100 (got {q})"
            )));
        }
    };
    let background = parse_background(req.background.as_deref())?;
    let urls = req.asset_urls.unwrap_or_default();
    let needs = plan::plan(
        &req.design,
        Some(std::slice::from_ref(&page)),
        &urls,
        Want {
            images: true,
            fonts: true,
            media: false,
        },
        acfg,
    );
    Ok(PreparedThumbnail {
        design: req.design,
        page,
        scale,
        format,
        quality,
        background,
        warnings,
        needs,
    })
}

/// Renders a thumbnail.
pub fn execute_thumbnail(
    p: PreparedThumbnail,
    report: FetchReport,
    fonts: &FontService,
    cancel: &Cancel,
) -> ApiResult<Output> {
    let mut store = MemoryAssetStore::new();
    for (id, bytes) in report.bytes {
        store.insert(id, bytes);
    }
    let mut renderer = Renderer::new(fonts.engine(cancel.deadline()), Box::new(store));
    let (transparent, background) = match p.background {
        Background::Page => (false, None),
        Background::Transparent => (true, None),
        Background::Color(c) => (true, Some(c)),
    };
    let r = renderer.render_page(
        &p.design,
        &PageRenderOptions {
            page: Some(p.page.clone()),
            scale: p.scale,
            transparent,
            background,
            ..PageRenderOptions::default()
        },
    )?;
    let bytes = match p.format {
        Format::Png => bitmap::encode_png(&r.pixmap, None)?,
        Format::Jpeg => bitmap::encode_jpeg(
            &r.pixmap,
            p.quality,
            background.unwrap_or(Color4::WHITE),
            None,
        )?,
        _ => bitmap::encode_webp(&r.pixmap, p.quality)?,
    };
    let dl = r.display_list;
    let mut warnings = p.warnings;
    warnings.extend(dl.warnings);
    let mut missing_assets = p.needs.unresolved.clone();
    missing_assets.extend(dl.missing_assets);
    missing_assets.sort();
    missing_assets.dedup();
    Ok(Output {
        bytes,
        mime: p.format.mime(),
        meta: StillMeta {
            pages: 1,
            missing_assets,
            failed_assets: report.failed.iter().map(|f| f.id.clone()).collect(),
            missing_fonts: dl.missing_fonts,
            warnings,
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backgrounds_parse() {
        assert_eq!(parse_background(None).unwrap(), Background::Page);
        assert_eq!(
            parse_background(Some("Transparent")).unwrap(),
            Background::Transparent
        );
        assert!(matches!(
            parse_background(Some("#FFB02E")).unwrap(),
            Background::Color(_)
        ));
        assert!(parse_background(Some("red")).is_err());
    }
}
