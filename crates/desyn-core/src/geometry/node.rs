//! Node transforms, oriented boxes and bounds.

use serde::{Deserialize, Serialize};

use super::primitives::{Affine, Point, Rect};
use crate::model::{Base, Design, Node, NodeType};

/// A rectangle `0..width x 0..height` placed in some space by `transform` (local -> space).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct OrientedBox {
    /// Local -> space transform.
    pub transform: Affine,
    /// Local width.
    pub width: f64,
    /// Local height.
    pub height: f64,
}

impl OrientedBox {
    /// Axis-aligned box from a rect.
    pub fn from_rect(r: Rect) -> Self {
        OrientedBox {
            transform: Affine::translate(r.x, r.y),
            width: r.w,
            height: r.h,
        }
    }

    /// Corners in space: top-left, top-right, bottom-right, bottom-left (in local orientation).
    pub fn corners(&self) -> [Point; 4] {
        let t = &self.transform;
        [
            t.apply(Point::new(0.0, 0.0)),
            t.apply(Point::new(self.width, 0.0)),
            t.apply(Point::new(self.width, self.height)),
            t.apply(Point::new(0.0, self.height)),
        ]
    }

    /// Center in space.
    pub fn center(&self) -> Point {
        self.transform
            .apply(Point::new(self.width / 2.0, self.height / 2.0))
    }

    /// Axis-aligned bounding box in space.
    pub fn aabb(&self) -> Rect {
        self.transform
            .transform_rect_bbox(&Rect::new(0.0, 0.0, self.width, self.height))
    }

    /// Point (in space) inside the box, expanded by `tolerance` in local units.
    pub fn contains(&self, p: Point, tolerance: f64) -> bool {
        match self.transform.inverse() {
            Some(inv) => {
                let l = inv.apply(p);
                l.x >= -tolerance
                    && l.y >= -tolerance
                    && l.x <= self.width + tolerance
                    && l.y <= self.height + tolerance
            }
            None => {
                // Degenerate (zero-size) box: fall back to distance from the transformed segment.
                let c = self.corners();
                super::primitives::point_polyline_distance(p, &c, true) <= tolerance
            }
        }
    }

    /// Separating-axis overlap test against another oriented box (touching counts).
    pub fn intersects(&self, o: &OrientedBox) -> bool {
        let a = self.corners();
        let b = o.corners();
        let axes = [a[1] - a[0], a[3] - a[0], b[1] - b[0], b[3] - b[0]];
        for axis in axes {
            let axis = if axis.length() == 0.0 {
                continue;
            } else {
                axis.normalize()
            };
            let (amin, amax) = project(&a, axis);
            let (bmin, bmax) = project(&b, axis);
            if amax < bmin - 1e-9 || bmax < amin - 1e-9 {
                return false;
            }
        }
        // All axes overlapped; for degenerate boxes also require AABB overlap.
        self.aabb().intersects(&o.aabb())
    }

    /// True when the box lies fully inside `r`.
    pub fn inside_rect(&self, r: &Rect) -> bool {
        self.corners().iter().all(|p| r.contains(*p))
    }

    /// Rotation of the box x axis in degrees.
    pub fn rotation_deg(&self) -> f64 {
        self.transform.rotation_deg()
    }
}

fn project(pts: &[Point; 4], axis: Point) -> (f64, f64) {
    let mut lo = f64::INFINITY;
    let mut hi = f64::NEG_INFINITY;
    for p in pts {
        let d = p.dot(axis);
        lo = lo.min(d);
        hi = hi.max(d);
    }
    (lo, hi)
}

/// Transform from a node's local box to its parent's space:
/// `translate(x, y) * rotate_about_center(rotation) * flip_about_center`.
pub fn local_transform(b: &Base) -> Affine {
    local_transform_parts(
        b.x,
        b.y,
        b.width,
        b.height,
        b.rotation,
        b.flipped_x(),
        b.flipped_y(),
    )
}

/// [`local_transform`] from raw values.
pub fn local_transform_parts(
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    rotation: f64,
    flip_x: bool,
    flip_y: bool,
) -> Affine {
    if rotation == 0.0 && !flip_x && !flip_y {
        return Affine::translate(x, y);
    }
    let (cx, cy) = (w / 2.0, h / 2.0);
    let sx = if flip_x { -1.0 } else { 1.0 };
    let sy = if flip_y { -1.0 } else { 1.0 };
    Affine::translate(x + cx, y + cy)
        * Affine::rotate_deg(rotation)
        * Affine::scale(sx, sy)
        * Affine::translate(-cx, -cy)
}

/// Placement of a node inside its parent (the transform-related base fields).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Placement {
    /// X.
    pub x: f64,
    /// Y.
    pub y: f64,
    /// Rotation in degrees (-180..180].
    pub rotation: f64,
    /// Horizontal flip.
    pub flip_x: bool,
    /// Vertical flip (always false from [`decompose_local`]; a vertical flip is expressed as flipX + 180°).
    pub flip_y: bool,
}

/// Decomposes a rigid (rotation + optional mirror + translation) transform into node placement fields for a box of
/// size `w x h`. Scale/skew in `t` is ignored (the box keeps its size).
pub fn decompose_local(t: &Affine, w: f64, h: f64) -> Placement {
    let flip_x = t.determinant() < 0.0;
    // Linear part M = R * S(flip). Remove the flip to read the rotation.
    let m = if flip_x {
        *t * Affine::scale(-1.0, 1.0)
    } else {
        *t
    };
    let mut rotation = m.b.atan2(m.a).to_degrees();
    if rotation <= -180.0 {
        rotation += 360.0;
    }
    if rotation.abs() < 1e-9 {
        rotation = 0.0;
    }
    // t(p) = (x, y) + c + L(p - c)  =>  (x, y) = t(c) - c.
    let c = Point::new(w / 2.0, h / 2.0);
    let tc = t.apply(c);
    Placement {
        x: tc.x - c.x,
        y: tc.y - c.y,
        rotation,
        flip_x,
        flip_y: false,
    }
}

/// World transform of a node relative to its page (page-local coordinates). Pages and the root map to identity.
pub fn world_transform(d: &Design, id: &str) -> Affine {
    let mut chain: Vec<&Node> = Vec::new();
    let mut cur = d.node(id);
    let mut guard = 0usize;
    while let Some(n) = cur {
        if matches!(n.node_type(), NodeType::Page | NodeType::Root) {
            break;
        }
        chain.push(n);
        guard += 1;
        if guard > d.nodes.len() {
            break;
        }
        cur = n.parent().and_then(|p| d.node(p));
    }
    let mut t = Affine::IDENTITY;
    for n in chain.iter().rev() {
        t = t * local_transform(n.base());
    }
    t
}

/// Transform of a node's parent space relative to the page (identity for page children).
pub fn parent_world_transform(d: &Design, id: &str) -> Affine {
    match d.node(id).and_then(Node::parent) {
        Some(p) => world_transform(d, p),
        None => Affine::IDENTITY,
    }
}

/// Oriented box of a node in page coordinates.
pub fn node_obb(d: &Design, id: &str) -> Option<OrientedBox> {
    let n = d.node(id)?;
    let b = n.base();
    Some(OrientedBox {
        transform: world_transform(d, id),
        width: b.width,
        height: b.height,
    })
}

/// Rotated bounding box of a node in page coordinates.
pub fn node_aabb(d: &Design, id: &str) -> Option<Rect> {
    node_obb(d, id).map(|o| o.aabb())
}

/// Bounding box of a node in its parent's space (accounts for rotation and flips).
pub fn bounds_in_parent(b: &Base) -> Rect {
    if b.rotation == 0.0 {
        return Rect::new(b.x, b.y, b.width, b.height);
    }
    local_transform(b).transform_rect_bbox(&Rect::new(0.0, 0.0, b.width, b.height))
}

/// Size of the rotated bounding box of a `w x h` box rotated by `rotation` degrees.
pub fn rotated_size(w: f64, h: f64, rotation: f64) -> (f64, f64) {
    if rotation == 0.0 {
        return (w, h);
    }
    let (s, c) = rotation.to_radians().sin_cos();
    let (s, c) = (s.abs(), c.abs());
    (w * c + h * s, w * s + h * c)
}

/// Placement that keeps a node's world position when it is moved under `new_parent`.
pub fn reparent_placement(d: &Design, id: &str, new_parent: &str) -> Option<Placement> {
    let n = d.node(id)?;
    let world = world_transform(d, id);
    let parent_world = match d.node(new_parent)?.node_type() {
        NodeType::Page | NodeType::Root => Affine::IDENTITY,
        _ => world_transform(d, new_parent),
    };
    let local = parent_world.inverse()? * world;
    let b = n.base();
    Some(decompose_local(&local, b.width, b.height))
}

/// Union of the rotated bounding boxes of the given nodes in page coordinates.
pub fn selection_aabb(d: &Design, ids: &[String]) -> Option<Rect> {
    let rects: Vec<Rect> = ids.iter().filter_map(|id| node_aabb(d, id)).collect();
    super::primitives::union_bounds(rects.iter())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::DesignKind;

    fn close(a: f64, b: f64) -> bool {
        (a - b).abs() < 1e-9
    }

    #[test]
    fn rotation_about_center() {
        let t = local_transform_parts(10.0, 10.0, 20.0, 10.0, 90.0, false, false);
        // Center stays put.
        let c = t.apply(Point::new(10.0, 5.0));
        assert!(close(c.x, 20.0) && close(c.y, 15.0));
        let (w, h) = rotated_size(20.0, 10.0, 90.0);
        assert!(close(w, 10.0) && close(h, 20.0));
        let bb = t.transform_rect_bbox(&Rect::new(0.0, 0.0, 20.0, 10.0));
        assert!(close(bb.x, 15.0) && close(bb.y, 5.0) && close(bb.w, 10.0) && close(bb.h, 20.0));
    }

    #[test]
    fn decompose_roundtrip() {
        for &(rot, fx, fy) in &[
            (0.0, false, false),
            (30.0, false, false),
            (-120.0, true, false),
            (45.0, false, true),
            (170.0, true, true),
        ] {
            let t = local_transform_parts(5.0, -3.0, 40.0, 20.0, rot, fx, fy);
            let p = decompose_local(&t, 40.0, 20.0);
            let t2 = local_transform_parts(p.x, p.y, 40.0, 20.0, p.rotation, p.flip_x, p.flip_y);
            for (a, b) in t.as_coeffs().iter().zip(t2.as_coeffs()) {
                assert!((a - b).abs() < 1e-9, "{rot} {fx} {fy}: {t:?} vs {t2:?}");
            }
        }
    }

    #[test]
    fn world_and_reparent() {
        let mut d = Design::with_page("d", "D", DesignKind::Poster, "p", 500.0, 500.0);
        let mut f = Node::frame("f", "F", 100.0, 100.0, 200.0, 200.0);
        f.base_mut().rotation = 90.0;
        d.push_child("p", f);
        d.push_child("f", Node::rect("r", "R", 0.0, 0.0, 10.0, 10.0));
        let obb = node_obb(&d, "r").unwrap();
        // Frame rotated 90° about (200,200): its local (0,0) maps to (300,100).
        let c = obb.corners()[0];
        assert!(close(c.x, 300.0) && close(c.y, 100.0));
        let p = reparent_placement(&d, "r", "p").unwrap();
        assert!(close(p.rotation, 90.0));
        let aabb = node_aabb(&d, "r").unwrap();
        assert!(close(aabb.x, 290.0) && close(aabb.y, 100.0));
        assert!(close(p.x, 290.0) && close(p.y, 100.0));
    }

    #[test]
    fn obb_sat() {
        let a = OrientedBox::from_rect(Rect::new(0.0, 0.0, 10.0, 10.0));
        let b = OrientedBox {
            transform: Affine::rotate_about(45.0, Point::new(18.0, 5.0))
                * Affine::translate(13.0, 0.0),
            width: 10.0,
            height: 10.0,
        };
        // Diamond centered at (18,5) with half-diagonal ~7.07 reaches x≈10.93 -> no overlap.
        assert!(!a.intersects(&b));
        let c = OrientedBox {
            transform: Affine::rotate_about(45.0, Point::new(16.0, 5.0))
                * Affine::translate(11.0, 0.0),
            width: 10.0,
            height: 10.0,
        };
        assert!(a.intersects(&c));
        assert!(a.contains(Point::new(10.5, 5.0), 1.0));
        assert!(!a.contains(Point::new(11.5, 5.0), 1.0));
    }
}
