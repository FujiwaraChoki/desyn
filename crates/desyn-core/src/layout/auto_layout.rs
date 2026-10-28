//! Auto-layout engine: row / column (with wrap, reverse, space-between, baseline) and grid.

use rustc_hash::FxHashMap;
use serde::{Deserialize, Serialize};

use super::changes::{ChangeLog, Geo, geo_of};
use super::measure::{TextMeasurer, TextMetrics, measure_text_node, vertical_offset};
use crate::geometry::rotated_size;
use crate::model::{
    AutoLayout, AutoResize, CrossAlign, Design, LayoutMode, MainAlign, Node, Sizing, SizingMode,
};

/// Planned geometry of one child (relative to the container's top-left, padding included).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LayoutItem {
    /// Child id.
    pub id: String,
    /// X.
    pub x: f64,
    /// Y.
    pub y: f64,
    /// Width.
    pub width: f64,
    /// Height.
    pub height: f64,
}

/// Result of planning an auto-layout container.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct LayoutPlan {
    /// Content width (without padding).
    pub content_width: f64,
    /// Content height (without padding).
    pub content_height: f64,
    /// Child placements (visible children only, in children order).
    pub items: Vec<LayoutItem>,
}

/// Plans the auto-layout of container `id` for the given inner (padding-excluded) size; `None` means the axis hugs
/// its content. Returns `None` when the node has no auto-layout.
pub fn plan_auto_layout(
    d: &Design,
    m: &mut dyn TextMeasurer,
    id: &str,
    inner_w: Option<f64>,
    inner_h: Option<f64>,
) -> Option<LayoutPlan> {
    let mut ctx = Ctx::new(m);
    ctx.plan(d, id, inner_w, inner_h)
}

/// Nesting depth up to which layout descends (auto-layout planning, arranging, constraint cascades). Deeper
/// containers keep their stored geometry. Real designs nest a few dozen levels; the bound keeps the recursion within
/// the small stacks of wasm hosts for hostile documents.
pub const MAX_LAYOUT_DEPTH: usize = 128;

pub(crate) struct Ctx<'m> {
    pub m: &'m mut dyn TextMeasurer,
    /// Current recursion depth of plan / arrange / constraint cascades (see [`MAX_LAYOUT_DEPTH`]).
    pub(crate) depth: usize,
    text_cache: FxHashMap<(String, u64), TextMetrics>,
    /// Plans and measurements of the current design state, keyed by node and size overrides. Planning reads the
    /// design only, so within one pass every (node, overrides) pair is computed once; without this, nested fill /
    /// hug containers re-plan their subtrees at every level (exponential in the nesting depth). Cleared by
    /// [`Ctx::invalidate`] whenever geometry is written.
    plan_memo: FxHashMap<MemoKey, Option<LayoutPlan>>,
    measure_memo: FxHashMap<MemoKey, (f64, f64)>,
}

type MemoKey = (String, u64, u64);

fn memo_key(id: &str, a: Option<f64>, b: Option<f64>) -> MemoKey {
    let bits = |v: Option<f64>| v.map(f64::to_bits).unwrap_or(u64::MAX);
    (id.to_string(), bits(a), bits(b))
}

/// Effective sizing of a node inside an auto-layout parent. Text derives hug axes from `autoResize` unless an explicit
/// `fill` is set.
fn modes(n: &Node) -> Sizing {
    let explicit = n.base().sizing.clone();
    if let Node::Text(t) = n {
        let (h, v) = match t.auto_resize {
            AutoResize::Width => (SizingMode::Hug, SizingMode::Hug),
            AutoResize::Height => (SizingMode::Fixed, SizingMode::Hug),
            AutoResize::None => (SizingMode::Fixed, SizingMode::Fixed),
        };
        let e = explicit.unwrap_or(Sizing {
            h,
            v,
            extra: Default::default(),
        });
        return Sizing {
            h: if e.h == SizingMode::Fill {
                SizingMode::Fill
            } else {
                h
            },
            v: if e.v == SizingMode::Fill {
                SizingMode::Fill
            } else {
                v
            },
            extra: Default::default(),
        };
    }
    let s = n.base().sizing_or_fixed();
    if n.layout().is_some() {
        s
    } else {
        // Only auto-layout containers (and text) can hug; everything else is fixed unless it fills.
        let fix = |m: SizingMode| {
            if m == SizingMode::Hug {
                SizingMode::Fixed
            } else {
                m
            }
        };
        Sizing {
            h: fix(s.h),
            v: fix(s.v),
            extra: Default::default(),
        }
    }
}

struct Item {
    id: String,
    rotated: bool,
    rotation: f64,
    main_mode: SizingMode,
    cross_mode: SizingMode,
    /// Node size (unrotated).
    w: f64,
    h: f64,
}

impl Item {
    /// Occupied (rotated bounding box) size.
    fn outer(&self) -> (f64, f64) {
        rotated_size(self.w, self.h, self.rotation)
    }
}

impl<'m> Ctx<'m> {
    pub fn new(m: &'m mut dyn TextMeasurer) -> Self {
        Ctx {
            m,
            depth: 0,
            text_cache: FxHashMap::default(),
            plan_memo: FxHashMap::default(),
            measure_memo: FxHashMap::default(),
        }
    }

    /// Forgets memoized plans / measurements (call after writing geometry). Text metrics stay valid: they depend
    /// on the text and the width only, which layout never changes.
    pub fn invalidate(&mut self) {
        self.plan_memo.clear();
        self.measure_memo.clear();
    }

    fn text_metrics(&mut self, d: &Design, id: &str, width: Option<f64>) -> TextMetrics {
        let key = (id.to_string(), width.map(f64::to_bits).unwrap_or(u64::MAX));
        if let Some(r) = self.text_cache.get(&key) {
            return *r;
        }
        let r = match d.node(id) {
            Some(Node::Text(t)) => measure_text_node(self.m, t, width),
            _ => TextMetrics::default(),
        };
        self.text_cache.insert(key, r);
        r
    }

    /// Size of a node given optional fixed width / height decided by its parent.
    pub fn measure(
        &mut self,
        d: &Design,
        id: &str,
        w_ovr: Option<f64>,
        h_ovr: Option<f64>,
    ) -> (f64, f64) {
        let key = memo_key(id, w_ovr, h_ovr);
        if let Some(r) = self.measure_memo.get(&key) {
            return *r;
        }
        let r = self.measure_uncached(d, id, w_ovr, h_ovr);
        self.measure_memo.insert(key, r);
        r
    }

    fn measure_uncached(
        &mut self,
        d: &Design,
        id: &str,
        w_ovr: Option<f64>,
        h_ovr: Option<f64>,
    ) -> (f64, f64) {
        let Some(n) = d.node(id) else {
            return (0.0, 0.0);
        };
        let b = n.base();
        let (w0, h0) = (b.width, b.height);
        if b.rotation != 0.0 {
            return (w0, h0);
        }
        match n {
            Node::Text(t) => {
                let auto = t.auto_resize;
                if let Some(w) = w_ovr {
                    let h = match auto {
                        AutoResize::None => h0,
                        _ => self.text_metrics(d, id, Some(w)).height,
                    };
                    return (w, h_ovr.unwrap_or(h));
                }
                match auto {
                    AutoResize::Width => {
                        let r = self.text_metrics(d, id, None);
                        (r.width, h_ovr.unwrap_or(r.height))
                    }
                    AutoResize::Height => (
                        w0,
                        h_ovr.unwrap_or_else(|| self.text_metrics(d, id, Some(w0)).height),
                    ),
                    AutoResize::None => (w0, h_ovr.unwrap_or(h0)),
                }
            }
            _ => {
                let Some(layout) = n.layout() else {
                    return (w_ovr.unwrap_or(w0), h_ovr.unwrap_or(h0));
                };
                let s = b.sizing_or_fixed();
                let hug_w = w_ovr.is_none() && s.h == SizingMode::Hug;
                let hug_h = h_ovr.is_none() && s.v == SizingMode::Hug;
                let mut w = w_ovr.unwrap_or(w0);
                let mut h = h_ovr.unwrap_or(h0);
                if hug_w || hug_h {
                    let [pt, pr, pb, pl] = layout.padding;
                    let inner_w = (!hug_w).then(|| (w - pl - pr).max(0.0));
                    let inner_h = (!hug_h).then(|| (h - pt - pb).max(0.0));
                    if let Some(plan) = self.plan(d, id, inner_w, inner_h) {
                        if hug_w {
                            w = (plan.content_width + pl + pr).max(0.0);
                        }
                        if hug_h {
                            h = (plan.content_height + pt + pb).max(0.0);
                        }
                    }
                }
                (w, h)
            }
        }
    }

    /// Distance from the top of a node (of final size `h`) to its first baseline.
    fn baseline(&mut self, d: &Design, id: &str, w: f64, h: f64, depth: usize) -> f64 {
        let Some(n) = d.node(id) else { return h };
        if n.base().rotation != 0.0 {
            return rotated_size(w, h, n.base().rotation).1;
        }
        match n {
            Node::Text(t) => {
                let r = self.text_metrics(d, id, Some(w));
                r.baseline + vertical_offset(t.vertical_align, h, r.height)
            }
            _ if n.layout().is_some() && depth < 8 => {
                let first = n
                    .child_ids()
                    .iter()
                    .find(|c| d.node(c).is_some_and(|c| c.base().visible));
                match first.and_then(|c| d.node(c)) {
                    Some(c) => {
                        let cb = c.base();
                        cb.y + self.baseline(d, c.id(), cb.width, cb.height, depth + 1)
                    }
                    None => h,
                }
            }
            _ => h,
        }
    }

    /// Minimum main-axis size of a fill child: an auto-layout container's hugged content (plus padding); 0 for
    /// everything else (text wraps, shapes scale).
    fn min_main(&mut self, d: &Design, id: &str, row: bool) -> f64 {
        let Some(layout) = d.node(id).and_then(|n| n.layout().cloned()) else {
            return 0.0;
        };
        let [pt, pr, pb, pl] = layout.padding;
        match self.plan(d, id, None, None) {
            Some(p) if row => p.content_width + pl + pr,
            Some(p) => p.content_height + pt + pb,
            None => 0.0,
        }
    }

    fn items(&self, d: &Design, id: &str, layout: &AutoLayout, row: bool) -> Vec<Item> {
        let Some(n) = d.node(id) else {
            return Vec::new();
        };
        let mut out: Vec<Item> = n
            .child_ids()
            .iter()
            .filter_map(|c| d.node(c))
            .filter(|c| c.base().visible)
            .map(|c| {
                let s = modes(c);
                let (main_mode, cross_mode) = if row { (s.h, s.v) } else { (s.v, s.h) };
                let b = c.base();
                Item {
                    id: c.id().to_string(),
                    rotated: b.rotation != 0.0,
                    rotation: b.rotation,
                    main_mode,
                    cross_mode,
                    w: b.width,
                    h: b.height,
                }
            })
            .collect();
        if layout.reverse.unwrap_or(false) {
            out.reverse();
        }
        out
    }

    /// Plans container `id` (see [`plan_auto_layout`]).
    pub fn plan(
        &mut self,
        d: &Design,
        id: &str,
        inner_w: Option<f64>,
        inner_h: Option<f64>,
    ) -> Option<LayoutPlan> {
        let key = memo_key(id, inner_w, inner_h);
        if let Some(p) = self.plan_memo.get(&key) {
            return p.clone();
        }
        if self.depth >= MAX_LAYOUT_DEPTH {
            return None;
        }
        self.depth += 1;
        let p = self.plan_uncached(d, id, inner_w, inner_h);
        self.depth -= 1;
        self.plan_memo.insert(key, p.clone());
        p
    }

    fn plan_uncached(
        &mut self,
        d: &Design,
        id: &str,
        inner_w: Option<f64>,
        inner_h: Option<f64>,
    ) -> Option<LayoutPlan> {
        let layout = d.node(id)?.layout()?.clone();
        Some(match layout.mode {
            LayoutMode::Row => self.plan_flex(d, id, &layout, true, inner_w, inner_h),
            LayoutMode::Column => self.plan_flex(d, id, &layout, false, inner_w, inner_h),
            LayoutMode::Grid => self.plan_grid(d, id, &layout, inner_w, inner_h),
        })
    }

    fn measure_axes(
        &mut self,
        d: &Design,
        id: &str,
        row: bool,
        main: Option<f64>,
        cross: Option<f64>,
    ) -> (f64, f64) {
        if row {
            self.measure(d, id, main, cross)
        } else {
            self.measure(d, id, cross, main)
        }
    }

    fn plan_flex(
        &mut self,
        d: &Design,
        id: &str,
        l: &AutoLayout,
        row: bool,
        inner_w: Option<f64>,
        inner_h: Option<f64>,
    ) -> LayoutPlan {
        let (main_inner, cross_inner) = if row {
            (inner_w, inner_h)
        } else {
            (inner_h, inner_w)
        };
        let wrap = l.wrap.unwrap_or(false) && main_inner.is_some();
        let gap = l.gap;
        let line_gap = l.row_gap.unwrap_or(gap);
        let mut items = self.items(d, id, l, row);
        let stretchable = |it: &Item| {
            !it.rotated
                && (it.cross_mode == SizingMode::Fill
                    || (l.cross_align == CrossAlign::Stretch && it.cross_mode != SizingMode::Hug))
        };
        // Base sizes.
        for it in items.iter_mut() {
            let cross_ovr = if !wrap && stretchable(it) {
                cross_inner
            } else {
                None
            };
            let (w, h) = self.measure_axes(d, &it.id, row, None, cross_ovr);
            it.w = w;
            it.h = h;
        }
        let main_of = |it: &Item| if row { it.outer().0 } else { it.outer().1 };
        // Line breaking.
        let mut lines: Vec<Vec<usize>> = Vec::new();
        if wrap {
            let limit = main_inner.unwrap_or(f64::INFINITY);
            let mut cur: Vec<usize> = Vec::new();
            let mut used = 0.0;
            for (i, it) in items.iter().enumerate() {
                let s = main_of(it);
                let next = if cur.is_empty() { s } else { used + gap + s };
                if !cur.is_empty() && next > limit + 1e-9 {
                    lines.push(std::mem::take(&mut cur));
                    used = s;
                } else {
                    used = next;
                }
                cur.push(i);
            }
            if !cur.is_empty() {
                lines.push(cur);
            }
        } else if !items.is_empty() {
            lines.push((0..items.len()).collect());
        }
        // Main-axis fill distribution (single-line containers with a known main size).
        if let (false, Some(mi)) = (wrap, main_inner) {
            let fills: Vec<usize> = (0..items.len())
                .filter(|&i| items[i].main_mode == SizingMode::Fill && !items[i].rotated)
                .collect();
            if !fills.is_empty() {
                let fixed: f64 = (0..items.len())
                    .filter(|&i| !(items[i].main_mode == SizingMode::Fill && !items[i].rotated))
                    .map(|i| main_of(&items[i]))
                    .sum();
                let gaps = gap * (items.len().saturating_sub(1)) as f64;
                // Fill children share the free space equally but never shrink below their minimum (an
                // auto-layout container's hugged content); children at their minimum leave the pool.
                let mins: Vec<f64> = fills
                    .iter()
                    .map(|&i| self.min_main(d, &items[i].id, row))
                    .collect();
                let mut size = vec![0.0; fills.len()];
                let mut pool: Vec<usize> = (0..fills.len()).collect();
                let mut free = mi - fixed - gaps;
                loop {
                    let share = (free / pool.len().max(1) as f64).max(0.0);
                    let (at_min, rest): (Vec<usize>, Vec<usize>) =
                        pool.iter().partition(|&&k| mins[k] > share);
                    if at_min.is_empty() {
                        for k in rest {
                            size[k] = share;
                        }
                        break;
                    }
                    for k in at_min {
                        size[k] = mins[k];
                        free -= mins[k];
                    }
                    pool = rest;
                    if pool.is_empty() {
                        break;
                    }
                }
                for (k, i) in fills.into_iter().enumerate() {
                    let cross_ovr = if stretchable(&items[i]) {
                        cross_inner
                    } else {
                        None
                    };
                    let (w, h) =
                        self.measure_axes(d, &items[i].id.clone(), row, Some(size[k]), cross_ovr);
                    items[i].w = w;
                    items[i].h = h;
                }
            }
        }
        let cross_of = |it: &Item| if row { it.outer().1 } else { it.outer().0 };
        let baseline_mode = row && l.cross_align == CrossAlign::Baseline;
        let mut placed: Vec<Option<LayoutItem>> = vec![None; items.len()];
        let mut cross_cursor = 0.0;
        let mut content_main: f64 = 0.0;
        let single = lines.len() == 1 && !wrap;
        for (li, line) in lines.iter().enumerate() {
            // Cross size of the line.
            let mut baselines: Vec<f64> = Vec::new();
            let mut line_cross: f64 = 0.0;
            if baseline_mode {
                let mut asc: f64 = 0.0;
                let mut desc: f64 = 0.0;
                for &i in line {
                    let it = &items[i];
                    let b = self.baseline(d, &it.id, it.w, it.h, 0);
                    asc = asc.max(b);
                    desc = desc.max(cross_of(it) - b);
                    baselines.push(b);
                }
                line_cross = asc + desc;
            } else {
                for &i in line {
                    line_cross = line_cross.max(cross_of(&items[i]));
                }
            }
            let align_box = match (single, cross_inner) {
                (true, Some(ci)) => ci,
                _ => line_cross,
            };
            // Wrapped lines stretch their items to the line's cross size.
            if wrap {
                for &i in line {
                    if stretchable(&items[i]) {
                        let id = items[i].id.clone();
                        let main = if row { items[i].w } else { items[i].h };
                        let (w, h) = self.measure_axes(d, &id, row, Some(main), Some(line_cross));
                        items[i].w = w;
                        items[i].h = h;
                    }
                }
            }
            let n = line.len();
            let line_main: f64 = line.iter().map(|&i| main_of(&items[i])).sum::<f64>()
                + gap * n.saturating_sub(1) as f64;
            content_main = content_main.max(line_main);
            let remaining = main_inner.map(|m| m - line_main).unwrap_or(0.0);
            let (mut cursor, spacing) = match l.main_align {
                MainAlign::Start => (0.0, gap),
                MainAlign::Center => (remaining / 2.0, gap),
                MainAlign::End => (remaining, gap),
                MainAlign::SpaceBetween => {
                    if n > 1 && remaining > 0.0 {
                        (0.0, gap + remaining / (n - 1) as f64)
                    } else {
                        (0.0, gap)
                    }
                }
            };
            let line_baseline = baselines.iter().copied().fold(0.0, f64::max);
            for (k, &i) in line.iter().enumerate() {
                let it = &items[i];
                let (ow, oh) = it.outer();
                let (om, oc) = if row { (ow, oh) } else { (oh, ow) };
                let cross_pos = if baseline_mode {
                    line_baseline - baselines[k]
                } else {
                    match l.cross_align {
                        CrossAlign::Start | CrossAlign::Stretch | CrossAlign::Baseline => 0.0,
                        CrossAlign::Center => (align_box - oc) / 2.0,
                        CrossAlign::End => align_box - oc,
                    }
                };
                let (slot_x, slot_y) = if row {
                    (cursor, cross_cursor + cross_pos)
                } else {
                    (cross_cursor + cross_pos, cursor)
                };
                // Rotated children occupy their bounding box; x/y address the unrotated box centered in it.
                let x = slot_x + (ow - it.w) / 2.0;
                let y = slot_y + (oh - it.h) / 2.0;
                placed[i] = Some(LayoutItem {
                    id: it.id.clone(),
                    x,
                    y,
                    width: it.w,
                    height: it.h,
                });
                cursor += om + spacing;
            }
            cross_cursor += line_cross;
            if li + 1 < lines.len() {
                cross_cursor += line_gap;
            }
        }
        let content_cross = cross_cursor;
        let (cw, ch) = if row {
            (content_main, content_cross)
        } else {
            (content_cross, content_main)
        };
        let mut out: Vec<LayoutItem> = placed.into_iter().flatten().collect();
        if l.reverse.unwrap_or(false) {
            out.reverse();
        }
        LayoutPlan {
            content_width: cw,
            content_height: ch,
            items: out,
        }
    }

    fn plan_grid(
        &mut self,
        d: &Design,
        id: &str,
        l: &AutoLayout,
        inner_w: Option<f64>,
        inner_h: Option<f64>,
    ) -> LayoutPlan {
        let mut items = self.items(d, id, l, true);
        let n = items.len();
        if n == 0 {
            return LayoutPlan::default();
        }
        // `columns` may be any safe integer. Column widths use the real count (`cols_f`); cell indices use it capped
        // at the item count, which places every item identically (with `columns >= n` all items share row 0) and
        // keeps the index math within `usize` on 32-bit targets.
        let columns = l
            .columns
            .map(|c| c.max(1))
            .unwrap_or_else(|| (n as f64).sqrt().ceil().max(1.0) as u64);
        let cols_f = columns as f64;
        let cols = columns.min(n as u64) as usize;
        let rows = n.div_ceil(cols);
        let gap = l.gap;
        let row_gap = l.row_gap.unwrap_or(gap);
        for it in items.iter_mut() {
            let (w, h) = self.measure(d, &it.id, None, None);
            it.w = w;
            it.h = h;
        }
        let col_w = match inner_w {
            Some(iw) => ((iw - gap * (cols_f - 1.0)) / cols_f).max(0.0),
            None => items.iter().map(|it| it.outer().0).fold(0.0, f64::max),
        };
        // Horizontal fill first (it can change text heights), then row heights.
        for it in items.iter_mut() {
            if it.main_mode == SizingMode::Fill && !it.rotated {
                let (w, h) = self.measure(d, &it.id, Some(col_w), None);
                it.w = w;
                it.h = h;
            }
        }
        let v_fill = |it: &Item| {
            !it.rotated
                && (it.cross_mode == SizingMode::Fill
                    || (l.cross_align == CrossAlign::Stretch && it.cross_mode != SizingMode::Hug))
        };
        let mut row_h = vec![0.0f64; rows];
        for (i, it) in items.iter().enumerate() {
            if !v_fill(it) {
                row_h[i / cols] = row_h[i / cols].max(it.outer().1);
            }
        }
        for (i, it) in items.iter().enumerate() {
            if v_fill(it) && row_h[i / cols] == 0.0 {
                row_h[i / cols] = it.outer().1;
            }
        }
        if let Some(ih) = inner_h {
            // Rows made only of fill children share the leftover height.
            let mut is_fill_row = vec![true; rows];
            for (i, it) in items.iter().enumerate() {
                if !v_fill(it) {
                    is_fill_row[i / cols] = false;
                }
            }
            let fill_rows: Vec<usize> = (0..rows).filter(|&r| is_fill_row[r]).collect();
            if !fill_rows.is_empty() {
                let fixed: f64 = (0..rows)
                    .filter(|&r| !is_fill_row[r])
                    .map(|r| row_h[r])
                    .sum();
                let share =
                    ((ih - fixed - row_gap * (rows - 1) as f64) / fill_rows.len() as f64).max(0.0);
                for r in fill_rows {
                    row_h[r] = share;
                }
            }
        }
        let mut out = Vec::with_capacity(n);
        let mut y = 0.0;
        let mut row_y = vec![0.0; rows];
        for (r, ry) in row_y.iter_mut().enumerate() {
            *ry = y;
            y += row_h[r] + row_gap;
        }
        for (i, it) in items.iter_mut().enumerate() {
            let (r, c) = (i / cols, i % cols);
            if v_fill(it) {
                let (w, h) = self.measure(d, &it.id, Some(it.w), Some(row_h[r]));
                it.w = w;
                it.h = h;
            }
            let (ow, oh) = it.outer();
            let cell_x = c as f64 * (col_w + gap);
            let dx = match l.main_align {
                MainAlign::Start | MainAlign::SpaceBetween => 0.0,
                MainAlign::Center => (col_w - ow) / 2.0,
                MainAlign::End => col_w - ow,
            };
            let dy = match l.cross_align {
                CrossAlign::Start | CrossAlign::Stretch | CrossAlign::Baseline => 0.0,
                CrossAlign::Center => (row_h[r] - oh) / 2.0,
                CrossAlign::End => row_h[r] - oh,
            };
            out.push(LayoutItem {
                id: it.id.clone(),
                x: cell_x + dx + (ow - it.w) / 2.0,
                y: row_y[r] + dy + (oh - it.h) / 2.0,
                width: it.w,
                height: it.h,
            });
        }
        if l.reverse.unwrap_or(false) {
            out.reverse();
        }
        let content_w = col_w * cols_f + gap * (cols_f - 1.0);
        let content_h = row_h.iter().sum::<f64>() + row_gap * (rows - 1) as f64;
        LayoutPlan {
            content_width: content_w,
            content_height: content_h,
            items: out,
        }
    }

    /// Lays out container `id` at its final size `(w, h)` (position unchanged) and recursively its descendants.
    pub fn arrange(
        &mut self,
        d: &mut Design,
        log: &mut ChangeLog,
        id: &str,
        w: f64,
        h: f64,
        explicit: &rustc_hash::FxHashSet<String>,
    ) {
        let Some(g) = geo_of(d, id) else { return };
        let old = (g.width, g.height);
        log.set(
            d,
            id,
            Geo {
                width: w,
                height: h,
                ..g
            },
        );
        // Geometry was written since the last plan (here or by the caller): earlier plans may be stale.
        self.invalidate();
        if self.depth >= MAX_LAYOUT_DEPTH {
            return;
        }
        self.depth += 1;
        self.arrange_children(d, log, id, old, w, h, explicit);
        self.depth -= 1;
    }

    #[allow(clippy::too_many_arguments)]
    fn arrange_children(
        &mut self,
        d: &mut Design,
        log: &mut ChangeLog,
        id: &str,
        old: (f64, f64),
        w: f64,
        h: f64,
        explicit: &rustc_hash::FxHashSet<String>,
    ) {
        let layout = d.node(id).and_then(|n| n.layout().cloned());
        let Some(layout) = layout else {
            // A non-layout container resized by its parent: its children follow their constraints.
            if d.node(id).is_some_and(|n| {
                n.container().is_some() && !matches!(n, Node::Group(_) | Node::Boolean(_))
            }) {
                super::normalize::apply_constraints(d, log, id, old, (w, h), explicit, self);
            }
            return;
        };
        let [pt, pr, pb, pl] = layout.padding;
        let Some(plan) = self.plan(
            d,
            id,
            Some((w - pl - pr).max(0.0)),
            Some((h - pt - pb).max(0.0)),
        ) else {
            return;
        };
        for item in plan.items {
            let Some(cg) = geo_of(d, &item.id) else {
                continue;
            };
            let child_is_container = d.node(&item.id).is_some_and(Node::is_container);
            let child_is_group = d
                .node(&item.id)
                .is_some_and(|n| matches!(n, Node::Group(_) | Node::Boolean(_)));
            if child_is_container && !child_is_group {
                log.set(
                    d,
                    &item.id,
                    Geo {
                        x: pl + item.x,
                        y: pt + item.y,
                        ..cg
                    },
                );
                self.arrange(d, log, &item.id, item.width, item.height, explicit);
            } else if child_is_group {
                // Group size is derived from its children; layout only positions it.
                log.set(
                    d,
                    &item.id,
                    Geo {
                        x: pl + item.x,
                        y: pt + item.y,
                        ..cg
                    },
                );
            } else {
                log.set(
                    d,
                    &item.id,
                    Geo {
                        x: pl + item.x,
                        y: pt + item.y,
                        width: item.width,
                        height: item.height,
                    },
                );
            }
        }
    }
}
