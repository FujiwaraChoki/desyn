//! Text nodes: glyph outlines from desyn-text (subpixel positions, synthetic bold / oblique), per-span paints,
//! highlights, underline / strikethrough, color glyphs (COLR layers, bitmaps), text-on-arc, outline strokes,
//! typewriter reveal, span links and shaped runs for vector exporters.

use std::collections::{BTreeMap, HashSet};
use std::sync::Arc;

use desyn_core::geometry::{Affine, Point, Rect};
use desyn_core::model::{BlendMode, Fill, StrokeAlign, TextNode};
use desyn_core::paths::kurbo::{self, BezPath, Shape as _};
use desyn_text::{
    BitmapImage, ColorPaint, GradientExtend, LaidOutText, RunKind, TextPath, TextPathKind,
    place_on_curve,
};

use super::build::DisplayListBuilder;
use super::shapes::{Shape, ShapeKind};
use super::{FillItem, FillRule, GlyphItem, GlyphRunItem, ImageItem, Item, LinkTarget, TextItem};
use crate::assets::RasterImage;
use crate::geom::{bez_to_path, path_bounds};
use crate::paint::{Color4, GradientStop, Paint, Quality, Spread};

/// Paints of a span: its visible fills resolved over the text box, or its solid color.
fn span_paints(
    b: &mut DisplayListBuilder<'_>,
    fills: &[Fill],
    color: Option<[u8; 4]>,
    w: f64,
    h: f64,
) -> Vec<(Paint, f32, BlendMode)> {
    let mut out = Vec::new();
    if fills.is_empty() {
        if let Some(c) = color {
            out.push((Paint::Solid(Color4::from_rgba8(c)), 1.0, BlendMode::Normal));
        }
        return out;
    }
    for f in fills {
        if let Some(pl) = b.resolve_fill(f, w, h, (0.0, 0.0)) {
            out.push((pl.paint, pl.opacity, pl.blend));
        }
    }
    out
}

fn glyph_offset(skew: f64, x: f64, y: f64) -> kurbo::Affine {
    kurbo::Affine::new([1.0, 0.0, -skew, 1.0, x, y])
}

fn spread(e: GradientExtend) -> Spread {
    match e {
        GradientExtend::Pad => Spread::Pad,
        GradientExtend::Repeat => Spread::Repeat,
        GradientExtend::Reflect => Spread::Reflect,
    }
}

fn stops(s: &[desyn_text::GradientStop]) -> Vec<GradientStop> {
    let mut v: Vec<GradientStop> = s
        .iter()
        .map(|g| GradientStop {
            pos: g.offset.clamp(0.0, 1.0),
            color: Color4::from_rgba8(g.color),
        })
        .collect();
    v.sort_by(|a, b| a.pos.total_cmp(&b.pos));
    v
}

fn color_paint(p: &ColorPaint, t: Affine) -> Paint {
    match p {
        ColorPaint::Solid { color } => Paint::Solid(Color4::from_rgba8(*color)),
        ColorPaint::Linear {
            p0,
            p1,
            stops: s,
            extend,
        } => Paint::Linear {
            start: Point::new(p0.0, p0.1),
            end: Point::new(p1.0, p1.1),
            stops: stops(s),
            spread: spread(*extend),
            transform: t,
        },
        ColorPaint::Radial {
            c0,
            r0,
            c1,
            r1,
            stops: s,
            extend,
        } => Paint::Radial {
            c0: Point::new(c0.0, c0.1),
            r0: *r0,
            c1: Point::new(c1.0, c1.1),
            r1: *r1,
            stops: stops(s),
            spread: spread(*extend),
            transform: t,
        },
        ColorPaint::Sweep {
            center,
            start_angle,
            end_angle,
            stops: s,
            extend,
        } => Paint::Conic {
            center: Point::new(center.0, center.1),
            start_deg: *start_angle,
            end_deg: *end_angle,
            stops: stops(s),
            spread: spread(*extend),
            transform: t,
        },
    }
}

fn bitmap_image(img: &BitmapImage) -> Option<RasterImage> {
    match img {
        BitmapImage::Png(bytes) => crate::assets::decode_image(Arc::from(bytes.as_slice())).ok(),
        BitmapImage::Bgra {
            width,
            height,
            data,
        } => {
            let mut rgba = data.clone();
            for px in rgba.as_chunks_mut::<4>().0 {
                px.swap(0, 2);
            }
            let size = tiny_skia::IntSize::from_wh(*width, *height)?;
            tiny_skia::Pixmap::from_vec(rgba, size).map(|p| RasterImage::new(p, None))
        }
        BitmapImage::Mask {
            width,
            height,
            data,
        } => {
            let mut rgba = Vec::with_capacity(data.len() * 4);
            for a in data {
                rgba.extend_from_slice(&[0, 0, 0, *a]);
            }
            RasterImage::from_rgba8(*width, *height, rgba)
        }
    }
}

/// Byte offset after the first `fraction` of the characters of `text`.
fn reveal_cutoff(text: &str, fraction: f64) -> usize {
    let n = text.chars().count();
    let k = ((n as f64) * fraction.clamp(0.0, 1.0)).floor() as usize;
    text.char_indices()
        .nth(k)
        .map(|(i, _)| i)
        .unwrap_or(text.len())
}

impl DisplayListBuilder<'_> {
    /// Items and links of a text node.
    pub(super) fn text_node_items(
        &mut self,
        t: &TextNode,
        typewriter: Option<f64>,
    ) -> (Vec<Item>, Vec<(Rect, LinkTarget)>) {
        let design = self.design;
        let laid = self.text.layout_node(t, Some(&design.styles));
        self.collect_font_requests();
        let (w, h) = (t.base.width.max(0.0), t.base.height.max(0.0));
        let curve = t.curve.filter(|c| c.is_finite() && c.abs() >= 0.01);
        let strokes = t.strokes.as_deref().unwrap_or(&[]);
        self.laid_text_items(&laid, w, h, curve, typewriter, strokes)
    }

    /// Items of already laid out text (also used for chart / table labels).
    pub(super) fn laid_text_items(
        &mut self,
        laid: &LaidOutText,
        w: f64,
        h: f64,
        curve: Option<f64>,
        typewriter: Option<f64>,
        strokes: &[desyn_core::model::Stroke],
    ) -> (Vec<Item>, Vec<(Rect, LinkTarget)>) {
        let cutoff = typewriter.map(|f| reveal_cutoff(&laid.text, f));
        let visible = |run: usize, glyph: usize| -> bool {
            let Some(c) = cutoff else { return true };
            let Some(r) = laid.runs.get(run) else {
                return false;
            };
            match r.kind {
                RunKind::Text => r.glyphs.get(glyph).is_some_and(|g| g.cluster < c),
                // Markers appear with their paragraph's first character; ellipsis / hyphen with the line end.
                _ => r.range.start < c || laid.lines.get(r.line).is_some_and(|l| l.range.start < c),
            }
        };
        // Glyph geometry, paint ordered.
        let paths: Vec<TextPath> = match curve {
            None => self.text.text_paths(laid),
            Some(c) => self.curved_paths(laid, c),
        };
        // Max revealed x per line (typewriter clips decorations).
        let mut line_reveal: BTreeMap<usize, f64> = BTreeMap::new();
        if cutoff.is_some() {
            for (ri, r) in laid.runs.iter().enumerate() {
                for (gi, g) in r.glyphs.iter().enumerate() {
                    if visible(ri, gi) {
                        let e = line_reveal.entry(r.line).or_insert(f64::MIN);
                        *e = e.max(g.x + g.advance);
                    }
                }
            }
        }
        let mut out: Vec<Item> = Vec::new();
        let mut glyph_groups: BTreeMap<(usize, u64), BezPath> = BTreeMap::new();
        let mut color_glyphs: Vec<(usize, usize)> = Vec::new();
        let mut decos: Vec<(TextPathKind, usize, BezPath, Option<[u8; 4]>)> = Vec::new();
        let mut all_glyphs = BezPath::new();
        for tp in paths {
            match tp.kind {
                TextPathKind::Glyph => {
                    let (Some(ri), Some(gi)) = (tp.run, tp.glyph_index) else {
                        continue;
                    };
                    if !visible(ri, gi) {
                        continue;
                    }
                    if tp.color_glyph {
                        color_glyphs.push((ri, gi));
                        continue;
                    }
                    if !strokes.is_empty() {
                        all_glyphs.extend(tp.path.elements().iter().copied());
                    }
                    glyph_groups
                        .entry((tp.span, tp.stroke.to_bits()))
                        .or_default()
                        .extend(tp.path.elements().iter().copied());
                }
                kind => {
                    let mut path = tp.path;
                    if cutoff.is_some() {
                        // Clip the decoration rectangle to the revealed part of its line.
                        let bb = desyn_core::paths::bez_bounds(&path);
                        let line = laid
                            .decorations
                            .iter()
                            .find(|d| {
                                bb.is_some_and(|b| {
                                    (d.rect.y - b.y).abs() < 1e-6 && (d.rect.x - b.x).abs() < 1e-6
                                })
                            })
                            .map(|d| d.line);
                        let Some(max_x) = line.and_then(|l| line_reveal.get(&l)).copied() else {
                            continue;
                        };
                        let Some(b) = bb else { continue };
                        let right = (b.x + b.w).min(max_x);
                        if right <= b.x {
                            continue;
                        }
                        path = kurbo::Rect::new(b.x, b.y, right, b.y + b.h).to_path(0.1);
                    }
                    decos.push((kind, tp.span, path, tp.color));
                }
            }
        }
        // Highlights first.
        for (kind, _, path, color) in &decos {
            if *kind != TextPathKind::Highlight {
                continue;
            }
            let (Some(c), Some(p)) = (color, bez_to_path(path)) else {
                continue;
            };
            out.push(Item::Fill(FillItem {
                bounds: path_bounds(&p),
                path: Arc::new(p),
                rule: FillRule::Nonzero,
                paint: Paint::Solid(Color4::from_rgba8(*c)),
                opacity: 1.0,
                blend: BlendMode::Normal,
            }));
        }
        // Outside strokes go below the glyph fills.
        let stroke_shape = if strokes.is_empty() {
            None
        } else {
            Shape::from_bez(all_glyphs, FillRule::Nonzero, ShapeKind::Other)
        };
        let (outside, other): (Vec<_>, Vec<_>) = strokes
            .iter()
            .cloned()
            .partition(|s| s.align == StrokeAlign::Outside);
        if let Some(shape) = &stroke_shape {
            out.extend(self.stroke_items(shape, &outside, w, h));
        }
        // Shaped runs for vector exporters.
        let runs_by_span = if self.opts.vector && curve.is_none() {
            self.vector_runs(laid, &visible, &color_glyphs)
        } else {
            BTreeMap::new()
        };
        for ((span, bold_bits), bez) in glyph_groups {
            let Some(style) = laid.spans.get(span) else {
                continue;
            };
            let Some(p) = bez_to_path(&bez) else {
                continue;
            };
            let p = Arc::new(p);
            let bold = f64::from_bits(bold_bits);
            let bounds = path_bounds(&p).inflate(bold / 2.0);
            let fills = style.fills.clone();
            let paints = span_paints(self, &fills, style.color, w, h);
            let runs: Vec<GlyphRunItem> = runs_by_span
                .get(&span)
                .map(|v| {
                    v.iter()
                        .filter(|r| r.bold.to_bits() == bold_bits)
                        .cloned()
                        .collect()
                })
                .unwrap_or_default();
            for (paint, opacity, blend) in paints {
                out.push(Item::Text(TextItem {
                    outline: p.clone(),
                    paint,
                    opacity,
                    blend,
                    bold,
                    runs: runs.clone(),
                    bounds,
                }));
            }
        }
        // Color glyphs (COLR layers / bitmaps) in their own colors.
        for (ri, gi) in color_glyphs {
            self.color_glyph_items(laid, ri, gi, curve, &mut out);
        }
        // Underlines and strikethroughs in the span paints.
        for (kind, span, path, _) in &decos {
            if *kind == TextPathKind::Highlight {
                continue;
            }
            let Some(p) = bez_to_path(path) else { continue };
            let p = Arc::new(p);
            let Some(style) = laid.spans.get(*span) else {
                continue;
            };
            let fills = style.fills.clone();
            for (paint, opacity, blend) in span_paints(self, &fills, style.color, w, h) {
                out.push(Item::Fill(FillItem {
                    bounds: path_bounds(&p),
                    path: p.clone(),
                    rule: FillRule::Nonzero,
                    paint,
                    opacity,
                    blend,
                }));
            }
        }
        if let Some(shape) = &stroke_shape {
            out.extend(self.stroke_items(shape, &other, w, h));
        }
        // Span links: one rectangle per run on its line.
        let mut links = Vec::new();
        if curve.is_none() {
            for r in &laid.runs {
                let Some(link) = laid.spans.get(r.span).and_then(|s| s.link.clone()) else {
                    continue;
                };
                let Some(line) = laid.lines.get(r.line) else {
                    continue;
                };
                let Some(target) = super::parse_link(&link) else {
                    continue;
                };
                links.push((Rect::new(r.x, line.top, r.width, line.height), target));
            }
        }
        (out, links)
    }

    /// Glyph paths placed on an arc (`TextNode.curve`).
    fn curved_paths(&mut self, laid: &LaidOutText, curve: f64) -> Vec<TextPath> {
        let placements = place_on_curve(laid, curve);
        let mut out = Vec::with_capacity(placements.len());
        for pg in placements {
            let Some(run) = laid.runs.get(pg.run) else {
                continue;
            };
            let Some(g) = run.glyphs.get(pg.glyph) else {
                continue;
            };
            let kind = self.text.glyph_kind(run.instance, g.id);
            let color = kind != desyn_text::GlyphKind::Outline;
            let path = match self.text.glyph_path(run.instance, g.id, run.size) {
                Some(p) if !p.elements().is_empty() => p,
                _ if color => {
                    // Bitmap-only glyph: its box stands in so the color pass finds it.
                    kurbo::Rect::new(0.0, -run.size * 0.8, run.size, run.size * 0.2).to_path(0.1)
                }
                _ => continue,
            };
            let t = pg.transform.to_kurbo() * glyph_offset(run.skew, 0.0, 0.0);
            out.push(TextPath {
                kind: TextPathKind::Glyph,
                path: t * path,
                span: run.span,
                run: Some(pg.run),
                glyph_index: Some(pg.glyph),
                glyph: Some(g.id),
                color_glyph: color,
                color: run.color,
                stroke: run.synthetic_bold,
            });
        }
        out
    }

    /// COLR layers or the embedded bitmap of one glyph.
    fn color_glyph_items(
        &mut self,
        laid: &LaidOutText,
        ri: usize,
        gi: usize,
        curve: Option<f64>,
        out: &mut Vec<Item>,
    ) {
        let Some(run) = laid.runs.get(ri) else { return };
        let Some(g) = run.glyphs.get(gi) else { return };
        let place: Affine = match curve {
            None => crate::geom::from_kurbo(glyph_offset(run.skew, g.x, g.y)),
            Some(c) => {
                let Some(pg) = place_on_curve(laid, c)
                    .into_iter()
                    .find(|p| p.run == ri && p.glyph == gi)
                else {
                    return;
                };
                pg.transform * crate::geom::from_kurbo(glyph_offset(run.skew, 0.0, 0.0))
            }
        };
        let fg = run.color.unwrap_or([0x11, 0x11, 0x11, 0xff]);
        if let Some(layers) = self.text.color_glyph(run.instance, g.id, run.size, fg) {
            for layer in layers {
                let mut path = layer.path.clone();
                path.apply_affine(place.to_kurbo());
                let Some(p) = bez_to_path(&path) else {
                    continue;
                };
                out.push(Item::Fill(FillItem {
                    bounds: path_bounds(&p),
                    path: Arc::new(p),
                    rule: FillRule::Nonzero,
                    paint: color_paint(&layer.paint, place * layer.paint_transform),
                    opacity: 1.0,
                    blend: BlendMode::Normal,
                }));
            }
            return;
        }
        if let Some(bmp) = self.text.bitmap_glyph(run.instance, g.id, run.size)
            && let Some(img) = bitmap_image(&bmp.image)
        {
            let r = bmp.rect;
            let (iw, ih) = (f64::from(img.width()), f64::from(img.height()));
            let t = place * Affine::translate(r.x, r.y) * Affine::scale(r.w / iw, r.h / ih);
            let bounds = t.transform_rect_bbox(&Rect::new(0.0, 0.0, iw, ih));
            out.push(Item::Image(ImageItem {
                image: Arc::new(img),
                transform: t,
                opacity: 1.0,
                blend: BlendMode::Normal,
                quality: Quality::Bicubic,
                bounds,
            }));
        }
    }

    /// Shaped runs grouped by span (vector builds).
    fn vector_runs(
        &mut self,
        laid: &LaidOutText,
        visible: &dyn Fn(usize, usize) -> bool,
        color_glyphs: &[(usize, usize)],
    ) -> BTreeMap<usize, Vec<GlyphRunItem>> {
        let colored: HashSet<(usize, usize)> = color_glyphs.iter().copied().collect();
        let source: Arc<str> = Arc::from(laid.text.as_str());
        let mut out: BTreeMap<usize, Vec<GlyphRunItem>> = BTreeMap::new();
        for (ri, run) in laid.runs.iter().enumerate() {
            let Some(font) = self.font_entry(run.face.0, &run.variations) else {
                continue;
            };
            let (text, synthetic): (Arc<str>, bool) = match run.kind {
                RunKind::Text => (source.clone(), false),
                RunKind::Ellipsis => (Arc::from("\u{2026}"), true),
                RunKind::Hyphen => (Arc::from("-"), true),
                RunKind::ListMarker => {
                    let marker = laid
                        .paragraphs
                        .iter()
                        .find(|p| p.lines.contains(&run.line))
                        .and_then(|p| p.marker.clone())
                        .unwrap_or_else(|| "\u{2022}".into());
                    (Arc::from(marker.as_str()), true)
                }
            };
            let mut clusters: Vec<usize> = run.glyphs.iter().map(|g| g.cluster).collect();
            clusters.sort_unstable();
            clusters.dedup();
            let glyphs: Vec<GlyphItem> = run
                .glyphs
                .iter()
                .enumerate()
                .filter(|(gi, _)| visible(ri, *gi) && !colored.contains(&(ri, *gi)))
                .map(|(_, g)| {
                    let range = if synthetic {
                        0..text.len()
                    } else {
                        let end = clusters
                            .iter()
                            .find(|c| **c > g.cluster)
                            .copied()
                            .unwrap_or(run.range.end.max(g.cluster))
                            .min(text.len());
                        g.cluster.min(end)..end
                    };
                    GlyphItem {
                        id: g.id,
                        x: g.x,
                        y: g.y,
                        advance: g.advance,
                        text: range,
                    }
                })
                .collect();
            if glyphs.is_empty() {
                continue;
            }
            self.note_runs();
            out.entry(run.span).or_default().push(GlyphRunItem {
                font,
                size: run.size,
                skew: run.skew,
                bold: run.synthetic_bold,
                glyphs,
                text,
            });
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cutoff_counts_chars() {
        assert_eq!(reveal_cutoff("héllo", 0.4), 3);
        assert_eq!(reveal_cutoff("abc", 1.0), 3);
        assert_eq!(reveal_cutoff("abc", 0.0), 0);
    }
}
