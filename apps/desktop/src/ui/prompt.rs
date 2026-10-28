//! In-window confirmation dialogs ("Save changes?", About) drawn in the Desyn style where the platform has no
//! native alert (Linux). macOS and Windows keep their native dialogs. Keyboard: Enter picks the highlighted
//! button (the first one, the primary action), Escape picks Cancel, Tab / arrows move the highlight.

use gpui::{
    App, AppContext, BoxShadow, Context, EventEmitter, FocusHandle, Focusable, InteractiveElement,
    IntoElement, KeyDownEvent, ParentElement, PromptButton, PromptHandle, PromptLevel,
    PromptResponse, Render, RenderablePromptHandle, StatefulInteractiveElement, Styled, Window,
    div, prelude::FluentBuilder, px,
};

use super::components::{Variant, button, icon, t};
use super::theme::{SANS, SERIF, alpha};

/// Installs the Desyn prompt renderer on platforms without native alerts.
pub fn install(cx: &mut App) {
    if cfg!(any(target_os = "macos", target_os = "windows")) {
        return;
    }
    cx.set_prompt_builder(build);
}

fn build(
    level: PromptLevel,
    message: &str,
    detail: Option<&str>,
    actions: &[PromptButton],
    handle: PromptHandle,
    window: &mut Window,
    cx: &mut App,
) -> RenderablePromptHandle {
    let view = cx.new(|cx| DesynPrompt {
        level,
        message: message.to_string(),
        detail: detail.map(str::to_string),
        actions: actions.to_vec(),
        highlighted: 0,
        focus: cx.focus_handle(),
    });
    handle.with_view(view, window, cx)
}

/// A modal confirmation.
pub struct DesynPrompt {
    level: PromptLevel,
    message: String,
    detail: Option<String>,
    actions: Vec<PromptButton>,
    highlighted: usize,
    focus: FocusHandle,
}

impl EventEmitter<PromptResponse> for DesynPrompt {}

impl Focusable for DesynPrompt {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

/// The answer Escape picks: the Cancel button, else the last one.
pub fn cancel_index(actions: &[PromptButton]) -> usize {
    actions
        .iter()
        .position(|a| a.is_cancel() || a.label().eq_ignore_ascii_case("cancel"))
        .unwrap_or(actions.len().saturating_sub(1))
}

impl DesynPrompt {
    fn on_key(&mut self, e: &KeyDownEvent, _: &mut Window, cx: &mut Context<Self>) {
        let n = self.actions.len().max(1);
        let k = &e.keystroke;
        match k.key.as_str() {
            "escape" => cx.emit(PromptResponse(cancel_index(&self.actions))),
            "enter" | "space" => cx.emit(PromptResponse(self.highlighted)),
            "tab" if k.modifiers.shift => self.highlighted = (self.highlighted + n - 1) % n,
            "tab" | "right" | "down" => self.highlighted = (self.highlighted + 1) % n,
            "left" | "up" => self.highlighted = (self.highlighted + n - 1) % n,
            _ => return,
        }
        cx.stop_propagation();
        cx.notify();
    }
}

impl Render for DesynPrompt {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let th = t(window, cx);
        let cancel = cancel_index(&self.actions);
        let (glyph, tint) = match self.level {
            PromptLevel::Critical => ("icons/circle-alert.svg", th.danger),
            PromptLevel::Warning => ("icons/circle-alert.svg", th.accent_text),
            _ => ("icons/sun.svg", th.accent_text),
        };
        // Primary on the right (reading order ends on the main action); Cancel alone on the left.
        let ring = alpha(th.accent, 0.55);
        let make = |ix: usize, cx: &mut Context<Self>| {
            let a = &self.actions[ix];
            let variant = if ix == cancel {
                Variant::Ghost
            } else if ix == 0 {
                Variant::Primary
            } else {
                Variant::Secondary
            };
            button(("prompt-button", ix), a.label().clone(), variant, &th)
                .when(ix == self.highlighted, move |b| {
                    b.shadow(vec![
                        BoxShadow::new(px(0.0), px(0.0), ring).spread_radius(px(2.0)),
                    ])
                })
                .on_click(cx.listener(move |_, _, _, cx| {
                    cx.stop_propagation();
                    cx.emit(PromptResponse(ix));
                }))
        };
        let others: Vec<_> = (0..self.actions.len())
            .rev()
            .filter(|&i| i != cancel || self.actions.len() == 1)
            .map(|i| make(i, cx))
            .collect();
        let cancel_button = (self.actions.len() > 1).then(|| make(cancel, cx));
        let card = div()
            .id("prompt-card")
            .w(px(440.0))
            .max_w_full()
            .flex()
            .flex_col()
            .gap(px(18.0))
            .p(px(24.0))
            .rounded(px(14.0))
            .bg(th.surface1)
            .border_1()
            .border_color(th.border_subtle)
            .shadow(vec![
                BoxShadow::new(
                    px(0.0),
                    px(24.0),
                    alpha(gpui::black(), if th.dark { 0.6 } else { 0.18 }),
                )
                .blur_radius(px(64.0)),
                BoxShadow::new(px(0.0), px(20.0), alpha(th.accent, 0.10))
                    .blur_radius(px(60.0))
                    .spread_radius(px(-40.0)),
            ])
            .on_mouse_down(gpui::MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .child(
                div()
                    .flex()
                    .gap(px(14.0))
                    .child(
                        div()
                            .size(px(36.0))
                            .flex_none()
                            .flex()
                            .items_center()
                            .justify_center()
                            .rounded_full()
                            .bg(alpha(tint, 0.14))
                            .child(icon(glyph, 18.0, tint)),
                    )
                    .child(
                        div()
                            .flex_1()
                            .min_w(px(0.0))
                            .flex()
                            .flex_col()
                            .gap(px(6.0))
                            .child(
                                div()
                                    .font_family(SERIF)
                                    .text_size(px(24.0))
                                    .line_height(px(28.0))
                                    .text_color(th.fg)
                                    .child(self.message.clone()),
                            )
                            .when_some(self.detail.clone(), |d, detail| {
                                d.child(
                                    div()
                                        .font_family(SANS)
                                        .text_size(px(13.0))
                                        .line_height(px(19.0))
                                        .text_color(th.muted)
                                        .child(detail),
                                )
                            }),
                    ),
            )
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(8.0))
                    .children(cancel_button)
                    .child(div().flex_1())
                    .children(others),
            );
        div()
            .id("prompt")
            .track_focus(&self.focus)
            .on_key_down(cx.listener(Self::on_key))
            .size_full()
            .absolute()
            .inset_0()
            .flex()
            .items_center()
            .justify_center()
            .p(px(16.0))
            .bg(alpha(gpui::black(), if th.dark { 0.5 } else { 0.22 }))
            .occlude()
            .child(card)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escape_picks_cancel() {
        let a: Vec<PromptButton> = ["Save", "Don't Save", "Cancel"]
            .into_iter()
            .map(PromptButton::from)
            .collect();
        assert_eq!(cancel_index(&a), 2);
        let b: Vec<PromptButton> = ["OK"].into_iter().map(PromptButton::from).collect();
        assert_eq!(cancel_index(&b), 0);
    }
}
