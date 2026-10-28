//! Where colors and fonts are used: one record per paint (fill, gradient stop, text run, stroke), with the JSON
//! path that sets it (used by brand fixes) and an area weight (used by the palette).

use desyn_core::color::Rgba;
use desyn_core::{ColorValue, Fill, Node, NodeType, PathSeg};

use crate::ctx::Ctx;
use crate::lint::{idx, key};
use crate::paint;

/// Where a color is used.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, serde::Serialize, serde::Deserialize,
)]
#[serde(rename_all = "lowercase")]
pub enum ColorRole {
    /// Page background.
    Background,
    /// Shape / frame fill.
    Fill,
    /// Text color.
    Text,
    /// Stroke.
    Stroke,
}

/// One use of a color.
#[derive(Debug, Clone)]
pub struct ColorUse {
    /// Resolved color.
    pub color: Rgba,
    /// Item index (`None` = page background).
    pub item: Option<usize>,
    /// Use kind.
    pub role: ColorRole,
    /// Property path inside the node that holds this color (`["fills", 0, "color"]`), `None` when the color comes
    /// through a reference (`$var` / `$style`) or is not addressable.
    pub path: Option<Vec<PathSeg>>,
}

fn literal(v: &ColorValue) -> bool {
    matches!(v, ColorValue::Color(_))
}

fn fill_uses(
    fills: &[Fill],
    base: &[PathSeg],
    styles: &desyn_core::DesignStyles,
    item: Option<usize>,
    role: ColorRole,
    out: &mut Vec<ColorUse>,
) {
    for (k, f) in fills.iter().enumerate() {
        if !f.is_visible() {
            continue;
        }
        let mut p = base.to_vec();
        p.push(idx(k));
        match f {
            Fill::Solid(s) => {
                if let Some(c) = paint::resolve(&s.color, styles) {
                    let mut path = p.clone();
                    path.push(key("color"));
                    out.push(ColorUse {
                        color: c,
                        item,
                        role,
                        path: literal(&s.color).then_some(path),
                    });
                }
            }
            Fill::Image(_) => {}
            _ => {
                for (si, stop) in f.stops().unwrap_or(&[]).iter().enumerate() {
                    if let Some(c) = paint::resolve(&stop.color, styles) {
                        let mut path = p.clone();
                        path.extend([key("stops"), idx(si), key("color")]);
                        out.push(ColorUse {
                            color: c,
                            item,
                            role,
                            path: literal(&stop.color).then_some(path),
                        });
                    }
                }
            }
        }
    }
}

/// Every color use on visible nodes of the page (and the page background), in paint order.
pub fn color_uses(ctx: &Ctx<'_>) -> Vec<ColorUse> {
    let styles = &ctx.scene.design.styles;
    let mut out = Vec::new();
    fill_uses(
        &ctx.scene.page.background,
        &[key("background")],
        styles,
        None,
        ColorRole::Background,
        &mut out,
    );
    for (i, it) in ctx.scene.items.iter().enumerate() {
        if !it.visible {
            continue;
        }
        match it.node {
            Node::Text(t) => {
                if !ctx.text(i).is_some_and(|f| f.has_content()) {
                    continue;
                }
                let run_overrides = t
                    .runs
                    .iter()
                    .any(|r| r.style.as_ref().is_some_and(|s| s.fills.is_some()));
                let base_used = t.runs.iter().any(|r| {
                    r.style.as_ref().is_none_or(|s| s.fills.is_none())
                        && r.text.chars().any(|c| !c.is_whitespace())
                });
                if base_used || !run_overrides {
                    fill_uses(
                        &t.style.fills,
                        &[key("style"), key("fills")],
                        styles,
                        Some(i),
                        ColorRole::Text,
                        &mut out,
                    );
                }
                for (k, r) in t.runs.iter().enumerate() {
                    if let Some(fills) = r.style.as_ref().and_then(|s| s.fills.as_ref())
                        && r.text.chars().any(|c| !c.is_whitespace())
                    {
                        fill_uses(
                            fills,
                            &[key("runs"), idx(k), key("style"), key("fills")],
                            styles,
                            Some(i),
                            ColorRole::Text,
                            &mut out,
                        );
                    }
                }
            }
            Node::Qr(q) => {
                out.push(ColorUse {
                    color: Rgba::from_color(&q.fg),
                    item: Some(i),
                    role: ColorRole::Fill,
                    path: Some(vec![key("fg")]),
                });
                out.push(ColorUse {
                    color: Rgba::from_color(&q.bg),
                    item: Some(i),
                    role: ColorRole::Fill,
                    path: Some(vec![key("bg")]),
                });
            }
            Node::Chart(c) => {
                for (k, col) in c.options.palette.iter().enumerate() {
                    out.push(ColorUse {
                        color: Rgba::from_color(col),
                        item: Some(i),
                        role: ColorRole::Fill,
                        path: Some(vec![key("options"), key("palette"), idx(k)]),
                    });
                }
            }
            n => fill_uses(
                n.fills(),
                &[key("fills")],
                styles,
                Some(i),
                ColorRole::Fill,
                &mut out,
            ),
        }
        if it.kind() != NodeType::Text || ctx.text(i).is_some_and(|f| f.has_content()) {
            for (k, s) in it.node.strokes().iter().enumerate() {
                if s.is_visible() && s.width > 0.0 {
                    fill_uses(
                        &s.fills,
                        &[key("strokes"), idx(k), key("fills")],
                        styles,
                        Some(i),
                        ColorRole::Stroke,
                        &mut out,
                    );
                }
            }
        }
    }
    out
}

/// Font families used by visible text with content: `(family, weight, item, run index or None for the node
/// style)`.
pub fn font_uses(ctx: &Ctx<'_>) -> Vec<(String, f64, usize, Option<usize>)> {
    let mut out = Vec::new();
    for (i, it) in ctx.scene.items.iter().enumerate() {
        let Node::Text(t) = it.node else { continue };
        if !it.visible || !ctx.text(i).is_some_and(|f| f.has_content()) {
            continue;
        }
        let mut base_used = false;
        for (k, r) in t.runs.iter().enumerate() {
            if !r.text.chars().any(|c| !c.is_whitespace()) {
                continue;
            }
            match r.style.as_ref().and_then(|s| s.font_family.clone()) {
                Some(f) if f != t.style.font_family => {
                    let w = r
                        .style
                        .as_ref()
                        .and_then(|s| s.font_weight)
                        .unwrap_or(t.style.font_weight);
                    out.push((f, w, i, Some(k)));
                }
                _ => base_used = true,
            }
        }
        if base_used || t.runs.is_empty() {
            out.push((t.style.font_family.clone(), t.style.font_weight, i, None));
        }
        // Weights of runs in the node family.
        for r in &t.runs {
            if let Some(w) = r.style.as_ref().and_then(|s| s.font_weight)
                && r.style
                    .as_ref()
                    .and_then(|s| s.font_family.as_ref())
                    .is_none_or(|f| *f == t.style.font_family)
                && w != t.style.font_weight
            {
                out.push((t.style.font_family.clone(), w, i, None));
            }
        }
    }
    out
}
