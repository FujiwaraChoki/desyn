//! Shared analysis state: the page scene, text facts, contrast facts, flags and the issue list.

use std::collections::BTreeSet;

use desyn_core::color::Rgba;
use desyn_core::geometry::{Point, Rect};
use desyn_core::{DesignKind, Node, NodeType};
use desyn_text::TextEngine;

use crate::backdrop::backdrop_at;
use crate::kinds::{self, Insets};
use crate::options::DescribeOptions;
use crate::paint::{contrast_over, is_large_text};
use crate::sampler::ImageSampler;
use crate::scene::{Scene, visible_area};
use crate::text::{TextFacts, facts};
use crate::types::{Issue, IssueCode, Severity};

/// Contrast facts of a text node.
#[derive(Debug, Clone, Copy)]
pub struct Contrast {
    /// Text color with the lowest contrast, as it reaches the page (fill and layer opacity as alpha).
    pub fg: Rgba,
    /// What that color sits on where the contrast is lowest (average image pixels; its run's highlight included).
    pub bg: Rgba,
    /// The page backdrop at that point, before any run highlight (to re-check other runs against).
    pub backdrop: Rgba,
    /// Lowest contrast against the average backdrop.
    pub ratio: f64,
    /// Lowest contrast against the darkest / lightest image pixels (busy photos), when an image is behind.
    pub extreme: Option<f64>,
    /// Text sits on an image.
    pub on_image: bool,
    /// The backdrop is unknown (image without a sampler).
    pub unknown: bool,
    /// WCAG target for this text (3 for large text, else 4.5).
    pub target: f64,
}

/// Analysis context.
pub struct Ctx<'a> {
    /// Page view.
    pub scene: Scene<'a>,
    /// Text facts by item index (text nodes only).
    pub texts: Vec<Option<TextFacts>>,
    /// Contrast facts by item index (visible text with content only).
    pub contrast: Vec<Option<Contrast>>,
    /// Design kind.
    pub kind: DesignKind,
    /// Print page.
    pub print: bool,
    /// Minimum readable text size.
    pub min_text: f64,
    /// Safe-area insets `[t, r, b, l]`.
    pub safe: Insets,
    /// Where the safe area came from (preset id or `"default"`).
    pub safe_source: &'static str,
    /// Options.
    pub opts: &'a DescribeOptions,
    /// Flags by item index (deduplicated, insertion ordered).
    pub flags: Vec<Vec<String>>,
    /// Issues found so far.
    pub issues: Vec<Issue>,
    /// Visual weight 0..1 by item index.
    pub weights: Vec<f64>,
    /// Element class by item index (see [`crate::semantic::Elem`]).
    pub elems: Vec<crate::semantic::Elem>,
}

impl<'a> Ctx<'a> {
    /// Builds the context: scene, text layout of every text node and the contrast of visible text.
    pub fn new(
        scene: Scene<'a>,
        opts: &'a DescribeOptions,
        engine: &mut TextEngine,
        sampler: Option<&mut (dyn ImageSampler + '_)>,
    ) -> Self {
        Self::build(scene, opts, engine, sampler, true)
    }

    /// Like [`Ctx::new`] without the contrast pass (token extraction).
    pub fn without_contrast(
        scene: Scene<'a>,
        opts: &'a DescribeOptions,
        engine: &mut TextEngine,
    ) -> Self {
        Self::build(scene, opts, engine, None, false)
    }

    fn build(
        scene: Scene<'a>,
        opts: &'a DescribeOptions,
        engine: &mut TextEngine,
        mut sampler: Option<&mut (dyn ImageSampler + '_)>,
        contrast: bool,
    ) -> Self {
        let design = scene.design;
        let kind = design.kind;
        let print = kinds::is_print(scene.page);
        let min_text = kinds::min_text_size(kind, scene.page);
        let (safe, safe_source) =
            kinds::safe_insets(kind, scene.page.base.width, scene.page.base.height);
        let n = scene.items.len();
        let texts: Vec<Option<TextFacts>> = scene
            .items
            .iter()
            .map(|it| match it.node {
                Node::Text(t) => Some(facts(t, &design.styles, engine)),
                _ => None,
            })
            .collect();
        let mut ctx = Ctx {
            scene,
            texts,
            contrast: vec![None; n],
            kind,
            print,
            min_text,
            safe,
            safe_source,
            opts,
            flags: vec![Vec::new(); n],
            issues: Vec::new(),
            weights: vec![0.0; n],
            elems: Vec::new(),
        };
        ctx.elems = (0..n).map(|i| ctx.compute_elem(i)).collect();
        for i in 0..n {
            // Text cut away entirely (by a clipping frame or a mask) shows nothing to read.
            if contrast
                && ctx.scene.items[i].visible
                && visible_area(&ctx.scene.items[i]) > 0.0
                && ctx.texts[i].as_ref().is_some_and(TextFacts::has_content)
            {
                ctx.contrast[i] = ctx.measure_contrast(i, sampler.as_deref_mut());
            }
        }
        ctx
    }

    /// Text facts of an item.
    pub fn text(&self, i: usize) -> Option<&TextFacts> {
        self.texts[i].as_ref()
    }

    /// Adds a flag to a node.
    pub fn flag(&mut self, i: usize, flag: impl Into<String>) {
        let f = flag.into();
        if !self.flags[i].contains(&f) {
            self.flags[i].push(f);
        }
    }

    /// Adds an issue.
    #[allow(clippy::too_many_arguments)]
    pub fn issue(
        &mut self,
        severity: Severity,
        code: IssueCode,
        rule: &str,
        items: &[usize],
        message: String,
        hint: Option<String>,
        fix: Option<Vec<desyn_core::Op>>,
    ) {
        self.issues.push(Issue {
            severity,
            code,
            ids: items
                .iter()
                .map(|i| self.scene.items[*i].id().to_string())
                .collect(),
            message,
            fix,
            rule: rule.to_string(),
            hint,
        });
    }

    /// Adds an issue whose ids are given directly (e.g. the page itself, which is not an item).
    #[allow(clippy::too_many_arguments)]
    pub fn issue_with_ids(
        &mut self,
        severity: Severity,
        code: IssueCode,
        rule: &str,
        ids: Vec<String>,
        message: String,
        hint: Option<String>,
        fix: Option<Vec<desyn_core::Op>>,
    ) {
        self.issues.push(Issue {
            severity,
            code,
            ids,
            message,
            fix,
            rule: rule.to_string(),
            hint,
        });
    }

    /// Quoted layer name for messages.
    pub fn name(&self, i: usize) -> String {
        format!("\"{}\"", self.scene.items[i].node.base().name)
    }

    /// Visible content items (visible, on-page area, not backdrop).
    pub fn is_content(&self, i: usize) -> bool {
        let it = &self.scene.items[i];
        it.visible && visible_area(it) > 0.0 && !self.scene.is_backdrop(i)
    }

    /// Visible children of a container item (or of the page with `None`), in paint order.
    pub fn visible_children(&self, parent: Option<usize>) -> Vec<usize> {
        let list = match parent {
            Some(p) => &self.scene.items[p].children,
            None => &self.scene.top,
        };
        list.iter()
            .copied()
            .filter(|c| self.scene.items[*c].visible)
            .collect()
    }

    /// Whether an item is a leaf that carries content (text, media, shapes, lines, data).
    pub fn is_leaf_content(&self, i: usize) -> bool {
        !matches!(
            self.scene.items[i].kind(),
            NodeType::Group
                | NodeType::Frame
                | NodeType::Boolean
                | NodeType::Audio
                | NodeType::Root
                | NodeType::Page
        ) || (self.scene.items[i].kind() == NodeType::Frame
            && self.scene.items[i].children.is_empty())
    }

    /// Ids of a list of items.
    pub fn ids(&self, items: &[usize]) -> Vec<String> {
        items
            .iter()
            .map(|i| self.scene.items[*i].id().to_string())
            .collect()
    }

    /// Union of the visible boxes of items.
    pub fn union_box(&self, items: &[usize]) -> Option<Rect> {
        items
            .iter()
            .filter_map(|i| self.scene.items[*i].visible_box())
            .reduce(|a, b| a.union(&b))
    }

    /// Effective visible bounds of an item (aabb when not clipped away).
    pub fn bounds(&self, i: usize) -> Rect {
        self.scene.items[i]
            .visible_box()
            .unwrap_or(self.scene.items[i].aabb)
    }

    /// Descendant item indices (pre-order, excluding `i`).
    pub fn descendants(&self, i: usize) -> Vec<usize> {
        let mut out = Vec::new();
        let mut stack: Vec<usize> = self.scene.items[i].children.iter().rev().copied().collect();
        while let Some(c) = stack.pop() {
            out.push(c);
            stack.extend(self.scene.items[c].children.iter().rev().copied());
        }
        out
    }

    /// Leaf content under (and including) an item.
    pub fn leaves(&self, i: usize) -> Vec<usize> {
        if self.scene.items[i].children.is_empty() {
            return vec![i];
        }
        self.descendants(i)
            .into_iter()
            .filter(|d| self.scene.items[*d].children.is_empty() && self.scene.items[*d].visible)
            .collect()
    }

    fn measure_contrast(
        &mut self,
        i: usize,
        mut sampler: Option<&mut (dyn ImageSampler + '_)>,
    ) -> Option<Contrast> {
        let facts = self.texts[i].as_ref()?;
        let it = &self.scene.items[i];
        let world = it.world;
        let b = it.node.base();
        let layer_opacity = it.opacity;
        let size = facts.style().font_size;
        let weight = facts.style().font_weight;
        // Distinct (glyph color, run) pairs of runs with visible characters; the lowest contrast wins. Runs are
        // kept for their highlight (a highlight is the backdrop of its glyphs).
        let runs: Vec<(Rgba, &crate::text::StyledRun)> = {
            let mut seen = BTreeSet::new();
            facts
                .runs
                .iter()
                .filter(|r| r.text.chars().any(|c| !c.is_whitespace()))
                .filter_map(|r| r.ink(layer_opacity).map(|c| (c, r)))
                .filter(|(c, r)| {
                    let hl = r.style.highlight.as_ref().map(|h| h.as_str().to_string());
                    seen.insert((crate::paint::hex(*c), hl))
                })
                .collect()
        };
        if runs.is_empty() {
            return None;
        }
        // Sample points: three per line (20 / 50 / 80 % of the line) on up to six lines, in page space.
        let mut points: Vec<Point> = Vec::new();
        for l in facts.lines.iter().filter(|l| l.width > 0.0).take(6) {
            let y = l.top + l.height / 2.0;
            for t in [0.2, 0.5, 0.8] {
                points.push(world.apply(Point::new(l.x + l.width * t, y)));
            }
        }
        if points.is_empty() {
            points.push(world.apply(Point::new(b.width / 2.0, b.height / 2.0)));
        }
        let ink = if facts.ink.w > 0.0 && facts.ink.h > 0.0 {
            facts.ink
        } else {
            Rect::new(0.0, 0.0, b.width, b.height)
        };
        let region = world.transform_rect_bbox(&ink);
        let z = it.z;
        let mut worst: Option<Contrast> = None;
        let large = is_large_text(size, weight);
        let target = if large { 3.0 } else { 4.5 };
        for p in points {
            let bd = backdrop_at(&mut self.scene, z, &[], p, region, sampler.as_deref_mut());
            for (fg, run) in &runs {
                let bg = run.on(bd.average);
                let ratio = contrast_over(*fg, bg);
                let on_image = bd.on_image && !run.opaque_highlight();
                let extreme = on_image.then(|| {
                    contrast_over(*fg, run.on(bd.darkest))
                        .min(contrast_over(*fg, run.on(bd.lightest)))
                });
                let better = match &worst {
                    None => true,
                    Some(w) => ratio < w.ratio,
                };
                let extreme_min = match (worst.as_ref().and_then(|w| w.extreme), extreme) {
                    (Some(a), Some(b)) => Some(a.min(b)),
                    (a, b) => a.or(b),
                };
                let unknown = bd.unknown && !run.opaque_highlight();
                if better {
                    worst = Some(Contrast {
                        fg: *fg,
                        bg,
                        backdrop: bd.average,
                        ratio,
                        extreme: extreme_min,
                        on_image,
                        unknown,
                        target,
                    });
                } else if let Some(w) = worst.as_mut() {
                    w.extreme = extreme_min;
                    w.on_image |= on_image;
                    w.unknown |= unknown;
                }
            }
        }
        worst
    }
}
