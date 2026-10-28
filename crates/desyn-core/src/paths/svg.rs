//! SVG path data: parsing (all commands, relative and absolute, arcs, implicit repeats) and serialization.

use core::fmt;

use kurbo::{BezPath, PathEl, Point as KPoint, SvgArc, Vec2};
use serde::{Deserialize, Serialize};

use crate::canonical::canonical_number_string;
use crate::geometry::{Affine, Point, Rect};

/// An absolute path command. `S`/`T` are resolved to explicit control points and `H`/`V` to lines while parsing, so
/// every command is self-contained; arcs are kept as SVG arcs.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(tag = "cmd", rename_all = "camelCase")]
pub enum PathCommand {
    /// Start a sub-path.
    MoveTo {
        /// Point.
        to: Point,
    },
    /// Straight line.
    LineTo {
        /// Point.
        to: Point,
    },
    /// Quadratic Bézier.
    QuadTo {
        /// Control point.
        c: Point,
        /// End point.
        to: Point,
    },
    /// Cubic Bézier.
    CubicTo {
        /// First control point.
        c1: Point,
        /// Second control point.
        c2: Point,
        /// End point.
        to: Point,
    },
    /// Elliptical arc (SVG semantics).
    ArcTo {
        /// Radius x.
        rx: f64,
        /// Radius y.
        ry: f64,
        /// X axis rotation in degrees.
        rotation: f64,
        /// Large arc flag.
        large_arc: bool,
        /// Sweep flag (true = clockwise on screen).
        sweep: bool,
        /// End point.
        to: Point,
    },
    /// Close the sub-path.
    Close,
}

/// Parse error with the byte offset where parsing failed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PathParseError {
    /// Byte offset in the input.
    pub offset: usize,
    /// Description.
    pub message: String,
}

impl fmt::Display for PathParseError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "invalid path data at {}: {}", self.offset, self.message)
    }
}

impl std::error::Error for PathParseError {}

/// A parsed vector path (sequence of absolute commands).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct VectorPath {
    /// Commands.
    pub commands: Vec<PathCommand>,
}

struct Lexer<'a> {
    s: &'a [u8],
    i: usize,
}

impl<'a> Lexer<'a> {
    fn skip_ws(&mut self) {
        while self.i < self.s.len()
            && matches!(self.s[self.i], b' ' | b'\t' | b'\n' | b'\r' | b'\x0c')
        {
            self.i += 1;
        }
    }

    fn skip_ws_comma(&mut self) {
        self.skip_ws();
        if self.i < self.s.len() && self.s[self.i] == b',' {
            self.i += 1;
            self.skip_ws();
        }
    }

    fn err(&self, msg: &str) -> PathParseError {
        PathParseError {
            offset: self.i,
            message: msg.to_string(),
        }
    }

    fn at_number(&mut self) -> bool {
        self.skip_ws_comma();
        self.i < self.s.len() && matches!(self.s[self.i], b'0'..=b'9' | b'.' | b'-' | b'+')
    }

    fn number(&mut self) -> Result<f64, PathParseError> {
        self.skip_ws_comma();
        let start = self.i;
        let s = self.s;
        let mut j = self.i;
        if j < s.len() && (s[j] == b'+' || s[j] == b'-') {
            j += 1;
        }
        let mut digits = false;
        while j < s.len() && s[j].is_ascii_digit() {
            j += 1;
            digits = true;
        }
        if j < s.len() && s[j] == b'.' {
            j += 1;
            while j < s.len() && s[j].is_ascii_digit() {
                j += 1;
                digits = true;
            }
        }
        if !digits {
            return Err(self.err("expected a number"));
        }
        if j < s.len() && (s[j] == b'e' || s[j] == b'E') {
            let mut k = j + 1;
            if k < s.len() && (s[k] == b'+' || s[k] == b'-') {
                k += 1;
            }
            if k < s.len() && s[k].is_ascii_digit() {
                while k < s.len() && s[k].is_ascii_digit() {
                    k += 1;
                }
                j = k;
            }
        }
        let text = core::str::from_utf8(&s[start..j]).map_err(|_| self.err("invalid utf-8"))?;
        let v: f64 = text.parse().map_err(|_| self.err("invalid number"))?;
        if !v.is_finite() {
            return Err(self.err("number out of range"));
        }
        self.i = j;
        Ok(v)
    }

    fn flag(&mut self) -> Result<bool, PathParseError> {
        self.skip_ws_comma();
        match self.s.get(self.i) {
            Some(b'0') => {
                self.i += 1;
                Ok(false)
            }
            Some(b'1') => {
                self.i += 1;
                Ok(true)
            }
            _ => Err(self.err("expected arc flag 0 or 1")),
        }
    }
}

impl VectorPath {
    /// Parses SVG path data. Empty / whitespace-only input yields an empty path.
    pub fn parse(d: &str) -> Result<VectorPath, PathParseError> {
        let mut lx = Lexer {
            s: d.as_bytes(),
            i: 0,
        };
        let mut out = Vec::new();
        let mut cur = Point::ZERO;
        let mut start = Point::ZERO;
        let mut last_cubic_ctrl: Option<Point> = None;
        let mut last_quad_ctrl: Option<Point> = None;
        let mut cmd: Option<u8> = None;
        loop {
            lx.skip_ws_comma();
            if lx.i >= lx.s.len() {
                break;
            }
            let c = lx.s[lx.i];
            if c.is_ascii_alphabetic() {
                lx.i += 1;
                cmd = Some(c);
            } else if cmd.is_none() {
                return Err(lx.err("path must start with a command"));
            } else if !lx.at_number() {
                return Err(lx.err("unexpected character"));
            }
            let c = cmd.ok_or_else(|| lx.err("missing command"))?;
            if out.is_empty() && !matches!(c, b'M' | b'm') {
                return Err(lx.err("path must start with M"));
            }
            let rel = c.is_ascii_lowercase();
            let base = if rel { cur } else { Point::ZERO };
            let pt = |lx: &mut Lexer, base: Point| -> Result<Point, PathParseError> {
                let x = lx.number()?;
                let y = lx.number()?;
                Ok(Point::new(base.x + x, base.y + y))
            };
            let mut next_cubic = None;
            let mut next_quad = None;
            match c.to_ascii_uppercase() {
                b'M' => {
                    let p = pt(&mut lx, base)?;
                    out.push(PathCommand::MoveTo { to: p });
                    cur = p;
                    start = p;
                    // Subsequent coordinate pairs are implicit line-tos.
                    cmd = Some(if rel { b'l' } else { b'L' });
                }
                b'L' => {
                    let p = pt(&mut lx, base)?;
                    out.push(PathCommand::LineTo { to: p });
                    cur = p;
                }
                b'H' => {
                    let x = lx.number()?;
                    let p = Point::new(if rel { cur.x + x } else { x }, cur.y);
                    out.push(PathCommand::LineTo { to: p });
                    cur = p;
                }
                b'V' => {
                    let y = lx.number()?;
                    let p = Point::new(cur.x, if rel { cur.y + y } else { y });
                    out.push(PathCommand::LineTo { to: p });
                    cur = p;
                }
                b'C' => {
                    let c1 = pt(&mut lx, base)?;
                    let c2 = pt(&mut lx, base)?;
                    let p = pt(&mut lx, base)?;
                    out.push(PathCommand::CubicTo { c1, c2, to: p });
                    next_cubic = Some(c2);
                    cur = p;
                }
                b'S' => {
                    let c1 = match last_cubic_ctrl {
                        Some(lc) => Point::new(2.0 * cur.x - lc.x, 2.0 * cur.y - lc.y),
                        None => cur,
                    };
                    let c2 = pt(&mut lx, base)?;
                    let p = pt(&mut lx, base)?;
                    out.push(PathCommand::CubicTo { c1, c2, to: p });
                    next_cubic = Some(c2);
                    cur = p;
                }
                b'Q' => {
                    let q = pt(&mut lx, base)?;
                    let p = pt(&mut lx, base)?;
                    out.push(PathCommand::QuadTo { c: q, to: p });
                    next_quad = Some(q);
                    cur = p;
                }
                b'T' => {
                    let q = match last_quad_ctrl {
                        Some(lq) => Point::new(2.0 * cur.x - lq.x, 2.0 * cur.y - lq.y),
                        None => cur,
                    };
                    let p = pt(&mut lx, base)?;
                    out.push(PathCommand::QuadTo { c: q, to: p });
                    next_quad = Some(q);
                    cur = p;
                }
                b'A' => {
                    let rx = lx.number()?;
                    let ry = lx.number()?;
                    let rotation = lx.number()?;
                    let large_arc = lx.flag()?;
                    let sweep = lx.flag()?;
                    let p = pt(&mut lx, base)?;
                    out.push(PathCommand::ArcTo {
                        rx: rx.abs(),
                        ry: ry.abs(),
                        rotation,
                        large_arc,
                        sweep,
                        to: p,
                    });
                    cur = p;
                }
                b'Z' => {
                    out.push(PathCommand::Close);
                    cur = start;
                    // Z takes no arguments; a following number is an error unless a new command appears.
                    lx.skip_ws_comma();
                    if lx.i < lx.s.len() && !lx.s[lx.i].is_ascii_alphabetic() {
                        return Err(lx.err("unexpected number after Z"));
                    }
                }
                _ => {
                    return Err(PathParseError {
                        offset: lx.i - 1,
                        message: format!("unknown command {:?}", c as char),
                    });
                }
            }
            last_cubic_ctrl = next_cubic;
            last_quad_ctrl = next_quad;
        }
        Ok(VectorPath { commands: out })
    }

    /// Serializes as compact absolute SVG path data (numbers in canonical form, at most 6 decimals).
    pub fn to_svg(&self) -> String {
        let mut s = String::new();
        let n = |v: f64| canonical_number_string(v);
        let p = |pt: Point| format!("{} {}", n(pt.x), n(pt.y));
        for c in &self.commands {
            match c {
                PathCommand::MoveTo { to } => s.push_str(&format!("M{}", p(*to))),
                PathCommand::LineTo { to } => s.push_str(&format!("L{}", p(*to))),
                PathCommand::QuadTo { c, to } => s.push_str(&format!("Q{} {}", p(*c), p(*to))),
                PathCommand::CubicTo { c1, c2, to } => {
                    s.push_str(&format!("C{} {} {}", p(*c1), p(*c2), p(*to)))
                }
                PathCommand::ArcTo {
                    rx,
                    ry,
                    rotation,
                    large_arc,
                    sweep,
                    to,
                } => s.push_str(&format!(
                    "A{} {} {} {} {} {}",
                    n(*rx),
                    n(*ry),
                    n(*rotation),
                    u8::from(*large_arc),
                    u8::from(*sweep),
                    p(*to)
                )),
                PathCommand::Close => s.push('Z'),
            }
        }
        s
    }

    /// Converts to a kurbo path (arcs become cubic Béziers).
    pub fn to_bez(&self) -> BezPath {
        let mut b = BezPath::new();
        let mut cur = KPoint::ZERO;
        let mut start = KPoint::ZERO;
        let k = |p: Point| KPoint::new(p.x, p.y);
        for c in &self.commands {
            match *c {
                PathCommand::MoveTo { to } => {
                    b.move_to(k(to));
                    cur = k(to);
                    start = cur;
                }
                PathCommand::LineTo { to } => {
                    b.line_to(k(to));
                    cur = k(to);
                }
                PathCommand::QuadTo { c, to } => {
                    b.quad_to(k(c), k(to));
                    cur = k(to);
                }
                PathCommand::CubicTo { c1, c2, to } => {
                    b.curve_to(k(c1), k(c2), k(to));
                    cur = k(to);
                }
                PathCommand::ArcTo {
                    rx,
                    ry,
                    rotation,
                    large_arc,
                    sweep,
                    to,
                } => {
                    let arc = SvgArc {
                        from: cur,
                        to: k(to),
                        radii: Vec2::new(rx, ry),
                        x_rotation: rotation.to_radians(),
                        large_arc,
                        sweep,
                    };
                    match kurbo::Arc::from_svg_arc(&arc) {
                        Some(a) => a.to_cubic_beziers(
                            super::shapes::arc_tolerance(a.radii.x.max(a.radii.y)),
                            |p1, p2, p| b.curve_to(p1, p2, p),
                        ),
                        // Degenerate arcs (zero radius / same endpoints) are straight lines per the SVG spec.
                        None => b.line_to(k(to)),
                    }
                    cur = k(to);
                }
                PathCommand::Close => {
                    b.close_path();
                    cur = start;
                }
            }
        }
        b
    }

    /// Builds a path from kurbo elements.
    pub fn from_bez(b: &BezPath) -> VectorPath {
        let p = |q: KPoint| Point::new(q.x, q.y);
        let commands = b
            .elements()
            .iter()
            .map(|el| match *el {
                PathEl::MoveTo(a) => PathCommand::MoveTo { to: p(a) },
                PathEl::LineTo(a) => PathCommand::LineTo { to: p(a) },
                PathEl::QuadTo(c, a) => PathCommand::QuadTo { c: p(c), to: p(a) },
                PathEl::CurveTo(c1, c2, a) => PathCommand::CubicTo {
                    c1: p(c1),
                    c2: p(c2),
                    to: p(a),
                },
                PathEl::ClosePath => PathCommand::Close,
            })
            .collect();
        VectorPath { commands }
    }

    /// Exact bounding box of the geometry (`None` for an empty path).
    pub fn bounds(&self) -> Option<Rect> {
        bez_bounds(&self.to_bez())
    }

    /// Applies an affine transform (arcs are converted to curves first).
    pub fn transformed(&self, t: &Affine) -> VectorPath {
        let mut b = self.to_bez();
        b.apply_affine(t.to_kurbo());
        VectorPath::from_bez(&b)
    }
}

/// Exact bounding box of a kurbo path (`None` when it has no segments or points).
pub fn bez_bounds(b: &BezPath) -> Option<Rect> {
    if b.elements().is_empty() {
        return None;
    }
    let r = kurbo::Shape::bounding_box(b);
    if !r.x0.is_finite() || !r.x1.is_finite() {
        return None;
    }
    Some(Rect::new(r.x0, r.y0, r.width(), r.height()))
}

/// Parses SVG path data straight to a kurbo path.
pub fn parse_svg_path(d: &str) -> Result<BezPath, PathParseError> {
    VectorPath::parse(d).map(|p| p.to_bez())
}

/// Serializes a kurbo path as compact SVG path data.
pub fn bez_to_svg(b: &BezPath) -> String {
    VectorPath::from_bez(b).to_svg()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_all_commands() {
        let p = VectorPath::parse("M10 10 h10 v10 H5 V5 L1,1 l1-1 C1 2 3 4 5 6 s1 1 2 2 Q1 1 2 2 t3 3 A5 5 0 0 1 20 20 a5,5 30 1,0 5 5 z m1 1 2 2").unwrap();
        let kinds: Vec<&str> = p
            .commands
            .iter()
            .map(|c| match c {
                PathCommand::MoveTo { .. } => "M",
                PathCommand::LineTo { .. } => "L",
                PathCommand::QuadTo { .. } => "Q",
                PathCommand::CubicTo { .. } => "C",
                PathCommand::ArcTo { .. } => "A",
                PathCommand::Close => "Z",
            })
            .collect();
        assert_eq!(
            kinds,
            vec![
                "M", "L", "L", "L", "L", "L", "L", "C", "C", "Q", "Q", "A", "A", "Z", "M", "L"
            ]
        );
        assert_eq!(
            p.commands[1],
            PathCommand::LineTo {
                to: Point::new(20.0, 10.0)
            }
        );
        // m after z is relative to the sub-path start (10,10).
        assert_eq!(
            p.commands[14],
            PathCommand::MoveTo {
                to: Point::new(11.0, 11.0)
            }
        );
        assert_eq!(
            p.commands[15],
            PathCommand::LineTo {
                to: Point::new(13.0, 13.0)
            }
        );
        // S reflects the previous cubic control point (3,4) about (5,6).
        if let PathCommand::CubicTo { c1, .. } = p.commands[8] {
            assert_eq!(c1, Point::new(7.0, 8.0));
        } else {
            panic!()
        }
    }

    #[test]
    fn compact_numbers_and_flags() {
        let p = VectorPath::parse("M.5.5L-1e1-2.5e-1a1 1 0 011 1").unwrap();
        assert_eq!(
            p.commands[0],
            PathCommand::MoveTo {
                to: Point::new(0.5, 0.5)
            }
        );
        assert_eq!(
            p.commands[1],
            PathCommand::LineTo {
                to: Point::new(-10.0, -0.25)
            }
        );
        assert!(matches!(
            p.commands[2],
            PathCommand::ArcTo {
                large_arc: false,
                sweep: true,
                ..
            }
        ));
    }

    #[test]
    fn errors() {
        assert!(VectorPath::parse("L1 1").is_err());
        assert!(VectorPath::parse("M1").is_err());
        assert!(VectorPath::parse("M1 1 X").is_err());
        assert!(VectorPath::parse("M0 0 A1 1 0 2 0 1 1").is_err());
        assert!(VectorPath::parse("M0 0 Z 5").is_err());
        assert_eq!(VectorPath::parse("  ").unwrap().commands.len(), 0);
    }

    #[test]
    fn roundtrip_and_bounds() {
        let src = "M0 0L100 0L100 50Z";
        let p = VectorPath::parse(src).unwrap();
        assert_eq!(p.to_svg(), src);
        assert_eq!(p.bounds(), Some(Rect::new(0.0, 0.0, 100.0, 50.0)));
        let arc = VectorPath::parse("M0 50 A50 50 0 0 1 100 50").unwrap();
        let b = arc.bounds().unwrap();
        assert!(
            (b.y - 0.0).abs() < 0.01 && (b.h - 50.0).abs() < 0.01 && (b.w - 100.0).abs() < 1e-9
        );
        let t = p.transformed(&Affine::translate(10.0, 0.0));
        assert_eq!(t.bounds(), Some(Rect::new(10.0, 0.0, 100.0, 50.0)));
        assert_eq!(VectorPath::parse(&arc.to_svg()).unwrap(), arc);
    }
}
