//! Native widgets for the feature modules (panels, inspector, AI dock, dialogs), styled per DESIGN_SYSTEM §5 on
//! top of the shell's components: section headers, segmented controls, toggles, swatches, the sun spinner, empty
//! states, numeric scrubbers ([`number`]), the color picker ([`color`]), fonts and the font picker ([`fonts`]),
//! modal dialogs ([`dialog`]) and helpers to reach the workspace (toasts, open editors).

pub mod color;
pub mod dialog;
pub mod fonts;
pub mod number;

use std::rc::Rc;
use std::time::Duration;

use gpui::{
    Animation, AnimationExt, AnyElement, App, BoxShadow, Context, Div, Entity, Hsla,
    InteractiveElement, IntoElement, MouseMoveEvent, MouseUpEvent, ParentElement, Pixels, Point,
    SharedString, Stateful, StatefulInteractiveElement, Styled, Window, canvas, div,
    prelude::FluentBuilder, px,
};

use crate::ui::components::{icon, label, serif, tip};
use crate::ui::editor::EditorView;
use crate::ui::text_field::TextField;
use crate::ui::theme::{MONO, SANS, SERIF, Theme, alpha};
use crate::ui::workspace::Workspace;

/// Whether a URL that came from remote data (feeds, stock photo attribution) may be handed to the system
/// opener: web pages only, never `file:` or custom schemes that could launch local handlers.
pub fn is_web_url(url: &str) -> bool {
    url::Url::parse(url).is_ok_and(|u| matches!(u.scheme(), "https" | "http") && u.host().is_some())
}

/// Opens a URL from remote data in the browser when it is a web page (see [`is_web_url`]).
pub fn open_web_url(url: &str, cx: &mut App) {
    if is_web_url(url) {
        cx.open_url(url);
    } else {
        log::warn!("refused to open a non-web link from remote data");
    }
}

/// Shows a toast in the active window.
pub fn notify(cx: &mut App, msg: String) {
    if let Some(w) = crate::ui::app::target_window(cx) {
        let _ = w.update(cx, |ws, _, cx| ws.toast(msg, cx));
    }
}

/// Every open editor in every window.
pub fn all_editors(cx: &App) -> Vec<Entity<EditorView>> {
    cx.windows()
        .into_iter()
        .filter_map(|w| w.downcast::<Workspace>())
        .filter_map(|w| w.read(cx).ok().map(|ws| ws.editors().to_vec()))
        .flatten()
        .collect()
}

/// The active editor of the active window.
pub fn active_editor(cx: &App) -> Option<Entity<EditorView>> {
    let w = cx.active_window().and_then(|w| w.downcast::<Workspace>())?;
    w.read(cx).ok().and_then(|ws| ws.active_editor())
}

/// Opens a document in a tab of the active window (or a new window).
pub fn open_document(
    doc: crate::doc::Document,
    file: Option<std::path::PathBuf>,
    cx: &mut App,
) -> Option<Entity<EditorView>> {
    let w = crate::ui::app::target_window(cx)?;
    w.update(cx, |ws, window, cx| {
        window.activate_window();
        ws.open_document(doc, file, window, cx);
        ws.active_editor()
    })
    .ok()
    .flatten()
}

/// Focuses the tab showing `editor`.
pub fn focus_editor(editor: &Entity<EditorView>, cx: &mut App) -> bool {
    for w in cx
        .windows()
        .into_iter()
        .filter_map(|w| w.downcast::<Workspace>())
    {
        let has = w
            .read(cx)
            .ok()
            .is_some_and(|ws| ws.editors().iter().any(|e| e == editor));
        if has {
            let ed = editor.clone();
            let _ = w.update(cx, |ws, window, cx| {
                window.activate_window();
                if let Some(i) = ws.editors().iter().position(|e| *e == ed) {
                    ws.activate_tab(i, window, cx);
                }
            });
            return true;
        }
    }
    false
}

/// A panel's serif title with an optional italic sun word ("brand *kits*").
pub fn title(text: &str, italic: Option<&str>, th: &Theme) -> Div {
    div()
        .flex()
        .items_baseline()
        .gap(px(6.0))
        .font_family(SERIF)
        .text_size(px(26.0))
        .line_height(px(30.0))
        .text_color(th.fg)
        .child(text.to_string())
        .when_some(italic, |d, w| {
            d.child(
                div()
                    .italic()
                    .text_color(th.accent_text)
                    .child(w.to_string()),
            )
        })
}

/// A section header (small label, optional trailing element).
pub fn section(text: &str, trailing: Option<AnyElement>, th: &Theme) -> Div {
    div()
        .flex()
        .items_center()
        .justify_between()
        .h(px(28.0))
        .child(label(text, th))
        .children(trailing)
}

/// The search box around a text field.
pub fn search_box(field: Entity<TextField>, th: &Theme) -> Div {
    div()
        .h(px(34.0))
        .px(px(10.0))
        .flex()
        .items_center()
        .gap(px(8.0))
        .rounded(px(8.0))
        .bg(th.surface2)
        .border_1()
        .border_color(th.border_subtle)
        .child(icon("icons/search.svg", 14.0, th.faint))
        .child(div().flex_1().min_w(px(0.0)).child(field))
}

/// A text input box (label above optional).
pub fn input_box(field: Entity<TextField>, th: &Theme) -> Div {
    div()
        .h(px(32.0))
        .px(px(10.0))
        .flex()
        .items_center()
        .rounded(px(8.0))
        .bg(th.surface2)
        .border_1()
        .border_color(th.border_subtle)
        .child(div().flex_1().min_w(px(0.0)).child(field))
}

/// Empty state: serif headline, body, optional action.
pub fn empty(headline: &str, body: &str, action: Option<AnyElement>, th: &Theme) -> Div {
    div()
        .py(px(28.0))
        .px(px(12.0))
        .flex()
        .flex_col()
        .items_center()
        .gap(px(8.0))
        .child(serif(headline.to_string(), 22.0, th.fg))
        .child(
            div()
                .max_w(px(240.0))
                .text_center()
                .font_family(SANS)
                .text_size(px(12.5))
                .line_height(px(18.0))
                .text_color(th.muted)
                .child(body.to_string()),
        )
        .children(action.map(|a| div().pt(px(6.0)).child(a)))
}

/// The sun spinner (loading): a glowing disc that breathes.
pub fn spinner(id: impl Into<SharedString>, size: f32, th: &Theme) -> AnyElement {
    let hi = th.sun_hi;
    let lo = th.sun_lo;
    let glow = th.accent_glow;
    div()
        .size(px(size))
        .rounded(px(size))
        .bg(gpui::linear_gradient(
            135.0,
            gpui::linear_color_stop(hi, 0.0),
            gpui::linear_color_stop(lo, 1.0),
        ))
        .with_animation(
            gpui::ElementId::Name(id.into()),
            Animation::new(Duration::from_millis(1400))
                .repeat()
                .with_easing(|t| 0.5 - 0.5 * (t * std::f32::consts::TAU).cos()),
            move |d, t| {
                d.opacity(0.55 + 0.45 * t).shadow(vec![
                    BoxShadow::new(px(0.0), px(0.0), glow).blur_radius(px(size * (0.6 + 1.2 * t))),
                ])
            },
        )
        .into_any_element()
}

/// A loading row ("Loading templates…").
pub fn loading(id: &str, text: &str, th: &Theme) -> Div {
    div()
        .py(px(24.0))
        .flex()
        .items_center()
        .justify_center()
        .gap(px(10.0))
        .child(spinner(SharedString::from(id.to_string()), 12.0, th))
        .child(
            div()
                .font_family(SANS)
                .text_size(px(12.5))
                .text_color(th.muted)
                .child(text.to_string()),
        )
}

/// A one-line error with a retry action.
pub fn error_row(text: &str, retry: Option<AnyElement>, th: &Theme) -> Div {
    div()
        .p(px(12.0))
        .flex()
        .flex_col()
        .gap(px(8.0))
        .rounded(px(10.0))
        .bg(alpha(th.danger, 0.08))
        .border_1()
        .border_color(alpha(th.danger, 0.25))
        .child(
            div()
                .w_full()
                .flex()
                .gap(px(8.0))
                .child(icon("icons/circle-alert.svg", 14.0, th.danger))
                .child(
                    // min width 0 lets the message wrap inside the card instead of overflowing the panel.
                    div()
                        .flex_1()
                        .min_w_0()
                        .font_family(SANS)
                        .text_size(px(12.5))
                        .line_height(px(17.0))
                        .text_color(th.fg)
                        .child(text.to_string()),
                ),
        )
        .children(retry)
}

/// Callback with a value.
pub type OnValue<T> = Rc<dyn Fn(T, &mut Window, &mut App)>;

/// A segmented control option.
#[derive(Clone)]
pub enum Seg {
    /// Text label.
    Text(SharedString),
    /// Icon with a tooltip.
    Icon(&'static str, SharedString),
}

/// A segmented control.
pub fn segmented<T: Clone + PartialEq + 'static>(
    id: &str,
    options: Vec<(T, Seg)>,
    selected: Option<&T>,
    th: &Theme,
    on: impl Fn(T, &mut Window, &mut App) + 'static,
) -> Stateful<Div> {
    let on: OnValue<T> = Rc::new(on);
    let s3 = th.surface3;
    div()
        .id(SharedString::from(format!("seg-{id}")))
        .h(px(30.0))
        .p(px(2.0))
        .flex()
        .gap(px(2.0))
        .rounded(px(8.0))
        .bg(th.surface2)
        .border_1()
        .border_color(th.border_subtle)
        .children(options.into_iter().enumerate().map(|(i, (v, seg))| {
            let active = selected == Some(&v);
            let on = on.clone();
            let fg = if active { th.fg } else { th.muted };
            let mut d = div()
                .id(SharedString::from(format!("seg-{id}-{i}")))
                .flex_1()
                .h_full()
                .px(px(6.0))
                .flex()
                .items_center()
                .justify_center()
                .rounded(px(6.0))
                .cursor_pointer()
                .font_family(SANS)
                .text_size(px(12.0))
                .text_color(fg)
                .when(active, |d| {
                    d.bg(th.surface1).shadow(vec![
                        BoxShadow::new(px(0.0), px(1.0), alpha(gpui::black(), 0.25))
                            .blur_radius(px(2.0)),
                    ])
                })
                .when(!active, move |d| d.hover(move |s| s.bg(s3)))
                .on_click(move |_, window, cx| on(v.clone(), window, cx));
            d = match seg {
                Seg::Text(t) => d.child(t),
                Seg::Icon(path, t) => d.tooltip(tip(t, None)).child(icon(path, 14.0, fg)),
            };
            d
        }))
}

/// A toggle switch.
pub fn toggle(
    id: &str,
    on: bool,
    th: &Theme,
    f: impl Fn(bool, &mut Window, &mut App) + 'static,
) -> Stateful<Div> {
    let knob = div()
        .size(px(14.0))
        .rounded(px(7.0))
        .bg(if on { th.accent_ink } else { th.fg })
        .shadow(vec![
            BoxShadow::new(px(0.0), px(1.0), alpha(gpui::black(), 0.3)).blur_radius(px(2.0)),
        ]);
    div()
        .id(SharedString::from(format!("toggle-{id}")))
        .w(px(30.0))
        .h(px(18.0))
        .flex_none()
        .p(px(2.0))
        .flex()
        .items_center()
        .when(on, |d| d.justify_end())
        .rounded(px(9.0))
        .cursor_pointer()
        .bg(if on {
            th.accent_solid
        } else {
            alpha(th.fg, 0.18)
        })
        .child(knob)
        .on_click(move |_, window, cx| f(!on, window, cx))
}

/// A labelled row ("Opacity   [field]").
pub fn row(text: &str, content: impl IntoElement, th: &Theme) -> Div {
    div()
        .flex()
        .items_center()
        .gap(px(10.0))
        .min_h(px(30.0))
        .child(
            div()
                .w(px(76.0))
                .flex_none()
                .font_family(SANS)
                .text_size(px(12.0))
                .text_color(th.muted)
                .child(text.to_string()),
        )
        .child(div().flex_1().min_w(px(0.0)).child(content))
}

/// A color swatch (checkerboard behind translucent colors).
pub fn swatch(color: Hsla, size: f32, th: &Theme) -> Div {
    let checker = color.a < 0.999;
    let cell = (size / 4.0).max(3.0);
    let n = (size / cell).ceil() as usize;
    div()
        .size(px(size))
        .flex_none()
        .rounded(px(size.min(12.0) * 0.4))
        .overflow_hidden()
        .relative()
        .border_1()
        .border_color(th.border)
        .when(checker, |d| {
            d.bg(gpui::white()).children(
                (0..n * n)
                    .filter(|i| (i / n + i % n).is_multiple_of(2))
                    .map(|i| {
                        div()
                            .absolute()
                            .left(px((i % n) as f32 * cell))
                            .top(px((i / n) as f32 * cell))
                            .size(px(cell))
                            .bg(gpui::rgb(0xd0d0d0))
                    }),
            )
        })
        .child(div().absolute().inset_0().bg(color))
}

/// Converts a design color (`#rrggbb[aa]`) to a GPUI color.
pub fn hsla(c: &str) -> Hsla {
    let rgba = desyn_core::model::Color::new(c.to_string())
        .map(|c| c.rgba8())
        .unwrap_or([0, 0, 0, 255]);
    gpui::Rgba {
        r: rgba[0] as f32 / 255.0,
        g: rgba[1] as f32 / 255.0,
        b: rgba[2] as f32 / 255.0,
        a: rgba[3] as f32 / 255.0,
    }
    .into()
}

/// A small mono value ("1080 × 1080").
pub fn mono(text: impl Into<SharedString>, th: &Theme) -> Div {
    div()
        .font_family(MONO)
        .text_size(px(11.0))
        .text_color(th.faint)
        .child(text.into())
}

/// A clickable list row with an icon.
pub fn list_row(
    id: impl Into<SharedString>,
    icon_path: &'static str,
    text: impl Into<SharedString>,
    th: &Theme,
) -> Stateful<Div> {
    let s3 = th.surface3;
    div()
        .id(gpui::ElementId::Name(id.into()))
        .h(px(32.0))
        .px(px(8.0))
        .flex()
        .items_center()
        .gap(px(10.0))
        .rounded(px(8.0))
        .cursor_pointer()
        .hover(move |s| s.bg(s3))
        .child(icon(icon_path, 15.0, th.muted))
        .child(
            div()
                .flex_1()
                .min_w(px(0.0))
                .truncate()
                .font_family(SANS)
                .text_size(px(13.0))
                .text_color(th.fg)
                .child(text.into()),
        )
}

/// Captures mouse moves / releases anywhere in the window while `active` (scrubbing, dragging handles).
pub fn capture<V: 'static>(
    view: &Entity<V>,
    active: bool,
    on_move: impl Fn(&mut V, Point<Pixels>, bool, &mut Window, &mut Context<V>) + 'static,
    on_up: impl Fn(&mut V, Point<Pixels>, &mut Window, &mut Context<V>) + 'static,
) -> impl IntoElement {
    let view = view.clone();
    canvas(
        |_, _, _| (),
        move |_, _, window, _| {
            if !active {
                return;
            }
            let v = view.clone();
            window.on_mouse_event(move |e: &MouseMoveEvent, phase, window, cx| {
                if phase == gpui::DispatchPhase::Bubble {
                    v.update(cx, |this, cx| {
                        on_move(this, e.position, e.modifiers.shift, window, cx)
                    });
                }
            });
            let v = view.clone();
            window.on_mouse_event(move |e: &MouseUpEvent, phase, window, cx| {
                if phase == gpui::DispatchPhase::Bubble {
                    v.update(cx, |this, cx| on_up(this, e.position, window, cx));
                }
            });
        },
    )
    .absolute()
    .size(px(0.0))
}

/// "2 min ago", "yesterday", "12 Oct".
pub fn ago(ms: f64) -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as f64)
        .unwrap_or(0.0);
    let s = ((now - ms) / 1000.0).max(0.0);
    if s < 45.0 {
        "just now".into()
    } else if s < 3600.0 {
        format!("{} min ago", (s / 60.0).round().max(1.0))
    } else if s < 86_400.0 {
        format!("{} h ago", (s / 3600.0).round())
    } else if s < 172_800.0 {
        "yesterday".into()
    } else {
        format!("{} days ago", (s / 86_400.0).floor())
    }
}

/// Avatar circle with initials (or an image when loaded).
pub fn avatar(
    initials: &str,
    color: Hsla,
    image: Option<std::sync::Arc<gpui::Image>>,
    size: f32,
    th: &Theme,
) -> Div {
    div()
        .size(px(size))
        .flex_none()
        .rounded(px(size))
        .overflow_hidden()
        .flex()
        .items_center()
        .justify_center()
        .bg(color)
        .border_2()
        .border_color(th.surface1)
        .font_family(SANS)
        .text_size(px(size * 0.4))
        .font_weight(gpui::FontWeight(600.0))
        .text_color(gpui::black())
        .map(|d| match image {
            Some(img) => d.child(gpui::img(img).size_full()),
            None => d.child(initials.to_string()),
        })
}

/// Icon for a layer type.
pub fn node_icon(t: desyn_core::model::NodeType) -> &'static str {
    use desyn_core::model::NodeType as T;
    match t {
        T::Root | T::Page => "icons/file.svg",
        T::Frame => "icons/frame.svg",
        T::Group => "icons/group.svg",
        T::Boolean => "icons/squares-unite.svg",
        T::Rect => "icons/square.svg",
        T::Ellipse => "icons/circle.svg",
        T::Polygon => "icons/pentagon.svg",
        T::Star => "icons/star.svg",
        T::Line => "icons/minus.svg",
        T::Path => "icons/spline.svg",
        T::Text => "icons/type.svg",
        T::Image => "icons/image.svg",
        T::Svg => "icons/shapes.svg",
        T::Video => "icons/film.svg",
        T::Audio => "icons/play.svg",
        T::Chart => "icons/chart-column.svg",
        T::Table => "icons/table.svg",
        T::Qr => "icons/qr-code.svg",
    }
}

/// Human name of a layer type.
pub fn node_kind_label(t: desyn_core::model::NodeType) -> &'static str {
    use desyn_core::model::NodeType as T;
    match t {
        T::Root => "Design",
        T::Page => "Page",
        T::Frame => "Frame",
        T::Group => "Group",
        T::Boolean => "Boolean",
        T::Rect => "Rectangle",
        T::Ellipse => "Ellipse",
        T::Polygon => "Polygon",
        T::Star => "Star",
        T::Line => "Line",
        T::Path => "Vector",
        T::Text => "Text",
        T::Image => "Image",
        T::Svg => "Graphic",
        T::Video => "Video",
        T::Audio => "Audio",
        T::Chart => "Chart",
        T::Table => "Table",
        T::Qr => "QR code",
    }
}

/// A dropdown-looking button (opens a menu on click).
pub fn select_button(
    id: impl Into<SharedString>,
    text: impl Into<SharedString>,
    th: &Theme,
) -> Stateful<Div> {
    let s3 = th.surface3;
    let bs = th.border;
    div()
        .id(gpui::ElementId::Name(id.into()))
        .h(px(28.0))
        .px(px(8.0))
        .flex()
        .items_center()
        .gap(px(6.0))
        .rounded(px(6.0))
        .bg(th.surface2)
        .border_1()
        .border_color(th.border_subtle)
        .cursor_pointer()
        .hover(move |s| s.bg(s3).border_color(bs))
        .child(
            div()
                .flex_1()
                .min_w(px(0.0))
                .truncate()
                .font_family(SANS)
                .text_size(px(12.0))
                .text_color(th.fg)
                .child(text.into()),
        )
        .child(icon("icons/chevron-down.svg", 12.0, th.faint))
}

/// A small square icon toggle (B / I / U, lock, visibility).
pub fn icon_toggle(
    id: impl Into<SharedString>,
    path: &'static str,
    on: bool,
    hint: &str,
    th: &Theme,
) -> Stateful<Div> {
    let s3 = th.surface3;
    div()
        .id(gpui::ElementId::Name(id.into()))
        .size(px(28.0))
        .flex_none()
        .flex()
        .items_center()
        .justify_center()
        .rounded(px(6.0))
        .cursor_pointer()
        .when(on, |d| d.bg(th.accent_soft))
        .when(!on, move |d| d.hover(move |s| s.bg(s3)))
        .tooltip(tip(hint.to_string(), None))
        .child(icon(path, 14.0, if on { th.accent_text } else { th.muted }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_web_links_from_remote_data_open() {
        assert!(is_web_url("https://unsplash.com/@someone"));
        assert!(is_web_url("http://example.com/notes"));
        assert!(!is_web_url("file:///etc/passwd"));
        assert!(!is_web_url("desyn://design/abc"));
        assert!(!is_web_url("javascript:alert(1)"));
        assert!(!is_web_url("smb://host/share"));
        assert!(!is_web_url("not a url"));
    }

    #[test]
    fn colors_and_times() {
        let c = hsla("#ffb02e");
        let rgb = c.to_rgb();
        assert!((rgb.r - 1.0).abs() < 0.01 && (rgb.b - 46.0 / 255.0).abs() < 0.01);
        assert_eq!(hsla("#00000080").a, 128.0 / 255.0);
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as f64;
        assert_eq!(ago(now), "just now");
        assert_eq!(ago(now - 5.0 * 60_000.0), "5 min ago");
        assert_eq!(ago(now - 100_000_000.0), "yesterday");
    }
}
