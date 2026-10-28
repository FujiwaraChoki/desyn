//! Effects tab: drop / inner shadows, layer and background blur, noise and glow (each with its fields, visibility
//! and removal), plus the mask switch.

use desyn_core::model::{Design, NodeType};
use gpui::{
    AnyElement, Context, IntoElement, ParentElement, SharedString, StatefulInteractiveElement,
    Styled, Window, div, prelude::FluentBuilder, px,
};
use serde_json::{Value, json};

use super::props::{self, Sel, n};
use super::{ColorTarget, Edit, Inspector, add_button, block, hint, pair};
use crate::ui::components::{icon_button, tip};
use crate::ui::menu::MenuEntry;
use crate::ui::theme::{SANS, Theme};
use crate::widgets::number::Label;
use crate::widgets::{icon_toggle, row, toggle};

const KINDS: &[(&str, &str)] = &[
    ("dropShadow", "Drop shadow"),
    ("innerShadow", "Inner shadow"),
    ("layerBlur", "Layer blur"),
    ("backgroundBlur", "Background blur"),
    ("noise", "Noise"),
    ("glow", "Glow"),
];

fn effects_of(v: &Value) -> Vec<Value> {
    v.get("effects")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn edit_effects(sel: &Sel, f: impl Fn(&mut Vec<Value>)) -> Vec<desyn_core::model::Op> {
    sel.set_each("effects", |node| {
        let mut e = effects_of(node);
        f(&mut e);
        Some(Value::Array(e))
    })
}

/// Numeric fields (`fx.<i>.<field>`).
pub(super) fn number(key: &str, v: f64, sel: &Sel, _d: &mut Design) -> Edit {
    let rest = key.strip_prefix("fx.")?;
    let (i, field) = rest.split_once('.')?;
    let i: usize = i.parse().ok()?;
    let field = field.to_string();
    let val = match field.as_str() {
        "blur" | "radius" | "spread" => n(if field == "spread" { v } else { v.max(0.0) }),
        "amount" | "strength" => n(v.clamp(0.0, 1.0)),
        "scale" => n(v.clamp(0.1, 10.0)),
        _ => n(v),
    };
    Some((
        edit_effects(sel, |e| {
            if let Some(o) = e.get_mut(i).and_then(Value::as_object_mut) {
                o.insert(field.clone(), val.clone());
            }
        }),
        "Effect".to_string(),
    ))
}

/// Choices (`fx.add`, `fx.<i>.remove`, `fx.<i>.visible`, `fx.<i>.mono`, `mask`).
pub(super) fn choice(key: &str, v: &Value, sel: &Sel, _d: &mut Design) -> Edit {
    if key == "fx.add" {
        let kind = v.as_str()?.to_string();
        return Some((
            edit_effects(sel, |e| e.push(props::effect(&kind))),
            "Add effect".to_string(),
        ));
    }
    if key == "mask" {
        return Some((sel.set_all("mask", v.clone()), "Mask".to_string()));
    }
    let rest = key.strip_prefix("fx.")?;
    let (i, field) = rest.split_once('.')?;
    let i: usize = i.parse().ok()?;
    let field = field.to_string();
    Some((
        edit_effects(sel, |e| match field.as_str() {
            "remove" => {
                if i < e.len() {
                    e.remove(i);
                }
            }
            other => {
                if let Some(o) = e.get_mut(i).and_then(Value::as_object_mut) {
                    o.insert(other.to_string(), v.clone());
                }
            }
        }),
        "Effect".to_string(),
    ))
}

/// Effect colors.
pub(super) fn color(target: &ColorTarget, c: &str, sel: &Sel, _d: &mut Design) -> Edit {
    let ColorTarget::Effect(i) = target else {
        return None;
    };
    let i = *i;
    Some((
        edit_effects(sel, |e| {
            if let Some(o) = e.get_mut(i).and_then(Value::as_object_mut) {
                o.insert("color".into(), json!(c));
            }
        }),
        "Effect color".to_string(),
    ))
}

impl Inspector {
    pub(super) fn effects_tab(
        &mut self,
        sel: &Sel,
        th: &Theme,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let mut col = div().flex().flex_col().pt(px(6.0));
        if sel.is_page {
            return col
                .child(block(
                    "Effects",
                    None,
                    hint("Select a layer to add shadows, blurs, noise or a glow.", th),
                    th,
                ))
                .into_any_element();
        }
        let same = sel
            .nodes
            .iter()
            .all(|n| effects_of(n) == effects_of(&sel.nodes[0]));
        let effects = if same {
            effects_of(&sel.nodes[0])
        } else {
            Vec::new()
        };
        let add = add_button("fx", "Add effect", th).on_click(cx.listener(
            |this, e: &gpui::ClickEvent, window, cx| {
                let me = cx.entity().downgrade();
                let entries = KINDS
                    .iter()
                    .map(|(k, l)| {
                        let me = me.clone();
                        MenuEntry::run(*l, move |_, cx| {
                            let _ = me.update(cx, |this, cx| this.choose("fx.add", json!(k), cx));
                        })
                    })
                    .collect();
                let at = super::below(e);
                this.editor
                    .update(cx, |ed, cx| ed.open_menu(entries, at, window, cx));
            },
        ));
        let mut list = div().flex().flex_col().gap(px(10.0));
        if !same {
            list = list.child(hint(
                "The selected layers have different effects. Adding one adds it to all of them.",
                th,
            ));
        }
        if same && effects.is_empty() {
            list = list.child(hint(
                "No effects yet. Add a soft shadow or a glow with +.",
                th,
            ));
        }
        for (i, e) in effects.iter().enumerate() {
            list = list.child(self.effect_card(i, e, th, window, cx));
        }
        col = col.child(block("Effects", Some(add.into_any_element()), list, th));
        if !sel.any(&[NodeType::Page]) {
            let mask = sel.flag(&["mask"], false).unwrap_or(false);
            let me = cx.entity().downgrade();
            col = col.child(block(
                "Mask",
                None,
                div()
                    .flex()
                    .flex_col()
                    .gap(px(6.0))
                    .child(row(
                        "Use as mask",
                        toggle("mask", mask, th, move |v, _, cx| {
                            let _ = me.update(cx, |this, cx| this.choose("mask", json!(v), cx));
                        }),
                        th,
                    ))
                    .child(hint(
                        "A mask shows the layers above it only where it is opaque.",
                        th,
                    )),
                th,
            ));
        }
        col.into_any_element()
    }

    fn effect_card(
        &mut self,
        i: usize,
        e: &Value,
        th: &Theme,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let kind = e
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let label = KINDS
            .iter()
            .find(|(k, _)| *k == kind)
            .map(|(_, l)| *l)
            .unwrap_or("Effect");
        let visible = e.get("visible").and_then(Value::as_bool).unwrap_or(true);
        let f = |k: &str| e.get(k).and_then(Value::as_f64);
        let head = div()
            .flex()
            .items_center()
            .gap(px(6.0))
            .child(
                div()
                    .flex_1()
                    .font_family(SANS)
                    .text_size(px(12.5))
                    .text_color(th.fg)
                    .child(label),
            )
            .child(
                icon_toggle(
                    SharedString::from(format!("fx-vis-{i}")),
                    if visible {
                        "icons/eye.svg"
                    } else {
                        "icons/eye-off.svg"
                    },
                    false,
                    if visible { "Hide" } else { "Show" },
                    th,
                )
                .on_click(cx.listener(move |this, _, _, cx| {
                    this.choose(&format!("fx.{i}.visible"), json!(!visible), cx)
                })),
            )
            .child(
                icon_button(
                    SharedString::from(format!("fx-rm-{i}")),
                    "icons/minus.svg",
                    28.0,
                    false,
                    th,
                )
                .tooltip(tip("Remove", None))
                .on_click(cx.listener(move |this, _, _, cx| {
                    this.choose(&format!("fx.{i}.remove"), serde_json::Value::Null, cx)
                })),
            );
        let mut body = div().flex().flex_col().gap(px(6.0));
        match kind.as_str() {
            "dropShadow" | "innerShadow" => {
                let x = self.num(
                    &format!("fx.{i}.x"),
                    Label::Text("X".into()),
                    f("x"),
                    |n| n.range(-1000.0, 1000.0).precision(0),
                    window,
                    cx,
                );
                let y = self.num(
                    &format!("fx.{i}.y"),
                    Label::Text("Y".into()),
                    f("y"),
                    |n| n.range(-1000.0, 1000.0).precision(0),
                    window,
                    cx,
                );
                let blur = self.num(
                    &format!("fx.{i}.blur"),
                    Label::Text("B".into()),
                    f("blur"),
                    |n| n.range(0.0, 500.0).precision(0).tooltip("Blur"),
                    window,
                    cx,
                );
                let spread = self.num(
                    &format!("fx.{i}.spread"),
                    Label::Text("S".into()),
                    f("spread"),
                    |n| n.range(-500.0, 500.0).precision(0).tooltip("Spread"),
                    window,
                    cx,
                );
                let color = e.get("color").and_then(Value::as_str).map(str::to_string);
                body = body
                    .child(pair(x, y))
                    .child(pair(blur, spread))
                    .child(self.color_button(
                        &format!("fx-color-{i}"),
                        ColorTarget::Effect(i),
                        color,
                        th,
                        cx,
                    ));
            }
            "layerBlur" | "backgroundBlur" => {
                let r = self.num(
                    &format!("fx.{i}.radius"),
                    Label::Text("R".into()),
                    f("radius"),
                    |n| {
                        n.range(0.0, 500.0)
                            .unit("px")
                            .precision(0)
                            .tooltip("Radius")
                    },
                    window,
                    cx,
                );
                body = body.child(r);
            }
            "noise" => {
                let amount = self.num(
                    &format!("fx.{i}.amount"),
                    Label::Text("A".into()),
                    f("amount"),
                    |n| {
                        n.range(0.0, 1.0)
                            .display_scale(100.0)
                            .unit("%")
                            .precision(0)
                            .tooltip("Amount")
                    },
                    window,
                    cx,
                );
                let scale = self.num(
                    &format!("fx.{i}.scale"),
                    Label::Text("S".into()),
                    f("scale"),
                    |n| n.range(0.1, 10.0).precision(1).tooltip("Scale"),
                    window,
                    cx,
                );
                let mono = e.get("mono").and_then(Value::as_bool).unwrap_or(true);
                let me = cx.entity().downgrade();
                body = body.child(pair(amount, scale)).child(row(
                    "Monochrome",
                    toggle(&format!("fx-mono-{i}"), mono, th, move |v, _, cx| {
                        let _ = me.update(cx, |this, cx| {
                            this.choose(&format!("fx.{i}.mono"), json!(v), cx)
                        });
                    }),
                    th,
                ));
            }
            _ => {
                let r = self.num(
                    &format!("fx.{i}.radius"),
                    Label::Text("R".into()),
                    f("radius"),
                    |n| {
                        n.range(0.0, 500.0)
                            .unit("px")
                            .precision(0)
                            .tooltip("Radius")
                    },
                    window,
                    cx,
                );
                let s = self.num(
                    &format!("fx.{i}.strength"),
                    Label::Text("S".into()),
                    f("strength"),
                    |n| {
                        n.range(0.0, 1.0)
                            .display_scale(100.0)
                            .unit("%")
                            .precision(0)
                            .tooltip("Strength")
                    },
                    window,
                    cx,
                );
                let color = e.get("color").and_then(Value::as_str).map(str::to_string);
                body = body.child(pair(r, s)).child(self.color_button(
                    &format!("fx-color-{i}"),
                    ColorTarget::Effect(i),
                    color,
                    th,
                    cx,
                ));
            }
        }
        div()
            .p(px(10.0))
            .flex()
            .flex_col()
            .gap(px(8.0))
            .rounded(px(10.0))
            .bg(th.surface2)
            .border_1()
            .border_color(th.border_subtle)
            .when(!visible, |d| d.opacity(0.55))
            .child(head)
            .child(body)
            .into_any_element()
    }
}
