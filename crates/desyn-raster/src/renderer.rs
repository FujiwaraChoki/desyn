//! [`Renderer`]: owns the text engine, asset cache, display-list cache and layer cache, and offers the common
//! build / rasterize / render-page entry points used by the wasm engine, the desktop app, the worker and the CLI.

use std::collections::HashSet;

use desyn_core::geometry::{Affine, Rect};
use desyn_core::model::{AssetKind, Design, Id, Node};
use desyn_text::TextEngine;
use tiny_skia::{IntRect, Pixmap, PixmapMut};

use crate::assets::{AssetCache, AssetStore, NoAssets};
use crate::display::{BuildCache, BuildOptions, DisplayList, DisplayListBuilder, damage_rects};
use crate::error::RenderError;
use crate::geom;
use crate::paint::Color4;
use crate::raster::{LayerCache, RasterOptions, rasterize};

/// Largest side of a rendered image (device pixels).
pub const MAX_OUTPUT_SIDE: u32 = 16384;
/// Largest rendered image area (device pixels).
pub const MAX_OUTPUT_PIXELS: u64 = 16384 * 16384;

/// Interactive viewport: which part of the page / canvas is visible and at what zoom.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Viewport {
    /// Page (design px) x shown at the left edge.
    pub x: f64,
    /// Page y shown at the top edge.
    pub y: f64,
    /// CSS px per design px.
    pub zoom: f64,
    /// Output width in device pixels.
    pub width: u32,
    /// Output height in device pixels.
    pub height: u32,
    /// Device pixels per CSS px.
    pub device_scale: f64,
}

impl Viewport {
    /// Page-to-device transform.
    pub fn transform(&self) -> Affine {
        let s = self.zoom * self.device_scale;
        Affine::scale(s, s) * Affine::translate(-self.x, -self.y)
    }

    /// Device pixels per design px.
    pub fn scale(&self) -> f64 {
        self.zoom * self.device_scale
    }

    /// Device rectangle covering a page-space rectangle (clipped to the viewport).
    pub fn device_rect(&self, r: &Rect) -> Option<IntRect> {
        let d = geom::round_out(&self.transform().transform_rect_bbox(r))?;
        geom::intersect(
            &d,
            &IntRect::from_xywh(0, 0, self.width.max(1), self.height.max(1))?,
        )
    }
}

/// What a page render covers and how.
#[derive(Debug, Clone, PartialEq)]
pub struct PageRenderOptions {
    /// Page (`None` = first).
    pub page: Option<Id>,
    /// Device pixels per design px (2 = @2x).
    pub scale: f64,
    /// Page-space region to render (`None` = the page, plus bleed when `bleed`).
    pub region: Option<Rect>,
    /// Skip the page background (transparent export).
    pub transparent: bool,
    /// Color painted under everything (JPEG exports use white).
    pub background: Option<Color4>,
    /// Animation time.
    pub time_ms: Option<f64>,
    /// Include the page bleed area.
    pub bleed: bool,
    /// Render only these subtrees.
    pub only: Option<Vec<Id>>,
    /// Never render these subtrees.
    pub hidden: Vec<Id>,
    /// Render invisible nodes.
    pub show_hidden: bool,
}

impl Default for PageRenderOptions {
    fn default() -> Self {
        PageRenderOptions {
            page: None,
            scale: 1.0,
            region: None,
            transparent: false,
            background: None,
            time_ms: None,
            bleed: false,
            only: None,
            hidden: Vec::new(),
            show_hidden: false,
        }
    }
}

/// A rendered page region.
#[derive(Debug)]
pub struct RenderedPage {
    /// Premultiplied RGBA pixels.
    pub pixmap: Pixmap,
    /// Page-space rectangle the pixmap covers.
    pub region: Rect,
    /// Device pixels per design px.
    pub scale: f64,
    /// The display list that was rasterized.
    pub display_list: DisplayList,
}

/// Renderer state shared across renders.
pub struct Renderer {
    text: TextEngine,
    assets: AssetCache,
    build_cache: BuildCache,
    layer_cache: LayerCache,
    font_assets: HashSet<String>,
}

impl std::fmt::Debug for Renderer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Renderer")
            .field("assets", &self.assets)
            .field("build_cache", &self.build_cache.len())
            .field("layer_cache", &self.layer_cache)
            .finish()
    }
}

impl Renderer {
    /// Renderer over a text engine and an asset store.
    pub fn new(text: TextEngine, store: Box<dyn AssetStore>) -> Self {
        Renderer {
            text,
            assets: AssetCache::new(store),
            build_cache: BuildCache::new(),
            layer_cache: LayerCache::default(),
            font_assets: HashSet::new(),
        }
    }

    /// Renderer with an empty text engine and no assets (hosts register fonts / bytes later).
    pub fn empty() -> Self {
        Renderer::new(TextEngine::new(), Box::new(NoAssets))
    }

    /// Text engine.
    pub fn text(&self) -> &TextEngine {
        &self.text
    }

    /// Text engine (register fonts, providers).
    pub fn text_mut(&mut self) -> &mut TextEngine {
        &mut self.text
    }

    /// Asset cache (register bytes with `insert`, swap the store).
    pub fn assets_mut(&mut self) -> &mut AssetCache {
        &mut self.assets
    }

    /// Layer cache statistics / control.
    pub fn layer_cache_mut(&mut self) -> &mut LayerCache {
        &mut self.layer_cache
    }

    /// Drops every cache (decoded assets stay unless `assets` is true).
    pub fn clear_caches(&mut self, assets: bool) {
        self.build_cache.clear();
        self.layer_cache.clear();
        self.text.clear_caches();
        if assets {
            self.assets.clear();
        }
    }

    /// Registers the design's font assets (`AssetRef.kind == "font"`) with the text engine, once per asset id.
    /// Returns the ids that had no bytes yet.
    pub fn register_design_fonts(&mut self, design: &Design) -> Vec<String> {
        let mut missing = Vec::new();
        for (id, a) in &design.assets {
            if a.kind != AssetKind::Font || self.font_assets.contains(id) {
                continue;
            }
            match self.assets.bytes(id, Some(a)) {
                Some(bytes) => {
                    let r = match &a.family {
                        Some(f) if !f.trim().is_empty() => self.text.add_font_as(bytes.to_vec(), f),
                        _ => self.text.add_font(bytes.to_vec()),
                    };
                    if r.is_ok() {
                        self.font_assets.insert(id.clone());
                    }
                }
                None => missing.push(id.clone()),
            }
        }
        missing
    }

    /// Builds the display list of a page.
    pub fn build(
        &mut self,
        design: &Design,
        opts: &BuildOptions,
    ) -> Result<DisplayList, RenderError> {
        self.register_design_fonts(design);
        DisplayListBuilder::new(
            design,
            &mut self.text,
            &mut self.assets,
            &mut self.build_cache,
            opts,
        )
        .build()
    }

    /// Rasterizes a display list into a host buffer (layer cache enabled).
    pub fn rasterize(
        &mut self,
        dl: &DisplayList,
        target: &mut PixmapMut<'_>,
        opts: &RasterOptions,
    ) {
        rasterize(dl, target, opts, Some(&mut self.layer_cache));
    }

    /// Redraws only what changed between `old` and `new` in a viewport buffer that currently shows `old`.
    /// Returns the device rectangles that were redrawn.
    pub fn redraw_damage(
        &mut self,
        old: &DisplayList,
        new: &DisplayList,
        target: &mut PixmapMut<'_>,
        view: &Viewport,
        background: Option<Color4>,
    ) -> Vec<IntRect> {
        let Some(full) = IntRect::from_xywh(0, 0, target.width(), target.height()) else {
            return Vec::new();
        };
        let t = view.transform();
        let rects = damage_rects(old, new, &t, full, 8);
        for r in &rects {
            let opts = RasterOptions {
                transform: t,
                region: Some(*r),
                background,
            };
            rasterize(new, target, &opts, Some(&mut self.layer_cache));
        }
        rects
    }

    /// Builds and rasterizes a page region.
    pub fn render_page(
        &mut self,
        design: &Design,
        opts: &PageRenderOptions,
    ) -> Result<RenderedPage, RenderError> {
        if !(opts.scale.is_finite() && opts.scale > 0.0) {
            return Err(RenderError::InvalidOptions(format!("scale {}", opts.scale)));
        }
        let build = BuildOptions {
            page: opts.page.clone(),
            show_hidden: opts.show_hidden,
            background: !opts.transparent,
            only: opts.only.clone(),
            hidden: opts.hidden.clone(),
            time_ms: opts.time_ms,
            vector: false,
            bleed: opts.bleed,
            raster_scale: opts.scale,
        };
        let dl = self.build(design, &build)?;
        let region = opts.region.unwrap_or(if opts.bleed {
            dl.bleed_rect()
        } else {
            dl.page_rect()
        });
        let (w, h) = output_size(&region, opts.scale)?;
        let mut pixmap =
            Pixmap::new(w, h).ok_or_else(|| RenderError::TooLarge(format!("{w}x{h}")))?;
        let transform =
            Affine::scale(opts.scale, opts.scale) * Affine::translate(-region.x, -region.y);
        let ro = RasterOptions {
            transform,
            region: None,
            background: opts.background,
        };
        rasterize(&dl, &mut pixmap.as_mut(), &ro, Some(&mut self.layer_cache));
        Ok(RenderedPage {
            pixmap,
            region,
            scale: opts.scale,
            display_list: dl,
        })
    }

    /// Ids of the design's pages.
    pub fn page_ids(design: &Design) -> Vec<Id> {
        design
            .page_ids()
            .iter()
            .filter(|p| matches!(design.node(p), Some(Node::Page(_))))
            .cloned()
            .collect()
    }
}

/// Pixel size of a region at a scale (validated against the output limits).
pub fn output_size(region: &Rect, scale: f64) -> Result<(u32, u32), RenderError> {
    let w = (region.w * scale).round();
    let h = (region.h * scale).round();
    if !(w.is_finite() && h.is_finite()) || w < 1.0 || h < 1.0 {
        return Err(RenderError::InvalidOptions(format!(
            "empty output ({}x{} at scale {scale})",
            region.w, region.h
        )));
    }
    if w > f64::from(MAX_OUTPUT_SIDE)
        || h > f64::from(MAX_OUTPUT_SIDE)
        || w * h > MAX_OUTPUT_PIXELS as f64
    {
        return Err(RenderError::TooLarge(format!("{w}x{h} px")));
    }
    Ok((w as u32, h as u32))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renderer_is_send_and_viewport_maps() {
        fn assert_send<T: Send>() {}
        assert_send::<Renderer>();
        let v = Viewport {
            x: 100.0,
            y: 50.0,
            zoom: 0.5,
            width: 800,
            height: 600,
            device_scale: 2.0,
        };
        assert_eq!(v.scale(), 1.0);
        assert_eq!(
            v.transform()
                .apply(desyn_core::geometry::Point::new(100.0, 50.0))
                .x,
            0.0
        );
        let r = v.device_rect(&Rect::new(100.0, 50.0, 10.0, 10.0)).unwrap();
        assert_eq!((r.x(), r.y(), r.width(), r.height()), (0, 0, 10, 10));
        assert!(output_size(&Rect::new(0.0, 0.0, 100.0, 100.0), 0.001).is_err());
        assert!(output_size(&Rect::new(0.0, 0.0, 1e6, 10.0), 1.0).is_err());
    }
}
