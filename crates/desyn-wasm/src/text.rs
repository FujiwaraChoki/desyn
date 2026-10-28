//! Text editing geometry for the host's DOM overlay: laid-out lines and caret clusters with UTF-16 indices (DOM
//! offsets), caret / selection / hit / movement queries in page space, and text-to-outline conversion.

use desyn_core::geometry::{Affine, Point, Rect, world_transform};
use desyn_core::model::{Design, Node, TextNode};
use desyn_core::paths::{VectorPath, kurbo};
use desyn_text::{
    Affinity, LaidOutText, Movement, TextEngine, TextPosition, place_on_curve, utf8_to_utf16,
    utf16_to_utf8,
};
use serde::Serialize;

use crate::protocol::TextQuery;

/// Full layout of a text node for an editing overlay. Box coordinates are node-local (0..width, 0..height,
/// y down); `transform` maps them to page coordinates.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextLayoutInfo {
    /// Node id.
    pub node_id: String,
    /// Plain text (the runs concatenated); indices below are UTF-16 offsets into it.
    pub text: String,
    /// Length in UTF-16 code units.
    pub length: usize,
    /// Box width.
    pub width: f64,
    /// Box height.
    pub height: f64,
    /// Box -> page affine `[a, b, c, d, e, f]` (x' = a x + c y + e).
    pub transform: [f64; 6],
    /// Text on an arc (`curve`): carets use the straight layout.
    pub curved: bool,
    /// Vertical-alignment offset of the content.
    pub content_top: f64,
    /// Content taller than a fixed box.
    pub overflows: bool,
    /// Cut by `maxLines`.
    pub truncated: bool,
    /// Lines.
    pub lines: Vec<LineInfo>,
    /// Caret clusters (grapheme boxes per line, visual order).
    pub clusters: Vec<ClusterInfo>,
    /// Paragraphs.
    pub paragraphs: Vec<ParagraphRange>,
}

/// A laid out line.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LineInfo {
    /// Start (UTF-16).
    pub start: usize,
    /// End (UTF-16, excluding the paragraph separator).
    pub end: usize,
    /// Top of the line box.
    pub top: f64,
    /// Line box height.
    pub height: f64,
    /// Baseline.
    pub baseline: f64,
    /// Left of the visible content.
    pub x: f64,
    /// Width of the visible content.
    pub width: f64,
    /// Right-to-left paragraph.
    pub rtl: bool,
    /// Ends its paragraph.
    pub ends_paragraph: bool,
}

/// A grapheme box.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClusterInfo {
    /// Start (UTF-16).
    pub start: usize,
    /// End (UTF-16).
    pub end: usize,
    /// Line index.
    pub line: usize,
    /// Left edge.
    pub x0: f64,
    /// Right edge.
    pub x1: f64,
    /// Right-to-left.
    pub rtl: bool,
}

/// A paragraph range.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParagraphRange {
    /// Start (UTF-16).
    pub start: usize,
    /// End (UTF-16).
    pub end: usize,
    /// Right-to-left.
    pub rtl: bool,
}

/// Answer to a [`TextQuery`].
#[derive(Debug, Clone, PartialEq, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TextQueryResult {
    /// Resulting position (UTF-16), for `hit`, `move`.
    pub index: Option<usize>,
    /// Affinity of `index`.
    pub affinity: Option<Affinity>,
    /// Range (UTF-16), for `range`.
    pub start: Option<usize>,
    /// Range end.
    pub end: Option<usize>,
    /// Caret bar in box coordinates (`caret`, and for `hit` / `move` at the resulting position).
    pub caret: Option<CaretInfo>,
    /// Caret bar as a page-space segment `[x0, y0, x1, y1]` (top to bottom).
    pub caret_page: Option<[f64; 4]>,
    /// Selection rectangles in box coordinates.
    pub rects: Vec<Rect>,
    /// Selection rectangles as page-space quads (clockwise from top-left).
    pub quads: Vec<[Point; 4]>,
    /// Box -> page affine.
    pub transform: [f64; 6],
}

/// A caret bar.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaretInfo {
    /// x of the bar.
    pub x: f64,
    /// Top.
    pub y: f64,
    /// Height.
    pub height: f64,
    /// Line.
    pub line: usize,
    /// Inside right-to-left text.
    pub rtl: bool,
}

/// Outline of a text node.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextOutline {
    /// SVG path data in the node's box coordinates (glyphs and decorations, curve applied).
    pub d: String,
    /// Fill rule to draw it with.
    pub fill_rule: &'static str,
    /// Box width.
    pub width: f64,
    /// Box height.
    pub height: f64,
    /// Bounds of the outline (box coordinates).
    pub bounds: Option<Rect>,
}

/// The text node with `id`, if any.
pub fn text_node<'a>(design: &'a Design, id: &str) -> Option<&'a TextNode> {
    match design.node(id)? {
        Node::Text(t) => Some(t),
        _ => None,
    }
}

/// Box -> page affine of a node.
pub fn box_transform(design: &Design, id: &str) -> Affine {
    world_transform(design, id)
}

fn coeffs(a: &Affine) -> [f64; 6] {
    [a.a, a.b, a.c, a.d, a.e, a.f]
}

/// Converts a laid-out text to the overlay geometry.
pub fn layout_info(design: &Design, node: &TextNode, laid: &LaidOutText) -> TextLayoutInfo {
    let text = &laid.text;
    let u = |i: usize| utf8_to_utf16(text, i);
    let t = box_transform(design, &node.base.id);
    TextLayoutInfo {
        node_id: node.base.id.clone(),
        text: text.clone(),
        length: u(text.len()),
        width: laid.width,
        height: laid.height,
        transform: coeffs(&t),
        curved: node.curve.is_some_and(|c| c.is_finite() && c.abs() >= 0.01),
        content_top: laid.content_top,
        overflows: laid.overflows,
        truncated: laid.truncated,
        lines: laid
            .lines
            .iter()
            .map(|l| LineInfo {
                start: u(l.range.start),
                end: u(l.range.end),
                top: l.top,
                height: l.height,
                baseline: l.baseline,
                x: l.x,
                width: l.width,
                rtl: l.rtl,
                ends_paragraph: l.ends_paragraph,
            })
            .collect(),
        clusters: laid
            .clusters
            .iter()
            .map(|c| ClusterInfo {
                start: u(c.range.start),
                end: u(c.range.end),
                line: c.line,
                x0: c.x0,
                x1: c.x1,
                rtl: c.rtl,
            })
            .collect(),
        paragraphs: laid
            .paragraphs
            .iter()
            .map(|p| ParagraphRange {
                start: u(p.range.start),
                end: u(p.range.end),
                rtl: p.rtl,
            })
            .collect(),
    }
}

fn caret_info(laid: &LaidOutText, pos: TextPosition) -> CaretInfo {
    let c = laid.caret_rect(pos);
    CaretInfo {
        x: c.x,
        y: c.y,
        height: c.height,
        line: c.line,
        rtl: c.rtl,
    }
}

fn caret_segment(t: &Affine, c: &CaretInfo) -> [f64; 4] {
    let a = t.apply(Point::new(c.x, c.y));
    let b = t.apply(Point::new(c.x, c.y + c.height));
    [a.x, a.y, b.x, b.y]
}

fn quad(t: &Affine, r: &Rect) -> [Point; 4] {
    [
        t.apply(Point::new(r.x, r.y)),
        t.apply(Point::new(r.x + r.w, r.y)),
        t.apply(Point::new(r.x + r.w, r.y + r.h)),
        t.apply(Point::new(r.x, r.y + r.h)),
    ]
}

/// Answers a text query against a layout of the node.
pub fn query(design: &Design, laid: &LaidOutText, q: &TextQuery) -> Option<TextQueryResult> {
    let text = &laid.text;
    let id = match q {
        TextQuery::Caret { node_id, .. }
        | TextQuery::Hit { node_id, .. }
        | TextQuery::Selection { node_id, .. }
        | TextQuery::Move { node_id, .. }
        | TextQuery::Range { node_id, .. } => node_id,
    };
    let t = box_transform(design, id);
    let to8 = |i: usize| utf16_to_utf8(text, i);
    let to16 = |i: usize| utf8_to_utf16(text, i);
    let mut out = TextQueryResult {
        transform: coeffs(&t),
        ..Default::default()
    };
    let with_position = |out: &mut TextQueryResult, pos: TextPosition| {
        let c = caret_info(laid, pos);
        out.index = Some(to16(pos.index));
        out.affinity = Some(pos.affinity);
        out.caret_page = Some(caret_segment(&t, &c));
        out.caret = Some(c);
    };
    match q {
        TextQuery::Caret {
            index, affinity, ..
        } => {
            let pos = TextPosition {
                index: to8(*index),
                affinity: *affinity,
            };
            with_position(&mut out, pos);
        }
        TextQuery::Hit { x, y, .. } => {
            let local = t.inverse()?.apply(Point::new(*x, *y));
            let pos = laid.hit_test_point(local.x, local.y);
            with_position(&mut out, pos);
        }
        TextQuery::Selection { start, end, .. } => {
            let (a, b) = (to8(*start.min(end)), to8(*start.max(end)));
            out.rects = laid.selection_rects(a..b);
            out.quads = out.rects.iter().map(|r| quad(&t, r)).collect();
            out.start = Some(to16(a));
            out.end = Some(to16(b));
        }
        TextQuery::Move {
            index,
            affinity,
            direction,
            x,
            ..
        } => {
            let pos = TextPosition {
                index: to8(*index),
                affinity: *affinity,
            };
            let next = match direction.as_str() {
                "left" => laid.move_visual(pos, Movement::Left),
                "right" => laid.move_visual(pos, Movement::Right),
                "up" => laid.move_vertical(pos, -1, *x),
                "down" => laid.move_vertical(pos, 1, *x),
                "wordLeft" => TextPosition::new(laid.prev_word_boundary(pos.index)),
                "wordRight" => TextPosition::new(laid.next_word_boundary(pos.index)),
                "lineStart" => TextPosition::new(laid.line_range(pos).start),
                "lineEnd" => {
                    let r = laid.line_range(pos);
                    let ends_paragraph = laid
                        .line_for_position(pos)
                        .and_then(|li| laid.lines.get(li))
                        .is_none_or(|l| l.ends_paragraph);
                    // A soft-wrapped line ends where the next begins: stick to the earlier line.
                    let trimmed = text[r.clone()].trim_end_matches(' ').len() + r.start;
                    TextPosition {
                        index: if ends_paragraph { r.end } else { trimmed },
                        affinity: if ends_paragraph {
                            Affinity::Downstream
                        } else {
                            Affinity::Upstream
                        },
                    }
                }
                "docStart" => TextPosition::new(0),
                "docEnd" => TextPosition::new(text.len()),
                "graphemeLeft" => TextPosition::new(laid.prev_grapheme(pos.index)),
                "graphemeRight" => TextPosition::new(laid.next_grapheme(pos.index)),
                _ => return None,
            };
            with_position(&mut out, next);
        }
        TextQuery::Range { index, unit, .. } => {
            let i = to8(*index);
            let r = match unit.as_str() {
                "word" => laid.word_range(i),
                "line" => laid.line_range(TextPosition::new(i)),
                "paragraph" => laid.paragraph_range(i),
                _ => return None,
            };
            out.start = Some(to16(r.start));
            out.end = Some(to16(r.end));
        }
    }
    Some(out)
}

/// Converts the node's text to outlines (glyphs with synthetic styles baked in, underlines / strikethroughs;
/// text on an arc is placed along it).
pub fn outline(engine: &mut TextEngine, node: &TextNode, laid: &LaidOutText) -> TextOutline {
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
                let skew = kurbo::Affine::new([1.0, 0.0, -run.skew, 1.0, 0.0, 0.0]);
                let placed = pg.transform.to_kurbo() * skew * p;
                out.extend(placed.elements().iter().copied());
            }
            VectorPath::from_bez(&out)
        }
    };
    TextOutline {
        bounds: path.bounds(),
        d: path.to_svg(),
        fill_rule: "nonzero",
        width: laid.width,
        height: laid.height,
    }
}
