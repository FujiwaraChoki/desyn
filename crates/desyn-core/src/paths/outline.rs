//! Fill outlines of nodes in node-local coordinates (`0..width x 0..height`).

use kurbo::BezPath;

use super::boolean::{Shape, boolean};
use super::shapes::{ellipse_path, line_geometry, polygon_path, rect_path, star_path};
use super::stroke::{StrokeStyle, stroke_outline};
use super::svg::parse_svg_path;
use crate::geometry::local_transform;
use crate::model::{
    BoolOp, Design, FillRule, ImageShape, ImageShapeKind, Node, StrokeCap, StrokeJoin,
};

/// A node's fill geometry.
#[derive(Debug, Clone)]
pub struct Outline {
    /// Path in node-local coordinates.
    pub path: BezPath,
    /// Fill rule.
    pub fill_rule: FillRule,
}

fn rect_like(n: &Node) -> BezPath {
    let b = n.base();
    let smoothing = n.shaped().and_then(|s| s.corner_smoothing).unwrap_or(0.0);
    rect_path(b.width, b.height, n.corner_radii(), smoothing)
}

/// Outline of a line node: its stroke outline (shaft + decorations).
pub fn line_outline(n: &Node, tolerance: f64) -> BezPath {
    let Node::Line(l) = n else {
        return BezPath::new();
    };
    let width = l
        .strokes
        .iter()
        .filter(|s| s.is_visible())
        .map(|s| s.width)
        .fold(0.0, f64::max)
        .max(1.0);
    let s0 = l.strokes.first();
    let style = StrokeStyle {
        width,
        cap: s0.map(|s| s.cap).unwrap_or(StrokeCap::Butt),
        join: s0.map(|s| s.join).unwrap_or(StrokeJoin::Miter),
        miter_limit: s0.and_then(|s| s.miter_limit).unwrap_or(4.0),
        dash: Vec::new(),
    };
    let g = line_geometry(l.base.width, width, l.start_cap, l.end_cap);
    let mut out = stroke_outline(&g.shaft, &style, tolerance);
    for (cap, filled) in g.caps {
        if filled {
            out.extend(cap);
        } else {
            out.extend(stroke_outline(&cap, &style, tolerance));
        }
    }
    out
}

/// How many group / boolean levels an outline descends into. Deeper descendants (only hostile documents nest this
/// far) do not contribute, which keeps the recursion within the small stacks of wasm hosts.
pub const MAX_OUTLINE_DEPTH: usize = 128;

/// Fill outline of a node (local coordinates). `None` for nodes without geometry (root, audio) or an empty group.
/// Curves of booleans are flattened with `tolerance`. Groups and booleans contribute descendants up to
/// [`MAX_OUTLINE_DEPTH`] levels down.
pub fn node_outline(d: &Design, id: &str, tolerance: f64) -> Option<Outline> {
    outline_at(d, id, tolerance, 0)
}

fn outline_at(d: &Design, id: &str, tolerance: f64, depth: usize) -> Option<Outline> {
    let n = d.node(id)?;
    if depth > MAX_OUTLINE_DEPTH && n.is_container() {
        return None;
    }
    let b = n.base();
    let nonzero = |path: BezPath| {
        Some(Outline {
            path,
            fill_rule: FillRule::Nonzero,
        })
    };
    match n {
        Node::Root(_) | Node::Audio(_) => None,
        Node::Ellipse(e) => nonzero(ellipse_path(b.width, b.height, e.arc.as_ref())),
        Node::Polygon(p) => nonzero(polygon_path(
            b.width,
            b.height,
            p.sides,
            n.corner_radii()[0],
        )),
        Node::Star(s) => nonzero(star_path(
            b.width,
            b.height,
            s.points,
            s.inner_ratio,
            n.corner_radii()[0],
        )),
        Node::Line(_) => nonzero(line_outline(n, tolerance)),
        Node::Path(p) => {
            let parsed: Vec<(BezPath, FillRule)> = p
                .paths
                .iter()
                .filter_map(|pd| parse_svg_path(&pd.d).ok().map(|b| (b, pd.fill_rule)))
                .collect();
            let first_rule = parsed.first().map(|x| x.1).unwrap_or(FillRule::Nonzero);
            if parsed.iter().all(|x| x.1 == first_rule) {
                let mut path = BezPath::new();
                for (b, _) in parsed {
                    path.extend(b);
                }
                Some(Outline {
                    path,
                    fill_rule: first_rule,
                })
            } else {
                let shapes: Vec<Shape> = parsed
                    .into_iter()
                    .map(|(path, fill_rule)| Shape { path, fill_rule })
                    .collect();
                nonzero(boolean(&shapes, BoolOp::Union, tolerance))
            }
        }
        Node::Image(i) => match &i.shape {
            Some(ImageShape::Named(ImageShapeKind::Ellipse)) => {
                nonzero(ellipse_path(b.width, b.height, None))
            }
            Some(ImageShape::Path { path, .. }) => {
                let mut p = parse_svg_path(path).ok()?;
                p.apply_affine(kurbo::Affine::scale_non_uniform(b.width, b.height));
                nonzero(p)
            }
            _ => nonzero(rect_like(n)),
        },
        Node::Boolean(bn) => {
            let shapes: Vec<Shape> = bn
                .container
                .children
                .iter()
                .filter(|c| d.node(c).is_some_and(|c| c.base().visible))
                .filter_map(|c| {
                    let o = outline_at(d, c, tolerance, depth + 1)?;
                    let mut path = o.path;
                    path.apply_affine(local_transform(d.node(c)?.base()).to_kurbo());
                    Some(Shape {
                        path,
                        fill_rule: o.fill_rule,
                    })
                })
                .collect();
            if shapes.is_empty() {
                return None;
            }
            nonzero(boolean(&shapes, bn.op, tolerance))
        }
        Node::Group(g) => {
            let mut path = BezPath::new();
            for c in &g.container.children {
                if let (Some(o), Some(cn)) = (outline_at(d, c, tolerance, depth + 1), d.node(c)) {
                    let mut p = o.path;
                    p.apply_affine(local_transform(cn.base()).to_kurbo());
                    path.extend(p);
                }
            }
            if path.elements().is_empty() {
                None
            } else {
                nonzero(path)
            }
        }
        _ => nonzero(rect_like(n)),
    }
}

/// SVG path data of a node's fill outline (local coordinates).
pub fn node_path_data(d: &Design, id: &str, tolerance: f64) -> Option<String> {
    node_outline(d, id, tolerance).map(|o| super::svg::bez_to_svg(&o.path))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::DesignKind;
    use kurbo::Shape as _;

    #[test]
    fn boolean_node_outline() {
        let mut d = Design::with_page(
            "dddddddddddd",
            "D",
            DesignKind::Poster,
            "pppppppppppp",
            500.0,
            500.0,
        );
        d.push_child(
            "pppppppppppp",
            Node::boolean(
                "bbbbbbbbbbbb",
                "B",
                BoolOp::Subtract,
                0.0,
                0.0,
                100.0,
                100.0,
            ),
        );
        d.push_child(
            "bbbbbbbbbbbb",
            Node::rect("rrrrrrrrrrrr", "R", 0.0, 0.0, 100.0, 100.0),
        );
        d.push_child(
            "bbbbbbbbbbbb",
            Node::ellipse("eeeeeeeeeeee", "E", 25.0, 25.0, 50.0, 50.0),
        );
        let o = node_outline(&d, "bbbbbbbbbbbb", 0.05).unwrap();
        let expected = 10000.0 - std::f64::consts::PI * 625.0;
        assert!((o.path.area().abs() - expected).abs() < 5.0);
        assert!(!o.path.contains(kurbo::Point::new(50.0, 50.0)));
        assert!(o.path.contains(kurbo::Point::new(5.0, 5.0)));
        assert!(
            node_path_data(&d, "rrrrrrrrrrrr", 0.1)
                .unwrap()
                .starts_with("M0 0L100 0")
        );
    }
}
