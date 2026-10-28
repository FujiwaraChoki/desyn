//! Canvas overlay as plain data (screen coordinates, logical px): selection boxes, transform handles, hover
//! outlines, marquee, snap guides, smart distances, ruler guides, layout grid, pixel grid, pen anchors and
//! handles, text caret and selection. The UI paints these with theme colors; tests inspect them directly.

use desyn_core::geometry::{Point, Rect};

/// Paint role (mapped to theme colors by the UI).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    /// Selection outline and handles (sun).
    Selection,
    /// Hover outline (sun, lighter).
    Hover,
    /// Child outlines of a selected container / entered scope (faint).
    Scope,
    /// Marquee rectangle.
    Marquee,
    /// Snap alignment lines and smart distances (ember).
    Snap,
    /// Ruler guides.
    Guide,
    /// Layout grid columns.
    Grid,
    /// Pixel grid lines.
    PixelGrid,
    /// Pen path preview and anchors.
    Pen,
    /// Text caret.
    Caret,
    /// Text selection highlight.
    TextSelection,
    /// IME composition underline.
    Composition,
    /// Page outline for pages without a background.
    PageEdge,
}

/// A primitive.
#[derive(Debug, Clone, PartialEq)]
pub enum Prim {
    /// Closed polygon (rotated boxes), optional fill.
    Poly {
        pts: Vec<Point>,
        role: Role,
        width: f64,
        fill: bool,
        dashed: bool,
    },
    /// Polyline.
    Line {
        pts: Vec<Point>,
        role: Role,
        width: f64,
        dashed: bool,
    },
    /// Square resize handle (centered, rotated).
    Handle {
        center: Point,
        size: f64,
        rotation: f64,
    },
    /// Round anchor or handle dot.
    Dot {
        center: Point,
        radius: f64,
        role: Role,
        filled: bool,
    },
    /// Measurement / size pill.
    Label { at: Point, text: String, role: Role },
    /// Soft sun glow around a layer (AI activity); `intensity` 0..1.
    Glow { pts: Vec<Point>, intensity: f64 },
    /// Axis-aligned filled rect (grid columns, caret, text selection).
    Fill { rect: Rect, role: Role },
}

/// Overlay contents.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Overlay {
    /// Primitives, painted in order.
    pub prims: Vec<Prim>,
}

impl Overlay {
    /// Adds a box outline from 4 screen corners.
    pub fn quad(&mut self, pts: [Point; 4], role: Role, width: f64) {
        self.prims.push(Prim::Poly {
            pts: pts.to_vec(),
            role,
            width,
            fill: false,
            dashed: false,
        });
    }

    /// Adds a line segment.
    pub fn line(&mut self, a: Point, b: Point, role: Role, width: f64, dashed: bool) {
        self.prims.push(Prim::Line {
            pts: vec![a, b],
            role,
            width,
            dashed,
        });
    }

    /// Number of primitives with a role (tests).
    pub fn count(&self, role: Role) -> usize {
        self.prims
            .iter()
            .filter(|p| match p {
                Prim::Poly { role: r, .. }
                | Prim::Line { role: r, .. }
                | Prim::Dot { role: r, .. } => *r == role,
                Prim::Label { role: r, .. } | Prim::Fill { role: r, .. } => *r == role,
                Prim::Handle { .. } | Prim::Glow { .. } => role == Role::Selection,
            })
            .count()
    }

    /// Labels (tests).
    pub fn labels(&self) -> Vec<&str> {
        self.prims
            .iter()
            .filter_map(|p| match p {
                Prim::Label { text, .. } => Some(text.as_str()),
                _ => None,
            })
            .collect()
    }
}

/// Formats a design-px value for labels (no trailing zeros, at most 2 decimals).
pub fn fmt_px(v: f64) -> String {
    let r = (v * 100.0).round() / 100.0;
    if (r - r.round()).abs() < 1e-9 {
        format!("{}", r.round() as i64)
    } else {
        format!("{r}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats() {
        assert_eq!(fmt_px(12.0), "12");
        assert_eq!(fmt_px(12.345), "12.35");
        assert_eq!(fmt_px(-0.001), "0");
        let mut o = Overlay::default();
        o.line(
            Point::new(0.0, 0.0),
            Point::new(1.0, 1.0),
            Role::Snap,
            1.0,
            false,
        );
        assert_eq!(o.count(Role::Snap), 1);
    }
}
