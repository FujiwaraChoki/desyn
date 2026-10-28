//! An open design: the `Design` (desyn-core model), the bytes of its assets, undo history and the live-preview
//! mechanism used by gestures (drag, resize, typing) so the canvas updates every frame while history and sync
//! receive exactly one transaction per gesture (DOCUMENT_MODEL §6).

use std::collections::BTreeMap;
use std::sync::Arc;

use desyn_core::ids::{IdGen, RandomIds};
use desyn_core::layout::TextMeasurer;
use desyn_core::model::{AssetKind, AssetOp, AssetRef, AssetSource, Design, DesignKind, Id};
use desyn_core::{ApplyOptions, Op, Transaction, apply_transaction};

use super::history::{History, Step, tx};

/// Asset bytes by asset id (images, SVGs, fonts embedded in the `.desyn` file).
pub type AssetBytes = BTreeMap<Id, Arc<[u8]>>;

/// Why a change happened (for listeners such as sync, panels and autosave).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChangeKind {
    /// A local edit.
    Edit,
    /// Undo of a local edit.
    Undo,
    /// Redo of a local edit.
    Redo,
    /// A transaction that came from elsewhere (sync, AI run, import) applied through [`Document::apply_external`].
    External,
}

/// A committed change: the transaction as applied (derived geometry included), ready to be committed to Convex.
#[derive(Debug, Clone)]
pub struct Change {
    /// What produced it.
    pub kind: ChangeKind,
    /// Applied transaction (fresh id; `ops` are the applied ops).
    pub tx: Transaction,
}

struct Preview {
    /// The previewed ops (re-applied after an external change).
    ops: Vec<Op>,
    /// Ops restoring the state before the preview.
    inverse: Vec<Op>,
}

/// One open design.
pub struct Document {
    /// The design (source of truth for rendering).
    pub design: Design,
    /// Bytes of the design's assets.
    pub assets: AssetBytes,
    history: History,
    revision: u64,
    /// Counts committed changes only (previews excluded), so a cancelled gesture never marks the design dirty.
    edits: u64,
    saved_edits: u64,
    ids: RandomIds,
    preview: Option<Preview>,
    changes: Vec<Change>,
    clock: fn() -> u64,
}

fn monotonic_ms() -> u64 {
    use std::sync::OnceLock;
    use std::time::Instant;
    static START: OnceLock<Instant> = OnceLock::new();
    START.get_or_init(Instant::now).elapsed().as_millis() as u64
}

fn epoch_ms() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as f64)
        .unwrap_or(0.0)
}

/// Id generator seeded from the OS CSPRNG (the core never reads randomness itself).
pub fn random_ids() -> RandomIds {
    let mut seed = [0u8; 32];
    if getrandom::fill(&mut seed).is_err() {
        // No OS randomness (should not happen on desktop): fall back to time + address entropy.
        let t = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let a = &seed as *const _ as usize as u128;
        seed[..16].copy_from_slice(&(t ^ a.rotate_left(64)).to_le_bytes());
    }
    let words: [u64; 4] =
        std::array::from_fn(|i| u64::from_le_bytes(seed[i * 8..i * 8 + 8].try_into().unwrap()));
    RandomIds::from_seed(words)
}

impl Document {
    /// Wraps a loaded design.
    pub fn new(design: Design, assets: AssetBytes) -> Document {
        Document {
            design,
            assets,
            history: History::default(),
            revision: 0,
            edits: 0,
            saved_edits: 0,
            ids: random_ids(),
            preview: None,
            changes: Vec::new(),
            clock: monotonic_ms,
        }
    }

    /// A blank design with one page of the given size.
    pub fn blank(name: &str, kind: DesignKind, width: f64, height: f64) -> Document {
        let mut ids = random_ids();
        let design = Design::with_page(ids.next_id(), name, kind, ids.next_id(), width, height);
        let mut d = Document::new(design, AssetBytes::new());
        d.ids = ids;
        d
    }

    /// Replaces the clock (tests).
    #[cfg(test)]
    pub fn set_clock(&mut self, clock: fn() -> u64) {
        self.clock = clock;
    }

    /// A fresh node / transaction id.
    pub fn new_id(&mut self) -> Id {
        self.ids.next_id()
    }

    /// The id generator (for core helpers such as `clipboard::paste_ops`).
    pub fn id_gen(&mut self) -> &mut RandomIds {
        &mut self.ids
    }

    /// The design and the id generator borrowed together (editing builders need both).
    pub fn split(&mut self) -> (&mut Design, &mut RandomIds) {
        (&mut self.design, &mut self.ids)
    }

    /// Increments on every change; renderers and panels compare it to know when to refresh.
    pub fn revision(&self) -> u64 {
        self.revision
    }

    /// Unsaved changes exist (live previews do not count).
    pub fn is_dirty(&self) -> bool {
        self.edits != self.saved_edits
    }

    /// The point a save captures: pass it to [`Document::mark_saved`] once the write succeeded, so edits made
    /// while a background save runs keep the document dirty.
    pub fn save_point(&self) -> u64 {
        self.edits
    }

    /// Marks the given save point as saved (see [`Document::save_point`]).
    pub fn mark_saved(&mut self, save_point: u64) {
        self.saved_edits = save_point;
    }

    /// Marks the document as having unsaved changes (e.g. recovered from a crash).
    pub fn mark_dirty(&mut self) {
        self.saved_edits = u64::MAX;
    }

    /// Undo / redo history.
    pub fn history(&self) -> &History {
        &self.history
    }

    /// Ends undo coalescing (a new gesture starts a new step).
    pub fn seal_history(&mut self) {
        self.history.seal();
    }

    /// Changes since the last call (for sync, panels, autosave).
    pub fn take_changes(&mut self) -> Vec<Change> {
        std::mem::take(&mut self.changes)
    }

    fn apply_raw(
        &mut self,
        ops: Vec<Op>,
        label: &str,
        normalize: bool,
        m: &mut dyn TextMeasurer,
    ) -> (Transaction, Vec<Op>) {
        let id = self.ids.next_id();
        let t = tx(id, label, ops, epoch_ms());
        let res = apply_transaction(
            &mut self.design,
            &t,
            ApplyOptions {
                normalize,
                measurer: Some(m),
                inverse_id: None,
            },
        );
        if !res.dropped.is_empty() {
            log::debug!(
                "{label}: {} op(s) dropped: {:?}",
                res.dropped.len(),
                res.dropped
            );
        }
        let applied = Transaction {
            ops: res.applied,
            ..t
        };
        (applied, res.inverse.ops)
    }

    /// Applies a local edit as one undo step. Returns the applied transaction, or `None` when nothing changed.
    /// A running preview is cancelled first.
    pub fn apply(
        &mut self,
        ops: Vec<Op>,
        label: &str,
        m: &mut dyn TextMeasurer,
    ) -> Option<Transaction> {
        self.apply_coalescing(ops, label, None, m)
    }

    /// Like [`Document::apply`] but merges with the previous step when it has the same `key` and is recent.
    pub fn apply_coalescing(
        &mut self,
        ops: Vec<Op>,
        label: &str,
        key: Option<&str>,
        m: &mut dyn TextMeasurer,
    ) -> Option<Transaction> {
        self.cancel_preview(m);
        if ops.is_empty() {
            return None;
        }
        let (applied, inverse) = self.apply_raw(ops, label, true, m);
        if applied.ops.is_empty() {
            return None;
        }
        self.history
            .record(label, applied.ops.clone(), inverse, key, (self.clock)());
        self.bump(ChangeKind::Edit, applied.clone());
        Some(applied)
    }

    /// Applies a transaction produced elsewhere (remote collaborator, AI run, workflow). It is not added to the
    /// local undo stack unless `undoable` (AI runs started by this user are undoable as one step). A running
    /// preview is re-applied on top so an in-flight gesture survives.
    pub fn apply_external(
        &mut self,
        t: &Transaction,
        undoable: bool,
        m: &mut dyn TextMeasurer,
    ) -> Option<Transaction> {
        let restored = self.revert_preview(m);
        let res = apply_transaction(
            &mut self.design,
            t,
            ApplyOptions {
                normalize: true,
                measurer: Some(&mut *m),
                inverse_id: None,
            },
        );
        let applied = Transaction {
            ops: res.applied,
            ..t.clone()
        };
        if let Some(fwd) = restored {
            self.set_preview(fwd, m);
        }
        if applied.ops.is_empty() {
            return None;
        }
        if undoable {
            let run = t.actor.as_ref().and_then(|a| a.run_id.as_deref());
            match run {
                Some(run) => self.history.record_group(
                    &t.label,
                    applied.ops.clone(),
                    res.inverse.ops,
                    run,
                    (self.clock)(),
                ),
                None => self.history.record(
                    &t.label,
                    applied.ops.clone(),
                    res.inverse.ops,
                    None,
                    (self.clock)(),
                ),
            }
        }
        self.bump(ChangeKind::External, applied.clone());
        Some(applied)
    }

    fn bump(&mut self, kind: ChangeKind, tx: Transaction) {
        self.revision += 1;
        self.edits += 1;
        if self.edits == self.saved_edits {
            // Never collide with the marker set by mark_dirty().
            self.edits += 1;
        }
        self.changes.push(Change { kind, tx });
    }

    /// Undoes the last step. Returns its label.
    pub fn undo(&mut self, m: &mut dyn TextMeasurer) -> Option<String> {
        self.cancel_preview(m);
        let step = self.history.pop_undo()?;
        let (applied, inverse) = self.apply_raw(
            step.inverse.clone(),
            &format!("Undo {}", step.label),
            false,
            m,
        );
        // The redo replays exactly what undo reverted.
        let redo = Step {
            forward: inverse,
            inverse: applied.ops.clone(),
            coalesce: None,
            ..step
        };
        let label = redo.label.clone();
        self.history.push_redo(redo);
        self.bump(ChangeKind::Undo, applied);
        Some(label)
    }

    /// Redoes the last undone step. Returns its label.
    pub fn redo(&mut self, m: &mut dyn TextMeasurer) -> Option<String> {
        self.cancel_preview(m);
        let step = self.history.pop_redo()?;
        let (applied, inverse) = self.apply_raw(
            step.forward.clone(),
            &format!("Redo {}", step.label),
            false,
            m,
        );
        let again = Step {
            forward: applied.ops.clone(),
            inverse,
            coalesce: None,
            ..step
        };
        let label = again.label.clone();
        self.history.push_undo(again);
        self.bump(ChangeKind::Redo, applied);
        Some(label)
    }

    /// Shows `ops` as a live preview (replacing the previous preview). Nothing reaches history or listeners until
    /// [`Document::commit_preview`].
    pub fn set_preview(&mut self, ops: Vec<Op>, m: &mut dyn TextMeasurer) {
        self.revert_preview(m);
        if ops.is_empty() {
            return;
        }
        let (_, inverse) = self.apply_raw(ops.clone(), "preview", true, m);
        self.preview = Some(Preview { ops, inverse });
        // Renderers key off the revision; previews are visible changes too.
        self.revision += 1;
    }

    /// Whether a preview is showing.
    pub fn has_preview(&self) -> bool {
        self.preview.is_some()
    }

    /// The ops of the running preview.
    pub fn preview_ops(&self) -> Option<Vec<Op>> {
        self.preview.as_ref().map(|p| p.ops.clone())
    }

    /// Reverts the preview and returns its ops.
    fn revert_preview(&mut self, m: &mut dyn TextMeasurer) -> Option<Vec<Op>> {
        let p = self.preview.take()?;
        self.apply_raw(p.inverse, "revert preview", false, m);
        self.revision += 1;
        Some(p.ops)
    }

    /// Removes the preview without recording anything.
    pub fn cancel_preview(&mut self, m: &mut dyn TextMeasurer) {
        self.revert_preview(m);
    }

    /// Replaces the preview by a real edit of `ops` (usually the last preview's ops).
    pub fn commit_preview(
        &mut self,
        ops: Vec<Op>,
        label: &str,
        m: &mut dyn TextMeasurer,
    ) -> Option<Transaction> {
        self.revert_preview(m);
        self.apply(ops, label, m)
    }

    /// Replaces the preview by a real edit recorded in the undo step of `group` (consecutive edits of one group,
    /// such as the checkpoints of one text editing session, undo together however long they take).
    pub fn commit_preview_grouped(
        &mut self,
        ops: Vec<Op>,
        label: &str,
        group: &str,
        m: &mut dyn TextMeasurer,
    ) -> Option<Transaction> {
        self.revert_preview(m);
        if ops.is_empty() {
            return None;
        }
        let (applied, inverse) = self.apply_raw(ops, label, true, m);
        if applied.ops.is_empty() {
            return None;
        }
        self.history
            .record_group(label, applied.ops.clone(), inverse, group, (self.clock)());
        self.bump(ChangeKind::Edit, applied.clone());
        Some(applied)
    }

    /// Stores bytes as an asset. Identical bytes reuse the existing asset (sha256 dedupe). Returns the asset id
    /// and the `asset` op that registers it (empty when reused).
    pub fn add_asset(&mut self, bytes: Arc<[u8]>, mut meta: AssetRef) -> (Id, Vec<Op>) {
        let hash = desyn_core::canonical::sha256_hex(&bytes);
        if let Some((id, _)) = self.design.assets.iter().find(|(id, a)| {
            a.hash.as_deref() == Some(hash.as_str()) && self.assets.contains_key(*id)
        }) {
            return (id.clone(), Vec::new());
        }
        let id = self.new_id();
        meta.id = id.clone();
        meta.hash = Some(hash);
        meta.bytes = Some(bytes.len() as f64);
        meta.source.get_or_insert(AssetSource::Upload);
        meta.storage_key = Some(asset_entry_name(&id, &meta.mime));
        self.assets.insert(id.clone(), bytes);
        let mut set = BTreeMap::new();
        set.insert(id.clone(), meta);
        (
            id,
            vec![Op::Asset(AssetOp {
                set: Some(set),
                remove: None,
            })],
        )
    }

    /// Asset metadata for raw bytes of an image / SVG / font.
    pub fn asset_meta(
        kind: AssetKind,
        mime: &str,
        name: Option<&str>,
        size: Option<(u32, u32)>,
    ) -> AssetRef {
        let mut a = AssetRef::new(String::new(), kind, mime);
        a.name = name.map(str::to_string);
        if let Some((w, h)) = size {
            a.width = Some(w as f64);
            a.height = Some(h as f64);
        }
        a
    }
}

/// File name of an asset inside a `.desyn` archive (`assets/<id>.<ext>`).
pub fn asset_entry_name(id: &str, mime: &str) -> String {
    format!("assets/{id}.{}", ext_for_mime(mime))
}

/// File extension for a MIME type.
pub fn ext_for_mime(mime: &str) -> &'static str {
    match mime {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/webp" => "webp",
        "image/gif" => "gif",
        "image/bmp" => "bmp",
        "image/avif" => "avif",
        "image/svg+xml" => "svg",
        "font/ttf" => "ttf",
        "font/otf" => "otf",
        "font/woff" => "woff",
        "font/woff2" => "woff2",
        "video/mp4" => "mp4",
        "audio/mpeg" => "mp3",
        "application/json" => "json",
        _ => "bin",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use desyn_core::layout::ApproxMeasurer;
    use desyn_core::model::Node;
    use serde_json::json;

    fn doc() -> Document {
        Document::blank("Test", DesignKind::Poster, 800.0, 600.0)
    }

    fn page(d: &Document) -> Id {
        d.design.page_ids()[0].clone()
    }

    fn rect(d: &mut Document) -> Node {
        let id = d.new_id();
        Node::rect(id, "Rect", 10.0, 20.0, 100.0, 50.0)
    }

    #[test]
    fn apply_undo_redo_round_trip() {
        let mut m = ApproxMeasurer;
        let mut d = doc();
        let before = d.design.canonical_json();
        let r = rect(&mut d);
        let rid = r.id().to_string();
        let p = page(&d);
        let t = d
            .apply(vec![Op::create(vec![r], p, None)], "Add rect", &mut m)
            .unwrap();
        assert_eq!(t.ops.len(), 1);
        assert!(d.is_dirty());
        assert!(d.design.node(&rid).is_some());
        assert_eq!(d.undo(&mut m).as_deref(), Some("Add rect"));
        assert_eq!(d.design.canonical_json(), before);
        assert_eq!(d.redo(&mut m).as_deref(), Some("Add rect"));
        assert!(d.design.node(&rid).is_some());
        assert_eq!(d.undo(&mut m).as_deref(), Some("Add rect"));
        assert_eq!(d.design.canonical_json(), before);
        let kinds: Vec<_> = d.take_changes().iter().map(|c| c.kind).collect();
        assert_eq!(
            kinds,
            vec![
                ChangeKind::Edit,
                ChangeKind::Undo,
                ChangeKind::Redo,
                ChangeKind::Undo
            ]
        );
    }

    #[test]
    fn previews_commit_once() {
        let mut m = ApproxMeasurer;
        let mut d = doc();
        let r = rect(&mut d);
        let rid = r.id().to_string();
        let p = page(&d);
        d.apply(vec![Op::create(vec![r], p, None)], "Add", &mut m);
        d.take_changes();
        let mv = |x: f64| {
            let mut s = serde_json::Map::new();
            s.insert("x".into(), json!(x));
            vec![Op::update_set(rid.clone(), s)]
        };
        for x in [20.0, 30.0, 40.0] {
            d.set_preview(mv(x), &mut m);
            assert_eq!(d.design.node(&rid).unwrap().base().x, x);
        }
        assert!(d.take_changes().is_empty(), "previews are not changes");
        d.commit_preview(mv(40.0), "Move", &mut m).unwrap();
        assert_eq!(d.history().len(), 2);
        assert_eq!(d.take_changes().len(), 1);
        d.undo(&mut m);
        assert_eq!(d.design.node(&rid).unwrap().base().x, 10.0);
        d.set_preview(mv(99.0), &mut m);
        d.cancel_preview(&mut m);
        assert_eq!(d.design.node(&rid).unwrap().base().x, 10.0);
    }

    #[test]
    fn coalesced_nudges_undo_together() {
        let mut m = ApproxMeasurer;
        let mut d = doc();
        d.set_clock(|| 0);
        let r = rect(&mut d);
        let rid = r.id().to_string();
        let p = page(&d);
        d.apply(vec![Op::create(vec![r], p, None)], "Add", &mut m);
        for x in [11.0, 12.0, 13.0] {
            let mut s = serde_json::Map::new();
            s.insert("x".into(), json!(x));
            d.apply_coalescing(
                vec![Op::update_set(rid.clone(), s)],
                "Nudge",
                Some("nudge"),
                &mut m,
            );
        }
        assert_eq!(d.history().len(), 2);
        d.undo(&mut m);
        assert_eq!(d.design.node(&rid).unwrap().base().x, 10.0);
    }

    #[test]
    fn external_keeps_preview_and_skips_history() {
        let mut m = ApproxMeasurer;
        let mut d = doc();
        let r = rect(&mut d);
        let rid = r.id().to_string();
        let p = page(&d);
        d.apply(vec![Op::create(vec![r], p.clone(), None)], "Add", &mut m);
        let mut s = serde_json::Map::new();
        s.insert("x".into(), json!(300.0));
        d.set_preview(vec![Op::update_set(rid.clone(), s)], &mut m);
        let other = Node::ellipse("ext000000001", "Remote", 0.0, 0.0, 10.0, 10.0);
        let t = Transaction::new(
            "remote000001",
            "Remote add",
            vec![Op::create(vec![other], p, None)],
        );
        assert!(d.apply_external(&t, false, &mut m).is_some());
        assert!(d.design.node("ext000000001").is_some());
        assert_eq!(
            d.design.node(&rid).unwrap().base().x,
            300.0,
            "preview survives"
        );
        assert_eq!(d.history().len(), 1);
    }

    #[test]
    fn ai_run_transactions_undo_as_one_step() {
        let mut m = ApproxMeasurer;
        let mut d = doc();
        let p = page(&d);
        let before = d.design.canonical_json();
        let run_tx = |id: &str, node: &str| {
            let mut t = Transaction::new(
                id,
                "AI: add",
                vec![Op::create(
                    vec![Node::rect(node, "R", 0.0, 0.0, 10.0, 10.0)],
                    p.clone(),
                    None,
                )],
            );
            t.actor = Some(desyn_core::model::Actor {
                run_id: Some("run1".into()),
                ..Default::default()
            });
            t
        };
        // Far apart in time: grouping by run has no time window.
        d.set_clock(|| 0);
        d.apply_external(&run_tx("tx0000000001", "aiaiaiaiai01"), true, &mut m);
        d.set_clock(|| 600_000);
        d.apply_external(&run_tx("tx0000000002", "aiaiaiaiai02"), true, &mut m);
        assert_eq!(d.history().len(), 1, "one undo step per run");
        d.undo(&mut m);
        assert_eq!(d.design.canonical_json(), before);
        // A local edit in between ends the group.
        d.redo(&mut m);
        let r = rect(&mut d);
        d.apply(vec![Op::create(vec![r], p.clone(), None)], "Add", &mut m);
        d.apply_external(&run_tx("tx0000000003", "aiaiaiaiai03"), true, &mut m);
        assert_eq!(d.history().len(), 3);
    }

    #[test]
    fn cancelled_previews_leave_the_document_clean() {
        let mut m = ApproxMeasurer;
        let mut d = doc();
        let r = rect(&mut d);
        let rid = r.id().to_string();
        let p = page(&d);
        d.apply(vec![Op::create(vec![r], p, None)], "Add", &mut m);
        d.mark_saved(d.save_point());
        assert!(!d.is_dirty());
        let rev = d.revision();
        let mut s = serde_json::Map::new();
        s.insert("x".into(), json!(77.0));
        d.set_preview(vec![Op::update_set(rid, s)], &mut m);
        assert!(d.revision() > rev, "previews still repaint");
        d.cancel_preview(&mut m);
        assert!(!d.is_dirty(), "a cancelled gesture changes nothing");
        // A save that started before an edit keeps the edit dirty.
        let point = d.save_point();
        let r2 = rect(&mut d);
        let p = page(&d);
        d.apply(vec![Op::create(vec![r2], p, None)], "Add", &mut m);
        d.mark_saved(point);
        assert!(d.is_dirty());
    }

    #[test]
    fn assets_dedupe_by_hash() {
        let mut d = doc();
        let bytes: Arc<[u8]> = Arc::from(&b"\x89PNG fake"[..]);
        let (a, ops) = d.add_asset(
            bytes.clone(),
            Document::asset_meta(AssetKind::Image, "image/png", Some("a.png"), Some((2, 3))),
        );
        assert_eq!(ops.len(), 1);
        let mut m = ApproxMeasurer;
        d.apply(ops, "Add asset", &mut m);
        let (b, ops2) = d.add_asset(
            bytes,
            Document::asset_meta(AssetKind::Image, "image/png", None, None),
        );
        assert_eq!(a, b);
        assert!(ops2.is_empty());
        let meta = &d.design.assets[&a];
        assert_eq!(
            meta.storage_key.as_deref(),
            Some(format!("assets/{a}.png").as_str())
        );
        assert_eq!(meta.width, Some(2.0));
    }
}
