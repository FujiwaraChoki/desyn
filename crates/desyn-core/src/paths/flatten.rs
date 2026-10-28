//! Flattening curves to polylines.

use kurbo::{BezPath, PathEl};
use serde::{Deserialize, Serialize};

use crate::geometry::{Point, point_polyline_distance};
use crate::model::FillRule;

/// One flattened sub-path.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Polyline {
    /// Points (the closing point is not repeated for closed sub-paths).
    pub points: Vec<Point>,
    /// Whether the sub-path was closed with `Z`.
    pub closed: bool,
}

/// Flattening tolerance never goes below this fraction of the path's extent, so the segment count per curve stays
/// bounded (about a thousand) however large the coordinates are.
pub(crate) const RELATIVE_TOLERANCE: f64 = 1e-6;

/// Largest coordinate magnitude the geometry helpers process. Paths reaching beyond it (only possible in hostile or
/// corrupt documents) are treated as empty: `i_overlay` rejects coordinates above 2^500, and nothing that large is
/// drawable anyway.
pub const MAX_COORDINATE: f64 = 1e150;

/// Upper bound on the points one [`flatten_bez`] call produces; above it the tolerance is coarsened.
const MAX_FLATTEN_POINTS: usize = 1 << 20;

/// Largest side of the path's control box, or `None` when a coordinate is not finite or beyond
/// [`MAX_COORDINATE`].
pub(crate) fn path_extent(path: &BezPath) -> Option<f64> {
    if path.elements().is_empty() {
        return Some(0.0);
    }
    let b = path.control_box();
    let in_range = |v: f64| v.is_finite() && v.abs() <= MAX_COORDINATE;
    if [b.x0, b.y0, b.x1, b.y1].into_iter().all(in_range) {
        Some(b.width().max(b.height()))
    } else {
        None
    }
}

/// The tolerance actually used for `path`: at least `floor`, at least [`RELATIVE_TOLERANCE`] of `extent`.
pub(crate) fn effective_tolerance(tolerance: f64, floor: f64, extent: f64) -> f64 {
    let t = if tolerance.is_finite() {
        tolerance
    } else {
        floor
    };
    t.max(floor).max(extent * RELATIVE_TOLERANCE)
}

/// Flattens a path into polylines; `tolerance` is the maximum distance between curve and polyline. The tolerance is
/// raised for huge paths (never below 1e-6 of the path extent) and when the output would exceed about a million points, and
/// paths with non-finite or out-of-range coordinates ([`MAX_COORDINATE`]) flatten to nothing, so hostile documents
/// cannot exhaust time or memory.
pub fn flatten_bez(path: &BezPath, tolerance: f64) -> Vec<Polyline> {
    let Some(extent) = path_extent(path) else {
        return Vec::new();
    };
    let mut tol = effective_tolerance(tolerance, 1e-6, extent);
    loop {
        match flatten_bounded(path, tol) {
            Some(out) => return out,
            None => tol *= 16.0,
        }
    }
}

/// One flattening pass; `None` when the point budget is exceeded.
fn flatten_bounded(path: &BezPath, tol: f64) -> Option<Vec<Polyline>> {
    let mut out: Vec<Polyline> = Vec::new();
    let mut cur: Vec<Point> = Vec::new();
    let mut total = 0usize;
    let finish = |cur: &mut Vec<Point>, closed: bool, out: &mut Vec<Polyline>| {
        if cur.len() > 1 && closed && cur.first() == cur.last() {
            cur.pop();
        }
        if cur.len() >= 2 {
            out.push(Polyline {
                points: std::mem::take(cur),
                closed,
            });
        } else {
            cur.clear();
        }
    };
    let mut overflow = false;
    kurbo::flatten(path.elements().iter().copied(), tol, |el| {
        if overflow {
            return;
        }
        total += 1;
        if total > MAX_FLATTEN_POINTS {
            overflow = true;
            return;
        }
        match el {
            PathEl::MoveTo(p) => {
                finish(&mut cur, false, &mut out);
                cur.push(Point::new(p.x, p.y));
            }
            PathEl::LineTo(p) => cur.push(Point::new(p.x, p.y)),
            PathEl::ClosePath => {
                let start = cur.first().copied();
                finish(&mut cur, true, &mut out);
                // A drawing command after Z continues from the sub-path start.
                if let Some(s) = start {
                    cur.push(s);
                }
            }
            PathEl::QuadTo(..) | PathEl::CurveTo(..) => {}
        }
    });
    if overflow {
        return None;
    }
    // A trailing lone point left by `Z` handling is not a sub-path.
    if cur.len() > 1 {
        out.push(Polyline {
            points: cur,
            closed: false,
        });
    }
    Some(out)
}

/// Fill containment of a point against flattened sub-paths (open sub-paths are closed implicitly, as SVG fills do).
pub fn polylines_contain(polys: &[Polyline], p: Point, rule: FillRule) -> bool {
    let mut winding = 0i32;
    for poly in polys {
        if poly.points.len() >= 3 {
            winding += crate::geometry::winding_number(p, &poly.points);
        }
    }
    match rule {
        FillRule::Nonzero => winding != 0,
        FillRule::Evenodd => winding % 2 != 0,
    }
}

/// Distance from a point to the nearest polyline edge.
pub fn polylines_distance(polys: &[Polyline], p: Point) -> f64 {
    polys
        .iter()
        .map(|poly| point_polyline_distance(p, &poly.points, poly.closed))
        .fold(f64::INFINITY, f64::min)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flatten_circle() {
        let c = kurbo::Shape::to_path(&kurbo::Circle::new((0.0, 0.0), 10.0), 0.001);
        let polys = flatten_bez(&c, 0.05);
        assert_eq!(polys.len(), 1);
        assert!(polys[0].closed);
        assert!(polys[0].points.len() > 16);
        for p in &polys[0].points {
            assert!((p.length() - 10.0).abs() < 0.06);
        }
        assert!(polylines_contain(
            &polys,
            Point::new(0.0, 0.0),
            FillRule::Nonzero
        ));
        assert!(!polylines_contain(
            &polys,
            Point::new(11.0, 0.0),
            FillRule::Evenodd
        ));
        assert!((polylines_distance(&polys, Point::new(15.0, 0.0)) - 5.0).abs() < 0.1);
    }

    #[test]
    fn open_and_multi() {
        let b = crate::paths::parse_svg_path("M0 0L10 0M0 5L10 5L10 10Z").unwrap();
        let polys = flatten_bez(&b, 0.1);
        assert_eq!(polys.len(), 2);
        assert!(!polys[0].closed && polys[1].closed);
        assert_eq!(polys[1].points.len(), 3);
    }
}
