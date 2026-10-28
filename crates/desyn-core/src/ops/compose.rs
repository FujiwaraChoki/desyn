//! Composition (undo grouping, op coalescing) and stand-alone inversion, mirroring `compose.ts` of `@desyn/doc-ops`.

use serde_json::Map;

use super::{ApplyOptions, apply_transaction};
use crate::model::{Design, Id, Op, Transaction, UpdateOp};

/// Options for [`compose`].
#[derive(Debug, Clone)]
pub struct ComposeOptions {
    /// Id of the composed transaction (default: first 12 hex chars of `sha256("compose:" + ids joined by ",")`;
    /// the core has no randomness, pass a fresh id when one is needed).
    pub id: Option<Id>,
    /// Label (default: the first transaction's label).
    pub label: Option<String>,
    /// Merge adjacent redundant ops (default true), see [`coalesce_ops`].
    pub coalesce: bool,
}

impl Default for ComposeOptions {
    fn default() -> Self {
        ComposeOptions {
            id: None,
            label: None,
            coalesce: true,
        }
    }
}

fn merge_updates(a: &UpdateOp, b: &UpdateOp) -> UpdateOp {
    let b_set = b.set.clone().unwrap_or_default();
    let b_unset: Vec<String> = b.unset.clone().unwrap_or_default();
    let mut set = Map::new();
    for (k, v) in a.set.iter().flatten() {
        if !b_unset.contains(k) {
            set.insert(k.clone(), v.clone());
        }
    }
    for (k, v) in &b_set {
        set.insert(k.clone(), v.clone());
    }
    let mut unset: Vec<String> = Vec::new();
    for k in a
        .unset
        .iter()
        .flatten()
        .filter(|k| !b_set.contains_key(*k))
        .chain(b_unset.iter())
    {
        if !unset.contains(k) {
            unset.push(k.clone());
        }
    }
    UpdateOp {
        id: a.id.clone(),
        set: (!set.is_empty()).then_some(set),
        unset: (!unset.is_empty()).then_some(unset),
    }
}

/// Merges adjacent redundant ops: consecutive `update`s of one node, consecutive `patch`es of one path (the last
/// wins), and `update`/`patch`es of a node immediately followed by its `delete`. The result reaches the same state
/// whenever every original op applies.
pub fn coalesce_ops(ops: &[Op]) -> Vec<Op> {
    let mut out: Vec<Op> = Vec::with_capacity(ops.len());
    for op in ops {
        match (out.last(), op) {
            (Some(Op::Update(a)), Op::Update(b)) if a.id == b.id => {
                let merged = merge_updates(a, b);
                *out.last_mut().expect("non-empty") = Op::Update(merged);
                continue;
            }
            (Some(Op::Patch(a)), Op::Patch(b)) if a.id == b.id && a.path == b.path => {
                *out.last_mut().expect("non-empty") = op.clone();
                continue;
            }
            _ => {}
        }
        if let Op::Delete(del) = op {
            while matches!(out.last(), Some(Op::Update(u)) if u.id == del.id)
                || matches!(out.last(), Some(Op::Patch(p)) if p.id == del.id)
            {
                out.pop();
            }
        }
        out.push(op.clone());
    }
    out
}

/// One transaction equivalent to applying `txs` in order: label, source and actor from the first, `ts` from the
/// last. Returns `None` for an empty list. Use it to group consecutive AI transactions with the same `actor.runId`
/// into one undo step (compose the forward transactions in order, or their inverses in reverse order).
pub fn compose(txs: &[Transaction], options: ComposeOptions) -> Option<Transaction> {
    let first = txs.first()?;
    let last = txs.last()?;
    let ops: Vec<Op> = txs.iter().flat_map(|t| t.ops.iter().cloned()).collect();
    let id = options.id.unwrap_or_else(|| {
        let joined: Vec<&str> = txs.iter().map(|t| t.id.as_str()).collect();
        crate::canonical::sha256_hex(format!("compose:{}", joined.join(",")).as_bytes())[..12]
            .to_string()
    });
    Some(Transaction {
        id,
        label: options.label.unwrap_or_else(|| first.label.clone()),
        ops: if options.coalesce {
            coalesce_ops(&ops)
        } else {
            ops
        },
        source: first.source,
        actor: first.actor.clone(),
        ts: last.ts,
    })
}

/// Computes the inverse of `tx` against `design` without modifying it (clones the design; prefer
/// [`super::ApplyResult::inverse`] when applying anyway).
pub fn invert(design: &Design, tx: &Transaction) -> Transaction {
    let mut scratch = design.clone();
    apply_transaction(&mut scratch, tx, ApplyOptions::default()).inverse
}
