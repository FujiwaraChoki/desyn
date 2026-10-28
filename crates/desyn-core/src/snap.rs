//! Snapping for move and resize gestures: edges / centers of other objects, page edges and center, ruler guides,
//! layout-grid columns and baseline rows, equal-spacing (gap) snapping, size matching, plus smart distance labels.
//!
//! All rectangles are axis-aligned bounds in page coordinates. `threshold` is in design px (screen px / zoom).

use serde::{Deserialize, Serialize};

use crate::geometry::{Point, Rect, node_aabb};
use crate::model::{Design, GuideAxis, Id, Node, NodeType};

/// Axis of a snap line: `X` lines are vertical (constant x), `Y` lines horizontal.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Axis {
    /// Vertical line at x.
    X,
    /// Horizontal line at y.
    Y,
}

/// What produced a snap line.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SnapKind {
    /// Edge of another object.
    Edge,
    /// Center line of another object.
    Center,
    /// Page edge.
    PageEdge,
    /// Page center line.
    PageCenter,
    /// Ruler guide.
    Guide,
    /// Layout grid column / baseline row.
    Grid,
}

/// A snap line to draw.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct SnapGuide {
    /// Axis.
    pub axis: Axis,
    /// Line position (x for `X`, y for `Y`).
    pub pos: f64,
    /// Extent along the line: from.
    pub from: f64,
    /// Extent along the line: to.
    pub to: f64,
    /// Source.
    pub kind: SnapKind,
}

/// Equal-spacing indicator: every listed gap has the same size.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SpacingGuide {
    /// Axis along which the gaps are measured.
    pub axis: Axis,
    /// Gap size.
    pub gap: f64,
    /// Gap segments `(start, end, cross)`: along-axis interval and the cross-axis position to draw at.
    pub segments: Vec<(f64, f64, f64)>,
}

/// A width / height match with another object.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct SizeMatch {
    /// `X` = width, `Y` = height.
    pub axis: Axis,
    /// Matched size.
    pub size: f64,
    /// The matching object's bounds.
    pub with: Rect,
}

/// Result of a snap query.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct SnapResult {
    /// Correction to add to the gesture in x.
    pub dx: f64,
    /// Correction to add to the gesture in y.
    pub dy: f64,
    /// Alignment lines to draw after applying the correction.
    pub guides: Vec<SnapGuide>,
    /// Equal-spacing indicators.
    pub spacing: Vec<SpacingGuide>,
    /// Size matches (resize only).
    pub sizes: Vec<SizeMatch>,
}

/// Snap sources toggles and threshold.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SnapOptions {
    /// Max distance in design px.
    pub threshold: f64,
    /// Snap to other objects.
    pub objects: bool,
    /// Snap to page edges / center.
    pub page: bool,
    /// Snap to ruler guides.
    pub guides: bool,
    /// Snap to the layout grid.
    pub grid: bool,
    /// Equal-spacing snapping.
    pub spacing: bool,
}

impl Default for SnapOptions {
    fn default() -> Self {
        SnapOptions {
            threshold: 6.0,
            objects: true,
            page: true,
            guides: true,
            grid: true,
            spacing: true,
        }
    }
}

/// Everything a gesture can snap to.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapTargets {
    /// Page box (0, 0, w, h).
    pub page: Option<Rect>,
    /// Other objects' bounds.
    pub objects: Vec<Rect>,
    /// Ruler guides `(axis, pos)`.
    pub guides: Vec<(Axis, f64)>,
    /// Layout grid lines `(axis, pos)`.
    pub grid: Vec<(Axis, f64)>,
}

impl SnapTargets {
    /// Targets for moving `exclude` nodes on `page`: visible top-level page children and siblings of the excluded
    /// nodes (when they live inside frames / groups), page box, guides and layout grid. Excluded nodes and their
    /// descendants are never targets.
    pub fn for_page(d: &Design, page: &str, exclude: &[Id]) -> SnapTargets {
        let mut t = SnapTargets::default();
        let Some(Node::Page(pg)) = d.node(page) else {
            return t;
        };
        let (w, h) = (pg.base.width, pg.base.height);
        t.page = Some(Rect::new(0.0, 0.0, w, h));
        if let Some(gs) = &pg.guides {
            t.guides = gs
                .iter()
                .map(|g| {
                    (
                        if g.axis == GuideAxis::X {
                            Axis::X
                        } else {
                            Axis::Y
                        },
                        g.pos,
                    )
                })
                .collect();
        }
        if let Some(grid) = &pg.grid {
            let n = grid.columns.max(1) as f64;
            let cw = (w - 2.0 * grid.margin - grid.gutter * (n - 1.0)) / n;
            // Column lines share the 10,000-line budget with baseline rows below: a hostile column count must not
            // allocate unbounded targets.
            if cw > 0.0 {
                for i in 0..grid.columns.clamp(1, MAX_GRID_LINES as u64 / 2) {
                    let x0 = grid.margin + i as f64 * (cw + grid.gutter);
                    t.grid.push((Axis::X, x0));
                    t.grid.push((Axis::X, x0 + cw));
                }
            }
            if let Some(step) = grid.baseline.filter(|s| *s > 0.0) {
                let mut y = step;
                while y < h && t.grid.len() < MAX_GRID_LINES {
                    t.grid.push((Axis::Y, y));
                    y += step;
                }
            }
        }
        let excluded = |id: &str| exclude.iter().any(|e| d.is_ancestor_or_self(e, id));
        let mut containers: Vec<&str> = vec![page];
        for e in exclude {
            if let Some(p) = d.node(e).and_then(Node::parent)
                && p != page
                && !containers.contains(&p)
            {
                containers.push(p);
            }
        }
        for c in containers {
            let Some(cn) = d.node(c) else { continue };
            if cn.node_type() != NodeType::Page
                && !excluded(c)
                && let Some(r) = node_aabb(d, c)
            {
                t.objects.push(r);
            }
            for id in cn.child_ids() {
                if excluded(id) {
                    continue;
                }
                let Some(n) = d.node(id) else { continue };
                if !n.base().visible {
                    continue;
                }
                if let Some(r) = node_aabb(d, id) {
                    t.objects.push(r);
                }
            }
        }
        t
    }
}

/// Most layout-grid lines (columns plus baseline rows) offered as snap targets.
const MAX_GRID_LINES: usize = 10_000;

struct Line {
    pos: f64,
    kind: SnapKind,
    extent: Option<(f64, f64)>,
}

fn target_lines(t: &SnapTargets, o: &SnapOptions, axis: Axis) -> Vec<Line> {
    let mut out = Vec::new();
    if o.objects {
        for r in &t.objects {
            let (a, b, c0, c1) = match axis {
                Axis::X => (r.x, r.right(), r.y, r.bottom()),
                Axis::Y => (r.y, r.bottom(), r.x, r.right()),
            };
            out.push(Line {
                pos: a,
                kind: SnapKind::Edge,
                extent: Some((c0, c1)),
            });
            out.push(Line {
                pos: (a + b) / 2.0,
                kind: SnapKind::Center,
                extent: Some((c0, c1)),
            });
            out.push(Line {
                pos: b,
                kind: SnapKind::Edge,
                extent: Some((c0, c1)),
            });
        }
    }
    if o.page
        && let Some(p) = t.page
    {
        let (a, b, c0, c1) = match axis {
            Axis::X => (p.x, p.right(), p.y, p.bottom()),
            Axis::Y => (p.y, p.bottom(), p.x, p.right()),
        };
        out.push(Line {
            pos: a,
            kind: SnapKind::PageEdge,
            extent: Some((c0, c1)),
        });
        out.push(Line {
            pos: (a + b) / 2.0,
            kind: SnapKind::PageCenter,
            extent: Some((c0, c1)),
        });
        out.push(Line {
            pos: b,
            kind: SnapKind::PageEdge,
            extent: Some((c0, c1)),
        });
    }
    if o.guides {
        out.extend(t.guides.iter().filter(|g| g.0 == axis).map(|g| Line {
            pos: g.1,
            kind: SnapKind::Guide,
            extent: None,
        }));
    }
    if o.grid {
        out.extend(t.grid.iter().filter(|g| g.0 == axis).map(|g| Line {
            pos: g.1,
            kind: SnapKind::Grid,
            extent: None,
        }));
    }
    out
}

const EPS: f64 = 1e-6;

/// Best correction for one axis given the moving lines; returns `(delta, distance)`.
fn best_delta(moving: &[f64], lines: &[Line], threshold: f64) -> Option<f64> {
    let mut best: Option<f64> = None;
    for m in moving {
        for l in lines {
            let d = l.pos - m;
            if d.abs() <= threshold && best.is_none_or(|b| d.abs() < b.abs() - EPS) {
                best = Some(d);
            }
        }
    }
    best
}

fn guides_for(axis: Axis, moved: &Rect, moving_lines: &[f64], lines: &[Line]) -> Vec<SnapGuide> {
    let (c0, c1) = match axis {
        Axis::X => (moved.y, moved.bottom()),
        Axis::Y => (moved.x, moved.right()),
    };
    let mut out: Vec<SnapGuide> = Vec::new();
    for l in lines {
        if moving_lines.iter().any(|m| (m - l.pos).abs() < 1e-6) {
            let (from, to) = match l.extent {
                Some((a, b)) => (a.min(c0), b.max(c1)),
                None => (c0, c1),
            };
            if let Some(g) = out.iter_mut().find(|g| (g.pos - l.pos).abs() < 1e-6) {
                g.from = g.from.min(from);
                g.to = g.to.max(to);
                // Object alignment is more informative than generic lines.
                if matches!(l.kind, SnapKind::Edge | SnapKind::Center) {
                    g.kind = l.kind;
                }
            } else {
                out.push(SnapGuide {
                    axis,
                    pos: l.pos,
                    from,
                    to,
                    kind: l.kind,
                });
            }
        }
    }
    out
}

fn axis_lines(r: &Rect, axis: Axis) -> [f64; 3] {
    match axis {
        Axis::X => [r.x, r.center_x(), r.right()],
        Axis::Y => [r.y, r.center_y(), r.bottom()],
    }
}

/// Spacing candidates along `axis` for a moving box: returns `(delta, guide)` options.
fn spacing_options(
    m: &Rect,
    objects: &[Rect],
    axis: Axis,
    threshold: f64,
) -> Vec<(f64, SpacingGuide)> {
    let (lo, hi, len) = match axis {
        Axis::X => (m.x, m.right(), m.w),
        Axis::Y => (m.y, m.bottom(), m.h),
    };
    let overlaps_cross = |r: &Rect| match axis {
        Axis::X => r.y < m.bottom() && m.y < r.bottom(),
        Axis::Y => r.x < m.right() && m.x < r.right(),
    };
    let start = |r: &Rect| if axis == Axis::X { r.x } else { r.y };
    let end = |r: &Rect| {
        if axis == Axis::X {
            r.right()
        } else {
            r.bottom()
        }
    };
    let cross_mid = |a: &Rect, b: &Rect| match axis {
        Axis::X => (a.y.max(b.y) + a.bottom().min(b.bottom())) / 2.0,
        Axis::Y => (a.x.max(b.x) + a.right().min(b.right())) / 2.0,
    };
    let mut row: Vec<&Rect> = objects.iter().filter(|r| overlaps_cross(r)).collect();
    row.sort_by(|a, b| start(a).total_cmp(&start(b)));
    // Existing gaps between consecutive non-overlapping row members.
    let mut gaps: Vec<(f64, &Rect, &Rect)> = Vec::new();
    for w in row.windows(2) {
        let g = start(w[1]) - end(w[0]);
        if g > EPS {
            gaps.push((g, w[0], w[1]));
        }
    }
    let left = row
        .iter()
        .filter(|r| end(r) <= lo + threshold)
        .max_by(|a, b| end(a).total_cmp(&end(b)))
        .copied();
    let right = row
        .iter()
        .filter(|r| start(r) >= hi - threshold)
        .min_by(|a, b| start(a).total_cmp(&start(b)))
        .copied();
    let mut out = Vec::new();
    let make = |gap: f64, pairs: Vec<(f64, f64, f64)>| SpacingGuide {
        axis,
        gap,
        segments: pairs,
    };
    if let Some(a) = left {
        for (g, p, q) in &gaps {
            let target = end(a) + g;
            let d = target - lo;
            if d.abs() <= threshold {
                out.push((
                    d,
                    make(
                        *g,
                        vec![
                            (end(p), start(q), cross_mid(p, q)),
                            (end(a), target, cross_mid(a, m)),
                        ],
                    ),
                ));
            }
        }
    }
    if let Some(b) = right {
        for (g, p, q) in &gaps {
            let target = start(b) - g;
            let d = target - hi;
            if d.abs() <= threshold {
                out.push((
                    d,
                    make(
                        *g,
                        vec![
                            (end(p), start(q), cross_mid(p, q)),
                            (target, start(b), cross_mid(b, m)),
                        ],
                    ),
                ));
            }
        }
    }
    if let (Some(a), Some(b)) = (left, right) {
        let free = start(b) - end(a) - len;
        if free > 0.0 {
            let target = end(a) + free / 2.0;
            let d = target - lo;
            if d.abs() <= threshold {
                let g = free / 2.0;
                out.push((
                    d,
                    make(
                        g,
                        vec![
                            (end(a), end(a) + g, cross_mid(a, m)),
                            (start(b) - g, start(b), cross_mid(b, m)),
                        ],
                    ),
                ));
            }
        }
    }
    out
}

fn resolve_axis(
    m: &Rect,
    t: &SnapTargets,
    o: &SnapOptions,
    axis: Axis,
    moving_lines: &[f64],
) -> (f64, Option<SpacingGuide>) {
    let lines = target_lines(t, o, axis);
    let align = best_delta(moving_lines, &lines, o.threshold);
    let spacing = if o.spacing && o.objects {
        spacing_options(m, &t.objects, axis, o.threshold)
    } else {
        Vec::new()
    };
    let best_spacing = spacing
        .into_iter()
        .min_by(|a, b| a.0.abs().total_cmp(&b.0.abs()));
    match (align, best_spacing) {
        (Some(a), Some((s, g))) if s.abs() < a.abs() - EPS => (s, Some(g)),
        (Some(a), Some((s, g))) if (s - a).abs() < EPS => (a, Some(g)),
        (Some(a), _) => (a, None),
        (None, Some((s, g))) => (s, Some(g)),
        (None, None) => (0.0, None),
    }
}

/// Snaps a moving selection (`moving` = its bounds after the raw drag delta) to the targets.
pub fn snap_move(moving: Rect, t: &SnapTargets, o: &SnapOptions) -> SnapResult {
    let (dx, sx) = resolve_axis(&moving, t, o, Axis::X, &axis_lines(&moving, Axis::X));
    let (dy, sy) = resolve_axis(&moving, t, o, Axis::Y, &axis_lines(&moving, Axis::Y));
    let moved = moving.translate(dx, dy);
    let mut guides = Vec::new();
    for axis in [Axis::X, Axis::Y] {
        let lines = target_lines(t, o, axis);
        guides.extend(guides_for(axis, &moved, &axis_lines(&moved, axis), &lines));
    }
    SnapResult {
        dx,
        dy,
        guides,
        spacing: sx.into_iter().chain(sy).collect(),
        sizes: Vec::new(),
    }
}

/// Which edges a resize gesture moves.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct ResizeEdges {
    /// Left edge moves.
    pub left: bool,
    /// Right edge moves.
    pub right: bool,
    /// Top edge moves.
    pub top: bool,
    /// Bottom edge moves.
    pub bottom: bool,
}

/// Snaps the moving edges of a resize (`moving` = bounds after the raw drag). `dx` / `dy` are corrections for the
/// moving edge on each axis (apply to the left or right edge, whichever moves). Also reports width / height matches
/// with other objects within the threshold.
pub fn snap_resize(
    moving: Rect,
    edges: ResizeEdges,
    t: &SnapTargets,
    o: &SnapOptions,
) -> SnapResult {
    let mut res = SnapResult::default();
    for axis in [Axis::X, Axis::Y] {
        let (lo_moves, hi_moves) = match axis {
            Axis::X => (edges.left, edges.right),
            Axis::Y => (edges.top, edges.bottom),
        };
        if !lo_moves && !hi_moves {
            continue;
        }
        let [lo, _, hi] = axis_lines(&moving, axis);
        let mut lines_m = Vec::new();
        if lo_moves {
            lines_m.push(lo);
        }
        if hi_moves {
            lines_m.push(hi);
        }
        let lines = target_lines(t, o, axis);
        let mut delta = best_delta(&lines_m, &lines, o.threshold);
        // Size matching only when one edge moves.
        let size = hi - lo;
        if lo_moves != hi_moves && o.objects {
            let sign = if hi_moves { 1.0 } else { -1.0 };
            for r in &t.objects {
                let other = if axis == Axis::X { r.w } else { r.h };
                let d = (other - size) * sign;
                if d.abs() <= o.threshold && delta.is_none_or(|b| d.abs() < b.abs() - EPS) {
                    delta = Some(d);
                }
            }
        }
        let d = delta.unwrap_or(0.0);
        match axis {
            Axis::X => res.dx = d,
            Axis::Y => res.dy = d,
        }
    }
    let mut moved = moving;
    if edges.left {
        moved.x += res.dx;
        moved.w -= res.dx;
    } else if edges.right {
        moved.w += res.dx;
    }
    if edges.top {
        moved.y += res.dy;
        moved.h -= res.dy;
    } else if edges.bottom {
        moved.h += res.dy;
    }
    for axis in [Axis::X, Axis::Y] {
        let [lo, _, hi] = axis_lines(&moved, axis);
        let mut ml = Vec::new();
        match axis {
            Axis::X => {
                if edges.left {
                    ml.push(lo);
                }
                if edges.right {
                    ml.push(hi);
                }
            }
            Axis::Y => {
                if edges.top {
                    ml.push(lo);
                }
                if edges.bottom {
                    ml.push(hi);
                }
            }
        }
        res.guides
            .extend(guides_for(axis, &moved, &ml, &target_lines(t, o, axis)));
        if o.objects {
            let size = hi - lo;
            for r in &t.objects {
                let other = if axis == Axis::X { r.w } else { r.h };
                if (other - size).abs() < 1e-6 && !ml.is_empty() {
                    res.sizes.push(SizeMatch {
                        axis,
                        size,
                        with: *r,
                    });
                }
            }
        }
    }
    res
}

/// A measured distance to draw (smart distances while dragging / alt-hovering).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct DistanceLabel {
    /// Segment start.
    pub from: Point,
    /// Segment end.
    pub to: Point,
    /// Distance in design px.
    pub value: f64,
}

/// Distances from `moving` to the nearest object in each direction (left, right, up, down) among those overlapping
/// it on the cross axis; falls back to the page edges when nothing is in that direction. When `moving` is inside an
/// object (e.g. its frame), distances to that object's inner edges are reported instead.
pub fn distance_labels(moving: Rect, objects: &[Rect], page: Option<Rect>) -> Vec<DistanceLabel> {
    let mut out = Vec::new();
    let cy = moving.center_y();
    let cx = moving.center_x();
    let container = objects
        .iter()
        .filter(|r| r.contains_rect(&moving) && **r != moving)
        .min_by(|a, b| a.area().total_cmp(&b.area()))
        .copied()
        .or(page);
    let vert_overlap = |r: &Rect| r.y < moving.bottom() && moving.y < r.bottom();
    let horiz_overlap = |r: &Rect| r.x < moving.right() && moving.x < r.right();
    // Left.
    let left = objects
        .iter()
        .filter(|r| vert_overlap(r) && r.right() <= moving.x)
        .map(|r| r.right())
        .fold(f64::NEG_INFINITY, f64::max);
    let left = if left.is_finite() {
        Some(left)
    } else {
        container.map(|c| c.x)
    };
    if let Some(l) = left.filter(|l| *l < moving.x) {
        out.push(DistanceLabel {
            from: Point::new(l, cy),
            to: Point::new(moving.x, cy),
            value: moving.x - l,
        });
    }
    let right = objects
        .iter()
        .filter(|r| vert_overlap(r) && r.x >= moving.right())
        .map(|r| r.x)
        .fold(f64::INFINITY, f64::min);
    let right = if right.is_finite() {
        Some(right)
    } else {
        container.map(|c| c.right())
    };
    if let Some(r) = right.filter(|r| *r > moving.right()) {
        out.push(DistanceLabel {
            from: Point::new(moving.right(), cy),
            to: Point::new(r, cy),
            value: r - moving.right(),
        });
    }
    let up = objects
        .iter()
        .filter(|r| horiz_overlap(r) && r.bottom() <= moving.y)
        .map(|r| r.bottom())
        .fold(f64::NEG_INFINITY, f64::max);
    let up = if up.is_finite() {
        Some(up)
    } else {
        container.map(|c| c.y)
    };
    if let Some(u) = up.filter(|u| *u < moving.y) {
        out.push(DistanceLabel {
            from: Point::new(cx, u),
            to: Point::new(cx, moving.y),
            value: moving.y - u,
        });
    }
    let down = objects
        .iter()
        .filter(|r| horiz_overlap(r) && r.y >= moving.bottom())
        .map(|r| r.y)
        .fold(f64::INFINITY, f64::min);
    let down = if down.is_finite() {
        Some(down)
    } else {
        container.map(|c| c.bottom())
    };
    if let Some(dn) = down.filter(|dn| *dn > moving.bottom()) {
        out.push(DistanceLabel {
            from: Point::new(cx, moving.bottom()),
            to: Point::new(cx, dn),
            value: dn - moving.bottom(),
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn targets(objects: Vec<Rect>) -> SnapTargets {
        SnapTargets {
            page: Some(Rect::new(0.0, 0.0, 1000.0, 1000.0)),
            objects,
            guides: vec![(Axis::X, 333.0)],
            grid: vec![],
        }
    }

    #[test]
    fn edge_center_and_page() {
        let t = targets(vec![Rect::new(100.0, 100.0, 100.0, 100.0)]);
        let o = SnapOptions::default();
        // Left edge 4px right of the object's right edge -> snaps by -4.
        let r = snap_move(Rect::new(204.0, 300.0, 50.0, 50.0), &t, &o);
        assert_eq!(r.dx, -4.0);
        assert!(
            r.guides
                .iter()
                .any(|g| g.axis == Axis::X && g.pos == 200.0 && g.from == 100.0 && g.to == 350.0)
        );
        // Center to page center.
        let r = snap_move(Rect::new(473.0, 700.0, 50.0, 50.0), &t, &o);
        assert_eq!(r.dx, 2.0);
        assert!(r.guides.iter().any(|g| g.kind == SnapKind::PageCenter));
        // Guide.
        let r = snap_move(Rect::new(335.0, 700.0, 50.0, 50.0), &t, &o);
        assert_eq!(r.dx, -2.0);
        // Nothing within threshold.
        let r = snap_move(
            Rect::new(600.0, 600.0, 51.0, 51.0),
            &t,
            &SnapOptions { page: false, ..o },
        );
        assert_eq!((r.dx, r.dy), (0.0, 0.0));
        assert!(r.guides.is_empty());
    }

    #[test]
    fn equal_spacing() {
        // Two boxes 50 apart; moving box to the right of the second should snap to the same 50 gap.
        let t = SnapTargets {
            page: None,
            objects: vec![
                Rect::new(0.0, 0.0, 100.0, 100.0),
                Rect::new(150.0, 0.0, 100.0, 100.0),
            ],
            guides: vec![],
            grid: vec![],
        };
        let o = SnapOptions {
            page: false,
            ..SnapOptions::default()
        };
        let r = snap_move(Rect::new(303.0, 10.0, 80.0, 80.0), &t, &o);
        assert_eq!(r.dx, -3.0);
        assert_eq!(r.spacing.len(), 1);
        assert_eq!(r.spacing[0].gap, 50.0);
        // Centered between two boxes.
        let t = SnapTargets {
            page: None,
            objects: vec![
                Rect::new(0.0, 0.0, 100.0, 100.0),
                Rect::new(300.0, 0.0, 100.0, 100.0),
            ],
            guides: vec![],
            grid: vec![],
        };
        let r = snap_move(Rect::new(152.0, 300.0, 100.0, 100.0), &t, &o);
        assert_eq!(r.dx, 0.0, "no cross-axis overlap: spacing does not apply");
        let r = snap_move(Rect::new(153.0, 10.0, 96.0, 80.0), &t, &o);
        assert_eq!(r.dx, -1.0);
        assert!(r.spacing.iter().any(|s| (s.gap - 52.0).abs() < 1e-9));
    }

    #[test]
    fn resize_and_size_match() {
        let t = SnapTargets {
            page: None,
            objects: vec![Rect::new(0.0, 500.0, 120.0, 40.0)],
            guides: vec![],
            grid: vec![],
        };
        let o = SnapOptions::default();
        let r = snap_resize(
            Rect::new(200.0, 0.0, 117.0, 50.0),
            ResizeEdges {
                right: true,
                ..Default::default()
            },
            &t,
            &o,
        );
        assert_eq!(r.dx, 3.0);
        assert_eq!(r.sizes.len(), 1);
        let r = snap_resize(
            Rect::new(3.0, 0.0, 50.0, 50.0),
            ResizeEdges {
                left: true,
                ..Default::default()
            },
            &t,
            &o,
        );
        assert_eq!(r.dx, -3.0);
    }

    #[test]
    fn distances() {
        let objects = vec![
            Rect::new(0.0, 0.0, 100.0, 100.0),
            Rect::new(300.0, 0.0, 100.0, 100.0),
        ];
        let labels = distance_labels(
            Rect::new(150.0, 25.0, 50.0, 50.0),
            &objects,
            Some(Rect::new(0.0, 0.0, 500.0, 500.0)),
        );
        let values: Vec<f64> = labels.iter().map(|l| l.value).collect();
        assert_eq!(values, vec![50.0, 100.0, 25.0, 425.0]);
    }
}
