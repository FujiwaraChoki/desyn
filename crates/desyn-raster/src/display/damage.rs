//! Damage computation between two display lists of the same page: which page-space rectangles must be redrawn.

use std::collections::HashMap;

use desyn_core::geometry::{Affine, Rect};
use tiny_skia::IntRect;

use super::{DisplayList, Item, Layer};
use crate::geom;

fn same_header(a: &Layer, b: &Layer) -> bool {
    a.transform == b.transform
        && a.opacity == b.opacity
        && a.blend == b.blend
        && a.effects == b.effects
        && a.clip.as_ref().map(|c| geom::path_bounds(&c.path))
            == b.clip.as_ref().map(|c| geom::path_bounds(&c.path))
        && a.mask.as_ref().map(|m| m.layer.key) == b.mask.as_ref().map(|m| m.layer.key)
}

fn push(out: &mut Vec<Rect>, t: &Affine, r: &Rect) {
    if r.w > 0.0 && r.h > 0.0 {
        out.push(t.transform_rect_bbox(r));
    }
}

fn leaf_bounds(l: &Layer) -> Option<Rect> {
    let mut r: Option<Rect> = None;
    for it in &l.items {
        if !matches!(it, Item::Layer(_)) {
            r = geom::union_rect(r, &it.bounds());
        }
    }
    r
}

/// `parent` maps the layers' parent space to page space.
fn diff_layer(a: &Layer, b: &Layer, parent: &Affine, out: &mut Vec<Rect>) {
    if a.key == b.key && a.transform == b.transform {
        return;
    }
    if !same_header(a, b) || !a.effects.is_empty() {
        // Effects (blur, shadows) spread any inner change over the layer: redraw both extents.
        push(out, parent, &a.bounds);
        push(out, parent, &b.bounds);
        return;
    }
    let inner = *parent * a.transform;
    if a.paint_key != b.paint_key {
        if let Some(r) = leaf_bounds(a) {
            push(out, &inner, &r);
        }
        if let Some(r) = leaf_bounds(b) {
            push(out, &inner, &r);
        }
    }
    let la: Vec<&Layer> = a
        .items
        .iter()
        .filter_map(|i| match i {
            Item::Layer(l) => Some(l.as_ref()),
            _ => None,
        })
        .collect();
    let lb: Vec<&Layer> = b
        .items
        .iter()
        .filter_map(|i| match i {
            Item::Layer(l) => Some(l.as_ref()),
            _ => None,
        })
        .collect();
    let id = |l: &Layer, i: usize| -> String {
        match &l.node {
            Some(n) => format!("n:{n}"),
            None => format!("i:{i}"),
        }
    };
    let ia: HashMap<String, (usize, &Layer)> = la
        .iter()
        .enumerate()
        .map(|(i, l)| (id(l, i), (i, *l)))
        .collect();
    let ib: HashMap<String, (usize, &Layer)> = lb
        .iter()
        .enumerate()
        .map(|(i, l)| (id(l, i), (i, *l)))
        .collect();
    // Relative order of matched children; a reorder damages the reordered layers.
    let order_a: Vec<&String> = {
        let mut v: Vec<(&String, usize)> = ia
            .iter()
            .filter(|(k, _)| ib.contains_key(*k))
            .map(|(k, (i, _))| (k, *i))
            .collect();
        v.sort_by_key(|x| x.1);
        v.into_iter().map(|x| x.0).collect()
    };
    let order_b: Vec<&String> = {
        let mut v: Vec<(&String, usize)> = ib
            .iter()
            .filter(|(k, _)| ia.contains_key(*k))
            .map(|(k, (i, _))| (k, *i))
            .collect();
        v.sort_by_key(|x| x.1);
        v.into_iter().map(|x| x.0).collect()
    };
    let reordered = order_a != order_b;
    for (k, (_, l)) in &ia {
        match ib.get(k) {
            None => push(out, &inner, &l.bounds),
            Some((_, m)) => {
                if reordered
                    && (l.key != m.key
                        || order_a.iter().position(|x| x == &k)
                            != order_b.iter().position(|x| x == &k))
                {
                    push(out, &inner, &l.bounds);
                    push(out, &inner, &m.bounds);
                } else {
                    diff_layer(l, m, &inner, out);
                }
            }
        }
    }
    for (k, (_, m)) in &ib {
        if !ia.contains_key(k) {
            push(out, &inner, &m.bounds);
        }
    }
}

/// Page-space rectangles that changed between `old` and `new` (both built for the same page). Lists for
/// different pages or sizes damage everything.
pub fn damage(old: &DisplayList, new: &DisplayList) -> Vec<Rect> {
    if old.page != new.page
        || old.width != new.width
        || old.height != new.height
        || old.bleed != new.bleed
    {
        let mut v = Vec::new();
        push(
            &mut v,
            &Affine::IDENTITY,
            &old.root.bounds.union(&old.page_rect()),
        );
        push(
            &mut v,
            &Affine::IDENTITY,
            &new.root.bounds.union(&new.page_rect()),
        );
        return v;
    }
    let mut out = Vec::new();
    diff_layer(&old.root, &new.root, &Affine::IDENTITY, &mut out);
    out
}

/// Damage in device pixels for a page-to-device transform: rectangles grown by one pixel (antialiasing),
/// clipped to `bounds`, overlapping ones merged, and collapsed into their union when more than `max_rects`
/// remain.
pub fn damage_rects(
    old: &DisplayList,
    new: &DisplayList,
    view: &Affine,
    bounds: IntRect,
    max_rects: usize,
) -> Vec<IntRect> {
    let mut rects: Vec<IntRect> = damage(old, new)
        .iter()
        .filter_map(|r| geom::round_out(&view.transform_rect_bbox(r)))
        .map(|r| geom::outset_int(&r, 1))
        .filter_map(|r| geom::intersect(&r, &bounds))
        .collect();
    // Merge overlapping rectangles until stable.
    let mut changed = true;
    while changed {
        changed = false;
        let mut i = 0;
        while i < rects.len() {
            let mut j = i + 1;
            while j < rects.len() {
                if geom::intersect(&geom::outset_int(&rects[i], 1), &rects[j]).is_some() {
                    rects[i] = geom::union_int(&rects[i], &rects[j]);
                    rects.swap_remove(j);
                    changed = true;
                } else {
                    j += 1;
                }
            }
            i += 1;
        }
    }
    if rects.len() > max_rects.max(1) {
        let u = rects
            .iter()
            .skip(1)
            .fold(rects[0], |a, b| geom::union_int(&a, b));
        return vec![u];
    }
    rects
}
