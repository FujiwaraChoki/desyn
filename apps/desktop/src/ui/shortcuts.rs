//! The keyboard shortcuts sheet (mod+/): every command with its live binding, grouped like the docs table.

use gpui::{
    App, BoxShadow, Context, FocusHandle, Focusable, InteractiveElement, IntoElement,
    ParentElement, Render, StatefulInteractiveElement, Styled, Window, div, px,
};

use super::actions::shortcut_label;
use super::commands;
use super::components::{kbd, label, serif, t};
use super::theme::{SANS, alpha};

/// The sheet.
pub struct ShortcutsSheet {
    focus: FocusHandle,
}

impl ShortcutsSheet {
    /// New sheet.
    pub fn new(cx: &mut Context<Self>) -> ShortcutsSheet {
        ShortcutsSheet {
            focus: cx.focus_handle(),
        }
    }
}

impl Focusable for ShortcutsSheet {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl Render for ShortcutsSheet {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let th = t(window, cx);
        let mut groups: Vec<(&'static str, Vec<(String, String)>)> = Vec::new();
        for c in commands::all() {
            let a = (c.action)();
            let Some(b) = window.highest_precedence_binding_for_action(a.as_ref()) else {
                continue;
            };
            let keys = shortcut_label(
                &b.keystrokes()
                    .iter()
                    .map(|k| k.to_string())
                    .collect::<Vec<_>>()
                    .join(" "),
            );
            match groups.iter_mut().find(|(g, _)| *g == c.group) {
                Some(g) => g.1.push((c.title.to_string(), keys)),
                None => groups.push((c.group, vec![(c.title.to_string(), keys)])),
            }
        }
        // Gestures that are not actions.
        groups.push((
            "Canvas",
            vec![
                ("Pan".into(), "Space + drag".into()),
                (
                    "Zoom".into(),
                    format!(
                        "{} + scroll",
                        if cfg!(target_os = "macos") {
                            "⌘"
                        } else {
                            "Ctrl"
                        }
                    ),
                ),
                ("Constrain / keep proportions".into(), "Shift + drag".into()),
                ("Resize from center / duplicate".into(), "Alt + drag".into()),
                (
                    "Deep select".into(),
                    format!(
                        "{} + click",
                        if cfg!(target_os = "macos") {
                            "⌘"
                        } else {
                            "Ctrl"
                        }
                    ),
                ),
                ("Measure distances".into(), "Hold Alt".into()),
            ],
        ));
        div()
            .id("shortcuts")
            .track_focus(&self.focus)
            .mt(px(56.0))
            .w(px(860.0))
            .max_h(px(760.0))
            .overflow_y_scroll()
            .p(px(28.0))
            .rounded(px(18.0))
            .bg(th.surface1)
            .border_1()
            .border_color(th.border_subtle)
            .shadow(vec![
                BoxShadow::new(
                    px(0.0),
                    px(24.0),
                    alpha(gpui::black(), if th.dark { 0.6 } else { 0.2 }),
                )
                .blur_radius(px(64.0)),
            ])
            .flex()
            .flex_col()
            .gap(px(18.0))
            .child(serif("keyboard shortcuts", 34.0, th.fg))
            .child(
                div()
                    .flex()
                    .flex_wrap()
                    .gap(px(28.0))
                    .children(groups.into_iter().map(|(g, rows)| {
                        div()
                            .w(px(380.0))
                            .flex()
                            .flex_col()
                            .gap(px(4.0))
                            .child(label(g, &th))
                            .children(rows.into_iter().map(|(title, keys)| {
                                div()
                                    .flex()
                                    .items_center()
                                    .justify_between()
                                    .py(px(4.0))
                                    .child(
                                        div()
                                            .font_family(SANS)
                                            .text_size(px(13.0))
                                            .text_color(th.fg)
                                            .child(title),
                                    )
                                    .child(kbd(keys, &th))
                            }))
                    })),
            )
    }
}
