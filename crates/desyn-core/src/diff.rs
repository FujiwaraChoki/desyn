//! Design diff: the ops that turn design `a` into design `b` (`apply(a, diff(a, b))` is canonically equal to `b` for
//! valid designs). Same algorithm and output as `diffOps` in `packages/doc-ops/src/diff.ts`: one op per changed
//! node / asset map / style entry, minimal moves (longest increasing subsequence) for reorders, retyped nodes
//! rebuilt.

use std::collections::BTreeMap;

use rustc_hash::{FxHashMap, FxHashSet};
use serde_json::{Map, Value};

use crate::arrange::reorder_moves;
use crate::model::*;

const STRUCTURAL: [&str; 4] = ["id", "type", "parent", "children"];

/// Exact JSON equality, as `deepEqual` in `@desyn/doc-ops`: numbers compare as doubles (so `1` equals `1.0`, but
/// values that merely canonicalize alike differ), objects ignore key order.
fn json_eq(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => x.as_f64() == y.as_f64(),
        (Value::Array(x), Value::Array(y)) => {
            x.len() == y.len() && x.iter().zip(y).all(|(p, q)| json_eq(p, q))
        }
        (Value::Object(x), Value::Object(y)) => {
            x.len() == y.len()
                && x.iter()
                    .all(|(k, v)| y.get(k).is_some_and(|w| json_eq(v, w)))
        }
        _ => a == b,
    }
}

fn preorder(d: &Design, root: &str) -> Vec<Id> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_string()];
    while let Some(id) = stack.pop() {
        let Some(n) = d.node(&id) else { continue };
        for c in n.child_ids().iter().rev() {
            stack.push(c.clone());
        }
        out.push(id);
    }
    out
}

/// Structure-only simulation of the target being built.
struct Sim {
    parent: FxHashMap<Id, Option<Id>>,
    kids: FxHashMap<Id, Vec<Id>>,
}

impl Sim {
    fn new(d: &Design) -> Self {
        let mut s = Sim {
            parent: FxHashMap::default(),
            kids: FxHashMap::default(),
        };
        for (id, n) in &d.nodes {
            s.parent.insert(id.clone(), n.parent().map(str::to_string));
            if let Some(c) = n.children() {
                s.kids.insert(id.clone(), c.clone());
            }
        }
        s
    }

    fn children(&self, id: &str) -> Vec<Id> {
        self.kids.get(id).cloned().unwrap_or_default()
    }

    fn children_mut(&mut self, id: &str) -> &mut Vec<Id> {
        self.kids.entry(id.to_string()).or_default()
    }

    fn insert(&mut self, nodes: &[Node], parent: &str, index: usize) {
        for n in nodes {
            self.parent
                .insert(n.id().to_string(), n.parent().map(str::to_string));
            if let Some(c) = n.children() {
                self.kids.insert(n.id().to_string(), c.clone());
            }
        }
        let head = nodes[0].id().to_string();
        self.parent.insert(head.clone(), Some(parent.to_string()));
        let list = self.children_mut(parent);
        let at = index.min(list.len());
        list.insert(at, head);
    }

    fn mv(&mut self, id: &str, parent: &str, index: usize) {
        if let Some(Some(old)) = self.parent.get(id).cloned() {
            let from = self.children_mut(&old);
            if let Some(p) = from.iter().position(|x| x == id) {
                from.remove(p);
            }
        }
        let list = self.children_mut(parent);
        let at = index.min(list.len());
        list.insert(at, id.to_string());
        self.parent.insert(id.to_string(), Some(parent.to_string()));
    }

    fn remove(&mut self, id: &str) {
        if let Some(Some(p)) = self.parent.get(id).cloned() {
            let list = self.children_mut(&p);
            if let Some(i) = list.iter().position(|x| x == id) {
                list.remove(i);
            }
        }
        let mut stack = vec![id.to_string()];
        while let Some(cur) = stack.pop() {
            stack.extend(self.children(&cur));
            self.parent.remove(&cur);
            self.kids.remove(&cur);
        }
    }
}

fn insertion_index(sim: &Sim, parent: &str, target_siblings: &[Id], id: &str) -> usize {
    let current: Vec<Id> = sim
        .children(parent)
        .into_iter()
        .filter(|c| c != id)
        .collect();
    let pos = target_siblings.iter().position(|x| x == id).unwrap_or(0);
    for i in (0..pos).rev() {
        if let Some(at) = current.iter().position(|c| c == &target_siblings[i]) {
            return at + 1;
        }
    }
    0
}

fn doc_op(a: &Design, b: &Design) -> Option<Op> {
    let mut set = DocSet::default();
    if a.name != b.name {
        set.name = Some(b.name.clone());
    }
    if a.kind != b.kind {
        set.kind = Some(b.kind);
    }
    if b.brand_kit_id.is_some() && a.brand_kit_id != b.brand_kit_id {
        set.brand_kit_id = b.brand_kit_id.clone();
    }
    if !json_eq(
        &Value::Object(a.meta.clone()),
        &Value::Object(b.meta.clone()),
    ) {
        set.meta = Some(b.meta.clone());
    }
    let unset = a.brand_kit_id.is_some() && b.brand_kit_id.is_none();
    if set == DocSet::default() && !unset {
        return None;
    }
    Some(Op::Doc(DocOp {
        set,
        unset: unset.then(|| vec![DocField::BrandKitId]),
    }))
}

fn to_value<T: serde::Serialize>(v: &T) -> Value {
    serde_json::to_value(v).expect("model types serialize")
}

fn asset_op(a: &Design, b: &Design) -> Option<Op> {
    let mut set = BTreeMap::new();
    let mut remove = Vec::new();
    for (id, asset) in &b.assets {
        match a.assets.get(id) {
            Some(old) if json_eq(&to_value(old), &to_value(asset)) => {}
            _ => {
                set.insert(id.clone(), asset.clone());
            }
        }
    }
    for id in a.assets.keys() {
        if !b.assets.contains_key(id) {
            remove.push(id.clone());
        }
    }
    if set.is_empty() && remove.is_empty() {
        return None;
    }
    Some(Op::Asset(AssetOp {
        set: (!set.is_empty()).then_some(set),
        remove: (!remove.is_empty()).then_some(remove),
    }))
}

fn style_ops(a: &Design, b: &Design) -> Vec<Op> {
    let av = to_value(&a.styles);
    let bv = to_value(&b.styles);
    if json_eq(&av, &bv) {
        return Vec::new();
    }
    let (Value::Object(am), Value::Object(bm)) = (&av, &bv) else {
        return Vec::new();
    };
    if am.keys().any(|k| !bm.contains_key(k)) {
        return vec![Op::Styles(StylesOp {
            path: Vec::new(),
            value: bv.clone(),
        })];
    }
    let mut ops = Vec::new();
    for (key, bval) in bm {
        let aval = am.get(key);
        if aval.is_some_and(|x| json_eq(x, bval)) {
            continue;
        }
        let path = vec![PathSeg::Key(key.clone())];
        match (aval, bval) {
            (Some(Value::Object(ao)), Value::Object(bo)) => {
                if ao.keys().any(|k| !bo.contains_key(k)) {
                    ops.push(Op::Styles(StylesOp {
                        path,
                        value: bval.clone(),
                    }));
                    continue;
                }
                for (entry, value) in bo {
                    if !ao.get(entry).is_some_and(|x| json_eq(x, value)) {
                        ops.push(Op::Styles(StylesOp {
                            path: vec![PathSeg::Key(key.clone()), PathSeg::Key(entry.clone())],
                            value: value.clone(),
                        }));
                    }
                }
            }
            _ => ops.push(Op::Styles(StylesOp {
                path,
                value: bval.clone(),
            })),
        }
    }
    ops
}

fn node_update(before: &Node, after: &Node) -> Option<Op> {
    let (Value::Object(a), Value::Object(b)) = (to_value(before), to_value(after)) else {
        return None;
    };
    let mut set = Map::new();
    let mut unset = Vec::new();
    for (k, v) in &b {
        if STRUCTURAL.contains(&k.as_str()) {
            continue;
        }
        if !a.get(k).is_some_and(|x| json_eq(x, v)) {
            set.insert(k.clone(), v.clone());
        }
    }
    for k in a.keys() {
        if STRUCTURAL.contains(&k.as_str()) {
            continue;
        }
        if !b.contains_key(k) {
            unset.push(k.clone());
        }
    }
    if set.is_empty() && unset.is_empty() {
        return None;
    }
    Some(Op::Update(UpdateOp {
        id: after.id().to_string(),
        set: (!set.is_empty()).then_some(set),
        unset: (!unset.is_empty()).then_some(unset),
    }))
}

/// Ops turning `a` into `b`: doc fields, assets, styles, then structure (creates of new regions and moves top-down,
/// deletes, rebuilt retyped subtrees, child reorders) and finally property updates of surviving nodes.
pub fn diff_ops(a: &Design, b: &Design) -> Vec<Op> {
    let mut ops = Vec::new();
    ops.extend(doc_op(a, b));
    ops.extend(asset_op(a, b));
    ops.extend(style_ops(a, b));

    let in_a = |id: &str| a.nodes.contains_key(id);
    let in_b = |id: &str| b.nodes.contains_key(id);
    let mut rebuilt: FxHashSet<Id> = FxHashSet::default();
    for (id, bn) in &b.nodes {
        if let Some(an) = a.node(id)
            && an.node_type() != bn.node_type()
        {
            rebuilt.extend(preorder(b, id));
        }
    }
    let dead: FxHashSet<Id> = a
        .nodes
        .keys()
        .filter(|id| !in_b(id) || rebuilt.contains(*id))
        .cloned()
        .collect();
    let pure_new = |id: &str| !in_a(id) && !rebuilt.contains(id);

    let mut sim = Sim::new(a);
    let mut placed: FxHashSet<Id> = FxHashSet::default();
    let b_order = preorder(b, ROOT_ID);

    // Phase 1: top-down over the target, creating new regions and moving surviving nodes to their target parents.
    // Depth-first in target pre-order with an explicit stack (designs may nest deeper than the call stack allows):
    // each frame is a target parent, its target children and the next child to visit.
    let kids_of = |id: &str| -> Vec<Id> {
        b.node(id)
            .map(|n| n.child_ids().to_vec())
            .unwrap_or_default()
    };
    let mut stack: Vec<(Id, Vec<Id>, usize)> = vec![(ROOT_ID.to_string(), kids_of(ROOT_ID), 0)];
    while let Some(frame) = stack.last_mut() {
        let Some(id) = frame.1.get(frame.2).cloned() else {
            stack.pop();
            continue;
        };
        frame.2 += 1;
        if rebuilt.contains(&id) {
            continue;
        }
        let parent_id = frame.0.clone();
        let target_kids = &frame.1;
        if !placed.contains(&id) {
            if pure_new(&id) {
                // The new region: `id` and every descendant reachable through new nodes only (pre-order visits
                // parents first, so membership of the parent decides).
                let mut members: FxHashSet<Id> = FxHashSet::default();
                let mut region: Vec<Id> = Vec::new();
                for sub in preorder(b, &id) {
                    let joins = pure_new(&sub)
                        && (sub == id
                            || b.node(&sub)
                                .and_then(Node::parent)
                                .is_some_and(|p| members.contains(p)));
                    if joins {
                        members.insert(sub.clone());
                        region.push(sub);
                    }
                }
                let nodes: Vec<Node> = region
                    .iter()
                    .filter_map(|sub| b.node(sub))
                    .map(|n| {
                        let mut n = n.clone();
                        if let Some(ch) = n.children_mut() {
                            ch.retain(|c| members.contains(c));
                        }
                        n
                    })
                    .collect();
                let index = insertion_index(&sim, &parent_id, target_kids, &id);
                sim.insert(&nodes, &parent_id, index);
                ops.push(Op::create(nodes, parent_id.clone(), Some(index as i64)));
                placed.extend(region);
            } else if sim.parent.get(id.as_str()).cloned().flatten().as_deref()
                != Some(parent_id.as_str())
            {
                let index = insertion_index(&sim, &parent_id, target_kids, &id);
                ops.push(Op::move_to(
                    id.clone(),
                    parent_id.clone(),
                    Some(index as i64),
                ));
                sim.mv(&id, &parent_id, index);
            }
            placed.insert(id.clone());
        }
        let kids = kids_of(&id);
        stack.push((id, kids, 0));
    }

    // Phase 2: delete removed / retyped nodes.
    for id in preorder(a, ROOT_ID) {
        if !dead.contains(&id) || !sim.parent.contains_key(&id) {
            continue;
        }
        let parent = sim.parent.get(&id).cloned().flatten();
        if let Some(p) = parent
            && !dead.contains(&p)
        {
            ops.push(Op::delete(id.clone()));
            sim.remove(&id);
        }
    }

    // Phase 3: rebuild retyped subtrees.
    for id in &b_order {
        if !rebuilt.contains(id) {
            continue;
        }
        let Some(parent_id) = b.node(id).and_then(Node::parent).map(str::to_string) else {
            continue;
        };
        if rebuilt.contains(&parent_id) {
            continue;
        }
        let nodes: Vec<Node> = preorder(b, id)
            .iter()
            .filter_map(|s| b.node(s).cloned())
            .collect();
        let target: Vec<Id> = b
            .node(&parent_id)
            .map(|n| n.child_ids().to_vec())
            .unwrap_or_default();
        let index = insertion_index(&sim, &parent_id, &target, id);
        sim.insert(&nodes, &parent_id, index);
        ops.push(Op::create(nodes, parent_id, Some(index as i64)));
    }

    // Phase 4: child order.
    for id in &b_order {
        let Some(bn) = b.node(id) else { continue };
        let Some(target) = bn.children() else {
            continue;
        };
        let current = sim.children(id);
        if &current != target
            && let Some(moves) = reorder_moves(id, &current, target)
        {
            for m in moves {
                if let Op::Move(mv) = &m {
                    sim.mv(&mv.id, id, mv.index.unwrap_or(0) as usize);
                }
                ops.push(m);
            }
        }
    }

    // Phase 5: properties of surviving nodes.
    for id in &b_order {
        if !in_a(id) || rebuilt.contains(id) {
            continue;
        }
        if let (Some(an), Some(bn)) = (a.node(id), b.node(id))
            && let Some(u) = node_update(an, bn)
        {
            ops.push(u);
        }
    }
    ops
}

/// A transaction turning `a` into `b` (label "Sync changes", source `system`). `ops` is empty when they are equal.
pub fn diff_designs(a: &Design, b: &Design, id: impl Into<Id>) -> Transaction {
    Transaction {
        id: id.into(),
        label: "Sync changes".into(),
        ops: diff_ops(a, b),
        source: TxSource::System,
        actor: None,
        ts: 0.0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{ApplyOptions, apply_transaction};

    fn base() -> Design {
        let mut d = Design::with_page(
            "design000001",
            "D",
            DesignKind::Poster,
            "page00000001",
            500.0,
            500.0,
        );
        d.push_child(
            "page00000001",
            Node::rect("rect00000001", "a", 0.0, 0.0, 10.0, 10.0),
        );
        d.push_child(
            "page00000001",
            Node::group("group0000001", "g", 0.0, 0.0, 10.0, 10.0),
        );
        d.push_child(
            "group0000001",
            Node::rect("rect00000002", "b", 0.0, 0.0, 10.0, 10.0),
        );
        d.push_child(
            "page00000001",
            Node::ellipse("ellip0000001", "e", 0.0, 0.0, 10.0, 10.0),
        );
        d
    }

    fn check(a: &Design, b: &Design) -> usize {
        let tx = diff_designs(a, b, "tx0000000001");
        let mut x = a.clone();
        let r = apply_transaction(&mut x, &tx, ApplyOptions::default());
        assert!(
            r.dropped.is_empty(),
            "{:?}\n{}",
            r.dropped,
            serde_json::to_string_pretty(&tx).unwrap()
        );
        assert_eq!(x.canonical_json(), b.canonical_json());
        tx.ops.len()
    }

    #[test]
    fn identical_is_empty() {
        assert_eq!(check(&base(), &base()), 0);
    }

    #[test]
    fn structural_changes() {
        let a = base();
        let mut b = base();
        // Reorder, reparent, retype, add subtree, delete, update, doc/asset/styles.
        b.nodes
            .get_mut("page00000001")
            .unwrap()
            .children_mut()
            .unwrap()
            .reverse();
        let r2 = b
            .nodes
            .get_mut("group0000001")
            .unwrap()
            .children_mut()
            .unwrap()
            .pop()
            .unwrap();
        b.nodes
            .get_mut("page00000001")
            .unwrap()
            .children_mut()
            .unwrap()
            .push(r2.clone());
        b.nodes.get_mut(&r2).unwrap().base_mut().parent = Some("page00000001".into());
        b.nodes.get_mut("rect00000001").unwrap().base_mut().x = 42.0;
        b.nodes.get_mut("rect00000001").unwrap().base_mut().role = Some("cta".into());
        let mut e = Node::rect("ellip0000001", "now a rect", 1.0, 1.0, 5.0, 5.0);
        e.base_mut().parent = Some("page00000001".into());
        b.nodes.insert("ellip0000001".into(), e);
        let mut f =
            Node::frame("frame0000001", "f", 0.0, 0.0, 50.0, 50.0).with_parent("page00000001");
        f.children_mut().unwrap().push("rect00000009".into());
        b.nodes.insert("frame0000001".into(), f);
        b.nodes.insert(
            "rect00000009".into(),
            Node::rect("rect00000009", "n", 0.0, 0.0, 5.0, 5.0).with_parent("frame0000001"),
        );
        b.nodes
            .get_mut("page00000001")
            .unwrap()
            .children_mut()
            .unwrap()
            .insert(1, "frame0000001".into());
        b.name = "Renamed".into();
        b.brand_kit_id = Some("kit".into());
        b.assets.insert(
            "asset0000001".into(),
            AssetRef::new("asset0000001", AssetKind::Image, "image/png"),
        );
        b.styles.variables.insert("x".into(), VarValue::Number(1.0));
        check(&a, &b);
        // And back.
        check(&b, &a);
    }

    /// Values compare exactly (numbers as doubles, like `deepEqual` in `@desyn/doc-ops`): a change below the
    /// canonical precision is still a change, and `1` equals `1.0`.
    #[test]
    fn exact_value_equality_like_typescript() {
        let a = base();
        let mut b = a.clone();
        b.node_mut("page00000001").unwrap().base_mut().x = 0.0000001;
        let ops = diff_ops(&a, &b);
        assert_eq!(
            serde_json::to_value(&ops).unwrap(),
            serde_json::json!([{"op": "update", "id": "page00000001", "set": {"x": 0.0000001}}])
        );
        let mut c = a.clone();
        c.meta.insert("n".into(), serde_json::json!(1));
        let mut e = a.clone();
        e.meta.insert("n".into(), serde_json::json!(1.0));
        assert!(diff_ops(&c, &e).is_empty());
    }
}
