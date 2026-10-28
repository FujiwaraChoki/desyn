//! The client side of the sync protocol (DOCUMENT_MODEL §6), as a pure state machine: `confirmed` (the design at
//! the last server seq) plus `pending` (own transactions the server has not confirmed yet). The editor shows
//! confirmed + pending. A remote transaction is applied to `confirmed` and the pending ones are replayed over it
//! (dropping what no longer applies); the editor receives the difference. An own transaction moves from pending
//! into confirmed with the ops the server applied. Acks for anything but `seq + 1` wait for the `since` echo, so
//! `confirmed` always advances one contiguous seq at a time. Commits are idempotent on `tx.id`, so anything
//! unacknowledged is simply sent again after a reconnect.

use std::collections::VecDeque;

use desyn_core::diff::diff_designs;
use desyn_core::model::{Design, Op, Transaction};
use desyn_core::{ApplyOptions, apply_transaction};
use serde::{Deserialize, Serialize};

use super::wire::RemoteTx;

/// Where a pending transaction is.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum PendingState {
    /// Waiting to be sent.
    Queued,
    /// Sent, no answer yet.
    InFlight,
    /// The server accepted it at `seq`; waiting for the `since` echo to fold it in order.
    Acked {
        /// Assigned seq.
        seq: u64,
        /// Ops the server applied.
        applied: Vec<Op>,
    },
}

/// An own transaction not yet in `confirmed`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Pending {
    /// The transaction (ops as applied locally, or as replayed after a rebase).
    pub tx: Transaction,
    /// State.
    pub state: PendingState,
}

impl Pending {
    /// What this transaction does to the design: the ops the server applied once it was acknowledged (the server
    /// may have dropped some), the local ops before that.
    fn effective(&self) -> Transaction {
        match &self.state {
            PendingState::Acked { applied, .. } => Transaction {
                ops: applied.clone(),
                ..self.tx.clone()
            },
            _ => self.tx.clone(),
        }
    }
}

/// What the driver must do after an input.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Reconcile {
    /// Apply this to the editor (not undoable) so it shows confirmed + pending again.
    pub editor: Option<Transaction>,
    /// Remote transactions folded in, oldest first (for AI highlights and run grouping).
    pub remote: Vec<Transaction>,
    /// The log has a gap: reload the design and call [`SyncEngine::reload`].
    pub reload: bool,
    /// Own transactions the server refused permanently (their changes were reverted in the editor).
    pub rejected: Vec<Transaction>,
}

/// A commit answer.
#[derive(Debug, Clone, PartialEq)]
pub struct CommitOk {
    /// Seq the server assigned.
    pub seq: u64,
    /// Ops the server applied.
    pub applied: Vec<Op>,
    /// Indexes the server dropped.
    pub dropped: usize,
}

/// The sync state of one design.
#[derive(Debug, Clone)]
pub struct SyncEngine {
    confirmed: Design,
    seq: u64,
    pending: VecDeque<Pending>,
}

/// Persistable form (offline cache).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EngineState {
    /// Confirmed seq.
    pub seq: u64,
    /// Pending transactions (in-flight ones are stored as queued: they are resent, idempotently).
    pub pending: Vec<Pending>,
}

fn apply_plain(design: &mut Design, tx: &Transaction) -> Vec<Op> {
    apply_transaction(
        design,
        tx,
        ApplyOptions {
            normalize: false,
            measurer: None,
            inverse_id: None,
        },
    )
    .applied
}

impl SyncEngine {
    /// Starts from a loaded design at `seq`.
    pub fn new(confirmed: Design, seq: u64) -> SyncEngine {
        SyncEngine {
            confirmed,
            seq,
            pending: VecDeque::new(),
        }
    }

    /// Restores from the offline cache.
    pub fn restore(confirmed: Design, state: EngineState) -> SyncEngine {
        SyncEngine {
            confirmed,
            seq: state.seq,
            pending: state
                .pending
                .into_iter()
                .map(|mut p| {
                    if p.state == PendingState::InFlight {
                        p.state = PendingState::Queued;
                    }
                    p
                })
                .collect(),
        }
    }

    /// Persistable state.
    pub fn state(&self) -> EngineState {
        EngineState {
            seq: self.seq,
            pending: self.pending.iter().cloned().collect(),
        }
    }

    /// The design at the last confirmed seq.
    pub fn confirmed(&self) -> &Design {
        &self.confirmed
    }

    /// Last confirmed seq.
    pub fn seq(&self) -> u64 {
        self.seq
    }

    /// Own transactions not yet confirmed.
    pub fn pending(&self) -> impl Iterator<Item = &Pending> {
        self.pending.iter()
    }

    /// Number of own transactions not yet confirmed.
    pub fn pending_len(&self) -> usize {
        self.pending.len()
    }

    /// Nothing waiting to be sent or confirmed.
    pub fn is_idle(&self) -> bool {
        self.pending.is_empty()
    }

    /// confirmed + pending (what the editor should show).
    pub fn view(&self) -> Design {
        let mut d = self.confirmed.clone();
        for p in &self.pending {
            apply_plain(&mut d, &p.effective());
        }
        d
    }

    /// Re-attaches a local file to its cloud design after it was closed (or edited offline). `base` is the
    /// design as last confirmed by the server (the offline cache), `server` / `seq` the current server state and
    /// `local` what the file holds. The user's own changes since `base` are replayed over the server state as one
    /// pending transaction, so edits collaborators made meanwhile are kept. Without a base the local file wins.
    /// Returns the engine and the transaction that turns `local` into confirmed + pending (for the editor).
    pub fn reattach(
        base: Option<&Design>,
        server: Design,
        seq: u64,
        local: &Design,
        tx_id: String,
    ) -> (SyncEngine, Option<Transaction>) {
        let base = base.unwrap_or(&server);
        let offline = diff_designs(base, local, tx_id);
        let mut target = server.clone();
        let applied = apply_plain(&mut target, &offline);
        let mut engine = SyncEngine::new(server, seq);
        engine.local(Transaction {
            label: "Offline changes".into(),
            ops: applied,
            source: desyn_core::model::TxSource::User,
            ..offline
        });
        let editor = diff_designs(
            local,
            &target,
            desyn_core::ops::inverse_tx_id(&format!("reattach:{seq}")),
        );
        let editor = (!editor.ops.is_empty()).then(|| Transaction {
            label: "Sync".into(),
            ..editor
        });
        (engine, editor)
    }

    /// A local edit (already applied in the editor). Empty transactions are ignored.
    pub fn local(&mut self, tx: Transaction) {
        if tx.ops.is_empty() {
            return;
        }
        self.pending.push_back(Pending {
            tx,
            state: PendingState::Queued,
        });
    }

    /// The next transaction to send (one at a time, in order) with the base seq; marks it in flight.
    pub fn next_to_send(&mut self) -> Option<(Transaction, u64)> {
        if self
            .pending
            .iter()
            .any(|p| p.state == PendingState::InFlight)
        {
            return None;
        }
        let seq = self.seq;
        let p = self
            .pending
            .iter_mut()
            .find(|p| p.state == PendingState::Queued)?;
        p.state = PendingState::InFlight;
        Some((p.tx.clone(), seq))
    }

    /// Something is in flight.
    pub fn in_flight(&self) -> bool {
        self.pending
            .iter()
            .any(|p| p.state == PendingState::InFlight)
    }

    /// The connection dropped: everything in flight is sent again later (commits are idempotent).
    pub fn disconnected(&mut self) {
        for p in &mut self.pending {
            if p.state == PendingState::InFlight {
                p.state = PendingState::Queued;
            }
        }
    }

    /// The server accepted `tx_id`.
    pub fn commit_ok(&mut self, tx_id: &str, ok: CommitOk, view: &Design) -> Reconcile {
        let Some(i) = self.pending.iter().position(|p| p.tx.id == tx_id) else {
            // Already folded in through the since echo.
            return Reconcile::default();
        };
        if ok.seq <= self.seq {
            // A duplicate answer for something confirmed meanwhile.
            self.pending.remove(i);
            return Reconcile::default();
        }
        let diverged = ok.dropped > 0 || ok.applied != self.pending[i].tx.ops;
        self.pending[i].state = PendingState::Acked {
            seq: ok.seq,
            applied: ok.applied,
        };
        self.fold_acked();
        let mut r = Reconcile::default();
        if diverged {
            r.editor = self.rebase(view);
        }
        r
    }

    /// The commit of `tx_id` failed. Transient errors resend later; permanent ones drop the transaction and
    /// revert it in the editor.
    pub fn commit_failed(&mut self, tx_id: &str, transient: bool, view: &Design) -> Reconcile {
        let Some(i) = self.pending.iter().position(|p| p.tx.id == tx_id) else {
            return Reconcile::default();
        };
        if transient {
            self.pending[i].state = PendingState::Queued;
            return Reconcile::default();
        }
        let p = self.pending.remove(i).expect("index");
        Reconcile {
            editor: self.rebase(view),
            rejected: vec![p.tx],
            ..Default::default()
        }
    }

    /// Folds acked transactions whose seq is next in line.
    fn fold_acked(&mut self) {
        loop {
            let next = self.seq + 1;
            let Some(i) = self
                .pending
                .iter()
                .position(|p| matches!(&p.state, PendingState::Acked { seq, .. } if *seq == next))
            else {
                break;
            };
            let p = self.pending.remove(i).expect("index");
            if let PendingState::Acked { applied, .. } = p.state {
                let tx = Transaction {
                    ops: applied,
                    ..p.tx
                };
                apply_plain(&mut self.confirmed, &tx);
            }
            self.seq = next;
        }
    }

    /// Entries from `designOps.since` (oldest first).
    pub fn remote(&mut self, entries: &[RemoteTx], view: &Design) -> Reconcile {
        let mut r = Reconcile::default();
        let mut needs_rebase = false;
        let mut direct: Vec<Transaction> = Vec::new();
        for e in entries {
            if e.seq <= self.seq {
                continue;
            }
            if e.seq != self.seq + 1 {
                r.reload = true;
                break;
            }
            match self.pending.iter().position(|p| p.tx.id == e.tx.id) {
                Some(i) => {
                    let p = self.pending.remove(i).expect("index");
                    if p.tx.ops != e.tx.ops || i != 0 {
                        needs_rebase = true;
                    }
                    apply_plain(&mut self.confirmed, &e.tx);
                }
                None => {
                    apply_plain(&mut self.confirmed, &e.tx);
                    if self.pending.is_empty() && !needs_rebase {
                        direct.push(e.tx.clone());
                    } else {
                        needs_rebase = true;
                    }
                    r.remote.push(e.tx.clone());
                }
            }
            self.seq = e.seq;
            self.fold_acked();
        }
        if needs_rebase {
            r.editor = self.rebase(view);
        } else if !direct.is_empty() {
            r.editor = Some(if direct.len() == 1 {
                direct.pop().expect("one")
            } else {
                let mut ops = Vec::new();
                for t in &direct {
                    ops.extend(t.ops.iter().cloned());
                }
                Transaction {
                    ops,
                    ..direct[direct.len() - 1].clone()
                }
            });
        }
        r
    }

    /// A full reload after a gap (or on reconnect with a stale cache).
    pub fn reload(&mut self, design: Design, seq: u64, view: &Design) -> Reconcile {
        self.confirmed = design;
        self.seq = seq;
        self.pending
            .retain(|p| !matches!(&p.state, PendingState::Acked { seq: s, .. } if *s <= seq));
        Reconcile {
            editor: self.rebase(view),
            ..Default::default()
        }
    }

    /// Replays pending over confirmed and returns the transaction that turns `view` into the result.
    fn rebase(&mut self, view: &Design) -> Option<Transaction> {
        let mut target = self.confirmed.clone();
        for p in self.pending.iter_mut() {
            let applied = apply_plain(&mut target, &p.effective());
            if !matches!(p.state, PendingState::Acked { .. }) {
                p.tx.ops = applied;
            }
        }
        self.pending
            .retain(|p| !(p.tx.ops.is_empty() && !matches!(p.state, PendingState::Acked { .. })));
        let tx = diff_designs(
            view,
            &target,
            desyn_core::ops::inverse_tx_id(&format!("rebase:{}", self.seq)),
        );
        (!tx.ops.is_empty()).then(|| Transaction {
            label: "Sync".into(),
            ..tx
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use desyn_core::model::{DesignKind, Node, TxSource};
    use serde_json::{Map, json};

    /// A fake Convex: the authoritative design and the transaction log.
    struct Server {
        design: Design,
        log: Vec<(u64, Transaction)>,
    }

    impl Server {
        fn new(d: &Design) -> Server {
            Server {
                design: d.clone(),
                log: Vec::new(),
            }
        }

        /// `designs.commit`: applies to the current state, idempotent on tx id.
        fn commit(&mut self, tx: &Transaction) -> CommitOk {
            if let Some((seq, t)) = self.log.iter().find(|(_, t)| t.id == tx.id) {
                return CommitOk {
                    seq: *seq,
                    applied: t.ops.clone(),
                    dropped: 0,
                };
            }
            let res = apply_transaction(&mut self.design, tx, ApplyOptions::default());
            let seq = self.log.len() as u64 + 1;
            let accepted = Transaction {
                ops: res.applied.clone(),
                ..tx.clone()
            };
            self.log.push((seq, accepted));
            CommitOk {
                seq,
                applied: res.applied,
                dropped: res.dropped.len(),
            }
        }

        fn since(&self, seq: u64) -> Vec<RemoteTx> {
            self.log
                .iter()
                .filter(|(s, _)| *s > seq)
                .map(|(s, t)| RemoteTx {
                    seq: *s,
                    tx: t.clone(),
                })
                .collect()
        }
    }

    /// A client: the editor's document (view) and its engine.
    struct Client {
        view: Design,
        engine: SyncEngine,
        n: u32,
        name: &'static str,
    }

    impl Client {
        fn new(d: &Design, name: &'static str) -> Client {
            Client {
                view: d.clone(),
                engine: SyncEngine::new(d.clone(), 0),
                n: 0,
                name,
            }
        }

        fn edit(&mut self, ops: Vec<Op>) -> Transaction {
            self.n += 1;
            let tx = Transaction {
                id: format!("{}{:010}", &self.name[..2], self.n),
                label: "edit".into(),
                ops,
                source: TxSource::User,
                actor: None,
                ts: 0.0,
            };
            let applied = apply_plain(&mut self.view, &tx);
            let applied_tx = Transaction { ops: applied, ..tx };
            self.engine.local(applied_tx.clone());
            applied_tx
        }

        fn apply(&mut self, r: Reconcile) {
            if let Some(tx) = r.editor {
                apply_plain(&mut self.view, &tx);
            }
        }

        fn send(&mut self, server: &mut Server) {
            while let Some((tx, _base)) = self.engine.next_to_send() {
                let ok = server.commit(&tx);
                let view = self.view.clone();
                let r = self.engine.commit_ok(&tx.id, ok, &view);
                self.apply(r);
            }
        }

        fn pull(&mut self, server: &Server) {
            let entries = server.since(self.engine.seq());
            let view = self.view.clone();
            let r = self.engine.remote(&entries, &view);
            assert!(!r.reload);
            self.apply(r);
        }
    }

    fn base() -> Design {
        let mut d = Design::with_page(
            "design000001",
            "Test",
            DesignKind::Poster,
            "page00000001",
            500.0,
            500.0,
        );
        for (id, x) in [("rect00000001", 10.0), ("rect00000002", 200.0)] {
            d.push_child("page00000001", Node::rect(id, "Box", x, 10.0, 50.0, 50.0));
        }
        d
    }

    fn set(id: &str, k: &str, v: serde_json::Value) -> Op {
        let mut m = Map::new();
        m.insert(k.into(), v);
        Op::update_set(id, m)
    }

    fn x_of(d: &Design, id: &str) -> f64 {
        d.node(id).unwrap().base().x
    }

    #[test]
    fn own_commit_is_confirmed_without_touching_the_editor() {
        let d = base();
        let mut server = Server::new(&d);
        let mut a = Client::new(&d, "aa");
        a.edit(vec![set("rect00000001", "x", json!(42.0))]);
        assert_eq!(a.engine.pending_len(), 1);
        let (tx, base_seq) = a.engine.next_to_send().unwrap();
        assert_eq!(base_seq, 0);
        assert!(a.engine.next_to_send().is_none(), "one in flight at a time");
        let ok = server.commit(&tx);
        let view = a.view.clone();
        let r = a.engine.commit_ok(&tx.id, ok, &view);
        assert_eq!(r.editor, None);
        assert_eq!(a.engine.seq(), 1);
        assert!(a.engine.is_idle());
        assert_eq!(x_of(a.engine.confirmed(), "rect00000001"), 42.0);
        // The echo arrives later and is ignored.
        a.pull(&server);
        assert_eq!(a.engine.seq(), 1);
    }

    #[test]
    fn remote_change_rebases_pending_edits() {
        let d = base();
        let mut server = Server::new(&d);
        let mut a = Client::new(&d, "aa");
        let mut b = Client::new(&d, "bb");
        // A moves rect 1 (not yet sent); B changes rect 1's name and moves rect 2, and commits first.
        a.edit(vec![set("rect00000001", "x", json!(100.0))]);
        b.edit(vec![
            set("rect00000001", "name", json!("Hero")),
            set("rect00000002", "x", json!(300.0)),
        ]);
        b.send(&mut server);
        a.pull(&server);
        // A shows B's change and keeps its own pending move.
        assert_eq!(a.view.node("rect00000001").unwrap().base().name, "Hero");
        assert_eq!(x_of(&a.view, "rect00000001"), 100.0);
        assert_eq!(x_of(&a.view, "rect00000002"), 300.0);
        assert_eq!(a.engine.pending_len(), 1);
        a.send(&mut server);
        b.pull(&server);
        // Everyone converges on the server state.
        assert_eq!(a.view.canonical_json(), server.design.canonical_json());
        assert_eq!(b.view.canonical_json(), server.design.canonical_json());
        assert_eq!(
            a.engine.confirmed().canonical_json(),
            server.design.canonical_json()
        );
    }

    #[test]
    fn concurrent_edits_of_the_same_property_converge_to_server_order() {
        let d = base();
        let mut server = Server::new(&d);
        let mut a = Client::new(&d, "aa");
        let mut b = Client::new(&d, "bb");
        a.edit(vec![set("rect00000001", "x", json!(1.0))]);
        b.edit(vec![set("rect00000001", "x", json!(2.0))]);
        a.send(&mut server);
        b.send(&mut server); // B's commit lands last: last writer wins.
        a.pull(&server);
        b.pull(&server);
        assert_eq!(x_of(&server.design, "rect00000001"), 2.0);
        assert_eq!(x_of(&a.view, "rect00000001"), 2.0);
        assert_eq!(x_of(&b.view, "rect00000001"), 2.0);
    }

    #[test]
    fn pending_edit_of_a_node_deleted_remotely_is_dropped() {
        let d = base();
        let mut server = Server::new(&d);
        let mut a = Client::new(&d, "aa");
        let mut b = Client::new(&d, "bb");
        a.edit(vec![set("rect00000002", "x", json!(5.0))]);
        b.edit(vec![Op::delete("rect00000002")]);
        b.send(&mut server);
        a.pull(&server);
        assert!(a.view.node("rect00000002").is_none());
        assert!(a.engine.is_idle(), "the edit no longer applies");
        a.send(&mut server);
        assert_eq!(server.log.len(), 1);
    }

    #[test]
    fn reconnect_resends_and_duplicates_are_harmless() {
        let d = base();
        let mut server = Server::new(&d);
        let mut a = Client::new(&d, "aa");
        a.edit(vec![set("rect00000001", "x", json!(77.0))]);
        let (tx, _) = a.engine.next_to_send().unwrap();
        // The server got it, but the answer was lost when the connection dropped.
        server.commit(&tx);
        a.engine.disconnected();
        // While offline the user keeps editing.
        a.edit(vec![set("rect00000002", "x", json!(88.0))]);
        // Reconnected: both are sent again; the first is a duplicate answer with its original seq.
        a.send(&mut server);
        a.pull(&server);
        assert!(a.engine.is_idle());
        assert_eq!(a.engine.seq(), 2);
        assert_eq!(server.log.len(), 2);
        assert_eq!(a.view.canonical_json(), server.design.canonical_json());
    }

    #[test]
    fn out_of_order_ack_waits_for_the_echo() {
        let d = base();
        let mut server = Server::new(&d);
        let mut a = Client::new(&d, "aa");
        let mut b = Client::new(&d, "bb");
        b.edit(vec![set("rect00000002", "name", json!("B"))]);
        b.send(&mut server); // seq 1, A has not seen it
        a.edit(vec![set("rect00000001", "name", json!("A"))]);
        a.send(&mut server); // A's ack says seq 2
        assert_eq!(a.engine.seq(), 0, "seq 1 is still missing");
        assert_eq!(a.engine.pending_len(), 1);
        a.pull(&server);
        assert_eq!(a.engine.seq(), 2);
        assert!(a.engine.is_idle());
        assert_eq!(a.view.canonical_json(), server.design.canonical_json());
    }

    #[test]
    fn gap_requests_a_reload_that_keeps_pending_edits() {
        let d = base();
        let mut server = Server::new(&d);
        let mut a = Client::new(&d, "aa");
        let mut b = Client::new(&d, "bb");
        for i in 0..3 {
            b.edit(vec![set("rect00000002", "x", json!(i as f64))]);
        }
        b.send(&mut server);
        a.edit(vec![set("rect00000001", "name", json!("Mine"))]);
        // The log before seq 3 was compacted: only seq 3 is left.
        let entries: Vec<RemoteTx> = server.since(2);
        let view = a.view.clone();
        let r = a.engine.remote(&entries, &view);
        assert!(r.reload);
        let view = a.view.clone();
        let r = a.engine.reload(server.design.clone(), 3, &view);
        a.apply(r);
        assert_eq!(x_of(&a.view, "rect00000002"), 2.0);
        assert_eq!(a.view.node("rect00000001").unwrap().base().name, "Mine");
        a.send(&mut server);
        assert_eq!(a.view.canonical_json(), server.design.canonical_json());
    }

    #[test]
    fn permanent_failure_reverts_the_edit() {
        let d = base();
        let mut a = Client::new(&d, "aa");
        let tx = a.edit(vec![set("rect00000001", "x", json!(999.0))]);
        a.engine.next_to_send();
        let view = a.view.clone();
        let r = a.engine.commit_failed(&tx.id, false, &view);
        assert_eq!(r.rejected.len(), 1);
        a.apply(r);
        assert_eq!(x_of(&a.view, "rect00000001"), 10.0);
        // A transient failure keeps it queued.
        let tx2 = a.edit(vec![set("rect00000001", "x", json!(5.0))]);
        a.engine.next_to_send();
        let view = a.view.clone();
        let r = a.engine.commit_failed(&tx2.id, true, &view);
        assert_eq!(r, Reconcile::default());
        assert_eq!(a.engine.next_to_send().unwrap().0.id, tx2.id);
    }

    #[test]
    fn reattaching_a_linked_file_keeps_collaborators_changes() {
        // Last sync: both clients saw `base`. The file was then edited offline (rect 1 moved) while a
        // collaborator renamed rect 2 and moved rect 1's sibling on the server.
        let d = base();
        let mut server = Server::new(&d);
        let mut b = Client::new(&d, "bb");
        b.edit(vec![
            set("rect00000002", "name", json!("Theirs")),
            set("rect00000002", "x", json!(321.0)),
        ]);
        b.send(&mut server);
        let mut local = d.clone();
        apply_plain(
            &mut local,
            &Transaction::new(
                "file00000001",
                "edit",
                vec![set("rect00000001", "x", json!(64.0))],
            ),
        );
        let (mut engine, editor) = SyncEngine::reattach(
            Some(&d),
            server.design.clone(),
            1,
            &local,
            "tx0000000077".into(),
        );
        let mut view = local.clone();
        apply_plain(&mut view, &editor.expect("the editor catches up"));
        // The editor shows both: the collaborator's edits and the offline move.
        assert_eq!(view.node("rect00000002").unwrap().base().name, "Theirs");
        assert_eq!(x_of(&view, "rect00000002"), 321.0);
        assert_eq!(x_of(&view, "rect00000001"), 64.0);
        assert_eq!(view.canonical_json(), engine.view().canonical_json());
        // Only the offline move is sent.
        let (tx, base_seq) = engine.next_to_send().unwrap();
        assert_eq!(base_seq, 1);
        assert_eq!(tx.ops, vec![set("rect00000001", "x", json!(64.0))]);
        let ok = server.commit(&tx);
        let r = engine.commit_ok(&tx.id, ok, &view);
        assert_eq!(r.editor, None);
        assert_eq!(view.canonical_json(), server.design.canonical_json());

        // Without a cached base the file wins (nothing else to go by).
        let (engine, _) =
            SyncEngine::reattach(None, server.design.clone(), 2, &d, "tx0000000078".into());
        assert_eq!(x_of(&engine.view(), "rect00000002"), 200.0);
    }

    #[test]
    fn acked_commit_with_dropped_ops_shows_only_what_the_server_applied() {
        let d = base();
        let mut a = Client::new(&d, "aa");
        // A remote commit at seq 1 the client has not seen yet, then the client's own commit acked at seq 2
        // with its second op dropped.
        let tx = a.edit(vec![
            set("rect00000001", "x", json!(11.0)),
            set("rect00000002", "x", json!(22.0)),
        ]);
        a.engine.next_to_send();
        let view = a.view.clone();
        let r = a.engine.commit_ok(
            &tx.id,
            CommitOk {
                seq: 2,
                applied: vec![set("rect00000001", "x", json!(11.0))],
                dropped: 1,
            },
            &view,
        );
        a.apply(r);
        assert_eq!(x_of(&a.view, "rect00000001"), 11.0);
        assert_eq!(
            x_of(&a.view, "rect00000002"),
            200.0,
            "the dropped op is reverted at once"
        );
        assert_eq!(a.view.canonical_json(), a.engine.view().canonical_json());
    }

    #[test]
    fn state_roundtrip_requeues_in_flight() {
        let d = base();
        let mut a = Client::new(&d, "aa");
        a.edit(vec![set("rect00000001", "x", json!(3.0))]);
        a.engine.next_to_send();
        let st = a.engine.state();
        let json = serde_json::to_string(&st).unwrap();
        let back: EngineState = serde_json::from_str(&json).unwrap();
        let mut e = SyncEngine::restore(d.clone(), back);
        assert_eq!(e.pending_len(), 1);
        assert!(e.next_to_send().is_some());
        assert_eq!(x_of(&e.view(), "rect00000001"), 3.0);
    }
}
