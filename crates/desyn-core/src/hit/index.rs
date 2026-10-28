//! A per-page hit-test index: the page's nodes flattened in paint order with precomputed world transforms and
//! compact bounding boxes, so repeated queries (pointer moves, hover) scan a small contiguous array instead of
//! walking the node map. Build it after each transaction (O(n), a few hundred µs for 10k nodes) and query many
//! times; queries on 10k-node pages take tens of µs.

use super::pick::{HitOptions, hit_children, hits_self, mask_covers, stroke_reach};
use crate::geometry::{Affine, Point, Rect, local_transform};
use crate::model::{Design, Id, Node, NodeType};

const NONE: u32 = u32::MAX;

#[derive(Debug, Clone)]
struct Entry {
    /// Index of the node in `design.nodes`.
    node: usize,
    /// Nearest clipping ancestor entry.
    clip: u32,
    /// Governing mask sibling of this node or of its nearest masked ancestor chain (first link).
    mask: u32,
    /// Parent entry.
    parent: u32,
    /// Page -> node-local transform.
    inv: Affine,
    w: f64,
    h: f64,
    /// Hidden itself or below a hidden ancestor.
    hidden: bool,
    /// Locked itself or below a locked ancestor.
    locked: bool,
    /// Node never hits by itself (mask, group, root, audio) or sits inside a boolean or a mask (their children
    /// are geometry, not paint).
    skip: bool,
}

/// Hit-test index of one page. Valid for the design state it was built from.
#[derive(Debug, Clone)]
pub struct HitIndex {
    page: Id,
    page_size: (f64, f64),
    page_clips: bool,
    entries: Vec<Entry>,
    /// `[min_x, min_y, max_x, max_y]` per entry (world bounds including stroke reach), for the fast scan.
    bounds: Vec<[f32; 4]>,
}

impl HitIndex {
    /// Builds the index for `page` (empty when it is not a page).
    pub fn build(d: &Design, page: &str) -> HitIndex {
        let mut idx = HitIndex {
            page: page.to_string(),
            page_size: (0.0, 0.0),
            page_clips: false,
            entries: Vec::new(),
            bounds: Vec::new(),
        };
        let Some(pg) = d.node(page) else { return idx };
        if pg.node_type() != NodeType::Page {
            return idx;
        }
        idx.page_size = (pg.base().width, pg.base().height);
        idx.page_clips = pg.clips();
        idx.entries.reserve(d.nodes.len());
        idx.bounds.reserve(d.nodes.len());
        idx.add_children(d, pg, Affine::IDENTITY, NONE, NONE, false, false, false, 0);
        idx
    }

    #[allow(clippy::too_many_arguments)]
    fn add_children(
        &mut self,
        d: &Design,
        n: &Node,
        t: Affine,
        parent: u32,
        clip: u32,
        hidden: bool,
        locked: bool,
        in_shape: bool,
        depth: usize,
    ) {
        if depth > 512 {
            return;
        }
        let mut current_mask = NONE;
        let parent_mask = if parent == NONE {
            NONE
        } else {
            self.entries[parent as usize].mask
        };
        for c in n.child_ids() {
            let Some((node_index, _, cn)) = d.nodes.get_full(c.as_str()) else {
                continue;
            };
            let b = cn.base();
            let ct = t * local_transform(b);
            let inv = ct.inverse().unwrap_or(Affine::IDENTITY);
            let me = self.entries.len() as u32;
            let is_mask = b.is_mask();
            let h = hidden || !b.visible;
            let l = locked || b.locked;
            let skip = is_mask
                || in_shape
                || matches!(cn, Node::Group(_) | Node::Root(_) | Node::Audio(_));
            // Mask chain: own governing mask first, else inherit the parent's chain.
            let mask = if current_mask != NONE {
                current_mask
            } else {
                parent_mask
            };
            let reach = stroke_reach(cn);
            let r = ct.transform_rect_bbox(&Rect::new(
                -reach,
                -reach,
                b.width + 2.0 * reach,
                b.height + 2.0 * reach,
            ));
            self.entries.push(Entry {
                node: node_index,
                clip,
                mask,
                parent,
                inv,
                w: b.width,
                h: b.height,
                hidden: h,
                locked: l,
                skip,
            });
            self.bounds
                .push([r.x as f32, r.y as f32, r.right() as f32, r.bottom() as f32]);
            if is_mask {
                current_mask = me;
            }
            if cn.is_container() {
                let child_clip = if cn.clips() { me } else { clip };
                let child_shape = in_shape || is_mask || matches!(cn, Node::Boolean(_));
                self.add_children(d, cn, ct, me, child_clip, h, l, child_shape, depth + 1);
            }
        }
    }

    /// Number of indexed nodes.
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// True when the page has no nodes.
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// The indexed page.
    pub fn page(&self) -> &str {
        &self.page
    }

    fn inside_clips(&self, mut c: u32, p: Point, tol: f64) -> bool {
        while c != NONE {
            let e = &self.entries[c as usize];
            let q = e.inv.apply(p);
            if q.x < -tol || q.y < -tol || q.x > e.w + tol || q.y > e.h + tol {
                return false;
            }
            c = e.clip;
        }
        true
    }

    fn masks_cover(&self, d: &Design, mut i: u32, p: Point) -> bool {
        // Walk this entry and its ancestors; every governing mask on the way must cover the point.
        let mut checked = NONE;
        while i != NONE {
            let e = &self.entries[i as usize];
            if e.mask != NONE && e.mask != checked {
                let m = &self.entries[e.mask as usize];
                let Some((_, mn)) = d.nodes.get_index(m.node) else {
                    return false;
                };
                if !mask_covers(d, mn, m.inv.apply(p)) {
                    return false;
                }
                checked = e.mask;
            }
            i = e.parent;
        }
        true
    }

    /// Ids from the top-level page child down to the deepest node hit at `p` (same rules as
    /// [`super::hit_path`]). `d` must be the design the index was built from.
    pub fn hit_path(&self, d: &Design, p: Point, o: &HitOptions) -> Option<Vec<Id>> {
        let tol = o.tolerance;
        if self.page_clips
            && (p.x < -tol
                || p.y < -tol
                || p.x > self.page_size.0 + tol
                || p.y > self.page_size.1 + tol)
        {
            return None;
        }
        let (px, py) = (p.x as f32, p.y as f32);
        // The tolerance band is a square in each node's local space; under a rotated (rigid) transform it can
        // reach `tol * sqrt(2)` beyond the node's world bounds, so the prefilter must be that generous.
        let t = (tol * core::f64::consts::SQRT_2) as f32 + 1e-3;
        for i in (0..self.entries.len()).rev() {
            let bb = &self.bounds[i];
            if px < bb[0] - t || py < bb[1] - t || px > bb[2] + t || py > bb[3] + t {
                continue;
            }
            let e = &self.entries[i];
            if e.skip || (e.hidden && !o.include_hidden) || (e.locked && !o.include_locked) {
                continue;
            }
            if !self.inside_clips(e.clip, p, tol) {
                continue;
            }
            let Some((_, node)) = d.nodes.get_index(e.node) else {
                continue;
            };
            let q = e.inv.apply(p);
            if !hits_self(d, node, q, tol) {
                continue;
            }
            if !self.masks_cover(d, i as u32, p) {
                continue;
            }
            // Path from the top-level ancestor down to this node.
            let mut path = Vec::new();
            let mut cur = i as u32;
            while cur != NONE {
                let ce = &self.entries[cur as usize];
                if let Some((id, _)) = d.nodes.get_index(ce.node) {
                    path.push(id.clone());
                }
                cur = ce.parent;
            }
            path.reverse();
            if o.deep && matches!(node, Node::Boolean(_)) {
                hit_children(d, node, q, o, &mut path, 0);
            }
            return Some(path);
        }
        None
    }

    /// The node hit at `p` (top-level page child, or the deepest node with `deep`).
    pub fn hit_test(&self, d: &Design, p: Point, o: &HitOptions) -> Option<Id> {
        let path = self.hit_path(d, p, o)?;
        if o.deep {
            path.last().cloned()
        } else {
            path.first().cloned()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hit::{hit_path, hit_test};
    use crate::model::DesignKind;

    #[test]
    fn index_matches_direct_traversal() {
        let mut d = Design::with_page(
            "design000001",
            "D",
            DesignKind::Poster,
            "page00000001",
            400.0,
            400.0,
        );
        let mut f = Node::frame("frame0000001", "f", 50.0, 50.0, 100.0, 100.0);
        f.base_mut().rotation = 20.0;
        d.push_child("page00000001", f);
        d.push_child(
            "frame0000001",
            Node::rect("rect00000001", "r", 50.0, 50.0, 100.0, 30.0),
        );
        let mut m = Node::ellipse("mask00000001", "m", 200.0, 200.0, 100.0, 100.0);
        m.base_mut().mask = Some(true);
        d.push_child("page00000001", m);
        d.push_child(
            "page00000001",
            Node::rect("rect00000002", "r", 200.0, 200.0, 100.0, 100.0),
        );
        d.push_child(
            "page00000001",
            Node::group("group0000001", "g", 10.0, 300.0, 50.0, 50.0),
        );
        d.push_child(
            "group0000001",
            Node::text("text00000001", "hello", 0.0, 0.0, Some(50.0)),
        );
        let mut hidden = Node::rect("rect00000003", "h", 300.0, 0.0, 50.0, 50.0);
        hidden.base_mut().visible = false;
        d.push_child("page00000001", hidden);
        let idx = HitIndex::build(&d, "page00000001");
        assert_eq!(idx.len(), 7);
        for deep in [false, true] {
            let o = HitOptions {
                deep,
                tolerance: 1.0,
                ..Default::default()
            };
            for x in (0..400).step_by(7) {
                for y in (0..400).step_by(7) {
                    let p = Point::new(x as f64 + 0.5, y as f64 + 0.25);
                    assert_eq!(
                        idx.hit_path(&d, p, &o),
                        hit_path(&d, "page00000001", p, &o),
                        "at {p:?} deep={deep}"
                    );
                    assert_eq!(idx.hit_test(&d, p, &o), hit_test(&d, "page00000001", p, &o));
                }
            }
        }
    }
}
