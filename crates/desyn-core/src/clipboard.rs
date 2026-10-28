//! Subtree cloning with fresh ids, duplication and clipboard payloads (copy / paste across designs, including the
//! referenced assets and styles).

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::arrange::top_level_selection;
use crate::builder::{BuildError, TxBuilder};
use crate::geometry::{
    Affine, Point, Rect, decompose_local, local_transform, union_bounds, world_transform,
};
use crate::ids::IdGen;
use crate::model::*;

/// Options for [`clone_subtree`].
#[derive(Debug, Clone, Default)]
pub struct CloneOptions {
    /// Parent of the copy (default: the original's parent).
    pub parent: Option<Id>,
    /// Index in the parent (default: right above the original when the parent is unchanged, else on top).
    pub index: Option<i64>,
    /// Offset added to the copy's x / y.
    pub offset: Option<(f64, f64)>,
    /// Name of the copy's root.
    pub name: Option<String>,
}

/// A cloned subtree: the `create` op inserting it and the old -> new id map.
#[derive(Debug, Clone)]
pub struct ClonedSubtree {
    /// The create op.
    pub op: Op,
    /// Old id -> new id for every node of the subtree.
    pub id_map: BTreeMap<Id, Id>,
}

/// Deep-copies the subtree rooted at `id` with fresh ids from `ids`. Animation ids are renewed and
/// `link: "page:<id>"` references into the copied subtree are remapped. `None` for a missing node or the root.
pub fn clone_subtree(
    d: &Design,
    id: &str,
    ids: &mut dyn IdGen,
    o: &CloneOptions,
) -> Option<ClonedSubtree> {
    let root = d.node(id)?;
    if root.node_type() == NodeType::Root {
        return None;
    }
    let order = d.subtree_ids(id);
    let mut id_map = BTreeMap::new();
    for old in &order {
        id_map.insert(old.clone(), ids.next_id());
    }
    let nodes: Vec<Node> = order
        .iter()
        .enumerate()
        .filter_map(|(i, old)| d.node(old).map(|n| remap_node(n, i == 0, &id_map, ids)))
        .collect();
    let mut nodes = nodes;
    let parent = o
        .parent
        .clone()
        .unwrap_or_else(|| root.parent().unwrap_or(ROOT_ID).to_string());
    {
        let head = nodes[0].base_mut();
        head.parent = Some(parent.clone());
        if let Some((dx, dy)) = o.offset {
            head.x += dx;
            head.y += dy;
        }
        if let Some(n) = &o.name {
            head.name = n.clone();
        }
    }
    let index = o.index.unwrap_or_else(|| {
        if Some(parent.as_str()) == root.parent() {
            d.index_in_parent(id).map(|i| i as i64 + 1).unwrap_or(0)
        } else {
            d.node(&parent)
                .map(|p| p.child_ids().len() as i64)
                .unwrap_or(0)
        }
    });
    Some(ClonedSubtree {
        op: Op::create(nodes, parent, Some(index)),
        id_map,
    })
}

fn remap_node(n: &Node, is_head: bool, map: &BTreeMap<Id, Id>, ids: &mut dyn IdGen) -> Node {
    let mut c = n.clone();
    let remap = |old: &str| map.get(old).cloned().unwrap_or_else(|| old.to_string());
    let b = c.base_mut();
    b.id = remap(&n.base().id);
    if !is_head && let Some(p) = &n.base().parent {
        b.parent = Some(remap(p));
    }
    if let Some(anims) = &mut b.anim {
        for a in anims.iter_mut() {
            a.id = ids.next_id();
        }
    }
    if let Some(link) = &b.link
        && let Some(target) = link.strip_prefix("page:")
    {
        b.link = Some(format!("page:{}", remap(target)));
    }
    if let Some(ch) = c.children_mut() {
        for x in ch.iter_mut() {
            *x = remap(x);
        }
    }
    c
}

/// Duplicates the top-level selection, each copy directly above its original and offset by `offset` (pages are
/// never offset). Groups containing copies are refitted. The design is left unchanged.
pub fn duplicate(
    d: &mut Design,
    ids: &[Id],
    offset: (f64, f64),
    idgen: &mut dyn IdGen,
) -> Result<Vec<Op>, BuildError> {
    let sel = top_level_selection(d, ids);
    let mut b = TxBuilder::new(d);
    for id in &sel {
        let is_page = b
            .design
            .node(id)
            .is_some_and(|n| n.node_type() == NodeType::Page);
        let o = CloneOptions {
            offset: (!is_page).then_some(offset),
            ..Default::default()
        };
        let Some(c) = clone_subtree(b.design, id, idgen, &o) else {
            continue;
        };
        if let Err(e) = b.push(c.op) {
            b.finish();
            return Err(e);
        }
    }
    if let Err(e) = b.refit_groups(sel.iter()) {
        b.finish();
        return Err(e);
    }
    Ok(b.finish())
}

fn fill_assets(fills: &[Fill], out: &mut Vec<Id>) {
    for f in fills {
        if let Fill::Image(i) = f {
            out.push(i.asset_id.clone());
        }
    }
}

fn text_style_assets(s: &TextStyle, out: &mut Vec<Id>) {
    fill_assets(&s.fills, out);
}

/// Asset ids a node references directly (images, svg, video, audio, posters, masks, image fills in fills, strokes,
/// backgrounds and text styles). Fonts are referenced by family name, see [`font_families`].
pub fn node_asset_refs(n: &Node) -> Vec<Id> {
    let mut out = Vec::new();
    fill_assets(n.fills(), &mut out);
    for s in n.strokes() {
        fill_assets(&s.fills, &mut out);
    }
    match n {
        Node::Image(i) => {
            out.push(i.asset_id.clone());
            out.extend(i.mask_asset_id.clone());
        }
        Node::Svg(s) => out.extend(s.asset_id.clone()),
        Node::Video(v) => {
            out.push(v.asset_id.clone());
            out.extend(v.poster_asset_id.clone());
        }
        Node::Audio(a) => out.push(a.asset_id.clone()),
        Node::Text(t) => {
            text_style_assets(&t.style, &mut out);
            for r in &t.runs {
                if let Some(f) = r.style.as_ref().and_then(|s| s.fills.as_ref()) {
                    fill_assets(f, &mut out);
                }
            }
        }
        Node::Table(t) => {
            text_style_assets(&t.default_style, &mut out);
            for c in &t.cells {
                if let Some(f) = &c.fill {
                    fill_assets(std::slice::from_ref(f), &mut out);
                }
            }
        }
        _ => {}
    }
    out.sort();
    out.dedup();
    out
}

/// Font families a node uses (text styles, runs, tables, charts).
pub fn font_families(n: &Node) -> Vec<String> {
    let mut out = Vec::new();
    match n {
        Node::Text(t) => {
            out.push(t.style.font_family.clone());
            for r in &t.runs {
                if let Some(f) = r.style.as_ref().and_then(|s| s.font_family.clone()) {
                    out.push(f);
                }
            }
        }
        Node::Table(t) => {
            out.push(t.default_style.font_family.clone());
            for c in &t.cells {
                if let Some(f) = c.style.as_ref().and_then(|s| s.font_family.clone()) {
                    out.push(f);
                }
            }
        }
        Node::Chart(c) => out.push(c.options.font_family.clone()),
        _ => {}
    }
    out.sort();
    out.dedup();
    out
}

fn color_refs_in(v: &serde_json::Value, styles: &mut Vec<Id>, vars: &mut Vec<String>) {
    match v {
        serde_json::Value::Object(m) => {
            if let Some(serde_json::Value::String(s)) = m.get("$style") {
                styles.push(s.clone());
            }
            if let Some(serde_json::Value::String(s)) = m.get("$var") {
                vars.push(s.clone());
            }
            for x in m.values() {
                color_refs_in(x, styles, vars);
            }
        }
        serde_json::Value::Array(a) => a.iter().for_each(|x| color_refs_in(x, styles, vars)),
        _ => {}
    }
}

/// MIME type of serialized clipboard payloads.
pub const CLIPBOARD_MIME: &str = "application/x-desyn+json";

/// Clipboard content: subtrees with their page placement and everything they reference.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipboardPayload {
    /// Always `"desyn/clipboard"`.
    pub kind: String,
    /// Payload version (1).
    pub version: u32,
    /// Source design id.
    pub source_design: Id,
    /// Copied subtrees, each in pre-order (original ids). Roots carry their page-space placement in x / y /
    /// rotation / flips, so they can be pasted into any container.
    pub subtrees: Vec<Vec<Node>>,
    /// Referenced assets.
    pub assets: BTreeMap<Id, AssetRef>,
    /// Referenced color styles.
    pub color_styles: BTreeMap<Id, ColorStyle>,
    /// Referenced text styles.
    pub text_styles: BTreeMap<Id, TextStyleDef>,
    /// Referenced variables.
    pub variables: BTreeMap<String, VarValue>,
    /// Union of the copied nodes' bounds in page coordinates.
    pub bounds: Rect,
}

/// Copies the top-level selection (pages are not copied).
pub fn copy(d: &Design, ids: &[Id]) -> Option<ClipboardPayload> {
    let sel: Vec<Id> = top_level_selection(d, ids)
        .into_iter()
        .filter(|id| d.node(id).is_some_and(|n| n.node_type() != NodeType::Page))
        .collect();
    if sel.is_empty() {
        return None;
    }
    let mut subtrees = Vec::new();
    let mut assets = BTreeMap::new();
    let mut style_ids = Vec::new();
    let mut var_names = Vec::new();
    let mut text_styles = BTreeMap::new();
    let mut boxes = Vec::new();
    for id in &sel {
        let mut nodes: Vec<Node> = d
            .subtree_ids(id)
            .iter()
            .filter_map(|i| d.node(i).cloned())
            .collect();
        let w = world_transform(d, id);
        let b = nodes[0].base().clone();
        let p = decompose_local(&w, b.width, b.height);
        {
            let hb = nodes[0].base_mut();
            hb.x = p.x;
            hb.y = p.y;
            hb.rotation = p.rotation;
            hb.flip_x = p.flip_x.then_some(true);
            hb.flip_y = None;
        }
        if let Some(r) = crate::geometry::node_aabb(d, id) {
            boxes.push(r);
        }
        for n in &nodes {
            for a in node_asset_refs(n) {
                if let Some(asset) = d.assets.get(&a) {
                    assets.insert(a.clone(), asset.clone());
                }
            }
            for fam in font_families(n) {
                for (aid, asset) in &d.assets {
                    if asset.kind == AssetKind::Font
                        && asset.family.as_deref() == Some(fam.as_str())
                    {
                        assets.insert(aid.clone(), asset.clone());
                    }
                }
            }
            if let Node::Text(t) = n
                && let Some(sr) = &t.style_ref
                && let Some(def) = d.styles.text.get(sr)
            {
                text_styles.insert(sr.clone(), def.clone());
            }
            color_refs_in(
                &serde_json::to_value(n).unwrap_or_default(),
                &mut style_ids,
                &mut var_names,
            );
        }
        subtrees.push(nodes);
    }
    let color_styles = style_ids
        .iter()
        .filter_map(|s| d.styles.colors.get(s).map(|c| (s.clone(), c.clone())))
        .collect();
    let variables = var_names
        .iter()
        .filter_map(|v| d.styles.variables.get(v).map(|x| (v.clone(), x.clone())))
        .collect();
    Some(ClipboardPayload {
        kind: "desyn/clipboard".into(),
        version: 1,
        source_design: d.id.clone(),
        subtrees,
        assets,
        color_styles,
        text_styles,
        variables,
        bounds: union_bounds(boxes.iter()).unwrap_or_default(),
    })
}

impl ClipboardPayload {
    /// JSON text for the system clipboard.
    pub fn to_json(&self) -> String {
        serde_json::to_string(self).expect("payload serializes")
    }

    /// Parses clipboard JSON; `None` when it is not a Desyn payload.
    pub fn from_json(s: &str) -> Option<ClipboardPayload> {
        let p: ClipboardPayload = serde_json::from_str(s).ok()?;
        (p.kind == "desyn/clipboard" && p.version == 1 && !p.subtrees.is_empty()).then_some(p)
    }
}

/// Where and how to paste.
#[derive(Debug, Clone, Default)]
pub struct PasteOptions {
    /// Translation added in page coordinates (e.g. +16,+16 when pasting in place repeatedly).
    pub offset: (f64, f64),
    /// Center the pasted content on this page point instead (e.g. the viewport center).
    pub center_at: Option<Point>,
    /// Insert index in the target parent (default: on top).
    pub index: Option<i64>,
}

/// Ops that paste `payload` into container `parent` of `d`: an `asset` op for missing assets, `styles` ops for
/// missing styles / variables, then one `create` per subtree with fresh ids, placed so the content keeps its page
/// placement (plus `offset`, or centered at `center_at`). Returns an empty list when `parent` cannot hold nodes.
pub fn paste_ops(
    d: &Design,
    payload: &ClipboardPayload,
    parent: &str,
    idgen: &mut dyn IdGen,
    o: &PasteOptions,
) -> Vec<Op> {
    let Some(pn) = d.node(parent) else {
        return Vec::new();
    };
    if !pn.is_container() || pn.node_type() == NodeType::Root {
        return Vec::new();
    }
    let mut ops = Vec::new();
    let missing: BTreeMap<Id, AssetRef> = payload
        .assets
        .iter()
        .filter(|(k, _)| !d.assets.contains_key(*k))
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();
    if !missing.is_empty() {
        ops.push(Op::Asset(AssetOp {
            set: Some(missing),
            remove: None,
        }));
    }
    for (k, v) in &payload.color_styles {
        if !d.styles.colors.contains_key(k) {
            ops.push(Op::Styles(StylesOp {
                path: vec!["colors".into(), PathSeg::Key(k.clone())],
                value: serde_json::to_value(v).unwrap_or_default(),
            }));
        }
    }
    for (k, v) in &payload.text_styles {
        if !d.styles.text.contains_key(k) {
            ops.push(Op::Styles(StylesOp {
                path: vec!["text".into(), PathSeg::Key(k.clone())],
                value: serde_json::to_value(v).unwrap_or_default(),
            }));
        }
    }
    for (k, v) in &payload.variables {
        if !d.styles.variables.contains_key(k) {
            ops.push(Op::Styles(StylesOp {
                path: vec!["variables".into(), PathSeg::Key(k.clone())],
                value: serde_json::to_value(v).unwrap_or_default(),
            }));
        }
    }
    let (dx, dy) = match o.center_at {
        Some(c) => (
            c.x - payload.bounds.center_x(),
            c.y - payload.bounds.center_y(),
        ),
        None => o.offset,
    };
    let parent_world = match pn.node_type() {
        NodeType::Page => Affine::IDENTITY,
        _ => world_transform(d, parent),
    };
    let to_parent = parent_world.inverse().unwrap_or(Affine::IDENTITY);
    let mut index = o.index.unwrap_or(pn.child_ids().len() as i64);
    for subtree in &payload.subtrees {
        let Some(head) = subtree.first() else {
            continue;
        };
        let mut map = BTreeMap::new();
        for n in subtree {
            map.insert(n.id().to_string(), idgen.next_id());
        }
        let mut nodes: Vec<Node> = subtree
            .iter()
            .enumerate()
            .map(|(i, n)| remap_node(n, i == 0, &map, idgen))
            .collect();
        let hb = head.base();
        let page_t = Affine::translate(dx, dy) * local_transform(hb);
        let p = decompose_local(&(to_parent * page_t), hb.width, hb.height);
        let b = nodes[0].base_mut();
        b.parent = Some(parent.to_string());
        b.x = p.x;
        b.y = p.y;
        b.rotation = p.rotation;
        b.flip_x = p.flip_x.then_some(true);
        b.flip_y = None;
        ops.push(Op::create(nodes, parent, Some(index)));
        index += 1;
    }
    ops
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ids::SequentialIds;
    use crate::{ApplyOptions, Transaction, apply_transaction};

    fn design() -> Design {
        let mut d = Design::with_page(
            "design000001",
            "D",
            DesignKind::Poster,
            "page00000001",
            500.0,
            500.0,
        );
        let mut g = Node::group("group0000001", "g", 100.0, 100.0, 50.0, 50.0);
        g.base_mut().rotation = 90.0;
        d.push_child("page00000001", g);
        let mut img = Node::image("image0000001", "i", "asset0000001", 0.0, 0.0, 50.0, 50.0);
        img.base_mut().link = Some("page:page00000001".into());
        d.push_child("group0000001", img);
        d.assets.insert(
            "asset0000001".into(),
            AssetRef::new("asset0000001", AssetKind::Image, "image/png"),
        );
        d
    }

    fn apply(d: &mut Design, ops: Vec<Op>) {
        let r = apply_transaction(
            d,
            &Transaction::new("tx0000000001", "t", ops),
            ApplyOptions::default(),
        );
        assert!(r.dropped.is_empty(), "{:?}", r.dropped);
    }

    #[test]
    fn clone_and_duplicate() {
        let d0 = design();
        let mut idgen = SequentialIds::new("c");
        let c = clone_subtree(
            &d0,
            "group0000001",
            &mut idgen,
            &CloneOptions {
                offset: Some((10.0, 0.0)),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(c.id_map.len(), 2);
        let Op::Create(op) = &c.op else { panic!() };
        assert_eq!(op.nodes[0].base().x, 110.0);
        assert_eq!(op.index, Some(1));
        assert_eq!(op.nodes[1].parent(), Some(op.nodes[0].id()));
        let mut d = d0.clone();
        let ops = duplicate(
            &mut d,
            &["image0000001".to_string()],
            (16.0, 16.0),
            &mut idgen,
        )
        .unwrap();
        assert_eq!(d.canonical_json(), d0.canonical_json());
        apply(&mut d, ops);
        assert_eq!(d.node("group0000001").unwrap().child_ids().len(), 2);
        assert!(validate_design(&d).is_empty(), "{:?}", validate_design(&d));
    }

    #[test]
    fn copy_paste_keeps_page_placement() {
        let d = design();
        let payload = copy(&d, &["image0000001".to_string()]).unwrap();
        assert_eq!(payload.assets.len(), 1);
        let json = payload.to_json();
        let back = ClipboardPayload::from_json(&json).unwrap();
        let mut target = Design::with_page(
            "design000002",
            "T",
            DesignKind::Poster,
            "page00000002",
            500.0,
            500.0,
        );
        let mut idgen = SequentialIds::new("p");
        let ops = paste_ops(
            &target,
            &back,
            "page00000002",
            &mut idgen,
            &PasteOptions::default(),
        );
        assert!(matches!(ops[0], Op::Asset(_)));
        apply(&mut target, ops);
        let pasted = target.node("page00000002").unwrap().child_ids()[0].clone();
        let a = crate::geometry::node_aabb(&d, "image0000001").unwrap();
        let b = crate::geometry::node_aabb(&target, &pasted).unwrap();
        assert!((a.x - b.x).abs() < 1e-9 && (a.y - b.y).abs() < 1e-9);
        assert!((target.node(&pasted).unwrap().base().rotation - 90.0).abs() < 1e-9);
        assert!(ClipboardPayload::from_json("{}").is_none());
    }
}
