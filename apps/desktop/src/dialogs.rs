//! A per-editor host for modal dialogs (export, share, version history, sign-in) and the comments side sheet. It
//! lives in the editor's dock slot as an out-of-flow element and draws its content above the whole window.

use std::cell::RefCell;
use std::collections::HashMap;

use gpui::{
    AnyElement, AnyView, App, AppContext, BoxShadow, Context, Entity, EntityId, FocusHandle,
    Focusable, InteractiveElement, IntoElement, ParentElement, Render, Styled, WeakEntity, Window,
    anchored, deferred, div, point, px,
};

use crate::ui::components::t;
use crate::ui::editor::EditorView;
use crate::ui::ext::{Extensions, PanelSpec, Slot};
use crate::ui::theme::alpha;
use crate::widgets::dialog::{modal, modal_title};

thread_local! {
    static HOSTS: RefCell<HashMap<EntityId, WeakEntity<DialogHost>>> = RefCell::new(HashMap::new());
}

/// An open dialog.
pub struct Dialog {
    /// Serif title and italic sun word.
    pub title: (&'static str, Option<&'static str>),
    /// Card width.
    pub width: f32,
    /// Content view.
    pub view: AnyView,
}

/// The host.
pub struct DialogHost {
    editor: Entity<EditorView>,
    dialog: Option<Dialog>,
    sheet: Option<AnyView>,
    focus: FocusHandle,
}

impl Focusable for DialogHost {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

/// Registers the host in the dock slot.
pub fn install(cx: &mut App) {
    Extensions::update(cx, |x| {
        x.panel(
            PanelSpec::new(
                "dialogs",
                "Dialogs",
                "icons/app-window.svg",
                Slot::Dock,
                |editor, _window, cx| {
                    let e = editor.clone();
                    cx.new(|cx| DialogHost {
                        editor: e,
                        dialog: None,
                        sheet: None,
                        focus: cx.focus_handle(),
                    })
                    .into()
                },
            )
            .order(100),
        );
    });
}

fn host(editor: &Entity<EditorView>, cx: &mut App) -> Option<Entity<DialogHost>> {
    // Dialogs need the dock slot, which focus mode hides.
    editor.update(cx, |e, cx| {
        if e.focus_mode {
            e.focus_mode = false;
            cx.notify();
        }
    });
    if let Some(h) = HOSTS.with(|h| {
        h.borrow()
            .get(&editor.entity_id())
            .and_then(|w| w.upgrade())
    }) {
        return Some(h);
    }
    None
}

/// Opens a modal dialog for an editor (replacing any open one).
pub fn open(
    editor: &Entity<EditorView>,
    window: &mut Window,
    cx: &mut App,
    build: impl FnOnce(&mut Window, &mut App) -> Dialog,
) {
    let d = build(window, cx);
    match host(editor, cx) {
        Some(h) => {
            let focus = h.update(cx, |h, cx| {
                h.dialog = Some(d);
                cx.notify();
                h.focus.clone()
            });
            // Keys go to the dialog (Escape closes it) instead of the canvas shortcuts.
            window.focus(&focus, cx);
        }
        None => {
            // The host registers on its first render; try again on the next frame.
            let ed = editor.clone();
            PENDING.with(|p| p.borrow_mut().insert(ed.entity_id(), d));
            editor.update(cx, |_, cx| cx.notify());
        }
    }
}

thread_local! {
    static PENDING: RefCell<HashMap<EntityId, Dialog>> = RefCell::new(HashMap::new());
}

/// Closes the dialog of an editor.
pub fn close(editor: &Entity<EditorView>, cx: &mut App) {
    if let Some(h) = host(editor, cx) {
        h.update(cx, |h, cx| {
            h.dialog = None;
            cx.notify();
        });
    }
}

/// Shows or hides the side sheet (comments).
pub fn toggle_sheet(
    editor: &Entity<EditorView>,
    cx: &mut App,
    build: impl FnOnce(&mut App) -> AnyView,
) {
    if let Some(h) = host(editor, cx) {
        let open = h.read(cx).sheet.is_some();
        let view = (!open).then(|| build(cx));
        h.update(cx, |h, cx| {
            h.sheet = view;
            cx.notify();
        });
    }
}

/// Hides the side sheet.
pub fn close_sheet(editor: &Entity<EditorView>, cx: &mut App) {
    if let Some(h) = host(editor, cx) {
        h.update(cx, |h, cx| {
            h.sheet = None;
            cx.notify();
        });
    }
}

impl Render for DialogHost {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let me = cx.entity().downgrade();
        let ed_id = self.editor.entity_id();
        HOSTS.with(|h| h.borrow_mut().insert(ed_id, me));
        if let Some(d) = PENDING.with(|p| p.borrow_mut().remove(&ed_id)) {
            self.dialog = Some(d);
        }
        let th = t(window, cx);
        let ed = self.editor.clone();
        let dialog: Option<AnyElement> = self.dialog.as_ref().map(|d| {
            let ed = ed.clone();
            modal(
                "dialog",
                modal_title(d.title.0, d.title.1, &th),
                d.width,
                d.view.clone().into_any_element(),
                &th,
                window,
                Some(&self.focus),
                move |_, cx| close(&ed, cx),
            )
            .into_any_element()
        });
        let size = window.viewport_size();
        let sheet = self.sheet.clone().map(|v| {
            let top = px(92.0);
            deferred(
                anchored()
                    .position(point(size.width - px(372.0), top))
                    .child(
                        div()
                            .id("side-sheet")
                            .w(px(360.0))
                            .h(size.height - top - px(16.0))
                            .rounded(px(14.0))
                            .bg(th.surface1)
                            .border_1()
                            .border_color(th.border_subtle)
                            .shadow(vec![
                                BoxShadow::new(
                                    px(0.0),
                                    px(18.0),
                                    alpha(gpui::black(), if th.dark { 0.5 } else { 0.15 }),
                                )
                                .blur_radius(px(48.0)),
                            ])
                            .overflow_hidden()
                            .occlude()
                            .child(v),
                    ),
            )
            .with_priority(12)
        });
        div()
            .absolute()
            .size(px(0.0))
            .track_focus(&self.focus)
            .children(dialog)
            .children(sheet)
    }
}

impl Drop for DialogHost {
    fn drop(&mut self) {
        let id = self.editor.entity_id();
        HOSTS.with(|h| {
            h.borrow_mut().remove(&id);
        });
    }
}
