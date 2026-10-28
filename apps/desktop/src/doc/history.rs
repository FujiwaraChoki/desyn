//! Undo / redo stacks built on the core's exact inverse transactions (DOCUMENT_MODEL §5: undo groups map 1:1 to
//! transactions). Consecutive edits with the same coalescing key (arrow-key nudges, scrubbed values, typing)
//! merge into one undo step when they arrive within [`COALESCE_MS`].

use desyn_core::{Op, Transaction};

/// Edits with the same key closer than this merge into one undo step.
pub const COALESCE_MS: u64 = 1000;

/// Maximum number of undo steps kept.
pub const MAX_STEPS: usize = 500;

/// One undo step.
#[derive(Debug, Clone)]
pub struct Step {
    /// History label ("Move", "Nudge", "Edit text").
    pub label: String,
    /// The ops that took effect (as applied, including derived geometry), replayed by redo.
    pub forward: Vec<Op>,
    /// Ops restoring the state before the step (applied without normalization).
    pub inverse: Vec<Op>,
    /// Merge key.
    pub coalesce: Option<String>,
    /// Time of the last merged edit (ms, monotonic clock of the caller).
    pub at_ms: u64,
}

/// Undo / redo history.
#[derive(Debug, Default, Clone)]
pub struct History {
    undo: Vec<Step>,
    redo: Vec<Step>,
}

impl History {
    /// Records an applied transaction. `inverse` is the core's inverse of `forward`.
    pub fn record(
        &mut self,
        label: &str,
        forward: Vec<Op>,
        inverse: Vec<Op>,
        coalesce: Option<&str>,
        now_ms: u64,
    ) {
        if forward.is_empty() {
            return;
        }
        self.redo.clear();
        if let (Some(key), Some(last)) = (coalesce, self.undo.last_mut())
            && last.coalesce.as_deref() == Some(key)
            && now_ms.saturating_sub(last.at_ms) <= COALESCE_MS
        {
            last.forward.extend(forward);
            // The newest change must be undone first.
            let mut inv = inverse;
            inv.append(&mut last.inverse);
            last.inverse = inv;
            last.at_ms = now_ms;
            return;
        }
        self.undo.push(Step {
            label: label.to_string(),
            forward,
            inverse,
            coalesce: coalesce.map(str::to_string),
            at_ms: now_ms,
        });
        if self.undo.len() > MAX_STEPS {
            self.undo.remove(0);
        }
    }

    /// Records a step that belongs to a group (an AI run: DOCUMENT_MODEL §6 groups consecutive transactions
    /// with the same `actor.runId` into one undo step). Unlike coalescing there is no time window: a run may
    /// take minutes between transactions. Any other step recorded in between ends the group.
    pub fn record_group(
        &mut self,
        label: &str,
        forward: Vec<Op>,
        inverse: Vec<Op>,
        group: &str,
        now_ms: u64,
    ) {
        if forward.is_empty() {
            return;
        }
        let key = format!("group:{group}");
        if let Some(last) = self.undo.last_mut()
            && last.coalesce.as_deref() == Some(key.as_str())
        {
            self.redo.clear();
            last.forward.extend(forward);
            let mut inv = inverse;
            inv.append(&mut last.inverse);
            last.inverse = inv;
            last.at_ms = now_ms;
            return;
        }
        self.record(label, forward, inverse, None, now_ms);
        if let Some(last) = self.undo.last_mut() {
            last.coalesce = Some(key);
        }
    }

    /// Ends coalescing: the next edit starts a new step even with the same key.
    pub fn seal(&mut self) {
        if let Some(last) = self.undo.last_mut() {
            last.coalesce = None;
        }
    }

    /// Takes the step to undo.
    pub fn pop_undo(&mut self) -> Option<Step> {
        self.undo.pop()
    }

    /// Takes the step to redo.
    pub fn pop_redo(&mut self) -> Option<Step> {
        self.redo.pop()
    }

    /// Stores an undone step (with refreshed inverse/forward ops) for redo.
    pub fn push_redo(&mut self, step: Step) {
        self.redo.push(step);
    }

    /// Stores a redone step back on the undo stack.
    pub fn push_undo(&mut self, step: Step) {
        self.undo.push(step);
    }

    /// Label of the next undo ("Undo Move").
    pub fn undo_label(&self) -> Option<&str> {
        self.undo.last().map(|s| s.label.as_str())
    }

    /// Label of the next redo.
    pub fn redo_label(&self) -> Option<&str> {
        self.redo.last().map(|s| s.label.as_str())
    }

    /// Whether undo is possible.
    pub fn can_undo(&self) -> bool {
        !self.undo.is_empty()
    }

    /// Whether redo is possible.
    pub fn can_redo(&self) -> bool {
        !self.redo.is_empty()
    }

    /// Number of undo steps.
    pub fn len(&self) -> usize {
        self.undo.len()
    }

    /// No undo steps.
    pub fn is_empty(&self) -> bool {
        self.undo.is_empty()
    }

    /// Labels of the undo stack, newest first (for a history list).
    pub fn labels(&self) -> impl Iterator<Item = &str> {
        self.undo.iter().rev().map(|s| s.label.as_str())
    }

    /// Forgets everything (after loading another document).
    pub fn clear(&mut self) {
        self.undo.clear();
        self.redo.clear();
    }
}

/// A transaction wrapping ops with a fresh id.
pub fn tx(id: String, label: &str, ops: Vec<Op>, ts: f64) -> Transaction {
    let mut t = Transaction::new(id, label, ops);
    t.ts = ts;
    t
}

#[cfg(test)]
mod tests {
    use super::*;

    fn op(id: &str) -> Op {
        Op::delete(id)
    }

    #[test]
    fn coalesces_within_window() {
        let mut h = History::default();
        h.record("Nudge", vec![op("a")], vec![op("ia")], Some("nudge"), 0);
        h.record("Nudge", vec![op("b")], vec![op("ib")], Some("nudge"), 500);
        assert_eq!(h.len(), 1);
        let s = h.pop_undo().unwrap();
        assert_eq!(s.forward, vec![op("a"), op("b")]);
        assert_eq!(
            s.inverse,
            vec![op("ib"), op("ia")],
            "newest change undone first"
        );
    }

    #[test]
    fn seals_and_times_out() {
        let mut h = History::default();
        h.record("Nudge", vec![op("a")], vec![op("ia")], Some("nudge"), 0);
        h.record("Nudge", vec![op("b")], vec![op("ib")], Some("nudge"), 5000);
        assert_eq!(h.len(), 2);
        h.seal();
        h.record("Nudge", vec![op("c")], vec![op("ic")], Some("nudge"), 5100);
        assert_eq!(h.len(), 3);
        assert_eq!(h.undo_label(), Some("Nudge"));
    }

    #[test]
    fn record_clears_redo_and_caps() {
        let mut h = History::default();
        h.record("A", vec![op("a")], vec![op("ia")], None, 0);
        let s = h.pop_undo().unwrap();
        h.push_redo(s);
        assert!(h.can_redo());
        h.record("B", vec![op("b")], vec![op("ib")], None, 0);
        assert!(!h.can_redo());
        for i in 0..(MAX_STEPS + 10) {
            h.record("x", vec![op(&format!("n{i}"))], vec![], None, 0);
        }
        assert_eq!(h.len(), MAX_STEPS);
        h.record("empty", vec![], vec![], None, 0);
        assert_eq!(h.undo_label(), Some("x"), "empty edits are not recorded");
    }
}
