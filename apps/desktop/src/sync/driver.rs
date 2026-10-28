//! The sync loop of one cloud design: feeds local edits, commit answers and `designOps.since` results into the
//! [`SyncEngine`], sends commits one at a time, resubscribes as the seq advances, reloads after a gap and retries
//! with backoff while offline. It is generic over the transport (Convex in the app, a fake server in tests) and the
//! view (the editor in the app), and runs on whatever executor polls it.

use std::cell::RefCell;
use std::rc::Rc;
use std::time::Duration;

use desyn_core::model::{Design, Transaction};
use futures::channel::mpsc;
use futures::future::{Fuse, FusedFuture, FutureExt, LocalBoxFuture};
use futures::stream::{LocalBoxStream, StreamExt};
use futures::{pin_mut, select_biased};

use super::engine::{CommitOk, EngineState, Reconcile, SyncEngine};
use super::wire::{self, RemoteTx};
use crate::cloud::CloudError;
use crate::cloud::api::{CommitResult, Since};

/// The server side of the protocol.
pub trait Transport {
    /// `designs.commit({ designId, baseSeq, tx })`.
    fn commit(
        &self,
        tx_json: String,
        base_seq: u64,
    ) -> LocalBoxFuture<'static, Result<CommitResult, CloudError>>;
    /// `designs.load` (all pages assembled).
    fn load(&self) -> LocalBoxFuture<'static, Result<(Design, u64), CloudError>>;
    /// Live `designOps.since({ seq })` results.
    fn since(&self, seq: u64) -> LocalBoxStream<'static, Result<Since, CloudError>>;
    /// A timer.
    fn sleep(&self, d: Duration) -> LocalBoxFuture<'static, ()>;
}

/// What the loop tells the editor.
pub trait View {
    /// The design the editor shows now.
    fn design(&self) -> Option<Design>;
    /// Applies a remote / rebase transaction (`undoable` for the user's own AI runs).
    fn apply(&mut self, tx: &Transaction, undoable: bool);
    /// Remote transactions that were folded in (highlights, AI grouping).
    fn remote_applied(&mut self, _txs: &[Transaction]) {}
    /// New sync status.
    fn status(&mut self, status: Status);
    /// Persist (offline cache) after a change of confirmed / pending.
    fn persist(&mut self, confirmed: &Design, state: &EngineState);
    /// The server refused own changes permanently (they were reverted).
    fn rejected(&mut self, _txs: &[Transaction], _error: &CloudError) {}
    /// Decides whether a remote transaction is undoable here (the user's own AI run).
    fn undoable(&self, _tx: &Transaction) -> bool {
        false
    }
}

/// Sync status for the UI.
#[derive(Debug, Clone, PartialEq)]
pub enum Status {
    /// Loading / catching up.
    Connecting,
    /// Everything confirmed.
    Synced,
    /// Sending changes.
    Syncing(usize),
    /// Offline with this many changes kept locally.
    Offline(usize),
    /// Permanently failing (message).
    Error(String),
}

/// Inputs from the app.
#[derive(Debug, Clone)]
pub enum Input {
    /// A local edit (applied ops).
    Local(Transaction),
    /// Connectivity came back (retry now).
    Online,
    /// Stop the loop (tab closed).
    Stop,
}

/// Reports the status to the view.
type Report<V> = dyn Fn(&SyncEngine, bool, &Rc<RefCell<V>>);

/// Retry delays while offline.
pub const BACKOFF: [u64; 6] = [500, 1_000, 2_000, 5_000, 10_000, 20_000];

/// Resubscribe after this many entries arrived on one subscription.
const RESUBSCRIBE_AFTER: u64 = 100;

/// Runs until [`Input::Stop`] or the input channel closes.
pub async fn run<T: Transport, V: View>(
    engine: Rc<RefCell<SyncEngine>>,
    transport: T,
    view: Rc<RefCell<V>>,
    mut inputs: mpsc::UnboundedReceiver<Input>,
) {
    let mut sub_seq = engine.borrow().seq();
    let mut since = transport.since(sub_seq).fuse();
    let mut commit: Fuse<LocalBoxFuture<'static, (String, Result<CommitResult, CloudError>)>> =
        Fuse::terminated();
    let mut retry: Fuse<LocalBoxFuture<'static, ()>> = Fuse::terminated();
    let mut resub: Fuse<LocalBoxFuture<'static, ()>> = Fuse::terminated();
    let mut reload: Fuse<LocalBoxFuture<'static, Result<(Design, u64), CloudError>>> =
        Fuse::terminated();
    let mut reload_retry: Fuse<LocalBoxFuture<'static, ()>> = Fuse::terminated();
    let mut failures = 0usize;
    let mut offline = false;

    let report = |engine: &SyncEngine, offline: bool, view: &Rc<RefCell<V>>| {
        let n = engine.pending_len();
        let s = if offline {
            Status::Offline(n)
        } else if n == 0 {
            Status::Synced
        } else {
            Status::Syncing(n)
        };
        view.borrow_mut().status(s);
    };
    let backoff = |failures: usize| Duration::from_millis(BACKOFF[failures.min(BACKOFF.len() - 1)]);
    view.borrow_mut().status(Status::Connecting);

    loop {
        // Send the next commit when nothing is in flight.
        if commit.is_terminated() && retry.is_terminated() && reload.is_terminated() {
            let next = engine.borrow_mut().next_to_send();
            if let Some((tx, base)) = next {
                let id = tx.id.clone();
                let f = transport.commit(wire::encode_tx(&tx), base);
                commit = async move { (id, f.await) }.boxed_local().fuse();
                if !offline {
                    report(&engine.borrow(), offline, &view);
                }
            }
        }
        let event = {
            let inputs_next = inputs.next().fuse();
            pin_mut!(inputs_next);
            select_biased! {
                i = inputs_next => Event::Input(i),
                r = commit => Event::Commit(r.0, r.1),
                s = since.next() => Event::Since(s),
                r = reload => Event::Reload(Box::new(r)),
                _ = retry => Event::Retry,
                _ = resub => Event::Resubscribe,
                _ = reload_retry => Event::ReloadRetry,
            }
        };
        match event {
            Event::Input(None) | Event::Input(Some(Input::Stop)) => break,
            Event::Input(Some(Input::Local(tx))) => {
                engine.borrow_mut().local(tx);
                persist(&engine, &view);
                report(&engine.borrow(), offline, &view);
            }
            Event::Input(Some(Input::Online)) => {
                if offline {
                    failures = 0;
                    retry = Fuse::terminated();
                    resub = Fuse::terminated();
                    sub_seq = engine.borrow().seq();
                    since = transport.since(sub_seq).fuse();
                }
            }
            Event::Commit(id, res) => match res {
                Ok(c) => {
                    // The server answered: we are online again even before the subscription delivers.
                    failures = 0;
                    if offline {
                        offline = false;
                        retry = Fuse::terminated();
                    }
                    let ok = CommitOk {
                        seq: c.seq,
                        applied: wire::decode_ops(&c.applied).unwrap_or_default(),
                        dropped: c.dropped.len(),
                    };
                    let Some(v) = view.borrow().design() else {
                        break;
                    };
                    let r = engine.borrow_mut().commit_ok(&id, ok, &v);
                    apply(&view, r, None);
                    persist(&engine, &view);
                    report(&engine.borrow(), offline, &view);
                }
                Err(e) => {
                    let transient = e.is_transient();
                    let Some(v) = view.borrow().design() else {
                        break;
                    };
                    let r = engine.borrow_mut().commit_failed(&id, transient, &v);
                    if transient {
                        offline = true;
                        failures += 1;
                        retry = transport.sleep(backoff(failures - 1)).fuse();
                        report(&engine.borrow(), offline, &view);
                    } else {
                        apply(&view, r, Some(&e));
                        persist(&engine, &view);
                        if e.is_auth() {
                            view.borrow_mut().status(Status::Error(e.friendly()));
                        } else {
                            report(&engine.borrow(), offline, &view);
                        }
                    }
                }
            },
            Event::Since(None) => {
                lost(
                    &engine,
                    &view,
                    &mut offline,
                    &mut since,
                    &mut resub,
                    &mut failures,
                    &transport,
                    &report,
                    &backoff,
                );
            }
            Event::Since(Some(Err(e))) if e.is_transient() => {
                lost(
                    &engine,
                    &view,
                    &mut offline,
                    &mut since,
                    &mut resub,
                    &mut failures,
                    &transport,
                    &report,
                    &backoff,
                );
            }
            Event::Since(Some(Err(e))) => {
                view.borrow_mut().status(Status::Error(e.friendly()));
                // Local edits stay pending and cached; nothing more to receive.
                since = futures::stream::pending().boxed_local().fuse();
            }
            Event::Since(Some(Ok(s))) => {
                if offline {
                    offline = false;
                    failures = 0;
                    retry = Fuse::terminated();
                }
                let entries: Vec<RemoteTx> = wire::decode_entries(&s.ops);
                let Some(v) = view.borrow().design() else {
                    break;
                };
                let r = engine.borrow_mut().remote(&entries, &v);
                let need_reload = r.reload || (s.gap && entries.is_empty());
                apply(&view, r, None);
                if need_reload {
                    if reload.is_terminated() {
                        reload = transport.load().fuse();
                    }
                } else {
                    let seq = engine.borrow().seq();
                    if s.has_more || seq >= sub_seq + RESUBSCRIBE_AFTER {
                        sub_seq = seq;
                        since = transport.since(sub_seq).fuse();
                    }
                }
                persist(&engine, &view);
                report(&engine.borrow(), offline, &view);
            }
            Event::Reload(res) => match *res {
                Ok((design, seq)) => {
                    let Some(v) = view.borrow().design() else {
                        break;
                    };
                    let r = engine.borrow_mut().reload(design, seq, &v);
                    apply(&view, r, None);
                    sub_seq = seq;
                    since = transport.since(seq).fuse();
                    persist(&engine, &view);
                    report(&engine.borrow(), offline, &view);
                }
                Err(e) => {
                    offline = e.is_transient();
                    report(&engine.borrow(), offline, &view);
                    reload_retry = transport.sleep(backoff(failures)).fuse();
                    failures += 1;
                }
            },
            Event::Retry => {
                // The engine re-queued the failed commit; the top of the loop sends it again.
            }
            Event::Resubscribe => {
                sub_seq = engine.borrow().seq();
                since = transport.since(sub_seq).fuse();
            }
            Event::ReloadRetry => {
                reload = transport.load().fuse();
            }
        }
    }
}

/// The subscription ended or failed (connection lost): mark offline and resubscribe after a pause.
#[allow(clippy::too_many_arguments)]
fn lost<T: Transport, V: View>(
    engine: &Rc<RefCell<SyncEngine>>,
    view: &Rc<RefCell<V>>,
    offline: &mut bool,
    since: &mut futures::stream::Fuse<LocalBoxStream<'static, Result<Since, CloudError>>>,
    resub: &mut Fuse<LocalBoxFuture<'static, ()>>,
    failures: &mut usize,
    transport: &T,
    report: &Report<V>,
    backoff: &dyn Fn(usize) -> Duration,
) {
    *offline = true;
    engine.borrow_mut().disconnected();
    report(&engine.borrow(), true, view);
    *since = futures::stream::pending().boxed_local().fuse();
    *resub = transport.sleep(backoff(*failures)).fuse();
    *failures += 1;
}

enum Event {
    Input(Option<Input>),
    Commit(String, Result<CommitResult, CloudError>),
    Since(Option<Result<Since, CloudError>>),
    Reload(Box<Result<(Design, u64), CloudError>>),
    Retry,
    Resubscribe,
    ReloadRetry,
}

fn apply<V: View>(view: &Rc<RefCell<V>>, r: Reconcile, error: Option<&CloudError>) {
    let mut v = view.borrow_mut();
    if let Some(tx) = &r.editor {
        let undoable = r.remote.len() == 1 && r.remote[0].id == tx.id && v.undoable(tx);
        v.apply(tx, undoable);
    }
    if !r.remote.is_empty() {
        v.remote_applied(&r.remote);
    }
    if !r.rejected.is_empty()
        && let Some(e) = error
    {
        v.rejected(&r.rejected, e);
    }
}

fn persist<V: View>(engine: &Rc<RefCell<SyncEngine>>, view: &Rc<RefCell<V>>) {
    let e = engine.borrow();
    view.borrow_mut().persist(e.confirmed(), &e.state());
}

#[cfg(test)]
mod tests {
    use super::*;
    use desyn_core::model::{DesignKind, Node, Op, TxSource};
    use desyn_core::{ApplyOptions, apply_transaction};
    use futures::executor::LocalPool;
    use futures::task::LocalSpawnExt;
    use serde_json::{Map, json};
    use std::cell::Cell;

    type SinceSender = mpsc::UnboundedSender<Result<Since, CloudError>>;
    type Setup = (
        LocalPool,
        Rc<FakeServer>,
        Rc<RefCell<FakeView>>,
        Rc<RefCell<SyncEngine>>,
        mpsc::UnboundedSender<Input>,
    );

    /// A fake Convex deployment: authoritative design, log, live `since` subscribers and a switch to go offline.
    #[derive(Default)]
    struct FakeServer {
        design: RefCell<Option<Design>>,
        log: RefCell<Vec<(u64, Transaction)>>,
        subscribers: RefCell<Vec<(u64, SinceSender)>>,
        offline: Cell<bool>,
        commits: Cell<usize>,
        /// Drop the answer of the next commit (it is applied, but the client sees a network error).
        lose_next_answer: Cell<bool>,
    }

    impl FakeServer {
        fn commit(&self, json: &str) -> Result<CommitResult, CloudError> {
            if self.offline.get() {
                return Err(CloudError::network("offline"));
            }
            self.commits.set(self.commits.get() + 1);
            let tx = wire::decode_tx(json).unwrap();
            if let Some((seq, t)) = self.log.borrow().iter().find(|(_, t)| t.id == tx.id) {
                return Ok(CommitResult {
                    seq: *seq,
                    applied: serde_json::to_string(&t.ops).unwrap(),
                    dropped: vec![],
                    duplicate: true,
                });
            }
            let mut d = self.design.borrow_mut();
            let res = apply_transaction(d.as_mut().unwrap(), &tx, ApplyOptions::default());
            let seq = self.log.borrow().len() as u64 + 1;
            let accepted = Transaction {
                ops: res.applied.clone(),
                ..tx
            };
            self.log.borrow_mut().push((seq, accepted));
            drop(d);
            let lose = self.lose_next_answer.replace(false);
            if lose {
                // The connection reset right after the server applied it: the answer and the subscriptions are
                // lost, so the client only learns about it by sending again.
                self.subscribers.borrow_mut().clear();
            }
            self.publish();
            if lose {
                return Err(CloudError::network("connection reset"));
            }
            Ok(CommitResult {
                seq,
                applied: serde_json::to_string(&res.applied).unwrap(),
                dropped: vec![],
                duplicate: false,
            })
        }

        fn since_result(&self, seq: u64) -> Since {
            let ops = self
                .log
                .borrow()
                .iter()
                .filter(|(s, _)| *s > seq)
                .map(|(s, t)| crate::cloud::api::OpEntry {
                    seq: *s,
                    tx_id: t.id.clone(),
                    tx: wire::encode_tx(t),
                    actor: None,
                    source: "user".into(),
                    ts: 0.0,
                })
                .collect();
            Since {
                ops,
                has_more: false,
                gap: false,
                latest_seq: self.log.borrow().len() as u64,
            }
        }

        fn publish(&self) {
            let subs = self.subscribers.borrow();
            for (seq, tx) in subs.iter() {
                let _ = tx.unbounded_send(Ok(self.since_result(*seq)));
            }
        }

        /// External commit by another client.
        fn external(&self, ops: Vec<Op>, id: &str) {
            let tx = Transaction {
                id: id.into(),
                label: "other".into(),
                ops,
                source: TxSource::User,
                actor: None,
                ts: 0.0,
            };
            self.commit(&wire::encode_tx(&tx)).unwrap();
        }

        fn disconnect(&self) {
            self.offline.set(true);
            // Live subscriptions end.
            self.subscribers.borrow_mut().clear();
        }
    }

    struct FakeTransport(Rc<FakeServer>);

    impl Transport for FakeTransport {
        fn commit(
            &self,
            tx_json: String,
            _base: u64,
        ) -> LocalBoxFuture<'static, Result<CommitResult, CloudError>> {
            let s = self.0.clone();
            async move { s.commit(&tx_json) }.boxed_local()
        }

        fn load(&self) -> LocalBoxFuture<'static, Result<(Design, u64), CloudError>> {
            let s = self.0.clone();
            async move {
                if s.offline.get() {
                    return Err(CloudError::network("offline"));
                }
                Ok((
                    s.design.borrow().clone().unwrap(),
                    s.log.borrow().len() as u64,
                ))
            }
            .boxed_local()
        }

        fn since(&self, seq: u64) -> LocalBoxStream<'static, Result<Since, CloudError>> {
            if self.0.offline.get() {
                return futures::stream::once(async { Err(CloudError::network("offline")) })
                    .boxed_local();
            }
            let (tx, rx) = mpsc::unbounded();
            let _ = tx.unbounded_send(Ok(self.0.since_result(seq)));
            self.0.subscribers.borrow_mut().push((seq, tx));
            rx.boxed_local()
        }

        fn sleep(&self, _d: Duration) -> LocalBoxFuture<'static, ()> {
            // Time is not simulated: timers fire at once while the server is reachable and never while it is not
            // (the test sends Input::Online when it comes back, like the app does on reconnect).
            if self.0.offline.get() {
                futures::future::pending().boxed_local()
            } else {
                async {}.boxed_local()
            }
        }
    }

    #[derive(Default)]
    struct FakeView {
        design: Option<Design>,
        statuses: Vec<Status>,
        persisted: usize,
    }

    impl View for FakeView {
        fn design(&self) -> Option<Design> {
            self.design.clone()
        }
        fn apply(&mut self, tx: &Transaction, _undoable: bool) {
            apply_transaction(self.design.as_mut().unwrap(), tx, ApplyOptions::default());
        }
        fn status(&mut self, s: Status) {
            self.statuses.push(s);
        }
        fn persist(&mut self, _c: &Design, _s: &EngineState) {
            self.persisted += 1;
        }
    }

    fn base() -> Design {
        let mut d = Design::with_page(
            "design000001",
            "T",
            DesignKind::Poster,
            "page00000001",
            100.0,
            100.0,
        );
        d.push_child(
            "page00000001",
            Node::rect("rect00000001", "Box", 0.0, 0.0, 10.0, 10.0),
        );
        d
    }

    fn set_x(x: f64) -> Op {
        let mut m = Map::new();
        m.insert("x".into(), json!(x));
        Op::update_set("rect00000001", m)
    }

    fn local(view: &Rc<RefCell<FakeView>>, id: &str, op: Op) -> Transaction {
        let tx = Transaction {
            id: id.into(),
            label: "edit".into(),
            ops: vec![op],
            source: TxSource::User,
            actor: None,
            ts: 0.0,
        };
        let applied = {
            let mut v = view.borrow_mut();
            apply_transaction(v.design.as_mut().unwrap(), &tx, ApplyOptions::default()).applied
        };
        Transaction { ops: applied, ..tx }
    }

    fn setup() -> Setup {
        let server = Rc::new(FakeServer::default());
        *server.design.borrow_mut() = Some(base());
        let view = Rc::new(RefCell::new(FakeView {
            design: Some(base()),
            ..Default::default()
        }));
        let engine = Rc::new(RefCell::new(SyncEngine::new(base(), 0)));
        let (tx, rx) = mpsc::unbounded();
        let pool = LocalPool::new();
        pool.spawner()
            .spawn_local(run(
                engine.clone(),
                FakeTransport(server.clone()),
                view.clone(),
                rx,
            ))
            .unwrap();
        (pool, server, view, engine, tx)
    }

    #[test]
    fn edits_reach_the_server_and_remote_edits_reach_the_view() {
        let (mut pool, server, view, engine, input) = setup();
        pool.run_until_stalled();
        let tx = local(&view, "local0000001", set_x(42.0));
        input.unbounded_send(Input::Local(tx)).unwrap();
        pool.run_until_stalled();
        assert_eq!(server.log.borrow().len(), 1);
        assert!(engine.borrow().is_idle());
        assert_eq!(view.borrow().statuses.last(), Some(&Status::Synced));
        // Another client edits: the subscription delivers it.
        let mut m = Map::new();
        m.insert("name".into(), json!("Remote"));
        server.external(vec![Op::update_set("rect00000001", m)], "remote000001");
        pool.run_until_stalled();
        let v = view.borrow();
        let n = v.design.as_ref().unwrap().node("rect00000001").unwrap();
        assert_eq!(n.base().name, "Remote");
        assert_eq!(n.base().x, 42.0);
        assert_eq!(engine.borrow().seq(), 2);
    }

    #[test]
    fn reconnect_after_offline_edits_converges() {
        let (mut pool, server, view, engine, input) = setup();
        pool.run_until_stalled();
        server.disconnect();
        let t1 = local(&view, "local0000001", set_x(5.0));
        input.unbounded_send(Input::Local(t1)).unwrap();
        pool.run_until_stalled();
        assert!(matches!(
            view.borrow().statuses.last(),
            Some(Status::Offline(1))
        ));
        assert_eq!(engine.borrow().pending_len(), 1);
        // Meanwhile someone else changes the same layer's name on the server.
        server.offline.set(false);
        let mut m = Map::new();
        m.insert("name".into(), json!("Theirs"));
        server.external(vec![Op::update_set("rect00000001", m)], "remote000001");
        server.offline.set(true);
        // Back online.
        server.offline.set(false);
        input.unbounded_send(Input::Online).unwrap();
        pool.run_until_stalled();
        assert!(engine.borrow().is_idle());
        let sd = server.design.borrow().clone().unwrap();
        assert_eq!(
            view.borrow().design.as_ref().unwrap().canonical_json(),
            sd.canonical_json()
        );
        assert_eq!(sd.node("rect00000001").unwrap().base().x, 5.0);
        assert_eq!(sd.node("rect00000001").unwrap().base().name, "Theirs");
        assert_eq!(view.borrow().statuses.last(), Some(&Status::Synced));
        assert!(view.borrow().persisted > 0);
    }

    #[test]
    fn lost_commit_answer_is_resent_without_duplicating() {
        let (mut pool, server, view, engine, input) = setup();
        pool.run_until_stalled();
        server.lose_next_answer.set(true);
        let t1 = local(&view, "local0000001", set_x(9.0));
        input.unbounded_send(Input::Local(t1)).unwrap();
        pool.run_until_stalled();
        // Applied once on the server even though the client sent it twice.
        assert_eq!(server.log.borrow().len(), 1);
        assert!(server.commits.get() >= 2);
        assert!(engine.borrow().is_idle());
        assert_eq!(engine.borrow().seq(), 1);
        input.unbounded_send(Input::Stop).unwrap();
        pool.run_until_stalled();
    }
}
