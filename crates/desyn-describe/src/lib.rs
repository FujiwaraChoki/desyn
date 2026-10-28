//! Desyn describe / lint.
//!
//! Turns one page of a [`desyn_core::Design`] into the semantic [`Description`] of `docs/DOCUMENT_MODEL.md`
//! section 7: a tree with roles, page-space boxes, resolved text styles and colors, inferred semantic groups,
//! reading order, palette, fonts, type scale, grid, visual hierarchy and lint [`Issue`]s with fixes. Used by the
//! AI (`read_design`, `critique`) and the editor's design check. Deterministic; no model calls. Builds natively
//! and for `wasm32-unknown-unknown`.
//!
//! ```no_run
//! # fn demo(design: &desyn_core::Design) {
//! use desyn_describe::{DescribeOptions, describe, compact_text, CompactOptions};
//! let mut engine = desyn_text::TextEngine::new(); // register the design's fonts for exact line metrics
//! let desc = describe(design, &DescribeOptions::default(), &mut engine, None).unwrap();
//! let prompt = compact_text(&desc, &CompactOptions { max_tokens: 1500, ..Default::default() });
//! # }
//! ```
//!
//! See `API.md` for the full surface and the lint rule table.

#![warn(missing_docs)]

pub mod backdrop;
pub mod compact;
pub mod ctx;
pub mod kinds;
pub mod lint;
pub mod options;
pub mod order;
pub mod paint;
pub mod sampler;
pub mod scene;
pub mod semantic;
pub mod summary;
pub mod text;
pub mod tokens;
pub mod tree;
pub mod types;
pub mod usage;

use desyn_core::{Design, Node};
use desyn_text::TextEngine;

pub use compact::{CompactOptions, compact_text, compact_value, estimate_tokens};
pub use options::{BrandColor, BrandFont, BrandKit, DescribeOptions, Detail};
pub use sampler::{ImageSample, ImageSampler, PixelSampler};
pub use semantic::GroupKind;
pub use tokens::DesignTokens;
pub use types::*;

/// Why a description could not be produced.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DescribeError {
    /// The design has no pages.
    NoPages,
    /// `pageId` does not name a page of the design.
    PageNotFound(String),
}

impl std::fmt::Display for DescribeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            DescribeError::NoPages => write!(f, "design has no pages"),
            DescribeError::PageNotFound(id) => {
                write!(f, "page \"{id}\" does not exist in this design")
            }
        }
    }
}

impl std::error::Error for DescribeError {}

/// Resolves the page to describe: `pageId`, else the page of the first existing selected node, else the first
/// page. Returns `(page node, index)`.
pub fn resolve_page<'a>(
    design: &'a Design,
    opts: &DescribeOptions,
) -> Result<(&'a desyn_core::PageNode, usize), DescribeError> {
    let pages: Vec<(usize, &desyn_core::PageNode)> = design
        .page_ids()
        .iter()
        .filter_map(|id| match design.node(id) {
            Some(Node::Page(p)) => Some(p),
            _ => None,
        })
        .enumerate()
        .collect();
    if pages.is_empty() {
        return Err(DescribeError::NoPages);
    }
    let wanted: Option<String> = match &opts.page_id {
        Some(id) => Some(id.clone()),
        None => opts
            .selection
            .iter()
            .find_map(|s| design.page_of(s).map(str::to_string)),
    };
    match wanted {
        Some(id) => pages
            .iter()
            .find(|(_, p)| p.base.id == id)
            .map(|(i, p)| (*p, *i))
            .ok_or(DescribeError::PageNotFound(id)),
        None => Ok((pages[0].1, 0)),
    }
}

/// Describes one page (see the crate docs). `engine` measures text (register the design's fonts for exact line
/// breaks; without fonts it uses approximate metrics); `sampler` lets the contrast check see images.
pub fn describe(
    design: &Design,
    opts: &DescribeOptions,
    engine: &mut TextEngine,
    sampler: Option<&mut (dyn ImageSampler + '_)>,
) -> Result<Description, DescribeError> {
    let (page, index) = resolve_page(design, opts)?;
    let scene = scene::Scene::new(design, page, index);
    let mut ctx = ctx::Ctx::new(scene, opts, engine, sampler);
    let grouping = semantic::group(&ctx);
    let hierarchy = summary::hierarchy(&mut ctx, &grouping);
    if opts.lint() {
        lint::run(&mut ctx, &grouping, opts.brand.as_ref());
    }
    let direction = direction(&ctx);
    let reading_order = order::reading_order(&ctx, &grouping, direction);
    let (palette, _) = summary::palette(&ctx);
    let fonts = summary::fonts(&ctx);
    let typography = summary::typography(&ctx);
    let grid = summary::grid(&ctx);
    let tokens = opts.include_styles().then(|| {
        let mut b = tokens::TokenBuilder::default();
        b.add(&ctx);
        b.finish(design)
    });
    let selection_items: Vec<usize> = opts
        .selection
        .iter()
        .filter_map(|s| ctx.scene.by_id.get(s.as_str()).copied())
        .collect();
    let mut tb = tree::TreeBuilder::new(&ctx, &grouping, selection_items);
    let tree = tb.build();
    let omitted = tb.omitted;
    let selection: Vec<String> = opts
        .selection
        .iter()
        .filter(|s| design.node(s).is_some())
        .cloned()
        .collect();
    Ok(Description {
        design: DesignInfo {
            id: design.id.clone(),
            name: design.name.clone(),
            kind: design.kind.as_str().to_string(),
            page_count: design
                .page_ids()
                .iter()
                .filter(|p| matches!(design.node(p), Some(Node::Page(_))))
                .count(),
            locale: design
                .meta
                .get("locale")
                .and_then(|v| v.as_str())
                .map(str::to_string),
        },
        page: PageInfo {
            id: page.base.id.clone(),
            index,
            width: page.base.width,
            height: page.base.height,
            unit: page.unit.as_str().to_string(),
            background: paint::summarize(&page.background, &design.styles),
        },
        selection,
        tree,
        palette,
        fonts,
        typography,
        grid,
        hierarchy,
        issues: std::mem::take(&mut ctx.issues),
        reading_order,
        groups: grouping.groups,
        direction,
        tokens,
        omitted,
    })
}

/// Only the lint results of a page (same rules and order as `describe(...).issues`).
pub fn lint(
    design: &Design,
    opts: &DescribeOptions,
    engine: &mut TextEngine,
    sampler: Option<&mut (dyn ImageSampler + '_)>,
) -> Result<Vec<Issue>, DescribeError> {
    let (page, index) = resolve_page(design, opts)?;
    let scene = scene::Scene::new(design, page, index);
    let mut ctx = ctx::Ctx::new(scene, opts, engine, sampler);
    let grouping = semantic::group(&ctx);
    summary::hierarchy(&mut ctx, &grouping);
    lint::run(&mut ctx, &grouping, opts.brand.as_ref());
    Ok(ctx.issues)
}

/// Design tokens of one page (`pageId`) or, without one, of every page of the design.
pub fn design_tokens(
    design: &Design,
    page_id: Option<&str>,
    engine: &mut TextEngine,
) -> Result<DesignTokens, DescribeError> {
    let opts = DescribeOptions {
        lint: Some(false),
        ..Default::default()
    };
    let mut builder = tokens::TokenBuilder::default();
    let pages: Vec<String> = match page_id {
        Some(p) => vec![p.to_string()],
        None => design.page_ids().to_vec(),
    };
    let mut any = false;
    for id in pages {
        let o = DescribeOptions {
            page_id: Some(id.clone()),
            ..opts.clone()
        };
        let (page, index) = match resolve_page(design, &o) {
            Ok(p) => p,
            Err(e) if page_id.is_some() => return Err(e),
            Err(_) => continue,
        };
        let scene = scene::Scene::new(design, page, index);
        let ctx = ctx::Ctx::without_contrast(scene, &o, engine);
        builder.add(&ctx);
        any = true;
    }
    if !any {
        return Err(DescribeError::NoPages);
    }
    Ok(builder.finish(design))
}

/// Dominant direction: right-to-left when most text characters sit in RTL paragraphs, or when there is no text
/// and the design locale is an RTL language.
fn direction(ctx: &ctx::Ctx<'_>) -> Direction {
    let (mut rtl, mut total) = (0usize, 0usize);
    for (i, it) in ctx.scene.items.iter().enumerate() {
        if let Some(f) = ctx.text(i)
            && it.visible
        {
            let n = f.text.chars().filter(|c| !c.is_whitespace()).count();
            total += n;
            if f.rtl {
                rtl += n;
            }
        }
    }
    if total > 0 {
        return if rtl * 2 > total {
            Direction::Rtl
        } else {
            Direction::Ltr
        };
    }
    let locale = ctx
        .scene
        .design
        .meta
        .get("locale")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let lang = locale.split(['-', '_']).next().unwrap_or("").to_lowercase();
    if matches!(
        lang.as_str(),
        "ar" | "he" | "fa" | "ur" | "yi" | "ps" | "sd" | "ug" | "dv" | "ku"
    ) {
        Direction::Rtl
    } else {
        Direction::Ltr
    }
}
