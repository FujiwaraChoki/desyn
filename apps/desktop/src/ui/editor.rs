//! `EditorView`: one open design in a tab. Wraps the [`EditorSession`] view model, wires actions and shortcuts,
//! clipboard, import, saving / autosave / crash-recovery snapshots, and lays out the editor chrome around the
//! canvas (top bar, tool dock, pages strip, extension panels).

use std::collections::HashMap;
use std::ops::Range;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use desyn_core::arrange::{Alignment, DistributeAxis, ZOrder};
use desyn_core::geometry::Point;
use desyn_core::model::Id;
use desyn_raster::Renderer;
use desyn_text::TextEngine;
use gpui::{
    AnyView, App, AppContext, Bounds, ClipboardEntry, ClipboardItem, ClipboardString, Context,
    Entity, EntityInputHandler, EventEmitter, ExternalPaths, FocusHandle, Focusable, IntoElement,
    KeyDownEvent, KeyUpEvent, ModifiersChangedEvent, ParentElement, Pixels, Render, RenderImage,
    SharedString, Styled, Subscription, Task, UTF16Selection, Window, div, prelude::*, px,
};

use super::actions::*;
use super::app::AppState;
use super::canvas::CanvasElement;
use super::components::{icon, icon_button, t, tip};
use super::dock;
use super::ext::{Extensions, PanelSpec, Slot};
use super::menu::{MenuEntry, PopupMenu};
use super::pages;
use super::text_field::{FieldEvent, TextField};
use super::theme::{MONO, SANS, Theme, alpha};
use crate::canvas::session::PlacingImage;
use crate::canvas::text::{DeleteUnit, Format, Move};
use crate::canvas::{ClipboardContent, Cursor, EditorSession, SessionEvent, Tool, ViewPrefs};
use crate::doc::{Change, Document};
use crate::file::format::{self, Thumbnails};
use crate::file::recovery::SnapshotInfo;
use crate::file::thumbnail;

/// What happened in an editor (workspace, panels and extension observers listen).
#[derive(Debug, Clone)]
pub enum EditorEvent {
    /// Transactions applied (in order; ops as applied, ready for sync).
    Changed(Vec<Change>),
    /// Selection changed.
    Selection(Vec<Id>),
    /// Active page changed.
    Page(Id),
    /// Saved to a file.
    Saved(PathBuf),
    /// Name, file or dirty state changed (tab titles).
    TitleChanged,
    /// Message for a toast.
    Notice(String),
    /// Text editing started / stopped.
    TextEditing(bool),
    /// Wants to open a file in a new tab (e.g. a dropped .desyn file).
    OpenFile(PathBuf),
}

/// Popup menus the editor can show.
#[derive(Clone)]
pub(crate) struct OpenMenu {
    pub(crate) menu: Entity<PopupMenu>,
    pub(crate) _sub: std::rc::Rc<Subscription>,
}

/// One open design.
pub struct EditorView {
    /// The view model.
    pub session: EditorSession,
    pub(crate) focus: FocusHandle,
    file: Option<PathBuf>,
    key: String,
    saving: Option<Task<()>>,
    autosave: Option<Task<()>>,
    recovery_task: Option<Task<()>>,
    last_recovery: Option<(Instant, u64)>,
    pub(crate) cursor: Cursor,
    pub(crate) canvas_bounds: Option<Bounds<Pixels>>,
    /// Tile textures by tile uid.
    pub(crate) tile_images: HashMap<u64, Arc<RenderImage>>,
    /// Page thumbnails: (revision rendered, image).
    pub(crate) thumbs: HashMap<Id, (u64, Arc<RenderImage>)>,
    /// Pages whose thumbnail no longer matches the design (only the pages an edit touched).
    pub(crate) thumb_dirty: std::collections::HashSet<Id>,
    pub(crate) retired_images: Vec<Arc<RenderImage>>,
    /// Hide the chrome (mod+\).
    pub focus_mode: bool,
    left_panel: Option<SharedString>,
    inspector_open: bool,
    panel_views: HashMap<SharedString, AnyView>,
    pub(crate) menu: Option<OpenMenu>,
    renaming: Option<(Option<Id>, Entity<TextField>, Subscription)>,
    /// Link being edited for a text range (mod+shift+U while typing).
    link_edit: Option<(Range<usize>, Entity<TextField>, Subscription)>,
    pub(crate) drop_active: bool,
    pub(crate) last_frame: Option<Instant>,
    saved_label: Option<Instant>,
    title_cache: String,
    last_shape: Tool,
    autosave_on: bool,
    pub(crate) last_change: Instant,
    thumb_timer: Option<Task<()>>,
    /// Debounced commit of typed text (400 ms without typing).
    text_checkpoint: Option<Task<()>>,
}

impl EventEmitter<EditorEvent> for EditorView {}

impl Focusable for EditorView {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

/// Idle time after the last keystroke before typed text is committed (DOCUMENT_MODEL §6).
const TEXT_CHECKPOINT_DELAY: Duration = Duration::from_millis(400);

static NEXT_KEY: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

impl EditorView {
    /// Opens a document.
    pub fn new(doc: Document, file: Option<PathBuf>, cx: &mut Context<Self>) -> EditorView {
        let renderer = Renderer::new(
            TextEngine::with_bundled_fonts(),
            Box::new(desyn_raster::NoAssets),
        );
        let mut session = EditorSession::new(doc, renderer);
        session.prefs = prefs_from(cx);
        // Settings changes (rulers, snapping, nudge) apply to open editors immediately.
        cx.observe_global::<AppState>(|this, cx| {
            this.session.prefs = prefs_from(cx);
            this.autosave_on = super::app::settings(Some(cx)).autosave;
            cx.notify();
        })
        .detach();
        let key = format!(
            "editor-{}",
            NEXT_KEY.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        );
        let mut v = EditorView {
            session,
            focus: cx.focus_handle(),
            file,
            key,
            saving: None,
            autosave: None,
            recovery_task: None,
            last_recovery: None,
            cursor: Cursor::Default,
            canvas_bounds: None,
            tile_images: HashMap::new(),
            thumbs: HashMap::new(),
            thumb_dirty: Default::default(),
            retired_images: Vec::new(),
            focus_mode: false,
            left_panel: None,
            inspector_open: true,
            panel_views: HashMap::new(),
            menu: None,
            renaming: None,
            link_edit: None,
            drop_active: false,
            last_frame: None,
            saved_label: None,
            title_cache: String::new(),
            last_shape: Tool::Rect,
            autosave_on: super::app::settings(Some(cx)).autosave,
            last_change: Instant::now(),
            thumb_timer: None,
            text_checkpoint: None,
        };
        v.title_cache = v.title();
        v
    }

    /// The file this design is saved in.
    pub fn file(&self) -> Option<&Path> {
        self.file.as_deref()
    }

    /// Stable key while open (recovery snapshots, scripts).
    pub fn key(&self) -> &str {
        &self.key
    }

    /// Design name.
    pub fn name(&self) -> String {
        let n = self.session.doc.design.name.trim();
        if n.is_empty() {
            "Untitled design".into()
        } else {
            n.to_string()
        }
    }

    /// Tab title ("Poster •" when unsaved).
    pub fn title(&self) -> String {
        if self.session.doc.is_dirty() && !(self.file.is_some() && self.autosave_on) {
            format!("{} •", self.name())
        } else {
            self.name()
        }
    }

    /// Whether there are unsaved changes.
    pub fn is_dirty(&self) -> bool {
        self.session.doc.is_dirty()
    }

    /// Applies ops as one undo step (feature modules: inspector edits, AI tools).
    pub fn apply(&mut self, ops: Vec<desyn_core::Op>, label: &str, cx: &mut Context<Self>) -> bool {
        let ok = self.session.commit(ops, label, None);
        self.after(cx);
        ok
    }

    /// Applies a transaction from elsewhere (sync / AI); see `Document::apply_external`.
    pub fn apply_external(
        &mut self,
        tx: &desyn_core::Transaction,
        undoable: bool,
        cx: &mut Context<Self>,
    ) -> bool {
        let ok = self.session.apply_external(tx, undoable);
        self.after(cx);
        ok
    }

    /// Adds asset bytes (images, fonts) and returns the asset id plus the op that registers it.
    pub fn add_asset(
        &mut self,
        bytes: Arc<[u8]>,
        meta: desyn_core::model::AssetRef,
    ) -> (Id, Vec<desyn_core::Op>) {
        let r = self.session.doc.add_asset(bytes, meta);
        self.session.sync_assets();
        r
    }

    /// Selects nodes.
    pub fn select(&mut self, ids: Vec<Id>, cx: &mut Context<Self>) {
        self.session.select(ids);
        self.after(cx);
    }

    /// Shows a page.
    pub fn set_page(&mut self, page: &str, cx: &mut Context<Self>) {
        self.session.set_page(page);
        self.after(cx);
    }

    /// PNG of a page (AI previews, share sheets).
    pub fn render_page_png(&mut self, page: &str, scale: f64) -> Option<Vec<u8>> {
        thumbnail::render_png(
            &mut self.session.renderer,
            &self.session.doc.design,
            &page.to_string(),
            {
                let n = self.session.doc.design.node(page)?;
                n.base().width.max(n.base().height) * scale
            },
        )
    }

    /// The shape tool the dock shows (the last one used).
    pub fn last_shape_tool(&self) -> Tool {
        self.last_shape
    }

    /// Marks layers an AI run is working on (a pulsing sun glow) or clears it with an empty list.
    pub fn set_activity(&mut self, ids: Vec<Id>, cx: &mut Context<Self>) {
        self.session.activity = ids;
        cx.notify();
    }

    /// Plays the "sunrise" glow on layers that just changed (e.g. when an AI run finishes).
    pub fn flash(&mut self, ids: Vec<Id>, cx: &mut Context<Self>) {
        self.session
            .flashes
            .extend(ids.into_iter().map(|i| (i, 1.0)));
        cx.notify();
    }

    /// Drains session events, notifies listeners, schedules autosave / recovery.
    pub fn after(&mut self, cx: &mut Context<Self>) {
        if self.session.tool.is_shape() {
            self.last_shape = self.session.tool;
        }
        if self
            .session
            .text
            .as_ref()
            .is_some_and(|t| t.has_uncommitted())
        {
            self.schedule_text_checkpoint(cx);
        } else if self.session.text.is_none() {
            self.text_checkpoint = None;
        }
        let events = self.session.take_events();
        let mut changed = false;
        for e in events {
            let ev = match e {
                SessionEvent::Changed(c) => {
                    changed = true;
                    let pages = touched_pages(&self.session.doc.design, &c);
                    self.thumb_dirty.extend(pages);
                    EditorEvent::Changed(c)
                }
                SessionEvent::Selection(s) => EditorEvent::Selection(s),
                SessionEvent::Page(p) => EditorEvent::Page(p),
                SessionEvent::Tool(_) => continue,
                SessionEvent::Notice(n) => EditorEvent::Notice(n),
                SessionEvent::TextEditing(b) => EditorEvent::TextEditing(b),
            };
            self.emit_event(ev, cx);
        }
        if changed {
            self.last_change = Instant::now();
            self.schedule_autosave(cx);
            self.schedule_recovery(cx);
            self.schedule_thumbnails(cx);
        }
        let title = self.title();
        if title != self.title_cache {
            self.title_cache = title;
            cx.emit(EditorEvent::TitleChanged);
        }
        cx.notify();
    }

    fn emit_event(&mut self, ev: EditorEvent, cx: &mut Context<Self>) {
        let observers = Extensions::get(cx).observers().to_vec();
        if !observers.is_empty() {
            let me = cx.entity();
            let ev2 = ev.clone();
            cx.defer(move |cx| {
                for o in &observers {
                    o(&me, &ev2, cx);
                }
            });
        }
        cx.emit(ev);
    }

    // -----------------------------------------------------------------------------------------------------------
    // Saving

    fn snapshot(&self) -> (desyn_core::model::Design, crate::doc::AssetBytes) {
        (
            self.session.doc.design.clone(),
            self.session.doc.assets.clone(),
        )
    }

    /// Saves to the current file (Save As when the design has none). `then` runs after a successful write.
    pub fn save(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        match self.file.clone() {
            Some(p) => self.save_to(p, true, cx),
            None => self.save_as(window, cx),
        }
    }

    /// Save As.
    pub fn save_as(&mut self, _window: &mut Window, cx: &mut Context<Self>) {
        let dir = self
            .file
            .as_ref()
            .and_then(|f| f.parent().map(Path::to_path_buf))
            .unwrap_or_else(|| super::app::library_dir(cx));
        let name = format!("{}.desyn", crate::paths::sanitize_file_stem(&self.name()));
        let rx = cx.prompt_for_new_path(&dir, Some(&name));
        cx.spawn(async move |this, cx| {
            let Ok(Ok(Some(mut path))) = rx.await else {
                return;
            };
            if path.extension().is_none_or(|e| e != "desyn") {
                path.set_extension("desyn");
            }
            let _ = this.update(cx, |this, cx| {
                let old = this.file.replace(path.clone());
                if let Some(old) = old {
                    AppState::update(cx, |s| s.recent.rename(&old, &path, &this.name()));
                }
                this.save_to(path, true, cx);
                cx.emit(EditorEvent::TitleChanged);
            });
        })
        .detach();
    }

    /// Writes the design to `path` on a background thread.
    pub fn save_to(&mut self, path: PathBuf, user: bool, cx: &mut Context<Self>) {
        if self.saving.is_some() {
            // A save is running; autosave will pick up later changes.
            if user {
                self.schedule_autosave(cx);
            }
            return;
        }
        let save_point = self.session.doc.save_point();
        let (design, assets) = self.snapshot();
        let p2 = path.clone();
        // Thumbnails render with the background renderer: autosaves of large multi-page designs never block
        // the canvas.
        let task = cx.background_spawn(async move {
            let thumbs = thumbnail::render_all_shared(&design, &assets);
            format::write(&p2, &design, &assets, &thumbs)
        });
        let key = self.key.clone();
        self.saving = Some(cx.spawn(async move |this, cx| {
            let res = task.await;
            let _ = this.update(cx, |this, cx| {
                this.saving = None;
                match res {
                    Ok(()) => {
                        this.session.doc.mark_saved(save_point);
                        if !this.session.doc.is_dirty()
                            && let Some(r) = super::app::recovery(cx)
                        {
                            r.discard(&key);
                        }
                        let name = this.name();
                        AppState::update(cx, |s| {
                            s.recent.touch(&path, &name, now_ms());
                            s.save_recent();
                            s.library.invalidate(&path);
                        });
                        this.saved_label = Some(Instant::now());
                        cx.emit(EditorEvent::Saved(path.clone()));
                        cx.emit(EditorEvent::TitleChanged);
                        this.title_cache = this.title();
                        if this.session.doc.is_dirty() {
                            this.schedule_autosave(cx);
                        }
                    }
                    Err(e) => {
                        log::error!("save {}: {e}", path.display());
                        cx.emit(EditorEvent::Notice(format!(
                            "Couldn't save “{}”: {e}",
                            path.display()
                        )));
                    }
                }
                cx.notify();
            });
        }));
    }

    /// Typing commits after 400 ms without keystrokes (DOCUMENT_MODEL §6), keeping the layer in edit mode.
    fn schedule_text_checkpoint(&mut self, cx: &mut Context<Self>) {
        self.text_checkpoint = Some(cx.spawn(async move |this, cx| {
            cx.background_executor().timer(TEXT_CHECKPOINT_DELAY).await;
            let _ = this.update(cx, |this, cx| {
                this.text_checkpoint = None;
                if this.session.checkpoint_text() {
                    this.after(cx);
                }
            });
        }));
    }

    /// Re-renders page thumbnails once editing pauses (never per frame while dragging or typing).
    fn schedule_thumbnails(&mut self, cx: &mut Context<Self>) {
        self.thumb_timer = Some(cx.spawn(async move |this, cx| {
            cx.background_executor()
                .timer(Duration::from_millis(350))
                .await;
            let _ = this.update(cx, |_, cx| cx.notify());
        }));
    }

    pub(crate) fn schedule_autosave(&mut self, cx: &mut Context<Self>) {
        let s = super::app::settings(Some(cx));
        if !s.autosave || self.file.is_none() {
            return;
        }
        let delay = Duration::from_millis(s.autosave_delay_ms);
        self.autosave = Some(cx.spawn(async move |this, cx| {
            cx.background_executor().timer(delay).await;
            let _ = this.update(cx, |this, cx| {
                this.autosave = None;
                if !this.session.doc.is_dirty() {
                    return;
                }
                if this.session.has_gesture() || this.session.doc.has_preview() {
                    // Never save half a gesture or a word being typed: try again shortly.
                    this.schedule_autosave(cx);
                    return;
                }
                if let Some(p) = this.file.clone() {
                    this.save_to(p, false, cx);
                }
            });
        }));
    }

    fn schedule_recovery(&mut self, cx: &mut Context<Self>) {
        if self.recovery_task.is_some() {
            return;
        }
        let interval = Duration::from_secs(super::app::settings(Some(cx)).recovery_interval_secs);
        let due = match self.last_recovery {
            Some((t, _)) => interval.saturating_sub(t.elapsed()),
            None => Duration::from_millis(500),
        };
        self.recovery_task = Some(cx.spawn(async move |this, cx| {
            cx.background_executor().timer(due).await;
            let _ = this.update(cx, |this, cx| {
                this.recovery_task = None;
                this.write_recovery(cx);
            });
        }));
    }

    fn write_recovery(&mut self, cx: &mut Context<Self>) {
        let rev = self.session.doc.revision();
        if !self.session.doc.is_dirty() || self.last_recovery.is_some_and(|(_, r)| r == rev) {
            return;
        }
        let Some(rec) = super::app::recovery(cx) else {
            return;
        };
        let (design, assets) = self.snapshot();
        let info = SnapshotInfo {
            origin: self.file.clone(),
            name: self.name(),
            saved_at: now_ms(),
        };
        let key = self.key.clone();
        cx.background_spawn(async move {
            match format::encode(&design, &assets, &Thumbnails::default()) {
                Ok(bytes) => {
                    if let Err(e) = rec.write(&key, &bytes, &info) {
                        log::warn!("recovery snapshot: {e}");
                    }
                }
                Err(e) => log::warn!("recovery snapshot: {e}"),
            }
        })
        .detach();
        self.last_recovery = Some((Instant::now(), rev));
    }

    /// Called when the tab closes: drops the recovery snapshot when nothing is unsaved.
    pub fn closing(&mut self, cx: &mut Context<Self>) {
        if !self.session.doc.is_dirty()
            && let Some(r) = super::app::recovery(cx)
        {
            r.discard(&self.key);
        }
    }

    /// Ends a running gesture and commits text / pen sessions so the document holds everything the user did.
    fn settle(&mut self, cx: &mut Context<Self>) {
        self.session.cancel_gesture();
        self.session.finish_text();
        self.session.finish_pen();
        self.after(cx);
    }

    /// Writes the design to its file synchronously (closing paths, where a background save would be cancelled
    /// together with the view). Errors are returned for a toast.
    pub fn write_now(&mut self, cx: &mut Context<Self>) -> Result<PathBuf, String> {
        let path = self
            .file
            .clone()
            .ok_or_else(|| "This design has no file yet.".to_string())?;
        let save_point = self.session.doc.save_point();
        let (design, assets) = self.snapshot();
        let thumbs = thumbnail::render_all(&mut self.session.renderer, &design);
        format::write(&path, &design, &assets, &thumbs).map_err(|e| {
            log::error!("save {}: {e}", path.display());
            format!("Couldn't save “{}”: {e}", path.display())
        })?;
        self.session.doc.mark_saved(save_point);
        if let Some(r) = super::app::recovery(cx) {
            r.discard(&self.key);
        }
        let name = self.name();
        AppState::update(cx, |s| {
            s.recent.touch(&path, &name, now_ms());
            s.save_recent();
            s.library.invalidate(&path);
        });
        self.saved_label = Some(Instant::now());
        self.title_cache = self.title();
        cx.emit(EditorEvent::Saved(path.clone()));
        cx.emit(EditorEvent::TitleChanged);
        cx.notify();
        Ok(path)
    }

    /// Saves before the tab or window closes: writes synchronously to the design's file, or asks for a file
    /// first (Save As) when it has none. Resolves to `true` once the design is on disk; `false` when the user
    /// cancelled the file dialog or the write failed (the caller then keeps the tab open).
    pub fn save_for_close(&mut self, window: &mut Window, cx: &mut Context<Self>) -> Task<bool> {
        self.settle(cx);
        if self.file.is_some() {
            let res = self.write_now(cx);
            if let Err(e) = &res {
                cx.emit(EditorEvent::Notice(e.clone()));
            }
            return Task::ready(res.is_ok());
        }
        let dir = super::app::library_dir(cx);
        let name = format!("{}.desyn", crate::paths::sanitize_file_stem(&self.name()));
        let rx = cx.prompt_for_new_path(&dir, Some(&name));
        cx.spawn_in(window, async move |this, cx| {
            let Ok(Ok(Some(mut path))) = rx.await else {
                return false;
            };
            if path.extension().is_none_or(|e| e != "desyn") {
                path.set_extension("desyn");
            }
            this.update(cx, |this, cx| {
                this.file = Some(path);
                match this.write_now(cx) {
                    Ok(_) => true,
                    Err(e) => {
                        this.file = None;
                        cx.emit(EditorEvent::Notice(e));
                        false
                    }
                }
            })
            .unwrap_or(false)
        })
    }

    /// Drops this design's crash-recovery snapshot (the user chose not to keep the changes).
    pub fn discard_recovery(&self, cx: &App) {
        if let Some(r) = super::app::recovery(cx) {
            r.discard(&self.key);
        }
    }

    /// Finishes any gesture / text / pen session and, when autosave applies, writes the design synchronously.
    /// Used when a tab, window or the app closes (a pending background save would be cancelled with the view).
    /// Unsaved designs that cannot be autosaved get a fresh crash-recovery snapshot, so quitting never loses the
    /// edits made since the last periodic snapshot (they are offered again on the next start).
    pub fn flush(&mut self, cx: &mut Context<Self>) {
        self.settle(cx);
        let autosave = super::app::settings(Some(cx)).autosave;
        if !self.session.doc.is_dirty() {
            self.closing(cx);
            return;
        }
        if autosave && self.file.is_some() {
            if let Err(e) = self.write_now(cx) {
                log::error!("save on close: {e}");
                self.write_recovery_now(cx);
            }
        } else {
            self.write_recovery_now(cx);
        }
        self.closing(cx);
    }

    /// Writes the crash-recovery snapshot synchronously (quit / close paths).
    fn write_recovery_now(&mut self, cx: &mut Context<Self>) {
        let Some(rec) = super::app::recovery(cx) else {
            return;
        };
        let (design, assets) = self.snapshot();
        let info = SnapshotInfo {
            origin: self.file.clone(),
            name: self.name(),
            saved_at: now_ms(),
        };
        match format::encode(&design, &assets, &Thumbnails::default()) {
            Ok(bytes) => {
                if let Err(e) = rec.write(&self.key, &bytes, &info) {
                    log::warn!("recovery snapshot: {e}");
                }
            }
            Err(e) => log::warn!("recovery snapshot: {e}"),
        }
        self.last_recovery = Some((Instant::now(), self.session.doc.revision()));
    }

    /// "Saved", "Saving…" or "Unsaved changes".
    fn save_status(&self, cx: &App) -> Option<(&'static str, bool)> {
        if self.saving.is_some() {
            return Some(("Saving…", false));
        }
        if self.session.doc.is_dirty() {
            let auto = self.file.is_some() && super::app::settings(Some(cx)).autosave;
            return Some((if auto { "Editing" } else { "Unsaved changes" }, !auto));
        }
        if self
            .saved_label
            .is_some_and(|t| t.elapsed() < Duration::from_secs(3))
        {
            return Some(("Saved", false));
        }
        None
    }

    // -----------------------------------------------------------------------------------------------------------
    // Clipboard, import

    fn copy(&mut self, cx: &mut Context<Self>) {
        match self.session.copy() {
            Some(ClipboardContent::Layers(c, png)) => {
                let mut entries = vec![ClipboardEntry::String(ClipboardString::new(c.json))];
                if let Some(png) = png {
                    entries.push(ClipboardEntry::Image(gpui::Image::from_bytes(
                        gpui::ImageFormat::Png,
                        png,
                    )));
                }
                cx.write_to_clipboard(ClipboardItem { entries });
            }
            Some(ClipboardContent::Text(s)) => cx.write_to_clipboard(ClipboardItem::new_string(s)),
            None => {}
        }
        self.after(cx);
    }

    fn cut(&mut self, cx: &mut Context<Self>) {
        match self.session.cut() {
            Some(ClipboardContent::Layers(c, _)) => {
                cx.write_to_clipboard(ClipboardItem::new_string(c.json))
            }
            Some(ClipboardContent::Text(s)) => cx.write_to_clipboard(ClipboardItem::new_string(s)),
            None => {}
        }
        self.after(cx);
    }

    fn paste(&mut self, in_place: bool, cx: &mut Context<Self>) {
        let Some(item) = cx.read_from_clipboard() else {
            return;
        };
        match paste_choice(item.entries(), self.session.text.is_some()) {
            Some(PasteChoice::Text(s)) => self.session.paste_text(&s, in_place),
            Some(PasteChoice::Image(bytes)) => {
                self.session.paste_bytes(Arc::from(bytes), None, None);
            }
            Some(PasteChoice::Files(paths)) => {
                let at = self.canvas_center();
                self.import_paths(paths, at, cx);
            }
            None => {}
        }
        self.after(cx);
    }

    fn canvas_center(&self) -> Option<Point> {
        Some(Point::new(
            self.session.camera.width / 2.0,
            self.session.camera.height / 2.0,
        ))
    }

    /// Imports files (SVG, images, JSON layers) at a canvas point; `.desyn` files open in new tabs and whole
    /// design JSON files open as new designs.
    pub fn import_paths(&mut self, paths: Vec<PathBuf>, at: Option<Point>, cx: &mut Context<Self>) {
        let task = cx.background_spawn(async move {
            paths
                .into_iter()
                .map(|p| {
                    let bytes = std::fs::metadata(&p)
                        .map_err(|e| e.to_string())
                        .and_then(|m| {
                            if m.len() as usize > crate::doc::import::MAX_IMPORT_BYTES {
                                Err("larger than 256 MB".to_string())
                            } else {
                                std::fs::read(&p).map_err(|e| e.to_string())
                            }
                        });
                    (p, bytes)
                })
                .collect::<Vec<_>>()
        });
        cx.spawn(async move |this, cx| {
            let files = task.await;
            let _ = this.update(cx, |this, cx| {
                for (i, (path, bytes)) in files.into_iter().enumerate() {
                    let name = path.file_name().map(|n| n.to_string_lossy().into_owned());
                    if path
                        .extension()
                        .is_some_and(|e| e.eq_ignore_ascii_case("desyn"))
                    {
                        cx.emit(EditorEvent::OpenFile(path));
                        continue;
                    }
                    let bytes = match bytes {
                        Ok(b) => b,
                        Err(e) => {
                            cx.emit(EditorEvent::Notice(format!(
                                "Couldn't read “{}”: {e}",
                                path.display()
                            )));
                            continue;
                        }
                    };
                    if matches!(
                        crate::doc::import::sniff(&bytes, name.as_deref()),
                        Ok(crate::doc::import::Importable::Design(_))
                    ) {
                        cx.emit(EditorEvent::OpenFile(path));
                        continue;
                    }
                    let offset = Point::new(24.0 * i as f64, 24.0 * i as f64);
                    let at = at.map(|p| p + offset);
                    this.session
                        .paste_bytes(Arc::from(bytes), name.as_deref(), at);
                }
                this.after(cx);
            });
        })
        .detach();
    }

    fn import_dialog(&mut self, cx: &mut Context<Self>) {
        let rx = cx.prompt_for_paths(gpui::PathPromptOptions {
            files: true,
            directories: false,
            multiple: true,
            prompt: Some("Import".into()),
        });
        cx.spawn(async move |this, cx| {
            let Ok(Ok(Some(paths))) = rx.await else {
                return;
            };
            let _ = this.update(cx, |this, cx| {
                let at = this.canvas_center();
                this.import_paths(paths, at, cx);
            });
        })
        .detach();
    }

    fn place_image_dialog(&mut self, cx: &mut Context<Self>) {
        let rx = cx.prompt_for_paths(gpui::PathPromptOptions {
            files: true,
            directories: false,
            multiple: false,
            prompt: Some("Place image".into()),
        });
        cx.spawn(async move |this, cx| {
            let Ok(Ok(Some(paths))) = rx.await else {
                return;
            };
            let Some(path) = paths.into_iter().next() else {
                return;
            };
            let read = cx
                .background_spawn(async move { (std::fs::read(&path), path) })
                .await;
            let _ = this.update(cx, |this, cx| {
                let (bytes, path) = read;
                let name = path
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_default();
                match bytes.map_err(|e| e.to_string()).and_then(|b| {
                    crate::doc::import::sniff(&b, Some(&name))
                        .map(|k| (b, k))
                        .map_err(|e| e.0)
                }) {
                    Ok((b, crate::doc::import::Importable::Image { width, height, .. })) => {
                        this.session.start_placing(PlacingImage {
                            bytes: Arc::from(b),
                            name,
                            size: (width as f64, height as f64),
                        });
                    }
                    Ok((b, crate::doc::import::Importable::Svg { width, height })) => {
                        this.session.start_placing(PlacingImage {
                            bytes: Arc::from(b),
                            name,
                            size: (width, height),
                        });
                    }
                    Ok(_) => cx.emit(EditorEvent::Notice(
                        "Choose an image or SVG to place.".into(),
                    )),
                    Err(e) => cx.emit(EditorEvent::Notice(e)),
                }
                this.after(cx);
            });
        })
        .detach();
    }

    // -----------------------------------------------------------------------------------------------------------
    // Renaming

    /// Starts renaming the design (`None`) or a layer.
    pub fn start_rename(
        &mut self,
        target: Option<Id>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let current = match &target {
            Some(id) => self
                .session
                .doc
                .design
                .node(id)
                .map(|n| n.base().name.clone())
                .unwrap_or_default(),
            None => self.name(),
        };
        let field = cx.new(|cx| {
            let mut f = TextField::new("Name", cx);
            f.font_size = 13.0;
            f.set_text(&current, cx);
            f
        });
        let sub = cx.subscribe_in(
            &field,
            window,
            |this, field, ev: &FieldEvent, window, cx| match ev {
                FieldEvent::Confirm => {
                    let text = field.read(cx).text().to_string();
                    this.finish_rename(Some(text), window, cx);
                }
                FieldEvent::Cancel => this.finish_rename(None, window, cx),
                _ => {}
            },
        );
        window.focus(&field.focus_handle(cx), cx);
        self.renaming = Some((target, field, sub));
        cx.notify();
    }

    fn finish_rename(&mut self, text: Option<String>, window: &mut Window, cx: &mut Context<Self>) {
        let Some((target, _, _)) = self.renaming.take() else {
            return;
        };
        if let Some(text) = text.map(|t| t.trim().to_string()).filter(|t| !t.is_empty()) {
            match target {
                Some(id) => self.session.rename(&id, &text),
                None => {
                    let op = desyn_core::Op::Doc(desyn_core::model::DocOp {
                        set: desyn_core::model::DocSet {
                            name: Some(text.clone()),
                            ..Default::default()
                        },
                        unset: None,
                    });
                    self.session.commit(vec![op], "Rename design", None);
                }
            }
        }
        window.focus(&self.focus, cx);
        self.after(cx);
    }

    // -----------------------------------------------------------------------------------------------------------
    // Text links

    /// Opens the link field for the selected text (or the word at the caret).
    pub fn start_link_edit(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some((range, current)) = self.session.text_link_target() else {
            cx.emit(EditorEvent::Notice(
                "Links apply to text: double-click a text layer and select words first.".into(),
            ));
            return;
        };
        let field = cx.new(|cx| {
            let mut f = TextField::new("Paste or type a link", cx);
            f.font_size = 13.0;
            f.set_text(current.as_deref().unwrap_or(""), cx);
            f
        });
        let sub = cx.subscribe_in(
            &field,
            window,
            |this, field, ev: &FieldEvent, window, cx| match ev {
                FieldEvent::Confirm => {
                    let text = field.read(cx).text().to_string();
                    this.finish_link_edit(Some(text), window, cx);
                }
                FieldEvent::Cancel => this.finish_link_edit(None, window, cx),
                _ => {}
            },
        );
        window.focus(&field.focus_handle(cx), cx);
        self.link_edit = Some((range, field, sub));
        cx.notify();
    }

    fn finish_link_edit(
        &mut self,
        text: Option<String>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some((range, _, _)) = self.link_edit.take() else {
            return;
        };
        if let Some(text) = text {
            match crate::canvas::text::normalize_link(&text) {
                Ok(link) => {
                    let removed = link.is_none();
                    self.session.text_set_link(range, link);
                    if removed {
                        cx.emit(EditorEvent::Notice("Link removed.".into()));
                    }
                }
                Err(e) => cx.emit(EditorEvent::Notice(e)),
            }
        }
        window.focus(&self.focus, cx);
        self.after(cx);
    }

    fn link_field(&self, th: &Theme) -> Option<gpui::AnyElement> {
        let (_, field, _) = self.link_edit.as_ref()?;
        let g = self.session.text_geometry()?;
        // Below the selection (or the caret), clamped into the canvas.
        let bottom = g
            .selection
            .iter()
            .flat_map(|q| q.iter())
            .chain(g.caret.iter())
            .fold(f64::MIN, |m, p| m.max(p.y));
        let left = g.selection.first().map(|q| q[3].x).unwrap_or(g.caret[1].x);
        let max_x = (self.session.camera.width - 340.0).max(8.0);
        let max_y = (self.session.camera.height - 48.0).max(8.0);
        Some(
            div()
                .absolute()
                .left(px(left.clamp(8.0, max_x) as f32))
                .top(px((bottom + 10.0).clamp(8.0, max_y) as f32))
                .w(px(320.0))
                .h(px(34.0))
                .px(px(10.0))
                .flex()
                .items_center()
                .gap(px(8.0))
                .rounded(px(10.0))
                .bg(th.glass)
                .border_1()
                .border_color(alpha(th.accent, 0.6))
                .shadow(vec![
                    gpui::BoxShadow::new(px(0.0), px(10.0), alpha(gpui::black(), 0.35))
                        .blur_radius(px(28.0)),
                ])
                .child(icon("icons/link.svg", 14.0, th.accent_text))
                .child(div().flex_1().min_w(px(0.0)).child(field.clone()))
                .into_any_element(),
        )
    }

    // -----------------------------------------------------------------------------------------------------------
    // Menus

    pub(crate) fn open_menu(
        &mut self,
        entries: Vec<MenuEntry>,
        at: gpui::Point<Pixels>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let focus = self.focus.clone();
        let menu = cx.new(|cx| PopupMenu::new(entries, at, focus, cx));
        let sub = cx.subscribe_in(
            &menu,
            window,
            |this, _, _: &super::menu::MenuDismissed, window, cx| {
                this.menu = None;
                window.focus(&this.focus, cx);
                cx.notify();
            },
        );
        window.focus(&menu.focus_handle(cx), cx);
        self.menu = Some(OpenMenu {
            menu,
            _sub: std::rc::Rc::new(sub),
        });
        cx.notify();
    }

    fn context_menu_entries(&self, cx: &App) -> Vec<MenuEntry> {
        let has_sel = !self.session.selection.is_empty();
        let mut v = vec![
            MenuEntry::action("Cut", Cut).enabled(has_sel),
            MenuEntry::action("Copy", Copy).enabled(has_sel),
            MenuEntry::action("Paste", Paste),
            MenuEntry::action("Paste in place", PasteInPlace),
            MenuEntry::action("Duplicate", Duplicate).enabled(has_sel),
            MenuEntry::action("Delete", Delete).enabled(has_sel),
            MenuEntry::Separator,
        ];
        if has_sel {
            v.extend([
                MenuEntry::action("Bring forward", BringForward),
                MenuEntry::action("Send backward", SendBackward),
                MenuEntry::action("Bring to front", BringToFront),
                MenuEntry::action("Send to back", SendToBack),
                MenuEntry::Separator,
                MenuEntry::action("Group", Group),
                MenuEntry::action("Ungroup", Ungroup),
                MenuEntry::action("Frame selection", FrameSelection),
                MenuEntry::action("Add auto-layout", AddAutoLayout),
                MenuEntry::action("Use as mask", UseAsMask),
                MenuEntry::Separator,
                MenuEntry::action("Flip horizontal", FlipHorizontal),
                MenuEntry::action("Flip vertical", FlipVertical),
                MenuEntry::action("Lock / unlock", ToggleLock),
                MenuEntry::action("Hide / show", ToggleHide),
                MenuEntry::action("Rename", RenameLayer),
            ]);
        } else {
            v.extend([
                MenuEntry::action("Select all", SelectAll),
                MenuEntry::action("Zoom to fit", ZoomFitAll),
                MenuEntry::action("Add page", AddPage),
            ]);
        }
        let ext = Extensions::get(cx);
        let extra: Vec<MenuEntry> = [
            ("Export…", Box::new(Export) as Box<dyn gpui::Action>),
            ("Comments", Box::new(Comments)),
        ]
        .into_iter()
        .filter(|(_, a)| ext.handles(a.as_ref()))
        .map(|(l, a)| MenuEntry::boxed(l, a))
        .collect();
        if !extra.is_empty() {
            v.push(MenuEntry::Separator);
            v.extend(extra);
        }
        v
    }

    pub(crate) fn show_context_menu(
        &mut self,
        at: gpui::Point<Pixels>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let entries = self.context_menu_entries(cx);
        self.open_menu(entries, at, window, cx);
    }

    pub(crate) fn zoom_menu_entries(&self, cx: &App) -> Vec<MenuEntry> {
        let pages_strip = super::app::settings(Some(cx)).pages_strip;
        let p = &self.session.prefs;
        vec![
            MenuEntry::action("Zoom in", ZoomIn),
            MenuEntry::action("Zoom out", ZoomOut),
            MenuEntry::action("Zoom to 100%", Zoom100),
            MenuEntry::action("Zoom to fit all", ZoomFitAll),
            MenuEntry::action("Zoom to selection", ZoomSelection),
            MenuEntry::action("Fit page", ZoomFitPage),
            MenuEntry::Separator,
            MenuEntry::action("Rulers", ToggleRulers).checked(p.rulers),
            MenuEntry::action("Layout grid", ToggleLayoutGrid).checked(p.layout_grid),
            MenuEntry::action("Pixel grid", TogglePixelGrid).checked(p.pixel_grid),
            MenuEntry::action("Snapping", ToggleSnapping).checked(p.snap.enabled),
            MenuEntry::action("Smart distances", ToggleSmartDistances).checked(p.smart_distances),
            MenuEntry::action("Pages strip", TogglePagesStrip).checked(pages_strip),
        ]
    }

    // -----------------------------------------------------------------------------------------------------------
    // Rendering helpers

    fn panel_view(
        &mut self,
        spec: &PanelSpec,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyView {
        if let Some(v) = self.panel_views.get(&spec.id) {
            return v.clone();
        }
        let me = cx.entity();
        let v = (spec.build)(&me, window, cx);
        self.panel_views.insert(spec.id.clone(), v.clone());
        v
    }

    fn top_bar(
        &mut self,
        th: &Theme,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> gpui::AnyElement {
        let me = cx.entity();
        let can_undo = self.session.doc.history().can_undo();
        let can_redo = self.session.doc.history().can_redo();
        let zoom = self.session.camera.percent_label();
        let status = self.save_status(cx);
        let items: Vec<_> = Extensions::get(cx)
            .top_bar_items()
            .into_iter()
            .map(|f| f(&me, window, cx))
            .collect();
        let name: SharedString = self.name().into();
        let undo_label = self
            .session
            .doc
            .history()
            .undo_label()
            .map(|l| format!("Undo {l}"));
        let redo_label = self
            .session
            .doc
            .history()
            .redo_label()
            .map(|l| format!("Redo {l}"));
        let file_tip = self
            .file
            .as_ref()
            .map(|f| f.display().to_string())
            .unwrap_or_else(|| "Not saved yet".into());
        div()
            .h(px(44.0))
            .flex_none()
            .flex()
            .items_center()
            .px(px(12.0))
            .gap(px(4.0))
            .border_b_1()
            .border_color(th.border_subtle)
            .bg(th.surface1)
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(10.0))
                    .min_w(px(0.0))
                    .flex_1()
                    .child(match &self.renaming {
                        Some((None, field, _)) => div()
                            .w(px(260.0))
                            .h(px(28.0))
                            .px(px(8.0))
                            .flex()
                            .items_center()
                            .rounded(px(6.0))
                            .bg(th.surface2)
                            .border_1()
                            .border_color(alpha(th.accent, 0.6))
                            .child(field.clone())
                            .into_any_element(),
                        _ => div()
                            .id("doc-name")
                            .px(px(8.0))
                            .h(px(28.0))
                            .flex()
                            .items_center()
                            .rounded(px(6.0))
                            .font_family(SANS)
                            .text_size(px(13.5))
                            .font_weight(gpui::FontWeight(550.0))
                            .text_color(th.fg)
                            .cursor_pointer()
                            .hover({
                                let s3 = th.surface3;
                                move |s| s.bg(s3)
                            })
                            .tooltip(tip(file_tip, None))
                            .on_click(cx.listener(|this, _, window, cx| {
                                this.start_rename(None, window, cx)
                            }))
                            .child(name)
                            .into_any_element(),
                    })
                    .when_some(status, |d, (s, warn)| {
                        d.child(
                            div()
                                .font_family(SANS)
                                .text_size(px(12.0))
                                .text_color(if warn { th.accent_text } else { th.faint })
                                .child(s),
                        )
                    }),
            )
            .child(
                icon_button("undo", "icons/undo-2.svg", 32.0, false, th)
                    .when(!can_undo, |d| d.opacity(0.35))
                    .tooltip(tip(
                        undo_label.unwrap_or_else(|| "Undo".into()),
                        Some(super::actions::shortcut_label("secondary-z")),
                    ))
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.session.undo();
                        this.after(cx);
                    })),
            )
            .child(
                icon_button("redo", "icons/redo-2.svg", 32.0, false, th)
                    .when(!can_redo, |d| d.opacity(0.35))
                    .tooltip(tip(
                        redo_label.unwrap_or_else(|| "Redo".into()),
                        Some(super::actions::shortcut_label("secondary-shift-z")),
                    ))
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.session.redo();
                        this.after(cx);
                    })),
            )
            .child(div().w(px(8.0)))
            .child(
                div()
                    .id("zoom")
                    .h(px(28.0))
                    .px(px(10.0))
                    .flex()
                    .items_center()
                    .gap(px(4.0))
                    .rounded(px(6.0))
                    .font_family(MONO)
                    .text_size(px(12.0))
                    .text_color(th.muted)
                    .cursor_pointer()
                    .hover({
                        let s3 = th.surface3;
                        let fg = th.fg;
                        move |s| s.bg(s3).text_color(fg)
                    })
                    .child(zoom)
                    .child(icon("icons/chevron-down.svg", 12.0, th.faint))
                    .on_click(cx.listener(|this, e: &gpui::ClickEvent, window, cx| {
                        let entries = this.zoom_menu_entries(cx);
                        let p = e.position();
                        this.open_menu(
                            entries,
                            gpui::point(p.x - px(60.0), px(44.0) + window_top(window)),
                            window,
                            cx,
                        );
                    })),
            )
            .children(items)
            .into_any_element()
    }

    fn left_rail(
        &mut self,
        th: &Theme,
        panels: &[PanelSpec],
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<gpui::AnyElement> {
        if panels.is_empty() || self.focus_mode {
            return None;
        }
        let open = self.left_panel.clone();
        let flyout = match open
            .as_ref()
            .and_then(|id| panels.iter().find(|p| &p.id == id))
        {
            Some(spec) => {
                let v = self.panel_view(spec, window, cx);
                Some(
                    div()
                        .w(px(320.0))
                        .h_full()
                        .flex_none()
                        .bg(th.surface1)
                        .border_r_1()
                        .border_color(th.border_subtle)
                        .child(v),
                )
            }
            None => None,
        };
        let rail = div()
            .w(px(64.0))
            .h_full()
            .flex_none()
            .flex()
            .flex_col()
            .items_center()
            .gap(px(4.0))
            .py(px(10.0))
            .bg(th.surface1)
            .border_r_1()
            .border_color(th.border_subtle)
            .children(panels.iter().map(|p| {
                let active = open.as_ref() == Some(&p.id);
                let id = p.id.clone();
                let fg = if active { th.accent_text } else { th.muted };
                div()
                    .id(SharedString::from(format!("rail-{}", p.id)))
                    .w(px(56.0))
                    .py(px(6.0))
                    .flex()
                    .flex_col()
                    .items_center()
                    .gap(px(3.0))
                    .rounded(px(10.0))
                    .cursor_pointer()
                    .when(active, |d| d.bg(th.accent_soft))
                    .hover({
                        let s3 = th.surface3;
                        move |s| s.bg(s3)
                    })
                    .child(icon(p.icon.clone(), 18.0, fg))
                    .child(
                        div()
                            .font_family(SANS)
                            .text_size(px(10.5))
                            .text_color(fg)
                            .child(p.title.clone()),
                    )
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.left_panel = if this.left_panel.as_ref() == Some(&id) {
                            None
                        } else {
                            Some(id.clone())
                        };
                        cx.notify();
                    }))
            }));
        Some(
            div()
                .h_full()
                .flex()
                .child(rail)
                .children(flyout)
                .into_any_element(),
        )
    }

    /// Opens or closes a left panel by id (feature modules bind `LayersPanel` etc. to this).
    pub fn toggle_left_panel(&mut self, id: &str, cx: &mut Context<Self>) {
        let id: SharedString = id.to_string().into();
        self.left_panel = if self.left_panel.as_ref() == Some(&id) {
            None
        } else {
            Some(id)
        };
        cx.notify();
    }

    /// Shows / hides the right inspector column.
    pub fn toggle_inspector(&mut self, cx: &mut Context<Self>) {
        self.inspector_open = !self.inspector_open;
        cx.notify();
    }

    fn ext_action<A: gpui::Action>(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
        fallback: &str,
    ) {
        match Extensions::get(cx).handler::<A>() {
            Some(h) => {
                let me = cx.entity();
                // Run outside this editor's update so handlers can update the editor (window.defer, not defer_in).
                window.defer(cx, move |window, cx| h(&me, window, cx));
            }
            None => cx.emit(EditorEvent::Notice(fallback.to_string())),
        }
    }

    fn on_key_down(&mut self, e: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        // Space pans only while the canvas itself has focus (not a field in a panel or the inspector).
        if e.keystroke.key == "space"
            && self.focus.is_focused(window)
            && self.session.text.is_none()
            && self.renaming.is_none()
            && !self.session.space
        {
            self.session.space = true;
            cx.stop_propagation();
            cx.notify();
        }
    }

    fn on_key_up(&mut self, e: &KeyUpEvent, _: &mut Window, cx: &mut Context<Self>) {
        if e.keystroke.key == "space" && self.session.space {
            self.session.space = false;
            cx.notify();
        }
    }

    fn on_modifiers(&mut self, e: &ModifiersChangedEvent, _: &mut Window, cx: &mut Context<Self>) {
        if self.session.alt != e.modifiers.alt {
            self.session.alt = e.modifiers.alt;
            cx.notify();
        }
    }

    fn text_utf16_range(&self, r: Range<usize>) -> Range<usize> {
        match &self.session.text {
            Some(t) => t.from_utf16(r.start)..t.from_utf16(r.end),
            None => 0..0,
        }
    }
}

/// Pages whose rendering an applied change may have altered: the page of every updated / patched / created
/// node; deletes, moves, asset, style and document changes (whose old page is unknown or which can affect any
/// page) mark every page.
fn touched_pages(design: &desyn_core::model::Design, changes: &[Change]) -> Vec<Id> {
    use desyn_core::Op;
    let all = || design.page_ids().to_vec();
    let mut out = Vec::new();
    for c in changes {
        for op in &c.tx.ops {
            let id = match op {
                Op::Update(u) => u.id.as_str(),
                Op::Patch(p) => p.id.as_str(),
                Op::Create(c) => c.parent.as_str(),
                _ => return all(),
            };
            match design.page_of(id) {
                Some(p) => out.push(p.to_string()),
                // A page itself (or the root) changed.
                None if design.page_ids().iter().any(|p| p == id) => out.push(id.to_string()),
                None => return all(),
            }
        }
    }
    out
}

/// What a paste uses from the clipboard's entries.
#[derive(Debug, PartialEq)]
enum PasteChoice {
    Text(String),
    Image(Vec<u8>),
    Files(Vec<PathBuf>),
}

/// Picks the richest usable entry: Desyn layers JSON first (it carries editable layers), then an image (apps
/// such as browsers put a URL or HTML next to a copied picture), then files, then plain text. While typing in a
/// text layer only text applies.
fn paste_choice(entries: &[ClipboardEntry], typing: bool) -> Option<PasteChoice> {
    let texts = entries.iter().filter_map(|e| match e {
        ClipboardEntry::String(s) => Some(s.text().to_string()),
        _ => None,
    });
    if typing {
        return texts.into_iter().next().map(PasteChoice::Text);
    }
    let texts: Vec<String> = texts.collect();
    if let Some(t) = texts
        .iter()
        .find(|t| desyn_core::clipboard::ClipboardPayload::from_json(t).is_some())
    {
        return Some(PasteChoice::Text(t.clone()));
    }
    for e in entries {
        match e {
            ClipboardEntry::Image(img) => return Some(PasteChoice::Image(img.bytes.clone())),
            ClipboardEntry::ExternalPaths(p) => {
                return Some(PasteChoice::Files(p.paths().to_vec()));
            }
            _ => {}
        }
    }
    texts.into_iter().next().map(PasteChoice::Text)
}

fn window_top(_window: &Window) -> Pixels {
    px(36.0)
}

fn now_ms() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as f64)
        .unwrap_or(0.0)
}

/// View preferences from the global settings.
pub fn prefs_from(cx: &App) -> ViewPrefs {
    let s = super::app::settings(Some(cx));
    ViewPrefs {
        snap: s.snapping,
        rulers: s.rulers,
        layout_grid: s.layout_grid,
        pixel_grid: s.pixel_grid,
        smart_distances: s.smart_distances,
        nudge: s.nudge,
        big_nudge: s.big_nudge,
    }
}

/// Registers simple session commands as action listeners.
macro_rules! session_actions {
    ($div:expr, $cx:expr, $( $a:ty => |$s:ident| $body:expr ),* $(,)?) => {
        $div $( .on_action($cx.listener(|this: &mut EditorView, _: &$a, _w: &mut Window, cx: &mut Context<EditorView>| {
            let $s = &mut this.session;
            $body;
            this.after(cx);
        })) )*
    };
}

impl EntityInputHandler for EditorView {
    fn text_for_range(
        &mut self,
        r: Range<usize>,
        adjusted: &mut Option<Range<usize>>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<String> {
        let t = self.session.text.as_ref()?;
        let text = t.buffer.text();
        let range = self.text_utf16_range(r);
        let range = range.start.min(text.len())..range.end.min(text.len());
        adjusted.replace(t.to_utf16(range.start)..t.to_utf16(range.end));
        text.get(range).map(str::to_string)
    }

    fn selected_text_range(
        &mut self,
        _: bool,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<UTF16Selection> {
        let t = self.session.text.as_ref()?;
        let s = t.selection();
        Some(UTF16Selection {
            range: t.to_utf16(s.start)..t.to_utf16(s.end),
            reversed: t.head < t.anchor,
        })
    }

    fn marked_text_range(&self, _: &mut Window, _: &mut Context<Self>) -> Option<Range<usize>> {
        let t = self.session.text.as_ref()?;
        t.marked
            .as_ref()
            .map(|m| t.to_utf16(m.start)..t.to_utf16(m.end))
    }

    fn unmark_text(&mut self, _: &mut Window, cx: &mut Context<Self>) {
        if let Some(t) = &mut self.session.text {
            t.unmark();
        }
        cx.notify();
    }

    fn replace_text_in_range(
        &mut self,
        r: Option<Range<usize>>,
        s: &str,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.session.text.is_none() {
            return;
        }
        let range = r.map(|r| self.text_utf16_range(r));
        self.session.with_text(|t, _, _| {
            if let Some(range) = range
                && t.marked.is_none()
            {
                t.anchor = range.start;
                t.head = range.end;
            }
            t.insert(s);
        });
        self.after(cx);
    }

    fn replace_and_mark_text_in_range(
        &mut self,
        r: Option<Range<usize>>,
        s: &str,
        sel: Option<Range<usize>>,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.session.text.is_none() {
            return;
        }
        let range = r.map(|r| self.text_utf16_range(r));
        // The selection inside the composition is in UTF-16 units of the composed string.
        let sel = sel.map(|r| {
            let to8 = |i: usize| desyn_text::utf16_to_utf8(s, i);
            to8(r.start)..to8(r.end)
        });
        self.session
            .with_text(|t, _, _| t.set_marked(range, s, sel));
        self.after(cx);
    }

    fn bounds_for_range(
        &mut self,
        r: Range<usize>,
        element: Bounds<Pixels>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<Bounds<Pixels>> {
        let range = self.text_utf16_range(r);
        let t = self.session.text.as_ref()?;
        let (laid, w) = self.session.text_layout.as_ref()?;
        let c = laid.caret_rect(desyn_text::TextPosition {
            index: range.start,
            affinity: t.affinity,
        });
        let top = self.session.camera.to_screen(w.apply(Point::new(c.x, c.y)));
        let bottom = self
            .session
            .camera
            .to_screen(w.apply(Point::new(c.x, c.y + c.height)));
        Some(Bounds::from_corners(
            gpui::point(
                element.left() + px(top.x as f32),
                element.top() + px(top.y as f32),
            ),
            gpui::point(
                element.left() + px(top.x as f32 + 2.0),
                element.top() + px(bottom.y as f32),
            ),
        ))
    }

    fn character_index_for_point(
        &mut self,
        p: gpui::Point<Pixels>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<usize> {
        let b = self.canvas_bounds?;
        let s = Point::new(
            f32::from(p.x - b.left()) as f64,
            f32::from(p.y - b.top()) as f64,
        );
        let page = self.session.camera.to_page(s);
        let t = self.session.text.as_ref()?;
        let (laid, w) = self.session.text_layout.as_ref()?;
        let local = w.inverse()?.apply(page);
        Some(t.to_utf16(laid.hit_test_point(local.x, local.y).index))
    }

    fn accepts_text_input(&self, _: &mut Window, _: &mut Context<Self>) -> bool {
        self.session.text.is_some()
    }
}

impl Render for EditorView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let th = t(window, cx);
        let ext = Extensions::get(cx);
        let left = ext.panels(Slot::Left);
        let right = ext.panels(Slot::Right);
        let docked = ext.panels(Slot::Dock);
        let editing_text = self.session.text.is_some();
        let pages_strip = super::app::settings(Some(cx)).pages_strip && !self.focus_mode;
        let top = (!self.focus_mode).then(|| self.top_bar(&th, window, cx).into_any_element());
        let rail = self.left_rail(&th, &left, window, cx);
        let inspector = if self.inspector_open && !self.focus_mode && !right.is_empty() {
            let views: Vec<AnyView> = right
                .iter()
                .map(|s| self.panel_view(s, window, cx))
                .collect();
            Some(
                div()
                    .w(px(288.0))
                    .h_full()
                    .flex_none()
                    .flex()
                    .flex_col()
                    .bg(th.surface1)
                    .border_l_1()
                    .border_color(th.border_subtle)
                    .children(views),
            )
        } else {
            None
        };
        let dock_views: Vec<AnyView> = docked
            .iter()
            .map(|s| self.panel_view(s, window, cx))
            .collect();
        let me = cx.entity();
        let rename_layer = match &self.renaming {
            Some((Some(id), field, _)) => {
                let b = desyn_core::geometry::node_aabb(&self.session.doc.design, id);
                b.map(|b| {
                    let s = self.session.camera.to_screen(Point::new(b.x, b.y));
                    div()
                        .absolute()
                        .left(px(s.x as f32))
                        .top(px((s.y as f32 - 34.0).max(4.0)))
                        .w(px(220.0))
                        .h(px(28.0))
                        .px(px(8.0))
                        .flex()
                        .items_center()
                        .rounded(px(6.0))
                        .bg(th.surface2)
                        .border_1()
                        .border_color(alpha(th.accent, 0.6))
                        .shadow(vec![
                            gpui::BoxShadow::new(px(0.0), px(8.0), alpha(gpui::black(), 0.4))
                                .blur_radius(px(20.0)),
                        ])
                        .child(field.clone())
                })
            }
            _ => None,
        };
        let page_shadow = {
            let r = self
                .session
                .camera
                .rect_to_screen(&self.session.page_rect());
            div()
                .absolute()
                .left(px(r.x as f32))
                .top(px(r.y as f32))
                .w(px(r.w as f32))
                .h(px(r.h as f32))
                .shadow(vec![
                    gpui::BoxShadow::new(px(0.0), px(24.0), th.page_shadow)
                        .blur_radius(px(60.0))
                        .spread_radius(px(-12.0)),
                    gpui::BoxShadow::new(px(0.0), px(1.0), alpha(th.page_shadow, 0.6))
                        .blur_radius(px(3.0)),
                ])
        };
        let canvas_area = div()
            .id("canvas-area")
            .relative()
            .flex_1()
            .h_full()
            .overflow_hidden()
            .bg(th.canvas)
            .on_drop(cx.listener(|this, paths: &ExternalPaths, window, cx| {
                this.drop_active = false;
                let at = this.canvas_bounds.map(|b| {
                    let m = window.mouse_position();
                    Point::new(
                        f32::from(m.x - b.left()) as f64,
                        f32::from(m.y - b.top()) as f64,
                    )
                });
                this.import_paths(paths.paths().to_vec(), at, cx);
            }))
            .drag_over::<ExternalPaths>({
                let a = th.accent_soft;
                move |s, _, _, _| s.bg(a)
            })
            .child(page_shadow)
            .child(CanvasElement::new(me.clone()))
            .children(rename_layer)
            .children(self.link_field(&th))
            .when(!self.focus_mode, |d| {
                d.child(
                    div()
                        .absolute()
                        .bottom(px(20.0))
                        .left_0()
                        .right_0()
                        .flex()
                        .flex_col()
                        .items_center()
                        .gap(px(10.0))
                        .children(dock_views)
                        .child(dock::tool_dock(self, &th, cx)),
                )
            });
        div()
            .id("editor")
            .key_context(if editing_text {
                "Editor TextEditing"
            } else {
                "Editor Canvas"
            })
            .track_focus(&self.focus)
            .size_full()
            .flex()
            .flex_col()
            .bg(th.bg)
            .on_key_down(cx.listener(Self::on_key_down))
            .on_key_up(cx.listener(Self::on_key_up))
            .on_modifiers_changed(cx.listener(Self::on_modifiers))
            .map(|d| self.bind_actions(d, cx))
            .children(top)
            .child(
                div()
                    .flex_1()
                    .min_h(px(0.0))
                    .flex()
                    .children(rail)
                    .child(canvas_area)
                    .children(inspector),
            )
            .when(pages_strip, |d| {
                d.child(pages::pages_strip(self, &th, window, cx))
            })
            .children(self.menu.as_ref().map(|m| m.menu.clone()))
    }
}

impl EditorView {
    fn bind_actions(
        &mut self,
        d: gpui::Stateful<gpui::Div>,
        cx: &mut Context<Self>,
    ) -> gpui::Stateful<gpui::Div> {
        let d = session_actions!(d, cx,
            Duplicate => |s| s.duplicate(),
            Delete => |s| s.delete(),
            SelectAll => |s| s.select_all(),
            Escape => |s| s.escape(),
            Enter => |s| { if s.pen.is_some() { s.finish_pen() } else { s.enter() } },
            SelectParent => |s| s.select_parent(),
            NextSibling => |s| s.select_sibling(1),
            PreviousSibling => |s| s.select_sibling(-1),
            SelectMatching => |s| s.select_matching(),
            ZoomIn => |s| s.camera.step(1),
            ZoomOut => |s| s.camera.step(-1),
            Zoom100 => |s| s.zoom_actual(),
            ZoomFitAll => |s| s.zoom_to_fit_all(),
            ZoomSelection => |s| s.zoom_to_selection(),
            ZoomFitPage => |s| s.fit_page(),
            PreviousPage => |s| s.step_page(-1),
            NextPage => |s| s.step_page(1),
            AddPage => |s| s.add_page(),
            NudgeLeft => |s| s.nudge(-1.0, 0.0, false),
            NudgeRight => |s| s.nudge(1.0, 0.0, false),
            NudgeUp => |s| s.nudge(0.0, -1.0, false),
            NudgeDown => |s| s.nudge(0.0, 1.0, false),
            BigNudgeLeft => |s| s.nudge(-1.0, 0.0, true),
            BigNudgeRight => |s| s.nudge(1.0, 0.0, true),
            BigNudgeUp => |s| s.nudge(0.0, -1.0, true),
            BigNudgeDown => |s| s.nudge(0.0, 1.0, true),
            BringForward => |s| s.reorder(ZOrder::BringForward),
            SendBackward => |s| s.reorder(ZOrder::SendBackward),
            BringToFront => |s| s.reorder(ZOrder::BringToFront),
            SendToBack => |s| s.reorder(ZOrder::SendToBack),
            Group => |s| s.group(),
            Ungroup => |s| s.ungroup(),
            FrameSelection => |s| s.frame_selection(),
            AddAutoLayout => |s| s.add_auto_layout(),
            UseAsMask => |s| s.use_as_mask(),
            FlipHorizontal => |s| s.flip(true),
            FlipVertical => |s| s.flip(false),
            AlignLeft => |s| s.align(Alignment::Left),
            AlignCenter => |s| s.align(Alignment::Center),
            AlignRight => |s| s.align(Alignment::Right),
            AlignTop => |s| s.align(Alignment::Top),
            AlignMiddle => |s| s.align(Alignment::Middle),
            AlignBottom => |s| s.align(Alignment::Bottom),
            DistributeHorizontal => |s| s.distribute(DistributeAxis::Horizontal),
            DistributeVertical => |s| s.distribute(DistributeAxis::Vertical),
            ToggleLock => |s| s.toggle_lock(),
            ToggleHide => |s| s.toggle_visible(),
            ToolSelect => |s| s.set_tool(Tool::Select),
            ToolHand => |s| s.set_tool(Tool::Hand),
            ToolFrame => |s| s.set_tool(Tool::Frame),
            ToolRect => |s| s.set_tool(Tool::Rect),
            ToolEllipse => |s| s.set_tool(Tool::Ellipse),
            ToolPolygon => |s| s.set_tool(Tool::Polygon),
            ToolStar => |s| s.set_tool(Tool::Star),
            ToolLine => |s| s.set_tool(Tool::Line),
            ToolArrow => |s| s.set_tool(Tool::Arrow),
            ToolPen => |s| s.set_tool(Tool::Pen),
            ToolText => |s| s.set_tool(Tool::Text),
            Backspace => |s| s.text_delete(false, DeleteUnit::Grapheme),
            DeleteForward => |s| s.text_delete(true, DeleteUnit::Grapheme),
            DeleteWordBackward => |s| s.text_delete(false, DeleteUnit::Word),
            DeleteWordForward => |s| s.text_delete(true, DeleteUnit::Word),
            DeleteToLineStart => |s| s.text_delete(false, DeleteUnit::Line),
            Left => |s| s.text_move(Move::Left, false),
            Right => |s| s.text_move(Move::Right, false),
            Up => |s| s.text_move(Move::Up, false),
            Down => |s| s.text_move(Move::Down, false),
            WordLeft => |s| s.text_move(Move::WordLeft, false),
            WordRight => |s| s.text_move(Move::WordRight, false),
            LineStart => |s| s.text_move(Move::LineStart, false),
            LineEnd => |s| s.text_move(Move::LineEnd, false),
            DocStart => |s| s.text_move(Move::DocStart, false),
            DocEnd => |s| s.text_move(Move::DocEnd, false),
            SelectLeft => |s| s.text_move(Move::Left, true),
            SelectRight => |s| s.text_move(Move::Right, true),
            SelectUp => |s| s.text_move(Move::Up, true),
            SelectDown => |s| s.text_move(Move::Down, true),
            SelectWordLeft => |s| s.text_move(Move::WordLeft, true),
            SelectWordRight => |s| s.text_move(Move::WordRight, true),
            SelectLineStart => |s| s.text_move(Move::LineStart, true),
            SelectLineEnd => |s| s.text_move(Move::LineEnd, true),
            Newline => |s| s.text_insert("\n"),
            Bold => |s| s.text_format(Format::Bold),
            Italic => |s| s.text_format(Format::Italic),
            Underline => |s| s.text_format(Format::Underline),
            Strikethrough => |s| s.text_format(Format::Strikethrough),
            BiggerText => |s| s.text_format(Format::Bigger),
            SmallerText => |s| s.text_format(Format::Smaller),
            AlignTextLeft => |s| s.text_paragraph("align", serde_json::json!("left")),
            AlignTextCenter => |s| s.text_paragraph("align", serde_json::json!("center")),
            AlignTextRight => |s| s.text_paragraph("align", serde_json::json!("right")),
            BulletList => |s| s.text_paragraph("list", serde_json::json!("bullet")),
            NumberedList => |s| s.text_paragraph("list", serde_json::json!("number")),
        );
        d.on_action(cx.listener(|this, _: &Undo, _, cx| {
            this.session.undo();
            this.after(cx);
        }))
        .on_action(cx.listener(|this, _: &Redo, _, cx| {
            this.session.redo();
            this.after(cx);
        }))
        .on_action(cx.listener(|this, _: &Copy, _, cx| this.copy(cx)))
        .on_action(cx.listener(|this, _: &Cut, _, cx| this.cut(cx)))
        .on_action(cx.listener(|this, _: &Paste, _, cx| this.paste(false, cx)))
        .on_action(cx.listener(|this, _: &PasteInPlace, _, cx| this.paste(true, cx)))
        .on_action(cx.listener(|this, _: &Save, window, cx| this.save(window, cx)))
        .on_action(cx.listener(|this, _: &SaveAs, window, cx| this.save_as(window, cx)))
        .on_action(cx.listener(|this, _: &Import, _, cx| this.import_dialog(cx)))
        .on_action(cx.listener(|this, _: &PlaceImage, _, cx| this.place_image_dialog(cx)))
        .on_action(cx.listener(|this, _: &RenameLayer, window, cx| {
            if let [id] = this.session.selection.as_slice() {
                let id = id.clone();
                this.start_rename(Some(id), window, cx);
            }
        }))
        .on_action(cx.listener(|this, _: &EditPath, _, cx| {
            if let [id] = this.session.selection.clone().as_slice() {
                this.session.edit_path(id);
                this.after(cx);
            }
        }))
        .on_action(cx.listener(|this, _: &DuplicatePage, _, cx| {
            let p = this.session.page.clone();
            this.session.duplicate_page(&p);
            this.after(cx);
        }))
        .on_action(cx.listener(|this, _: &DeletePage, _, cx| {
            let p = this.session.page.clone();
            this.session.delete_page(&p);
            this.after(cx);
        }))
        .on_action(cx.listener(|this, _: &ToggleRulers, _, cx| {
            toggle_setting(cx, |s| s.rulers = !s.rulers, this)
        }))
        .on_action(cx.listener(|this, _: &ToggleLayoutGrid, _, cx| {
            toggle_setting(cx, |s| s.layout_grid = !s.layout_grid, this)
        }))
        .on_action(cx.listener(|this, _: &TogglePixelGrid, _, cx| {
            toggle_setting(cx, |s| s.pixel_grid = !s.pixel_grid, this)
        }))
        .on_action(cx.listener(|this, _: &ToggleSnapping, _, cx| {
            toggle_setting(cx, |s| s.snapping.enabled = !s.snapping.enabled, this);
            let on = this.session.prefs.snap.enabled;
            cx.emit(EditorEvent::Notice(if on {
                "Snapping on".into()
            } else {
                "Snapping off".into()
            }));
        }))
        .on_action(cx.listener(|this, _: &ToggleSmartDistances, _, cx| {
            toggle_setting(cx, |s| s.smart_distances = !s.smart_distances, this)
        }))
        .on_action(cx.listener(|this, _: &TogglePagesStrip, _, cx| {
            toggle_setting(cx, |s| s.pages_strip = !s.pages_strip, this)
        }))
        .on_action(cx.listener(|this, _: &ToggleFocusMode, _, cx| {
            this.focus_mode = !this.focus_mode;
            cx.notify();
        }))
        .on_action(cx.listener(|this, _: &Export, w, cx| {
            this.ext_action::<Export>(w, cx, "Export is not available in this build.")
        }))
        .on_action(cx.listener(|this, _: &SaveVersion, w, cx| {
            this.ext_action::<SaveVersion>(
                w,
                cx,
                "Named versions need a Desyn account (sync is not set up in this build).",
            )
        }))
        .on_action(cx.listener(|this, _: &OpenAiPrompt, w, cx| {
            this.ext_action::<OpenAiPrompt>(w, cx, "The AI dock is not available in this build.")
        }))
        .on_action(cx.listener(|this, _: &ToggleInspector, w, cx| {
            if Extensions::get(cx).handler::<ToggleInspector>().is_some() {
                this.ext_action::<ToggleInspector>(w, cx, "");
            } else {
                this.toggle_inspector(cx);
            }
        }))
        .on_action(cx.listener(|this, _: &LayersPanel, w, cx| {
            this.ext_action::<LayersPanel>(
                w,
                cx,
                "The layers panel is not available in this build.",
            )
        }))
        .on_action(cx.listener(|this, _: &ElementsPanel, w, cx| {
            this.ext_action::<ElementsPanel>(
                w,
                cx,
                "The elements panel is not available in this build.",
            )
        }))
        .on_action(cx.listener(|this, _: &BrandPanel, w, cx| {
            this.ext_action::<BrandPanel>(w, cx, "Brand kits need a Desyn account.")
        }))
        .on_action(cx.listener(|this, _: &Comments, w, cx| {
            this.ext_action::<Comments>(w, cx, "Comments need a Desyn account.")
        }))
        .on_action(cx.listener(|this, _: &CommentTool, w, cx| {
            this.ext_action::<CommentTool>(w, cx, "Comments need a Desyn account.")
        }))
        .on_action(cx.listener(|this, _: &EditLink, w, cx| this.start_link_edit(w, cx)))
        .on_action(cx.listener(|this, _: &VersionHistory, w, cx| {
            this.ext_action::<VersionHistory>(w, cx, "Version history needs a Desyn account.")
        }))
        .on_action(cx.listener(|this, _: &Present, w, cx| {
            this.ext_action::<Present>(w, cx, "Presenting is not available in this build.")
        }))
        .on_action(cx.listener(|this, _: &ShowCharacterPalette, window, cx| {
            if this.session.text.is_some() {
                window.show_character_palette();
            }
            cx.notify();
        }))
    }
}

fn toggle_setting(
    cx: &mut Context<EditorView>,
    f: impl FnOnce(&mut crate::settings::Settings),
    this: &mut EditorView,
) {
    AppState::update(cx, |s| {
        f(&mut s.settings);
        s.save_settings();
    });
    this.session.prefs = prefs_from(cx);
    cx.notify();
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text(s: &str) -> ClipboardEntry {
        ClipboardEntry::String(ClipboardString::new(s.to_string()))
    }

    fn image() -> ClipboardEntry {
        ClipboardEntry::Image(gpui::Image::from_bytes(gpui::ImageFormat::Png, vec![1, 2]))
    }

    #[test]
    fn paste_prefers_layers_then_images_then_text() {
        let r = desyn_core::model::Node::rect("aaaaaaaaaaaa", "R", 0.0, 0.0, 5.0, 5.0);
        let layers = crate::doc::import::payload_from_nodes("dddddddddddd", vec![r]).to_json();
        // A browser copying a picture also offers its URL as text: the picture wins.
        assert_eq!(
            paste_choice(&[text("https://example.com/a.png"), image()], false),
            Some(PasteChoice::Image(vec![1, 2]))
        );
        // Desyn layers win over the PNG preview written next to them.
        assert_eq!(
            paste_choice(&[image(), text(&layers)], false),
            Some(PasteChoice::Text(layers.clone()))
        );
        assert_eq!(
            paste_choice(&[text("hello")], false),
            Some(PasteChoice::Text("hello".into()))
        );
        // While typing, only text applies.
        assert_eq!(
            paste_choice(&[image(), text("hi")], true),
            Some(PasteChoice::Text("hi".into()))
        );
        assert_eq!(paste_choice(&[image()], true), None);
        assert_eq!(paste_choice(&[], false), None);
    }
}
