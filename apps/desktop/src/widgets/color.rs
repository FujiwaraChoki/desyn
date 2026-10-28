//! The color picker (DESIGN_SYSTEM §5): saturation / value area, hue and alpha sliders, hex + alpha fields, an
//! eyedropper that samples the canvas, and swatches (document colors, brand kit, the sun palette). Owners show it
//! in a popover and receive [`ColorEvent`]s; a drag previews, the release commits.

use std::rc::Rc;

use desyn_core::color::Rgba as CRgba;
use desyn_core::model::Color;
use gpui::{
    App, AppContext, Bounds, Context, Entity, EventEmitter, FocusHandle, Focusable, Hsla,
    InteractiveElement, IntoElement, MouseButton, MouseDownEvent, ParentElement, Pixels, Point,
    Render, SharedString, StatefulInteractiveElement, Styled, Subscription, Window, canvas, div,
    linear_color_stop, linear_gradient, px,
};

use super::{capture, hsla, swatch};
use crate::ui::components::{icon, label, t, tip};
use crate::ui::text_field::{FieldEvent, TextField};
use crate::ui::theme::{MONO, Theme, alpha};

/// What the picker reports.
#[derive(Debug, Clone, PartialEq)]
pub enum ColorEvent {
    /// Live color while dragging (`#rrggbb[aa]`).
    Preview(String),
    /// Final color.
    Commit(String),
    /// The user wants to sample a color from the canvas.
    PickFromCanvas,
}

/// The sun palette (DESIGN_SYSTEM §1) plus neutrals.
pub const PALETTE: &[&str] = &[
    "#ffb02e", "#ff6a1f", "#ffd66b", "#c4451c", "#8a5a00", "#e8e1d3", "#7a7468", "#5aa9ff",
    "#0a0a0a", "#171717", "#3a3a3a", "#8a8a8a", "#d4d4d4", "#ffffff", "#4ade80", "#ff5c5c",
];

/// A named group of swatches.
#[derive(Debug, Clone, PartialEq)]
pub struct SwatchGroup {
    /// Title ("Document", "Brand").
    pub title: SharedString,
    /// Colors (`#rrggbb[aa]`).
    pub colors: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum Drag {
    Area,
    Hue,
    Alpha,
}

/// The picker.
pub struct ColorPicker {
    h: f64,
    s: f64,
    v: f64,
    a: f64,
    drag: Option<Drag>,
    area: Option<Bounds<Pixels>>,
    hue_bar: Option<Bounds<Pixels>>,
    alpha_bar: Option<Bounds<Pixels>>,
    hex: Entity<TextField>,
    groups: Vec<SwatchGroup>,
    focus: FocusHandle,
    _subs: Vec<Subscription>,
}

impl EventEmitter<ColorEvent> for ColorPicker {}

impl Focusable for ColorPicker {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

/// `#rrggbb` (or `#rrggbbaa` when not opaque) from HSV + alpha.
pub fn to_hex(h: f64, s: f64, v: f64, a: f64) -> String {
    let c = CRgba::from_hsv(h, s, v, a);
    let [r, g, b, al] = c.to_color().rgba8();
    if al == 255 {
        format!("#{r:02x}{g:02x}{b:02x}")
    } else {
        format!("#{r:02x}{g:02x}{b:02x}{al:02x}")
    }
}

/// Parses `#rgb`, `#rrggbb`, `#rrggbbaa` or any CSS color into a design color.
pub fn parse(input: &str) -> Option<String> {
    let s = input.trim();
    let s = if !s.starts_with('#') && s.len() >= 3 && s.chars().all(|c| c.is_ascii_hexdigit()) {
        format!("#{s}")
    } else {
        s.to_string()
    };
    desyn_core::color::parse_css_color(&s).ok().map(|c| {
        let [r, g, b, a] = c.to_color().rgba8();
        if a == 255 {
            format!("#{r:02x}{g:02x}{b:02x}")
        } else {
            format!("#{r:02x}{g:02x}{b:02x}{a:02x}")
        }
    })
}

impl ColorPicker {
    /// A picker showing `color`.
    pub fn new(
        color: &str,
        groups: Vec<SwatchGroup>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> ColorPicker {
        let hex = cx.new(|cx| {
            let mut f = TextField::new("#ffffff", cx);
            f.font_size = 12.0;
            f
        });
        let subs = vec![
            cx.subscribe_in(&hex, window, |this, field, e: &FieldEvent, _, cx| {
                if *e == FieldEvent::Confirm {
                    let text = field.read(cx).text().to_string();
                    if let Some(c) = parse(&text) {
                        this.set_color(&c, cx);
                        cx.emit(ColorEvent::Commit(c));
                    }
                }
            }),
        ];
        let mut p = ColorPicker {
            h: 0.0,
            s: 0.0,
            v: 0.0,
            a: 1.0,
            drag: None,
            area: None,
            hue_bar: None,
            alpha_bar: None,
            hex,
            groups,
            focus: cx.focus_handle(),
            _subs: subs,
        };
        p.set_color(color, cx);
        p
    }

    /// Shows another color (keeps the hue for grays).
    pub fn set_color(&mut self, color: &str, cx: &mut Context<Self>) {
        let Ok(c) = Color::new(color.to_string()) else {
            return;
        };
        let rgba = CRgba::from_color(&c);
        let (h, s, v) = rgba.to_hsv();
        if s > 0.001 && v > 0.001 {
            self.h = h;
        }
        self.s = s;
        self.v = v;
        self.a = rgba.a;
        let hex = self.hex_string();
        self.hex.update(cx, |f, cx| f.set_text(&hex, cx));
        cx.notify();
    }

    /// Replaces the swatch groups.
    pub fn set_groups(&mut self, groups: Vec<SwatchGroup>, cx: &mut Context<Self>) {
        self.groups = groups;
        cx.notify();
    }

    fn hex_string(&self) -> String {
        to_hex(self.h, self.s, self.v, self.a)
    }

    fn changed(&mut self, commit: bool, cx: &mut Context<Self>) {
        let c = self.hex_string();
        let shown = c.clone();
        self.hex.update(cx, |f, cx| f.set_text(&shown, cx));
        cx.emit(if commit {
            ColorEvent::Commit(c)
        } else {
            ColorEvent::Preview(c)
        });
        cx.notify();
    }

    fn drag_to(&mut self, p: Point<Pixels>, cx: &mut Context<Self>) {
        let frac = |b: Option<Bounds<Pixels>>, horizontal: bool| -> Option<f64> {
            let b = b?;
            let f = if horizontal {
                f32::from(p.x - b.left()) / f32::from(b.size.width).max(1.0)
            } else {
                f32::from(p.y - b.top()) / f32::from(b.size.height).max(1.0)
            };
            Some(f.clamp(0.0, 1.0) as f64)
        };
        match self.drag {
            Some(Drag::Area) => {
                if let (Some(x), Some(y)) = (frac(self.area, true), frac(self.area, false)) {
                    self.s = x;
                    self.v = 1.0 - y;
                }
            }
            Some(Drag::Hue) => {
                if let Some(x) = frac(self.hue_bar, true) {
                    self.h = x * 360.0;
                }
            }
            Some(Drag::Alpha) => {
                if let Some(x) = frac(self.alpha_bar, true) {
                    self.a = (x * 100.0).round() / 100.0;
                }
            }
            None => return,
        }
        self.changed(false, cx);
    }

    fn start(&mut self, d: Drag, p: Point<Pixels>, cx: &mut Context<Self>) {
        self.drag = Some(d);
        self.drag_to(p, cx);
    }

    fn end(&mut self, cx: &mut Context<Self>) {
        if self.drag.take().is_some() {
            self.changed(true, cx);
        }
    }

    fn pick(&mut self, c: String, cx: &mut Context<Self>) {
        self.set_color(&c, cx);
        cx.emit(ColorEvent::Commit(c));
    }
}

fn hue(h: f64) -> Hsla {
    Hsla {
        h: (h / 360.0) as f32,
        s: 1.0,
        l: 0.5,
        a: 1.0,
    }
}

fn track_bounds(
    view: &Entity<ColorPicker>,
    set: fn(&mut ColorPicker, Bounds<Pixels>),
) -> impl IntoElement {
    let v = view.clone();
    canvas(
        move |b, _, cx| {
            v.update(cx, |p, _| set(p, b));
        },
        |_, _, _, _| {},
    )
    .absolute()
    .inset_0()
}

fn knob(x: f32, y: f32, color: Hsla) -> impl IntoElement {
    div()
        .absolute()
        .left(px(x - 7.0))
        .top(px(y - 7.0))
        .size(px(14.0))
        .rounded(px(7.0))
        .border_2()
        .border_color(gpui::white())
        .bg(color)
        .shadow(vec![
            gpui::BoxShadow::new(px(0.0), px(1.0), alpha(gpui::black(), 0.5)).blur_radius(px(3.0)),
        ])
}

const W: f32 = 232.0;

impl Render for ColorPicker {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let th = t(window, cx);
        let me = cx.entity();
        let current = hsla(&self.hex_string());
        let opaque = Hsla { a: 1.0, ..current };
        let area_h = 150.0f32;
        let area = div()
            .id("sv-area")
            .relative()
            .w(px(W))
            .h(px(area_h))
            .rounded(px(8.0))
            .overflow_hidden()
            .bg(hue(self.h))
            .cursor_crosshair()
            .child(div().absolute().inset_0().bg(linear_gradient(
                90.0,
                linear_color_stop(gpui::white(), 0.0),
                linear_color_stop(
                    Hsla {
                        a: 0.0,
                        ..gpui::white()
                    },
                    1.0,
                ),
            )))
            .child(div().absolute().inset_0().bg(linear_gradient(
                180.0,
                linear_color_stop(
                    Hsla {
                        a: 0.0,
                        ..gpui::black()
                    },
                    0.0,
                ),
                linear_color_stop(gpui::black(), 1.0),
            )))
            .child(track_bounds(&me, |p, b| p.area = Some(b)))
            .child(knob(
                self.s as f32 * W,
                (1.0 - self.v as f32) * area_h,
                opaque,
            ))
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|this, e: &MouseDownEvent, _, cx| {
                    this.start(Drag::Area, e.position, cx);
                    cx.stop_propagation();
                }),
            );
        let bar_w = W - 40.0;
        let hue_segments = (0..6).map(|i| {
            div().flex_1().h_full().bg(linear_gradient(
                90.0,
                linear_color_stop(hue(i as f64 * 60.0), 0.0),
                linear_color_stop(hue((i + 1) as f64 * 60.0), 1.0),
            ))
        });
        let hue_bar = div()
            .id("hue")
            .relative()
            .w(px(bar_w))
            .h(px(12.0))
            .rounded(px(6.0))
            .flex()
            .overflow_hidden()
            .cursor_pointer()
            .children(hue_segments)
            .child(track_bounds(&me, |p, b| p.hue_bar = Some(b)))
            .child(knob((self.h / 360.0) as f32 * bar_w, 6.0, hue(self.h)))
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|this, e: &MouseDownEvent, _, cx| {
                    this.start(Drag::Hue, e.position, cx);
                    cx.stop_propagation();
                }),
            );
        let cells = (bar_w / 6.0) as usize + 1;
        let alpha_bar = div()
            .id("alpha")
            .relative()
            .w(px(bar_w))
            .h(px(12.0))
            .rounded(px(6.0))
            .overflow_hidden()
            .bg(gpui::white())
            .cursor_pointer()
            .children(
                (0..cells * 2)
                    .filter(|i| (i % cells + i / cells).is_multiple_of(2))
                    .map(move |i| {
                        div()
                            .absolute()
                            .left(px((i % cells) as f32 * 6.0))
                            .top(px((i / cells) as f32 * 6.0))
                            .size(px(6.0))
                            .bg(gpui::rgb(0xcfcfcf))
                    }),
            )
            .child(div().absolute().inset_0().bg(linear_gradient(
                90.0,
                linear_color_stop(Hsla { a: 0.0, ..opaque }, 0.0),
                linear_color_stop(opaque, 1.0),
            )))
            .child(track_bounds(&me, |p, b| p.alpha_bar = Some(b)))
            .child(knob(self.a as f32 * bar_w, 6.0, current))
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|this, e: &MouseDownEvent, _, cx| {
                    this.start(Drag::Alpha, e.position, cx);
                    cx.stop_propagation();
                }),
            );
        let eyedropper = div()
            .id("eyedropper")
            .size(px(30.0))
            .flex_none()
            .flex()
            .items_center()
            .justify_center()
            .rounded(px(8.0))
            .border_1()
            .border_color(th.border_subtle)
            .cursor_pointer()
            .hover({
                let s3 = th.surface3;
                move |s| s.bg(s3)
            })
            .tooltip(tip("Pick a color from the canvas", Some("I".into())))
            .child(icon("icons/pipette.svg", 14.0, th.muted))
            .on_click(cx.listener(|_, _, _, cx| cx.emit(ColorEvent::PickFromCanvas)));
        let groups: Vec<SwatchGroup> = self
            .groups
            .iter()
            .cloned()
            .chain(std::iter::once(SwatchGroup {
                title: "Palette".into(),
                colors: PALETTE.iter().map(|s| s.to_string()).collect(),
            }))
            .filter(|g| !g.colors.is_empty())
            .collect();
        let swatches = groups.into_iter().enumerate().map(|(gi, g)| {
            div()
                .flex()
                .flex_col()
                .gap(px(6.0))
                .child(label(&g.title, &th))
                .child(div().flex().flex_wrap().gap(px(6.0)).children(
                    g.colors.into_iter().take(24).enumerate().map(|(i, c)| {
                        let col = c.clone();
                        let pick = Rc::new(col);
                        div()
                            .id(SharedString::from(format!("sw-{gi}-{i}")))
                            .cursor_pointer()
                            .tooltip(tip(c.clone(), None))
                            .child(swatch(hsla(&c), 20.0, &th))
                            .on_click(
                                cx.listener(move |this, _, _, cx| this.pick((*pick).clone(), cx)),
                            )
                    }),
                ))
        });
        div()
            .id("color-picker")
            .track_focus(&self.focus)
            .w(px(W + 24.0))
            .p(px(12.0))
            .flex()
            .flex_col()
            .gap(px(12.0))
            .child(area)
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(10.0))
                    .child(eyedropper)
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .gap(px(8.0))
                            .child(hue_bar)
                            .child(alpha_bar),
                    ),
            )
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(8.0))
                    .child(swatch(current, 28.0, &th))
                    .child(
                        div()
                            .flex_1()
                            .h(px(28.0))
                            .px(px(8.0))
                            .flex()
                            .items_center()
                            .rounded(px(6.0))
                            .bg(th.surface2)
                            .border_1()
                            .border_color(th.border_subtle)
                            .font_family(MONO)
                            .child(self.hex.clone()),
                    )
                    .child(
                        div()
                            .w(px(46.0))
                            .font_family(MONO)
                            .text_size(px(11.5))
                            .text_color(th.muted)
                            .child(format!("{}%", (self.a * 100.0).round())),
                    ),
            )
            .children(swatches)
            .child(capture(
                &me,
                self.drag.is_some(),
                |this, p, _, _, cx| this.drag_to(p, cx),
                |this, _, _, cx| this.end(cx),
            ))
    }
}

/// Colors used in a design (fills, strokes, text), most frequent first.
pub fn document_colors(design: &desyn_core::model::Design, limit: usize) -> Vec<String> {
    let mut counts: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    fn walk(v: &serde_json::Value, counts: &mut std::collections::HashMap<String, usize>) {
        match v {
            serde_json::Value::Object(o) => {
                for (k, v) in o {
                    if (k == "color"
                        || k == "fg"
                        || k == "bg"
                        || k == "textColor"
                        || k == "highlight"
                        || k == "borderColor")
                        && let Some(s) = v.as_str()
                        && Color::is_valid(s)
                    {
                        *counts.entry(s.to_string()).or_default() += 1;
                    } else {
                        walk(v, counts);
                    }
                }
            }
            serde_json::Value::Array(a) => a.iter().for_each(|v| walk(v, counts)),
            _ => {}
        }
    }
    for n in design.nodes.values() {
        if let Ok(v) = serde_json::to_value(n) {
            walk(&v, &mut counts);
        }
    }
    let mut v: Vec<(String, usize)> = counts.into_iter().collect();
    v.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    v.into_iter().take(limit).map(|(c, _)| c).collect()
}

/// Theme-independent check used by tests.
pub fn contrast_text(c: &str, th: &Theme) -> Hsla {
    let l = Color::new(c.to_string())
        .map(|c| CRgba::from_color(&c).relative_luminance())
        .unwrap_or(0.0);
    if l > 0.45 { gpui::black() } else { th.fg }
}

#[cfg(test)]
mod tests {
    use super::*;
    use desyn_core::model::{DesignKind, Node};

    #[test]
    fn hex_conversions() {
        assert_eq!(to_hex(0.0, 1.0, 1.0, 1.0), "#ff0000");
        assert_eq!(to_hex(0.0, 0.0, 1.0, 0.5), "#ffffff80");
        assert_eq!(parse("FFB02E").as_deref(), Some("#ffb02e"));
        assert_eq!(parse("#fff").as_deref(), Some("#ffffff"));
        assert_eq!(parse("rgb(255 0 0 / 50%)").as_deref(), Some("#ff000080"));
        assert_eq!(parse("nonsense"), None);
    }

    #[test]
    fn collects_document_colors() {
        let mut d = desyn_core::model::Design::with_page(
            "design000001",
            "x",
            DesignKind::Poster,
            "page00000001",
            10.0,
            10.0,
        );
        d.push_child(
            "page00000001",
            Node::rect("rect00000001", "a", 0.0, 0.0, 1.0, 1.0),
        );
        d.push_child(
            "page00000001",
            Node::rect("rect00000002", "b", 0.0, 0.0, 1.0, 1.0),
        );
        let colors = document_colors(&d, 8);
        assert_eq!(colors.first().map(String::as_str), Some("#d9d9d9"));
    }
}
