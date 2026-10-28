//! The AI panel in the left rail: the conversation with the design agent, suggested prompts, a prompt box, and the
//! recent runs on this design (from every collaborator), each with its goal, status and cost.

use gpui::{
    App, AppContext, Context, Entity, FocusHandle, Focusable, InteractiveElement, IntoElement,
    ParentElement, Render, SharedString, StatefulInteractiveElement, Styled, Subscription, Window,
    div, prelude::FluentBuilder, px,
};
use serde_json::json;

use super::dock::{SUGGESTIONS, conversation};
use super::{Blocked, Mode};
use crate::auth::Account;
use crate::cloud::Cloud;
use crate::cloud::api::{self, Run, f};
use crate::panels::{body, frame};
use crate::ui::components::{Variant, button, t};
use crate::ui::editor::EditorView;
use crate::ui::ext::{Extensions, PanelSpec, Slot};
use crate::ui::text_field::{FieldEvent, TextField};
use crate::ui::theme::{MONO, SANS, alpha};
use crate::widgets::{ago, empty, input_box, section};

/// Registers the panel.
pub fn install(cx: &mut App) {
    Extensions::update(cx, |x| {
        x.panel(
            PanelSpec::new(
                "ai",
                "AI",
                "icons/message-square-text.svg",
                Slot::Left,
                |editor, window, cx| {
                    let e = editor.clone();
                    cx.new(|cx| AiPanel::new(e, window, cx)).into()
                },
            )
            .order(70),
        );
    });
}

/// The panel.
pub struct AiPanel {
    editor: Entity<EditorView>,
    prompt: Entity<TextField>,
    history: Vec<Run>,
    loaded_for: Option<String>,
    focus: FocusHandle,
    _subs: Vec<Subscription>,
}

impl Focusable for AiPanel {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl AiPanel {
    fn new(editor: Entity<EditorView>, window: &mut Window, cx: &mut Context<Self>) -> AiPanel {
        let prompt = cx.new(|cx| {
            let mut f = TextField::new("Describe what to create or change…", cx);
            f.font_size = 13.0;
            f
        });
        let subs = vec![
            cx.subscribe_in(&prompt, window, |this, f, e: &FieldEvent, _, cx| {
                if *e == FieldEvent::Confirm {
                    let text = f.read(cx).text().to_string();
                    this.send(text, cx);
                }
            }),
            cx.observe_global::<super::AiState>(|this, cx| {
                this.load_history(cx);
                cx.notify();
            }),
            cx.observe_global::<Account>(|_, cx| cx.notify()),
        ];
        let mut p = AiPanel {
            editor,
            prompt,
            history: Vec::new(),
            loaded_for: None,
            focus: cx.focus_handle(),
            _subs: subs,
        };
        p.load_history(cx);
        p
    }

    fn send(&mut self, text: String, cx: &mut Context<Self>) {
        if text.trim().is_empty() {
            return;
        }
        let waiting = super::with(&self.editor, cx, |ai| {
            ai.current().is_some_and(|r| r.status == "needs-input")
        })
        .unwrap_or(false);
        if waiting {
            super::answer(&self.editor, text, cx);
        } else if !super::with(&self.editor, cx, super::EditorAi::busy).unwrap_or(false) {
            super::start(&self.editor, text, Mode::Edit, cx);
        }
        self.prompt.update(cx, |f, cx| f.set_text("", cx));
    }

    fn load_history(&mut self, cx: &mut Context<Self>) {
        let Some(design) = crate::sync::design_id(&self.editor, cx) else {
            return;
        };
        let runs_now = super::with(&self.editor, cx, |ai| ai.runs.len()).unwrap_or(0);
        let key = format!("{design}:{runs_now}");
        if self.loaded_for.as_deref() == Some(key.as_str()) || !Account::signed_in(cx) {
            return;
        }
        self.loaded_for = Some(key);
        let q = Cloud::get(cx).query(f::AI_RUNS, json!({ "designId": design, "limit": 12 }));
        cx.spawn(async move |this, cx| {
            if let Ok(runs) = q.await.and_then(api::decode::<Vec<Run>>) {
                let _ = this.update(cx, |this, cx| {
                    this.history = runs;
                    cx.notify();
                });
            }
        })
        .detach();
    }
}

impl Render for AiPanel {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let th = t(window, cx);
        let ed = self.editor.clone();
        let blocked = super::blocked_reason(&ed, cx);
        let runs = super::with(&ed, cx, |ai| ai.runs.clone()).unwrap_or_default();
        let app = Cloud::try_get(cx)
            .map(|c| c.endpoints().app_url.clone())
            .unwrap_or_default();
        let content: gpui::AnyElement = match blocked {
            Some(Blocked::SignedOut) => {
                let settings = format!("{app}/settings/ai");
                empty(
                    "design with words",
                    "Sign in to run the Desyn design agent. Prefer your own keys or a local model (Ollama, LM Studio)? Set them up in the web app; they stay in your browser.",
                    Some(
                        div()
                            .flex()
                            .flex_col()
                            .gap(px(8.0))
                            .child(button("aip-signin", "Sign in", Variant::Primary, &th).w_full().on_click(|_, _, cx| Account::start_sign_in(cx)))
                            .child(button("aip-local", "Local models in the web app", Variant::Ghost, &th).w_full().on_click(move |_, _, cx| cx.open_url(&settings)))
                            .into_any_element(),
                    ),
                    &th,
                )
                .into_any_element()
            }
            Some(Blocked::Plan) => {
                let u = format!("{app}/settings/billing");
                empty(
                    "the agent is pro",
                    "Generate full designs, restyle with a sentence and fix layouts with Desyn Pro.",
                    Some(button("aip-plans", "See plans", Variant::Primary, &th).on_click(move |_, _, cx| cx.open_url(&u)).into_any_element()),
                    &th,
                )
                .into_any_element()
            }
            _ => {
                let me = cx.entity().entity_id();
                let chips = div().flex().flex_col().gap(px(6.0)).children(
                    SUGGESTIONS.iter().enumerate().map(|(i, s)| {
                        let s3 = th.surface3;
                        let text = s.to_string();
                        div()
                            .id(("ai-suggest", i))
                            .px(px(12.0))
                            .py(px(8.0))
                            .flex()
                            .items_center()
                            .gap(px(8.0))
                            .rounded(px(9.0))
                            .bg(th.surface2)
                            .border_1()
                            .border_color(th.border_subtle)
                            .cursor_pointer()
                            .hover(move |st| st.bg(s3))
                            .child(
                                div()
                                    .font_family(SANS)
                                    .text_size(px(12.5))
                                    .text_color(th.fg)
                                    .child(text.clone()),
                            )
                            .on_click(
                                cx.listener(move |this, _, _, cx| this.send(text.clone(), cx)),
                            )
                    }),
                );
                let history = self.history.clone();
                div()
                    .flex()
                    .flex_col()
                    .gap(px(14.0))
                    .child(input_box(self.prompt.clone(), &th).h(px(38.0)))
                    .when(blocked == Some(Blocked::LocalDesign), |d| {
                        d.child(div().font_family(SANS).text_size(px(11.5)).text_color(th.faint).child("This local design is uploaded to your Desyn cloud when you start the agent."))
                    })
                    .when(blocked == Some(Blocked::ViewOnly), |d| {
                        d.child(div().font_family(SANS).text_size(px(11.5)).text_color(th.faint).child("View only: the agent cannot edit this design."))
                    })
                    .child(if runs.is_empty() {
                        div().flex().flex_col().gap(px(8.0)).child(section("Try", None, &th)).child(chips).into_any_element()
                    } else {
                        div().flex().flex_col().gap(px(8.0)).child(section("Conversation", None, &th)).child(conversation(&runs, &th, me, &ed, cx)).into_any_element()
                    })
                    .when(!history.is_empty(), |d| {
                        d.child(div().flex().flex_col().gap(px(6.0)).child(section("Recent runs on this design", None, &th)).children(history.iter().take(12).enumerate().map(|(i, r)| {
                            let color = match r.status.as_str() {
                                "completed" => th.success,
                                "failed" => th.danger,
                                "running" | "queued" => th.accent_text,
                                _ => th.faint,
                            };
                            div()
                                .id(SharedString::from(format!("ai-hist-{i}")))
                                .px(px(10.0))
                                .py(px(8.0))
                                .rounded(px(9.0))
                                .border_1()
                                .border_color(th.border_subtle)
                                .flex()
                                .flex_col()
                                .gap(px(3.0))
                                .child(div().font_family(SANS).text_size(px(12.5)).text_color(th.fg).child(r.goal.chars().take(140).collect::<String>()))
                                .child(
                                    div()
                                        .flex()
                                        .gap(px(8.0))
                                        .font_family(MONO)
                                        .text_size(px(10.5))
                                        .text_color(th.faint)
                                        .child(div().text_color(color).child(r.status.clone()))
                                        .child(ago(r.created_at))
                                        .when(r.cost_credits > 0.0, |d| d.child(format!("{} cr", crate::widgets::number::format(r.cost_credits, 1)))),
                                )
                        })))
                    })
                    .child(div().p(px(10.0)).rounded(px(10.0)).bg(alpha(th.accent, 0.06)).font_family(SANS).text_size(px(11.5)).line_height(px(17.0)).text_color(th.muted).child(
                        "The agent edits real layers. Everything it changes can be undone, and collaborators see it live.",
                    ))
                    .into_any_element()
            }
        };
        frame(
            "desyn",
            Some("ai"),
            Some("Ask for a whole design or a small change."),
            &th,
        )
        .child(body("ai-panel-body", content))
    }
}
