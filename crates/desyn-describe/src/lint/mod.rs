//! Lint rules. Every rule reports under one contract [`IssueCode`]; the precise rule name is in `Issue.rule`.

mod content;
mod layout;
mod style;
mod text;

pub(crate) use layout::sibling_sets;
pub(crate) use text::ink_box;

use desyn_core::{Op, PathSeg};
use serde_json::{Map, Value, json};

use crate::ctx::Ctx;
use crate::options::BrandKit;
use crate::types::{IssueCode, Severity};

/// Every lint rule with the contract code it reports under.
pub const RULES: &[(&str, IssueCode, &str)] = &[
    (
        "low-contrast",
        IssueCode::LowContrast,
        "text color against the composited backdrop is below WCAG AA",
    ),
    (
        "busy-background",
        IssueCode::LowContrast,
        "text on a photo whose light or dark areas swallow it",
    ),
    (
        "qr-contrast",
        IssueCode::LowContrast,
        "QR code colors too close to scan reliably",
    ),
    (
        "tiny-text",
        IssueCode::TinyText,
        "text below the readable size for the design kind",
    ),
    (
        "text-overflow",
        IssueCode::TextOverflow,
        "text taller than its fixed box",
    ),
    (
        "text-truncated",
        IssueCode::TextOverflow,
        "text cut by maxLines",
    ),
    (
        "text-clipped",
        IssueCode::TextOverflow,
        "text cut by a clipping frame",
    ),
    (
        "off-page",
        IssueCode::OffPage,
        "element entirely outside the page",
    ),
    (
        "cut-by-page",
        IssueCode::OffPage,
        "text, logo or button partly outside the page",
    ),
    (
        "unsafe-margin",
        IssueCode::UnsafeMargin,
        "important content inside the safe-area margin",
    ),
    (
        "missing-bleed",
        IssueCode::UnsafeMargin,
        "print backdrop stops at the trim instead of the bleed",
    ),
    (
        "misaligned",
        IssueCode::Misaligned,
        "edges or centers that almost line up",
    ),
    (
        "off-center",
        IssueCode::Misaligned,
        "element almost centered on the page",
    ),
    (
        "uneven-spacing",
        IssueCode::UnevenSpacing,
        "inconsistent gaps between stacked or repeated items",
    ),
    (
        "orphan-line",
        IssueCode::OrphanLine,
        "a paragraph ends with a single short word",
    ),
    (
        "widow-line",
        IssueCode::OrphanLine,
        "a paragraph's first line is alone before a break in a column",
    ),
    (
        "too-many-fonts",
        IssueCode::TooManyFonts,
        "more than three font families",
    ),
    (
        "too-many-sizes",
        IssueCode::TooManyFonts,
        "more than six distinct text sizes",
    ),
    (
        "off-brand-font",
        IssueCode::TooManyFonts,
        "font family outside the brand kit",
    ),
    (
        "too-many-colors",
        IssueCode::TooManyColors,
        "more than seven distinct colors",
    ),
    (
        "off-brand-color",
        IssueCode::TooManyColors,
        "color outside the brand palette",
    ),
    (
        "weak-hierarchy",
        IssueCode::WeakHierarchy,
        "the headline is not clearly dominant",
    ),
    (
        "image-low-res",
        IssueCode::ImageLowRes,
        "image has fewer pixels than its size and target resolution need",
    ),
    (
        "missing-alt",
        IssueCode::MissingAlt,
        "meaningful image without alt text",
    ),
    (
        "overlap",
        IssueCode::Overlap,
        "text blocks overlapping each other",
    ),
    (
        "text-covered",
        IssueCode::Overlap,
        "text partly hidden under another element",
    ),
    (
        "unlabeled-group",
        IssueCode::UnlabeledGroup,
        "group of layers without a meaningful name or role",
    ),
    (
        "unnamed-important",
        IssueCode::UnlabeledGroup,
        "key element (headline, hero, CTA) with a default name and no role",
    ),
    (
        "empty-text",
        IssueCode::UnlabeledGroup,
        "text layer without visible characters",
    ),
    (
        "empty-frame",
        IssueCode::UnlabeledGroup,
        "frame or group that shows nothing",
    ),
];

/// Runs every rule.
pub fn run(ctx: &mut Ctx<'_>, grouping: &crate::semantic::Grouping, brand: Option<&BrandKit>) {
    content::empty(ctx);
    text::checks(ctx);
    text::overlaps(ctx);
    layout::bounds(ctx);
    layout::alignment(ctx, grouping);
    layout::spacing(ctx, grouping);
    style::fonts(ctx);
    style::colors(ctx);
    style::hierarchy(ctx);
    if let Some(b) = brand {
        style::brand(ctx, b);
    }
    content::images(ctx);
    content::labels(ctx, grouping);
    content::qr(ctx);
    sort(ctx);
}

/// Most severe first, then contract code order, then paint order of the first node, then rule and message.
fn sort(ctx: &mut Ctx<'_>) {
    let z = |id: Option<&String>| {
        id.and_then(|i| ctx.scene.by_id.get(i.as_str()).copied())
            .unwrap_or(usize::MAX)
    };
    let mut keyed: Vec<(Severity, IssueCode, usize, String, String, usize)> = ctx
        .issues
        .iter()
        .enumerate()
        .map(|(k, i)| {
            (
                i.severity,
                i.code,
                z(i.ids.first()),
                i.rule.clone(),
                i.message.clone(),
                k,
            )
        })
        .collect();
    keyed.sort_by(|a, b| {
        b.0.cmp(&a.0)
            .then(a.1.cmp(&b.1))
            .then(a.2.cmp(&b.2))
            .then(a.3.cmp(&b.3))
            .then(a.4.cmp(&b.4))
    });
    let mut old: Vec<Option<crate::types::Issue>> = std::mem::take(&mut ctx.issues)
        .into_iter()
        .map(Some)
        .collect();
    ctx.issues = keyed
        .into_iter()
        .map(|k| old[k.5].take().expect("issue"))
        .collect();
}

/// Rounds to 1/100 px.
pub(crate) fn r2(v: f64) -> f64 {
    let r = (v * 100.0).round() / 100.0;
    if r == 0.0 { 0.0 } else { r }
}

/// One decimal for messages.
pub(crate) fn r1(v: f64) -> f64 {
    let r = (v * 10.0).round() / 10.0;
    if r == 0.0 { 0.0 } else { r }
}

/// `update` op setting a few properties.
pub(crate) fn update(id: &str, set: Value) -> Op {
    let map: Map<String, Value> = match set {
        Value::Object(m) => m,
        _ => Map::new(),
    };
    Op::update_set(id, map)
}

/// `patch` op.
pub(crate) fn patch(id: &str, path: &[PathSeg], value: Value) -> Op {
    Op::patch(id, path.to_vec(), value)
}

/// Path segment helpers.
pub(crate) fn key(k: &str) -> PathSeg {
    PathSeg::Key(k.to_string())
}

pub(crate) fn idx(i: usize) -> PathSeg {
    PathSeg::Index(i as i64)
}

/// Fix that moves an item by a page-space delta, when its local coordinates move the same way (no rotated /
/// flipped ancestors) and no auto-layout parent owns its position.
pub(crate) fn translate_fix(ctx: &Ctx<'_>, i: usize, dx: f64, dy: f64) -> Option<Op> {
    let it = &ctx.scene.items[i];
    if !it.axis_aligned_parents || it.in_layout || it.node.base().locked {
        return None;
    }
    let b = it.node.base();
    let mut set = Map::new();
    if dx != 0.0 {
        set.insert("x".into(), json!(r2(b.x + dx)));
    }
    if dy != 0.0 {
        set.insert("y".into(), json!(r2(b.y + dy)));
    }
    if set.is_empty() {
        return None;
    }
    Some(Op::update_set(it.id(), set))
}
