//! Modal dialogs and popovers drawn above the whole window (deferred + anchored, like the shell's menus): a dimmed
//! scrim with a centered card (export, share, versions, sign-in), and glass popovers anchored to a point (color
//! and font pickers). Clicking outside or pressing Escape dismisses them.

use std::rc::Rc;

use gpui::{
    AnyElement, App, BoxShadow, InteractiveElement, IntoElement, KeyDownEvent, ParentElement,
    Pixels, Point, SharedString, StatefulInteractiveElement, Styled, Window, anchored, deferred,
    div, point, prelude::FluentBuilder, px,
};

use crate::ui::components::{icon_button, serif};
use crate::ui::theme::{SANS, Theme, alpha};

/// Dismiss callback.
pub type OnClose = Rc<dyn Fn(&mut Window, &mut App)>;

/// A modal: scrim + centered card with a serif title, close button and content.
#[allow(clippy::too_many_arguments)]
pub fn modal(
    id: &str,
    title: AnyElement,
    width: f32,
    content: AnyElement,
    th: &Theme,
    window: &Window,
    focus: Option<&gpui::FocusHandle>,
    on_close: impl Fn(&mut Window, &mut App) + 'static,
) -> impl IntoElement {
    let on_close: OnClose = Rc::new(on_close);
    let size = window.viewport_size();
    let c1 = on_close.clone();
    let c2 = on_close.clone();
    let c3 = on_close.clone();
    let card = div()
        .id(SharedString::from(format!("{id}-card")))
        .w(px(width))
        .max_h(size.height - px(80.0))
        .flex()
        .flex_col()
        .rounded(px(14.0))
        .bg(th.surface1)
        .border_1()
        .border_color(th.border_subtle)
        .shadow(vec![
            BoxShadow::new(
                px(0.0),
                px(30.0),
                alpha(gpui::black(), if th.dark { 0.6 } else { 0.18 }),
            )
            .blur_radius(px(80.0)),
            BoxShadow::new(px(0.0), px(0.0), alpha(th.accent, 0.08)).blur_radius(px(40.0)),
        ])
        .occlude()
        .on_mouse_down(gpui::MouseButton::Left, |_, _, cx| cx.stop_propagation())
        .child(
            div()
                .flex_none()
                .px(px(22.0))
                .pt(px(18.0))
                .pb(px(12.0))
                .flex()
                .items_center()
                .justify_between()
                .child(title)
                .child(
                    icon_button(
                        SharedString::from(format!("{id}-close")),
                        "icons/x.svg",
                        30.0,
                        false,
                        th,
                    )
                    .on_click(move |_, w, cx| c1(w, cx)),
                ),
        )
        .child(
            div()
                .id(SharedString::from(format!("{id}-body")))
                .flex_1()
                .min_h(px(0.0))
                .overflow_y_scroll()
                .px(px(22.0))
                .pb(px(20.0))
                .child(content),
        );
    deferred(
        anchored().position(point(px(0.0), px(0.0))).child(
            div()
                .id(SharedString::from(format!("{id}-scrim")))
                .w(size.width)
                .h(size.height)
                .flex()
                .items_center()
                .justify_center()
                .bg(alpha(gpui::black(), if th.dark { 0.55 } else { 0.28 }))
                .when_some(focus.cloned(), |d, f| d.track_focus(&f))
                .occlude()
                .on_mouse_down(gpui::MouseButton::Left, move |_, w, cx| c2(w, cx))
                .on_key_down(move |e: &KeyDownEvent, w, cx| {
                    if e.keystroke.key == "escape" {
                        c3(w, cx);
                        cx.stop_propagation();
                    }
                })
                .child(card),
        ),
    )
    .with_priority(20)
}

/// A modal title: serif with one italic sun word ("export your *design*").
pub fn modal_title(text: &str, italic: Option<&str>, th: &Theme) -> AnyElement {
    div()
        .flex()
        .items_baseline()
        .gap(px(7.0))
        .child(serif(text.to_string(), 28.0, th.fg))
        .children(italic.map(|w| {
            div()
                .font_family(crate::ui::theme::SERIF)
                .italic()
                .text_size(px(28.0))
                .text_color(th.accent_text)
                .child(w.to_string())
        }))
        .into_any_element()
}

/// A glass popover anchored at a window position.
pub fn popover(
    id: &str,
    at: Point<Pixels>,
    content: AnyElement,
    th: &Theme,
    on_dismiss: impl Fn(&mut Window, &mut App) + 'static,
) -> impl IntoElement {
    let dismiss: OnClose = Rc::new(on_dismiss);
    let d2 = dismiss.clone();
    deferred(
        anchored()
            .position(at)
            .snap_to_window_with_margin(px(8.0))
            .child(
                div()
                    .id(SharedString::from(format!("{id}-popover")))
                    .rounded(px(12.0))
                    .bg(th.glass)
                    .border_1()
                    .border_color(th.border_subtle)
                    .shadow(vec![
                        BoxShadow::new(
                            px(0.0),
                            px(14.0),
                            alpha(gpui::black(), if th.dark { 0.45 } else { 0.16 }),
                        )
                        .blur_radius(px(36.0)),
                    ])
                    .font_family(SANS)
                    .occlude()
                    .on_mouse_down_out(move |_, w, cx| dismiss(w, cx))
                    .on_key_down(move |e: &KeyDownEvent, w, cx| {
                        if e.keystroke.key == "escape" {
                            d2(w, cx);
                            cx.stop_propagation();
                        }
                    })
                    .child(content),
            ),
    )
    .with_priority(15)
}
