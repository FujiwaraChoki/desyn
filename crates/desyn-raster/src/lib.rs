//! Desyn renderer: display lists built from a design page, a tiny-skia rasterizer and every exporter.
//!
//! * [`display`]: [`DisplayList`] / [`Layer`] / [`Item`] trees with stable layer keys and paint bounds (layer
//!   caching, damage rectangles), built by [`Renderer::build`] from any page of a design.
//! * [`raster`]: rasterization with group opacity, all 16 blend modes, clips, alpha / luminance masks, shadows,
//!   blurs, glow, noise and damage-region redraws.
//! * [`assets`]: [`AssetStore`] (bytes by asset id) and the decoding [`AssetCache`] (images incl. adjustments, SVG).
//! * [`export`]: PNG / JPEG / WebP, SVG, PDF (krilla), PPTX, GIF and frame sequences.
//! * [`anim`]: the animation timeline evaluator.
//!
//! See `API.md` for the full surface.

#![warn(missing_docs)]

pub mod anim;
pub mod assets;
pub mod display;
mod error;
pub mod export;
pub mod geom;
pub mod hash;
pub mod paint;
pub mod raster;
mod renderer;

#[cfg(not(target_arch = "wasm32"))]
pub use assets::DirAssetStore;
pub use assets::{AssetCache, AssetStore, MemoryAssetStore, NoAssets, RasterImage};
pub use display::{BuildOptions, DisplayList, Item, Layer};
pub use error::RenderError;
pub use paint::{Color4, Paint};
pub use raster::{LayerCache, RasterOptions, rasterize};
pub use renderer::{
    MAX_OUTPUT_PIXELS, MAX_OUTPUT_SIDE, PageRenderOptions, RenderedPage, Renderer, Viewport,
    output_size,
};

/// Re-export of the tiny-skia version in use (pixmaps cross the API).
pub use tiny_skia;
