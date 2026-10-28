//! Incremental transaction builder: every op is applied to the design right away (so later ops see the evolving
//! state) and rolled back when the builder finishes, leaving the design unchanged. Mirrors `builder.ts` of
//! `@desyn/doc-ops` (same rounding, same "only changed keys" updates, same group refit).

use serde_json::{Map, Value};

use crate::canonical::canonical_json;
use crate::geometry::{Affine, Point, local_transform, parent_world_transform};
use crate::model::{Design, Id, Node, NodeType, Op, UpdateOp};
use crate::ops::{DropReason, apply_op};

/// Builder error: an op the builder produced did not apply (a bug in the caller's inputs or the builder).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BuildError {
    /// Kind of the failing op.
    pub op: &'static str,
    /// Why it was dropped.
    pub reason: DropReason,
}

impl core::fmt::Display for BuildError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        write!(
            f,
            "builder produced a {} op that does not apply ({})",
            self.op, self.reason
        )
    }
}

impl std::error::Error for BuildError {}

const EPS: f64 = 1e-4;

/// Rounds builder geometry to 1/10000 px (as `roundGeom` in `@desyn/doc-ops`).
pub fn round_geom(n: f64) -> f64 {
    let r = crate::canonical::js_round(n * 10000.0) / 10000.0;
    if r == 0.0 { 0.0 } else { r }
}

fn num(v: f64) -> Value {
    serde_json::Number::from_f64(v)
        .map(Value::Number)
        .unwrap_or(Value::Null)
}

/// Applies ops to a design while recording them; [`TxBuilder::finish`] undoes everything and returns the ops.
pub struct TxBuilder<'a> {
    /// The design in its evolving state.
    pub design: &'a mut Design,
    ops: Vec<Op>,
    undo: Vec<Op>,
}

impl<'a> TxBuilder<'a> {
    /// Starts building on `design`.
    pub fn new(design: &'a mut Design) -> Self {
        TxBuilder {
            design,
            ops: Vec::new(),
            undo: Vec::new(),
        }
    }

    /// Applies and records an op.
    pub fn push(&mut self, op: Op) -> Result<(), BuildError> {
        match apply_op(self.design, &op) {
            Ok((applied, inverse)) => {
                let _ = applied;
                self.ops.push(op);
                self.undo.push(inverse);
                Ok(())
            }
            Err(reason) => Err(BuildError {
                op: op.kind(),
                reason,
            }),
        }
    }

    /// Pushes an update containing only the keys whose value actually changes (canonical comparison).
    pub fn update(
        &mut self,
        id: &str,
        set: Map<String, Value>,
        unset: &[&str],
    ) -> Result<(), BuildError> {
        let Some(node) = self.design.node(id) else {
            return Err(BuildError {
                op: "update",
                reason: DropReason::MissingNode,
            });
        };
        let current = match serde_json::to_value(node) {
            Ok(Value::Object(m)) => m,
            _ => Map::new(),
        };
        let mut changed = Map::new();
        for (k, v) in set {
            match current.get(&k) {
                Some(old) if canonical_json(old) == canonical_json(&v) => {}
                _ => {
                    changed.insert(k, v);
                }
            }
        }
        let removing: Vec<String> = unset
            .iter()
            .filter(|k| current.contains_key(**k))
            .map(|k| k.to_string())
            .collect();
        if changed.is_empty() && removing.is_empty() {
            return Ok(());
        }
        self.push(Op::Update(UpdateOp {
            id: id.to_string(),
            set: (!changed.is_empty()).then_some(changed),
            unset: (!removing.is_empty()).then_some(removing),
        }))
    }

    /// Translates a node by a delta in page coordinates (rounded to 1/10000 px).
    pub fn translate_in_page(&mut self, id: &str, dx: f64, dy: f64) -> Result<(), BuildError> {
        if dx.abs() < EPS && dy.abs() < EPS {
            return Ok(());
        }
        let Some(n) = self.design.node(id) else {
            return Err(BuildError {
                op: "update",
                reason: DropReason::MissingNode,
            });
        };
        let (x, y) = (n.base().x, n.base().y);
        let local = parent_world_transform(self.design, id)
            .inverse()
            .map(|inv| inv.apply_vector(Point::new(dx, dy)))
            .unwrap_or(Point::new(dx, dy));
        let mut set = Map::new();
        set.insert("x".into(), num(round_geom(x + local.x)));
        set.insert("y".into(), num(round_geom(y + local.y)));
        self.update(id, set, &[])
    }

    /// Recomputes the bounds of every group that contains (or is) one of `ids`, deepest first, keeping children
    /// fixed on the page.
    pub fn refit_groups<'i>(
        &mut self,
        ids: impl IntoIterator<Item = &'i Id>,
    ) -> Result<(), BuildError> {
        let mut groups: Vec<(Id, usize)> = Vec::new();
        for id in ids {
            if self.design.node(id).is_none() {
                continue;
            }
            let mut chain = vec![id.clone()];
            chain.extend(self.design.ancestors(id));
            let len = chain.len();
            for (i, gid) in chain.iter().enumerate() {
                if self
                    .design
                    .node(gid)
                    .is_some_and(|n| n.node_type() == NodeType::Group)
                {
                    let depth = len - i;
                    match groups.iter_mut().find(|(g, _)| g == gid) {
                        Some(e) => e.1 = e.1.max(depth),
                        None => groups.push((gid.clone(), depth)),
                    }
                }
            }
        }
        // Stable sort keeps first-seen order among equal depths (as Array.prototype.sort does).
        groups.sort_by_key(|g| std::cmp::Reverse(g.1));
        for (gid, _) in groups {
            self.refit_group(&gid)?;
        }
        Ok(())
    }

    fn refit_group(&mut self, id: &str) -> Result<(), BuildError> {
        let Some(Node::Group(g)) = self.design.node(id) else {
            return Ok(());
        };
        if g.container.children.is_empty() {
            return Ok(());
        }
        let gb = g.base.clone();
        let kids: Vec<(Id, crate::model::Base)> = g
            .container
            .children
            .iter()
            .filter_map(|c| self.design.node(c).map(|n| (c.clone(), n.base().clone())))
            .collect();
        let pts: Vec<Point> = kids
            .iter()
            .flat_map(|(_, b)| {
                let t = local_transform(b);
                [
                    Point::new(0.0, 0.0),
                    Point::new(b.width, 0.0),
                    Point::new(b.width, b.height),
                    Point::new(0.0, b.height),
                ]
                .map(|p| t.apply(p))
            })
            .collect();
        let Some(r) = crate::geometry::Rect::bounding(pts) else {
            return Ok(());
        };
        if r.x.abs() < EPS
            && r.y.abs() < EPS
            && (r.w - gb.width).abs() < EPS
            && (r.h - gb.height).abs() < EPS
        {
            return Ok(());
        }
        let m = local_transform(&gb) * Affine::translate(r.x, r.y);
        let p = decompose_prefer(&m, r.w, r.h, gb.flipped_x(), gb.flipped_y());
        let mut set = Map::new();
        set.insert("x".into(), num(round_geom(p.0)));
        set.insert("y".into(), num(round_geom(p.1)));
        set.insert("width".into(), num(round_geom(r.w)));
        set.insert("height".into(), num(round_geom(r.h)));
        set.insert("rotation".into(), num(round_geom(p.2)));
        self.update(id, set, &[])?;
        for (kid, b) in kids {
            let mut s = Map::new();
            s.insert("x".into(), num(round_geom(b.x - r.x)));
            s.insert("y".into(), num(round_geom(b.y - r.y)));
            self.update(&kid, s, &[])?;
        }
        Ok(())
    }

    /// Ops pushed so far.
    pub fn ops(&self) -> &[Op] {
        &self.ops
    }

    /// Rolls the design back to its initial state and returns the recorded ops.
    pub fn finish(self) -> Vec<Op> {
        for inv in self.undo.into_iter().rev() {
            // Inverses of applied ops always apply to the state they were computed for.
            let _ = apply_op(self.design, &inv);
        }
        self.ops
    }
}

/// Normalizes degrees to (-180, 180].
pub fn normalize_degrees(deg: f64) -> f64 {
    let mut r = deg % 360.0;
    if r <= -180.0 {
        r += 360.0;
    }
    if r > 180.0 {
        r -= 360.0;
    }
    if r == 0.0 { 0.0 } else { r }
}

/// `(x, y, rotation, flip_x, flip_y)` such that the node transform of a `w x h` box equals the rigid matrix `m`,
/// keeping the preferred flips when the matrix handedness allows (otherwise flipX toggles). Same as `decompose` in
/// `@desyn/doc-ops`.
pub fn decompose_prefer(
    m: &Affine,
    w: f64,
    h: f64,
    prefer_flip_x: bool,
    prefer_flip_y: bool,
) -> (f64, f64, f64, bool, bool) {
    let mut flip_x = prefer_flip_x;
    let flip_y = prefer_flip_y;
    let det = m.determinant();
    let handed = if flip_x { -1.0 } else { 1.0 } * if flip_y { -1.0 } else { 1.0 };
    if det != 0.0 && det.signum() != handed {
        flip_x = !flip_x;
    }
    let fx = if flip_x { -1.0 } else { 1.0 };
    let rotation = normalize_degrees((m.b * fx).atan2(m.a * fx).to_degrees());
    let c = m.apply(Point::new(w / 2.0, h / 2.0));
    (c.x - w / 2.0, c.y - h / 2.0, rotation, flip_x, flip_y)
}
