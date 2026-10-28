//! Tables: column / row sizes scaled to the node box, header and stripe tints, cell fills, wrapped and aligned
//! cell text (clipped to its cell), merged cells and a border grid drawn as one path (no doubled joints).

use std::sync::Arc;

use desyn_core::geometry::Rect;
use desyn_core::model::{BlendMode, CellAlign, Color, Fill, TableNode, TextAlign, VerticalAlign};
use desyn_core::paths::kurbo::{self, BezPath, Shape as _};

use super::build::DisplayListBuilder;
use super::chart::Label;
use super::{Clip, FillItem, FillRule, Item};
use crate::geom::{bez_to_path, path_bounds};
use crate::paint::{Color4, Paint};

const MAX_ROWS: usize = 2000;
const MAX_COLS: usize = 200;

/// Sizes scaled so they sum to `total` (missing / invalid entries share what is left equally).
fn sizes(given: &[f64], n: usize, total: f64) -> Vec<f64> {
    let mut v: Vec<Option<f64>> = (0..n)
        .map(|i| given.get(i).copied().filter(|x| x.is_finite() && *x > 0.0))
        .collect();
    let known: f64 = v.iter().flatten().sum();
    let missing = v.iter().filter(|x| x.is_none()).count();
    let fill = if missing > 0 {
        ((total - known) / missing as f64).max(if known > 0.0 {
            known / (n - missing).max(1) as f64
        } else {
            total / n as f64
        })
    } else {
        0.0
    };
    for x in v.iter_mut() {
        if x.is_none() {
            *x = Some(fill.max(1.0));
        }
    }
    let sum: f64 = v.iter().flatten().sum();
    let k = if sum > 0.0 { total / sum } else { 1.0 };
    v.into_iter().map(|x| x.unwrap_or(0.0) * k).collect()
}

fn solid_fill(path: BezPath, color: Color4) -> Option<Item> {
    let p = bez_to_path(&path)?;
    Some(Item::Fill(FillItem {
        bounds: path_bounds(&p),
        path: Arc::new(p),
        rule: FillRule::Nonzero,
        paint: Paint::Solid(color),
        opacity: 1.0,
        blend: BlendMode::Normal,
    }))
}

impl DisplayListBuilder<'_> {
    /// Items of a table node.
    pub(super) fn table_items(&mut self, t: &TableNode) -> Vec<Item> {
        let (w, h) = (t.base.width.max(0.0), t.base.height.max(0.0));
        let rows = usize::try_from(t.rows).unwrap_or(MAX_ROWS).min(MAX_ROWS);
        let cols = usize::try_from(t.cols).unwrap_or(MAX_COLS).min(MAX_COLS);
        if rows == 0 || cols == 0 || !(w > 0.0 && h > 0.0) {
            return Vec::new();
        }
        let cw = sizes(&t.col_widths, cols, w);
        let rh = sizes(&t.row_heights, rows, h);
        let mut xs = vec![0.0; cols + 1];
        for i in 0..cols {
            xs[i + 1] = xs[i] + cw[i];
        }
        let mut ys = vec![0.0; rows + 1];
        for i in 0..rows {
            ys[i + 1] = ys[i] + rh[i];
        }
        // Anchor (top-left cell of its span) of every grid position.
        let mut anchor: Vec<Option<(usize, usize)>> = vec![None; rows * cols];
        let mut cells: Vec<(usize, usize, usize, usize, usize)> = Vec::new(); // r, c, rs, cs, index
        for (idx, cell) in t.cells.iter().enumerate() {
            let (Ok(r), Ok(c)) = (usize::try_from(cell.r), usize::try_from(cell.c)) else {
                continue;
            };
            if r >= rows || c >= cols || anchor[r * cols + c].is_some() {
                continue;
            }
            let rs = cell
                .rowspan
                .and_then(|v| usize::try_from(v).ok())
                .unwrap_or(1)
                .clamp(1, rows - r);
            let cs = cell
                .colspan
                .and_then(|v| usize::try_from(v).ok())
                .unwrap_or(1)
                .clamp(1, cols - c);
            for rr in r..r + rs {
                for cc in c..c + cs {
                    if anchor[rr * cols + cc].is_none() {
                        anchor[rr * cols + cc] = Some((r, c));
                    }
                }
            }
            cells.push((r, c, rs, cs, idx));
        }
        let text_color = t
            .default_style
            .fills
            .iter()
            .find_map(|f| match f {
                Fill::Solid(s) => crate::paint::resolve(&s.color, &self.design.styles),
                _ => None,
            })
            .unwrap_or(Color4::parse_hex("#111111").expect("valid"));
        let mut out = Vec::new();
        // Row tints.
        for r in 0..rows {
            let tint = if t.header && r == 0 {
                Some(text_color.with_alpha_mul(0.08))
            } else if t.stripe && (r + usize::from(!t.header)) % 2 == 0 {
                Some(text_color.with_alpha_mul(0.04))
            } else {
                None
            };
            if let Some(c) = tint {
                out.extend(solid_fill(
                    kurbo::Rect::new(0.0, ys[r], w, ys[r + 1]).to_path(0.1),
                    c,
                ));
            }
        }
        // Cell fills.
        for &(r, c, rs, cs, idx) in &cells {
            let Some(f) = &t.cells[idx].fill else {
                continue;
            };
            let rect = Rect::new(xs[c], ys[r], xs[c + cs] - xs[c], ys[r + rs] - ys[r]);
            if let Some(path) = crate::geom::rect_path(&rect) {
                let shape = super::shapes::Shape::rect_like(path, rect.w, rect.h, [0.0; 4], 0.0)
                    .translated_box(rect.x, rect.y);
                out.extend(self.fill_items(
                    &shape,
                    std::slice::from_ref(f),
                    rect.w,
                    rect.h,
                    (rect.x, rect.y),
                ));
            }
        }
        // Cell text.
        let pad = if t.cell_padding.is_finite() {
            t.cell_padding.max(0.0)
        } else {
            0.0
        };
        for &(r, c, rs, cs, idx) in &cells {
            let cell = &t.cells[idx];
            if cell.text.is_empty() {
                continue;
            }
            let rect = Rect::new(xs[c], ys[r], xs[c + cs] - xs[c], ys[r + rs] - ys[r]);
            let inner = Rect::new(
                rect.x + pad,
                rect.y + pad,
                (rect.w - 2.0 * pad).max(1.0),
                (rect.h - 2.0 * pad).max(1.0),
            );
            let mut style = match &cell.style {
                Some(p) => t.default_style.merged(p),
                None => t.default_style.clone(),
            };
            if t.header && r == 0 && cell.style.as_ref().and_then(|s| s.font_weight).is_none() {
                style.font_weight = style.font_weight.max(600.0);
            }
            if style.fills.is_empty() {
                style.fills = vec![Fill::solid(Color::new("#111111").expect("valid"))];
            }
            let align = match cell.align {
                Some(CellAlign::Center) => TextAlign::Center,
                Some(CellAlign::Right) => TextAlign::Right,
                _ => TextAlign::Left,
            };
            if let Some(Item::Layer(mut l)) = self.label(Label {
                text: &cell.text,
                style,
                align,
                valign: VerticalAlign::Middle,
                rect: inner,
                single_line: false,
            }) {
                let clip_rect = Rect::new(
                    rect.x - l.transform.e,
                    rect.y - l.transform.f,
                    rect.w,
                    rect.h,
                );
                l.clip = crate::geom::rect_path(&clip_rect).map(|p| Clip {
                    path: Arc::new(p),
                    rule: FillRule::Nonzero,
                    rect: Some(clip_rect),
                });
                l.update_bounds();
                out.push(Item::Layer(l));
            }
        }
        // Borders: grid segments that do not cross a merged cell, as filled bars in one path.
        let bw = if t.border_width.is_finite() {
            t.border_width.clamp(0.0, 1000.0)
        } else {
            0.0
        };
        if bw > 0.0 {
            let half = bw / 2.0;
            let mut grid = BezPath::new();
            let same = |a: Option<(usize, usize)>, b: Option<(usize, usize)>| a.is_some() && a == b;
            for r in 0..=rows {
                let mut start: Option<usize> = None;
                for c in 0..=cols {
                    let draw = c < cols
                        && (r == 0
                            || r == rows
                            || !same(anchor[(r - 1) * cols + c], anchor[r * cols + c]));
                    match (draw, start) {
                        (true, None) => start = Some(c),
                        (false, Some(s)) => {
                            grid.extend(
                                kurbo::Rect::new(
                                    xs[s] - half,
                                    ys[r] - half,
                                    xs[c] + half,
                                    ys[r] + half,
                                )
                                .to_path(0.1),
                            );
                            start = None;
                        }
                        _ => {}
                    }
                }
            }
            for c in 0..=cols {
                let mut start: Option<usize> = None;
                for r in 0..=rows {
                    let draw = r < rows
                        && (c == 0
                            || c == cols
                            || !same(anchor[r * cols + c - 1], anchor[r * cols + c]));
                    match (draw, start) {
                        (true, None) => start = Some(r),
                        (false, Some(s)) => {
                            grid.extend(
                                kurbo::Rect::new(
                                    xs[c] - half,
                                    ys[s] - half,
                                    xs[c] + half,
                                    ys[r] + half,
                                )
                                .to_path(0.1),
                            );
                            start = None;
                        }
                        _ => {}
                    }
                }
            }
            out.extend(solid_fill(grid, Color4::from_color(&t.border_color)));
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sizes_scale_and_fill_missing() {
        assert_eq!(sizes(&[100.0, 100.0], 2, 400.0), vec![200.0, 200.0]);
        let v = sizes(&[100.0], 3, 300.0);
        assert!((v.iter().sum::<f64>() - 300.0).abs() < 1e-9);
        assert_eq!(v.len(), 3);
    }
}
