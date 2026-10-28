//! Charts (bar, column, stacked column, line, area, scatter, pie, donut, radar, funnel, progress) drawn from the
//! node's data and options, with grid lines, axes, value labels and a legend. Labels are real text items.

use std::f64::consts::PI;
use std::sync::Arc;

use desyn_core::geometry::{Affine, Rect};
use desyn_core::model::{
    AutoResize, BlendMode, ChartKind, ChartNode, Color, Fill, Node, TextAlign, TextStyle,
    VerticalAlign,
};
use desyn_core::paths::kurbo::{self, BezPath, Shape as _};

use super::build::DisplayListBuilder;
use super::{FillItem, FillRule, Item, LineCap, LineJoin, StrokeItem, StrokeStyle};
use crate::geom::{bez_to_path, path_bounds};
use crate::paint::{Color4, Paint};

/// Most categories / series drawn (hostile documents can carry millions).
const MAX_CATEGORIES: usize = 2000;
const MAX_SERIES: usize = 64;

/// Palette used when a chart has none.
const DEFAULT_PALETTE: &[&str] = &[
    "#ffb02e", "#4f8cff", "#2fbf71", "#e5484d", "#a463f2", "#14b8a6", "#f97316",
];

/// A text label in a box.
pub(super) struct Label<'s> {
    pub text: &'s str,
    pub style: TextStyle,
    pub align: TextAlign,
    pub valign: VerticalAlign,
    pub rect: Rect,
    pub single_line: bool,
}

fn fill_item(path: BezPath, color: Color4) -> Option<Item> {
    let p = bez_to_path(&path)?;
    Some(Item::Fill(FillItem {
        bounds: path_bounds(&p),
        path: Arc::new(p),
        rule: FillRule::Nonzero,
        paint: Paint::Solid(color),
        opacity: 1.0,
        blend: BlendMode::Normal,
    }))
}

fn stroke_item(path: BezPath, color: Color4, width: f64, round: bool) -> Option<Item> {
    let p = bez_to_path(&path)?;
    let stroke = StrokeStyle {
        width,
        cap: if round { LineCap::Round } else { LineCap::Butt },
        join: if round {
            LineJoin::Round
        } else {
            LineJoin::Miter
        },
        miter_limit: 4.0,
        dash: None,
    };
    Some(Item::Stroke(StrokeItem {
        bounds: path_bounds(&p).inflate(stroke.outset()),
        path: Arc::new(p),
        stroke,
        paint: Paint::Solid(color),
        opacity: 1.0,
        blend: BlendMode::Normal,
    }))
}

fn rounded(x: f64, y: f64, w: f64, h: f64, r: f64) -> BezPath {
    let r = r.min(w / 2.0).min(h / 2.0).max(0.0);
    kurbo::RoundedRect::new(x, y, x + w, y + h, r).to_path(0.05)
}

/// Bar rectangle rounded only at its value end (`end`: 0 top, 1 right, 2 bottom, 3 left).
fn bar_shape(x: f64, y: f64, w: f64, h: f64, r: f64, end: u8) -> BezPath {
    let r = r.min(w / 2.0).min(h / 2.0).max(0.0);
    let radii = match end {
        0 => kurbo::RoundedRectRadii::new(r, r, 0.0, 0.0),
        1 => kurbo::RoundedRectRadii::new(0.0, r, r, 0.0),
        2 => kurbo::RoundedRectRadii::new(0.0, 0.0, r, r),
        _ => kurbo::RoundedRectRadii::new(r, 0.0, 0.0, r),
    };
    kurbo::RoundedRect::new(x, y, x + w, y + h, radii).to_path(0.05)
}

/// "Nice" axis ticks covering `lo..hi`.
pub(super) fn nice_ticks(lo: f64, hi: f64, target: usize) -> Vec<f64> {
    if !(lo.is_finite() && hi.is_finite()) || hi <= lo {
        return vec![lo, lo + 1.0];
    }
    let raw = (hi - lo) / target.max(1) as f64;
    let mag = 10f64.powf(raw.log10().floor());
    let step = [1.0, 2.0, 2.5, 5.0, 10.0]
        .iter()
        .map(|m| m * mag)
        .find(|s| *s >= raw)
        .unwrap_or(10.0 * mag);
    let start = (lo / step).floor() * step;
    let mut v = Vec::new();
    let mut t = start;
    // Ticks run until one covers `hi`, so every value lies inside the axis.
    loop {
        v.push(if t.abs() < step * 1e-9 { 0.0 } else { t });
        if t >= hi - step * 1e-9 || v.len() >= 50 {
            break;
        }
        t += step;
    }
    v
}

/// Formats a value with grouping and at most two decimals, plus the unit.
pub(super) fn format_value(v: f64, unit: Option<&str>) -> String {
    let neg = v < 0.0;
    let a = v.abs();
    let mut s = if (a - a.round()).abs() < 1e-9 {
        format!("{}", a.round() as i64)
    } else {
        let t = format!("{a:.2}");
        t.trim_end_matches('0').trim_end_matches('.').to_string()
    };
    let (int, frac) = match s.find('.') {
        Some(i) => (s[..i].to_string(), s[i..].to_string()),
        None => (s.clone(), String::new()),
    };
    if int.len() > 3 {
        let mut grouped = String::new();
        for (i, ch) in int.chars().enumerate() {
            if i > 0 && (int.len() - i) % 3 == 0 {
                grouped.push(',');
            }
            grouped.push(ch);
        }
        s = grouped + &frac;
    }
    let sign = if neg { "-" } else { "" };
    match unit.filter(|u| !u.is_empty()) {
        Some(u) if matches!(u, "$" | "€" | "£" | "¥") => format!("{sign}{u}{s}"),
        // Single-character suffixes (%, k, M, x) attach directly; unit words get a space.
        Some(u) if u.chars().count() == 1 => format!("{sign}{s}{u}"),
        Some(u) => format!("{sign}{s} {u}"),
        None => format!("{sign}{s}"),
    }
}

impl DisplayListBuilder<'_> {
    /// A label laid out by the text engine, placed in its rectangle.
    pub(super) fn label(&mut self, l: Label<'_>) -> Option<Item> {
        if l.text.is_empty() || !(l.rect.w > 0.0 && l.rect.h > 0.0) {
            return None;
        }
        let Node::Text(mut t) = Node::text("label0000000", l.text, 0.0, 0.0, Some(l.rect.w)) else {
            return None;
        };
        t.base.height = l.rect.h;
        t.style = l.style;
        t.paragraph.align = l.align;
        t.auto_resize = AutoResize::None;
        t.vertical_align = l.valign;
        if l.single_line {
            t.max_lines = Some(1);
        }
        let laid = self.text.layout_node(&t, Some(&self.design.styles));
        self.collect_font_requests();
        let (items, _) = self.laid_text_items(&laid, l.rect.w, l.rect.h, None, None, &[]);
        if items.is_empty() {
            return None;
        }
        Some(Item::Layer(Box::new(self.group(
            Affine::translate(l.rect.x, l.rect.y),
            items,
            crate::hash::hash_of(l.text) ^ l.rect.x.to_bits() ^ l.rect.y.to_bits().rotate_left(17),
        ))))
    }

    fn chart_style(&self, c: &ChartNode, scale: f64, color: &Color, alpha: f32) -> TextStyle {
        let mut s = TextStyle::default_style();
        if !c.options.font_family.trim().is_empty() {
            s.font_family = c.options.font_family.clone();
        }
        let fs = if c.options.font_size.is_finite() && c.options.font_size > 0.0 {
            c.options.font_size
        } else {
            14.0
        };
        s.font_size = (fs * scale).clamp(1.0, 400.0);
        let [r, g, b, a] = Color4::from_color(color).with_alpha_mul(alpha).to_rgba8();
        s.fills = vec![Fill::solid(Color::from_rgba8(r, g, b, a))];
        s
    }

    fn series_color(&self, c: &ChartNode, i: usize) -> Color4 {
        if let Some(col) = c.data.series.get(i).and_then(|s| s.color.as_ref()) {
            return Color4::from_color(col);
        }
        self.palette_color(c, i)
    }

    fn palette_color(&self, c: &ChartNode, i: usize) -> Color4 {
        if !c.options.palette.is_empty() {
            return Color4::from_color(&c.options.palette[i % c.options.palette.len()]);
        }
        Color4::parse_hex(DEFAULT_PALETTE[i % DEFAULT_PALETTE.len()]).expect("valid palette")
    }

    /// Items of a chart node.
    pub(super) fn chart_items(&mut self, c: &ChartNode) -> Vec<Item> {
        let (w, h) = (c.base.width.max(0.0), c.base.height.max(0.0));
        if !(w > 4.0 && h > 4.0) {
            return Vec::new();
        }
        let labels: Vec<&str> = c
            .data
            .labels
            .iter()
            .take(MAX_CATEGORIES)
            .map(String::as_str)
            .collect();
        let series: Vec<(String, Vec<f64>)> = c
            .data
            .series
            .iter()
            .take(MAX_SERIES)
            .map(|s| {
                (
                    s.name.clone(),
                    s.values
                        .iter()
                        .take(MAX_CATEGORIES)
                        .map(|v| if v.is_finite() { *v } else { 0.0 })
                        .collect(),
                )
            })
            .collect();
        let fs = if c.options.font_size.is_finite() && c.options.font_size > 0.0 {
            c.options.font_size.min(200.0)
        } else {
            14.0
        };
        let text = c.options.text_color.clone();
        let muted = self.chart_style(c, 0.85, &text, 0.7);
        let strong = self.chart_style(c, 1.0, &text, 1.0);
        let grid_color = Color4::from_color(&text).with_alpha_mul(0.14);
        let pad = (fs * 0.5).max(2.0);
        let mut out = Vec::new();

        // Legend.
        let pie_like = matches!(
            c.chart,
            ChartKind::Pie | ChartKind::Donut | ChartKind::Funnel
        );
        let legend_entries: Vec<(String, Color4)> = if pie_like {
            labels
                .iter()
                .enumerate()
                .map(|(i, l)| (l.to_string(), self.palette_color(c, i)))
                .collect()
        } else {
            series
                .iter()
                .enumerate()
                .map(|(i, s)| (s.0.clone(), self.series_color(c, i)))
                .collect()
        };
        let mut top = pad;
        if c.options.legend && !legend_entries.is_empty() && c.chart != ChartKind::Progress {
            let row_h = fs * 1.6;
            let mut x = pad;
            let mut y = pad;
            for (name, color) in &legend_entries {
                let est = fs * 0.6 * name.chars().count() as f64 + fs * 1.6;
                if x + est > w - pad && x > pad {
                    x = pad;
                    y += row_h;
                }
                if y + row_h > h * 0.4 {
                    break;
                }
                let r = fs * 0.35;
                out.extend(fill_item(
                    kurbo::Circle::new((x + r, y + row_h / 2.0), r).to_path(0.05),
                    *color,
                ));
                out.extend(self.label(Label {
                    text: name,
                    style: muted.clone(),
                    align: TextAlign::Left,
                    valign: VerticalAlign::Middle,
                    rect: Rect::new(
                        x + r * 2.0 + fs * 0.4,
                        y,
                        est.min(w - x - pad).max(fs),
                        row_h,
                    ),
                    single_line: true,
                }));
                x += est + fs * 0.6;
            }
            top = y + row_h + pad * 0.5;
        }
        let area = Rect::new(pad, top, (w - 2.0 * pad).max(1.0), (h - top - pad).max(1.0));
        match c.chart {
            ChartKind::Pie | ChartKind::Donut => {
                self.pie(c, &labels, &series, area, &strong, &mut out)
            }
            ChartKind::Radar => self.radar(c, &labels, &series, area, &muted, grid_color, &mut out),
            ChartKind::Funnel => self.funnel(c, &labels, &series, area, &strong, &mut out),
            ChartKind::Progress => self.progress(c, &series, area, &strong, grid_color, &mut out),
            _ => self.cartesian(c, &labels, &series, area, &muted, grid_color, &mut out),
        }
        out
    }

    #[allow(clippy::too_many_arguments)]
    fn cartesian(
        &mut self,
        c: &ChartNode,
        labels: &[&str],
        series: &[(String, Vec<f64>)],
        area: Rect,
        muted: &TextStyle,
        grid_color: Color4,
        out: &mut Vec<Item>,
    ) {
        let fs = muted.font_size;
        let n = labels
            .len()
            .max(series.iter().map(|s| s.1.len()).max().unwrap_or(0))
            .max(1);
        let stacked = c.chart == ChartKind::StackedColumn;
        let horizontal = c.chart == ChartKind::Bar;
        let (mut lo, mut hi) = (0.0f64, f64::MIN);
        for i in 0..n {
            if stacked {
                let (mut pos, mut neg) = (0.0, 0.0);
                for s in series {
                    let v = s.1.get(i).copied().unwrap_or(0.0);
                    if v >= 0.0 {
                        pos += v;
                    } else {
                        neg += v;
                    }
                }
                hi = hi.max(pos);
                lo = lo.min(neg);
            } else {
                for s in series {
                    if let Some(v) = s.1.get(i) {
                        hi = hi.max(*v);
                        lo = lo.min(*v);
                    }
                }
            }
        }
        if hi == f64::MIN {
            hi = 1.0;
        }
        if let Some(m) = c.options.min.filter(|v| v.is_finite()) {
            lo = m;
        }
        if let Some(m) = c.options.max.filter(|v| v.is_finite()) {
            hi = m;
        }
        if hi <= lo {
            hi = lo + 1.0;
        }
        let ticks = nice_ticks(lo, hi, 5);
        let (vlo, vhi) = (
            ticks.first().copied().unwrap_or(lo).min(lo),
            ticks.last().copied().unwrap_or(hi).max(hi),
        );
        let unit = c.options.unit.as_deref();
        let tick_w = ticks
            .iter()
            .map(|t| format_value(*t, unit).chars().count())
            .max()
            .unwrap_or(1) as f64
            * fs
            * 0.62
            + fs * 0.6;
        let label_h = fs * 1.8;
        let scatter_numeric: Option<Vec<f64>> = (c.chart == ChartKind::Scatter)
            .then(|| {
                labels
                    .iter()
                    .map(|l| l.trim().parse::<f64>().ok())
                    .collect::<Option<Vec<f64>>>()
            })
            .flatten()
            .filter(|v| !v.is_empty());
        let plot = if horizontal {
            let cat_w =
                (labels.iter().map(|l| l.chars().count()).max().unwrap_or(0) as f64 * fs * 0.62
                    + fs * 0.6)
                    .min(area.w * 0.35);
            Rect::new(
                area.x + cat_w,
                area.y,
                (area.w - cat_w).max(1.0),
                (area.h - label_h).max(1.0),
            )
        } else {
            Rect::new(
                area.x + tick_w,
                area.y,
                (area.w - tick_w).max(1.0),
                (area.h - label_h).max(1.0),
            )
        };
        let value_pos = |v: f64| -> f64 {
            let t = (v - vlo) / (vhi - vlo);
            if horizontal {
                plot.x + t * plot.w
            } else {
                plot.y + plot.h - t * plot.h
            }
        };
        // Grid and value axis labels.
        for t in &ticks {
            let p = value_pos(*t);
            let mut line = BezPath::new();
            if horizontal {
                line.move_to((p, plot.y));
                line.line_to((p, plot.y + plot.h));
            } else {
                line.move_to((plot.x, p));
                line.line_to((plot.x + plot.w, p));
            }
            if c.options.grid || *t == 0.0 {
                out.extend(stroke_item(line, grid_color, 1.0, false));
            }
            let txt = format_value(*t, unit);
            let rect = if horizontal {
                Rect::new(p - fs * 3.0, plot.y + plot.h, fs * 6.0, label_h)
            } else {
                Rect::new(area.x, p - fs, tick_w - fs * 0.4, fs * 2.0)
            };
            out.extend(self.label(Label {
                text: &txt,
                style: muted.clone(),
                align: if horizontal {
                    TextAlign::Center
                } else {
                    TextAlign::Right
                },
                valign: VerticalAlign::Middle,
                rect,
                single_line: true,
            }));
        }
        let band = if horizontal { plot.h } else { plot.w } / n as f64;
        // Category labels.
        let step =
            ((fs * 0.62 * labels.iter().map(|l| l.chars().count()).max().unwrap_or(1) as f64 + fs)
                / band)
                .ceil()
                .max(1.0) as usize;
        // Numeric x axis of scatter charts: nice ticks spanning the data.
        let x_domain = scatter_numeric.as_ref().map(|xs| {
            let (mn, mx) = xs
                .iter()
                .fold((f64::MAX, f64::MIN), |(a, b), v| (a.min(*v), b.max(*v)));
            let t = nice_ticks(mn, if mx > mn { mx } else { mn + 1.0 }, 5);
            (
                t.first().copied().unwrap_or(mn).min(mn),
                t.last().copied().unwrap_or(mx).max(mx),
                t,
            )
        });
        if let Some((xlo, xhi, xt)) = &x_domain {
            for t in xt {
                let px = plot.x + (t - xlo) / (xhi - xlo).max(1e-9) * plot.w;
                if c.options.grid {
                    let mut line = BezPath::new();
                    line.move_to((px, plot.y));
                    line.line_to((px, plot.y + plot.h));
                    out.extend(stroke_item(line, grid_color, 1.0, false));
                }
                let txt = format_value(*t, None);
                out.extend(self.label(Label {
                    text: &txt,
                    style: muted.clone(),
                    align: TextAlign::Center,
                    valign: VerticalAlign::Middle,
                    rect: Rect::new(px - fs * 3.0, plot.y + plot.h, fs * 6.0, label_h),
                    single_line: true,
                }));
            }
        }
        if scatter_numeric.is_none() {
            for (i, l) in labels.iter().enumerate() {
                if !horizontal && i % step != 0 {
                    continue;
                }
                let rect = if horizontal {
                    Rect::new(
                        area.x,
                        plot.y + band * i as f64,
                        plot.x - area.x - fs * 0.4,
                        band,
                    )
                } else {
                    Rect::new(
                        plot.x + band * i as f64 - band * (step as f64 - 1.0) / 2.0,
                        plot.y + plot.h,
                        band * step as f64,
                        label_h,
                    )
                };
                out.extend(self.label(Label {
                    text: l,
                    style: muted.clone(),
                    align: if horizontal {
                        TextAlign::Right
                    } else {
                        TextAlign::Center
                    },
                    valign: VerticalAlign::Middle,
                    rect,
                    single_line: true,
                }));
            }
        }
        let zero = value_pos(0.0f64.clamp(vlo, vhi));
        let k = series.len().max(1) as f64;
        match c.chart {
            ChartKind::Bar | ChartKind::Column | ChartKind::StackedColumn => {
                let group = band * 0.72;
                let bw = if stacked { group } else { group / k };
                let mut pos_acc = vec![0.0f64; n];
                let mut neg_acc = vec![0.0f64; n];
                for (si, s) in series.iter().enumerate() {
                    let color = self.series_color(c, si);
                    for (i, v) in s.1.iter().enumerate() {
                        let (from, to) = if stacked {
                            let acc = if *v >= 0.0 {
                                &mut pos_acc[i]
                            } else {
                                &mut neg_acc[i]
                            };
                            let f = *acc;
                            *acc += v;
                            (f, *acc)
                        } else {
                            (0.0, *v)
                        };
                        let (a, b) = (
                            value_pos(from.clamp(vlo, vhi)),
                            value_pos(to.clamp(vlo, vhi)),
                        );
                        let offset = band * i as f64
                            + (band - group) / 2.0
                            + if stacked { 0.0 } else { bw * si as f64 };
                        // Only the outer end of a bar (or of the outermost stack segment) is rounded.
                        let outermost = !stacked
                            || series[si + 1..].iter().all(|o| {
                                o.1.get(i)
                                    .is_none_or(|ov| ov.signum() != v.signum() || *ov == 0.0)
                            });
                        let radius = if outermost { (bw * 0.18).min(6.0) } else { 0.0 };
                        let end = match (horizontal, *v >= 0.0) {
                            (true, true) => 1,
                            (true, false) => 3,
                            (false, true) => 0,
                            (false, false) => 2,
                        };
                        let bar = if horizontal {
                            bar_shape(
                                a.min(b),
                                plot.y + offset + bw * 0.06,
                                (b - a).abs(),
                                bw * 0.88,
                                radius,
                                end,
                            )
                        } else {
                            bar_shape(
                                plot.x + offset + bw * 0.06,
                                a.min(b),
                                bw * 0.88,
                                (b - a).abs(),
                                radius,
                                end,
                            )
                        };
                        if (b - a).abs() > 0.01 {
                            out.extend(fill_item(bar, color));
                        }
                        if c.options.labels && !stacked {
                            let txt = format_value(*v, unit);
                            let rect = if horizontal {
                                Rect::new(b + fs * 0.3, plot.y + offset, fs * 6.0, bw)
                            } else {
                                Rect::new(
                                    plot.x + offset - fs * 2.0 + bw / 2.0,
                                    b - fs * 1.6,
                                    fs * 4.0,
                                    fs * 1.5,
                                )
                            };
                            out.extend(self.label(Label {
                                text: &txt,
                                style: muted.clone(),
                                align: if horizontal {
                                    TextAlign::Left
                                } else {
                                    TextAlign::Center
                                },
                                valign: VerticalAlign::Middle,
                                rect,
                                single_line: true,
                            }));
                        }
                    }
                }
            }
            ChartKind::Line | ChartKind::Area | ChartKind::Scatter => {
                let x_at = |i: usize| -> f64 {
                    match (&scatter_numeric, &x_domain) {
                        (Some(xs), Some((xlo, xhi, _))) => {
                            plot.x
                                + (xs.get(i).copied().unwrap_or(*xlo) - xlo) / (xhi - xlo).max(1e-9)
                                    * plot.w
                        }
                        _ => plot.x + band * (i as f64 + 0.5),
                    }
                };
                let lw = (fs / 6.0).max(2.0);
                for (si, s) in series.iter().enumerate() {
                    let color = self.series_color(c, si);
                    let pts: Vec<(f64, f64)> =
                        s.1.iter()
                            .enumerate()
                            .map(|(i, v)| (x_at(i), value_pos(v.clamp(vlo, vhi))))
                            .collect();
                    if pts.is_empty() {
                        continue;
                    }
                    if c.chart == ChartKind::Area && pts.len() > 1 {
                        let mut a = BezPath::new();
                        a.move_to((pts[0].0, zero));
                        for p in &pts {
                            a.line_to(*p);
                        }
                        a.line_to((pts[pts.len() - 1].0, zero));
                        a.close_path();
                        out.extend(fill_item(a, color.with_alpha_mul(0.28)));
                    }
                    if c.chart != ChartKind::Scatter && pts.len() > 1 {
                        let mut l = BezPath::new();
                        l.move_to(pts[0]);
                        for p in &pts[1..] {
                            l.line_to(*p);
                        }
                        out.extend(stroke_item(l, color, lw, true));
                    }
                    let r = if c.chart == ChartKind::Scatter {
                        (fs * 0.32).max(3.0)
                    } else {
                        lw * 1.4
                    };
                    for (i, p) in pts.iter().enumerate() {
                        out.extend(fill_item(kurbo::Circle::new(*p, r).to_path(0.05), color));
                        if c.options.labels {
                            let txt = format_value(s.1[i], unit);
                            out.extend(self.label(Label {
                                text: &txt,
                                style: muted.clone(),
                                align: TextAlign::Center,
                                valign: VerticalAlign::Bottom,
                                rect: Rect::new(
                                    p.0 - fs * 3.0,
                                    p.1 - r - fs * 1.6,
                                    fs * 6.0,
                                    fs * 1.5,
                                ),
                                single_line: true,
                            }));
                        }
                    }
                }
            }
            _ => {}
        }
    }

    fn pie(
        &mut self,
        c: &ChartNode,
        labels: &[&str],
        series: &[(String, Vec<f64>)],
        area: Rect,
        strong: &TextStyle,
        out: &mut Vec<Item>,
    ) {
        let values: Vec<f64> = series
            .first()
            .map(|s| s.1.iter().map(|v| v.max(0.0)).collect())
            .unwrap_or_default();
        let total: f64 = values.iter().sum();
        if total <= 0.0 {
            return;
        }
        let r = area.w.min(area.h) / 2.0;
        let (cx, cy) = (area.x + area.w / 2.0, area.y + area.h / 2.0);
        let inner = if c.chart == ChartKind::Donut {
            r * 0.6
        } else {
            0.0
        };
        let mut a0 = -PI / 2.0;
        for (i, v) in values.iter().enumerate() {
            let sweep = v / total * 2.0 * PI;
            if sweep <= 0.0 {
                continue;
            }
            let color = self.palette_color(c, i);
            let a1 = a0 + sweep;
            let mut p = BezPath::new();
            let outer = kurbo::Arc::new((cx, cy), (r, r), a0, sweep, 0.0);
            if inner > 0.0 {
                let start = (cx + inner * a0.cos(), cy + inner * a0.sin());
                p.move_to(start);
                p.line_to((cx + r * a0.cos(), cy + r * a0.sin()));
                outer.to_cubic_beziers(0.05, |p1, p2, p3| p.curve_to(p1, p2, p3));
                p.line_to((cx + inner * a1.cos(), cy + inner * a1.sin()));
                kurbo::Arc::new((cx, cy), (inner, inner), a1, -sweep, 0.0)
                    .to_cubic_beziers(0.05, |p1, p2, p3| p.curve_to(p1, p2, p3));
            } else {
                p.move_to((cx, cy));
                p.line_to((cx + r * a0.cos(), cy + r * a0.sin()));
                outer.to_cubic_beziers(0.05, |p1, p2, p3| p.curve_to(p1, p2, p3));
            }
            p.close_path();
            out.extend(fill_item(p, color));
            if values.len() > 1 {
                // Hairline separators read as gaps between slices.
                let mut sep = BezPath::new();
                sep.move_to((cx + inner * a0.cos(), cy + inner * a0.sin()));
                sep.line_to((cx + r * a0.cos(), cy + r * a0.sin()));
                out.extend(stroke_item(
                    sep,
                    Color4::WHITE.with_alpha_mul(0.85),
                    (r * 0.012).max(1.0),
                    false,
                ));
            }
            if c.options.labels && sweep > 0.25 {
                let mid = a0 + sweep / 2.0;
                let rr = if inner > 0.0 {
                    (r + inner) / 2.0
                } else {
                    r * 0.62
                };
                let (lx, ly) = (cx + rr * mid.cos(), cy + rr * mid.sin());
                let pct = format!("{}%", format_value(v / total * 100.0, None));
                let mut st = strong.clone();
                st.fills = vec![Fill::solid(Color::new("#ffffff").expect("valid"))];
                let fs = st.font_size;
                out.extend(self.label(Label {
                    text: &pct,
                    style: st,
                    align: TextAlign::Center,
                    valign: VerticalAlign::Middle,
                    rect: Rect::new(lx - fs * 3.0, ly - fs, fs * 6.0, fs * 2.0),
                    single_line: true,
                }));
            }
            a0 = a1;
        }
        let _ = labels;
    }

    #[allow(clippy::too_many_arguments)]
    fn radar(
        &mut self,
        c: &ChartNode,
        labels: &[&str],
        series: &[(String, Vec<f64>)],
        area: Rect,
        muted: &TextStyle,
        grid_color: Color4,
        out: &mut Vec<Item>,
    ) {
        let n = labels
            .len()
            .max(series.iter().map(|s| s.1.len()).max().unwrap_or(0));
        if n < 3 {
            return;
        }
        let fs = muted.font_size;
        let r = (area.w.min(area.h) / 2.0 - fs * 1.8).max(4.0);
        let (cx, cy) = (area.x + area.w / 2.0, area.y + area.h / 2.0);
        let hi = c
            .options
            .max
            .filter(|v| v.is_finite() && *v > 0.0)
            .unwrap_or_else(|| {
                series
                    .iter()
                    .flat_map(|s| s.1.iter())
                    .fold(0.0f64, |a, v| a.max(*v))
                    .max(1e-9)
            });
        let ang = |i: usize| -PI / 2.0 + 2.0 * PI * i as f64 / n as f64;
        if c.options.grid {
            for ring in 1..=4 {
                let rr = r * ring as f64 / 4.0;
                let mut p = BezPath::new();
                for i in 0..n {
                    let pt = (cx + rr * ang(i).cos(), cy + rr * ang(i).sin());
                    if i == 0 {
                        p.move_to(pt);
                    } else {
                        p.line_to(pt);
                    }
                }
                p.close_path();
                out.extend(stroke_item(p, grid_color, 1.0, false));
            }
            for i in 0..n {
                let mut p = BezPath::new();
                p.move_to((cx, cy));
                p.line_to((cx + r * ang(i).cos(), cy + r * ang(i).sin()));
                out.extend(stroke_item(p, grid_color, 1.0, false));
            }
        }
        for (i, l) in labels.iter().enumerate().take(n) {
            let a = ang(i);
            let (lx, ly) = (cx + (r + fs * 1.1) * a.cos(), cy + (r + fs * 1.1) * a.sin());
            out.extend(self.label(Label {
                text: l,
                style: muted.clone(),
                align: TextAlign::Center,
                valign: VerticalAlign::Middle,
                rect: Rect::new(lx - fs * 4.0, ly - fs, fs * 8.0, fs * 2.0),
                single_line: true,
            }));
        }
        for (si, s) in series.iter().enumerate() {
            let color = self.series_color(c, si);
            let mut p = BezPath::new();
            for i in 0..n {
                let v = s.1.get(i).copied().unwrap_or(0.0).max(0.0) / hi;
                let pt = (
                    cx + r * v.min(1.0) * ang(i).cos(),
                    cy + r * v.min(1.0) * ang(i).sin(),
                );
                if i == 0 {
                    p.move_to(pt);
                } else {
                    p.line_to(pt);
                }
            }
            p.close_path();
            out.extend(fill_item(p.clone(), color.with_alpha_mul(0.22)));
            out.extend(stroke_item(p, color, (fs / 7.0).max(1.5), true));
        }
    }

    fn funnel(
        &mut self,
        c: &ChartNode,
        labels: &[&str],
        series: &[(String, Vec<f64>)],
        area: Rect,
        strong: &TextStyle,
        out: &mut Vec<Item>,
    ) {
        let values: Vec<f64> = series
            .first()
            .map(|s| s.1.iter().map(|v| v.max(0.0)).collect())
            .unwrap_or_default();
        let n = values.len();
        let hi = values.iter().fold(0.0f64, |a, v| a.max(*v));
        if n == 0 || hi <= 0.0 {
            return;
        }
        let gap = (area.h * 0.02).min(6.0);
        let bh = (area.h - gap * (n as f64 - 1.0)) / n as f64;
        let fs = strong.font_size;
        for (i, v) in values.iter().enumerate() {
            // Narrow stages keep a readable width (the label carries the exact value).
            let bw = area.w * (0.28 + 0.72 * v / hi);
            let x = area.x + (area.w - bw) / 2.0;
            let y = area.y + i as f64 * (bh + gap);
            out.extend(fill_item(
                rounded(x, y, bw, bh, (bh * 0.2).min(8.0)),
                self.palette_color(c, i),
            ));
            let txt = match labels.get(i) {
                Some(l) if c.options.labels => {
                    format!("{l}  {}", format_value(*v, c.options.unit.as_deref()))
                }
                Some(l) => l.to_string(),
                None => format_value(*v, c.options.unit.as_deref()),
            };
            let mut st = strong.clone();
            st.fills = vec![Fill::solid(Color::new("#ffffff").expect("valid"))];
            out.extend(self.label(Label {
                text: &txt,
                style: st,
                align: TextAlign::Center,
                valign: VerticalAlign::Middle,
                rect: Rect::new(area.x, y, area.w, bh.max(fs)),
                single_line: true,
            }));
        }
    }

    fn progress(
        &mut self,
        c: &ChartNode,
        series: &[(String, Vec<f64>)],
        area: Rect,
        strong: &TextStyle,
        track: Color4,
        out: &mut Vec<Item>,
    ) {
        let v = series
            .first()
            .and_then(|s| s.1.first())
            .copied()
            .unwrap_or(0.0);
        let lo = c.options.min.filter(|v| v.is_finite()).unwrap_or(0.0);
        let hi = c.options.max.filter(|v| v.is_finite()).unwrap_or(100.0);
        let t = if hi > lo {
            ((v - lo) / (hi - lo)).clamp(0.0, 1.0)
        } else {
            0.0
        };
        let fs = strong.font_size;
        let label_w = if c.options.labels { fs * 4.5 } else { 0.0 };
        let bar_h = area.h.min(fs * 1.2).max(2.0);
        let y = area.y + (area.h - bar_h) / 2.0;
        let bw = (area.w - label_w).max(1.0);
        out.extend(fill_item(rounded(area.x, y, bw, bar_h, bar_h / 2.0), track));
        if t > 0.0 {
            out.extend(fill_item(
                rounded(area.x, y, (bw * t).max(bar_h), bar_h, bar_h / 2.0),
                self.series_color(c, 0),
            ));
        }
        if c.options.labels {
            let txt = match c.options.unit.as_deref() {
                Some(u) if !u.is_empty() => format_value(v, Some(u)),
                _ => format!("{}%", format_value(t * 100.0, None)),
            };
            out.extend(self.label(Label {
                text: &txt,
                style: strong.clone(),
                align: TextAlign::Right,
                valign: VerticalAlign::Middle,
                rect: Rect::new(area.x + bw, area.y, label_w, area.h),
                single_line: true,
            }));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ticks_and_format() {
        assert_eq!(
            nice_ticks(0.0, 97.0, 5),
            vec![0.0, 20.0, 40.0, 60.0, 80.0, 100.0]
        );
        assert_eq!(format_value(1250.0, None), "1,250");
        assert_eq!(format_value(12.5, Some("%")), "12.5%");
        assert_eq!(format_value(-3.0, Some("$")), "-$3");
        assert_eq!(format_value(1234567.891, Some("kg")), "1,234,567.89 kg");
    }
}
