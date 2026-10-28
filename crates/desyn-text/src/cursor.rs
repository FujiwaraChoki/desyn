//! Caret and selection geometry, hit testing, word / line / paragraph boundaries, visual caret movement and
//! UTF-16 index conversion (web hosts address text in UTF-16 code units).
//!
//! Indices are byte offsets into [`LaidOutText::text`] (always on char boundaries). An index between two lines
//! (a soft wrap) is ambiguous: [`Affinity::Upstream`] puts the caret at the end of the earlier line,
//! [`Affinity::Downstream`] at the start of the later one.

use std::ops::Range;

use desyn_core::geometry::Rect;
use serde::{Deserialize, Serialize};
use unicode_segmentation::UnicodeSegmentation;

use crate::layout::NEWLINE_SELECTION_EM;
use crate::types::{ClusterBox, LaidOutText, Line};

/// Which side of a line break a position sticks to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Affinity {
    /// End of the earlier line.
    Upstream,
    /// Start of the later line.
    #[default]
    Downstream,
}

/// A caret position.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextPosition {
    /// Byte offset.
    pub index: usize,
    /// Line-break affinity.
    pub affinity: Affinity,
}

impl TextPosition {
    /// Downstream position.
    pub fn new(index: usize) -> Self {
        TextPosition {
            index,
            affinity: Affinity::Downstream,
        }
    }
}

/// Caret geometry (a vertical bar).
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaretRect {
    /// x of the bar.
    pub x: f64,
    /// Top.
    pub y: f64,
    /// Height.
    pub height: f64,
    /// Line index.
    pub line: usize,
    /// The caret sits in right-to-left text.
    pub rtl: bool,
}

/// Visual caret movement direction.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Movement {
    /// Towards the left edge.
    Left,
    /// Towards the right edge.
    Right,
}

/// Byte offset -> UTF-16 code unit offset.
pub fn utf8_to_utf16(text: &str, index: usize) -> usize {
    let index = floor_boundary(text, index.min(text.len()));
    text[..index].encode_utf16().count()
}

/// UTF-16 code unit offset -> byte offset (offsets inside a surrogate pair round down).
pub fn utf16_to_utf8(text: &str, index: usize) -> usize {
    let mut units = 0;
    for (i, c) in text.char_indices() {
        let next = units + c.len_utf16();
        if next > index {
            return i;
        }
        units = next;
    }
    text.len()
}

fn floor_boundary(s: &str, mut i: usize) -> usize {
    while i > 0 && !s.is_char_boundary(i) {
        i -= 1;
    }
    i
}

fn is_word(s: &str) -> bool {
    s.chars().any(char::is_alphanumeric)
}

impl LaidOutText {
    fn clamp_index(&self, i: usize) -> usize {
        floor_boundary(&self.text, i.min(self.text.len()))
    }

    fn line_boxes(&self, line: usize) -> &[ClusterBox] {
        self.lines
            .get(line)
            .map_or(&[][..], |l| &self.clusters[l.clusters.clone()])
    }

    /// Line index whose box contains `y` (the nearest line above / below the text).
    pub fn line_at_y(&self, y: f64) -> Option<usize> {
        if self.lines.is_empty() {
            return None;
        }
        Some(
            self.lines
                .iter()
                .position(|l| y < l.top + l.height)
                .unwrap_or(self.lines.len() - 1),
        )
    }

    /// Line showing a position.
    pub fn line_for_position(&self, pos: TextPosition) -> Option<usize> {
        if self.lines.is_empty() {
            return None;
        }
        let idx = self.clamp_index(pos.index);
        let mut found: Option<usize> = None;
        for (i, l) in self.lines.iter().enumerate() {
            if l.range.start <= idx && idx <= l.range.end {
                match found {
                    None => found = Some(i),
                    // Shared boundary of a soft wrap: downstream moves to the later line.
                    Some(_) if pos.affinity == Affinity::Downstream => found = Some(i),
                    Some(_) => {}
                }
            }
        }
        if found.is_none() {
            // Inside list tabs or the separator of a paragraph: the paragraph's line; beyond the visible text
            // (truncated): the last line.
            found = self
                .paragraphs
                .iter()
                .find(|p| p.range.start <= idx && idx <= p.range.end && !p.lines.is_empty())
                .map(|p| p.lines.start)
                .or_else(|| {
                    self.lines
                        .iter()
                        .rposition(|l| l.range.start <= idx)
                        .or(Some(0))
                });
        }
        found
    }

    fn caret_on_line(&self, li: usize, idx: usize, affinity: Affinity) -> CaretRect {
        let l: &Line = &self.lines[li];
        let boxes = self.line_boxes(li);
        let start_match = boxes.iter().find(|b| b.range.start == idx);
        let end_match = boxes.iter().find(|b| b.range.end == idx);
        let pick = match affinity {
            Affinity::Upstream => end_match
                .map(|b| (b, false))
                .or(start_match.map(|b| (b, true))),
            Affinity::Downstream => start_match
                .map(|b| (b, true))
                .or(end_match.map(|b| (b, false))),
        };
        let (x, rtl) = match pick {
            Some((b, leading)) => {
                let x = match (leading, b.rtl) {
                    (true, false) | (false, true) => b.x0,
                    (true, true) | (false, false) => b.x1,
                };
                (x, b.rtl)
            }
            None => match boxes
                .iter()
                .find(|b| b.range.start < idx && idx < b.range.end)
            {
                Some(b) => (if b.rtl { b.x1 } else { b.x0 }, b.rtl),
                None => {
                    // Empty line, or a position before the first / after the last box.
                    let at_start = boxes.is_empty() || idx <= l.range.start;
                    let x = if at_start {
                        if l.rtl { l.x + l.width } else { l.x }
                    } else if l.rtl {
                        l.x
                    } else {
                        l.x + l.width
                    };
                    (x, l.rtl)
                }
            },
        };
        let (y, height) = if l.ascent + l.descent > 0.0 {
            (l.baseline - l.ascent, l.ascent + l.descent)
        } else {
            (l.top, l.height)
        };
        CaretRect {
            x,
            y,
            height,
            line: li,
            rtl,
        }
    }

    /// Caret geometry for a position. Text without lines (`maxLines: 0`) yields a caret at the box origin.
    pub fn caret_rect(&self, pos: TextPosition) -> CaretRect {
        let idx = self.clamp_index(pos.index);
        match self.line_for_position(pos) {
            Some(li) => self.caret_on_line(li, idx, pos.affinity),
            None => CaretRect {
                x: 0.0,
                y: self.content_top,
                height: (self.first_baseline - self.content_top).max(0.0) * 1.25,
                line: 0,
                rtl: false,
            },
        }
    }

    fn hit_line(&self, li: usize, x: f64) -> TextPosition {
        let l = &self.lines[li];
        let boxes = self.line_boxes(li);
        if boxes.is_empty() {
            return TextPosition::new(l.range.start);
        }
        let left = boxes
            .iter()
            .min_by(|a, b| a.x0.total_cmp(&b.x0))
            .expect("non-empty");
        let right = boxes
            .iter()
            .max_by(|a, b| a.x1.total_cmp(&b.x1))
            .expect("non-empty");
        // (index, the index is the box's logical end) — an end index is drawn at the box's trailing edge, which
        // is what upstream affinity selects.
        let (idx, from_end) = if x <= left.x0 {
            if left.rtl {
                (left.range.end, true)
            } else {
                (left.range.start, false)
            }
        } else if x >= right.x1 {
            if right.rtl {
                (right.range.start, false)
            } else {
                (right.range.end, true)
            }
        } else {
            let b = boxes
                .iter()
                .find(|b| b.x0 <= x && x < b.x1)
                .unwrap_or(right);
            let before_mid = x < (b.x0 + b.x1) / 2.0;
            match (before_mid, b.rtl) {
                (true, false) | (false, true) => (b.range.start, false),
                (true, true) | (false, false) => (b.range.end, true),
            }
        };
        let affinity = if from_end {
            Affinity::Upstream
        } else {
            Affinity::Downstream
        };
        TextPosition {
            index: idx,
            affinity,
        }
    }

    /// Text position nearest to a point in box coordinates.
    pub fn hit_test_point(&self, x: f64, y: f64) -> TextPosition {
        match self.line_at_y(y) {
            Some(li) => self.hit_line(li, x),
            None => TextPosition::new(0),
        }
    }

    /// Selection highlight rectangles for a byte range (one or more per line; bidi text can produce several).
    /// Paragraph breaks inside the selection get a narrow newline rectangle at the line end.
    pub fn selection_rects(&self, range: Range<usize>) -> Vec<Rect> {
        let start = self.clamp_index(range.start.min(range.end));
        let end = self.clamp_index(range.start.max(range.end));
        let mut out = Vec::new();
        if start == end {
            return out;
        }
        for (li, l) in self.lines.iter().enumerate() {
            if l.range.end < start || l.range.start > end {
                continue;
            }
            let mut spans: Vec<(f64, f64)> = self
                .line_boxes(li)
                .iter()
                .filter(|b| b.range.start < end && b.range.end > start)
                .map(|b| (b.x0, b.x1))
                .collect();
            let includes_break = l.ends_paragraph && start <= l.range.end && end > l.range.end;
            if includes_break {
                let w = (l.ascent + l.descent).max(l.height * 0.8) * NEWLINE_SELECTION_EM;
                let (min_x, max_x) = spans
                    .iter()
                    .fold((f64::INFINITY, f64::NEG_INFINITY), |(a, b), s| {
                        (a.min(s.0), b.max(s.1))
                    });
                if l.rtl {
                    let edge = if min_x.is_finite() {
                        min_x
                    } else {
                        l.x + l.width
                    };
                    spans.push((edge - w, edge));
                } else {
                    let edge = if max_x.is_finite() { max_x } else { l.x };
                    spans.push((edge, edge + w));
                }
            }
            spans.sort_by(|a, b| a.0.total_cmp(&b.0));
            let mut merged: Vec<(f64, f64)> = Vec::new();
            for s in spans {
                match merged.last_mut() {
                    Some(m) if s.0 <= m.1 + 0.5 => m.1 = m.1.max(s.1),
                    _ => merged.push(s),
                }
            }
            for (x0, x1) in merged {
                out.push(Rect {
                    x: x0,
                    y: l.top,
                    w: (x1 - x0).max(0.0),
                    h: l.height,
                });
            }
        }
        out
    }

    /// Word (or whitespace / punctuation run) containing `index`; at the end of a word, that word.
    pub fn word_range(&self, index: usize) -> Range<usize> {
        let idx = self.clamp_index(index);
        let segs: Vec<(usize, &str)> = self.text.split_word_bound_indices().collect();
        if segs.is_empty() {
            return 0..0;
        }
        let pos = segs
            .iter()
            .position(|(s, w)| *s <= idx && idx < s + w.len())
            .unwrap_or(segs.len() - 1);
        let (s, w) = segs[pos];
        if !is_word(w) && pos > 0 {
            let (ps, pw) = segs[pos - 1];
            if ps + pw.len() == idx && is_word(pw) {
                return ps..ps + pw.len();
            }
        }
        s..s + w.len()
    }

    /// End of the next word after `index` (word-wise forward movement).
    pub fn next_word_boundary(&self, index: usize) -> usize {
        let idx = self.clamp_index(index);
        self.text
            .split_word_bound_indices()
            .filter(|(s, w)| s + w.len() > idx && is_word(w))
            .map(|(s, w)| s + w.len())
            .next()
            .unwrap_or(self.text.len())
    }

    /// Start of the word before `index` (word-wise backward movement).
    pub fn prev_word_boundary(&self, index: usize) -> usize {
        let idx = self.clamp_index(index);
        self.text
            .split_word_bound_indices()
            .rev()
            .find(|(s, w)| *s < idx && is_word(w))
            .map(|(s, _)| s)
            .unwrap_or(0)
    }

    /// Next grapheme boundary after `index`.
    pub fn next_grapheme(&self, index: usize) -> usize {
        let idx = self.clamp_index(index);
        self.text
            .grapheme_indices(true)
            .map(|(i, g)| i + g.len())
            .find(|&e| e > idx)
            .unwrap_or(self.text.len())
    }

    /// Previous grapheme boundary before `index`.
    pub fn prev_grapheme(&self, index: usize) -> usize {
        let idx = self.clamp_index(index);
        self.text
            .grapheme_indices(true)
            .map(|(i, _)| i)
            .rfind(|&s| s < idx)
            .unwrap_or(0)
    }

    /// Source range of the line showing `pos`.
    pub fn line_range(&self, pos: TextPosition) -> Range<usize> {
        self.line_for_position(pos)
            .map_or(0..self.text.len(), |li| self.lines[li].range.clone())
    }

    /// Source range of the paragraph containing `index` (without its separator).
    pub fn paragraph_range(&self, index: usize) -> Range<usize> {
        let idx = self.clamp_index(index);
        let start = self.text[..idx].rfind(['\n', '\u{2029}']).map_or(0, |p| {
            p + self.text[p..].chars().next().map_or(1, char::len_utf8)
        });
        let end = self.text[idx..]
            .find(['\n', '\u{2029}'])
            .map_or(self.text.len(), |p| idx + p);
        start..end
    }

    /// Moves the caret one step visually (bidi-aware); crosses to the adjacent line at a line edge.
    pub fn move_visual(&self, pos: TextPosition, dir: Movement) -> TextPosition {
        let Some(li) = self.line_for_position(pos) else {
            return pos;
        };
        let idx = self.clamp_index(pos.index);
        let cur = self.caret_on_line(li, idx, pos.affinity).x;
        let l = &self.lines[li];
        let mut stops: Vec<(f64, usize)> = Vec::new();
        for b in self.line_boxes(li) {
            stops.push((b.x0, if b.rtl { b.range.end } else { b.range.start }));
            stops.push((b.x1, if b.rtl { b.range.start } else { b.range.end }));
        }
        let eps = 1e-6;
        let next = match dir {
            Movement::Right => stops
                .iter()
                .filter(|(x, i)| *x > cur + eps && *i != idx)
                .min_by(|a, b| a.0.total_cmp(&b.0)),
            Movement::Left => stops
                .iter()
                .filter(|(x, i)| *x < cur - eps && *i != idx)
                .max_by(|a, b| a.0.total_cmp(&b.0)),
        };
        if let Some((_, i)) = next {
            let affinity = if *i == l.range.end && !l.ends_paragraph {
                Affinity::Upstream
            } else {
                Affinity::Downstream
            };
            return TextPosition {
                index: *i,
                affinity,
            };
        }
        let forward = (dir == Movement::Right) != l.rtl;
        if forward {
            match self.lines.get(li + 1) {
                Some(n) if n.range.start > idx || !l.ends_paragraph => {
                    if l.ends_paragraph {
                        TextPosition::new(n.range.start)
                    } else {
                        // Soft wrap: the same index is the start of the next line.
                        let step = if n.range.start == idx {
                            self.next_grapheme(idx)
                        } else {
                            n.range.start
                        };
                        TextPosition::new(step)
                    }
                }
                _ => pos,
            }
        } else if li > 0 {
            let p = &self.lines[li - 1];
            TextPosition {
                index: p.range.end,
                affinity: if p.ends_paragraph {
                    Affinity::Downstream
                } else {
                    Affinity::Upstream
                },
            }
        } else {
            pos
        }
    }

    /// Moves the caret `delta` lines up (negative) or down, keeping the horizontal position `x` (pass the x
    /// remembered from the first vertical move, or `None` to use the caret's x).
    pub fn move_vertical(&self, pos: TextPosition, delta: i32, x: Option<f64>) -> TextPosition {
        let Some(li) = self.line_for_position(pos) else {
            return pos;
        };
        let x = x.unwrap_or_else(|| self.caret_rect(pos).x);
        let target = li as i64 + i64::from(delta);
        if target < 0 {
            return TextPosition::new(0);
        }
        if target as usize >= self.lines.len() {
            return TextPosition::new(self.text.len());
        }
        self.hit_line(target as usize, x)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utf16_round_trip() {
        let s = "a😀é中";
        assert_eq!(utf8_to_utf16(s, 0), 0);
        assert_eq!(utf8_to_utf16(s, 1), 1);
        assert_eq!(utf8_to_utf16(s, 5), 3);
        assert_eq!(utf8_to_utf16(s, 7), 4);
        assert_eq!(utf8_to_utf16(s, s.len()), 5);
        for (i, _) in s.char_indices() {
            assert_eq!(utf16_to_utf8(s, utf8_to_utf16(s, i)), i);
        }
        assert_eq!(
            utf16_to_utf8(s, 2),
            1,
            "inside a surrogate pair rounds down"
        );
        assert_eq!(utf16_to_utf8(s, 99), s.len());
    }
}
