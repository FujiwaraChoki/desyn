//! Group / boolean bounds recomputation: the container box is fitted to its children's rotated bounds while every
//! child keeps its world position.

use super::changes::{ChangeLog, Geo, geo_of};
use crate::geometry::{Affine, Point, Rect, bounds_in_parent, local_transform};
use crate::model::Design;

const EPS: f64 = 1e-9;

/// Fits the box of the group (or boolean) `id` to the union of its children's bounds. Visible children define the
/// bounds; when none is visible all children do; an empty group keeps its box. Returns true when anything changed.
pub fn fit_group_bounds(d: &mut Design, id: &str) -> bool {
    let mut log = ChangeLog::default();
    fit(d, id, &mut log);
    !log.finish(d).is_empty()
}

pub(crate) fn fit(d: &mut Design, id: &str, log: &mut ChangeLog) {
    let Some(group) = d.node(id) else { return };
    let children: Vec<String> = group.child_ids().to_vec();
    if children.is_empty() {
        return;
    }
    let boxes = |visible_only: bool| -> Vec<Rect> {
        children
            .iter()
            .filter_map(|c| d.node(c))
            .filter(|n| !visible_only || n.base().visible)
            .map(|n| bounds_in_parent(n.base()))
            .collect()
    };
    let mut rects = boxes(true);
    if rects.is_empty() {
        rects = boxes(false);
    }
    let Some(u) = crate::geometry::union_bounds(rects.iter()) else {
        return;
    };
    let gb = group.base().clone();
    let (mx, my) = (u.x, u.y);
    if mx.abs() < EPS
        && my.abs() < EPS
        && (u.w - gb.width).abs() < EPS
        && (u.h - gb.height).abs() < EPS
    {
        return;
    }
    // Keep children fixed in world space: x' = x + c - c' + L(m + c' - c).
    let t = local_transform(&gb);
    let linear = Affine {
        e: 0.0,
        f: 0.0,
        ..t
    };
    let c = Point::new(gb.width / 2.0, gb.height / 2.0);
    let c2 = Point::new(u.w / 2.0, u.h / 2.0);
    let v = linear.apply(Point::new(mx + c2.x - c.x, my + c2.y - c.y));
    let nx = gb.x + c.x - c2.x + v.x;
    let ny = gb.y + c.y - c2.y + v.y;
    log.set(
        d,
        id,
        Geo {
            x: nx,
            y: ny,
            width: u.w,
            height: u.h,
        },
    );
    for cid in &children {
        if let Some(g) = geo_of(d, cid) {
            log.set(
                d,
                cid,
                Geo {
                    x: g.x - mx,
                    y: g.y - my,
                    ..g
                },
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::geometry::node_aabb;
    use crate::model::{DesignKind, Node};

    #[test]
    fn fits_and_preserves_world_positions() {
        let mut d = Design::with_page(
            "dddddddddddd",
            "D",
            DesignKind::Poster,
            "pppppppppppp",
            500.0,
            500.0,
        );
        let mut g = Node::group("gggggggggggg", "G", 50.0, 50.0, 10.0, 10.0);
        g.base_mut().rotation = 30.0;
        d.push_child("pppppppppppp", g);
        d.push_child(
            "gggggggggggg",
            Node::rect("aaaaaaaaaaaa", "A", 20.0, 30.0, 40.0, 10.0),
        );
        let mut b = Node::rect("bbbbbbbbbbbb", "B", -10.0, 0.0, 20.0, 20.0);
        b.base_mut().rotation = 45.0;
        d.push_child("gggggggggggg", b);
        let before_a = node_aabb(&d, "aaaaaaaaaaaa").unwrap();
        let before_b = node_aabb(&d, "bbbbbbbbbbbb").unwrap();
        assert!(fit_group_bounds(&mut d, "gggggggggggg"));
        let after_a = node_aabb(&d, "aaaaaaaaaaaa").unwrap();
        let after_b = node_aabb(&d, "bbbbbbbbbbbb").unwrap();
        for (p, q) in [(before_a, after_a), (before_b, after_b)] {
            assert!(
                (p.x - q.x).abs() < 1e-9 && (p.y - q.y).abs() < 1e-9 && (p.w - q.w).abs() < 1e-9
            );
        }
        // Children now start at the group's origin.
        let g = d.node("gggggggggggg").unwrap().base().clone();
        let r = crate::geometry::union_bounds(
            ["aaaaaaaaaaaa", "bbbbbbbbbbbb"]
                .iter()
                .map(|i| bounds_in_parent(d.node(i).unwrap().base()))
                .collect::<Vec<_>>()
                .iter(),
        )
        .unwrap();
        assert!(r.x.abs() < 1e-9 && r.y.abs() < 1e-9);
        assert!((r.w - g.width).abs() < 1e-9 && (r.h - g.height).abs() < 1e-9);
        // Idempotent.
        assert!(!fit_group_bounds(&mut d, "gggggggggggg"));
    }
}
