//! Small building blocks shared by every view: icons, buttons, keyboard hints, tooltips, pills and dividers
//! (DESIGN_SYSTEM.md §5).

use gpui::{
    AnyView, App, AppContext, BoxShadow, Div, ElementId, Hsla, InteractiveElement, IntoElement,
    ParentElement, Render, SharedString, Styled, Svg, Window, div, prelude::FluentBuilder, px, svg,
};

use super::theme::{MONO, SANS, SERIF, Theme, alpha, theme};

/// An icon (Lucide, 1.5 px stroke) tinted with `color`.
pub fn icon(path: impl Into<SharedString>, size: f32, color: Hsla) -> Svg {
    svg()
        .path(path.into())
        .size(px(size))
        .flex_none()
        .text_color(color)
}

/// Theme for the window.
pub fn t(window: &Window, cx: &App) -> Theme {
    theme(cx, window.appearance())
}

/// A tooltip with an optional shortcut (shown after the platform delay).
pub struct Tip {
    text: SharedString,
    keys: Option<SharedString>,
}

impl Render for Tip {
    fn render(&mut self, window: &mut Window, cx: &mut gpui::Context<Self>) -> impl IntoElement {
        let th = t(window, cx);
        div()
            .font_family(SANS)
            .text_size(px(12.0))
            .px(px(8.0))
            .py(px(5.0))
            .rounded(px(6.0))
            .bg(th.surface2)
            .border_1()
            .border_color(th.border_subtle)
            .text_color(th.fg)
            .shadow(vec![
                BoxShadow::new(px(0.0), px(8.0), alpha(gpui::black(), 0.35)).blur_radius(px(24.0)),
            ])
            .flex()
            .items_center()
            .gap(px(8.0))
            .child(self.text.clone())
            .when_some(self.keys.clone(), |d, k| d.child(kbd(k, &th)))
    }
}

/// Tooltip builder for `.tooltip(...)`.
pub fn tip(
    text: impl Into<SharedString>,
    keys: Option<String>,
) -> impl Fn(&mut Window, &mut App) -> AnyView + 'static {
    let text = text.into();
    let keys: Option<SharedString> = keys.map(Into::into);
    move |_window, cx| {
        cx.new(|_| Tip {
            text: text.clone(),
            keys: keys.clone(),
        })
        .into()
    }
}

/// Keyboard hint chip.
pub fn kbd(text: impl Into<SharedString>, th: &Theme) -> Div {
    div()
        .font_family(MONO)
        .text_size(px(10.5))
        .px(px(5.0))
        .py(px(1.0))
        .rounded(px(4.0))
        .border_1()
        .border_color(th.border_subtle)
        .bg(alpha(th.fg, 0.04))
        .text_color(th.muted)
        .child(text.into())
}

/// Square icon button (28 / 32 / 36 px). `active` shows the sun-tinted selected state.
pub fn icon_button(
    id: impl Into<ElementId>,
    icon_path: &'static str,
    size: f32,
    active: bool,
    th: &Theme,
) -> gpui::Stateful<Div> {
    let fg = if active { th.accent_text } else { th.muted };
    let hover_bg = th.surface3;
    let hover_fg = th.fg;
    div()
        .id(id)
        .flex()
        .flex_none()
        .items_center()
        .justify_center()
        .size(px(size))
        .rounded(px(8.0))
        .cursor_pointer()
        .when(active, |d| d.bg(th.accent_soft))
        .when(!active, move |d| {
            d.hover(move |s| s.bg(hover_bg).text_color(hover_fg))
        })
        .text_color(fg)
        .child(icon(icon_path, (size * 0.5).round(), fg))
}

/// Button styles.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Variant {
    /// Sun fill, near-black text, glow on hover.
    Primary,
    /// Surface-2 with a border.
    Secondary,
    /// Text only.
    Ghost,
    /// Destructive.
    Danger,
}

/// A labelled button.
pub fn button(
    id: impl Into<ElementId>,
    label: impl Into<SharedString>,
    variant: Variant,
    th: &Theme,
) -> gpui::Stateful<Div> {
    let base = div()
        .id(id)
        .flex()
        .flex_none()
        .items_center()
        .justify_center()
        .gap(px(6.0))
        .h(px(32.0))
        .px(px(14.0))
        .rounded(px(8.0))
        .font_family(SANS)
        .text_size(px(13.0))
        .font_weight(gpui::FontWeight(550.0))
        .cursor_pointer();
    let glow = th.accent_glow;
    let s3 = th.surface3;
    let bs = th.border_strong;
    match variant {
        Variant::Primary => base
            .bg(th.accent_solid)
            .text_color(th.accent_ink)
            .hover(move |s| {
                s.shadow(vec![
                    BoxShadow::new(px(0.0), px(0.0), glow).blur_radius(px(18.0)),
                ])
            }),
        Variant::Secondary => base
            .bg(th.surface2)
            .border_1()
            .border_color(th.border)
            .text_color(th.fg)
            .hover(move |s| s.border_color(bs).bg(s3)),
        Variant::Ghost => base.text_color(th.muted).hover(move |s| s.bg(s3)),
        Variant::Danger => base.bg(th.danger).text_color(gpui::white()),
    }
    .child(label.into())
}

/// Thin separator.
pub fn divider(th: &Theme, vertical: bool) -> Div {
    let d = div().flex_none().bg(th.border_subtle);
    if vertical {
        d.w(px(1.0)).h(px(18.0))
    } else {
        d.h(px(1.0)).w_full()
    }
}

/// Serif heading (Instrument Serif, single weight: hierarchy from size and italics).
pub fn serif(text: impl Into<SharedString>, size: f32, color: Hsla) -> Div {
    div()
        .font_family(SERIF)
        .text_size(px(size))
        .line_height(px(size * 1.12))
        .text_color(color)
        .child(text.into())
}

/// Small muted group label (sentence case, normal tracking, at the dense app size).
pub fn label(text: &str, th: &Theme) -> Div {
    div()
        .font_family(SANS)
        .text_size(px(11.5))
        .font_weight(gpui::FontWeight(600.0))
        .text_color(th.faint)
        .child(text.to_string())
}

/// Small pill ("Pro", counts).
pub fn pill(text: impl Into<SharedString>, th: &Theme) -> Div {
    div()
        .font_family(SANS)
        .text_size(px(11.0))
        .px(px(8.0))
        .py(px(2.0))
        .rounded(px(999.0))
        .bg(th.accent_soft)
        .text_color(th.accent_text)
        .child(text.into())
}

/// The Desyn mark: two print crop corners around the sun, on the same 48-unit grid as the SVG
/// (`M6 17V6h11M31 42h11V31`, 2.5 stroke with square caps, sun r 8.5). Strokes never drop below
/// 1 px so the corners survive at status-bar sizes.
pub fn sun_mark(size: f32, th: &Theme) -> Div {
    let u = size / 48.0;
    let stroke = (2.5 * u).max(1.0);
    let edge = 6.0 * u - stroke / 2.0;
    let arm = 11.0 * u + stroke;
    div()
        .relative()
        .size(px(size))
        .flex_none()
        .child(
            div()
                .absolute()
                .left(px(edge))
                .top(px(edge))
                .size(px(arm))
                .border_t(px(stroke))
                .border_l(px(stroke))
                .border_color(th.fg),
        )
        .child(
            div()
                .absolute()
                .right(px(edge))
                .bottom(px(edge))
                .size(px(arm))
                .border_b(px(stroke))
                .border_r(px(stroke))
                .border_color(th.fg),
        )
        .child(
            div()
                .absolute()
                .left(px(15.5 * u))
                .top(px(15.5 * u))
                .size(px(17.0 * u))
                .rounded(px(size))
                .bg(th.accent),
        )
}

/// The wordmark: lowercase "desyn" in Instrument Serif next to the sun.
pub fn wordmark(size: f32, th: &Theme) -> Div {
    div()
        .flex()
        .items_center()
        .gap(px(size * 0.35))
        .child(sun_mark(size * 0.9, th))
        .child(
            div()
                .font_family(SERIF)
                .text_size(px(size))
                .text_color(th.fg)
                .child("desyn"),
        )
}
