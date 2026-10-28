//! Arrangement helpers producing ops: align, distribute, tidy into a grid, match size and z-order. Same rules and
//! output as the builders in `packages/doc-ops/src/arrange.ts`.
//!
//! Every function takes `&mut Design` because it applies ops incrementally (later ops see earlier ones); the design
//! is restored before returning. Wrap the returned ops in a [`crate::Transaction`] and apply it as usual.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::builder::{BuildError, TxBuilder, round_geom};
use crate::geometry::{Rect, node_aabb, union_bounds};
use crate::model::{Design, Id, MoveOp, Node, NodeType, Op, ROOT_ID};

/// Alignment target edge / center.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Alignment {
    /// Left edges.
    Left,
    /// Horizontal centers.
    Center,
    /// Right edges.
    Right,
    /// Top edges.
    Top,
    /// Vertical centers.
    Middle,
    /// Bottom edges.
    Bottom,
}

/// What to align to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AlignTo {
    /// The selection's bounds (a single node always aligns to its page).
    #[default]
    Selection,
    /// The page.
    Page,
}

/// Distribution axis.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DistributeAxis {
    /// Along x.
    Horizontal,
    /// Along y.
    Vertical,
}

/// Arrangement error.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ArrangeError {
    /// A node is not on a page (needed for page alignment).
    NotOnPage(Id),
    /// A reference node does not exist.
    MissingReference(Id),
    /// An internal op did not apply.
    Build(BuildError),
}

impl core::fmt::Display for ArrangeError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            ArrangeError::NotOnPage(id) => write!(f, "node {id:?} is not on a page"),
            ArrangeError::MissingReference(id) => write!(f, "reference node {id:?} does not exist"),
            ArrangeError::Build(e) => e.fmt(f),
        }
    }
}

impl std::error::Error for ArrangeError {}

impl From<BuildError> for ArrangeError {
    fn from(e: BuildError) -> Self {
        ArrangeError::Build(e)
    }
}

/// Existing ids minus those whose ancestor is also selected, in document order; root excluded.
pub fn top_level_selection(d: &Design, ids: &[Id]) -> Vec<Id> {
    let existing: Vec<Id> = ids
        .iter()
        .filter(|id| id.as_str() != ROOT_ID && d.node(id).is_some())
        .cloned()
        .collect();
    let mut sel = d.top_level_ids(&existing);
    d.sort_by_paint_order(&mut sel);
    sel
}

fn movable(d: &Design, ids: &[Id]) -> Vec<Id> {
    top_level_selection(d, ids)
        .into_iter()
        .filter(|id| {
            d.node(id)
                .is_some_and(|n| n.node_type() != NodeType::Page && !n.base().locked)
        })
        .collect()
}

fn page_rect(d: &Design, id: &str) -> Result<Rect, ArrangeError> {
    let page = d
        .page_of(id)
        .and_then(|p| d.node(p))
        .ok_or_else(|| ArrangeError::NotOnPage(id.to_string()))?;
    Ok(Rect::new(0.0, 0.0, page.base().width, page.base().height))
}

fn bounds(d: &Design, id: &str) -> Rect {
    node_aabb(d, id).unwrap_or_default()
}

/// Aligns the rotated bounds of the movable selection (top-level, unlocked, not pages) to an edge or center of the
/// selection bounds or the page. Groups containing moved nodes are refitted.
pub fn align_nodes(
    d: &mut Design,
    ids: &[Id],
    alignment: Alignment,
    to: AlignTo,
) -> Result<Vec<Op>, ArrangeError> {
    let sel = movable(d, ids);
    let to_page = to == AlignTo::Page || sel.len() == 1;
    let rects: Vec<Rect> = sel.iter().map(|id| bounds(d, id)).collect();
    let selection = union_bounds(rects.iter());
    let mut targets = Vec::with_capacity(sel.len());
    for id in &sel {
        targets.push(if to_page {
            page_rect(d, id)?
        } else {
            selection.unwrap_or_default()
        });
    }
    let mut b = TxBuilder::new(d);
    for (i, id) in sel.iter().enumerate() {
        let r = rects[i];
        let t = targets[i];
        let (dx, dy) = match alignment {
            Alignment::Left => (t.x - r.x, 0.0),
            Alignment::Center => (t.x + t.w / 2.0 - (r.x + r.w / 2.0), 0.0),
            Alignment::Right => (t.right() - r.right(), 0.0),
            Alignment::Top => (0.0, t.y - r.y),
            Alignment::Middle => (0.0, t.y + t.h / 2.0 - (r.y + r.h / 2.0)),
            Alignment::Bottom => (0.0, t.bottom() - r.bottom()),
        };
        if let Err(e) = b.translate_in_page(id, dx, dy) {
            b.finish();
            return Err(e.into());
        }
    }
    finish(b, &sel)
}

fn finish(mut b: TxBuilder<'_>, refit: &[Id]) -> Result<Vec<Op>, ArrangeError> {
    match b.refit_groups(refit.iter()) {
        Ok(()) => Ok(b.finish()),
        Err(e) => {
            b.finish();
            Err(e.into())
        }
    }
}

/// Distributes the movable selection along an axis by rotated bounds: evenly between the outermost nodes (needs
/// at least 3), or with a fixed `spacing` (needs at least 2).
pub fn distribute(
    d: &mut Design,
    ids: &[Id],
    axis: DistributeAxis,
    spacing: Option<f64>,
) -> Result<Vec<Op>, ArrangeError> {
    let sel = movable(d, ids);
    let minimum = if spacing.is_none() { 3 } else { 2 };
    if sel.len() < minimum {
        return Ok(Vec::new());
    }
    let horizontal = axis == DistributeAxis::Horizontal;
    let mut items: Vec<(Id, Rect)> = sel.iter().map(|id| (id.clone(), bounds(d, id))).collect();
    let start = |r: &Rect| if horizontal { r.x } else { r.y };
    let size = |r: &Rect| if horizontal { r.w } else { r.h };
    crate::jssort::sort_by(&mut items, |p, q| {
        crate::jssort::js_order(start(&p.1) - start(&q.1))
    });
    let first = items[0].1;
    let last = items[items.len() - 1].1;
    let gap = spacing.unwrap_or_else(|| {
        (start(&last) + size(&last)
            - start(&first)
            - items.iter().map(|it| size(&it.1)).sum::<f64>())
            / (items.len() - 1) as f64
    });
    let mut b = TxBuilder::new(d);
    let mut cursor = start(&first);
    for (id, r) in &items {
        let delta = cursor - start(r);
        let res = if horizontal {
            b.translate_in_page(id, delta, 0.0)
        } else {
            b.translate_in_page(id, 0.0, delta)
        };
        if let Err(e) = res {
            b.finish();
            return Err(e.into());
        }
        cursor += size(r) + gap;
    }
    finish(b, &sel)
}

/// Arranges the movable selection into a grid in reading order, starting at the selection's top-left; every cell
/// is the size of the largest node. `columns` defaults to `ceil(sqrt(n))`, `gap` to 24.
pub fn tidy_grid(
    d: &mut Design,
    ids: &[Id],
    columns: Option<usize>,
    gap: Option<f64>,
) -> Result<Vec<Op>, ArrangeError> {
    let sel = movable(d, ids);
    if sel.len() < 2 {
        return Ok(Vec::new());
    }
    let mut items: Vec<(Id, Rect)> = sel.iter().map(|id| (id.clone(), bounds(d, id))).collect();
    let cell_w = items
        .iter()
        .map(|i| i.1.w)
        .fold(f64::NEG_INFINITY, f64::max);
    let cell_h = items
        .iter()
        .map(|i| i.1.h)
        .fold(f64::NEG_INFINITY, f64::max);
    // Reading order: rows by vertical center (half a cell of tolerance), then left to right. This comparator is not
    // transitive, so it must go through the V8-compatible sort (the standard sort may panic on it).
    crate::jssort::sort_by(&mut items, |p, q| {
        let dy = p.1.y + p.1.h / 2.0 - (q.1.y + q.1.h / 2.0);
        if dy.abs() > cell_h / 2.0 {
            crate::jssort::js_order(dy)
        } else {
            crate::jssort::js_order(p.1.x - q.1.x)
        }
    });
    let columns = columns
        .unwrap_or_else(|| (items.len() as f64).sqrt().ceil() as usize)
        .max(1);
    let gap = gap.unwrap_or(24.0);
    let origin = union_bounds(items.iter().map(|i| &i.1)).unwrap_or_default();
    let mut b = TxBuilder::new(d);
    for (i, (id, r)) in items.iter().enumerate() {
        let (col, row) = (i % columns, i / columns);
        let tx = origin.x + col as f64 * (cell_w + gap) + (cell_w - r.w) / 2.0;
        let ty = origin.y + row as f64 * (cell_h + gap) + (cell_h - r.h) / 2.0;
        if let Err(e) = b.translate_in_page(id, tx - r.x, ty - r.y) {
            b.finish();
            return Err(e.into());
        }
    }
    finish(b, &sel)
}

/// Which dimension [`match_size`] copies.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Dimension {
    /// Width only.
    Width,
    /// Height only.
    Height,
    /// Both.
    #[default]
    Both,
}

/// Reference node for [`match_size`].
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MatchTo {
    /// First selected (document order).
    #[default]
    First,
    /// Last selected.
    Last,
    /// Largest area.
    Largest,
    /// Smallest area.
    Smallest,
    /// An explicit node.
    Node(Id),
}

/// Gives every selected node the reference node's width and/or height, keeping each node's center. Lines keep
/// their (zero) height.
pub fn match_size(
    d: &mut Design,
    ids: &[Id],
    dimension: Dimension,
    to: &MatchTo,
) -> Result<Vec<Op>, ArrangeError> {
    let sel = movable(d, ids);
    if sel.is_empty() {
        return Ok(Vec::new());
    }
    let nodes: Vec<(Id, crate::model::Base, bool)> = sel
        .iter()
        .filter_map(|id| {
            d.node(id).map(|n| {
                (
                    id.clone(),
                    n.base().clone(),
                    n.node_type() == NodeType::Line,
                )
            })
        })
        .collect();
    let area = |b: &crate::model::Base| b.width * b.height;
    let reference: crate::model::Base = match to {
        MatchTo::First => nodes[0].1.clone(),
        MatchTo::Last => nodes[nodes.len() - 1].1.clone(),
        MatchTo::Largest => nodes
            .iter()
            .fold(
                &nodes[0],
                |m, n| if area(&n.1) > area(&m.1) { n } else { m },
            )
            .1
            .clone(),
        MatchTo::Smallest => nodes
            .iter()
            .fold(
                &nodes[0],
                |m, n| if area(&n.1) < area(&m.1) { n } else { m },
            )
            .1
            .clone(),
        MatchTo::Node(id) => d
            .node(id)
            .ok_or_else(|| ArrangeError::MissingReference(id.clone()))?
            .base()
            .clone(),
    };
    let mut b = TxBuilder::new(d);
    for (id, n, is_line) in &nodes {
        if *id == reference.id {
            continue;
        }
        let width = if dimension == Dimension::Height {
            n.width
        } else {
            reference.width
        };
        let height = if dimension == Dimension::Width || *is_line {
            n.height
        } else {
            reference.height
        };
        let mut set = Map::new();
        set.insert(
            "x".into(),
            Value::from(round_geom(n.x + (n.width - width) / 2.0)),
        );
        set.insert(
            "y".into(),
            Value::from(round_geom(n.y + (n.height - height) / 2.0)),
        );
        set.insert("width".into(), Value::from(width));
        set.insert("height".into(), Value::from(height));
        if let Err(e) = b.update(id, set, &[]) {
            b.finish();
            return Err(e.into());
        }
    }
    finish(b, &sel)
}

/// Indices (into `seq`) of one longest strictly increasing subsequence.
fn longest_increasing(seq: &[usize]) -> Vec<bool> {
    let mut tails: Vec<usize> = Vec::new();
    let mut prev = vec![usize::MAX; seq.len()];
    for i in 0..seq.len() {
        let v = seq[i];
        let (mut lo, mut hi) = (0usize, tails.len());
        while lo < hi {
            let mid = (lo + hi) / 2;
            if seq[tails[mid]] < v {
                lo = mid + 1;
            } else {
                hi = mid;
            }
        }
        if lo > 0 {
            prev[i] = tails[lo - 1];
        }
        if lo == tails.len() {
            tails.push(i);
        } else {
            tails[lo] = i;
        }
    }
    let mut keep = vec![false; seq.len()];
    let mut i = tails.last().copied().unwrap_or(usize::MAX);
    while i != usize::MAX {
        keep[i] = true;
        i = prev[i];
    }
    keep
}

/// Moves (within `parent`) that reorder `current` into `target` (same ids). Elements on a longest increasing
/// subsequence stay; every other element moves once, right after its target predecessor. `None` when the lists
/// do not hold the same ids.
pub fn reorder_moves(parent: &str, current: &[Id], target: &[Id]) -> Option<Vec<Op>> {
    if current.len() != target.len() {
        return None;
    }
    let pos: rustc_hash::FxHashMap<&str, usize> = target
        .iter()
        .enumerate()
        .map(|(i, id)| (id.as_str(), i))
        .collect();
    let positions: Vec<usize> = current
        .iter()
        .map(|id| pos.get(id.as_str()).copied())
        .collect::<Option<_>>()?;
    let stay = longest_increasing(&positions);
    let stable: rustc_hash::FxHashSet<&str> = current
        .iter()
        .enumerate()
        .filter(|(i, _)| stay[*i])
        .map(|(_, id)| id.as_str())
        .collect();
    let mut list: Vec<Id> = current.to_vec();
    let mut ops = Vec::new();
    for (i, id) in target.iter().enumerate() {
        if stable.contains(id.as_str()) {
            continue;
        }
        let from = list.iter().position(|x| x == id)?;
        list.remove(from);
        let index = if i == 0 {
            0
        } else {
            list.iter()
                .position(|x| x == &target[i - 1])
                .map(|p| p + 1)
                .unwrap_or(0)
        };
        list.insert(index, id.clone());
        if index != from {
            ops.push(Op::Move(MoveOp {
                id: id.clone(),
                parent: parent.to_string(),
                index: Some(index as i64),
            }));
        }
    }
    Some(ops)
}

/// Z-order change kinds.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ZOrder {
    /// One step up past the next unselected sibling.
    BringForward,
    /// One step down past the previous unselected sibling.
    SendBackward,
    /// To the top of the parent, keeping relative order.
    BringToFront,
    /// To the bottom of the parent, keeping relative order.
    SendToBack,
}

/// Reorders the selection (top-level, not pages) within each parent; returns the `move` ops.
pub fn reorder(d: &Design, ids: &[Id], kind: ZOrder) -> Vec<Op> {
    let sel: Vec<Id> = top_level_selection(d, ids)
        .into_iter()
        .filter(|id| d.node(id).is_some_and(|n| n.node_type() != NodeType::Page))
        .collect();
    let mut by_parent: Vec<(Id, rustc_hash::FxHashSet<Id>)> = Vec::new();
    for id in &sel {
        let Some(parent) = d.node(id).and_then(Node::parent) else {
            continue;
        };
        match by_parent.iter_mut().find(|(p, _)| p == parent) {
            Some(e) => {
                e.1.insert(id.clone());
            }
            None => by_parent.push((parent.to_string(), std::iter::once(id.clone()).collect())),
        }
    }
    let mut ops = Vec::new();
    for (parent, selected) in by_parent {
        let current: Vec<Id> = d
            .node(&parent)
            .map(|n| n.child_ids().to_vec())
            .unwrap_or_default();
        let mut out = current.clone();
        match kind {
            ZOrder::BringForward => {
                for i in (0..out.len().saturating_sub(1)).rev() {
                    if selected.contains(&out[i]) && !selected.contains(&out[i + 1]) {
                        out.swap(i, i + 1);
                    }
                }
            }
            ZOrder::SendBackward => {
                for i in 1..out.len() {
                    if selected.contains(&out[i]) && !selected.contains(&out[i - 1]) {
                        out.swap(i, i - 1);
                    }
                }
            }
            ZOrder::BringToFront => {
                let (sel_part, rest): (Vec<Id>, Vec<Id>) = current
                    .iter()
                    .cloned()
                    .partition(|id| selected.contains(id));
                out = rest.into_iter().chain(sel_part).collect();
            }
            ZOrder::SendToBack => {
                let (sel_part, rest): (Vec<Id>, Vec<Id>) = current
                    .iter()
                    .cloned()
                    .partition(|id| selected.contains(id));
                out = sel_part.into_iter().chain(rest).collect();
            }
        }
        if let Some(moves) = reorder_moves(&parent, &current, &out) {
            ops.extend(moves);
        }
    }
    ops
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::DesignKind;
    use crate::{ApplyOptions, Transaction, apply_transaction};

    fn d() -> Design {
        let mut d = Design::with_page(
            "design000001",
            "D",
            DesignKind::Poster,
            "page00000001",
            1000.0,
            1000.0,
        );
        d.push_child(
            "page00000001",
            Node::rect("rect00000001", "a", 10.0, 10.0, 100.0, 50.0),
        );
        d.push_child(
            "page00000001",
            Node::rect("rect00000002", "b", 300.0, 100.0, 50.0, 50.0),
        );
        d.push_child(
            "page00000001",
            Node::rect("rect00000003", "c", 600.0, 200.0, 80.0, 20.0),
        );
        d
    }

    fn ids(v: &[&str]) -> Vec<Id> {
        v.iter().map(|s| s.to_string()).collect()
    }

    fn apply(d: &mut Design, ops: Vec<Op>) {
        let r = apply_transaction(
            d,
            &Transaction::new("tx0000000001", "t", ops),
            ApplyOptions::default(),
        );
        assert!(r.dropped.is_empty());
    }

    #[test]
    fn align_left_and_page() {
        let mut d = d();
        let before = d.canonical_json();
        let ops = align_nodes(
            &mut d,
            &ids(&["rect00000001", "rect00000002", "rect00000003"]),
            Alignment::Left,
            AlignTo::Selection,
        )
        .unwrap();
        assert_eq!(d.canonical_json(), before, "design restored");
        assert_eq!(ops.len(), 2);
        apply(&mut d, ops);
        for id in ["rect00000001", "rect00000002", "rect00000003"] {
            assert_eq!(d.node(id).unwrap().base().x, 10.0);
        }
        let ops = align_nodes(
            &mut d,
            &ids(&["rect00000002"]),
            Alignment::Bottom,
            AlignTo::Selection,
        )
        .unwrap();
        apply(&mut d, ops);
        assert_eq!(d.node("rect00000002").unwrap().base().y, 950.0);
    }

    #[test]
    fn distribute_and_tidy() {
        let mut d = d();
        let ops = distribute(
            &mut d,
            &ids(&["rect00000001", "rect00000002", "rect00000003"]),
            DistributeAxis::Horizontal,
            None,
        )
        .unwrap();
        apply(&mut d, ops);
        let x = |id: &str| d.node(id).unwrap().base().x;
        let w = |id: &str| d.node(id).unwrap().base().width;
        let g1 = x("rect00000002") - (x("rect00000001") + w("rect00000001"));
        let g2 = x("rect00000003") - (x("rect00000002") + w("rect00000002"));
        assert!((g1 - g2).abs() < 1e-3);
        let ops = tidy_grid(
            &mut d,
            &ids(&["rect00000001", "rect00000002", "rect00000003"]),
            Some(3),
            Some(10.0),
        )
        .unwrap();
        apply(&mut d, ops);
        let ys: Vec<f64> = ["rect00000001", "rect00000002", "rect00000003"]
            .iter()
            .map(|i| d.node(i).unwrap().base().y + d.node(i).unwrap().base().height / 2.0)
            .collect();
        assert!(
            ys.iter().all(|y| (y - ys[0]).abs() < 1e-6),
            "one row with centered cells"
        );
    }

    #[test]
    fn match_size_and_zorder() {
        let mut d = d();
        let ops = match_size(
            &mut d,
            &ids(&["rect00000001", "rect00000002"]),
            Dimension::Both,
            &MatchTo::First,
        )
        .unwrap();
        apply(&mut d, ops);
        let b = d.node("rect00000002").unwrap().base();
        assert_eq!((b.width, b.height, b.x, b.y), (100.0, 50.0, 275.0, 100.0));
        let ops = reorder(&d, &ids(&["rect00000001"]), ZOrder::BringToFront);
        apply(&mut d, ops);
        assert_eq!(
            d.node("page00000001").unwrap().child_ids().last().unwrap(),
            "rect00000001"
        );
        let ops = reorder(&d, &ids(&["rect00000001"]), ZOrder::SendBackward);
        apply(&mut d, ops);
        assert_eq!(
            d.node("page00000001").unwrap().child_ids()[1],
            "rect00000001"
        );
        let moves = reorder_moves(
            "p",
            &ids(&["a", "b", "c", "d"]),
            &ids(&["d", "a", "b", "c"]),
        )
        .unwrap();
        assert_eq!(moves.len(), 1);
    }

    /// The tidy reading order ("same row within half a cell") is not transitive. The standard sort may panic on
    /// such a comparator; the V8-compatible sort must give exactly the `tidyGrid` output of `@desyn/doc-ops`
    /// (golden captured from the TypeScript builder for this scene).
    #[test]
    fn tidy_with_overlapping_rows_matches_typescript_and_never_panics() {
        let mut d = Design::with_page(
            "design000001",
            "D",
            DesignKind::Custom,
            "page00000001",
            2000.0,
            2000.0,
        );
        let mut all = Vec::new();
        for i in 0..24u32 {
            let id = format!("r{i:011}");
            let n = Node::rect(
                &id,
                "r",
                f64::from((i * 137) % 900),
                f64::from(i * 9 + (i * 53) % 40),
                f64::from(40 + (i % 5) * 10),
                f64::from(30 + (i % 4) * 8),
            );
            d.push_child("page00000001", n);
            all.push(id);
        }
        let before = d.canonical_json();
        let ops = tidy_grid(&mut d, &all, Some(6), Some(8.0)).unwrap();
        assert_eq!(d.canonical_json(), before, "design restored");
        let golden = r#"[{"id":"r00000000000","op":"update","set":{"x":20,"y":12}},{"id":"r00000000001","op":"update","set":{"x":103,"y":8}},{"id":"r00000000002","op":"update","set":{"x":186,"y":4}},{"id":"r00000000004","op":"update","set":{"x":264,"y":12}},{"id":"r00000000007","op":"update","set":{"x":362,"y":0}},{"id":"r00000000008","op":"update","set":{"x":445,"y":12}},{"id":"r00000000003","op":"update","set":{"x":5,"y":62}},{"id":"r00000000005","op":"update","set":{"x":108}},{"id":"r00000000009","op":"update","set":{"x":176,"y":70}},{"id":"r00000000010","op":"update","set":{"x":284,"y":66}},{"id":"r00000000006","op":"update","set":{"x":367,"y":66}},{"id":"r00000000014","op":"update","set":{"x":440,"y":66}},{"id":"r00000000016","op":"update","set":{"x":15,"y":136}},{"id":"r00000000011","op":"update","set":{"x":103,"y":124}},{"id":"r00000000012","op":"update","set":{"x":186,"y":136}},{"id":"r00000000013","op":"update","set":{"x":269,"y":132}},{"id":"r00000000020","op":"update","set":{"x":372,"y":136}},{"id":"r00000000015","op":"update","set":{"x":460,"y":124}},{"id":"r00000000017","op":"update","set":{"x":10,"y":194}},{"id":"r00000000021","op":"update","set":{"x":103,"y":194}},{"id":"r00000000022","op":"update","set":{"x":186,"y":190}},{"id":"r00000000018","op":"update","set":{"x":269,"y":190}},{"id":"r00000000019","op":"update","set":{"x":352,"y":186}},{"id":"r00000000023","op":"update","set":{"x":445,"y":186}}]"#;
        assert_eq!(crate::canonical::canonical_string(&ops), golden);
        // Many random overlapping rows: no panic, every node placed once.
        let mut seed = 7u64;
        let mut rnd = || {
            seed = seed
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            (seed >> 33) as f64 / (1u64 << 31) as f64
        };
        for trial in 0..40 {
            let mut d = Design::with_page(
                "design000001",
                "D",
                DesignKind::Custom,
                "page00000001",
                4000.0,
                4000.0,
            );
            let mut sel = Vec::new();
            for i in 0..(20 + trial * 5) {
                let id = format!("t{i:011}");
                d.push_child(
                    "page00000001",
                    Node::rect(
                        &id,
                        "r",
                        rnd() * 3000.0,
                        rnd() * 3000.0,
                        10.0 + rnd() * 50.0,
                        10.0 + rnd() * 100.0,
                    ),
                );
                sel.push(id);
            }
            assert!(tidy_grid(&mut d, &sel, None, None).is_ok());
        }
    }
}
