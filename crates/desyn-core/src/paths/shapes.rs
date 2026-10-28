//! Shape-to-path conversion in local box coordinates (`0..w x 0..h`).

use std::f64::consts::{FRAC_PI_2, PI, TAU};

use kurbo::{BezPath, Point as KPoint, SvgArc, Vec2};
use serde::{Deserialize, Serialize};

use crate::model::{Cap, EllipseArc};

fn kp(x: f64, y: f64) -> KPoint {
    KPoint::new(x, y)
}

/// Clamps per-corner radii `[tl, tr, br, bl]` like CSS: negative radii become 0 and, when adjacent radii exceed a
/// side, all radii are scaled down by the same factor.
pub fn clamp_radii(w: f64, h: f64, radii: [f64; 4]) -> [f64; 4] {
    let r = radii.map(|v| if v.is_finite() { v.max(0.0) } else { 0.0 });
    let mut f: f64 = 1.0;
    let sides = [
        (w, r[0] + r[1]),
        (h, r[1] + r[2]),
        (w, r[2] + r[3]),
        (h, r[3] + r[0]),
    ];
    for (len, sum) in sides {
        if sum > 0.0 {
            f = f.min(len.max(0.0) / sum);
        }
    }
    if f < 1.0 { r.map(|v| v * f) } else { r }
}

/// Tolerance for approximating a circular / elliptical arc of radius `r` with cubics: 0.01 px, relaxed for radii
/// above 100,000 px so huge (hostile) shapes still produce a handful of segments instead of an unbounded number.
pub(crate) fn arc_tolerance(r: f64) -> f64 {
    (r.abs() * 1e-7).max(0.01)
}

/// Most vertices a polygon / star outline gets. Beyond a few thousand sides a regular polygon is indistinguishable
/// from its circumscribed ellipse (sagitta below 0.002 px per 1,000 px of radius), and an unbounded count would let
/// a document allocate gigabytes.
pub const MAX_POLYGON_VERTICES: u64 = 4096;

fn arc_to(b: &mut BezPath, from: KPoint, to: KPoint, r: f64, sweep: bool) {
    let arc = SvgArc {
        from,
        to,
        radii: Vec2::new(r, r),
        x_rotation: 0.0,
        large_arc: false,
        sweep,
    };
    match kurbo::Arc::from_svg_arc(&arc) {
        Some(a) => a.to_cubic_beziers(arc_tolerance(r), |p1, p2, p| b.curve_to(p1, p2, p)),
        None => b.line_to(to),
    }
}

/// Smoothed-corner parameters (Figma-style squircle), see [`rect_path`].
#[derive(Debug, Clone, Copy)]
struct CornerParams {
    a: f64,
    b: f64,
    c: f64,
    d: f64,
    p: f64,
    arc_len: f64,
    r: f64,
}

fn corner_params(radius: f64, smoothing: f64, budget: f64) -> CornerParams {
    let r = radius.min(budget).max(0.0);
    if r <= 0.0 {
        return CornerParams {
            a: 0.0,
            b: 0.0,
            c: 0.0,
            d: 0.0,
            p: 0.0,
            arc_len: 0.0,
            r: 0.0,
        };
    }
    let mut s = smoothing.clamp(0.0, 1.0);
    let mut p = (1.0 + s) * r;
    // Without enough room, reduce smoothing so the corner fits its budget.
    let max_s = budget / r - 1.0;
    s = s.min(max_s).max(0.0);
    p = p.min(budget);
    let arc_measure = 90.0 * (1.0 - s);
    let arc_len = (arc_measure / 2.0).to_radians().sin() * r * std::f64::consts::SQRT_2;
    let alpha = (90.0 - arc_measure) / 2.0;
    let p3_to_p4 = r * (alpha / 2.0).to_radians().tan();
    let beta = 45.0 * s;
    let c = p3_to_p4 * beta.to_radians().cos();
    let d = c * beta.to_radians().tan();
    let b = ((p - arc_len - c - d) / 3.0).max(0.0);
    let a = 2.0 * b;
    CornerParams {
        a,
        b,
        c,
        d,
        p: a + b + c + d + arc_len,
        arc_len,
        r,
    }
}

/// Rounded rectangle with per-corner radii `[tl, tr, br, bl]` and iOS-style corner smoothing (0 = circular corners,
/// 1 = maximal squircle, the Figma corner-smoothing construction). Starts at the top edge and runs clockwise.
pub fn rect_path(w: f64, h: f64, radii: [f64; 4], smoothing: f64) -> BezPath {
    let w = w.max(0.0);
    let h = h.max(0.0);
    let r = clamp_radii(w, h, radii);
    let mut b = BezPath::new();
    if r.iter().all(|v| *v <= 0.0) {
        b.move_to(kp(0.0, 0.0));
        b.line_to(kp(w, 0.0));
        b.line_to(kp(w, h));
        b.line_to(kp(0.0, h));
        b.close_path();
        return b;
    }
    if smoothing <= 0.0 {
        let [tl, tr, br, bl] = r;
        b.move_to(kp(tl, 0.0));
        b.line_to(kp(w - tr, 0.0));
        if tr > 0.0 {
            arc_to(&mut b, kp(w - tr, 0.0), kp(w, tr), tr, true);
        }
        b.line_to(kp(w, h - br));
        if br > 0.0 {
            arc_to(&mut b, kp(w, h - br), kp(w - br, h), br, true);
        }
        b.line_to(kp(bl, h));
        if bl > 0.0 {
            arc_to(&mut b, kp(bl, h), kp(0.0, h - bl), bl, true);
        }
        b.line_to(kp(0.0, tl));
        if tl > 0.0 {
            arc_to(&mut b, kp(0.0, tl), kp(tl, 0.0), tl, true);
        }
        b.close_path();
        return b;
    }
    let budget = w.min(h) / 2.0;
    let [tl, tr, br, bl] = r.map(|v| corner_params(v, smoothing, budget));
    // Each corner is: cubic, circular arc, cubic - written relative to the corner's entry point in the local frame of
    // that corner (u = along the incoming edge, v = toward the outgoing edge).
    let corner = |b: &mut BezPath, start: KPoint, u: Vec2, v: Vec2, c: &CornerParams| {
        if c.r <= 0.0 {
            return;
        }
        let at = |du: f64, dv: f64| start + u * du + v * dv;
        let (a, bb, cc, d) = (c.a, c.b, c.c, c.d);
        b.curve_to(at(a, 0.0), at(a + bb, 0.0), at(a + bb + cc, d));
        let arc_start = at(a + bb + cc, d);
        let arc_end = at(a + bb + cc + c.arc_len, d + c.arc_len);
        arc_to(b, arc_start, arc_end, c.r, true);
        let s2 = arc_end;
        let at2 = |du: f64, dv: f64| s2 + u * du + v * dv;
        b.curve_to(at2(d, cc), at2(d, bb + cc), at2(d, a + bb + cc));
    };
    b.move_to(kp(tl.p, 0.0));
    b.line_to(kp(w - tr.p, 0.0));
    corner(
        &mut b,
        kp(w - tr.p, 0.0),
        Vec2::new(1.0, 0.0),
        Vec2::new(0.0, 1.0),
        &tr,
    );
    b.line_to(kp(w, h - br.p));
    corner(
        &mut b,
        kp(w, h - br.p),
        Vec2::new(0.0, 1.0),
        Vec2::new(-1.0, 0.0),
        &br,
    );
    b.line_to(kp(bl.p, h));
    corner(
        &mut b,
        kp(bl.p, h),
        Vec2::new(-1.0, 0.0),
        Vec2::new(0.0, -1.0),
        &bl,
    );
    b.line_to(kp(0.0, tl.p));
    corner(
        &mut b,
        kp(0.0, tl.p),
        Vec2::new(0.0, -1.0),
        Vec2::new(1.0, 0.0),
        &tl,
    );
    b.close_path();
    b
}

fn ellipse_point(cx: f64, cy: f64, rx: f64, ry: f64, angle: f64) -> KPoint {
    kp(cx + rx * angle.cos(), cy + ry * angle.sin())
}

fn append_arc(b: &mut BezPath, cx: f64, cy: f64, rx: f64, ry: f64, start: f64, sweep: f64) {
    let arc = kurbo::Arc::new(kp(cx, cy), Vec2::new(rx, ry), start, sweep, 0.0);
    arc.to_cubic_beziers(arc_tolerance(rx.max(ry)), |p1, p2, p| b.curve_to(p1, p2, p));
}

/// Ellipse filling the box, optionally a pie / arc / donut. Angles are degrees, 0 = 3 o'clock, increasing clockwise;
/// `inner` is the inner radius ratio (donut hole). Full rings use two sub-paths with opposite winding.
pub fn ellipse_path(w: f64, h: f64, arc: Option<&EllipseArc>) -> BezPath {
    let (rx, ry) = (w.max(0.0) / 2.0, h.max(0.0) / 2.0);
    let (cx, cy) = (rx, ry);
    let mut b = BezPath::new();
    let (start, mut sweep, inner) = match arc {
        Some(a) => (
            a.start.to_radians(),
            (a.end - a.start).to_radians(),
            a.inner.clamp(0.0, 1.0),
        ),
        None => (0.0, TAU, 0.0),
    };
    if sweep.abs() >= TAU - 1e-9 || sweep == 0.0 && arc.is_none() {
        sweep = TAU;
    }
    if sweep < 0.0 {
        sweep = sweep.rem_euclid(TAU);
    }
    let full = (sweep - TAU).abs() < 1e-9;
    if full {
        b.move_to(ellipse_point(cx, cy, rx, ry, start));
        append_arc(&mut b, cx, cy, rx, ry, start, TAU);
        b.close_path();
        if inner > 0.0 {
            let (irx, iry) = (rx * inner, ry * inner);
            b.move_to(ellipse_point(cx, cy, irx, iry, start));
            append_arc(&mut b, cx, cy, irx, iry, start, -TAU);
            b.close_path();
        }
        return b;
    }
    if sweep <= 0.0 {
        return b;
    }
    b.move_to(ellipse_point(cx, cy, rx, ry, start));
    append_arc(&mut b, cx, cy, rx, ry, start, sweep);
    if inner > 0.0 {
        let (irx, iry) = (rx * inner, ry * inner);
        b.line_to(ellipse_point(cx, cy, irx, iry, start + sweep));
        append_arc(&mut b, cx, cy, irx, iry, start + sweep, -sweep);
    } else {
        b.line_to(kp(cx, cy));
    }
    b.close_path();
    b
}

/// Vertices of a regular polygon (`sides` clamped to `3..=`[`MAX_POLYGON_VERTICES`], first vertex at 12 o'clock)
/// scaled so their bounds fill the box.
pub fn polygon_points(w: f64, h: f64, sides: u64) -> Vec<KPoint> {
    let n = sides.clamp(3, MAX_POLYGON_VERTICES) as usize;
    let unit: Vec<KPoint> = (0..n)
        .map(|i| {
            let a = -FRAC_PI_2 + i as f64 * TAU / n as f64;
            kp(a.cos(), a.sin())
        })
        .collect();
    fit_points(&unit, w, h)
}

/// Vertices of a star (`points` outer points clamped to `3..=`[`MAX_POLYGON_VERTICES`]` / 2`, alternating with inner
/// points at `inner_ratio`) fitted to the box.
pub fn star_points(w: f64, h: f64, points: u64, inner_ratio: f64) -> Vec<KPoint> {
    let n = points.clamp(3, MAX_POLYGON_VERTICES / 2) as usize;
    let ir = inner_ratio.clamp(0.0, 1.0);
    let unit: Vec<KPoint> = (0..2 * n)
        .map(|i| {
            let a = -FRAC_PI_2 + i as f64 * PI / n as f64;
            let r = if i % 2 == 0 { 1.0 } else { ir };
            kp(a.cos() * r, a.sin() * r)
        })
        .collect();
    // Fit to the outer points' bounds so the inner ratio does not change the star's size.
    let outer: Vec<KPoint> = unit.iter().step_by(2).copied().collect();
    let (minx, miny, maxx, maxy) = bounds_of(&outer);
    map_points(&unit, (minx, miny, maxx, maxy), w, h)
}

fn bounds_of(pts: &[KPoint]) -> (f64, f64, f64, f64) {
    pts.iter().fold(
        (
            f64::INFINITY,
            f64::INFINITY,
            f64::NEG_INFINITY,
            f64::NEG_INFINITY,
        ),
        |(a, b, c, d), p| (a.min(p.x), b.min(p.y), c.max(p.x), d.max(p.y)),
    )
}

fn map_points(
    pts: &[KPoint],
    (minx, miny, maxx, maxy): (f64, f64, f64, f64),
    w: f64,
    h: f64,
) -> Vec<KPoint> {
    let sx = if maxx > minx { w / (maxx - minx) } else { 0.0 };
    let sy = if maxy > miny { h / (maxy - miny) } else { 0.0 };
    pts.iter()
        .map(|p| kp((p.x - minx) * sx, (p.y - miny) * sy))
        .collect()
}

fn fit_points(unit: &[KPoint], w: f64, h: f64) -> Vec<KPoint> {
    map_points(unit, bounds_of(unit), w, h)
}

/// Closed polygon through `pts` with every vertex rounded by `radius` (clamped so adjacent roundings never overlap).
pub fn rounded_polygon(pts: &[KPoint], radius: f64) -> BezPath {
    let mut b = BezPath::new();
    let n = pts.len();
    if n < 3 {
        return b;
    }
    if radius <= 0.0 {
        b.move_to(pts[0]);
        for p in &pts[1..] {
            b.line_to(*p);
        }
        b.close_path();
        return b;
    }
    // Per vertex: tangent distance t = r / tan(theta / 2), limited to half of the shorter adjacent edge.
    let mut corners = Vec::with_capacity(n);
    for i in 0..n {
        let prev = pts[(i + n - 1) % n];
        let cur = pts[i];
        let next = pts[(i + 1) % n];
        let u1 = prev - cur;
        let u2 = next - cur;
        let (l1, l2) = (u1.hypot(), u2.hypot());
        if l1 == 0.0 || l2 == 0.0 {
            corners.push((cur, cur, cur, cur));
            continue;
        }
        let (u1, u2) = (u1 / l1, u2 / l2);
        let theta = u1.dot(u2).clamp(-1.0, 1.0).acos();
        let half_tan = (theta / 2.0).tan();
        if half_tan <= 1e-9 || theta >= PI - 1e-9 {
            corners.push((cur, cur, cur, cur));
            continue;
        }
        let t = (radius / half_tan).min(l1 / 2.0).min(l2 / 2.0);
        let r = t * half_tan;
        let phi = PI - theta;
        let k = 4.0 / 3.0 * (phi / 4.0).tan() * r;
        let p0 = cur + u1 * t;
        let p3 = cur + u2 * t;
        let c1 = p0 - u1 * k;
        let c2 = p3 - u2 * k;
        corners.push((p0, c1, c2, p3));
    }
    b.move_to(corners[0].3);
    for i in 1..=n {
        let (p0, c1, c2, p3) = corners[i % n];
        b.line_to(p0);
        if p0 != p3 {
            b.curve_to(c1, c2, p3);
        }
    }
    b.close_path();
    b
}

/// Regular polygon path fitted to the box with rounded vertices.
pub fn polygon_path(w: f64, h: f64, sides: u64, corner_radius: f64) -> BezPath {
    rounded_polygon(&polygon_points(w, h, sides), corner_radius)
}

/// Star path fitted to the box with rounded vertices.
pub fn star_path(w: f64, h: f64, points: u64, inner_ratio: f64, corner_radius: f64) -> BezPath {
    rounded_polygon(&star_points(w, h, points, inner_ratio), corner_radius)
}

/// One decoration at a line end.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CapGeometry {
    /// SVG path data of the decoration (line-local coordinates).
    pub path: String,
    /// True: fill with the stroke paint; false: stroke it like the shaft.
    pub filled: bool,
}

/// Geometry of a line node: the (possibly shortened) shaft plus end decorations.
#[derive(Debug, Clone, PartialEq)]
pub struct LineGeometry {
    /// Open shaft path.
    pub shaft: BezPath,
    /// Decorations as kurbo paths with their fill flag.
    pub caps: Vec<(BezPath, bool)>,
}

/// Size of line end decorations for a stroke width.
pub fn cap_size(stroke_width: f64) -> f64 {
    (stroke_width * 3.0).max(stroke_width + 6.0)
}

/// Line along +x from (0,0) to (length,0) with decorations. Filled decorations shorten the shaft so translucent
/// strokes do not double-paint; open decorations (arrow, bar) are stroked with the line's stroke.
pub fn line_geometry(length: f64, stroke_width: f64, start: Cap, end: Cap) -> LineGeometry {
    let s = cap_size(stroke_width.max(0.0));
    let mut caps = Vec::new();
    let mut x0 = 0.0;
    let mut x1 = length;
    for (cap, tip, dir) in [(start, 0.0, -1.0), (end, length, 1.0)] {
        // `dir` points outward (away from the line body) along x.
        let back = |d: f64| tip - dir * d;
        let mut p = BezPath::new();
        let (filled, inset) = match cap {
            Cap::None => continue,
            Cap::Arrow => {
                p.move_to(kp(back(s), -s * 0.6));
                p.line_to(kp(tip, 0.0));
                p.line_to(kp(back(s), s * 0.6));
                (false, 0.0)
            }
            Cap::Triangle => {
                p.move_to(kp(tip, 0.0));
                p.line_to(kp(back(s), -s * 0.6));
                p.line_to(kp(back(s), s * 0.6));
                p.close_path();
                (true, s)
            }
            Cap::Circle => {
                let c = kurbo::Circle::new(kp(tip, 0.0), s / 2.0);
                p = kurbo::Shape::to_path(&c, arc_tolerance(s / 2.0));
                (true, s / 2.0)
            }
            Cap::Square => {
                p.move_to(kp(tip - s / 2.0, -s / 2.0));
                p.line_to(kp(tip + s / 2.0, -s / 2.0));
                p.line_to(kp(tip + s / 2.0, s / 2.0));
                p.line_to(kp(tip - s / 2.0, s / 2.0));
                p.close_path();
                (true, s / 2.0)
            }
            Cap::Diamond => {
                p.move_to(kp(tip + s / 2.0, 0.0));
                p.line_to(kp(tip, s / 2.0));
                p.line_to(kp(tip - s / 2.0, 0.0));
                p.line_to(kp(tip, -s / 2.0));
                p.close_path();
                (true, s / 2.0)
            }
            Cap::Bar => {
                p.move_to(kp(tip, -s / 2.0));
                p.line_to(kp(tip, s / 2.0));
                (false, 0.0)
            }
        };
        if dir < 0.0 {
            x0 = (x0 + inset).min(length / 2.0);
        } else {
            x1 = (x1 - inset).max(length / 2.0);
        }
        caps.push((p, filled));
    }
    let mut shaft = BezPath::new();
    shaft.move_to(kp(x0, 0.0));
    shaft.line_to(kp(x1, 0.0));
    LineGeometry { shaft, caps }
}

#[cfg(test)]
mod tests {
    use super::*;
    use kurbo::Shape;

    fn area(b: &BezPath) -> f64 {
        b.area().abs()
    }

    #[test]
    fn rect_areas() {
        let sharp = rect_path(100.0, 50.0, [0.0; 4], 0.0);
        assert!((area(&sharp) - 5000.0).abs() < 1e-9);
        let round = rect_path(100.0, 50.0, [10.0; 4], 0.0);
        let expected = 5000.0 - 4.0 * (100.0 - 25.0 * PI);
        assert!(
            (area(&round) - expected).abs() < 0.5,
            "{} vs {expected}",
            area(&round)
        );
        // Smoothing keeps the shape inside the box and closer to a rectangle near edges.
        let smooth = rect_path(100.0, 100.0, [20.0; 4], 0.6);
        let bb = smooth.bounding_box();
        assert!(bb.x0 >= -1e-6 && bb.y0 >= -1e-6 && bb.x1 <= 100.0 + 1e-6 && bb.y1 <= 100.0 + 1e-6);
        let circ = rect_path(100.0, 100.0, [20.0; 4], 0.0);
        assert!(
            area(&smooth) < area(&circ),
            "smoothed corners remove more area near the corner"
        );
        assert!(area(&smooth) > area(&circ) - 600.0);
        // Over-large radii are clamped (pill).
        let pill = rect_path(100.0, 20.0, [50.0; 4], 0.0);
        assert!((area(&pill) - (80.0 * 20.0 + PI * 100.0)).abs() < 0.5);
        assert_eq!(
            clamp_radii(100.0, 20.0, [50.0, 50.0, 50.0, 50.0]),
            [10.0; 4]
        );
    }

    #[test]
    fn ellipse_variants() {
        let e = ellipse_path(100.0, 50.0, None);
        assert!((area(&e) - PI * 50.0 * 25.0).abs() < 1.0);
        let half = ellipse_path(
            100.0,
            100.0,
            Some(&EllipseArc {
                start: 0.0,
                end: 180.0,
                inner: 0.0,
                extra: Default::default(),
            }),
        );
        assert!((area(&half) - PI * 2500.0 / 2.0).abs() < 1.0);
        let bb = half.bounding_box();
        assert!(
            bb.y0 > 49.0,
            "clockwise from 3 o'clock covers the bottom half: {bb:?}"
        );
        let donut = ellipse_path(
            100.0,
            100.0,
            Some(&EllipseArc {
                start: 0.0,
                end: 360.0,
                inner: 0.5,
                extra: Default::default(),
            }),
        );
        assert!((area(&donut) - PI * (2500.0 - 625.0)).abs() < 1.5);
        let ring_sector = ellipse_path(
            100.0,
            100.0,
            Some(&EllipseArc {
                start: -90.0,
                end: 0.0,
                inner: 0.5,
                extra: Default::default(),
            }),
        );
        assert!((area(&ring_sector) - PI * (2500.0 - 625.0) / 4.0).abs() < 1.0);
    }

    #[test]
    fn polygons_fill_box() {
        let tri = polygon_path(100.0, 80.0, 3, 0.0);
        let bb = tri.bounding_box();
        assert!((bb.width() - 100.0).abs() < 1e-9 && (bb.height() - 80.0).abs() < 1e-9);
        assert!((area(&tri) - 4000.0).abs() < 1e-6);
        let star = star_path(100.0, 100.0, 5, 0.382, 0.0);
        let sb = star.bounding_box();
        assert!((sb.width() - 100.0).abs() < 1e-9 && (sb.height() - 100.0).abs() < 1e-9);
        let rounded = polygon_path(100.0, 100.0, 6, 10.0);
        assert!(area(&rounded) < area(&polygon_path(100.0, 100.0, 6, 0.0)));
    }

    #[test]
    fn line_caps() {
        let g = line_geometry(100.0, 2.0, Cap::Triangle, Cap::Arrow);
        assert_eq!(g.caps.len(), 2);
        assert!(g.caps[0].1 && !g.caps[1].1);
        let bb = g.shaft.bounding_box();
        assert_eq!(bb.x0, 8.0, "shaft shortened by the triangle length");
        assert_eq!(bb.x1, 100.0);
        let g = line_geometry(100.0, 2.0, Cap::None, Cap::None);
        assert!(g.caps.is_empty());
        for cap in Cap::ALL {
            let g = line_geometry(50.0, 4.0, *cap, *cap);
            assert!(g.shaft.bounding_box().x1 >= 25.0);
        }
    }
}
