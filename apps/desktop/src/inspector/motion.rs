//! Animate tab: entrance, exit and loop animations of layers (preset, start, duration, easing) and, for pages,
//! the page duration and the transition to the next page (presentations and videos).

use desyn_core::model::{Design, Op, UpdateOp};
use gpui::{
    AnyElement, Context, InteractiveElement, IntoElement, ParentElement, SharedString,
    StatefulInteractiveElement, Styled, Window, div, px,
};
use serde_json::{Value, json};

use super::props::{self, Sel, n};
use super::{Edit, Inspector, below, block, hint, pair};
use crate::ui::components::{icon_button, tip};
use crate::ui::theme::{SANS, Theme};
use crate::widgets::number::Label;
use crate::widgets::{Seg, row, segmented, select_button};

const EASINGS: &[(&str, &str)] = &[
    ("ease-out", "Ease out"),
    ("ease-in-out", "Ease in out"),
    ("ease-in", "Ease in"),
    ("ease", "Ease"),
    ("linear", "Linear"),
    ("spring", "Spring"),
];

const TRANSITIONS: &[(&str, &str)] = &[
    ("none", "None"),
    ("fade", "Fade"),
    ("slide", "Slide"),
    ("push", "Push"),
    ("zoom", "Zoom"),
    ("dissolve", "Dissolve"),
];

fn anims(v: &Value) -> Vec<Value> {
    v.get("anim")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn edit_anims(sel: &Sel, f: impl Fn(&mut Vec<Value>)) -> Vec<Op> {
    sel.set_each("anim", |node| {
        let mut a = anims(node);
        f(&mut a);
        Some(Value::Array(a))
    })
}

/// Numeric fields.
pub(super) fn number(key: &str, v: f64, sel: &Sel, _d: &mut Design) -> Edit {
    let r = |ops, label: &str| Some((ops, label.to_string()));
    match key {
        "page.durationMs" => r(
            sel.set_all("durationMs", n((v * 1000.0).clamp(100.0, 600_000.0))),
            "Page duration",
        ),
        "page.transitionMs" => r(
            sel.set_each("transition", |node| {
                let mut t = node
                    .get("transition")
                    .cloned()
                    .unwrap_or(json!({ "kind": "fade", "durationMs": 400 }));
                t["durationMs"] = n((v * 1000.0).clamp(0.0, 10_000.0));
                Some(t)
            }),
            "Transition duration",
        ),
        k if k.starts_with("anim.") => {
            let (i, field) = k[5..].split_once('.')?;
            let i: usize = i.parse().ok()?;
            let field = field.to_string();
            let ms = n((v * 1000.0).clamp(0.0, 600_000.0));
            r(
                edit_anims(sel, |a| {
                    if let Some(o) = a.get_mut(i).and_then(Value::as_object_mut) {
                        o.insert(field.clone(), ms.clone());
                    }
                }),
                "Animation timing",
            )
        }
        _ => None,
    }
}

/// Choices.
pub(super) fn choice(key: &str, v: &Value, sel: &Sel, _d: &mut Design) -> Edit {
    let r = |ops, label: &str| Some((ops, label.to_string()));
    match key {
        "anim.add" => {
            let phase = v.as_str()?.to_string();
            let preset = match phase.as_str() {
                "loop" => "pulse",
                _ => "fade",
            };
            r(
                edit_anims(sel, |a| {
                    let start = if phase == "out" { 2000 } else { 0 };
                    a.push(json!({
                        "id": crate::sync::new_tx_id(),
                        "preset": preset,
                        "phase": phase,
                        "startMs": start,
                        "durationMs": if phase == "loop" { 1600 } else { 600 },
                        "easing": if phase == "loop" { "ease-in-out" } else { "ease-out" },
                    }));
                }),
                "Add animation",
            )
        }
        "anim.clear" => r(
            sel.ids
                .iter()
                .map(|id| {
                    Op::Update(UpdateOp {
                        id: id.clone(),
                        set: None,
                        unset: Some(vec!["anim".into()]),
                    })
                })
                .collect(),
            "Remove animations",
        ),
        "page.transition" => r(
            sel.set_each("transition", |node| {
                let mut t = node
                    .get("transition")
                    .cloned()
                    .unwrap_or(json!({ "kind": "none", "durationMs": 400 }));
                t["kind"] = v.clone();
                Some(t)
            }),
            "Transition",
        ),
        k if k.starts_with("anim.") => {
            let (i, field) = k[5..].split_once('.')?;
            let i: usize = i.parse().ok()?;
            let field = field.to_string();
            r(
                edit_anims(sel, |a| {
                    if field == "remove" {
                        if i < a.len() {
                            a.remove(i);
                        }
                    } else if let Some(o) = a.get_mut(i).and_then(Value::as_object_mut) {
                        o.insert(field.clone(), v.clone());
                    }
                }),
                "Animation",
            )
        }
        _ => None,
    }
}

impl Inspector {
    pub(super) fn animate_tab(
        &mut self,
        sel: &Sel,
        th: &Theme,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let mut col = div().flex().flex_col().pt(px(6.0));
        if sel.is_page {
            let dur = sel.num(&["durationMs"]).map(|v| v / 1000.0);
            let trans = sel.common(&["transition"]);
            let kind = trans
                .as_ref()
                .and_then(|t| t.get("kind"))
                .and_then(Value::as_str)
                .unwrap_or("none")
                .to_string();
            let tms = trans
                .as_ref()
                .and_then(|t| t.get("durationMs"))
                .and_then(Value::as_f64)
                .map(|v| v / 1000.0);
            let d = self.num(
                "page.durationMs",
                Label::Text("s".into()),
                dur.or(Some(5.0)),
                |f| {
                    f.range(0.1, 600.0)
                        .unit("s")
                        .step(0.1)
                        .precision(1)
                        .tooltip("Shown for")
                },
                window,
                cx,
            );
            let label = TRANSITIONS
                .iter()
                .find(|(k, _)| *k == kind)
                .map(|(_, l)| l.to_string())
                .unwrap_or_default();
            let k2 = kind.clone();
            let tb = select_button("page-transition", label, th).on_click(cx.listener(
                move |this, e: &gpui::ClickEvent, window, cx| {
                    let o = TRANSITIONS
                        .iter()
                        .map(|(k, l)| (json!(k), l.to_string()))
                        .collect();
                    this.menu(
                        "page.transition",
                        o,
                        Some(&json!(k2.clone())),
                        below(e),
                        window,
                        cx,
                    );
                },
            ));
            let td = self.num(
                "page.transitionMs",
                Label::Text("s".into()),
                tms.or(Some(0.4)),
                |f| {
                    f.range(0.0, 10.0)
                        .unit("s")
                        .step(0.1)
                        .precision(1)
                        .tooltip("Transition length")
                },
                window,
                cx,
            );
            col = col
                .child(block(
                    "Page timing",
                    None,
                    div()
                        .flex()
                        .flex_col()
                        .gap(px(8.0))
                        .child(row("Duration", d, th))
                        .child(hint(
                            "How long this page shows in videos and auto-playing presentations.",
                            th,
                        )),
                    th,
                ))
                .child(block(
                    "Transition",
                    None,
                    div().flex().flex_col().gap(px(8.0)).child(pair(tb, td)),
                    th,
                ));
            return col.into_any_element();
        }
        let same = sel.nodes.iter().all(|n| anims(n) == anims(&sel.nodes[0]));
        let list = if same {
            anims(&sel.nodes[0])
        } else {
            Vec::new()
        };
        let me = cx.entity().downgrade();
        let adders = div().flex().gap(px(6.0)).children(
            [("in", "Entrance"), ("out", "Exit"), ("loop", "Loop")]
                .into_iter()
                .map(|(phase, label)| {
                    let me = me.clone();
                    let s3 = th.surface3;
                    div()
                        .id(SharedString::from(format!("anim-add-{phase}")))
                        .flex_1()
                        .h(px(30.0))
                        .flex()
                        .items_center()
                        .justify_center()
                        .rounded(px(7.0))
                        .border_1()
                        .border_dashed()
                        .border_color(th.border)
                        .cursor_pointer()
                        .hover(move |s| s.bg(s3))
                        .font_family(SANS)
                        .text_size(px(12.0))
                        .text_color(th.muted)
                        .child(format!("+ {label}"))
                        .on_click(move |_, _, cx| {
                            let _ =
                                me.update(cx, |this, cx| this.choose("anim.add", json!(phase), cx));
                        })
                }),
        );
        let mut cards = div().flex().flex_col().gap(px(10.0));
        if !same {
            cards = cards.child(hint(
                "The selected layers animate differently. Adding an animation adds it to all.",
                th,
            ));
        } else if list.is_empty() {
            cards = cards.child(hint(
                "Animations play in presentations, the present view and video exports.",
                th,
            ));
        }
        for (i, a) in list.iter().enumerate() {
            cards = cards.child(self.anim_card(i, a, th, window, cx));
        }
        col = col.child(block(
            "Animations",
            None,
            div()
                .flex()
                .flex_col()
                .gap(px(10.0))
                .child(adders)
                .child(cards),
            th,
        ));
        col.into_any_element()
    }

    fn anim_card(
        &mut self,
        i: usize,
        a: &Value,
        th: &Theme,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let phase = a
            .get("phase")
            .and_then(Value::as_str)
            .unwrap_or("in")
            .to_string();
        let preset = a
            .get("preset")
            .and_then(Value::as_str)
            .unwrap_or("fade")
            .to_string();
        let easing = a
            .get("easing")
            .and_then(Value::as_str)
            .unwrap_or("ease-out")
            .to_string();
        let start = a.get("startMs").and_then(Value::as_f64).map(|v| v / 1000.0);
        let dur = a
            .get("durationMs")
            .and_then(Value::as_f64)
            .map(|v| v / 1000.0);
        let title = match phase.as_str() {
            "out" => "Exit",
            "loop" => "Loop",
            _ => "Entrance",
        };
        let label = props::ANIM_PRESETS
            .iter()
            .find(|(k, _)| *k == preset)
            .map(|(_, l)| l.to_string())
            .unwrap_or(preset.clone());
        let p2 = preset.clone();
        let preset_btn = select_button(SharedString::from(format!("anim-preset-{i}")), label, th)
            .on_click(cx.listener(move |this, e: &gpui::ClickEvent, window, cx| {
                let o = props::ANIM_PRESETS
                    .iter()
                    .map(|(k, l)| (json!(k), l.to_string()))
                    .collect();
                this.menu(
                    &format!("anim.{i}.preset"),
                    o,
                    Some(&json!(p2.clone())),
                    below(e),
                    window,
                    cx,
                );
            }));
        let me = cx.entity().downgrade();
        let ease = segmented(
            &format!("anim-ease-{i}"),
            EASINGS
                .iter()
                .take(4)
                .map(|(k, l)| (k.to_string(), Seg::Text((*l).into())))
                .collect(),
            Some(&easing),
            th,
            move |v, _, cx| {
                let _ = me.update(cx, |this, cx| {
                    this.choose(&format!("anim.{i}.easing"), json!(v), cx)
                });
            },
        );
        let s = self.num(
            &format!("anim.{i}.startMs"),
            Label::Text("At".into()),
            start,
            |f| {
                f.range(0.0, 600.0)
                    .unit("s")
                    .step(0.1)
                    .precision(1)
                    .tooltip("Starts at")
            },
            window,
            cx,
        );
        let d = self.num(
            &format!("anim.{i}.durationMs"),
            Label::Text("For".into()),
            dur,
            |f| {
                f.range(0.05, 600.0)
                    .unit("s")
                    .step(0.1)
                    .precision(2)
                    .tooltip("Duration")
            },
            window,
            cx,
        );
        div()
            .p(px(10.0))
            .flex()
            .flex_col()
            .gap(px(8.0))
            .rounded(px(10.0))
            .bg(th.surface2)
            .border_1()
            .border_color(th.border_subtle)
            .child(
                div()
                    .flex()
                    .items_center()
                    .child(
                        div()
                            .flex_1()
                            .font_family(SANS)
                            .text_size(px(12.5))
                            .text_color(th.fg)
                            .child(title),
                    )
                    .child(
                        icon_button(
                            SharedString::from(format!("anim-rm-{i}")),
                            "icons/minus.svg",
                            26.0,
                            false,
                            th,
                        )
                        .tooltip(tip("Remove", None))
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.choose(&format!("anim.{i}.remove"), Value::Null, cx)
                        })),
                    ),
            )
            .child(preset_btn)
            .child(pair(s, d))
            .child(ease)
            .into_any_element()
    }
}
