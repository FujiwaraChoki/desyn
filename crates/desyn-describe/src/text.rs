//! Text facts: content, resolved styles per run, the dominant style and real line layout from `desyn-text`.

use desyn_core::color::Rgba;
use desyn_core::geometry::Rect;
use desyn_core::{DesignStyles, TextAlign, TextDirection, TextNode, TextStyle};
use desyn_text::TextEngine;

use crate::paint;

/// One run with its effective style.
#[derive(Debug, Clone)]
pub struct StyledRun {
    /// Run text.
    pub text: String,
    /// Node style merged with the run override.
    pub style: TextStyle,
    /// Representative glyph color.
    pub color: Option<Rgba>,
    /// Opacity of the fill the glyph color comes from (`Fill.opacity`; 1 when unset).
    pub fill_opacity: f64,
}

impl StyledRun {
    /// Glyph color as it reaches the page: the representative fill color with the fill opacity and the layer
    /// opacity (`layer_opacity`, own times ancestors) applied as alpha. `None` without a solid / gradient fill.
    pub fn ink(&self, layer_opacity: f64) -> Option<Rgba> {
        self.color
            .map(|c| c.with_alpha(c.a * self.fill_opacity * layer_opacity.clamp(0.0, 1.0)))
    }

    /// What the glyphs of this run sit on: `backdrop` with the run's `highlight` painted over it.
    pub fn on(&self, backdrop: Rgba) -> Rgba {
        match &self.style.highlight {
            Some(h) => desyn_core::color::blend(
                desyn_core::BlendMode::Normal,
                backdrop,
                Rgba::from_color(h),
            ),
            None => backdrop,
        }
    }

    /// Whether an opaque highlight hides whatever is behind the run.
    pub fn opaque_highlight(&self) -> bool {
        self.style
            .highlight
            .as_ref()
            .is_some_and(|h| Rgba::from_color(h).a >= 0.99)
    }
}

/// A laid-out line (box-local coordinates).
#[derive(Debug, Clone)]
pub struct LineFact {
    /// Paragraph index.
    pub paragraph: usize,
    /// Left of the visible ink.
    pub x: f64,
    /// Top.
    pub top: f64,
    /// Visible width (no trailing spaces).
    pub width: f64,
    /// Height.
    pub height: f64,
    /// Words on the line.
    pub words: usize,
    /// Right-to-left line.
    pub rtl: bool,
    /// Ends with the ellipsis of `maxLines`.
    pub ellipsis: bool,
}

/// Everything describe needs to know about one text node.
#[derive(Debug, Clone)]
pub struct TextFacts {
    /// Plain text (runs concatenated).
    pub text: String,
    /// Runs with effective styles.
    pub runs: Vec<StyledRun>,
    /// Index into `runs` of the run carrying the most visible characters.
    pub dominant: usize,
    /// Smallest font size among runs with visible characters.
    pub min_size: f64,
    /// Largest font size among runs with visible characters.
    pub max_size: f64,
    /// Laid-out lines.
    pub lines: Vec<LineFact>,
    /// Height the content needs.
    pub content_height: f64,
    /// Widest line extent.
    pub content_width: f64,
    /// Content taller than the fixed box.
    pub overflows: bool,
    /// Text cut by `maxLines`.
    pub truncated: bool,
    /// Any right-to-left paragraph.
    pub rtl: bool,
    /// Visible ink bounds (box-local), empty text gives a zero rect at the top-left.
    pub ink: Rect,
    /// Paragraph alignment.
    pub align: TextAlign,
}

impl TextFacts {
    /// The dominant run style.
    pub fn style(&self) -> &TextStyle {
        &self.runs[self.dominant].style
    }

    /// Whether there is any non-whitespace character.
    pub fn has_content(&self) -> bool {
        self.text.chars().any(|c| !c.is_whitespace())
    }

    /// Dominant glyph color (falls back to black like an unset fill would render).
    pub fn color(&self) -> Rgba {
        self.runs[self.dominant].color.unwrap_or(Rgba::BLACK)
    }

    /// Number of laid-out lines (at least 1 for non-empty text).
    pub fn line_count(&self) -> u32 {
        self.lines.len().max(usize::from(!self.text.is_empty())) as u32
    }
}

/// Collects the facts of a text node.
pub fn facts(node: &TextNode, styles: &DesignStyles, engine: &mut TextEngine) -> TextFacts {
    let mut runs: Vec<StyledRun> = node
        .runs
        .iter()
        .map(|r| {
            let style = match &r.style {
                Some(p) => node.style.merged(p),
                None => node.style.clone(),
            };
            let paint = paint::representative_paint(&style.fills, styles);
            StyledRun {
                text: r.text.clone(),
                style,
                color: paint.map(|p| p.0),
                fill_opacity: paint.map(|p| p.1).unwrap_or(1.0),
            }
        })
        .collect();
    if runs.is_empty() {
        let paint = paint::representative_paint(&node.style.fills, styles);
        runs.push(StyledRun {
            text: String::new(),
            style: node.style.clone(),
            color: paint.map(|p| p.0),
            fill_opacity: paint.map(|p| p.1).unwrap_or(1.0),
        });
    }
    let visible_chars = |r: &StyledRun| r.text.chars().filter(|c| !c.is_whitespace()).count();
    let dominant = runs
        .iter()
        .enumerate()
        .max_by(|a, b| {
            visible_chars(a.1)
                .cmp(&visible_chars(b.1))
                .then(b.0.cmp(&a.0))
        })
        .map(|(i, _)| i)
        .unwrap_or(0);
    let sized: Vec<f64> = runs
        .iter()
        .filter(|r| visible_chars(r) > 0)
        .map(|r| r.style.font_size)
        .collect();
    let base = runs[dominant].style.font_size;
    let min_size = sized.iter().copied().fold(f64::INFINITY, f64::min);
    let max_size = sized.iter().copied().fold(f64::NEG_INFINITY, f64::max);
    let text: String = node.runs.iter().map(|r| r.text.as_str()).collect();

    let laid = engine.layout_node(node, Some(styles));
    let lines: Vec<LineFact> = laid
        .lines
        .iter()
        .map(|l| {
            let slice = laid.text.get(l.range.clone()).unwrap_or("");
            LineFact {
                paragraph: l.paragraph,
                x: l.x,
                top: l.top,
                width: l.width,
                height: l.height,
                words: slice.split_whitespace().count(),
                rtl: l.rtl,
                ellipsis: l.ellipsis,
            }
        })
        .collect();
    let rtl =
        laid.paragraphs.iter().any(|p| p.rtl) || node.paragraph.direction == TextDirection::Rtl;
    let ink = laid.bounds();
    // A fixed box more than a pixel shorter than its content overflows (sub-pixel differences are rounding);
    // with auto-resize the engine sizes the box itself.
    let overflows = laid.overflows && laid.content_height > node.base.height + 1.0;
    TextFacts {
        text,
        runs,
        dominant,
        min_size: if min_size.is_finite() { min_size } else { base },
        max_size: if max_size.is_finite() { max_size } else { base },
        lines,
        content_height: laid.content_height,
        content_width: laid.content_width,
        overflows,
        truncated: laid.truncated,
        rtl,
        ink,
        align: node.paragraph.align,
    }
}
