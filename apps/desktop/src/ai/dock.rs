//! The AI prompt bar (bottom-center, above the tool dock) and the conversation it expands into: the user's
//! prompts, the agent's messages, each tool step with its result, previews, plans, questions with quick answers,
//! and the final summary with the credits used. mod+J focuses it.

use gpui::{
    AnyElement, App, AppContext, BoxShadow, Context, Entity, FocusHandle, Focusable,
    InteractiveElement, IntoElement, ParentElement, Render, SharedString,
    StatefulInteractiveElement, Styled, Subscription, Window, div, img, prelude::FluentBuilder, px,
};

use super::run::{Entry, RunState, status_line, tool_label};
use super::{Blocked, EditorAi, Mode};
use crate::auth::Account;
use crate::cloud::{Cloud, images};
use crate::ui::actions;
use crate::ui::components::{Variant, button, icon, t, tip};
use crate::ui::editor::EditorView;
use crate::ui::ext::{Extensions, PanelSpec, Slot};
use crate::ui::text_field::{FieldEvent, TextField};
use crate::ui::theme::{MONO, SANS, SERIF, Theme, alpha};
use crate::widgets::{Seg, segmented, spinner};

/// Registers the dock and the shortcut.
pub fn install(cx: &mut App) {
    Extensions::update(cx, |x| {
        x.panel(PanelSpec::new(
            "ai-dock",
            "AI",
            "icons/message-square-text.svg",
            Slot::Dock,
            |editor, window, cx| {
                let e = editor.clone();
                cx.new(|cx| AiDock::new(e, window, cx)).into()
            },
        ));
        x.handle::<actions::OpenAiPrompt>(|editor, window, cx| {
            super::set_expanded(editor, true, cx);
            DOCKS.with(|d| {
                if let Some(dock) = d
                    .borrow()
                    .get(&editor.entity_id())
                    .and_then(|w| w.upgrade())
                {
                    dock.update(cx, |dock, cx| dock.focus_prompt(window, cx));
                }
            });
        });
    });
}

thread_local! {
    static DOCKS: std::cell::RefCell<std::collections::HashMap<gpui::EntityId, gpui::WeakEntity<AiDock>>> =
        std::cell::RefCell::new(std::collections::HashMap::new());
}

/// Renders a conversation.
pub fn conversation(
    runs: &[RunState],
    th: &Theme,
    viewer: gpui::EntityId,
    editor: &Entity<EditorView>,
    cx: &mut App,
) -> gpui::Div {
    let mut col = div().flex().flex_col().gap(px(10.0));
    for (ri, run) in runs.iter().enumerate() {
        let last = ri + 1 == runs.len();
        for (ei, e) in run.entries.iter().enumerate() {
            let id = SharedString::from(format!("ai-{ri}-{ei}"));
            let el: AnyElement = match e {
                Entry::User(text) => div()
                    .flex()
                    .justify_end()
                    .child(
                        div()
                            .max_w(px(420.0))
                            .px(px(12.0))
                            .py(px(8.0))
                            .rounded(px(12.0))
                            .bg(th.accent_soft)
                            .border_1()
                            .border_color(alpha(th.accent, 0.25))
                            .font_family(SANS)
                            .text_size(px(13.0))
                            .line_height(px(19.0))
                            .text_color(th.fg)
                            .child(text.clone()),
                    )
                    .into_any_element(),
                Entry::Agent(text) => div()
                    .flex()
                    .gap(px(9.0))
                    .child(
                        div()
                            .pt(px(3.0))
                            .child(crate::ui::components::sun_mark(12.0, th)),
                    )
                    .child(
                        div()
                            .flex_1()
                            .font_family(SANS)
                            .text_size(px(13.0))
                            .line_height(px(19.5))
                            .text_color(th.fg)
                            .child(text.trim().to_string()),
                    )
                    .into_any_element(),
                Entry::Tool {
                    tool,
                    done,
                    ok,
                    summary,
                    ..
                } => {
                    let running = !*done && last && run.is_active();
                    div()
                        .pl(px(21.0))
                        .flex()
                        .items_center()
                        .gap(px(8.0))
                        .child(if running {
                            spinner(format!("tool-{ri}-{ei}"), 8.0, th)
                        } else {
                            icon(
                                if *ok {
                                    "icons/check.svg"
                                } else {
                                    "icons/circle-alert.svg"
                                },
                                12.0,
                                if *ok { th.success } else { th.danger },
                            )
                            .into_any_element()
                        })
                        .child(
                            div()
                                .font_family(SANS)
                                .text_size(px(12.0))
                                .text_color(th.muted)
                                .child(tool_label(tool)),
                        )
                        .when(!summary.is_empty(), |d| {
                            d.child(
                                div()
                                    .flex_1()
                                    .min_w(px(0.0))
                                    .truncate()
                                    .font_family(SANS)
                                    .text_size(px(12.0))
                                    .text_color(th.faint)
                                    .child(summary.clone()),
                            )
                        })
                        .into_any_element()
                }
                Entry::Preview { url, width, height } => {
                    let im = images::image(url, viewer, cx);
                    let w = 220.0f32;
                    let h = (w as f64 * height / width.max(1.0)).clamp(40.0, 320.0) as f32;
                    div()
                        .pl(px(21.0))
                        .child(
                            div()
                                .w(px(w))
                                .h(px(h))
                                .rounded(px(10.0))
                                .overflow_hidden()
                                .bg(th.surface2)
                                .border_1()
                                .border_color(th.border_subtle)
                                .children(im.map(|i| img(i).size_full())),
                        )
                        .into_any_element()
                }
                Entry::Plan(steps) => div()
                    .ml(px(21.0))
                    .p(px(10.0))
                    .flex()
                    .flex_col()
                    .gap(px(5.0))
                    .rounded(px(10.0))
                    .bg(th.surface2)
                    .border_1()
                    .border_color(th.border_subtle)
                    .child(crate::ui::components::label("Plan", th))
                    .children(steps.iter().map(|(title, status)| {
                        let done = status == "done" || status == "completed";
                        div()
                            .flex()
                            .gap(px(8.0))
                            .items_center()
                            .child(icon(
                                if done {
                                    "icons/circle-check-big.svg"
                                } else {
                                    "icons/circle.svg"
                                },
                                12.0,
                                if done { th.success } else { th.faint },
                            ))
                            .child(
                                div()
                                    .font_family(SANS)
                                    .text_size(px(12.0))
                                    .text_color(if done { th.muted } else { th.fg })
                                    .child(title.clone()),
                            )
                    }))
                    .into_any_element(),
                Entry::Question { question, options } => {
                    let waiting = last && run.status == "needs-input";
                    div()
                        .ml(px(21.0))
                        .p(px(12.0))
                        .flex()
                        .flex_col()
                        .gap(px(8.0))
                        .rounded(px(10.0))
                        .border_1()
                        .border_color(alpha(th.accent, 0.4))
                        .bg(th.accent_soft)
                        .child(
                            div()
                                .font_family(SANS)
                                .text_size(px(13.0))
                                .text_color(th.fg)
                                .child(question.clone()),
                        )
                        .when(waiting && !options.is_empty(), |d| {
                            d.child(div().flex().flex_wrap().gap(px(6.0)).children(
                                options.iter().enumerate().map(|(oi, o)| {
                                    let ed = editor.clone();
                                    let answer = o.clone();
                                    button(
                                        SharedString::from(format!("ai-opt-{ri}-{ei}-{oi}")),
                                        o.clone(),
                                        Variant::Secondary,
                                        th,
                                    )
                                    .h(px(28.0))
                                    .on_click(
                                        move |_, _, cx| super::answer(&ed, answer.clone(), cx),
                                    )
                                }),
                            ))
                        })
                        .into_any_element()
                }
                Entry::Progress(text) => div()
                    .pl(px(21.0))
                    .font_family(SANS)
                    .text_size(px(12.0))
                    .text_color(th.faint)
                    .child(text.clone())
                    .into_any_element(),
                Entry::Error(text) => div()
                    .pl(px(21.0))
                    .flex()
                    .gap(px(8.0))
                    .child(icon("icons/circle-alert.svg", 12.0, th.danger))
                    .child(
                        div()
                            .font_family(SANS)
                            .text_size(px(12.0))
                            .text_color(th.danger)
                            .child(text.clone()),
                    )
                    .into_any_element(),
                Entry::Done {
                    status,
                    summary,
                    credits,
                } => {
                    let line = status_line(status);
                    div()
                        .pl(px(21.0))
                        .flex()
                        .flex_col()
                        .gap(px(4.0))
                        .when(!summary.trim().is_empty(), |d| {
                            d.child(
                                div()
                                    .font_family(SANS)
                                    .text_size(px(13.0))
                                    .line_height(px(19.0))
                                    .text_color(th.fg)
                                    .child(summary.trim().to_string()),
                            )
                        })
                        .child(
                            div()
                                .flex()
                                .gap(px(8.0))
                                .font_family(MONO)
                                .text_size(px(10.5))
                                .text_color(th.faint)
                                .child(line.to_string())
                                .when(*credits > 0.0, |d| {
                                    d.child(format!(
                                        "· {} credits",
                                        crate::widgets::number::format(*credits, 1)
                                    ))
                                }),
                        )
                        .into_any_element()
                }
            };
            col = col.child(div().id(id).child(el));
        }
    }
    col
}

/// The dock view.
pub struct AiDock {
    editor: Entity<EditorView>,
    prompt: Entity<TextField>,
    mode: Mode,
    focus: FocusHandle,
    _subs: Vec<Subscription>,
}

impl Focusable for AiDock {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl AiDock {
    fn new(editor: Entity<EditorView>, window: &mut Window, cx: &mut Context<Self>) -> AiDock {
        let prompt = cx.new(|cx| {
            let mut f = TextField::new("Ask Desyn to design or change anything…", cx);
            f.font_size = 14.0;
            f
        });
        let subs = vec![
            cx.subscribe_in(
                &prompt,
                window,
                |this, _, e: &FieldEvent, window, cx| match e {
                    FieldEvent::Confirm => this.send(cx),
                    FieldEvent::Cancel => {
                        super::set_expanded(&this.editor, false, cx);
                        let f = this.editor.read(cx).focus.clone();
                        window.focus(&f, cx);
                    }
                    _ => {}
                },
            ),
            cx.observe_global::<super::AiState>(|_, cx| cx.notify()),
            cx.observe_global::<Account>(|_, cx| cx.notify()),
        ];
        let me = cx.entity().downgrade();
        DOCKS.with(|d| d.borrow_mut().insert(editor.entity_id(), me));
        AiDock {
            editor,
            prompt,
            mode: Mode::Edit,
            focus: cx.focus_handle(),
            _subs: subs,
        }
    }

    fn focus_prompt(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let f = self.prompt.focus_handle(cx);
        window.focus(&f, cx);
        cx.notify();
    }

    fn send(&mut self, cx: &mut Context<Self>) {
        let text = self.prompt.read(cx).text().trim().to_string();
        if text.is_empty() {
            return;
        }
        let waiting = super::with(&self.editor, cx, |ai| {
            ai.current().is_some_and(|r| r.status == "needs-input")
        })
        .unwrap_or(false);
        if waiting {
            super::answer(&self.editor, text, cx);
        } else {
            if super::with(&self.editor, cx, EditorAi::busy).unwrap_or(false) {
                return;
            }
            super::start(&self.editor, text, self.mode, cx);
        }
        self.prompt.update(cx, |f, cx| f.set_text("", cx));
    }

    fn blocked_bar(&self, b: Blocked, th: &Theme, cx: &mut Context<Self>) -> Option<AnyElement> {
        let app = Cloud::try_get(cx)
            .map(|c| c.endpoints().app_url.clone())
            .unwrap_or_default();
        let (text, primary): (&str, AnyElement) = match b {
            Blocked::SignedOut => (
                "Sign in to use the design agent, or set up a local model in the web app.",
                button("ai-signin", "Sign in", Variant::Primary, th)
                    .h(px(30.0))
                    .on_click(|_, _, cx| Account::start_sign_in(cx))
                    .into_any_element(),
            ),
            Blocked::Plan => {
                let u = format!("{app}/settings/billing");
                (
                    "The design agent is part of Desyn Pro.",
                    button("ai-plans", "See plans", Variant::Primary, th)
                        .h(px(30.0))
                        .on_click(move |_, _, cx| cx.open_url(&u))
                        .into_any_element(),
                )
            }
            Blocked::ViewOnly => (
                "You can view this design but not edit it, so the AI cannot change it.",
                div().into_any_element(),
            ),
            // Local designs can still prompt: they are uploaded first.
            Blocked::LocalDesign => return None,
        };
        let settings = format!("{app}/settings/ai");
        Some(
            div()
                .flex()
                .items_center()
                .gap(px(10.0))
                .child(
                    // Wraps (min width 0) so the buttons stay inside the bar at any window width.
                    div()
                        .flex_1()
                        .min_w_0()
                        .font_family(SANS)
                        .text_size(px(12.5))
                        .line_height(px(17.0))
                        .text_color(th.muted)
                        .child(text),
                )
                .when(b == Blocked::SignedOut, |d| {
                    d.child(
                        button("ai-local", "Local models", Variant::Ghost, th)
                            .h(px(30.0))
                            .on_click(move |_, _, cx| cx.open_url(&settings)),
                    )
                })
                .child(primary)
                .into_any_element(),
        )
    }
}

impl Render for AiDock {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let th = t(window, cx);
        let ed = self.editor.clone();
        let blocked = super::blocked_reason(&ed, cx);
        let (runs, expanded, busy, starting, error) = super::with(&ed, cx, |ai| {
            (
                ai.runs.clone(),
                ai.expanded,
                ai.busy(),
                ai.starting,
                ai.error.clone(),
            )
        })
        .unwrap_or((Vec::new(), false, false, false, None));
        let current = runs.last().cloned();
        let waiting = current.as_ref().is_some_and(|r| r.status == "needs-input");
        let me = cx.entity().entity_id();
        let status_text = if starting {
            Some("Starting…".to_string())
        } else if let Some(r) = current.as_ref().filter(|r| r.is_active()) {
            r.entries
                .iter()
                .rev()
                .find_map(|e| match e {
                    Entry::Tool {
                        tool, done: false, ..
                    } => Some(tool_label(tool)),
                    _ => None,
                })
                .or_else(|| {
                    Some(if r.status == "queued" {
                        "Queued…".into()
                    } else {
                        "Thinking…".into()
                    })
                })
        } else {
            None
        };
        let glass = th.glass;
        let shadow = vec![
            BoxShadow::new(
                px(0.0),
                px(16.0),
                alpha(gpui::black(), if th.dark { 0.45 } else { 0.14 }),
            )
            .blur_radius(px(40.0)),
            BoxShadow::new(
                px(0.0),
                px(0.0),
                alpha(th.accent, if busy { 0.28 } else { 0.0 }),
            )
            .blur_radius(px(28.0)),
        ];
        let panel = (expanded && !runs.is_empty()).then(|| {
            let ed2 = ed.clone();
            let ed3 = ed.clone();
            div()
                .id("ai-conversation")
                .w_full()
                .max_w(px(600.0))
                .max_h(px(420.0))
                .flex()
                .flex_col()
                .rounded(px(16.0))
                .bg(glass)
                .border_1()
                .border_color(th.border_subtle)
                .shadow(shadow.clone())
                .occlude()
                .child(
                    div()
                        .flex_none()
                        .px(px(16.0))
                        .py(px(10.0))
                        .flex()
                        .items_center()
                        .gap(px(8.0))
                        .border_b_1()
                        .border_color(th.border_subtle)
                        .child(
                            div()
                                .font_family(SERIF)
                                .text_size(px(18.0))
                                .text_color(th.fg)
                                .child("desyn"),
                        )
                        .child(
                            div()
                                .font_family(SERIF)
                                .italic()
                                .text_size(px(18.0))
                                .text_color(th.accent_text)
                                .child("ai"),
                        )
                        .child(div().flex_1())
                        .when_some(current.as_ref().and_then(|r| r.model.clone()), |d, m| {
                            d.child(
                                div()
                                    .font_family(MONO)
                                    .text_size(px(10.5))
                                    .text_color(th.faint)
                                    .child(m.split(':').next_back().unwrap_or(&m).to_string()),
                            )
                        })
                        .child(
                            crate::ui::components::icon_button(
                                "ai-new",
                                "icons/message-square-plus.svg",
                                28.0,
                                false,
                                &th,
                            )
                            .tooltip(tip("New conversation", None))
                            .on_click(move |_, _, cx| super::new_chat(&ed2, cx)),
                        )
                        .child(
                            crate::ui::components::icon_button(
                                "ai-collapse",
                                "icons/chevron-down.svg",
                                28.0,
                                false,
                                &th,
                            )
                            .tooltip(tip("Hide", None))
                            .on_click(move |_, _, cx| super::set_expanded(&ed3, false, cx)),
                        ),
                )
                .child(
                    div()
                        .id("ai-conversation-body")
                        .flex_1()
                        .min_h(px(0.0))
                        .overflow_y_scroll()
                        .px(px(16.0))
                        .py(px(12.0))
                        .child(conversation(&runs, &th, me, &ed, cx)),
                )
        });
        let bar: AnyElement = match blocked.and_then(|b| self.blocked_bar(b, &th, cx)) {
            Some(bar) => bar,
            None => {
                let ed4 = ed.clone();
                let ed5 = ed.clone();
                let me2 = cx.entity().downgrade();
                let mode_el = segmented(
                    "ai-mode",
                    vec![
                        (Mode::Edit, Seg::Text("Edit".into())),
                        (Mode::Generate, Seg::Text("Create".into())),
                        (Mode::Critique, Seg::Text("Review".into())),
                    ],
                    Some(&self.mode),
                    &th,
                    move |m, _, cx| {
                        let _ = me2.update(cx, |this, cx| {
                            this.mode = m;
                            cx.notify();
                        });
                    },
                )
                .w(px(190.0))
                .flex_none();
                let action: AnyElement = if busy && !waiting {
                    div()
                        .id("ai-stop")
                        .size(px(34.0))
                        .flex_none()
                        .flex()
                        .items_center()
                        .justify_center()
                        .rounded(px(17.0))
                        .bg(th.surface3)
                        .cursor_pointer()
                        .tooltip(tip("Stop", None))
                        .child(icon("icons/circle-stop.svg", 16.0, th.fg))
                        .on_click(move |_, _, cx| super::cancel(&ed4, cx))
                        .into_any_element()
                } else {
                    div()
                        .id("ai-send")
                        .size(px(34.0))
                        .flex_none()
                        .flex()
                        .items_center()
                        .justify_center()
                        .rounded(px(17.0))
                        .bg(gpui::linear_gradient(
                            135.0,
                            gpui::linear_color_stop(th.sun_hi, 0.0),
                            gpui::linear_color_stop(th.sun_lo, 1.0),
                        ))
                        .cursor_pointer()
                        .tooltip(tip(
                            if waiting { "Answer" } else { "Send" },
                            Some("enter".into()),
                        ))
                        .child(icon("icons/arrow-up.svg", 16.0, gpui::black()))
                        .on_click(cx.listener(|this, _, _, cx| this.send(cx)))
                        .into_any_element()
                };
                div()
                    .flex()
                    .flex_col()
                    .gap(px(6.0))
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(10.0))
                            .child(
                                div()
                                    .id("ai-toggle")
                                    .cursor_pointer()
                                    .tooltip(tip(if expanded { "Hide the conversation" } else { "Show the conversation" }, Some(crate::ui::actions::shortcut_label("secondary-j"))))
                                    .child(icon("icons/message-square-text.svg", 17.0, th.accent_text))
                                    .on_click(move |_, _, cx| {
                                        let open = super::with(&ed5, cx, |ai| ai.expanded).unwrap_or(false);
                                        super::set_expanded(&ed5, !open, cx)
                                    }),
                            )
                            .child(div().flex_1().min_w(px(0.0)).child(self.prompt.clone()))
                            .when(!busy, |d| d.child(mode_el))
                            .child(action),
                    )
                    .when_some(status_text.clone().filter(|_| busy), |d, s| {
                        d.child(
                            div()
                                .pl(px(27.0))
                                .flex()
                                .items_center()
                                .gap(px(8.0))
                                .child(spinner("ai-status", 8.0, &th))
                                .child(div().font_family(SANS).text_size(px(11.5)).text_color(th.muted).child(s)),
                        )
                    })
                    .when(waiting, |d| {
                        d.child(div().pl(px(27.0)).font_family(SANS).text_size(px(11.5)).text_color(th.accent_text).child("The agent asked a question. Type your answer or pick an option above."))
                    })
                    .when(blocked == Some(Blocked::LocalDesign), |d| {
                        d.child(div().pl(px(27.0)).font_family(SANS).text_size(px(11.0)).text_color(th.faint).child("The agent runs in your Desyn cloud: this design will be uploaded to your account first."))
                    })
                    .when_some(error.clone(), |d, e| {
                        d.child(div().pl(px(27.0)).font_family(SANS).text_size(px(11.5)).text_color(th.danger).child(e))
                    })
                    .into_any_element()
            }
        };
        // As wide as the canvas allows (600 px at most), with a gutter so it never touches the side panels.
        div()
            .id("ai-dock")
            .track_focus(&self.focus)
            .w_full()
            .px(px(16.0))
            .flex()
            .flex_col()
            .items_center()
            .gap(px(10.0))
            .children(panel)
            .child(
                div()
                    .id("ai-bar")
                    .w_full()
                    .max_w(px(600.0))
                    .px(px(14.0))
                    .py(px(10.0))
                    .rounded(px(18.0))
                    .bg(glass)
                    .border_1()
                    .border_color(if busy {
                        alpha(th.accent, 0.45)
                    } else {
                        th.border_subtle
                    })
                    .shadow(shadow)
                    .occlude()
                    .child(bar),
            )
    }
}

/// Quick prompts offered in the AI panel.
pub const SUGGESTIONS: &[&str] = &[
    "Make it feel more premium",
    "Fix alignment and spacing",
    "Write a punchier headline",
    "Check contrast and readability",
    "Generate a background image that fits",
    "Make a version for Instagram stories",
];

impl Drop for AiDock {
    fn drop(&mut self) {
        let id = self.editor.entity_id();
        DOCKS.with(|d| {
            d.borrow_mut().remove(&id);
        });
    }
}
