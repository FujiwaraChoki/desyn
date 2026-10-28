//! Content rules: empty layers, alt text, image resolution, layer naming, QR contrast.

use desyn_core::color::{Rgba, contrast_ratio};
use desyn_core::{Fill, ImageFillMode, Node, NodeType, Op};

use super::r1;
use crate::backdrop::SourceMode;
use crate::ctx::Ctx;
use crate::kinds::PRINT_DPI;
use crate::semantic::{GroupKind, Grouping};
use crate::types::{IssueCode, Severity};

/// Names the editor gives new layers of a type (`"Rectangle 3"` for a rect); such layers carry no meaning.
pub(crate) fn is_default_name(name: &str, kind: NodeType) -> bool {
    let n = name.trim().to_lowercase();
    if n.is_empty() {
        return true;
    }
    let base = n.trim_end_matches(|c: char| c.is_ascii_digit()).trim_end();
    if n != base && !n[base.len()..].trim().chars().all(|c| c.is_ascii_digit()) {
        return false;
    }
    let typed: &[&str] = match kind {
        NodeType::Text => &["text"],
        NodeType::Image => &["image"],
        NodeType::Frame => &["frame", "container"],
        NodeType::Group => &["group"],
        NodeType::Rect => &["rectangle", "rect", "shape"],
        NodeType::Ellipse => &["ellipse", "circle", "shape"],
        NodeType::Polygon => &["polygon", "shape"],
        NodeType::Star => &["star", "shape"],
        NodeType::Line => &["line"],
        NodeType::Path => &["path", "vector", "shape"],
        NodeType::Svg => &["svg", "vector", "graphic"],
        NodeType::Boolean => &["boolean", "union", "subtract", "intersect", "exclude"],
        NodeType::Video => &["video"],
        NodeType::Chart => &["chart"],
        NodeType::Table => &["table"],
        NodeType::Qr => &["qr", "qr code"],
        _ => &[],
    };
    typed.contains(&base) || matches!(base, "layer" | "copy" | "untitled")
}

const DECORATIVE: &[&str] = &["background", "decoration", "pattern", "watermark"];

/// Text without characters, frames and groups that show nothing.
pub fn empty(ctx: &mut Ctx<'_>) {
    // Whether any descendant shows something, bottom-up in one pass (items are in pre-order: children come after
    // their parent), so deep trees stay linear.
    let n = ctx.scene.items.len();
    let mut shows = vec![false; n];
    for i in (0..n).rev() {
        let it = &ctx.scene.items[i];
        if let Some(p) = it.parent {
            shows[p] |= shows[i] || (it.visible && it.node.paints_self());
        }
    }
    for (i, shows_children) in shows.into_iter().enumerate() {
        let it = &ctx.scene.items[i];
        if !it.visible {
            continue;
        }
        let node = it.node;
        let has_children = !it.children.is_empty();
        let name = ctx.name(i);
        let id = node.id().to_string();
        let locked = node.base().locked;
        match node.node_type() {
            NodeType::Text if !ctx.text(i).is_some_and(|f| f.has_content()) => {
                ctx.flag(i, "empty");
                ctx.issue(
                    Severity::Info,
                    IssueCode::UnlabeledGroup,
                    "empty-text",
                    &[i],
                    format!("{name} is a text layer without any visible characters."),
                    Some("Delete it, or type the copy it was meant to hold.".into()),
                    (!locked).then(|| vec![Op::delete(id)]),
                );
            }
            NodeType::Frame | NodeType::Group => {
                let paints = node.node_type() == NodeType::Frame
                    && (node.fills().iter().any(|f| f.is_visible())
                        || node
                            .strokes()
                            .iter()
                            .any(|s| s.is_visible() && s.width > 0.0)
                        || node.base().effects.iter().any(|e| e.is_visible()));
                if !paints && !shows_children && node.base().role.as_deref() != Some("placeholder")
                {
                    ctx.flag(i, "empty");
                    let what = if has_children {
                        "only holds hidden or empty layers"
                    } else {
                        "has no layers"
                    };
                    ctx.issue(
                        Severity::Info,
                        IssueCode::UnlabeledGroup,
                        "empty-frame",
                        &[i],
                        format!("{name} {what} and shows nothing."),
                        Some("Delete it, or give it a fill or content.".into()),
                        (!locked).then(|| vec![Op::delete(id)]),
                    );
                }
            }
            _ => {}
        }
    }
}

/// Missing alt text and low-resolution images.
pub fn images(ctx: &mut Ctx<'_>) {
    for i in 0..ctx.scene.items.len() {
        let it = &ctx.scene.items[i];
        if !it.visible || crate::scene::visible_area(it) <= 0.0 {
            continue;
        }
        let node = it.node;
        let b = node.base();
        let role = b.role.as_deref().unwrap_or("");
        let decorative = DECORATIVE.contains(&role);
        let name = ctx.name(i);
        // Alt text: images, vector graphics and shapes filled with a meaningful photo.
        let media = match node {
            Node::Image(_) => true,
            // Icons are decorative next to their label unless they act as a link.
            Node::Svg(_) => ctx.elem(i) != crate::semantic::Elem::Icon || b.link.is_some(),
            Node::Video(_) => true,
            n => {
                crate::paint::top_is_image(n.fills())
                    && matches!(
                        role,
                        "photo" | "hero" | "product" | "avatar" | "illustration"
                    )
            }
        };
        if media && !decorative && b.alt.as_deref().is_none_or(|a| a.trim().is_empty()) {
            ctx.flag(i, "missing-alt");
            ctx.issue(
                Severity::Info,
                IssueCode::MissingAlt,
                "missing-alt",
                &[i],
                format!("{name} has no alt text."),
                Some("Describe what the image shows in one short sentence (or mark it as decoration).".into()),
                None,
            );
        }
        // Resolution.
        let (w, h) = (b.width, b.height);
        let sources: Vec<(&str, SourceMode)> = match node {
            Node::Image(img) => vec![(
                img.asset_id.as_str(),
                SourceMode::of_node(img.fit, img.crop.as_ref()),
            )],
            n => n
                .fills()
                .iter()
                .filter(|f| f.is_visible())
                .filter_map(|f| match f {
                    Fill::Image(fi) if fi.mode != ImageFillMode::Tile => {
                        Some((fi.asset_id.as_str(), SourceMode::of_fill(fi)))
                    }
                    _ => None,
                })
                .collect(),
        };
        for (asset_id, mode) in sources {
            let Some(asset) = ctx.scene.design.assets.get(asset_id) else {
                continue;
            };
            let (Some(aw), Some(ah)) = (asset.width, asset.height) else {
                continue;
            };
            if aw <= 0.0 || ah <= 0.0 || w <= 0.0 || h <= 0.0 {
                continue;
            }
            // Display px per source px.
            let s = match mode {
                SourceMode::Cover => (w / aw).max(h / ah),
                SourceMode::Contain => (w / aw).min(h / ah),
                SourceMode::Stretch => (w / aw).max(h / ah),
                SourceMode::Crop(c) => (w / (aw * c.w.max(1e-6))).max(h / (ah * c.h.max(1e-6))),
                SourceMode::Tile => continue,
            };
            if ctx.print {
                let dpi = 96.0 / s;
                if dpi < PRINT_DPI * 0.9 {
                    ctx.flag(i, "low-res");
                    let need = (
                        (w * PRINT_DPI / 96.0).round(),
                        (h * PRINT_DPI / 96.0).round(),
                    );
                    ctx.issue(
                        if dpi < 150.0 { Severity::Error } else { Severity::Warn },
                        IssueCode::ImageLowRes,
                        "image-low-res",
                        &[i],
                        format!(
                            "{name} prints at about {} dpi ({}x{}px source); print needs {} dpi, about {}x{}px at this size.",
                            dpi.round(),
                            aw,
                            ah,
                            PRINT_DPI,
                            need.0,
                            need.1
                        ),
                        Some("Upscale the image or replace it with a larger original.".into()),
                        None,
                    );
                }
            } else if s > 1.0 / 0.9 {
                ctx.flag(i, "low-res");
                ctx.issue(
                    if s > 2.5 {
                        Severity::Error
                    } else {
                        Severity::Warn
                    },
                    IssueCode::ImageLowRes,
                    "image-low-res",
                    &[i],
                    format!(
                        "{name} is {}x{}px but is shown {}x larger; upscale or replace it.",
                        aw,
                        ah,
                        r1(s)
                    ),
                    Some("Upscale the image or use a larger original.".into()),
                    None,
                );
            }
        }
    }
}

/// Groups without names, and key elements left with default names.
pub fn labels(ctx: &mut Ctx<'_>, grouping: &Grouping) {
    let mut reported: std::collections::HashSet<usize> = std::collections::HashSet::new();
    for i in 0..ctx.scene.items.len() {
        let it = &ctx.scene.items[i];
        if !it.visible
            || !matches!(it.kind(), NodeType::Group | NodeType::Frame)
            || it.children.len() < 2
        {
            continue;
        }
        let b = it.node.base();
        if b.role.is_some() || !is_default_name(&b.name, it.kind()) {
            continue;
        }
        let suggestion = grouping
            .by_container
            .get(&i)
            .map(|g| grouping.groups[*g].kind);
        let name = ctx.name(i);
        reported.insert(i);
        ctx.issue(
            Severity::Info,
            IssueCode::UnlabeledGroup,
            "unlabeled-group",
            &[i],
            format!(
                "{name} groups {} layers but has no meaningful name or role.",
                it.children.len()
            ),
            Some(match suggestion {
                Some(k) if k != GroupKind::Role => format!(
                    "Name it after what it is (it looks like a {}) and set a role.",
                    k.noun()
                ),
                _ => "Name it after what it is and set a role.".into(),
            }),
            None,
        );
    }
    // Key elements: the three strongest elements and every button-like group.
    let mut key: Vec<usize> = Vec::new();
    let mut ranked: Vec<usize> = (0..ctx.scene.items.len())
        .filter(|i| ctx.weights[*i] > 0.0)
        .collect();
    ranked.sort_by(|a, b| ctx.weights[*b].total_cmp(&ctx.weights[*a]).then(a.cmp(b)));
    key.extend(ranked.into_iter().take(3));
    for g in &grouping.groups {
        if g.kind == GroupKind::Button
            && let Some(n) = g
                .node
                .as_ref()
                .and_then(|n| ctx.scene.by_id.get(n.as_str()))
        {
            key.push(*n);
        }
    }
    key.sort_unstable();
    key.dedup();
    for i in key {
        let it = &ctx.scene.items[i];
        let b = it.node.base();
        if reported.contains(&i)
            || b.role.is_some()
            || !is_default_name(&b.name, it.kind())
            || !it.visible
        {
            continue;
        }
        let what = match it.kind() {
            NodeType::Text => "text",
            NodeType::Image => "image",
            NodeType::Group | NodeType::Frame => "group",
            _ => "element",
        };
        let name = ctx.name(i);
        ctx.issue(
            Severity::Info,
            IssueCode::UnlabeledGroup,
            "unnamed-important",
            &[i],
            format!("{name} is one of the most prominent elements but has a default {what} name and no role."),
            Some("Rename it (e.g. \"Hero photo\", \"Headline\", \"CTA button\") and set its role.".into()),
            None,
        );
    }
}

/// QR codes that may not scan.
pub fn qr(ctx: &mut Ctx<'_>) {
    for i in 0..ctx.scene.items.len() {
        let it = &ctx.scene.items[i];
        let node = it.node;
        let Node::Qr(q) = node else { continue };
        if !it.visible {
            continue;
        }
        let (fg, bg) = (Rgba::from_color(&q.fg), Rgba::from_color(&q.bg));
        let ratio = contrast_ratio(fg, bg);
        let inverted = fg.relative_luminance() > bg.relative_luminance();
        if ratio < 4.0 || inverted {
            ctx.flag(i, "low-contrast");
            let name = ctx.name(i);
            let msg = if inverted {
                format!(
                    "{name} has light modules on a dark background; many scanners expect dark on light."
                )
            } else {
                format!(
                    "{name} has only {}:1 contrast between its modules and background; it may not scan.",
                    (ratio * 100.0).round() / 100.0
                )
            };
            ctx.issue(
                if ratio < 3.0 {
                    Severity::Error
                } else {
                    Severity::Warn
                },
                IssueCode::LowContrast,
                "qr-contrast",
                &[i],
                msg,
                Some("Use dark modules (e.g. #000000) on a light background.".into()),
                Some(vec![super::update(
                    node.id(),
                    serde_json::json!({ "fg": "#000000", "bg": "#ffffff" }),
                )]),
            );
        }
    }
}
