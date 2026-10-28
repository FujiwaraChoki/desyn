# desyn-core API

Rust engine core shared by every client and service: document model, transactions (apply / invert / compose /
diff), canonical JSON, geometry, vector paths and booleans, layout (auto-layout, constraints, groups, text
auto-resize), hit testing, snapping, arrangement builders, clipboard, color math and plans.

* Contract: `docs/DOCUMENT_MODEL.md` (frozen). Op semantics, drop reasons and canonical JSON are pinned by
  `spec/fixtures/README.md`; this crate passes every fixture in `spec/fixtures/{canonical,nodes,ops,layout}`.
* Builds for `wasm32-unknown-unknown` with default features (no system randomness, no filesystem, no threads).
* Feature `std-fs`: `Design::load(path)` / `Design::save(path)` (canonical JSON). Not for wasm.

```toml
desyn-core = { path = "../desyn-core" }                       # wasm, worker, desktop, ffi
desyn-core = { path = "../desyn-core", features = ["std-fs"] } # native tools that read / write files
```

Everything below is `pub` and documented with rustdoc (`cargo doc -p desyn-core --open`).

## Module map

| module | what |
|---|---|
| `desyn_core` (root) | re-exports `model::*` and `ApplyOptions, ApplyResult, DirtySet, DropReason, Dropped, apply_transaction` |
| `model` | serde types (`Design`, `Node`, `Op`, `Transaction`, paints, text styles, assets, styles), factories, validation |
| `canonical` | canonical JSON + sha256 (byte-identical to `@desyn/schema` `canonicalize` / `hashCanonical`) |
| `ops` | `apply_transaction`, `apply_op`, `invert`, `compose`, `coalesce_ops`, `inverse_tx_id`, `check_op_schema` |
| `layout` | `TextMeasurer` trait, `ApproxMeasurer`, `normalize`, `normalize_all`, `plan_auto_layout`, constraints, groups |
| `geometry` | `Point`, `Rect`, `Affine`, `OrientedBox`, node transforms / bounds, distances |
| `paths` | SVG path parse / serialize, flatten, bounds, shape-to-path, line caps, node outlines, booleans, stroke outline |
| `hit` | `hit_test`, `hit_path`, `HitIndex`, `nodes_at`, `marquee`, `selection_bounds`, transform handles, resize math |
| `snap` | `SnapTargets`, `snap_move`, `snap_resize`, spacing guides, size matches, `distance_labels` |
| `arrange` | `align_nodes`, `distribute`, `tidy_grid`, `match_size`, `reorder` (z-order), `reorder_moves` |
| `diff` | `diff_ops`, `diff_designs` (minimal ops turning design A into B) |
| `clipboard` | `clone_subtree`, `duplicate`, `copy` / `paste_ops`, `ClipboardPayload`, `node_asset_refs`, `font_families` |
| `builder` | `TxBuilder` (apply-as-you-build with rollback), `round_geom`, `decompose_prefer` |
| `color` | `Rgba`, CSS parsing, HSL / HSV / OKLab / OKLCH, 16 blend modes, compositing, WCAG contrast, gradients, `resolve_color` |
| `plans` | typed `config/plans.json` (embedded): `can`, `limit`, `within_limit`, `credit_cost`, `plan_for_edition` |
| `ids` | `IdGen` trait, `SequentialIds` (tests), `RandomIds` (seeded xoshiro) |

## model

```rust
pub struct Design { schema: u32, id: Id, name: String, kind: DesignKind, nodes: NodeMap,
                    assets: BTreeMap<Id, AssetRef>, styles: DesignStyles, brand_kit_id: Option<String>,
                    meta: Map<String, Value>, extra: Map<String, Value> }
pub type NodeMap = IndexMap<Id, Node, FxBuildHasher>;   // O(1) lookups; iteration order is not meaningful
pub type Id = String;  pub const ROOT_ID: &str = "root";
```

* `Design` methods: `node(id)`, `node_mut(id)`, `root()`, `page_ids()`, `from_json(&str)`, `to_json()`,
  `canonical_json()`, `hash()` (sha256 of canonical JSON), `index_in_parent(id)`, `ancestors(id)`,
  `is_ancestor_or_self(a, id)`, `page_of(id)`, `depth(id)`, `subtree_ids(id)` (pre-order), `walk(id, f)`,
  `top_level_ids(ids)`, `sort_by_paint_order(ids)`, `push_child(parent, node)` (unvalidated builder for tests /
  importers). Factories: `Design::new(id, name, kind)` (root only), `Design::with_page(id, name, kind, page, w, h)`.
* `Node` — enum internally tagged on `"type"` (non-string tags are rejected): `Root, Page, Frame, Group, Boolean,
  Rect, Ellipse, Polygon, Star, Line, Path, Text, Image, Svg, Video, Audio, Chart, Table, Qr`; each variant is a struct
  `XxxNode { base: Base, <type fields>, extra }`. Accessors: `base()`, `base_mut()`, `id()`, `parent()`,
  `node_type() -> NodeType`, `children()`, `children_mut()`, `child_ids() -> &[Id]`, `is_container()`,
  `container() -> Option<&Container>` (`children, clip, layout`), `layout()`, `clips()`,
  `shaped() -> Option<&Shaped>` (`fills, strokes, corner_radius, corner_smoothing`), `fills()` (page background for
  pages), `strokes()`, `corner_radii() -> [tl, tr, br, bl]`, `paints_self()`, `extra()`.
* `Base`: `id, name, parent, x, y, width, height, rotation, flip_x, flip_y, opacity, blend, visible, locked, effects,
  role, constraints, sizing, aspect_locked, mask, link, alt, anim, notes, meta`; helpers `flipped_x()`,
  `flipped_y()`, `is_mask()`, `sizing_or_fixed()`, `constraints_or_default()`. `Base::new(id, name, x, y, w, h)` uses
  the factory defaults (parent `"root"`, opacity 1, normal blend, visible, unlocked).
* Forward compatibility: every JSON object of the model keeps unknown keys in an `extra` map (nodes, fills, stops,
  strokes, effects, text styles, runs, layout, constraints, sizing, assets, styles, design, ...), so documents from
  newer clients round-trip unchanged. Optional fields reject explicit `null` (as zod does).
* Integer counts (`sides`, `points`, `maxLines`, grid / layout `columns`, table `rows` / `cols` / `r` / `c` /
  `colspan` / `rowspan`) are `u64` accepting every JavaScript safe integer (`0..=MAX_SAFE_INTEGER`, 2^53 - 1), exactly
  like zod's `z.int()`; integral floats such as `5.0` load as integers. Engines must treat them as untrusted:
  geometry helpers clamp (`MAX_POLYGON_VERTICES`), layout uses them without allocating per unit.
* Values: `Color` (validated `#rrggbb` / `#rrggbbaa` newtype; `new`, `as_str`, `rgba8`, `rgba_f64`,
  `from_rgba8`), `ColorRef` (`var(name)` / `style(id)`), `ColorValue = Color | ColorRef`, `Fill` (`solid`, `linear`,
  `radial`, `conic`, `image`; `Fill::solid(color)`, `flags()`, `is_visible()`, `stops()`), `Stroke`
  (`Stroke::solid(color, w)`, `is_visible()`, `outset()`), `Effect` (`outsets()` for render bounds), `TextStyle` /
  `TextStylePatch` (`merged`), `ParagraphStyle` / `ParagraphStylePatch`, `LineHeight::resolve`, `TextRun`,
  `AutoLayout`, `CornerRadius` (`Uniform | PerCorner`, `corners()`), `AssetRef::new(id, kind, mime)`,
  `DesignStyles { colors, text, effects, variables, extra }`. Every string union is a Rust enum with `as_str()`,
  `FromStr`, `Display` and `ALL` (`BlendMode`, `DesignKind`, `NodeType`, `Cap`, `LayoutMode`, ...).
* Factories (defaults identical to `packages/schema/src/defaults.ts`: Inter 400 24px `#111111`, 120% line height,
  shapes `#d9d9d9`): `Node::root()`, `Node::page(id, name, w, h)`, `Node::frame|group|rect|ellipse(id, name, x, y, w, h)`,
  `Node::boolean(id, name, op, x, y, w, h)`, `Node::polygon(id, name, sides, x, y, w, h)`,
  `Node::star(id, name, points, inner_ratio, x, y, w, h)`, `Node::line(id, name, x, y, length)`,
  `Node::path(id, name, d, x, y, w, h)`, `Node::text(id, text, x, y, Option<width>)`,
  `Node::image|svg(id, name, asset_id, x, y, w, h)`, `Node::qr(id, data, x, y, size)`, `.with_parent(p)`,
  `TextStyle::default_style()`, `ParagraphStyle::default_style()`.
* Ops: `Op::{Create(CreateOp), Update(UpdateOp), Patch(PatchOp), Delete(DeleteOp), Move(MoveOp), Asset(AssetOp),
  Styles(StylesOp), Doc(DocOp), Invalid { raw, error }}` serialized with the `"op"` tag. A malformed op inside a
  transaction parses as `Op::Invalid` (dropped with the reason the reference applier gives) instead of failing the
  whole transaction. `PathSeg = Index(i64) | Key(String)`. `DocOp { set: DocSet, unset: Option<Vec<DocField>> }`.
  Helpers: `Op::from_value`, `Op::kind()`, `Op::update_set`, `Op::delete`, `Op::move_to`, `Op::patch`, `Op::create`.
  `Transaction { id, label, ops, source: TxSource, actor: Option<Actor>, ts }`, `Transaction::new(id, label, ops)`.
* Validation: `validate_design(&Design) -> Vec<Violation>` (all invariants + schema rules), `validate_node(&Node)`,
  `check_node_schema`, `check_fill`, `check_asset_schema`, `check_styles_schema`, `is_id`, `is_node_id`.

## canonical

`canonical_json(&Value) -> String`, `canonical_string<T: Serialize>(&T)`, `canonical_hash<T>(&T)` (sha256 hex),
`sha256_hex(&[u8])`, `normalize_number(f64)`, `canonical_number_string(f64)`, `normalize_value(&Value)`,
`js_number_string(f64)` (JavaScript `String(n)`), `js_round(f64)`, `key_cmp`. Rules: keys by code point, integers
verbatim, other numbers rounded half away from zero to 6 decimals, no `-0`, plain decimal, `JSON.stringify` string
escaping. `serde_json` is compiled with `float_roundtrip` so parsing is exact.

## ops

```rust
pub fn apply_transaction(design: &mut Design, tx: &Transaction, opts: ApplyOptions<'_>) -> ApplyResult;
pub struct ApplyOptions<'a> { pub normalize: bool, pub measurer: Option<&'a mut dyn TextMeasurer>, pub inverse_id: Option<Id> }
pub struct ApplyResult { pub inverse: Transaction, pub applied: Vec<Op>, pub dropped: Vec<Dropped> }
pub struct Dropped { pub index: usize, pub reason: DropReason }      // {"index": 2, "reason": "cycle"}
pub fn apply_op(design: &mut Design, op: &Op) -> Result<(Op /*applied*/, Op /*inverse*/), DropReason>;
pub fn invert(design: &Design, tx: &Transaction) -> Transaction;      // clones the design
pub fn compose(txs: &[Transaction], opts: ComposeOptions) -> Option<Transaction>;  // undo grouping
pub fn coalesce_ops(ops: &[Op]) -> Vec<Op>;
pub fn inverse_tx_id(tx_id: &str) -> Id;                              // sha256("inverse:" + id)[..12]
pub fn check_op_schema(op: &Op) -> Result<(), String>;                // strict OpSchema (id patterns, node schemas)
```

* Mutates the design in place (no clone). Semantics, check order, drop reasons (`invalid-op`, `missing-node`,
  `missing-parent`, `not-container`, `cycle`, `duplicate-id`, `immutable-field`, `invalid-node`, `root-protected`,
  `page-nesting`, `invalid-path`, `invalid-value`), normalized `applied` forms and inverse shapes are identical to
  `@desyn/doc-ops` (`spec/fixtures/README.md`). Never panics on bad input.
* `normalize: false` = the fixture / TypeScript semantics. `normalize: true` runs [`layout::normalize`] afterwards and
  appends the derived geometry changes to `applied` as `update` ops (`x`, `y`, `width`, `height`), so a TS server
  replaying `applied` verbatim reaches the same state; the inverse also restores them. Apply inverses with
  `normalize: false` (on normalized designs `true` is a no-op).
* `DirtySet { nodes, containers, resized, explicit_geometry }` describes what a transaction touched;
  `DirtySet::all(&design)`.

## layout

```rust
pub trait TextMeasurer { fn measure(&mut self, req: &TextMeasureRequest<'_>) -> TextMetrics; }
pub struct TextMeasureRequest<'a> { pub runs: &'a [TextRun], pub style: &'a TextStyle, pub paragraph: &'a ParagraphStyle,
                                    pub max_width: Option<f64>, pub max_lines: Option<u32> }
pub struct TextMetrics { pub width: f64, pub height: f64, pub lines: u32, pub baseline: f64 /* first baseline from top */ }
pub struct ApproxMeasurer;                                            // deterministic, font-free
pub fn measure_text_node(m: &mut dyn TextMeasurer, t: &TextNode, max_width: Option<f64>) -> TextMetrics;
pub fn vertical_offset(align: VerticalAlign, box_h: f64, content_h: f64) -> f64;
pub fn normalize(d: &mut Design, m: &mut dyn TextMeasurer, dirty: &DirtySet) -> Vec<GeometryChange>;
pub fn normalize_all(d: &mut Design, m: &mut dyn TextMeasurer) -> Vec<GeometryChange>;   // worker /v1/layout
pub fn plan_auto_layout(d: &Design, m: &mut dyn TextMeasurer, id: &str, inner_w: Option<f64>, inner_h: Option<f64>) -> Option<LayoutPlan>;
pub fn constrain_box(c: &Constraints, child: (x, y, w, h), old: (w, h), new: (w, h)) -> (x, y, w, h);
pub fn fit_group_bounds(d: &mut Design, id: &str) -> bool;
pub struct GeometryChange { pub id: Id, pub before: Geo, pub after: Geo }   // Geo { x, y, width, height }
```

* `desyn-text` implements `TextMeasurer` with real fonts (`&mut self` so it can own a font system / caches).
* Text auto-resize: `width` = box sized from the unwrapped text; `height` = height for the fixed width; `maxLines`
  truncates. Text inside auto-layout derives hug axes from `autoResize` (explicit `fill` wins).
* Auto-layout: `row` / `column` / `grid`, `gap`, `rowGap` (wrapped lines / grid rows, defaults to `gap`), padding,
  `mainAlign` (`start|center|end|space-between`), `crossAlign` (`start|center|end|stretch|baseline` — baseline via
  the measurer), `wrap`, `reverse`, grid `columns` (default `ceil(sqrt(n))`), hidden children skipped, rotated
  children occupy their bounding box, child sizing `fixed | hug | fill` (fill shares free space, never below an
  auto-layout child's hugged content), containers hug content + padding.
* Constraints (`left|right|center|stretch|scale` x `top|bottom|center|stretch|scale`) apply when a non-layout
  container is resized (by an op, a constraint or a parent layout); children whose geometry the same transaction set
  explicitly are left alone (keeps replays idempotent). Groups / booleans refit to their children (visible ones
  first) keeping children fixed in page space, honoring the group's rotation and flips.
* Derived geometry is always finite: a component that would overflow (absurd paddings / gaps near `f64::MAX`) keeps
  its previous value, so normalized designs stay valid and derived `update` ops never contain `null`. `maxLines`
  above `u32::MAX` reaches the measurer as `u32::MAX` (unlimited).
* Nesting: the contract has no depth limit, so every traversal is iterative or depth-bounded and fits a 1 MiB
  (wasm-sized) stack on 20,000-level chains (`tests/robustness.rs`): `Design::walk` / `sort_by_paint_order`,
  `ancestors` / `depth` (linear), `diff_ops`, clipboard, normalization (memoized depths) are unbounded; layout
  descends `MAX_LAYOUT_DEPTH` (128) levels (deeper containers keep their stored geometry), outlines and group masks
  `paths::MAX_OUTLINE_DEPTH` (128), hit testing 512.
* Order: constraints top-down, text auto-resize, then groups and auto-layout containers on the dirty ancestor chains
  deepest first. Idempotent.

## geometry

`Point` (`+ - * neg`, `dot`, `cross`, `length`, `distance`, `normalize`, `lerp`, `perp`), `Rect {x, y, w, h}`
(`from_points`, `bounding`, `right`, `bottom`, `center`, `corners`, `union`, `intersection`, `contains`,
`contains_rect`, `intersects`, `inflate`, `outset`, `translate`, `area`, `distance_to`, `distance_to_point`),
`union_bounds`, `Affine {a, b, c, d, e, f}` (`IDENTITY`, `new`, `translate`, `scale`, `rotate_deg`, `rotate_about`,
`apply`, `apply_vector`, `inverse`, `determinant`, `transform_rect_bbox`, `rotation_deg`, `scale_factors`, `to_kurbo`,
`a * b` applies `b` first), `OrientedBox { transform, width, height }` (`from_rect`, `corners`, `center`, `aabb`,
`contains(p, tol)`, `intersects` (SAT), `inside_rect`, `rotation_deg`).
Node helpers: `local_transform(&Base)` (translate · rotate about center · flip about center),
`local_transform_parts`, `world_transform(d, id)` (page-local; a page's own x/y is canvas placement and not
included), `parent_world_transform`, `node_obb`, `node_aabb`, `bounds_in_parent(&Base)`, `rotated_size(w, h, deg)`,
`decompose_local(&Affine, w, h) -> Placement {x, y, rotation, flip_x, flip_y}`, `reparent_placement(d, id, new_parent)`
(keep page position when moving under another container), `selection_aabb`. Distances: `point_segment_distance`,
`point_polyline_distance`, `point_in_polygon`, `winding_number`.

## paths

* `VectorPath { commands: Vec<PathCommand> }` — `parse(d)` (all SVG commands M L H V C S Q T A Z, relative and
  absolute, implicit repeats, compact numbers / flags; `S`/`T` resolved, `H`/`V` become lines, arcs kept),
  `to_svg()` (compact absolute, canonical numbers), `to_bez()` (arcs -> cubics), `from_bez`, `bounds()`,
  `transformed(&Affine)`. Shortcuts: `parse_svg_path(d) -> kurbo::BezPath`, `bez_to_svg`, `bez_bounds`.
  `paths::kurbo` re-exports the kurbo version in use.
* Flattening: `flatten_bez(path, tolerance) -> Vec<Polyline { points, closed }>`, `polylines_contain(polys, p, rule)`,
  `polylines_distance(polys, p)`.
* Hostile-input bounds (all path helpers): tolerances never drop below 1e-6 of the path extent (arcs: 1e-7 of the
  radius, never below 0.01 px), one `flatten_bez` call yields at most ~1M points (tolerance coarsened beyond), paths
  with coordinates beyond `MAX_COORDINATE` (1e150) or non-finite ones flatten / stroke / combine to nothing (so
  `i_overlay` never sees out-of-range input), dash patterns that would produce more than 100k dashes stroke solid,
  polygons / stars have at most `MAX_POLYGON_VERTICES` (4096) vertices. No helper panics or runs unbounded on any
  schema-valid document (`tests/robustness.rs`).
* Shapes (local box coordinates): `rect_path(w, h, [tl, tr, br, bl], smoothing)` (CSS radius clamping, Figma-style
  corner smoothing 0..1), `clamp_radii`, `ellipse_path(w, h, Option<&EllipseArc>)` (pie, arc, donut, ring; angles
  clockwise from 3 o'clock), `polygon_points` / `polygon_path(w, h, sides: u64, radius)`, `star_points` /
  `star_path(w, h, points: u64, inner_ratio, radius)` (fitted to the box, rounded vertices; counts clamped to
  `3..=MAX_POLYGON_VERTICES` vertices), `rounded_polygon(pts, r)`,
  `line_geometry(length, stroke_width, start: Cap, end: Cap) -> LineGeometry { shaft, caps: Vec<(BezPath, filled)> }`
  for `arrow, triangle, circle, square, diamond, bar` (filled caps shorten the shaft), `cap_size(stroke_width)`.
* `node_outline(d, id, tolerance) -> Option<Outline { path, fill_rule }>` — fill geometry of any node in local
  coordinates (booleans computed from their children, groups as the union of children, image clip shapes, path nodes
  with mixed fill rules, lines as their stroke outline); `node_path_data` (SVG string); `line_outline`.
* Booleans: `boolean(&[Shape { path, fill_rule }], BoolOp, tolerance) -> BezPath` (`i_overlay`; union / intersect /
  exclude fold left, subtract removes every later shape from the first; result is polygons, outer and hole contours
  oppositely wound), `contours_to_bez`.
* Strokes: `stroke_outline(path, &StrokeStyle, tolerance)` (kurbo; caps, joins, miter limit, dashes),
  `aligned_stroke_outline(path, fill_rule, style, StrokeAlign, tolerance)` (inside / outside via booleans),
  `StrokeStyle::from(&Stroke)`.

## hit

```rust
pub struct HitOptions { pub deep: bool, pub include_locked: bool, pub include_hidden: bool, pub tolerance: f64 /* design px */ }
pub fn hit_test(d: &Design, page: &str, p: Point, o: &HitOptions) -> Option<Id>;     // page child, or deepest with `deep`
pub fn hit_path(d: &Design, page: &str, p: Point, o: &HitOptions) -> Option<Vec<Id>>; // page child .. deepest
pub fn nodes_at(d: &Design, page: &str, p: Point, o: &HitOptions) -> Vec<Id>;        // topmost first
pub fn marquee(d: &Design, page: &str, rect: Rect, mode: MarqueeMode /* Contain | Intersect */, o: &HitOptions) -> Vec<Id>;
pub struct HitIndex;  HitIndex::build(&d, page); idx.hit_test(&d, p, &o); idx.hit_path(&d, p, &o)
pub fn selection_bounds(d: &Design, ids: &[Id]) -> Option<SelectionBounds { aabb, obb, rotation }>;
pub fn transform_handles(bounds: &OrientedBox, zoom: f64, style: &HandleStyle) -> Handles { bounds, resize: Vec<Handle>, rotate: Vec<RotateZone> };
pub fn hit_handles(h: &Handles, p: Point) -> Option<HandleHit /* Resize(kind) | Rotate(corner) */>;
pub fn resize_box(b: &OrientedBox, handle: HandleKind, pointer: Point, o: &ResizeOptions { keep_aspect, from_center }) -> ResizeResult { bounds, flip_x, flip_y };
pub fn rotation_delta(center: Point, start: Point, pointer: Point, step: Option<f64>) -> f64;
```

* Points are page coordinates; divide screen tolerances by the zoom. Topmost first; honors visibility, locks,
  clipping (frames / pages / groups with `clip`), masks (a mask clips the following siblings until the next mask),
  rotation and flips, exact shapes (ellipse, rounded rect, polygons / stars / paths / booleans via outlines), stroke
  bands (inside / center / outside) for unfilled shapes, line shafts and caps, text boxes. Frames are hittable by
  their area; groups only through children; booleans by their combined shape.
* `HitIndex` (per page, built after each transaction, ~0.5 ms for 10k nodes) answers queries on 10k-node pages in
  ~10-20 µs and returns exactly what `hit_path` returns. The direct traversal needs no index (≈0.25 ms worst case on
  a flat 10k-node page) and is fine for one-off queries.
* Handles: 8 resize handles (`HandleKind` clockwise from top-left; edge handles hide when the selection is shorter
  than `min_side_for_edges` on screen) and 4 rotate zones outside the corners; `cursor_angle` for resize cursors.

## snap

```rust
pub struct SnapTargets { pub page: Option<Rect>, pub objects: Vec<Rect>, pub guides: Vec<(Axis, f64)>, pub grid: Vec<(Axis, f64)> }
SnapTargets::for_page(d, page, exclude_ids)   // visible top-level nodes + siblings of the moving nodes, page, guides, layout grid
pub fn snap_move(moving: Rect, t: &SnapTargets, o: &SnapOptions) -> SnapResult { dx, dy, guides, spacing, sizes };
pub fn snap_resize(moving: Rect, edges: ResizeEdges, t: &SnapTargets, o: &SnapOptions) -> SnapResult;
pub fn distance_labels(moving: Rect, objects: &[Rect], page: Option<Rect>) -> Vec<DistanceLabel { from, to, value }>;
pub struct SnapOptions { threshold /* design px */, objects, page, guides, grid, spacing }
```

Snap lines: object edges and centers, page edges and center, ruler guides, layout grid columns and baseline rows
(`SnapKind`). Equal spacing: matches existing gaps in the moving box's row / column or centers it between neighbors
(`SpacingGuide { axis, gap, segments }`). Resize snaps only the moving edges and reports width / height matches.

## arrange (design restored before returning; wrap the ops in a transaction)

`align_nodes(&mut d, ids, Alignment, AlignTo) -> Result<Vec<Op>, ArrangeError>`,
`distribute(&mut d, ids, DistributeAxis, spacing: Option<f64>)`, `tidy_grid(&mut d, ids, columns, gap)`,
`match_size(&mut d, ids, Dimension, &MatchTo)`, `reorder(&d, ids, ZOrder) -> Vec<Op>` (bring forward / send
backward / to front / to back), `reorder_moves(parent, current, target) -> Option<Vec<Op>>` (LIS-minimal moves),
`top_level_selection(&d, ids)`. Same rules and output as `packages/doc-ops/src/arrange.ts` (rotated bounds, locked
nodes stay, groups refit, geometry rounded to 1/10000 px).

## diff / clipboard / builder

* `diff_ops(a, b) -> Vec<Op>`, `diff_designs(a, b, tx_id) -> Transaction` — doc / asset / style ops, new regions as
  single `create`s, moves, deletes, retyped nodes rebuilt, LIS reorders, property updates (same algorithm as
  `diffOps` in `@desyn/doc-ops`). `apply(a, diff(a, b)) == b` canonically.
* `clone_subtree(&d, id, &mut dyn IdGen, &CloneOptions { parent, index, offset, name }) -> Option<ClonedSubtree { op, id_map }>`
  (fresh ids, renewed animation ids, `page:` links remapped), `duplicate(&mut d, ids, offset, idgen)`,
  `copy(&d, ids) -> Option<ClipboardPayload>` (subtrees with page-space placement, referenced assets incl. fonts,
  color / text styles, variables, bounds), `ClipboardPayload::{to_json, from_json}`, `CLIPBOARD_MIME`,
  `paste_ops(&d, &payload, parent, idgen, &PasteOptions { offset, center_at, index }) -> Vec<Op>`,
  `node_asset_refs(&Node)`, `font_families(&Node)`.
* `TxBuilder::new(&mut d)` — `push(op)`, `update(id, set, unset)` (only changed keys), `translate_in_page`,
  `refit_groups`, `finish() -> Vec<Op>` (rolls the design back). `round_geom`, `normalize_degrees`,
  `decompose_prefer`.

## color

`Rgba { r, g, b, a }` (`new`, `from_color`, `to_color`, `with_alpha`, `lerp` (premultiplied), `relative_luminance`,
`to_hsl` / `from_hsl`, `to_hsv` / `from_hsv`, `to_oklab` / `from_oklab`, `to_oklch` / `from_oklch`),
`parse_css_color` / `css_to_color` (hex 3/4/6/8, `rgb()`/`rgba()`/`hsl()`/`hsla()` comma or space syntax with
`/ alpha`, named colors, `transparent`), `resolve_color(&ColorValue, &DesignStyles)` (`$style`, `$var`),
`blend(mode, backdrop, source)` (W3C compositing for all 16 `BlendMode`s, separable and non-separable),
`blend_rgb`, `contrast_ratio`, `wcag_level(ratio, large)`, `sample_stops(&[Stop], &styles, t)`, `sample_resolved`,
`linear_gradient_t`, `radial_gradient_t`, `conic_gradient_t`.

## plans

`plans() -> &'static Plans` (embedded `config/plans.json`, `ALL_TRUE` expanded; `feature_keys` / `limit_keys` in config
order), `plan(id)`, `can(plan, feature) -> bool`, `limit(plan, key) -> Option<Limit /* Unlimited | Max(f64) */>`,
`within_limit(plan, key, used)`, `credit_cost(action) -> Option<f64>`, `Edition::{Hosted, Selfhost}`
(`from_env_value(DESYN_EDITION)`: exactly `"hosted"` is hosted, anything else self-hosted, no trimming, same as
`parseEdition`), `plan_for_edition(edition, Option<&SubscriptionInfo>, now_ms) -> &str`,
`parse_plans(json)`, `PLANS_JSON`.

## ids

`trait IdGen { fn next_id(&mut self) -> String }` (also implemented for `FnMut() -> String`), `SequentialIds::new("n")`
(`"n00000000001"`, ...), `RandomIds::from_u64(seed)` / `from_seed([u64; 4])` — seed from the platform CSPRNG
(`crypto.getRandomValues` in wasm hosts); same alphabet / rejection sampling as `newId()`.

## Performance (release, 32-core dev box; `cargo bench -p desyn-core`, budgets asserted in `tests/perf.rs`)

| operation on a 10k-node design | time |
|---|---|
| update geometry (+ normalize) | ~6-11 µs |
| update a child of an auto-layout frame (relayout of 99 siblings) | ~30 µs |
| move / create | ~2-3 µs |
| delete a 100-node subtree | ~25-100 µs |
| 20 updates in one transaction | ~120 µs |
| `HitIndex::build` / indexed query (worst case) | ~0.45 ms / ~15 µs |
| direct `hit_test`, flat 10k page, full-scan miss | ~0.24 ms |
| parse / canonical JSON of the whole design | ~45 ms / ~50 ms |
| `normalize_all` | ~11 ms |
