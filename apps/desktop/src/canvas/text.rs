//! In-place text editing. A session edits the runs of one text node; every change becomes a document preview
//! (the canvas re-renders through desyn-raster, so what you type is exactly what exports), and leaving the
//! session commits one transaction. Caret, selection and navigation use desyn-text's layout (`LaidOutText`), so
//! bidi, ligatures, wrapping and lists behave like the renderer. IME composition ("marked text") is part of the
//! buffer and shown underlined; the UI maps the platform's UTF-16 ranges with [`TextSession::to_utf16`].

use std::ops::Range;

use desyn_core::Op;
use desyn_core::model::{Id, Node, TextNode, TextRun, TextStylePatch};
use desyn_text::{Affinity, LaidOutText, Movement, TextPosition, utf8_to_utf16, utf16_to_utf8};
use serde_json::{Map, Value, json};
use unicode_segmentation::UnicodeSegmentation;

/// Rich text buffer: the node's runs with byte-offset editing.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct TextBuffer {
    runs: Vec<TextRun>,
}

impl TextBuffer {
    /// From a node's runs.
    pub fn new(runs: Vec<TextRun>) -> TextBuffer {
        let mut b = TextBuffer { runs };
        b.normalize();
        b
    }

    /// The concatenated text.
    pub fn text(&self) -> String {
        self.runs.iter().map(|r| r.text.as_str()).collect()
    }

    /// Byte length.
    pub fn len(&self) -> usize {
        self.runs.iter().map(|r| r.text.len()).sum()
    }

    /// Empty text.
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Runs for the model (adjacent runs with equal styles merged, at least one run).
    pub fn runs(&self) -> Vec<TextRun> {
        let mut out: Vec<TextRun> = Vec::new();
        for r in &self.runs {
            if let Some(last) = out.last_mut()
                && last.style == r.style
                && last.extra == r.extra
            {
                last.text.push_str(&r.text);
                continue;
            }
            if r.text.is_empty() && !out.is_empty() {
                continue;
            }
            out.push(r.clone());
        }
        if out.is_empty() {
            out.push(TextRun {
                text: String::new(),
                style: None,
                extra: Default::default(),
            });
        }
        if out.len() > 1 {
            out.retain(|r| !r.text.is_empty());
        }
        out
    }

    fn normalize(&mut self) {
        let runs = self.runs();
        self.runs = runs;
    }

    /// Run index and offset inside it for a byte index; at a boundary the run *before* wins (typing continues
    /// the style of the preceding character).
    fn locate(&self, index: usize) -> (usize, usize) {
        let mut pos = 0;
        for (i, r) in self.runs.iter().enumerate() {
            let end = pos + r.text.len();
            if index <= end && (index > pos || i == 0 || r.text.is_empty()) {
                return (i, index - pos);
            }
            pos = end;
        }
        let last = self.runs.len().saturating_sub(1);
        (last, self.runs.get(last).map(|r| r.text.len()).unwrap_or(0))
    }

    /// Style override at a byte index (the style typing would use).
    pub fn style_at(&self, index: usize) -> Option<TextStylePatch> {
        let (i, _) = self.locate(index);
        self.runs.get(i).and_then(|r| r.style.clone())
    }

    /// Replaces `range` with `s`. New text takes the style of the run at `range.start` (or `style` when given).
    pub fn replace(&mut self, range: Range<usize>, s: &str, style: Option<Option<TextStylePatch>>) {
        let range = self.clamp(range);
        self.delete(range.clone());
        if s.is_empty() {
            return;
        }
        if self.runs.is_empty() {
            self.runs.push(TextRun {
                text: String::new(),
                style: None,
                extra: Default::default(),
            });
        }
        let (ri, off) = self.locate(range.start);
        match style {
            Some(st) if self.runs[ri].style != st => {
                let tail = self.runs[ri].text.split_off(off);
                let extra = self.runs[ri].extra.clone();
                let inserted = TextRun {
                    text: s.to_string(),
                    style: st,
                    extra: extra.clone(),
                };
                let after = TextRun {
                    text: tail,
                    style: self.runs[ri].style.clone(),
                    extra,
                };
                self.runs.insert(ri + 1, inserted);
                self.runs.insert(ri + 2, after);
            }
            _ => self.runs[ri].text.insert_str(off, s),
        }
        self.normalize();
    }

    /// Deletes a byte range.
    pub fn delete(&mut self, range: Range<usize>) {
        let range = self.clamp(range);
        if range.is_empty() {
            return;
        }
        let mut pos = 0;
        for r in &mut self.runs {
            let start = pos;
            let end = pos + r.text.len();
            pos = end;
            let a = range.start.max(start);
            let b = range.end.min(end);
            if a < b {
                r.text.replace_range(a - start..b - start, "");
            }
        }
        // Keep the style of a run emptied at the caret so typing continues in it.
        let keep_first = self.runs.iter().position(|r| r.text.is_empty());
        let mut i = 0;
        self.runs.retain(|r| {
            let k = !r.text.is_empty() || Some(i) == keep_first;
            i += 1;
            k
        });
    }

    fn clamp(&self, r: Range<usize>) -> Range<usize> {
        let len = self.len();
        let text = self.text();
        let fix = |mut i: usize| {
            i = i.min(len);
            while i > 0 && !text.is_char_boundary(i) {
                i -= 1;
            }
            i
        };
        let (a, b) = (fix(r.start.min(r.end)), fix(r.start.max(r.end)));
        a..b
    }

    /// Applies `f` to the style override of every character in `range` (splitting runs at the edges).
    pub fn restyle(&mut self, range: Range<usize>, f: &dyn Fn(&mut TextStylePatch)) {
        let range = self.clamp(range);
        if range.is_empty() {
            return;
        }
        let mut out = Vec::new();
        let mut pos = 0;
        for r in std::mem::take(&mut self.runs) {
            let start = pos;
            let end = pos + r.text.len();
            pos = end;
            let a = range.start.clamp(start, end) - start;
            let b = range.end.clamp(start, end) - start;
            if a == b {
                out.push(r);
                continue;
            }
            let (before, rest) = r.text.split_at(a);
            let (mid, after) = rest.split_at(b - a);
            if !before.is_empty() {
                out.push(TextRun {
                    text: before.into(),
                    style: r.style.clone(),
                    extra: r.extra.clone(),
                });
            }
            let mut st = r.style.clone().unwrap_or_default();
            f(&mut st);
            let st = (st != TextStylePatch::default()).then_some(st);
            out.push(TextRun {
                text: mid.into(),
                style: st,
                extra: r.extra.clone(),
            });
            if !after.is_empty() {
                out.push(TextRun {
                    text: after.into(),
                    style: r.style.clone(),
                    extra: r.extra.clone(),
                });
            }
        }
        self.runs = out;
        self.normalize();
    }

    /// Whether every character in `range` satisfies `pred` given the effective style (patch over `base`).
    pub fn all(&self, range: Range<usize>, pred: &dyn Fn(Option<&TextStylePatch>) -> bool) -> bool {
        let range = self.clamp(range);
        let mut pos = 0;
        let mut any = false;
        for r in &self.runs {
            let (start, end) = (pos, pos + r.text.len());
            pos = end;
            if range.start < end && start < range.end {
                any = true;
                if !pred(r.style.as_ref()) {
                    return false;
                }
            }
        }
        any
    }
}

/// Text formatting commands (shortcuts of the docs table).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Format {
    /// mod+B.
    Bold,
    /// mod+I.
    Italic,
    /// mod+U.
    Underline,
    /// mod+shift+X.
    Strikethrough,
    /// mod+shift+. (+1 step).
    Bigger,
    /// mod+shift+, (-1 step).
    Smaller,
}

/// Checks and normalizes a link typed by the user: `https://` / `http://` / `mailto:` / `tel:` URLs and
/// `page:<id>` links stay as typed, a bare domain gains `https://`, an empty string removes the link
/// (`Ok(None)`). Anything else (notably `javascript:` and `data:` URLs, which would run in share pages and
/// exported PDFs) is rejected with a message for people.
pub fn normalize_link(input: &str) -> Result<Option<String>, String> {
    let t = input.trim();
    if t.is_empty() {
        return Ok(None);
    }
    if t.chars().any(|c| c.is_control()) || t.len() > 2048 {
        return Err("This link is not valid.".into());
    }
    let lower = t.to_ascii_lowercase();
    if let Some(id) = t.strip_prefix("page:") {
        return if !id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric()) {
            Ok(Some(t.to_string()))
        } else {
            Err("Page links look like page:<page id>.".into())
        };
    }
    let has_host = |rest: &str| {
        let host = rest.split(['/', '?', '#']).next().unwrap_or("");
        !host.is_empty() && !host.contains(char::is_whitespace)
    };
    for scheme in ["https://", "http://"] {
        if lower.starts_with(scheme) {
            return if has_host(&t[scheme.len()..]) {
                Ok(Some(t.to_string()))
            } else {
                Err("This link has no address.".into())
            };
        }
    }
    for scheme in ["mailto:", "tel:"] {
        if lower.starts_with(scheme) {
            return if t.len() > scheme.len() && !t.contains(char::is_whitespace) {
                Ok(Some(t.to_string()))
            } else {
                Err("This link is not valid.".into())
            };
        }
    }
    // Anything with a scheme of its own is refused; a bare domain ("desyn.app/pricing") becomes https.
    let scheme_like = t.split_once(':').is_some_and(|(s, _)| {
        !s.is_empty()
            && s.chars()
                .all(|c| c.is_ascii_alphanumeric() || "+-.".contains(c))
    });
    let host = t.split(['/', '?', '#']).next().unwrap_or("");
    if !scheme_like && host.contains('.') && !t.contains(char::is_whitespace) {
        return Ok(Some(format!("https://{t}")));
    }
    Err("Use a web address (https://…), an email (mailto:…) or a phone number (tel:…).".into())
}

/// Font-size steps for bigger / smaller.
pub const SIZE_STEPS: [f64; 22] = [
    6.0, 8.0, 9.0, 10.0, 11.0, 12.0, 14.0, 16.0, 18.0, 20.0, 24.0, 28.0, 32.0, 36.0, 40.0, 48.0,
    56.0, 64.0, 72.0, 96.0, 128.0, 160.0,
];

/// An editing session on one text node.
#[derive(Debug, Clone)]
pub struct TextSession {
    /// Node being edited.
    pub node_id: Id,
    /// The node did not exist before (text tool); it is created on commit unless left empty.
    pub created: Option<Node>,
    /// Current runs.
    pub buffer: TextBuffer,
    /// Selection anchor (byte index).
    pub anchor: usize,
    /// Selection head / caret (byte index).
    pub head: usize,
    /// Caret affinity at soft wraps.
    pub affinity: Affinity,
    /// IME composition range.
    pub marked: Option<Range<usize>>,
    /// Goal x for vertical movement (box coordinates).
    goal_x: Option<f64>,
    /// Style for the next typed characters (formatting toggled with an empty selection).
    pending_style: Option<Option<TextStylePatch>>,
    original_runs: Vec<TextRun>,
    paragraph: Option<Value>,
    /// Paragraph changes made in the session (whole-node paragraph style).
    pub paragraph_changed: bool,
}

impl TextSession {
    /// Starts editing an existing text node with the caret at the end (or all text selected).
    pub fn edit(node: &TextNode, select_all: bool) -> TextSession {
        let buffer = TextBuffer::new(node.runs.clone());
        let len = buffer.len();
        TextSession {
            node_id: node.base.id.clone(),
            created: None,
            buffer,
            anchor: if select_all { 0 } else { len },
            head: len,
            affinity: Affinity::Downstream,
            marked: None,
            goal_x: None,
            pending_style: None,
            original_runs: node.runs.clone(),
            paragraph: None,
            paragraph_changed: false,
        }
    }

    /// Starts a new text node (created on commit).
    pub fn create(node: Node) -> Option<TextSession> {
        let Node::Text(t) = &node else { return None };
        let mut s = TextSession::edit(t, false);
        s.created = Some(node.clone());
        Some(s)
    }

    /// Selected byte range (ordered).
    pub fn selection(&self) -> Range<usize> {
        self.anchor.min(self.head)..self.anchor.max(self.head)
    }

    /// The caret position for layout queries.
    pub fn caret(&self) -> TextPosition {
        TextPosition {
            index: self.head,
            affinity: self.affinity,
        }
    }

    /// Whether the text changed in this session.
    pub fn changed(&self) -> bool {
        self.created.is_some() || self.buffer.runs() != self.original_runs || self.paragraph_changed
    }

    fn set_caret(&mut self, i: usize, extend: bool) {
        self.head = i.min(self.buffer.len());
        if !extend {
            self.anchor = self.head;
        }
        self.affinity = Affinity::Downstream;
        self.pending_style = None;
    }

    /// Inserts text at the selection (typing, paste, IME commit).
    pub fn insert(&mut self, s: &str) {
        let s = s.replace("\r\n", "\n").replace('\r', "\n");
        let range = self.marked.take().unwrap_or_else(|| self.selection());
        let style = self.pending_style.take();
        self.buffer.replace(range.clone(), &s, style);
        let caret = range.start + s.len();
        self.anchor = caret;
        self.head = caret;
        self.goal_x = None;
    }

    /// Replaces `range` (or the composition / selection) with composing text and selects `sel` inside it.
    pub fn set_marked(&mut self, range: Option<Range<usize>>, s: &str, sel: Option<Range<usize>>) {
        let range = range
            .or_else(|| self.marked.clone())
            .unwrap_or_else(|| self.selection());
        let style = self.pending_style.clone();
        self.buffer.replace(range.clone(), s, style);
        self.marked = (!s.is_empty()).then(|| range.start..range.start + s.len());
        let (a, b) = sel
            .map(|r| (range.start + r.start, range.start + r.end))
            .unwrap_or((range.start + s.len(), range.start + s.len()));
        self.anchor = a.min(self.buffer.len());
        self.head = b.min(self.buffer.len());
    }

    /// Ends composition keeping the composed text.
    pub fn unmark(&mut self) {
        self.marked = None;
    }

    /// Backspace (word with alt / ctrl, to line start with mod on macOS-style hosts).
    pub fn backspace(&mut self, laid: &LaidOutText, unit: DeleteUnit) {
        let sel = self.selection();
        if !sel.is_empty() {
            self.buffer.delete(sel.clone());
            self.set_caret(sel.start, false);
            return;
        }
        let from = match unit {
            DeleteUnit::Grapheme => prev_grapheme(&self.buffer.text(), self.head),
            DeleteUnit::Word => laid.prev_word_boundary(self.head),
            DeleteUnit::Line => laid.line_range(self.caret()).start,
        };
        if from < self.head {
            self.buffer.delete(from..self.head);
            self.set_caret(from, false);
        }
    }

    /// Forward delete.
    pub fn delete_forward(&mut self, laid: &LaidOutText, unit: DeleteUnit) {
        let sel = self.selection();
        if !sel.is_empty() {
            self.buffer.delete(sel.clone());
            self.set_caret(sel.start, false);
            return;
        }
        let to = match unit {
            DeleteUnit::Grapheme => next_grapheme(&self.buffer.text(), self.head),
            DeleteUnit::Word => laid.next_word_boundary(self.head),
            DeleteUnit::Line => laid.line_range(self.caret()).end,
        };
        if to > self.head {
            self.buffer.delete(self.head..to);
        }
    }

    /// Caret movement.
    pub fn move_caret(&mut self, laid: &LaidOutText, m: Move, extend: bool) {
        let sel = self.selection();
        let pos = self.caret();
        let next = match m {
            Move::Left | Move::Right if !extend && !sel.is_empty() => {
                // Collapse a selection to the edge in the direction of travel.
                let i = if m == Move::Left { sel.start } else { sel.end };
                TextPosition::new(i)
            }
            Move::Left => laid.move_visual(pos, Movement::Left),
            Move::Right => laid.move_visual(pos, Movement::Right),
            Move::WordLeft => TextPosition::new(laid.prev_word_boundary(self.head)),
            Move::WordRight => TextPosition::new(laid.next_word_boundary(self.head)),
            Move::Up | Move::Down => {
                let x = self.goal_x.unwrap_or_else(|| laid.caret_rect(pos).x);
                let p = laid.move_vertical(pos, if m == Move::Up { -1 } else { 1 }, Some(x));
                self.head = p.index;
                if !extend {
                    self.anchor = p.index;
                }
                self.affinity = p.affinity;
                self.goal_x = Some(x);
                return;
            }
            Move::LineStart => TextPosition::new(laid.line_range(pos).start),
            Move::LineEnd => TextPosition {
                index: trim_line_end(&self.buffer.text(), laid.line_range(pos)),
                affinity: Affinity::Upstream,
            },
            Move::DocStart => TextPosition::new(0),
            Move::DocEnd => TextPosition::new(self.buffer.len()),
        };
        self.head = next.index.min(self.buffer.len());
        if !extend {
            self.anchor = self.head;
        }
        self.affinity = next.affinity;
        self.goal_x = None;
        self.pending_style = None;
    }

    /// Select all.
    pub fn select_all(&mut self) {
        self.anchor = 0;
        self.head = self.buffer.len();
    }

    /// Places the caret at a box-local point (click); `extend` with shift.
    pub fn click(&mut self, laid: &LaidOutText, x: f64, y: f64, extend: bool) {
        let p = laid.hit_test_point(x, y);
        self.head = p.index.min(self.buffer.len());
        self.affinity = p.affinity;
        if !extend {
            self.anchor = self.head;
        }
        self.goal_x = None;
        self.marked = None;
        self.pending_style = None;
    }

    /// Selects the word (double click) or paragraph (triple click) at a box-local point.
    pub fn select_unit_at(&mut self, laid: &LaidOutText, x: f64, y: f64, paragraph: bool) {
        let p = laid.hit_test_point(x, y);
        let r = if paragraph {
            laid.paragraph_range(p.index)
        } else {
            laid.word_range(p.index)
        };
        self.anchor = r.start;
        self.head = r.end;
    }

    /// Selected text (copy).
    pub fn selected_text(&self) -> String {
        let t = self.buffer.text();
        t.get(self.selection()).unwrap_or_default().to_string()
    }

    /// Toggles / steps formatting on the selection, or on the next typed text when the selection is empty.
    pub fn format(&mut self, f: Format, node: &TextNode) {
        let base = &node.style;
        let sel = self.selection();
        let fallback_range = || 0..0;
        let range = if sel.is_empty() {
            fallback_range()
        } else {
            sel.clone()
        };
        let current_weight =
            |p: Option<&TextStylePatch>| p.and_then(|p| p.font_weight).unwrap_or(base.font_weight);
        let toggle_on = match f {
            Format::Bold => !self.buffer.all(self.effective_range(&range), &|p| {
                current_weight(p) >= 600.0
            }),
            Format::Italic => !self.buffer.all(self.effective_range(&range), &|p| {
                p.and_then(|p| p.font_style).unwrap_or(base.font_style)
                    == desyn_core::model::FontStyle::Italic
            }),
            Format::Underline => !self.buffer.all(self.effective_range(&range), &|p| {
                p.and_then(|p| p.decoration).unwrap_or(base.decoration)
                    == desyn_core::model::TextDecoration::Underline
            }),
            Format::Strikethrough => !self.buffer.all(self.effective_range(&range), &|p| {
                p.and_then(|p| p.decoration).unwrap_or(base.decoration)
                    == desyn_core::model::TextDecoration::Strikethrough
            }),
            Format::Bigger | Format::Smaller => true,
        };
        let base_size = base.font_size;
        let base_weight = base.font_weight;
        let apply = move |p: &mut TextStylePatch| match f {
            Format::Bold => {
                p.font_weight = Some(if toggle_on {
                    700.0
                } else if base_weight >= 600.0 {
                    400.0
                } else {
                    base_weight
                })
            }
            Format::Italic => {
                p.font_style = Some(if toggle_on {
                    desyn_core::model::FontStyle::Italic
                } else {
                    desyn_core::model::FontStyle::Normal
                })
            }
            Format::Underline => {
                p.decoration = Some(if toggle_on {
                    desyn_core::model::TextDecoration::Underline
                } else {
                    desyn_core::model::TextDecoration::None
                })
            }
            Format::Strikethrough => {
                p.decoration = Some(if toggle_on {
                    desyn_core::model::TextDecoration::Strikethrough
                } else {
                    desyn_core::model::TextDecoration::None
                })
            }
            Format::Bigger | Format::Smaller => {
                let cur = p.font_size.unwrap_or(base_size);
                p.font_size = Some(step_size(cur, f == Format::Bigger));
            }
        };
        if sel.is_empty() {
            let mut st = self
                .pending_style
                .clone()
                .unwrap_or_else(|| self.buffer.style_at(self.head))
                .unwrap_or_default();
            apply(&mut st);
            self.pending_style = Some((st != TextStylePatch::default()).then_some(st));
        } else {
            self.buffer.restyle(sel, &apply);
        }
    }

    /// The text a link applies to: the selection, or the word around the caret. Returns the range and the link
    /// it currently carries (when the whole range shares one).
    pub fn link_target(
        &self,
        laid: &LaidOutText,
        node: &TextNode,
    ) -> (Range<usize>, Option<String>) {
        let sel = self.selection();
        let range = if sel.is_empty() {
            laid.word_range(self.head)
        } else {
            sel
        };
        let base = node.style.link.clone().filter(|l| !l.is_empty());
        let effective = |p: Option<&TextStylePatch>| match p.and_then(|p| p.link.clone()) {
            Some(l) if l.is_empty() => None,
            Some(l) => Some(l),
            None => base.clone(),
        };
        if range.is_empty() {
            let st = self.buffer.style_at(self.head);
            return (range, effective(st.as_ref()));
        }
        let mut current: Option<Option<String>> = None;
        let mut pos = 0;
        for r in &self.buffer.runs {
            let (start, end) = (pos, pos + r.text.len());
            pos = end;
            if range.start < end && start < range.end {
                let l = effective(r.style.as_ref());
                match &current {
                    None => current = Some(l),
                    Some(c) if *c != l => return (range, None),
                    _ => {}
                }
            }
        }
        (range, current.flatten())
    }

    /// Sets (or with `None` removes) the link of `range`. An empty range only changes the next typed text.
    pub fn set_link(&mut self, range: Range<usize>, link: Option<String>, node: &TextNode) {
        // A link on the node's base style is overridden with an empty link to remove it locally.
        let base_has_link = node.style.link.as_deref().is_some_and(|l| !l.is_empty());
        let value = match link {
            Some(l) => Some(l),
            None if base_has_link => Some(String::new()),
            None => None,
        };
        let apply = move |p: &mut TextStylePatch| p.link = value.clone();
        if range.is_empty() {
            let mut st = self
                .pending_style
                .clone()
                .unwrap_or_else(|| self.buffer.style_at(self.head))
                .unwrap_or_default();
            apply(&mut st);
            self.pending_style = Some((st != TextStylePatch::default()).then_some(st));
        } else {
            self.buffer.restyle(range, &apply);
        }
    }

    /// The range whose style decides a toggle: the selection, or the character before the caret (after it at
    /// the very start).
    fn effective_range(&self, r: &Range<usize>) -> Range<usize> {
        if !r.is_empty() {
            return r.clone();
        }
        let t = self.buffer.text();
        let p = prev_grapheme(&t, self.head);
        if p < self.head {
            p..self.head
        } else {
            self.head..next_grapheme(&t, self.head)
        }
    }

    /// Sets a paragraph property for the whole node (alignment, list).
    pub fn set_paragraph(&mut self, node: &TextNode, key: &str, value: Value) {
        let mut p = self
            .paragraph
            .clone()
            .unwrap_or_else(|| serde_json::to_value(&node.paragraph).unwrap_or(json!({})));
        p[key] = value;
        self.paragraph = Some(p);
        self.paragraph_changed = true;
    }

    /// The node as it should look now (for previews and layout).
    pub fn ops(&self) -> Vec<Op> {
        let runs = serde_json::to_value(self.buffer.runs()).unwrap_or(Value::Array(vec![]));
        if let Some(n) = &self.created {
            let mut v = serde_json::to_value(n).unwrap_or_default();
            v["runs"] = runs;
            if let Some(p) = &self.paragraph {
                v["paragraph"] = p.clone();
            }
            let name: String = self
                .buffer
                .text()
                .lines()
                .next()
                .unwrap_or("")
                .chars()
                .take(40)
                .collect();
            if !name.trim().is_empty() {
                v["name"] = json!(name);
            }
            let Ok(node) = serde_json::from_value::<Node>(v) else {
                return Vec::new();
            };
            let parent = n.parent().unwrap_or("root").to_string();
            return vec![Op::create(vec![node], parent, None)];
        }
        let mut set = Map::new();
        set.insert("runs".into(), runs);
        if let Some(p) = &self.paragraph {
            set.insert("paragraph".into(), p.clone());
        }
        vec![Op::update_set(self.node_id.clone(), set)]
    }

    /// Ops to commit when leaving the session: `None` when nothing should be recorded. Text emptied by the user is
    /// deleted (a new empty node is simply not created).
    pub fn commit_ops(&self) -> Option<Vec<Op>> {
        if self.buffer.text().trim().is_empty() {
            return if self.created.is_some() {
                None
            } else {
                Some(vec![Op::delete(self.node_id.clone())])
            };
        }
        self.changed().then(|| self.ops())
    }

    /// Ops for a checkpoint while the session stays open (typing paused, DOCUMENT_MODEL §6): the text so far,
    /// never a deletion. `None` when nothing changed since the last checkpoint, the text is empty or an IME
    /// composition is in progress.
    pub fn checkpoint_ops(&self) -> Option<Vec<Op>> {
        self.has_uncommitted().then(|| self.ops())
    }

    /// Whether a checkpoint would commit something (see [`TextSession::checkpoint_ops`]).
    pub fn has_uncommitted(&self) -> bool {
        self.marked.is_none() && self.changed() && !self.buffer.text().trim().is_empty()
    }

    /// Records that the current state was committed: the node exists now and later changes are measured
    /// against this text.
    pub fn mark_checkpoint(&mut self) {
        self.created = None;
        self.original_runs = self.buffer.runs();
        self.paragraph_changed = false;
    }

    /// UTF-16 offset of a byte index (IME hosts).
    pub fn to_utf16(&self, index: usize) -> usize {
        utf8_to_utf16(&self.buffer.text(), index)
    }

    /// Byte index of a UTF-16 offset.
    pub fn from_utf16(&self, index: usize) -> usize {
        utf16_to_utf8(&self.buffer.text(), index)
    }
}

/// What backspace / delete removes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeleteUnit {
    /// One grapheme.
    Grapheme,
    /// To the word boundary.
    Word,
    /// To the line boundary.
    Line,
}

/// Caret movements.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Move {
    /// Visual left.
    Left,
    /// Visual right.
    Right,
    /// Previous word start.
    WordLeft,
    /// Next word end.
    WordRight,
    /// Line above.
    Up,
    /// Line below.
    Down,
    /// Start of the visual line.
    LineStart,
    /// End of the visual line.
    LineEnd,
    /// Start of the text.
    DocStart,
    /// End of the text.
    DocEnd,
}

fn prev_grapheme(t: &str, i: usize) -> usize {
    t.grapheme_indices(true)
        .map(|(j, _)| j)
        .take_while(|j| *j < i)
        .last()
        .unwrap_or(0)
}

fn next_grapheme(t: &str, i: usize) -> usize {
    t.grapheme_indices(true)
        .map(|(j, g)| j + g.len())
        .find(|j| *j > i)
        .unwrap_or(t.len())
}

fn trim_line_end(t: &str, r: Range<usize>) -> usize {
    // A soft-wrapped line ends after its trailing space; the caret belongs before the newline of a paragraph.
    let mut end = r.end.min(t.len());
    if end > r.start && t[..end].ends_with('\n') {
        end -= 1;
    }
    end
}

/// The next font size step.
pub fn step_size(cur: f64, up: bool) -> f64 {
    if up {
        SIZE_STEPS
            .iter()
            .copied()
            .find(|s| *s > cur + 1e-9)
            .unwrap_or((cur * 1.25).round())
    } else {
        SIZE_STEPS
            .iter()
            .rev()
            .copied()
            .find(|s| *s < cur - 1e-9)
            .unwrap_or((cur * 0.8).round().max(1.0))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use desyn_text::{LayoutOptions, TextContent, TextEngine};

    fn run(t: &str, w: Option<f64>) -> TextRun {
        TextRun {
            text: t.into(),
            style: w.map(|w| TextStylePatch {
                font_weight: Some(w),
                ..Default::default()
            }),
            extra: Default::default(),
        }
    }

    fn node(text: &str) -> TextNode {
        match Node::text("aaaaaaaaaaaa", text, 0.0, 0.0, Some(400.0)) {
            Node::Text(t) => t,
            _ => unreachable!(),
        }
    }

    fn laid(s: &TextSession, n: &TextNode) -> LaidOutText {
        let mut e = TextEngine::with_bundled_fonts();
        let mut n = n.clone();
        n.runs = s.buffer.runs();
        let c = TextContent::from_node(&n, None);
        e.layout(&c, &LayoutOptions::for_node(&n))
    }

    #[test]
    fn buffer_editing_keeps_styles() {
        let mut b = TextBuffer::new(vec![
            run("Hello ", None),
            run("bold", Some(700.0)),
            run(" end", None),
        ]);
        assert_eq!(b.text(), "Hello bold end");
        b.replace(10..10, "er", None);
        assert_eq!(
            b.runs()[1].text,
            "bolder",
            "typing at a run end continues that run"
        );
        b.delete(4..8);
        assert_eq!(b.text(), "Helllder end");
        b.restyle(0..2, &|p| p.font_weight = Some(700.0));
        let runs = b.runs();
        assert_eq!(runs[0].text, "He");
        assert_eq!(runs[0].style.as_ref().unwrap().font_weight, Some(700.0));
        b.delete(0..b.len());
        assert_eq!(b.runs().len(), 1);
        assert!(b.is_empty());
        b.replace(0..0, "x", Some(None));
        assert_eq!(b.text(), "x");
    }

    #[test]
    fn session_typing_navigation_and_ime() {
        let n = node("Hi");
        let mut s = TextSession::edit(&n, false);
        assert_eq!(s.head, 2);
        s.insert(" there");
        assert_eq!(s.buffer.text(), "Hi there");
        let l = laid(&s, &n);
        s.move_caret(&l, Move::WordLeft, false);
        assert_eq!(s.head, 3);
        s.move_caret(&l, Move::LineEnd, true);
        assert_eq!(s.selected_text(), "there");
        s.set_marked(None, "に", Some(3..3));
        assert_eq!(s.buffer.text(), "Hi に");
        assert_eq!(s.marked, Some(3..6));
        s.set_marked(None, "日本", None);
        assert_eq!(s.buffer.text(), "Hi 日本");
        s.unmark();
        s.insert("!");
        assert_eq!(s.buffer.text(), "Hi 日本!");
        assert_eq!(s.to_utf16(s.head), 6);
        let l = laid(&s, &n);
        s.backspace(&l, DeleteUnit::Grapheme);
        assert_eq!(s.buffer.text(), "Hi 日本");
        s.insert(" big world");
        let l = laid(&s, &n);
        s.backspace(&l, DeleteUnit::Word);
        assert_eq!(s.buffer.text(), "Hi 日本 big ");
        assert!(s.commit_ops().is_some());
    }

    #[test]
    fn links() {
        assert_eq!(normalize_link("  "), Ok(None));
        assert_eq!(
            normalize_link("desyn.app/pricing"),
            Ok(Some("https://desyn.app/pricing".into()))
        );
        assert_eq!(
            normalize_link("HTTPS://desyn.app"),
            Ok(Some("HTTPS://desyn.app".into()))
        );
        assert_eq!(
            normalize_link("mailto:hi@desyn.app"),
            Ok(Some("mailto:hi@desyn.app".into()))
        );
        assert_eq!(
            normalize_link("page:abc123"),
            Ok(Some("page:abc123".into()))
        );
        for bad in [
            "javascript:alert(1)",
            "JavaScript:alert(1)",
            "data:text/html,x",
            "vbscript:x",
            "https://",
            "hello world",
            "file:///etc/passwd",
            "page:../x",
        ] {
            assert!(normalize_link(bad).is_err(), "{bad}");
        }

        let n = node("Visit our shop today");
        let mut s = TextSession::edit(&n, false);
        let l = laid(&s, &n);
        // Caret inside "shop": the word is the target.
        s.anchor = 12;
        s.head = 12;
        let (r, cur) = s.link_target(&l, &n);
        assert_eq!(&s.buffer.text()[r.clone()], "shop");
        assert_eq!(cur, None);
        s.set_link(r.clone(), Some("https://desyn.app".into()), &n);
        let runs = s.buffer.runs();
        assert_eq!(runs.len(), 3);
        assert_eq!(runs[1].text, "shop");
        assert_eq!(
            runs[1].style.as_ref().and_then(|p| p.link.as_deref()),
            Some("https://desyn.app")
        );
        assert_eq!(
            s.link_target(&l, &n).1.as_deref(),
            Some("https://desyn.app")
        );
        s.set_link(r, None, &n);
        assert_eq!(
            s.buffer.runs().len(),
            1,
            "removing the link merges the runs again"
        );
    }

    #[test]
    fn formatting_and_commit_rules() {
        let n = node("Make this bold");
        let mut s = TextSession::edit(&n, false);
        s.anchor = 5;
        s.head = 9;
        s.format(Format::Bold, &n);
        let runs = s.buffer.runs();
        assert_eq!(runs.len(), 3);
        assert_eq!(runs[1].text, "this");
        s.format(Format::Bold, &n);
        assert_eq!(
            s.buffer.runs()[1]
                .style
                .as_ref()
                .and_then(|p| p.font_weight),
            Some(400.0)
        );
        s.format(Format::Bigger, &n);
        assert_eq!(
            s.buffer.runs()[1].style.as_ref().and_then(|p| p.font_size),
            Some(28.0)
        );
        // Empty selection: the toggle applies to the next typed characters.
        s.anchor = 14;
        s.head = 14;
        s.format(Format::Italic, &n);
        s.insert("!");
        let last = s.buffer.runs().last().cloned().unwrap();
        assert_eq!(last.text, "!");
        assert_eq!(
            last.style.unwrap().font_style,
            Some(desyn_core::model::FontStyle::Italic)
        );
        // Emptying an existing node deletes it; an untouched session records nothing.
        let mut e = TextSession::edit(&n, true);
        assert!(e.commit_ops().is_none());
        e.insert("");
        let l = laid(&e, &n);
        e.backspace(&l, DeleteUnit::Grapheme);
        assert!(matches!(e.commit_ops().as_deref(), Some([Op::Delete(_)])));
        let c = TextSession::create(Node::text("bbbbbbbbbbbb", "", 0.0, 0.0, None)).unwrap();
        assert!(c.commit_ops().is_none(), "an empty new text is not created");
        assert_eq!(step_size(24.0, true), 28.0);
        assert_eq!(step_size(6.0, false), 5.0);
    }
}
