//! Display-list builder: walks a page of a design and produces layers / items, caching each node's own paint by
//! a content key so repeated builds (interactive editing) only redo changed nodes.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::hash::Hasher;

use desyn_core::geometry::{Affine, Rect, local_transform};
use desyn_core::model::{Design, Effect, Id, Node, PageNode};
use desyn_text::TextEngine;

use super::{
    Clip, FillRule, FontEntry, FontTable, Item, Layer, LayerEffect, LayerKind, LayerMask, LinkArea,
    LinkTarget, MaskKind,
};
use crate::anim::{self, AnimContext, AnimState};
use crate::assets::{AssetCache, AssetIssue, RasterImage};
use crate::error::RenderError;
use crate::geom;
use crate::hash::{StableHasher, combine, hash_of, hash_serialized};
use crate::paint::Color4;

/// Nodes nested deeper than this below the page are not rendered (keeps recursion within small wasm stacks;
/// only hostile documents nest this deep). Matches `desyn_core::layout::MAX_LAYOUT_DEPTH`.
pub const MAX_RENDER_DEPTH: usize = 128;

/// What to build.
#[derive(Debug, Clone, PartialEq)]
pub struct BuildOptions {
    /// Page id (`None` = first page).
    pub page: Option<Id>,
    /// Render nodes with `visible: false` too.
    pub show_hidden: bool,
    /// Paint the page background.
    pub background: bool,
    /// Render only these subtrees (selection previews, per-node fallbacks); ancestors contribute transforms,
    /// opacity and clipping but not their own paint.
    pub only: Option<Vec<Id>>,
    /// Never render these subtrees (e.g. a text node being edited in a DOM overlay).
    pub hidden: Vec<Id>,
    /// Animation time in ms (`None` = designed state).
    pub time_ms: Option<f64>,
    /// Collect shaped glyph runs and their fonts (real text in PDF / SVG exports).
    pub vector: bool,
    /// Extend the page clip and background by the page bleed.
    pub bleed: bool,
    /// Expected device pixels per design pixel (resolution of rasterized fallbacks and flattening tolerance).
    pub raster_scale: f64,
}

impl Default for BuildOptions {
    fn default() -> Self {
        BuildOptions {
            page: None,
            show_hidden: false,
            background: true,
            only: None,
            hidden: Vec::new(),
            time_ms: None,
            vector: false,
            bleed: false,
            raster_scale: 1.0,
        }
    }
}

/// A node's own paint (without children), cached by content key.
#[derive(Debug, Clone, Default)]
pub(super) struct SelfPaint {
    /// Drawn below the children (fills, image, text, ...).
    pub below: Vec<Item>,
    /// Drawn above the children (frame strokes).
    pub above: Vec<Item>,
    /// Children clip (frames with `clip`).
    pub clip: Option<Clip>,
    /// Links in local coordinates (rect, target).
    pub links: Vec<(Rect, LinkTarget)>,
}

#[derive(Debug, Clone)]
struct CachedPaint {
    key: u64,
    paint: SelfPaint,
    missing: Vec<String>,
    warnings: Vec<String>,
    fonts: Vec<String>,
}

/// Cache of node paints and font bytes, kept across builds by the [`crate::Renderer`].
#[derive(Debug, Default)]
pub struct BuildCache {
    nodes: HashMap<Id, CachedPaint>,
    font_bytes: HashMap<u32, std::sync::Arc<[u8]>>,
    font_generation: u64,
}

/// Entries above which the node cache is dropped (designs this large rebuild everything once).
const MAX_CACHED_NODES: usize = 50_000;

impl BuildCache {
    /// Empty cache.
    pub fn new() -> Self {
        BuildCache::default()
    }

    /// Drops everything.
    pub fn clear(&mut self) {
        self.nodes.clear();
        self.font_bytes.clear();
    }

    /// Number of cached node paints.
    pub fn len(&self) -> usize {
        self.nodes.len()
    }

    /// True when empty.
    pub fn is_empty(&self) -> bool {
        self.nodes.is_empty()
    }
}

/// Builds display lists. Create one per build with [`DisplayListBuilder::new`] and call
/// [`DisplayListBuilder::build`].
pub struct DisplayListBuilder<'a> {
    pub(super) design: &'a Design,
    pub(super) text: &'a mut TextEngine,
    pub(super) assets: &'a mut AssetCache,
    cache: &'a mut BuildCache,
    pub(super) opts: &'a BuildOptions,
    pub(super) page_w: f64,
    pub(super) page_h: f64,
    env_key: u64,
    fonts: FontTable,
    font_index: HashMap<(u32, Vec<(String, u32)>), usize>,
    links: Vec<LinkArea>,
    warnings: Vec<String>,
    missing: BTreeSet<String>,
    missing_fonts: BTreeSet<String>,
    node_missing: Vec<String>,
    node_warnings: Vec<String>,
    node_fonts: Vec<String>,
    node_has_runs: bool,
    only: Option<HashSet<Id>>,
    only_path: HashSet<Id>,
    hidden: HashSet<Id>,
    anim_cx: AnimContext,
    /// Self key of the node being built (seeds keys of internal layers).
    pub(super) cur_key: u64,
}

impl<'a> DisplayListBuilder<'a> {
    /// New builder.
    pub fn new(
        design: &'a Design,
        text: &'a mut TextEngine,
        assets: &'a mut AssetCache,
        cache: &'a mut BuildCache,
        opts: &'a BuildOptions,
    ) -> Self {
        DisplayListBuilder {
            design,
            text,
            assets,
            cache,
            opts,
            page_w: 0.0,
            page_h: 0.0,
            env_key: 0,
            fonts: FontTable::default(),
            font_index: HashMap::new(),
            links: Vec::new(),
            warnings: Vec::new(),
            missing: BTreeSet::new(),
            missing_fonts: BTreeSet::new(),
            node_missing: Vec::new(),
            node_warnings: Vec::new(),
            node_fonts: Vec::new(),
            node_has_runs: false,
            only: None,
            only_path: HashSet::new(),
            hidden: HashSet::new(),
            anim_cx: AnimContext {
                page_w: 1.0,
                page_h: 1.0,
            },
            cur_key: 0,
        }
    }

    /// Flattening tolerance in design px for the target resolution.
    pub(super) fn tol(&self) -> f64 {
        (0.1 / self.opts.raster_scale.max(1e-3)).clamp(0.002, 0.5)
    }

    /// Records a non-fatal problem for the node being built.
    pub(super) fn warn(&mut self, msg: String) {
        self.node_warnings.push(msg);
    }

    /// Decoded image of an asset (records missing / invalid assets).
    pub(super) fn image_asset(&mut self, id: &str) -> Option<std::sync::Arc<RasterImage>> {
        let aref = self.design.assets.get(id);
        match self.assets.image(id, aref) {
            Ok(img) => Some(img),
            Err(AssetIssue::Missing) => {
                self.node_missing.push(id.to_string());
                None
            }
            Err(AssetIssue::Invalid(e)) => {
                self.warn(format!("asset {id}: {e}"));
                None
            }
        }
    }

    /// Records a missing asset id (SVG assets, posters).
    pub(super) fn note_missing(&mut self, id: &str) {
        self.node_missing.push(id.to_string());
    }

    /// Records families the text engine could not find.
    pub(super) fn collect_font_requests(&mut self) {
        for r in self.text.take_font_requests() {
            self.node_fonts.push(r.family);
        }
    }

    /// Index of a font instance in the font table (vector builds).
    pub(super) fn font_entry(&mut self, face: u32, variations: &[(String, f32)]) -> Option<usize> {
        let key = (
            face,
            variations
                .iter()
                .map(|(t, v)| (t.clone(), v.to_bits()))
                .collect::<Vec<_>>(),
        );
        if let Some(i) = self.font_index.get(&key) {
            return Some(*i);
        }
        let fid = desyn_text::FontId(face);
        let info = self.text.db().face(fid)?.clone();
        let data = match self.cache.font_bytes.get(&face) {
            Some(d) => d.clone(),
            None => {
                let (bytes, _) = self.text.db().font_data(fid)?;
                let arc: std::sync::Arc<[u8]> = std::sync::Arc::from(bytes);
                self.cache.font_bytes.insert(face, arc.clone());
                arc
            }
        };
        let weight = variations
            .iter()
            .find(|(t, _)| t == "wght")
            .map(|(_, v)| *v)
            .unwrap_or(info.weight);
        let italic = !matches!(info.style, desyn_text::font::FaceStyle::Normal)
            || variations
                .iter()
                .any(|(t, v)| (t == "ital" && *v > 0.5) || (t == "slnt" && *v != 0.0));
        let entry = FontEntry {
            face,
            data,
            index: info.collection_index,
            family: info.family.clone(),
            postscript_name: info
                .postscript_name
                .clone()
                .unwrap_or_else(|| info.family.replace(' ', "")),
            weight,
            weight_range: info.weight_range,
            italic,
            variations: variations.to_vec(),
            units_per_em: f64::from(info.units_per_em),
        };
        self.fonts.entries.push(entry);
        let i = self.fonts.entries.len() - 1;
        self.font_index.insert(key, i);
        Some(i)
    }

    /// Builds the display list.
    pub fn build(mut self) -> Result<super::DisplayList, RenderError> {
        let design = self.design;
        let page_id = match &self.opts.page {
            Some(p) => p.clone(),
            None => design
                .page_ids()
                .first()
                .cloned()
                .ok_or_else(|| RenderError::NoPage("design has no pages".into()))?,
        };
        let Some(Node::Page(page)) = design.node(&page_id) else {
            return Err(RenderError::NoPage(page_id));
        };
        self.page_w = page.base.width.max(0.0);
        self.page_h = page.base.height.max(0.0);
        self.anim_cx = AnimContext {
            page_w: self.page_w.max(1.0),
            page_h: self.page_h.max(1.0),
        };
        if self.text.db().generation() != self.cache.font_generation {
            self.cache.font_generation = self.text.db().generation();
            self.cache.font_bytes.clear();
        }
        self.env_key = {
            let mut h = StableHasher::new();
            hash_serialized(&mut h, &design.styles);
            h.write_u64(self.text.db().generation());
            h.write_u64(self.assets.generation());
            h.write_u8(u8::from(self.opts.vector));
            h.write_f64(self.opts.raster_scale.max(1e-3).log2().round());
            h.finish()
        };
        if let Some(only) = &self.opts.only {
            let set: HashSet<Id> = only.iter().cloned().collect();
            for id in only {
                for a in design.ancestors(id) {
                    self.only_path.insert(a);
                }
            }
            self.only = Some(set);
        }
        self.hidden = self.opts.hidden.iter().cloned().collect();
        if self.cache.nodes.len() > MAX_CACHED_NODES {
            self.cache.nodes.clear();
        }

        let root = self.build_page(page);
        let mut missing: BTreeSet<String> = std::mem::take(&mut self.missing);
        for m in self.assets.take_missing() {
            missing.insert(m);
        }
        Ok(super::DisplayList {
            page: page_id,
            width: self.page_w,
            height: self.page_h,
            bleed: if page.bleed.is_finite() {
                page.bleed.max(0.0)
            } else {
                0.0
            },
            root,
            links: std::mem::take(&mut self.links),
            fonts: std::mem::take(&mut self.fonts),
            missing_assets: missing.into_iter().collect(),
            missing_fonts: std::mem::take(&mut self.missing_fonts)
                .into_iter()
                .collect(),
            warnings: std::mem::take(&mut self.warnings),
            time_ms: self.opts.time_ms,
        })
    }

    fn build_page(&mut self, page: &PageNode) -> Layer {
        let id = page.base.id.clone();
        let mut root = Layer::new(LayerKind::Page, Some(id.clone()), Affine::IDENTITY);
        let bleed = if self.opts.bleed && page.bleed.is_finite() {
            page.bleed.max(0.0)
        } else {
            0.0
        };
        let area = Rect::new(
            -bleed,
            -bleed,
            self.page_w + 2.0 * bleed,
            self.page_h + 2.0 * bleed,
        );
        let self_key = {
            let mut h = StableHasher::new();
            h.write_u64(self.env_key);
            hash_serialized(&mut h, &page.background);
            h.write_f64(area.x);
            h.write_f64(area.w);
            h.write_f64(area.h);
            h.write_u8(u8::from(self.opts.background));
            h.finish()
        };
        self.cur_key = self_key;
        if self.opts.background && self.only.is_none() {
            if let Some(path) = geom::rect_path(&area) {
                let shape = super::shapes::Shape::rect_like(path, area.w, area.h, [0.0; 4], 0.0)
                    .translated_box(area.x, area.y);
                let items =
                    self.fill_items(&shape, &page.background, area.w, area.h, (area.x, area.y));
                root.items.extend(items);
            }
            self.flush_node_reports(None);
        }
        let children = self.build_children(&page.container.children, 1, &Affine::IDENTITY);
        if page.container.clip && !children.is_empty() {
            let mut g = Layer::new(LayerKind::Group, None, Affine::IDENTITY);
            g.clip = geom::rect_path(&area).map(|p| Clip {
                path: std::sync::Arc::new(p),
                rule: FillRule::Nonzero,
                rect: Some(area),
            });
            g.items = children;
            g.update_bounds();
            g.key = self.group_key(&g, self_key);
            root.items.push(Item::Layer(Box::new(g)));
        } else {
            root.items.extend(children);
        }
        root.update_bounds();
        root.paint_key = self_key;
        root.key = self.group_key(&root, self_key);
        root
    }

    /// Builds children of a container, grouping mask nodes with the siblings they mask.
    fn build_children(&mut self, ids: &[Id], depth: usize, world: &Affine) -> Vec<Item> {
        let mut out = Vec::with_capacity(ids.len());
        let mut i = 0;
        while i < ids.len() {
            let id = &ids[i];
            let is_mask = self
                .design
                .node(id)
                .is_some_and(|n| n.base().is_mask() && (n.base().visible || self.opts.show_hidden));
            if !is_mask {
                if let Some(l) = self.build_node(id, depth, world, false) {
                    out.push(Item::Layer(Box::new(l)));
                }
                i += 1;
                continue;
            }
            let mut j = i + 1;
            while j < ids.len()
                && !self
                    .design
                    .node(&ids[j])
                    .is_some_and(|n| n.base().is_mask())
            {
                j += 1;
            }
            let kind = self
                .design
                .node(id)
                .and_then(|n| n.extra().get("maskType"))
                .and_then(|v| v.as_str())
                .map(|s| {
                    if s == "luminance" {
                        MaskKind::Luminance
                    } else {
                        MaskKind::Alpha
                    }
                })
                .unwrap_or(MaskKind::Alpha);
            let mask_layer = self.build_node(id, depth, world, true);
            let mut members = Vec::new();
            for sid in &ids[i + 1..j] {
                if let Some(l) = self.build_node(sid, depth, world, false) {
                    members.push(Item::Layer(Box::new(l)));
                }
            }
            match mask_layer {
                Some(mask_layer) if !members.is_empty() => {
                    let mut g = Layer::new(LayerKind::MaskGroup, None, Affine::IDENTITY);
                    let mask_key = mask_layer.key;
                    g.mask = Some(Box::new(LayerMask {
                        layer: mask_layer,
                        kind,
                    }));
                    g.items = members;
                    g.update_bounds();
                    g.key = self.group_key(&g, mask_key);
                    out.push(Item::Layer(Box::new(g)));
                }
                // A mask excluded from this build (`hidden`) masks nothing, like an invisible mask node.
                None => out.extend(members),
                Some(_) => {}
            }
            i = j;
        }
        out
    }

    /// Key of a layer from its header and children keys.
    pub(super) fn group_key(&self, l: &Layer, seed: u64) -> u64 {
        let mut h = StableHasher::new();
        h.write_u64(seed);
        for v in l.transform.as_coeffs() {
            h.write_f64(v);
        }
        h.write_f64(f64::from(l.opacity));
        h.write_u8(l.blend as u8);
        if let Some(c) = &l.clip {
            let b = geom::path_bounds(&c.path);
            h.write_f64(b.x);
            h.write_f64(b.y);
            h.write_f64(b.w);
            h.write_f64(b.h);
            h.write_u64(c.path.len() as u64);
        }
        if let Some(m) = &l.mask {
            h.write_u64(m.layer.key);
            h.write_u8(m.kind as u8);
        }
        for e in &l.effects {
            h.write_str(&format!("{e:?}"));
        }
        for (i, it) in l.items.iter().enumerate() {
            match it {
                Item::Layer(c) => h.write_u64(c.key),
                _ => h.write_u64(i as u64),
            }
        }
        h.finish()
    }

    fn self_key(&self, node: &Node, anim: &AnimState) -> u64 {
        let mut h = StableHasher::new();
        h.write_u64(self.env_key);
        hash_serialized(&mut h, node);
        if matches!(node, Node::Boolean(_)) {
            // A boolean's shape comes from its children.
            self.design.walk(node.id(), &mut |n, d| {
                if d > 0 {
                    hash_serialized(&mut h, n);
                }
                true
            });
        }
        if let Some(t) = anim.typewriter {
            h.write_f64(t);
        }
        h.finish()
    }

    fn flush_node_reports(&mut self, node: Option<&str>) {
        for m in self.node_missing.drain(..) {
            self.missing.insert(m);
        }
        for w in self.node_warnings.drain(..) {
            let w = match node {
                Some(n) => format!("{n}: {w}"),
                None => w,
            };
            self.warnings.push(w);
        }
        for f in self.node_fonts.drain(..) {
            self.missing_fonts.insert(f);
        }
    }

    /// Marks the node being built as holding glyph runs (vector builds index this build's font table, so such
    /// paints are not cached).
    pub(super) fn note_runs(&mut self) {
        self.node_has_runs = true;
    }

    /// Builds one node. `as_mask` builds a mask node's content (its own `mask` flag is ignored).
    fn build_node(
        &mut self,
        id: &str,
        depth: usize,
        world: &Affine,
        as_mask: bool,
    ) -> Option<Layer> {
        if depth > MAX_RENDER_DEPTH || self.hidden.contains(id) {
            return None;
        }
        let design = self.design;
        let node = design.node(id)?;
        if matches!(node, Node::Root(_) | Node::Page(_) | Node::Audio(_)) {
            return None;
        }
        let b = node.base();
        if !b.visible && !self.opts.show_hidden {
            return None;
        }
        let selected = match &self.only {
            // Mask content is context for the selected members it masks, like an ancestor's clip.
            None => true,
            Some(_) if as_mask => true,
            Some(set) => {
                let in_sel =
                    set.contains(id) || design.ancestors(id).iter().any(|a| set.contains(a));
                if !in_sel && !self.only_path.contains(id) {
                    return None;
                }
                in_sel
            }
        };
        let anim_state = match (&b.anim, self.opts.time_ms) {
            (Some(a), Some(_)) if !a.is_empty() => {
                anim::evaluate(a, self.opts.time_ms, &self.anim_cx)
            }
            _ => AnimState::IDENTITY,
        };
        if anim_state.is_hidden() && !as_mask {
            return None;
        }
        let local = local_transform(b);
        let transform = anim_state.transform(&local, b.width, b.height) * local;
        if !geom::affine_finite(&transform) {
            return None;
        }
        let mut layer = Layer::new(LayerKind::Node, Some(id.to_string()), transform);
        layer.opacity = (b.opacity.clamp(0.0, 1.0) * anim_state.opacity.clamp(0.0, 1.0)) as f32;
        layer.blend = b.blend;
        layer.effects = convert_effects(&b.effects, id);
        if anim_state.blur > 0.0 {
            layer.effects.push(LayerEffect::LayerBlur {
                radius: anim_state.blur,
            });
        }
        let world_here = *world * transform;

        // Own paint (cached by content key).
        let self_key = self.self_key(node, &anim_state);
        self.cur_key = self_key;
        let paint = if selected {
            self.cached_paint(node, self_key, &anim_state)
        } else {
            // Ancestors of a selection keep their clip but paint nothing themselves.
            let mut p = self.cached_paint(node, self_key, &anim_state);
            p.below.clear();
            p.above.clear();
            p.links.clear();
            p
        };
        for (r, target) in &paint.links {
            let quad = geom::quad(&world_here, r);
            if let Some(rect) = Rect::bounding(quad) {
                self.links.push(LinkArea {
                    quad,
                    rect,
                    target: target.clone(),
                });
            }
        }
        layer.items.extend(paint.below);
        if !matches!(node, Node::Boolean(_))
            && let Some(children) = node.children()
            && !children.is_empty()
        {
            let items = self.build_children(children, depth + 1, &world_here);
            if !items.is_empty() {
                if let Some(clip) = paint.clip {
                    let mut g = Layer::new(LayerKind::Group, None, Affine::IDENTITY);
                    g.clip = Some(clip);
                    g.items = items;
                    g.update_bounds();
                    g.key = self.group_key(&g, self_key);
                    layer.items.push(Item::Layer(Box::new(g)));
                } else {
                    layer.items.extend(items);
                }
            }
        }
        layer.items.extend(paint.above);
        if let Some(w) = anim_state.wipe {
            let r = Rect::new(
                0.0,
                0.0,
                b.width.max(0.0) * w.clamp(0.0, 1.0),
                b.height.max(0.0),
            );
            layer.clip = geom::rect_path(&r).map(|p| Clip {
                path: std::sync::Arc::new(p),
                rule: FillRule::Nonzero,
                rect: Some(r),
            });
        }
        layer.update_bounds();
        layer.paint_key = self_key;
        layer.key = self.group_key(&layer, self_key);
        Some(layer)
    }

    fn cached_paint(&mut self, node: &Node, key: u64, anim_state: &AnimState) -> SelfPaint {
        let id = node.id().to_string();
        if let Some(c) = self.cache.nodes.get(&id)
            && c.key == key
        {
            let c = c.clone();
            for m in c.missing {
                self.missing.insert(m);
            }
            for w in c.warnings {
                self.warnings.push(format!("{id}: {w}"));
            }
            for f in c.fonts {
                self.missing_fonts.insert(f);
            }
            return c.paint;
        }
        self.node_missing.clear();
        self.node_warnings.clear();
        self.node_fonts.clear();
        self.node_has_runs = false;
        let paint = self.node_paint(node, anim_state);
        if !self.node_has_runs {
            self.cache.nodes.insert(
                id.clone(),
                CachedPaint {
                    key,
                    paint: paint.clone(),
                    missing: self.node_missing.clone(),
                    warnings: self.node_warnings.clone(),
                    fonts: self.node_fonts.clone(),
                },
            );
        }
        self.flush_node_reports(Some(&id));
        paint
    }

    /// Own paint of a node by type.
    fn node_paint(&mut self, node: &Node, anim_state: &AnimState) -> SelfPaint {
        let b = node.base();
        let (w, h) = (b.width.max(0.0), b.height.max(0.0));
        let mut p = SelfPaint::default();
        if let Some(link) = b.link.as_deref().and_then(super::parse_link) {
            p.links.push((Rect::new(0.0, 0.0, w, h), link));
        }
        match node {
            Node::Frame(f) => {
                if let Some(shape) = self.node_shape(node) {
                    p.below = self.fill_items(&shape, &f.shape.fills, w, h, (0.0, 0.0));
                    p.above = self.stroke_items(&shape, &f.shape.strokes, w, h);
                    if f.container.clip {
                        p.clip = Some(shape.clip());
                    }
                }
            }
            Node::Rect(_)
            | Node::Ellipse(_)
            | Node::Polygon(_)
            | Node::Star(_)
            | Node::Path(_)
            | Node::Boolean(_) => {
                p.below = self.shape_node_items(node, w, h);
            }
            Node::Line(l) => p.below = self.line_items(l),
            Node::Text(t) => {
                let (items, links) = self.text_node_items(t, anim_state.typewriter);
                p.below = items;
                p.links.extend(links);
            }
            Node::Image(i) => p.below = self.image_node_items(i),
            Node::Svg(s) => p.below = self.svg_node_items(s),
            Node::Video(v) => p.below = self.video_node_items(v),
            Node::Chart(c) => p.below = self.chart_items(c),
            Node::Table(t) => p.below = self.table_items(t),
            Node::Qr(q) => p.below = self.qr_items(q),
            Node::Group(g) => {
                // Groups clip to their (derived) bounds when asked to.
                if g.container.clip
                    && let Some(path) = geom::rect_path(&Rect::new(0.0, 0.0, w, h))
                {
                    p.clip = Some(Clip {
                        path: std::sync::Arc::new(path),
                        rule: FillRule::Nonzero,
                        rect: Some(Rect::new(0.0, 0.0, w, h)),
                    });
                }
            }
            Node::Root(_) | Node::Page(_) | Node::Audio(_) => {}
        }
        p
    }

    /// Internal group layer with a key derived from the current node.
    pub(super) fn group(&self, transform: Affine, items: Vec<Item>, salt: u64) -> Layer {
        let mut g = Layer::new(LayerKind::Group, None, transform);
        g.items = items;
        g.update_bounds();
        g.paint_key = combine(self.cur_key, salt);
        g.key = self.group_key(&g, g.paint_key);
        g
    }
}

/// Converts model effects (visible ones) to layer effects.
pub(super) fn convert_effects(effects: &[Effect], id: &str) -> Vec<LayerEffect> {
    let fin = |v: f64| if v.is_finite() { v } else { 0.0 };
    effects
        .iter()
        .filter(|e| e.is_visible())
        .filter_map(|e| match e {
            Effect::DropShadow(s) => Some(LayerEffect::DropShadow {
                dx: fin(s.x),
                dy: fin(s.y),
                blur: fin(s.blur).clamp(0.0, 1000.0),
                spread: fin(s.spread).clamp(-1000.0, 1000.0),
                color: Color4::from_color(&s.color),
            }),
            Effect::InnerShadow(s) => Some(LayerEffect::InnerShadow {
                dx: fin(s.x),
                dy: fin(s.y),
                blur: fin(s.blur).clamp(0.0, 1000.0),
                spread: fin(s.spread).clamp(-1000.0, 1000.0),
                color: Color4::from_color(&s.color),
            }),
            Effect::LayerBlur(b) => (fin(b.radius) > 0.0).then(|| LayerEffect::LayerBlur {
                radius: fin(b.radius).min(1000.0),
            }),
            Effect::BackgroundBlur(b) => {
                (fin(b.radius) > 0.0).then(|| LayerEffect::BackgroundBlur {
                    radius: fin(b.radius).min(1000.0),
                })
            }
            Effect::Noise(n) => (fin(n.amount) > 0.0).then(|| LayerEffect::Noise {
                amount: fin(n.amount).clamp(0.0, 1.0),
                scale: fin(n.scale).clamp(0.25, 64.0),
                mono: n.mono,
                seed: hash_of(id),
            }),
            Effect::Glow(g) => {
                (fin(g.radius) >= 0.0 && fin(g.strength) > 0.0).then(|| LayerEffect::Glow {
                    radius: fin(g.radius).min(1000.0),
                    strength: fin(g.strength).clamp(0.0, 1.0),
                    color: Color4::from_color(&g.color),
                })
            }
        })
        .collect()
}
