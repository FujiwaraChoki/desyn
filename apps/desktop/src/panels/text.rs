//! Text panel: heading / subheading / body / caption presets, font pairings (headline + body, fetched from Google
//! Fonts on first use) and the design's own text styles (apply to the selection).

use desyn_core::model::{Node, NodeType};
use gpui::{
    App, Context, Entity, FocusHandle, Focusable, InteractiveElement, IntoElement, ParentElement,
    Render, SharedString, StatefulInteractiveElement, Styled, Window, div, prelude::FluentBuilder,
    px,
};
use serde_json::{Value, json};

use super::insert::{self, tweak};
use super::{body, frame};
use crate::ui::components::{t, tip};
use crate::ui::editor::{EditorEvent, EditorView};
use crate::ui::theme::{SANS, SERIF, Theme};
use crate::widgets::fonts::FontLibrary;
use crate::widgets::section;

struct Preset {
    id: &'static str,
    text: &'static str,
    family: &'static str,
    weight: i64,
    size: f64,
    case: &'static str,
    tracking: f64,
    preview: f32,
}

const PRESETS: &[Preset] = &[
    Preset {
        id: "heading",
        text: "Add a heading",
        family: "Instrument Serif",
        weight: 400,
        size: 96.0,
        case: "none",
        tracking: -0.01,
        preview: 30.0,
    },
    Preset {
        id: "subheading",
        text: "Add a subheading",
        family: "Instrument Sans",
        weight: 600,
        size: 40.0,
        case: "none",
        tracking: -0.01,
        preview: 19.0,
    },
    Preset {
        id: "body",
        text: "Add a little bit of body text",
        family: "Inter",
        weight: 400,
        size: 22.0,
        case: "none",
        tracking: 0.0,
        preview: 13.5,
    },
    Preset {
        id: "caption",
        text: "ADD A CAPTION",
        family: "Instrument Sans",
        weight: 600,
        size: 16.0,
        case: "upper",
        tracking: 0.2,
        preview: 11.0,
    },
];

/// Headline + body pairings.
const PAIRINGS: &[(&str, &str, &str, i64, &str)] = &[
    (
        "Editorial",
        "Playfair Display",
        "Inter",
        700,
        "the quiet hour",
    ),
    (
        "Modern",
        "Space Grotesk",
        "DM Sans",
        700,
        "build the future",
    ),
    (
        "Classic",
        "Cormorant Garamond",
        "Lora",
        600,
        "a story well told",
    ),
    ("Bold", "Bebas Neue", "Inter", 400, "MAKE IT LOUD"),
    ("Warm", "Fraunces", "Work Sans", 600, "slow mornings"),
    ("Playful", "Pacifico", "Nunito", 400, "hello sunshine"),
    ("Technical", "JetBrains Mono", "Inter", 700, "v2.0 is live"),
    ("Luxe", "Bodoni Moda", "Montserrat", 500, "the collection"),
];

#[allow(clippy::too_many_arguments)]
fn text_node(
    id: String,
    text: &str,
    family: &str,
    weight: i64,
    size: f64,
    case: &str,
    tracking: f64,
    width: Option<f64>,
) -> Option<Node> {
    let n = Node::text(id, text, 0.0, 0.0, width);
    let mut style = serde_json::to_value(match &n {
        Node::Text(t) => &t.style,
        _ => return None,
    })
    .ok()?;
    style["fontFamily"] = json!(family);
    style["fontWeight"] = json!(weight);
    style["fontSize"] = json!(size);
    style["textCase"] = json!(case);
    style["letterSpacing"] = json!(tracking);
    style["fills"] = json!([{ "type": "solid", "color": "#111111" }]);
    let h = (size * 1.25).round();
    tweak(n, json!({ "style": style, "height": h }))
}

/// The panel.
pub struct TextPanel {
    editor: Entity<EditorView>,
    focus: FocusHandle,
    _sub: gpui::Subscription,
}

impl Focusable for TextPanel {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl TextPanel {
    /// A panel for an editor.
    pub fn new(
        editor: Entity<EditorView>,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) -> TextPanel {
        for (_, h, b, _, _) in PAIRINGS {
            FontLibrary::ensure(h, cx);
            FontLibrary::ensure(b, cx);
        }
        FontLibrary::ensure("Inter", cx);
        let sub = cx.subscribe(&editor, |_, _, e: &EditorEvent, cx| {
            if matches!(e, EditorEvent::Changed(_) | EditorEvent::Selection(_)) {
                cx.notify();
            }
        });
        TextPanel {
            editor,
            focus: cx.focus_handle(),
            _sub: sub,
        }
    }

    fn add_preset(&mut self, p: &Preset, cx: &mut Context<Self>) {
        FontLibrary::ensure(p.family, cx);
        let id = insert::new_id(&self.editor, cx);
        let pw = self.editor.read(cx).session.page_rect().w.max(1.0);
        let width = if p.id == "body" {
            Some((pw * 0.6).round().max(200.0))
        } else {
            None
        };
        if let Some(n) = text_node(
            id, p.text, p.family, p.weight, p.size, p.case, p.tracking, width,
        ) {
            let n = tweak(n.clone(), json!({ "role": match p.id { "heading" => "headline", "subheading" => "subhead", "caption" => "caption", _ => "body" } })).unwrap_or(n);
            insert::insert(&self.editor, vec![vec![n]], Vec::new(), "Add text", cx);
        }
    }

    fn add_pairing(&mut self, i: usize, cx: &mut Context<Self>) {
        let (_, head, bodyf, weight, sample) = PAIRINGS[i];
        FontLibrary::ensure(head, cx);
        FontLibrary::ensure(bodyf, cx);
        let pw = self.editor.read(cx).session.page_rect().w.max(1.0);
        let width = (pw * 0.62).round().max(240.0);
        let gid = insert::new_id(&self.editor, cx);
        let hid = insert::new_id(&self.editor, cx);
        let bid = insert::new_id(&self.editor, cx);
        let size = (pw / 11.0).clamp(36.0, 120.0).round();
        let Some(h) = text_node(
            hid.clone(),
            sample,
            head,
            weight,
            size,
            "none",
            0.0,
            Some(width),
        ) else {
            return;
        };
        let Some(b) = text_node(
            bid.clone(),
            "Pair a striking headline with a calm, readable body. Edit this text to make it yours.",
            bodyf,
            400,
            (size * 0.28).clamp(14.0, 28.0).round(),
            "none",
            0.0,
            Some(width),
        ) else {
            return;
        };
        let bh = b.base().height;
        let hh = h.base().height;
        let gap = (size * 0.3).round();
        let Some(h) = tweak(h, json!({ "role": "headline", "parent": gid })) else {
            return;
        };
        let Some(b) = tweak(b, json!({ "role": "body", "y": hh + gap, "parent": gid })) else {
            return;
        };
        let Some(group) = tweak(
            Node::group(gid.clone(), "Text pairing", 0.0, 0.0, width, hh + gap + bh),
            json!({ "children": [hid, bid] }),
        ) else {
            return;
        };
        insert::insert(
            &self.editor,
            vec![vec![group, h, b]],
            Vec::new(),
            "Add text pairing",
            cx,
        );
    }

    fn apply_style(&mut self, style_id: String, cx: &mut Context<Self>) {
        self.editor.update(cx, |e, cx| {
            let d = &e.session.doc.design;
            let Some(st) = d.styles.text.get(&style_id) else {
                return;
            };
            let style = serde_json::to_value(&st.style).unwrap_or(Value::Null);
            let para = st
                .paragraph
                .as_ref()
                .and_then(|p| serde_json::to_value(p).ok());
            let targets: Vec<String> = e
                .session
                .selection
                .iter()
                .filter(|id| d.node(id).is_some_and(|n| n.node_type() == NodeType::Text))
                .cloned()
                .collect();
            if targets.is_empty() {
                cx.emit(EditorEvent::Notice(
                    "Select text layers to apply a style.".into(),
                ));
                return;
            }
            let mut ops = Vec::new();
            for id in &targets {
                let node = serde_json::to_value(d.node(id).unwrap()).unwrap_or(Value::Null);
                let mut s = node.get("style").cloned().unwrap_or(json!({}));
                if let (Some(o), Some(src)) = (s.as_object_mut(), style.as_object()) {
                    for (k, v) in src {
                        o.insert(k.clone(), v.clone());
                    }
                }
                ops.push(crate::inspector::props::update(id, "style", s));
                ops.push(crate::inspector::props::update(
                    id,
                    "styleRef",
                    json!(style_id),
                ));
                if let Some(p) = &para {
                    let mut cur = node.get("paragraph").cloned().unwrap_or(json!({}));
                    if let (Some(o), Some(src)) = (cur.as_object_mut(), p.as_object()) {
                        for (k, v) in src {
                            o.insert(k.clone(), v.clone());
                        }
                    }
                    ops.push(crate::inspector::props::update(id, "paragraph", cur));
                }
            }
            e.apply(ops, "Apply text style", cx);
        });
    }
}

fn row_card(id: impl Into<SharedString>, th: &Theme) -> gpui::Stateful<gpui::Div> {
    let s3 = th.surface3;
    let b = th.border;
    div()
        .id(gpui::ElementId::Name(id.into()))
        .w_full()
        .px(px(14.0))
        .py(px(12.0))
        .rounded(px(10.0))
        .bg(th.surface2)
        .border_1()
        .border_color(th.border_subtle)
        .cursor_pointer()
        .hover(move |s| s.bg(s3).border_color(b))
}

impl Render for TextPanel {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let th = t(window, cx);
        let mut presets = div().flex().flex_col().gap(px(8.0));
        for (i, p) in PRESETS.iter().enumerate() {
            let family: SharedString = if FontLibrary::previewable(p.family, cx) {
                p.family.into()
            } else {
                SANS.into()
            };
            let family = if p.family == "Instrument Serif" {
                SERIF.into()
            } else {
                family
            };
            presets = presets.child(
                row_card(format!("preset-{}", p.id), &th)
                    .child(
                        div()
                            .font_family(family)
                            .text_size(px(p.preview))
                            .line_height(px(p.preview * 1.2))
                            .font_weight(gpui::FontWeight(p.weight as f32))
                            .text_color(th.fg)
                            .child(p.text),
                    )
                    .on_click(cx.listener(move |this, _, _, cx| this.add_preset(&PRESETS[i], cx))),
            );
        }
        let mut pairs = div().flex().flex_col().gap(px(8.0));
        for (i, (name, head, bodyf, weight, sample)) in PAIRINGS.iter().enumerate() {
            let hf: SharedString = if FontLibrary::previewable(head, cx) {
                (*head).into()
            } else {
                SANS.into()
            };
            let bf: SharedString = if FontLibrary::previewable(bodyf, cx) {
                (*bodyf).into()
            } else {
                SANS.into()
            };
            let loading = FontLibrary::is_loading(head, cx) || FontLibrary::is_loading(bodyf, cx);
            pairs = pairs.child(
                row_card(format!("pair-{i}"), &th)
                    .tooltip(tip(format!("{head} + {bodyf}"), None))
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .justify_between()
                            .child(
                                div()
                                    .font_family(SANS)
                                    .text_size(px(11.5))
                                    .text_color(th.faint)
                                    .child(*name),
                            )
                            .when(loading, |d| {
                                d.child(crate::widgets::spinner(format!("pair-load-{i}"), 8.0, &th))
                            }),
                    )
                    .child(
                        div()
                            .pt(px(4.0))
                            .font_family(hf)
                            .font_weight(gpui::FontWeight(*weight as f32))
                            .text_size(px(22.0))
                            .line_height(px(26.0))
                            .text_color(th.fg)
                            .child(*sample),
                    )
                    .child(
                        div()
                            .font_family(bf)
                            .text_size(px(12.0))
                            .text_color(th.muted)
                            .child(format!("{head} · {bodyf}")),
                    )
                    .on_click(cx.listener(move |this, _, _, cx| this.add_pairing(i, cx))),
            );
        }
        let styles: Vec<(String, String, f64, String)> = {
            let d = &self.editor.read(cx).session.doc.design;
            d.styles
                .text
                .iter()
                .map(|(id, s)| {
                    (
                        id.clone(),
                        s.name.clone(),
                        s.style.font_size,
                        s.style.font_family.clone(),
                    )
                })
                .collect()
        };
        let mut doc_styles = div().flex().flex_col().gap(px(6.0));
        for (id, name, size, family) in styles {
            let id2 = id.clone();
            doc_styles = doc_styles.child(
                row_card(format!("style-{id}"), &th)
                    .child(
                        div()
                            .font_family(SANS)
                            .text_size(px(13.0))
                            .text_color(th.fg)
                            .child(name),
                    )
                    .child(
                        div()
                            .font_family(SANS)
                            .text_size(px(11.0))
                            .text_color(th.faint)
                            .child(format!(
                                "{family} · {} px",
                                crate::widgets::number::format(size, 1)
                            )),
                    )
                    .on_click(cx.listener(move |this, _, _, cx| this.apply_style(id2.clone(), cx))),
            );
        }
        let has_styles = !self
            .editor
            .read(cx)
            .session
            .doc
            .design
            .styles
            .text
            .is_empty();
        let content = div()
            .flex()
            .flex_col()
            .gap(px(14.0))
            .child(div().flex().flex_col().gap(px(8.0)).child(section("Click to add", None, &th)).child(presets))
            .child(div().flex().flex_col().gap(px(8.0)).child(section("Font pairings", None, &th)).child(pairs))
            .when(has_styles, |d| d.child(div().flex().flex_col().gap(px(8.0)).child(section("Text styles in this design", None, &th)).child(doc_styles)))
            .child(
                div()
                    .font_family(SANS)
                    .text_size(px(11.0))
                    .text_color(th.faint)
                    .child("Tip: press T to draw a text box, or double-click text on the canvas to edit it."),
            );
        frame("add", Some("text"), None, &th).child(body("text-body", content))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_nodes_are_valid() {
        for p in PRESETS {
            let n = text_node(
                "abcdefghijkl".into(),
                p.text,
                p.family,
                p.weight,
                p.size,
                p.case,
                p.tracking,
                Some(300.0),
            )
            .unwrap();
            assert!(desyn_core::model::validate_node(&n).is_ok());
        }
    }
}
