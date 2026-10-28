//! The right inspector (DESIGN_SYSTEM §6): Design (fill, stroke, opacity, blend, text styles, image adjustments,
//! corner radius, shape / QR / chart properties, page background and size), Arrange (align, distribute, z-order,
//! grouping, auto-layout, constraints), Effects (shadows, blurs, noise, glow, masks), Animate (entrance / exit /
//! loop animations, page timing and transitions) and Position (x, y, size, rotation, flips). Native widgets: numeric
//! scrubbers, the color picker with eyedropper, the font picker. Every edit is one transaction; scrubs and color
//! drags preview live and commit once.

mod arrange;
mod design;
mod effects;
mod motion;
mod position;
pub mod props;

use std::collections::HashMap;

use desyn_core::model::{Design, Op};
use gpui::{
    AnyElement, App, AppContext, Context, Entity, FocusHandle, Focusable, InteractiveElement,
    IntoElement, MouseButton, MouseDownEvent, ParentElement, Pixels, Point, Render, SharedString,
    StatefulInteractiveElement, Styled, Subscription, Window, anchored, deferred, div, point, px,
};
use serde_json::Value;

use crate::ui::actions;
use crate::ui::components::{icon, t, tip};
use crate::ui::editor::{EditorEvent, EditorView};
use crate::ui::ext::{Extensions, PanelSpec, Slot};
use crate::ui::menu::MenuEntry;
use crate::ui::text_field::{FieldEvent, TextField};
use crate::ui::theme::{SANS, Theme, alpha};
use crate::widgets::color::{ColorEvent, ColorPicker, SwatchGroup, document_colors};
use crate::widgets::fonts::{FontEvent, FontPicker};
use crate::widgets::number::{Label, NumberEvent, NumberField};
use crate::widgets::{dialog, hsla, swatch};
use props::Sel;

/// Inspector tabs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tab {
    /// Fill, stroke, text, image, shape.
    Design,
    /// Align, distribute, order, layout.
    Arrange,
    /// Shadows, blurs, masks.
    Effects,
    /// Animations and page timing.
    Animate,
    /// Geometry.
    Position,
}

/// What a color picker edits.
#[derive(Debug, Clone, PartialEq)]
pub enum ColorTarget {
    /// Fill `i` (page background for pages, text fills for text).
    Fill(usize),
    /// Gradient stop `stop` of fill `fill`.
    Stop {
        /// Fill index.
        fill: usize,
        /// Stop index.
        stop: usize,
    },
    /// Stroke color.
    Stroke,
    /// Effect `i` color.
    Effect(usize),
    /// QR foreground.
    QrFg,
    /// QR background.
    QrBg,
    /// Chart series color `i`.
    ChartSeries(usize),
    /// Chart text color.
    ChartText,
    /// Text highlight.
    Highlight,
    /// Table border.
    TableBorder,
}

/// Edits computed for a field: ops and an undo label.
pub type Edit = Option<(Vec<Op>, String)>;

/// The inspector view of one editor.
pub struct Inspector {
    pub(crate) editor: Entity<EditorView>,
    tab: Tab,
    nums: HashMap<String, Entity<NumberField>>,
    texts: HashMap<String, Entity<TextField>>,
    color: Option<(
        ColorTarget,
        Entity<ColorPicker>,
        Point<Pixels>,
        Subscription,
    )>,
    font: Option<(Entity<FontPicker>, Point<Pixels>, Subscription)>,
    eyedropper: Option<ColorTarget>,
    pub(crate) radius_split: bool,
    focus: FocusHandle,
    _subs: Vec<Subscription>,
}

impl Focusable for Inspector {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

/// Registers the inspector in the right column and its shortcut.
pub fn install(cx: &mut App) {
    Extensions::update(cx, |x| {
        x.panel(
            PanelSpec::new(
                "inspector",
                "Inspector",
                "icons/panel-right.svg",
                Slot::Right,
                |editor, window, cx| {
                    let ed = editor.clone();
                    cx.new(|cx| Inspector::new(ed, window, cx)).into()
                },
            )
            .order(10),
        );
    });
}

impl Inspector {
    fn new(editor: Entity<EditorView>, _window: &mut Window, cx: &mut Context<Self>) -> Inspector {
        let subs = vec![
            cx.subscribe(&editor, |this, _, e: &EditorEvent, cx| match e {
                EditorEvent::Selection(_) | EditorEvent::Page(_) => {
                    this.color = None;
                    this.font = None;
                    cx.notify();
                }
                EditorEvent::Changed(_) => cx.notify(),
                _ => {}
            }),
        ];
        Inspector {
            editor,
            tab: Tab::Design,
            nums: HashMap::new(),
            texts: HashMap::new(),
            color: None,
            font: None,
            eyedropper: None,
            radius_split: false,
            focus: cx.focus_handle(),
            _subs: subs,
        }
    }

    /// The selection now.
    pub(crate) fn sel(&self, cx: &App) -> Sel {
        let e = self.editor.read(cx);
        Sel::new(&e.session.doc.design, &e.session.selection, &e.session.page)
    }

    // ---------------------------------------------------------------------------------------------------------
    // Applying edits

    /// Runs `f` on the base design (any preview reverted) and previews or commits the ops it returns.
    pub(crate) fn edit(
        &mut self,
        commit: bool,
        cx: &mut Context<Self>,
        f: impl FnOnce(&Sel, &mut Design) -> Edit,
    ) {
        self.editor.update(cx, |e, cx| {
            let s = &mut e.session;
            s.doc.cancel_preview(s.renderer.text_mut());
            let sel = Sel::new(&s.doc.design, &s.selection, &s.page);
            let Some((ops, label)) = f(&sel, &mut s.doc.design) else {
                e.after(cx);
                return;
            };
            if ops.is_empty() {
                e.after(cx);
                return;
            }
            if commit {
                e.apply(ops, &label, cx);
            } else {
                let s = &mut e.session;
                s.doc.set_preview(ops, s.renderer.text_mut());
                s.sync_assets();
                cx.notify();
            }
        });
        cx.notify();
    }

    /// Cancels a running preview.
    pub(crate) fn cancel_preview(&mut self, cx: &mut Context<Self>) {
        self.editor.update(cx, |e, cx| {
            let s = &mut e.session;
            s.doc.cancel_preview(s.renderer.text_mut());
            cx.notify();
        });
    }

    /// Runs a session command (align, group, ...) and refreshes.
    pub(crate) fn command(
        &mut self,
        cx: &mut Context<Self>,
        f: impl FnOnce(&mut crate::canvas::EditorSession),
    ) {
        self.editor.update(cx, |e, cx| {
            f(&mut e.session);
            e.after(cx);
        });
        cx.notify();
    }

    // ---------------------------------------------------------------------------------------------------------
    // Widgets

    /// A numeric field for `key` showing `value`.
    pub(crate) fn num(
        &mut self,
        key: &str,
        label: Label,
        value: Option<f64>,
        cfg: impl FnOnce(NumberField) -> NumberField,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Entity<NumberField> {
        let f = match self.nums.get(key) {
            Some(f) => f.clone(),
            None => {
                let f = cx.new(|cx| cfg(NumberField::new(label, window, cx)));
                let k = key.to_string();
                let sub = cx.subscribe(&f, move |this, _, e: &NumberEvent, cx| {
                    this.on_number(&k, *e, cx)
                });
                self._subs.push(sub);
                self.nums.insert(key.to_string(), f.clone());
                f
            }
        };
        f.update(cx, |f, cx| f.set_value(value, cx));
        f
    }

    /// A text input for `key` showing `value` (committed on Enter).
    pub(crate) fn text(
        &mut self,
        key: &str,
        placeholder: &str,
        value: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Entity<TextField> {
        let f = match self.texts.get(key) {
            Some(f) => f.clone(),
            None => {
                let f = cx.new(|cx| {
                    let mut f = TextField::new(placeholder.to_string(), cx);
                    f.font_size = 12.5;
                    f
                });
                let k = key.to_string();
                let sub =
                    cx.subscribe_in(&f, window, move |this, f, e: &FieldEvent, window, cx| {
                        if *e == FieldEvent::Confirm {
                            let text = f.read(cx).text().to_string();
                            this.on_text(&k, text, cx);
                            let ed = this.editor.read(cx).focus.clone();
                            window.focus(&ed, cx);
                        }
                    });
                self._subs.push(sub);
                self.texts.insert(key.to_string(), f.clone());
                f
            }
        };
        let focused = f.read(cx).focus_handle(cx).is_focused(window);
        if !focused && f.read(cx).text() != value {
            f.update(cx, |f, cx| f.set_text(value, cx));
        }
        f
    }

    fn on_number(&mut self, key: &str, e: NumberEvent, cx: &mut Context<Self>) {
        let (v, commit) = match e {
            NumberEvent::Preview(v) => (v, false),
            NumberEvent::Commit(v) => (v, true),
            NumberEvent::Cancel => {
                self.cancel_preview(cx);
                return;
            }
        };
        let key = key.to_string();
        self.edit(commit, cx, |sel, d| {
            position::number(&key, v, sel, d)
                .or_else(|| design::number(&key, v, sel, d))
                .or_else(|| arrange::number(&key, v, sel, d))
                .or_else(|| effects::number(&key, v, sel, d))
                .or_else(|| motion::number(&key, v, sel, d))
        });
    }

    fn on_text(&mut self, key: &str, text: String, cx: &mut Context<Self>) {
        let key = key.to_string();
        self.edit(true, cx, |sel, d| design::text(&key, &text, sel, d));
    }

    /// Applies a choice (dropdown / segmented / toggle) for `key`.
    pub(crate) fn choose(&mut self, key: &str, value: Value, cx: &mut Context<Self>) {
        let key = key.to_string();
        self.edit(true, cx, |sel, d| {
            design::choice(&key, &value, sel, d)
                .or_else(|| arrange::choice(&key, &value, sel, d))
                .or_else(|| effects::choice(&key, &value, sel, d))
                .or_else(|| motion::choice(&key, &value, sel, d))
                .or_else(|| position::choice(&key, &value, sel, d))
        });
    }

    /// A menu of choices for `key` opened at the click position.
    pub(crate) fn menu(
        &mut self,
        key: &str,
        options: Vec<(Value, String)>,
        current: Option<&Value>,
        at: Point<Pixels>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let me = cx.entity().downgrade();
        let entries: Vec<MenuEntry> = options
            .into_iter()
            .map(|(v, label)| {
                let me = me.clone();
                let k = key.to_string();
                let checked = current == Some(&v);
                let label = if checked {
                    format!("{label}  ✓")
                } else {
                    label
                };
                MenuEntry::run(label, move |_, cx| {
                    let v = v.clone();
                    let _ = me.update(cx, |this, cx| this.choose(&k, v, cx));
                })
            })
            .collect();
        self.editor
            .update(cx, |e, cx| e.open_menu(entries, at, window, cx));
    }

    /// A color swatch button that opens the picker for `target`.
    pub(crate) fn color_button(
        &mut self,
        id: &str,
        target: ColorTarget,
        color: Option<String>,
        th: &Theme,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let c = color.clone().unwrap_or_else(|| "#000000".into());
        let mixed = color.is_none();
        let shown = if mixed { hsla("#00000000") } else { hsla(&c) };
        let empty = if matches!(target, ColorTarget::Highlight) {
            "None"
        } else {
            "Mixed"
        };
        div()
            .id(SharedString::from(format!("color-{id}")))
            .h(px(28.0))
            .px(px(4.0))
            .flex()
            .items_center()
            .gap(px(8.0))
            .rounded(px(6.0))
            .bg(th.surface2)
            .border_1()
            .border_color(th.border_subtle)
            .cursor_pointer()
            .hover({
                let b = th.border;
                move |s| s.border_color(b)
            })
            .child(swatch(shown, 20.0, th))
            .child(
                div()
                    .flex_1()
                    .font_family(crate::ui::theme::MONO)
                    .text_size(px(11.5))
                    .text_color(if mixed { th.faint } else { th.fg })
                    .child(if mixed {
                        empty.to_string()
                    } else {
                        c.trim_start_matches('#').to_uppercase()
                    }),
            )
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(move |this, e: &MouseDownEvent, window, cx| {
                    this.open_color(
                        target.clone(),
                        &c,
                        point(e.position.x - px(290.0), e.position.y - px(40.0)),
                        window,
                        cx,
                    );
                    cx.stop_propagation();
                }),
            )
            .into_any_element()
    }

    fn swatch_groups(&self, cx: &App) -> Vec<SwatchGroup> {
        let e = self.editor.read(cx);
        let mut groups = vec![SwatchGroup {
            title: "Document".into(),
            colors: document_colors(&e.session.doc.design, 16),
        }];
        if let Some(kits) = crate::panels::brand::cached_kits(cx) {
            for k in kits.iter().take(2) {
                groups.push(SwatchGroup {
                    title: k.name.clone().into(),
                    colors: k.colors.iter().map(|c| c.value.clone()).collect(),
                });
            }
        }
        groups
    }

    fn open_color(
        &mut self,
        target: ColorTarget,
        color: &str,
        at: Point<Pixels>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let groups = self.swatch_groups(cx);
        let picker = cx.new(|cx| ColorPicker::new(color, groups, window, cx));
        let t2 = target.clone();
        let sub = cx.subscribe_in(
            &picker,
            window,
            move |this, _, e: &ColorEvent, _, cx| match e {
                ColorEvent::Preview(c) => this.apply_color(&t2, c, false, cx),
                ColorEvent::Commit(c) => this.apply_color(&t2, c, true, cx),
                ColorEvent::PickFromCanvas => {
                    this.eyedropper = Some(t2.clone());
                    cx.notify();
                }
            },
        );
        self.font = None;
        self.color = Some((target, picker, at, sub));
        cx.notify();
    }

    fn apply_color(
        &mut self,
        target: &ColorTarget,
        color: &str,
        commit: bool,
        cx: &mut Context<Self>,
    ) {
        let target = target.clone();
        let color = color.to_string();
        self.edit(commit, cx, |sel, d| {
            design::color(&target, &color, sel, d)
                .or_else(|| effects::color(&target, &color, sel, d))
        });
    }

    /// Opens the font picker below `at`.
    pub(crate) fn open_font(
        &mut self,
        current: &str,
        at: Point<Pixels>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let families: Vec<String> = self
            .editor
            .read(cx)
            .session
            .renderer
            .text()
            .db()
            .families()
            .into_iter()
            .map(|f| f.name)
            .collect();
        let picker = cx.new(|cx| FontPicker::new(current, families, window, cx));
        let sub = cx.subscribe(&picker, |this, _, e: &FontEvent, cx| {
            let FontEvent::Pick(name) = e;
            this.choose("text.family", Value::String(name.clone()), cx);
        });
        self.color = None;
        self.font = Some((picker, at, sub));
        cx.notify();
    }

    fn sample(&mut self, at: Point<Pixels>, cx: &mut Context<Self>) {
        let Some(target) = self.eyedropper.take() else {
            return;
        };
        let color = self.editor.update(cx, |e, _| {
            let b = e.canvas_bounds?;
            let s = desyn_core::geometry::Point::new(
                f32::from(at.x - b.left()) as f64,
                f32::from(at.y - b.top()) as f64,
            );
            let p = e.session.camera.to_page(s);
            let page = e.session.page.clone();
            let r = e
                .session
                .renderer
                .render_page(
                    &e.session.doc.design,
                    &desyn_raster::PageRenderOptions {
                        page: Some(page),
                        scale: 1.0,
                        region: Some(desyn_core::geometry::Rect {
                            x: p.x.floor(),
                            y: p.y.floor(),
                            w: 1.0,
                            h: 1.0,
                        }),
                        ..Default::default()
                    },
                )
                .ok()?;
            let px = r.pixmap.pixel(0, 0)?.demultiply();
            Some(format!(
                "#{:02x}{:02x}{:02x}",
                px.red(),
                px.green(),
                px.blue()
            ))
        });
        if let Some(c) = color {
            self.apply_color(&target, &c, true, cx);
            if let Some((_, picker, _, _)) = &self.color {
                picker.update(cx, |p, cx| p.set_color(&c, cx));
            }
        }
        cx.notify();
    }

    fn tabs(&mut self, th: &Theme, cx: &mut Context<Self>) -> impl IntoElement {
        let tabs = [
            (Tab::Design, "Design"),
            (Tab::Arrange, "Arrange"),
            (Tab::Effects, "Effects"),
            (Tab::Animate, "Animate"),
            (Tab::Position, "Position"),
        ];
        div()
            .px(px(14.0))
            .pt(px(10.0))
            .flex()
            .justify_between()
            .border_b_1()
            .border_color(th.border_subtle)
            .children(tabs.into_iter().map(|(tab, title)| {
                let active = self.tab == tab;
                let fg = th.fg;
                div()
                    .id(SharedString::from(format!("inspector-tab-{title}")))
                    .pt(px(6.0))
                    .pb(px(9.0))
                    .px(px(2.0))
                    .border_b_2()
                    .border_color(if active {
                        th.accent
                    } else {
                        gpui::transparent_black()
                    })
                    .cursor_pointer()
                    .font_family(SANS)
                    .text_size(px(12.0))
                    .font_weight(gpui::FontWeight(if active { 600.0 } else { 450.0 }))
                    .text_color(if active { th.fg } else { th.muted })
                    .hover(move |s| s.text_color(fg))
                    .child(title)
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.tab = tab;
                        this.color = None;
                        this.font = None;
                        cx.notify();
                    }))
            }))
    }
}

/// A labelled grid of two fields ("X [..]  Y [..]").
pub(crate) fn pair(a: impl IntoElement, b: impl IntoElement) -> impl IntoElement {
    div()
        .flex()
        .gap(px(8.0))
        .child(div().flex_1().min_w(px(0.0)).child(a))
        .child(div().flex_1().min_w(px(0.0)).child(b))
}

/// Inspector section: label + content with the standard rhythm.
pub(crate) fn block(
    label: &str,
    trailing: Option<AnyElement>,
    content: impl IntoElement,
    th: &Theme,
) -> impl IntoElement {
    div()
        .flex()
        .flex_col()
        .gap(px(8.0))
        .py(px(12.0))
        .border_t_1()
        .border_color(th.border_subtle)
        .child(crate::widgets::section(label, trailing, th))
        .child(content)
}

/// A small "+" button for section headers.
pub(crate) fn add_button(id: &str, hint: &str, th: &Theme) -> gpui::Stateful<gpui::Div> {
    let s3 = th.surface3;
    div()
        .id(SharedString::from(format!("add-{id}")))
        .size(px(24.0))
        .flex()
        .items_center()
        .justify_center()
        .rounded(px(6.0))
        .cursor_pointer()
        .hover(move |s| s.bg(s3))
        .tooltip(tip(hint.to_string(), None))
        .child(icon("icons/plus.svg", 14.0, th.muted))
}

/// A muted hint line.
pub(crate) fn hint(text: &str, th: &Theme) -> impl IntoElement {
    div()
        .font_family(SANS)
        .text_size(px(12.0))
        .line_height(px(17.0))
        .text_color(th.faint)
        .child(text.to_string())
}

impl Render for Inspector {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let th = t(window, cx);
        let sel = self.sel(cx);
        let body: AnyElement = match self.tab {
            Tab::Design => self.design_tab(&sel, &th, window, cx),
            Tab::Arrange => self.arrange_tab(&sel, &th, window, cx),
            Tab::Effects => self.effects_tab(&sel, &th, window, cx),
            Tab::Animate => self.animate_tab(&sel, &th, window, cx),
            Tab::Position => self.position_tab(&sel, &th, window, cx),
        };
        let me = cx.entity();
        let size = window.viewport_size();
        let color_pop = self.color.as_ref().map(|(_, picker, at, _)| {
            let me = me.clone();
            dialog::popover(
                "inspector-color",
                *at,
                picker.clone().into_any_element(),
                &th,
                move |_, cx| {
                    me.update(cx, |this, cx| {
                        if this.eyedropper.is_none() {
                            this.color = None;
                            cx.notify();
                        }
                    })
                },
            )
        });
        let font_pop = self.font.as_ref().map(|(picker, at, _)| {
            let me = me.clone();
            dialog::popover(
                "inspector-font",
                *at,
                picker.clone().into_any_element(),
                &th,
                move |_, cx| {
                    me.update(cx, |this, cx| {
                        this.font = None;
                        cx.notify();
                    })
                },
            )
        });
        let dropper = self.eyedropper.is_some().then(|| {
            deferred(
                anchored().position(point(px(0.0), px(0.0))).child(
                    div()
                        .id("eyedropper-capture")
                        .w(size.width)
                        .h(size.height)
                        .cursor_crosshair()
                        .occlude()
                        .bg(alpha(th.accent, 0.03))
                        .child(
                            div()
                                .absolute()
                                .top(px(56.0))
                                .left(size.width / 2.0 - px(150.0))
                                .w(px(300.0))
                                .py(px(8.0))
                                .rounded(px(999.0))
                                .bg(th.glass)
                                .border_1()
                                .border_color(th.border_subtle)
                                .flex()
                                .justify_center()
                                .font_family(SANS)
                                .text_size(px(12.5))
                                .text_color(th.fg)
                                .child("Click the canvas to pick a color · Esc cancels"),
                        )
                        .on_mouse_down(
                            MouseButton::Left,
                            cx.listener(|this, e: &MouseDownEvent, _, cx| {
                                this.sample(e.position, cx);
                                cx.stop_propagation();
                            }),
                        )
                        .on_mouse_down(
                            MouseButton::Right,
                            cx.listener(|this, _, _, cx| {
                                this.eyedropper = None;
                                cx.notify();
                            }),
                        ),
                ),
            )
            .with_priority(30)
        });
        div()
            .id("inspector")
            .key_context("Inspector")
            .track_focus(&self.focus)
            .on_action(cx.listener(|this, _: &actions::Escape, _, cx| {
                this.eyedropper = None;
                this.color = None;
                this.font = None;
                cx.notify();
            }))
            .size_full()
            .flex()
            .flex_col()
            .child(self.tabs(&th, cx))
            .child(
                div()
                    .id("inspector-body")
                    .flex_1()
                    .min_h(px(0.0))
                    .overflow_y_scroll()
                    .px(px(14.0))
                    .pb(px(24.0))
                    .child(body),
            )
            .children(color_pop)
            .children(font_pop)
            .children(dropper)
    }
}

/// Small helper for click positions of menus anchored to a button.
pub(crate) fn below(e: &gpui::ClickEvent) -> Point<Pixels> {
    let p = e.position();
    point(p.x - px(120.0), p.y + px(14.0))
}
