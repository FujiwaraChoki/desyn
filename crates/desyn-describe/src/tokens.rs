//! Design tokens: the palette with usage counts, the type scale, the spacing scale and corner radii actually used,
//! plus the named styles the design defines.

use std::collections::BTreeMap;

use desyn_core::color::Rgba;
use desyn_core::geometry::Rect;
use desyn_core::{Color, NodeType};
use serde::{Deserialize, Serialize};

use crate::ctx::Ctx;
use crate::lint::r2;
use crate::paint::{delta_e, hex6};
use crate::usage::{ColorRole, color_uses};

/// Design tokens.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DesignTokens {
    /// Colors by number of nodes using them (desc), then color.
    pub palette: Vec<ColorToken>,
    /// Text sizes, largest first.
    pub type_scale: Vec<TypeToken>,
    /// Gaps and paddings, smallest first.
    pub spacing_scale: Vec<SpacingToken>,
    /// Corner radii, smallest first.
    pub radii: Vec<SpacingToken>,
    /// Named color styles (`Design.styles.colors`).
    pub color_styles: Vec<NamedColor>,
    /// Named text styles (`Design.styles.text`).
    pub text_styles: Vec<NamedText>,
}

/// One palette color.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColorToken {
    /// `#rrggbb`.
    pub color: String,
    /// Nodes using it (the page background counts as one).
    pub count: usize,
    /// How it is used.
    pub roles: Vec<ColorRole>,
    /// Name of the matching color style, if any.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub style: Option<String>,
}

/// One text size.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TypeToken {
    /// Size in px.
    pub size: f64,
    /// Text nodes using it.
    pub count: usize,
    /// Visible characters set in it.
    pub chars: usize,
    /// Families at this size.
    pub families: Vec<String>,
    /// Weights at this size.
    pub weights: Vec<f64>,
    /// Roles of the nodes at this size (explicit roles only).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub roles: Vec<String>,
}

/// One spacing (or radius) value.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SpacingToken {
    /// Value in px (whole pixels).
    pub value: f64,
    /// Occurrences.
    pub count: usize,
}

/// Named color style.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NamedColor {
    /// Style id.
    pub id: String,
    /// Name.
    pub name: String,
    /// Value.
    pub value: Color,
}

/// Named text style.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NamedText {
    /// Style id.
    pub id: String,
    /// Name.
    pub name: String,
    /// Family.
    pub family: String,
    /// Size in px.
    pub size: f64,
    /// Weight.
    pub weight: f64,
}

/// Usage of one text size.
#[derive(Default)]
struct SizeAcc {
    ids: Vec<String>,
    chars: usize,
    families: Vec<String>,
    weights: Vec<f64>,
    roles: Vec<String>,
}

/// Accumulates tokens over one or more pages.
#[derive(Default)]
pub struct TokenBuilder {
    colors: Vec<(Rgba, Vec<String>, Vec<ColorRole>)>,
    sizes: BTreeMap<i64, SizeAcc>,
    spacing: BTreeMap<i64, usize>,
    radii: BTreeMap<i64, usize>,
}

impl TokenBuilder {
    /// Adds a page.
    pub fn add(&mut self, ctx: &Ctx<'_>) {
        for u in color_uses(ctx) {
            let key = match u.item {
                Some(i) => ctx.scene.items[i].id().to_string(),
                None => format!("page:{}", ctx.scene.page.base.id),
            };
            let c = u.color.with_alpha(1.0);
            let entry = match self
                .colors
                .iter_mut()
                .position(|e| delta_e(e.0, c) < crate::summary::SAME_COLOR)
            {
                Some(p) => &mut self.colors[p],
                None => {
                    self.colors.push((c, Vec::new(), Vec::new()));
                    self.colors.last_mut().expect("color")
                }
            };
            if !entry.1.contains(&key) {
                entry.1.push(key);
            }
            if !entry.2.contains(&u.role) {
                entry.2.push(u.role);
            }
        }
        for (i, it) in ctx.scene.items.iter().enumerate() {
            if !it.visible {
                continue;
            }
            if let Some(f) = ctx.text(i).filter(|f| f.has_content()) {
                for r in &f.runs {
                    let n = r.text.chars().filter(|c| !c.is_whitespace()).count();
                    if n == 0 {
                        continue;
                    }
                    let e = self
                        .sizes
                        .entry((r.style.font_size * 100.0).round() as i64)
                        .or_default();
                    let id = it.id().to_string();
                    if !e.ids.contains(&id) {
                        e.ids.push(id);
                    }
                    e.chars += n;
                    if !e.families.contains(&r.style.font_family) {
                        e.families.push(r.style.font_family.clone());
                    }
                    if !e.weights.contains(&r.style.font_weight) {
                        e.weights.push(r.style.font_weight);
                    }
                    if let Some(role) = it.role()
                        && !e.roles.iter().any(|x| x == role)
                    {
                        e.roles.push(role.to_string());
                    }
                }
            }
            let radii = it.node.corner_radii();
            if matches!(
                it.kind(),
                NodeType::Rect | NodeType::Frame | NodeType::Image | NodeType::Video
            ) {
                for r in radii {
                    if r > 0.0 && r.is_finite() {
                        *self.radii.entry(r.round() as i64).or_default() += 1;
                    }
                }
            }
            if let Some(l) = it.node.layout() {
                if l.gap > 0.0 {
                    *self.spacing.entry(l.gap.round() as i64).or_default() += 1;
                }
                for p in l.padding {
                    if p > 0.0 {
                        *self.spacing.entry(p.round() as i64).or_default() += 1;
                    }
                }
            }
        }
        // Gaps between free-positioned siblings: each item's nearest neighbor below and to the right (items
        // sitting on a shape are measured against each other, not against the shape).
        for set in crate::lint::sibling_sets(ctx) {
            let boxes: Vec<Rect> = set.iter().map(|i| ctx.bounds(*i)).collect();
            let contains = |a: &Rect, b: &Rect| {
                let inter = a.intersection(b).map(|r| r.area()).unwrap_or(0.0);
                inter >= a.area().min(b.area()) * 0.9
            };
            for horizontal in [false, true] {
                let start = |r: &Rect| if horizontal { r.x } else { r.y };
                let end = |r: &Rect| if horizontal { r.right() } else { r.bottom() };
                let mut order: Vec<usize> = (0..boxes.len()).collect();
                order.sort_by(|a, b| {
                    start(&boxes[*a])
                        .total_cmp(&start(&boxes[*b]))
                        .then(a.cmp(b))
                });
                for (k, &a) in order.iter().enumerate() {
                    let ra = boxes[a];
                    let mut best: Option<f64> = None;
                    for &b in &order[k + 1..] {
                        let rb = boxes[b];
                        let gap = start(&rb) - end(&ra);
                        if best.is_some_and(|g| gap > g) {
                            break;
                        }
                        let cross = if horizontal {
                            ra.bottom().min(rb.bottom()) - ra.y.max(rb.y)
                        } else {
                            ra.right().min(rb.right()) - ra.x.max(rb.x)
                        };
                        if gap >= 1.0 && cross > 0.0 && !contains(&ra, &rb) {
                            best = Some(best.map_or(gap, |g: f64| g.min(gap)));
                        }
                    }
                    if let Some(g) = best {
                        *self.spacing.entry(g.round() as i64).or_default() += 1;
                    }
                }
            }
        }
    }

    /// Finishes with the named styles of the design.
    pub fn finish(self, design: &desyn_core::Design) -> DesignTokens {
        let styles = &design.styles;
        let style_name = |c: Rgba| -> Option<String> {
            styles
                .colors
                .values()
                .find(|s| delta_e(Rgba::from_color(&s.value), c) < 0.01)
                .map(|s| s.name.clone())
        };
        let mut palette: Vec<ColorToken> = self
            .colors
            .into_iter()
            .map(|(c, ids, mut roles)| {
                roles.sort();
                ColorToken {
                    color: hex6(c),
                    count: ids.len(),
                    roles,
                    style: style_name(c),
                }
            })
            .collect();
        palette.sort_by(|a, b| b.count.cmp(&a.count).then(a.color.cmp(&b.color)));
        let type_scale = self
            .sizes
            .into_iter()
            .rev()
            .map(|(k, mut a)| {
                a.weights.sort_by(f64::total_cmp);
                a.roles.sort();
                TypeToken {
                    size: k as f64 / 100.0,
                    count: a.ids.len(),
                    chars: a.chars,
                    families: a.families,
                    weights: a.weights,
                    roles: a.roles,
                }
            })
            .collect();
        let to_tokens = |m: BTreeMap<i64, usize>| -> Vec<SpacingToken> {
            m.into_iter()
                .map(|(v, count)| SpacingToken {
                    value: v as f64,
                    count,
                })
                .collect()
        };
        DesignTokens {
            palette,
            type_scale,
            spacing_scale: to_tokens(self.spacing),
            radii: to_tokens(self.radii),
            color_styles: styles
                .colors
                .iter()
                .map(|(id, s)| NamedColor {
                    id: id.clone(),
                    name: s.name.clone(),
                    value: s.value.clone(),
                })
                .collect(),
            text_styles: styles
                .text
                .iter()
                .map(|(id, s)| NamedText {
                    id: id.clone(),
                    name: s.name.clone(),
                    family: s.style.font_family.clone(),
                    size: r2(s.style.font_size),
                    weight: s.style.font_weight,
                })
                .collect(),
        }
    }
}
