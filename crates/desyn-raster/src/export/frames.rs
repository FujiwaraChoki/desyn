//! Frame sequences of animated pages (RGBA frames + timing for the worker's MP4 encoder), multi-page timelines
//! with page transitions, and animated GIF export.

use desyn_core::geometry::Rect;
use desyn_core::model::{Design, Id, Node, TransitionKind};
use tiny_skia::{Pixmap, PixmapPaint, Transform};

use super::{ExportOptions, page_render_options};
use crate::anim::page_duration;
use crate::error::RenderError;
use crate::renderer::{Renderer, output_size};

/// One rendered frame.
#[derive(Debug)]
pub struct Frame<'a> {
    /// Frame index.
    pub index: usize,
    /// Timeline time (ms) of the frame.
    pub time_ms: f64,
    /// Premultiplied RGBA pixels.
    pub pixmap: &'a Pixmap,
}

/// Summary of a rendered sequence.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct FrameSequence {
    /// Frame width.
    pub width: u32,
    /// Frame height.
    pub height: u32,
    /// Frames per second.
    pub fps: f64,
    /// Number of frames.
    pub frames: usize,
    /// Total duration (ms).
    pub duration_ms: f64,
}

/// Frame times for a duration at `fps` (capped at `max`).
pub fn frame_times(duration_ms: f64, fps: f64, max: usize) -> Vec<f64> {
    let d = if duration_ms.is_finite() {
        duration_ms.max(0.0)
    } else {
        0.0
    };
    let n = ((d / 1000.0 * fps).round() as usize).clamp(1, max.max(1));
    (0..n).map(|i| i as f64 * 1000.0 / fps).collect()
}

struct PageSpan {
    id: Id,
    start: f64,
    duration: f64,
    transition: (TransitionKind, f64),
}

fn spans(design: &Design, pages: &[Id], single: Option<f64>) -> (Vec<PageSpan>, f64) {
    let mut out = Vec::new();
    let mut t = 0.0;
    for p in pages {
        let d = match (single, pages.len()) {
            (Some(d), 1) => d,
            _ => page_duration(design, p),
        };
        let tr = match design.node(p) {
            Some(Node::Page(pg)) => pg
                .transition
                .as_ref()
                .map(|tr| {
                    (
                        tr.kind,
                        if tr.duration_ms.is_finite() {
                            tr.duration_ms.clamp(0.0, d)
                        } else {
                            0.0
                        },
                    )
                })
                .unwrap_or((TransitionKind::None, 0.0)),
            _ => (TransitionKind::None, 0.0),
        };
        out.push(PageSpan {
            id: p.clone(),
            start: t,
            duration: d,
            transition: tr,
        });
        t += d;
    }
    (out, t)
}

fn render_at(
    renderer: &mut Renderer,
    design: &Design,
    page: &Id,
    t: f64,
    opts: &ExportOptions,
    w: u32,
    h: u32,
) -> Result<Pixmap, RenderError> {
    let Some(Node::Page(p)) = design.node(page) else {
        return Err(RenderError::NoPage(page.clone()));
    };
    let mut ro = page_render_options(opts, page, false);
    ro.time_ms = Some(t);
    // Pages of other sizes are fitted into the first page's frame.
    let (pw, ph) = (p.base.width.max(1.0), p.base.height.max(1.0));
    let scale = (f64::from(w) / pw).min(f64::from(h) / ph);
    ro.scale = scale;
    ro.region = None;
    let r = renderer.render_page(design, &ro)?;
    if r.pixmap.width() == w && r.pixmap.height() == h {
        return Ok(r.pixmap);
    }
    let mut frame = Pixmap::new(w, h).ok_or_else(|| RenderError::TooLarge(format!("{w}x{h}")))?;
    let dx = (w as i32 - r.pixmap.width() as i32) / 2;
    let dy = (h as i32 - r.pixmap.height() as i32) / 2;
    frame.draw_pixmap(
        dx,
        dy,
        r.pixmap.as_ref(),
        &PixmapPaint::default(),
        Transform::identity(),
        None,
    );
    Ok(frame)
}

fn transition(prev: &Pixmap, cur: &Pixmap, kind: TransitionKind, p: f32) -> Pixmap {
    let (w, h) = (cur.width() as f32, cur.height() as f32);
    let mut out = Pixmap::new(cur.width(), cur.height()).expect("same size as the frame");
    let paint = |o: f32| PixmapPaint {
        opacity: o.clamp(0.0, 1.0),
        ..PixmapPaint::default()
    };
    match kind {
        TransitionKind::None => {
            out.draw_pixmap(0, 0, cur.as_ref(), &paint(1.0), Transform::identity(), None);
        }
        TransitionKind::Fade | TransitionKind::Dissolve => {
            out.draw_pixmap(
                0,
                0,
                prev.as_ref(),
                &paint(1.0),
                Transform::identity(),
                None,
            );
            out.draw_pixmap(0, 0, cur.as_ref(), &paint(p), Transform::identity(), None);
        }
        TransitionKind::Slide => {
            out.draw_pixmap(
                0,
                0,
                prev.as_ref(),
                &paint(1.0),
                Transform::identity(),
                None,
            );
            let x = ((1.0 - p) * w).round() as i32;
            out.draw_pixmap(x, 0, cur.as_ref(), &paint(1.0), Transform::identity(), None);
        }
        TransitionKind::Push => {
            let x = (p * w).round() as i32;
            out.draw_pixmap(
                -x,
                0,
                prev.as_ref(),
                &paint(1.0),
                Transform::identity(),
                None,
            );
            out.draw_pixmap(
                w as i32 - x,
                0,
                cur.as_ref(),
                &paint(1.0),
                Transform::identity(),
                None,
            );
        }
        TransitionKind::Zoom => {
            out.draw_pixmap(
                0,
                0,
                prev.as_ref(),
                &paint(1.0),
                Transform::identity(),
                None,
            );
            let s = 0.85 + 0.15 * p;
            let t = Transform::from_row(s, 0.0, 0.0, s, w * (1.0 - s) / 2.0, h * (1.0 - s) / 2.0);
            let pp = PixmapPaint {
                opacity: p,
                quality: tiny_skia::FilterQuality::Bilinear,
                ..PixmapPaint::default()
            };
            out.draw_pixmap(0, 0, cur.as_ref(), &pp, t, None);
        }
    }
    out
}

/// Renders the timeline of `pages` (one page: its animations; several: pages in order, each for its duration,
/// with page transitions) and calls `f` for every frame.
pub fn render_frames(
    renderer: &mut Renderer,
    design: &Design,
    pages: &[Id],
    opts: &ExportOptions,
    mut f: impl FnMut(Frame<'_>) -> Result<(), RenderError>,
) -> Result<FrameSequence, RenderError> {
    if pages.is_empty() {
        return Err(RenderError::NoPage("no pages selected".into()));
    }
    let Some(Node::Page(first)) = design.node(&pages[0]) else {
        return Err(RenderError::NoPage(pages[0].clone()));
    };
    let (w, h) = output_size(
        &Rect::new(0.0, 0.0, first.base.width, first.base.height),
        opts.scale,
    )?;
    let (spans, total) = spans(design, pages, opts.anim.duration_ms);
    let times = frame_times(total, opts.anim.fps, opts.anim.max_frames);
    let mut prev_end: Option<(usize, Pixmap)> = None;
    for (index, t) in times.iter().enumerate() {
        let si = spans.iter().rposition(|s| *t >= s.start).unwrap_or(0);
        let span = &spans[si];
        let local = t - span.start;
        let mut frame = render_at(renderer, design, &span.id, local, opts, w, h)?;
        if si > 0 && local < span.transition.1 && span.transition.0 != TransitionKind::None {
            let need = prev_end.as_ref().is_none_or(|(i, _)| *i != si - 1);
            if need {
                let p = &spans[si - 1];
                let end = render_at(renderer, design, &p.id, p.duration, opts, w, h)?;
                prev_end = Some((si - 1, end));
            }
            if let Some((_, prev)) = &prev_end {
                let p = (local / span.transition.1.max(1.0)) as f32;
                frame = transition(prev, &frame, span.transition.0, p);
            }
        }
        f(Frame {
            index,
            time_ms: *t,
            pixmap: &frame,
        })?;
    }
    Ok(FrameSequence {
        width: w,
        height: h,
        fps: opts.anim.fps,
        frames: times.len(),
        duration_ms: total,
    })
}

/// Animated GIF of one page's timeline (looping forever).
#[cfg(feature = "gif")]
pub fn export_gif(
    renderer: &mut Renderer,
    design: &Design,
    page: &Id,
    opts: &ExportOptions,
) -> Result<super::ExportOutput, RenderError> {
    let Some(Node::Page(p)) = design.node(page) else {
        return Err(RenderError::NoPage(page.clone()));
    };
    let (w, h) = output_size(
        &Rect::new(0.0, 0.0, p.base.width, p.base.height),
        opts.scale,
    )?;
    if w > u32::from(u16::MAX) || h > u32::from(u16::MAX) {
        return Err(RenderError::TooLarge(format!(
            "gif is limited to 65535 px ({w}x{h})"
        )));
    }
    let mut out = Vec::new();
    let delay = (100.0 / opts.anim.fps).round().clamp(2.0, 65535.0) as u16;
    let transparent = matches!(opts.background, super::Background::Transparent);
    let frames = {
        let mut enc = gif::Encoder::new(&mut out, w as u16, h as u16, &[])
            .map_err(|e| RenderError::Encode(e.to_string()))?;
        enc.set_repeat(gif::Repeat::Infinite)
            .map_err(|e| RenderError::Encode(e.to_string()))?;
        let seq = render_frames(renderer, design, std::slice::from_ref(page), opts, |fr| {
            let mut rgba = if transparent {
                super::bitmap::pixmap_rgba(fr.pixmap)
            } else {
                let rgb = super::bitmap::pixmap_rgb_on(fr.pixmap, crate::paint::Color4::WHITE);
                rgb.as_chunks::<3>()
                    .0
                    .iter()
                    .flat_map(|c| [c[0], c[1], c[2], 255])
                    .collect()
            };
            let mut frame = gif::Frame::from_rgba_speed(w as u16, h as u16, &mut rgba, 10);
            frame.delay = delay;
            frame.dispose = gif::DisposalMethod::Background;
            enc.write_frame(&frame)
                .map_err(|e| RenderError::Encode(e.to_string()))
        })?;
        seq.frames
    };
    if frames == 0 {
        return Err(RenderError::Encode("no frames".into()));
    }
    Ok(super::ExportOutput {
        bytes: out,
        mime: super::Format::Gif.mime(),
        extension: "gif",
        pages: 1,
        missing_assets: Vec::new(),
        missing_fonts: Vec::new(),
        warnings: Vec::new(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_time_grid() {
        let t = frame_times(1000.0, 10.0, 100);
        assert_eq!(t.len(), 10);
        assert_eq!(t[1], 100.0);
        assert_eq!(frame_times(0.0, 30.0, 10).len(), 1);
        assert_eq!(frame_times(1e9, 30.0, 50).len(), 50);
    }
}
