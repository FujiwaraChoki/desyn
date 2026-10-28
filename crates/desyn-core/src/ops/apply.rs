//! Per-op application with inverse computation. Check order, drop reasons, `applied` normalization and inverse
//! shapes mirror the reference implementation `packages/doc-ops/src/apply.ts` (pinned by `spec/fixtures/ops`).

use rustc_hash::{FxHashMap, FxHashSet};
use serde_json::{Map, Value};

use super::value_path::set_path;
use super::{DirtySet, DropReason};
use crate::model::*;

pub(crate) struct Done {
    pub applied: Op,
    pub inverse: Op,
}

/// Keys `update` / `patch` may never touch.
pub const IMMUTABLE_KEYS: [&str; 4] = ["id", "type", "parent", "children"];
/// Base keys that define a node's transform / size.
const GEOMETRY_KEYS: [&str; 7] = ["x", "y", "width", "height", "rotation", "flipX", "flipY"];

type R = Result<Done, DropReason>;

pub(crate) fn apply_op(d: &mut Design, op: &Op, dirty: &mut DirtySet) -> R {
    match op {
        Op::Invalid { raw, .. } => Err(invalid_reason(d, raw)),
        Op::Create(o) => create(d, o, dirty),
        Op::Update(o) => update(d, o, dirty),
        Op::Patch(o) => patch(d, o, dirty),
        Op::Delete(o) => delete(d, o, dirty),
        Op::Move(o) => move_node(d, o, dirty),
        Op::Asset(o) => asset(d, o),
        Op::Styles(o) => styles(d, o),
        Op::Doc(o) => doc(d, o),
    }
}

fn clamp_index(index: Option<i64>, len: usize) -> usize {
    match index {
        None => len,
        Some(i) if i < 0 => 0,
        Some(i) => (i as usize).min(len),
    }
}

// Raw-op reasons ------------------------------------------------------------------------------------------------

fn is_integer(v: &Value) -> bool {
    v.as_f64()
        .is_some_and(|f| f.is_finite() && f.fract() == 0.0)
}

fn is_string_array(v: &Value) -> bool {
    v.as_array().is_some_and(|a| a.iter().all(Value::is_string))
}

/// Drop reason of an op that failed typed parsing, following the reference check order. Typed parsing only fails
/// where the reference either rejects the op shape (`invalid-op`) or rejects a value later (`invalid-node` for
/// created nodes, `invalid-value` for assets / doc fields), so the first failing reference check is the answer.
fn invalid_reason(d: &Design, raw: &Value) -> DropReason {
    let Some(op) = raw.as_object() else {
        return DropReason::InvalidOp;
    };
    match op.get("op").and_then(Value::as_str) {
        Some("create") => raw_create_reason(d, op),
        Some("asset") => raw_asset_reason(op),
        Some("doc") => raw_doc_reason(op),
        _ => DropReason::InvalidOp,
    }
}

fn raw_create_reason(d: &Design, op: &Map<String, Value>) -> DropReason {
    let Some(nodes) = op
        .get("nodes")
        .and_then(Value::as_array)
        .filter(|n| !n.is_empty())
    else {
        return DropReason::InvalidOp;
    };
    let Some(parent) = op.get("parent").and_then(Value::as_str) else {
        return DropReason::InvalidOp;
    };
    if op.get("index").is_some_and(|i| !is_integer(i)) {
        return DropReason::InvalidOp;
    }
    let Some(p) = d.node(parent) else {
        return DropReason::MissingParent;
    };
    if !p.is_container() {
        return DropReason::NotContainer;
    }
    let mut ids: FxHashSet<&str> = FxHashSet::default();
    let mut objs = Vec::with_capacity(nodes.len());
    for n in nodes {
        match n
            .as_object()
            .and_then(|o| o.get("id").and_then(Value::as_str).map(|id| (o, id)))
        {
            Some(x) => objs.push(x),
            None => return DropReason::InvalidNode,
        }
    }
    for (_, id) in &objs {
        if !ids.insert(id) || d.nodes.contains_key(*id) || *id == ROOT_ID {
            return DropReason::DuplicateId;
        }
    }
    let type_of =
        |o: &Map<String, Value>| o.get("type").and_then(Value::as_str).map(str::to_string);
    if objs
        .iter()
        .any(|(o, _)| type_of(o).as_deref() == Some("root"))
    {
        return DropReason::RootProtected;
    }
    if (parent == ROOT_ID) != (type_of(objs[0].0).as_deref() == Some("page")) {
        return DropReason::PageNesting;
    }
    if objs[1..]
        .iter()
        .any(|(o, _)| type_of(o).as_deref() == Some("page"))
    {
        return DropReason::PageNesting;
    }
    DropReason::InvalidNode
}

fn raw_asset_reason(op: &Map<String, Value>) -> DropReason {
    let set = op.get("set");
    let remove = op.get("remove");
    if set.is_some_and(|s| !s.is_object()) || remove.is_some_and(|r| !is_string_array(r)) {
        return DropReason::InvalidOp;
    }
    let removed: Vec<&str> = remove
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    if let Some(set) = set.and_then(Value::as_object) {
        for (k, v) in set {
            let id_ok = v
                .as_object()
                .and_then(|o| o.get("id"))
                .and_then(Value::as_str)
                == Some(k.as_str());
            if !id_ok || removed.contains(&k.as_str()) {
                return DropReason::InvalidOp;
            }
        }
    }
    DropReason::InvalidValue
}

const DOC_SET_KEYS: [&str; 4] = ["name", "kind", "brandKitId", "meta"];

fn raw_doc_reason(op: &Map<String, Value>) -> DropReason {
    let Some(set) = op.get("set").and_then(Value::as_object) else {
        return DropReason::InvalidOp;
    };
    if !set.keys().all(|k| DOC_SET_KEYS.contains(&k.as_str())) {
        return DropReason::InvalidOp;
    }
    let unset_brand = match op.get("unset") {
        None => false,
        Some(Value::Array(a)) if a.iter().all(|u| u.as_str() == Some("brandKitId")) => {
            !a.is_empty()
        }
        Some(_) => return DropReason::InvalidOp,
    };
    if unset_brand && set.contains_key("brandKitId") {
        return DropReason::InvalidOp;
    }
    DropReason::InvalidValue
}

// create ---------------------------------------------------------------------------------------------------------

fn create(d: &mut Design, o: &CreateOp, dirty: &mut DirtySet) -> R {
    let Some(first) = o.nodes.first() else {
        return Err(DropReason::InvalidOp);
    };
    let parent = d.node(&o.parent).ok_or(DropReason::MissingParent)?;
    if !parent.is_container() {
        return Err(DropReason::NotContainer);
    }
    let mut ids: FxHashSet<&str> = FxHashSet::default();
    for n in &o.nodes {
        if !ids.insert(n.id()) || d.nodes.contains_key(n.id()) || n.id() == ROOT_ID {
            return Err(DropReason::DuplicateId);
        }
    }
    if o.nodes.iter().any(|n| n.node_type() == NodeType::Root) {
        return Err(DropReason::RootProtected);
    }
    if (o.parent == ROOT_ID) != (first.node_type() == NodeType::Page) {
        return Err(DropReason::PageNesting);
    }
    if o.nodes[1..].iter().any(|n| n.node_type() == NodeType::Page) {
        return Err(DropReason::PageNesting);
    }
    // Structure: descendants form a tree under nodes[0] whose parent / children agree exactly.
    let head = first.id();
    let by_id: FxHashMap<&str, &Node> = o.nodes.iter().map(|n| (n.id(), n)).collect();
    let mut listed_in: FxHashMap<&str, &str> = FxHashMap::default();
    for n in &o.nodes {
        if !n.is_container() && n.extra().contains_key("children") {
            return Err(DropReason::InvalidNode);
        }
        for c in n.child_ids() {
            if !by_id.contains_key(c.as_str()) || c == head || listed_in.contains_key(c.as_str()) {
                return Err(DropReason::InvalidNode);
            }
            listed_in.insert(c, n.id());
        }
    }
    for n in &o.nodes[1..] {
        match n.parent() {
            Some(p) if listed_in.get(n.id()) == Some(&p) => {}
            _ => return Err(DropReason::InvalidNode),
        }
    }
    let mut seen: FxHashSet<&str> = FxHashSet::default();
    seen.insert(head);
    let mut stack = vec![head];
    while let Some(id) = stack.pop() {
        for c in by_id[id].child_ids() {
            if seen.insert(c) {
                stack.push(c);
            }
        }
    }
    if seen.len() != o.nodes.len() {
        return Err(DropReason::InvalidNode);
    }
    let mut nodes = o.nodes.clone();
    nodes[0].base_mut().parent = Some(o.parent.clone());
    for n in &nodes {
        validate_node(n).map_err(|_| DropReason::InvalidNode)?;
    }
    let head = head.to_string();
    let children = d
        .node_mut(&o.parent)
        .and_then(Node::children_mut)
        .expect("checked container");
    let at = clamp_index(o.index, children.len());
    children.insert(at, head.clone());
    dirty.containers.insert(o.parent.clone());
    for n in &nodes {
        dirty.nodes.insert(n.id().to_string());
        d.nodes.insert(n.id().to_string(), n.clone());
    }
    Ok(Done {
        applied: Op::Create(CreateOp {
            nodes,
            parent: o.parent.clone(),
            index: Some(at as i64),
        }),
        inverse: Op::delete(head),
    })
}

// update / patch -------------------------------------------------------------------------------------------------

fn node_value(n: &Node) -> Map<String, Value> {
    match serde_json::to_value(n) {
        Ok(Value::Object(m)) => m,
        _ => unreachable!("nodes serialize to JSON objects"),
    }
}

/// Re-types a mutated node object and validates it.
fn retype(m: Map<String, Value>) -> Result<Node, DropReason> {
    let node: Node =
        serde_json::from_value(Value::Object(m)).map_err(|_| DropReason::InvalidNode)?;
    validate_node(&node).map_err(|_| DropReason::InvalidNode)?;
    Ok(node)
}

fn mark_node_change(dirty: &mut DirtySet, before: &Node, after: &Node, touched: &[&str]) {
    let id = after.id().to_string();
    if touched.iter().any(|k| GEOMETRY_KEYS.contains(k)) {
        dirty.explicit_geometry.insert(id.clone());
    }
    let (b, a) = (before.base(), after.base());
    if b.width != a.width || b.height != a.height {
        dirty
            .resized
            .entry(id.clone())
            .or_insert((b.width, b.height));
    }
    dirty.nodes.insert(id);
}

fn update(d: &mut Design, o: &UpdateOp, dirty: &mut DirtySet) -> R {
    let set_keys: Vec<&str> = o
        .set
        .iter()
        .flat_map(|m| m.keys().map(String::as_str))
        .collect();
    let mut unset_keys: Vec<&str> = Vec::new();
    for k in o.unset.iter().flatten() {
        if !unset_keys.contains(&k.as_str()) {
            unset_keys.push(k);
        }
    }
    if unset_keys.iter().any(|k| set_keys.contains(k)) {
        return Err(DropReason::InvalidOp);
    }
    let node = d.node(&o.id).ok_or(DropReason::MissingNode)?;
    if set_keys
        .iter()
        .chain(unset_keys.iter())
        .any(|k| IMMUTABLE_KEYS.contains(k))
    {
        return Err(DropReason::ImmutableField);
    }
    let before = node_value(node);
    let mut next = before.clone();
    if let Some(set) = &o.set {
        for (k, v) in set {
            next.insert(k.clone(), v.clone());
        }
    }
    for k in &unset_keys {
        next.remove(*k);
    }
    let new_node = retype(next)?;
    let mut inv_set = Map::new();
    let mut inv_unset = Vec::new();
    for k in set_keys.iter().chain(unset_keys.iter()) {
        match before.get(*k) {
            Some(v) => {
                inv_set.insert(k.to_string(), v.clone());
            }
            None if set_keys.contains(k) => inv_unset.push(k.to_string()),
            None => {}
        }
    }
    // Arrays derived from object keys never depend on key order: sort by code point (as the reference does).
    inv_unset.sort();
    let touched: Vec<&str> = set_keys.iter().chain(unset_keys.iter()).copied().collect();
    let old_node = std::mem::replace(d.node_mut(&o.id).expect("exists"), new_node);
    mark_node_change(dirty, &old_node, d.node(&o.id).expect("exists"), &touched);
    let applied = UpdateOp {
        id: o.id.clone(),
        set: (!set_keys.is_empty()).then(|| o.set.clone().unwrap_or_default()),
        unset: (!unset_keys.is_empty()).then(|| unset_keys.iter().map(|k| k.to_string()).collect()),
    };
    let inverse = UpdateOp {
        id: o.id.clone(),
        set: (!inv_set.is_empty()).then_some(inv_set),
        unset: (!inv_unset.is_empty()).then_some(inv_unset),
    };
    Ok(Done {
        applied: Op::Update(applied),
        inverse: Op::Update(inverse),
    })
}

fn patch(d: &mut Design, o: &PatchOp, dirty: &mut DirtySet) -> R {
    let node = d.node(&o.id).ok_or(DropReason::MissingNode)?;
    if o.path.is_empty() {
        return Err(DropReason::InvalidPath);
    }
    if let PathSeg::Key(k) = &o.path[0]
        && IMMUTABLE_KEYS.contains(&k.as_str())
    {
        return Err(DropReason::ImmutableField);
    }
    let mut v = Value::Object(node_value(node));
    let res = set_path(&mut v, &o.path, o.value.clone()).ok_or(DropReason::InvalidPath)?;
    let Value::Object(m) = v else {
        return Err(DropReason::InvalidNode);
    };
    let new_node = retype(m)?;
    let top = match &o.path[0] {
        PathSeg::Key(k) => k.clone(),
        PathSeg::Index(i) => i.to_string(),
    };
    let inverse = match (res.old_leaf, res.old_parent) {
        (Some(old), _) => Op::patch(o.id.clone(), o.path.clone(), old),
        (None, _) if o.path.len() == 1 => Op::Update(UpdateOp {
            id: o.id.clone(),
            set: None,
            unset: Some(vec![top.clone()]),
        }),
        (None, parent) => Op::patch(
            o.id.clone(),
            o.path[..o.path.len() - 1].to_vec(),
            parent.unwrap_or(Value::Null),
        ),
    };
    let old_node = std::mem::replace(d.node_mut(&o.id).expect("exists"), new_node);
    mark_node_change(
        dirty,
        &old_node,
        d.node(&o.id).expect("exists"),
        &[top.as_str()],
    );
    Ok(Done {
        applied: Op::Patch(o.clone()),
        inverse,
    })
}

// delete / move --------------------------------------------------------------------------------------------------

fn delete(d: &mut Design, o: &DeleteOp, dirty: &mut DirtySet) -> R {
    if o.id == ROOT_ID {
        return Err(DropReason::RootProtected);
    }
    let node = d.node(&o.id).ok_or(DropReason::MissingNode)?;
    let parent = node
        .parent()
        .map(str::to_string)
        .ok_or(DropReason::InvalidNode)?;
    let index = d.index_in_parent(&o.id).unwrap_or(0);
    let ids = d.subtree_ids(&o.id);
    let mut removed = Vec::with_capacity(ids.len());
    for id in &ids {
        if let Some(n) = d.nodes.swap_remove(id.as_str()) {
            removed.push(n);
        }
        dirty.nodes.remove(id.as_str());
        dirty.containers.remove(id.as_str());
        dirty.explicit_geometry.remove(id.as_str());
        dirty.resized.remove(id.as_str());
    }
    if let Some(ch) = d.node_mut(&parent).and_then(Node::children_mut) {
        ch.retain(|c| c != &o.id);
    }
    dirty.containers.insert(parent.clone());
    Ok(Done {
        applied: Op::Delete(o.clone()),
        inverse: Op::create(removed, parent, Some(index as i64)),
    })
}

fn move_node(d: &mut Design, o: &MoveOp, dirty: &mut DirtySet) -> R {
    let node = d.node(&o.id).ok_or(DropReason::MissingNode)?;
    if o.id == ROOT_ID {
        return Err(DropReason::RootProtected);
    }
    let is_page = node.node_type() == NodeType::Page;
    let target = d.node(&o.parent).ok_or(DropReason::MissingParent)?;
    if !target.is_container() {
        return Err(DropReason::NotContainer);
    }
    if d.is_ancestor_or_self(&o.id, &o.parent) {
        return Err(DropReason::Cycle);
    }
    if (o.parent == ROOT_ID) != is_page {
        return Err(DropReason::PageNesting);
    }
    let old_parent = node
        .parent()
        .map(str::to_string)
        .ok_or(DropReason::InvalidNode)?;
    let old_index = d.index_in_parent(&o.id).ok_or(DropReason::InvalidNode)?;
    if let Some(ch) = d.node_mut(&old_parent).and_then(Node::children_mut) {
        ch.remove(old_index);
    }
    let ch = d
        .node_mut(&o.parent)
        .and_then(Node::children_mut)
        .expect("checked container");
    let at = clamp_index(o.index, ch.len());
    ch.insert(at, o.id.clone());
    d.node_mut(&o.id).expect("exists").base_mut().parent = Some(o.parent.clone());
    dirty.nodes.insert(o.id.clone());
    dirty.containers.insert(old_parent.clone());
    dirty.containers.insert(o.parent.clone());
    Ok(Done {
        applied: Op::move_to(o.id.clone(), o.parent.clone(), Some(at as i64)),
        inverse: Op::move_to(o.id.clone(), old_parent, Some(old_index as i64)),
    })
}

// asset / styles / doc -------------------------------------------------------------------------------------------

fn asset(d: &mut Design, o: &AssetOp) -> R {
    let mut remove_ids: Vec<&str> = Vec::new();
    for r in o.remove.iter().flatten() {
        if !remove_ids.contains(&r.as_str()) {
            remove_ids.push(r);
        }
    }
    if let Some(set) = &o.set {
        for (k, a) in set {
            if k != &a.id || remove_ids.contains(&k.as_str()) {
                return Err(DropReason::InvalidOp);
            }
        }
        for a in set.values() {
            check_asset_schema(a).map_err(|_| DropReason::InvalidValue)?;
        }
    }
    let existing: Vec<String> = remove_ids
        .iter()
        .filter(|r| d.assets.contains_key(**r))
        .map(|r| r.to_string())
        .collect();
    let mut inv_set = std::collections::BTreeMap::new();
    let mut inv_remove = Vec::new();
    if let Some(set) = &o.set {
        for (k, a) in set {
            match d.assets.insert(k.clone(), a.clone()) {
                Some(old) => {
                    inv_set.insert(k.clone(), old);
                }
                None => inv_remove.push(k.clone()),
            }
        }
    }
    for r in &existing {
        if let Some(old) = d.assets.remove(r) {
            inv_set.insert(r.clone(), old);
        }
    }
    inv_remove.sort();
    let has_set = o.set.as_ref().is_some_and(|s| !s.is_empty());
    let applied = AssetOp {
        set: if has_set { o.set.clone() } else { None },
        remove: (!existing.is_empty()).then_some(existing),
    };
    let inverse = AssetOp {
        set: (!inv_set.is_empty()).then_some(inv_set),
        remove: (!inv_remove.is_empty()).then_some(inv_remove),
    };
    Ok(Done {
        applied: Op::Asset(applied),
        inverse: Op::Asset(inverse),
    })
}

fn styles(d: &mut Design, o: &StylesOp) -> R {
    let mut v = serde_json::to_value(&d.styles).expect("styles serialize");
    let res = set_path(&mut v, &o.path, o.value.clone()).ok_or(DropReason::InvalidPath)?;
    let new_styles: DesignStyles =
        serde_json::from_value(v).map_err(|_| DropReason::InvalidValue)?;
    check_styles_schema(&new_styles).map_err(|_| DropReason::InvalidValue)?;
    let inverse = match (res.old_leaf, res.old_parent) {
        (Some(old), _) => StylesOp {
            path: o.path.clone(),
            value: old,
        },
        (None, parent) => StylesOp {
            path: o.path[..o.path.len().saturating_sub(1)].to_vec(),
            value: parent.unwrap_or(Value::Null),
        },
    };
    d.styles = new_styles;
    Ok(Done {
        applied: Op::Styles(o.clone()),
        inverse: Op::Styles(inverse),
    })
}

fn doc(d: &mut Design, o: &DocOp) -> R {
    let unset_brand = o.unset.as_ref().is_some_and(|u| !u.is_empty());
    if unset_brand && o.set.brand_kit_id.is_some() {
        return Err(DropReason::InvalidOp);
    }
    let mut inv = DocSet::default();
    let mut inv_unset_brand = false;
    if let Some(n) = &o.set.name {
        inv.name = Some(std::mem::replace(&mut d.name, n.clone()));
    }
    if let Some(k) = o.set.kind {
        inv.kind = Some(std::mem::replace(&mut d.kind, k));
    }
    if let Some(b) = &o.set.brand_kit_id {
        match d.brand_kit_id.replace(b.clone()) {
            Some(old) => inv.brand_kit_id = Some(old),
            None => inv_unset_brand = true,
        }
    }
    if let Some(m) = &o.set.meta {
        inv.meta = Some(std::mem::replace(&mut d.meta, m.clone()));
    }
    if unset_brand && let Some(old) = d.brand_kit_id.take() {
        inv.brand_kit_id = Some(old);
    }
    let applied = DocOp {
        set: o.set.clone(),
        unset: unset_brand.then(|| vec![DocField::BrandKitId]),
    };
    let inverse = DocOp {
        set: inv,
        unset: inv_unset_brand.then(|| vec![DocField::BrandKitId]),
    };
    Ok(Done {
        applied: Op::Doc(applied),
        inverse: Op::Doc(inverse),
    })
}
