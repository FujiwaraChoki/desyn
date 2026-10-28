//! Transactions: apply (with inverse), invert, compose, op schema checks.
//!
//! Semantics follow DOCUMENT_MODEL section 5 and `spec/fixtures/README.md`; the TypeScript applier in
//! `@desyn/doc-ops` implements the same rules and both are verified against `spec/fixtures/ops`.

mod apply;
mod compose;
mod schema;
mod value_path;

use rustc_hash::{FxHashMap, FxHashSet};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

pub use compose::{ComposeOptions, coalesce_ops, compose, invert};
pub use schema::check_op_schema;

use crate::layout::{ApproxMeasurer, GeometryChange, TextMeasurer};
use crate::model::{Design, Id, Op, Transaction, UpdateOp};

/// Why an op was dropped. Fixed vocabulary shared with `@desyn/doc-ops` (see `spec/fixtures/README.md`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DropReason {
    /// The op does not match the op schema (unknown `op`, wrong field types, malformed ids, ...).
    InvalidOp,
    /// The target node does not exist.
    MissingNode,
    /// The parent named by `create` / `move` does not exist.
    MissingParent,
    /// The parent named by `create` / `move` cannot have children.
    NotContainer,
    /// `move` into the node itself or one of its descendants.
    Cycle,
    /// `create` with an id that already exists (or repeats inside the op).
    DuplicateId,
    /// `update` / `patch` touching `id`, `type`, `parent` or `children`.
    ImmutableField,
    /// A created or mutated node is not valid (schema / invariants / inconsistent subtree).
    InvalidNode,
    /// Deleting / moving the root.
    RootProtected,
    /// A page placed under a non-root parent, or a non-page placed under the root.
    PageNesting,
    /// A `patch` / `styles` path that does not resolve.
    InvalidPath,
    /// An `asset` / `styles` / `doc` value that is not valid.
    InvalidValue,
}

impl DropReason {
    /// The reason string, e.g. `"missing-node"`.
    pub fn as_str(self) -> &'static str {
        match self {
            DropReason::InvalidOp => "invalid-op",
            DropReason::MissingNode => "missing-node",
            DropReason::MissingParent => "missing-parent",
            DropReason::NotContainer => "not-container",
            DropReason::Cycle => "cycle",
            DropReason::DuplicateId => "duplicate-id",
            DropReason::ImmutableField => "immutable-field",
            DropReason::InvalidNode => "invalid-node",
            DropReason::RootProtected => "root-protected",
            DropReason::PageNesting => "page-nesting",
            DropReason::InvalidPath => "invalid-path",
            DropReason::InvalidValue => "invalid-value",
        }
    }
}

impl core::fmt::Display for DropReason {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// A dropped op.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Dropped {
    /// Index of the op in `tx.ops`.
    pub index: usize,
    /// Reason.
    pub reason: DropReason,
}

/// Result of [`apply_transaction`]. The design itself is mutated in place.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ApplyResult {
    /// Transaction that restores the previous state exactly.
    pub inverse: Transaction,
    /// Ops that took effect (possibly rewritten), followed by derived-geometry `update`s from normalization.
    pub applied: Vec<Op>,
    /// Dropped ops.
    pub dropped: Vec<Dropped>,
}

/// Options for [`apply_transaction`].
#[derive(Default)]
pub struct ApplyOptions<'a> {
    /// Run layout normalization (auto-layout, constraints, group bounds, text auto-resize) after the ops.
    pub normalize: bool,
    /// Text measurer used by normalization; [`ApproxMeasurer`] when `None`.
    pub measurer: Option<&'a mut dyn TextMeasurer>,
    /// Id of the inverse transaction (defaults to [`inverse_tx_id`]`(tx.id)`).
    pub inverse_id: Option<Id>,
}

impl<'a> ApplyOptions<'a> {
    /// Options with normalization on and the given measurer.
    pub fn normalized(measurer: &'a mut dyn TextMeasurer) -> Self {
        ApplyOptions {
            normalize: true,
            measurer: Some(measurer),
            inverse_id: None,
        }
    }
}

/// What changed during a transaction; input of [`crate::layout::normalize`].
#[derive(Debug, Clone, Default)]
pub struct DirtySet {
    /// Nodes created, updated, patched or moved.
    pub nodes: FxHashSet<Id>,
    /// Containers whose children list changed (insert / remove / reorder).
    pub containers: FxHashSet<Id>,
    /// Size before the transaction of nodes whose `width` / `height` were changed by ops.
    pub resized: FxHashMap<Id, (f64, f64)>,
    /// Nodes whose geometry fields (`x`, `y`, `width`, `height`, `rotation`, flips) were set explicitly by ops;
    /// constraints never override these.
    pub explicit_geometry: FxHashSet<Id>,
}

impl DirtySet {
    /// Marks every node dirty (full normalization).
    pub fn all(d: &Design) -> Self {
        let mut s = DirtySet::default();
        for (id, n) in &d.nodes {
            s.nodes.insert(id.clone());
            if n.is_container() {
                s.containers.insert(id.clone());
            }
        }
        s
    }

    /// True when nothing is marked.
    pub fn is_empty(&self) -> bool {
        self.nodes.is_empty() && self.containers.is_empty()
    }
}

/// Applies a transaction in place. Never panics on bad input: invalid ops are dropped and reported.
pub fn apply_transaction(
    design: &mut Design,
    tx: &Transaction,
    opts: ApplyOptions<'_>,
) -> ApplyResult {
    let mut applied = Vec::with_capacity(tx.ops.len());
    let mut inverse_parts: Vec<Op> = Vec::with_capacity(tx.ops.len() + 1);
    let mut dropped = Vec::new();
    let mut dirty = DirtySet::default();
    for (index, op) in tx.ops.iter().enumerate() {
        match apply::apply_op(design, op, &mut dirty) {
            Ok(done) => {
                applied.push(done.applied);
                inverse_parts.push(done.inverse);
            }
            Err(reason) => dropped.push(Dropped { index, reason }),
        }
    }
    if opts.normalize && !dirty.is_empty() {
        let mut approx = ApproxMeasurer;
        let measurer: &mut dyn TextMeasurer = match opts.measurer {
            Some(m) => m,
            None => &mut approx,
        };
        let changes = crate::layout::normalize(design, measurer, &dirty);
        let (fwd, inv) = geometry_change_ops(&changes);
        applied.extend(fwd);
        inverse_parts.extend(inv);
    }
    let inverse_ops: Vec<Op> = inverse_parts.into_iter().rev().collect();
    ApplyResult {
        inverse: Transaction {
            id: opts.inverse_id.unwrap_or_else(|| inverse_tx_id(&tx.id)),
            label: tx.label.clone(),
            ops: inverse_ops,
            source: tx.source,
            actor: tx.actor.clone(),
            ts: tx.ts,
        },
        applied,
        dropped,
    }
}

/// Applies a single op in place; returns the applied (normalized) op and its inverse op.
pub fn apply_op(design: &mut Design, op: &Op) -> Result<(Op, Op), DropReason> {
    let mut dirty = DirtySet::default();
    apply::apply_op(design, op, &mut dirty).map(|d| (d.applied, d.inverse))
}

/// Deterministic id of an inverse transaction: the first 12 hex chars of `sha256("inverse:" + tx_id)`
/// (same as `inverseTxId` in `@desyn/doc-ops`).
pub fn inverse_tx_id(tx_id: &str) -> Id {
    crate::canonical::sha256_hex(format!("inverse:{tx_id}").as_bytes())[..12].to_string()
}

fn num(v: f64) -> Value {
    serde_json::Number::from_f64(v)
        .map(Value::Number)
        .unwrap_or(Value::Null)
}

/// Turns normalization changes into forward `update` ops and their inverse `update` ops (same order; the caller
/// reverses the whole inverse list).
fn geometry_change_ops(changes: &[GeometryChange]) -> (Vec<Op>, Vec<Op>) {
    let mut fwd = Vec::with_capacity(changes.len());
    let mut inv = Vec::with_capacity(changes.len());
    for ch in changes {
        let mut set = Map::new();
        let mut old = Map::new();
        let pairs = [
            ("x", ch.before.x, ch.after.x),
            ("y", ch.before.y, ch.after.y),
            ("width", ch.before.width, ch.after.width),
            ("height", ch.before.height, ch.after.height),
        ];
        for (k, b, a) in pairs {
            if a != b {
                set.insert(k.to_string(), num(a));
                old.insert(k.to_string(), num(b));
            }
        }
        if set.is_empty() {
            continue;
        }
        fwd.push(Op::Update(UpdateOp {
            id: ch.id.clone(),
            set: Some(set),
            unset: None,
        }));
        inv.push(Op::Update(UpdateOp {
            id: ch.id.clone(),
            set: Some(old),
            unset: None,
        }));
    }
    (fwd, inv)
}
