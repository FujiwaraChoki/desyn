//! Text on a path: per-glyph placements along a vector path, and the text-on-arc layout of
//! `TextNode.curve` (degrees of sweep; positive bends like a rainbow, negative like a smile).

use desyn_core::geometry::{Affine as CoreAffine, Rect};
use desyn_core::paths::flatten_bez;
use desyn_core::paths::kurbo::{Affine, BezPath, Point, Vec2};
use serde::Serialize;

use crate::types::LaidOutText;

/// Where the text sits along the path.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PathAlign {
    /// From the path start (plus offset).
    #[default]
    Start,
    /// Centered on the path.
    Center,
    /// Ending at the path end.
    End,
}

/// Options for [`place_on_path`].
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct PathTextOptions {
    /// Extra distance along the path, px.
    pub offset: f64,
    /// Alignment along the path.
    pub align: PathAlign,
    /// Moves the baseline away from the path (positive = to the left of the path direction, i.e. "up").
    pub baseline_offset: f64,
}

/// A glyph transformed onto a path.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlacedGlyph {
    /// Run index in [`LaidOutText::runs`].
    pub run: usize,
    /// Glyph index in the run.
    pub glyph: usize,
    /// Maps glyph-local coordinates (px, y down, origin at the glyph origin) to path / box coordinates.
    pub transform: CoreAffine,
    /// False when the glyph falls beyond the end of an open path (it is placed on the extended end tangent).
    pub visible: bool,
}

fn to_core(a: Affine) -> CoreAffine {
    let c = a.as_coeffs();
    CoreAffine::new(c)
}

struct Measured {
    points: Vec<Point>,
    cum: Vec<f64>,
    closed: bool,
}

impl Measured {
    fn new(path: &BezPath) -> Option<Measured> {
        let polys = flatten_bez(path, 0.05);
        let mut points: Vec<Point> = Vec::new();
        let mut closed = false;
        for (i, poly) in polys.iter().enumerate() {
            for p in &poly.points {
                let p = Point::new(p.x, p.y);
                if points.last().is_none_or(|q| q.distance(p) > 1e-9) {
                    points.push(p);
                }
            }
            if i == 0 {
                closed = poly.closed && polys.len() == 1;
                if closed && let Some(first) = poly.points.first() {
                    points.push(Point::new(first.x, first.y));
                }
            }
        }
        if points.len() < 2 {
            return None;
        }
        let mut cum = Vec::with_capacity(points.len());
        let mut acc = 0.0;
        cum.push(0.0);
        for w in points.windows(2) {
            acc += w[0].distance(w[1]);
            cum.push(acc);
        }
        (acc > 1e-9).then_some(Measured {
            points,
            cum,
            closed,
        })
    }

    fn length(&self) -> f64 {
        *self.cum.last().unwrap_or(&0.0)
    }

    /// Point and unit tangent at distance `s` (extrapolated along the end tangents).
    fn at(&self, s: f64) -> (Point, Vec2) {
        let n = self.points.len();
        let seg = |i: usize| {
            let d = self.points[i + 1] - self.points[i];
            let len = d.hypot().max(1e-12);
            d / len
        };
        if s <= 0.0 {
            let t = seg(0);
            return (self.points[0] + t * s, t);
        }
        if s >= self.length() {
            let t = seg(n - 2);
            return (self.points[n - 1] + t * (s - self.length()), t);
        }
        let i = self
            .cum
            .partition_point(|c| *c <= s)
            .saturating_sub(1)
            .min(n - 2);
        let t = seg(i);
        (self.points[i] + t * (s - self.cum[i]), t)
    }
}

/// Places every glyph along `path` (box coordinates). Glyphs keep their horizontal layout positions relative to
/// the first line's start; later lines sit below the path by their baseline distance.
pub fn place_on_path(
    laid: &LaidOutText,
    path: &BezPath,
    opts: &PathTextOptions,
) -> Vec<PlacedGlyph> {
    let Some(m) = Measured::new(path) else {
        return Vec::new();
    };
    let Some(first) = laid.lines.first() else {
        return Vec::new();
    };
    let total = m.length();
    let width = laid.lines.iter().map(|l| l.width).fold(0.0f64, f64::max);
    let start = opts.offset
        + match opts.align {
            PathAlign::Start => 0.0,
            PathAlign::Center => (total - width) / 2.0,
            PathAlign::End => total - width,
        };
    let mut out = Vec::new();
    for (ri, run) in laid.runs.iter().enumerate() {
        let line_x = laid.lines.get(run.line).map_or(first.x, |l| l.x);
        for (gi, g) in run.glyphs.iter().enumerate() {
            let mut s = start + (g.x - line_x) + g.advance / 2.0;
            let mut visible = true;
            if m.closed {
                s = s.rem_euclid(total);
            } else if s < 0.0 || s > total {
                visible = false;
            }
            let (p, t) = m.at(s);
            let angle = t.y.atan2(t.x);
            let local = Affine::translate((
                -g.advance / 2.0,
                g.y - first.baseline - opts.baseline_offset,
            ));
            let a = Affine::translate(p.to_vec2()) * Affine::rotate(angle) * local;
            out.push(PlacedGlyph {
                run: ri,
                glyph: gi,
                transform: to_core(a),
                visible,
            });
        }
    }
    out
}

/// Text-on-arc placements for `TextNode.curve` (degrees of sweep over the widest line). Straight text (|curve| <
/// 0.01) maps every glyph to its laid out position.
pub fn place_on_curve(laid: &LaidOutText, curve_deg: f64) -> Vec<PlacedGlyph> {
    let straight = !curve_deg.is_finite() || curve_deg.abs() < 0.01;
    let theta = curve_deg.clamp(-359.0, 359.0).to_radians();
    let width = laid.content_width.max(1e-6);
    let r = width / theta.abs().max(1e-9);
    let cx = laid.width / 2.0;
    let b0 = laid.first_baseline;
    let mut out = Vec::new();
    for (ri, run) in laid.runs.iter().enumerate() {
        for (gi, g) in run.glyphs.iter().enumerate() {
            let a = if straight {
                Affine::translate((g.x, g.y))
            } else {
                let s = g.x + g.advance / 2.0 - cx;
                let below = g.y - b0;
                let phi = s / r;
                let local = Affine::translate((-g.advance / 2.0, 0.0));
                if theta > 0.0 {
                    let rad = r - below;
                    let p = Point::new(cx + rad * phi.sin(), b0 + r - rad * phi.cos());
                    Affine::translate(p.to_vec2()) * Affine::rotate(phi) * local
                } else {
                    let rad = r + below;
                    let p = Point::new(cx + rad * phi.sin(), b0 - r + rad * phi.cos());
                    Affine::translate(p.to_vec2()) * Affine::rotate(-phi) * local
                }
            };
            out.push(PlacedGlyph {
                run: ri,
                glyph: gi,
                transform: to_core(a),
                visible: true,
            });
        }
    }
    out
}

/// Bounds of placed glyphs, using each glyph's advance and its line's ascent / descent as the glyph box.
pub fn placements_bounds(laid: &LaidOutText, placements: &[PlacedGlyph]) -> Option<Rect> {
    let mut acc: Option<Rect> = None;
    for p in placements.iter().filter(|p| p.visible) {
        let run = laid.runs.get(p.run)?;
        let g = run.glyphs.get(p.glyph)?;
        let line = laid.lines.get(run.line)?;
        let corners = [
            (0.0, -line.ascent),
            (g.advance, -line.ascent),
            (0.0, line.descent),
            (g.advance, line.descent),
        ];
        let t = p.transform.to_kurbo();
        for (x, y) in corners {
            let q = t * Point::new(x, y);
            let r = Rect {
                x: q.x,
                y: q.y,
                w: 0.0,
                h: 0.0,
            };
            acc = Some(match acc {
                Some(a) => a.union(&r),
                None => r,
            });
        }
    }
    acc
}
