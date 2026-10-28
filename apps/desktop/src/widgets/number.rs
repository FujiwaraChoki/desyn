//! Numeric field with a scrubbable label (DESIGN_SYSTEM §5): drag the label to change the value (shift = 10x),
//! click the number to type (simple math like `120+24` or `50%` of nothing is evaluated), arrow keys step,
//! Enter / blur commits, Escape cancels. Emits [`NumberEvent::Preview`] while scrubbing and
//! [`NumberEvent::Commit`] once at the end, so owners record one undo step per gesture.

use gpui::{
    App, AppContext, Context, Entity, EventEmitter, FocusHandle, Focusable, InteractiveElement,
    IntoElement, MouseButton, MouseDownEvent, ParentElement, Pixels, Point, Render, SharedString,
    StatefulInteractiveElement, Styled, Subscription, Window, div, prelude::FluentBuilder, px,
};

use super::capture;
use crate::ui::components::{icon, t};
use crate::ui::text_field::{FieldEvent, TextField};
use crate::ui::theme::{MONO, SANS, alpha};

/// What the field reports.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum NumberEvent {
    /// Live value while scrubbing.
    Preview(f64),
    /// Final value (typed, stepped or end of a scrub).
    Commit(f64),
    /// Scrub or typing cancelled (revert previews).
    Cancel,
}

/// The label of a field.
#[derive(Debug, Clone)]
pub enum Label {
    /// Short text ("X", "W", "°").
    Text(SharedString),
    /// An icon.
    Icon(&'static str),
}

/// Evaluates `+ - * /` with parentheses (`"120+24*2"` = 168).
pub fn eval(expr: &str) -> Option<f64> {
    struct P<'a> {
        s: &'a [u8],
        i: usize,
    }
    impl P<'_> {
        fn ws(&mut self) {
            while self.i < self.s.len() && self.s[self.i].is_ascii_whitespace() {
                self.i += 1;
            }
        }
        fn expr(&mut self) -> Option<f64> {
            let mut v = self.term()?;
            loop {
                self.ws();
                match self.s.get(self.i) {
                    Some(b'+') => {
                        self.i += 1;
                        v += self.term()?;
                    }
                    Some(b'-') => {
                        self.i += 1;
                        v -= self.term()?;
                    }
                    _ => return Some(v),
                }
            }
        }
        fn term(&mut self) -> Option<f64> {
            let mut v = self.factor()?;
            loop {
                self.ws();
                match self.s.get(self.i) {
                    Some(b'*') | Some(b'x') => {
                        self.i += 1;
                        v *= self.factor()?;
                    }
                    Some(b'/') => {
                        self.i += 1;
                        let d = self.factor()?;
                        if d == 0.0 {
                            return None;
                        }
                        v /= d;
                    }
                    _ => return Some(v),
                }
            }
        }
        fn factor(&mut self) -> Option<f64> {
            self.ws();
            match self.s.get(self.i)? {
                b'-' => {
                    self.i += 1;
                    Some(-self.factor()?)
                }
                b'+' => {
                    self.i += 1;
                    self.factor()
                }
                b'(' => {
                    self.i += 1;
                    let v = self.expr()?;
                    self.ws();
                    (self.s.get(self.i) == Some(&b')')).then(|| {
                        self.i += 1;
                        v
                    })
                }
                _ => {
                    let start = self.i;
                    while self.i < self.s.len()
                        && (self.s[self.i].is_ascii_digit() || self.s[self.i] == b'.')
                    {
                        self.i += 1;
                    }
                    std::str::from_utf8(&self.s[start..self.i])
                        .ok()?
                        .parse()
                        .ok()
                }
            }
        }
    }
    let cleaned: String = expr
        .trim()
        .trim_end_matches(['%', '°'])
        .trim_end_matches("px")
        .replace(',', ".");
    let mut p = P {
        s: cleaned.as_bytes(),
        i: 0,
    };
    let v = p.expr()?;
    p.ws();
    (p.i == p.s.len() && v.is_finite()).then_some(v)
}

/// Formats a value with at most `precision` decimals (no trailing zeros).
pub fn format(v: f64, precision: usize) -> String {
    let s = format!("{v:.precision$}");
    let s = if s.contains('.') {
        s.trim_end_matches('0').trim_end_matches('.').to_string()
    } else {
        s
    };
    if s == "-0" { "0".into() } else { s }
}

/// The field.
pub struct NumberField {
    label: Label,
    tooltip: Option<SharedString>,
    value: Option<f64>,
    /// Shown value = stored value × `display_scale` (opacity 0..1 shown as 0..100).
    display_scale: f64,
    unit: SharedString,
    min: f64,
    max: f64,
    step: f64,
    precision: usize,
    disabled: bool,
    field: Entity<TextField>,
    editing: bool,
    scrub: Option<(Pixels, f64, bool)>,
    focus: FocusHandle,
    _subs: Vec<Subscription>,
}

impl EventEmitter<NumberEvent> for NumberField {}

impl Focusable for NumberField {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl NumberField {
    /// A field (range unbounded, step 1, precision 2).
    pub fn new(label: Label, window: &mut Window, cx: &mut Context<Self>) -> NumberField {
        let field = cx.new(|cx| {
            let mut f = TextField::new("", cx);
            f.font_size = 12.0;
            f
        });
        let fh = field.focus_handle(cx);
        let subs = vec![
            cx.subscribe_in(
                &field,
                window,
                |this, field, e: &FieldEvent, window, cx| match e {
                    FieldEvent::Confirm => {
                        let text = field.read(cx).text().to_string();
                        this.finish_typing(Some(text), window, cx);
                    }
                    FieldEvent::Cancel => this.finish_typing(None, window, cx),
                    FieldEvent::Up => this.step_by(1.0, cx),
                    FieldEvent::Down => this.step_by(-1.0, cx),
                    FieldEvent::Changed(_) => {}
                },
            ),
            cx.on_blur(&fh, window, |this, window, cx| {
                if this.editing {
                    let text = this.field.read(cx).text().to_string();
                    this.finish_typing(Some(text), window, cx);
                }
            }),
        ];
        NumberField {
            label,
            tooltip: None,
            value: None,
            display_scale: 1.0,
            unit: SharedString::default(),
            min: f64::NEG_INFINITY,
            max: f64::INFINITY,
            step: 1.0,
            precision: 2,
            disabled: false,
            field,
            editing: false,
            scrub: None,
            focus: cx.focus_handle(),
            _subs: subs,
        }
    }

    /// Unit suffix ("px", "%", "°").
    pub fn unit(mut self, unit: &'static str) -> Self {
        self.unit = unit.into();
        self
    }

    /// Value range (in stored units).
    pub fn range(mut self, min: f64, max: f64) -> Self {
        self.min = min;
        self.max = max;
        self
    }

    /// Step per pixel of scrubbing / per arrow press (in displayed units).
    pub fn step(mut self, step: f64) -> Self {
        self.step = step;
        self
    }

    /// Decimals shown.
    pub fn precision(mut self, p: usize) -> Self {
        self.precision = p;
        self
    }

    /// Display scale (opacity 0..1 shown as 0..100).
    pub fn display_scale(mut self, s: f64) -> Self {
        self.display_scale = s;
        self
    }

    /// Tooltip.
    pub fn tooltip(mut self, t: &'static str) -> Self {
        self.tooltip = Some(t.into());
        self
    }

    /// Updates the shown value (`None` = mixed); ignored while the user is typing or scrubbing.
    pub fn set_value(&mut self, v: Option<f64>, cx: &mut Context<Self>) {
        if self.editing || self.scrub.is_some() {
            return;
        }
        if self.value != v {
            self.value = v;
            cx.notify();
        }
    }

    /// The value shown (`None` = mixed).
    pub fn value(&self) -> Option<f64> {
        self.value
    }

    /// Enables / disables the field.
    pub fn set_disabled(&mut self, d: bool, cx: &mut Context<Self>) {
        if self.disabled != d {
            self.disabled = d;
            cx.notify();
        }
    }

    fn clamp(&self, v: f64) -> f64 {
        v.clamp(self.min, self.max)
    }

    fn shown(&self) -> String {
        match self.value {
            Some(v) => format(v * self.display_scale, self.precision),
            None => "Mixed".into(),
        }
    }

    fn start_typing(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.disabled {
            return;
        }
        let text = self
            .value
            .map(|v| format(v * self.display_scale, self.precision))
            .unwrap_or_default();
        self.field.update(cx, |f, cx| f.set_text(&text, cx));
        self.editing = true;
        let fh = self.field.focus_handle(cx);
        window.focus(&fh, cx);
        cx.notify();
    }

    fn finish_typing(&mut self, text: Option<String>, window: &mut Window, cx: &mut Context<Self>) {
        if !self.editing {
            return;
        }
        self.editing = false;
        if let Some(v) = text.as_deref().and_then(eval) {
            let v = self.clamp(v / self.display_scale);
            self.value = Some(v);
            cx.emit(NumberEvent::Commit(v));
        }
        window.focus(&self.focus, cx);
        cx.notify();
    }

    fn step_by(&mut self, dir: f64, cx: &mut Context<Self>) {
        let Some(v) = self.value else { return };
        let nv = self.clamp(v + dir * self.step / self.display_scale);
        self.value = Some(nv);
        let text = format(nv * self.display_scale, self.precision);
        self.field.update(cx, |f, cx| f.set_text(&text, cx));
        cx.emit(NumberEvent::Commit(nv));
        cx.notify();
    }

    fn scrub_to(&mut self, p: Point<Pixels>, shift: bool, cx: &mut Context<Self>) {
        let Some((x0, v0, _)) = self.scrub else {
            return;
        };
        let dx = f32::from(p.x - x0) as f64;
        let factor = if shift { 10.0 } else { 1.0 };
        let raw = v0 * self.display_scale + (dx / 2.0).round() * self.step * factor;
        let v = self.clamp(raw / self.display_scale);
        let v = (v * 10f64.powi(self.precision as i32)).round() / 10f64.powi(self.precision as i32);
        if self.value != Some(v) {
            self.value = Some(v);
            self.scrub = Some((x0, v0, true));
            cx.emit(NumberEvent::Preview(v));
            cx.notify();
        }
    }

    fn end_scrub(&mut self, cx: &mut Context<Self>) {
        if let Some((_, _, moved)) = self.scrub.take() {
            if let (true, Some(v)) = (moved, self.value) {
                cx.emit(NumberEvent::Commit(v));
            }
            cx.notify();
        }
    }
}

impl Render for NumberField {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let th = t(window, cx);
        let me = cx.entity();
        let focused = self.editing;
        let label: gpui::AnyElement = match &self.label {
            Label::Text(s) => div()
                .font_family(SANS)
                .text_size(px(11.0))
                .text_color(th.faint)
                .child(s.clone())
                .into_any_element(),
            Label::Icon(p) => icon(*p, 13.0, th.faint).into_any_element(),
        };
        let mixed = self.value.is_none();
        div()
            .id("number")
            .track_focus(&self.focus)
            .h(px(28.0))
            .w_full()
            .min_w(px(0.0))
            .flex()
            .items_center()
            .rounded(px(6.0))
            .bg(th.surface2)
            .border_1()
            .border_color(if focused {
                alpha(th.accent, 0.6)
            } else {
                th.border_subtle
            })
            .when(self.disabled, |d| d.opacity(0.45))
            .when_some(self.tooltip.clone(), |d, tt| {
                d.tooltip(crate::ui::components::tip(tt, None))
            })
            .child(
                div()
                    .id("scrub")
                    .w(px(24.0))
                    .h_full()
                    .flex_none()
                    .flex()
                    .items_center()
                    .justify_center()
                    .cursor(gpui::CursorStyle::ResizeLeftRight)
                    .child(label)
                    .on_mouse_down(
                        MouseButton::Left,
                        cx.listener(|this, e: &MouseDownEvent, _, cx| {
                            if this.disabled {
                                return;
                            }
                            let v = this.value.unwrap_or(0.0);
                            this.scrub = Some((e.position.x, v, false));
                            cx.stop_propagation();
                            cx.notify();
                        }),
                    ),
            )
            .child(
                div()
                    .id("value")
                    .flex_1()
                    .min_w(px(0.0))
                    .h_full()
                    .flex()
                    .items_center()
                    .cursor_text()
                    .map(|d| {
                        if self.editing {
                            d.child(self.field.clone())
                        } else {
                            d.child(
                                div()
                                    .truncate()
                                    .font_family(if mixed { SANS } else { MONO })
                                    .text_size(px(12.0))
                                    .text_color(if mixed { th.faint } else { th.fg })
                                    .child(self.shown()),
                            )
                        }
                    })
                    .on_click(cx.listener(|this, _, window, cx| {
                        if !this.editing {
                            this.start_typing(window, cx)
                        }
                    })),
            )
            .when(!self.unit.is_empty(), |d| {
                d.child(
                    div()
                        .pr(px(7.0))
                        .flex_none()
                        .font_family(MONO)
                        .text_size(px(10.5))
                        .text_color(th.faint)
                        .child(self.unit.clone()),
                )
            })
            .child(capture(
                &me,
                self.scrub.is_some(),
                |this, p, shift, _, cx| this.scrub_to(p, shift, cx),
                |this, _, _, cx| this.end_scrub(cx),
            ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn evaluates_math() {
        assert_eq!(eval("120"), Some(120.0));
        assert_eq!(eval("120+24*2"), Some(168.0));
        assert_eq!(eval("(1+2)*3"), Some(9.0));
        assert_eq!(eval(" -4.5 "), Some(-4.5));
        assert_eq!(eval("50%"), Some(50.0));
        assert_eq!(eval("12,5px"), Some(12.5));
        assert_eq!(eval("1/0"), None);
        assert_eq!(eval("abc"), None);
        assert_eq!(eval("2*"), None);
    }

    #[test]
    fn formats_compactly() {
        assert_eq!(format(1.0, 2), "1");
        assert_eq!(format(1.256, 2), "1.26");
        assert_eq!(format(-0.0001, 2), "0");
        assert_eq!(format(100.5, 0), "100");
    }
}
