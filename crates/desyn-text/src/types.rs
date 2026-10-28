//! Layout output.

use std::ops::Range;

use desyn_core::geometry::Rect;
use serde::Serialize;

use crate::content::SpanStyle;
use crate::font::{FontId, InstanceId};

/// What a glyph run draws.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RunKind {
    /// Text of the content.
    Text,
    /// A list bullet or number.
    ListMarker,
    /// The `…` appended to truncated text.
    Ellipsis,
    /// The hyphen drawn at a hyphenated line end.
    Hyphen,
}

/// One positioned glyph.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Glyph {
    /// Glyph id in the run's font.
    pub id: u32,
    /// Origin x in box coordinates (px).
    pub x: f64,
    /// Origin y (on the baseline, including mark offsets and baseline shift) in box coordinates (px, y down).
    pub y: f64,
    /// Advance (px).
    pub advance: f64,
    /// Byte offset in the source text of the cluster this glyph belongs to.
    pub cluster: usize,
}

/// Glyphs sharing font, size and style, in visual (left-to-right) order.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GlyphRun {
    /// Kind.
    pub kind: RunKind,
    /// Face.
    pub face: FontId,
    /// Face at its variation location.
    pub instance: InstanceId,
    /// Axis values of the instance (`[("wght", 650.0)]`).
    pub variations: Vec<(String, f32)>,
    /// Font size in px.
    pub size: f64,
    /// Index into [`LaidOutText::spans`].
    pub span: usize,
    /// Line index.
    pub line: usize,
    /// Right-to-left run.
    pub rtl: bool,
    /// Source byte range the run covers (empty for markers).
    pub range: Range<usize>,
    /// Baseline y (px, including baseline shift).
    pub baseline: f64,
    /// Left edge.
    pub x: f64,
    /// Advance width.
    pub width: f64,
    /// Resolved solid color of the span (`None` for gradient / image fills).
    pub color: Option<[u8; 4]>,
    /// Synthetic bold: stroke glyphs with this width in px (0 = none).
    pub synthetic_bold: f64,
    /// Synthetic oblique: horizontal skew factor (x += skew * height above baseline; 0 = none).
    pub skew: f64,
    /// Glyphs.
    pub glyphs: Vec<Glyph>,
}

/// Decoration kind.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DecorationKind {
    /// Underline (drawn after glyph backgrounds, before or after glyphs at the renderer's choice).
    Underline,
    /// Strikethrough (drawn over glyphs).
    Strikethrough,
    /// Highlight background (drawn under glyphs).
    Highlight,
}

/// A decoration rectangle.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Decoration {
    /// Kind.
    pub kind: DecorationKind,
    /// Geometry in box coordinates.
    pub rect: Rect,
    /// Span whose fills paint it (highlights use [`Decoration::color`]).
    pub span: usize,
    /// Line index.
    pub line: usize,
    /// Highlight color, or the span's solid color for lines.
    pub color: Option<[u8; 4]>,
}

/// A laid out line.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Line {
    /// Source byte range (including trailing spaces, excluding the paragraph separator).
    pub range: Range<usize>,
    /// Paragraph index.
    pub paragraph: usize,
    /// Top of the line box.
    pub top: f64,
    /// Line box height.
    pub height: f64,
    /// Baseline y.
    pub baseline: f64,
    /// Largest ascent above the baseline (font ascent, no leading).
    pub ascent: f64,
    /// Largest descent below the baseline.
    pub descent: f64,
    /// Left edge of the visible content (after alignment, without hanging spaces).
    pub x: f64,
    /// Width of the visible content (without trailing spaces).
    pub width: f64,
    /// Paragraph is right-to-left.
    pub rtl: bool,
    /// Glyph runs of this line.
    pub runs: Range<usize>,
    /// Caret clusters of this line.
    pub clusters: Range<usize>,
    /// The line ends its paragraph.
    pub ends_paragraph: bool,
    /// Truncated with an ellipsis.
    pub ellipsis: bool,
    /// Ends with a hyphenation hyphen.
    pub hyphenated: bool,
}

/// A grapheme box for caret / selection geometry, in visual order per line.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClusterBox {
    /// Source byte range.
    pub range: Range<usize>,
    /// Line index.
    pub line: usize,
    /// Left edge.
    pub x0: f64,
    /// Right edge.
    pub x1: f64,
    /// Right-to-left.
    pub rtl: bool,
}

/// Per-paragraph result.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParagraphInfo {
    /// Source byte range (excluding the separator).
    pub range: Range<usize>,
    /// Lines of the paragraph.
    pub lines: Range<usize>,
    /// Resolved right-to-left base direction.
    pub rtl: bool,
    /// List nesting level.
    pub list_level: u8,
    /// List marker text (`"•"`, `"3."`).
    pub marker: Option<String>,
}

/// The result of laying out text in a box.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LaidOutText {
    /// Source text.
    pub text: String,
    /// Box width.
    pub width: f64,
    /// Box height.
    pub height: f64,
    /// Widest line extent including indents and list gutters.
    pub content_width: f64,
    /// Height of all lines and paragraph spacing.
    pub content_height: f64,
    /// Offset of the content from the box top (vertical alignment; negative when it overflows).
    pub content_top: f64,
    /// First baseline from the box top.
    pub first_baseline: f64,
    /// Lines.
    pub lines: Vec<Line>,
    /// Glyph runs.
    pub runs: Vec<GlyphRun>,
    /// Underlines, strikethroughs and highlights.
    pub decorations: Vec<Decoration>,
    /// Caret clusters.
    pub clusters: Vec<ClusterBox>,
    /// Paragraphs.
    pub paragraphs: Vec<ParagraphInfo>,
    /// Span styles referenced by runs and decorations.
    pub spans: Vec<SpanStyle>,
    /// Some text was cut by `maxLines`.
    pub truncated: bool,
    /// Content is taller than a fixed box.
    pub overflows: bool,
}

impl LaidOutText {
    /// Logical bounds of the lines (visible content, box coordinates).
    pub fn bounds(&self) -> Rect {
        let mut r: Option<Rect> = None;
        for l in &self.lines {
            let lr = Rect {
                x: l.x,
                y: l.top,
                w: l.width.max(0.0),
                h: l.height.max(0.0),
            };
            r = Some(match r {
                Some(a) => a.union(&lr),
                None => lr,
            });
        }
        r.unwrap_or(Rect {
            x: 0.0,
            y: self.content_top,
            w: 0.0,
            h: 0.0,
        })
    }

    /// Number of lines.
    pub fn line_count(&self) -> usize {
        self.lines.len()
    }
}
