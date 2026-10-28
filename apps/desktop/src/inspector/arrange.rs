//! Arrange tab: align and distribute, z-order, group / frame / mask / flip, auto-layout of containers, sizing of
//! auto-layout children and constraints of children of plain frames.

use desyn_core::arrange::{Alignment, DistributeAxis, ZOrder};
use desyn_core::model::{Design, NodeType, Op, UpdateOp};
use gpui::{
    AnyElement, Context, InteractiveElement, IntoElement, ParentElement, SharedString,
    StatefulInteractiveElement, Styled, Window, div, px,
};
use serde_json::{Value, json};

use super::props::{Sel, get, n};
use super::{Edit, Inspector, below, block, hint, pair};
use crate::ui::components::{icon, tip};
use crate::ui::theme::{SANS, Theme};
use crate::widgets::number::Label;
use crate::widgets::{Seg, row, segmented, select_button, toggle};

fn layout_of(v: &Value) -> Option<&Value> {
    v.get("layout").filter(|l| l.is_object())
}

/// Numeric fields of the Arrange tab.
pub(super) fn number(key: &str, v: f64, sel: &Sel, _d: &mut Design) -> Edit {
    let r = |ops, label: &str| Some((ops, label.to_string()));
    let set_layout = |field: &str, val: Value| {
        sel.set_each("layout", |node| {
            let mut l = layout_of(node)?.clone();
            super::props::set_in(&mut l, &[field], val.clone());
            Some(l)
        })
    };
    match key {
        "layout.gap" => r(set_layout("gap", n(v.max(0.0))), "Gap"),
        "layout.rowGap" => r(set_layout("rowGap", n(v.max(0.0))), "Row gap"),
        "layout.columns" => r(
            set_layout("columns", json!(v.round().clamp(1.0, 48.0) as i64)),
            "Columns",
        ),
        k if k.starts_with("layout.pad.") => {
            let i: usize = k[11..].parse().ok()?;
            r(
                sel.set_each("layout", |node| {
                    let mut l = layout_of(node)?.clone();
                    let mut pad: Vec<f64> = l
                        .get("padding")
                        .and_then(Value::as_array)
                        .map(|a| a.iter().map(|x| x.as_f64().unwrap_or(0.0)).collect())
                        .unwrap_or_else(|| vec![0.0; 4]);
                    pad.resize(4, 0.0);
                    if i == 4 {
                        pad = vec![v.max(0.0); 4];
                    } else {
                        pad[i] = v.max(0.0);
                    }
                    l["padding"] = json!(pad.iter().map(|x| n(*x)).collect::<Vec<_>>());
                    Some(l)
                }),
                "Padding",
            )
        }
        _ => None,
    }
}

/// Choices of the Arrange tab.
pub(super) fn choice(key: &str, v: &Value, sel: &Sel, _d: &mut Design) -> Edit {
    let r = |ops, label: &str| Some((ops, label.to_string()));
    let set_layout = |field: &str, val: Value| {
        sel.set_each("layout", |node| {
            let mut l = layout_of(node)?.clone();
            super::props::set_in(&mut l, &[field], val.clone());
            Some(l)
        })
    };
    match key {
        "layout.mode" => r(set_layout("mode", v.clone()), "Layout direction"),
        "layout.main" => r(set_layout("mainAlign", v.clone()), "Distribution"),
        "layout.cross" => r(set_layout("crossAlign", v.clone()), "Alignment"),
        "layout.wrap" => r(set_layout("wrap", v.clone()), "Wrap"),
        "layout.reverse" => r(set_layout("reverse", v.clone()), "Reverse"),
        "layout.remove" => r(
            sel.ids
                .iter()
                .map(|id| {
                    Op::Update(UpdateOp {
                        id: id.clone(),
                        set: None,
                        unset: Some(vec!["layout".into()]),
                    })
                })
                .collect(),
            "Remove auto-layout",
        ),
        "clip" => r(sel.set_all("clip", v.clone()), "Clip content"),
        "sizing.h" | "sizing.v" => {
            let axis = &key[7..];
            r(
                sel.set_each("sizing", |node| {
                    let mut s = node
                        .get("sizing")
                        .cloned()
                        .unwrap_or(json!({ "h": "fixed", "v": "fixed" }));
                    s[axis] = v.clone();
                    Some(s)
                }),
                "Sizing",
            )
        }
        "constraints.h" | "constraints.v" => {
            let axis = &key[12..];
            r(
                sel.set_each("constraints", |node| {
                    let mut c = node
                        .get("constraints")
                        .cloned()
                        .unwrap_or(json!({ "h": "left", "v": "top" }));
                    c[axis] = v.clone();
                    Some(c)
                }),
                "Constraints",
            )
        }
        _ => None,
    }
}

fn icon_cmd(
    id: &str,
    path: &'static str,
    hint_text: &str,
    th: &Theme,
) -> gpui::Stateful<gpui::Div> {
    let s3 = th.surface3;
    div()
        .id(SharedString::from(format!("arr-{id}")))
        .h(px(32.0))
        .flex_1()
        .flex()
        .items_center()
        .justify_center()
        .rounded(px(7.0))
        .bg(th.surface2)
        .border_1()
        .border_color(th.border_subtle)
        .cursor_pointer()
        .hover(move |s| s.bg(s3))
        .tooltip(tip(hint_text.to_string(), None))
        .child(icon(path, 15.0, th.muted))
}

fn text_cmd(id: &str, path: &'static str, label: &str, th: &Theme) -> gpui::Stateful<gpui::Div> {
    let s3 = th.surface3;
    div()
        .id(SharedString::from(format!("arr-{id}")))
        .h(px(32.0))
        .flex_1()
        .px(px(8.0))
        .flex()
        .items_center()
        .gap(px(7.0))
        .rounded(px(7.0))
        .bg(th.surface2)
        .border_1()
        .border_color(th.border_subtle)
        .cursor_pointer()
        .hover(move |s| s.bg(s3))
        .child(icon(path, 14.0, th.muted))
        .child(
            div()
                .font_family(SANS)
                .text_size(px(12.0))
                .text_color(th.fg)
                .child(label.to_string()),
        )
}

impl Inspector {
    pub(super) fn arrange_tab(
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
                    "Arrange",
                    None,
                    hint(
                        "Select layers to align, distribute, order, group or lay them out.",
                        th,
                    ),
                    th,
                ))
                .into_any_element();
        }
        let multi = sel.nodes.len() > 1;
        let aligns = [
            (
                Alignment::Left,
                "icons/align-start-vertical.svg",
                "Align left",
            ),
            (
                Alignment::Center,
                "icons/align-center-vertical.svg",
                "Align centers",
            ),
            (
                Alignment::Right,
                "icons/align-end-vertical.svg",
                "Align right",
            ),
            (
                Alignment::Top,
                "icons/align-start-horizontal.svg",
                "Align top",
            ),
            (
                Alignment::Middle,
                "icons/align-center-horizontal.svg",
                "Align middles",
            ),
            (
                Alignment::Bottom,
                "icons/align-end-horizontal.svg",
                "Align bottom",
            ),
        ];
        let mut a1 = div().flex().gap(px(6.0));
        let mut a2 = div().flex().gap(px(6.0));
        for (i, (a, path, h)) in aligns.into_iter().enumerate() {
            let b = icon_cmd(&format!("align-{i}"), path, h, th)
                .on_click(cx.listener(move |this, _, _, cx| this.command(cx, |s| s.align(a))));
            if i < 3 {
                a1 = a1.child(b)
            } else {
                a2 = a2.child(b)
            }
        }
        let dist = div()
            .flex()
            .gap(px(6.0))
            .child(
                icon_cmd(
                    "dist-h",
                    "icons/align-horizontal-space-around.svg",
                    "Distribute horizontally",
                    th,
                )
                .on_click(cx.listener(|this, _, _, cx| {
                    this.command(cx, |s| s.distribute(DistributeAxis::Horizontal))
                })),
            )
            .child(
                icon_cmd(
                    "dist-v",
                    "icons/align-vertical-space-around.svg",
                    "Distribute vertically",
                    th,
                )
                .on_click(cx.listener(|this, _, _, cx| {
                    this.command(cx, |s| s.distribute(DistributeAxis::Vertical))
                })),
            );
        col = col.child(block(
            if multi { "Align" } else { "Align to page" },
            None,
            div()
                .flex()
                .flex_col()
                .gap(px(6.0))
                .child(a1)
                .child(a2)
                .child(if multi {
                    dist.into_any_element()
                } else {
                    hint("Select two or more layers to distribute them.", th).into_any_element()
                }),
            th,
        ));
        let order = div()
            .flex()
            .flex_col()
            .gap(px(6.0))
            .child(pair(
                text_cmd("front", "icons/bring-to-front.svg", "To front", th).on_click(
                    cx.listener(|this, _, _, cx| {
                        this.command(cx, |s| s.reorder(ZOrder::BringToFront))
                    }),
                ),
                text_cmd("forward", "icons/arrow-up.svg", "Forward", th).on_click(cx.listener(
                    |this, _, _, cx| this.command(cx, |s| s.reorder(ZOrder::BringForward)),
                )),
            ))
            .child(pair(
                text_cmd("back", "icons/send-to-back.svg", "To back", th).on_click(cx.listener(
                    |this, _, _, cx| this.command(cx, |s| s.reorder(ZOrder::SendToBack)),
                )),
                text_cmd("backward", "icons/arrow-down.svg", "Backward", th).on_click(cx.listener(
                    |this, _, _, cx| this.command(cx, |s| s.reorder(ZOrder::SendBackward)),
                )),
            ));
        col = col.child(block("Order", None, order, th));
        let is_group = sel.all(NodeType::Group);
        let grouping = div()
            .flex()
            .flex_col()
            .gap(px(6.0))
            .child(pair(
                if is_group {
                    text_cmd("ungroup", "icons/ungroup.svg", "Ungroup", th)
                        .on_click(cx.listener(|this, _, _, cx| this.command(cx, |s| s.ungroup())))
                        .into_any_element()
                } else {
                    text_cmd("group", "icons/group.svg", "Group", th)
                        .on_click(cx.listener(|this, _, _, cx| this.command(cx, |s| s.group())))
                        .into_any_element()
                },
                text_cmd("frame", "icons/frame.svg", "Frame", th).on_click(
                    cx.listener(|this, _, _, cx| this.command(cx, |s| s.frame_selection())),
                ),
            ))
            .child(pair(
                text_cmd("flip-h", "icons/flip-horizontal-2.svg", "Flip H", th)
                    .on_click(cx.listener(|this, _, _, cx| this.command(cx, |s| s.flip(true)))),
                text_cmd("flip-v", "icons/flip-vertical-2.svg", "Flip V", th)
                    .on_click(cx.listener(|this, _, _, cx| this.command(cx, |s| s.flip(false)))),
            ))
            .child(
                text_cmd("mask", "icons/scan.svg", "Use as mask", th)
                    .on_click(cx.listener(|this, _, _, cx| this.command(cx, |s| s.use_as_mask()))),
            );
        col = col.child(block("Group", None, grouping, th));

        // Auto-layout of a single container.
        if let Some(node) = sel
            .single()
            .filter(|_| sel.any(&[NodeType::Frame, NodeType::Group]))
        {
            let node = node.clone();
            col = col.child(self.layout_block(&node, sel, th, window, cx));
        }

        // Children of auto-layout parents: sizing; children of plain frames: constraints.
        let (parent_layout, parent_frame) = {
            let e = self.editor.read(cx);
            let d = &e.session.doc.design;
            let parents: Vec<_> = sel
                .ids
                .iter()
                .filter_map(|id| d.node(id).and_then(|n| n.parent()).and_then(|p| d.node(p)))
                .collect();
            (
                !parents.is_empty() && parents.iter().all(|p| p.layout().is_some()),
                !parents.is_empty()
                    && parents
                        .iter()
                        .all(|p| p.node_type() == NodeType::Frame && p.layout().is_none()),
            )
        };
        if parent_layout {
            let me1 = cx.entity().downgrade();
            let me2 = cx.entity().downgrade();
            let opts = |_: &str| {
                vec![
                    ("fixed".to_string(), Seg::Text("Fixed".into())),
                    ("hug".to_string(), Seg::Text("Hug".into())),
                    ("fill".to_string(), Seg::Text("Fill".into())),
                ]
            };
            let h = sel.str(&["sizing", "h"]).or(Some("fixed".into()));
            let v = sel.str(&["sizing", "v"]).or(Some("fixed".into()));
            col = col.child(block(
                "Resizing in layout",
                None,
                div()
                    .flex()
                    .flex_col()
                    .gap(px(6.0))
                    .child(row(
                        "Width",
                        segmented("sizing-h", opts("h"), h.as_ref(), th, move |x, _, cx| {
                            let _ =
                                me1.update(cx, |this, cx| this.choose("sizing.h", json!(x), cx));
                        }),
                        th,
                    ))
                    .child(row(
                        "Height",
                        segmented("sizing-v", opts("v"), v.as_ref(), th, move |x, _, cx| {
                            let _ =
                                me2.update(cx, |this, cx| this.choose("sizing.v", json!(x), cx));
                        }),
                        th,
                    )),
                th,
            ));
        } else if parent_frame {
            let hs = [
                ("left", "Left"),
                ("right", "Right"),
                ("center", "Center"),
                ("stretch", "Left & right"),
                ("scale", "Scale"),
            ];
            let vs = [
                ("top", "Top"),
                ("bottom", "Bottom"),
                ("center", "Center"),
                ("stretch", "Top & bottom"),
                ("scale", "Scale"),
            ];
            let ch = sel
                .str(&["constraints", "h"])
                .unwrap_or_else(|| "left".into());
            let cv = sel
                .str(&["constraints", "v"])
                .unwrap_or_else(|| "top".into());
            let hl = hs
                .iter()
                .find(|(k, _)| *k == ch)
                .map(|(_, l)| l.to_string())
                .unwrap_or_default();
            let vl = vs
                .iter()
                .find(|(k, _)| *k == cv)
                .map(|(_, l)| l.to_string())
                .unwrap_or_default();
            let ch2 = ch.clone();
            let cv2 = cv.clone();
            col = col.child(block(
                "Constraints",
                None,
                div()
                    .flex()
                    .flex_col()
                    .gap(px(6.0))
                    .child(row(
                        "Horizontal",
                        select_button("con-h", hl, th).on_click(cx.listener(
                            move |this, e: &gpui::ClickEvent, window, cx| {
                                let o = hs.iter().map(|(k, l)| (json!(k), l.to_string())).collect();
                                this.menu(
                                    "constraints.h",
                                    o,
                                    Some(&json!(ch2.clone())),
                                    below(e),
                                    window,
                                    cx,
                                );
                            },
                        )),
                        th,
                    ))
                    .child(row(
                        "Vertical",
                        select_button("con-v", vl, th).on_click(cx.listener(
                            move |this, e: &gpui::ClickEvent, window, cx| {
                                let o = vs.iter().map(|(k, l)| (json!(k), l.to_string())).collect();
                                this.menu(
                                    "constraints.v",
                                    o,
                                    Some(&json!(cv2.clone())),
                                    below(e),
                                    window,
                                    cx,
                                );
                            },
                        )),
                        th,
                    ))
                    .child(hint(
                        "How the layer follows its frame when the frame is resized.",
                        th,
                    )),
                th,
            ));
        }
        col.into_any_element()
    }

    fn layout_block(
        &mut self,
        node: &Value,
        sel: &Sel,
        th: &Theme,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let Some(layout) = layout_of(node).cloned() else {
            let add = text_cmd("add-layout", "icons/rows-3.svg", "Add auto-layout", th)
                .on_click(cx.listener(|this, _, _, cx| this.command(cx, |s| s.add_auto_layout())));
            let clip = sel.flag(&["clip"], false).unwrap_or(false);
            let me = cx.entity().downgrade();
            let mut d = div().flex().flex_col().gap(px(8.0)).child(add).child(hint(
                "Stack the layers inside in a row, column or grid with even spacing.",
                th,
            ));
            if sel.all(NodeType::Frame) {
                d = d.child(row(
                    "Clip content",
                    toggle("clip", clip, th, move |v, _, cx| {
                        let _ = me.update(cx, |this, cx| this.choose("clip", json!(v), cx));
                    }),
                    th,
                ));
            }
            return block("Auto-layout", None, d, th).into_any_element();
        };
        let mode = layout
            .get("mode")
            .and_then(Value::as_str)
            .unwrap_or("row")
            .to_string();
        let main = layout
            .get("mainAlign")
            .and_then(Value::as_str)
            .unwrap_or("start")
            .to_string();
        let cross = layout
            .get("crossAlign")
            .and_then(Value::as_str)
            .unwrap_or("start")
            .to_string();
        let wrap = layout.get("wrap").and_then(Value::as_bool).unwrap_or(false);
        let pad: Vec<f64> = layout
            .get("padding")
            .and_then(Value::as_array)
            .map(|a| a.iter().map(|x| x.as_f64().unwrap_or(0.0)).collect())
            .unwrap_or_else(|| vec![0.0; 4]);
        let me = cx.entity().downgrade();
        let (m1, m2, m3, m4) = (me.clone(), me.clone(), me.clone(), me.clone());
        let mode_row = segmented(
            "layout-mode",
            vec![
                (
                    "row".to_string(),
                    Seg::Icon("icons/columns-3.svg", "Row".into()),
                ),
                (
                    "column".to_string(),
                    Seg::Icon("icons/rows-3.svg", "Column".into()),
                ),
                (
                    "grid".to_string(),
                    Seg::Icon("icons/layout-grid.svg", "Grid".into()),
                ),
            ],
            Some(&mode),
            th,
            move |v, _, cx| {
                let _ = m1.update(cx, |this, cx| this.choose("layout.mode", json!(v), cx));
            },
        );
        let gap = self.num(
            "layout.gap",
            Label::Icon("icons/move-horizontal.svg"),
            get(&layout, &["gap"]).and_then(Value::as_f64),
            |f| f.range(0.0, 5000.0).unit("px").precision(0).tooltip("Gap"),
            window,
            cx,
        );
        let pad_all = (pad.iter().all(|p| (*p - pad[0]).abs() < 1e-9)).then(|| pad[0]);
        let padding = self.num(
            "layout.pad.4",
            Label::Icon("icons/scan.svg"),
            pad_all,
            |f| {
                f.range(0.0, 5000.0)
                    .unit("px")
                    .precision(0)
                    .tooltip("Padding (all sides)")
            },
            window,
            cx,
        );
        let pt = self.num(
            "layout.pad.0",
            Label::Text("T".into()),
            pad.first().copied(),
            |f| f.range(0.0, 5000.0).precision(0),
            window,
            cx,
        );
        let pr = self.num(
            "layout.pad.1",
            Label::Text("R".into()),
            pad.get(1).copied(),
            |f| f.range(0.0, 5000.0).precision(0),
            window,
            cx,
        );
        let pb = self.num(
            "layout.pad.2",
            Label::Text("B".into()),
            pad.get(2).copied(),
            |f| f.range(0.0, 5000.0).precision(0),
            window,
            cx,
        );
        let pl = self.num(
            "layout.pad.3",
            Label::Text("L".into()),
            pad.get(3).copied(),
            |f| f.range(0.0, 5000.0).precision(0),
            window,
            cx,
        );
        let main_row = segmented(
            "layout-main",
            vec![
                ("start".to_string(), Seg::Text("Start".into())),
                ("center".to_string(), Seg::Text("Center".into())),
                ("end".to_string(), Seg::Text("End".into())),
                ("space-between".to_string(), Seg::Text("Spread".into())),
            ],
            Some(&main),
            th,
            move |v, _, cx| {
                let _ = m2.update(cx, |this, cx| this.choose("layout.main", json!(v), cx));
            },
        );
        let cross_row = segmented(
            "layout-cross",
            vec![
                ("start".to_string(), Seg::Text("Start".into())),
                ("center".to_string(), Seg::Text("Center".into())),
                ("end".to_string(), Seg::Text("End".into())),
                ("stretch".to_string(), Seg::Text("Stretch".into())),
            ],
            Some(&cross),
            th,
            move |v, _, cx| {
                let _ = m3.update(cx, |this, cx| this.choose("layout.cross", json!(v), cx));
            },
        );
        let mut content = div()
            .flex()
            .flex_col()
            .gap(px(8.0))
            .child(mode_row)
            .child(pair(gap, padding))
            .child(
                div()
                    .flex()
                    .gap(px(6.0))
                    .child(div().flex_1().child(pt))
                    .child(div().flex_1().child(pr))
                    .child(div().flex_1().child(pb))
                    .child(div().flex_1().child(pl)),
            )
            .child(row("Distribute", main_row, th))
            .child(row("Align", cross_row, th));
        if mode == "grid" {
            let cols = self.num(
                "layout.columns",
                Label::Text("C".into()),
                get(&layout, &["columns"]).and_then(Value::as_f64),
                |f| f.range(1.0, 48.0).precision(0).tooltip("Columns"),
                window,
                cx,
            );
            let rg = self.num(
                "layout.rowGap",
                Label::Icon("icons/move-vertical.svg"),
                get(&layout, &["rowGap"])
                    .and_then(Value::as_f64)
                    .or(get(&layout, &["gap"]).and_then(Value::as_f64)),
                |f| {
                    f.range(0.0, 5000.0)
                        .unit("px")
                        .precision(0)
                        .tooltip("Row gap")
                },
                window,
                cx,
            );
            content = content.child(pair(cols, rg));
        } else {
            content = content.child(row(
                "Wrap",
                toggle("layout-wrap", wrap, th, move |v, _, cx| {
                    let _ = m4.update(cx, |this, cx| this.choose("layout.wrap", json!(v), cx));
                }),
                th,
            ));
        }
        let remove = div()
            .id("layout-remove")
            .font_family(SANS)
            .text_size(px(12.0))
            .text_color(th.accent_text)
            .cursor_pointer()
            .child("Remove")
            .on_click(cx.listener(|this, _, _, cx| this.choose("layout.remove", Value::Null, cx)));
        block("Auto-layout", Some(remove.into_any_element()), content, th).into_any_element()
    }
}
