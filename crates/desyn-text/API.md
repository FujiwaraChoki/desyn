# desyn-text API

The text engine every Desyn client shares: font database, CSS font matching and fallback, shaping (harfrust),
bidi, UAX #14 line breaking, rich paragraph layout, caret / selection geometry, glyph outlines, color glyphs and text
on paths. Builds for `wasm32-unknown-unknown` (no system fonts there; the host feeds bytes) and natively. It
implements `desyn_core::layout::TextMeasurer`, so core normalization uses real metrics.

```toml
desyn-text = { path = "../desyn-text" }                                     # wasm, ffi: host registers fonts
desyn-text = { path = "../desyn-text", features = ["bundled"] }             # + Inter, Instrument Sans/Serif, JetBrains Mono
desyn-text = { path = "../desyn-text", features = ["bundled", "bundled-noto", "bundled-emoji"] }  # + Arabic, Hebrew, mono emoji
desyn-text = { path = "../desyn-text", features = ["fetch"] }               # native: Google Fonts provider with disk cache
```

`cargo doc -p desyn-text --open` has rustdoc for everything below.

## Why this stack

cosmic-text 0.19 and parley 0.12 were evaluated. Neither covers first-line indent, list gutters / markers,
ellipsis truncation, a hyphenation hook, baseline shift, per-paragraph spacing before / after, text on paths or CSS
font matching over a database the host controls, and both own font discovery. The engine therefore builds on the
same maintained building blocks parley uses: **harfrust 0.14** (HarfBuzz port, googlefonts) for shaping,
**skrifa 0.48 / read-fonts 0.45** (googlefonts fontations) for parsing, metrics, variations, outlines, COLR and
bitmaps, **unicode-bidi**, **unicode-linebreak** (UAX #14), **unicode-segmentation**, **unicode-script**,
**unicode-properties** (emoji) and **wuff** (WOFF / WOFF2). Optional **ureq** for `fetch`.

## Quick start

```rust
use desyn_text::{TextEngine, LayoutOptions, TextContent, TextPosition};

let mut engine = TextEngine::with_bundled_fonts();          // or TextEngine::new() + engine.add_font(bytes)
let laid = engine.layout_node(&text_node, Some(&design.styles)); // node box, autoResize, maxLines, verticalAlign
for run in &laid.runs { /* run.instance, run.size, run.glyphs[i].{id,x,y}, run.color, run.span */ }
let caret = laid.caret_rect(TextPosition::new(3));
let pos = laid.hit_test_point(x, y);
let rects = laid.selection_rects(2..9);
let outline = engine.text_outline(&laid);                   // kurbo BezPath, box coordinates
desyn_core::layout::normalize_all(&mut design, &mut engine);  // real metrics for auto-resize / hug / baseline
```

## Modules and types

### `TextEngine` (root)

| method | what |
|---|---|
| `new()`, `with_db(FontDb)`, `with_bundled_fonts()` | construct (bundled list depends on features) |
| `db()`, `db_mut()` | the [`FontDb`] (fallback config lives in `db_mut().fallback`) |
| `add_font(bytes)`, `add_font_as(bytes, family)` | register TTF / OTF / TTC / OTC / WOFF / WOFF2 (`add_font_as` for design font assets, `AssetRef.family`) |
| `set_provider(Option<Box<dyn FontProvider>>)` | synchronous lazy loading of missing families (called once per family / weight / italic) |
| `take_font_requests()`, `font_requests()` | families needed but missing (no provider, or the provider had nothing): wasm hosts fetch, `add_font`, lay out again |
| `take_provider_errors()` | provider failures (layout continued with fallbacks) |
| `set_hyphenator(Option<Box<dyn Hyphenator>>)` | hook used when `LayoutOptions::hyphenate` |
| `layout(&TextContent, &LayoutOptions) -> LaidOutText` | full layout |
| `layout_node(&TextNode, Option<&DesignStyles>) -> LaidOutText` | `TextContent::from_node` + `LayoutOptions::for_node` |
| `measure_content(&TextContent, &LayoutOptions) -> TextMetrics` | cached measurement (no glyph placement) |
| `impl TextMeasurer` | `measure(&TextMeasureRequest)` for desyn-core |
| `glyph_path(instance, glyph, size)` | outline in px, y down, relative to the glyph origin (cached in font units) |
| `glyph_kind(instance, glyph)` | `Outline` / `Color` (COLR) / `Bitmap` (CBDT, sbix) |
| `text_paths(&LaidOutText) -> Vec<TextPath>` | paint-ordered geometry: highlights, glyphs (synthetic oblique applied, `stroke` = synthetic bold width), underlines / strikethroughs |
| `text_outline(&LaidOutText) -> BezPath`, `text_outline_vector -> VectorPath` | "convert text to outlines" (synthetic bold baked in) |
| `color_glyph(instance, glyph, size, foreground) -> Option<Vec<ColorLayer>>` | COLR v0 / v1 layers: path + `ColorPaint::{Solid, Linear, Radial, Sweep}` + `paint_transform` |
| `bitmap_glyph(instance, glyph, size) -> Option<BitmapGlyphImage>` | PNG / BGRA / mask with its placement rect |
| `clear_caches()`, `cache_stats()` | shape / measure / outline caches |

`TextEngine: Send` (the worker can keep one per thread or behind a mutex).

### `content`: input

* `TextContent { text, spans: Vec<Span { range, style: SpanStyle }>, paragraph: ParagraphFormat,
  paragraph_overrides: BTreeMap<usize, ParagraphFormat>, default_style }` — `plain(text, style, para)`,
  `from_runs(runs, base, paragraph, styles)`, `from_node(node, styles)`, `style_at(i)`, `paragraph_format(i)`.
* `SpanStyle { families, weight, italic, stretch, size, letter_spacing (em), word_spacing (em), case, underline,
  strikethrough, fills, color: Option<[u8;4]>, highlight, baseline_shift (px, + raises), features, variations,
  link, language }` — `from_text_style(&TextStyle, Option<&DesignStyles>)` (resolves `$var` / `$style` colors).
* `ParagraphFormat { align, direction, line_height: LineHeightSpec::{Auto, Px, Percent}, space_before,
  space_after, indent, list, list_level: Option<u8>, list_start }` — `from_paragraph_style`.

#### Model extensions (optional keys in the model's forward-compatible `extra` maps)

| key | on | meaning |
|---|---|---|
| `baselineShift` | `TextStyle` / run style | px, positive raises (superscript) |
| `wordSpacing` | `TextStyle` / run style | em added to word separators |
| `fontStretch` | `TextStyle` / run style | width in percent (50-200), drives `wdth` and CSS stretch matching |
| `lang` | `TextStyle` / run style | BCP 47 language for shaping, hyphenation and Han fallback (`ja`, `zh-Hant`, `ko`) |
| `spaceBefore` | `ParagraphStyle` | px before each paragraph but the first (`spacing` is the space after) |
| `listStart` | `ParagraphStyle` | first number of numbered lists |

List nesting: leading tab characters of a list paragraph set its level (one per tab, not drawn). Markers cycle
`• ◦ ▪` and `1. a. i.` by level; each level indents 1.5 em of the paragraph's first character.

### `LayoutOptions`

`{ width, height, auto_resize: AutoResize, max_lines, vertical_align, hyphenate }` — `wrapping(width)`,
`for_node(&TextNode)`. `AutoResize::Width` never wraps (box = content), `Height` wraps at `width` (box height =
content), `None` wraps at `width` in a fixed box (vertical alignment, `overflows`).

### `types`: output (`LaidOutText`, serde-serializable, camelCase)

* `LaidOutText { text, width, height (box), content_width, content_height, content_top (vertical-align offset),
  first_baseline, lines, runs, decorations, clusters, paragraphs, spans, truncated, overflows }`, `bounds()`.
* `Line { range (source bytes), paragraph, top, height, baseline, ascent, descent, x, width (visible, no trailing
  spaces), rtl, runs, clusters, ends_paragraph, ellipsis, hyphenated }`.
* `GlyphRun { kind: RunKind::{Text, ListMarker, Ellipsis, Hyphen}, face: FontId, instance: InstanceId, variations,
  size, span, line, rtl, range, baseline, x, width, color, synthetic_bold (stroke px), skew, glyphs }`,
  `Glyph { id, x, y (baseline incl. marks / shift), advance, cluster (source byte) }`. Runs are in visual order.
* `Decoration { kind: Underline | Strikethrough | Highlight, rect, span, line, color }`.
* `ClusterBox { range, line, x0, x1, rtl }` — grapheme boxes per line in visual order (ligatures split evenly).
* `ParagraphInfo { range, lines, rtl, list_level, marker }`.

All coordinates are box-local px, y down. Byte offsets index `LaidOutText::text`.

### `cursor`: caret, selection, navigation

`TextPosition { index, affinity: Affinity::{Upstream, Downstream} }` (soft wraps: upstream = end of the earlier line).
On `LaidOutText`: `hit_test_point(x, y)`, `caret_rect(pos) -> CaretRect { x, y, height, line, rtl }`,
`selection_rects(range) -> Vec<Rect>` (bidi-aware, newline marker across paragraph breaks), `line_at_y`,
`line_for_position`, `word_range(i)`, `next_word_boundary`, `prev_word_boundary`, `next_grapheme`, `prev_grapheme`,
`line_range(pos)`, `paragraph_range(i)`, `move_visual(pos, Movement::{Left, Right})` (bidi-aware),
`move_vertical(pos, delta, x)`. Free functions `utf8_to_utf16`, `utf16_to_utf8` for web hosts (DOM offsets are
UTF-16). `hit_test_point` returns the affinity that makes `caret_rect` draw at the clicked edge (bidi boundaries).

### `font`

* `FontDb`: `add_font`, `add_font_as`, `add_static_font` (zero-copy), `load_dir` (native), `faces()`, `face(id)`,
  `families()`, `family_faces`, `has_family`, `match_family(name, &MatchRequest) -> Option<FaceMatch>` (generic
  names expand), `variations_for(&FaceMatch, size, overrides)`, `instance(face, &variations) -> InstanceId`,
  `instance_info(id) -> &Instance { face(), variations(), metrics(): InstanceMetrics, coords() }`, `glyph_index`,
  `covers`, `covers_cluster`, `advance`, `glyph_bounds`, `font_data(id) -> (&[u8], index)` (embed in PDF / SVG),
  `generation()`, `fallback: FallbackConfig`.
* `FaceInfo { id, family, aliases, subfamily, full_name, postscript_name, weight, weight_range, stretch,
  stretch_range, style: FaceStyle::{Normal, Italic, Oblique(deg)}, ital_range, slnt_range, opsz_range, axes:
  Vec<AxisInfo>, named_instances: Vec<NamedInstanceInfo { name, postscript_name, coords }>, units_per_em, ascent,
  descent, line_gap, x_height, cap_height, monospace, color: ColorSupport, glyph_count, collection_index }`.
* CSS matching (`match_faces`, CSS Fonts 4 §5.2: stretch, then style, then weight with the 400-500 rule; variable
  ranges match inside the axis): `FaceMatch { face, weight, stretch, use_ital_axis, slnt, synthetic_bold
  (requested >= 600, rendered <= 500), synthetic_italic }`. Variable instances set `wght`, `wdth`, `ital`, `slnt`
  and `opsz` (= font size, clamped); explicit `TextStyle.variations` win.
* Fallback per grapheme cluster: emoji presentation -> `emoji_families` (color first; VS15 keeps text), the span's
  family stack, `FallbackConfig::for_script(script, lang)`, `default_families`, then any registered face that covers
  it. Uncovered text renders with the primary face and produces a `FontRequest { family, weight, italic, reason:
  Family | Fallback | Emoji }` naming the Google Fonts family to fetch.
* Providers: `trait FontProvider: Send { fn load(&mut self, &FontRequest) -> Result<Vec<Vec<u8>>, ProviderError> }`;
  `MemoryProvider` (host-registered bytes), `DirectoryProvider` (native, e.g. the worker's `FONTS_DIR`),
  `GoogleFontsProvider` (feature `fetch`, native: CSS2 API with weight / italic fallbacks, disk cache in
  `$DESYN_FONT_CACHE` | `$XDG_CACHE_HOME/desyn/fonts` | `~/.cache/desyn/fonts`, `offline(true)` serves only the
  cache, `with_endpoint` for mirrors; family names longer than 100 bytes or with control characters are never
  requested, and an https endpoint only downloads https font files).
* Untrusted bytes: `add_font*` never panics on malformed data. WOFF 1 table directories are validated before
  decoding (decoded size <= 128 MB, plausible zlib ratios), so a tiny file declaring 4 GB tables is rejected instead
  of aborting the process on allocation; WOFF2 has the same cap inside `wuff`.
* `bundled::{fonts(), register(&mut FontDb)}` (see `fonts/README.md`).

### `layout`

`Hyphenator` trait (`hyphenate(word, lang) -> Vec<byte offsets>`), `LayoutOptions`. Behaviour: one paragraph per
`\n` / U+2029; U+2028 is a forced line break; tabs render as four spaces; soft hyphens break with a visible hyphen
(only where the hyphen still fits the line); words wider than the line break at grapheme boundaries; trailing
spaces hang (they get caret boxes but no glyph runs, so underlines and highlights end at the last visible glyph);
alignment is visual (`left` is flush
left in RTL too, `justify` aligns its last line to the paragraph start); justification stretches spaces, or
between characters on CJK / Thai lines without spaces; letter spacing is skipped for cursive scripts and disables
optional ligatures; items split by a line break at a position unsafe to break are reshaped; line height uses
half-leading per run (`Auto` = ascent + descent + gap, `Percent` of each run's size, `Px`). Without any registered
font the engine falls back to `ApproxMeasurer`-compatible metrics (no glyphs, carets still work).

### `path_text`

`place_on_path(&LaidOutText, &BezPath, &PathTextOptions { offset, align: Start | Center | End, baseline_offset })
-> Vec<PlacedGlyph { run, glyph, transform: desyn_core::geometry::Affine, visible }>` (closed paths wrap),
`place_on_curve(&LaidOutText, curve_deg)` for `TextNode.curve` (positive = rainbow, negative = smile; sweep spans the
widest line; later lines are concentric), `placements_bounds`. Draw glyph `g` of run `r` with
`transform * glyph_path(...)`.

## Performance (release, this 32-core box; `cargo bench --bench text`, budget asserted in `tests/perf.rs`)

| 2 000-character paragraph wrapped at 600 px | time |
|---|---|
| Latin, cold caches (shaping included) | ~0.73-0.84 ms |
| Latin, warm shape cache | ~0.35-0.44 ms |
| Arabic, cold | ~0.73-0.81 ms |
| CJK, cold | ~0.56 ms |
| measure only, Latin cold | ~0.66 ms |
