//! Attributed text input: resolved span styles and paragraph formats, built from the document model.
//!
//! The document model (`DOCUMENT_MODEL.md` §3) carries a node-level `TextStyle` with per-run overrides and one
//! `ParagraphStyle` per node. A few optional keys that the model keeps in its forward-compatible `extra` maps are
//! honored here (see `API.md`, "Model extensions"): `TextStyle.baselineShift` (px, positive raises),
//! `TextStyle.wordSpacing` (em), `TextStyle.fontStretch` (percent), `TextStyle.lang` (BCP 47),
//! `ParagraphStyle.spaceBefore` (px) and `ParagraphStyle.listStart`. List nesting comes from leading tab characters
//! of a list paragraph (one level per tab, the tabs themselves are not drawn).

use std::collections::BTreeMap;
use std::ops::Range;

use desyn_core::color::resolve_color;
use desyn_core::model::{
    DesignStyles, Fill, LineHeightUnit, ListStyle, ParagraphStyle, TextAlign, TextCase,
    TextDecoration, TextDirection, TextNode, TextRun, TextStyle,
};
use serde_json::Value;

use crate::font::split_family_list;

/// Line height of a paragraph.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum LineHeightSpec {
    /// The font's natural line height (ascent + descent + line gap).
    Auto,
    /// Fixed line height in px.
    Px(f64),
    /// Percent of the font size.
    Percent(f64),
}

/// Fully resolved character style of a span.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpanStyle {
    /// Font family stack (first available wins, per character coverage).
    pub families: Vec<String>,
    /// Weight 1..1000.
    pub weight: f32,
    /// Italic.
    pub italic: bool,
    /// Width in percent (100 = normal).
    pub stretch: f32,
    /// Font size in px.
    pub size: f64,
    /// Tracking in em.
    pub letter_spacing: f64,
    /// Extra space added to word separators, in em.
    pub word_spacing: f64,
    /// Case transform.
    pub case: TextCase,
    /// Underline.
    pub underline: bool,
    /// Strikethrough.
    pub strikethrough: bool,
    /// Glyph paints (from the model; renderers draw these).
    pub fills: Vec<Fill>,
    /// First visible solid fill, resolved (`None` for gradient / image fills or unresolvable references).
    pub color: Option<[u8; 4]>,
    /// Highlight (background) color.
    pub highlight: Option<[u8; 4]>,
    /// Vertical shift in px (positive raises: superscript).
    pub baseline_shift: f64,
    /// OpenType features (`"liga"`, `"-kern"`, `"ss01"`, `"tnum=1"`).
    pub features: Vec<String>,
    /// Explicit variable font axis values (`[("wght", 550.0)]`); they win over weight / stretch / style.
    pub variations: Vec<(String, f32)>,
    /// Hyperlink.
    pub link: Option<String>,
    /// Language (BCP 47) for shaping, hyphenation and Han fallback.
    pub language: Option<String>,
}

impl Default for SpanStyle {
    fn default() -> Self {
        SpanStyle {
            families: vec!["Inter".into()],
            weight: 400.0,
            italic: false,
            stretch: 100.0,
            size: 24.0,
            letter_spacing: 0.0,
            word_spacing: 0.0,
            case: TextCase::None,
            underline: false,
            strikethrough: false,
            fills: Vec::new(),
            color: Some([0x11, 0x11, 0x11, 0xff]),
            highlight: None,
            baseline_shift: 0.0,
            features: Vec::new(),
            variations: Vec::new(),
            link: None,
            language: None,
        }
    }
}

fn extra_f64(extra: &serde_json::Map<String, Value>, key: &str) -> Option<f64> {
    extra
        .get(key)
        .and_then(Value::as_f64)
        .filter(|v| v.is_finite())
}

fn extra_str(extra: &serde_json::Map<String, Value>, key: &str) -> Option<String> {
    extra
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

fn finite_or(v: f64, d: f64) -> f64 {
    if v.is_finite() { v } else { d }
}

impl SpanStyle {
    /// Resolves a model `TextStyle` (with `styles` for `$var` / `$style` color references).
    pub fn from_text_style(s: &TextStyle, styles: Option<&DesignStyles>) -> SpanStyle {
        let families = split_family_list(&s.font_family);
        let color = s
            .fills
            .iter()
            .find(|f| f.is_visible())
            .and_then(|f| match f {
                Fill::Solid(solid) => {
                    let c = match styles {
                        Some(st) => resolve_color(&solid.color, st),
                        None => match &solid.color {
                            desyn_core::model::ColorValue::Color(c) => Some(c.clone()),
                            _ => None,
                        },
                    }?;
                    let mut rgba = c.rgba8();
                    let opacity = solid.flags.opacity.unwrap_or(1.0).clamp(0.0, 1.0);
                    rgba[3] = (f64::from(rgba[3]) * opacity).round() as u8;
                    Some(rgba)
                }
                _ => None,
            });
        SpanStyle {
            families: if families.is_empty() {
                vec!["Inter".into()]
            } else {
                families
            },
            weight: finite_or(s.font_weight, 400.0).clamp(1.0, 1000.0) as f32,
            italic: s.font_style == desyn_core::model::FontStyle::Italic,
            stretch: extra_f64(&s.extra, "fontStretch")
                .unwrap_or(100.0)
                .clamp(50.0, 200.0) as f32,
            size: finite_or(s.font_size, 0.0).clamp(0.0, 100_000.0),
            letter_spacing: finite_or(s.letter_spacing, 0.0).clamp(-10.0, 100.0),
            word_spacing: extra_f64(&s.extra, "wordSpacing")
                .unwrap_or(0.0)
                .clamp(-10.0, 100.0),
            case: s.text_case,
            underline: s.decoration == TextDecoration::Underline,
            strikethrough: s.decoration == TextDecoration::Strikethrough,
            fills: s.fills.clone(),
            color,
            highlight: s.highlight.as_ref().map(|c| c.rgba8()),
            baseline_shift: extra_f64(&s.extra, "baselineShift")
                .unwrap_or(0.0)
                .clamp(-100_000.0, 100_000.0),
            features: s.features.clone().unwrap_or_default(),
            variations: s
                .variations
                .as_ref()
                .map(|m| {
                    m.iter()
                        .filter(|(_, v)| v.is_finite())
                        .map(|(k, v)| (k.clone(), *v as f32))
                        .collect()
                })
                .unwrap_or_default(),
            link: s.link.clone(),
            language: extra_str(&s.extra, "lang"),
        }
    }
}

/// Paragraph format.
#[derive(Debug, Clone, PartialEq)]
pub struct ParagraphFormat {
    /// Horizontal alignment (visual: `left` is flush left in either direction).
    pub align: TextAlign,
    /// Base direction (`auto` = first strong character).
    pub direction: TextDirection,
    /// Line height.
    pub line_height: LineHeightSpec,
    /// Space before the paragraph (not before the first one), px.
    pub space_before: f64,
    /// Space after the paragraph (not after the last one), px.
    pub space_after: f64,
    /// First-line indent on the start side, px.
    pub indent: f64,
    /// List style.
    pub list: ListStyle,
    /// Nesting level; `None` derives it from leading tabs.
    pub list_level: Option<u8>,
    /// First number of numbered lists.
    pub list_start: u32,
}

impl Default for ParagraphFormat {
    fn default() -> Self {
        ParagraphFormat {
            align: TextAlign::Left,
            direction: TextDirection::Auto,
            line_height: LineHeightSpec::Percent(120.0),
            space_before: 0.0,
            space_after: 0.0,
            indent: 0.0,
            list: ListStyle::None,
            list_level: None,
            list_start: 1,
        }
    }
}

impl ParagraphFormat {
    /// Converts a model `ParagraphStyle`.
    pub fn from_paragraph_style(p: &ParagraphStyle) -> ParagraphFormat {
        let line_height = match p.line_height.unit {
            LineHeightUnit::Auto => LineHeightSpec::Auto,
            LineHeightUnit::Px => LineHeightSpec::Px(finite_or(p.line_height.value, 0.0).max(0.0)),
            LineHeightUnit::Percent => {
                LineHeightSpec::Percent(finite_or(p.line_height.value, 120.0).max(0.0))
            }
        };
        ParagraphFormat {
            align: p.align,
            direction: p.direction,
            line_height,
            space_before: extra_f64(&p.extra, "spaceBefore")
                .unwrap_or(0.0)
                .clamp(-100_000.0, 100_000.0),
            space_after: finite_or(p.spacing, 0.0).clamp(-100_000.0, 100_000.0),
            indent: finite_or(p.indent, 0.0).clamp(-100_000.0, 100_000.0),
            list: p.list,
            list_level: None,
            list_start: extra_f64(&p.extra, "listStart")
                .map(|v| v.clamp(0.0, 1_000_000.0) as u32)
                .unwrap_or(1),
        }
    }
}

/// A styled byte range of [`TextContent::text`].
#[derive(Debug, Clone, PartialEq)]
pub struct Span {
    /// Byte range.
    pub range: Range<usize>,
    /// Style.
    pub style: SpanStyle,
}

/// Attributed text to lay out.
#[derive(Debug, Clone, PartialEq)]
pub struct TextContent {
    /// Plain text; `'\n'` (and U+2029) separate paragraphs.
    pub text: String,
    /// Non-overlapping spans in order covering `text` (gaps use the style of the preceding span).
    pub spans: Vec<Span>,
    /// Paragraph format for every paragraph.
    pub paragraph: ParagraphFormat,
    /// Per-paragraph overrides by paragraph index.
    pub paragraph_overrides: BTreeMap<usize, ParagraphFormat>,
    /// Style of an empty text (caret height, empty-line metrics).
    pub default_style: SpanStyle,
}

impl TextContent {
    /// Text with a single style.
    pub fn plain(text: impl Into<String>, style: SpanStyle, paragraph: ParagraphFormat) -> Self {
        let text = text.into();
        let spans = vec![Span {
            range: 0..text.len(),
            style: style.clone(),
        }];
        TextContent {
            text,
            spans,
            paragraph,
            paragraph_overrides: BTreeMap::new(),
            default_style: style,
        }
    }

    /// Builds content from model runs over a base style (run overrides merged as in the model).
    pub fn from_runs(
        runs: &[TextRun],
        base: &TextStyle,
        paragraph: &ParagraphStyle,
        styles: Option<&DesignStyles>,
    ) -> Self {
        let mut text = String::new();
        let mut spans: Vec<Span> = Vec::new();
        let base_span = SpanStyle::from_text_style(base, styles);
        for run in runs {
            if run.text.is_empty() {
                continue;
            }
            let style = match &run.style {
                Some(patch) => SpanStyle::from_text_style(&base.merged(patch), styles),
                None => base_span.clone(),
            };
            let start = text.len();
            text.push_str(&run.text);
            match spans.last_mut() {
                Some(last) if last.style == style && last.range.end == start => {
                    last.range.end = text.len()
                }
                _ => spans.push(Span {
                    range: start..text.len(),
                    style,
                }),
            }
        }
        TextContent {
            text,
            spans,
            paragraph: ParagraphFormat::from_paragraph_style(paragraph),
            paragraph_overrides: BTreeMap::new(),
            default_style: base_span,
        }
    }

    /// Builds content from a text node (`styles` resolves color references).
    pub fn from_node(node: &TextNode, styles: Option<&DesignStyles>) -> Self {
        Self::from_runs(&node.runs, &node.style, &node.paragraph, styles)
    }

    /// Index of the span covering byte `i` (the last span starting at or before `i`).
    pub(crate) fn span_at(&self, i: usize) -> Option<usize> {
        if self.spans.is_empty() {
            return None;
        }
        let pos = self.spans.partition_point(|s| s.range.start <= i);
        Some(pos.saturating_sub(1))
    }

    /// Style at byte `i` (default style when there are no spans).
    pub fn style_at(&self, i: usize) -> &SpanStyle {
        match self.span_at(i) {
            Some(s) => &self.spans[s].style,
            None => &self.default_style,
        }
    }

    /// Format of paragraph `index`.
    pub fn paragraph_format(&self, index: usize) -> &ParagraphFormat {
        self.paragraph_overrides
            .get(&index)
            .unwrap_or(&self.paragraph)
    }
}

/// Applies a case transform to `text`, returning the transformed string and, for every byte of it, the byte offset
/// of the source character it came from (plus one trailing entry for the end).
pub(crate) fn transform_case(
    text: &str,
    case: TextCase,
    at_word_start: &mut bool,
    src_offset: usize,
    out: &mut String,
    map: &mut Vec<usize>,
) {
    for (i, c) in text.char_indices() {
        let before = out.len();
        match case {
            TextCase::None => out.push(c),
            TextCase::Upper => out.extend(c.to_uppercase()),
            TextCase::Lower => out.extend(c.to_lowercase()),
            TextCase::Title => {
                if *at_word_start && c.is_alphabetic() {
                    out.extend(c.to_uppercase());
                } else {
                    out.push(c);
                }
            }
        }
        if c.is_alphabetic() {
            *at_word_start = false;
        } else if c.is_whitespace() {
            *at_word_start = true;
        }
        for _ in before..out.len() {
            map.push(src_offset + i);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use desyn_core::model::{Color, Node};

    #[test]
    fn runs_merge_and_resolve() {
        let Node::Text(mut t) = Node::text("aaaaaaaaaaaa", "", 0.0, 0.0, None) else {
            unreachable!()
        };
        t.runs = vec![
            TextRun::plain("Hello "),
            TextRun {
                text: "world".into(),
                style: Some(desyn_core::model::TextStylePatch {
                    font_weight: Some(700.0),
                    highlight: Some(Color::new("#ffb02e").unwrap()),
                    ..Default::default()
                }),
                extra: Default::default(),
            },
            TextRun::plain("!"),
        ];
        t.style
            .extra
            .insert("baselineShift".into(), serde_json::json!(3.5));
        let c = TextContent::from_node(&t, None);
        assert_eq!(c.text, "Hello world!");
        assert_eq!(c.spans.len(), 3);
        assert_eq!(c.spans[1].range, 6..11);
        assert_eq!(c.spans[1].style.weight, 700.0);
        assert_eq!(c.spans[1].style.highlight, Some([0xff, 0xb0, 0x2e, 0xff]));
        assert_eq!(c.spans[0].style.baseline_shift, 3.5);
        assert_eq!(c.spans[0].style.color, Some([0x11, 0x11, 0x11, 0xff]));
        assert_eq!(c.style_at(7).weight, 700.0);
    }

    #[test]
    fn case_map_tracks_sources() {
        let mut out = String::new();
        let mut map = Vec::new();
        let mut ws = true;
        transform_case("straße x", TextCase::Upper, &mut ws, 10, &mut out, &mut map);
        assert_eq!(out, "STRASSE X");
        assert_eq!(map.len(), out.len());
        // "SS" both map to the source 'ß' at byte 4.
        assert_eq!(map[4], 14);
        assert_eq!(map[5], 14);
        let mut out = String::new();
        let mut map = Vec::new();
        let mut ws = true;
        transform_case(
            "hello wORLD",
            TextCase::Title,
            &mut ws,
            0,
            &mut out,
            &mut map,
        );
        assert_eq!(out, "Hello WORLD");
    }
}
