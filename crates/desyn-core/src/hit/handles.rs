//! Selection bounds and transform-handle geometry (8 resize handles + 4 rotate zones), plus resize math.

use serde::{Deserialize, Serialize};

use crate::geometry::{Affine, OrientedBox, Point, Rect, node_obb};
use crate::model::Design;

/// Bounds of a selection.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct SelectionBounds {
    /// Axis-aligned bounds in page coordinates.
    pub aabb: Rect,
    /// Oriented bounds: the node's box for a single node, the tight box in the shared rotation when every node has
    /// the same world rotation, otherwise `aabb`.
    pub obb: OrientedBox,
    /// Rotation of `obb` in degrees.
    pub rotation: f64,
}

/// Bounds of the given nodes (missing ids are ignored); `None` for an empty selection.
pub fn selection_bounds(d: &Design, ids: &[String]) -> Option<SelectionBounds> {
    let boxes: Vec<OrientedBox> = ids.iter().filter_map(|id| node_obb(d, id)).collect();
    let first = *boxes.first()?;
    let aabb =
        crate::geometry::union_bounds(boxes.iter().map(|b| b.aabb()).collect::<Vec<_>>().iter())?;
    if boxes.len() == 1 {
        return Some(SelectionBounds {
            aabb,
            obb: first,
            rotation: first.rotation_deg(),
        });
    }
    let rot = first.rotation_deg();
    let same = boxes.iter().all(|b| {
        let diff = (b.rotation_deg() - rot).rem_euclid(360.0);
        diff < 1e-6 || (360.0 - diff) < 1e-6
    });
    if !same || rot.abs() < 1e-9 {
        return Some(SelectionBounds {
            aabb,
            obb: OrientedBox::from_rect(aabb),
            rotation: 0.0,
        });
    }
    // Tight box in the rotated frame.
    let unrot = Affine::rotate_deg(-rot);
    let pts: Vec<Point> = boxes
        .iter()
        .flat_map(|b| b.corners())
        .map(|p| unrot.apply(p))
        .collect();
    let r = Rect::bounding(pts)?;
    let obb = OrientedBox {
        transform: Affine::rotate_deg(rot) * Affine::translate(r.x, r.y),
        width: r.w,
        height: r.h,
    };
    Some(SelectionBounds {
        aabb,
        obb,
        rotation: rot,
    })
}

/// Resize handle positions, clockwise from the top-left corner.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum HandleKind {
    /// Top-left corner.
    TopLeft,
    /// Top edge.
    Top,
    /// Top-right corner.
    TopRight,
    /// Right edge.
    Right,
    /// Bottom-right corner.
    BottomRight,
    /// Bottom edge.
    Bottom,
    /// Bottom-left corner.
    BottomLeft,
    /// Left edge.
    Left,
}

impl HandleKind {
    /// All handles in clockwise order.
    pub const ALL: [HandleKind; 8] = [
        HandleKind::TopLeft,
        HandleKind::Top,
        HandleKind::TopRight,
        HandleKind::Right,
        HandleKind::BottomRight,
        HandleKind::Bottom,
        HandleKind::BottomLeft,
        HandleKind::Left,
    ];

    /// Position in the unit box (0..1, 0..1).
    pub fn anchor(self) -> (f64, f64) {
        match self {
            HandleKind::TopLeft => (0.0, 0.0),
            HandleKind::Top => (0.5, 0.0),
            HandleKind::TopRight => (1.0, 0.0),
            HandleKind::Right => (1.0, 0.5),
            HandleKind::BottomRight => (1.0, 1.0),
            HandleKind::Bottom => (0.5, 1.0),
            HandleKind::BottomLeft => (0.0, 1.0),
            HandleKind::Left => (0.0, 0.5),
        }
    }

    /// The handle on the opposite side (the fixed point while resizing).
    pub fn opposite(self) -> HandleKind {
        match self {
            HandleKind::TopLeft => HandleKind::BottomRight,
            HandleKind::Top => HandleKind::Bottom,
            HandleKind::TopRight => HandleKind::BottomLeft,
            HandleKind::Right => HandleKind::Left,
            HandleKind::BottomRight => HandleKind::TopLeft,
            HandleKind::Bottom => HandleKind::Top,
            HandleKind::BottomLeft => HandleKind::TopRight,
            HandleKind::Left => HandleKind::Right,
        }
    }

    /// True for the four corners.
    pub fn is_corner(self) -> bool {
        matches!(
            self,
            HandleKind::TopLeft
                | HandleKind::TopRight
                | HandleKind::BottomRight
                | HandleKind::BottomLeft
        )
    }
}

/// One resize handle.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Handle {
    /// Which handle.
    pub kind: HandleKind,
    /// Center in page coordinates.
    pub center: Point,
    /// Hit / draw square (oriented with the selection).
    pub rect: OrientedBox,
    /// Screen angle of the resize direction in degrees (0 = horizontal), for picking the resize cursor.
    pub cursor_angle: f64,
    /// False when the selection is too small on screen for this handle (edge handles hide first).
    pub visible: bool,
}

/// A rotate zone just outside a corner.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct RotateZone {
    /// Corner it belongs to.
    pub corner: HandleKind,
    /// Zone center in page coordinates.
    pub center: Point,
    /// Zone radius in page px.
    pub radius: f64,
}

/// Handle geometry for a selection box.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Handles {
    /// The selection box.
    pub bounds: OrientedBox,
    /// Eight resize handles.
    pub resize: Vec<Handle>,
    /// Four rotate zones.
    pub rotate: Vec<RotateZone>,
}

/// Handle sizing in screen pixels.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct HandleStyle {
    /// Handle square size (default 8, DESIGN_SYSTEM.md).
    pub size: f64,
    /// Extra hit slop around each handle (default 4).
    pub slop: f64,
    /// Rotate zone radius (default 12).
    pub rotate_radius: f64,
    /// Minimum on-screen side length for edge handles to show (default 24).
    pub min_side_for_edges: f64,
}

impl Default for HandleStyle {
    fn default() -> Self {
        HandleStyle {
            size: 8.0,
            slop: 4.0,
            rotate_radius: 12.0,
            min_side_for_edges: 24.0,
        }
    }
}

/// Computes handle geometry for `bounds` at `zoom` (screen px per design px).
pub fn transform_handles(bounds: &OrientedBox, zoom: f64, style: &HandleStyle) -> Handles {
    let z = if zoom > 0.0 { zoom } else { 1.0 };
    let size = (style.size + 2.0 * style.slop) / z;
    let (sx, sy) = bounds.transform.scale_factors();
    let screen_w = bounds.width * sx * z;
    let screen_h = bounds.height * sy * z;
    let rot = bounds.rotation_deg();
    let unit_rot = Affine::rotate_deg(rot);
    let resize = HandleKind::ALL
        .iter()
        .map(|&kind| {
            let (u, v) = kind.anchor();
            let center = bounds
                .transform
                .apply(Point::new(u * bounds.width, v * bounds.height));
            let rect = OrientedBox {
                transform: Affine::translate(center.x, center.y)
                    * unit_rot
                    * Affine::translate(-size / 2.0, -size / 2.0),
                width: size,
                height: size,
            };
            let base_angle = match kind {
                HandleKind::Top | HandleKind::Bottom => 90.0,
                HandleKind::Left | HandleKind::Right => 0.0,
                HandleKind::TopLeft | HandleKind::BottomRight => 45.0,
                HandleKind::TopRight | HandleKind::BottomLeft => 135.0,
            };
            let visible = match kind {
                HandleKind::Top | HandleKind::Bottom => screen_w >= style.min_side_for_edges,
                HandleKind::Left | HandleKind::Right => screen_h >= style.min_side_for_edges,
                _ => true,
            };
            Handle {
                kind,
                center,
                rect,
                cursor_angle: (base_angle + rot).rem_euclid(180.0),
                visible,
            }
        })
        .collect();
    let r = style.rotate_radius / z;
    let rotate = [
        HandleKind::TopLeft,
        HandleKind::TopRight,
        HandleKind::BottomRight,
        HandleKind::BottomLeft,
    ]
    .iter()
    .map(|&corner| {
        let (u, v) = corner.anchor();
        let c = bounds
            .transform
            .apply(Point::new(u * bounds.width, v * bounds.height));
        // Push the zone diagonally outward from the box center.
        let center_of_box = bounds.center();
        let dir = (c - center_of_box).normalize();
        RotateZone {
            corner,
            center: c + dir * (size / 2.0 + r * 0.75),
            radius: r,
        }
    })
    .collect();
    Handles {
        bounds: *bounds,
        resize,
        rotate,
    }
}

/// What a pointer is over.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", content = "handle", rename_all = "camelCase")]
pub enum HandleHit {
    /// A resize handle.
    Resize(HandleKind),
    /// A rotate zone of a corner.
    Rotate(HandleKind),
}

/// Handle under the point (resize handles win over rotate zones; hidden handles are ignored).
pub fn hit_handles(h: &Handles, p: Point) -> Option<HandleHit> {
    for handle in h.resize.iter().filter(|x| x.visible && x.kind.is_corner()) {
        if handle.rect.contains(p, 0.0) {
            return Some(HandleHit::Resize(handle.kind));
        }
    }
    for handle in h.resize.iter().filter(|x| x.visible && !x.kind.is_corner()) {
        if handle.rect.contains(p, 0.0) {
            return Some(HandleHit::Resize(handle.kind));
        }
    }
    if h.bounds.contains(p, 0.0) {
        return None;
    }
    h.rotate
        .iter()
        .find(|z| z.center.distance(p) <= z.radius)
        .map(|z| HandleHit::Rotate(z.corner))
}

/// Resize modifiers.
#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ResizeOptions {
    /// Keep the aspect ratio (shift / aspect-locked nodes).
    pub keep_aspect: bool,
    /// Resize symmetrically about the center (alt).
    pub from_center: bool,
}

/// New box after dragging `handle` so it lands at `pointer` (page coordinates). The opposite handle (or the center
/// with `from_center`) stays fixed; dragging past it flips the box (reported by negative scale in the result as
/// `flip_x` / `flip_y`).
pub fn resize_box(
    b: &OrientedBox,
    handle: HandleKind,
    pointer: Point,
    o: &ResizeOptions,
) -> ResizeResult {
    let Some(inv) = b.transform.inverse() else {
        return ResizeResult {
            bounds: *b,
            flip_x: false,
            flip_y: false,
        };
    };
    let local = inv.apply(pointer);
    let (u, v) = handle.anchor();
    let (au, av) = if o.from_center {
        (0.5, 0.5)
    } else {
        handle.opposite().anchor()
    };
    let anchor = Point::new(au * b.width, av * b.height);
    let horizontal = u != 0.5;
    let vertical = v != 0.5;
    let k = if o.from_center { 2.0 } else { 1.0 };
    let mut w = if horizontal {
        (local.x - anchor.x) * k * if u < au { -1.0 } else { 1.0 }
    } else {
        b.width
    };
    let mut h = if vertical {
        (local.y - anchor.y) * k * if v < av { -1.0 } else { 1.0 }
    } else {
        b.height
    };
    if o.keep_aspect && b.width > 0.0 && b.height > 0.0 {
        let ratio = b.width / b.height;
        if horizontal && vertical {
            if (w / b.width).abs() > (h / b.height).abs() {
                h = w.abs() / ratio * h.signum_or_one();
            } else {
                w = h.abs() * ratio * w.signum_or_one();
            }
        } else if horizontal {
            h = w.abs() / ratio;
        } else if vertical {
            w = h.abs() * ratio;
        }
    }
    let flip_x = w < 0.0;
    let flip_y = h < 0.0;
    let (nw, nh) = (w.abs(), h.abs());
    // Local origin of the new box, keeping the anchor point fixed.
    let ox = if o.from_center {
        anchor.x - nw / 2.0
    } else if !horizontal {
        // Edge drag with a locked aspect grows the other axis symmetrically.
        if o.keep_aspect {
            (b.width - nw) / 2.0
        } else {
            0.0
        }
    } else if (u < au) != flip_x {
        anchor.x - nw
    } else {
        anchor.x
    };
    let oy = if o.from_center {
        anchor.y - nh / 2.0
    } else if !vertical {
        if o.keep_aspect {
            (b.height - nh) / 2.0
        } else {
            0.0
        }
    } else if (v < av) != flip_y {
        anchor.y - nh
    } else {
        anchor.y
    };
    let transform = b.transform * Affine::translate(ox, oy);
    ResizeResult {
        bounds: OrientedBox {
            transform,
            width: nw,
            height: nh,
        },
        flip_x,
        flip_y,
    }
}

trait SignumOrOne {
    fn signum_or_one(self) -> f64;
}

impl SignumOrOne for f64 {
    fn signum_or_one(self) -> f64 {
        if self < 0.0 { -1.0 } else { 1.0 }
    }
}

/// Result of [`resize_box`].
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResizeResult {
    /// New box (same rotation as the input).
    pub bounds: OrientedBox,
    /// The drag crossed the fixed edge horizontally (toggle the node's flipX).
    pub flip_x: bool,
    /// The drag crossed the fixed edge vertically (toggle the node's flipY).
    pub flip_y: bool,
}

/// Rotation (degrees, clockwise) of a rotate drag around `center` from `start` to `pointer`, optionally snapped to
/// multiples of `step` degrees (e.g. 15 with shift).
pub fn rotation_delta(center: Point, start: Point, pointer: Point, step: Option<f64>) -> f64 {
    let a0 = (start.y - center.y).atan2(start.x - center.x);
    let a1 = (pointer.y - center.y).atan2(pointer.x - center.x);
    let mut deg = (a1 - a0).to_degrees();
    if deg > 180.0 {
        deg -= 360.0;
    } else if deg <= -180.0 {
        deg += 360.0;
    }
    match step {
        Some(s) if s > 0.0 => (deg / s).round() * s,
        _ => deg,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn handles_and_hits() {
        let b = OrientedBox::from_rect(Rect::new(100.0, 100.0, 200.0, 100.0));
        let h = transform_handles(&b, 2.0, &HandleStyle::default());
        assert_eq!(h.resize.len(), 8);
        assert_eq!(h.resize[0].center, Point::new(100.0, 100.0));
        assert_eq!(h.resize[3].center, Point::new(300.0, 150.0));
        assert_eq!(
            hit_handles(&h, Point::new(101.0, 101.0)),
            Some(HandleHit::Resize(HandleKind::TopLeft))
        );
        assert_eq!(
            hit_handles(&h, Point::new(200.0, 100.5)),
            Some(HandleHit::Resize(HandleKind::Top))
        );
        assert_eq!(hit_handles(&h, Point::new(200.0, 150.0)), None);
        let z = h.rotate[2];
        assert_eq!(
            hit_handles(&h, z.center),
            Some(HandleHit::Rotate(HandleKind::BottomRight))
        );
        // Tiny selection hides edge handles.
        let small = transform_handles(
            &OrientedBox::from_rect(Rect::new(0.0, 0.0, 4.0, 4.0)),
            1.0,
            &HandleStyle::default(),
        );
        assert!(!small.resize[1].visible && small.resize[0].visible);
    }

    #[test]
    fn resize_math() {
        let b = OrientedBox::from_rect(Rect::new(0.0, 0.0, 100.0, 50.0));
        let r = resize_box(
            &b,
            HandleKind::BottomRight,
            Point::new(150.0, 100.0),
            &ResizeOptions::default(),
        );
        assert_eq!(r.bounds.aabb(), Rect::new(0.0, 0.0, 150.0, 100.0));
        let r = resize_box(
            &b,
            HandleKind::Left,
            Point::new(-20.0, 10.0),
            &ResizeOptions::default(),
        );
        assert_eq!(r.bounds.aabb(), Rect::new(-20.0, 0.0, 120.0, 50.0));
        let r = resize_box(
            &b,
            HandleKind::Right,
            Point::new(-50.0, 10.0),
            &ResizeOptions::default(),
        );
        assert!(r.flip_x);
        assert_eq!(r.bounds.aabb(), Rect::new(-50.0, 0.0, 50.0, 50.0));
        let r = resize_box(
            &b,
            HandleKind::BottomRight,
            Point::new(200.0, 60.0),
            &ResizeOptions {
                keep_aspect: true,
                from_center: false,
            },
        );
        assert_eq!(r.bounds.aabb(), Rect::new(0.0, 0.0, 200.0, 100.0));
        let r = resize_box(
            &b,
            HandleKind::Right,
            Point::new(110.0, 0.0),
            &ResizeOptions {
                keep_aspect: false,
                from_center: true,
            },
        );
        assert_eq!(r.bounds.aabb(), Rect::new(-10.0, 0.0, 120.0, 50.0));
        assert!(
            (rotation_delta(
                Point::ZERO,
                Point::new(1.0, 0.0),
                Point::new(0.0, 1.0),
                None
            ) - 90.0)
                .abs()
                < 1e-9
        );
        assert_eq!(
            rotation_delta(
                Point::ZERO,
                Point::new(1.0, 0.0),
                Point::new(1.0, 0.3),
                Some(15.0)
            ),
            15.0
        );
    }

    #[test]
    fn rotated_selection_bounds() {
        use crate::model::{DesignKind, Node};
        let mut d = Design::with_page(
            "dddddddddddd",
            "D",
            DesignKind::Poster,
            "pppppppppppp",
            500.0,
            500.0,
        );
        for (i, x) in [0.0, 100.0].iter().enumerate() {
            let mut r = Node::rect(format!("rect0000000{i}"), "R", *x, 0.0, 50.0, 20.0);
            r.base_mut().rotation = 30.0;
            d.push_child("pppppppppppp", r);
        }
        let sb = selection_bounds(&d, &["rect00000000".into(), "rect00000001".into()]).unwrap();
        assert!((sb.rotation - 30.0).abs() < 1e-9);
        assert!(sb.obb.width > 0.0 && sb.aabb.w >= sb.obb.width * 0.5);
        for id in ["rect00000000", "rect00000001"] {
            for c in node_obb(&d, id).unwrap().corners() {
                assert!(sb.obb.contains(c, 1e-6));
            }
        }
    }
}
