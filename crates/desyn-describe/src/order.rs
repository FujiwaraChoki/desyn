//! Reading order: recursive XY-cut over reading units (clusters from the grouping step), top-to-bottom bands
//! first, then columns left-to-right (right-to-left for RTL pages); overlapping units read back-to-front (an
//! overlay caption after its photo). Containers expand into their own units; only content leaves are listed.

use desyn_core::NodeType;
use desyn_core::geometry::Rect;

use crate::ctx::Ctx;
use crate::semantic::Grouping;
use crate::types::Direction;

/// Content ids in reading order.
pub fn reading_order(ctx: &Ctx<'_>, grouping: &Grouping, dir: Direction) -> Vec<String> {
    let mut out = Vec::new();
    let mut stack: Vec<Option<usize>> = Vec::new();
    expand(ctx, grouping, None, dir, &mut out, &mut stack);
    out.into_iter()
        .map(|i| ctx.scene.items[i].id().to_string())
        .collect()
}

fn is_readable_leaf(ctx: &Ctx<'_>, i: usize) -> bool {
    let it = &ctx.scene.items[i];
    match it.kind() {
        NodeType::Text => ctx.text(i).is_some_and(|f| f.has_content()),
        NodeType::Image
        | NodeType::Svg
        | NodeType::Video
        | NodeType::Chart
        | NodeType::Table
        | NodeType::Qr => true,
        _ => false,
    }
}

fn expand(
    ctx: &Ctx<'_>,
    grouping: &Grouping,
    parent: Option<usize>,
    dir: Direction,
    out: &mut Vec<usize>,
    stack: &mut Vec<Option<usize>>,
) {
    // Bounded recursion: deep documents stop expanding (their leaves are still reachable through the tree).
    if stack.len() > 64 {
        return;
    }
    stack.push(parent);
    let units: Vec<Vec<usize>> = grouping.units.get(&parent).cloned().unwrap_or_default();
    let auto = parent.and_then(|p| ctx.scene.items[p].node.layout().cloned());
    let ordered: Vec<Vec<usize>> = if let Some(layout) = auto {
        // Auto-layout order is the reading order (reversed layouts read last-to-first).
        let mut u = units;
        if layout.reverse == Some(true) {
            u.reverse();
        }
        u
    } else {
        let boxes: Vec<(usize, Rect, usize)> = units
            .iter()
            .enumerate()
            .filter_map(|(k, u)| ctx.union_box(u).map(|r| (k, r, ctx.scene.items[u[0]].z)))
            .collect();
        xy_cut(&boxes, dir)
            .into_iter()
            .map(|k| units[k].clone())
            .collect()
    };
    for unit in ordered {
        let members: Vec<usize> = if unit.len() > 1 {
            let boxes: Vec<(usize, Rect, usize)> = unit
                .iter()
                .enumerate()
                .map(|(k, m)| (k, ctx.bounds(*m), ctx.scene.items[*m].z))
                .collect();
            xy_cut(&boxes, dir).into_iter().map(|k| unit[k]).collect()
        } else {
            unit
        };
        for m in members {
            if !ctx.scene.items[m].children.is_empty() {
                expand(ctx, grouping, Some(m), dir, out, stack);
            } else if is_readable_leaf(ctx, m) && ctx.scene.items[m].visible {
                out.push(m);
            }
        }
    }
    stack.pop();
}

/// Recursive XY-cut. Returns positions into `boxes` (`(key, rect, z)`).
pub fn xy_cut(boxes: &[(usize, Rect, usize)], dir: Direction) -> Vec<usize> {
    let mut out = Vec::with_capacity(boxes.len());
    let mut work: Vec<Vec<usize>> = vec![(0..boxes.len()).collect()];
    // Iterative: a stack of pending sets, emitted in order.
    let mut emitted: Vec<Vec<usize>> = Vec::new();
    while let Some(set) = work.pop() {
        if set.len() <= 1 {
            emitted.push(set);
            continue;
        }
        if let Some(bands) = split(boxes, &set, true) {
            // Push in reverse so the first band is processed first.
            for b in bands.into_iter().rev() {
                work.push(b);
            }
            continue;
        }
        if let Some(mut cols) = split(boxes, &set, false) {
            if dir == Direction::Rtl {
                cols.reverse();
            }
            for c in cols.into_iter().rev() {
                work.push(c);
            }
            continue;
        }
        // No clean cut: overlapping units read back-to-front.
        let mut s = set;
        s.sort_by_key(|k| boxes[*k].2);
        for k in s {
            emitted.push(vec![k]);
        }
    }
    for e in emitted {
        out.extend(e.into_iter().map(|k| boxes[k].0));
    }
    out
}

/// Splits a set along y (`horizontal_bands`) or x at whitespace gaps of the projection; `None` without a gap.
fn split(
    boxes: &[(usize, Rect, usize)],
    set: &[usize],
    horizontal_bands: bool,
) -> Option<Vec<Vec<usize>>> {
    let span = |k: usize| {
        let r = boxes[k].1;
        if horizontal_bands {
            (r.y, r.bottom())
        } else {
            (r.x, r.right())
        }
    };
    let mut sorted: Vec<usize> = set.to_vec();
    sorted.sort_by(|a, b| {
        span(*a)
            .0
            .total_cmp(&span(*b).0)
            .then(boxes[*a].2.cmp(&boxes[*b].2))
    });
    let mut parts: Vec<Vec<usize>> = vec![Vec::new()];
    let mut end = f64::NEG_INFINITY;
    for k in sorted {
        let (s, e) = span(k);
        // Small overlaps (descenders, shadows) still count as a gap.
        let slack = ((e - s) * 0.1).min(4.0);
        if !parts.last().expect("part").is_empty() && s >= end - slack {
            parts.push(Vec::new());
        }
        parts.last_mut().expect("part").push(k);
        end = end.max(e);
    }
    (parts.len() > 1).then_some(parts)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn columns_then_rows() {
        // Two columns: left has rows 0 and 1, right has rows 2 and 3.
        let b = vec![
            (0, Rect::new(0.0, 0.0, 100.0, 20.0), 0),
            (1, Rect::new(0.0, 30.0, 100.0, 20.0), 1),
            (2, Rect::new(200.0, 0.0, 100.0, 60.0), 2),
            (3, Rect::new(0.0, 100.0, 300.0, 20.0), 3),
        ];
        assert_eq!(xy_cut(&b, Direction::Ltr), vec![0, 1, 2, 3]);
        assert_eq!(xy_cut(&b, Direction::Rtl), vec![2, 0, 1, 3]);
    }

    #[test]
    fn overlaps_read_back_to_front() {
        let b = vec![
            (7, Rect::new(10.0, 10.0, 50.0, 50.0), 5),
            (8, Rect::new(0.0, 0.0, 100.0, 100.0), 1),
        ];
        assert_eq!(xy_cut(&b, Direction::Ltr), vec![8, 7]);
    }
}
