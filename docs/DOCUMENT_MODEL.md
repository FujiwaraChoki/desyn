# Desyn Document Model, Operations and Sync (FROZEN CONTRACT)

Every package that touches a design (Rust core, TS packages, Convex, web, desktop, iOS, AI, worker) MUST follow this
document. Names are exact. JSON is camelCase. The TS definitions below are the source of truth; `packages/schema`
turns them into zod + JSON Schema, `crates/desyn-core` mirrors them with serde (`#[serde(rename_all = "camelCase")]`,
internally tagged enums with the `type` / `op` field named below). Conformance fixtures in `spec/fixtures/` are the
arbiter: any implementation must round-trip them byte-for-byte equal after canonical JSON normalization.

If this document is wrong or ambiguous, change it in a minimal, additive way, note the change at the bottom under
"Change log", and keep every implementation in sync. Never fork the model silently.

## 1. Primitives

```ts
type Id = string;            // 12 chars [a-z0-9], generated client-side (nanoid alphabet lowercase+digits). "root" is reserved.
type Color = string;         // "#RRGGBB" or "#RRGGBBAA" (lowercase hex). No named colors, no rgb().
type Unit = "px" | "mm" | "in" | "pt";
type BlendMode = "normal" | "multiply" | "screen" | "overlay" | "darken" | "lighten" | "color-dodge" | "color-burn"
  | "hard-light" | "soft-light" | "difference" | "exclusion" | "hue" | "saturation" | "color" | "luminosity";
```

All geometry is in **design pixels** (1 px = 1/96 in) regardless of `Page.unit` (unit is for display / print export only).
Node `x`,`y` are relative to the parent's top-left (before parent rotation). `rotation` is degrees clockwise about the node
center. Origin top-left, y grows downward.

## 2. Design

```ts
interface Design {
  schema: 1;
  id: Id;
  name: string;
  kind: DesignKind;
  nodes: Record<Id, Node>;      // flat map. nodes["root"] is the RootNode whose children are the Page ids, in order.
  assets: Record<Id, AssetRef>; // assets referenced by nodes (images, svg, fonts, video, audio)
  styles: DesignStyles;         // reusable named styles + variables
  brandKitId?: string;          // Convex id of the brand kit this design follows (informational)
  meta: {                       // free-form, never interpreted by the engine
    createdAt?: number; updatedAt?: number; templateId?: string; tags?: string[]; locale?: string;
    [k: string]: unknown;
  };
}

type DesignKind =
  | "social-post" | "story" | "poster" | "flyer" | "thumbnail" | "banner" | "ad" | "presentation" | "infographic"
  | "business-card" | "resume" | "invitation" | "menu" | "logo" | "newsletter" | "document" | "whiteboard"
  | "website" | "video" | "book-cover" | "certificate" | "sticker" | "mockup" | "custom";

interface AssetRef {
  id: Id;
  kind: "image" | "svg" | "font" | "video" | "audio" | "lottie" | "data";
  url?: string;          // resolvable URL (signed or public) - filled by clients at load time, never persisted by Convex
  storageKey?: string;   // S3 object key (server-side truth)
  mime: string; bytes?: number; width?: number; height?: number; durationMs?: number;
  hash?: string;         // sha256 hex of the bytes (dedupe)
  name?: string; source?: "upload" | "ai" | "stock" | "template" | "brand";
  attribution?: { author?: string; license?: string; url?: string };
  ai?: { provider: string; model: string; prompt: string; seed?: number };
  family?: string; weight?: number; style?: "normal" | "italic"; // for fonts
}

interface DesignStyles {
  colors: Record<Id, { name: string; value: Color }>;
  text: Record<Id, { name: string; style: TextStyle; paragraph?: Partial<ParagraphStyle> }>;
  effects: Record<Id, { name: string; effects: Effect[] }>;
  variables: Record<string, string | number | boolean>; // e.g. "brand.primary": "#ffb02e"; referenced as {"$var":"brand.primary"}
}
```

A value anywhere a `Color` is expected MAY be `{ "$var": "<name>" }` or `{ "$style": "<styleId>" }` (resolved by the engine); keep
the type `Color | ColorRef` in schemas where noted (`Fill.color`, `TextStyle` fills).

## 3. Nodes

```ts
type Node = RootNode | PageNode | FrameNode | GroupNode | BooleanNode | RectNode | EllipseNode | PolygonNode | StarNode
  | LineNode | PathNode | TextNode | ImageNode | SvgNode | VideoNode | AudioNode | ChartNode | TableNode | QrNode;

interface BaseNode {
  id: Id;
  type: string;                 // discriminant, see each interface
  name: string;
  parent: Id | null;            // null only for root
  x: number; y: number; width: number; height: number; rotation: number; // degrees
  flipX?: boolean; flipY?: boolean;
  opacity: number;              // 0..1
  blend: BlendMode;
  visible: boolean;
  locked: boolean;
  effects: Effect[];
  role?: Role;                  // semantic role (AI + layout intelligence), see Role
  constraints?: { h: "left" | "right" | "center" | "stretch" | "scale"; v: "top" | "bottom" | "center" | "stretch" | "scale" };
  sizing?: { h: "fixed" | "hug" | "fill"; v: "fixed" | "hug" | "fill" }; // used inside auto-layout parents
  aspectLocked?: boolean;
  mask?: boolean;               // if true this node masks following siblings within its parent until the next mask (alpha mask)
  link?: string;                // url or "page:<pageId>"
  alt?: string;                 // accessibility description
  anim?: Animation[];           // entrance/exit/emphasis animations (video + presentations)
  notes?: string;               // speaker notes / designer notes (only meaningful on pages and frames)
  meta?: Record<string, unknown>; // e.g. { slot: "headline" } for template slots, { aiNote: "..." }
}

interface ContainerProps {
  children: Id[];               // ordered back-to-front (index 0 is bottom-most)
  clip: boolean;                // clip children to bounds
  layout?: AutoLayout;
}

interface AutoLayout {
  mode: "row" | "column" | "grid";
  gap: number; rowGap?: number;                       // gap = main-axis gap (column gap for grid)
  padding: [number, number, number, number];          // top right bottom left
  mainAlign: "start" | "center" | "end" | "space-between";
  crossAlign: "start" | "center" | "end" | "stretch" | "baseline";
  wrap?: boolean; columns?: number;                   // grid column count
  reverse?: boolean;
}

interface RootNode extends BaseNode, Pick<ContainerProps, "children"> { type: "root"; }   // x=y=0, size 0, children are PageNode ids

interface PageNode extends BaseNode, ContainerProps {
  type: "page";
  unit: Unit;
  background: Fill[];
  bleed: number;                // px, print bleed outside width/height
  durationMs?: number;          // for video / presentation auto-advance
  transition?: { kind: "none" | "fade" | "slide" | "push" | "zoom" | "dissolve"; durationMs: number };
  grid?: { columns: number; gutter: number; margin: number; baseline?: number }; // layout grid (guides)
  guides?: { axis: "x" | "y"; pos: number }[];
}

interface FrameNode extends BaseNode, ContainerProps, Shaped { type: "frame"; }
interface GroupNode extends BaseNode, ContainerProps { type: "group"; }              // no paint; bounds fit children
interface BooleanNode extends BaseNode, ContainerProps, Shaped { type: "boolean"; op: "union" | "subtract" | "intersect" | "exclude"; }

interface Shaped {
  fills: Fill[];                // bottom-to-top
  strokes: Stroke[];
  cornerRadius: number | [number, number, number, number]; // tl tr br bl
  cornerSmoothing?: number;     // 0..1 (iOS-style squircle)
}

interface RectNode extends BaseNode, Shaped { type: "rect"; }
interface EllipseNode extends BaseNode, Shaped { type: "ellipse"; arc?: { start: number; end: number; inner: number }; } // degrees, inner ratio 0..1
interface PolygonNode extends BaseNode, Shaped { type: "polygon"; sides: number; }
interface StarNode extends BaseNode, Shaped { type: "star"; points: number; innerRatio: number; }
interface LineNode extends BaseNode { type: "line"; strokes: Stroke[]; startCap: Cap; endCap: Cap; } // drawn along +x of box, height 0
type Cap = "none" | "arrow" | "triangle" | "circle" | "square" | "diamond" | "bar";

interface PathNode extends BaseNode, Shaped {
  type: "path";
  paths: { d: string; fillRule: "nonzero" | "evenodd" }[];   // SVG path data in the node's local box coordinates (0..width, 0..height)
}

interface TextNode extends BaseNode {
  type: "text";
  runs: TextRun[];              // concatenated text; "\n" starts a new paragraph
  style: TextStyle;             // default style for all runs
  paragraph: ParagraphStyle;
  autoResize: "none" | "height" | "width"; // "height": width fixed, height grows; "width": single line grows both
  maxLines?: number;            // with ellipsis truncation
  curve?: number;               // text-on-arc, degrees of sweep (0 = straight)
  verticalAlign: "top" | "middle" | "bottom";
  strokes?: Stroke[];           // outline text
  styleRef?: Id;                // DesignStyles.text id this node follows
}
interface TextRun { text: string; style?: Partial<TextStyle>; }
interface TextStyle {
  fontFamily: string; fontWeight: number; fontStyle: "normal" | "italic"; fontSize: number;
  fills: Fill[]; letterSpacing: number /* em */; textCase: "none" | "upper" | "lower" | "title";
  decoration: "none" | "underline" | "strikethrough"; link?: string;
  highlight?: Color; features?: string[] /* OpenType e.g. "liga","ss01" */; variations?: Record<string, number>;
}
interface ParagraphStyle {
  align: "left" | "center" | "right" | "justify"; direction: "ltr" | "rtl" | "auto";
  lineHeight: { unit: "auto" | "px" | "percent"; value: number };
  spacing: number; indent: number; list: "none" | "bullet" | "number";
}

interface ImageNode extends BaseNode {
  type: "image";
  assetId: Id;
  fit: "fill" | "fit" | "crop" | "tile";
  crop?: { x: number; y: number; w: number; h: number; zoom?: number };   // normalized 0..1 of source, used when fit="crop"
  cornerRadius: number | [number, number, number, number];
  shape?: "rect" | "ellipse" | { path: string };                         // clipping shape; path is SVG d in 0..1 unit box
  adjust?: ImageAdjust;
  strokes: Stroke[];
  maskAssetId?: Id;             // optional alpha mask image (e.g. result of background removal as separate matte)
}
interface ImageAdjust {
  brightness: number; contrast: number; saturation: number; hue: number; temperature: number; tint: number; // each -1..1 (hue -180..180)
  exposure: number; vignette: number; blur: number /* px */; grayscale: number; sepia: number; sharpen: number; grain: number;
  duotone?: [Color, Color]; filter?: string /* named preset id */;
}

interface SvgNode extends BaseNode {
  type: "svg";
  assetId?: Id;                 // svg asset
  markup?: string;              // inline sanitized SVG (no script/foreignObject/external refs); one of assetId|markup is required
  recolor?: Record<Color, Color>; // map original -> replacement colors
  strokes?: Stroke[];
}
interface VideoNode extends BaseNode { type: "video"; assetId: Id; trimStartMs: number; trimEndMs?: number; muted: boolean; loop: boolean; volume: number; posterAssetId?: Id; fit: "fill" | "fit" | "crop"; cornerRadius: number; }
interface AudioNode extends BaseNode { type: "audio"; assetId: Id; startMs: number; trimStartMs: number; trimEndMs?: number; volume: number; fadeInMs?: number; fadeOutMs?: number; }

interface ChartNode extends BaseNode {
  type: "chart";
  chart: "bar" | "column" | "line" | "area" | "pie" | "donut" | "scatter" | "radar" | "funnel" | "stacked-column" | "progress";
  data: { labels: string[]; series: { name: string; values: number[]; color?: Color }[] };
  options: { legend: boolean; grid: boolean; labels: boolean; palette: Color[]; fontFamily: string; fontSize: number; textColor: Color; min?: number; max?: number; unit?: string };
}
interface TableNode extends BaseNode {
  type: "table";
  rows: number; cols: number;
  colWidths: number[]; rowHeights: number[];
  cells: { r: number; c: number; text: string; style?: Partial<TextStyle>; fill?: Fill; align?: "left" | "center" | "right"; colspan?: number; rowspan?: number }[];
  header: boolean; stripe: boolean; borderColor: Color; borderWidth: number; cellPadding: number; defaultStyle: TextStyle;
}
interface QrNode extends BaseNode { type: "qr"; data: string; fg: Color; bg: Color; errorCorrection: "L" | "M" | "Q" | "H"; rounded: boolean; }

type Fill =
  | { type: "solid"; color: Color | ColorRef; opacity?: number; visible?: boolean; blend?: BlendMode }
  | { type: "linear"; angle: number; stops: Stop[]; opacity?: number; visible?: boolean; blend?: BlendMode }
  | { type: "radial"; cx: number; cy: number; rx: number; ry: number; stops: Stop[]; opacity?: number; visible?: boolean; blend?: BlendMode }   // normalized 0..1 of the box
  | { type: "conic"; cx: number; cy: number; angle: number; stops: Stop[]; opacity?: number; visible?: boolean; blend?: BlendMode }
  | { type: "image"; assetId: Id; mode: "fill" | "fit" | "tile" | "stretch"; scale?: number; offsetX?: number; offsetY?: number; rotation?: number; opacity?: number; visible?: boolean; blend?: BlendMode; adjust?: Partial<ImageAdjust> };
interface Stop { pos: number /* 0..1 */; color: Color | ColorRef; }
type ColorRef = { $var: string } | { $style: Id };

interface Stroke { fills: Fill[]; width: number; align: "inside" | "center" | "outside"; dash?: number[]; cap: "butt" | "round" | "square"; join: "miter" | "round" | "bevel"; miterLimit?: number; visible?: boolean; }

type Effect =
  | { type: "dropShadow"; x: number; y: number; blur: number; spread: number; color: Color; visible?: boolean }
  | { type: "innerShadow"; x: number; y: number; blur: number; spread: number; color: Color; visible?: boolean }
  | { type: "layerBlur"; radius: number; visible?: boolean }
  | { type: "backgroundBlur"; radius: number; visible?: boolean }
  | { type: "noise"; amount: number; scale: number; mono: boolean; visible?: boolean }
  | { type: "glow"; radius: number; strength: number; color: Color; visible?: boolean };

interface Animation {
  id: Id; preset: "fade" | "rise" | "drop" | "slide-left" | "slide-right" | "zoom-in" | "zoom-out" | "pop" | "rotate" | "wipe"
    | "typewriter" | "pulse" | "float" | "shake" | "blur-in" | "none";
  phase: "in" | "out" | "loop"; startMs: number; durationMs: number; easing: "linear" | "ease" | "ease-in" | "ease-out" | "ease-in-out" | "spring";
}
```

### Role (semantic role)

Open string union; engines treat unknown roles as opaque. Known roles (AI prompts and `describe` rely on them):
`background`, `hero`, `headline`, `subhead`, `body`, `caption`, `eyebrow`, `cta`, `button`, `logo`, `brand-mark`, `photo`, `product`,
`product-card`, `card`, `badge`, `price`, `rating`, `icon`, `illustration`, `decoration`, `pattern`, `divider`, `quote`, `author`,
`stat`, `stat-label`, `list`, `list-item`, `nav`, `footer`, `header`, `section`, `chart`, `table`, `qr`, `contact`, `date`, `location`,
`url`, `watermark`, `placeholder`, `slide-title`, `slide-body`, `speaker`, `avatar`, `form-field`.

## 4. Invariants

1. `nodes["root"]` exists, `type: "root"`, `parent: null`; every other node has exactly one parent and appears exactly once
   in that parent's `children`. Pages are children of root only; pages cannot nest. Non-container nodes have no `children`.
2. No cycles. Ids unique. `children` ids all exist.
3. `opacity` in [0,1]; `width`,`height` >= 0; `rotation` finite; arrays never `null`.
4. Auto-layout parents own the position/size of children with `sizing` fill/hug; engines recompute `x`,`y`,`width`,`height` of
   affected nodes after any transaction (layout is part of `applyTransaction` in the Rust core and in the worker `/v1/layout`).
5. Text node `height` (autoResize "height" / "width") and group bounds are *derived*; clients persist the derived values they
   compute so servers and other clients without a text shaper see consistent boxes.

## 5. Operations

```ts
type Op =
  | { op: "create"; nodes: Node[]; parent: Id; index?: number }  // nodes[0] is the subtree root (its parent field is overwritten with `parent`); others in `nodes` are its descendants; all ids must be new
  | { op: "update"; id: Id; set?: Record<string, unknown>; unset?: string[] }  // shallow top-level property merge (nested values are replaced whole)
  | { op: "patch"; id: Id; path: (string | number)[]; value: unknown }          // deep set at a path (arrays by index; use for fine edits like layout.gap)
  | { op: "delete"; id: Id }                                                    // removes id and its subtree; no-op when missing
  | { op: "move"; id: Id; parent: Id; index?: number }                          // reparent / reorder; index omitted = top (end of children)
  | { op: "asset"; set?: Record<Id, AssetRef>; remove?: Id[] }
  | { op: "styles"; path: (string | number)[]; value: unknown }                 // deep set into Design.styles
  | { op: "doc"; set: { name?: string; kind?: DesignKind; brandKitId?: string; meta?: Record<string, unknown> }; unset?: "brandKitId"[] };

interface Transaction {
  id: Id;                       // client-generated, idempotency key
  label: string;                // human label for history ("Move headline", "AI: make it more premium")
  ops: Op[];
  source: "user" | "ai" | "workflow" | "import" | "template" | "system";
  actor?: { userId?: string; runId?: string; agent?: string };
  ts: number;                   // ms epoch (informational)
}
```

Semantics (identical in Rust and TS, verified by fixtures):

* `applyTransaction(design, tx) -> { design, inverse: Transaction, applied: Op[], dropped: { index: number; reason: string }[] }`.
  Ops are applied in order. An op that references a missing node/parent, would create a cycle, or violates an invariant is
  **dropped** (reported in `dropped`), never throws. `applied` is the exact (possibly rewritten) op list that took effect.
* `inverse` replays to the previous state exactly (undo). Undo groups map 1:1 to transactions.
* `create` with `index` out of range clamps. `move` into own descendant is dropped. `update` cannot change `id`, `type`, `parent`,
  `children` (use create/delete/move). Unknown keys are preserved (forward compatibility).
* Layout/derived-geometry normalization runs after the op list (Rust core + worker). TS appliers used by Convex do not run layout;
  they apply ops verbatim and trust the derived values the client included in the same transaction.
* Canonical JSON: keys sorted lexicographically, no insignificant whitespace, numbers normalized (no `-0`, max 6 decimals),
  used for hashing, fixtures and golden comparison.
* The exact rules (drop-reason vocabulary and check order, `move` index semantics, `applied` normal forms, inverse ops, path
  resolution, canonical number algorithm) are specified in `spec/fixtures/README.md`.

## 6. Sync protocol (Convex)

* Authority: Convex. Each design has a monotonically increasing `seq`. `designOps` table holds accepted transactions by `seq`.
  Materialized state lives in node documents; periodic snapshots (every 200 tx or 5 min of activity) are stored as compressed JSON
  in S3 (`snapshots/<designId>/<seq>.json.zst`) and referenced from `designs.snapshot`.
* Client commit: `designs.commit({ designId, baseSeq, tx })` -> `{ seq, applied, dropped }`. Server applies ops to the current
  state (not to `baseSeq`) with last-writer-wins per property; structural conflicts resolved by server order; invalid ops are
  dropped and reported. Idempotent on `tx.id`.
* Client model: `confirmed` (design at last server seq) + `pending` (own uncommitted transactions). Render = confirmed + pending.
  On remote tx: apply to `confirmed`, then re-apply `pending` over it (dropping what no longer applies). On own ack: move the tx
  from pending into confirmed (using the server's `applied`).
* Load: `designs.load` (paginated one-shot queries, nodes in chunks of 500) returns `{ design, seq }`; then subscribe to
  `designOps.since({ designId, seq })` (reactive) for live transactions. If the gap is large the client reloads a snapshot.
* Ephemeral state (cursors, selections, live drag previews, "AI is editing X" markers) uses `presence` (Convex table with
  `expiresAt`, heartbeat every 5 s, auto-cleanup cron) and never enters history.
* Dragging/typing never commits per frame. Clients commit one transaction per gesture (pointer-up / debounced text edit 400 ms).
* AI/workflow transactions use the same `commit` with `source: "ai" | "workflow"`; the client groups consecutive transactions
  with the same `actor.runId` into one undo step.

## 7. Semantic description for AI (`describe`)

Produced by the Rust core (`desyn_core::describe`), exposed by wasm and the worker `POST /v1/describe`. Input: design,
optional `pageId`, `selection: Id[]`, `maxDepth`, `includeStyles`. Output:

```ts
interface Description {
  design: { id: Id; name: string; kind: DesignKind; pageCount: number; locale?: string };
  page: { id: Id; index: number; width: number; height: number; unit: Unit; background: string /* css-ish summary */ };
  selection: Id[];
  tree: DNode[];                // top-level children of the page, front-to-back reading order is NOT applied; z-order preserved back-to-front
  palette: { color: Color; share: number }[];           // dominant colors by area
  fonts: { family: string; weights: number[]; usedBy: number }[];
  typography: { scale: number[]; headlineSize?: number; bodySize?: number; ratio?: number };
  grid: { margins: { t: number; r: number; b: number; l: number }; alignments: { axis: "x" | "y"; pos: number; ids: Id[] }[]; spacingRhythm?: number };
  hierarchy: { id: Id; rank: number; reason: string }[]; // visual weight ranking (size, contrast, position)
  issues: Issue[];              // lint results
}
interface DNode {
  id: Id; type: string; name: string; role?: string; box: { x: number; y: number; w: number; h: number; rotation: number }; // page coordinates
  z: number; visible: boolean; locked: boolean; opacity: number;
  text?: string; font?: { family: string; size: number; weight: number; color: Color; align: string; lines?: number };
  fill?: string; image?: { assetId: Id; alt?: string; kind?: "photo" | "illustration" | "logo" | "icon" | "unknown" };
  semantic?: string;            // inferred group meaning, e.g. "product card: image + title + price + button"
  children?: DNode[]; flags?: string[]; // "overflows-page","overlaps:<id>","low-contrast","tiny-text","off-center", ...
}
interface Issue { severity: "info" | "warn" | "error"; code: IssueCode; ids: Id[]; message: string; fix?: Op[] }
type IssueCode = "low-contrast" | "tiny-text" | "text-overflow" | "off-page" | "overlap" | "misaligned" | "uneven-spacing" | "orphan-line"
  | "too-many-fonts" | "too-many-colors" | "weak-hierarchy" | "image-low-res" | "unsafe-margin" | "missing-alt" | "unlabeled-group";
```

Grouping inference (`semantic`) is heuristic and deterministic (no model call): clusters of nodes with shared container,
proximity and role patterns (image + text + price + button => product card, list of equal siblings => list, etc.). The AI may
also set `role` / `name` explicitly; explicit values win over inference.

## 8. Worker HTTP API (crates/desyn-worker, internal; shared secret in `x-desyn-secret`)

All bodies JSON unless noted. `design` is a full `Design`; large designs may be sent gzip-compressed.

* `POST /v1/render` `{ design, pageId?, region?:{x,y,w,h}, scale?: number, format: "png"|"jpeg"|"webp"|"svg"|"pdf"|"pptx"|"gif"|"mp4", quality?, background?: Color|"transparent", pdf?: {bleed:boolean, cropMarks:boolean, cmyk:boolean}, assetUrls?: Record<Id,string> }` -> bytes (`content-type` per format). `pageId: "all"` for multi-page pdf/pptx.
* `POST /v1/describe` `{ design, pageId?, selection?, maxDepth? }` -> `Description`.
* `POST /v1/layout` `{ design }` -> `{ design }` with derived geometry recomputed (text boxes, auto-layout, groups).
* `POST /v1/measure` `{ items: { text: TextRun[]; style: TextStyle; paragraph: ParagraphStyle; width?: number }[] }` -> `{ sizes: {w,h,lines}[] }`.
* `POST /v1/apply` `{ design, tx }` -> `{ design, inverse, applied, dropped }` (full core semantics including layout).
* `POST /v1/imageops/remove-background|upscale|...` are NOT in the worker; those are AI provider calls made from Convex/AI package. The worker also exposes `POST /v1/thumbnail` `{ design, pageId, width }` -> webp bytes.
* `GET /healthz`.
Fonts: worker loads fonts from `FONTS_DIR` (bundled OFL set) and from `assetUrls` for design assets and custom fonts.

## Change log

* v1 initial freeze (2026-10-20).
* 2026-10-20 (schema agent, additive): `doc` op gains optional `unset?: "brandKitId"[]` so the inverse of attaching a brand kit can
  remove it again (`brandKitId` is the only optional design field). Precise op semantics live in `spec/fixtures/README.md`:
  dropped reasons are the fixed vocabulary `invalid-op | missing-node | missing-parent | not-container | cycle | duplicate-id |
  immutable-field | invalid-node | root-protected | page-nesting | invalid-path | invalid-value`; `move.index` is the final index
  (counted after removing the node from its old position); `delete` of a missing node is reported as dropped (`missing-node`);
  `styles` with an empty path replaces `Design.styles`; inverse transaction id = first 12 hex chars of sha256("inverse:" + tx.id).
* 2026-10-20 (schema review, additive precision in `spec/fixtures/README.md`): ops fixtures now pin the exact `inverse`
  transaction; arrays in inverse ops that come from object keys (`update` inverse `unset`, `asset` inverse `remove`) are
  sorted by Unicode code point because JSON object key order carries no meaning; `doc.unset` may be empty and repeated
  entries collapse. Client sync: `seq` is contiguous per design, and an ack for anything but `seq + 1` waits for the
  `designOps.since` echo.
* 2026-10-20 (designs agent, additive, §6 Convex wire format): Convex values reject object keys that start with `$`
  (ColorRef) or contain non-ASCII characters, so design content crosses the Convex boundary as JSON strings:
  `designs.commit({ designId, baseSeq?, tx })` takes `tx` as a JSON string (a plain object is accepted only when it has
  no such keys) and returns `{ seq, applied: <JSON of Op[]>, dropped, duplicate }`; `designs.load` pages carry node JSON
  strings and the first page's header carries `assets` / `styles` / `meta` as JSON; `designOps.since` entries carry
  `tx` as JSON whose `ops` are the server-applied ops. Every accepted transaction gets the next seq, even when all of
  its ops were dropped (the echo has `ops: []`), so `seq` stays contiguous and every commit has an echo. Every
  design's log starts from an empty base (root only), so any seq can be rebuilt from the newest snapshot at or before
  it plus the log. Snapshot keys: `snapshots/<designId>/<seq>.json.zst` (`.json.gz` when the Node runtime lacks
  zstd). Client helpers: `convex/lib/designs_wire.ts` (`encodeTx`, `decodeTx`, `decodeOps`, `assembleDesign`).
* 2026-10-20 (text agent, additive, optional keys only; no schema change): `crates/desyn-text` reads these optional
  keys from the forward-compatible `extra` maps when present (other implementations preserve them untouched):
  `TextStyle.baselineShift` (px, positive raises; superscript / subscript), `TextStyle.wordSpacing` (em added to
  word separators), `TextStyle.fontStretch` (percent 50-200; `wdth` axis + CSS stretch matching), `TextStyle.lang`
  (BCP 47; shaping, hyphenation, Han fallback), `ParagraphStyle.spaceBefore` (px before every paragraph but the
  first; `spacing` stays the space after), `ParagraphStyle.listStart` (first number of numbered lists). List nesting
  is expressed in the text itself: leading tab characters of a paragraph in a list node set its level (one level
  per tab; the tabs are not drawn). Full rules: `crates/desyn-text/API.md`.
* 2026-10-20 (describe agent, additive, section 7; no field removed or renamed): `describe` is implemented by
  `crates/desyn-describe` (`desyn_describe::describe`), not inside `desyn-core`. Request options gain optional
  `includeHidden`, `detail: "summary" | "full"`, `maxNodes`, `lint`, `brand` (brand kit) and the aliases `page` /
  `depth`. Output gains optional keys the loose schemas already preserve: `Description.readingOrder: Id[]`,
  `Description.groups` (inferred semantic groups `{ id, kind, label, node?, ids, parts?, box, source }`),
  `Description.direction: "ltr" | "rtl"`, `Description.tokens` (design tokens), `Description.omitted`,
  `DNode.weight` (visual weight 0..1), `Issue.rule` (precise lint rule, always present) and `Issue.hint`.
  `IssueCode` is unchanged: finer rules report under the closest code (empty layers and unnamed key elements under
  `unlabeled-group`, off-brand colors under `too-many-colors`, off-brand fonts and too many sizes under
  `too-many-fonts`, print bleed under `unsafe-margin`, busy photo backgrounds and QR contrast under
  `low-contrast`, clipped / truncated text under `text-overflow`, widows under `orphan-line`, covered text under
  `overlap`). Rule table: `crates/desyn-describe/API.md`.
* 2026-10-20 (raster agent, additive, optional keys only; no schema change): `crates/desyn-raster` reads these
  optional keys from the forward-compatible `extra` maps when present (other implementations preserve them
  untouched): node `maskType` (`"alpha"` default | `"luminance"`) on mask nodes; `Stroke.sides`
  (`[top, right, bottom, left]` widths, rect-like nodes: per-side borders); `ImageAdjust.highlights` /
  `ImageAdjust.shadows` (-1..1, also in image-fill `adjust`). `ImageAdjust.filter` preset ids the renderer
  knows: `vivid`, `warm`, `cool`, `mono`, `noir`, `vintage`, `fade`, `dramatic`, `film`, `sunset`, `matte`,
  `chrome`, `lush`, `dusk` (values add to the explicit adjustments; unknown ids are ignored). Image-fill
  `offsetX` / `offsetY` are fractions of the box. Full rules: `crates/desyn-raster/API.md`.
* 2026-10-20 (worker agent, additive, section 8; nothing removed or renamed): `crates/desyn-worker` implements the
  worker API. Additive: `format: "webm"` (VP9 + Opus, alpha with `background: "transparent"`) next to `mp4`;
  `pageId: "all"` also for `gif` (pages in order with their `durationMs` / `transition`) and video; optional request
  keys `timeMs`, `fps`, `durationMs`, `svgText`, `strictAssets`, `audio`, `pdf.flatten`, `pdf.dpi` (render),
  `format` / `quality` / `background` / `assetUrls` (thumbnail), `sampleImages` / `assetUrls` plus the
  `DescribeOptions` of section 7 (describe), `normalize` (apply), `maxLines` per item and font `assets` (measure);
  `/v1/layout` answers `{ design, changed }` and `/v1/measure` sizes carry `baseline`. Assets resolve from
  `assetUrls[id]`, else `AssetRef.url`. `GET /readyz` (unauthenticated) and `GET /metrics` (secret) exist next to
  `/healthz`. Errors are `{ error: { code, message, details? } }`; 401 without the secret, 403 with a wrong one.
  Full reference: `crates/desyn-worker/README.md`.
