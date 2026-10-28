//! Style rules: font and size count, color count, hierarchy, brand palette and fonts.

use std::collections::BTreeMap;

use desyn_core::Color;
use desyn_core::color::Rgba;
use serde_json::json;

use super::{key, patch, r1};
use crate::ctx::Ctx;
use crate::options::BrandKit;
use crate::paint::{chroma, delta_e, hex6};
use crate::summary;
use crate::types::{IssueCode, Severity};
use crate::usage::{color_uses, font_uses};

fn text_items(ctx: &Ctx<'_>) -> Vec<usize> {
    (0..ctx.scene.items.len())
        .filter(|i| ctx.scene.items[*i].visible && ctx.text(*i).is_some_and(|f| f.has_content()))
        .collect()
}

/// More than three families; more than six sizes.
pub fn fonts(ctx: &mut Ctx<'_>) {
    let fonts = summary::fonts(ctx);
    let texts = text_items(ctx);
    if fonts.len() > 3 {
        let names: Vec<&str> = fonts.iter().map(|f| f.family.as_str()).collect();
        ctx.issue(
            Severity::Warn,
            IssueCode::TooManyFonts,
            "too-many-fonts",
            &texts,
            format!(
                "{} font families are used ({}); limit to two (three at most).",
                fonts.len(),
                names.join(", ")
            ),
            Some("Pick one display and one text family and restyle the rest.".into()),
            None,
        );
    }
    let sizes = summary::size_usage(ctx);
    // Sizes within half a pixel read as one.
    let mut distinct: Vec<f64> = Vec::new();
    for (s, _) in &sizes {
        if distinct.last().is_none_or(|d| (d - s).abs() > 0.5) {
            distinct.push(*s);
        }
    }
    if distinct.len() > 6 {
        let list: Vec<String> = distinct.iter().map(|s| format!("{}", r1(*s))).collect();
        ctx.issue(
            Severity::Info,
            IssueCode::TooManyFonts,
            "too-many-sizes",
            &texts,
            format!("{} different text sizes are used ({}px); a scale of four to five sizes reads calmer.", distinct.len(), list.join("/")),
            Some("Snap sizes to a type scale (e.g. 1.25 or 1.333 ratio).".into()),
            None,
        );
    }
}

/// More than seven distinct colors.
pub fn colors(ctx: &mut Ctx<'_>) {
    let (_, distinct) = summary::palette(ctx);
    if distinct > 7 {
        ctx.issue(
            Severity::Info,
            IssueCode::TooManyColors,
            "too-many-colors",
            &[],
            format!(
                "{distinct} distinct colors are in use; a focused palette of 3–5 reads better."
            ),
            Some("Reuse a few brand or palette colors and tints of them.".into()),
            None,
        );
    }
}

/// The largest text barely bigger than the body, or two elements competing for attention.
pub fn hierarchy(ctx: &mut Ctx<'_>) {
    let texts = text_items(ctx);
    if texts.len() < 2 {
        return;
    }
    let t = summary::typography(ctx);
    if let Some(ratio) = t.ratio
        && ratio < 1.4
    {
        ctx.issue(
            Severity::Warn,
            IssueCode::WeakHierarchy,
            "weak-hierarchy",
            &texts,
            format!("The largest text is only {ratio}x the body size; make the headline clearly dominant (1.6x or more)."),
            Some("Enlarge or embolden the headline, or reduce the supporting text.".into()),
            None,
        );
        return;
    }
    // Two texts of the same top weight compete (only when they are not the same role / part of a repeated list).
    let mut ranked: Vec<usize> = texts.clone();
    ranked.sort_by(|a, b| ctx.weights[*b].total_cmp(&ctx.weights[*a]).then(a.cmp(b)));
    if let [a, b, ..] = ranked[..]
        && ctx.weights[a] > 0.0
        && ctx.weights[b] >= ctx.weights[a] * 0.97
        && ctx.text(a).map(|f| f.style().font_size) == ctx.text(b).map(|f| f.style().font_size)
        && ranked.len() == 2
    {
        let (na, nb) = (ctx.name(a), ctx.name(b));
        ctx.issue(
            Severity::Info,
            IssueCode::WeakHierarchy,
            "weak-hierarchy",
            &[a, b],
            format!(
                "{na} and {nb} carry the same visual weight; it is unclear which to read first."
            ),
            Some("Make one of them the clear headline.".into()),
            None,
        );
    }
}

/// One off-brand color and where it is used.
struct OffColor {
    color: Rgba,
    /// Index of the nearest brand color.
    nearest: usize,
    /// `(item or None for the page background, property path, alpha of the use)` of every literal use (fixable).
    paths: Vec<(Option<usize>, Vec<desyn_core::PathSeg>, f64)>,
    items: Vec<usize>,
    /// The page background uses it.
    page: bool,
}

/// Off-palette colors and off-brand fonts.
pub fn brand(ctx: &mut Ctx<'_>, kit: &BrandKit) {
    if !kit.colors.is_empty() {
        let palette: Vec<(Rgba, String)> = kit
            .colors
            .iter()
            .map(|c| {
                let label = c
                    .name
                    .clone()
                    .or_else(|| c.role.clone())
                    .unwrap_or_else(|| c.value.as_str().to_string());
                (Rgba::from_color(&c.value), label)
            })
            .collect();
        // Off-brand colors grouped by color (first use order).
        let mut groups: Vec<OffColor> = Vec::new();
        for u in color_uses(ctx) {
            let c = u.color.with_alpha(1.0);
            // Neutrals (black, white, greys) are always allowed.
            if chroma(c) < 0.02 {
                continue;
            }
            let (best, dist) = palette
                .iter()
                .enumerate()
                .map(|(k, p)| (k, delta_e(p.0, c)))
                .min_by(|a, b| a.1.total_cmp(&b.1))
                .expect("palette");
            if dist <= 0.05 {
                continue;
            }
            let entry = match groups.iter_mut().position(|g| delta_e(g.color, c) < 0.01) {
                Some(p) => &mut groups[p],
                None => {
                    groups.push(OffColor {
                        color: c,
                        nearest: best,
                        paths: Vec::new(),
                        items: Vec::new(),
                        page: false,
                    });
                    groups.last_mut().expect("group")
                }
            };
            match u.item {
                Some(item) if !entry.items.contains(&item) => entry.items.push(item),
                Some(_) => {}
                None => entry.page = true,
            }
            if let Some(path) = u.path {
                entry.paths.push((u.item, path, u.color.a));
            }
        }
        let page_id = ctx.scene.page.base.id.clone();
        for OffColor {
            color: c,
            nearest: best,
            paths,
            items,
            page,
        } in groups
        {
            let target = &palette[best];
            for i in &items {
                ctx.flag(*i, "off-brand-color");
            }
            // The brand color replaces the hue; each use keeps its own transparency.
            let value = |alpha: f64| {
                let t = target.0;
                let byte = |v: f64| (v.clamp(0.0, 1.0) * 255.0).round() as u8;
                json!(Color::from_rgba8(byte(t.r), byte(t.g), byte(t.b), byte(alpha)).as_str())
            };
            let fix: Vec<desyn_core::Op> = paths
                .iter()
                .map(|(i, path, alpha)| {
                    let id = match i {
                        Some(i) => ctx.scene.items[*i].id(),
                        None => page_id.as_str(),
                    };
                    patch(id, path, value(*alpha))
                })
                .collect();
            let mut ids: Vec<String> = Vec::new();
            if page {
                ids.push(page_id.clone());
            }
            ids.extend(ctx.ids(&items));
            ctx.issue_with_ids(
                Severity::Warn,
                IssueCode::TooManyColors,
                "off-brand-color",
                ids,
                format!(
                    "{} is not in the {} palette; the closest brand color is {} ({}).",
                    hex6(c),
                    if kit.name.is_empty() {
                        "brand"
                    } else {
                        kit.name.as_str()
                    },
                    hex6(target.0),
                    target.1
                ),
                Some(format!(
                    "Replace it with {} or another brand color.",
                    hex6(target.0)
                )),
                (!fix.is_empty()).then_some(fix),
            );
        }
    }
    if !kit.fonts.is_empty() {
        let allowed: Vec<String> = kit
            .fonts
            .iter()
            .map(|f| f.family.trim().to_lowercase())
            .collect();
        let heading = kit
            .fonts
            .iter()
            .find(|f| f.role.as_deref() == Some("heading"))
            .or(kit.fonts.first())
            .map(|f| f.family.clone());
        let body = kit
            .fonts
            .iter()
            .find(|f| f.role.as_deref() == Some("body"))
            .or(kit.fonts.last())
            .map(|f| f.family.clone());
        let body_size = summary::typography(ctx).body_size.unwrap_or(16.0);
        let mut by_family: BTreeMap<String, (String, Vec<usize>, Vec<desyn_core::Op>)> =
            BTreeMap::new();
        let mut order: Vec<String> = Vec::new();
        for (family, _w, item, run) in font_uses(ctx) {
            if allowed.contains(&family.trim().to_lowercase()) {
                continue;
            }
            let is_heading = ctx.scene.items[item]
                .role()
                .is_some_and(|r| matches!(r, "headline" | "subhead" | "slide-title" | "eyebrow"))
                || ctx
                    .text(item)
                    .is_some_and(|f| f.style().font_size >= body_size * 1.5);
            let target = if is_heading {
                heading.clone()
            } else {
                body.clone()
            }
            .unwrap_or_default();
            let id = ctx.scene.items[item].id().to_string();
            let e = by_family.entry(family.clone()).or_insert_with(|| {
                order.push(family.clone());
                (target.clone(), Vec::new(), Vec::new())
            });
            if !e.1.contains(&item) {
                e.1.push(item);
            }
            let op = match run {
                None => patch(&id, &[key("style"), key("fontFamily")], json!(target)),
                Some(k) => patch(
                    &id,
                    &[key("runs"), super::idx(k), key("style"), key("fontFamily")],
                    json!(target),
                ),
            };
            if !e.2.contains(&op) {
                e.2.push(op);
            }
        }
        let brand_names: Vec<&str> = kit.fonts.iter().map(|f| f.family.as_str()).collect();
        for family in order {
            let (target, items, fix) = by_family.remove(&family).expect("family");
            for i in &items {
                ctx.flag(*i, "off-brand-font");
            }
            ctx.issue(
                Severity::Warn,
                IssueCode::TooManyFonts,
                "off-brand-font",
                &items,
                format!("{family} is not a brand font ({}).", brand_names.join(", ")),
                Some(format!("Use {target} instead.")),
                Some(fix),
            );
        }
    }
}
