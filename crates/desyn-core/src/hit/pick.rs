//! Point hit testing and marquee selection.

use serde::{Deserialize, Serialize};

use crate::geometry::{Affine, OrientedBox, Point, Rect, local_transform, world_transform};
use crate::model::{
    Design, EllipseNode, Id, ImageShape, ImageShapeKind, Node, NodeType, StrokeAlign,
};
use crate::paths::{cap_size, flatten_bez, node_outline, polylines_distance};

/// Options for [`hit_test`] and friends.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct HitOptions {
    /// Return the deepest hit node instead of the page's top-level child that contains it.
    pub deep: bool,
    /// Consider locked nodes (and their subtrees).
    pub include_locked: bool,
    /// Consider hidden nodes (and their subtrees).
    pub include_hidden: bool,
    /// Extra hit slop in design px (screen slop divided by zoom); also the minimum stroke hit band.
    pub tolerance: f64,
}

impl Default for HitOptions {
    fn default() -> Self {
        HitOptions {
            deep: false,
            include_locked: false,
            include_hidden: false,
            tolerance: 0.0,
        }
    }
}

/// Tolerance used when flattening curves for hit tests.
const FLATTEN_TOL: f64 = 0.2;

#[inline]
fn to_local(b: &crate::model::Base, p: Point) -> Option<Point> {
    if b.rotation == 0.0 && !b.flipped_x() && !b.flipped_y() {
        return Some(Point::new(p.x - b.x, p.y - b.y));
    }
    local_transform(b).inverse().map(|inv| inv.apply(p))
}

#[inline]
fn in_box(p: Point, w: f64, h: f64, pad: f64) -> bool {
    p.x >= -pad && p.y >= -pad && p.x <= w + pad && p.y <= h + pad
}

/// Largest distance the node's paint reaches outside its box from strokes (line caps included).
pub(crate) fn stroke_reach(n: &Node) -> f64 {
    let mut r: f64 = 0.0;
    for s in n.strokes() {
        if s.visible.unwrap_or(true) {
            r = r.max(s.outset()).max(match s.cap {
                crate::model::StrokeCap::Butt => 0.0,
                _ => s.width / 2.0,
            });
        }
    }
    if let Node::Line(l) = n {
        let w = l
            .strokes
            .iter()
            .map(|s| s.width)
            .fold(0.0, f64::max)
            .max(1.0);
        r = r.max(w / 2.0);
        if l.start_cap != crate::model::Cap::None || l.end_cap != crate::model::Cap::None {
            r = r.max(cap_size(w) * 0.6 + w / 2.0);
        }
    }
    r
}

/// Point (node-local) inside a rounded rectangle.
fn in_rounded_rect(p: Point, w: f64, h: f64, radii: [f64; 4], pad: f64) -> bool {
    if !in_box(p, w, h, pad) {
        return false;
    }
    let r = crate::paths::clamp_radii(w, h, radii);
    let corners = [
        (r[0], r[0], r[0]),
        (r[1], w - r[1], r[1]),
        (r[2], w - r[2], h - r[2]),
        (r[3], r[3], h - r[3]),
    ];
    for (i, (rad, cx, cy)) in corners.into_iter().enumerate() {
        if rad <= 0.0 {
            continue;
        }
        let in_corner_region = match i {
            0 => p.x < cx && p.y < cy,
            1 => p.x > cx && p.y < cy,
            2 => p.x > cx && p.y > cy,
            _ => p.x < cx && p.y > cy,
        };
        if in_corner_region && Point::new(cx, cy).distance(p) > rad + pad {
            return false;
        }
    }
    true
}

fn in_ellipse(p: Point, w: f64, h: f64, pad: f64) -> bool {
    let (rx, ry) = (w / 2.0 + pad, h / 2.0 + pad);
    if rx <= 0.0 || ry <= 0.0 {
        return false;
    }
    let dx = (p.x - w / 2.0) / rx;
    let dy = (p.y - h / 2.0) / ry;
    dx * dx + dy * dy <= 1.0
}

/// Fill hit inside the node's shape (node-local point).
fn fill_contains(d: &Design, n: &Node, p: Point, pad: f64) -> bool {
    let b = n.base();
    match n {
        Node::Ellipse(EllipseNode { arc: None, .. }) => in_ellipse(p, b.width, b.height, pad),
        Node::Image(i) if matches!(i.shape, Some(ImageShape::Named(ImageShapeKind::Ellipse))) => {
            in_ellipse(p, b.width, b.height, pad)
        }
        Node::Rect(_)
        | Node::Frame(_)
        | Node::Page(_)
        | Node::Video(_)
        | Node::Table(_)
        | Node::Chart(_)
        | Node::Qr(_)
        | Node::Svg(_)
        | Node::Text(_) => in_rounded_rect(p, b.width, b.height, n.corner_radii(), pad),
        Node::Image(i) if !matches!(i.shape, Some(ImageShape::Path { .. })) => {
            in_rounded_rect(p, b.width, b.height, n.corner_radii(), pad)
        }
        _ => match node_outline(d, n.id(), FLATTEN_TOL) {
            Some(o) => {
                let kp = kurbo::Point::new(p.x, p.y);
                let w = kurbo::Shape::winding(&o.path, kp);
                let inside = match o.fill_rule {
                    crate::model::FillRule::Nonzero => w != 0,
                    crate::model::FillRule::Evenodd => w % 2 != 0,
                };
                inside
                    || (pad > 0.0
                        && polylines_distance(&flatten_bez(&o.path, FLATTEN_TOL), p) <= pad)
            }
            None => false,
        },
    }
}

/// Stroke hit (node-local point): within the painted stroke band plus `pad`.
fn stroke_contains(d: &Design, n: &Node, p: Point, pad: f64) -> bool {
    let strokes: Vec<_> = n.strokes().iter().filter(|s| s.is_visible()).collect();
    if strokes.is_empty() {
        return false;
    }
    let Some(o) = node_outline(d, n.id(), FLATTEN_TOL) else {
        return false;
    };
    let polys = flatten_bez(&o.path, FLATTEN_TOL);
    let dist = polylines_distance(&polys, p);
    let inside = fill_contains(d, n, p, 0.0);
    strokes.iter().any(|s| match s.align {
        StrokeAlign::Center => dist <= s.width / 2.0 + pad,
        StrokeAlign::Inside => (inside && dist <= s.width + pad) || dist <= pad,
        StrokeAlign::Outside => (!inside && dist <= s.width + pad) || dist <= pad,
    })
}

/// Whether the node's own paint (not its children) is hit at the node-local point.
pub(crate) fn hits_self(d: &Design, n: &Node, p: Point, tol: f64) -> bool {
    let b = n.base();
    let reach = stroke_reach(n);
    if !in_box(p, b.width, b.height, reach + tol) {
        return false;
    }
    match n {
        Node::Root(_) | Node::Group(_) | Node::Audio(_) => false,
        Node::Line(l) => {
            let w = l
                .strokes
                .iter()
                .map(|s| s.width)
                .fold(0.0, f64::max)
                .max(1.0);
            let shaft =
                crate::geometry::point_segment_distance(p, Point::ZERO, Point::new(b.width, 0.0));
            if shaft <= w / 2.0 + tol {
                return true;
            }
            let caps = crate::paths::line_outline(n, FLATTEN_TOL);
            kurbo::Shape::winding(&caps, kurbo::Point::new(p.x, p.y)) != 0
        }
        Node::Text(_) => in_box(p, b.width, b.height, tol),
        Node::Frame(_) | Node::Page(_) => {
            fill_contains(d, n, p, tol) || stroke_contains(d, n, p, tol)
        }
        _ => {
            let has_fill = n.fills().iter().any(|f| f.is_visible());
            let has_stroke = n.strokes().iter().any(|s| s.is_visible());
            let fill_hit = if has_fill || !has_stroke || !n.shaped().is_some() {
                fill_contains(d, n, p, tol)
            } else {
                false
            };
            fill_hit || (has_stroke && stroke_contains(d, n, p, tol))
        }
    }
}

/// Whether a node's shape (used as a mask) covers the node-local point.
pub(crate) fn mask_covers(d: &Design, n: &Node, p: Point) -> bool {
    mask_covers_at(d, n, p, 0)
}

fn mask_covers_at(d: &Design, n: &Node, p: Point, depth: usize) -> bool {
    match n {
        // Same depth bound as outlines (group masks of hostile depth stop contributing instead of overflowing).
        Node::Group(_) if depth > crate::paths::MAX_OUTLINE_DEPTH => false,
        Node::Group(_) => {
            n.child_ids()
                .iter()
                .filter_map(|c| d.node(c))
                .any(|c| match to_local(c.base(), p) {
                    Some(q) => mask_covers_at(d, c, q, depth + 1),
                    None => false,
                })
        }
        _ => fill_contains(d, n, p, 0.0) || stroke_contains(d, n, p, 0.0),
    }
}

fn eligible(n: &Node, o: &HitOptions) -> bool {
    let b = n.base();
    (b.visible || o.include_hidden) && (!b.locked || o.include_locked)
}

/// Nearest mask sibling below index `j` (masks apply to following siblings until the next mask).
fn governing_mask<'a>(d: &'a Design, children: &[Id], j: usize) -> Option<&'a Node> {
    children[..j]
        .iter()
        .rev()
        .filter_map(|c| d.node(c))
        .find(|n| n.base().is_mask())
}

/// Appends the hit path below container `n` (point in `n`'s local space). Returns true on a hit.
pub(crate) fn hit_children(
    d: &Design,
    n: &Node,
    p: Point,
    o: &HitOptions,
    path: &mut Vec<Id>,
    depth: usize,
) -> bool {
    let children = n.child_ids();
    if children.is_empty() || depth > 512 {
        return false;
    }
    for j in (0..children.len()).rev() {
        let Some(c) = d.node(&children[j]) else {
            continue;
        };
        let cb = c.base();
        if !eligible(c, o) || cb.is_mask() {
            continue;
        }
        let Some(q) = to_local(cb, p) else { continue };
        // Cheap reject for leaves before the full test (most children miss).
        if !c.is_container() {
            let pad = o.tolerance
                + if c.strokes().is_empty() && !matches!(c, Node::Line(_)) {
                    0.0
                } else {
                    stroke_reach(c)
                };
            if !in_box(q, cb.width, cb.height, pad) {
                continue;
            }
        }
        let mark = path.len();
        if !hit_node(d, c, q, o, path, depth + 1) {
            continue;
        }
        // Masks are resolved only for actual hits so misses stay a single pass over the children.
        if let Some(mn) = governing_mask(d, children, j) {
            let covered = to_local(mn.base(), p).is_some_and(|mq| mask_covers(d, mn, mq));
            if !covered {
                path.truncate(mark);
                continue;
            }
        }
        return true;
    }
    false
}

/// Hit test of one node (point in its local space): children first (topmost), then its own paint.
fn hit_node(
    d: &Design,
    n: &Node,
    q: Point,
    o: &HitOptions,
    path: &mut Vec<Id>,
    depth: usize,
) -> bool {
    let b = n.base();
    if n.is_container() {
        // Clipping limits the children only: the container's own paint (e.g. a centered or outside stroke) still
        // reaches outside its box.
        let children_reachable = !n.clips() || in_box(q, b.width, b.height, o.tolerance);
        // Booleans are hit by their combined shape; their children are only reachable through the boolean.
        if matches!(n, Node::Boolean(_)) {
            if hits_self(d, n, q, o.tolerance) {
                path.push(b.id.clone());
                let mark = path.len();
                if o.deep && !hit_children(d, n, q, o, path, depth) {
                    path.truncate(mark);
                }
                return true;
            }
            return false;
        }
        path.push(b.id.clone());
        if (children_reachable && hit_children(d, n, q, o, path, depth))
            || hits_self(d, n, q, o.tolerance)
        {
            return true;
        }
        path.pop();
        return false;
    }
    if hits_self(d, n, q, o.tolerance) {
        path.push(b.id.clone());
        return true;
    }
    false
}

/// Ids from the page's top-level child down to the deepest node hit at `p` (page coordinates), topmost first.
/// Honors visibility, locks, clipping, masks, rotation / flips, stroke bands and `tolerance`.
pub fn hit_path(d: &Design, page: &str, p: Point, o: &HitOptions) -> Option<Vec<Id>> {
    let pg = d.node(page)?;
    if pg.node_type() != NodeType::Page {
        return None;
    }
    if pg.clips() && !in_box(p, pg.base().width, pg.base().height, o.tolerance) {
        return None;
    }
    let mut path = Vec::new();
    if hit_children(d, pg, p, o, &mut path, 0) {
        Some(path)
    } else {
        None
    }
}

/// The node hit at `p` (page coordinates): the page's top-level child containing the hit, or the deepest node when
/// `deep` is set. `None` when only the page background is under the point.
pub fn hit_test(d: &Design, page: &str, p: Point, o: &HitOptions) -> Option<Id> {
    let path = hit_path(d, page, p, o)?;
    if o.deep {
        path.last().cloned()
    } else {
        path.first().cloned()
    }
}

/// Every node under `p`, topmost first: top-level children (or, with `deep`, the deepest hit node of every
/// overlapping branch).
pub fn nodes_at(d: &Design, page: &str, p: Point, o: &HitOptions) -> Vec<Id> {
    let Some(pg) = d.node(page) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    collect_at(d, pg, p, o, &mut out, 0);
    out
}

fn collect_at(d: &Design, n: &Node, p: Point, o: &HitOptions, out: &mut Vec<Id>, depth: usize) {
    if depth > 512 {
        return;
    }
    let children = n.child_ids();
    for j in (0..children.len()).rev() {
        let Some(c) = d.node(&children[j]) else {
            continue;
        };
        if !eligible(c, o) || c.base().is_mask() {
            continue;
        }
        if let Some(mn) = governing_mask(d, children, j)
            && !to_local(mn.base(), p).is_some_and(|q| mask_covers(d, mn, q))
        {
            continue;
        }
        let Some(q) = to_local(c.base(), p) else {
            continue;
        };
        if o.deep && c.is_container() && !matches!(c, Node::Boolean(_)) {
            let before = out.len();
            if !c.clips() || in_box(q, c.base().width, c.base().height, o.tolerance) {
                collect_at(d, c, q, o, out, depth + 1);
            }
            if out.len() == before && hits_self(d, c, q, o.tolerance) {
                out.push(c.id().to_string());
            }
        } else {
            let mut path = Vec::new();
            if hit_node(
                d,
                c,
                q,
                &HitOptions { deep: false, ..*o },
                &mut path,
                depth + 1,
            ) {
                out.push(c.id().to_string());
            }
        }
    }
}

/// Marquee selection rule.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MarqueeMode {
    /// Node fully inside the rectangle.
    Contain,
    /// Node touching the rectangle.
    Intersect,
}

/// Nodes selected by a marquee rectangle (page coordinates), in paint order (back to front). Without `deep`, the
/// candidates are the page's top-level children; with `deep`, groups and frames are entered and their leaves (and
/// childless containers) are candidates. Locked / hidden nodes are skipped unless included.
pub fn marquee(d: &Design, page: &str, rect: Rect, mode: MarqueeMode, o: &HitOptions) -> Vec<Id> {
    let Some(pg) = d.node(page) else {
        return Vec::new();
    };
    let target = OrientedBox::from_rect(rect);
    let mut out = Vec::new();
    marquee_rec(d, pg, Affine::IDENTITY, &target, rect, mode, o, &mut out, 0);
    out
}

#[allow(clippy::too_many_arguments)]
fn marquee_rec(
    d: &Design,
    n: &Node,
    t: Affine,
    target: &OrientedBox,
    rect: Rect,
    mode: MarqueeMode,
    o: &HitOptions,
    out: &mut Vec<Id>,
    depth: usize,
) {
    if depth > 512 {
        return;
    }
    for c in n.child_ids() {
        let Some(cn) = d.node(c) else { continue };
        if !eligible(cn, o) || cn.base().is_mask() {
            continue;
        }
        let ct = t * local_transform(cn.base());
        let obb = OrientedBox {
            transform: ct,
            width: cn.base().width,
            height: cn.base().height,
        };
        let enter = o.deep
            && cn.is_container()
            && !matches!(cn, Node::Boolean(_))
            && !cn.child_ids().is_empty();
        if enter {
            if obb.intersects(target) {
                marquee_rec(d, cn, ct, target, rect, mode, o, out, depth + 1);
            }
            continue;
        }
        let hit = match mode {
            MarqueeMode::Contain => obb.inside_rect(&rect),
            MarqueeMode::Intersect => obb.intersects(target),
        };
        if hit {
            out.push(c.clone());
        }
    }
}

/// World transform helper re-exported for UI code that needs it next to hit tests.
pub fn node_world_transform(d: &Design, id: &str) -> Affine {
    world_transform(d, id)
}
