# desyn-raster API

The single renderer of Desyn: builds a **display list** from any page of a design, rasterizes it with
tiny-skia, and exports PNG / JPEG / WebP / SVG / PDF / PPTX / GIF / frame sequences. Shared by the wasm engine,
the desktop app, the iOS FFI, the render worker, the templates pipeline and the `desyn-render` CLI, so every
client draws identically. Builds and runs on `wasm32-unknown-unknown` (all exporters included; verified in a
wasm runtime by `tests/wasm.rs`).

```toml
desyn-raster = { path = "../desyn-raster" }                                       # pdf + pptx + gif (default)
desyn-raster = { path = "../desyn-raster", default-features = false }             # raster, PNG/JPEG/WebP, SVG, frames
desyn-raster = { path = "../desyn-raster", features = ["bundled-fonts"] }         # + desyn-text's bundled OFL fonts
desyn-raster = { path = "../desyn-raster", features = ["webp-lossy", "avif"] }    # native: libwebp (C), dav1d (system lib)
```

| feature | what |
|---|---|
| `pdf` (default) | PDF export through krilla 0.8 |
| `pptx` (default) | PowerPoint export (zip 9 + hand-written OOXML) |
| `gif` (default) | animated GIF export |
| `webp-lossy` | lossy WebP via libwebp (native only; without it WebP is lossless) |
| `avif` | AVIF decoding via dav1d (native, needs `libdav1d`) |
| `bundled-fonts` | desyn-text `bundled`, `bundled-noto`, `bundled-emoji` |
| `cli` | the `desyn-render` binary (enables pdf, pptx, gif, bundled-fonts) |

`cargo doc -p desyn-raster --open` documents every public item.

## Quick start

```rust
use desyn_raster::{Renderer, MemoryAssetStore, PageRenderOptions, RasterOptions, Viewport};
use desyn_raster::display::BuildOptions;
use desyn_raster::export::{self, ExportOptions, Format};

let mut store = MemoryAssetStore::new();
store.insert("img00000001", jpeg_bytes);                     // bytes by AssetRef id
let mut r = Renderer::new(desyn_text::TextEngine::with_bundled_fonts(), Box::new(store));

// One-shot page render (exports, thumbnails, AI previews).
let page = r.render_page(&design, &PageRenderOptions { scale: 2.0, ..Default::default() })?;
let png = export::bitmap::encode_png(&page.pixmap, Some(192.0))?;

// Interactive: build + rasterize into a host buffer, then redraw only the damage.
let view = Viewport { x: 0.0, y: 0.0, zoom: 0.5, width: 1600, height: 1000, device_scale: 2.0 };
let old = r.build(&design, &BuildOptions { raster_scale: view.scale(), ..Default::default() })?;
r.rasterize(&old, &mut pixmap.as_mut(), &RasterOptions::new(view.transform()));
let new = r.build(&edited, &BuildOptions { raster_scale: view.scale(), ..Default::default() })?;
let redrawn = r.redraw_damage(&old, &new, &mut pixmap.as_mut(), &view, None); // Vec<IntRect>

// Any format.
let out = export::export(&mut r, &design, &ExportOptions { format: Format::Pdf, ..Default::default() })?;
```

## Renderer (`desyn_raster::Renderer`)

Owns the `TextEngine`, the `AssetCache`, the display-list `BuildCache` and the `LayerCache`; keep one per
document view / worker thread (`Renderer: Send`).

| method | what |
|---|---|
| `new(TextEngine, Box<dyn AssetStore>)`, `empty()` | construct |
| `text()`, `text_mut()` | the text engine (register fonts: `text_mut().add_font_as(bytes, family)`) |
| `assets_mut() -> &mut AssetCache` | `insert(id, bytes)` (host-provided bytes win over the store), `remove`, `invalidate`, `set_store`, `set_budget`, `take_missing()` |
| `layer_cache_mut()` | `stats()`, `clear()` |
| `register_design_fonts(&Design) -> Vec<Id>` | adds the design's `font` assets to the text engine (called by `build`); returns ids without bytes |
| `build(&Design, &BuildOptions) -> Result<DisplayList>` | display list of one page (incremental: unchanged nodes reuse cached paint) |
| `rasterize(&DisplayList, &mut PixmapMut, &RasterOptions)` | draw (layer + resample caches on) |
| `redraw_damage(&old, &new, &mut PixmapMut, &Viewport, background) -> Vec<IntRect>` | damage-only redraw |
| `render_page(&Design, &PageRenderOptions) -> Result<RenderedPage { pixmap, region, scale, display_list }>` | build + rasterize a page or region |
| `clear_caches(assets: bool)`, `page_ids(&Design)` | |

`Viewport { x, y, zoom, width, height, device_scale }`: page point `(x, y)` maps to the top-left device pixel;
`transform()` = `scale(zoom * device_scale) * translate(-x, -y)`; `device_rect(&Rect)`.
`PageRenderOptions { page, scale, region, transparent, background, time_ms, bleed, only, hidden, show_hidden }`.
Output limits: `MAX_OUTPUT_SIDE` 16384 px, `MAX_OUTPUT_PIXELS` 16384², `output_size(&Rect, scale)`.

## Display lists (`desyn_raster::display`)

```rust
pub struct DisplayList { page, width, height, bleed, root: Layer, links: Vec<LinkArea>, fonts: FontTable,
                         missing_assets: Vec<Id>, missing_fonts: Vec<String>, warnings: Vec<String>, time_ms }
pub struct Layer { kind: LayerKind /* Page | Node | MaskGroup | Group */, node: Option<Id>, key: u64, paint_key: u64,
                   transform: Affine, opacity: f32, blend: BlendMode, clip: Option<Clip>, mask: Option<Box<LayerMask>>,
                   effects: Vec<LayerEffect>, items: Vec<Item>, content_bounds: Rect, bounds: Rect }
pub enum Item { Fill(FillItem), Stroke(StrokeItem), Image(ImageItem), Text(TextItem), Layer(Box<Layer>) }
```

* One `Layer` per rendered node (plus internal groups); items are in layer-local coordinates, `transform` maps
  to the parent, `bounds` is the paint bounds in the parent's space (transform, clip and effect outsets
  applied) for culling and damage.
* `key` is a **stable content hash** of everything the layer draws (node JSON, resolved styles, font / asset
  generations, animation pose, children keys, header); identical across runs, renderers and platforms (own
  64-bit hasher, not `RandomState`). Clients may cache rendered layers by `key` (+ device transform).
  `paint_key` covers the layer's own leaf items only.
* `FillItem { path: Arc<tiny_skia::Path>, rule, paint: Paint, opacity, blend, bounds }`, `StrokeItem` (centered
  stroke: `StrokeStyle { width, cap, join, miter_limit, dash }`), `ImageItem { image: Arc<RasterImage>,
  transform, opacity, blend, quality, bounds }`, `TextItem { outline, paint, opacity, blend, bold, runs:
  Vec<GlyphRunItem>, bounds }`.
* `Paint` (`desyn_raster::paint`): `Solid(Color4)`, `Linear { start, end, stops, spread, transform }`,
  `Radial { c0, r0, c1, r1, .. }` (two-circle), `Conic { center, start_deg, end_deg, .. }`,
  `Image(ImagePaint { image, transform, extend: Repeat | Clamp | Transparent, quality })`.
* `LayerEffect`: `DropShadow`, `InnerShadow` (CSS box-shadow semantics, sigma = blur / 2), `LayerBlur`,
  `BackgroundBlur` (sigma = radius / 2), `Glow`, `Noise { amount, scale, mono, seed }`.
* `LinkArea { quad, rect, target: Url(String) | Page(Id) }` from `node.link` and text span `link`s, parsed by
  `display::parse_link`: `page:<id>`, or URLs with the schemes in `LINK_SCHEMES` (`http`, `https`, `mailto`,
  `tel`); bare host names (`desyn.app/x`) and `//host` get `https:`; `javascript:`, `data:`, `file:` and other
  schemes, relative paths and links with control characters are dropped (exported SVG / PDF / PPTX open in
  browsers and office suites). PPTX turns `page:` links into slide jumps.
* `FontTable` / `GlyphRunItem { font, size, skew, bold, glyphs: Vec<GlyphItem { id, x, y, advance, text }>, text }`
  are filled only with `BuildOptions::vector` (real text in PDF / SVG).

`BuildOptions { page, show_hidden, background, only: Option<Vec<Id>>, hidden: Vec<Id>, time_ms, vector,
bleed, raster_scale }` — `only` renders selected subtrees (ancestors contribute transform / clip / opacity, not
paint; a mask node keeps masking selected members); `hidden` skips subtrees (e.g. the text node under a DOM editing overlay); `raster_scale` = expected device
px per design px (flattening tolerance, SVG filter fallbacks, grain size).

Damage: `damage(&old, &new) -> Vec<Rect>` (page space; layers compared by node id and key, leaf changes by
`paint_key`, reorders handled, effects damage their full extent) and `damage_rects(&old, &new, &view, bounds,
max_rects) -> Vec<IntRect>` (device, outset 1 px, merged, collapsed to their union beyond `max_rects`).
`MAX_RENDER_DEPTH` = 128 nesting levels (deeper nodes are not drawn; matches core layout depth).

### What each node draws

| node | rendering |
|---|---|
| rect / frame | rounded rect with per-corner radii and corner smoothing (core `rect_path`); frames clip children (`clip`), strokes above children |
| ellipse | full ellipse, arcs, pies, donuts (`arc`) |
| polygon / star / path / boolean | core outlines (`node_outline`; booleans via `i_overlay`), per-path fill rules |
| line | centered shaft with cap / join / dash, end decorations (arrow, triangle, circle, square, diamond, bar) in the stroke paint |
| group | children; clip to bounds when `clip` |
| text | desyn-text layout: glyph outlines with subpixel positions, synthetic bold / oblique, per-span fills (solid / gradient / image), highlights, underline / strikethrough, lists, COLR color glyphs (layers with gradients), bitmap emoji, `curve` (text on arc), outline `strokes` (inside / center / outside), span links, typewriter reveal |
| image | fill / fit / crop (`crop`, `zoom`) / tile, rect radii / ellipse / custom clip `shape`, adjustments (below), `maskAssetId` alpha matte, strokes, flips |
| svg | sanitized usvg tree converted to items (paths, linear / radial gradients, groups with opacity / blend / clip / mask, embedded images, nested SVG, text); `recolor`; filter groups and pattern paints rasterized with resvg; outline `strokes` around the union silhouette (stickers) |
| chart | bar, column, stacked-column, line, area, scatter (numeric x axis when labels are numbers), pie, donut, radar, funnel, progress; grid, axis ticks, value labels, legend, palette / series colors, `min` / `max` / `unit` |
| table | scaled column / row sizes, header tint + bold, stripes, cell fills, wrapped aligned text clipped to cells, col / row spans, border grid without doubled joints |
| qr | qrcode crate, error correction L/M/Q/H, square modules or `rounded` dots with rounded finder patterns, 1-module quiet zone |
| video | poster frame (`posterAssetId`) with fit and corner radius; without a poster a neutral frame with a play badge |
| audio | nothing (not visual) |

Fills: solid, linear (CSS angle), radial (ellipse in the box), conic (CSS start angle), image (fill / fit / tile /
stretch, `scale`, `offsetX/Y` as fractions of the box, `rotation`, `adjust`); per-paint opacity and blend modes.
Strokes: inside / center / outside (exact rings for rects / ellipses, boolean outlines otherwise), dashes, joins,
caps, miter limit, multiple strokes and paints. Effects and all 16 blend modes (`raster` section).

Missing assets never fail a build: they are listed in `missing_assets` (hosts fetch the bytes, call
`assets_mut().insert`, rebuild) and draw nothing; undecodable assets / unparsable path data become `warnings`.

### Image adjustments

`ImageAdjust` (nodes) and `Partial<ImageAdjust>` (image fills), applied once per image + parameters and cached:
exposure, brightness (midtone curve), contrast, highlights / shadows (extension keys, below), temperature, tint,
saturation, hue (CSS hue-rotate matrix), grayscale, sepia, duotone, blur (node px, sigma = radius / 2), sharpen
(unsharp mask), vignette and grain (box-space; baked into the pixels when the picture covers its box, otherwise
drawn as overlays). Named `filter` presets add to the explicit values: `vivid`, `warm`, `cool`, `mono`, `noir`,
`vintage`, `fade`, `dramatic`, `film`, `sunset`, `matte`, `chrome`, `lush`, `dusk` (`assets::FILTER_PRESETS`).

### Document-model extension keys read by the renderer (optional, kept in the models' `extra` maps)

| key | on | meaning |
|---|---|---|
| `maskType` | mask node | `"alpha"` (default) or `"luminance"` |
| `sides` | `Stroke` | `[top, right, bottom, left]` widths for rect-like nodes (per-side borders) |
| `highlights`, `shadows` | `ImageAdjust` / image-fill `adjust` | -1..1 tone adjustments |

## Rasterizer (`desyn_raster::raster`)

```rust
pub struct RasterOptions { transform: Affine /* page -> device */, region: Option<IntRect>, background: Option<Color4> }
pub fn rasterize(dl: &DisplayList, target: &mut PixmapMut, opts: &RasterOptions, cache: Option<&mut LayerCache>);
pub fn render_to_pixmap(dl, width, height, transform, background, cache) -> Option<Pixmap>;
pub fn render_layer(layer, width, height, transform) -> Option<Pixmap>;           // exporters' fallbacks
pub fn truncate_after(root: &Layer, target: &Layer) -> Option<Layer>;            // backdrop of a layer
pub fn render_region(root: &Layer, region: &Rect, scale) -> Option<Pixmap>;
pub fn skia_blend(BlendMode) -> tiny_skia::BlendMode;
```

* Pixels are premultiplied RGBA8 (`tiny_skia::Pixmap`, re-exported as `desyn_raster::tiny_skia`).
  `export::bitmap::pixmap_rgba` converts to straight alpha (canvas `ImageData`, CGImage, textures).
* `region` redraws only that device rectangle (pixels outside are untouched; the result equals a full render).
* Group opacity / blend / clip / mask / effects use offscreen layers only when needed (a single leaf takes the
  opacity and blend mode directly); axis-aligned, pixel-aligned rectangular clips cost nothing.
* Masks: alpha and luminance (`Mask::from_pixmap`); a mask node masks the following siblings up to the next
  mask; an invisible mask node, or one excluded by `BuildOptions::hidden`, masks nothing (its members draw
  unmasked). Blend modes: all 16 (overlay / hard-light run on the float
  pipeline: tiny-skia's 8-bit pipeline overflows for them).
* Effects: three-box gaussian blur (cost independent of radius), dilation / erosion for shadow spread, inner
  shadows, glow, layer blur, background blur (the backdrop already drawn, blurred and *replacing* the
  backdrop inside the layer's shape coverage, also when the backdrop is a translucent offscreen group), device-anchored noise.
* Images: mip levels for downscaling, a cached separable Mitchell resample at the exact device size for
  axis-aligned draws (computed on first use for upscales and mild downscales, where it is cheaper than direct
  bicubic sampling; strong downscales only when the same size is drawn twice, so zoom gestures never pay for
  wide kernels; matches direct bicubic sampling), direct row copies for opaque pixel-aligned pictures.
* `LayerCache` (128 MB default): layers with effects / masks are cached by `(key, device transform)` and reused
  under integer translations (panning); resampled images share the budget.

## Exporters (`desyn_raster::export`)

```rust
pub fn export(&mut Renderer, &Design, &ExportOptions) -> Result<ExportOutput, RenderError>;
pub fn export_pages(&mut Renderer, &Design, &ExportOptions) -> Result<Vec<(Id, ExportOutput)>, RenderError>;
pub struct ExportOptions { format: Format, pages: PageSelection /* First | Id | Index | All */, scale, dpi: Option<f64>,
    quality: u8, background: Background /* Page | Transparent | Color(Color4) */, region: Option<Rect>, time_ms,
    pdf: PdfOptions { bleed, crop_marks, cmyk, flatten, dpi, title }, svg_text: SvgText /* Text { embed_fonts } | Outlines */,
    anim: AnimOptions { fps, duration_ms, max_frames }, only, hidden }
pub struct ExportOutput { bytes, mime, extension, pages, missing_assets, missing_fonts, warnings }
```

| format | details |
|---|---|
| PNG | straight alpha, sRGB chunk, `pHYs` DPI (default 96 x scale) — `bitmap::encode_png` |
| JPEG | quality 1..100, flattened on white (or the background color), JFIF density — `bitmap::encode_jpeg` |
| WebP | lossless (pure Rust) or lossy with `webp-lossy` when quality < 100 — `bitmap::encode_webp`; max 16383 px |
| SVG | own writer: groups, `matrix()` transforms, opacity, `mix-blend-mode`, clip paths, alpha / luminance masks, filters (drop / inner shadow, blur, glow), linear / radial gradients, image patterns, embedded images (original JPEG / PNG / WebP bytes), text as `<text>` with `@font-face` embedding (one per font file, variable axes via `font-variation-settings`) or as outlines, links; conic gradients, noise (grain) layers and background blurs (with their backdrop) become images |
| PDF | krilla: vector paths and gradients, real text with subset-embedded fonts (selectable / searchable, variable instances), images passed through, clips, masks, opacity, blend modes, URL + page links, multi-page, `bleed` (BleedBox / TrimBox), `crop_marks` (slug + registration-color marks), `cmyk` (DeviceCMYK), `flatten` (one image per page at `dpi`); layers with effects render as images at `dpi`, background blur with its backdrop |
| PPTX | slide size from the page (scaled into PowerPoint's 1-56 in limits), shapes (preset / custom geometry), solid / gradient / image fills, outlines (dash, cap, join, inset), shadows / glow, connectors with arrow heads, text boxes (runs: font, size, bold, italic, underline, strike, caps, spacing, color, highlight, links; paragraphs: alignment, line height, spacing, bullets / numbering, RTL), pictures with crop rectangles, groups / frames, page background, transitions, speaker notes; unsupported content becomes 2x pictures (listed in `warnings`) |
| GIF | timeline frames at `fps`, NeuQuant palette, looping, transparent background when requested |

Frames for video (`frames::render_frames(&mut Renderer, &Design, pages, &opts, |Frame { index, time_ms, pixmap }| ...)
-> FrameSequence { width, height, fps, frames, duration_ms }`): one page plays its animations; several pages
play in order (each for `durationMs` or its animations' length) with page transitions (fade, dissolve, slide,
push, zoom). The worker pipes the RGBA frames to ffmpeg for MP4.

Worker `/v1/render` mapping: `format` -> `Format` (`mp4` -> `frames::render_frames` + ffmpeg), `pageId` ->
`PageSelection::Id` (`"all"` -> `All`), `region`, `scale`, `quality`, `background` (`"transparent"` ->
`Background::Transparent`, a color -> `Background::Color`), `pdf.{bleed, cropMarks, cmyk}` -> `PdfOptions`,
`assetUrls` -> download, then `MemoryAssetStore` / `AssetCache::insert`.

## Assets (`desyn_raster::assets`)

* `trait AssetStore: Send { fn load(&self, id, Option<&AssetRef>) -> Option<Arc<[u8]>> }`; `MemoryAssetStore`,
  `NoAssets`, `DirAssetStore` (native: `<dir>/<id>`, `<dir>/<id>.<ext>`, or the `storageKey` file name; path
  traversal refused).
* `AssetCache`: decoded images (`RasterImage`: premultiplied pixmap, original bytes for pass-through, mips,
  padded copies), adjusted images, parsed SVG trees, LRU memory budget (768 MB default), generation counter
  (part of layer keys), `take_missing()`.
* `decode_image` (PNG, JPEG, GIF, WebP, BMP; AVIF with `avif`): decompression-bomb limits, EXIF orientation
  applied (as browsers do; such images are re-encoded instead of passed through), downscale above 8192 px. `parse_svg`: usvg with no file or network access (only `data:` images), 8 MB limit, scripts /
  foreignObject / event attributes never execute (usvg is a render tree).

## Animation (`desyn_raster::anim`)

`evaluate(&[Animation], Option<f64>, &AnimContext) -> AnimState { opacity, dx, dy, scale, rotate, blur, wipe,
typewriter }`; `ease(Easing, p)` (linear, CSS ease / ease-in / ease-out / ease-in-out cubic-beziers, spring);
`page_duration(&Design, page)`; `page_is_animated`. Phases: `in` rests in the preset's initial pose before its
start, `out` holds the designed state until its start and stays hidden after, `loop` repeats from its start
(pulse / float / shake / rotate have dedicated loops, other presets ping-pong). Several animations compose.
`BuildOptions::time_ms` applies the pose (transform about the node center, opacity, blur, wipe clip, text
reveal).

## CLI

```
desyn-render design.json -o out.pdf --assets assets/ --page all --bleed --crop-marks
desyn-render design.json --format frames --fps 30 -o frames/          # frame-00001.png ... + frames.json
desyn-render - --format png < request.json > out.png                   # bare design or { "design": ... }
desyn-render --help
```

Exit codes: 0 ok, 1 runtime / i/o, 2 invalid options, 3 invalid design or page. `--info` prints
`{ missingAssets, missingFonts, warnings, output }` to stderr.

## Performance (release, this 32-core machine; `cargo bench --bench raster`, budgets asserted in `tests/perf.rs`)

| case | time |
|---|---|
| 1080x1080 social design (photo + adjustments, scrim, text, shadowed button, SVG logo), warm build + rasterize | 3.7 ms (budget 8 ms) |
| same, first render with a fresh `Renderer` (JPEG decode, adjustments, shaping, SVG parse, resample) | 29-30 ms |
| same, rasterize with no `LayerCache` at all (direct bicubic) | 31 ms |
| resize the full-bleed photo (new device size and vignette box every frame): rebuild + damage + redraw | 14 ms (asserted < 24 ms) |
| move a rectangle: rebuild + damage + redraw | 0.03-0.7 ms (budget 2 ms) |
| build, warm (incremental, unchanged nodes) | 8-20 µs |
| charts sheet 980x980 / text page 480x480 | 2.2 ms / 1.3 ms |
| export social: PNG / SVG (outlines) / PDF / PPTX | 7.8 / 3.0 / 26 / 16 ms |

## Limits and fallbacks

* Nesting deeper than 128 levels is not drawn; offscreen layers and fallbacks are capped at 16384 px; charts
  draw at most 2000 categories / 64 series; tables 2000 rows / 200 columns; QR payloads up to 2953 bytes.
* `diamond` gradients and pattern fills are not part of the document model; SVG has no background blur or conic
  gradient (images instead); PPTX fallbacks are pictures; PDF effects are images at the export DPI.
