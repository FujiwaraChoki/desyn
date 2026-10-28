//! Geometry glue between `desyn-core` (f64 affines, kurbo paths) and tiny-skia (f32 paths / transforms).

use desyn_core::geometry::{Affine, Point, Rect};
use desyn_core::paths::kurbo::{self, BezPath, PathEl};
use tiny_skia::{IntRect, Path as SkPath, PathBuilder, PathSegment, Transform};

/// Coordinates beyond this magnitude are dropped before reaching tiny-skia (f32 math, fixed-point edges).
pub const MAX_COORD: f64 = 1.0e7;

/// Core affine to a tiny-skia transform.
#[inline]
pub fn to_ts(a: &Affine) -> Transform {
    Transform::from_row(
        a.a as f32, a.b as f32, a.c as f32, a.d as f32, a.e as f32, a.f as f32,
    )
}

/// tiny-skia transform to a core affine.
#[inline]
pub fn from_ts(t: &Transform) -> Affine {
    Affine::new([
        f64::from(t.sx),
        f64::from(t.ky),
        f64::from(t.kx),
        f64::from(t.sy),
        f64::from(t.tx),
        f64::from(t.ty),
    ])
}

/// kurbo affine to a core affine.
#[inline]
pub fn from_kurbo(a: kurbo::Affine) -> Affine {
    Affine::new(a.as_coeffs())
}

/// True when every coefficient is finite.
pub fn affine_finite(a: &Affine) -> bool {
    a.as_coeffs().iter().all(|v| v.is_finite())
}

fn ok(p: kurbo::Point) -> bool {
    p.x.is_finite() && p.y.is_finite() && p.x.abs() <= MAX_COORD && p.y.abs() <= MAX_COORD
}

/// kurbo path to a tiny-skia path. `None` for empty paths or paths with non-finite / huge coordinates.
pub fn bez_to_path(b: &BezPath) -> Option<SkPath> {
    let mut pb = PathBuilder::with_capacity(b.elements().len(), b.elements().len() * 2);
    for el in b.elements() {
        match *el {
            PathEl::MoveTo(p) => {
                if !ok(p) {
                    return None;
                }
                pb.move_to(p.x as f32, p.y as f32);
            }
            PathEl::LineTo(p) => {
                if !ok(p) {
                    return None;
                }
                pb.line_to(p.x as f32, p.y as f32);
            }
            PathEl::QuadTo(a, p) => {
                if !ok(a) || !ok(p) {
                    return None;
                }
                pb.quad_to(a.x as f32, a.y as f32, p.x as f32, p.y as f32);
            }
            PathEl::CurveTo(a, c, p) => {
                if !ok(a) || !ok(c) || !ok(p) {
                    return None;
                }
                pb.cubic_to(
                    a.x as f32, a.y as f32, c.x as f32, c.y as f32, p.x as f32, p.y as f32,
                );
            }
            PathEl::ClosePath => pb.close(),
        }
    }
    pb.finish()
}

/// tiny-skia path to a kurbo path.
pub fn path_to_bez(p: &SkPath) -> BezPath {
    let mut b = BezPath::new();
    let kp = |p: tiny_skia::Point| kurbo::Point::new(f64::from(p.x), f64::from(p.y));
    for seg in p.segments() {
        match seg {
            PathSegment::MoveTo(p) => b.move_to(kp(p)),
            PathSegment::LineTo(p) => b.line_to(kp(p)),
            PathSegment::QuadTo(a, p) => b.quad_to(kp(a), kp(p)),
            PathSegment::CubicTo(a, c, p) => b.curve_to(kp(a), kp(c), kp(p)),
            PathSegment::Close => b.close_path(),
        }
    }
    b
}

/// Bounds of a tiny-skia path in its own coordinates.
pub fn path_bounds(p: &SkPath) -> Rect {
    let r = p.bounds();
    Rect::new(
        f64::from(r.x()),
        f64::from(r.y()),
        f64::from(r.width()),
        f64::from(r.height()),
    )
}

/// Axis-aligned rectangle path (`None` when degenerate or non-finite).
pub fn rect_path(r: &Rect) -> Option<SkPath> {
    if !(r.w > 0.0 && r.h > 0.0) || !r.x.is_finite() || !r.y.is_finite() {
        return None;
    }
    let rect = tiny_skia::Rect::from_xywh(r.x as f32, r.y as f32, r.w as f32, r.h as f32)?;
    Some(PathBuilder::from_rect(rect))
}

/// Union that ignores empty (zero-area and zero-size) rectangles.
pub fn union_rect(a: Option<Rect>, b: &Rect) -> Option<Rect> {
    if !(b.w >= 0.0 && b.h >= 0.0) || !b.x.is_finite() || !b.y.is_finite() {
        return a;
    }
    Some(match a {
        Some(a) => a.union(b),
        None => *b,
    })
}

/// Device rectangle covering `r` (rounded outwards), clamped to sane integer ranges.
pub fn round_out(r: &Rect) -> Option<IntRect> {
    if !(r.w > 0.0 && r.h > 0.0) || !r.x.is_finite() || !r.y.is_finite() {
        return None;
    }
    let lim = 1.0e8;
    let x0 = r.x.clamp(-lim, lim).floor();
    let y0 = r.y.clamp(-lim, lim).floor();
    let x1 = (r.x + r.w).clamp(-lim, lim).ceil();
    let y1 = (r.y + r.h).clamp(-lim, lim).ceil();
    IntRect::from_ltrb(x0 as i32, y0 as i32, x1 as i32, y1 as i32)
}

/// Intersection of two device rectangles.
pub fn intersect(a: &IntRect, b: &IntRect) -> Option<IntRect> {
    let l = a.left().max(b.left());
    let t = a.top().max(b.top());
    let r = a.right().min(b.right());
    let btm = a.bottom().min(b.bottom());
    if r <= l || btm <= t {
        return None;
    }
    IntRect::from_ltrb(l, t, r, btm)
}

/// Union of two device rectangles.
pub fn union_int(a: &IntRect, b: &IntRect) -> IntRect {
    IntRect::from_ltrb(
        a.left().min(b.left()),
        a.top().min(b.top()),
        a.right().max(b.right()),
        a.bottom().max(b.bottom()),
    )
    .unwrap_or(*a)
}

/// Grows a device rectangle on every side.
pub fn outset_int(r: &IntRect, d: i32) -> IntRect {
    IntRect::from_ltrb(
        r.left().saturating_sub(d),
        r.top().saturating_sub(d),
        r.right().saturating_add(d),
        r.bottom().saturating_add(d),
    )
    .unwrap_or(*r)
}

/// Float rectangle of a device rectangle.
pub fn int_to_rect(r: &IntRect) -> Rect {
    Rect::new(
        f64::from(r.x()),
        f64::from(r.y()),
        f64::from(r.width()),
        f64::from(r.height()),
    )
}

/// Bounding box of a transformed rectangle.
#[inline]
pub fn transform_rect(a: &Affine, r: &Rect) -> Rect {
    a.transform_rect_bbox(r)
}

/// True when the transform keeps axis alignment (no rotation / skew; flips allowed).
pub fn is_axis_aligned(a: &Affine) -> bool {
    (a.b.abs() < 1e-9 && a.c.abs() < 1e-9) || (a.a.abs() < 1e-9 && a.d.abs() < 1e-9)
}

/// Geometric mean of the transform's axis scales (for tolerances and blur radii in device space).
pub fn mean_scale(a: &Affine) -> f64 {
    let (sx, sy) = a.scale_factors();
    let s = (sx * sy).sqrt();
    if s.is_finite() && s > 0.0 { s } else { 1.0 }
}

/// Corners of a rectangle transformed (quad, clockwise from top-left).
pub fn quad(a: &Affine, r: &Rect) -> [Point; 4] {
    r.corners().map(|p| a.apply(p))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn conversions_roundtrip() {
        let a = Affine::new([1.0, 2.0, 3.0, 4.0, 5.0, 6.0]);
        assert_eq!(from_ts(&to_ts(&a)), a);
        let mut b = BezPath::new();
        b.move_to((0.0, 0.0));
        b.line_to((10.0, 0.0));
        b.curve_to((10.0, 5.0), (5.0, 10.0), (0.0, 10.0));
        b.close_path();
        let p = bez_to_path(&b).unwrap();
        assert_eq!(path_bounds(&p), Rect::new(0.0, 0.0, 10.0, 10.0));
        assert_eq!(path_to_bez(&p).elements().len(), 4);
        let mut bad = BezPath::new();
        bad.move_to((f64::NAN, 0.0));
        bad.line_to((1.0, 1.0));
        assert!(bez_to_path(&bad).is_none());
        assert_eq!(
            round_out(&Rect::new(0.5, 0.5, 1.0, 1.0)).unwrap(),
            IntRect::from_xywh(0, 0, 2, 2).unwrap()
        );
    }
}
