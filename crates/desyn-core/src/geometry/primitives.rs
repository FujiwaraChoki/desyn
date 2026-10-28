//! Points, rectangles and 2x3 affine transforms.

use core::ops::{Add, Mul, Neg, Sub};

use serde::{Deserialize, Serialize};

/// 2D point / vector.
#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize)]
pub struct Point {
    /// X.
    pub x: f64,
    /// Y.
    pub y: f64,
}

impl Point {
    /// Origin.
    pub const ZERO: Point = Point { x: 0.0, y: 0.0 };

    /// New point.
    #[inline]
    pub const fn new(x: f64, y: f64) -> Self {
        Point { x, y }
    }

    /// Dot product (as vectors).
    #[inline]
    pub fn dot(self, o: Point) -> f64 {
        self.x * o.x + self.y * o.y
    }

    /// 2D cross product z component.
    #[inline]
    pub fn cross(self, o: Point) -> f64 {
        self.x * o.y - self.y * o.x
    }

    /// Vector length.
    #[inline]
    pub fn length(self) -> f64 {
        self.x.hypot(self.y)
    }

    /// Distance to another point.
    #[inline]
    pub fn distance(self, o: Point) -> f64 {
        (self - o).length()
    }

    /// Unit vector (zero stays zero).
    pub fn normalize(self) -> Point {
        let l = self.length();
        if l > 0.0 {
            Point::new(self.x / l, self.y / l)
        } else {
            self
        }
    }

    /// Linear interpolation.
    #[inline]
    pub fn lerp(self, o: Point, t: f64) -> Point {
        Point::new(self.x + (o.x - self.x) * t, self.y + (o.y - self.y) * t)
    }

    /// Perpendicular vector (rotated 90° clockwise in y-down coordinates).
    #[inline]
    pub fn perp(self) -> Point {
        Point::new(-self.y, self.x)
    }
}

impl Add for Point {
    type Output = Point;
    #[inline]
    fn add(self, o: Point) -> Point {
        Point::new(self.x + o.x, self.y + o.y)
    }
}

impl Sub for Point {
    type Output = Point;
    #[inline]
    fn sub(self, o: Point) -> Point {
        Point::new(self.x - o.x, self.y - o.y)
    }
}

impl Mul<f64> for Point {
    type Output = Point;
    #[inline]
    fn mul(self, s: f64) -> Point {
        Point::new(self.x * s, self.y * s)
    }
}

impl Neg for Point {
    type Output = Point;
    #[inline]
    fn neg(self) -> Point {
        Point::new(-self.x, -self.y)
    }
}

/// Axis-aligned rectangle `{x, y, w, h}` (w, h >= 0 for valid rects).
#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize)]
pub struct Rect {
    /// Left.
    pub x: f64,
    /// Top.
    pub y: f64,
    /// Width.
    pub w: f64,
    /// Height.
    pub h: f64,
}

impl Rect {
    /// New rect.
    #[inline]
    pub const fn new(x: f64, y: f64, w: f64, h: f64) -> Self {
        Rect { x, y, w, h }
    }

    /// Rect from two corner points (any order).
    pub fn from_points(a: Point, b: Point) -> Self {
        let x0 = a.x.min(b.x);
        let y0 = a.y.min(b.y);
        Rect::new(x0, y0, (a.x - b.x).abs(), (a.y - b.y).abs())
    }

    /// Smallest rect containing all points (`None` for no points).
    pub fn bounding(points: impl IntoIterator<Item = Point>) -> Option<Rect> {
        let mut it = points.into_iter();
        let first = it.next()?;
        let (mut x0, mut y0, mut x1, mut y1) = (first.x, first.y, first.x, first.y);
        for p in it {
            x0 = x0.min(p.x);
            y0 = y0.min(p.y);
            x1 = x1.max(p.x);
            y1 = y1.max(p.y);
        }
        Some(Rect::new(x0, y0, x1 - x0, y1 - y0))
    }

    /// Right edge.
    #[inline]
    pub fn right(&self) -> f64 {
        self.x + self.w
    }

    /// Bottom edge.
    #[inline]
    pub fn bottom(&self) -> f64 {
        self.y + self.h
    }

    /// Center x.
    #[inline]
    pub fn center_x(&self) -> f64 {
        self.x + self.w / 2.0
    }

    /// Center y.
    #[inline]
    pub fn center_y(&self) -> f64 {
        self.y + self.h / 2.0
    }

    /// Center.
    #[inline]
    pub fn center(&self) -> Point {
        Point::new(self.center_x(), self.center_y())
    }

    /// Corners clockwise from top-left.
    pub fn corners(&self) -> [Point; 4] {
        [
            Point::new(self.x, self.y),
            Point::new(self.right(), self.y),
            Point::new(self.right(), self.bottom()),
            Point::new(self.x, self.bottom()),
        ]
    }

    /// Union of two rects.
    pub fn union(&self, o: &Rect) -> Rect {
        let x0 = self.x.min(o.x);
        let y0 = self.y.min(o.y);
        let x1 = self.right().max(o.right());
        let y1 = self.bottom().max(o.bottom());
        Rect::new(x0, y0, x1 - x0, y1 - y0)
    }

    /// Intersection (`None` when disjoint; touching edges give a zero-size rect).
    pub fn intersection(&self, o: &Rect) -> Option<Rect> {
        let x0 = self.x.max(o.x);
        let y0 = self.y.max(o.y);
        let x1 = self.right().min(o.right());
        let y1 = self.bottom().min(o.bottom());
        if x1 < x0 || y1 < y0 {
            None
        } else {
            Some(Rect::new(x0, y0, x1 - x0, y1 - y0))
        }
    }

    /// Point inside (edges inclusive).
    #[inline]
    pub fn contains(&self, p: Point) -> bool {
        p.x >= self.x && p.x <= self.right() && p.y >= self.y && p.y <= self.bottom()
    }

    /// `o` fully inside `self` (edges inclusive).
    pub fn contains_rect(&self, o: &Rect) -> bool {
        o.x >= self.x && o.y >= self.y && o.right() <= self.right() && o.bottom() <= self.bottom()
    }

    /// Overlap test (touching counts).
    #[inline]
    pub fn intersects(&self, o: &Rect) -> bool {
        self.x <= o.right() && o.x <= self.right() && self.y <= o.bottom() && o.y <= self.bottom()
    }

    /// Grown by `d` on every side (negative shrinks, clamped at zero size).
    pub fn inflate(&self, d: f64) -> Rect {
        let w = (self.w + 2.0 * d).max(0.0);
        let h = (self.h + 2.0 * d).max(0.0);
        Rect::new(self.center_x() - w / 2.0, self.center_y() - h / 2.0, w, h)
    }

    /// Grown by per-side amounts `[left, top, right, bottom]`.
    pub fn outset(&self, o: [f64; 4]) -> Rect {
        Rect::new(
            self.x - o[0],
            self.y - o[1],
            (self.w + o[0] + o[2]).max(0.0),
            (self.h + o[1] + o[3]).max(0.0),
        )
    }

    /// Translated copy.
    #[inline]
    pub fn translate(&self, dx: f64, dy: f64) -> Rect {
        Rect::new(self.x + dx, self.y + dy, self.w, self.h)
    }

    /// Area.
    #[inline]
    pub fn area(&self) -> f64 {
        self.w * self.h
    }

    /// Euclidean distance between two rects (0 when they touch or overlap).
    pub fn distance_to(&self, o: &Rect) -> f64 {
        let dx = (o.x - self.right()).max(self.x - o.right()).max(0.0);
        let dy = (o.y - self.bottom()).max(self.y - o.bottom()).max(0.0);
        dx.hypot(dy)
    }

    /// Distance from a point to the rect (0 inside).
    pub fn distance_to_point(&self, p: Point) -> f64 {
        let dx = (self.x - p.x).max(p.x - self.right()).max(0.0);
        let dy = (self.y - p.y).max(p.y - self.bottom()).max(0.0);
        dx.hypot(dy)
    }
}

/// Union of many rects (`None` when empty).
pub fn union_bounds<'a>(rects: impl IntoIterator<Item = &'a Rect>) -> Option<Rect> {
    let mut it = rects.into_iter();
    let first = *it.next()?;
    Some(it.fold(first, |acc, r| acc.union(r)))
}

/// 2x3 affine transform mapping `(x, y)` to `(a*x + c*y + e, b*x + d*y + f)` (SVG / canvas convention).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Affine {
    /// m11.
    pub a: f64,
    /// m12.
    pub b: f64,
    /// m21.
    pub c: f64,
    /// m22.
    pub d: f64,
    /// Translation x.
    pub e: f64,
    /// Translation y.
    pub f: f64,
}

impl Default for Affine {
    fn default() -> Self {
        Affine::IDENTITY
    }
}

impl Affine {
    /// Identity.
    pub const IDENTITY: Affine = Affine {
        a: 1.0,
        b: 0.0,
        c: 0.0,
        d: 1.0,
        e: 0.0,
        f: 0.0,
    };

    /// From coefficients `[a, b, c, d, e, f]`.
    #[inline]
    pub const fn new(m: [f64; 6]) -> Self {
        Affine {
            a: m[0],
            b: m[1],
            c: m[2],
            d: m[3],
            e: m[4],
            f: m[5],
        }
    }

    /// Coefficients `[a, b, c, d, e, f]`.
    #[inline]
    pub fn as_coeffs(&self) -> [f64; 6] {
        [self.a, self.b, self.c, self.d, self.e, self.f]
    }

    /// Translation.
    #[inline]
    pub const fn translate(x: f64, y: f64) -> Self {
        Affine {
            a: 1.0,
            b: 0.0,
            c: 0.0,
            d: 1.0,
            e: x,
            f: y,
        }
    }

    /// Non-uniform scale.
    #[inline]
    pub const fn scale(sx: f64, sy: f64) -> Self {
        Affine {
            a: sx,
            b: 0.0,
            c: 0.0,
            d: sy,
            e: 0.0,
            f: 0.0,
        }
    }

    /// Rotation by degrees, clockwise on screen (y down).
    pub fn rotate_deg(deg: f64) -> Self {
        let (s, c) = deg.to_radians().sin_cos();
        Affine {
            a: c,
            b: s,
            c: -s,
            d: c,
            e: 0.0,
            f: 0.0,
        }
    }

    /// Rotation by degrees about a point.
    pub fn rotate_about(deg: f64, center: Point) -> Self {
        Affine::translate(center.x, center.y)
            * Affine::rotate_deg(deg)
            * Affine::translate(-center.x, -center.y)
    }

    /// Applies to a point.
    #[inline]
    pub fn apply(&self, p: Point) -> Point {
        Point::new(
            self.a * p.x + self.c * p.y + self.e,
            self.b * p.x + self.d * p.y + self.f,
        )
    }

    /// Applies the linear part only (vectors).
    #[inline]
    pub fn apply_vector(&self, v: Point) -> Point {
        Point::new(self.a * v.x + self.c * v.y, self.b * v.x + self.d * v.y)
    }

    /// Determinant of the linear part.
    #[inline]
    pub fn determinant(&self) -> f64 {
        self.a * self.d - self.b * self.c
    }

    /// Inverse (`None` when singular).
    pub fn inverse(&self) -> Option<Affine> {
        let det = self.determinant();
        if det.abs() < 1e-12 || !det.is_finite() {
            return None;
        }
        let inv = 1.0 / det;
        let a = self.d * inv;
        let b = -self.b * inv;
        let c = -self.c * inv;
        let d = self.a * inv;
        Some(Affine {
            a,
            b,
            c,
            d,
            e: -(a * self.e + c * self.f),
            f: -(b * self.e + d * self.f),
        })
    }

    /// True when the transform is a pure translation.
    #[inline]
    pub fn is_translation(&self) -> bool {
        self.a == 1.0 && self.b == 0.0 && self.c == 0.0 && self.d == 1.0
    }

    /// Bounding box of a transformed rect.
    pub fn transform_rect_bbox(&self, r: &Rect) -> Rect {
        if self.is_translation() {
            return r.translate(self.e, self.f);
        }
        Rect::bounding(r.corners().map(|p| self.apply(p))).expect("four corners")
    }

    /// Rotation angle of the transformed x axis in degrees (clockwise, -180..180).
    pub fn rotation_deg(&self) -> f64 {
        self.b.atan2(self.a).to_degrees()
    }

    /// Scale factors (lengths of the transformed unit axes).
    pub fn scale_factors(&self) -> (f64, f64) {
        (self.a.hypot(self.b), self.c.hypot(self.d))
    }

    /// To a kurbo affine.
    pub fn to_kurbo(&self) -> kurbo::Affine {
        kurbo::Affine::new(self.as_coeffs())
    }
}

impl Mul for Affine {
    type Output = Affine;
    /// `self * o` applies `o` first, then `self`.
    fn mul(self, o: Affine) -> Affine {
        Affine {
            a: self.a * o.a + self.c * o.b,
            b: self.b * o.a + self.d * o.b,
            c: self.a * o.c + self.c * o.d,
            d: self.b * o.c + self.d * o.d,
            e: self.a * o.e + self.c * o.f + self.e,
            f: self.b * o.e + self.d * o.f + self.f,
        }
    }
}

/// Distance from `p` to the segment `a..b`.
pub fn point_segment_distance(p: Point, a: Point, b: Point) -> f64 {
    let ab = b - a;
    let len2 = ab.dot(ab);
    if len2 <= 0.0 {
        return p.distance(a);
    }
    let t = ((p - a).dot(ab) / len2).clamp(0.0, 1.0);
    p.distance(a + ab * t)
}

/// Distance from `p` to a polyline (`closed` adds the closing segment).
pub fn point_polyline_distance(p: Point, pts: &[Point], closed: bool) -> f64 {
    match pts.len() {
        0 => f64::INFINITY,
        1 => p.distance(pts[0]),
        _ => {
            let mut best = f64::INFINITY;
            for w in pts.windows(2) {
                best = best.min(point_segment_distance(p, w[0], w[1]));
            }
            if closed {
                best = best.min(point_segment_distance(p, pts[pts.len() - 1], pts[0]));
            }
            best
        }
    }
}

/// Even-odd / nonzero point-in-polygon test for a single ring.
pub fn point_in_polygon(p: Point, ring: &[Point], nonzero: bool) -> bool {
    let w = winding_number(p, ring);
    if nonzero { w != 0 } else { w % 2 != 0 }
}

/// Winding number of a closed ring around `p`.
pub fn winding_number(p: Point, ring: &[Point]) -> i32 {
    let n = ring.len();
    if n < 3 {
        return 0;
    }
    let mut wn = 0;
    for i in 0..n {
        let a = ring[i];
        let b = ring[(i + 1) % n];
        if a.y <= p.y {
            if b.y > p.y && (b - a).cross(p - a) > 0.0 {
                wn += 1;
            }
        } else if b.y <= p.y && (b - a).cross(p - a) < 0.0 {
            wn -= 1;
        }
    }
    wn
}

#[cfg(test)]
mod tests {
    use super::*;

    fn close(a: Point, b: Point) -> bool {
        (a.x - b.x).abs() < 1e-9 && (a.y - b.y).abs() < 1e-9
    }

    #[test]
    fn affine_ops() {
        let t = Affine::translate(10.0, 5.0) * Affine::rotate_deg(90.0);
        // Rotating (1,0) by 90° clockwise on screen gives (0,1).
        assert!(close(t.apply(Point::new(1.0, 0.0)), Point::new(10.0, 6.0)));
        let inv = t.inverse().unwrap();
        assert!(close(
            inv.apply(t.apply(Point::new(3.0, -2.0))),
            Point::new(3.0, -2.0)
        ));
        assert!((t.rotation_deg() - 90.0).abs() < 1e-9);
        assert!(Affine::scale(0.0, 1.0).inverse().is_none());
    }

    #[test]
    fn rect_ops() {
        let a = Rect::new(0.0, 0.0, 10.0, 10.0);
        let b = Rect::new(20.0, 0.0, 5.0, 5.0);
        assert_eq!(a.distance_to(&b), 10.0);
        assert_eq!(a.union(&b), Rect::new(0.0, 0.0, 25.0, 10.0));
        assert!(a.intersection(&b).is_none());
        assert!(a.contains(Point::new(10.0, 10.0)));
        assert_eq!(
            union_bounds([a, b].iter()),
            Some(Rect::new(0.0, 0.0, 25.0, 10.0))
        );
    }

    #[test]
    fn polygon_tests() {
        let sq = [
            Point::new(0.0, 0.0),
            Point::new(10.0, 0.0),
            Point::new(10.0, 10.0),
            Point::new(0.0, 10.0),
        ];
        assert!(point_in_polygon(Point::new(5.0, 5.0), &sq, true));
        assert!(!point_in_polygon(Point::new(15.0, 5.0), &sq, false));
        assert_eq!(
            point_polyline_distance(Point::new(5.0, -3.0), &sq, true),
            3.0
        );
    }
}
