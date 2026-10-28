//! Builds the `DNode` tree.

use desyn_core::{Node, NodeType};

use crate::ctx::Ctx;
use crate::lint::r2;
use crate::options::{Detail, SUMMARY_TEXT_CHARS};
use crate::paint::{self, hex6};
use crate::semantic::{Elem, Grouping};
use crate::types::{DBox, DFont, DImage, DNode, ImageKind};

/// Hard cap on tree depth (keeps recursion small on wasm stacks whatever `maxDepth` says).
pub const MAX_TREE_DEPTH: usize = 64;

/// Tree build state.
pub struct TreeBuilder<'c, 'a> {
    ctx: &'c Ctx<'a>,
    grouping: &'c Grouping,
    depth: usize,
    include_hidden: bool,
    detail: Detail,
    max_nodes: usize,
    selection: Vec<usize>,
    /// Nodes emitted so far.
    pub emitted: usize,
    /// Nodes left out.
    pub omitted: usize,
}

impl<'c, 'a> TreeBuilder<'c, 'a> {
    /// New builder.
    pub fn new(ctx: &'c Ctx<'a>, grouping: &'c Grouping, selection: Vec<usize>) -> Self {
        let o = ctx.opts;
        TreeBuilder {
            ctx,
            grouping,
            depth: o.depth().min(MAX_TREE_DEPTH),
            include_hidden: o.include_hidden(),
            detail: o.detail,
            max_nodes: o.max_nodes.unwrap_or(usize::MAX),
            selection,
            emitted: 0,
            omitted: 0,
        }
    }

    /// The page's top-level nodes.
    pub fn build(&mut self) -> Vec<DNode> {
        let top = self.ctx.scene.top.clone();
        self.children(&top, 0)
    }

    fn subtree_size(&self, i: usize) -> usize {
        1 + self.ctx.descendants(i).len()
    }

    fn children(&mut self, list: &[usize], depth: usize) -> Vec<DNode> {
        let mut out = Vec::new();
        for &c in list {
            if !self.include_hidden && !self.ctx.scene.items[c].visible {
                self.omitted += self.subtree_size(c);
                continue;
            }
            if self.emitted >= self.max_nodes {
                self.omitted += self.subtree_size(c);
                continue;
            }
            out.push(self.node(c, depth));
        }
        out
    }

    fn node(&mut self, i: usize, depth: usize) -> DNode {
        self.emitted += 1;
        let ctx = self.ctx;
        let it = &ctx.scene.items[i];
        let b = it.node.base();
        let styles = &ctx.scene.design.styles;
        let r = it.aabb;
        let mut d = DNode {
            id: b.id.clone(),
            node_type: it.kind().as_str().to_string(),
            name: b.name.clone(),
            role: b.role.clone(),
            bbox: DBox {
                x: r2(r.x),
                y: r2(r.y),
                w: r2(r.w),
                h: r2(r.h),
                rotation: r2(it.rotation),
            },
            z: it.z,
            visible: b.visible,
            locked: b.locked,
            opacity: (b.opacity * 1000.0).round() / 1000.0,
            text: None,
            font: None,
            fill: None,
            image: None,
            semantic: None,
            children: None,
            flags: None,
            weight: (ctx.weights[i] > 0.0).then_some(ctx.weights[i]),
        };
        match it.node {
            Node::Text(t) => {
                if let Some(f) = ctx.text(i) {
                    let text = match self.detail {
                        Detail::Summary if f.text.chars().count() > SUMMARY_TEXT_CHARS => {
                            let mut s: String =
                                f.text.chars().take(SUMMARY_TEXT_CHARS - 1).collect();
                            s.push('…');
                            s
                        }
                        _ => f.text.clone(),
                    };
                    d.text = Some(text);
                    let s = f.style();
                    d.font = Some(DFont {
                        family: s.font_family.clone(),
                        size: r2(s.font_size),
                        weight: s.font_weight,
                        color: hex6(f.color()),
                        align: t.paragraph.align.as_str().to_string(),
                        lines: Some(f.line_count()),
                    });
                }
            }
            Node::Line(l) => {
                d.fill = l.strokes.iter().find(|s| s.is_visible()).map(|s| {
                    format!(
                        "stroke {} {}px",
                        paint::summarize(&s.fills, styles),
                        r2(s.width)
                    )
                });
            }
            Node::Qr(q) => d.fill = Some(format!("qr({} on {})", q.fg.as_str(), q.bg.as_str())),
            Node::Image(img) => {
                d.image = Some(DImage {
                    asset_id: img.asset_id.clone(),
                    alt: b.alt.clone(),
                    kind: Some(self.image_kind(i)),
                });
            }
            Node::Svg(s) => {
                if let Some(a) = &s.asset_id {
                    d.image = Some(DImage {
                        asset_id: a.clone(),
                        alt: b.alt.clone(),
                        kind: Some(self.image_kind(i)),
                    });
                }
            }
            Node::Video(v) => {
                d.image = Some(DImage {
                    asset_id: v.asset_id.clone(),
                    alt: b.alt.clone(),
                    kind: Some(ImageKind::Photo),
                });
            }
            n => {
                if n.shaped().is_some() {
                    d.fill = Some(paint::summarize(n.fills(), styles));
                    if let Some(desyn_core::Fill::Image(f)) =
                        n.fills().iter().rev().find(|f| f.is_visible())
                    {
                        d.image = Some(DImage {
                            asset_id: f.asset_id.clone(),
                            alt: b.alt.clone(),
                            kind: Some(self.image_kind(i)),
                        });
                    }
                }
            }
        }
        if let Some(g) = self.grouping.by_container.get(&i) {
            d.semantic = Some(self.grouping.groups[*g].label.clone());
        }
        let mut flags = ctx.flags[i].clone();
        if self.selection.contains(&i) {
            flags.insert(0, "selected".into());
        }
        if it.mask {
            flags.push("mask".into());
        } else if b.visible && !it.visible && !it.in_mask && it.node.base().opacity > 0.01 {
            flags.push("hidden-by-parent".into());
        }
        if ctx.text(i).is_some_and(|f| f.rtl) {
            flags.push("rtl".into());
        }
        if !flags.is_empty() {
            d.flags = Some(flags);
        }
        let kids = it.children.clone();
        if !kids.is_empty() {
            if depth + 1 < self.depth {
                let c = self.children(&kids, depth + 1);
                if !c.is_empty() {
                    d.children = Some(c);
                }
            } else {
                self.omitted += self.ctx.descendants(i).len();
            }
        }
        d
    }

    fn image_kind(&self, i: usize) -> ImageKind {
        let it = &self.ctx.scene.items[i];
        match it.role() {
            Some("logo" | "brand-mark") => return ImageKind::Logo,
            Some("icon") => return ImageKind::Icon,
            Some("illustration") => return ImageKind::Illustration,
            Some("photo" | "hero" | "product" | "avatar") => return ImageKind::Photo,
            _ => {}
        }
        match (it.kind(), self.ctx.elem(i)) {
            (_, Elem::Icon) => ImageKind::Icon,
            (_, Elem::Logo) => ImageKind::Logo,
            (NodeType::Svg, _) => ImageKind::Illustration,
            (_, Elem::Photo) => ImageKind::Photo,
            (NodeType::Image, _) => ImageKind::Photo,
            _ => ImageKind::Unknown,
        }
    }
}
