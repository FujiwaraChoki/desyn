//! Layout rules: page bounds, safe area, bleed, near-miss alignment, off-center placement, spacing rhythm.

use desyn_core::geometry::Rect;
use desyn_core::{DesignKind, NodeType};
use serde_json::json;

use super::text::ink_box;
use super::{r1, r2, translate_fix, update};
use crate::ctx::Ctx;
use crate::semantic::{Elem, GroupKind, Grouping};
use crate::types::{IssueCode, Severity};

/// Roles that must stay readable and inside the safe area.
const IMPORTANT_ROLES: &[&str] = &[
    "logo",
    "brand-mark",
    "cta",
    "button",
    "headline",
    "price",
    "qr",
    "contact",
    "url",
];

fn is_important(ctx: &Ctx<'_>, i: usize) -> bool {
    let it = &ctx.scene.items[i];
    it.kind() == NodeType::Text && ctx.text(i).is_some_and(|f| f.has_content())
        || it.role().is_some_and(|r| IMPORTANT_ROLES.contains(&r))
        || it.kind() == NodeType::Qr
}

/// Box used for placement checks: ink for text, bounds otherwise.
fn placement_box(ctx: &Ctx<'_>, i: usize) -> Rect {
    if ctx.text(i).is_some() {
        ink_box(ctx, i)
    } else {
        ctx.scene.items[i].aabb
    }
}

/// Off-page, cut by the page edge, safe-area intrusions and missing bleed.
pub fn bounds(ctx: &mut Ctx<'_>) {
    let page = ctx.scene.page_rect;
    let n = ctx.scene.items.len();
    let mut off = vec![false; n];
    let [st, sr, sb, sl] = ctx.safe;
    for i in 0..n {
        let it = &ctx.scene.items[i];
        if !it.visible {
            continue;
        }
        if it.parent.is_some_and(|p| off[p]) {
            off[i] = true;
            continue;
        }
        let r = it.aabb;
        let name = ctx.name(i);
        if entirely_outside(&r, &page) {
            off[i] = true;
            ctx.flag(i, "off-page");
            let dx = r.x.clamp(0.0, (page.w - r.w).max(0.0)) - r.x;
            let dy = r.y.clamp(0.0, (page.h - r.h).max(0.0)) - r.y;
            let fix = translate_fix(ctx, i, r2(dx), r2(dy)).map(|o| vec![o]);
            ctx.issue(
                Severity::Error,
                IssueCode::OffPage,
                "off-page",
                &[i],
                format!("{name} is completely outside the page."),
                Some("Move it onto the page or delete it.".into()),
                fix,
            );
            continue;
        }
        if ctx.scene.is_backdrop(i) {
            continue;
        }
        let pr = placement_box(ctx, i);
        let pinside = pr.intersection(&page).map(|x| x.area()).unwrap_or(0.0);
        let cut = pr.area() > 0.0 && pinside < pr.area() - 1.0;
        let top_level = it.depth == 0;
        if cut && top_level && it.kind() != NodeType::Line {
            ctx.flag(i, "overflows-page");
        }
        let important = is_important(ctx, i);
        if cut && important {
            let dx = if pr.x < 0.0 {
                -pr.x
            } else if pr.right() > page.w {
                page.w - pr.right()
            } else {
                0.0
            };
            let dy = if pr.y < 0.0 {
                -pr.y
            } else if pr.bottom() > page.h {
                page.h - pr.bottom()
            } else {
                0.0
            };
            let fits = pr.w <= page.w && pr.h <= page.h;
            let fix = if fits {
                translate_fix(ctx, i, dx, dy).map(|o| vec![o])
            } else {
                None
            };
            ctx.issue(
                Severity::Warn,
                IssueCode::OffPage,
                "cut-by-page",
                &[i],
                format!("{name} runs past the page edge and will be cut off."),
                Some("Move it fully onto the page, ideally inside the safe margin.".into()),
                fix,
            );
            continue;
        }
        // Safe area: only for important content that lies on the page (web pages and whiteboards have none).
        if important && !cut && !matches!(ctx.kind, DesignKind::Website | DesignKind::Whiteboard) {
            let intrudes = pr.x < sl - 0.5
                || pr.y < st - 0.5
                || pr.right() > page.w - sr + 0.5
                || pr.bottom() > page.h - sb + 0.5;
            if intrudes {
                ctx.flag(i, "unsafe-margin");
                let (safe_w, safe_h) = (page.w - sl - sr, page.h - st - sb);
                let dx = if pr.x < sl {
                    sl - pr.x
                } else if pr.right() > page.w - sr {
                    page.w - sr - pr.right()
                } else {
                    0.0
                };
                let dy = if pr.y < st {
                    st - pr.y
                } else if pr.bottom() > page.h - sb {
                    page.h - sb - pr.bottom()
                } else {
                    0.0
                };
                let fits = pr.w <= safe_w && pr.h <= safe_h;
                let fix = if fits {
                    translate_fix(ctx, i, r2(dx), r2(dy)).map(|o| vec![o])
                } else {
                    None
                };
                let what = if ctx.safe_source == "default" {
                    format!("the {}px safe margin", r1(sl.max(st)))
                } else {
                    format!("the {} safe area", ctx.safe_source)
                };
                ctx.issue(
                    Severity::Warn,
                    IssueCode::UnsafeMargin,
                    "unsafe-margin",
                    &[i],
                    format!("{name} sits inside {what}; keep text, logos and buttons away from the edges."),
                    Some("Move it inward so platform UI or trimming cannot cover it.".into()),
                    fix,
                );
            }
        }
    }
    missing_bleed(ctx);
}

/// Whether a box lies entirely outside the page. A box with no extent on one axis (a straight line) is on the page
/// when its segment touches it; a point-sized box is never reported.
pub(crate) fn entirely_outside(r: &Rect, page: &Rect) -> bool {
    if !(r.w > 0.0 || r.h > 0.0) {
        return false;
    }
    let touches = |start: f64, len: f64, p_start: f64, p_len: f64| {
        let overlap = (start + len).min(p_start + p_len) - start.max(p_start);
        if len > 0.0 {
            overlap > 0.0
        } else {
            overlap >= 0.0
        }
    };
    !(touches(r.x, r.w, page.x, page.w) && touches(r.y, r.h, page.y, page.h))
}

fn missing_bleed(ctx: &mut Ctx<'_>) {
    let bleed = ctx.scene.page.bleed;
    if bleed <= 0.0 {
        return;
    }
    let page = ctx.scene.page_rect;
    for i in ctx.scene.top.clone() {
        let it = &ctx.scene.items[i];
        if !it.visible {
            continue;
        }
        let paints = matches!(it.kind(), NodeType::Image | NodeType::Video)
            || it.node.fills().iter().any(|f| f.is_visible());
        if !paints || matches!(it.kind(), NodeType::Text | NodeType::Line) {
            continue;
        }
        let r = it.aabb;
        // Sides that stop exactly at the trim.
        let left = (r.x - page.x).abs() <= 1.0;
        let top = (r.y - page.y).abs() <= 1.0;
        let right = (r.right() - page.right()).abs() <= 1.0;
        let bottom = (r.bottom() - page.bottom()).abs() <= 1.0;
        if !(left || top || right || bottom) {
            continue;
        }
        let b = it.node.base();
        let fix = (it.rotation == 0.0 && it.axis_aligned_parents && !it.in_layout && !b.locked)
            .then(|| {
                let x = if left { b.x - bleed } else { b.x };
                let y = if top { b.y - bleed } else { b.y };
                let w = b.width + if left { bleed } else { 0.0 } + if right { bleed } else { 0.0 };
                let h = b.height + if top { bleed } else { 0.0 } + if bottom { bleed } else { 0.0 };
                vec![update(
                    it.id(),
                    json!({ "x": r2(x), "y": r2(y), "width": r2(w), "height": r2(h) }),
                )]
            });
        let sides: Vec<&str> = [
            (left, "left"),
            (top, "top"),
            (right, "right"),
            (bottom, "bottom"),
        ]
        .into_iter()
        .filter_map(|(on, s)| on.then_some(s))
        .collect();
        let name = ctx.name(i);
        ctx.flag(i, "missing-bleed");
        ctx.issue(
            Severity::Warn,
            IssueCode::UnsafeMargin,
            "missing-bleed",
            &[i],
            format!(
                "{name} stops at the trim on the {} edge; extend it {}px into the bleed so no white line shows after cutting.",
                sides.join(" / "),
                r1(bleed)
            ),
            Some("Extend edge-to-edge artwork past the page into the bleed.".into()),
            fix,
        );
    }
}

/// Alignment tolerance: up to this many px apart counts as "meant to align".
fn align_tol(ctx: &Ctx<'_>) -> f64 {
    let short = ctx.scene.page_rect.w.min(ctx.scene.page_rect.h);
    (short * 0.0056).clamp(3.0, 12.0)
}

/// Sibling sets whose positions are free (not owned by auto-layout).
pub(crate) fn sibling_sets(ctx: &Ctx<'_>) -> Vec<Vec<usize>> {
    let mut sets = Vec::new();
    let mut parents: Vec<Option<usize>> = vec![None];
    parents.extend(
        (0..ctx.scene.items.len())
            .filter(|i| {
                let it = &ctx.scene.items[*i];
                it.visible
                    && it.children.len() >= 2
                    && it.node.layout().is_none()
                    && it.kind() != NodeType::Boolean
            })
            .map(Some),
    );
    for p in parents {
        if p.is_none() && ctx.scene.page.container.layout.is_some() {
            continue;
        }
        let set: Vec<usize> = ctx
            .visible_children(p)
            .into_iter()
            .filter(|c| ctx.is_content(*c) && ctx.scene.items[*c].rotation == 0.0)
            .collect();
        if set.len() >= 2 {
            sets.push(set);
        }
    }
    sets
}

/// Near-miss edges / centers among siblings, and near-centered elements.
///
/// Per sibling set and axis, items that share a line exactly (within 1 px) form alignment lines. An item whose
/// left / center / right (top / middle / bottom) sits 1-`tol` px from a line it does not belong to is reported
/// once, against the line with the most members, and the fix snaps it onto that line. Left-aligned text only
/// counts its left edge (centered text its center, right-aligned text its right edge); centers and far edges need
/// items of comparable size; a shape and the content sitting on it are not compared.
pub fn alignment(ctx: &mut Ctx<'_>, grouping: &Grouping) {
    let tol = align_tol(ctx);
    let mut reported = 0usize;
    for set in sibling_sets(ctx) {
        let boxes: Vec<Rect> = set.iter().map(|i| placement_box(ctx, *i)).collect();
        let meaningful: Vec<[bool; 3]> = set
            .iter()
            .map(|i| match ctx.text(*i).map(|f| f.align) {
                Some(desyn_core::TextAlign::Left | desyn_core::TextAlign::Justify) => {
                    [true, false, false]
                }
                Some(desyn_core::TextAlign::Center) => [false, true, false],
                Some(desyn_core::TextAlign::Right) => [false, false, true],
                None => [true; 3],
            })
            .collect();
        let pos = |r: &Rect, axis: usize, k: usize| -> f64 {
            match (axis, k) {
                (0, 0) => r.x,
                (0, 1) => r.center_x(),
                (0, _) => r.right(),
                (_, 0) => r.y,
                (_, 1) => r.center_y(),
                _ => r.bottom(),
            }
        };
        let contains = |a: &Rect, b: &Rect| {
            let inter = a.intersection(b).map(|r| r.area()).unwrap_or(0.0);
            inter >= a.area().min(b.area()) * 0.9
        };
        let page = ctx.scene.page_rect;
        // (item, axis, k, delta, partners)
        let mut found: Vec<(usize, usize, usize, f64, Vec<usize>)> = Vec::new();
        for axis in 0..2 {
            // Pairs already sharing some line on this axis are aligned; other near-misses between them are noise.
            let aligned = |a: usize, b: usize| {
                (0..3).any(|k| (pos(&boxes[a], axis, k) - pos(&boxes[b], axis, k)).abs() <= 1.0)
            };
            let mut best: Vec<Option<(usize, f64, Vec<usize>)>> = vec![None; set.len()];
            for (k, _line) in ["start", "center", "end"].iter().enumerate() {
                let eligible = |a: usize| axis == 1 || meaningful[a][k];
                let related = |a: usize, b: usize| {
                    // Content on different surfaces (a label inside a button vs. text on the card) is inset on
                    // purpose.
                    if grouping.surface.get(&set[a]) != grouping.surface.get(&set[b]) {
                        return false;
                    }
                    let (ra, rb) = (boxes[a], boxes[b]);
                    if contains(&ra, &rb) {
                        return false;
                    }
                    let size = |r: &Rect| if axis == 0 { r.w } else { r.h };
                    let comparable = size(&ra).min(size(&rb)) >= size(&ra).max(size(&rb)) * 0.4;
                    if k != 0 && !comparable {
                        return false;
                    }
                    let gap = if axis == 0 {
                        (rb.y - ra.bottom()).max(ra.y - rb.bottom())
                    } else {
                        (rb.x - ra.right()).max(ra.x - rb.right())
                    };
                    gap <= if axis == 0 { page.h } else { page.w } * 0.35
                };
                // Exact lines (sorted sweep: items within 1 px of a line's first member join it).
                let mut sorted: Vec<(f64, usize)> = (0..set.len())
                    .filter(|a| eligible(*a))
                    .map(|a| (pos(&boxes[a], axis, k), a))
                    .collect();
                sorted.sort_by(|x, y| x.0.total_cmp(&y.0).then(x.1.cmp(&y.1)));
                let mut lines: Vec<(f64, Vec<usize>)> = Vec::new();
                let mut line_of = vec![usize::MAX; set.len()];
                for (p, a) in &sorted {
                    match lines.last_mut() {
                        Some(l) if p - l.0 <= 1.0 => l.1.push(*a),
                        _ => lines.push((*p, vec![*a])),
                    }
                    line_of[*a] = lines.len() - 1;
                }
                for (p, a) in sorted.iter().copied() {
                    let own = lines[line_of[a]].1.len();
                    // Lines within the tolerance (binary search on the sorted line positions).
                    let lo = lines.partition_point(|l| l.0 < p - tol - 1.0);
                    let hi = lines.partition_point(|l| l.0 <= p + tol + 1.0);
                    for (li, (lp, members)) in lines.iter().enumerate().take(hi).skip(lo) {
                        let d = lp - p;
                        if li == line_of[a] || d.abs() <= 1.0 || d.abs() > tol {
                            continue;
                        }
                        let partners: Vec<usize> = members
                            .iter()
                            .take(64)
                            .copied()
                            .filter(|b| related(a, *b) && !aligned(a, *b))
                            .collect();
                        if partners.is_empty() {
                            continue;
                        }
                        // The weaker line moves; on a tie the items painted later move (one report per pair).
                        let first_partner =
                            partners.iter().map(|p| set[*p]).min().unwrap_or(usize::MAX);
                        if own > partners.len() || (own == partners.len() && set[a] < first_partner)
                        {
                            continue;
                        }
                        let better = match &best[a] {
                            None => true,
                            Some((_, bd, bp)) => {
                                partners.len() > bp.len()
                                    || (partners.len() == bp.len() && d.abs() < bd.abs())
                            }
                        };
                        if better {
                            best[a] = Some((k, d, partners));
                        }
                    }
                }
            }
            for (a, b) in best.into_iter().enumerate() {
                if let Some((k, d, partners)) = b {
                    found.push((a, axis, k, d, partners));
                }
            }
        }
        for (a, axis, k, d, partners) in found {
            if reported >= 24 {
                return;
            }
            let item = set[a];
            let (dx, dy) = if axis == 0 { (d, 0.0) } else { (0.0, d) };
            let fix = translate_fix(ctx, item, r2(dx), r2(dy)).map(|o| vec![o]);
            let what = match (axis, k) {
                (0, 0) => "left edge",
                (0, 1) => "horizontal center",
                (0, _) => "right edge",
                (_, 0) => "top edge",
                (_, 1) => "vertical center",
                _ => "bottom edge",
            };
            let mut ids = vec![item];
            ids.extend(partners.iter().map(|p| set[*p]));
            for i in &ids {
                ctx.flag(*i, "misaligned");
            }
            let names: Vec<String> = partners.iter().take(3).map(|p| ctx.name(set[*p])).collect();
            let more = if partners.len() > 3 {
                format!(" and {} more", partners.len() - 3)
            } else {
                String::new()
            };
            let name = ctx.name(item);
            ctx.issue(
                Severity::Info,
                IssueCode::Misaligned,
                "misaligned",
                &ids,
                format!(
                    "{name} is {}px off the {what} it nearly shares with {}{more}.",
                    r1(d.abs()),
                    names.join(", ")
                ),
                Some(
                    "Snap it to the same line, or offset it clearly if the difference is intended."
                        .into(),
                ),
                fix,
            );
            reported += 1;
        }
    }
    off_center(ctx, tol);
}

fn off_center(ctx: &mut Ctx<'_>, tol: f64) {
    let page = ctx.scene.page_rect;
    for i in ctx.scene.top.clone() {
        if !ctx.is_content(i) || ctx.scene.items[i].rotation != 0.0 {
            continue;
        }
        // The box carries the centering intent (a left-aligned text box can be centered on the page).
        let r = ctx.scene.items[i].aabb;
        if r.w >= page.w * 0.95 {
            continue;
        }
        let d = page.center_x() - r.center_x();
        // Centered text paragraphs make the intent explicit; other elements need to be close and not edge-aligned.
        let centered_text = ctx
            .text(i)
            .is_some_and(|f| f.align == desyn_core::TextAlign::Center);
        let limit = if centered_text { tol * 2.0 } else { tol };
        if d.abs() > 1.0 && d.abs() <= limit {
            ctx.flag(i, "off-center");
            let fix = translate_fix(ctx, i, r2(d), 0.0).map(|o| vec![o]);
            let name = ctx.name(i);
            ctx.issue(
                Severity::Info,
                IssueCode::Misaligned,
                "off-center",
                &[i],
                format!(
                    "{name} is {}px off the page's horizontal center.",
                    r1(d.abs())
                ),
                Some("Center it exactly on the page.".into()),
                fix,
            );
        }
    }
}

/// Uneven gaps in repeated structures (lists, grids, nav bars) and near-equal stacks.
pub fn spacing(ctx: &mut Ctx<'_>, grouping: &Grouping) {
    // 1. Repeated structures must be exact.
    for g in &grouping.groups {
        if !matches!(
            g.kind,
            GroupKind::List | GroupKind::Grid | GroupKind::NavBar
        ) {
            continue;
        }
        let units: Vec<Vec<usize>> = if !g.parts.is_empty() {
            g.parts
                .iter()
                .filter_map(|p| grouping.groups.iter().find(|x| &x.id == p))
                .map(|x| {
                    x.ids
                        .iter()
                        .filter_map(|id| ctx.scene.by_id.get(id.as_str()).copied())
                        .collect()
                })
                .collect()
        } else if let Some(node) = g
            .node
            .as_ref()
            .and_then(|n| ctx.scene.by_id.get(n.as_str()).copied())
        {
            if ctx.scene.items[node].node.layout().is_some() {
                continue;
            }
            ctx.visible_children(Some(node))
                .into_iter()
                .filter(|c| ctx.is_content(*c))
                .map(|c| vec![c])
                .collect()
        } else {
            g.ids
                .iter()
                .filter_map(|id| ctx.scene.by_id.get(id.as_str()).copied())
                .filter(|i| ctx.text(*i).is_some() || ctx.elem(*i) != Elem::Shape)
                .map(|i| vec![i])
                .collect()
        };
        if units.len() < 3 {
            continue;
        }
        check_units(ctx, &units, true, &g.label);
    }
    // 2. Stacks of siblings with almost (but not exactly) equal gaps.
    for set in sibling_sets(ctx) {
        let mut stack: Vec<usize> = set
            .into_iter()
            .filter(|i| ctx.elem(*i) != Elem::Line)
            .collect();
        stack.sort_by(|a, b| ctx.bounds(*a).y.total_cmp(&ctx.bounds(*b).y));
        // Keep a vertical chain: consecutive items overlap horizontally and do not overlap vertically.
        let mut chain: Vec<usize> = Vec::new();
        for i in stack {
            if let Some(&last) = chain.last() {
                let (a, b) = (ctx.bounds(last), ctx.bounds(i));
                let ox = (a.right().min(b.right()) - a.x.max(b.x)).max(0.0);
                if ox <= 0.0 || b.y < a.bottom() - 0.5 {
                    continue;
                }
            }
            chain.push(i);
        }
        if chain.len() >= 4 {
            let units: Vec<Vec<usize>> = chain.into_iter().map(|i| vec![i]).collect();
            check_units(ctx, &units, false, "stack");
        }
    }
}

/// Gap check along the dominant axis of units (each unit moves as a whole).
fn check_units(ctx: &mut Ctx<'_>, units: &[Vec<usize>], strict: bool, label: &str) {
    let boxes: Vec<Rect> = units
        .iter()
        .map(|u| ctx.union_box(u).unwrap_or_default())
        .collect();
    let xs = boxes
        .iter()
        .map(|b| b.center_x())
        .fold((f64::INFINITY, f64::NEG_INFINITY), |a, v| {
            (a.0.min(v), a.1.max(v))
        });
    let ys = boxes
        .iter()
        .map(|b| b.center_y())
        .fold((f64::INFINITY, f64::NEG_INFINITY), |a, v| {
            (a.0.min(v), a.1.max(v))
        });
    let horizontal = xs.1 - xs.0 > ys.1 - ys.0;
    // Rows (horizontal) or columns (vertical) of units; gaps are measured inside each line.
    let mut order: Vec<usize> = (0..units.len()).collect();
    let main = |b: &Rect| if horizontal { b.x } else { b.y };
    let cross = |b: &Rect| {
        if horizontal {
            b.center_y()
        } else {
            b.center_x()
        }
    };
    order.sort_by(|a, b| {
        cross(&boxes[*a])
            .total_cmp(&cross(&boxes[*b]))
            .then(main(&boxes[*a]).total_cmp(&main(&boxes[*b])))
    });
    let mut lines: Vec<Vec<usize>> = Vec::new();
    for k in order {
        let tol = if horizontal {
            boxes[k].h * 0.5
        } else {
            boxes[k].w * 0.5
        };
        match lines.last_mut() {
            Some(l) if (cross(&boxes[l[0]]) - cross(&boxes[k])).abs() <= tol => l.push(k),
            _ => lines.push(vec![k]),
        }
    }
    let mut gaps: Vec<(usize, usize, f64)> = Vec::new();
    for l in &mut lines {
        l.sort_by(|a, b| main(&boxes[*a]).total_cmp(&main(&boxes[*b])));
        for w in l.windows(2) {
            let (a, b) = (boxes[w[0]], boxes[w[1]]);
            let gap = if horizontal {
                b.x - a.right()
            } else {
                b.y - a.bottom()
            };
            gaps.push((w[0], w[1], gap));
        }
    }
    if gaps.len() < 2 || gaps.iter().any(|g| g.2 < -0.5) {
        return;
    }
    let mut sorted: Vec<f64> = gaps.iter().map(|g| g.2).collect();
    sorted.sort_by(f64::total_cmp);
    let median = sorted[sorted.len() / 2];
    let (min, max) = (sorted[0], sorted[sorted.len() - 1]);
    let uneven = if strict {
        max - min > (median * 0.1).max(2.0)
    } else {
        // Loose stacks: flag only near-equal rhythms (intentional grouping uses clearly different gaps).
        let near = gaps
            .iter()
            .all(|g| (g.2 - median).abs() <= (median * 0.25).max(4.0));
        near && max - min > 2.0 && gaps.len() >= 3
    };
    if !uneven {
        return;
    }
    // Fix: keep the first unit of every line, place the others at the median gap.
    let mut fix = Vec::new();
    let mut fixable = true;
    for l in &lines {
        let mut pos = main(&boxes[l[0]])
            + if horizontal {
                boxes[l[0]].w
            } else {
                boxes[l[0]].h
            };
        for k in l.iter().skip(1) {
            let target = pos + median;
            let delta = target - main(&boxes[*k]);
            if delta.abs() > 0.01 {
                for m in &units[*k] {
                    let (dx, dy) = if horizontal {
                        (delta, 0.0)
                    } else {
                        (0.0, delta)
                    };
                    match translate_fix(ctx, *m, r2(dx), r2(dy)) {
                        Some(op) => fix.push(op),
                        None => fixable = false,
                    }
                }
            }
            pos = target + if horizontal { boxes[*k].w } else { boxes[*k].h };
        }
    }
    let items: Vec<usize> = units.iter().flatten().copied().collect();
    for i in &items {
        ctx.flag(*i, "uneven-spacing");
    }
    let axis = if horizontal { "Horizontal" } else { "Vertical" };
    ctx.issue(
        if strict {
            Severity::Warn
        } else {
            Severity::Info
        },
        IssueCode::UnevenSpacing,
        "uneven-spacing",
        &items,
        format!(
            "{axis} gaps in the {} vary from {} to {}px; use one consistent gap.",
            label.split(':').next().unwrap_or(label),
            r1(min),
            r1(max)
        ),
        Some(format!("Space them evenly at about {}px.", r1(median))),
        (fixable && !fix.is_empty()).then_some(fix),
    );
}
