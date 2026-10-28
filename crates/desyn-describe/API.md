# desyn-describe API

`cargo doc -p desyn-describe --open` has rustdoc for everything below.

```toml
desyn-describe = { path = "../desyn-describe" }   # depends on desyn-core + desyn-text; wasm32 compatible
```

## Entry points

```rust
pub fn describe(design: &Design, opts: &DescribeOptions, engine: &mut TextEngine,
                sampler: Option<&mut dyn ImageSampler>) -> Result<Description, DescribeError>;
pub fn lint(design, opts, engine, sampler) -> Result<Vec<Issue>, DescribeError>;      // == describe(..).issues
pub fn design_tokens(design: &Design, page_id: Option<&str>, engine: &mut TextEngine)
    -> Result<DesignTokens, DescribeError>;                                          // one page or every page
pub fn resolve_page(design, opts) -> Result<(&PageNode, usize), DescribeError>;
pub fn compact_value(desc: &Description, issues: Option<usize>) -> serde_json::Value; // @desyn/ai compactDescription
pub fn compact_text(desc: &Description, o: &CompactOptions) -> String;               // token-budgeted text
pub fn estimate_tokens(s: &str) -> usize;                                            // ceil(bytes / 4)
pub enum DescribeError { NoPages, PageNotFound(String) }
```

* Page: `pageId`, else the page of the first existing selected node, else the first page. An unknown `pageId` is
  an error (the TypeScript `describeDesign` falls back to the first page).
* `compact_text`: one line per entry; free text (names, text, alt, labels) is JSON-quoted and control characters
  elsewhere (roles, font families, ids in messages) are escaped, so design content cannot forge lines. It is
  still design data: hosts wrap it as untrusted content.
* `engine`: text is laid out with `desyn-text` (`layout_node`), so line counts, overflow, orphans and ink boxes
  are real. Register the design's fonts (`add_font_as(bytes, family)`) for exact results; without fonts the engine
  uses approximate metrics. Reuse one engine per document (shape caches).
* `sampler`: optional `ImageSampler` (`fn sample(&mut self, asset_id, region_in_0..1) -> Option<ImageSample
  { average, darkest, lightest }>`). `PixelSampler` implements it over decoded RGBA8 buffers
  (`insert(asset_id, w, h, rgba)`; at most 4096 pixels read per sample). Without a sampler, text on a photo gets
  the `on-image` flag and no contrast verdict.

## DescribeOptions (serde, camelCase; the worker / wasm request body)

| field | default | meaning |
|---|---|---|
| `pageId` (alias `page`) | see above | page to describe |
| `selection` | `[]` | echoed (existing ids only); selected nodes get the `selected` flag; picks the page |
| `maxDepth` (alias `depth`) | 8 (`full`), 4 (`summary`) | tree depth below the page (hard cap 64) |
| `includeHidden` | `true` | keep hidden nodes in the tree (`visible: false`) and mask nodes (they paint nothing); lints always skip them |
| `includeStyles` | `true` for `full`, else `false` | add `tokens` |
| `detail` | `"full"` | `"summary"` shortens node text to 160 characters |
| `maxNodes` | unlimited | pre-order cap on tree nodes; the rest is counted in `omitted` |
| `lint` | `true` | `false` leaves `issues` empty |
| `brand` | none | `BrandKit { name, colors: [{ value, name?, role? }], fonts: [{ family, role?, weight? }] }` (same shape as `@desyn/ai` `BrandKit`; extra keys ignored) |

## Description (DOCUMENT_MODEL section 7, names exact)

All contract fields with contract semantics. Additive fields (preserved by the loose zod schemas):

* `Description.readingOrder: Id[]` — content leaves (text, image, svg, video, chart, table, qr) in reading order.
* `Description.groups: SemanticGroup[]` — `{ id: "g1", kind, label, node?, ids, parts?, box, source }`;
  `kind` is one of `product-card | card | button | logo-lockup | image-with-caption | header | footer | nav-bar |
  list | grid | stat | quote | text-block | labelled-icon | role`; `source` is `role | container | containment |
  proximity | repetition`; `parts` lists the group ids a list / grid is made of. Containers that match get
  `DNode.semantic = label`.
* `Description.direction: "ltr" | "rtl"`, `Description.tokens?: DesignTokens`, `Description.omitted?: number`.
* `DNode.weight?: number` — visual weight 0..1 (1 = strongest element).
* `Issue.rule: string` — the precise rule (table below); `Issue.hint?: string` — one-sentence advice.

Conventions: `DNode.box` is the axis-aligned bounds of the rotated box in page coordinates (as `approxBounds` in
`@desyn/doc-ops`) with `rotation` = page-space rotation; `z` = pre-order paint index on the page; `font` is the
dominant run (most visible characters) with its resolved color; `fill` is the CSS-ish fill summary
(`#ffffff`, `linear(#a → #b) @50%`, `image(<id>)`), lines get `stroke <fills> <w>px`, QR codes
`qr(<fg> on <bg>)`; colors are `#rrggbb`. Issues are sorted most severe first, then by code order, then paint order.

### Lint rules

| rule | IssueCode | severity | fix |
|---|---|---|---|
| `low-contrast` | `low-contrast` | error below 0.7 x target, else warn | failing fills recolored (node style and/or the failing run overrides only; OKLCH lightness search, hue kept); node `opacity` set to 1 when no color can reach the target through it |
| `busy-background` | `low-contrast` | warn | — (hint: scrim / shadow) |
| `qr-contrast` | `low-contrast` | error below 3:1, else warn | `fg` / `bg` set to black on white |
| `tiny-text` | `tiny-text` | warn | font sizes raised to the minimum |
| `text-overflow` | `text-overflow` | warn | `height` = content height, `autoResize: "height"` |
| `text-truncated` | `text-overflow` | info | — |
| `text-clipped` | `text-overflow` | warn | — |
| `off-page` | `off-page` | error | moved onto the page |
| `cut-by-page` | `off-page` | warn | moved fully onto the page |
| `unsafe-margin` | `unsafe-margin` | warn | moved inside the safe area (when it fits) |
| `missing-bleed` | `unsafe-margin` | warn | box extended into the bleed |
| `misaligned` | `misaligned` | info | snapped to the shared line |
| `off-center` | `misaligned` | info | centered on the page |
| `uneven-spacing` | `uneven-spacing` | warn (lists / grids / nav), info (stacks) | items moved to the median gap |
| `orphan-line` / `widow-line` | `orphan-line` | info | — |
| `too-many-fonts` / `too-many-sizes` | `too-many-fonts` | warn / info | — |
| `off-brand-font` | `too-many-fonts` | warn | `fontFamily` set to the brand heading / body font |
| `too-many-colors` | `too-many-colors` | info | — |
| `off-brand-color` | `too-many-colors` | warn | literal colors (nodes and the page background; the page id is then in `ids`) replaced with the nearest brand color, keeping each use's alpha |
| `weak-hierarchy` | `weak-hierarchy` | warn / info | — |
| `image-low-res` | `image-low-res` | print: error below 150 dpi, warn below 270; screen: warn above 1.11x upscale, error above 2.5x | — |
| `missing-alt` | `missing-alt` | info | — |
| `overlap` | `overlap` | warn (at most 3 partners per text, 50 per page) | — |
| `text-covered` | `overlap` | error | — |
| `unlabeled-group` / `unnamed-important` | `unlabeled-group` | info | — |
| `empty-text` / `empty-frame` | `unlabeled-group` | info | `delete` |

Every fix is a list of contract `Op`s (`update` / `patch` / `delete`) meant to be applied as one transaction;
`tests/describe.rs` applies each fixture fix through `desyn_core::apply_transaction` and checks the issue is
gone. Position fixes are only offered when no rotated / flipped ancestor or auto-layout parent owns the position.

Contrast: each run's glyph color reaches the page through its fill opacity and the layer opacity (own times
ancestors); a run `highlight` is composited over the backdrop first. Masks (`mask: true`) paint nothing: they are
`visible: false` for every analysis (flag `mask` in the tree), and the siblings after a visible mask (up to the
next mask node, as the renderer groups them) are clipped to the mask's bounds. Text cut away entirely by a clip or
a mask gets no contrast verdict.

Thresholds: WCAG AA (4.5:1, 3:1 for large text: >= 24 px or bold >= 18.66 px); minimum text size per kind
(`kinds::min_text_size`: screen kinds scale with the page, print uses 6-7 pt); safe area from the
`@desyn/schema` page presets of the same size (kind-matched, `kinds::SAFE_AREA_PRESETS`, generated by
`scripts/safe-areas.ts`), else 4% of the shorter side (web pages and whiteboards have none); print = physical unit
or bleed, 300 dpi target; alignment tolerance 0.56% of the shorter side (3-12 px), lines within 1 px count as
aligned; palette colors merge below OKLab distance 0.025.

### Flags (`DNode.flags`)

`selected`, `mask`, `hidden-by-parent`, `rtl`, `on-image`, `low-contrast`, `busy-background`, `tiny-text`, `text-overflow`,
`truncated`, `clipped`, `orphan-line`, `widow-line`, `overlaps:<id>`, `covered-by:<id>`, `off-page`,
`overflows-page`, `unsafe-margin`, `missing-bleed`, `misaligned`, `off-center`, `uneven-spacing`,
`off-brand-color`, `off-brand-font`, `missing-alt`, `low-res`, `empty`.

## DesignTokens

`{ palette: [{ color, count, roles: ["background"|"fill"|"text"|"stroke"], style? }], typeScale: [{ size, count,
chars, families, weights, roles }], spacingScale: [{ value, count }], radii: [{ value, count }], colorStyles,
textStyles }`. Spacing = nearest-neighbor gaps between free-positioned siblings plus auto-layout gaps / paddings.

## Lower-level modules (public for hosts and tests)

`scene` (page flattening with transforms, clips, effective visibility / opacity, point grid), `ctx` (text facts,
contrast facts), `backdrop` (compositing what is behind a point), `paint` (color resolution, summaries,
`ensure_contrast`, `delta_e`), `text` (`TextFacts`), `semantic` (`group`, `GroupKind`, `Elem`), `order`
(`xy_cut`), `summary`, `tokens`, `lint` (`RULES`), `kinds`, `sampler`, `tree`, `usage`, `compact`.

## Performance (release, this 32-core machine; `tests/perf.rs`, `cargo bench --bench describe`)

| page | describe | compact_text |
|---|---|---|
| 288 nodes (48 cards) | ~1.8 ms | — |
| 300 nodes (50 cards) | ~1.4 ms | ~0.2 ms |
| 2,400 nodes (400 cards) | ~15-20 ms | ~1.2 ms |
| 9,600 nodes (1,600 cards) | ~90 ms | ~4.5 ms |

Robustness (`tests/robustness.rs`): 20,000-level nesting on a 1 MiB stack (release), coordinates near 1e300,
polygons with 10^12 points, 3,000 stacked texts; no panics, no non-finite numbers in the output.
