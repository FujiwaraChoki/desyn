//! The interactive frame: a persistent premultiplied RGBA buffer that is redrawn incrementally (damage
//! rectangles) between renders of the same page and viewport, and copied out to the host.

use desyn_core::model::{Design, Id, Node};
use desyn_raster::display::{BuildOptions, DisplayList};
use desyn_raster::tiny_skia::{IntRect, Pixmap};
use desyn_raster::{Color4, MAX_OUTPUT_PIXELS, MAX_OUTPUT_SIDE, RasterOptions, Renderer, Viewport};

use crate::convert::parse_opt_color;
use crate::error::EngineError;
use crate::types::{FrameInfo, PixelRect, RenderRequest};

/// What the frame buffer currently shows.
pub(crate) struct Frame {
    /// Sequence number of the frame the buffer shows.
    pub(crate) seq: u64,
    page: Id,
    viewport: Viewport,
    canvas: Option<Color4>,
    bleed: bool,
    list: DisplayList,
    pub(crate) pixmap: Pixmap,
}

/// Resolves a page argument (`None` = first page) to an existing page id.
pub(crate) fn resolve_page(design: &Design, page: Option<&str>) -> Result<Id, EngineError> {
    let pages = Renderer::page_ids(design);
    match page {
        Some(id) => {
            if matches!(design.node(id), Some(Node::Page(_))) {
                Ok(id.to_string())
            } else {
                Err(EngineError::PageNotFound { id: id.to_string() })
            }
        }
        None => pages
            .into_iter()
            .next()
            .ok_or_else(|| EngineError::PageNotFound {
                id: "(first page)".into(),
            }),
    }
}

fn validate_viewport(v: &Viewport) -> Result<(), EngineError> {
    if v.width == 0 || v.height == 0 {
        return Err(EngineError::arg(
            "viewport width and height must be at least 1 px",
        ));
    }
    if v.width > MAX_OUTPUT_SIDE
        || v.height > MAX_OUTPUT_SIDE
        || u64::from(v.width) * u64::from(v.height) > MAX_OUTPUT_PIXELS
    {
        return Err(EngineError::arg(format!(
            "viewport {}x{} exceeds {MAX_OUTPUT_SIDE} px per side",
            v.width, v.height
        )));
    }
    if !(v.zoom.is_finite() && v.zoom > 0.0) {
        return Err(EngineError::arg(format!("zoom {} must be > 0", v.zoom)));
    }
    if !(v.device_scale.is_finite() && v.device_scale > 0.0) {
        return Err(EngineError::arg(format!(
            "device scale {} must be > 0",
            v.device_scale
        )));
    }
    if !(v.x.is_finite() && v.y.is_finite()) {
        return Err(EngineError::arg("viewport origin must be finite"));
    }
    Ok(())
}

/// Builds the requested page and brings `slot` up to date with it: a damage-only redraw when the frame already
/// shows the same page, viewport and canvas color, a full rasterization otherwise. The new frame gets sequence
/// number `seq`; its damage is relative to the frame that was in `slot`.
pub(crate) fn render_frame(
    design: &Design,
    renderer: &mut Renderer,
    slot: &mut Option<Frame>,
    req: &RenderRequest,
    seq: u64,
) -> Result<FrameInfo, EngineError> {
    let viewport: Viewport = req.viewport.into();
    validate_viewport(&viewport)?;
    let page = resolve_page(design, req.page_id.as_deref())?;
    let canvas = parse_opt_color(req.background.as_deref())?;
    if let Some(t) = req.time_ms
        && !t.is_finite()
    {
        return Err(EngineError::arg("time_ms must be finite"));
    }
    let opts = BuildOptions {
        page: Some(page.clone()),
        show_hidden: req.show_hidden,
        background: true,
        only: None,
        hidden: req.hidden.clone(),
        time_ms: req.time_ms,
        vector: false,
        bleed: req.bleed,
        raster_scale: viewport.scale(),
    };
    let list = renderer.build(design, &opts)?;

    let reusable = slot.as_ref().is_some_and(|f| {
        !req.full_redraw
            && f.page == page
            && f.viewport == viewport
            && f.canvas == canvas
            && f.bleed == req.bleed
    });
    let info = |damage: Vec<IntRect>, full: bool, list: &DisplayList| FrameInfo {
        sequence: seq,
        page_id: page.clone(),
        width: viewport.width,
        height: viewport.height,
        damage: damage.into_iter().map(PixelRect::from).collect(),
        full,
        missing_assets: list.missing_assets.clone(),
        missing_fonts: list.missing_fonts.clone(),
        warnings: list.warnings.clone(),
        links: list.links.iter().cloned().map(Into::into).collect(),
    };
    if reusable && let Some(frame) = slot.as_mut() {
        let rects = renderer.redraw_damage(
            &frame.list,
            &list,
            &mut frame.pixmap.as_mut(),
            &viewport,
            canvas,
        );
        let out = info(rects, false, &list);
        frame.list = list;
        frame.seq = seq;
        return Ok(out);
    }
    // Reuse the allocation when only the content, origin or page changed.
    let mut pixmap = match slot.take() {
        Some(f) if f.pixmap.width() == viewport.width && f.pixmap.height() == viewport.height => {
            f.pixmap
        }
        _ => Pixmap::new(viewport.width, viewport.height).ok_or_else(|| {
            EngineError::arg(format!(
                "cannot allocate a {}x{} frame",
                viewport.width, viewport.height
            ))
        })?,
    };
    renderer.rasterize(
        &list,
        &mut pixmap.as_mut(),
        &RasterOptions {
            transform: viewport.transform(),
            region: None,
            background: canvas,
        },
    );
    let all = IntRect::from_xywh(0, 0, viewport.width, viewport.height)
        .ok_or_else(|| EngineError::arg("empty viewport"))?;
    let out = info(vec![all], true, &list);
    *slot = Some(Frame {
        seq,
        page: page.clone(),
        viewport,
        canvas,
        bleed: req.bleed,
        list,
        pixmap,
    });
    Ok(out)
}

/// Bytes a caller buffer needs for a `width x height` frame with `stride` bytes per row.
pub(crate) fn required_len(width: u32, height: u32, stride: u32) -> Result<usize, EngineError> {
    let row = (width as usize)
        .checked_mul(4)
        .ok_or_else(|| EngineError::arg("frame too wide"))?;
    if (stride as usize) < row {
        return Err(EngineError::arg(format!(
            "stride {stride} is smaller than {row} bytes per row"
        )));
    }
    if height == 0 {
        return Ok(0);
    }
    (stride as usize)
        .checked_mul(height as usize - 1)
        .and_then(|n| n.checked_add(row))
        .ok_or_else(|| EngineError::arg("frame too large"))
}

/// Copies `rects` of `src` into `dst`, a buffer of `stride` bytes per row with the same pixel size.
pub(crate) fn copy_rects(src: &Pixmap, dst: &mut [u8], stride: usize, rects: &[PixelRect]) {
    let src_stride = src.width() as usize * 4;
    let data = src.data();
    for r in rects {
        let x0 = (r.x as usize).min(src.width() as usize);
        let x1 = (r.x as usize + r.width as usize).min(src.width() as usize);
        let y0 = (r.y as usize).min(src.height() as usize);
        let y1 = (r.y as usize + r.height as usize).min(src.height() as usize);
        if x0 >= x1 {
            continue;
        }
        for y in y0..y1 {
            let s = y * src_stride + x0 * 4;
            let d = y * stride + x0 * 4;
            let n = (x1 - x0) * 4;
            dst[d..d + n].copy_from_slice(&data[s..s + n]);
        }
    }
}

/// The whole frame as one damage rectangle.
pub(crate) fn full_rect(width: u32, height: u32) -> PixelRect {
    PixelRect {
        x: 0,
        y: 0,
        width,
        height,
    }
}

/// Frame info for a one-shot page render.
pub(crate) fn page_info(page: Id, pixmap: &Pixmap, list: &DisplayList) -> FrameInfo {
    FrameInfo {
        sequence: 0,
        page_id: page,
        width: pixmap.width(),
        height: pixmap.height(),
        damage: vec![full_rect(pixmap.width(), pixmap.height())],
        full: true,
        missing_assets: list.missing_assets.clone(),
        missing_fonts: list.missing_fonts.clone(),
        warnings: list.warnings.clone(),
        links: list.links.iter().cloned().map(Into::into).collect(),
    }
}
