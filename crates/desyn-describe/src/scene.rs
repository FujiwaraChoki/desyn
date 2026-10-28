//! Flattened view of one page: every node with its page transform, bounds, effective visibility / opacity,
//! clipping and paint order, plus a uniform-grid index for point queries.

use std::collections::{HashMap, HashSet};

use desyn_core::geometry::{Affine, OrientedBox, Point, Rect, local_transform};
use desyn_core::paths::{Polyline, clamp_radii, flatten_bez, node_outline, polylines_contain};
use desyn_core::{Design, FillRule, Node, NodeType, PageNode};

/// Roles that mark a node as backdrop (never content, never a lint subject for layout rules).
pub const BACKDROP_ROLES: &[&str] = &["background", "decoration", "pattern", "watermark"];

/// A node of the page.
#[derive(Debug)]
pub struct Item<'a> {
    /// The node.
    pub node: &'a Node,
    /// Index of the parent item (`None` for page children).
    pub parent: Option<usize>,
    /// Child items back-to-front.
    pub children: Vec<usize>,
    /// 0 for page children.
    pub depth: usize,
    /// Paint order on the page (pre-order, 0 = bottom-most).
    pub z: usize,
    /// Node box (0..w, 0..h) to page coordinates.
    pub world: Affine,
    /// Axis-aligned bounds of the rotated box (page coordinates).
    pub aabb: Rect,
    /// Accumulated clip of clipping ancestors (page coordinates), if any.
    pub clip: Option<Rect>,
    /// Self and every ancestor visible, the effective opacity above 1%, and not part of a mask (mask shapes are
    /// not painted, they only cut their following siblings).
    pub visible: bool,
    /// The node is a visible mask (`mask: true`): it paints nothing and clips the siblings after it.
    pub mask: bool,
    /// The node is a mask or lies inside one.
    pub in_mask: bool,
    /// Product of own and ancestor opacities.
    pub opacity: f64,
    /// The parent is an auto-layout container (it owns this node's position).
    pub in_layout: bool,
    /// Page-space rotation in degrees.
    pub rotation: f64,
    /// Every ancestor up to the page has no rotation and no flips (page deltas equal local deltas).
    pub axis_aligned_parents: bool,
}

impl Item<'_> {
    /// Node id.
    pub fn id(&self) -> &str {
        self.node.id()
    }

    /// Visible part of the bounds (bounds intersected with the clip), `None` when fully clipped away.
    pub fn visible_box(&self) -> Option<Rect> {
        match self.clip {
            Some(c) => self.aabb.intersection(&c),
            None => Some(self.aabb),
        }
    }

    /// Explicit role.
    pub fn role(&self) -> Option<&str> {
        self.node.base().role.as_deref()
    }

    /// Node type.
    pub fn kind(&self) -> NodeType {
        self.node.node_type()
    }

    /// Oriented box in page coordinates.
    pub fn obb(&self) -> OrientedBox {
        let b = self.node.base();
        OrientedBox {
            transform: self.world,
            width: b.width,
            height: b.height,
        }
    }
}

/// The page view.
pub struct Scene<'a> {
    /// Design.
    pub design: &'a Design,
    /// Page node.
    pub page: &'a PageNode,
    /// Page index among the design's pages.
    pub page_index: usize,
    /// Items in paint order (index == z).
    pub items: Vec<Item<'a>>,
    /// Page children (item indices, back-to-front).
    pub top: Vec<usize>,
    /// Id -> item index.
    pub by_id: HashMap<&'a str, usize>,
    /// `0, 0, width, height`.
    pub page_rect: Rect,
    grid: PointGrid,
    outlines: HashMap<usize, Option<(Vec<Polyline>, FillRule)>>,
}

impl<'a> Scene<'a> {
    /// Builds the view of `page` (iterative pre-order walk; tolerant of malformed trees: missing children and
    /// repeated ids are skipped).
    pub fn new(design: &'a Design, page: &'a PageNode, page_index: usize) -> Self {
        let page_rect = Rect::new(0.0, 0.0, page.base.width, page.base.height);
        let page_clip = page.container.clip.then_some(page_rect);
        let mut items: Vec<Item<'a>> = Vec::new();
        let mut by_id: HashMap<&'a str, usize> = HashMap::new();
        let mut seen: HashSet<&str> = HashSet::new();
        seen.insert(page.base.id.as_str());
        let mut top = Vec::new();
        // Stack of (child id, parent item, governing mask sibling); children pushed in reverse so they pop
        // back-to-front.
        let mut stack: Vec<(&'a str, Option<usize>, Option<&'a str>)> = Vec::new();
        push_children(design, &page.container.children, None, &mut stack);
        while let Some((id, parent, mask_sibling)) = stack.pop() {
            let Some(node) = design.node(id) else {
                continue;
            };
            if matches!(node.node_type(), NodeType::Root | NodeType::Page) || !seen.insert(id) {
                continue;
            }
            let b = node.base();
            let (pw, pclip, pvis, popa, pdepth, paxis, playout, pmask) = match parent {
                Some(p) => {
                    let pi = &items[p];
                    let pn = pi.node;
                    let clip = if pn.clips() {
                        let own = pi.aabb;
                        Some(match pi.clip {
                            Some(c) => c
                                .intersection(&own)
                                .unwrap_or(Rect::new(own.x, own.y, 0.0, 0.0)),
                            None => own,
                        })
                    } else {
                        pi.clip
                    };
                    let pb = pn.base();
                    let axis = pi.axis_aligned_parents
                        && pb.rotation == 0.0
                        && !pb.flipped_x()
                        && !pb.flipped_y();
                    (
                        pi.world,
                        clip,
                        pi.visible,
                        pi.opacity,
                        pi.depth + 1,
                        axis,
                        pn.layout().is_some(),
                        pi.in_mask,
                    )
                }
                None => (
                    Affine::IDENTITY,
                    page_clip,
                    page.base.visible,
                    1.0,
                    0,
                    true,
                    page.container.layout.is_some(),
                    false,
                ),
            };
            // Siblings after a mask show only inside it (approximated by the mask's visible bounds).
            let pclip = match mask_sibling.and_then(|m| by_id.get(m)).map(|m| &items[*m]) {
                Some(m) => {
                    let mbox = m
                        .visible_box()
                        .unwrap_or(Rect::new(m.aabb.x, m.aabb.y, 0.0, 0.0));
                    Some(match pclip {
                        Some(c) => c
                            .intersection(&mbox)
                            .unwrap_or(Rect::new(mbox.x, mbox.y, 0.0, 0.0)),
                        None => mbox,
                    })
                }
                None => pclip,
            };
            let is_mask = b.is_mask() && b.visible;
            let world = pw * local_transform(b);
            let aabb = world.transform_rect_bbox(&Rect::new(0.0, 0.0, b.width, b.height));
            let opacity = popa * b.opacity.clamp(0.0, 1.0);
            let index = items.len();
            items.push(Item {
                node,
                parent,
                children: Vec::new(),
                depth: pdepth,
                z: index,
                world,
                aabb,
                clip: pclip,
                visible: pvis && b.visible && opacity > 0.01 && !is_mask && !pmask,
                mask: is_mask,
                in_mask: is_mask || pmask,
                opacity,
                in_layout: playout,
                rotation: normalize_deg(world.rotation_deg()),
                axis_aligned_parents: paxis,
            });
            by_id.insert(node.id(), index);
            match parent {
                Some(p) => items[p].children.push(index),
                None => top.push(index),
            }
            push_children(design, node.child_ids(), Some(index), &mut stack);
        }
        let grid = PointGrid::build(&items, page_rect);
        Scene {
            design,
            page,
            page_index,
            items,
            top,
            by_id,
            page_rect,
            grid,
            outlines: HashMap::new(),
        }
    }

    /// Item by node id.
    pub fn get(&self, id: &str) -> Option<&Item<'a>> {
        self.by_id.get(id).map(|i| &self.items[*i])
    }

    /// Page area.
    pub fn page_area(&self) -> f64 {
        self.page_rect.area().max(1.0)
    }

    /// Backdrop by role or by covering most of the page.
    pub fn is_backdrop(&self, i: usize) -> bool {
        let it = &self.items[i];
        if it.role().is_some_and(|r| BACKDROP_ROLES.contains(&r)) {
            return true;
        }
        visible_area(it) >= self.page_area() * 0.85
    }

    /// Surface items (shapes, frames, images, video, QR, tables) whose bounds may contain `p`, in paint order.
    pub fn candidates_at(&self, p: Point) -> Vec<usize> {
        self.grid.at(p)
    }

    /// Whether the node's own fill geometry covers the page point `p` (clipping ancestors honored, masks are not).
    pub fn paint_contains(&mut self, i: usize, p: Point) -> bool {
        let it = &self.items[i];
        if let Some(c) = it.clip
            && !c.contains(p)
        {
            return false;
        }
        let Some(inv) = it.world.inverse() else {
            return false;
        };
        let l = inv.apply(p);
        let b = it.node.base();
        let (w, h) = (b.width, b.height);
        if l.x < 0.0 || l.y < 0.0 || l.x > w || l.y > h {
            return false;
        }
        match it.node {
            Node::Rect(_)
            | Node::Frame(_)
            | Node::Image(_)
            | Node::Video(_)
            | Node::Qr(_)
            | Node::Table(_) => in_rounded_rect(l, w, h, it.node.corner_radii()),
            Node::Ellipse(e) if e.arc.is_none() => in_ellipse(l, w, h),
            Node::Ellipse(_)
            | Node::Polygon(_)
            | Node::Star(_)
            | Node::Path(_)
            | Node::Boolean(_) => {
                let design = self.design;
                let entry = self.outlines.entry(i).or_insert_with(|| {
                    node_outline(design, it.node.id(), 0.25)
                        .map(|o| (flatten_bez(&o.path, 0.5), o.fill_rule))
                });
                match entry {
                    Some((polys, rule)) => polylines_contain(polys, l, *rule),
                    None => false,
                }
            }
            _ => true,
        }
    }

    /// Ancestor chain (nearest first) of an item.
    pub fn ancestors(&self, i: usize) -> Vec<usize> {
        let mut out = Vec::new();
        let mut cur = self.items[i].parent;
        while let Some(p) = cur {
            out.push(p);
            cur = self.items[p].parent;
        }
        out
    }

    /// Whether `a` is an ancestor of `b`.
    pub fn is_ancestor(&self, a: usize, b: usize) -> bool {
        let mut cur = self.items[b].parent;
        while let Some(p) = cur {
            if p == a {
                return true;
            }
            cur = self.items[p].parent;
        }
        false
    }
}

/// Pushes the children of a container (reversed, so they pop back-to-front) with the mask sibling that governs
/// each: a visible mask cuts every following sibling up to the next mask node (as the renderer groups them); a
/// hidden mask ends the run without starting one.
fn push_children<'a>(
    design: &'a Design,
    ids: &'a [desyn_core::Id],
    parent: Option<usize>,
    stack: &mut Vec<(&'a str, Option<usize>, Option<&'a str>)>,
) {
    let mut current: Option<&'a str> = None;
    let mut governed: Vec<(&'a str, Option<&'a str>)> = Vec::with_capacity(ids.len());
    for c in ids {
        match design.node(c).map(|n| n.base()) {
            Some(b) if b.is_mask() => {
                governed.push((c.as_str(), None));
                current = b.visible.then_some(c.as_str());
            }
            _ => governed.push((c.as_str(), current)),
        }
    }
    stack.extend(governed.into_iter().rev().map(|(c, m)| (c, parent, m)));
}

/// Visible (clipped) area of an item.
pub fn visible_area(it: &Item<'_>) -> f64 {
    it.visible_box().map(|r| r.area()).unwrap_or(0.0)
}

fn normalize_deg(d: f64) -> f64 {
    let r = d.rem_euclid(360.0);
    let r = if r > 180.0 { r - 360.0 } else { r };
    if r.abs() < 1e-9 {
        0.0
    } else {
        (r * 1e6).round() / 1e6
    }
}

fn in_rounded_rect(p: Point, w: f64, h: f64, radii: [f64; 4]) -> bool {
    let r = clamp_radii(w, h, radii);
    let corners = [
        (r[0], r[0], r[0]),
        (r[1], w - r[1], r[1]),
        (r[2], w - r[2], h - r[2]),
        (r[3], r[3], h - r[3]),
    ];
    for (k, (rad, cx, cy)) in corners.into_iter().enumerate() {
        if rad <= 0.0 {
            continue;
        }
        let inside_corner = match k {
            0 => p.x < cx && p.y < cy,
            1 => p.x > cx && p.y < cy,
            2 => p.x > cx && p.y > cy,
            _ => p.x < cx && p.y > cy,
        };
        if inside_corner && Point::new(cx, cy).distance(p) > rad {
            return false;
        }
    }
    true
}

fn in_ellipse(p: Point, w: f64, h: f64) -> bool {
    let (rx, ry) = (w / 2.0, h / 2.0);
    if rx <= 0.0 || ry <= 0.0 {
        return false;
    }
    let dx = (p.x - rx) / rx;
    let dy = (p.y - ry) / ry;
    dx * dx + dy * dy <= 1.0
}

/// Uniform grid over the page for point queries (items outside the page land in the border cells).
struct PointGrid {
    origin: Point,
    cell: f64,
    cols: usize,
    rows: usize,
    cells: Vec<Vec<usize>>,
    /// Items spanning many cells (backgrounds, cards); checked for every query instead of filling every cell.
    big: Vec<usize>,
}

const GRID_CELLS: usize = 32;
/// Items covering more cells than this go to the `big` list.
const BIG_SPAN: usize = 64;

impl PointGrid {
    fn build(items: &[Item<'_>], page: Rect) -> Self {
        let cell = (page.w.max(page.h) / GRID_CELLS as f64).max(1.0);
        let cols = ((page.w / cell).ceil() as usize).clamp(1, GRID_CELLS);
        let rows = ((page.h / cell).ceil() as usize).clamp(1, GRID_CELLS);
        let mut g = PointGrid {
            origin: Point::new(page.x, page.y),
            cell,
            cols,
            rows,
            cells: vec![Vec::new(); cols * rows],
            big: Vec::new(),
        };
        for (i, it) in items.iter().enumerate() {
            // Only surfaces matter for point queries (what is behind / on top of text): text, lines and
            // groups never are.
            if !it.visible
                || !it.node.paints_self()
                || matches!(
                    it.kind(),
                    NodeType::Text | NodeType::Line | NodeType::Svg | NodeType::Chart
                )
            {
                continue;
            }
            let Some(r) = it.visible_box() else { continue };
            if !(r.w.is_finite() && r.h.is_finite()) {
                continue;
            }
            let (c0, r0) = g.cell_of(Point::new(r.x, r.y));
            let (c1, r1) = g.cell_of(Point::new(r.right(), r.bottom()));
            if (c1 - c0 + 1) * (r1 - r0 + 1) > BIG_SPAN {
                g.big.push(i);
                continue;
            }
            for row in r0..=r1 {
                for col in c0..=c1 {
                    g.cells[row * cols + col].push(i);
                }
            }
        }
        g
    }

    fn cell_of(&self, p: Point) -> (usize, usize) {
        let c = ((p.x - self.origin.x) / self.cell).floor();
        let r = ((p.y - self.origin.y) / self.cell).floor();
        let clamp = |v: f64, n: usize| {
            if v.is_finite() {
                v.clamp(0.0, (n - 1) as f64) as usize
            } else {
                0
            }
        };
        (clamp(c, self.cols), clamp(r, self.rows))
    }

    fn at(&self, p: Point) -> Vec<usize> {
        let (c, r) = self.cell_of(p);
        let small = &self.cells[r * self.cols + c];
        // Both lists are in paint order; merge them.
        let mut out = Vec::with_capacity(small.len() + self.big.len());
        let (mut a, mut b) = (0, 0);
        while a < small.len() || b < self.big.len() {
            let take_small = b >= self.big.len() || (a < small.len() && small[a] < self.big[b]);
            if take_small {
                out.push(small[a]);
                a += 1;
            } else {
                out.push(self.big[b]);
                b += 1;
            }
        }
        out
    }
}
