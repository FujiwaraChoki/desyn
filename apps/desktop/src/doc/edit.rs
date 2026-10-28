//! Editing commands as op lists (applied by the caller as one transaction). Geometry follows the core
//! conventions (page coordinates, rotation about the node center, flips) and the arrangement semantics of
//! `@desyn/doc-ops` / `desyn_core::arrange`.

use desyn_core::arrange::{self, top_level_selection};
use desyn_core::builder::{TxBuilder, decompose_prefer, round_geom};
use desyn_core::geometry::{
    Affine, OrientedBox, Point, Rect, node_aabb, parent_world_transform, world_transform,
};
use desyn_core::ids::IdGen;
use desyn_core::model::{
    AutoLayout, CrossAlign, Design, Id, LayoutMode, MainAlign, Node, NodeType, Op, ROOT_ID,
    TextStylePatch,
};
use serde_json::{Map, Value, json};

/// Numbers as JSON (non-finite values never reach the document).
pub fn num(v: f64) -> Value {
    serde_json::Number::from_f64(if v.is_finite() { round_geom(v) } else { 0.0 })
        .map(Value::Number)
        .unwrap_or(json!(0))
}

/// Top-level selection without pages and the root.
pub fn movable(d: &Design, ids: &[Id]) -> Vec<Id> {
    top_level_selection(d, ids)
        .into_iter()
        .filter(|id| {
            d.node(id)
                .is_some_and(|n| !matches!(n.node_type(), NodeType::Page | NodeType::Root))
        })
        .collect()
}

/// Selection without locked nodes (what canvas gestures may move).
pub fn unlocked(d: &Design, ids: &[Id]) -> Vec<Id> {
    movable(d, ids)
        .into_iter()
        .filter(|id| {
            !d.node(id).is_some_and(|n| n.base().locked)
                && !d
                    .ancestors(id)
                    .iter()
                    .any(|a| d.node(a).is_some_and(|n| n.base().locked))
        })
        .collect()
}

/// Deletes the selection (pages are deleted with [`delete_page`]).
pub fn delete(d: &Design, ids: &[Id]) -> Vec<Op> {
    movable(d, ids).into_iter().map(Op::delete).collect()
}

/// Moves nodes by a page-space delta and refits their groups.
pub fn translate(d: &mut Design, ids: &[Id], dx: f64, dy: f64) -> Vec<Op> {
    let sel = unlocked(d, ids);
    let mut b = TxBuilder::new(d);
    for id in &sel {
        if b.translate_in_page(id, dx, dy).is_err() {
            return b.finish();
        }
    }
    let _ = b.refit_groups(sel.iter());
    b.finish()
}

/// Sets a node's geometry so its world transform is the rigid box `obb` of size `w × h` with the given flips.
fn place_world(
    b: &mut TxBuilder<'_>,
    id: &str,
    center: Point,
    rotation: f64,
    flip: bool,
    w: f64,
    h: f64,
) {
    let Some(n) = b.design.node(id) else { return };
    let base = n.base().clone();
    let f = if flip {
        Affine::scale(-1.0, 1.0)
    } else {
        Affine::IDENTITY
    };
    let world = Affine::translate(center.x, center.y)
        * Affine::rotate_deg(rotation)
        * f
        * Affine::translate(-w / 2.0, -h / 2.0);
    let parent = match b
        .design
        .node(base.parent.as_deref().unwrap_or(ROOT_ID))
        .map(|p| p.node_type())
    {
        Some(NodeType::Page) | Some(NodeType::Root) | None => Affine::IDENTITY,
        _ => parent_world_transform(b.design, id),
    };
    let local = parent.inverse().unwrap_or(Affine::IDENTITY) * world;
    let (x, y, rot, fx, fy) = decompose_prefer(&local, w, h, base.flipped_x(), base.flipped_y());
    let mut set = Map::new();
    set.insert("x".into(), num(x));
    set.insert("y".into(), num(y));
    set.insert("width".into(), num(w.max(0.0)));
    set.insert("height".into(), num(h.max(0.0)));
    set.insert("rotation".into(), num(rot));
    let mut unset: Vec<&str> = Vec::new();
    if fx {
        set.insert("flipX".into(), json!(true));
    } else {
        unset.push("flipX");
    }
    if fy {
        set.insert("flipY".into(), json!(true));
    } else {
        unset.push("flipY");
    }
    let _ = b.update(id, set, &unset);
}

/// Applies the page-space affine map `m` (any combination of translation, rotation, scale and reflection) to the
/// nodes: each keeps a rigid box whose center, orientation and side lengths follow `m`. Groups are transformed
/// through their children (their bounds are derived). Text scaled uniformly scales its font sizes.
pub fn transform_nodes(d: &mut Design, ids: &[Id], m: &Affine) -> Vec<Op> {
    let sel = unlocked(d, ids);
    let mut leaves = Vec::new();
    for id in &sel {
        collect_transform_targets(d, id, &mut leaves);
    }
    let mut b = TxBuilder::new(d);
    let lin = Affine {
        e: 0.0,
        f: 0.0,
        ..*m
    };
    for id in &leaves {
        let Some(n) = b.design.node(id) else { continue };
        let base = n.base().clone();
        let w = world_transform(b.design, id);
        let center = m.apply(w.apply(Point::new(base.width / 2.0, base.height / 2.0)));
        let ux = w.apply_vector(Point::new(1.0, 0.0)).normalize();
        let uy = w.apply_vector(Point::new(0.0, 1.0)).normalize();
        let mx = lin.apply(ux);
        let my = lin.apply(uy);
        let (sw, sh) = (mx.length(), my.length());
        if !(sw.is_finite() && sh.is_finite()) || sw < 1e-9 || sh < 1e-9 {
            continue;
        }
        let rotation = mx.y.atan2(mx.x).to_degrees();
        let flip = mx.cross(my) < 0.0;
        let (nw, nh) = (base.width * sw, base.height * sh);
        place_world(&mut b, id, center, rotation, flip, nw, nh);
        if let Some(Node::Text(t)) = b.design.node(id)
            && (sw - sh).abs() < 1e-6
            && (sw - 1.0).abs() > 1e-9
        {
            let t = t.clone();
            scale_text(&mut b, &t, sw);
        }
    }
    let _ = b.refit_groups(sel.iter());
    b.finish()
}

fn collect_transform_targets(d: &Design, id: &str, out: &mut Vec<Id>) {
    match d.node(id) {
        Some(Node::Group(g)) if !g.container.children.is_empty() => {
            for c in &g.container.children {
                collect_transform_targets(d, c, out);
            }
        }
        Some(_) => out.push(id.to_string()),
        None => {}
    }
}

fn scale_text(b: &mut TxBuilder<'_>, t: &desyn_core::model::TextNode, s: f64) {
    let mut style = serde_json::to_value(&t.style).unwrap_or_default();
    if let Some(fs) = style.get("fontSize").and_then(Value::as_f64) {
        style["fontSize"] = num((fs * s).max(1.0));
    }
    let runs: Vec<Value> = t
        .runs
        .iter()
        .map(|r| {
            let mut v = serde_json::to_value(r).unwrap_or_default();
            if let Some(fs) = r.style.as_ref().and_then(|p: &TextStylePatch| p.font_size) {
                v["style"]["fontSize"] = num((fs * s).max(1.0));
            }
            v
        })
        .collect();
    let mut set = Map::new();
    set.insert("style".into(), style);
    set.insert("runs".into(), Value::Array(runs));
    let _ = b.update(&t.base.id, set, &[]);
}

/// The affine map taking box `from` onto box `to` (both oriented boxes in page space).
pub fn box_map(from: &OrientedBox, to: &OrientedBox, flip_x: bool, flip_y: bool) -> Affine {
    let sx = if from.width.abs() > 1e-9 {
        to.width / from.width
    } else {
        1.0
    };
    let sy = if from.height.abs() > 1e-9 {
        to.height / from.height
    } else {
        1.0
    };
    let fx = if flip_x { -1.0 } else { 1.0 };
    let fy = if flip_y { -1.0 } else { 1.0 };
    // Flips mirror about the new box's center.
    let flip = Affine::translate(to.width / 2.0, to.height / 2.0)
        * Affine::scale(fx, fy)
        * Affine::translate(-to.width / 2.0, -to.height / 2.0);
    let inv = from.transform.inverse().unwrap_or(Affine::IDENTITY);
    to.transform * flip * Affine::scale(sx, sy) * inv
}

/// Rotates nodes by `deg` about a page point.
pub fn rotate(d: &mut Design, ids: &[Id], center: Point, deg: f64) -> Vec<Op> {
    transform_nodes(d, ids, &Affine::rotate_about(deg, center))
}

/// Mirrors the selection horizontally or vertically about its center.
pub fn flip(d: &mut Design, ids: &[Id], horizontal: bool) -> Vec<Op> {
    let sel = unlocked(d, ids);
    let Some(r) = desyn_core::geometry::selection_aabb(d, &sel) else {
        return Vec::new();
    };
    let c = r.center();
    let s = if horizontal {
        Affine::scale(-1.0, 1.0)
    } else {
        Affine::scale(1.0, -1.0)
    };
    let m = Affine::translate(c.x, c.y) * s * Affine::translate(-c.x, -c.y);
    transform_nodes(d, &sel, &m)
}

/// Sets `locked` on the selection.
pub fn set_locked(d: &Design, ids: &[Id], locked: bool) -> Vec<Op> {
    set_flag(d, ids, "locked", locked)
}

/// Sets `visible` on the selection.
pub fn set_visible(d: &Design, ids: &[Id], visible: bool) -> Vec<Op> {
    set_flag(d, ids, "visible", visible)
}

fn set_flag(d: &Design, ids: &[Id], key: &str, v: bool) -> Vec<Op> {
    movable(d, ids)
        .into_iter()
        .filter(|id| {
            d.node(id).is_some_and(|n| match key {
                "locked" => n.base().locked != v,
                _ => n.base().visible != v,
            })
        })
        .map(|id| {
            let mut s = Map::new();
            s.insert(key.into(), json!(v));
            Op::update_set(id, s)
        })
        .collect()
}

/// Renames a node or page.
pub fn rename(d: &Design, id: &str, name: &str) -> Vec<Op> {
    let name = name.trim();
    match d.node(id) {
        Some(n) if !name.is_empty() && n.base().name != name => {
            let mut s = Map::new();
            s.insert("name".into(), json!(name));
            vec![Op::update_set(id, s)]
        }
        _ => Vec::new(),
    }
}

/// Parent shared by the selection (the first node's parent when they differ) and the insert index above the
/// topmost selected node there.
fn common_parent(d: &Design, sel: &[Id]) -> Option<(Id, i64)> {
    let first = sel.first()?;
    let parent = d.node(first)?.parent()?.to_string();
    let idx = sel
        .iter()
        .filter(|id| d.node(id).and_then(|n| n.parent()) == Some(parent.as_str()))
        .filter_map(|id| d.index_in_parent(id))
        .max()
        .map(|i| i as i64 + 1)
        .unwrap_or(0);
    Some((parent, idx))
}

/// Wraps the selection in a new container (`group` or `frame`), keeping every node's page position. Returns the
/// ops and the new container id.
pub fn wrap(
    d: &mut Design,
    ids: &[Id],
    ids_gen: &mut dyn IdGen,
    frame: bool,
) -> Option<(Vec<Op>, Id)> {
    let mut sel = movable(d, ids);
    if sel.is_empty()
        || (!frame
            && sel.len() < 2
            && d.node(&sel[0])
                .is_some_and(|n| n.node_type() == NodeType::Group))
    {
        return None;
    }
    d.sort_by_paint_order(&mut sel);
    let (parent, index) = common_parent(d, &sel)?;
    let aabb = desyn_core::geometry::selection_aabb(d, &sel)?;
    // Container box in the parent's coordinate space.
    let parent_world = match d.node(&parent).map(|n| n.node_type()) {
        Some(NodeType::Page) | Some(NodeType::Root) | None => Affine::IDENTITY,
        _ => world_transform(d, &parent),
    };
    let inv = parent_world.inverse().unwrap_or(Affine::IDENTITY);
    let local = inv.transform_rect_bbox(&aabb);
    let id = ids_gen.next_id();
    let name = if frame { "Frame" } else { "Group" };
    let mut node = if frame {
        Node::frame(id.clone(), name, local.x, local.y, local.w, local.h)
    } else {
        Node::group(id.clone(), name, local.x, local.y, local.w, local.h)
    };
    if frame && let Node::Frame(f) = &mut node {
        // A frame made from a selection is a transparent layout box, not a white card.
        f.shape.fills.clear();
        f.container.clip = false;
    }
    let mut b = TxBuilder::new(d);
    if b.push(Op::create(vec![node], parent.clone(), Some(index)))
        .is_err()
    {
        b.finish();
        return None;
    }
    for sid in &sel {
        let Some(p) = desyn_core::geometry::reparent_placement(b.design, sid, &id) else {
            continue;
        };
        if b.push(Op::move_to(sid.clone(), id.clone(), None)).is_err() {
            continue;
        }
        let mut s = Map::new();
        s.insert("x".into(), num(p.x));
        s.insert("y".into(), num(p.y));
        s.insert("rotation".into(), num(p.rotation));
        let mut unset = Vec::new();
        if p.flip_x {
            s.insert("flipX".into(), json!(true));
        } else {
            unset.push("flipX");
        }
        unset.push("flipY");
        let _ = b.update(sid, s, &unset);
    }
    let _ = b.refit_groups([&id]);
    Some((b.finish(), id))
}

/// Groups the selection (mod+G).
pub fn group(d: &mut Design, ids: &[Id], idg: &mut dyn IdGen) -> Option<(Vec<Op>, Id)> {
    wrap(d, ids, idg, false)
}

/// Wraps the selection in a frame (mod+alt+G).
pub fn frame_selection(d: &mut Design, ids: &[Id], idg: &mut dyn IdGen) -> Option<(Vec<Op>, Id)> {
    wrap(d, ids, idg, true)
}

/// Ungroups groups (and booleans) in the selection: children move to the group's parent at its position, keeping
/// their page placement. Returns the ops and the released children.
pub fn ungroup(d: &mut Design, ids: &[Id]) -> (Vec<Op>, Vec<Id>) {
    let groups: Vec<Id> = movable(d, ids)
        .into_iter()
        .filter(|id| {
            d.node(id)
                .is_some_and(|n| matches!(n.node_type(), NodeType::Group | NodeType::Boolean))
        })
        .collect();
    let mut released = Vec::new();
    let mut b = TxBuilder::new(d);
    for g in &groups {
        let Some(n) = b.design.node(g) else { continue };
        let parent = n.parent().unwrap_or(ROOT_ID).to_string();
        let kids = n.child_ids().to_vec();
        let mut index = b.design.index_in_parent(g).unwrap_or(0) as i64;
        for k in kids {
            let Some(p) = desyn_core::geometry::reparent_placement(b.design, &k, &parent) else {
                continue;
            };
            if b.push(Op::move_to(k.clone(), parent.clone(), Some(index)))
                .is_err()
            {
                continue;
            }
            index += 1;
            let mut s = Map::new();
            s.insert("x".into(), num(p.x));
            s.insert("y".into(), num(p.y));
            s.insert("rotation".into(), num(p.rotation));
            let mut unset = vec!["flipY"];
            if p.flip_x {
                s.insert("flipX".into(), json!(true));
            } else {
                unset.push("flipX");
            }
            let _ = b.update(&k, s, &unset);
            released.push(k);
        }
        let _ = b.push(Op::delete(g.clone()));
    }
    let _ = b.refit_groups(released.iter());
    (b.finish(), released)
}

/// Groups the selection and makes its bottom layer a mask (mod+alt+M). A single selected node becomes a mask in
/// place.
pub fn use_as_mask(d: &mut Design, ids: &[Id], idg: &mut dyn IdGen) -> Option<(Vec<Op>, Id)> {
    let mut sel = movable(d, ids);
    if sel.is_empty() {
        return None;
    }
    d.sort_by_paint_order(&mut sel);
    if sel.len() == 1 {
        let mut s = Map::new();
        s.insert("mask".into(), json!(true));
        return Some((vec![Op::update_set(sel[0].clone(), s)], sel[0].clone()));
    }
    let (mut ops, gid) = wrap(d, &sel, idg, false)?;
    let mut s = Map::new();
    s.insert("mask".into(), json!(true));
    ops.push(Op::update_set(sel[0].clone(), s));
    let _ = d;
    Some((ops, gid))
}

/// Adds auto-layout (shift+A): a frame without layout gets one; anything else is wrapped in a frame with layout.
/// The direction follows how the children are arranged.
pub fn add_auto_layout(d: &mut Design, ids: &[Id], idg: &mut dyn IdGen) -> Option<(Vec<Op>, Id)> {
    let sel = movable(d, ids);
    let (mut ops, target, kids) = match sel.as_slice() {
        [one] if matches!(d.node(one), Some(Node::Frame(f)) if f.container.layout.is_none()) => {
            let kids = d
                .node(one)
                .map(|n| n.child_ids().to_vec())
                .unwrap_or_default();
            (Vec::new(), one.clone(), kids)
        }
        _ => {
            let (ops, id) = wrap(d, &sel, idg, true)?;
            (ops, id, sel.clone())
        }
    };
    let rects: Vec<Rect> = kids.iter().filter_map(|k| node_aabb(d, k)).collect();
    let mode = if rects.len() >= 2 {
        let (mut xs, mut ys): (Vec<f64>, Vec<f64>) =
            rects.iter().map(|r| (r.center_x(), r.center_y())).unzip();
        xs.sort_by(f64::total_cmp);
        ys.sort_by(f64::total_cmp);
        if xs[xs.len() - 1] - xs[0] >= ys[ys.len() - 1] - ys[0] {
            LayoutMode::Row
        } else {
            LayoutMode::Column
        }
    } else {
        LayoutMode::Column
    };
    let gap = estimate_gap(&rects, mode);
    let layout = AutoLayout {
        mode,
        gap,
        row_gap: None,
        padding: [0.0; 4],
        main_align: MainAlign::Start,
        cross_align: CrossAlign::Start,
        wrap: None,
        columns: None,
        reverse: None,
        extra: Default::default(),
    };
    ops.push(Op::patch(
        target.clone(),
        vec!["layout".into()],
        serde_json::to_value(layout).ok()?,
    ));
    Some((ops, target))
}

fn estimate_gap(rects: &[Rect], mode: LayoutMode) -> f64 {
    let mut r: Vec<Rect> = rects.to_vec();
    match mode {
        LayoutMode::Row => r.sort_by(|a, b| a.x.total_cmp(&b.x)),
        _ => r.sort_by(|a, b| a.y.total_cmp(&b.y)),
    }
    let gaps: Vec<f64> = r
        .windows(2)
        .map(|w| match mode {
            LayoutMode::Row => w[1].x - w[0].right(),
            _ => w[1].y - w[0].bottom(),
        })
        .filter(|g| *g >= 0.0)
        .collect();
    if gaps.is_empty() {
        16.0
    } else {
        (gaps.iter().sum::<f64>() / gaps.len() as f64).round()
    }
}

/// Duplicates the selection with an offset; returns ops and the new top-level ids.
pub fn duplicate(
    d: &mut Design,
    ids: &[Id],
    offset: (f64, f64),
    idg: &mut dyn IdGen,
) -> (Vec<Op>, Vec<Id>) {
    let sel = movable(d, ids);
    let ops = desyn_core::clipboard::duplicate(d, &sel, offset, idg).unwrap_or_default();
    let new_ids = ops
        .iter()
        .filter_map(|o| match o {
            Op::Create(c) => c.nodes.first().map(|n| n.id().to_string()),
            _ => None,
        })
        .collect();
    (ops, new_ids)
}

/// Z-order (mod+[ / ] with alt for back / front).
pub fn reorder(d: &Design, ids: &[Id], kind: arrange::ZOrder) -> Vec<Op> {
    arrange::reorder(d, ids, kind)
}

/// Aligns the selection (one node aligns to its page).
pub fn align(d: &mut Design, ids: &[Id], a: arrange::Alignment) -> Vec<Op> {
    let sel = unlocked(d, ids);
    arrange::align_nodes(d, &sel, a, arrange::AlignTo::Selection).unwrap_or_default()
}

/// Distributes the selection evenly (needs three or more).
pub fn distribute(d: &mut Design, ids: &[Id], axis: arrange::DistributeAxis) -> Vec<Op> {
    let sel = unlocked(d, ids);
    if sel.len() < 3 {
        return Vec::new();
    }
    arrange::distribute(d, &sel, axis, None).unwrap_or_default()
}

/// Visible, unlocked children of a container (select all).
pub fn selectable_children(d: &Design, parent: &str) -> Vec<Id> {
    d.node(parent)
        .map(|n| {
            n.child_ids()
                .iter()
                .filter(|c| {
                    d.node(c)
                        .is_some_and(|n| n.base().visible && !n.base().locked)
                })
                .cloned()
                .collect()
        })
        .unwrap_or_default()
}

/// Layers on the page that match the selection's type (and, for text, font family) — "Select matching layers".
pub fn matching(d: &Design, page: &str, ids: &[Id]) -> Vec<Id> {
    let kinds: Vec<NodeType> = ids
        .iter()
        .filter_map(|i| d.node(i))
        .map(|n| n.node_type())
        .collect();
    if kinds.is_empty() {
        return Vec::new();
    }
    let families: Vec<String> = ids
        .iter()
        .filter_map(|i| match d.node(i) {
            Some(Node::Text(t)) => Some(t.style.font_family.clone()),
            _ => None,
        })
        .collect();
    let mut out = Vec::new();
    d.walk(page, &mut |n, _| {
        if n.node_type() != NodeType::Page
            && n.base().visible
            && !n.base().locked
            && kinds.contains(&n.node_type())
            && match n {
                Node::Text(t) => families.is_empty() || families.contains(&t.style.font_family),
                _ => true,
            }
        {
            out.push(n.id().to_string());
        }
        true
    });
    out
}

// ---------------------------------------------------------------------------------------------------------------
// Pages

/// Adds a page after `after` (or at the end) with the size and background of `like`.
pub fn add_page(
    d: &Design,
    after: Option<&str>,
    like: Option<&str>,
    idg: &mut dyn IdGen,
) -> (Vec<Op>, Id) {
    let pages = d.page_ids();
    let template = like
        .or(after)
        .or(pages.last().map(String::as_str))
        .and_then(|p| d.node(p));
    let (w, h) = template
        .map(|n| (n.base().width, n.base().height))
        .unwrap_or((1080.0, 1080.0));
    let id = idg.next_id();
    let mut page = Node::page(id.clone(), format!("Page {}", pages.len() + 1), w, h);
    if let (Some(Node::Page(src)), Node::Page(p)) = (template, &mut page) {
        p.background = src.background.clone();
        p.unit = src.unit;
        p.bleed = src.bleed;
        p.grid = src.grid.clone();
    }
    let index = after
        .and_then(|a| pages.iter().position(|p| p == a))
        .map(|i| i as i64 + 1);
    (vec![Op::create(vec![page], ROOT_ID, index)], id)
}

/// Duplicates a page (with fresh ids for every node) right after it.
pub fn duplicate_page(d: &Design, page: &str, idg: &mut dyn IdGen) -> Option<(Vec<Op>, Id)> {
    let pages = d.page_ids();
    let at = pages.iter().position(|p| p == page)?;
    let opts = desyn_core::clipboard::CloneOptions {
        parent: Some(ROOT_ID.into()),
        index: Some(at as i64 + 1),
        offset: None,
        name: d.node(page).map(|n| format!("{} copy", n.base().name)),
    };
    let c = desyn_core::clipboard::clone_subtree(d, page, idg, &opts)?;
    let id = c.id_map.get(page)?.clone();
    Some((vec![c.op], id))
}

/// Deletes a page (never the last one).
pub fn delete_page(d: &Design, page: &str) -> Vec<Op> {
    if d.page_ids().len() <= 1 || !d.page_ids().iter().any(|p| p == page) {
        return Vec::new();
    }
    vec![Op::delete(page)]
}

/// Moves a page to `index` (final position).
pub fn move_page(d: &Design, page: &str, index: usize) -> Vec<Op> {
    let pages = d.page_ids();
    match pages.iter().position(|p| p == page) {
        Some(cur) if cur != index && index < pages.len() => {
            vec![Op::move_to(page, ROOT_ID, Some(index as i64))]
        }
        _ => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::doc::Document;
    use desyn_core::geometry::node_obb;
    use desyn_core::layout::ApproxMeasurer;
    use desyn_core::model::DesignKind;

    struct Fx {
        doc: Document,
        page: Id,
    }

    impl Fx {
        fn new() -> Fx {
            let doc = Document::blank("T", DesignKind::Poster, 1000.0, 1000.0);
            let page = doc.design.page_ids()[0].clone();
            Fx { doc, page }
        }
        fn rect(&mut self, x: f64, y: f64, w: f64, h: f64) -> Id {
            let id = self.doc.new_id();
            let n = Node::rect(id.clone(), "R", x, y, w, h);
            self.doc.apply(
                vec![Op::create(vec![n], self.page.clone(), None)],
                "add",
                &mut ApproxMeasurer,
            );
            id
        }
        fn apply(&mut self, ops: Vec<Op>) {
            assert!(!ops.is_empty(), "expected ops");
            self.doc
                .apply(ops, "edit", &mut ApproxMeasurer)
                .expect("applies");
        }
        fn aabb(&self, id: &str) -> Rect {
            node_aabb(&self.doc.design, id).unwrap()
        }
    }

    fn close(a: f64, b: f64) -> bool {
        (a - b).abs() < 1e-3
    }

    #[test]
    fn translate_and_lock() {
        let mut f = Fx::new();
        let a = f.rect(10.0, 10.0, 50.0, 50.0);
        let ops = translate(&mut f.doc.design, std::slice::from_ref(&a), 5.0, -3.0);
        f.apply(ops);
        assert_eq!(
            f.aabb(&a),
            Rect {
                x: 15.0,
                y: 7.0,
                w: 50.0,
                h: 50.0
            }
        );
        let ops = set_locked(&f.doc.design, std::slice::from_ref(&a), true);
        f.apply(ops);
        assert!(
            translate(&mut f.doc.design, std::slice::from_ref(&a), 5.0, 0.0).is_empty(),
            "locked nodes stay"
        );
        assert!(
            set_locked(&f.doc.design, std::slice::from_ref(&a), true).is_empty(),
            "no-op"
        );
    }

    #[test]
    fn group_ungroup_keeps_positions() {
        let mut f = Fx::new();
        let a = f.rect(100.0, 100.0, 50.0, 50.0);
        let b = f.rect(300.0, 200.0, 20.0, 80.0);
        let before = (f.aabb(&a), f.aabb(&b));
        let design = f.doc.design.clone();
        let mut d = design.clone();
        let (ops, g) = group(&mut d, &[a.clone(), b.clone()], f.doc.id_gen()).unwrap();
        assert_eq!(
            d.canonical_json(),
            design.canonical_json(),
            "builder leaves the design untouched"
        );
        f.apply(ops);
        assert_eq!(f.doc.design.node(&a).unwrap().parent(), Some(g.as_str()));
        assert_eq!((f.aabb(&a), f.aabb(&b)), before);
        assert_eq!(
            f.aabb(&g),
            Rect {
                x: 100.0,
                y: 100.0,
                w: 220.0,
                h: 180.0
            }
        );
        let (ops, released) = ungroup(&mut f.doc.design, std::slice::from_ref(&g));
        f.apply(ops);
        assert_eq!(released.len(), 2);
        assert!(f.doc.design.node(&g).is_none());
        assert_eq!((f.aabb(&a), f.aabb(&b)), before);
    }

    #[test]
    fn resize_and_rotate_through_box_map() {
        let mut f = Fx::new();
        let a = f.rect(100.0, 100.0, 100.0, 50.0);
        let from = node_obb(&f.doc.design, &a).unwrap();
        let to = OrientedBox {
            transform: Affine::translate(100.0, 100.0),
            width: 200.0,
            height: 100.0,
        };
        let m = box_map(&from, &to, false, false);
        let ops = transform_nodes(&mut f.doc.design, std::slice::from_ref(&a), &m);
        f.apply(ops);
        assert_eq!(
            f.aabb(&a),
            Rect {
                x: 100.0,
                y: 100.0,
                w: 200.0,
                h: 100.0
            }
        );
        let c = f.aabb(&a).center();
        let ops = rotate(&mut f.doc.design, std::slice::from_ref(&a), c, 90.0);
        f.apply(ops);
        let n = f.doc.design.node(&a).unwrap().base().clone();
        assert!(close(n.rotation, 90.0), "{}", n.rotation);
        let r = f.aabb(&a);
        assert!(close(r.w, 100.0) && close(r.h, 200.0), "{r:?}");
        // Flip across the box keeps the box but toggles flipX.
        let from = node_obb(&f.doc.design, &a).unwrap();
        let m = box_map(&from, &from, true, false);
        let ops = transform_nodes(&mut f.doc.design, std::slice::from_ref(&a), &m);
        f.apply(ops);
        let r2 = f.aabb(&a);
        assert!(close(r2.x, r.x) && close(r2.w, r.w));
        assert!(
            f.doc.design.node(&a).unwrap().base().flipped_x()
                ^ f.doc.design.node(&a).unwrap().base().flipped_y()
        );
    }

    #[test]
    fn flips_mirror_positions() {
        let mut f = Fx::new();
        let a = f.rect(0.0, 0.0, 10.0, 10.0);
        let b = f.rect(90.0, 0.0, 10.0, 10.0);
        let c = f.rect(40.0, 50.0, 20.0, 10.0);
        let before_c = f.aabb(&c);
        let ops = flip(&mut f.doc.design, &[a.clone(), b.clone(), c.clone()], true);
        f.apply(ops);
        assert!(close(f.aabb(&a).x, 90.0));
        assert!(close(f.aabb(&b).x, 0.0));
        let after_c = f.aabb(&c);
        assert!(
            close(after_c.x, before_c.x)
                && close(after_c.y, before_c.y)
                && close(after_c.w, before_c.w)
        );
        assert!(f.doc.design.node(&c).unwrap().base().flipped_x());
    }

    #[test]
    fn frames_masks_and_auto_layout() {
        let mut f = Fx::new();
        let a = f.rect(0.0, 0.0, 10.0, 10.0);
        let b = f.rect(30.0, 0.0, 10.0, 10.0);
        let (d, g) = f.doc.split();
        let (ops, fr) = add_auto_layout(d, &[a.clone(), b.clone()], g).unwrap();
        f.apply(ops);
        match f.doc.design.node(&fr) {
            Some(Node::Frame(fr)) => {
                let l = fr.container.layout.as_ref().unwrap();
                assert_eq!(l.mode, LayoutMode::Row);
                assert_eq!(l.gap, 20.0);
            }
            other => panic!("{other:?}"),
        }
        let c = f.rect(500.0, 500.0, 10.0, 10.0);
        let d2 = f.rect(505.0, 505.0, 10.0, 10.0);
        let (d, g) = f.doc.split();
        let (ops, _) = use_as_mask(d, &[d2.clone(), c.clone()], g).unwrap();
        f.apply(ops);
        assert_eq!(f.doc.design.node(&c).unwrap().base().mask, Some(true));
    }

    #[test]
    fn pages() {
        let mut f = Fx::new();
        let first = f.page.clone();
        f.rect(1.0, 1.0, 5.0, 5.0);
        let (d, g) = f.doc.split();
        let (ops, p2) = add_page(d, Some(&first), None, g);
        f.apply(ops);
        assert_eq!(f.doc.design.page_ids(), [first.clone(), p2.clone()]);
        let (d, g) = f.doc.split();
        let (ops, p3) = duplicate_page(d, &first, g).unwrap();
        f.apply(ops);
        assert_eq!(f.doc.design.page_ids()[1], p3);
        assert_eq!(f.doc.design.node(&p3).unwrap().child_ids().len(), 1);
        let ops = move_page(&f.doc.design, &first, 2);
        f.apply(ops);
        assert_eq!(f.doc.design.page_ids()[2], first);
        let ops = delete_page(&f.doc.design, &p2);
        f.apply(ops);
        let ops = delete_page(&f.doc.design, &p3);
        f.apply(ops);
        assert!(
            delete_page(&f.doc.design, &first).is_empty(),
            "the last page stays"
        );
    }

    #[test]
    fn duplicate_and_matching() {
        let mut f = Fx::new();
        let a = f.rect(0.0, 0.0, 10.0, 10.0);
        let (d, g) = f.doc.split();
        let (ops, ids) = duplicate(d, std::slice::from_ref(&a), (10.0, 10.0), g);
        f.apply(ops);
        assert_eq!(ids.len(), 1);
        assert_eq!(f.aabb(&ids[0]).x, 10.0);
        let all = matching(&f.doc.design, &f.page, std::slice::from_ref(&a));
        assert_eq!(all.len(), 2);
        assert_eq!(selectable_children(&f.doc.design, &f.page).len(), 2);
    }
}
