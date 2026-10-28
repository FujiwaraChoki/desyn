//! A window: title bar (menus on Linux / Windows, tabs, window controls), the start screen and one editor per tab,
//! plus window-level overlays (command palette, settings, shortcuts sheet, toasts).

use std::path::PathBuf;
use std::time::Duration;

use gpui::{
    AnyElement, App, AppContext, BoxShadow, ClipboardItem, Context, Decorations, Entity, EntityId,
    FocusHandle, Focusable, InteractiveElement, IntoElement, MouseButton, ParentElement,
    PromptLevel, Render, ResizeEdge, SharedString, StatefulInteractiveElement, Styled,
    Subscription, Task, Window, WindowControlArea, div, prelude::*, px,
};

use super::actions::*;
use super::app::{self, AppState, load_document, new_document};
use super::components::{icon, icon_button, t, tip, wordmark};
use super::editor::{EditorEvent, EditorView};
use super::home::{HomeEvent, HomeView};
use super::menu::MenuEntry;
use super::menus::app_menus;
use super::palette::{Palette, PaletteEvent};
use super::settings_view::SettingsView;
use super::shortcuts::ShortcutsSheet;
use super::theme::{SANS, Theme, ThemeSetting, alpha};
use crate::deeplink::{LaunchRequest, NewDesign as NewDesignRequest};
use crate::doc::Document;
use crate::settings::ThemePref;

/// A transient message.
#[derive(Clone)]
pub struct Toast {
    id: u64,
    text: SharedString,
}

enum Overlay {
    Palette(Entity<Palette>, #[allow(dead_code)] Subscription),
    Settings(Entity<SettingsView>),
    Shortcuts(Entity<ShortcutsSheet>),
}

/// Window root.
pub struct Workspace {
    tabs: Vec<Entity<EditorView>>,
    active: Option<usize>,
    home: Entity<HomeView>,
    overlay: Option<Overlay>,
    toasts: Vec<Toast>,
    toast_seq: u64,
    menu: Option<super::editor::OpenMenu>,
    menubar_open: Option<usize>,
    focus: FocusHandle,
    subs: Vec<(EntityId, Subscription)>,
    _home_sub: Subscription,
    toast_task: Option<Task<()>>,
    closing: bool,
}

const MAC: bool = cfg!(target_os = "macos");
const TITLEBAR: f32 = 38.0;

impl Focusable for Workspace {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl Workspace {
    /// New window content showing the start screen.
    pub fn new(window: &mut Window, cx: &mut Context<Self>) -> Workspace {
        let home = cx.new(HomeView::new);
        let home_sub = cx.subscribe_in(
            &home,
            window,
            |this, _, ev: &HomeEvent, window, cx| match ev {
                HomeEvent::Request(r) => this.handle_request(r.clone(), window, cx),
                HomeEvent::Notice(n) => this.toast(n.clone(), cx),
                HomeEvent::Recover(list) => this.recover(list.clone(), window, cx),
            },
        );
        cx.observe_window_appearance(window, |_, _, cx| cx.notify())
            .detach();
        cx.observe_global::<ThemeSetting>(|_, cx| cx.notify())
            .detach();
        cx.observe_global::<AppState>(|_, cx| cx.notify()).detach();
        window.on_window_should_close(cx, {
            let me = cx.entity().downgrade();
            move |window, cx| {
                let Some(ws) = me.upgrade() else { return true };
                ws.update(cx, |ws, cx| ws.should_close(window, cx))
            }
        });
        let focus = cx.focus_handle();
        window.focus(&focus, cx);
        Workspace {
            tabs: Vec::new(),
            active: None,
            home,
            overlay: None,
            toasts: Vec::new(),
            toast_seq: 0,
            menu: None,
            menubar_open: None,
            focus,
            subs: Vec::new(),
            _home_sub: home_sub,
            toast_task: None,
            closing: false,
        }
    }

    /// The editor in the active tab.
    pub fn active_editor(&self) -> Option<Entity<EditorView>> {
        self.active.and_then(|i| self.tabs.get(i).cloned())
    }

    /// All open editors.
    pub fn editors(&self) -> &[Entity<EditorView>] {
        &self.tabs
    }

    /// Whether any tab has changes that are not on disk and will not be autosaved.
    pub fn has_unsaved(&self, cx: &App) -> bool {
        let autosave = app::settings(Some(cx)).autosave;
        self.tabs.iter().any(|t| {
            let e = t.read(cx);
            e.is_dirty() && !(autosave && e.file().is_some())
        })
    }

    /// Shows a toast.
    pub fn toast(&mut self, text: String, cx: &mut Context<Self>) {
        self.toast_seq += 1;
        let id = self.toast_seq;
        self.toasts.retain(|t| t.text.as_ref() != text);
        self.toasts.push(Toast {
            id,
            text: text.into(),
        });
        if self.toasts.len() > 3 {
            self.toasts.remove(0);
        }
        self.toast_task = Some(cx.spawn(async move |this, cx| {
            cx.background_executor()
                .timer(Duration::from_millis(3600))
                .await;
            let _ = this.update(cx, |this, cx| {
                this.toasts.retain(|t| t.id > id);
                cx.notify();
            });
        }));
        cx.notify();
    }

    /// Adds an editor tab and focuses it.
    pub fn add_editor(
        &mut self,
        editor: Entity<EditorView>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let sub = cx.subscribe_in(
            &editor,
            window,
            |this, editor, ev: &EditorEvent, window, cx| match ev {
                EditorEvent::Notice(n) => this.toast(n.clone(), cx),
                EditorEvent::TitleChanged | EditorEvent::Saved(_) => {
                    this.update_title(window, cx);
                    cx.notify();
                }
                EditorEvent::OpenFile(p) => {
                    let p = p.clone();
                    this.open_path(p, window, cx);
                }
                _ => {
                    let _ = editor;
                }
            },
        );
        self.subs.push((editor.entity_id(), sub));
        self.tabs.push(editor.clone());
        self.activate(Some(self.tabs.len() - 1), window, cx);
    }

    /// Shows tab `i` (feature modules: focus an already open cloud design).
    pub fn activate_tab(&mut self, i: usize, window: &mut Window, cx: &mut Context<Self>) {
        self.activate(Some(i), window, cx);
    }

    fn activate(&mut self, i: Option<usize>, window: &mut Window, cx: &mut Context<Self>) {
        self.active = i.filter(|i| *i < self.tabs.len());
        match self.active_editor() {
            Some(e) => {
                let f = e.read(cx).focus.clone();
                window.focus(&f, cx);
            }
            None => {
                self.home.update(cx, |h, cx| h.refresh(cx));
                let f = self.home.focus_handle(cx);
                window.focus(&f, cx);
            }
        }
        self.update_title(window, cx);
        cx.notify();
    }

    fn update_title(&self, window: &mut Window, cx: &App) {
        let title = match self.active_editor() {
            Some(e) => format!("{} — Desyn", e.read(cx).title()),
            None => "Desyn".into(),
        };
        window.set_window_title(&title);
    }

    /// Opens a document in a new tab (or focuses it when already open).
    pub fn open_document(
        &mut self,
        doc: Document,
        file: Option<PathBuf>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if let Some(f) = &file
            && let Some(i) = self
                .tabs
                .iter()
                .position(|t| t.read(cx).file() == Some(f.as_path()))
        {
            self.activate(Some(i), window, cx);
            return;
        }
        let name = doc.design.name.clone();
        let editor = cx.new(|cx| EditorView::new(doc, file.clone(), cx));
        if let Some(f) = &file {
            AppState::update(cx, |s| {
                s.recent.touch(f, &name, now_ms());
                s.save_recent();
            });
        }
        self.add_editor(editor, window, cx);
    }

    /// Opens a path (`.desyn`, or an importable file as a new design) on a background thread.
    pub fn open_path(&mut self, path: PathBuf, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(i) = self
            .tabs
            .iter()
            .position(|t| t.read(cx).file() == Some(path.as_path()))
        {
            self.activate(Some(i), window, cx);
            return;
        }
        let task = cx.background_spawn({
            let path = path.clone();
            async move { load_document(&path) }
        });
        cx.spawn_in(window, async move |this, cx| {
            let res = task.await;
            let _ = this.update_in(cx, |this, window, cx| match res {
                Ok((doc, file, warnings)) => {
                    this.open_document(doc, file, window, cx);
                    for w in warnings {
                        this.toast(w, cx);
                    }
                }
                Err(e) => {
                    AppState::update(cx, |s| {
                        if !path.exists() {
                            s.recent.remove(&path);
                            s.save_recent();
                        }
                    });
                    this.toast(format!("Couldn't open “{}”: {e}", path.display()), cx);
                }
            });
        })
        .detach();
    }

    /// Reopens designs rescued after a crash. They keep their original file (when it still has a folder) and
    /// open with unsaved changes, so the next save writes them back.
    pub fn recover(
        &mut self,
        orphans: Vec<crate::file::recovery::Orphan>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let n = orphans.len();
        let task = cx.background_spawn(async move {
            orphans
                .into_iter()
                .map(|o| {
                    let res = crate::file::format::read(&o.file).map_err(|e| e.to_string());
                    (o, res)
                })
                .collect::<Vec<_>>()
        });
        cx.spawn_in(window, async move |this, cx| {
            let loaded = task.await;
            let _ = this.update_in(cx, |this, window, cx| {
                let mut ok = 0;
                for (o, res) in loaded {
                    match res {
                        Ok(f) => {
                            let mut doc = Document::new(f.design, f.assets);
                            doc.mark_dirty();
                            let file = o
                                .info
                                .origin
                                .clone()
                                .filter(|p| p.parent().is_some_and(|d| d.is_dir()));
                            let editor = cx.new(|cx| EditorView::new(doc, file, cx));
                            // Write the rescued state back to its file (autosave rules apply).
                            editor.update(cx, |e, cx| e.schedule_autosave(cx));
                            this.add_editor(editor, window, cx);
                            crate::file::recovery::remove_orphan(&o);
                            ok += 1;
                        }
                        Err(e) => {
                            this.toast(format!("Couldn't recover “{}”: {e}", o.info.name), cx)
                        }
                    }
                }
                if ok > 0 {
                    this.toast(
                        if n == 1 {
                            "Recovered your design.".into()
                        } else {
                            format!("Recovered {ok} designs.")
                        },
                        cx,
                    );
                }
            });
        })
        .detach();
    }

    /// Creates a design in the library folder and opens it.
    pub fn create_design(
        &mut self,
        req: NewDesignRequest,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let doc = new_document(&req);
        let lib = app::library_dir(cx);
        let _ = std::fs::create_dir_all(&lib);
        let path = crate::file::library::new_design_path(&lib, &doc.design.name);
        let editor = cx.new(|cx| EditorView::new(doc, Some(path.clone()), cx));
        // Write it right away so it shows up in the library and survives a crash.
        editor.update(cx, |e, cx| e.save_to(path, false, cx));
        self.add_editor(editor, window, cx);
    }

    /// Handles a launch request in this window.
    pub fn handle_request(
        &mut self,
        req: LaunchRequest,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match req {
            LaunchRequest::Open(p) | LaunchRequest::Import(p) => self.open_path(p, window, cx),
            LaunchRequest::New(n) => self.create_design(n, window, cx),
            LaunchRequest::Settings => self.open_settings(window, cx),
            LaunchRequest::Focus => window.activate_window(),
            other => app::handle_request(other, cx),
        }
    }

    /// Closes a tab (asks first when it has unsaved changes that will not be autosaved).
    pub fn close_tab(&mut self, i: usize, window: &mut Window, cx: &mut Context<Self>) {
        let Some(editor) = self.tabs.get(i).cloned() else {
            return;
        };
        let (dirty, has_file, name) = {
            let e = editor.read(cx);
            (e.is_dirty(), e.file().is_some(), e.name())
        };
        let autosave = app::settings(Some(cx)).autosave;
        if dirty && !(autosave && has_file) {
            let answer = window.prompt(
                PromptLevel::Warning,
                &format!("Save changes to “{name}”?"),
                Some("Your changes will be lost if you don't save them."),
                &["Save", "Don't Save", "Cancel"],
                cx,
            );
            cx.spawn_in(window, async move |this, cx| {
                let Ok(choice) = answer.await else { return };
                match choice {
                    0 => {
                        // Close only once the design is on disk (Save As may be cancelled).
                        let Ok(saved) = this.update_in(cx, |_, window, cx| {
                            editor.update(cx, |e, cx| e.save_for_close(window, cx))
                        }) else {
                            return;
                        };
                        if saved.await {
                            let _ = this.update_in(cx, |this, window, cx| {
                                this.remove_tab(&editor, window, cx)
                            });
                        }
                    }
                    1 => {
                        let _ = this.update_in(cx, |this, window, cx| {
                            editor.update(cx, |e, cx| e.discard_recovery(cx));
                            this.remove_tab(&editor, window, cx);
                        });
                    }
                    _ => {}
                }
            })
            .detach();
            return;
        }
        // Write pending autosave changes before the tab (and its background tasks) goes away.
        editor.update(cx, |e, cx| e.flush(cx));
        self.remove_tab(&editor, window, cx);
    }

    fn remove_tab(
        &mut self,
        editor: &Entity<EditorView>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(i) = self.tabs.iter().position(|t| t == editor) else {
            return;
        };
        editor.update(cx, |e, cx| e.closing(cx));
        self.tabs.remove(i);
        self.subs.retain(|(id, _)| *id != editor.entity_id());
        let next = if self.tabs.is_empty() {
            None
        } else {
            Some(i.min(self.tabs.len() - 1))
        };
        self.activate(next, window, cx);
    }

    fn should_close(&mut self, window: &mut Window, cx: &mut Context<Self>) -> bool {
        if self.closing || !self.has_unsaved(cx) {
            self.prepare_close(window, cx);
            return true;
        }
        let confirm = self.confirm_close(window, cx);
        cx.spawn_in(window, async move |this, cx| {
            if confirm.await {
                let _ = this.update_in(cx, |this, window, _| {
                    this.closing = true;
                    window.remove_window();
                });
            }
        })
        .detach();
        false
    }

    /// Remembers the window placement and writes autosaved designs before the window goes away.
    fn prepare_close(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.save_placement(window, cx);
        for t in self.tabs.clone() {
            t.update(cx, |e, cx| e.flush(cx));
        }
    }

    /// Asks what to do with designs that have unsaved changes (Save All / Don't Save / Cancel) and carries it
    /// out. Resolves to `true` when the window may close: everything was saved, or the user chose not to save.
    /// A cancelled Save As dialog or a failed write keeps the window open.
    pub fn confirm_close(&mut self, window: &mut Window, cx: &mut Context<Self>) -> Task<bool> {
        if !self.has_unsaved(cx) {
            self.prepare_close(window, cx);
            return Task::ready(true);
        }
        window.activate_window();
        let autosave = app::settings(Some(cx)).autosave;
        let unsaved: Vec<Entity<EditorView>> = self
            .tabs
            .iter()
            .filter(|t| {
                let e = t.read(cx);
                e.is_dirty() && !(autosave && e.file().is_some())
            })
            .cloned()
            .collect();
        let (title, detail) = match unsaved.as_slice() {
            [one] => (
                format!("Save changes to “{}”?", one.read(cx).name()),
                "Your changes will be lost if you don't save them.".to_string(),
            ),
            many => (
                format!("{} designs have unsaved changes.", many.len()),
                "Save them before closing?".to_string(),
            ),
        };
        let answer = window.prompt(
            PromptLevel::Warning,
            &title,
            Some(&detail),
            &["Save All", "Don't Save", "Cancel"],
            cx,
        );
        cx.spawn_in(window, async move |this, cx| {
            let Ok(choice) = answer.await else {
                return false;
            };
            match choice {
                0 => {
                    for e in unsaved {
                        let Ok(saved) = this.update_in(cx, |this, window, cx| {
                            if let Some(i) = this.tabs.iter().position(|t| *t == e) {
                                this.activate(Some(i), window, cx);
                            }
                            e.update(cx, |e, cx| e.save_for_close(window, cx))
                        }) else {
                            return false;
                        };
                        if !saved.await {
                            return false;
                        }
                    }
                }
                1 => {
                    let _ = this.update(cx, |_, cx| {
                        for e in &unsaved {
                            e.update(cx, |e, cx| {
                                e.discard_recovery(cx);
                                e.session.doc.mark_saved(e.session.doc.save_point());
                            });
                        }
                    });
                }
                _ => return false,
            }
            this.update_in(cx, |this, window, cx| {
                this.prepare_close(window, cx);
                true
            })
            .unwrap_or(false)
        })
    }

    fn save_placement(&self, window: &mut Window, cx: &mut Context<Self>) {
        let b = window.window_bounds();
        let r = b.get_bounds();
        let placement = crate::settings::WindowPlacement {
            x: f32::from(r.origin.x),
            y: f32::from(r.origin.y),
            width: f32::from(r.size.width),
            height: f32::from(r.size.height),
            maximized: matches!(b, gpui::WindowBounds::Maximized(_)),
        };
        AppState::update(cx, |s| {
            s.settings.window = Some(placement);
            s.save_settings();
        });
    }

    fn open_dialog(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let rx = cx.prompt_for_paths(gpui::PathPromptOptions {
            files: true,
            directories: false,
            multiple: true,
            prompt: Some("Open".into()),
        });
        cx.spawn_in(window, async move |this, cx| {
            let Ok(Ok(Some(paths))) = rx.await else {
                return;
            };
            let _ = this.update_in(cx, |this, window, cx| {
                for p in paths {
                    this.open_path(p, window, cx);
                }
            });
        })
        .detach();
    }

    /// Opens the command palette.
    pub fn open_palette(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let editor = self.active_editor();
        let palette = cx.new(|cx| Palette::new(editor, window, cx));
        let sub = cx.subscribe_in(
            &palette,
            window,
            |this, _, ev: &PaletteEvent, window, cx| {
                this.overlay = None;
                this.refocus(window, cx);
                match ev {
                    PaletteEvent::Dismissed => {}
                    PaletteEvent::Action(a) => {
                        let a = a.boxed_clone();
                        window.defer(cx, move |window, cx| window.dispatch_action(a, cx));
                    }
                    PaletteEvent::Run(f) => {
                        let f = f.clone();
                        window.defer(cx, move |window, cx| f(window, cx));
                    }
                    PaletteEvent::Request(r) => this.handle_request(r.clone(), window, cx),
                }
                cx.notify();
            },
        );
        let f = palette.focus_handle(cx);
        window.focus(&f, cx);
        self.overlay = Some(Overlay::Palette(palette, sub));
        cx.notify();
    }

    fn open_settings(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let v = cx.new(|cx| SettingsView::new(window, cx));
        let f = v.focus_handle(cx);
        window.focus(&f, cx);
        self.overlay = Some(Overlay::Settings(v));
        cx.notify();
    }

    fn refocus(&self, window: &mut Window, cx: &mut Context<Self>) {
        match self.active_editor() {
            Some(e) => {
                let f = e.read(cx).focus.clone();
                window.focus(&f, cx);
            }
            None => {
                let f = self.home.focus_handle(cx);
                window.focus(&f, cx);
            }
        }
    }

    /// Closes overlays.
    pub fn close_overlay(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.overlay.take().is_some() {
            self.refocus(window, cx);
            cx.notify();
        }
    }

    fn set_theme(&mut self, pref: ThemePref, cx: &mut Context<Self>) {
        set_theme(pref, cx);
    }

    // ---------------------------------------------------------------------------------------------------------
    // Title bar

    fn titlebar(&mut self, th: &Theme, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let decorations = window.window_decorations();
        let client = matches!(decorations, Decorations::Client { .. });
        let tabs: Vec<AnyElement> = self
            .tabs
            .iter()
            .enumerate()
            .map(|(i, ed)| {
                let e = ed.read(cx);
                let title: SharedString = e.title().into();
                let active = self.active == Some(i);
                let tooltip = e
                    .file()
                    .map(|f| f.display().to_string())
                    .unwrap_or_else(|| e.name());
                tab(("tab", i), title, active, th)
                    .tooltip(tip(tooltip, None))
                    .on_click(
                        cx.listener(move |this, _, window, cx| this.activate(Some(i), window, cx)),
                    )
                    .on_mouse_down(
                        MouseButton::Middle,
                        cx.listener(move |this, _, window, cx| this.close_tab(i, window, cx)),
                    )
                    .child(
                        div()
                            .id(("tab-close", i))
                            .ml(px(2.0))
                            .size(px(18.0))
                            .flex()
                            .items_center()
                            .justify_center()
                            .rounded(px(5.0))
                            .hover({
                                let s3 = th.surface3;
                                move |s| s.bg(s3)
                            })
                            .child(icon("icons/x.svg", 12.0, th.faint))
                            .on_click(cx.listener(move |this, _, window, cx| {
                                cx.stop_propagation();
                                this.close_tab(i, window, cx);
                            })),
                    )
                    .into_any_element()
            })
            .collect();
        let home_active = self.active.is_none();
        let menubar: Option<AnyElement> = (!MAC).then(|| {
            let menus = app_menus(cx);
            div()
                .flex()
                .items_center()
                .gap(px(1.0))
                .children(menus.into_iter().enumerate().map(|(i, m)| {
                    let open = self.menubar_open == Some(i);
                    div()
                        .id(("menubar", i))
                        .px(px(9.0))
                        .h(px(26.0))
                        .flex()
                        .items_center()
                        .rounded(px(6.0))
                        .font_family(SANS)
                        .text_size(px(12.5))
                        .text_color(if open { th.fg } else { th.muted })
                        .when(open, |d| d.bg(th.surface3))
                        .hover({
                            let s3 = th.surface3;
                            let fg = th.fg;
                            move |s| s.bg(s3).text_color(fg)
                        })
                        .child(m.name)
                        .on_click(cx.listener(move |this, e: &gpui::ClickEvent, window, cx| {
                            let p = e.position();
                            this.open_menubar(
                                i,
                                gpui::point(p.x - px(12.0), px(TITLEBAR - 2.0)),
                                window,
                                cx,
                            );
                        }))
                        .on_hover(cx.listener(move |this, hovered: &bool, window, cx| {
                            if *hovered
                                && this.menubar_open.is_some()
                                && this.menubar_open != Some(i)
                            {
                                let x = window.mouse_position().x;
                                this.open_menubar(
                                    i,
                                    gpui::point(x - px(12.0), px(TITLEBAR - 2.0)),
                                    window,
                                    cx,
                                );
                            }
                        }))
                        .into_any_element()
                }))
                .into_any_element()
        });
        let controls: Option<AnyElement> = (client && !MAC).then(|| {
            let maximized = window.is_maximized();
            div()
                .flex()
                .items_center()
                .gap(px(2.0))
                .pr(px(6.0))
                .child(
                    icon_button("win-min", "icons/minus.svg", 30.0, false, th)
                        .window_control_area(WindowControlArea::Min)
                        .on_click(|_, window, _| window.minimize_window()),
                )
                .child(
                    icon_button(
                        "win-max",
                        if maximized {
                            "icons/copy.svg"
                        } else {
                            "icons/square.svg"
                        },
                        30.0,
                        false,
                        th,
                    )
                    .window_control_area(WindowControlArea::Max)
                    .on_click(|_, window, _| window.zoom_window()),
                )
                .child(
                    icon_button("win-close", "icons/x.svg", 30.0, false, th)
                        .window_control_area(WindowControlArea::Close)
                        .on_click(|_, window, cx| {
                            window.dispatch_action(Box::new(CloseWindow), cx)
                        }),
                )
                .into_any_element()
        });
        div()
            .id("titlebar")
            .h(px(TITLEBAR))
            .flex_none()
            .flex()
            .items_center()
            .gap(px(6.0))
            .pl(px(if MAC { 80.0 } else { 12.0 }))
            .bg(th.bg)
            .border_b_1()
            .border_color(th.border_subtle)
            .window_control_area(WindowControlArea::Drag)
            .on_mouse_down(MouseButton::Left, |e, window, _| {
                if e.click_count >= 2 {
                    window.zoom_window();
                } else if !MAC {
                    window.start_window_move();
                }
            })
            .child(div().flex_none().mr(px(6.0)).child(wordmark(17.0, th)))
            .children(menubar.map(|m| div().flex_none().child(m)))
            .child(div().flex_none().w(px(10.0)))
            // Tabs take the remaining room and shrink (titles truncate) so the right-hand buttons and window
            // controls always stay visible, even in narrow windows.
            .child(
                div()
                    .flex_1()
                    .min_w(px(0.0))
                    .h_full()
                    .flex()
                    .items_center()
                    .gap(px(6.0))
                    .overflow_hidden()
                    .child(
                        tab("tab-home", "Home".into(), home_active, th)
                            .flex_none()
                            .child(icon(
                                "icons/home.svg",
                                13.0,
                                if home_active {
                                    th.accent_text
                                } else {
                                    th.faint
                                },
                            ))
                            .on_click(
                                cx.listener(|this, _, window, cx| this.activate(None, window, cx)),
                            ),
                    )
                    .children(tabs)
                    .child(
                        icon_button("new-tab", "icons/plus.svg", 26.0, false, th)
                            .flex_none()
                            .tooltip(tip("New design", Some(shortcut_label("secondary-n"))))
                            .on_click(
                                cx.listener(|this, _, window, cx| this.activate(None, window, cx)),
                            ),
                    ),
            )
            .child(
                icon_button("palette", "icons/command.svg", 28.0, false, th)
                    .tooltip(tip("Command palette", Some(shortcut_label("secondary-k"))))
                    .on_click(cx.listener(|this, _, window, cx| this.open_palette(window, cx))),
            )
            .child(
                icon_button("settings", "icons/settings.svg", 28.0, false, th)
                    .tooltip(tip("Settings", Some(shortcut_label("secondary-,"))))
                    .on_click(cx.listener(|this, _, window, cx| this.open_settings(window, cx))),
            )
            .children(controls)
            .when(MAC || !client, |d| d.pr(px(10.0)))
            .into_any_element()
    }

    fn open_menubar(
        &mut self,
        i: usize,
        at: gpui::Point<gpui::Pixels>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let menus = app_menus(cx);
        let Some(m) = menus.into_iter().nth(i) else {
            return;
        };
        let target = match self.active_editor() {
            Some(e) => e.read(cx).focus.clone(),
            None => self.home.focus_handle(cx),
        };
        let menu = cx.new(|cx| super::menu::PopupMenu::new(m.entries, at, target, cx));
        let sub = cx.subscribe_in(
            &menu,
            window,
            |this, _, _: &super::menu::MenuDismissed, _window, cx| {
                this.menu = None;
                this.menubar_open = None;
                cx.notify();
            },
        );
        let f = menu.focus_handle(cx);
        window.focus(&f, cx);
        self.menu = Some(super::editor::OpenMenu {
            menu,
            _sub: std::rc::Rc::new(sub),
        });
        self.menubar_open = Some(i);
        cx.notify();
    }

    fn resize_edges(&self, window: &mut Window) -> Option<AnyElement> {
        let Decorations::Client { tiling } = window.window_decorations() else {
            return None;
        };
        if MAC || tiling.is_tiled() || window.is_maximized() {
            return None;
        }
        use gpui::CursorStyle as C;
        let grip = |id: &'static str, e: ResizeEdge, c: C| {
            div().id(id).absolute().cursor(c).on_mouse_down(
                MouseButton::Left,
                move |_, window, cx| {
                    cx.stop_propagation();
                    window.start_window_resize(e);
                },
            )
        };
        let w = px(5.0);
        let k = px(10.0);
        Some(
            div()
                .absolute()
                .inset_0()
                .child(
                    grip("edge-top", ResizeEdge::Top, C::ResizeUpDown)
                        .top_0()
                        .left_0()
                        .right_0()
                        .h(w),
                )
                .child(
                    grip("edge-bottom", ResizeEdge::Bottom, C::ResizeUpDown)
                        .bottom_0()
                        .left_0()
                        .right_0()
                        .h(w),
                )
                .child(
                    grip("edge-left", ResizeEdge::Left, C::ResizeLeftRight)
                        .top_0()
                        .bottom_0()
                        .left_0()
                        .w(w),
                )
                .child(
                    grip("edge-right", ResizeEdge::Right, C::ResizeLeftRight)
                        .top_0()
                        .bottom_0()
                        .right_0()
                        .w(w),
                )
                .child(
                    grip("c-tl", ResizeEdge::TopLeft, C::ResizeUpLeftDownRight)
                        .top_0()
                        .left_0()
                        .size(k),
                )
                .child(
                    grip("c-tr", ResizeEdge::TopRight, C::ResizeUpRightDownLeft)
                        .top_0()
                        .right_0()
                        .size(k),
                )
                .child(
                    grip("c-bl", ResizeEdge::BottomLeft, C::ResizeUpRightDownLeft)
                        .bottom_0()
                        .left_0()
                        .size(k),
                )
                .child(
                    grip("c-br", ResizeEdge::BottomRight, C::ResizeUpLeftDownRight)
                        .bottom_0()
                        .right_0()
                        .size(k),
                )
                .into_any_element(),
        )
    }

    fn workspace_actions(
        &mut self,
        d: gpui::Stateful<gpui::Div>,
        cx: &mut Context<Self>,
    ) -> gpui::Stateful<gpui::Div> {
        d.on_action(cx.listener(|this, _: &NewDesign, window, cx| {
            this.activate(None, window, cx);
            this.home.update(cx, |h, cx| h.focus_create(cx));
        }))
        .on_action(cx.listener(|this, _: &NewDesignLikeCurrent, window, cx| {
            let req = this.active_editor().and_then(|e| {
                let s = &e.read(cx).session;
                let n = s.doc.design.node(&s.page)?;
                Some(NewDesignRequest {
                    width: Some(n.base().width),
                    height: Some(n.base().height),
                    kind: Some(s.doc.design.kind.to_string()),
                    ..Default::default()
                })
            });
            this.create_design(req.unwrap_or_default(), window, cx);
        }))
        .on_action(cx.listener(|this, _: &Open, window, cx| this.open_dialog(window, cx)))
        .on_action(cx.listener(|this, _: &Import, window, cx| {
            if this.active_editor().is_none() {
                // From the start screen, imports become new designs.
                this.open_dialog(window, cx);
            } else {
                cx.propagate();
            }
        }))
        .on_action(
            cx.listener(|this, _: &CloseTab, window, cx| match this.active {
                Some(i) => this.close_tab(i, window, cx),
                None => window.dispatch_action(Box::new(CloseWindow), cx),
            }),
        )
        .on_action(cx.listener(|this, _: &CloseWindow, window, cx| {
            if this.should_close(window, cx) {
                window.remove_window();
            }
        }))
        .on_action(cx.listener(|this, _: &NextTab, window, cx| {
            let n = this.tabs.len();
            let next = match this.active {
                None if n > 0 => Some(0),
                Some(i) if i + 1 < n => Some(i + 1),
                _ => None,
            };
            this.activate(next, window, cx);
        }))
        .on_action(cx.listener(|this, _: &PreviousTab, window, cx| {
            let n = this.tabs.len();
            let prev = match this.active {
                None if n > 0 => Some(n - 1),
                Some(0) => None,
                Some(i) => Some(i - 1),
                None => None,
            };
            this.activate(prev, window, cx);
        }))
        .on_action(cx.listener(|this, _: &MoveTabToNewWindow, window, cx| {
            let Some(i) = this.active else { return };
            let editor = this.tabs[i].clone();
            this.tabs.remove(i);
            this.subs.retain(|(id, _)| *id != editor.entity_id());
            let next = if this.tabs.is_empty() {
                None
            } else {
                Some(i.min(this.tabs.len() - 1))
            };
            this.activate(next, window, cx);
            cx.defer(move |cx| {
                if let Some(w) = app::open_window(cx) {
                    let _ = w.update(cx, |ws, window, cx| ws.add_editor(editor, window, cx));
                }
            });
        }))
        .on_action(cx.listener(|this, _: &ShowHome, window, cx| this.activate(None, window, cx)))
        .on_action(cx.listener(|this, _: &OpenSettings, window, cx| this.open_settings(window, cx)))
        .on_action(
            cx.listener(|this, _: &CommandPalette, window, cx| this.open_palette(window, cx)),
        )
        .on_action(cx.listener(|this, _: &ShowShortcuts, window, cx| {
            let v = cx.new(ShortcutsSheet::new);
            let f = v.focus_handle(cx);
            window.focus(&f, cx);
            this.overlay = Some(Overlay::Shortcuts(v));
            cx.notify();
        }))
        .on_action(cx.listener(|this, _: &ThemeDark, _, cx| this.set_theme(ThemePref::Dark, cx)))
        .on_action(cx.listener(|this, _: &ThemeLight, _, cx| this.set_theme(ThemePref::Light, cx)))
        .on_action(
            cx.listener(|this, _: &ThemeSystem, _, cx| this.set_theme(ThemePref::System, cx)),
        )
        .on_action(cx.listener(|this, _: &RevealInFiles, _, cx| {
            match this
                .active_editor()
                .and_then(|e| e.read(cx).file().map(|p| p.to_path_buf()))
            {
                Some(p) => cx.reveal_path(&p),
                None => cx.reveal_path(&app::library_dir(cx)),
            }
        }))
        .on_action(cx.listener(|this, _: &CopyFileLink, _, cx| {
            match this
                .active_editor()
                .and_then(|e| e.read(cx).file().map(|p| p.to_path_buf()))
            {
                Some(p) => {
                    cx.write_to_clipboard(ClipboardItem::new_string(
                        crate::deeplink::open_url_for(&p),
                    ));
                    this.toast(
                        "Link copied. It opens this file in Desyn on this computer.".into(),
                        cx,
                    );
                }
                None => this.toast("Save the design first.".into(), cx),
            }
        }))
        .on_action(cx.listener(|_, _: &ToggleFullScreen, window, _| window.toggle_fullscreen()))
        .on_action(cx.listener(|_, _: &Minimize, window, _| window.minimize_window()))
        .on_action(cx.listener(|_, _: &ZoomWindow, window, _| window.zoom_window()))
        .on_action(cx.listener(|this, _: &About, window, cx| {
            drop(window.prompt(
                PromptLevel::Info,
                &format!("Desyn {}", env!("CARGO_PKG_VERSION")),
                Some("The AI-native design suite. Desyn Non-Commercial Source License."),
                &["OK"],
                cx,
            ));
            let _ = this;
        }))
        .on_action(cx.listener(|this, _: &ClearRecent, _, cx| {
            AppState::update(cx, |s| {
                s.recent.entries.clear();
                s.save_recent();
            });
            this.home.update(cx, |h, cx| h.refresh(cx));
        }))
    }
}

/// App-level actions that work without a window.
pub fn register_global_actions(cx: &mut App) {
    cx.on_action(|_: &Quit, cx| quit(cx));
    cx.on_action(|_: &NewWindow, cx| {
        app::open_window(cx);
    });
    cx.on_action(|_: &OpenDocs, cx| cx.open_url("https://docs.desyn.app/editor"));
    cx.on_action(|_: &ThemeDark, cx| set_theme(ThemePref::Dark, cx));
    cx.on_action(|_: &ThemeLight, cx| set_theme(ThemePref::Light, cx));
    cx.on_action(|_: &ThemeSystem, cx| set_theme(ThemePref::System, cx));
}

/// Quits after every window agreed to close (unsaved designs are offered for saving, one window at a time).
pub fn quit(cx: &mut App) {
    let windows: Vec<gpui::WindowHandle<Workspace>> = cx
        .windows()
        .into_iter()
        .filter_map(|w| w.downcast::<Workspace>())
        .collect();
    cx.spawn(async move |cx| {
        for w in windows {
            let Ok(confirm) = w.update(cx, |ws, window, cx| ws.confirm_close(window, cx)) else {
                continue;
            };
            if !confirm.await {
                return;
            }
            let _ = w.update(cx, |ws, _, _| ws.closing = true);
        }
        cx.update(|cx| cx.quit());
    })
    .detach();
}

/// Applies and saves a theme preference.
pub fn set_theme(pref: ThemePref, cx: &mut App) {
    cx.set_global(ThemeSetting(pref));
    AppState::update(cx, |s| {
        s.settings.theme = pref;
        s.save_settings();
    });
    super::menus::install(cx);
    cx.refresh_windows();
}

fn now_ms() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as f64)
        .unwrap_or(0.0)
}

fn tab(
    id: impl Into<gpui::ElementId>,
    title: SharedString,
    active: bool,
    th: &Theme,
) -> gpui::Stateful<gpui::Div> {
    let s3 = th.surface3;
    div()
        .id(id)
        .h(px(28.0))
        .max_w(px(220.0))
        .min_w(px(64.0))
        .flex_shrink(1.0)
        .pl(px(10.0))
        .pr(px(4.0))
        .flex()
        .flex_row_reverse()
        .items_center()
        .gap(px(6.0))
        .rounded(px(8.0))
        .font_family(SANS)
        .text_size(px(12.5))
        .cursor_pointer()
        .text_color(if active { th.fg } else { th.muted })
        .when(active, |d| {
            d.bg(th.surface2).border_1().border_color(th.border_subtle)
        })
        .when(!active, move |d| d.hover(move |s| s.bg(s3)))
        .child(div().min_w(px(0.0)).truncate().child(title))
}

impl Render for Workspace {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let th = t(window, cx);
        let titlebar = self.titlebar(&th, window, cx);
        let body: AnyElement = match self.active_editor() {
            Some(e) => e.into_any_element(),
            None => self.home.clone().into_any_element(),
        };
        let overlay: Option<AnyElement> = self.overlay.as_ref().map(|o| {
            let content: AnyElement = match o {
                Overlay::Palette(p, _) => p.clone().into_any_element(),
                Overlay::Settings(s) => s.clone().into_any_element(),
                Overlay::Shortcuts(s) => s.clone().into_any_element(),
            };
            div()
                .id("overlay-scrim")
                .absolute()
                .inset_0()
                .bg(alpha(gpui::black(), if th.dark { 0.45 } else { 0.18 }))
                .flex()
                .justify_center()
                .on_mouse_down(
                    MouseButton::Left,
                    cx.listener(|this, _, window, cx| this.close_overlay(window, cx)),
                )
                .on_action(
                    cx.listener(|this, _: &Cancel, window, cx| this.close_overlay(window, cx)),
                )
                .child(
                    div()
                        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                        .child(content),
                )
                .into_any_element()
        });
        let toasts = (!self.toasts.is_empty()).then(|| {
            div()
                .absolute()
                .bottom(px(196.0))
                .left_0()
                .right_0()
                .flex()
                .flex_col()
                .items_center()
                .gap(px(8.0))
                .children(self.toasts.iter().map(|t| {
                    div()
                        .px(px(14.0))
                        .py(px(9.0))
                        .max_w(px(560.0))
                        .rounded(px(12.0))
                        .bg(th.glass)
                        .border_1()
                        .border_color(th.border_subtle)
                        .shadow(vec![
                            BoxShadow::new(px(0.0), px(12.0), alpha(gpui::black(), 0.35))
                                .blur_radius(px(32.0)),
                        ])
                        .font_family(SANS)
                        .text_size(px(13.0))
                        .text_color(th.fg)
                        .flex()
                        .items_center()
                        .gap(px(10.0))
                        .child(super::components::sun_mark(8.0, &th))
                        .child(t.text.clone())
                }))
        });
        let edges = self.resize_edges(window);
        div()
            .id("workspace")
            .key_context("Workspace")
            .track_focus(&self.focus)
            .relative()
            .size_full()
            .flex()
            .flex_col()
            .bg(th.bg)
            .text_color(th.fg)
            .font_family(SANS)
            .map(|d| self.workspace_actions(d, cx))
            .child(titlebar)
            .child(div().flex_1().min_h(px(0.0)).child(body))
            .children(overlay)
            .children(toasts)
            .children(self.menu.as_ref().map(|m| m.menu.clone()))
            .children(edges)
    }
}

/// Entries for a recent file's context menu.
pub fn recent_entries() -> Vec<MenuEntry> {
    vec![MenuEntry::action("Clear recent files", ClearRecent)]
}
