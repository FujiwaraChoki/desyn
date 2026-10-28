//! Rich text layout: paragraphs, bidi, itemization with font fallback, shaping, UAX #14 line breaking with a
//! hyphenation hook, justification, lists, ellipsis truncation, vertical alignment and caret clusters.

use std::collections::HashMap;
use std::ops::Range;

use desyn_core::geometry::Rect;
use desyn_core::layout::{approx_advance_em, vertical_offset};
use desyn_core::model::{AutoResize, ListStyle, TextAlign, TextDirection, TextNode, VerticalAlign};
use unicode_bidi::{Level, ParagraphBidiInfo};
use unicode_linebreak::{BreakOpportunity, linebreaks};
use unicode_script::Script;
use unicode_segmentation::UnicodeSegmentation;

use crate::content::{LineHeightSpec, ParagraphFormat, SpanStyle, TextContent, transform_case};
use crate::font::fallback::{
    char_script, is_cursive_script, is_emoji_cluster, is_ignorable, is_inter_character_script,
};
use crate::font::{
    FaceMatch, FontDb, FontId, FontRequest, InstanceId, MatchRequest, RequestReason, StyleQuery,
};
use crate::shape::{FeatureList, ShapeRequest, Shaper, parse_features};
use crate::types::{
    ClusterBox, Decoration, DecorationKind, Glyph, GlyphRun, LaidOutText, Line, ParagraphInfo,
    RunKind,
};

/// Width tolerance so text measured at width `w` does not wrap when laid out at exactly `w`.
const EPS: f64 = 1e-4;
/// Synthetic oblique skew (about 11.3 degrees).
const SYNTHETIC_SKEW: f64 = 0.2;
/// List gutter per nesting level, in em of the paragraph's first character.
const LIST_INDENT_EM: f64 = 1.5;
/// Gap between a list marker and the text, in em.
const LIST_MARKER_GAP_EM: f64 = 0.4;
/// Width of the newline marker drawn when a selection spans a paragraph break, in em.
pub(crate) const NEWLINE_SELECTION_EM: f64 = 0.3;

/// Supplies hyphenation points for words that do not fit a line.
pub trait Hyphenator: Send {
    /// Byte offsets inside `word` where a hyphen may be inserted (the part before the offset stays on the line).
    fn hyphenate(&self, word: &str, language: Option<&str>) -> Vec<usize>;
}

/// How to lay out a text box.
#[derive(Debug, Clone, PartialEq)]
pub struct LayoutOptions {
    /// Box width (the wrap width unless `auto_resize` is `Width`).
    pub width: Option<f64>,
    /// Box height (used with `auto_resize: None` for vertical alignment and overflow).
    pub height: Option<f64>,
    /// Auto-resize mode of the node.
    pub auto_resize: AutoResize,
    /// Maximum number of lines; the last kept line ends with an ellipsis when text is cut.
    pub max_lines: Option<u32>,
    /// Vertical alignment of the content in the box.
    pub vertical_align: VerticalAlign,
    /// Ask the hyphenator for break points in words that do not fit (soft hyphens always work).
    pub hyphenate: bool,
}

impl Default for LayoutOptions {
    fn default() -> Self {
        LayoutOptions {
            width: None,
            height: None,
            auto_resize: AutoResize::Width,
            max_lines: None,
            vertical_align: VerticalAlign::Top,
            hyphenate: false,
        }
    }
}

impl LayoutOptions {
    /// Wrapping at `width` with the height following the content.
    pub fn wrapping(width: f64) -> Self {
        LayoutOptions {
            width: Some(width),
            auto_resize: AutoResize::Height,
            ..Default::default()
        }
    }

    /// Options matching a text node's box, auto-resize mode, line limit and vertical alignment.
    pub fn for_node(node: &TextNode) -> Self {
        LayoutOptions {
            width: Some(node.base.width),
            height: Some(node.base.height),
            auto_resize: node.auto_resize,
            max_lines: node.max_lines.map(|v| u32::try_from(v).unwrap_or(u32::MAX)),
            vertical_align: node.vertical_align,
            hyphenate: false,
        }
    }

    fn wrap_width(&self) -> Option<f64> {
        match self.auto_resize {
            AutoResize::Width => None,
            _ => self.width.filter(|w| w.is_finite()).map(|w| w.max(0.0)),
        }
    }
}

pub(crate) struct LayoutCtx<'a> {
    pub db: &'a mut FontDb,
    pub shaper: &'a mut Shaper,
    pub hyphenator: Option<&'a dyn Hyphenator>,
    pub requests: &'a mut Vec<FontRequest>,
}

#[derive(Debug, Clone, Copy)]
struct PGlyph {
    id: u32,
    advance: f64,
    dx: f64,
    dy: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Brk {
    None,
    Allowed,
    Mandatory,
}

#[derive(Debug, Clone)]
struct Item {
    range: Range<usize>,
    span: usize,
    rtl: bool,
    script: Script,
    font: Option<FontSel>,
    size: f64,
    scale: f64,
    letter_spacing: f64,
    word_spacing: f64,
    features: FeatureList,
}

#[derive(Debug, Clone, Copy, PartialEq)]
struct FontSel {
    face: FontId,
    instance: InstanceId,
    synthetic_bold: bool,
    synthetic_italic: bool,
}

#[derive(Debug, Clone)]
struct Cluster {
    range: Range<usize>,
    item: usize,
    glyphs: Range<usize>,
    advance: f64,
    letter_spacing: f64,
    whitespace: bool,
    space: bool,
    brk: Brk,
    unsafe_before: bool,
    shy: bool,
    inter_char: bool,
}

/// A glyph sequence appended to a line (ellipsis, hyphen) or drawn in the gutter (list marker).
#[derive(Debug, Clone)]
struct Synthetic {
    kind: RunKind,
    item: Item,
    /// Glyphs in visual order with their pen x relative to the start of the sequence.
    glyphs: Vec<(PGlyph, f64)>,
    width: f64,
}

struct Para {
    index: usize,
    src: Range<usize>,
    content_start: usize,
    display: String,
    d2s: Vec<usize>,
    span_ranges: Vec<(Range<usize>, usize)>,
    format: ParagraphFormat,
    level: u8,
    rtl: bool,
    levels: Vec<Level>,
    has_rtl: bool,
    items: Vec<Item>,
    clusters: Vec<Cluster>,
    glyphs: Vec<PGlyph>,
    style_span: usize,
    marker: Option<Synthetic>,
    marker_text: Option<String>,
    gutter: f64,
}

struct LineSpan {
    start: usize,
    end: usize,
    forced: bool,
    hyphen: Option<Synthetic>,
    ellipsis: Option<Synthetic>,
    ends_paragraph: bool,
}

struct PreLine {
    para: usize,
    span: LineSpan,
    first_in_para: bool,
    width: f64,
    trailing_ws: f64,
    above: f64,
    below: f64,
    ascent: f64,
    descent: f64,
    top: f64,
}

#[derive(Default)]
struct SpanFonts {
    stack: Vec<FaceMatch>,
    req: MatchRequest,
    features: FeatureList,
}

struct Builder<'c, 'a> {
    ctx: &'c mut LayoutCtx<'a>,
    content: &'c TextContent,
    spans: Vec<Option<SpanFonts>>,
    sel_cache: HashMap<(usize, FontId), FontSel>,
    fallback_cache: HashMap<(usize, String), Option<FaceMatch>>,
}

fn span_request(style: &SpanStyle) -> MatchRequest {
    MatchRequest {
        weight: style.weight,
        style: if style.italic {
            StyleQuery::Italic
        } else {
            StyleQuery::Normal
        },
        stretch: style.stretch,
    }
}

fn push_request(requests: &mut Vec<FontRequest>, req: FontRequest) {
    if !requests.iter().any(|r| r.key() == req.key()) {
        requests.push(req);
    }
}

impl<'c, 'a> Builder<'c, 'a> {
    fn style(&self, span: usize) -> &'c SpanStyle {
        match self.content.spans.get(span) {
            Some(s) => &s.style,
            None => &self.content.default_style,
        }
    }

    /// Resolves the family stack of a span once per layout.
    fn span_fonts(&mut self, span: usize) -> &SpanFonts {
        // Every index past the spans (`usize::MAX` marks "no span": empty text) means the default style.
        let span = span.min(self.content.spans.len());
        if self.spans.len() <= span {
            self.spans.resize_with(span + 1, || None);
        }
        if self.spans[span].is_none() {
            let style = self.style(span);
            let req = span_request(style);
            let mut stack = Vec::new();
            for family in &style.families {
                match self.ctx.db.match_family(family, &req) {
                    Some(m) => stack.push(m),
                    // Generic families (`sans-serif`, ...) resolve through the fallback chains, not providers.
                    None if self
                        .ctx
                        .db
                        .fallback
                        .generic_families
                        .contains_key(&crate::font::normalize_family(family)) => {}
                    None => push_request(
                        self.ctx.requests,
                        FontRequest {
                            family: family.clone(),
                            weight: style.weight,
                            italic: style.italic,
                            reason: RequestReason::Family,
                        },
                    ),
                }
            }
            if stack.is_empty() {
                let defaults = self.ctx.db.fallback.default_families.clone();
                for family in defaults {
                    if let Some(m) = self.ctx.db.match_family(&family, &req) {
                        stack.push(m);
                        break;
                    }
                }
            }
            if stack.is_empty()
                && let Some(first) = self.ctx.db.faces().next()
            {
                let family = first.family.clone();
                if let Some(m) = self.ctx.db.match_family(&family, &req) {
                    stack.push(m);
                }
            }
            let tracking = style.letter_spacing != 0.0;
            self.spans[span] = Some(SpanFonts {
                stack,
                req,
                features: parse_features(&style.features, tracking),
            });
        }
        self.spans[span].as_ref().expect("resolved above")
    }

    fn select(&mut self, span: usize, m: &FaceMatch) -> FontSel {
        if let Some(sel) = self.sel_cache.get(&(span, m.face)) {
            return *sel;
        }
        let style = self.style(span);
        let vars = self
            .ctx
            .db
            .variations_for(m, style.size as f32, &style.variations);
        let instance = self.ctx.db.instance(m.face, &vars);
        let sel = FontSel {
            face: m.face,
            instance,
            synthetic_bold: m.synthetic_bold,
            synthetic_italic: m.synthetic_italic,
        };
        self.sel_cache.insert((span, m.face), sel);
        sel
    }

    /// Picks the face for a grapheme cluster: emoji fonts for emoji presentation, then the span's family stack,
    /// then per-script fallbacks, the default families and finally any registered face covering it.
    fn choose_face(
        &mut self,
        span: usize,
        cluster: &str,
        raw_script: Script,
        emoji: bool,
    ) -> Option<FaceMatch> {
        let primary = self.span_fonts(span).stack.first().copied();
        if !emoji
            && let Some(p) = primary
            && self.ctx.db.covers_cluster(p.face, cluster)
        {
            return Some(p);
        }
        let key = (span, cluster.to_string());
        if let Some(hit) = self.fallback_cache.get(&key) {
            return hit.or(primary);
        }
        let found = self.find_fallback(span, cluster, raw_script, emoji);
        self.fallback_cache.insert(key, found);
        found.or(primary)
    }

    fn find_fallback(
        &mut self,
        span: usize,
        cluster: &str,
        raw_script: Script,
        emoji: bool,
    ) -> Option<FaceMatch> {
        let style = self.style(span);
        let (req, stack) = {
            let fonts = self.span_fonts(span);
            (fonts.req, fonts.stack.clone())
        };
        let db = &*self.ctx.db;
        let try_family = |family: &str| -> Option<FaceMatch> {
            let m = db.match_family(family, &req)?;
            db.covers_cluster(m.face, cluster).then_some(m)
        };
        if emoji {
            for family in &db.fallback.emoji_families {
                if let Some(m) = try_family(family) {
                    return Some(m);
                }
            }
        }
        for m in &stack {
            if db.covers_cluster(m.face, cluster) {
                return Some(*m);
            }
        }
        // Other faces of the span's own families (unicode-range subsets of one web font).
        for family in &style.families {
            if let Some(m) = db.match_family_covering(family, &req, cluster) {
                return Some(m);
            }
        }
        let script_families = db
            .fallback
            .for_script(raw_script, style.language.as_deref());
        for family in &script_families {
            if let Some(m) = try_family(family) {
                return Some(m);
            }
        }
        for family in &db.fallback.default_families {
            if let Some(m) = try_family(family) {
                return Some(m);
            }
        }
        let scanned = self.ctx.db.scan_cover(cluster, emoji);
        if let Some(face) = scanned {
            let info = self.ctx.db.face(face)?;
            let refs = [info];
            return crate::font::match_faces(&refs, &req);
        }
        // Nothing covers it: ask the host for the fallback family and render with the primary face.
        let wanted = if emoji {
            self.ctx.db.fallback.emoji_families.first().cloned()
        } else {
            script_families.first().cloned()
        };
        if let Some(family) = wanted {
            push_request(
                self.ctx.requests,
                FontRequest {
                    family,
                    weight: style.weight,
                    italic: style.italic,
                    reason: if emoji {
                        RequestReason::Emoji
                    } else {
                        RequestReason::Fallback
                    },
                },
            );
        }
        None
    }

    fn make_item(
        &mut self,
        range: Range<usize>,
        span: usize,
        rtl: bool,
        script: Script,
        face: Option<FaceMatch>,
    ) -> Item {
        let style = self.style(span);
        let size = style.size.max(0.0);
        let font = face.map(|m| self.select(span, &m));
        let scale = match font {
            Some(f) => size / self.ctx.db.inst(f.instance).metrics().units_per_em,
            None => 0.0,
        };
        let cursive = is_cursive_script(script);
        Item {
            range,
            span,
            rtl,
            script,
            font,
            size,
            scale,
            letter_spacing: if cursive {
                0.0
            } else {
                style.letter_spacing * size
            },
            word_spacing: style.word_spacing * size,
            features: self.span_fonts(span).features.clone(),
        }
    }

    /// Shapes `text` (a slice of the paragraph display text at `range`) for an item.
    fn shape_glyphs(
        &mut self,
        display: &str,
        item: &Item,
        range: Range<usize>,
    ) -> Vec<(PGlyph, usize, bool)> {
        let text = &display[range.clone()];
        let Some(font) = item.font else {
            // No font at all: approximate advances, one invisible glyph per grapheme.
            return text
                .grapheme_indices(true)
                .map(|(i, g)| {
                    let adv: f64 = g.chars().map(approx_advance_em).sum::<f64>() * item.size;
                    (
                        PGlyph {
                            id: 0,
                            advance: adv,
                            dx: 0.0,
                            dy: 0.0,
                        },
                        range.start + i,
                        false,
                    )
                })
                .collect();
        };
        let pre_start = floor_char_boundary(display, range.start.saturating_sub(32));
        let post_end = ceil_char_boundary(display, (range.end + 32).min(display.len()));
        let style = self.style(item.span);
        let shaped = self.ctx.shaper.shape(
            self.ctx.db,
            &ShapeRequest {
                text,
                pre_context: &display[pre_start..range.start],
                post_context: &display[range.end..post_end],
                instance: font.instance,
                rtl: item.rtl,
                script: item.script,
                language: style.language.as_deref(),
                features: &item.features,
                start_of_paragraph: range.start == 0,
                end_of_paragraph: range.end == display.len(),
            },
        );
        shaped
            .glyphs
            .iter()
            .map(|g| {
                (
                    PGlyph {
                        id: g.id,
                        advance: f64::from(g.advance) * item.scale,
                        dx: f64::from(g.dx) * item.scale,
                        dy: f64::from(g.dy) * item.scale,
                    },
                    range.start + g.cluster as usize,
                    g.unsafe_to_break,
                )
            })
            .collect()
    }

    /// Groups shaped glyphs into logical clusters.
    fn build_clusters(
        &mut self,
        display: &str,
        item_index: usize,
        item: &Item,
        range: Range<usize>,
        glyph_store: &mut Vec<PGlyph>,
    ) -> Vec<Cluster> {
        let shaped = self.shape_glyphs(display, item, range.clone());
        // Groups of consecutive glyphs sharing a cluster value, in visual order.
        let mut groups: Vec<(usize, Range<usize>, bool)> = Vec::new();
        let base = glyph_store.len();
        for (i, (g, cl, unsafe_)) in shaped.iter().enumerate() {
            glyph_store.push(*g);
            match groups.last_mut() {
                Some((c, r, u)) if *c == *cl => {
                    r.end = base + i + 1;
                    *u |= *unsafe_;
                }
                _ => groups.push((*cl, base + i..base + i + 1, *unsafe_)),
            }
        }
        if item.rtl {
            groups.reverse();
        }
        // Monotone clusters can still repeat after reordering in rare fonts; merge equal starts.
        groups.sort_by_key(|g| g.0);
        let mut merged: Vec<(usize, Range<usize>, bool)> = Vec::with_capacity(groups.len());
        for g in groups {
            match merged.last_mut() {
                Some(last) if last.0 == g.0 => {
                    last.1.start = last.1.start.min(g.1.start);
                    last.1.end = last.1.end.max(g.1.end);
                    last.2 |= g.2;
                }
                _ => merged.push(g),
            }
        }
        let mut out = Vec::with_capacity(merged.len());
        for (k, (start, glyphs, unsafe_)) in merged.iter().enumerate() {
            let start = (*start).max(range.start);
            let end = merged.get(k + 1).map_or(range.end, |n| n.0).min(range.end);
            if start >= end {
                continue;
            }
            let text = &display[start..end];
            let whitespace = text.chars().all(char::is_whitespace);
            let space = whitespace
                && text
                    .chars()
                    .any(|c| matches!(c, ' ' | '\u{a0}' | '\u{3000}'));
            let adv: f64 = glyph_store[glyphs.clone()].iter().map(|g| g.advance).sum();
            let ls = if whitespace && text.chars().all(|c| c == '\u{200b}') {
                0.0
            } else {
                item.letter_spacing
            };
            let ws = if space { item.word_spacing } else { 0.0 };
            out.push(Cluster {
                range: start..end,
                item: item_index,
                glyphs: glyphs.clone(),
                advance: adv + ls + ws,
                letter_spacing: ls,
                whitespace,
                space,
                brk: Brk::None,
                unsafe_before: *unsafe_,
                shy: text.ends_with('\u{ad}'),
                inter_char: is_inter_character_script(item.script),
            });
        }
        out
    }

    /// Shapes a short string (marker, ellipsis, hyphen) with the face chosen for its characters.
    fn synthetic(&mut self, text: &str, span: usize, rtl: bool, kind: RunKind) -> Synthetic {
        let script = text
            .chars()
            .map(char_script)
            .find(|s| !matches!(s, Script::Common | Script::Inherited))
            .unwrap_or(Script::Common);
        let face = self.choose_face(span, text, Script::Common, false);
        let item = self.make_item(
            0..text.len(),
            span,
            rtl,
            if script == Script::Common {
                Script::Latin
            } else {
                script
            },
            face,
        );
        let mut store = Vec::new();
        let mut clusters = self.build_clusters(text, 0, &item, 0..text.len(), &mut store);
        if rtl {
            clusters.reverse();
        }
        let mut glyphs = Vec::with_capacity(store.len());
        let mut x = 0.0;
        for c in &clusters {
            let mut pen = x + if rtl { c.letter_spacing } else { 0.0 };
            for g in &store[c.glyphs.clone()] {
                glyphs.push((*g, pen));
                pen += g.advance;
            }
            x += c.advance;
        }
        Synthetic {
            kind,
            item,
            glyphs,
            width: x,
        }
    }

    fn hyphen(&mut self, span: usize, rtl: bool) -> Synthetic {
        let h = self.synthetic("\u{2010}", span, rtl, RunKind::Hyphen);
        if h.glyphs.iter().all(|(g, _)| g.id != 0) && !h.glyphs.is_empty() {
            return h;
        }
        self.synthetic("-", span, rtl, RunKind::Hyphen)
    }

    fn ellipsis(&mut self, span: usize, rtl: bool) -> Synthetic {
        let e = self.synthetic("\u{2026}", span, rtl, RunKind::Ellipsis);
        if e.glyphs.iter().all(|(g, _)| g.id != 0) && !e.glyphs.is_empty() || e.item.font.is_none()
        {
            return e;
        }
        self.synthetic("...", span, rtl, RunKind::Ellipsis)
    }

    /// Ascent, descent and line gap (px) of a span's primary face.
    fn span_metrics(&mut self, span: usize) -> (f64, f64, f64, f64) {
        let size = self.style(span).size.max(0.0);
        let primary = self.span_fonts(span).stack.first().copied();
        match primary {
            Some(m) => {
                let sel = self.select(span, &m);
                let met = *self.ctx.db.inst(sel.instance).metrics();
                let s = size / met.units_per_em;
                (met.ascent * s, met.descent * s, met.line_gap * s, size)
            }
            None => (size * 0.8, size * 0.2, size * 0.2, size),
        }
    }

    fn item_metrics(&self, item: &Item) -> (f64, f64, f64) {
        match item.font {
            Some(f) => {
                let m = self.ctx.db.inst(f.instance).metrics();
                (
                    m.ascent * item.scale,
                    m.descent * item.scale,
                    m.line_gap * item.scale,
                )
            }
            None => (item.size * 0.8, item.size * 0.2, item.size * 0.2),
        }
    }
}

fn floor_char_boundary(s: &str, mut i: usize) -> usize {
    while i > 0 && !s.is_char_boundary(i) {
        i -= 1;
    }
    i
}

fn ceil_char_boundary(s: &str, mut i: usize) -> usize {
    while i < s.len() && !s.is_char_boundary(i) {
        i += 1;
    }
    i
}

impl Para {
    fn span_at(&self, i: usize) -> usize {
        let pos = self.span_ranges.partition_point(|(r, _)| r.start <= i);
        self.span_ranges
            .get(pos.saturating_sub(1))
            .map_or(self.style_span, |(_, s)| *s)
    }

    fn src(&self, display: usize) -> usize {
        self.d2s[display.min(self.d2s.len() - 1)]
    }
}

fn alpha(mut n: u32) -> String {
    let mut s = Vec::new();
    while n > 0 {
        n -= 1;
        s.push((b'a' + (n % 26) as u8) as char);
        n /= 26;
    }
    s.iter().rev().collect()
}

fn roman(mut n: u32) -> String {
    if n == 0 || n >= 4000 {
        return n.to_string();
    }
    let table = [
        (1000, "m"),
        (900, "cm"),
        (500, "d"),
        (400, "cd"),
        (100, "c"),
        (90, "xc"),
        (50, "l"),
        (40, "xl"),
        (10, "x"),
        (9, "ix"),
        (5, "v"),
        (4, "iv"),
        (1, "i"),
    ];
    let mut s = String::new();
    for (v, r) in table {
        while n >= v {
            s.push_str(r);
            n -= v;
        }
    }
    s
}

/// Marker text of a list item.
pub(crate) fn marker_text(list: ListStyle, level: u8, number: u32) -> Option<String> {
    match list {
        ListStyle::None => None,
        ListStyle::Bullet => {
            Some(["\u{2022}", "\u{25E6}", "\u{25AA}"][usize::from(level % 3)].to_string())
        }
        ListStyle::Number => Some(match level % 3 {
            0 => format!("{number}."),
            1 => format!("{}.", alpha(number)),
            _ => format!("{}.", roman(number)),
        }),
    }
}

fn paragraph_ranges(text: &str) -> Vec<Range<usize>> {
    let mut out = Vec::new();
    let mut start = 0;
    for (i, c) in text.char_indices() {
        if c == '\n' || c == '\u{2029}' {
            out.push(start..i);
            start = i + c.len_utf8();
        }
    }
    out.push(start..text.len());
    out
}

/// Lays out `content`. With `measure_only`, glyph placement, decorations and caret clusters are skipped.
pub(crate) fn layout(
    ctx: &mut LayoutCtx<'_>,
    content: &TextContent,
    opts: &LayoutOptions,
    measure_only: bool,
) -> LaidOutText {
    let mut b = Builder {
        ctx,
        content,
        spans: Vec::new(),
        sel_cache: HashMap::new(),
        fallback_cache: HashMap::new(),
    };
    let text = &content.text;
    let wrap = opts.wrap_width();
    let max_lines = opts.max_lines.unwrap_or(u32::MAX) as usize;

    // 1. Paragraphs, list levels and counters.
    let ranges = paragraph_ranges(text);
    let mut paras: Vec<Para> = Vec::with_capacity(ranges.len());
    let mut counters: [Option<u32>; 16] = [None; 16];
    let mut prev_list = false;
    for (index, src) in ranges.into_iter().enumerate() {
        let format = content.paragraph_format(index).clone();
        let is_list = format.list != ListStyle::None;
        let mut content_start = src.start;
        let mut level = 0u8;
        if is_list {
            let tabs = text[src.clone()]
                .bytes()
                .take_while(|b| *b == b'\t')
                .count();
            level = format
                .list_level
                .unwrap_or_else(|| tabs.min(15) as u8)
                .min(15);
            if format.list_level.is_none() {
                content_start += tabs;
            }
        }
        let lv = usize::from(level);
        let mut marker_text_s = None;
        if is_list {
            if !prev_list {
                counters = [None; 16];
            }
            // A shallower item ends the deeper sub-lists.
            for c in counters.iter_mut().skip(lv + 1) {
                *c = None;
            }
            let n = counters[lv].map_or(format.list_start, |n| n.saturating_add(1));
            counters[lv] = Some(n);
            marker_text_s = marker_text(format.list, level, n);
        }
        prev_list = is_list;
        let style_span = content
            .span_at(content_start.min(text.len().saturating_sub(1)))
            .unwrap_or(usize::MAX);
        paras.push(Para {
            index,
            src: src.clone(),
            content_start,
            display: String::new(),
            d2s: Vec::new(),
            span_ranges: Vec::new(),
            format,
            level,
            rtl: false,
            levels: Vec::new(),
            has_rtl: false,
            items: Vec::new(),
            clusters: Vec::new(),
            glyphs: Vec::new(),
            style_span,
            marker: None,
            marker_text: marker_text_s,
            gutter: 0.0,
        });
    }

    // 2. Per paragraph: display text, bidi, items, clusters, line breaks (until the line budget is used up).
    let mut line_spans: Vec<(usize, LineSpan)> = Vec::new();
    let mut truncated = false;
    let mut last_para = 0usize;
    for pi in 0..paras.len() {
        if line_spans.len() >= max_lines {
            truncated = true;
            break;
        }
        last_para = pi;
        prepare_paragraph(&mut b, &mut paras[pi]);
        let gutter = paras[pi].gutter;
        let first = wrap.map_or(f64::INFINITY, |w| {
            (w - gutter - paras[pi].format.indent).max(0.0)
        });
        let rest = wrap.map_or(f64::INFINITY, |w| (w - gutter).max(0.0));
        let spans = break_lines(&mut b, &paras[pi], first, rest, opts.hyphenate);
        let mut spans = reshape_unsafe_breaks(&mut b, &mut paras[pi], spans);
        let budget = max_lines - line_spans.len();
        let cut = spans.len() > budget;
        if cut {
            spans.truncate(budget);
        }
        let more_after = pi + 1 < paras.len();
        if (cut || (more_after && line_spans.len() + spans.len() >= max_lines)) && !spans.is_empty()
        {
            truncated = true;
            let last = spans.len() - 1;
            let avail = if last == 0 && line_spans.iter().all(|(p, _)| *p != pi) {
                first
            } else {
                rest
            };
            apply_ellipsis(&mut b, &paras[pi], &mut spans[last], avail);
        }
        let n = spans.len();
        for (k, mut s) in spans.into_iter().enumerate() {
            s.ends_paragraph = k + 1 == n && !truncated;
            line_spans.push((pi, s));
        }
        if truncated {
            break;
        }
    }
    if max_lines == 0 {
        truncated = !text.is_empty();
    }
    let para_count = if line_spans.is_empty() {
        0
    } else {
        last_para + 1
    };

    // 3. Line metrics and vertical positions.
    let mut pre: Vec<PreLine> = Vec::with_capacity(line_spans.len());
    let mut y = 0.0;
    let mut prev_para: Option<usize> = None;
    for (pi, span) in line_spans {
        let para = &paras[pi];
        let first_in_para = prev_para != Some(pi);
        if first_in_para && let Some(pp) = prev_para {
            y += paras[pp].format.space_after + para.format.space_before;
        }
        prev_para = Some(pi);
        let (above, below, ascent, descent) = line_metrics(&mut b, para, &span);
        let (width, trailing_ws) = line_width(para, &span);
        pre.push(PreLine {
            para: pi,
            span,
            first_in_para,
            width,
            trailing_ws,
            above,
            below,
            ascent,
            descent,
            top: y,
        });
        y += above + below;
    }
    let content_height = y.max(0.0);

    // 4. Box geometry.
    let content_width = pre
        .iter()
        .map(|l| {
            let p = &paras[l.para];
            let inset = p.gutter
                + if l.first_in_para {
                    p.format.indent
                } else {
                    0.0
                };
            (inset + l.width).max(0.0)
        })
        .fold(0.0f64, f64::max);
    let align_width = wrap.unwrap_or(content_width);
    let box_width = match opts.auto_resize {
        AutoResize::Width => content_width,
        _ => opts
            .width
            .filter(|w| w.is_finite())
            .unwrap_or(content_width)
            .max(0.0),
    };
    let box_height = match opts.auto_resize {
        AutoResize::None => opts
            .height
            .filter(|h| h.is_finite())
            .unwrap_or(content_height)
            .max(0.0),
        _ => content_height,
    };
    let content_top = if opts.auto_resize == AutoResize::None {
        vertical_offset(opts.vertical_align, box_height, content_height)
    } else {
        0.0
    };
    let first_baseline = pre.first().map_or_else(
        || {
            let (a, d, g, size) = b.span_metrics(content.span_at(0).unwrap_or(usize::MAX));
            let lh = line_height_px(&content.paragraph.line_height, a, d, g, size);
            content_top + a + (lh - (a + d)) / 2.0
        },
        |l| content_top + l.top + l.above,
    );

    let mut out = LaidOutText {
        text: text.clone(),
        width: box_width,
        height: box_height,
        content_width,
        content_height,
        content_top,
        first_baseline,
        lines: Vec::with_capacity(pre.len()),
        runs: Vec::new(),
        decorations: Vec::new(),
        clusters: Vec::new(),
        paragraphs: Vec::new(),
        spans: content.spans.iter().map(|s| s.style.clone()).collect(),
        truncated,
        overflows: opts.auto_resize == AutoResize::None && content_height > box_height + EPS,
    };
    if out.spans.is_empty() {
        out.spans.push(content.default_style.clone());
    }

    // 5. Placement.
    for (li, l) in pre.iter().enumerate() {
        let para = &paras[l.para];
        let line = place_line(
            &b,
            para,
            l,
            li,
            align_width,
            content_top,
            measure_only,
            &mut out,
        );
        out.lines.push(line);
    }
    for (pi, para) in paras.iter().enumerate().take(para_count) {
        let first = out.lines.iter().position(|l| l.paragraph == pi);
        let last = out.lines.iter().rposition(|l| l.paragraph == pi);
        let lines = match (first, last) {
            (Some(a), Some(z)) => a..z + 1,
            _ => out.lines.len()..out.lines.len(),
        };
        out.paragraphs.push(ParagraphInfo {
            range: para.src.clone(),
            lines,
            rtl: para.rtl,
            list_level: para.level,
            marker: para.marker_text.clone(),
        });
    }
    if !measure_only {
        merge_decorations(&mut out.decorations);
    }
    out
}

fn prepare_paragraph(b: &mut Builder<'_, '_>, para: &mut Para) {
    let content = b.content;
    let text = &content.text;
    // Display text with case transforms, tabs expanded and carriage returns dropped.
    let mut display = String::with_capacity(para.src.end - para.content_start);
    let mut d2s = Vec::with_capacity(display.capacity() + 1);
    let mut span_ranges: Vec<(Range<usize>, usize)> = Vec::new();
    let mut word_start = true;
    let mut pos = para.content_start;
    while pos < para.src.end {
        let span = content.span_at(pos).unwrap_or(usize::MAX);
        let span_end = content
            .spans
            .get(span)
            .map_or(para.src.end, |s| s.range.end.max(pos + 1))
            .min(para.src.end);
        let span_end = ceil_char_boundary(text, span_end);
        let case = content.style_at(pos).case;
        let d_start = display.len();
        let mut seg_start = pos;
        for (off, c) in text[pos..span_end].char_indices() {
            let i = pos + off;
            if c == '\t' || c == '\r' {
                if seg_start < i {
                    transform_case(
                        &text[seg_start..i],
                        case,
                        &mut word_start,
                        seg_start,
                        &mut display,
                        &mut d2s,
                    );
                }
                if c == '\t' {
                    for _ in 0..4 {
                        display.push(' ');
                        d2s.push(i);
                    }
                    word_start = true;
                }
                seg_start = i + c.len_utf8();
            }
        }
        if seg_start < span_end {
            transform_case(
                &text[seg_start..span_end],
                case,
                &mut word_start,
                seg_start,
                &mut display,
                &mut d2s,
            );
        }
        if display.len() > d_start {
            match span_ranges.last_mut() {
                Some((r, s)) if *s == span && r.end == d_start => r.end = display.len(),
                _ => span_ranges.push((d_start..display.len(), span)),
            }
        }
        pos = span_end;
    }
    d2s.push(para.src.end);
    para.display = display;
    para.d2s = d2s;
    para.span_ranges = span_ranges;

    // Bidi.
    let base = match para.format.direction {
        TextDirection::Ltr => Some(Level::ltr()),
        TextDirection::Rtl => Some(Level::rtl()),
        TextDirection::Auto => None,
    };
    if para.display.is_empty() {
        para.rtl = para.format.direction == TextDirection::Rtl;
        para.levels = Vec::new();
    } else {
        let info = ParagraphBidiInfo::new(&para.display, base);
        para.rtl = info.paragraph_level.is_rtl();
        para.has_rtl = info.levels.iter().any(|l| l.is_rtl());
        para.levels = info.levels;
    }

    // List gutter and marker.
    let em = b.style(para.style_span).size.max(0.0);
    if para.format.list != ListStyle::None {
        para.gutter = em * LIST_INDENT_EM * f64::from(para.level + 1);
        if let Some(t) = para.marker_text.clone() {
            para.marker = Some(b.synthetic(&t, para.style_span, para.rtl, RunKind::ListMarker));
        }
    }

    // Items: span x bidi level x script x font.
    struct Seg {
        range: Range<usize>,
        span: usize,
        level: u8,
        script: Script,
        face: Option<FaceMatch>,
        emoji: bool,
    }
    let mut segs: Vec<Seg> = Vec::new();
    let display = std::mem::take(&mut para.display);
    let mut prev_script = display
        .chars()
        .map(char_script)
        .find(|s| !matches!(s, Script::Common | Script::Inherited | Script::Unknown))
        .unwrap_or(Script::Latin);
    for (start, g) in display.grapheme_indices(true) {
        let span = para.span_at(start);
        let level = para.levels.get(start).map_or(0, |l| l.number());
        let raw = g
            .chars()
            .map(char_script)
            .find(|s| !matches!(s, Script::Common | Script::Inherited | Script::Unknown))
            .unwrap_or(Script::Common);
        let script = if raw == Script::Common {
            prev_script
        } else {
            raw
        };
        prev_script = script;
        let emoji = is_emoji_cluster(g);
        let end = start + g.len();
        if let Some(cur) = segs.last_mut()
            && cur.span == span
            && cur.level == level
            && cur.emoji == emoji
            && (cur.script == script || raw == Script::Common)
            && cur.range.end == start
            && match cur.face {
                Some(f) => b.ctx.db.covers_cluster(f.face, g) || g.chars().all(is_ignorable),
                None => b.ctx.db.is_empty(),
            }
        {
            cur.range.end = end;
            continue;
        }
        let face = b.choose_face(span, g, raw, emoji);
        if let Some(cur) = segs.last_mut()
            && cur.span == span
            && cur.level == level
            && cur.script == script
            && cur.range.end == start
            && cur.face.map(|f| f.face) == face.map(|f| f.face)
        {
            cur.range.end = end;
            cur.emoji |= emoji;
            continue;
        }
        segs.push(Seg {
            range: start..end,
            span,
            level,
            script,
            face,
            emoji,
        });
    }
    para.display = display;

    let items: Vec<Item> = segs
        .into_iter()
        .map(|seg| {
            b.make_item(
                seg.range,
                seg.span,
                seg.level % 2 == 1,
                seg.script,
                seg.face,
            )
        })
        .collect();
    shape_items(b, para, items);
}

/// Shapes items into clusters and marks UAX #14 break opportunities after clusters.
fn shape_items(b: &mut Builder<'_, '_>, para: &mut Para, items: Vec<Item>) {
    let mut clusters = Vec::new();
    let mut glyphs = Vec::new();
    for (idx, item) in items.iter().enumerate() {
        let mut cl = b.build_clusters(&para.display, idx, item, item.range.clone(), &mut glyphs);
        clusters.append(&mut cl);
    }
    if !clusters.is_empty() {
        let mut ci = 0usize;
        for (idx, opp) in linebreaks(&para.display) {
            if idx >= para.display.len() {
                break;
            }
            while ci < clusters.len() && clusters[ci].range.end < idx {
                ci += 1;
            }
            if ci < clusters.len() && clusters[ci].range.end == idx {
                clusters[ci].brk = match opp {
                    BreakOpportunity::Mandatory => Brk::Mandatory,
                    BreakOpportunity::Allowed => Brk::Allowed,
                };
            }
        }
    }
    para.items = items;
    para.clusters = clusters;
    para.glyphs = glyphs;
}

/// Reshapes items that a line break splits at a position unsafe to break (Arabic joining, kerning, ligatures
/// across the break) and maps the line spans onto the new clusters.
fn reshape_unsafe_breaks(
    b: &mut Builder<'_, '_>,
    para: &mut Para,
    lines: Vec<LineSpan>,
) -> Vec<LineSpan> {
    let cuts: Vec<usize> = lines
        .iter()
        .skip(1)
        .filter(|l| {
            l.start > 0
                && l.start < para.clusters.len()
                && para.clusters[l.start].unsafe_before
                && para.clusters[l.start].item == para.clusters[l.start - 1].item
        })
        .map(|l| para.clusters[l.start].range.start)
        .collect();
    if cuts.is_empty() {
        return lines;
    }
    let bounds: Vec<(usize, usize)> = lines
        .iter()
        .map(|l| {
            let start = para
                .clusters
                .get(l.start)
                .map_or(para.display.len(), |c| c.range.start);
            let end = if l.end > l.start {
                para.clusters[l.end - 1].range.end
            } else {
                start
            };
            (start, end)
        })
        .collect();
    let mut items: Vec<Item> = Vec::with_capacity(para.items.len() + cuts.len());
    for item in &para.items {
        let mut start = item.range.start;
        for &c in cuts
            .iter()
            .filter(|&&c| c > item.range.start && c < item.range.end)
        {
            let mut piece = item.clone();
            piece.range = start..c;
            items.push(piece);
            start = c;
        }
        let mut piece = item.clone();
        piece.range = start..item.range.end;
        items.push(piece);
    }
    shape_items(b, para, items);
    let find_start = |d: usize| {
        para.clusters
            .iter()
            .position(|c| c.range.start >= d)
            .unwrap_or(para.clusters.len())
    };
    lines
        .into_iter()
        .zip(bounds)
        .map(|(mut l, (ds, de))| {
            l.start = find_start(ds);
            l.end = if de > ds { find_start(de) } else { l.start };
            l
        })
        .collect()
}

fn width_of(para: &Para, range: Range<usize>) -> f64 {
    para.clusters[range].iter().map(|c| c.advance).sum()
}

fn break_lines(
    b: &mut Builder<'_, '_>,
    para: &Para,
    first: f64,
    rest: f64,
    hyphenate: bool,
) -> Vec<LineSpan> {
    let n = para.clusters.len();
    let mut lines: Vec<LineSpan> = Vec::new();
    let new = |start, end, forced| LineSpan {
        start,
        end,
        forced,
        hyphen: None,
        ellipsis: None,
        ends_paragraph: false,
    };
    if n == 0 {
        lines.push(new(0, 0, false));
        return lines;
    }
    // Width of the hyphen drawn at a soft-hyphen break, per span.
    let mut hyphen_widths: HashMap<usize, f64> = HashMap::new();
    let mut start = 0;
    while start < n {
        let avail = if lines.is_empty() { first } else { rest };
        let mut x = 0.0;
        let mut last_break: Option<usize> = None;
        let mut k = start;
        let mut forced = false;
        while k < n {
            let c = &para.clusters[k];
            let nx = x + c.advance;
            if !c.whitespace && nx > avail + EPS && k > start {
                break;
            }
            x = nx;
            k += 1;
            match c.brk {
                Brk::Mandatory => {
                    forced = true;
                    break;
                }
                // A soft hyphen is a break opportunity only where the visible hyphen still fits.
                Brk::Allowed if c.shy => {
                    let span = para.items[c.item].span;
                    let hw = *hyphen_widths
                        .entry(span)
                        .or_insert_with(|| b.hyphen(span, para.rtl).width);
                    if x + hw <= avail + EPS {
                        last_break = Some(k);
                    }
                }
                Brk::Allowed => last_break = Some(k),
                Brk::None => {}
            }
        }
        if forced || k >= n {
            lines.push(new(start, k, forced));
            start = k;
            continue;
        }
        // Cluster k overflows the line.
        if hyphenate && let Some(h) = b.ctx.hyphenator {
            let ws = last_break.unwrap_or(start);
            let mut we = k;
            while we < n && para.clusters[we].brk == Brk::None {
                we += 1;
            }
            let we = (we + 1).min(n);
            let space = avail - width_of(para, start..ws);
            if let Some((cut, hy)) = try_hyphenate(b, h, para, ws, we, space) {
                let mut line = new(start, cut, false);
                line.hyphen = Some(hy);
                lines.push(line);
                start = cut;
                continue;
            }
        }
        match last_break {
            Some(bk) if bk > start => {
                let mut line = new(start, bk, false);
                if para.clusters[bk - 1].shy {
                    let span = para.items[para.clusters[bk - 1].item].span;
                    line.hyphen = Some(b.hyphen(span, para.rtl));
                }
                lines.push(line);
                start = bk;
            }
            _ => {
                // No break opportunity fits: break inside the word (at least one cluster per line).
                let end = k.max(start + 1);
                lines.push(new(start, end, false));
                start = end;
            }
        }
    }
    lines
}

fn try_hyphenate(
    b: &mut Builder<'_, '_>,
    h: &dyn Hyphenator,
    para: &Para,
    ws: usize,
    we: usize,
    space: f64,
) -> Option<(usize, Synthetic)> {
    // The word without trailing whitespace.
    let mut end = we;
    while end > ws && para.clusters[end - 1].whitespace {
        end -= 1;
    }
    if end <= ws + 1 {
        return None;
    }
    let d0 = para.clusters[ws].range.start;
    let d1 = para.clusters[end - 1].range.end;
    let word = &para.display[d0..d1];
    let span = para.items[para.clusters[ws].item].span;
    let lang = b.style(span).language.clone();
    let mut points = h.hyphenate(word, lang.as_deref());
    points.sort_unstable();
    points.dedup();
    let hy = b.hyphen(span, para.rtl);
    for p in points.into_iter().rev() {
        let abs = d0 + p;
        let Some(q) = (ws + 1..end).find(|&q| para.clusters[q].range.start == abs) else {
            continue;
        };
        if width_of(para, ws..q) + hy.width <= space + EPS {
            return Some((q, hy));
        }
    }
    None
}

fn apply_ellipsis(b: &mut Builder<'_, '_>, para: &Para, line: &mut LineSpan, avail: f64) {
    line.hyphen = None;
    let span = if line.end > line.start {
        para.items[para.clusters[line.end - 1].item].span
    } else {
        para.style_span
    };
    let ell = b.ellipsis(span, para.rtl);
    let mut end = line.end;
    loop {
        while end > line.start && para.clusters[end - 1].whitespace {
            end -= 1;
        }
        if end == line.start || width_of(para, line.start..end) + ell.width <= avail + EPS {
            break;
        }
        end -= 1;
    }
    line.end = end;
    line.forced = false;
    line.ellipsis = Some(ell);
}

fn line_height_px(spec: &LineHeightSpec, a: f64, d: f64, g: f64, size: f64) -> f64 {
    match spec {
        LineHeightSpec::Auto => a + d + g,
        LineHeightSpec::Px(v) => *v,
        LineHeightSpec::Percent(p) => size * p / 100.0,
    }
}

fn line_metrics(b: &mut Builder<'_, '_>, para: &Para, span: &LineSpan) -> (f64, f64, f64, f64) {
    struct Acc {
        spec: LineHeightSpec,
        above: f64,
        below: f64,
        ascent: f64,
        descent: f64,
    }
    impl Acc {
        fn add(&mut self, a: f64, d: f64, g: f64, size: f64, shift: f64) {
            let lh = line_height_px(&self.spec, a, d, g, size);
            let half = (lh - (a + d)) / 2.0;
            self.above = self.above.max(a + half + shift);
            self.below = self.below.max(d + half - shift);
            self.ascent = self.ascent.max(a + shift);
            self.descent = self.descent.max(d - shift);
        }
    }
    let mut acc = Acc {
        spec: para.format.line_height,
        above: f64::NEG_INFINITY,
        below: f64::NEG_INFINITY,
        ascent: 0.0,
        descent: 0.0,
    };
    let mut seen: Vec<usize> = Vec::new();
    for c in &para.clusters[span.start..span.end] {
        if seen.contains(&c.item) {
            continue;
        }
        seen.push(c.item);
        let item = &para.items[c.item];
        let (a, d, g) = b.item_metrics(item);
        let shift = b.style(item.span).baseline_shift;
        acc.add(a, d, g, item.size, shift);
    }
    for syn in [&span.ellipsis, &span.hyphen].into_iter().flatten() {
        let (a, d, g) = b.item_metrics(&syn.item);
        let shift = b.style(syn.item.span).baseline_shift;
        acc.add(a, d, g, syn.item.size, shift);
    }
    if acc.above == f64::NEG_INFINITY {
        let (a, d, g, size) = b.span_metrics(para.style_span);
        acc.add(a, d, g, size, 0.0);
    }
    (acc.above, acc.below, acc.ascent, acc.descent)
}

/// Visible width (without trailing whitespace, with the synthetic ellipsis / hyphen) and trailing whitespace.
fn line_width(para: &Para, span: &LineSpan) -> (f64, f64) {
    let mut end = span.end;
    let mut trailing = 0.0;
    while end > span.start && para.clusters[end - 1].whitespace {
        end -= 1;
        trailing += para.clusters[end].advance;
    }
    let mut w = width_of(para, span.start..end);
    for syn in [&span.ellipsis, &span.hyphen].into_iter().flatten() {
        w += syn.width;
    }
    (w, trailing)
}

/// Visual order of the line's clusters (indices into `para.clusters`): UAX #9 rules L1 (trailing whitespace takes
/// the paragraph level) and L2 (reverse runs from the highest level down to the lowest odd level) at cluster
/// granularity.
fn visual_order(para: &Para, span: &LineSpan) -> Vec<usize> {
    let (start, end) = (span.start, span.end);
    if start >= end {
        return Vec::new();
    }
    if !para.has_rtl {
        return (start..end).collect();
    }
    let base = u8::from(para.rtl);
    let mut levels: Vec<u8> = para.clusters[start..end]
        .iter()
        .map(|c| para.levels.get(c.range.start).map_or(base, |l| l.number()))
        .collect();
    for (i, c) in para.clusters[start..end].iter().enumerate().rev() {
        if !c.whitespace {
            break;
        }
        levels[i] = base;
    }
    let max = levels.iter().copied().max().unwrap_or(0);
    let Some(min_odd) = levels.iter().copied().filter(|l| l % 2 == 1).min() else {
        return (start..end).collect();
    };
    let mut order: Vec<usize> = (start..end).collect();
    let n = order.len();
    for lvl in (min_odd..=max).rev() {
        let mut i = 0;
        while i < n {
            if levels[i] >= lvl {
                let mut j = i;
                while j < n && levels[j] >= lvl {
                    j += 1;
                }
                order[i..j].reverse();
                levels[i..j].reverse();
                i = j;
            } else {
                i += 1;
            }
        }
    }
    order
}

#[allow(clippy::too_many_arguments)]
fn place_line(
    b: &Builder<'_, '_>,
    para: &Para,
    l: &PreLine,
    li: usize,
    align_width: f64,
    content_top: f64,
    measure_only: bool,
    out: &mut LaidOutText,
) -> Line {
    let span = &l.span;
    let top = content_top + l.top;
    let baseline = top + l.above;
    let inset = para.gutter
        + if l.first_in_para {
            para.format.indent
        } else {
            0.0
        };
    let avail = (align_width - inset).max(0.0);
    let last_visible = {
        let mut e = span.end;
        while e > span.start && para.clusters[e - 1].whitespace {
            e -= 1;
        }
        e
    };
    // Justification.
    let justify = para.format.align == TextAlign::Justify
        && !span.ends_paragraph
        && !span.forced
        && span.ellipsis.is_none()
        && avail > l.width + EPS
        && avail.is_finite();
    let (mut per_space, mut per_char) = (0.0, 0.0);
    if justify {
        let extra = avail - l.width;
        let spaces = (span.start..last_visible)
            .filter(|&i| para.clusters[i].space)
            .count();
        if spaces > 0 {
            per_space = extra / spaces as f64;
        } else {
            let inter = (span.start..last_visible)
                .filter(|&i| para.clusters[i].inter_char)
                .count();
            if inter > 1 && last_visible > span.start + 1 {
                per_char = extra / (last_visible - span.start - 1) as f64;
            }
        }
    }
    let used = if justify && (per_space > 0.0 || per_char > 0.0) {
        avail
    } else {
        l.width
    };
    let offset = match para.format.align {
        TextAlign::Left => 0.0,
        TextAlign::Right => avail - used,
        TextAlign::Center => (avail - used) / 2.0,
        TextAlign::Justify => {
            if para.rtl {
                avail - used
            } else {
                0.0
            }
        }
    };
    let area_left = if para.rtl { 0.0 } else { inset };
    let visible_left = area_left + offset;
    let run_start = out.runs.len();
    let cluster_start = out.clusters.len();
    let src_range = if span.start < span.end {
        para.src(para.clusters[span.start].range.start)
            ..para.src(para.clusters[span.end - 1].range.end)
    } else {
        para.content_start..para.src.end
    };
    let line = Line {
        range: src_range,
        paragraph: para.index,
        top,
        height: l.above + l.below,
        baseline,
        ascent: l.ascent,
        descent: l.descent,
        x: visible_left,
        width: used,
        rtl: para.rtl,
        runs: run_start..run_start,
        clusters: cluster_start..cluster_start,
        ends_paragraph: span.ends_paragraph,
        ellipsis: span.ellipsis.is_some(),
        hyphenated: span.hyphen.is_some(),
    };
    if measure_only {
        return line;
    }

    // List marker on the first line, in the gutter on the start side.
    if l.first_in_para
        && let Some(m) = &para.marker
    {
        let em = b.style(para.style_span).size.max(0.0);
        let gutter_end = para.gutter - LIST_MARKER_GAP_EM * em;
        let x = if para.rtl {
            align_width - gutter_end
        } else {
            gutter_end - m.width
        };
        emit_synthetic(
            b,
            m,
            x,
            baseline,
            li,
            para.content_start,
            (top, l.above + l.below),
            out,
        );
    }

    enum Piece<'p> {
        Cluster(usize),
        Synth(&'p Synthetic),
    }
    let mut pieces: Vec<Piece<'_>> = visual_order(para, span)
        .into_iter()
        .map(Piece::Cluster)
        .collect();
    for syn in [&span.hyphen, &span.ellipsis].into_iter().flatten() {
        if para.rtl {
            pieces.insert(0, Piece::Synth(syn));
        } else {
            pieces.push(Piece::Synth(syn));
        }
    }
    let mut x = visible_left - if para.rtl { l.trailing_ws } else { 0.0 };
    let mut current: Option<(usize, GlyphRun)> = None;
    let line_box = (top, l.above + l.below);
    for piece in pieces {
        match piece {
            Piece::Synth(syn) => {
                flush(b, &mut current, out, li, line_box);
                let end = line.range.end;
                x += emit_synthetic(b, syn, x, baseline, li, end, line_box, out);
            }
            Piece::Cluster(ci) => {
                let c = &para.clusters[ci];
                let item = &para.items[c.item];
                let trailing = ci >= last_visible;
                let extra = if trailing {
                    0.0
                } else if c.space {
                    per_space
                } else if per_char > 0.0 && ci + 1 < last_visible {
                    per_char
                } else {
                    0.0
                };
                let width = c.advance + extra;
                // Caret boxes per grapheme.
                push_cluster_boxes(para, c, item.rtl, x, width, li, out);
                // Hanging whitespace at the line end has no ink; keeping it out of the runs keeps underlines and
                // highlights from sticking out past the visible text (or past the box edge when right aligned).
                if let Some(font) = item.font.filter(|_| !trailing) {
                    let shift = b.style(item.span).baseline_shift;
                    let run_base = baseline - shift;
                    let src = para.src(c.range.start);
                    if current.as_ref().is_none_or(|(it, _)| *it != c.item) {
                        flush(b, &mut current, out, li, line_box);
                        let mut run = new_run(b, item, font, li, run_base, x, RunKind::Text);
                        run.range = src..src;
                        current = Some((c.item, run));
                    }
                    let (_, run) = current.as_mut().expect("set above");
                    let mut pen = x + if item.rtl { c.letter_spacing } else { 0.0 };
                    for g in &para.glyphs[c.glyphs.clone()] {
                        run.glyphs.push(Glyph {
                            id: g.id,
                            x: pen + g.dx,
                            y: run_base - g.dy,
                            advance: g.advance,
                            cluster: src,
                        });
                        pen += g.advance;
                    }
                    run.width = x + width - run.x;
                    run.range.start = run.range.start.min(src);
                    run.range.end = run.range.end.max(para.src(c.range.end));
                } else {
                    flush(b, &mut current, out, li, line_box);
                }
                x += width;
            }
        }
    }
    flush(b, &mut current, out, li, line_box);
    merge_empty_boxes(&mut out.clusters, cluster_start);
    Line {
        runs: run_start..out.runs.len(),
        clusters: cluster_start..out.clusters.len(),
        ..line
    }
}

fn new_run(
    b: &Builder<'_, '_>,
    item: &Item,
    font: FontSel,
    line: usize,
    baseline: f64,
    x: f64,
    kind: RunKind,
) -> GlyphRun {
    let style = b.style(item.span);
    GlyphRun {
        kind,
        face: font.face,
        instance: font.instance,
        variations: b.ctx.db.inst(font.instance).variations().to_vec(),
        size: item.size,
        span: if item.span < b.content.spans.len() {
            item.span
        } else {
            0
        },
        line,
        rtl: item.rtl,
        range: 0..0,
        baseline,
        x,
        width: 0.0,
        color: style.color,
        synthetic_bold: if font.synthetic_bold {
            item.size / 36.0
        } else {
            0.0
        },
        skew: if font.synthetic_italic {
            SYNTHETIC_SKEW
        } else {
            0.0
        },
        glyphs: Vec::new(),
    }
}

fn flush(
    b: &Builder<'_, '_>,
    current: &mut Option<(usize, GlyphRun)>,
    out: &mut LaidOutText,
    line: usize,
    line_box: (f64, f64),
) {
    if let Some((_, run)) = current.take()
        && !run.glyphs.is_empty()
    {
        push_decorations(b, out, &run, line, line_box);
        out.runs.push(run);
    }
}

/// Emits a synthetic run at `x`; returns its width.
#[allow(clippy::too_many_arguments)]
fn emit_synthetic(
    b: &Builder<'_, '_>,
    syn: &Synthetic,
    x: f64,
    baseline: f64,
    line: usize,
    src: usize,
    line_box: (f64, f64),
    out: &mut LaidOutText,
) -> f64 {
    let Some(font) = syn.item.font else {
        return syn.width;
    };
    let shift = b.style(syn.item.span).baseline_shift;
    let run_base = baseline - shift;
    let mut run = new_run(b, &syn.item, font, line, run_base, x, syn.kind);
    for (g, pen) in &syn.glyphs {
        run.glyphs.push(Glyph {
            id: g.id,
            x: x + pen + g.dx,
            y: run_base - g.dy,
            advance: g.advance,
            cluster: src,
        });
    }
    run.width = syn.width;
    run.range = src..src;
    push_decorations(b, out, &run, line, line_box);
    out.runs.push(run);
    syn.width
}

fn push_cluster_boxes(
    para: &Para,
    c: &Cluster,
    rtl: bool,
    x: f64,
    width: f64,
    line: usize,
    out: &mut LaidOutText,
) {
    // Strong negative tracking can make an advance negative; caret boxes stay ordered (x0 <= x1).
    let (x, width) = if width < 0.0 {
        (x + width, -width)
    } else {
        (x, width)
    };
    let text = &para.display[c.range.clone()];
    if text.chars().nth(1).is_none() {
        // Empty source ranges (expanded tabs, case expansions) are merged by `merge_empty_boxes`.
        out.clusters.push(ClusterBox {
            range: para.src(c.range.start)..para.src(c.range.end),
            line,
            x0: x,
            x1: x + width,
            rtl,
        });
        return;
    }
    let bounds: Vec<(usize, usize)> = text
        .grapheme_indices(true)
        .map(|(i, g)| (c.range.start + i, c.range.start + i + g.len()))
        .collect();
    // Merge graphemes that map to the same source position (case expansion, expanded tabs).
    let mut parts: Vec<Range<usize>> = Vec::with_capacity(bounds.len());
    for (s, e) in bounds {
        let (ss, se) = (para.src(s), para.src(e));
        match parts.last_mut() {
            Some(last) if ss < last.end || ss == last.start => last.end = last.end.max(se),
            _ => parts.push(ss..se),
        }
    }
    if parts.is_empty() {
        return;
    }
    let n = parts.len() as f64;
    let w = width / n;
    for (k, r) in parts.into_iter().enumerate() {
        let k = k as f64;
        let x0 = if rtl {
            x + width - (k + 1.0) * w
        } else {
            x + k * w
        };
        out.clusters.push(ClusterBox {
            range: r,
            line,
            x0,
            x1: x0 + w,
            rtl,
        });
    }
}

/// Folds caret boxes that map to no source text (one source character drawn as several clusters) into the box
/// of the same source position next to them.
fn merge_empty_boxes(boxes: &mut Vec<ClusterBox>, from: usize) {
    let owner = |boxes: &[ClusterBox], i: usize, step: isize| -> Option<usize> {
        let pos = boxes[i].range.start;
        let mut k = i as isize + step;
        while k >= from as isize && (k as usize) < boxes.len() {
            let r = &boxes[k as usize].range;
            if r.start == r.end && r.start == pos {
                k += step;
                continue;
            }
            return (r.start == pos && r.start < r.end).then_some(k as usize);
        }
        None
    };
    let mut i = from;
    while i < boxes.len() {
        if boxes[i].range.start < boxes[i].range.end {
            i += 1;
            continue;
        }
        if let Some(j) = owner(boxes, i, 1).or_else(|| owner(boxes, i, -1)) {
            let (x0, x1) = (boxes[i].x0, boxes[i].x1);
            boxes[j].x0 = boxes[j].x0.min(x0);
            boxes[j].x1 = boxes[j].x1.max(x1);
        }
        boxes.remove(i);
    }
}

fn push_decorations(
    b: &Builder<'_, '_>,
    out: &mut LaidOutText,
    run: &GlyphRun,
    line: usize,
    (line_top, line_height): (f64, f64),
) {
    let Some(style) = out.spans.get(run.span) else {
        return;
    };
    let (underline, strike, highlight, color) = (
        style.underline,
        style.strikethrough,
        style.highlight,
        style.color,
    );
    if run.kind == RunKind::ListMarker || run.width <= 0.0 {
        return;
    }
    let m = *b.ctx.db.inst(run.instance).metrics();
    let s = run.size / m.units_per_em;
    if let Some(h) = highlight {
        out.decorations.push(Decoration {
            kind: DecorationKind::Highlight,
            rect: Rect {
                x: run.x,
                y: line_top,
                w: run.width,
                h: line_height,
            },
            span: run.span,
            line,
            color: Some(h),
        });
    }
    if underline {
        out.decorations.push(Decoration {
            kind: DecorationKind::Underline,
            rect: Rect {
                x: run.x,
                y: run.baseline - m.underline_position * s,
                w: run.width,
                h: (m.underline_thickness * s).max(0.0),
            },
            span: run.span,
            line,
            color,
        });
    }
    if strike {
        out.decorations.push(Decoration {
            kind: DecorationKind::Strikethrough,
            rect: Rect {
                x: run.x,
                y: run.baseline - m.strikeout_position * s,
                w: run.width,
                h: (m.strikeout_thickness * s).max(0.0),
            },
            span: run.span,
            line,
            color,
        });
    }
}

fn merge_decorations(decos: &mut Vec<Decoration>) {
    let mut out: Vec<Decoration> = Vec::with_capacity(decos.len());
    for d in decos.drain(..) {
        if let Some(last) = out.last_mut()
            && last.kind == d.kind
            && last.line == d.line
            && last.color == d.color
            && (last.rect.y - d.rect.y).abs() < 1e-6
            && (last.rect.h - d.rect.h).abs() < 1e-6
            && (last.rect.x + last.rect.w - d.rect.x).abs() < 1e-6
        {
            last.rect.w = d.rect.x + d.rect.w - last.rect.x;
            continue;
        }
        out.push(d);
    }
    *decos = out;
}
