//! Desyn text engine, shared by every client (native and `wasm32-unknown-unknown`; no system font access).
//!
//! * [`font`]: font database (TTF / OTF / TTC / WOFF / WOFF2, variable fonts with axes and named instances), CSS
//!   font matching, fallback chains (per script + emoji), lazy loading through [`font::FontProvider`] (Google Fonts
//!   with the `fetch` feature) and the bundled OFL set (`bundled`, `bundled-noto`, `bundled-emoji` features).
//! * [`TextEngine::layout`]: rich text layout (harfrust shaping, bidi, UAX #14 line breaking with a hyphenation
//!   hook, justification, lists, ellipsis, vertical alignment, auto-resize) producing [`LaidOutText`] with lines,
//!   glyph runs, decorations, caret clusters and paragraph info.
//! * [`cursor`]: caret / selection geometry, hit testing, word / line boundaries, visual movement, UTF-16 helpers.
//! * Outlines: [`TextEngine::glyph_path`], [`TextEngine::text_paths`], [`TextEngine::text_outline`], COLR layers
//!   and bitmap glyphs.
//! * [`path_text`]: glyph placements along a path and the `curve` text-on-arc layout.
//! * [`TextEngine`] implements `desyn_core::layout::TextMeasurer`, so core normalization (auto-resize, auto-layout
//!   hugging, baseline alignment) uses real font metrics.
//!
//! See `API.md` for the full surface and the document-model extension keys the engine reads.

pub mod content;
pub mod cursor;
mod engine;
pub mod font;
pub mod layout;
mod outline;
pub mod path_text;
mod shape;
pub mod types;

pub use content::{LineHeightSpec, ParagraphFormat, Span, SpanStyle, TextContent};
pub use cursor::{Affinity, CaretRect, Movement, TextPosition, utf8_to_utf16, utf16_to_utf8};
pub use engine::{CacheStats, TextEngine};
pub use font::{FontDb, FontId, FontProvider, FontRequest, InstanceId};
pub use layout::{Hyphenator, LayoutOptions};
pub use outline::{
    BitmapGlyphImage, BitmapImage, ColorLayer, ColorPaint, GlyphKind, GradientExtend, GradientStop,
    TextPath, TextPathKind,
};
pub use path_text::{
    PathAlign, PathTextOptions, PlacedGlyph, place_on_curve, place_on_path, placements_bounds,
};
pub use types::{
    ClusterBox, Decoration, DecorationKind, Glyph, GlyphRun, LaidOutText, Line, ParagraphInfo,
    RunKind,
};
