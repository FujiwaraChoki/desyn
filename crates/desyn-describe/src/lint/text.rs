//! Text rules: contrast, size, overflow / truncation / clipping, orphans and widows, overlaps.

use desyn_core::geometry::{Point, Rect};
use desyn_core::{AutoResize, NodeType};
use serde_json::json;

use super::{idx, key, patch, r1, update};
use crate::ctx::Ctx;
use crate::paint::{contrast_over, ensure_contrast, hex6};
use crate::types::{IssueCode, Severity};
use desyn_core::color::Rgba;

/// Roles whose text is intentionally quiet (watermarks, decorative type).
const QUIET_ROLES: &[&str] = &["watermark", "decoration", "pattern"];

/// Page-space ink box of a text item.
pub(crate) fn ink_box(ctx: &Ctx<'_>, i: usize) -> Rect {
    let it = &ctx.scene.items[i];
    let b = it.node.base();
    let ink = ctx
        .text(i)
        .map(|f| f.ink)
        .filter(|r| r.w > 0.0 && r.h > 0.0)
        .unwrap_or(Rect::new(0.0, 0.0, b.width, b.height));
    it.world.transform_rect_bbox(&ink)
}

/// Per-text checks.
pub fn checks(ctx: &mut Ctx<'_>) {
    for i in 0..ctx.scene.items.len() {
        let Some(f) = ctx.text(i).cloned() else {
            continue;
        };
        let it = &ctx.scene.items[i];
        if !it.visible || !f.has_content() {
            continue;
        }
        let quiet = it.role().is_some_and(|r| QUIET_ROLES.contains(&r));
        let id = it.id().to_string();
        let name = ctx.name(i);
        let node = match it.node {
            desyn_core::Node::Text(t) => t,
            _ => continue,
        };

        // Tiny text.
        if !quiet && f.min_size < ctx.min_text - 0.01 {
            ctx.flag(i, "tiny-text");
            let min = r1(ctx.min_text.ceil());
            let mut fix = Vec::new();
            if node.style.font_size < min {
                fix.push(patch(&id, &[key("style"), key("fontSize")], json!(min)));
            }
            for (k, run) in node.runs.iter().enumerate() {
                if run
                    .style
                    .as_ref()
                    .and_then(|s| s.font_size)
                    .is_some_and(|s| s < min)
                {
                    fix.push(patch(
                        &id,
                        &[key("runs"), idx(k), key("style"), key("fontSize")],
                        json!(min),
                    ));
                }
            }
            let kind = ctx.kind.as_str();
            ctx.issue(
                Severity::Warn,
                IssueCode::TinyText,
                "tiny-text",
                &[i],
                format!(
                    "{name} is {}px; the minimum readable size for a {kind} {} is about {min}px.",
                    r1(f.min_size),
                    if ctx.print {
                        "in print"
                    } else {
                        "at this size"
                    }
                ),
                Some(format!(
                    "Increase the text to at least {min}px or cut the copy."
                )),
                (!fix.is_empty()).then_some(fix),
            );
        }

        // Contrast.
        if let Some(c) = ctx.contrast[i]
            && !quiet
        {
            if c.unknown {
                ctx.flag(i, "on-image");
            } else if c.ratio < c.target {
                ctx.flag(i, "low-contrast");
                // Repair only what fails on the worst backdrop, each paint keeping its own hue: the node style
                // (runs without their own fills) and every run override that fails. When the layer is so
                // transparent that no color gets there, the node's own opacity goes back to 1 as well.
                let layer = ctx.scene.items[i].opacity;
                let own_opacity = node.base.opacity.clamp(0.0, 1.0);
                let visible =
                    |r: &crate::text::StyledRun| r.text.chars().any(|ch| !ch.is_whitespace());
                let own_fills = |k: usize| {
                    node.runs
                        .get(k)
                        .and_then(|r| r.style.as_ref())
                        .is_some_and(|s| s.fills.is_some())
                };
                let solid = |color: Rgba| json!([{ "type": "solid", "color": hex6(color) }]);
                let plan = |layer: f64| -> Option<(Vec<desyn_core::Op>, Option<Rgba>)> {
                    let ratio_of = |r: &crate::text::StyledRun| {
                        r.ink(layer)
                            .map(|fg| contrast_over(fg, r.on(c.backdrop)))
                            .unwrap_or(f64::INFINITY)
                    };
                    let mut ops = Vec::new();
                    let mut first: Option<Rgba> = None;
                    let base_worst = f
                        .runs
                        .iter()
                        .enumerate()
                        .filter(|(k, r)| !own_fills(*k) && visible(r) && ratio_of(r) < c.target)
                        .min_by(|a, b| ratio_of(a.1).total_cmp(&ratio_of(b.1)));
                    if let Some((_, r)) = base_worst {
                        let fixed = repaired(r, layer, c.backdrop, c.target)?;
                        first = Some(fixed);
                        ops.push(patch(&id, &[key("style"), key("fills")], solid(fixed)));
                    }
                    for (k, r) in f.runs.iter().enumerate() {
                        if own_fills(k) && visible(r) && ratio_of(r) < c.target {
                            let fixed = repaired(r, layer, c.backdrop, c.target)?;
                            first.get_or_insert(fixed);
                            ops.push(patch(
                                &id,
                                &[key("runs"), idx(k), key("style"), key("fills")],
                                solid(fixed),
                            ));
                        }
                    }
                    Some((ops, first))
                };
                let (fix, suggested) = match plan(layer) {
                    Some(p) => p,
                    None if own_opacity < 1.0 && own_opacity > 0.0 => {
                        match plan((layer / own_opacity).min(1.0)) {
                            Some((mut ops, first)) => {
                                ops.insert(0, update(&id, json!({ "opacity": 1 })));
                                (ops, first)
                            }
                            None => (Vec::new(), None),
                        }
                    }
                    None => (Vec::new(), None),
                };
                let fixed = suggested
                    .unwrap_or_else(|| ensure_contrast(c.fg.with_alpha(1.0), c.bg, c.target + 0.2));
                let on = if c.on_image {
                    "on the image behind it".to_string()
                } else {
                    format!("on {}", hex6(c.bg))
                };
                ctx.issue(
                    if c.ratio < c.target * 0.7 { Severity::Error } else { Severity::Warn },
                    IssueCode::LowContrast,
                    "low-contrast",
                    &[i],
                    format!("{name} has {}:1 contrast {on} (needs {}:1).", (c.ratio * 100.0).round() / 100.0, c.target),
                    Some(format!(
                        "Use {} for the text or change the background; a scrim or shadow also works on photos.",
                        hex6(fixed)
                    )),
                    (!fix.is_empty()).then_some(fix),
                );
            } else if c.on_image
                && let Some(x) = c.extreme
                && x < c.target * 0.6
            {
                ctx.flag(i, "busy-background");
                ctx.issue(
                    Severity::Warn,
                    IssueCode::LowContrast,
                    "busy-background",
                    &[i],
                    format!(
                        "{name} averages {}:1 on its photo, but parts of the photo drop to {}:1.",
                        (c.ratio * 100.0).round() / 100.0,
                        (x * 100.0).round() / 100.0
                    ),
                    Some("Add a scrim or text shadow behind the text, or move it to a calmer part of the image.".into()),
                    None,
                );
            } else if c.on_image {
                ctx.flag(i, "on-image");
            }
        }

        // Overflow / truncation / clipping.
        if f.overflows {
            ctx.flag(i, "text-overflow");
            let need = f.content_height.ceil();
            ctx.issue(
                Severity::Warn,
                IssueCode::TextOverflow,
                "text-overflow",
                &[i],
                format!(
                    "{name} needs about {need}px of height but its box is {}px.",
                    node.base.height.round()
                ),
                Some("Let the box grow with its text, shorten the copy or reduce the size.".into()),
                Some(vec![update(
                    &id,
                    json!({ "height": need, "autoResize": AutoResize::Height.as_str() }),
                )]),
            );
        } else if f.truncated {
            ctx.flag(i, "truncated");
            ctx.issue(
                Severity::Info,
                IssueCode::TextOverflow,
                "text-truncated",
                &[i],
                format!(
                    "{name} wraps to more lines than its limit of {} and ends with an ellipsis.",
                    node.max_lines.unwrap_or(0)
                ),
                Some("Shorten the copy or allow more lines if every word matters.".into()),
                None,
            );
        }
        if let Some(clipper) = clipping_ancestor(ctx, i) {
            ctx.flag(i, "clipped");
            let cname = ctx.name(clipper);
            ctx.issue(
                Severity::Warn,
                IssueCode::TextOverflow,
                "text-clipped",
                &[i, clipper],
                format!("{name} is cut off by the edges of {cname}, which clips its content."),
                Some(
                    "Move the text inside the frame, enlarge the frame or turn clipping off."
                        .into(),
                ),
                None,
            );
        }

        // Orphans and widows.
        orphans(ctx, i, &f, &name);
    }
}

/// Opaque replacement for a run's glyph color that reaches `target` on its backdrop through a layer of opacity
/// `layer` (hue kept; black or white when the hue cannot get there; `None` when nothing can).
fn repaired(run: &crate::text::StyledRun, layer: f64, backdrop: Rgba, target: f64) -> Option<Rgba> {
    let bg = run.on(backdrop);
    let fg = run.color.unwrap_or(Rgba::BLACK).with_alpha(1.0);
    let c = ensure_contrast(fg, bg, target + 0.2);
    if contrast_over(c.with_alpha(layer), bg) >= target {
        return Some(c);
    }
    [Rgba::BLACK, Rgba::WHITE]
        .into_iter()
        .filter(|k| contrast_over(k.with_alpha(layer), bg) >= target)
        .max_by(|a, b| {
            contrast_over(a.with_alpha(layer), bg)
                .total_cmp(&contrast_over(b.with_alpha(layer), bg))
        })
}

/// Nearest ancestor (below the page) whose clipping cuts into the text's ink.
fn clipping_ancestor(ctx: &Ctx<'_>, i: usize) -> Option<usize> {
    let ink = ink_box(ctx, i);
    ctx.scene.ancestors(i).into_iter().find(|a| {
        let p = &ctx.scene.items[*a];
        p.node.clips() && p.node.node_type() != NodeType::Page && {
            let pb = p.aabb;
            ink.x < pb.x - 0.5
                || ink.y < pb.y - 0.5
                || ink.right() > pb.right() + 0.5
                || ink.bottom() > pb.bottom() + 0.5
        }
    })
}

fn orphans(ctx: &mut Ctx<'_>, i: usize, f: &crate::text::TextFacts, name: &str) {
    let headline = f.max_size >= ctx.min_text * 1.6;
    let mut paragraphs: Vec<Vec<&crate::text::LineFact>> = Vec::new();
    for l in &f.lines {
        if paragraphs
            .last()
            .is_none_or(|p| p[0].paragraph != l.paragraph)
        {
            paragraphs.push(Vec::new());
        }
        paragraphs.last_mut().expect("paragraph").push(l);
    }
    for p in &paragraphs {
        if p.len() < 2 || (!headline && p.len() > 4) {
            continue;
        }
        let last = p[p.len() - 1];
        let widest = p.iter().map(|l| l.width).fold(0.0, f64::max);
        let words: usize = p.iter().map(|l| l.words).sum();
        if !last.ellipsis && last.words == 1 && words >= 4 && last.width < widest * 0.4 {
            ctx.flag(i, "orphan-line");
            ctx.issue(
                Severity::Info,
                IssueCode::OrphanLine,
                "orphan-line",
                &[i],
                format!("{name} ends a paragraph with a single short word on its own line."),
                Some(
                    "Rebalance the line breaks: adjust the box width slightly or edit the copy."
                        .into(),
                ),
                None,
            );
            return;
        }
    }
    // Widow: the box cuts off right after the first line of a paragraph.
    if f.truncated || f.overflows {
        let node_h = ctx.scene.items[i].node.base().height;
        let visible: Vec<&crate::text::LineFact> = f
            .lines
            .iter()
            .filter(|l| l.top + l.height <= node_h + 0.5)
            .collect();
        if let Some(last) = visible.last() {
            let first_of_paragraph = f
                .lines
                .iter()
                .position(|l| l.paragraph == last.paragraph)
                .is_some_and(|k| std::ptr::eq(&f.lines[k], *last));
            let more = f
                .lines
                .iter()
                .filter(|l| l.paragraph == last.paragraph)
                .count()
                > 1;
            if first_of_paragraph && more && visible.len() > 1 {
                ctx.flag(i, "widow-line");
                ctx.issue(
                    Severity::Info,
                    IssueCode::OrphanLine,
                    "widow-line",
                    &[i],
                    format!("{name} shows only the first line of its last visible paragraph before the box cuts off."),
                    Some("Give the text more room or end the visible text at a paragraph break.".into()),
                    None,
                );
            }
        }
    }
}

/// Most overlap partners reported per text.
const MAX_OVERLAPS_PER_TEXT: usize = 3;
/// Most overlap issues per page.
const MAX_OVERLAP_ISSUES: usize = 50;

/// Text blocks overlapping each other, and text partly hidden under other elements.
pub fn overlaps(ctx: &mut Ctx<'_>) {
    let texts: Vec<(usize, Rect)> = (0..ctx.scene.items.len())
        .filter(|i| ctx.scene.items[*i].visible && ctx.text(*i).is_some_and(|f| f.has_content()))
        .map(|i| (i, ink_box(ctx, i)))
        .collect();
    // Sweep on x so dense pages stay near-linear.
    let mut by_x = texts.clone();
    by_x.sort_by(|a, b| a.1.x.total_cmp(&b.1.x).then(a.0.cmp(&b.0)));
    let mut pairs = Vec::new();
    'sweep: for a in 0..by_x.len() {
        for b in a + 1..by_x.len() {
            if by_x[b].1.x > by_x[a].1.right() {
                break;
            }
            let (ia, ra) = by_x[a];
            let (ib, rb) = by_x[b];
            let inter = ra.intersection(&rb).map(|r| r.area()).unwrap_or(0.0);
            if inter > ra.area().min(rb.area()) * 0.1 {
                pairs.push(if ia < ib { (ia, ib) } else { (ib, ia) });
                if pairs.len() >= 20_000 {
                    break 'sweep;
                }
            }
        }
    }
    pairs.sort_unstable();
    // Report each text with at most a few partners and cap the total: a pile of stacked copies is one problem.
    let mut per_item = std::collections::HashMap::<usize, usize>::new();
    let pairs: Vec<(usize, usize)> = pairs
        .into_iter()
        .filter(|(a, b)| {
            let ok = per_item.get(a).copied().unwrap_or(0) < MAX_OVERLAPS_PER_TEXT
                && per_item.get(b).copied().unwrap_or(0) < MAX_OVERLAPS_PER_TEXT;
            if ok {
                *per_item.entry(*a).or_default() += 1;
                *per_item.entry(*b).or_default() += 1;
            }
            ok
        })
        .take(MAX_OVERLAP_ISSUES)
        .collect();
    for (a, b) in pairs {
        let (ida, idb) = (
            ctx.scene.items[a].id().to_string(),
            ctx.scene.items[b].id().to_string(),
        );
        ctx.flag(a, format!("overlaps:{idb}"));
        ctx.flag(b, format!("overlaps:{ida}"));
        let (na, nb) = (ctx.name(a), ctx.name(b));
        ctx.issue(
            Severity::Warn,
            IssueCode::Overlap,
            "overlap",
            &[a, b],
            format!("{na} and {nb} overlap."),
            Some("Separate the text blocks or merge them into one text layer.".into()),
            None,
        );
    }

    // Text covered by something painted above it.
    for (t, ink) in texts {
        let tz = ctx.scene.items[t].z;
        let probes = [
            Point::new(ink.x + ink.w * 0.5, ink.y + ink.h * 0.5),
            Point::new(ink.x + ink.w * 0.15, ink.y + ink.h * 0.5),
            Point::new(ink.x + ink.w * 0.85, ink.y + ink.h * 0.5),
        ];
        let mut cover: Option<usize> = None;
        for p in probes {
            for c in ctx.scene.candidates_at(p) {
                let it = &ctx.scene.items[c];
                if c <= tz
                    || !it.visible
                    || it.opacity < 0.5
                    || matches!(
                        it.kind(),
                        NodeType::Text | NodeType::Line | NodeType::Group | NodeType::Svg
                    )
                {
                    continue;
                }
                let inter = it
                    .visible_box()
                    .and_then(|r| r.intersection(&ink))
                    .map(|r| r.area())
                    .unwrap_or(0.0);
                if inter < ink.area() * 0.15 || !paints_solid(ctx, c) {
                    continue;
                }
                if ctx.scene.paint_contains(c, p) {
                    cover = Some(c);
                    break;
                }
            }
            if cover.is_some() {
                break;
            }
        }
        if let Some(c) = cover {
            let cid = ctx.scene.items[c].id().to_string();
            ctx.flag(t, format!("covered-by:{cid}"));
            let (nt, nc) = (ctx.name(t), ctx.name(c));
            ctx.issue(
                Severity::Error,
                IssueCode::Overlap,
                "text-covered",
                &[t, c],
                format!("{nt} is partly hidden under {nc}."),
                Some("Bring the text forward or move the element that covers it.".into()),
                None,
            );
        }
    }
}

/// Whether the node paints an opaque-enough fill (images count).
fn paints_solid(ctx: &Ctx<'_>, i: usize) -> bool {
    let n = ctx.scene.items[i].node;
    match n.node_type() {
        NodeType::Image | NodeType::Video | NodeType::Qr | NodeType::Chart | NodeType::Table => {
            true
        }
        _ => n
            .fills()
            .iter()
            .any(|f| f.is_visible() && f.flags().opacity.unwrap_or(1.0) >= 0.5),
    }
}
