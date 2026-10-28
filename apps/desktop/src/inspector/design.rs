//! Design tab: layer opacity and blend, fills (solid / gradients with stops / image), stroke, corner radius, text
//! styles, image fit / filters / adjustments, shape, QR, chart and table properties, link and alt text; for the page:
//! background, size, unit, bleed and layout grid.

use desyn_core::model::{Design, NodeType};
use gpui::{
    AnyElement, Context, InteractiveElement, IntoElement, ParentElement, SharedString,
    StatefulInteractiveElement, Styled, Window, div, prelude::FluentBuilder, px,
};
use serde_json::{Value, json};

use super::props::{self, Sel, get, n};
use super::{ColorTarget, Edit, Inspector, add_button, below, block, hint, pair};
use crate::ui::components::{icon, icon_button, tip};
use crate::ui::theme::{MONO, SANS, Theme};
use crate::widgets::number::Label;
use crate::widgets::{
    Seg, icon_toggle, input_box, node_icon, node_kind_label, row, segmented, select_button,
};

fn key_index(key: &str, prefix: &str) -> Option<(usize, String)> {
    let rest = key.strip_prefix(prefix)?;
    let (i, field) = rest.split_once('.')?;
    Some((i.parse().ok()?, field.to_string()))
}

fn fills_of(sel: &Sel, i: usize) -> Option<Vec<Value>> {
    let t = *sel.types.get(i)?;
    let path = props::fills_path(t)?;
    Some(
        get(&sel.nodes[i], path)
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default(),
    )
}

/// Sets fills of every selected node via `f(fills) -> new fills`.
fn edit_fills(sel: &Sel, mut f: impl FnMut(&mut Vec<Value>)) -> Vec<desyn_core::model::Op> {
    let mut ops = Vec::new();
    for (i, id) in sel.ids.iter().enumerate() {
        let Some(path) = props::fills_path(sel.types[i]) else {
            continue;
        };
        let mut fills = fills_of(sel, i).unwrap_or_default();
        f(&mut fills);
        if path.len() == 1 {
            ops.push(props::update(id, path[0], Value::Array(fills)));
        } else {
            let mut style = sel.nodes[i].get("style").cloned().unwrap_or(json!({}));
            props::set_in(&mut style, &path[1..], Value::Array(fills));
            ops.push(props::update(id, "style", style));
        }
    }
    ops
}

/// Text style edit: sets `key` on the node style and removes the same override from every run.
fn text_style(sel: &Sel, key: &str, v: Value) -> Vec<desyn_core::model::Op> {
    let mut ops = Vec::new();
    for (i, id) in sel.ids.iter().enumerate() {
        if sel.types[i] != NodeType::Text {
            continue;
        }
        let node = &sel.nodes[i];
        let mut style = node.get("style").cloned().unwrap_or(json!({}));
        props::set_in(&mut style, &[key], v.clone());
        ops.push(props::update(id, "style", style));
        if let Some(runs) = node.get("runs").and_then(Value::as_array) {
            let mut changed = false;
            let runs: Vec<Value> = runs
                .iter()
                .map(|r| {
                    let mut r = r.clone();
                    if let Some(st) = r.get_mut("style").and_then(Value::as_object_mut)
                        && st.remove(key).is_some()
                    {
                        changed = true;
                    }
                    r
                })
                .collect();
            if changed {
                ops.push(props::update(id, "runs", Value::Array(runs)));
            }
        }
    }
    ops
}

fn paragraph(sel: &Sel, key: &str, v: Value) -> Vec<desyn_core::model::Op> {
    sel.ids
        .iter()
        .enumerate()
        .filter(|(i, _)| sel.types[*i] == NodeType::Text)
        .map(|(i, id)| {
            let mut p = sel.nodes[i].get("paragraph").cloned().unwrap_or(json!({}));
            props::set_in(&mut p, &[key], v.clone());
            props::update(id, "paragraph", p)
        })
        .collect()
}

fn image_adjust(sel: &Sel, f: impl Fn(&mut Value)) -> Vec<desyn_core::model::Op> {
    sel.ids
        .iter()
        .enumerate()
        .filter(|(i, _)| sel.types[*i] == NodeType::Image)
        .map(|(i, id)| {
            let mut a = sel.nodes[i]
                .get("adjust")
                .cloned()
                .filter(|v| v.is_object())
                .unwrap_or_else(props::neutral_adjust);
            f(&mut a);
            props::update(id, "adjust", a)
        })
        .collect()
}

/// Numeric fields of the Design tab.
pub(super) fn number(key: &str, v: f64, sel: &Sel, _d: &mut Design) -> Edit {
    let r = |ops, label: &str| Some((ops, label.to_string()));
    match key {
        "layer.opacity" => r(sel.set_all("opacity", n(v.clamp(0.0, 1.0))), "Opacity"),
        "stroke.width" => r(
            sel.set_each("strokes", |node| {
                let mut s = node
                    .get("strokes")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                if s.is_empty() {
                    s.push(props::stroke("#111111", v));
                }
                if let Some(o) = s[0].as_object_mut() {
                    o.insert("width".into(), n(v.max(0.0)));
                }
                Some(Value::Array(s))
            }),
            "Stroke width",
        ),
        "radius.all" => r(
            sel.set_each("cornerRadius", |node| {
                node.get("cornerRadius").map(|_| n(v.max(0.0)))
            }),
            "Corner radius",
        ),
        k if k.starts_with("radius.") => {
            let i: usize = k[7..].parse().ok()?;
            r(
                sel.set_each("cornerRadius", |node| {
                    let mut rr = props::radii(node).unwrap_or([0.0; 4]);
                    rr[i.min(3)] = v.max(0.0);
                    Some(json!([n(rr[0]), n(rr[1]), n(rr[2]), n(rr[3])]))
                }),
                "Corner radius",
            )
        }
        "text.size" => r(
            text_style(sel, "fontSize", n(v.clamp(1.0, 2000.0))),
            "Font size",
        ),
        "text.letterSpacing" => r(text_style(sel, "letterSpacing", n(v)), "Letter spacing"),
        "text.lineHeight" => r(
            paragraph(
                sel,
                "lineHeight",
                json!({ "unit": "percent", "value": n(v.max(10.0)) }),
            ),
            "Line height",
        ),
        "text.spacing" => r(
            paragraph(sel, "spacing", n(v.max(0.0))),
            "Paragraph spacing",
        ),
        "poly.sides" => r(
            sel.set_all("sides", json!(v.round().clamp(3.0, 60.0) as i64)),
            "Sides",
        ),
        "star.points" => r(
            sel.set_all("points", json!(v.round().clamp(3.0, 60.0) as i64)),
            "Points",
        ),
        "star.ratio" => r(
            sel.set_all("innerRatio", n(v.clamp(0.05, 1.0))),
            "Inner radius",
        ),
        "page.w" => r(
            sel.set_all("width", n(v.clamp(1.0, 100_000.0))),
            "Page width",
        ),
        "page.h" => r(
            sel.set_all("height", n(v.clamp(1.0, 100_000.0))),
            "Page height",
        ),
        "page.bleed" => r(sel.set_all("bleed", n(v.max(0.0))), "Bleed"),
        "grid.columns" | "grid.gutter" | "grid.margin" => {
            let field = &key[5..];
            r(
                sel.set_each("grid", |node| {
                    let mut g = node
                        .get("grid")
                        .cloned()
                        .unwrap_or(json!({ "columns": 12, "gutter": 24, "margin": 48 }));
                    let val = if field == "columns" {
                        json!(v.round().clamp(1.0, 48.0) as i64)
                    } else {
                        n(v.max(0.0))
                    };
                    props::set_in(&mut g, &[field], val);
                    Some(g)
                }),
                "Layout grid",
            )
        }
        "chart.fontSize" => r(
            sel.set_path(&["options", "fontSize"], n(v.clamp(4.0, 200.0))),
            "Chart text size",
        ),
        "table.padding" => r(sel.set_all("cellPadding", n(v.max(0.0))), "Cell padding"),
        "table.border" => r(sel.set_all("borderWidth", n(v.max(0.0))), "Border width"),
        k if k.starts_with("img.") => {
            let field = k[4..].to_string();
            r(
                image_adjust(sel, |a| {
                    props::set_in(a, &[&field], n(v));
                }),
                "Adjust image",
            )
        }
        k if k.starts_with("fill.") => {
            let (i, field) = key_index(k, "fill.")?;
            let val = match field.as_str() {
                "opacity" => n(v.clamp(0.0, 1.0)),
                "angle" => n(v.rem_euclid(360.0)),
                _ => return None,
            };
            r(
                edit_fills(sel, |fills| {
                    if let Some(f) = fills.get_mut(i).and_then(Value::as_object_mut) {
                        f.insert(field.clone(), val.clone());
                    }
                }),
                "Fill",
            )
        }
        _ => None,
    }
}

/// Text inputs of the Design tab.
pub(super) fn text(key: &str, text: &str, sel: &Sel, _d: &mut Design) -> Edit {
    let t = text.trim();
    let r = |ops, label: &str| Some((ops, label.to_string()));
    match key {
        "layer.name" if !t.is_empty() => r(sel.set_all("name", json!(t)), "Rename"),
        "layer.link" => {
            if t.is_empty() {
                r(
                    sel.ids
                        .iter()
                        .map(|id| {
                            desyn_core::model::Op::Update(desyn_core::model::UpdateOp {
                                id: id.clone(),
                                set: None,
                                unset: Some(vec!["link".into()]),
                            })
                        })
                        .collect(),
                    "Remove link",
                )
            } else {
                r(sel.set_all("link", json!(t)), "Link")
            }
        }
        "layer.alt" => r(sel.set_all("alt", json!(t)), "Alt text"),
        "qr.data" if !t.is_empty() => r(sel.set_all("data", json!(t)), "QR content"),
        "chart.labels" => {
            let labels: Vec<Value> = t
                .split(',')
                .map(|s| json!(s.trim()))
                .filter(|v| v != &json!(""))
                .collect();
            r(
                sel.set_path(&["data", "labels"], Value::Array(labels)),
                "Chart labels",
            )
        }
        "chart.values" => {
            let vals: Vec<f64> = t
                .split(',')
                .filter_map(|s| s.trim().replace(' ', "").parse().ok())
                .collect();
            if vals.is_empty() {
                return None;
            }
            r(
                sel.set_each("data", |node| {
                    let mut data = node
                        .get("data")
                        .cloned()
                        .unwrap_or(json!({ "labels": [], "series": [] }));
                    let mut series = data
                        .get("series")
                        .and_then(Value::as_array)
                        .cloned()
                        .unwrap_or_default();
                    if series.is_empty() {
                        series.push(json!({ "name": "Series 1", "values": [] }));
                    }
                    if let Some(o) = series[0].as_object_mut() {
                        o.insert("values".into(), json!(vals));
                    }
                    props::set_in(&mut data, &["series"], Value::Array(series));
                    Some(data)
                }),
                "Chart values",
            )
        }
        "chart.unit" => r(sel.set_path(&["options", "unit"], json!(t)), "Chart unit"),
        _ => None,
    }
}

/// Choices (dropdowns, toggles, segmented controls) of the Design tab.
pub(super) fn choice(key: &str, v: &Value, sel: &Sel, _d: &mut Design) -> Edit {
    let r = |ops, label: &str| Some((ops, label.to_string()));
    let s = v.as_str().unwrap_or_default();
    match key {
        "layer.blend" => r(sel.set_all("blend", v.clone()), "Blend mode"),
        "layer.visible" => r(sel.set_all("visible", v.clone()), "Visibility"),
        "layer.locked" => r(sel.set_all("locked", v.clone()), "Lock"),
        "fill.add" => r(
            edit_fills(sel, |fills| {
                let base = fills
                    .last()
                    .and_then(props::fill_color)
                    .unwrap_or_else(|| "#d9d9d9".into());
                fills.push(props::solid(&base));
            }),
            "Add fill",
        ),
        "stroke.add" => r(
            sel.set_each("strokes", |node| {
                let mut s = node
                    .get("strokes")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                if s.is_empty() {
                    s.push(props::stroke("#111111", 2.0));
                }
                Some(Value::Array(s))
            }),
            "Add stroke",
        ),
        "stroke.remove" => r(sel.set_all("strokes", json!([])), "Remove stroke"),
        "stroke.align" | "stroke.dash" | "stroke.cap" => r(
            sel.set_each("strokes", |node| {
                let mut st = node
                    .get("strokes")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                let first = st.first_mut()?.as_object_mut()?;
                match key {
                    "stroke.align" => {
                        first.insert("align".into(), v.clone());
                    }
                    "stroke.cap" => {
                        first.insert("cap".into(), v.clone());
                    }
                    _ => {
                        if s == "solid" {
                            first.remove("dash");
                        } else {
                            let w = first
                                .get("width")
                                .and_then(Value::as_f64)
                                .unwrap_or(2.0)
                                .max(1.0);
                            let dash = if s == "dotted" {
                                json!([0, n(w * 2.0)])
                            } else {
                                json!([n(w * 3.0), n(w * 2.0)])
                            };
                            first.insert("dash".into(), dash);
                            if s == "dotted" {
                                first.insert("cap".into(), json!("round"));
                            }
                        }
                    }
                }
                Some(Value::Array(st))
            }),
            "Stroke",
        ),
        "text.family" => r(text_style(sel, "fontFamily", v.clone()), "Font"),
        "text.weight" => r(text_style(sel, "fontWeight", v.clone()), "Font weight"),
        "text.italic" => r(
            text_style(
                sel,
                "fontStyle",
                json!(if v.as_bool() == Some(true) {
                    "italic"
                } else {
                    "normal"
                }),
            ),
            "Italic",
        ),
        "text.decoration" => r(text_style(sel, "decoration", v.clone()), "Decoration"),
        "text.case" => r(text_style(sel, "textCase", v.clone()), "Text case"),
        "text.align" => r(paragraph(sel, "align", v.clone()), "Align text"),
        "text.list" => r(paragraph(sel, "list", v.clone()), "List"),
        "text.valign" => r(sel.set_all("verticalAlign", v.clone()), "Vertical align"),
        "text.autoResize" => r(sel.set_all("autoResize", v.clone()), "Auto size"),
        "img.fit" => r(sel.set_all("fit", v.clone()), "Image fit"),
        "img.filter" => r(
            image_adjust(sel, |a| {
                if let Some(o) = a.as_object_mut() {
                    if s.is_empty() {
                        o.remove("filter");
                    } else {
                        o.insert("filter".into(), json!(s));
                    }
                }
            }),
            "Filter",
        ),
        "img.reset" => r(
            sel.ids
                .iter()
                .enumerate()
                .filter(|(i, _)| sel.types[*i] == NodeType::Image)
                .map(|(_, id)| {
                    desyn_core::model::Op::Update(desyn_core::model::UpdateOp {
                        id: id.clone(),
                        set: None,
                        unset: Some(vec!["adjust".into()]),
                    })
                })
                .collect(),
            "Reset adjustments",
        ),
        "line.startCap" => r(sel.set_all("startCap", v.clone()), "Line start"),
        "line.endCap" => r(sel.set_all("endCap", v.clone()), "Line end"),
        "qr.ec" => r(
            sel.set_all("errorCorrection", v.clone()),
            "Error correction",
        ),
        "qr.rounded" => r(sel.set_all("rounded", v.clone()), "Rounded modules"),
        "chart.type" => r(sel.set_all("chart", v.clone()), "Chart type"),
        "chart.legend" | "chart.grid" | "chart.showLabels" => {
            let field = match key {
                "chart.legend" => "legend",
                "chart.grid" => "grid",
                _ => "labels",
            };
            r(
                sel.set_path(&["options", field], v.clone()),
                "Chart options",
            )
        }
        "table.header" => r(sel.set_all("header", v.clone()), "Header row"),
        "table.stripe" => r(sel.set_all("stripe", v.clone()), "Striped rows"),
        "page.unit" => r(sel.set_all("unit", v.clone()), "Units"),
        "page.preset" => {
            let p = crate::presets::all().iter().find(|p| p.id == s)?;
            let mut ops = sel.set_all("width", n(p.width));
            ops.extend(sel.set_all("height", n(p.height)));
            ops.extend(sel.set_all("unit", json!(p.unit)));
            r(ops, "Resize page")
        }
        "page.swap" => {
            let (w, h) = (sel.num(&["width"])?, sel.num(&["height"])?);
            let mut ops = sel.set_all("width", n(h));
            ops.extend(sel.set_all("height", n(w)));
            r(ops, "Swap orientation")
        }
        "grid.toggle" => {
            if v.as_bool() == Some(true) {
                r(
                    sel.set_all("grid", json!({ "columns": 12, "gutter": 24, "margin": 48 })),
                    "Layout grid",
                )
            } else {
                r(
                    sel.ids
                        .iter()
                        .map(|id| {
                            desyn_core::model::Op::Update(desyn_core::model::UpdateOp {
                                id: id.clone(),
                                set: None,
                                unset: Some(vec!["grid".into()]),
                            })
                        })
                        .collect(),
                    "Layout grid",
                )
            }
        }
        k if k.starts_with("fill.") => {
            let (i, field) = key_index(k, "fill.")?;
            r(
                edit_fills(sel, |fills| match field.as_str() {
                    "remove" => {
                        if i < fills.len() {
                            fills.remove(i);
                        }
                    }
                    "visible" => {
                        if let Some(f) = fills.get_mut(i).and_then(Value::as_object_mut) {
                            f.insert("visible".into(), v.clone());
                        }
                    }
                    "kind" => {
                        if let Some(f) = fills.get_mut(i) {
                            *f = props::convert_fill(f, s);
                        }
                    }
                    "addStop" => {
                        if let Some(stops) = fills
                            .get_mut(i)
                            .and_then(|f| f.get_mut("stops"))
                            .and_then(Value::as_array_mut)
                        {
                            let last = stops
                                .last()
                                .and_then(|s| s.get("color"))
                                .cloned()
                                .unwrap_or(json!("#ffffff"));
                            stops.push(json!({ "pos": 1, "color": last }));
                            redistribute(stops);
                        }
                    }
                    "removeStop" => {
                        if let Some(stops) = fills
                            .get_mut(i)
                            .and_then(|f| f.get_mut("stops"))
                            .and_then(Value::as_array_mut)
                            && stops.len() > 2
                        {
                            stops.pop();
                            redistribute(stops);
                        }
                    }
                    "reverse" => {
                        if let Some(stops) = fills
                            .get_mut(i)
                            .and_then(|f| f.get_mut("stops"))
                            .and_then(Value::as_array_mut)
                        {
                            stops.reverse();
                            for s in stops.iter_mut() {
                                if let Some(p) = s.get("pos").and_then(Value::as_f64) {
                                    s["pos"] = n(1.0 - p);
                                }
                            }
                        }
                    }
                    _ => {}
                }),
                "Fill",
            )
        }
        _ => None,
    }
}

fn redistribute(stops: &mut [Value]) {
    let k = stops.len().saturating_sub(1).max(1) as f64;
    for (j, s) in stops.iter_mut().enumerate() {
        s["pos"] = n(j as f64 / k);
    }
}

/// Color edits.
pub(super) fn color(target: &ColorTarget, c: &str, sel: &Sel, _d: &mut Design) -> Edit {
    let r = |ops, label: &str| Some((ops, label.to_string()));
    match target {
        ColorTarget::Fill(i) => {
            let i = *i;
            r(
                edit_fills(sel, |fills| {
                    if fills.is_empty() && i == 0 {
                        fills.push(props::solid(c));
                        return;
                    }
                    if let Some(f) = fills.get_mut(i) {
                        if f.get("type").and_then(Value::as_str) == Some("solid")
                            || f.get("type").is_none()
                        {
                            *f = {
                                let mut nf = f.clone();
                                nf["type"] = json!("solid");
                                nf["color"] = json!(c);
                                nf
                            };
                        } else if let Some(stops) = f.get_mut("stops").and_then(Value::as_array_mut)
                            && let Some(s0) = stops.first_mut()
                        {
                            s0["color"] = json!(c);
                        }
                    }
                }),
                "Fill color",
            )
        }
        ColorTarget::Stop { fill, stop } => r(
            edit_fills(sel, |fills| {
                if let Some(s) = fills
                    .get_mut(*fill)
                    .and_then(|f| f.get_mut("stops"))
                    .and_then(Value::as_array_mut)
                    .and_then(|s| s.get_mut(*stop))
                {
                    s["color"] = json!(c);
                }
            }),
            "Gradient color",
        ),
        ColorTarget::Stroke => r(
            sel.set_each("strokes", |node| {
                let mut s = node
                    .get("strokes")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                if s.is_empty() {
                    s.push(props::stroke(c, 2.0));
                } else {
                    s[0]["fills"] = json!([props::solid(c)]);
                }
                Some(Value::Array(s))
            }),
            "Stroke color",
        ),
        ColorTarget::QrFg => r(sel.set_all("fg", json!(c)), "QR color"),
        ColorTarget::QrBg => r(sel.set_all("bg", json!(c)), "QR background"),
        ColorTarget::ChartText => r(
            sel.set_path(&["options", "textColor"], json!(c)),
            "Chart text color",
        ),
        ColorTarget::ChartSeries(i) => r(
            sel.set_each("options", |node| {
                let mut o = node.get("options").cloned().unwrap_or(json!({}));
                let mut pal = o
                    .get("palette")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                while pal.len() <= *i {
                    pal.push(json!("#ffb02e"));
                }
                pal[*i] = json!(c);
                o["palette"] = Value::Array(pal);
                Some(o)
            }),
            "Chart colors",
        ),
        ColorTarget::Highlight => r(text_style(sel, "highlight", json!(c)), "Highlight"),
        ColorTarget::TableBorder => r(sel.set_all("borderColor", json!(c)), "Border color"),
        ColorTarget::Effect(_) => None,
    }
}

const WEIGHTS: &[(i64, &str)] = &[
    (100, "Thin"),
    (200, "Extra light"),
    (300, "Light"),
    (400, "Regular"),
    (500, "Medium"),
    (600, "Semibold"),
    (700, "Bold"),
    (800, "Extra bold"),
    (900, "Black"),
];

impl Inspector {
    pub(super) fn design_tab(
        &mut self,
        sel: &Sel,
        th: &Theme,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let mut col = div().flex().flex_col();
        col = col.child(self.header(sel, th, window, cx));
        if sel.is_page {
            col = col.child(self.page_sections(sel, th, window, cx));
            return col.into_any_element();
        }
        // Layer: opacity + blend.
        let opacity = self.num(
            "layer.opacity",
            Label::Icon("icons/blend.svg"),
            sel.num(&["opacity"]),
            |f| {
                f.range(0.0, 1.0)
                    .display_scale(100.0)
                    .unit("%")
                    .precision(0)
                    .tooltip("Opacity")
            },
            window,
            cx,
        );
        let blend = sel.str(&["blend"]).unwrap_or_default();
        let blend_label = props::BLEND_MODES
            .iter()
            .find(|(k, _)| *k == blend)
            .map(|(_, l)| l.to_string())
            .unwrap_or_else(|| {
                if sel.nodes.len() > 1 {
                    "Mixed".into()
                } else {
                    "Normal".into()
                }
            });
        let blend_btn = select_button("blend", blend_label, th).on_click(cx.listener(
            move |this, e: &gpui::ClickEvent, window, cx| {
                let cur = Value::String(blend.clone());
                let opts = props::BLEND_MODES
                    .iter()
                    .map(|(k, l)| (json!(k), l.to_string()))
                    .collect();
                this.menu("layer.blend", opts, Some(&cur), below(e), window, cx);
            },
        ));
        col = col.child(block("Layer", None, pair(opacity, blend_btn), th));

        let t0 = sel.types[0];
        if sel.types.iter().all(|t| props::fills_path(*t).is_some()) {
            col = col.child(self.fills_section(sel, th, window, cx));
        }
        if sel.all(NodeType::Text) {
            col = col.child(self.text_section(sel, th, window, cx));
        }
        if sel.types.iter().all(|t| props::has_stroke(*t)) {
            col = col.child(self.stroke_section(sel, th, window, cx));
        }
        if sel.types.iter().all(|t| props::has_radius(*t)) {
            col = col.child(self.radius_section(sel, th, window, cx));
        }
        if sel.all(NodeType::Image) {
            col = col.child(self.image_section(sel, th, window, cx));
        }
        if sel.all(NodeType::Polygon) {
            let sides = self.num(
                "poly.sides",
                Label::Text("N".into()),
                sel.num(&["sides"]),
                |f| f.range(3.0, 60.0).precision(0).tooltip("Sides"),
                window,
                cx,
            );
            col = col.child(block("Polygon", None, row("Sides", sides, th), th));
        }
        if sel.all(NodeType::Star) {
            let pts = self.num(
                "star.points",
                Label::Text("N".into()),
                sel.num(&["points"]),
                |f| f.range(3.0, 60.0).precision(0).tooltip("Points"),
                window,
                cx,
            );
            let ratio = self.num(
                "star.ratio",
                Label::Text("R".into()),
                sel.num(&["innerRatio"]),
                |f| {
                    f.range(0.05, 1.0)
                        .display_scale(100.0)
                        .unit("%")
                        .precision(0)
                        .tooltip("Inner radius")
                },
                window,
                cx,
            );
            col = col.child(block("Star", None, pair(pts, ratio), th));
        }
        if sel.all(NodeType::Line) {
            col = col.child(self.line_section(sel, th, cx));
        }
        if sel.all(NodeType::Qr) {
            col = col.child(self.qr_section(sel, th, window, cx));
        }
        if sel.all(NodeType::Chart) {
            col = col.child(self.chart_section(sel, th, window, cx));
        }
        if sel.all(NodeType::Table) {
            col = col.child(self.table_section(sel, th, window, cx));
        }
        if sel.nodes.len() == 1 {
            let link = sel.str(&["link"]).unwrap_or_default();
            let alt = sel.str(&["alt"]).unwrap_or_default();
            let link_f = self.text("layer.link", "https:// or page link", &link, window, cx);
            let mut content =
                div()
                    .flex()
                    .flex_col()
                    .gap(px(8.0))
                    .child(row("Link", input_box(link_f, th), th));
            if matches!(
                t0,
                NodeType::Image | NodeType::Svg | NodeType::Chart | NodeType::Qr | NodeType::Video
            ) {
                let alt_f = self.text(
                    "layer.alt",
                    "Describe it for screen readers",
                    &alt,
                    window,
                    cx,
                );
                content = content.child(row("Alt text", input_box(alt_f, th), th));
            }
            col = col.child(block("Link & accessibility", None, content, th));
        }
        col.into_any_element()
    }

    fn header(
        &mut self,
        sel: &Sel,
        th: &Theme,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let t = sel.types.first().copied().unwrap_or(NodeType::Page);
        let mixed = sel.types.iter().any(|x| *x != t);
        let title = if sel.nodes.len() > 1 {
            format!("{} layers", sel.nodes.len())
        } else {
            sel.str(&["name"])
                .filter(|n| !n.is_empty())
                .unwrap_or_else(|| node_kind_label(t).to_string())
        };
        let kind = if mixed {
            "Mixed selection".to_string()
        } else {
            node_kind_label(t).to_string()
        };
        let kind = match (sel.single(), sel.num(&["width"]), sel.num(&["height"])) {
            (Some(_), Some(w), Some(h)) => format!(
                "{kind} · {} × {}",
                crate::widgets::number::format(w, 0),
                crate::widgets::number::format(h, 0)
            ),
            _ => kind,
        };
        let visible = sel.flag(&["visible"], true).unwrap_or(true);
        let locked = sel.flag(&["locked"], false).unwrap_or(false);
        let mut h = div()
            .pt(px(10.0))
            .pb(px(12.0))
            .flex()
            .items_center()
            .gap(px(10.0))
            .child(
                div()
                    .size(px(32.0))
                    .flex_none()
                    .flex()
                    .items_center()
                    .justify_center()
                    .rounded(px(9.0))
                    .bg(th.surface2)
                    .border_1()
                    .border_color(th.border_subtle)
                    .child(icon(node_icon(t), 15.0, th.accent_text)),
            );
        if sel.nodes.len() == 1 && !sel.is_page {
            let name = self.text("layer.name", "Layer name", &title, window, cx);
            h = h.child(
                div()
                    .flex_1()
                    .min_w(px(0.0))
                    .flex()
                    .flex_col()
                    .child(div().h(px(22.0)).flex().items_center().child(name))
                    .child(
                        div()
                            .font_family(SANS)
                            .text_size(px(11.0))
                            .text_color(th.faint)
                            .child(kind),
                    ),
            );
        } else {
            h = h.child(
                div()
                    .flex_1()
                    .min_w(px(0.0))
                    .flex()
                    .flex_col()
                    .child(
                        div()
                            .truncate()
                            .font_family(SANS)
                            .text_size(px(13.5))
                            .text_color(th.fg)
                            .child(title),
                    )
                    .child(
                        div()
                            .font_family(SANS)
                            .text_size(px(11.0))
                            .text_color(th.faint)
                            .child(kind),
                    ),
            );
        }
        if !sel.is_page {
            h = h
                .child(
                    icon_toggle(
                        "vis",
                        if visible {
                            "icons/eye.svg"
                        } else {
                            "icons/eye-off.svg"
                        },
                        !visible,
                        if visible { "Hide" } else { "Show" },
                        th,
                    )
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.choose("layer.visible", json!(!visible), cx)
                    })),
                )
                .child(
                    icon_toggle(
                        "lock",
                        if locked {
                            "icons/lock.svg"
                        } else {
                            "icons/lock-open.svg"
                        },
                        locked,
                        if locked { "Unlock" } else { "Lock" },
                        th,
                    )
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.choose("layer.locked", json!(!locked), cx)
                    })),
                );
        }
        h.into_any_element()
    }

    fn fills_section(
        &mut self,
        sel: &Sel,
        th: &Theme,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let fills: Vec<Value> = if sel.nodes.len() == 1
            || sel
                .common(props::fills_path(sel.types[0]).unwrap_or(&["fills"]))
                .is_some()
        {
            fills_of(sel, 0).unwrap_or_default()
        } else {
            Vec::new()
        };
        let mixed = sel.nodes.len() > 1
            && fills.is_empty()
            && (0..sel.nodes.len()).any(|i| !fills_of(sel, i).unwrap_or_default().is_empty());
        let title = if sel.is_page {
            "Background"
        } else if sel.all(NodeType::Text) {
            "Text color"
        } else {
            "Fill"
        };
        let add = add_button("fill", "Add fill", th)
            .on_click(cx.listener(|this, _, _, cx| this.choose("fill.add", Value::Null, cx)));
        let mut list = div().flex().flex_col().gap(px(8.0));
        if mixed {
            list = list.child(hint(
                "The selected layers have different fills. Pick a color to set them all.",
                th,
            ));
            list = list.child(self.color_button("fill-mixed", ColorTarget::Fill(0), None, th, cx));
        }
        for (i, f) in fills.iter().enumerate().rev() {
            let kind = f
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or("solid")
                .to_string();
            let visible = f.get("visible").and_then(Value::as_bool).unwrap_or(true);
            let kind_label = match kind.as_str() {
                "solid" => "Solid",
                "linear" => "Linear",
                "radial" => "Radial",
                "conic" => "Conic",
                "image" => "Image",
                _ => "Fill",
            };
            let k2 = kind.clone();
            let kind_btn =
                select_button(SharedString::from(format!("fill-kind-{i}")), kind_label, th)
                    .w(px(86.0))
                    .flex_none()
                    .on_click(cx.listener(move |this, e: &gpui::ClickEvent, window, cx| {
                        let opts = vec![
                            (json!("solid"), "Solid".to_string()),
                            (json!("linear"), "Linear gradient".to_string()),
                            (json!("radial"), "Radial gradient".to_string()),
                            (json!("conic"), "Conic gradient".to_string()),
                        ];
                        this.menu(
                            &format!("fill.{i}.kind"),
                            opts,
                            Some(&json!(k2.clone())),
                            below(e),
                            window,
                            cx,
                        );
                    }));
            let opacity = self.num(
                &format!("fill.{i}.opacity"),
                Label::Text("%".into()),
                Some(f.get("opacity").and_then(Value::as_f64).unwrap_or(1.0)),
                |f| {
                    f.range(0.0, 1.0)
                        .display_scale(100.0)
                        .precision(0)
                        .tooltip("Fill opacity")
                },
                window,
                cx,
            );
            let main: AnyElement = if kind == "image" {
                div()
                    .flex_1()
                    .h(px(28.0))
                    .px(px(8.0))
                    .flex()
                    .items_center()
                    .gap(px(6.0))
                    .rounded(px(6.0))
                    .bg(th.surface2)
                    .child(icon("icons/image.svg", 13.0, th.muted))
                    .child(
                        div()
                            .font_family(SANS)
                            .text_size(px(12.0))
                            .text_color(th.muted)
                            .child("Image fill"),
                    )
                    .into_any_element()
            } else {
                self.color_button(
                    &format!("fill-{i}"),
                    ColorTarget::Fill(i),
                    props::fill_color(f),
                    th,
                    cx,
                )
            };
            let row_el = div()
                .flex()
                .items_center()
                .gap(px(6.0))
                .when(!visible, |d| d.opacity(0.5))
                .child(div().flex_1().min_w(px(0.0)).child(main))
                .child(div().w(px(58.0)).flex_none().child(opacity))
                .child(
                    icon_toggle(
                        SharedString::from(format!("fill-vis-{i}")),
                        if visible {
                            "icons/eye.svg"
                        } else {
                            "icons/eye-off.svg"
                        },
                        false,
                        if visible { "Hide fill" } else { "Show fill" },
                        th,
                    )
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.choose(&format!("fill.{i}.visible"), json!(!visible), cx)
                    })),
                )
                .child(
                    icon_button(
                        SharedString::from(format!("fill-rm-{i}")),
                        "icons/minus.svg",
                        28.0,
                        false,
                        th,
                    )
                    .tooltip(tip("Remove fill", None))
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.choose(&format!("fill.{i}.remove"), Value::Null, cx)
                    })),
                );
            list = list.child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(6.0))
                    .child(
                        div()
                            .flex()
                            .gap(px(6.0))
                            .child(kind_btn)
                            .child(div().flex_1()),
                    )
                    .child(row_el),
            );
            if matches!(kind.as_str(), "linear" | "radial" | "conic") {
                list = list.child(self.gradient_editor(i, f, th, window, cx));
            }
        }
        if fills.is_empty() && !mixed {
            list = list.child(hint(
                if sel.all(NodeType::Text) {
                    "No color: the text is invisible."
                } else {
                    "No fill. Add one with +."
                },
                th,
            ));
        }
        block(title, Some(add.into_any_element()), list, th).into_any_element()
    }

    fn gradient_editor(
        &mut self,
        i: usize,
        f: &Value,
        th: &Theme,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let stops: Vec<(f64, String)> = f
            .get("stops")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .map(|s| {
                        (
                            s.get("pos").and_then(Value::as_f64).unwrap_or(0.0),
                            s.get("color")
                                .and_then(Value::as_str)
                                .unwrap_or("#000000")
                                .to_string(),
                        )
                    })
                    .collect()
            })
            .unwrap_or_default();
        let a = stops
            .first()
            .map(|s| crate::widgets::hsla(&s.1))
            .unwrap_or(th.fg);
        let b = stops
            .last()
            .map(|s| crate::widgets::hsla(&s.1))
            .unwrap_or(th.fg);
        let bar = div()
            .h(px(14.0))
            .rounded(px(7.0))
            .border_1()
            .border_color(th.border)
            .bg(gpui::linear_gradient(
                90.0,
                gpui::linear_color_stop(a, 0.0),
                gpui::linear_color_stop(b, 1.0),
            ));
        let mut col = div()
            .flex()
            .flex_col()
            .gap(px(6.0))
            .pl(px(8.0))
            .border_l_2()
            .border_color(th.border_subtle)
            .child(bar);
        for (j, (pos, c)) in stops.iter().enumerate() {
            col = col.child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(6.0))
                    .child(
                        div()
                            .w(px(36.0))
                            .font_family(MONO)
                            .text_size(px(11.0))
                            .text_color(th.faint)
                            .child(format!("{}%", (pos * 100.0).round())),
                    )
                    .child(div().flex_1().child(self.color_button(
                        &format!("stop-{i}-{j}"),
                        ColorTarget::Stop { fill: i, stop: j },
                        Some(c.clone()),
                        th,
                        cx,
                    ))),
            );
        }
        let mut tools = div().flex().items_center().gap(px(4.0));
        if f.get("type").and_then(Value::as_str) == Some("linear")
            || f.get("type").and_then(Value::as_str) == Some("conic")
        {
            let angle = self.num(
                &format!("fill.{i}.angle"),
                Label::Icon("icons/rotate-cw.svg"),
                f.get("angle").and_then(Value::as_f64),
                |f| {
                    f.range(-3600.0, 3600.0)
                        .unit("°")
                        .precision(0)
                        .tooltip("Angle")
                },
                window,
                cx,
            );
            tools = tools.child(div().w(px(90.0)).child(angle));
        }
        tools = tools
            .child(div().flex_1())
            .child(
                icon_button(
                    SharedString::from(format!("stop-add-{i}")),
                    "icons/plus.svg",
                    28.0,
                    false,
                    th,
                )
                .tooltip(tip("Add color stop", None))
                .on_click(cx.listener(move |this, _, _, cx| {
                    this.choose(&format!("fill.{i}.addStop"), Value::Null, cx)
                })),
            )
            .child(
                icon_button(
                    SharedString::from(format!("stop-rm-{i}")),
                    "icons/minus.svg",
                    28.0,
                    false,
                    th,
                )
                .tooltip(tip("Remove last stop", None))
                .on_click(cx.listener(move |this, _, _, cx| {
                    this.choose(&format!("fill.{i}.removeStop"), Value::Null, cx)
                })),
            )
            .child(
                icon_button(
                    SharedString::from(format!("stop-rev-{i}")),
                    "icons/flip-horizontal-2.svg",
                    28.0,
                    false,
                    th,
                )
                .tooltip(tip("Reverse", None))
                .on_click(cx.listener(move |this, _, _, cx| {
                    this.choose(&format!("fill.{i}.reverse"), Value::Null, cx)
                })),
            );
        col.child(tools).into_any_element()
    }

    fn stroke_section(
        &mut self,
        sel: &Sel,
        th: &Theme,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let has = sel.nodes.iter().any(|n| {
            n.get("strokes")
                .and_then(Value::as_array)
                .is_some_and(|a| !a.is_empty())
        });
        let color = sel
            .common(&["strokes", "0", "fills", "0"])
            .and_then(|f| props::fill_color(&f));
        if !has {
            let add = add_button("stroke", "Add stroke", th)
                .on_click(cx.listener(|this, _, _, cx| this.choose("stroke.add", Value::Null, cx)));
            return block(
                "Stroke",
                Some(add.into_any_element()),
                hint("No stroke.", th),
                th,
            )
            .into_any_element();
        }
        let width = self.num(
            "stroke.width",
            Label::Icon("icons/minus.svg"),
            sel.num(&["strokes", "0", "width"]),
            |f| {
                f.range(0.0, 1000.0)
                    .unit("px")
                    .precision(1)
                    .tooltip("Stroke width")
            },
            window,
            cx,
        );
        let align = sel.str(&["strokes", "0", "align"]);
        let dash = sel.common(&["strokes", "0", "dash"]);
        let style = match &dash {
            None => {
                if sel.nodes.len() > 1 {
                    None
                } else {
                    Some("solid".to_string())
                }
            }
            Some(Value::Array(a)) if a.first().and_then(Value::as_f64) == Some(0.0) => {
                Some("dotted".into())
            }
            Some(_) => Some("dashed".into()),
        };
        let remove = icon_button("stroke-rm", "icons/minus.svg", 24.0, false, th)
            .tooltip(tip("Remove stroke", None))
            .on_click(cx.listener(|this, _, _, cx| this.choose("stroke.remove", Value::Null, cx)));
        let me = cx.entity().downgrade();
        let me2 = me.clone();
        let content = div()
            .flex()
            .flex_col()
            .gap(px(8.0))
            .child(pair(
                self.color_button("stroke", ColorTarget::Stroke, color, th, cx),
                width,
            ))
            .when(!sel.all(NodeType::Line), |d| {
                d.child(segmented(
                    "stroke-align",
                    vec![
                        ("inside".to_string(), Seg::Text("Inside".into())),
                        ("center".to_string(), Seg::Text("Center".into())),
                        ("outside".to_string(), Seg::Text("Outside".into())),
                    ],
                    align.as_ref(),
                    th,
                    move |v, _, cx| {
                        let _ = me.update(cx, |this, cx| this.choose("stroke.align", json!(v), cx));
                    },
                ))
            })
            .child(segmented(
                "stroke-dash",
                vec![
                    ("solid".to_string(), Seg::Text("Solid".into())),
                    ("dashed".to_string(), Seg::Text("Dashed".into())),
                    ("dotted".to_string(), Seg::Text("Dotted".into())),
                ],
                style.as_ref(),
                th,
                move |v, _, cx| {
                    let _ = me2.update(cx, |this, cx| this.choose("stroke.dash", json!(v), cx));
                },
            ));
        block("Stroke", Some(remove.into_any_element()), content, th).into_any_element()
    }

    fn radius_section(
        &mut self,
        sel: &Sel,
        th: &Theme,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let radii: Vec<[f64; 4]> = sel.nodes.iter().filter_map(props::radii).collect();
        let uniform = radii.len() == sel.nodes.len()
            && radii
                .iter()
                .all(|r| r.iter().all(|x| (x - r[0]).abs() < 1e-9))
            && radii.iter().all(|r| (r[0] - radii[0][0]).abs() < 1e-9);
        let split = self.radius_split || (!uniform && sel.nodes.len() == 1);
        let toggle = crate::widgets::icon_toggle(
            "radius-split",
            "icons/square-round-corner.svg",
            split,
            "Independent corners",
            th,
        )
        .on_click(cx.listener(|this, _, _, cx| {
            this.radius_split = !this.radius_split;
            cx.notify();
        }));
        let content: AnyElement = if split {
            let r = radii.first().copied().unwrap_or([0.0; 4]);
            let names = ["↖", "↗", "↘", "↙"];
            let mut fields = Vec::new();
            for (k, nm) in names.iter().enumerate() {
                let v = if sel.nodes.len() == 1 {
                    Some(r[k])
                } else {
                    None
                };
                fields.push(self.num(
                    &format!("radius.{k}"),
                    Label::Text((*nm).into()),
                    v,
                    |f| f.range(0.0, 10_000.0).unit("px").precision(1),
                    window,
                    cx,
                ));
            }
            let mut it = fields.into_iter();
            let (a, b, c, d) = (
                it.next().unwrap(),
                it.next().unwrap(),
                it.next().unwrap(),
                it.next().unwrap(),
            );
            div()
                .flex()
                .flex_col()
                .gap(px(8.0))
                .child(pair(a, b))
                .child(pair(d, c))
                .into_any_element()
        } else {
            let v = uniform.then(|| radii.first().map(|r| r[0])).flatten();
            self.num(
                "radius.all",
                Label::Icon("icons/square-round-corner.svg"),
                v,
                |f| {
                    f.range(0.0, 10_000.0)
                        .unit("px")
                        .precision(1)
                        .tooltip("Corner radius")
                },
                window,
                cx,
            )
            .into_any_element()
        };
        block(
            "Corner radius",
            Some(toggle.into_any_element()),
            content,
            th,
        )
        .into_any_element()
    }

    fn text_section(
        &mut self,
        sel: &Sel,
        th: &Theme,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let family = sel.str(&["style", "fontFamily"]);
        let weight = sel.num(&["style", "fontWeight"]);
        let italic = sel.str(&["style", "fontStyle"]).as_deref() == Some("italic");
        let deco = sel
            .str(&["style", "decoration"])
            .unwrap_or_else(|| "none".into());
        let align = sel.str(&["paragraph", "align"]);
        let valign = sel.str(&["verticalAlign"]);
        let case = sel
            .str(&["style", "textCase"])
            .unwrap_or_else(|| "none".into());
        let list = sel
            .str(&["paragraph", "list"])
            .unwrap_or_else(|| "none".into());
        let auto = sel.str(&["autoResize"]);
        let lh = sel.common(&["paragraph", "lineHeight"]);
        let lh_val = lh
            .as_ref()
            .and_then(|l| match l.get("unit").and_then(Value::as_str) {
                Some("percent") => l.get("value").and_then(Value::as_f64),
                Some("auto") => Some(120.0),
                _ => None,
            });
        let fam_label = family.clone().unwrap_or_else(|| "Mixed".into());
        let loading = family
            .as_deref()
            .is_some_and(|f| crate::widgets::fonts::FontLibrary::is_loading(f, cx));
        let fam_preview: SharedString = family
            .clone()
            .filter(|f| crate::widgets::fonts::FontLibrary::previewable(f, cx))
            .map(SharedString::from)
            .unwrap_or_else(|| SANS.into());
        let fam_cur = family.clone().unwrap_or_default();
        let font_btn = div()
            .id("font-family")
            .h(px(34.0))
            .px(px(10.0))
            .flex()
            .items_center()
            .gap(px(8.0))
            .rounded(px(8.0))
            .bg(th.surface2)
            .border_1()
            .border_color(th.border_subtle)
            .cursor_pointer()
            .hover({
                let b = th.border;
                move |s| s.border_color(b)
            })
            .child(
                div()
                    .flex_1()
                    .truncate()
                    .font_family(fam_preview)
                    .text_size(px(15.0))
                    .text_color(th.fg)
                    .child(fam_label),
            )
            .when(loading, |d| {
                d.child(crate::widgets::spinner("font-loading", 9.0, th))
            })
            .child(icon("icons/chevron-down.svg", 12.0, th.faint))
            .on_click(cx.listener(move |this, e: &gpui::ClickEvent, window, cx| {
                let p = e.position();
                this.open_font(
                    &fam_cur,
                    gpui::point(p.x - px(300.0), p.y - px(20.0)),
                    window,
                    cx,
                );
            }));
        let weight_label = weight
            .and_then(|w| {
                WEIGHTS
                    .iter()
                    .min_by_key(|(x, _)| (*x - w.round() as i64).abs())
                    .map(|(_, l)| l.to_string())
            })
            .unwrap_or_else(|| "Mixed".into());
        let weight_btn = select_button("font-weight", weight_label, th).on_click(cx.listener(
            move |this, e: &gpui::ClickEvent, window, cx| {
                let opts = WEIGHTS
                    .iter()
                    .map(|(w, l)| (json!(w), l.to_string()))
                    .collect();
                this.menu(
                    "text.weight",
                    opts,
                    weight.map(|w| json!(w.round() as i64)).as_ref(),
                    below(e),
                    window,
                    cx,
                );
            },
        ));
        let size = self.num(
            "text.size",
            Label::Text("Aa".into()),
            sel.num(&["style", "fontSize"]),
            |f| {
                f.range(1.0, 2000.0)
                    .unit("px")
                    .precision(1)
                    .tooltip("Font size")
            },
            window,
            cx,
        );
        let line = self.num(
            "text.lineHeight",
            Label::Icon("icons/chevrons-up-down.svg"),
            lh_val,
            |f| {
                f.range(10.0, 1000.0)
                    .unit("%")
                    .precision(0)
                    .tooltip("Line height")
            },
            window,
            cx,
        );
        let spacing = self.num(
            "text.letterSpacing",
            Label::Icon("icons/move-horizontal.svg"),
            sel.num(&["style", "letterSpacing"]),
            |f| {
                f.range(-0.5, 2.0)
                    .display_scale(100.0)
                    .unit("%")
                    .step(1.0)
                    .precision(1)
                    .tooltip("Letter spacing")
            },
            window,
            cx,
        );
        let para = self.num(
            "text.spacing",
            Label::Icon("icons/pilcrow.svg"),
            sel.num(&["paragraph", "spacing"]),
            |f| {
                f.range(0.0, 1000.0)
                    .unit("px")
                    .precision(0)
                    .tooltip("Paragraph spacing")
            },
            window,
            cx,
        );
        let bold = weight.is_some_and(|w| w >= 600.0);
        let me = cx.entity().downgrade();
        let (m1, m2, m3) = (me.clone(), me.clone(), me.clone());
        let style_row = div()
            .flex()
            .items_center()
            .gap(px(2.0))
            .child(
                icon_toggle("t-bold", "icons/bold.svg", bold, "Bold", th).on_click(cx.listener(
                    move |this, _, _, cx| {
                        this.choose("text.weight", json!(if bold { 400 } else { 700 }), cx)
                    },
                )),
            )
            .child(
                icon_toggle("t-italic", "icons/italic.svg", italic, "Italic", th).on_click(
                    cx.listener(move |this, _, _, cx| {
                        this.choose("text.italic", json!(!italic), cx)
                    }),
                ),
            )
            .child({
                let on = deco == "underline";
                icon_toggle("t-underline", "icons/underline.svg", on, "Underline", th).on_click(
                    cx.listener(move |this, _, _, cx| {
                        this.choose(
                            "text.decoration",
                            json!(if on { "none" } else { "underline" }),
                            cx,
                        )
                    }),
                )
            })
            .child({
                let on = deco == "strikethrough";
                icon_toggle(
                    "t-strike",
                    "icons/strikethrough.svg",
                    on,
                    "Strikethrough",
                    th,
                )
                .on_click(cx.listener(move |this, _, _, cx| {
                    this.choose(
                        "text.decoration",
                        json!(if on { "none" } else { "strikethrough" }),
                        cx,
                    )
                }))
            })
            .child(div().flex_1())
            .child({
                let cur = case.clone();
                select_button(
                    "t-case",
                    match case.as_str() {
                        "upper" => "AA",
                        "lower" => "aa",
                        "title" => "Aa",
                        _ => "—",
                    },
                    th,
                )
                .w(px(64.0))
                .tooltip(tip("Letter case", None))
                .on_click(cx.listener(
                    move |this, e: &gpui::ClickEvent, window, cx| {
                        let opts = vec![
                            (json!("none"), "As typed".to_string()),
                            (json!("upper"), "UPPERCASE".to_string()),
                            (json!("lower"), "lowercase".to_string()),
                            (json!("title"), "Title Case".to_string()),
                        ];
                        this.menu(
                            "text.case",
                            opts,
                            Some(&json!(cur.clone())),
                            below(e),
                            window,
                            cx,
                        );
                    },
                ))
            })
            .child({
                let cur = list.clone();
                icon_toggle("t-list", "icons/list.svg", list != "none", "List", th).on_click(
                    cx.listener(move |this, e: &gpui::ClickEvent, window, cx| {
                        let opts = vec![
                            (json!("none"), "No list".to_string()),
                            (json!("bullet"), "• Bulleted".to_string()),
                            (json!("number"), "1. Numbered".to_string()),
                        ];
                        this.menu(
                            "text.list",
                            opts,
                            Some(&json!(cur.clone())),
                            below(e),
                            window,
                            cx,
                        );
                    }),
                )
            });
        let align_row = segmented(
            "t-align",
            vec![
                (
                    "left".to_string(),
                    Seg::Icon("icons/text-align-start.svg", "Align left".into()),
                ),
                (
                    "center".to_string(),
                    Seg::Icon("icons/text-align-center.svg", "Center".into()),
                ),
                (
                    "right".to_string(),
                    Seg::Icon("icons/text-align-end.svg", "Align right".into()),
                ),
                (
                    "justify".to_string(),
                    Seg::Icon("icons/text-align-justify.svg", "Justify".into()),
                ),
            ],
            align.as_ref(),
            th,
            move |v, _, cx| {
                let _ = m1.update(cx, |this, cx| this.choose("text.align", json!(v), cx));
            },
        );
        let valign_row = segmented(
            "t-valign",
            vec![
                (
                    "top".to_string(),
                    Seg::Icon("icons/arrow-up-to-line.svg", "Top".into()),
                ),
                (
                    "middle".to_string(),
                    Seg::Icon("icons/fold-vertical.svg", "Middle".into()),
                ),
                (
                    "bottom".to_string(),
                    Seg::Icon("icons/arrow-down-to-line.svg", "Bottom".into()),
                ),
            ],
            valign.as_ref(),
            th,
            move |v, _, cx| {
                let _ = m2.update(cx, |this, cx| this.choose("text.valign", json!(v), cx));
            },
        );
        let auto_row = segmented(
            "t-auto",
            vec![
                ("width".to_string(), Seg::Text("Auto width".into())),
                ("height".to_string(), Seg::Text("Auto height".into())),
                ("none".to_string(), Seg::Text("Fixed".into())),
            ],
            auto.as_ref(),
            th,
            move |v, _, cx| {
                let _ = m3.update(cx, |this, cx| this.choose("text.autoResize", json!(v), cx));
            },
        );
        let highlight = sel.str(&["style", "highlight"]);
        let content = div()
            .flex()
            .flex_col()
            .gap(px(8.0))
            .child(font_btn)
            .child(pair(weight_btn, size))
            .child(pair(line, spacing))
            .child(style_row)
            .child(pair(align_row, valign_row))
            .child(auto_row)
            .child(pair(
                para,
                self.color_button("highlight", ColorTarget::Highlight, highlight, th, cx),
            ));
        block("Text", None, content, th).into_any_element()
    }

    fn image_section(
        &mut self,
        sel: &Sel,
        th: &Theme,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let fit = sel.str(&["fit"]);
        let filter = sel.str(&["adjust", "filter"]).unwrap_or_default();
        let me = cx.entity().downgrade();
        let fit_row = segmented(
            "img-fit",
            vec![
                ("fill".to_string(), Seg::Text("Fill".into())),
                ("fit".to_string(), Seg::Text("Fit".into())),
                ("crop".to_string(), Seg::Text("Crop".into())),
                ("tile".to_string(), Seg::Text("Tile".into())),
            ],
            fit.as_ref(),
            th,
            move |v, _, cx| {
                let _ = me.update(cx, |this, cx| this.choose("img.fit", json!(v), cx));
            },
        );
        let mut chips = div().flex().flex_wrap().gap(px(6.0));
        for (id, label) in std::iter::once(&("", "None")).chain(props::FILTERS.iter()) {
            let active = filter == *id;
            let s3 = th.surface3;
            chips = chips.child(
                div()
                    .id(SharedString::from(format!("filter-{label}")))
                    .px(px(9.0))
                    .h(px(26.0))
                    .flex()
                    .items_center()
                    .rounded(px(999.0))
                    .border_1()
                    .border_color(if active { th.accent } else { th.border_subtle })
                    .when(active, |d| d.bg(th.accent_soft))
                    .when(!active, move |d| d.hover(move |s| s.bg(s3)))
                    .cursor_pointer()
                    .font_family(SANS)
                    .text_size(px(11.5))
                    .text_color(if active { th.accent_text } else { th.muted })
                    .child(label.to_string())
                    .on_click(
                        cx.listener(move |this, _, _, cx| this.choose("img.filter", json!(id), cx)),
                    ),
            );
        }
        let mut adj = div().flex().flex_col().gap(px(6.0));
        for (key, label, min, max) in props::ADJUSTMENTS {
            let v = sel
                .num(&["adjust", key])
                .or_else(|| sel.common(&["adjust"]).is_none().then_some(0.0));
            let scale = if *key == "hue" || *key == "blur" {
                1.0
            } else {
                100.0
            };
            let unit = if *key == "hue" {
                "°"
            } else if *key == "blur" {
                "px"
            } else {
                ""
            };
            let f = self.num(
                &format!("img.{key}"),
                Label::Text("".into()),
                v,
                |f| {
                    f.range(*min, *max)
                        .display_scale(scale)
                        .unit(unit)
                        .precision(0)
                },
                window,
                cx,
            );
            adj = adj.child(row(label, f, th));
        }
        let reset = div()
            .id("img-reset")
            .font_family(SANS)
            .text_size(px(12.0))
            .text_color(th.accent_text)
            .cursor_pointer()
            .child("Reset")
            .on_click(cx.listener(|this, _, _, cx| this.choose("img.reset", Value::Null, cx)));
        div()
            .flex()
            .flex_col()
            .child(block("Image", None, fit_row, th))
            .child(block("Filters", None, chips, th))
            .child(block("Adjust", Some(reset.into_any_element()), adj, th))
            .into_any_element()
    }

    fn line_section(&mut self, sel: &Sel, th: &Theme, cx: &mut Context<Self>) -> AnyElement {
        let caps = [
            ("none", "None"),
            ("arrow", "Arrow"),
            ("triangle", "Triangle"),
            ("circle", "Circle"),
            ("square", "Square"),
            ("diamond", "Diamond"),
            ("bar", "Bar"),
        ];
        let start = sel.str(&["startCap"]).unwrap_or_else(|| "none".into());
        let end = sel.str(&["endCap"]).unwrap_or_else(|| "none".into());
        let label = |v: &str| {
            caps.iter()
                .find(|(k, _)| *k == v)
                .map(|(_, l)| l.to_string())
                .unwrap_or_default()
        };
        let s2 = start.clone();
        let e2 = end.clone();
        let sb = select_button("cap-start", format!("Start: {}", label(&start)), th).on_click(
            cx.listener(move |this, e: &gpui::ClickEvent, window, cx| {
                let opts = caps
                    .iter()
                    .map(|(k, l)| (json!(k), l.to_string()))
                    .collect();
                this.menu(
                    "line.startCap",
                    opts,
                    Some(&json!(s2.clone())),
                    below(e),
                    window,
                    cx,
                );
            }),
        );
        let eb = select_button("cap-end", format!("End: {}", label(&end)), th).on_click(
            cx.listener(move |this, e: &gpui::ClickEvent, window, cx| {
                let opts = caps
                    .iter()
                    .map(|(k, l)| (json!(k), l.to_string()))
                    .collect();
                this.menu(
                    "line.endCap",
                    opts,
                    Some(&json!(e2.clone())),
                    below(e),
                    window,
                    cx,
                );
            }),
        );
        block("Line ends", None, pair(sb, eb), th).into_any_element()
    }

    fn qr_section(
        &mut self,
        sel: &Sel,
        th: &Theme,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let data = sel.str(&["data"]).unwrap_or_default();
        let field = self.text("qr.data", "Link or text", &data, window, cx);
        let ec = sel.str(&["errorCorrection"]);
        let rounded = sel.flag(&["rounded"], false).unwrap_or(false);
        let me = cx.entity().downgrade();
        let content = div()
            .flex()
            .flex_col()
            .gap(px(8.0))
            .child(input_box(field, th))
            .child(pair(
                self.color_button("qr-fg", ColorTarget::QrFg, sel.str(&["fg"]), th, cx),
                self.color_button("qr-bg", ColorTarget::QrBg, sel.str(&["bg"]), th, cx),
            ))
            .child(segmented(
                "qr-ec",
                vec![
                    ("L".to_string(), Seg::Text("L 7%".into())),
                    ("M".to_string(), Seg::Text("M 15%".into())),
                    ("Q".to_string(), Seg::Text("Q 25%".into())),
                    ("H".to_string(), Seg::Text("H 30%".into())),
                ],
                ec.as_ref(),
                th,
                move |v, _, cx| {
                    let _ = me.update(cx, |this, cx| this.choose("qr.ec", json!(v), cx));
                },
            ))
            .child(row(
                "Rounded",
                crate::widgets::toggle("qr-rounded", rounded, th, {
                    let me = cx.entity().downgrade();
                    move |on, _, cx| {
                        let _ = me.update(cx, |this, cx| this.choose("qr.rounded", json!(on), cx));
                    }
                }),
                th,
            ));
        block("QR code", None, content, th).into_any_element()
    }

    fn chart_section(
        &mut self,
        sel: &Sel,
        th: &Theme,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let kinds = [
            ("bar", "Bar"),
            ("column", "Column"),
            ("stacked-column", "Stacked"),
            ("line", "Line"),
            ("area", "Area"),
            ("pie", "Pie"),
            ("donut", "Donut"),
            ("scatter", "Scatter"),
            ("radar", "Radar"),
            ("funnel", "Funnel"),
            ("progress", "Progress"),
        ];
        let kind = sel.str(&["chart"]).unwrap_or_default();
        let label = kinds
            .iter()
            .find(|(k, _)| *k == kind)
            .map(|(_, l)| l.to_string())
            .unwrap_or_else(|| "Mixed".into());
        let k2 = kind.clone();
        let kind_btn = select_button("chart-kind", label, th).on_click(cx.listener(
            move |this, e: &gpui::ClickEvent, window, cx| {
                let opts = kinds
                    .iter()
                    .map(|(k, l)| (json!(k), l.to_string()))
                    .collect();
                this.menu(
                    "chart.type",
                    opts,
                    Some(&json!(k2.clone())),
                    below(e),
                    window,
                    cx,
                );
            },
        ));
        let node = sel.single().cloned().unwrap_or(Value::Null);
        let labels = get(&node, &["data", "labels"])
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(Value::as_str)
                    .collect::<Vec<_>>()
                    .join(", ")
            })
            .unwrap_or_default();
        let values = get(&node, &["data", "series", "0", "values"])
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(Value::as_f64)
                    .map(|v| crate::widgets::number::format(v, 2))
                    .collect::<Vec<_>>()
                    .join(", ")
            })
            .unwrap_or_default();
        let lf = self.text("chart.labels", "Q1, Q2, Q3", &labels, window, cx);
        let vf = self.text("chart.values", "12, 19, 7", &values, window, cx);
        let unit = sel.str(&["options", "unit"]).unwrap_or_default();
        let uf = self.text("chart.unit", "%, $, k", &unit, window, cx);
        let fs = self.num(
            "chart.fontSize",
            Label::Text("Aa".into()),
            sel.num(&["options", "fontSize"]),
            |f| f.range(4.0, 200.0).unit("px").precision(0),
            window,
            cx,
        );
        let palette: Vec<String> = get(&node, &["options", "palette"])
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default();
        let mut pal = div().flex().flex_wrap().gap(px(6.0));
        for (i, c) in palette.iter().enumerate().take(8) {
            pal = pal.child(div().w(px(118.0)).child(self.color_button(
                &format!("chart-pal-{i}"),
                ColorTarget::ChartSeries(i),
                Some(c.clone()),
                th,
                cx,
            )));
        }
        let toggles = [
            ("chart.legend", "legend", "Legend"),
            ("chart.grid", "grid", "Grid"),
            ("chart.showLabels", "labels", "Values"),
        ];
        let mut tg = div().flex().flex_col().gap(px(4.0));
        for (key, field, label) in toggles {
            let on = sel.flag(&["options", field], false).unwrap_or(false);
            let me = cx.entity().downgrade();
            tg = tg.child(row(
                label,
                crate::widgets::toggle(key, on, th, move |v, _, cx| {
                    let _ = me.update(cx, |this, cx| this.choose(key, json!(v), cx));
                }),
                th,
            ));
        }
        let content = div()
            .flex()
            .flex_col()
            .gap(px(8.0))
            .child(kind_btn)
            .when(sel.nodes.len() == 1, |d| {
                d.child(row("Labels", input_box(lf, th), th))
                    .child(row("Values", input_box(vf, th), th))
                    .child(hint(
                        "Separate entries with commas; press Enter to apply.",
                        th,
                    ))
            })
            .child(pair(input_box(uf, th), fs))
            .child(self.color_button(
                "chart-text",
                ColorTarget::ChartText,
                sel.str(&["options", "textColor"]),
                th,
                cx,
            ))
            .child(pal)
            .child(tg);
        block("Chart", None, content, th).into_any_element()
    }

    fn table_section(
        &mut self,
        sel: &Sel,
        th: &Theme,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let header = sel.flag(&["header"], false).unwrap_or(false);
        let stripe = sel.flag(&["stripe"], false).unwrap_or(false);
        let pad = self.num(
            "table.padding",
            Label::Text("P".into()),
            sel.num(&["cellPadding"]),
            |f| {
                f.range(0.0, 200.0)
                    .unit("px")
                    .precision(0)
                    .tooltip("Cell padding")
            },
            window,
            cx,
        );
        let bw = self.num(
            "table.border",
            Label::Text("B".into()),
            sel.num(&["borderWidth"]),
            |f| {
                f.range(0.0, 40.0)
                    .unit("px")
                    .precision(1)
                    .tooltip("Border width")
            },
            window,
            cx,
        );
        let me1 = cx.entity().downgrade();
        let me2 = cx.entity().downgrade();
        let content = div()
            .flex()
            .flex_col()
            .gap(px(8.0))
            .child(pair(pad, bw))
            .child(self.color_button(
                "table-border",
                ColorTarget::TableBorder,
                sel.str(&["borderColor"]),
                th,
                cx,
            ))
            .child(row(
                "Header row",
                crate::widgets::toggle("tbl-header", header, th, move |v, _, cx| {
                    let _ = me1.update(cx, |this, cx| this.choose("table.header", json!(v), cx));
                }),
                th,
            ))
            .child(row(
                "Stripes",
                crate::widgets::toggle("tbl-stripe", stripe, th, move |v, _, cx| {
                    let _ = me2.update(cx, |this, cx| this.choose("table.stripe", json!(v), cx));
                }),
                th,
            ))
            .child(hint(
                "Double-click a cell on the canvas to edit its text.",
                th,
            ));
        block("Table", None, content, th).into_any_element()
    }

    fn page_sections(
        &mut self,
        sel: &Sel,
        th: &Theme,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let w = self.num(
            "page.w",
            Label::Text("W".into()),
            sel.num(&["width"]),
            |f| f.range(1.0, 100_000.0).unit("px").precision(0),
            window,
            cx,
        );
        let h = self.num(
            "page.h",
            Label::Text("H".into()),
            sel.num(&["height"]),
            |f| f.range(1.0, 100_000.0).unit("px").precision(0),
            window,
            cx,
        );
        let unit = sel.str(&["unit"]).unwrap_or_else(|| "px".into());
        let preset_btn = select_button("page-preset", "Resize to…", th).on_click(cx.listener(
            |this, e: &gpui::ClickEvent, window, cx| {
                let opts = crate::presets::all()
                    .iter()
                    .map(|p| (json!(p.id), format!("{} · {}", p.label, p.size_label())))
                    .collect();
                this.menu("page.preset", opts, None, below(e), window, cx);
            },
        ));
        let swap = icon_button("page-swap", "icons/rotate-cw.svg", 28.0, false, th)
            .tooltip(tip("Swap width and height", None))
            .on_click(cx.listener(|this, _, _, cx| this.choose("page.swap", Value::Null, cx)));
        let me = cx.entity().downgrade();
        let unit_row = segmented(
            "page-unit",
            vec![
                ("px".to_string(), Seg::Text("px".into())),
                ("mm".to_string(), Seg::Text("mm".into())),
                ("in".to_string(), Seg::Text("in".into())),
                ("pt".to_string(), Seg::Text("pt".into())),
            ],
            Some(&unit),
            th,
            move |v, _, cx| {
                let _ = me.update(cx, |this, cx| this.choose("page.unit", json!(v), cx));
            },
        );
        let bleed = self.num(
            "page.bleed",
            Label::Text("B".into()),
            sel.num(&["bleed"]),
            |f| {
                f.range(0.0, 500.0)
                    .unit("px")
                    .precision(1)
                    .tooltip("Print bleed")
            },
            window,
            cx,
        );
        let grid_on = sel.common(&["grid"]).is_some_and(|g| g.is_object());
        let me2 = cx.entity().downgrade();
        let grid_toggle = crate::widgets::toggle("grid-on", grid_on, th, move |v, _, cx| {
            let _ = me2.update(cx, |this, cx| this.choose("grid.toggle", json!(v), cx));
        });
        let mut grid = div().flex().flex_col().gap(px(8.0));
        if grid_on {
            let cols = self.num(
                "grid.columns",
                Label::Text("C".into()),
                sel.num(&["grid", "columns"]),
                |f| f.range(1.0, 48.0).precision(0).tooltip("Columns"),
                window,
                cx,
            );
            let gut = self.num(
                "grid.gutter",
                Label::Text("G".into()),
                sel.num(&["grid", "gutter"]),
                |f| {
                    f.range(0.0, 1000.0)
                        .unit("px")
                        .precision(0)
                        .tooltip("Gutter")
                },
                window,
                cx,
            );
            let mar = self.num(
                "grid.margin",
                Label::Text("M".into()),
                sel.num(&["grid", "margin"]),
                |f| {
                    f.range(0.0, 5000.0)
                        .unit("px")
                        .precision(0)
                        .tooltip("Margin")
                },
                window,
                cx,
            );
            grid = grid.child(pair(cols, gut)).child(row("Margin", mar, th));
        } else {
            grid = grid.child(hint(
                "Columns to align layers to; shown with View › Layout grid.",
                th,
            ));
        }
        div()
            .flex()
            .flex_col()
            .child(self.fills_section(sel, th, window, cx))
            .child(block(
                "Size",
                Some(swap.into_any_element()),
                div()
                    .flex()
                    .flex_col()
                    .gap(px(8.0))
                    .child(pair(w, h))
                    .child(preset_btn)
                    .child(unit_row),
                th,
            ))
            .child(block("Print", None, row("Bleed", bleed, th), th))
            .child(block(
                "Layout grid",
                Some(grid_toggle.into_any_element()),
                grid,
                th,
            ))
            .into_any_element()
    }
}
