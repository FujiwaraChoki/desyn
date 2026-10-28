//! Popup menus (context menu, zoom menu, shapes menu, the in-window menu bar on Linux / Windows): a glass panel
//! with keyboard navigation that dispatches actions to the element that had focus.

use std::rc::Rc;

use gpui::{
    Action, App, BoxShadow, Context, DismissEvent, EventEmitter, FocusHandle, Focusable,
    IntoElement, KeyDownEvent, MouseButton, ParentElement, Pixels, Point, Render, SharedString,
    Styled, Window, anchored, deferred, div, prelude::*, px,
};

use super::actions::shortcut_label;
use super::components::{icon, t};
use super::theme::{SANS, alpha};

/// A callback run by a menu row or palette entry.
pub type MenuRun = Rc<dyn Fn(&mut Window, &mut App)>;

/// A menu row.
#[derive(Clone)]
pub enum MenuEntry {
    /// Dispatches an action.
    Action {
        /// Label.
        label: SharedString,
        /// Action.
        action: Rc<dyn Action>,
        /// Enabled.
        enabled: bool,
        /// Checkmark state (`None` = not a toggle).
        checked: Option<bool>,
    },
    /// Runs a closure.
    Run {
        /// Label.
        label: SharedString,
        /// Callback.
        run: MenuRun,
        /// Shortcut hint.
        hint: Option<SharedString>,
    },
    /// Section title.
    Header(SharedString),
    /// Separator.
    Separator,
}

impl MenuEntry {
    /// Action row.
    pub fn action(label: impl Into<SharedString>, action: impl Action) -> MenuEntry {
        MenuEntry::Action {
            label: label.into(),
            action: Rc::from(Box::new(action) as Box<dyn Action>),
            enabled: true,
            checked: None,
        }
    }

    /// Action row from a boxed action.
    pub fn boxed(label: impl Into<SharedString>, action: Box<dyn Action>) -> MenuEntry {
        MenuEntry::Action {
            label: label.into(),
            action: Rc::from(action),
            enabled: true,
            checked: None,
        }
    }

    /// Closure row.
    pub fn run(
        label: impl Into<SharedString>,
        f: impl Fn(&mut Window, &mut App) + 'static,
    ) -> MenuEntry {
        MenuEntry::Run {
            label: label.into(),
            run: Rc::new(f),
            hint: None,
        }
    }

    /// Sets enabled.
    pub fn enabled(mut self, on: bool) -> MenuEntry {
        if let MenuEntry::Action { enabled, .. } = &mut self {
            *enabled = on;
        }
        self
    }

    /// Makes the row a toggle.
    pub fn checked(mut self, on: bool) -> MenuEntry {
        if let MenuEntry::Action { checked, .. } = &mut self {
            *checked = Some(on);
        }
        self
    }

    fn selectable(&self) -> bool {
        matches!(
            self,
            MenuEntry::Action { enabled: true, .. } | MenuEntry::Run { .. }
        )
    }
}

/// Emitted when the menu closes.
pub struct MenuDismissed;

/// The popup.
pub struct PopupMenu {
    entries: Vec<MenuEntry>,
    at: Point<Pixels>,
    focus: FocusHandle,
    return_focus: FocusHandle,
    hover: Option<usize>,
}

impl EventEmitter<MenuDismissed> for PopupMenu {}
impl EventEmitter<DismissEvent> for PopupMenu {}

impl Focusable for PopupMenu {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl PopupMenu {
    /// Opens at a window position; actions go to `return_focus`.
    pub fn new(
        entries: Vec<MenuEntry>,
        at: Point<Pixels>,
        return_focus: FocusHandle,
        cx: &mut Context<Self>,
    ) -> PopupMenu {
        PopupMenu {
            entries,
            at,
            focus: cx.focus_handle(),
            return_focus,
            hover: None,
        }
    }

    fn activate(&mut self, i: usize, window: &mut Window, cx: &mut Context<Self>) {
        let Some(e) = self.entries.get(i).cloned() else {
            return;
        };
        if !e.selectable() {
            return;
        }
        window.focus(&self.return_focus, cx);
        cx.emit(MenuDismissed);
        match e {
            MenuEntry::Action { action, .. } => {
                let a = action.boxed_clone();
                window.defer(cx, move |window, cx| window.dispatch_action(a, cx));
            }
            MenuEntry::Run { run, .. } => {
                window.defer(cx, move |window, cx| run(window, cx));
            }
            _ => {}
        }
    }

    fn step(&mut self, dir: i32) {
        let n = self.entries.len() as i32;
        if n == 0 {
            return;
        }
        let mut i = self
            .hover
            .map(|h| h as i32)
            .unwrap_or(if dir > 0 { -1 } else { n });
        for _ in 0..n {
            i = (i + dir).rem_euclid(n);
            if self.entries[i as usize].selectable() {
                self.hover = Some(i as usize);
                return;
            }
        }
    }

    fn on_key(&mut self, e: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        match e.keystroke.key.as_str() {
            "down" => self.step(1),
            "up" => self.step(-1),
            "enter" | "space" => {
                if let Some(h) = self.hover {
                    self.activate(h, window, cx);
                }
            }
            "escape" => {
                cx.emit(MenuDismissed);
            }
            _ => return,
        }
        cx.stop_propagation();
        cx.notify();
    }
}

impl Render for PopupMenu {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let th = t(window, cx);
        let rows: Vec<gpui::AnyElement> = self
            .entries
            .iter()
            .enumerate()
            .map(|(i, e)| match e {
                MenuEntry::Separator => div()
                    .h(px(1.0))
                    .mx(px(8.0))
                    .my(px(4.0))
                    .bg(th.border_subtle)
                    .into_any_element(),
                MenuEntry::Header(h) => div()
                    .px(px(12.0))
                    .pt(px(8.0))
                    .pb(px(4.0))
                    .font_family(SANS)
                    .text_size(px(11.0))
                    .text_color(th.faint)
                    .child(h.clone())
                    .into_any_element(),
                MenuEntry::Action {
                    label,
                    action,
                    enabled,
                    checked,
                } => {
                    let keys = window
                        .highest_precedence_binding_for_action(action.as_ref())
                        .map(|b| {
                            shortcut_label(
                                &b.keystrokes()
                                    .iter()
                                    .map(|k| k.to_string())
                                    .collect::<Vec<_>>()
                                    .join(" "),
                            )
                        });
                    row(
                        i,
                        label.clone(),
                        keys.map(Into::into),
                        *enabled,
                        *checked,
                        self.hover == Some(i),
                        &th,
                        cx,
                    )
                }
                MenuEntry::Run { label, hint, .. } => row(
                    i,
                    label.clone(),
                    hint.clone(),
                    true,
                    None,
                    self.hover == Some(i),
                    &th,
                    cx,
                ),
            })
            .collect();
        let panel = div()
            .id("popup-menu")
            .track_focus(&self.focus)
            .on_key_down(cx.listener(Self::on_key))
            .on_mouse_down_out(cx.listener(|_, _, _, cx| cx.emit(MenuDismissed)))
            .min_w(px(220.0))
            .py(px(6.0))
            .rounded(px(12.0))
            .bg(th.glass)
            .border_1()
            .border_color(th.border_subtle)
            .shadow(vec![
                BoxShadow::new(
                    px(0.0),
                    px(10.0),
                    alpha(gpui::black(), if th.dark { 0.4 } else { 0.14 }),
                )
                .blur_radius(px(28.0)),
            ])
            .font_family(SANS)
            .text_size(px(13.0))
            .text_color(th.fg)
            .children(rows);
        deferred(
            anchored()
                .position(self.at)
                .snap_to_window_with_margin(px(8.0))
                .child(panel),
        )
        .with_priority(10)
    }
}

#[allow(clippy::too_many_arguments)]
fn row(
    i: usize,
    label: SharedString,
    keys: Option<SharedString>,
    enabled: bool,
    checked: Option<bool>,
    hovered: bool,
    th: &super::theme::Theme,
    cx: &mut Context<PopupMenu>,
) -> gpui::AnyElement {
    let fg = if enabled { th.fg } else { th.faint };
    div()
        .id(("menu-row", i))
        .mx(px(6.0))
        .px(px(8.0))
        .h(px(30.0))
        .flex()
        .items_center()
        .gap(px(8.0))
        .rounded(px(7.0))
        .text_color(fg)
        .when(hovered && enabled, |d| d.bg(th.accent_soft))
        .when(enabled, |d| {
            let s = th.accent_soft;
            d.cursor_pointer().hover(move |st| st.bg(s))
        })
        .child(
            div().w(px(14.0)).flex_none().children(
                checked
                    .filter(|c| *c)
                    .map(|_| icon("icons/check.svg", 14.0, th.accent_text)),
            ),
        )
        .child(div().flex_1().child(label))
        .children(keys.map(|k| div().text_size(px(11.5)).text_color(th.faint).child(k)))
        .on_mouse_move(cx.listener(move |this, _, _, cx| {
            if this.hover != Some(i) {
                this.hover = Some(i);
                cx.notify();
            }
        }))
        .on_mouse_up(
            MouseButton::Left,
            cx.listener(move |this, _, window, cx| this.activate(i, window, cx)),
        )
        .into_any_element()
}
