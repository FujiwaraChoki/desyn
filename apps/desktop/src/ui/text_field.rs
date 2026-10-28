//! Single-line text input with full IME support (command palette, rename, settings, size fields). Emits
//! [`FieldEvent`]s; the owner subscribes.

use std::ops::Range;

use gpui::{
    App, Bounds, ClipboardItem, Context, CursorStyle, Element, ElementId, ElementInputHandler,
    Entity, EntityInputHandler, EventEmitter, FocusHandle, Focusable, GlobalElementId, IntoElement,
    LayoutId, MouseButton, MouseDownEvent, MouseMoveEvent, MouseUpEvent, PaintQuad, Pixels, Point,
    Render, ShapedLine, SharedString, Style, TextRun, UTF16Selection, UnderlineStyle, Window, div,
    fill, point, prelude::*, px, relative, size,
};
use unicode_segmentation::UnicodeSegmentation;

use super::actions::{
    Backspace, Cancel, Confirm, Copy, Cut, DeleteForward, DeleteWordBackward, Left, LineEnd,
    LineStart, MenuDown, MenuUp, Paste, Right, SelectAll, SelectLeft, SelectLineEnd,
    SelectLineStart, SelectRight, WordLeft, WordRight,
};
use super::components::t;
use super::theme::{SANS, alpha};

/// Bullet shown for each character of a masked field.
const MASK: char = '•';

/// Events from a field.
#[derive(Debug, Clone, PartialEq)]
pub enum FieldEvent {
    /// Text changed.
    Changed(String),
    /// Enter.
    Confirm,
    /// Escape.
    Cancel,
    /// Arrow up (lists).
    Up,
    /// Arrow down (lists).
    Down,
}

/// The field state.
pub struct TextField {
    focus: FocusHandle,
    text: String,
    placeholder: SharedString,
    selected: Range<usize>,
    reversed: bool,
    marked: Option<Range<usize>>,
    layout: Option<ShapedLine>,
    bounds: Option<Bounds<Pixels>>,
    selecting: bool,
    /// Font size in px.
    pub font_size: f32,
    /// Show bullets instead of the text and refuse copy / cut (passwords).
    pub masked: bool,
}

impl EventEmitter<FieldEvent> for TextField {}

impl Focusable for TextField {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl TextField {
    /// New field.
    pub fn new(placeholder: impl Into<SharedString>, cx: &mut Context<Self>) -> TextField {
        TextField {
            focus: cx.focus_handle(),
            text: String::new(),
            placeholder: placeholder.into(),
            selected: 0..0,
            reversed: false,
            marked: None,
            layout: None,
            bounds: None,
            selecting: false,
            font_size: 14.0,
            masked: false,
        }
    }

    /// Current text.
    pub fn text(&self) -> &str {
        &self.text
    }

    /// Index in the displayed (possibly masked) string for a byte index of the text.
    fn disp(&self, i: usize) -> usize {
        if self.masked {
            self.text[..i.min(self.text.len())].chars().count() * MASK.len_utf8()
        } else {
            i
        }
    }

    /// Byte index of the text for an index in the displayed string.
    fn real(&self, d: usize) -> usize {
        if self.masked {
            let n = d / MASK.len_utf8();
            self.text
                .char_indices()
                .nth(n)
                .map(|(b, _)| b)
                .unwrap_or(self.text.len())
        } else {
            d
        }
    }

    /// Replaces the text and selects all of it.
    pub fn set_text(&mut self, s: &str, cx: &mut Context<Self>) {
        self.text = s.to_string();
        self.selected = 0..self.text.len();
        self.marked = None;
        cx.notify();
    }

    fn cursor(&self) -> usize {
        if self.reversed {
            self.selected.start
        } else {
            self.selected.end
        }
    }

    fn move_to(&mut self, i: usize, cx: &mut Context<Self>) {
        self.selected = i..i;
        self.reversed = false;
        cx.notify();
    }

    fn select_to(&mut self, i: usize, cx: &mut Context<Self>) {
        if self.reversed {
            self.selected.start = i
        } else {
            self.selected.end = i
        }
        if self.selected.end < self.selected.start {
            self.reversed = !self.reversed;
            self.selected = self.selected.end..self.selected.start;
        }
        cx.notify();
    }

    fn prev(&self, i: usize) -> usize {
        self.text
            .grapheme_indices(true)
            .rev()
            .find_map(|(j, _)| (j < i).then_some(j))
            .unwrap_or(0)
    }

    fn next(&self, i: usize) -> usize {
        self.text
            .grapheme_indices(true)
            .find_map(|(j, _)| (j > i).then_some(j))
            .unwrap_or(self.text.len())
    }

    fn prev_word(&self, i: usize) -> usize {
        self.text
            .unicode_word_indices()
            .map(|(j, _)| j)
            .rfind(|j| *j < i)
            .unwrap_or(0)
    }

    fn next_word(&self, i: usize) -> usize {
        self.text
            .unicode_word_indices()
            .map(|(j, w)| j + w.len())
            .find(|j| *j > i)
            .unwrap_or(self.text.len())
    }

    fn replace(&mut self, range: Range<usize>, s: &str, cx: &mut Context<Self>) {
        let s = s.replace(['\n', '\r'], " ");
        self.text.replace_range(range.clone(), &s);
        let c = range.start + s.len();
        self.selected = c..c;
        self.reversed = false;
        self.marked = None;
        cx.emit(FieldEvent::Changed(self.text.clone()));
        cx.notify();
    }

    fn on_backspace(&mut self, _: &Backspace, _: &mut Window, cx: &mut Context<Self>) {
        if self.selected.is_empty() {
            let p = self.prev(self.cursor());
            self.select_to(p, cx);
        }
        self.replace(self.selected.clone(), "", cx);
    }

    fn on_delete(&mut self, _: &DeleteForward, _: &mut Window, cx: &mut Context<Self>) {
        if self.selected.is_empty() {
            let n = self.next(self.cursor());
            self.select_to(n, cx);
        }
        self.replace(self.selected.clone(), "", cx);
    }

    fn on_delete_word(&mut self, _: &DeleteWordBackward, _: &mut Window, cx: &mut Context<Self>) {
        if self.selected.is_empty() {
            let p = self.prev_word(self.cursor());
            self.select_to(p, cx);
        }
        self.replace(self.selected.clone(), "", cx);
    }

    fn on_left(&mut self, _: &Left, _: &mut Window, cx: &mut Context<Self>) {
        let i = if self.selected.is_empty() {
            self.prev(self.cursor())
        } else {
            self.selected.start
        };
        self.move_to(i, cx);
    }

    fn on_right(&mut self, _: &Right, _: &mut Window, cx: &mut Context<Self>) {
        let i = if self.selected.is_empty() {
            self.next(self.cursor())
        } else {
            self.selected.end
        };
        self.move_to(i, cx);
    }

    fn on_word_left(&mut self, _: &WordLeft, _: &mut Window, cx: &mut Context<Self>) {
        let i = self.prev_word(self.cursor());
        self.move_to(i, cx);
    }

    fn on_word_right(&mut self, _: &WordRight, _: &mut Window, cx: &mut Context<Self>) {
        let i = self.next_word(self.cursor());
        self.move_to(i, cx);
    }

    fn on_sel_left(&mut self, _: &SelectLeft, _: &mut Window, cx: &mut Context<Self>) {
        let i = self.prev(self.cursor());
        self.select_to(i, cx);
    }

    fn on_sel_right(&mut self, _: &SelectRight, _: &mut Window, cx: &mut Context<Self>) {
        let i = self.next(self.cursor());
        self.select_to(i, cx);
    }

    fn on_home(&mut self, _: &LineStart, _: &mut Window, cx: &mut Context<Self>) {
        self.move_to(0, cx);
    }

    fn on_end(&mut self, _: &LineEnd, _: &mut Window, cx: &mut Context<Self>) {
        self.move_to(self.text.len(), cx);
    }

    fn on_sel_home(&mut self, _: &SelectLineStart, _: &mut Window, cx: &mut Context<Self>) {
        self.select_to(0, cx);
    }

    fn on_sel_end(&mut self, _: &SelectLineEnd, _: &mut Window, cx: &mut Context<Self>) {
        self.select_to(self.text.len(), cx);
    }

    fn on_select_all(&mut self, _: &SelectAll, _: &mut Window, cx: &mut Context<Self>) {
        self.selected = 0..self.text.len();
        self.reversed = false;
        cx.notify();
    }

    fn on_copy(&mut self, _: &Copy, _: &mut Window, cx: &mut Context<Self>) {
        if !self.selected.is_empty() && !self.masked {
            cx.write_to_clipboard(ClipboardItem::new_string(
                self.text[self.selected.clone()].to_string(),
            ));
        }
    }

    fn on_cut(&mut self, _: &Cut, _: &mut Window, cx: &mut Context<Self>) {
        if !self.selected.is_empty() && !self.masked {
            cx.write_to_clipboard(ClipboardItem::new_string(
                self.text[self.selected.clone()].to_string(),
            ));
            self.replace(self.selected.clone(), "", cx);
        }
    }

    fn on_paste(&mut self, _: &Paste, _: &mut Window, cx: &mut Context<Self>) {
        if let Some(s) = cx.read_from_clipboard().and_then(|i| i.text()) {
            self.replace(self.selected.clone(), &s, cx);
        }
    }

    fn on_confirm(&mut self, _: &Confirm, _: &mut Window, cx: &mut Context<Self>) {
        cx.emit(FieldEvent::Confirm);
    }

    fn on_cancel(&mut self, _: &Cancel, _: &mut Window, cx: &mut Context<Self>) {
        cx.emit(FieldEvent::Cancel);
    }

    fn on_up(&mut self, _: &MenuUp, _: &mut Window, cx: &mut Context<Self>) {
        cx.emit(FieldEvent::Up);
    }

    fn on_down(&mut self, _: &MenuDown, _: &mut Window, cx: &mut Context<Self>) {
        cx.emit(FieldEvent::Down);
    }

    fn index_at(&self, p: Point<Pixels>) -> usize {
        let (Some(b), Some(l)) = (self.bounds, self.layout.as_ref()) else {
            return 0;
        };
        if p.x <= b.left() {
            return 0;
        }
        let d = l.closest_index_for_x(p.x - b.left());
        self.real(d).min(self.text.len())
    }

    fn on_mouse_down(&mut self, e: &MouseDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        window.focus(&self.focus, cx);
        self.selecting = true;
        let i = self.index_at(e.position);
        if e.modifiers.shift {
            self.select_to(i, cx)
        } else if e.click_count >= 2 {
            self.selected = 0..self.text.len();
            cx.notify();
        } else {
            self.move_to(i, cx)
        }
    }

    fn on_mouse_up(&mut self, _: &MouseUpEvent, _: &mut Window, _: &mut Context<Self>) {
        self.selecting = false;
    }

    fn on_mouse_move(&mut self, e: &MouseMoveEvent, _: &mut Window, cx: &mut Context<Self>) {
        if self.selecting {
            let i = self.index_at(e.position);
            self.select_to(i, cx);
        }
    }

    fn to16(&self, i: usize) -> usize {
        self.text[..i.min(self.text.len())].encode_utf16().count()
    }

    fn from16(&self, i: usize) -> usize {
        let mut n = 0;
        for (b, ch) in self.text.char_indices() {
            if n >= i {
                return b;
            }
            n += ch.len_utf16();
        }
        self.text.len()
    }
}

impl EntityInputHandler for TextField {
    fn text_for_range(
        &mut self,
        r: Range<usize>,
        adjusted: &mut Option<Range<usize>>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<String> {
        let range = self.from16(r.start)..self.from16(r.end);
        adjusted.replace(self.to16(range.start)..self.to16(range.end));
        Some(self.text[range].to_string())
    }

    fn selected_text_range(
        &mut self,
        _: bool,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<UTF16Selection> {
        Some(UTF16Selection {
            range: self.to16(self.selected.start)..self.to16(self.selected.end),
            reversed: self.reversed,
        })
    }

    fn marked_text_range(&self, _: &mut Window, _: &mut Context<Self>) -> Option<Range<usize>> {
        self.marked
            .as_ref()
            .map(|r| self.to16(r.start)..self.to16(r.end))
    }

    fn unmark_text(&mut self, _: &mut Window, _: &mut Context<Self>) {
        self.marked = None;
    }

    fn replace_text_in_range(
        &mut self,
        r: Option<Range<usize>>,
        s: &str,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let range = r
            .map(|r| self.from16(r.start)..self.from16(r.end))
            .or(self.marked.clone())
            .unwrap_or(self.selected.clone());
        self.replace(range, s, cx);
    }

    fn replace_and_mark_text_in_range(
        &mut self,
        r: Option<Range<usize>>,
        s: &str,
        sel: Option<Range<usize>>,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let range = r
            .map(|r| self.from16(r.start)..self.from16(r.end))
            .or(self.marked.clone())
            .unwrap_or(self.selected.clone());
        self.text.replace_range(range.clone(), s);
        self.marked = (!s.is_empty()).then(|| range.start..range.start + s.len());
        self.selected = sel
            .map(|r| range.start + r.start..range.start + r.end)
            .unwrap_or(range.start + s.len()..range.start + s.len());
        cx.emit(FieldEvent::Changed(self.text.clone()));
        cx.notify();
    }

    fn bounds_for_range(
        &mut self,
        r: Range<usize>,
        bounds: Bounds<Pixels>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<Bounds<Pixels>> {
        let l = self.layout.as_ref()?;
        let range = self.from16(r.start)..self.from16(r.end);
        Some(Bounds::from_corners(
            point(
                bounds.left() + l.x_for_index(self.disp(range.start)),
                bounds.top(),
            ),
            point(
                bounds.left() + l.x_for_index(self.disp(range.end)),
                bounds.bottom(),
            ),
        ))
    }

    fn character_index_for_point(
        &mut self,
        p: Point<Pixels>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<usize> {
        Some(self.to16(self.index_at(p)))
    }
}

struct FieldElement {
    field: Entity<TextField>,
}

struct Prepaint {
    line: Option<ShapedLine>,
    cursor: Option<PaintQuad>,
    selection: Option<PaintQuad>,
}

impl IntoElement for FieldElement {
    type Element = Self;
    fn into_element(self) -> Self::Element {
        self
    }
}

impl Element for FieldElement {
    type RequestLayoutState = ();
    type PrepaintState = Prepaint;

    fn id(&self) -> Option<ElementId> {
        None
    }

    fn source_location(&self) -> Option<&'static core::panic::Location<'static>> {
        None
    }

    fn request_layout(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&gpui::InspectorElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> (LayoutId, ()) {
        let fs = self.field.read(cx).font_size;
        let mut style = Style::default();
        style.size.width = relative(1.).into();
        style.size.height = px(fs * 1.5).into();
        (window.request_layout(style, [], cx), ())
    }

    fn prepaint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&gpui::InspectorElementId>,
        bounds: Bounds<Pixels>,
        _: &mut (),
        window: &mut Window,
        cx: &mut App,
    ) -> Prepaint {
        let th = t(window, cx);
        let f = self.field.read(cx);
        let (text, color) = if f.text.is_empty() {
            (f.placeholder.clone(), th.faint)
        } else if f.masked {
            (
                SharedString::from(MASK.to_string().repeat(f.text.chars().count())),
                th.fg,
            )
        } else {
            (SharedString::from(f.text.clone()), th.fg)
        };
        let font = gpui::Font {
            family: SANS.into(),
            ..window.text_style().font()
        };
        let run = TextRun {
            len: text.len(),
            font,
            color,
            background_color: None,
            underline: None,
            strikethrough: None,
        };
        let runs = match &f.marked {
            Some(m) if !f.text.is_empty() && !f.masked => [
                TextRun {
                    len: m.start,
                    ..run.clone()
                },
                TextRun {
                    len: m.end - m.start,
                    underline: Some(UnderlineStyle {
                        color: Some(color),
                        thickness: px(1.0),
                        wavy: false,
                    }),
                    ..run.clone()
                },
                TextRun {
                    len: text.len() - m.end,
                    ..run
                },
            ]
            .into_iter()
            .filter(|r| r.len > 0)
            .collect(),
            _ => vec![run],
        };
        let line = window
            .text_system()
            .shape_line(text, px(f.font_size), &runs, None);
        let h = bounds.size.height;
        let focused = f.focus.is_focused(window);
        let (selection, cursor) = if !focused {
            (None, None)
        } else if f.selected.is_empty() || f.text.is_empty() {
            let x = if f.text.is_empty() {
                px(0.0)
            } else {
                line.x_for_index(f.disp(f.cursor()))
            };
            (
                None,
                Some(fill(
                    Bounds::new(
                        point(bounds.left() + x, bounds.top() + px(2.0)),
                        size(px(1.5), h - px(4.0)),
                    ),
                    th.accent,
                )),
            )
        } else {
            (
                Some(fill(
                    Bounds::from_corners(
                        point(
                            bounds.left() + line.x_for_index(f.disp(f.selected.start)),
                            bounds.top(),
                        ),
                        point(
                            bounds.left() + line.x_for_index(f.disp(f.selected.end)),
                            bounds.bottom(),
                        ),
                    ),
                    alpha(th.accent, 0.3),
                )),
                None,
            )
        };
        Prepaint {
            line: Some(line),
            cursor,
            selection,
        }
    }

    fn paint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&gpui::InspectorElementId>,
        bounds: Bounds<Pixels>,
        _: &mut (),
        p: &mut Prepaint,
        window: &mut Window,
        cx: &mut App,
    ) {
        let focus = self.field.read(cx).focus.clone();
        window.handle_input(
            &focus,
            ElementInputHandler::new(bounds, self.field.clone()),
            cx,
        );
        if let Some(s) = p.selection.take() {
            window.paint_quad(s);
        }
        let Some(line) = p.line.take() else { return };
        let fs = self.field.read(cx).font_size;
        let _ = line.paint(
            bounds.origin,
            px(fs * 1.5),
            gpui::TextAlign::Left,
            None,
            window,
            cx,
        );
        if focus.is_focused(window)
            && let Some(c) = p.cursor.take()
        {
            window.paint_quad(c);
        }
        self.field.update(cx, |f, _| {
            f.layout = Some(line);
            f.bounds = Some(bounds);
        });
    }
}

impl Render for TextField {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        div()
            .key_context("TextField")
            .track_focus(&self.focus)
            .cursor(CursorStyle::IBeam)
            .w_full()
            .on_action(cx.listener(Self::on_backspace))
            .on_action(cx.listener(Self::on_delete))
            .on_action(cx.listener(Self::on_delete_word))
            .on_action(cx.listener(Self::on_left))
            .on_action(cx.listener(Self::on_right))
            .on_action(cx.listener(Self::on_word_left))
            .on_action(cx.listener(Self::on_word_right))
            .on_action(cx.listener(Self::on_sel_left))
            .on_action(cx.listener(Self::on_sel_right))
            .on_action(cx.listener(Self::on_home))
            .on_action(cx.listener(Self::on_end))
            .on_action(cx.listener(Self::on_sel_home))
            .on_action(cx.listener(Self::on_sel_end))
            .on_action(cx.listener(Self::on_select_all))
            .on_action(cx.listener(Self::on_copy))
            .on_action(cx.listener(Self::on_cut))
            .on_action(cx.listener(Self::on_paste))
            .on_action(cx.listener(Self::on_confirm))
            .on_action(cx.listener(Self::on_cancel))
            .on_action(cx.listener(Self::on_up))
            .on_action(cx.listener(Self::on_down))
            .on_mouse_down(MouseButton::Left, cx.listener(Self::on_mouse_down))
            .on_mouse_up(MouseButton::Left, cx.listener(Self::on_mouse_up))
            .on_mouse_up_out(MouseButton::Left, cx.listener(Self::on_mouse_up))
            .on_mouse_move(cx.listener(Self::on_mouse_move))
            .child(FieldElement { field: cx.entity() })
    }
}
