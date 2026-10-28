//! Text measurement interface (implemented by `desyn-text`) and a font-free approximation.

use serde::{Deserialize, Serialize};

use crate::model::{
    LineHeightUnit, ListStyle, ParagraphStyle, TextCase, TextNode, TextRun, TextStyle,
    VerticalAlign,
};

/// What to measure.
#[derive(Debug, Clone, Copy)]
pub struct TextMeasureRequest<'a> {
    /// Runs (concatenated; `"\n"` starts a paragraph).
    pub runs: &'a [TextRun],
    /// Default style (runs override it).
    pub style: &'a TextStyle,
    /// Paragraph style.
    pub paragraph: &'a ParagraphStyle,
    /// Wrap width; `None` = no wrapping (one line per paragraph).
    pub max_width: Option<f64>,
    /// Maximum number of lines (ellipsis truncation).
    pub max_lines: Option<u32>,
}

/// Measured text box.
#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize)]
pub struct TextMetrics {
    /// Width of the widest line (the box width for `autoResize: "width"`).
    pub width: f64,
    /// Total height of all (possibly truncated) lines including paragraph spacing.
    pub height: f64,
    /// Number of laid out lines.
    pub lines: u32,
    /// Distance from the top of the text to the first line's baseline.
    pub baseline: f64,
}

/// Measures text. `desyn-text` implements this with real fonts (cosmic-text); [`ApproxMeasurer`] is a deterministic
/// font-free fallback for tests, servers without fonts and early layout.
pub trait TextMeasurer {
    /// Measures `req`.
    fn measure(&mut self, req: &TextMeasureRequest<'_>) -> TextMetrics;
}

/// Measures a text node at an optional wrap width.
pub fn measure_text_node(
    m: &mut dyn TextMeasurer,
    t: &TextNode,
    max_width: Option<f64>,
) -> TextMetrics {
    m.measure(&TextMeasureRequest {
        runs: &t.runs,
        style: &t.style,
        paragraph: &t.paragraph,
        max_width,
        // Counts beyond u32 are "unlimited" for any real text.
        max_lines: t.max_lines.map(|v| u32::try_from(v).unwrap_or(u32::MAX)),
    })
}

/// Offset of the text block inside a box of height `box_h` for the node's vertical alignment.
pub fn vertical_offset(align: VerticalAlign, box_h: f64, content_h: f64) -> f64 {
    match align {
        VerticalAlign::Top => 0.0,
        VerticalAlign::Middle => (box_h - content_h) / 2.0,
        VerticalAlign::Bottom => box_h - content_h,
    }
}

/// Deterministic approximate measurer: per-character advance factors by character class, greedy word wrap,
/// line height from the paragraph style (`auto` = 1.2 x font size), ascent 0.8 / descent 0.2 of the font size.
#[derive(Debug, Clone, Copy, Default)]
pub struct ApproxMeasurer;

/// `auto` line-height factor used by [`ApproxMeasurer`].
pub const APPROX_AUTO_LINE_HEIGHT: f64 = 1.2;

/// Advance of one character in em for [`ApproxMeasurer`].
pub fn approx_advance_em(c: char) -> f64 {
    match c {
        ' ' | '\u{a0}' => 0.28,
        'i' | 'l' | 'j' | '.' | ',' | '\'' | '!' | '|' | ':' | ';' | 'I' => 0.28,
        'f' | 't' | 'r' | '(' | ')' | '[' | ']' | '-' | '"' | '/' => 0.38,
        'm' | 'w' | 'M' | 'W' | '@' | '%' => 0.85,
        '0'..='9' => 0.56,
        c if c.is_ascii_uppercase() => 0.66,
        c if is_wide(c) => 1.0,
        c if c.is_whitespace() => 0.28,
        _ => 0.54,
    }
}

fn is_wide(c: char) -> bool {
    matches!(c as u32,
        0x1100..=0x115F | 0x2E80..=0xA4CF | 0xAC00..=0xD7A3 | 0xF900..=0xFAFF | 0xFE30..=0xFE4F | 0xFF00..=0xFF60
        | 0xFFE0..=0xFFE6 | 0x1F300..=0x1F64F | 0x1F900..=0x1F9FF | 0x20000..=0x3FFFD)
}

#[derive(Clone, Copy)]
struct CharInfo {
    ch: char,
    advance: f64,
    font_size: f64,
}

struct Line {
    width: f64,
    font_size: f64,
}

fn case_transform(text: &str, case: TextCase) -> String {
    match case {
        TextCase::None => text.to_string(),
        TextCase::Upper => text.to_uppercase(),
        TextCase::Lower => text.to_lowercase(),
        TextCase::Title => {
            let mut out = String::with_capacity(text.len());
            let mut start = true;
            for c in text.chars() {
                if start && c.is_alphabetic() {
                    out.extend(c.to_uppercase());
                    start = false;
                } else {
                    out.push(c);
                    if c.is_whitespace() {
                        start = true;
                    }
                }
            }
            out
        }
    }
}

impl ApproxMeasurer {
    fn paragraphs(req: &TextMeasureRequest<'_>) -> Vec<Vec<CharInfo>> {
        let mut paras: Vec<Vec<CharInfo>> = vec![Vec::new()];
        for run in req.runs {
            let style = match &run.style {
                Some(p) => req.style.merged(p),
                None => req.style.clone(),
            };
            let fs = style.font_size.max(0.0);
            let tracking = style.letter_spacing * fs;
            for ch in case_transform(&run.text, style.text_case).chars() {
                if ch == '\n' {
                    paras.push(Vec::new());
                    continue;
                }
                let advance = approx_advance_em(ch) * fs + tracking;
                paras.last_mut().expect("non-empty").push(CharInfo {
                    ch,
                    advance,
                    font_size: fs,
                });
            }
        }
        paras
    }

    fn wrap(
        chars: &[CharInfo],
        first_indent: f64,
        max_width: Option<f64>,
        default_fs: f64,
    ) -> Vec<Line> {
        let mut lines = Vec::new();
        let limit = max_width.unwrap_or(f64::INFINITY);
        let mut i = 0usize;
        let mut indent = first_indent;
        if chars.is_empty() {
            return vec![Line {
                width: indent.max(0.0),
                font_size: default_fs,
            }];
        }
        while i < chars.len() {
            let mut width = indent;
            let mut fs: f64 = 0.0;
            let mut last_break: Option<(usize, f64, f64)> = None; // (index after space, width before space, fs)
            let mut j = i;
            while j < chars.len() {
                let c = chars[j];
                let next_w = width + c.advance;
                if next_w > limit + 1e-9 && j > i && !c.ch.is_whitespace() {
                    break;
                }
                width = next_w;
                fs = fs.max(c.font_size);
                if c.ch.is_whitespace() {
                    last_break = Some((j + 1, width - c.advance, fs));
                }
                j += 1;
            }
            if j >= chars.len() {
                lines.push(Line {
                    width: trim_trailing(&chars[i..j], width),
                    font_size: if fs > 0.0 { fs } else { default_fs },
                });
                break;
            }
            match last_break {
                Some((after, w, f)) if after > i => {
                    lines.push(Line {
                        width: w,
                        font_size: if f > 0.0 { f } else { default_fs },
                    });
                    i = after;
                }
                _ => {
                    // No break opportunity: break the word at the overflow point.
                    lines.push(Line {
                        width,
                        font_size: if fs > 0.0 { fs } else { default_fs },
                    });
                    i = j;
                }
            }
            // Skip leading spaces on the new line.
            while i < chars.len() && chars[i].ch == ' ' {
                i += 1;
            }
            indent = 0.0;
        }
        lines
    }
}

fn trim_trailing(chars: &[CharInfo], width: f64) -> f64 {
    let mut w = width;
    for c in chars.iter().rev() {
        if c.ch.is_whitespace() {
            w -= c.advance;
        } else {
            break;
        }
    }
    w
}

impl TextMeasurer for ApproxMeasurer {
    fn measure(&mut self, req: &TextMeasureRequest<'_>) -> TextMetrics {
        let p = req.paragraph;
        let default_fs = req.style.font_size.max(0.0);
        let list_indent = if p.list == ListStyle::None {
            0.0
        } else {
            default_fs * 1.5
        };
        let avail = req.max_width.map(|w| (w - list_indent).max(0.0));
        let mut lines_total = 0u32;
        let mut height = 0.0;
        let mut width: f64 = 0.0;
        let mut baseline = None;
        let max_lines = req.max_lines.unwrap_or(u32::MAX);
        let paras = Self::paragraphs(req);
        let para_count = paras.len();
        'outer: for (pi, para) in paras.iter().enumerate() {
            for line in Self::wrap(para, p.indent, avail, default_fs) {
                if lines_total >= max_lines {
                    break 'outer;
                }
                let lh = match p.line_height.unit {
                    LineHeightUnit::Auto => line.font_size * APPROX_AUTO_LINE_HEIGHT,
                    _ => p
                        .line_height
                        .resolve(line.font_size, APPROX_AUTO_LINE_HEIGHT),
                };
                if baseline.is_none() {
                    baseline = Some(height + (lh - line.font_size) / 2.0 + line.font_size * 0.8);
                }
                height += lh;
                width = width.max(line.width + list_indent);
                lines_total += 1;
            }
            if pi + 1 < para_count && lines_total < max_lines {
                height += p.spacing;
            }
        }
        TextMetrics {
            width: width.max(0.0),
            height: height.max(0.0),
            lines: lines_total,
            baseline: baseline.unwrap_or(0.0),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Node, TextAlign};

    fn text(s: &str) -> TextNode {
        match Node::text("aaaaaaaaaaaa", s, 0.0, 0.0, None) {
            Node::Text(t) => t,
            _ => unreachable!(),
        }
    }

    #[test]
    fn single_line_and_wrap() {
        let mut m = ApproxMeasurer;
        let mut t = text("Hello world");
        t.style.font_size = 10.0;
        let one = measure_text_node(&mut m, &t, None);
        assert_eq!(one.lines, 1);
        assert!((one.height - 12.0).abs() < 1e-9, "120% of 10px");
        let narrow = measure_text_node(&mut m, &t, Some(one.width * 0.7));
        assert_eq!(narrow.lines, 2);
        assert!(narrow.width <= one.width * 0.7 + 1e-9);
        assert!((narrow.height - 24.0).abs() < 1e-9);
        t.max_lines = Some(1);
        assert_eq!(
            measure_text_node(&mut m, &t, Some(one.width * 0.7)).lines,
            1
        );
        t.paragraph.align = TextAlign::Center;
    }

    #[test]
    fn paragraphs_and_spacing() {
        let mut m = ApproxMeasurer;
        let mut t = text("a\nb\n");
        t.style.font_size = 10.0;
        t.paragraph.spacing = 5.0;
        let r = measure_text_node(&mut m, &t, None);
        assert_eq!(r.lines, 3);
        assert!((r.height - (12.0 * 3.0 + 10.0)).abs() < 1e-9);
        assert!((r.baseline - (1.0 + 8.0)).abs() < 1e-9);
    }

    #[test]
    fn long_word_breaks() {
        let mut m = ApproxMeasurer;
        let t = text("aaaaaaaaaaaaaaaaaaaa");
        let r = measure_text_node(&mut m, &t, Some(50.0));
        assert!(r.lines > 1);
        assert!(r.width <= 50.0 + 1e-9);
    }
}
