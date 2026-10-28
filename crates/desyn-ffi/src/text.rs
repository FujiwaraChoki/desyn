//! Text layout and caret geometry for native text editing (UITextInput works in UTF-16 offsets; the text engine
//! in UTF-8 byte offsets).

use desyn_core::model::TextNode;
use desyn_core::paths::{VectorPath, kurbo};
use desyn_text::{
    Affinity, LaidOutText, Movement, TextEngine, place_on_curve, utf8_to_utf16, utf16_to_utf8,
};

use crate::convert::to_u32;
use crate::types::{
    Affine, CaretRect, DesignRect, TextAffinity, TextLayout, TextLine, TextMovement, TextOutline,
    TextPosition, TextRange,
};

/// UTF-16 offset -> byte offset of the laid out text.
pub(crate) fn to_byte(laid: &LaidOutText, index: u32) -> usize {
    utf16_to_utf8(&laid.text, index as usize)
}

/// Byte offset -> UTF-16 offset.
pub(crate) fn to_utf16(laid: &LaidOutText, index: usize) -> u32 {
    to_u32(utf8_to_utf16(&laid.text, index))
}

pub(crate) fn to_engine_position(laid: &LaidOutText, p: TextPosition) -> desyn_text::TextPosition {
    desyn_text::TextPosition {
        index: to_byte(laid, p.index),
        affinity: match p.affinity {
            TextAffinity::Upstream => Affinity::Upstream,
            TextAffinity::Downstream => Affinity::Downstream,
        },
    }
}

pub(crate) fn from_engine_position(
    laid: &LaidOutText,
    p: desyn_text::TextPosition,
) -> TextPosition {
    TextPosition {
        index: to_utf16(laid, p.index),
        affinity: match p.affinity {
            Affinity::Upstream => TextAffinity::Upstream,
            Affinity::Downstream => TextAffinity::Downstream,
        },
    }
}

fn range16(laid: &LaidOutText, r: &std::ops::Range<usize>) -> TextRange {
    TextRange {
        start: to_utf16(laid, r.start),
        end: to_utf16(laid, r.end),
    }
}

/// The FFI view of a layout.
pub(crate) fn layout_record(node_id: &str, laid: &LaidOutText, transform: Affine) -> TextLayout {
    TextLayout {
        node_id: node_id.to_string(),
        text: laid.text.clone(),
        length: to_u32(laid.text.encode_utf16().count()),
        transform,
        width: laid.width,
        height: laid.height,
        content_width: laid.content_width,
        content_height: laid.content_height,
        content_top: laid.content_top,
        first_baseline: laid.first_baseline,
        lines: laid
            .lines
            .iter()
            .map(|l| TextLine {
                range: range16(laid, &l.range),
                paragraph: to_u32(l.paragraph),
                top: l.top,
                height: l.height,
                baseline: l.baseline,
                x: l.x,
                width: l.width,
                rtl: l.rtl,
                ends_paragraph: l.ends_paragraph,
                ellipsis: l.ellipsis,
            })
            .collect(),
        truncated: laid.truncated,
        overflows: laid.overflows,
    }
}

pub(crate) fn caret(laid: &LaidOutText, p: TextPosition) -> CaretRect {
    let c = laid.caret_rect(to_engine_position(laid, p));
    CaretRect {
        x: c.x,
        y: c.y,
        height: c.height,
        line: to_u32(c.line),
        rtl: c.rtl,
    }
}

pub(crate) fn selection_rects(laid: &LaidOutText, range: TextRange) -> Vec<DesignRect> {
    let (a, b) = (to_byte(laid, range.start), to_byte(laid, range.end));
    let (lo, hi) = if a <= b { (a, b) } else { (b, a) };
    laid.selection_rects(lo..hi)
        .into_iter()
        .map(Into::into)
        .collect()
}

pub(crate) fn word_range(laid: &LaidOutText, index: u32) -> TextRange {
    range16(laid, &laid.word_range(to_byte(laid, index)))
}

pub(crate) fn line_range(laid: &LaidOutText, p: TextPosition) -> TextRange {
    range16(laid, &laid.line_range(to_engine_position(laid, p)))
}

pub(crate) fn paragraph_range(laid: &LaidOutText, index: u32) -> TextRange {
    range16(laid, &laid.paragraph_range(to_byte(laid, index)))
}

/// Moves a caret. `x` is the sticky horizontal position for `Up` / `Down` (box-local; `None` = the caret's x).
pub(crate) fn move_caret(
    laid: &LaidOutText,
    p: TextPosition,
    movement: TextMovement,
    x: Option<f64>,
) -> TextPosition {
    let pos = to_engine_position(laid, p);
    let at = |index: usize| desyn_text::TextPosition::new(index);
    let out = match movement {
        TextMovement::Left => laid.move_visual(pos, Movement::Left),
        TextMovement::Right => laid.move_visual(pos, Movement::Right),
        TextMovement::Up => laid.move_vertical(pos, -1, x.filter(|v| v.is_finite())),
        TextMovement::Down => laid.move_vertical(pos, 1, x.filter(|v| v.is_finite())),
        TextMovement::GraphemeForward => at(laid.next_grapheme(pos.index)),
        TextMovement::GraphemeBackward => at(laid.prev_grapheme(pos.index)),
        TextMovement::WordForward => at(laid.next_word_boundary(pos.index)),
        TextMovement::WordBackward => at(laid.prev_word_boundary(pos.index)),
        TextMovement::LineStart => at(laid.line_range(pos).start),
        TextMovement::LineEnd => {
            let r = laid.line_range(pos);
            // The end of a soft-wrapped line sits before the next line's first character: stay on this line.
            desyn_text::TextPosition {
                index: r.end,
                affinity: Affinity::Upstream,
            }
        }
        TextMovement::ParagraphStart => at(laid.paragraph_range(pos.index).start),
        TextMovement::ParagraphEnd => at(laid.paragraph_range(pos.index).end),
    };
    from_engine_position(laid, out)
}

/// Converts a laid out text node to outlines (same geometry as the renderer and the wasm engine's `outlineText`).
pub(crate) fn outline(engine: &mut TextEngine, node: &TextNode, laid: &LaidOutText) -> TextOutline {
    let curve = node.curve.filter(|c| c.is_finite() && c.abs() >= 0.01);
    let path = match curve {
        None => engine.text_outline_vector(laid),
        Some(deg) => {
            let mut out = kurbo::BezPath::new();
            for pg in place_on_curve(laid, deg) {
                if !pg.visible {
                    continue;
                }
                let Some(run) = laid.runs.get(pg.run) else {
                    continue;
                };
                let Some(g) = run.glyphs.get(pg.glyph) else {
                    continue;
                };
                let Some(p) = engine.glyph_path(run.instance, g.id, run.size) else {
                    continue;
                };
                // Synthetic italic: the same shear the renderer applies to the glyph.
                let skew = kurbo::Affine::new([1.0, 0.0, -run.skew, 1.0, 0.0, 0.0]);
                let placed = pg.transform.to_kurbo() * skew * p;
                out.extend(placed.elements().iter().copied());
            }
            VectorPath::from_bez(&out)
        }
    };
    TextOutline {
        d: path.to_svg(),
        fill_rule: "nonzero".to_string(),
        width: laid.width,
        height: laid.height,
        bounds: path.bounds().map(Into::into),
    }
}
