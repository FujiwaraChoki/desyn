//! Stroke outlining (stroke-to-fill), used for hit testing thick strokes, bounds and vector export.

use kurbo::BezPath;

use super::boolean::{Shape, boolean};
use crate::model::{BoolOp, FillRule, Stroke, StrokeAlign, StrokeCap, StrokeJoin};

/// Geometric stroke parameters.
#[derive(Debug, Clone, PartialEq)]
pub struct StrokeStyle {
    /// Width in px.
    pub width: f64,
    /// End cap.
    pub cap: StrokeCap,
    /// Corner join.
    pub join: StrokeJoin,
    /// Miter limit (ratio).
    pub miter_limit: f64,
    /// Dash pattern (empty = solid).
    pub dash: Vec<f64>,
}

impl From<&Stroke> for StrokeStyle {
    fn from(s: &Stroke) -> Self {
        StrokeStyle {
            width: s.width,
            cap: s.cap,
            join: s.join,
            miter_limit: s.miter_limit.unwrap_or(4.0),
            dash: s.dash.clone().unwrap_or_default(),
        }
    }
}

/// Most dashes one stroke outline produces; patterns that would produce more (hairline dashes along a huge path)
/// are outlined solid, which is indistinguishable at any zoom where they could be told apart from it.
const MAX_DASHES: f64 = 100_000.0;

/// Upper bound of the path length: the length of its control polygon.
fn control_polygon_length(path: &BezPath) -> f64 {
    let mut len = 0.0;
    let mut start = kurbo::Point::ZERO;
    let mut last = kurbo::Point::ZERO;
    for el in path.elements() {
        match *el {
            kurbo::PathEl::MoveTo(p) => {
                start = p;
                last = p;
            }
            kurbo::PathEl::LineTo(p) => {
                len += last.distance(p);
                last = p;
            }
            kurbo::PathEl::QuadTo(a, p) => {
                len += last.distance(a) + a.distance(p);
                last = p;
            }
            kurbo::PathEl::CurveTo(a, b, p) => {
                len += last.distance(a) + a.distance(b) + b.distance(p);
                last = p;
            }
            kurbo::PathEl::ClosePath => {
                len += last.distance(start);
                last = start;
            }
        }
    }
    len
}

fn kurbo_style(s: &StrokeStyle, width: f64, path_len: f64) -> kurbo::Stroke {
    let cap = match s.cap {
        StrokeCap::Butt => kurbo::Cap::Butt,
        StrokeCap::Round => kurbo::Cap::Round,
        StrokeCap::Square => kurbo::Cap::Square,
    };
    let join = match s.join {
        StrokeJoin::Miter => kurbo::Join::Miter,
        StrokeJoin::Round => kurbo::Join::Round,
        StrokeJoin::Bevel => kurbo::Join::Bevel,
    };
    let miter_limit = if s.miter_limit.is_finite() {
        s.miter_limit.max(1.0)
    } else {
        4.0
    };
    let mut k = kurbo::Stroke::new(width)
        .with_caps(cap)
        .with_join(join)
        .with_miter_limit(miter_limit);
    let dash: Vec<f64> = s
        .dash
        .iter()
        .copied()
        .filter(|d| d.is_finite() && *d >= 0.0)
        .collect();
    // SVG repeats an odd-length dash list twice to form the period.
    let period = dash.iter().sum::<f64>() * if dash.len() % 2 == 1 { 2.0 } else { 1.0 };
    if period > 0.0 && path_len / period * dash.len() as f64 <= MAX_DASHES {
        k = k.with_dashes(0.0, dash);
    }
    k
}

/// Outline of a centered stroke as a fill path (nonzero). Paths with coordinates beyond
/// [`super::flatten::MAX_COORDINATE`] (or non-finite widths) produce an empty outline; the tolerance is raised for
/// huge paths and widths so the work stays bounded.
pub fn stroke_outline(path: &BezPath, style: &StrokeStyle, tolerance: f64) -> BezPath {
    if !(style.width > 0.0 && style.width <= super::flatten::MAX_COORDINATE) {
        return BezPath::new();
    }
    let Some(extent) = super::flatten::path_extent(path) else {
        return BezPath::new();
    };
    let tol = super::flatten::effective_tolerance(tolerance, 1e-4, extent.max(style.width));
    kurbo::stroke(
        path.elements().iter().copied(),
        &kurbo_style(style, style.width, control_polygon_length(path)),
        &kurbo::StrokeOpts::default(),
        tol,
    )
}

/// Outline of a stroke honoring alignment: `inside` / `outside` strokes of closed shapes are the doubled-width
/// centered stroke intersected with / minus the fill area. Open paths always stroke centered.
pub fn aligned_stroke_outline(
    path: &BezPath,
    fill_rule: FillRule,
    style: &StrokeStyle,
    align: StrokeAlign,
    tolerance: f64,
) -> BezPath {
    let closed = path
        .elements()
        .iter()
        .any(|e| matches!(e, kurbo::PathEl::ClosePath));
    if align == StrokeAlign::Center || !closed {
        return stroke_outline(path, style, tolerance);
    }
    let wide = StrokeStyle {
        width: style.width * 2.0,
        ..style.clone()
    };
    let band = Shape {
        path: stroke_outline(path, &wide, tolerance),
        fill_rule: FillRule::Nonzero,
    };
    let fill = Shape {
        path: path.clone(),
        fill_rule,
    };
    match align {
        StrokeAlign::Inside => boolean(&[band, fill], BoolOp::Intersect, tolerance),
        StrokeAlign::Outside => boolean(&[band, fill], BoolOp::Subtract, tolerance),
        StrokeAlign::Center => stroke_outline(path, style, tolerance),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use kurbo::Shape as _;

    fn style(w: f64) -> StrokeStyle {
        StrokeStyle {
            width: w,
            cap: StrokeCap::Butt,
            join: StrokeJoin::Miter,
            miter_limit: 4.0,
            dash: vec![],
        }
    }

    #[test]
    fn outlines() {
        let line = crate::paths::parse_svg_path("M0 0L100 0").unwrap();
        let o = stroke_outline(&line, &style(10.0), 0.01);
        let bb = o.bounding_box();
        assert!((bb.y0 + 5.0).abs() < 1e-6 && (bb.y1 - 5.0).abs() < 1e-6 && bb.x0.abs() < 1e-6);
        assert!((o.area().abs() - 1000.0).abs() < 1e-3);
        let sq = crate::paths::parse_svg_path("M0 0L100 0L100 100L0 100Z").unwrap();
        let inside = aligned_stroke_outline(
            &sq,
            FillRule::Nonzero,
            &style(10.0),
            StrokeAlign::Inside,
            0.01,
        );
        let ib = inside.bounding_box();
        assert!(ib.x0 >= -1e-6 && ib.x1 <= 100.0 + 1e-6);
        assert!((inside.area().abs() - (10000.0 - 80.0 * 80.0)).abs() < 1e-3);
        let outside = aligned_stroke_outline(
            &sq,
            FillRule::Nonzero,
            &style(10.0),
            StrokeAlign::Outside,
            0.01,
        );
        assert!((outside.area().abs() - (120.0 * 120.0 - 10000.0)).abs() < 1e-3);
        let dashed = StrokeStyle {
            dash: vec![10.0, 10.0],
            ..style(2.0)
        };
        assert!((stroke_outline(&line, &dashed, 0.01).area().abs() - 100.0).abs() < 1e-3);
    }
}
