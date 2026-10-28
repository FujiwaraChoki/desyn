//! Offline-first cloud sync for the desktop editor. Local `.desyn` files keep working exactly as before; a design
//! can also live in a Desyn cloud, where it syncs live with Convex using the designs protocol (DOCUMENT_MODEL §6):
//! load, commit with `baseSeq`, `designOps.since` subscription, confirmed + pending with rebase ([`engine`]),
//! reconnect and retry ([`driver`]), an offline cache so cloud designs open and edit without a connection
//! ([`cache`]), asset upload / download, presence (who is here, what they selected) and a status pill in the top
//! bar. Local files can be uploaded to the cloud and stay linked to their cloud design.

pub mod cache;
pub mod driver;
pub mod engine;
pub mod transport;
pub mod wire;

use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::rc::Rc;
use std::sync::Arc;
use std::time::{Duration, Instant};

use desyn_core::model::{AssetOp, AssetRef, Design, Op, Transaction};
use futures::channel::mpsc;
use gpui::{
    AnyElement, App, AppContext, AsyncApp, Entity, EntityId, Global, InteractiveElement,
    IntoElement, ParentElement, SharedString, StatefulInteractiveElement, Styled, Task, WeakEntity,
    Window, div, prelude::FluentBuilder, px,
};
use serde_json::{Value as Json, json};

use crate::auth::Account;
use crate::cloud::api::{self, AssetView, Presence, f};
use crate::cloud::{Cloud, CloudError, Connection, runtime};
use crate::doc::{ChangeKind, Document};
use crate::ui::components::{icon, tip};
use crate::ui::editor::{EditorEvent, EditorView};
use crate::ui::ext::Extensions;
use crate::ui::theme::{SANS, alpha};
use crate::widgets::{self, avatar, hsla, notify};
use driver::{Input, Status};
use engine::{EngineState, SyncEngine};

/// A cloud design open in an editor.
pub struct CloudLink {
    /// Convex design id.
    pub design_id: String,
    /// Workspace.
    pub workspace_id: String,
    /// Caller's permission (view | comment | edit | manage).
    pub permission: String,
    /// Sync status.
    pub status: Status,
    /// Other people here.
    pub presence: Vec<Presence>,
    /// Presence session id of this editor.
    pub session_id: String,
    inputs: mpsc::UnboundedSender<Input>,
    uploading: HashSet<String>,
    _tasks: Vec<Task<()>>,
}

impl CloudLink {
    /// Whether the user may edit.
    pub fn can_edit(&self) -> bool {
        matches!(self.permission.as_str(), "edit" | "manage")
    }
}

/// Cloud designs by editor (GPUI global).
#[derive(Default)]
pub struct CloudDocs {
    links: HashMap<EntityId, CloudLink>,
    checked: HashSet<EntityId>,
    opening: HashSet<String>,
    /// Linked local files that could not attach yet (signed out, or the server was unreachable): retried on
    /// sign-in and on reconnect.
    awaiting: HashSet<EntityId>,
}

/// Retries attaching linked files that were opened while signed out or offline.
fn retry_awaiting(cx: &mut App) {
    let ids: Vec<EntityId> = cx.global_mut::<CloudDocs>().awaiting.drain().collect();
    if ids.is_empty() {
        return;
    }
    for ed in widgets::all_editors(cx) {
        if ids.contains(&ed.entity_id()) {
            cx.global_mut::<CloudDocs>().checked.remove(&ed.entity_id());
            attach_if_linked(&ed, cx);
        }
    }
}

impl Global for CloudDocs {}

/// The cloud link of an editor.
pub fn link<'a>(editor: &Entity<EditorView>, cx: &'a App) -> Option<&'a CloudLink> {
    cx.try_global::<CloudDocs>()?.links.get(&editor.entity_id())
}

/// The Convex design id of an editor's cloud design.
pub fn design_id(editor: &Entity<EditorView>, cx: &App) -> Option<String> {
    link(editor, cx).map(|l| l.design_id.clone())
}

fn server_dir(cx: &App) -> PathBuf {
    let data = cx
        .try_global::<crate::ui::app::AppState>()
        .map(|s| s.paths.data_dir.clone())
        .unwrap_or_else(|| crate::paths::AppPaths::detect().data_dir);
    cache::server_dir(&data, &Cloud::get(cx).endpoints().convex_url)
}

/// Installs the module (cloud links, observers, top bar status and presence).
pub fn install(cx: &mut App) {
    cx.set_global(CloudDocs::default());
    Extensions::update(cx, |x| {
        x.on_cloud_link(|id, cx| open_cloud_design(id.to_string(), cx));
        x.on_document(on_event);
        x.top_bar(5, status_item);
    });
    // Reconnected: every sync loop retries at once.
    let mut last = Connection::Idle;
    cx.observe_global::<Cloud>(move |cx| {
        let c = Cloud::get(cx).connection;
        if c == Connection::Online && last != Connection::Online {
            for l in cx.global::<CloudDocs>().links.values() {
                let _ = l.inputs.unbounded_send(Input::Online);
            }
            retry_awaiting(cx);
        }
        last = c;
    })
    .detach();
    // Signed in (also when the keychain session is restored after files were already opened at launch).
    let mut was_signed_in = false;
    cx.observe_global::<Account>(move |cx| {
        let now = Account::signed_in(cx);
        if now && !was_signed_in {
            retry_awaiting(cx);
        }
        was_signed_in = now;
    })
    .detach();
}

fn on_event(editor: &Entity<EditorView>, event: &EditorEvent, cx: &mut App) {
    attach_if_linked(editor, cx);
    let EditorEvent::Changed(changes) = event else {
        return;
    };
    let Some(l) = link(editor, cx) else { return };
    if !l.can_edit() {
        return;
    }
    let inputs = l.inputs.clone();
    let mut assets = false;
    for c in changes {
        if c.kind == ChangeKind::External {
            continue;
        }
        assets |= c.tx.ops.iter().any(|o| matches!(o, Op::Asset(_)));
        let _ = inputs.unbounded_send(Input::Local(c.tx.clone()));
    }
    if assets {
        upload_assets(editor.clone(), cx);
    }
}

/// Starts syncing a local file that was uploaded to the cloud earlier (once per editor).
fn attach_if_linked(editor: &Entity<EditorView>, cx: &mut App) {
    let id = editor.entity_id();
    if !cx.has_global::<CloudDocs>() || cx.global::<CloudDocs>().checked.contains(&id) {
        return;
    }
    cx.global_mut::<CloudDocs>().checked.insert(id);
    let Some(file) = editor.read(cx).file().map(|p| p.to_path_buf()) else {
        return;
    };
    let server = server_dir(cx);
    let links = cache::read_links(&server);
    let Some(design_id) = links.get(&file).cloned() else {
        return;
    };
    if !Account::signed_in(cx) {
        cx.global_mut::<CloudDocs>().awaiting.insert(id);
        return;
    }
    let cloud = Cloud::get(cx);
    let ed = editor.downgrade();
    // The design as the server last confirmed it to this computer: the base that tells the user's own offline
    // edits apart from what collaborators changed meanwhile.
    let base = cache::design_dir(&server, &design_id)
        .and_then(|d| cache::load(&d))
        .map(|c| c.confirmed);
    cx.spawn(async move |cx| {
        let res = transport::load_design(cloud, design_id.clone()).await;
        cx.update(|cx| match res {
            Ok((design, seq, header)) => {
                let Some(ed) = ed.upgrade() else { return };
                // Collaborators' changes since the last sync are kept; the file's own edits since then are
                // replayed over them as one pending change.
                let local = ed.read(cx).session.doc.design.clone();
                let (engine, editor_tx) =
                    SyncEngine::reattach(base.as_ref(), design, seq, &local, new_tx_id());
                if let Some(tx) = editor_tx {
                    ed.update(cx, |e, cx| {
                        e.apply_external(&tx, false, cx);
                    });
                }
                start_session(
                    &ed,
                    engine,
                    design_id.clone(),
                    header.workspace_id,
                    header.permission,
                    cx,
                );
            }
            Err(e) => {
                if e.code == "NOT_FOUND" || e.code == "FORBIDDEN" {
                    let _ = cache::write_link(&server_dir(cx), &file, None);
                } else if let Some(ed) = ed.upgrade() {
                    // Offline or signed out meanwhile: try again on reconnect / sign-in.
                    cx.global_mut::<CloudDocs>().awaiting.insert(ed.entity_id());
                }
                log::info!("linked design {design_id}: {e}");
            }
        });
    })
    .detach();
}

/// Opens a cloud design in a tab (from the offline cache at once when available).
pub fn open_cloud_design(design_id: String, cx: &mut App) {
    if let Some((ed, _)) = cx
        .try_global::<CloudDocs>()
        .and_then(|d| d.links.iter().find(|(_, l)| l.design_id == design_id))
        .and_then(|(id, _)| {
            widgets::all_editors(cx)
                .into_iter()
                .find(|e| e.entity_id() == *id)
                .map(|e| (e, ()))
        })
    {
        widgets::focus_editor(&ed, cx);
        return;
    }
    if !cx
        .global_mut::<CloudDocs>()
        .opening
        .insert(design_id.clone())
    {
        return;
    }
    let server = server_dir(cx);
    let cached =
        cache::design_dir(&server, &design_id).and_then(|d| cache::load(&d).map(|c| (d, c)));
    if let Some((dir, c)) = cached {
        let engine = SyncEngine::restore(c.confirmed, c.state);
        let view = engine.view();
        let assets = cache::load_assets(&dir, &view);
        let doc = Document::new(view, assets);
        cx.global_mut::<CloudDocs>().opening.remove(&design_id);
        if let Some(ed) = widgets::open_document(doc, None, cx) {
            start_session(
                &ed,
                engine,
                design_id,
                c.meta.workspace_id,
                c.meta.permission,
                cx,
            );
        }
        return;
    }
    if !Account::signed_in(cx) {
        cx.global_mut::<CloudDocs>().opening.remove(&design_id);
        notify(
            cx,
            "Sign in to open designs from your Desyn account.".into(),
        );
        Account::start_sign_in(cx);
        return;
    }
    notify(cx, "Opening from the cloud…".into());
    let cloud = Cloud::get(cx);
    cx.spawn(async move |cx| {
        let res = transport::load_design(cloud, design_id.clone()).await;
        cx.update(|cx| {
            cx.global_mut::<CloudDocs>().opening.remove(&design_id);
            match res {
                Ok((design, seq, header)) => {
                    let engine = SyncEngine::new(design.clone(), seq);
                    let doc = Document::new(design, Default::default());
                    if let Some(ed) = widgets::open_document(doc, None, cx) {
                        start_session(
                            &ed,
                            engine,
                            design_id.clone(),
                            header.workspace_id,
                            header.permission,
                            cx,
                        );
                    }
                }
                Err(e) => {
                    Account::handle_error(&e, cx);
                    notify(cx, format!("Couldn't open the design: {}", e.friendly()));
                }
            }
        });
    })
    .detach();
}

/// Creates a cloud design from a local design (upload) and keeps the editor linked to it.
pub fn upload_to_cloud(
    editor: &Entity<EditorView>,
    cx: &mut App,
) -> Task<Result<String, CloudError>> {
    if let Some(id) = design_id(editor, cx) {
        return Task::ready(Ok(id));
    }
    let Some(workspace) = Account::workspace_id(cx) else {
        return Task::ready(Err(CloudError {
            code: "UNAUTHENTICATED".into(),
            message: "Sign in to upload designs.".into(),
            data: Json::Null,
        }));
    };
    let cloud = Cloud::get(cx);
    let (design, name, file) = {
        let e = editor.read(cx);
        (
            e.session.doc.design.clone(),
            e.name(),
            e.file().map(|p| p.to_path_buf()),
        )
    };
    let ed = editor.downgrade();
    cx.spawn(async move |cx| {
        let res = cloud
            .mutation(
                f::DESIGNS_IMPORT,
                json!({ "workspaceId": workspace, "design": design.to_json(), "name": name }),
            )
            .await?;
        let design_id = res
            .get("designId")
            .and_then(Json::as_str)
            .ok_or_else(|| CloudError::server("The server did not return a design."))?
            .to_string();
        if res.get("pending").and_then(Json::as_bool) == Some(true) {
            // Large designs are built by a background action: wait until they load.
            for _ in 0..60 {
                runtime::sleep(Duration::from_secs(2)).await;
                if cloud
                    .query(f::DESIGNS_GET, json!({ "designId": design_id }))
                    .await
                    .is_ok()
                {
                    break;
                }
            }
        }
        let (server_design, seq, header) =
            transport::load_design(cloud.clone(), design_id.clone()).await?;
        cx.update(|cx| {
            if let Some(ed) = ed.upgrade() {
                // Imports drop local storage keys and URLs: show the server state, then upload the asset bytes.
                let local = ed.read(cx).session.doc.design.clone();
                let tx = desyn_core::diff::diff_designs(&local, &server_design, new_tx_id());
                if !tx.ops.is_empty() {
                    ed.update(cx, |e, cx| {
                        e.apply_external(&tx, false, cx);
                    });
                }
                if let Some(file) = &file {
                    let _ = cache::write_link(&server_dir(cx), file, Some(&design_id));
                }
                cx.global_mut::<CloudDocs>().checked.insert(ed.entity_id());
                start_session(
                    &ed,
                    SyncEngine::new(server_design, seq),
                    design_id.clone(),
                    header.workspace_id,
                    header.permission,
                    cx,
                );
            }
        });
        Ok(design_id)
    })
}

/// A fresh transaction id.
pub fn new_tx_id() -> String {
    use desyn_core::ids::IdGen as _;
    crate::doc::random_ids().next_id()
}

/// Starts syncing an editor with its cloud design.
pub fn start_session(
    editor: &Entity<EditorView>,
    engine: SyncEngine,
    design_id: String,
    workspace_id: String,
    permission: String,
    cx: &mut App,
) {
    let cloud = Cloud::get(cx);
    let (tx, rx) = mpsc::unbounded();
    let session_id = crate::auth::pkce::random_string(24).replace(['.', '~'], "_");
    let cache_dir = cache::design_dir(&server_dir(cx), &design_id);
    let engine = Rc::new(RefCell::new(engine));
    let adapter = Rc::new(RefCell::new(EditorAdapter {
        editor: editor.downgrade(),
        cx: cx.to_async(),
        cache_dir: cache_dir.clone(),
        meta: cache::CacheMeta {
            design_id: design_id.clone(),
            workspace_id: workspace_id.clone(),
            name: editor.read(cx).name(),
            permission: permission.clone(),
            synced_at: 0.0,
        },
        last_persist: None,
        persist_pending: Rc::new(RefCell::new(None)),
    }));
    let transport = transport::ConvexTransport {
        cloud: cloud.clone(),
        design_id: design_id.clone(),
    };
    let sync_task = cx.spawn(async move |_| {
        driver::run(engine, transport, adapter, rx).await;
    });
    let presence_task = presence_loop(
        editor.downgrade(),
        design_id.clone(),
        session_id.clone(),
        cx,
    );
    let link = CloudLink {
        design_id: design_id.clone(),
        workspace_id,
        permission,
        status: Status::Connecting,
        presence: Vec::new(),
        session_id,
        inputs: tx,
        uploading: HashSet::new(),
        _tasks: vec![sync_task, presence_task],
    };
    let id = editor.entity_id();
    cx.global_mut::<CloudDocs>().links.insert(id, link);
    cx.global_mut::<CloudDocs>().checked.insert(id);
    // Cloud designs are saved by syncing; the tab never asks to save them.
    editor.update(cx, |e, cx| {
        if e.file().is_none() {
            let r = e.session.doc.revision();
            e.session.doc.mark_saved(r);
        }
        cx.notify();
    });
    // Stop syncing when the editor goes away.
    let weak = editor.downgrade();
    cx.observe_release(editor, move |_, cx| {
        let _ = &weak;
        if let Some(l) = cx.global_mut::<CloudDocs>().links.remove(&id) {
            let _ = l.inputs.unbounded_send(Input::Stop);
            let cloud = Cloud::get(cx);
            let f = cloud.mutation(
                f::PRESENCE_LEAVE,
                json!({ "designId": l.design_id, "sessionId": l.session_id }),
            );
            cx.background_spawn(async move {
                let _ = f.await;
            })
            .detach();
        }
    })
    .detach();
    download_assets(editor.clone(), cx);
    upload_assets(editor.clone(), cx);
}

struct EditorAdapter {
    editor: WeakEntity<EditorView>,
    cx: AsyncApp,
    cache_dir: Option<PathBuf>,
    meta: cache::CacheMeta,
    last_persist: Option<Instant>,
    persist_pending: Rc<RefCell<Option<(Design, EngineState)>>>,
}

impl driver::View for EditorAdapter {
    fn design(&self) -> Option<Design> {
        self.editor
            .read_with(&self.cx, |e, _| e.session.doc.design.clone())
            .ok()
    }

    fn apply(&mut self, tx: &Transaction, undoable: bool) {
        let _ = self.editor.update(&mut self.cx, |e, cx| {
            e.apply_external(tx, undoable, cx);
            if e.file().is_none() {
                let r = e.session.doc.revision();
                e.session.doc.mark_saved(r);
            }
        });
        // New remote assets need their bytes.
        if tx.ops.iter().any(|o| matches!(o, Op::Asset(_)))
            && let Some(ed) = self.editor.upgrade()
        {
            self.cx.update(|cx| download_assets(ed, cx));
        }
    }

    fn remote_applied(&mut self, txs: &[Transaction]) {
        if let Some(ed) = self.editor.upgrade() {
            let txs = txs.to_vec();
            self.cx.update(|cx| crate::ai::on_remote(&ed, &txs, cx));
        }
    }

    fn undoable(&self, tx: &Transaction) -> bool {
        let run = tx.actor.as_ref().and_then(|a| a.run_id.clone());
        match run {
            Some(r) => self.cx.update(|cx| crate::ai::owns_run(&r, cx)),
            None => false,
        }
    }

    fn status(&mut self, status: Status) {
        let Some(ed) = self.editor.upgrade() else {
            return;
        };
        let id = ed.entity_id();
        self.cx.update(|cx| {
            if let Some(l) = cx.global_mut::<CloudDocs>().links.get_mut(&id)
                && l.status != status
            {
                if let Status::Error(m) = &status {
                    notify(cx, m.clone());
                }
                if let Some(l) = cx.global_mut::<CloudDocs>().links.get_mut(&id) {
                    l.status = status.clone();
                }
                ed.update(cx, |e, cx| {
                    if e.file().is_none() && matches!(status, Status::Synced) {
                        let r = e.session.doc.revision();
                        e.session.doc.mark_saved(r);
                    }
                    cx.notify()
                });
            }
        });
        if status == Status::Synced {
            self.meta.synced_at = now_ms();
        }
    }

    fn persist(&mut self, confirmed: &Design, state: &EngineState) {
        let Some(dir) = self.cache_dir.clone() else {
            return;
        };
        // Coalesce: write at most every 400 ms (the last state always lands).
        let first = self.persist_pending.borrow().is_none();
        *self.persist_pending.borrow_mut() = Some((confirmed.clone(), state.clone()));
        if !first {
            return;
        }
        let pending = self.persist_pending.clone();
        let wait = match self.last_persist {
            Some(t) if t.elapsed() < Duration::from_millis(400) => {
                Duration::from_millis(400) - t.elapsed()
            }
            _ => Duration::ZERO,
        };
        self.last_persist = Some(Instant::now() + wait);
        let mut meta = self.meta.clone();
        if let Some(ed) = self.editor.upgrade() {
            meta.name = self.cx.update(|cx| ed.read(cx).name());
        }
        let bg = self.cx.background_executor().clone();
        self.cx
            .spawn(async move |_| {
                if !wait.is_zero() {
                    runtime::sleep(wait).await;
                }
                let Some((design, state)) = pending.borrow_mut().take() else {
                    return;
                };
                bg.spawn(async move {
                    if let Err(e) = cache::save(&dir, &design, &state, &meta) {
                        log::warn!("cloud cache: {e}");
                    }
                })
                .await;
            })
            .detach();
    }

    fn rejected(&mut self, txs: &[Transaction], error: &CloudError) {
        let n = txs.len();
        let msg = format!(
            "{} {} could not be saved to the cloud and {} undone: {}",
            n,
            if n == 1 { "change" } else { "changes" },
            if n == 1 { "was" } else { "were" },
            error.friendly()
        );
        self.cx.update(|cx| notify(cx, msg));
    }
}

fn now_ms() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as f64)
        .unwrap_or(0.0)
}

/// Opens an editor for a cloud design and starts syncing (used by the library and template instantiation).
pub fn open_with(
    design: Design,
    assets: crate::doc::AssetBytes,
    engine: SyncEngine,
    design_id: String,
    workspace_id: String,
    permission: String,
    cx: &mut App,
) -> Option<Entity<EditorView>> {
    let doc = Document::new(design, assets);
    let ed = widgets::open_document(doc, None, cx)?;
    start_session(&ed, engine, design_id, workspace_id, permission, cx);
    Some(ed)
}

fn presence_loop(
    editor: WeakEntity<EditorView>,
    design_id: String,
    session_id: String,
    cx: &mut App,
) -> Task<()> {
    let cloud = Cloud::get(cx);
    cx.spawn(async move |cx| {
        let mut live = cloud.subscribe(f::PRESENCE_LIST, json!({ "designId": design_id }));
        let mut beat = Instant::now() - Duration::from_secs(60);
        loop {
            // Heartbeat every 5 s with the selection and viewport (presence never enters history).
            if beat.elapsed() >= Duration::from_secs(5) {
                beat = Instant::now();
                let Ok((selection, page, cam)) = editor.read_with(cx, |e, _| {
                    (
                        e.session.selection.clone(),
                        e.session.page.clone(),
                        e.session.camera,
                    )
                }) else {
                    break;
                };
                let f = cloud.mutation(
                    f::PRESENCE_HEARTBEAT,
                    json!({
                        "designId": design_id,
                        "sessionId": session_id,
                        "selection": selection.iter().take(100).collect::<Vec<_>>(),
                        // Same convention as the web editor: x / y = design point at the top-left corner, width /
                        // height in screen px (collaborators follow x, y, width / zoom, height / zoom).
                        "viewport": {
                            "x": cam.x,
                            "y": cam.y,
                            "zoom": cam.zoom,
                            "width": cam.width,
                            "height": cam.height,
                            "pageId": page,
                        },
                    }),
                );
                cx.background_spawn(async move {
                    let _ = f.await;
                })
                .detach();
            }
            let tick = runtime::sleep(Duration::from_millis(1000));
            let next = match futures::future::select(Box::pin(live.next()), Box::pin(tick)).await {
                futures::future::Either::Left((r, _)) => Some(r),
                futures::future::Either::Right(_) => None,
            };
            if let Some(Some(r)) = next {
                let list: Vec<Presence> = r.and_then(api::decode).unwrap_or_default();
                let others: Vec<Presence> = list
                    .into_iter()
                    .filter(|p| p.session_id != session_id)
                    .collect();
                let Some(ed) = editor.upgrade() else { break };
                let id = ed.entity_id();
                cx.update(|cx| {
                    if let Some(l) = cx.global_mut::<CloudDocs>().links.get_mut(&id)
                        && l.presence != others
                    {
                        l.presence = others;
                        ed.update(cx, |_, cx| cx.notify());
                    }
                });
            } else if let Some(None) = next {
                // Subscription ended (offline): resubscribe after a pause.
                runtime::sleep(Duration::from_secs(5)).await;
                live = cloud.subscribe(f::PRESENCE_LIST, json!({ "designId": design_id }));
            }
            if editor.upgrade().is_none() {
                break;
            }
        }
    })
}

/// Downloads asset bytes the editor does not have yet (signed URLs from `assets.designUrls`).
pub fn download_assets(editor: Entity<EditorView>, cx: &mut App) {
    let Some(l) = link(&editor, cx) else { return };
    let design_id = l.design_id.clone();
    let missing: Vec<String> = {
        let e = editor.read(cx);
        e.session
            .doc
            .design
            .assets
            .iter()
            .filter(|(id, a)| {
                !e.session.doc.assets.contains_key(*id)
                    && a.storage_key
                        .as_deref()
                        .is_some_and(|k| !k.starts_with("assets/"))
            })
            .map(|(id, _)| id.clone())
            .collect()
    };
    if missing.is_empty() {
        return;
    }
    let cloud = Cloud::get(cx);
    let cache_dir = cache::design_dir(&server_dir(cx), &design_id);
    let ed = editor.downgrade();
    cx.spawn(async move |cx| {
        let urls = match cloud
            .query(
                f::ASSET_DESIGN_URLS,
                json!({ "designId": design_id, "refs": missing }),
            )
            .await
        {
            Ok(v) => v.get("urls").cloned().unwrap_or(Json::Null),
            Err(e) => {
                log::info!("asset urls: {e}");
                return;
            }
        };
        for id in missing {
            let Some(url) = urls.get(&id).and_then(Json::as_str) else {
                continue;
            };
            match cloud
                .fetch_bytes(url, crate::cloud::http::MAX_DOWNLOAD)
                .await
            {
                Ok((bytes, _)) => {
                    if let Some(dir) = &cache_dir {
                        let _ = cache::save_asset(dir, &id, &bytes);
                    }
                    let bytes: Arc<[u8]> = Arc::from(bytes);
                    let ok = ed.update(cx, |e, cx| {
                        e.session.doc.assets.insert(id.clone(), bytes);
                        e.session.sync_assets();
                        cx.notify();
                    });
                    if ok.is_err() {
                        return;
                    }
                }
                Err(e) => log::info!("asset {id}: {e}"),
            }
        }
    })
    .detach();
}

/// Uploads local asset bytes of a cloud design (storage key still `assets/<id>.<ext>`) and records the server key.
pub fn upload_assets(editor: Entity<EditorView>, cx: &mut App) {
    let Some(l) = link(&editor, cx) else { return };
    if !l.can_edit() {
        return;
    }
    let workspace = l.workspace_id.clone();
    let busy = l.uploading.clone();
    let todo: Vec<(AssetRef, Arc<[u8]>)> = {
        let e = editor.read(cx);
        e.session
            .doc
            .design
            .assets
            .iter()
            .filter(|(id, a)| {
                !busy.contains(*id)
                    && a.storage_key
                        .as_deref()
                        .is_none_or(|k| k.starts_with("assets/"))
            })
            .filter_map(|(id, a)| e.session.doc.assets.get(id).map(|b| (a.clone(), b.clone())))
            .collect()
    };
    if todo.is_empty() {
        return;
    }
    let id = editor.entity_id();
    if let Some(l) = cx.global_mut::<CloudDocs>().links.get_mut(&id) {
        l.uploading.extend(todo.iter().map(|(a, _)| a.id.clone()));
    }
    let cloud = Cloud::get(cx);
    let ed = editor.downgrade();
    cx.spawn(async move |cx| {
        for (asset, bytes) in todo {
            let res = upload_one(&cloud, &workspace, &asset, bytes.clone()).await;
            let aid = asset.id.clone();
            match res {
                Ok(view) => {
                    let mut updated = asset.clone();
                    updated.storage_key = Some(view.storage_key.clone());
                    updated.hash = view.hash.clone().or(updated.hash);
                    updated.bytes = Some(view.bytes);
                    if let (Some(w), Some(h)) = (view.width, view.height) {
                        updated.width = Some(w);
                        updated.height = Some(h);
                    }
                    let mut set = std::collections::BTreeMap::new();
                    set.insert(aid.clone(), updated);
                    let tx = Transaction::new(
                        new_tx_id(),
                        "Upload image",
                        vec![Op::Asset(AssetOp {
                            set: Some(set),
                            remove: None,
                        })],
                    );
                    let _ = ed.update(cx, |e, cx| {
                        e.apply_external(&tx, false, cx);
                    });
                    cx.update(|cx| {
                        if let Some(l) = cx.global_mut::<CloudDocs>().links.get_mut(&id) {
                            let _ = l.inputs.unbounded_send(Input::Local(tx));
                            l.uploading.remove(&aid);
                        }
                    });
                }
                Err(e) => {
                    log::info!("upload {aid}: {e}");
                    cx.update(|cx| {
                        if e.code == "FEATURE_UNAVAILABLE"
                            || e.code == "LIMIT_REACHED"
                            || e.code == "NOT_CONFIGURED"
                        {
                            notify(
                                cx,
                                format!("An image could not be uploaded: {}", e.friendly()),
                            );
                        }
                        if e.is_transient()
                            && let Some(l) = cx.global_mut::<CloudDocs>().links.get_mut(&id)
                        {
                            // Retried with the next change.
                            l.uploading.remove(&aid);
                        }
                    });
                }
            }
        }
    })
    .detach();
}

async fn upload_one(
    cloud: &Cloud,
    workspace: &str,
    asset: &AssetRef,
    bytes: Arc<[u8]>,
) -> Result<AssetView, CloudError> {
    let sha = desyn_core::canonical::sha256_hex(&bytes);
    let name = asset.name.clone().unwrap_or_else(|| {
        crate::doc::asset_entry_name(&asset.id, &asset.mime).replace("assets/", "")
    });
    let mut args = json!({
        "workspaceId": workspace,
        "name": name,
        "mime": asset.mime,
        "bytes": bytes.len(),
        "sha256": sha,
    });
    if let Some(fam) = &asset.family {
        args["family"] = json!(fam);
    }
    let req = cloud.mutation(f::ASSET_REQUEST_UPLOAD, args).await?;
    let asset_id = req
        .get("assetId")
        .and_then(Json::as_str)
        .ok_or_else(|| CloudError::server("No upload slot."))?
        .to_string();
    if let Some(up) = req.get("upload").filter(|u| !u.is_null()) {
        let url = up
            .get("url")
            .and_then(Json::as_str)
            .unwrap_or_default()
            .to_string();
        let headers: Vec<(String, String)> = up
            .get("headers")
            .and_then(Json::as_object)
            .map(|h| {
                h.iter()
                    .map(|(k, v)| (k.clone(), v.as_str().unwrap_or_default().to_string()))
                    .collect()
            })
            .unwrap_or_default();
        let body = bytes.to_vec();
        let put =
            runtime::spawn(
                async move { crate::cloud::http::put_presigned(&url, &headers, body).await },
            );
        put.await.map_err(|_| CloudError::network("cancelled"))??;
        cloud
            .action(f::ASSET_FINALIZE, json!({ "assetId": asset_id }))
            .await?;
    }
    let v = cloud
        .query(f::ASSET_GET, json!({ "assetId": asset_id }))
        .await?;
    api::decode(v)
}

fn status_item(editor: &Entity<EditorView>, window: &mut Window, cx: &mut App) -> AnyElement {
    // Top bar items render while the editor is being updated: look at it on the next tick.
    if cx
        .try_global::<CloudDocs>()
        .is_some_and(|d| !d.checked.contains(&editor.entity_id()))
    {
        let ed = editor.clone();
        cx.defer(move |cx| attach_if_linked(&ed, cx));
    }
    let th = crate::ui::components::t(window, cx);
    let Some(l) = link(editor, cx) else {
        return div().into_any_element();
    };
    let (icon_path, text, color, hint): (&str, String, gpui::Hsla, String) = match &l.status {
        Status::Connecting => (
            "icons/cloud.svg",
            "Connecting…".into(),
            th.faint,
            "Loading the latest version.".into(),
        ),
        Status::Synced => (
            "icons/cloud-check.svg",
            "Synced".into(),
            th.faint,
            "All changes are saved to the cloud.".into(),
        ),
        Status::Syncing(n) => (
            "icons/cloud-upload.svg",
            "Saving…".into(),
            th.muted,
            format!(
                "Sending {n} {}.",
                if *n == 1 { "change" } else { "changes" }
            ),
        ),
        Status::Offline(n) => (
            "icons/cloud-off.svg",
            if *n > 0 {
                format!("Offline · {n}")
            } else {
                "Offline".into()
            },
            th.accent_text,
            if *n > 0 {
                format!(
                    "{n} {} kept on this computer. They sync when you reconnect.",
                    if *n == 1 { "change" } else { "changes" }
                )
            } else {
                "Reconnecting… You can keep editing.".into()
            },
        ),
        Status::Error(m) => (
            "icons/cloud-alert.svg",
            "Not syncing".into(),
            th.danger,
            m.clone(),
        ),
    };
    let readonly = !l.can_edit();
    let status = l.status.clone();
    let people: Vec<Presence> = l.presence.clone();
    let mut seen = HashSet::new();
    let people: Vec<Presence> = people
        .into_iter()
        .filter(|p| seen.insert(p.user_id.clone()))
        .collect();
    let me = editor.entity_id();
    let avatars = people.iter().take(4).enumerate().map(|(i, p)| {
        let img = p
            .image
            .as_deref()
            .and_then(|u| crate::cloud::images::image(u, me, cx));
        let initials: String = p
            .name
            .split_whitespace()
            .filter_map(|w| w.chars().next())
            .take(2)
            .collect::<String>()
            .to_uppercase();
        let label = match &p.editing {
            Some(e) => format!(
                "{} · {}",
                p.name,
                e.get("label").and_then(Json::as_str).unwrap_or("editing")
            ),
            None if !p.selection.is_empty() => {
                format!("{} · {} selected", p.name, p.selection.len())
            }
            None => p.name.clone(),
        };
        div()
            .id(SharedString::from(format!("peer-{i}")))
            .when(i > 0, |d| d.ml(px(-6.0)))
            .tooltip(tip(label, None))
            .child(avatar(
                if initials.is_empty() { "?" } else { &initials },
                hsla(&p.color),
                img,
                26.0,
                &th,
            ))
    });
    let extra = people.len().saturating_sub(4);
    div()
        .flex()
        .items_center()
        .gap(px(10.0))
        .mr(px(6.0))
        .child(
            div()
                .flex()
                .items_center()
                .children(avatars)
                .when(extra > 0, |d| {
                    d.child(
                        div()
                            .ml(px(-6.0))
                            .size(px(26.0))
                            .rounded(px(13.0))
                            .flex()
                            .items_center()
                            .justify_center()
                            .bg(th.surface3)
                            .border_2()
                            .border_color(th.surface1)
                            .font_family(SANS)
                            .text_size(px(10.5))
                            .text_color(th.muted)
                            .child(format!("+{extra}")),
                    )
                }),
        )
        .child(
            div()
                .id("sync-status")
                .h(px(26.0))
                .px(px(9.0))
                .flex()
                .items_center()
                .gap(px(6.0))
                .rounded(px(999.0))
                .border_1()
                .border_color(if matches!(status, Status::Offline(_)) {
                    alpha(th.accent, 0.35)
                } else {
                    th.border_subtle
                })
                .tooltip(tip(
                    if readonly {
                        format!("{hint} You can view this design.")
                    } else {
                        hint
                    },
                    None,
                ))
                .child(icon(icon_path, 13.0, color))
                .child(
                    div()
                        .font_family(SANS)
                        .text_size(px(11.5))
                        .text_color(color)
                        .child(if readonly {
                            format!("{text} · View only")
                        } else {
                            text
                        }),
                ),
        )
        .into_any_element()
}

#[cfg(test)]
mod tests {
    #[test]
    fn link_permissions() {
        let (tx, _rx) = futures::channel::mpsc::unbounded();
        let l = super::CloudLink {
            design_id: "d".into(),
            workspace_id: "w".into(),
            permission: "view".into(),
            status: super::Status::Synced,
            presence: vec![],
            session_id: "s".into(),
            inputs: tx,
            uploading: Default::default(),
            _tasks: vec![],
        };
        assert!(!l.can_edit());
    }
}
