//! Page summaries: palette, fonts, typography, grid (margins, alignment lines, spacing rhythm) and the visual
//! hierarchy. Formulas follow `describeDesign` of `@desyn/ai` so both hosts tell the model the same story; the
//! Rust side uses clipped visible areas, run-level sizes and real contrast.

use std::collections::BTreeMap;

use desyn_core::color::Rgba;
use desyn_core::geometry::Rect;
use desyn_core::{ImageFit, Node, NodeType};

use crate::ctx::Ctx;
use crate::lint::{r1, r2};
use crate::paint::{self, hex6};
use crate::scene::visible_area;
use crate::types::{Alignment, FontUsage, Grid, HierarchyEntry, Margins, PaletteEntry, Typography};
use crate::usage::font_uses;

/// Colors closer than this (OKLab distance) count as one palette entry.
pub const SAME_COLOR: f64 = 0.025;

/// Cached OKLab coordinates (palette merging compares every new color with every entry).
#[derive(Debug, Clone, Copy)]
pub struct Lab(f64, f64, f64);

impl Lab {
    /// OKLab of a color.
    pub fn of(c: Rgba) -> Lab {
        let (l, a, b) = c.to_oklab();
        Lab(l, a, b)
    }

    /// Euclidean distance (same as [`crate::paint::delta_e`]).
    pub fn distance(&self, o: &Lab) -> f64 {
        ((self.0 - o.0).powi(2) + (self.1 - o.1).powi(2) + (self.2 - o.2).powi(2)).sqrt()
    }
}

fn round3(v: f64) -> f64 {
    (v * 1000.0).round() / 1000.0
}

/// Representative paint of a node (text color, first stroke of lines, QR foreground, top fill).
fn paint_of(ctx: &Ctx<'_>, i: usize) -> Option<Rgba> {
    let styles = &ctx.scene.design.styles;
    let n = ctx.scene.items[i].node;
    match n {
        Node::Text(_) => ctx.text(i).filter(|f| f.has_content()).map(|f| f.color()),
        Node::Line(l) => l
            .strokes
            .first()
            .and_then(|s| paint::representative(&s.fills, styles)),
        Node::Qr(q) => Some(Rgba::from_color(&q.fg)),
        _ => paint::representative(n.fills(), styles),
    }
}

/// Palette by visible area plus the number of distinct colors.
pub fn palette(ctx: &Ctx<'_>) -> (Vec<PaletteEntry>, usize) {
    let page = ctx.scene.page_rect;
    let page_area = ctx.scene.page_area();
    let styles = &ctx.scene.design.styles;
    let mut weights: Vec<(Rgba, f64)> = Vec::new();
    let mut labs: Vec<Lab> = Vec::new();
    let mut add = |c: Option<Rgba>, w: f64| {
        let Some(c) = c else { return };
        if w <= 0.0 {
            return;
        }
        let c = c.with_alpha(1.0);
        let lab = Lab::of(c);
        match labs.iter().position(|k| k.distance(&lab) < SAME_COLOR) {
            Some(p) => weights[p].1 += w,
            None => {
                weights.push((c, w));
                labs.push(lab);
            }
        }
    };
    let covered = ctx.scene.top.iter().any(|i| {
        let it = &ctx.scene.items[*i];
        it.visible
            && it.opacity >= 0.99
            && it
                .aabb
                .intersection(&page)
                .is_some_and(|r| r.area() >= page_area * 0.98)
            && match it.node {
                Node::Image(img) => img.fit != ImageFit::Fit,
                n => n.fills().iter().any(|f| {
                    f.is_visible()
                        && f.flags().opacity.unwrap_or(1.0) >= 0.99
                        && matches!(f, desyn_core::Fill::Solid(_) | desyn_core::Fill::Image(_))
                }),
            }
    });
    if !covered {
        add(
            paint::representative(&ctx.scene.page.background, styles),
            page_area,
        );
    }
    for (i, it) in ctx.scene.items.iter().enumerate() {
        if !it.visible {
            continue;
        }
        let a = it
            .visible_box()
            .and_then(|r| r.intersection(&page))
            .map(|r| r.area())
            .unwrap_or(0.0);
        let w = match it.kind() {
            NodeType::Text => a * 0.2,
            NodeType::Line => a * 0.05 + 1.0,
            _ => a,
        };
        add(paint_of(ctx, i), w);
    }
    let total: f64 = weights.iter().map(|w| w.1).sum::<f64>().max(1e-9);
    let distinct = weights.len();
    let mut entries: Vec<PaletteEntry> = weights
        .into_iter()
        .map(|(c, w)| PaletteEntry {
            color: hex6(c),
            share: round3(w / total),
        })
        .collect();
    // Stable: equal shares keep paint order (as the TypeScript describe does).
    entries.sort_by(|a, b| b.share.total_cmp(&a.share));
    entries.truncate(8);
    (entries, distinct)
}

/// Font families in order of first use, with weights and the number of text nodes using each.
pub fn fonts(ctx: &Ctx<'_>) -> Vec<FontUsage> {
    let mut order: Vec<String> = Vec::new();
    let mut map: BTreeMap<String, (Vec<f64>, Vec<usize>)> = BTreeMap::new();
    for (family, weight, item, _) in font_uses(ctx) {
        let e = map.entry(family.clone()).or_insert_with(|| {
            order.push(family.clone());
            (Vec::new(), Vec::new())
        });
        if !e.0.contains(&weight) {
            e.0.push(weight);
        }
        if !e.1.contains(&item) {
            e.1.push(item);
        }
    }
    order
        .into_iter()
        .map(|f| {
            let (mut w, items) = map.remove(&f).expect("family");
            w.sort_by(f64::total_cmp);
            FontUsage {
                family: f,
                weights: w,
                used_by: items.len(),
            }
        })
        .collect()
}

/// Sizes with the number of visible characters set in each (descending size).
pub fn size_usage(ctx: &Ctx<'_>) -> Vec<(f64, usize)> {
    let mut map: BTreeMap<i64, usize> = BTreeMap::new();
    for (i, it) in ctx.scene.items.iter().enumerate() {
        let Some(f) = ctx.text(i) else { continue };
        if !it.visible || !f.has_content() {
            continue;
        }
        for r in &f.runs {
            let n = r.text.chars().filter(|c| !c.is_whitespace()).count();
            if n > 0 {
                *map.entry((r.style.font_size * 100.0).round() as i64)
                    .or_default() += n;
            }
        }
    }
    map.into_iter()
        .rev()
        .map(|(k, n)| (k as f64 / 100.0, n))
        .collect()
}

/// Type scale summary.
pub fn typography(ctx: &Ctx<'_>) -> Typography {
    let sizes = size_usage(ctx);
    let scale: Vec<f64> = sizes.iter().map(|s| s.0).collect();
    let headline = scale.first().copied();
    let body = sizes
        .iter()
        .filter(|s| Some(s.0) != headline)
        .max_by(|a, b| a.1.cmp(&b.1).then(b.0.total_cmp(&a.0)))
        .map(|s| s.0);
    let ratio = match (headline, body) {
        (Some(h), Some(b)) if b > 0.0 => Some(r2(h / b)),
        _ => None,
    };
    Typography {
        scale,
        headline_size: headline,
        body_size: body,
        ratio,
    }
}

/// Top-level blocks used by the grid summary (visible, not backdrop).
fn blocks(ctx: &Ctx<'_>) -> Vec<usize> {
    ctx.scene
        .top
        .iter()
        .copied()
        .filter(|i| ctx.is_content(*i))
        .collect()
}

/// Reads one alignment line (edge or center) of a box.
type EdgeFn = fn(&Rect) -> f64;

/// Margins, alignment lines and spacing rhythm.
pub fn grid(ctx: &Ctx<'_>) -> Grid {
    let page = ctx.scene.page_rect;
    let blocks = blocks(ctx);
    let content: Vec<usize> = if blocks.is_empty() {
        ctx.scene
            .top
            .iter()
            .copied()
            .filter(|i| ctx.scene.items[*i].visible)
            .collect()
    } else {
        blocks.clone()
    };
    let boxes: Vec<Rect> = content.iter().map(|i| ctx.scene.items[*i].aabb).collect();
    let margins = if boxes.is_empty() {
        Margins::default()
    } else {
        let min_x = boxes.iter().map(|b| b.x).fold(f64::INFINITY, f64::min);
        let min_y = boxes.iter().map(|b| b.y).fold(f64::INFINITY, f64::min);
        let max_x = boxes
            .iter()
            .map(|b| b.right())
            .fold(f64::NEG_INFINITY, f64::max);
        let max_y = boxes
            .iter()
            .map(|b| b.bottom())
            .fold(f64::NEG_INFINITY, f64::max);
        Margins {
            t: r1(min_y.max(0.0)),
            r: r1((page.w - max_x).max(0.0)),
            b: r1((page.h - max_y).max(0.0)),
            l: r1(min_x.max(0.0)),
        }
    };

    let mut alignments = Vec::new();
    let edges: [(&str, EdgeFn); 6] = [
        ("x", |r| r.x),
        ("x", |r| r.x + r.w / 2.0),
        ("x", |r| r.x + r.w),
        ("y", |r| r.y),
        ("y", |r| r.y + r.h / 2.0),
        ("y", |r| r.y + r.h),
    ];
    for (axis, get) in edges {
        let mut groups: Vec<(f64, Vec<String>)> = Vec::new();
        for b in &blocks {
            let pos = (get(&ctx.scene.items[*b].aabb) * 2.0).round() / 2.0;
            let id = ctx.scene.items[*b].id().to_string();
            match groups.iter_mut().find(|g| (g.0 - pos).abs() <= 0.5) {
                Some(g) => g.1.push(id),
                None => groups.push((pos, vec![id])),
            }
        }
        for (pos, ids) in groups {
            if ids.len() >= 2 {
                alignments.push(Alignment {
                    axis: axis.into(),
                    pos: r1(pos),
                    ids,
                });
            }
        }
    }

    let mut stack: Vec<Rect> = blocks.iter().map(|i| ctx.scene.items[*i].aabb).collect();
    stack.sort_by(|a, b| a.y.total_cmp(&b.y));
    let mut counts: BTreeMap<i64, usize> = BTreeMap::new();
    for w in stack.windows(2) {
        let (p, c) = (w[0], w[1]);
        let overlap_x = (p.right().min(c.right())) - p.x.max(c.x);
        let gap = c.y - p.bottom();
        if overlap_x > 0.0 && gap > 0.0 {
            let k = ((gap / 4.0).round() * 4.0).max(4.0) as i64;
            *counts.entry(k).or_default() += 1;
        }
    }
    let spacing_rhythm = counts
        .into_iter()
        .max_by(|a, b| a.1.cmp(&b.1).then(b.0.cmp(&a.0)))
        .map(|(k, _)| k as f64);
    Grid {
        margins,
        alignments,
        spacing_rhythm,
    }
}

/// Visual weight of every candidate (normalized to the strongest) and the top-12 ranking.
///
/// Surfaces (shapes other content sits on) and containers with children are not ranked themselves: their
/// content carries the weight.
pub fn hierarchy(ctx: &mut Ctx<'_>, grouping: &crate::semantic::Grouping) -> Vec<HierarchyEntry> {
    let page = ctx.scene.page_rect;
    let page_area = ctx.scene.page_area();
    let mut scored: Vec<(usize, f64, String)> = Vec::new();
    for (i, it) in ctx.scene.items.iter().enumerate() {
        if !it.visible {
            continue;
        }
        if let Some(f) = ctx.text(i) {
            if !f.has_content() || visible_area(it) <= 0.0 {
                continue;
            }
            let size = f.style().font_size;
            let (c, reason) = match ctx.contrast[i] {
                Some(c) if !c.unknown => {
                    let c10 = c.ratio.min(10.0) / 10.0;
                    (
                        c10,
                        format!("{}px text, contrast {}:1", r1(size), r1(c10 * 10.0)),
                    )
                }
                _ => (0.6, format!("{}px text on an image", r1(size))),
            };
            let bold = if f.style().font_weight >= 600.0 {
                1.15
            } else {
                1.0
            };
            // Content near the top reads first; a small bonus breaks ties between equal sizes.
            let top_bonus =
                1.0 + 0.08 * (1.0 - (it.aabb.center_y() / page.h.max(1.0)).clamp(0.0, 1.0));
            scored.push((i, size.powf(1.3) * (0.4 + c) * bold * top_bonus, reason));
            continue;
        }
        if it.depth > 2
            || ctx.scene.is_backdrop(i)
            || matches!(it.kind(), NodeType::Audio)
            || !it.children.is_empty()
            || grouping.backings.contains(&i)
            || ctx.elem(i) == crate::semantic::Elem::Other
        {
            continue;
        }
        let a = it
            .visible_box()
            .and_then(|r| r.intersection(&page))
            .map(|r| r.area())
            .unwrap_or(0.0);
        if a <= 0.0 || a >= page_area * 0.85 {
            continue;
        }
        let factor = match it.kind() {
            NodeType::Image | NodeType::Svg | NodeType::Video => 1.1,
            _ => 0.6,
        };
        scored.push((
            i,
            a.sqrt() * factor,
            format!(
                "{} covering {}% of the page",
                it.kind().as_str(),
                (a / page_area * 100.0).round()
            ),
        ));
    }
    scored.sort_by(|a, b| b.1.total_cmp(&a.1).then(a.0.cmp(&b.0)));
    let max = scored.first().map(|s| s.1).unwrap_or(1.0).max(1e-9);
    for (i, s, _) in &scored {
        ctx.weights[*i] = round3(s / max);
    }
    scored
        .into_iter()
        .take(12)
        .enumerate()
        .map(|(k, (i, _, reason))| HierarchyEntry {
            id: ctx.scene.items[i].id().to_string(),
            rank: k + 1,
            reason,
        })
        .collect()
}
