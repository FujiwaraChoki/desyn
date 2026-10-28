//! Elements panel: shapes, lines and arrows, frames, charts, tables, a QR code and icons (Iconify: Lucide, Phosphor,
//! Tabler, Material and more), inserted at the center of the view.

use desyn_core::model::{Cap, Node, TextStyle};
use gpui::{
    App, AppContext, Context, Entity, FocusHandle, Focusable, InteractiveElement, IntoElement,
    ParentElement, Render, SharedString, StatefulInteractiveElement, Styled, Subscription, Task,
    Window, div, img, prelude::FluentBuilder, px,
};
use serde_json::{Value, json};

use super::insert::{self, tweak};
use super::{body, frame};
use crate::cloud::{CloudError, http, images, runtime};
use crate::ui::components::{icon, t, tip};
use crate::ui::editor::EditorView;
use crate::ui::text_field::{FieldEvent, TextField};
use crate::ui::theme::{SANS, Theme};
use crate::widgets::{empty, loading, notify, search_box, section};

/// Popular Lucide icons shown before searching.
const POPULAR: &[&str] = &[
    "lucide:sun",
    "lucide:moon",
    "lucide:star",
    "lucide:heart",
    "lucide:check",
    "lucide:x",
    "lucide:arrow-right",
    "lucide:arrow-up-right",
    "lucide:sparkles",
    "lucide:zap",
    "lucide:flame",
    "lucide:leaf",
    "lucide:coffee",
    "lucide:camera",
    "lucide:music",
    "lucide:map-pin",
    "lucide:phone",
    "lucide:mail",
    "lucide:calendar",
    "lucide:clock",
    "lucide:gift",
    "lucide:shopping-bag",
    "lucide:tag",
    "lucide:trophy",
    "lucide:rocket",
    "lucide:globe",
    "lucide:smile",
    "lucide:thumbs-up",
    "lucide:message-circle",
    "lucide:bell",
    "lucide:home",
    "lucide:user",
];

fn iconify_svg_url(id: &str, color: &str, height: Option<u32>) -> Option<String> {
    let (prefix, name) = id.split_once(':')?;
    let ok = |s: &str| {
        !s.is_empty()
            && s.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    };
    if !ok(prefix) || !ok(name) {
        return None;
    }
    let c = color.trim_start_matches('#');
    Some(match height {
        Some(h) => {
            format!("https://api.iconify.design/{prefix}/{name}.svg?color=%23{c}&height={h}")
        }
        None => format!("https://api.iconify.design/{prefix}/{name}.svg?color=%23{c}"),
    })
}

/// Shapes offered in the grid: (label, icon, builder).
fn shape(kind: &str, id: String) -> Option<Node> {
    let n = match kind {
        "rect" => Node::rect(id, "Rectangle", 0.0, 0.0, 240.0, 240.0),
        "rounded" => tweak(
            Node::rect(id, "Rounded rectangle", 0.0, 0.0, 240.0, 240.0),
            json!({ "cornerRadius": 32 }),
        )?,
        "ellipse" => Node::ellipse(id, "Ellipse", 0.0, 0.0, 240.0, 240.0),
        "triangle" => Node::polygon(id, "Triangle", 3, 0.0, 0.0, 240.0, 220.0),
        "pentagon" => Node::polygon(id, "Pentagon", 5, 0.0, 0.0, 240.0, 230.0),
        "hexagon" => Node::polygon(id, "Hexagon", 6, 0.0, 0.0, 240.0, 210.0),
        "star" => Node::star(id, "Star", 5, 0.45, 0.0, 0.0, 240.0, 230.0),
        "burst" => Node::star(id, "Burst", 12, 0.7, 0.0, 0.0, 240.0, 240.0),
        "arc" => tweak(
            Node::ellipse(id, "Ring", 0.0, 0.0, 240.0, 240.0),
            json!({ "arc": { "start": 0, "end": 360, "inner": 0.62 } }),
        )?,
        "line" => Node::line(id, "Line", 0.0, 0.0, 320.0),
        "arrow" => tweak(
            Node::line(id, "Arrow", 0.0, 0.0, 320.0),
            json!({ "endCap": Cap::Arrow.as_str() }),
        )?,
        "double" => tweak(
            Node::line(id, "Double arrow", 0.0, 0.0, 320.0),
            json!({ "startCap": "arrow", "endCap": "arrow" }),
        )?,
        "dashed" => tweak(
            Node::line(id, "Dashed line", 0.0, 0.0, 320.0),
            json!({ "strokes": [{ "fills": [{ "type": "solid", "color": "#111111" }], "width": 3, "align": "center", "cap": "round", "join": "round", "dash": [10, 10] }] }),
        )?,
        "frame" => tweak(
            Node::frame(id, "Frame", 0.0, 0.0, 400.0, 300.0),
            json!({ "fills": [{ "type": "solid", "color": "#ffffff" }], "clip": true }),
        )?,
        "frame-circle" => tweak(
            Node::frame(id, "Circle frame", 0.0, 0.0, 300.0, 300.0),
            json!({ "fills": [{ "type": "solid", "color": "#e8e1d3" }], "clip": true, "cornerRadius": 150 }),
        )?,
        "frame-card" => tweak(
            Node::frame(id, "Card", 0.0, 0.0, 320.0, 400.0),
            json!({
                "fills": [{ "type": "solid", "color": "#ffffff" }], "clip": true, "cornerRadius": 20,
                "effects": [{ "type": "dropShadow", "x": 0, "y": 18, "blur": 40, "spread": -12, "color": "#0000002e" }]
            }),
        )?,
        _ => return None,
    };
    Some(n)
}

fn base(kind: &str, id: &str, name: &str, w: f64, h: f64) -> serde_json::Map<String, Value> {
    let mut m = serde_json::Map::new();
    for (k, v) in [
        ("id", json!(id)),
        ("type", json!(kind)),
        ("name", json!(name)),
        ("parent", json!("root")),
        ("x", json!(0)),
        ("y", json!(0)),
        ("width", json!(w)),
        ("height", json!(h)),
        ("rotation", json!(0)),
        ("opacity", json!(1)),
        ("blend", json!("normal")),
        ("visible", json!(true)),
        ("locked", json!(false)),
        ("effects", json!([])),
    ] {
        m.insert(k.to_string(), v);
    }
    m
}

/// A chart with editable starter data.
pub fn chart(kind: &str, id: String) -> Option<Node> {
    let mut m = base("chart", &id, "Chart", 480.0, 320.0);
    let (labels, series): (Value, Value) = match kind {
        "pie" | "donut" => (
            json!(["Design", "Marketing", "Product", "Other"]),
            json!([{ "name": "Share", "values": [38, 27, 22, 13] }]),
        ),
        "progress" => (
            json!(["Progress"]),
            json!([{ "name": "Done", "values": [72] }]),
        ),
        "line" | "area" => (
            json!(["Jan", "Feb", "Mar", "Apr", "May", "Jun"]),
            json!([{ "name": "This year", "values": [12, 19, 15, 24, 28, 34] }, { "name": "Last year", "values": [9, 12, 14, 16, 18, 21] }]),
        ),
        _ => (
            json!(["Q1", "Q2", "Q3", "Q4"]),
            json!([{ "name": "Revenue", "values": [12, 19, 15, 24] }]),
        ),
    };
    if kind == "pie" || kind == "donut" || kind == "progress" {
        m.insert("width".into(), json!(360));
        m.insert("height".into(), json!(360));
    }
    m.insert("chart".into(), json!(kind));
    m.insert("data".into(), json!({ "labels": labels, "series": series }));
    m.insert(
        "options".into(),
        json!({
            "legend": matches!(kind, "pie" | "donut" | "line" | "area"),
            "grid": !matches!(kind, "pie" | "donut" | "progress"),
            "labels": true,
            "palette": ["#ffb02e", "#ff6a1f", "#ffd66b", "#c4451c", "#8a5a00", "#5aa9ff"],
            "fontFamily": "Inter",
            "fontSize": 14,
            "textColor": "#3a3a3a",
            "unit": if kind == "progress" { "%" } else { "" },
        }),
    );
    serde_json::from_value(Value::Object(m)).ok()
}

/// A table with a header row.
pub fn table(rows: usize, cols: usize, id: String) -> Option<Node> {
    let mut m = base(
        "table",
        &id,
        "Table",
        160.0 * cols as f64,
        44.0 * rows as f64,
    );
    let mut cells = Vec::new();
    for r in 0..rows {
        for c in 0..cols {
            let text = if r == 0 {
                format!("Heading {}", c + 1)
            } else {
                String::new()
            };
            cells.push(json!({ "r": r, "c": c, "text": text }));
        }
    }
    let mut style = serde_json::to_value(TextStyle::default_style()).ok()?;
    style["fontSize"] = json!(16);
    style["fills"] = json!([{ "type": "solid", "color": "#171717" }]);
    m.insert("rows".into(), json!(rows));
    m.insert("cols".into(), json!(cols));
    m.insert("colWidths".into(), json!(vec![160; cols]));
    m.insert("rowHeights".into(), json!(vec![44; rows]));
    m.insert("cells".into(), Value::Array(cells));
    m.insert("header".into(), json!(true));
    m.insert("stripe".into(), json!(true));
    m.insert("borderColor".into(), json!("#e4e0d8"));
    m.insert("borderWidth".into(), json!(1));
    m.insert("cellPadding".into(), json!(12));
    m.insert("defaultStyle".into(), style);
    serde_json::from_value(Value::Object(m)).ok()
}

/// The panel.
pub struct ElementsPanel {
    editor: Entity<EditorView>,
    search: Entity<TextField>,
    icons: Vec<String>,
    searching: bool,
    error: Option<String>,
    request: u64,
    debounce: Option<Task<()>>,
    focus: FocusHandle,
    _subs: Vec<Subscription>,
}

impl Focusable for ElementsPanel {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl ElementsPanel {
    /// A panel for an editor.
    pub fn new(
        editor: Entity<EditorView>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> ElementsPanel {
        let search = cx.new(|cx| {
            let mut f = TextField::new("Search icons", cx);
            f.font_size = 13.0;
            f
        });
        let subs =
            vec![
                cx.subscribe_in(&search, window, |this, _, e: &FieldEvent, _, cx| match e {
                    FieldEvent::Changed(_) => {
                        this.debounce = Some(cx.spawn(async move |this, cx| {
                            runtime::sleep(std::time::Duration::from_millis(300)).await;
                            let _ = this.update(cx, |this, cx| this.search_icons(cx));
                        }));
                    }
                    FieldEvent::Confirm => this.search_icons(cx),
                    _ => {}
                }),
            ];
        ElementsPanel {
            editor,
            search,
            icons: POPULAR.iter().map(|s| s.to_string()).collect(),
            searching: false,
            error: None,
            request: 0,
            debounce: None,
            focus: cx.focus_handle(),
            _subs: subs,
        }
    }

    fn search_icons(&mut self, cx: &mut Context<Self>) {
        let q = self.search.read(cx).text().trim().to_string();
        self.request += 1;
        let req = self.request;
        if q.is_empty() {
            self.icons = POPULAR.iter().map(|s| s.to_string()).collect();
            self.error = None;
            cx.notify();
            return;
        }
        self.searching = true;
        let url = format!(
            "https://api.iconify.design/search?query={}&limit=96",
            url::form_urlencoded::byte_serialize(q.as_bytes()).collect::<String>()
        );
        let f = runtime::spawn(async move { http::get_json(&url, None).await });
        cx.spawn(async move |this, cx| {
            let res = f
                .await
                .unwrap_or_else(|_| Err(CloudError::network("cancelled")));
            let _ = this.update(cx, |this, cx| {
                if this.request != req {
                    return;
                }
                this.searching = false;
                match res {
                    Ok(v) => {
                        this.error = None;
                        this.icons = v
                            .get("icons")
                            .and_then(Value::as_array)
                            .map(|a| {
                                a.iter()
                                    .filter_map(|x| x.as_str().map(str::to_string))
                                    .collect()
                            })
                            .unwrap_or_default();
                    }
                    Err(e) => {
                        this.error = Some(if e.code == "NETWORK" {
                            "Icons need an internet connection.".into()
                        } else {
                            e.friendly()
                        })
                    }
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    fn add(&mut self, f: impl FnOnce(String) -> Option<Node>, label: &str, cx: &mut Context<Self>) {
        let id = insert::new_id(&self.editor, cx);
        if let Some(n) = f(id) {
            insert::insert(&self.editor, vec![vec![n]], Vec::new(), label, cx);
        }
    }

    fn add_icon(&mut self, id: String, cx: &mut Context<Self>) {
        let Some(url) = iconify_svg_url(&id, "#111111", Some(96)) else {
            return;
        };
        let f = runtime::spawn(async move { http::get_bytes(&url, 256 * 1024).await });
        let editor = self.editor.clone();
        cx.spawn(async move |_, cx| {
            let res = f
                .await
                .unwrap_or_else(|_| Err(CloudError::network("cancelled")));
            cx.update(|cx| match res {
                Ok((bytes, _)) => {
                    let markup = String::from_utf8_lossy(&bytes).to_string();
                    if !markup.trim_start().starts_with("<svg") {
                        notify(cx, "That icon could not be loaded.".into());
                        return;
                    }
                    let nid = insert::new_id(&editor, cx);
                    let name = id.split(':').nth(1).unwrap_or("Icon").replace('-', " ");
                    if let Some(n) = insert::svg_node(nid, &name, &markup, 96.0, 96.0) {
                        let n = tweak(n.clone(), json!({ "role": "icon" })).unwrap_or(n);
                        insert::insert(&editor, vec![vec![n]], Vec::new(), "Add icon", cx);
                    }
                }
                Err(e) => notify(cx, format!("Couldn't load the icon: {}", e.friendly())),
            });
        })
        .detach();
    }
}

fn tile(id: &str, icon_path: &'static str, label: &str, th: &Theme) -> gpui::Stateful<gpui::Div> {
    let s3 = th.surface3;
    let b = th.border;
    div()
        .id(SharedString::from(format!("el-{id}")))
        .w(px(65.0))
        .h(px(64.0))
        .flex()
        .flex_col()
        .items_center()
        .justify_center()
        .gap(px(6.0))
        .rounded(px(10.0))
        .bg(th.surface2)
        .border_1()
        .border_color(th.border_subtle)
        .cursor_pointer()
        .hover(move |s| s.bg(s3).border_color(b))
        .tooltip(tip(label.to_string(), None))
        .child(icon(icon_path, 20.0, th.fg))
        .child(
            div()
                .font_family(SANS)
                .text_size(px(10.0))
                .text_color(th.faint)
                .child(label.to_string()),
        )
}

impl Render for ElementsPanel {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let th = t(window, cx);
        let shapes: &[(&str, &str, &'static str)] = &[
            ("rect", "Square", "icons/square.svg"),
            ("rounded", "Rounded", "icons/squircle.svg"),
            ("ellipse", "Circle", "icons/circle.svg"),
            ("triangle", "Triangle", "icons/triangle.svg"),
            ("pentagon", "Pentagon", "icons/pentagon.svg"),
            ("hexagon", "Hexagon", "icons/hexagon.svg"),
            ("star", "Star", "icons/star.svg"),
            ("burst", "Burst", "icons/sparkle.svg"),
            ("arc", "Ring", "icons/circle-dot.svg"),
        ];
        let lines: &[(&str, &str, &'static str)] = &[
            ("line", "Line", "icons/minus.svg"),
            ("arrow", "Arrow", "icons/arrow-right.svg"),
            ("double", "Both ends", "icons/move-horizontal.svg"),
            ("dashed", "Dashed", "icons/ellipsis.svg"),
        ];
        let frames: &[(&str, &str, &'static str)] = &[
            ("frame", "Frame", "icons/frame.svg"),
            ("frame-circle", "Circle", "icons/circle.svg"),
            ("frame-card", "Card", "icons/square-dashed.svg"),
        ];
        let charts: &[(&str, &str, &'static str)] = &[
            ("column", "Column", "icons/chart-column.svg"),
            ("bar", "Bar", "icons/chart-column.svg"),
            ("line", "Line", "icons/spline.svg"),
            ("area", "Area", "icons/spline.svg"),
            ("pie", "Pie", "icons/chart-pie.svg"),
            ("donut", "Donut", "icons/circle-dot.svg"),
            ("stacked-column", "Stacked", "icons/chart-column.svg"),
            ("progress", "Progress", "icons/circle-check-big.svg"),
        ];
        let mut shape_grid = div().flex().flex_wrap().gap(px(6.0));
        for (k, l, i) in shapes.iter().chain(lines.iter()) {
            let k = k.to_string();
            let label = format!("Add {}", l.to_lowercase());
            shape_grid = shape_grid.child(tile(&k, i, l, &th).on_click(cx.listener(
                move |this, _, _, cx| {
                    let k = k.clone();
                    this.add(move |id| shape(&k, id), &label, cx)
                },
            )));
        }
        let mut frame_grid = div().flex().flex_wrap().gap(px(6.0));
        for (k, l, i) in frames {
            let k = k.to_string();
            frame_grid = frame_grid.child(tile(&k, i, l, &th).on_click(cx.listener(
                move |this, _, _, cx| {
                    let k = k.clone();
                    this.add(move |id| shape(&k, id), "Add frame", cx)
                },
            )));
        }
        let mut chart_grid = div().flex().flex_wrap().gap(px(6.0));
        for (k, l, i) in charts {
            let k = k.to_string();
            chart_grid = chart_grid.child(tile(&format!("chart-{k}"), i, l, &th).on_click(
                cx.listener(move |this, _, _, cx| {
                    let k = k.clone();
                    this.add(move |id| chart(&k, id), "Add chart", cx)
                }),
            ));
        }
        let mut table_grid = div().flex().flex_wrap().gap(px(6.0));
        for (r, c) in [(3usize, 3usize), (4, 3), (5, 4)] {
            table_grid = table_grid.child(
                tile(
                    &format!("table-{r}x{c}"),
                    "icons/table.svg",
                    &format!("{c} × {r}"),
                    &th,
                )
                .on_click(cx.listener(move |this, _, _, cx| {
                    this.add(move |id| table(r, c, id), "Add table", cx)
                })),
            );
        }
        table_grid = table_grid.child(tile("qr", "icons/qr-code.svg", "QR code", &th).on_click(
            cx.listener(|this, _, _, cx| {
                let data = crate::cloud::Cloud::try_get(cx)
                    .map(|c| c.endpoints().app_url.clone())
                    .unwrap_or_else(|| "https://desyn.app".into());
                this.add(
                    move |id| Some(Node::qr(id, data, 0.0, 0.0, 240.0)),
                    "Add QR code",
                    cx,
                )
            }),
        ));
        let me = cx.entity().entity_id();
        let fg = if th.dark { "#ededed" } else { "#171717" };
        let icons = self.icons.clone();
        let mut icon_grid = div().flex().flex_wrap().gap(px(6.0));
        for (i, id) in icons.iter().enumerate() {
            let url = iconify_svg_url(id, fg, None).unwrap_or_default();
            let image = images::image(&url, me, cx);
            let s3 = th.surface3;
            let id2 = id.clone();
            icon_grid = icon_grid.child(
                div()
                    .id(("icon", i))
                    .size(px(48.0))
                    .flex()
                    .items_center()
                    .justify_center()
                    .rounded(px(9.0))
                    .bg(th.surface2)
                    .cursor_pointer()
                    .hover(move |s| s.bg(s3))
                    .tooltip(tip(id.clone(), None))
                    .children(image.map(|im| img(im).size(px(24.0))))
                    .on_click(cx.listener(move |this, _, _, cx| this.add_icon(id2.clone(), cx))),
            );
        }
        let content = div()
            .flex()
            .flex_col()
            .gap(px(14.0))
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(8.0))
                    .child(section("Shapes & lines", None, &th))
                    .child(shape_grid),
            )
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(8.0))
                    .child(section("Frames", None, &th))
                    .child(frame_grid),
            )
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(8.0))
                    .child(section("Charts", None, &th))
                    .child(chart_grid),
            )
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(8.0))
                    .child(section("Tables & QR", None, &th))
                    .child(table_grid),
            )
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(8.0))
                    .child(section("Icons", None, &th))
                    .child(search_box(self.search.clone(), &th))
                    .when(self.searching, |d| {
                        d.child(loading("icons-loading", "Searching icons…", &th))
                    })
                    .children(self.error.clone().map(|e| empty("offline", &e, None, &th)))
                    .when(
                        !self.searching && self.error.is_none() && self.icons.is_empty(),
                        |d| {
                            d.child(empty(
                                "no icons",
                                "Nothing matches. Try a simpler word like “arrow” or “leaf”.",
                                None,
                                &th,
                            ))
                        },
                    )
                    .child(icon_grid)
                    .child(
                        div()
                            .font_family(SANS)
                            .text_size(px(10.5))
                            .text_color(th.faint)
                            .child("Icons by Iconify (open-source sets; licenses per set)."),
                    ),
            );
        frame("add", Some("elements"), None, &th).child(body("elements-body", content))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builders_make_valid_nodes() {
        for k in [
            "rect",
            "rounded",
            "ellipse",
            "triangle",
            "pentagon",
            "hexagon",
            "star",
            "burst",
            "arc",
            "line",
            "arrow",
            "double",
            "dashed",
            "frame",
            "frame-circle",
            "frame-card",
        ] {
            assert!(shape(k, "abcdefghijkl".into()).is_some(), "{k}");
        }
        for k in [
            "column",
            "bar",
            "line",
            "area",
            "pie",
            "donut",
            "stacked-column",
            "progress",
        ] {
            let n = chart(k, "abcdefghijkl".into()).unwrap_or_else(|| panic!("{k}"));
            assert!(
                desyn_core::model::validate_node(&n).is_ok(),
                "{k}: {:?}",
                desyn_core::model::validate_node(&n)
            );
        }
        let t = table(3, 4, "abcdefghijkl".into()).unwrap();
        assert!(
            desyn_core::model::validate_node(&t).is_ok(),
            "{:?}",
            desyn_core::model::validate_node(&t)
        );
        assert_eq!(
            iconify_svg_url("lucide:sun", "#111111", Some(96)).as_deref(),
            Some("https://api.iconify.design/lucide/sun.svg?color=%23111111&height=96")
        );
        assert!(iconify_svg_url("../x:y", "#000", None).is_none());
    }
}
