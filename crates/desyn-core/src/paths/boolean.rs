//! Boolean path operations (union / subtract / intersect / exclude) on flattened outlines using `i_overlay`.

use i_overlay::core::fill_rule::FillRule as OvFillRule;
use i_overlay::core::overlay_rule::OverlayRule;
use i_overlay::float::single::SingleFloatOverlay;
use kurbo::{BezPath, PathEl, Point as KPoint};

use super::flatten::flatten_bez;
use crate::model::{BoolOp, FillRule};

/// A filled shape operand: outline plus fill rule.
#[derive(Debug, Clone)]
pub struct Shape {
    /// Outline (closed sub-paths; open ones are closed implicitly).
    pub path: BezPath,
    /// Fill rule.
    pub fill_rule: FillRule,
}

type Contours = Vec<Vec<[f64; 2]>>;

fn to_contours(path: &BezPath, tolerance: f64) -> Contours {
    // `flatten_bez` yields nothing for paths beyond `MAX_COORDINATE`, which keeps every point inside the range
    // `i_overlay` accepts (it panics on coordinates above 2^500).
    flatten_bez(path, tolerance)
        .into_iter()
        .filter(|p| p.points.len() >= 3)
        .map(|p| p.points.iter().map(|q| [q.x, q.y]).collect())
        .collect()
}

fn ov_rule(r: FillRule) -> OvFillRule {
    match r {
        FillRule::Nonzero => OvFillRule::NonZero,
        FillRule::Evenodd => OvFillRule::EvenOdd,
    }
}

/// Normalizes one shape to non-overlapping contours (resolving its own fill rule).
fn resolve(shape: &Shape, tolerance: f64) -> Contours {
    let c = to_contours(&shape.path, tolerance);
    if c.is_empty() {
        return c;
    }
    let empty: Contours = Vec::new();
    flatten_shapes(c.overlay(&empty, OverlayRule::Subject, ov_rule(shape.fill_rule)))
}

fn flatten_shapes(shapes: Vec<Vec<Vec<[f64; 2]>>>) -> Contours {
    shapes.into_iter().flatten().collect()
}

fn binary(a: &Contours, b: &Contours, rule: OverlayRule) -> Contours {
    if a.is_empty() && b.is_empty() {
        return Vec::new();
    }
    flatten_shapes(a.overlay(b, rule, OvFillRule::NonZero))
}

/// Combines shapes in order: union / intersect / exclude fold left to right; subtract removes every later shape from
/// the first. Curves are flattened with `tolerance` (design px). The result uses polygons and fills correctly with
/// either fill rule (outer contours and holes have opposite orientation, no overlaps).
pub fn boolean(shapes: &[Shape], op: BoolOp, tolerance: f64) -> BezPath {
    let tol = tolerance.max(1e-4);
    let resolved: Vec<Contours> = shapes.iter().map(|s| resolve(s, tol)).collect();
    let Some((first, rest)) = resolved.split_first() else {
        return BezPath::new();
    };
    let mut acc = first.clone();
    match op {
        BoolOp::Union => {
            for r in rest {
                acc = binary(&acc, r, OverlayRule::Union);
            }
        }
        BoolOp::Intersect => {
            for r in rest {
                acc = binary(&acc, r, OverlayRule::Intersect);
            }
        }
        BoolOp::Exclude => {
            for r in rest {
                acc = binary(&acc, r, OverlayRule::Xor);
            }
        }
        BoolOp::Subtract => {
            if !rest.is_empty() {
                let mut cutter: Contours = Vec::new();
                for r in rest {
                    cutter = binary(&cutter, r, OverlayRule::Union);
                }
                acc = binary(&acc, &cutter, OverlayRule::Difference);
            }
        }
    }
    contours_to_bez(&acc)
}

/// Polygon contours to a closed kurbo path.
pub fn contours_to_bez(contours: &[Vec<[f64; 2]>]) -> BezPath {
    let mut b = BezPath::new();
    for c in contours {
        let Some(first) = c.first() else { continue };
        b.push(PathEl::MoveTo(KPoint::new(first[0], first[1])));
        for p in &c[1..] {
            b.push(PathEl::LineTo(KPoint::new(p[0], p[1])));
        }
        b.push(PathEl::ClosePath);
    }
    b
}

#[cfg(test)]
mod tests {
    use super::*;
    use kurbo::Shape as _;

    fn square(x: f64, y: f64, s: f64) -> Shape {
        let mut p = BezPath::new();
        p.move_to((x, y));
        p.line_to((x + s, y));
        p.line_to((x + s, y + s));
        p.line_to((x, y + s));
        p.close_path();
        Shape {
            path: p,
            fill_rule: FillRule::Nonzero,
        }
    }

    fn area(b: &BezPath) -> f64 {
        // Sum of absolute sub-path areas would double count holes; signed area works because holes are reversed.
        b.area().abs()
    }

    #[test]
    fn four_ops() {
        let a = square(0.0, 0.0, 10.0);
        let b = square(5.0, 5.0, 10.0);
        let shapes = [a.clone(), b.clone()];
        assert!((area(&boolean(&shapes, BoolOp::Union, 0.1)) - 175.0).abs() < 1e-6);
        assert!((area(&boolean(&shapes, BoolOp::Intersect, 0.1)) - 25.0).abs() < 1e-6);
        assert!((area(&boolean(&shapes, BoolOp::Subtract, 0.1)) - 75.0).abs() < 1e-6);
        assert!((area(&boolean(&shapes, BoolOp::Exclude, 0.1)) - 150.0).abs() < 1e-6);
        // Hole: subtract a fully contained square.
        let hole = boolean(
            &[square(0.0, 0.0, 10.0), square(2.0, 2.0, 2.0)],
            BoolOp::Subtract,
            0.1,
        );
        assert!((area(&hole) - 96.0).abs() < 1e-6);
        assert!(hole.contains(kurbo::Point::new(1.0, 1.0)));
        assert!(!hole.contains(kurbo::Point::new(3.0, 3.0)));
        // Disjoint intersect is empty.
        assert!(
            boolean(
                &[square(0.0, 0.0, 1.0), square(5.0, 5.0, 1.0)],
                BoolOp::Intersect,
                0.1
            )
            .elements()
            .is_empty()
        );
    }

    #[test]
    fn curves_and_fill_rules() {
        let circle = Shape {
            path: kurbo::Circle::new((0.0, 0.0), 10.0).to_path(0.01),
            fill_rule: FillRule::Nonzero,
        };
        let u = boolean(
            &[circle.clone(), square(0.0, -10.0, 20.0)],
            BoolOp::Union,
            0.01,
        );
        let expected = 400.0 + std::f64::consts::PI * 50.0;
        assert!(
            (area(&u) - expected).abs() < 1.0,
            "{} vs {expected}",
            area(&u)
        );
        // Even-odd self-overlap: two nested squares in one path make a frame.
        let mut p = square(0.0, 0.0, 10.0).path;
        p.extend(square(2.0, 2.0, 6.0).path);
        let eo = Shape {
            path: p.clone(),
            fill_rule: FillRule::Evenodd,
        };
        assert!((area(&boolean(&[eo], BoolOp::Union, 0.1)) - 64.0).abs() < 1e-6);
        let nz = Shape {
            path: p,
            fill_rule: FillRule::Nonzero,
        };
        assert!((area(&boolean(&[nz], BoolOp::Union, 0.1)) - 100.0).abs() < 1e-6);
    }
}
