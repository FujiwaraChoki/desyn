# Desyn conformance fixtures

These files are the arbiter between the TypeScript reference implementation (`packages/doc-ops`, `packages/schema`)
and the Rust core (`crates/desyn-core`). Both must pass every fixture. If an implementation disagrees with a fixture,
the implementation is wrong — or the fixture is, in which case fix the case in
`packages/doc-ops/scripts/fixture-cases.ts`, regenerate, and explain why in the commit message.

```
spec/fixtures/
  ops/*.json         applyTransaction cases (227)
  nodes/*.json       one valid example per node type / fill / effect / other shape, plus rejected examples
  canonical/*.json   canonical JSON input/output pairs
```

Regenerate (never edit the JSON by hand):

```sh
pnpm --filter @desyn/doc-ops gen:fixtures
```

The generator does not trust the implementation: every case carries a hand-written expectation (`after` mutation,
`applied`, `dropped`) and the generator refuses to write anything unless the TS applier matches all of them, the
inverse restores `before`, replaying `applied` reproduces `after`, and both designs pass `validateDesign`.

All comparisons are done on **canonical JSON** (see below), so key order and number formatting in the files do not
matter.

## ops fixture format

```jsonc
{
  "name": "move-forward-index-after-removal",   // = file name
  "description": "…",
  "layoutSensitive": false,                      // always false: no auto-layout, no text autoResize changes, no group bound changes
  "before": Design,
  "tx": Transaction,                             // tx.id "tx0000000NNN", source "user", ts 1760000000000
  "after": Design,                               // expected design
  "applied": Op[],                               // expected `applied` (normalized forms, see below)
  "dropped": [{ "index": 2, "reason": "cycle" }],// expected `dropped`, index into tx.ops, ascending
  "inverse": Transaction                         // expected inverse transaction (exact ops, id, metadata)
}
```

A conforming implementation runs `applyTransaction(before, tx)` **without layout / derived-geometry normalization**
(the Rust core exposes an apply entry point with layout disabled for this) and checks:

1. `canonical(result.design) == canonical(after)`
2. `canonical(result.applied) == canonical(applied)`
3. `canonical(result.dropped) == canonical(dropped)`
4. `applyTransaction(result.design, result.inverse)` drops nothing and yields `before` (canonically).
5. Applying `applied` (as a transaction) to `before` drops nothing and yields `after`.
6. `canonical(result.inverse) == canonical(inverse)` — the exact inverse transaction (see "Inverse transaction").

`before` is never mutated (TS: structural sharing; the input object graph is untouched).

## Drop reasons (fixed vocabulary)

| reason            | meaning                                                                                              |
| ----------------- | ---------------------------------------------------------------------------------------------------- |
| `invalid-op`      | The op is malformed: not an object, unknown `op`, missing / ill-typed fields (non-integer `index`, `path` not an array of strings and integers, `set` not an object, `unset` not an array of strings, missing `value`), `update` key in both `set` and `unset`, `asset` key ≠ record id or id in both `set` and `remove`, `doc.set` with a key other than `name` / `kind` / `brandKitId` / `meta`, `doc.unset` not an array or with an entry other than `"brandKitId"`, `brandKitId` both set and unset. |
| `missing-node`    | The target node (`update`, `patch`, `delete`, `move`) does not exist.                              |
| `missing-parent`  | The `create` / `move` parent does not exist.                                                         |
| `not-container`   | The `create` / `move` parent is not a container (`root`, `page`, `frame`, `group`, `boolean`).       |
| `cycle`           | `move` into the node itself or one of its descendants.                                               |
| `duplicate-id`    | A `create` node id already exists in the design, repeats within the op, or is `"root"`.             |
| `immutable-field` | `update` sets / unsets, or `patch` path starts with, `id`, `type`, `parent` or `children`.          |
| `invalid-node`    | A node produced by `create` / `update` / `patch` fails node validation (below), or a `create` subtree is structurally inconsistent. |
| `root-protected`  | `delete` / `move` of the root, or `create` of a node with `type: "root"`.                            |
| `page-nesting`    | A page whose parent is not the root, or a non-page whose parent is the root (`create`, `move`).      |
| `invalid-path`    | `patch` / `styles` path does not resolve (rules below); `patch` with an empty path.                 |
| `invalid-value`   | `asset` record fails `AssetRef`; `styles` result fails `DesignStyles`; `doc` value of the wrong type / unknown kind. |

### Check order per op

The first failing check decides the reason.

- **create**: `invalid-op` (`nodes` non-empty array, `parent` string, `index` absent or integer) → `missing-parent` →
  `not-container` → `invalid-node` (every entry an object with a string `id`) → `duplicate-id` → `root-protected`
  (any entry with `type: "root"`) → `page-nesting` (`nodes[0]` is a page iff parent is the root; no page among
  `nodes[1..]`) → `invalid-node` (structure, then node validation).
- **update**: `invalid-op` → `missing-node` → `immutable-field` → `invalid-node`.
- **patch**: `invalid-op` → `missing-node` → `invalid-path` (empty path) → `immutable-field` (first segment) →
  `invalid-path` (resolution) → `invalid-node`.
- **delete**: `invalid-op` → `root-protected` → `missing-node`.
- **move**: `invalid-op` → `missing-node` → `root-protected` → `missing-parent` → `not-container` → `cycle` →
  `page-nesting`.
- **asset**: `invalid-op` → `invalid-value`.
- **styles**: `invalid-op` → `invalid-path` → `invalid-value`.
- **doc**: `invalid-op` → `invalid-value`.

A dropped op changes nothing; later ops still run against the state left by the ops before it.

## Op semantics

### create `{ op, nodes, parent, index? }`

- `nodes[0]` is the subtree root; its `parent` field is overwritten with `parent`. `nodes[1..]` are its descendants
  in any order.
- Structure rules (else `invalid-node`): only container types may carry `children`; every `children` entry is the id
  of another node in the op and not `nodes[0]`; each id is listed at most once; each descendant's `parent` is a string
  equal to the node that lists it; every node is reachable from `nodes[0]` through `children`.
- `index` is the position in the parent's `children` (0 = bottom-most). Omitted = `children.length` (top).
  Out of range clamps to `[0, children.length]`.
- Inserted nodes are deep copies of the op's nodes (unknown keys preserved).
- **applied**: `{ op: "create", nodes (with nodes[0].parent = parent), parent, index: <actual insertion index> }`.
- **inverse**: `{ op: "delete", id: nodes[0].id }`.

### update `{ op, id, set?, unset? }`

- Shallow merge: each `set` key replaces the top-level value whole; each `unset` key is removed (absent keys are a
  no-op). Duplicate `unset` entries are ignored.
- **applied**: `{ op, id, set? , unset? }` with `set` omitted when empty and `unset` de-duplicated and omitted when
  empty.
- **inverse**: an `update` that sets every touched key that existed before to its old value and unsets every `set`
  key that did not exist. The inverse `unset` is sorted by Unicode code point (JSON object key order carries no
  meaning, so no array may depend on it); `set` / `unset` omitted when empty.

### patch `{ op, id, path, value }`

- Deep set at `path` inside the node (see **Paths**). `value` may be any JSON value including `null` (but must be
  present).
- **applied**: the op as given.
- **inverse**: if the final key / index existed: `patch` with the old value. Otherwise (new object key or array
  append): for a one-segment path `update { unset: [key] }`, else `patch` of the parent path with the parent's old
  value.

### delete `{ op, id }`

- Removes the node and its whole subtree and the id from the parent's `children`. Missing node → `missing-node`.
- **applied**: the op. **inverse**: `create` with the subtree in pre-order (back-to-front within each container),
  `parent` = old parent, `index` = old index.

### move `{ op, id, parent, index? }`

- **Index semantics:** the node is first removed from its current parent; `index` is then the position in the
  target's `children` **after that removal** (i.e. the node's final index). Omitted = end (top). Clamped to
  `[0, len]` where `len` is the length after removal. Example: children `[a,b,c,d]`, `move a index 2` → `[b,c,a,d]`;
  `move d index 1` → `[a,d,b,c]`. Moving to the current position is applied and changes nothing.
- The node's `parent` field is updated; x / y are **not** adjusted (builders do that).
- **applied**: `{ op, id, parent, index: <final index> }`. **inverse**: `move` back to the old parent and old index.

### asset `{ op, set?, remove? }`

- `set` adds or replaces whole records (key must equal `record.id`); `remove` deletes records. Ids in `remove` that
  do not exist are ignored; `remove` is de-duplicated. Referenced assets may be removed (nodes keep dangling ids).
- **applied**: `{ op: "asset", set? , remove? }` — `set` omitted when empty, `remove` filtered to ids that existed and
  omitted when empty. An asset op with nothing to do applies as `{ "op": "asset" }`.
- **inverse**: `set` with the previous records of every replaced or removed id, `remove` of every newly added id
  (sorted by Unicode code point).

### styles `{ op, path, value }`

- Deep set into `Design.styles` with the **Paths** rules; the empty path replaces `Design.styles` entirely (the
  only way to remove a top-level key; to remove an entry, set its map). The result must validate as `DesignStyles`
  (style map keys are Ids, colors are lowercase hex, …) else `invalid-value`.
- **applied**: the op. **inverse**: like `patch` but always a `styles` op: old value at the same path if it existed,
  otherwise the parent path with the parent's old value (the empty path when the path had one segment).

### doc `{ op, set, unset? }`

- `set` may hold `name` (string), `kind` (a DesignKind), `brandKitId` (string), `meta` (object, replaced whole).
  `unset: ["brandKitId"]` removes `brandKitId` (additive change, DOCUMENT_MODEL change log 2026-10-20); removing an
  absent `brandKitId` is a no-op. `unset` may be empty (nothing is removed) and repeated entries collapse.
- **applied**: `{ op: "doc", set: <given keys>, unset?: ["brandKitId"] }` (`unset` present exactly when the input
  `unset` was non-empty). **inverse**: `doc` restoring old values,
  with `unset: ["brandKitId"]` when it was absent before and set now.

### Inverse transaction

`{ id: first 12 hex chars of sha256("inverse:" + tx.id), label: tx.label, ops: <inverse ops of applied ops in
reverse order>, source: tx.source, actor: tx.actor (when present), ts: tx.ts }`.

## Paths

Used by `patch` (inside one node) and `styles` (inside `Design.styles`):

- Segments are strings or integers. Arrays are indexed by integers only, plain objects by strings only.
- Every segment but the last must resolve to an existing value: an own key of an object, or an index
  `0 <= i < length` of an array. Nothing is created on the way (`["layout","gap"]` on a node without `layout` is
  `invalid-path`). Descending into a string / number / boolean / null is `invalid-path`.
- The last segment on an object may name an existing or a new key. On an array it must be an integer
  `0 <= i <= length`; `i == length` appends.

## Node validation

A node is valid when it matches its type's schema — the zod schemas in `packages/schema/src/zod.ts`, published as
JSON Schema in `packages/schema/json-schema/` (`Node.json` and one file per node type) — and a non-container node
has no `children` key. Highlights of the schema:

- ids: `^[a-z0-9]{12}$` (the root's id is `"root"`); colors: `^#([0-9a-f]{6}|[0-9a-f]{8})$` (lowercase).
- `opacity` (node and fill), stop `pos`, `cornerSmoothing`, `innerRatio`, `arc.inner`: within [0, 1].
  `width`, `height`, stroke `width`, blur radii, font size, durations: >= 0.
- integers: polygon `sides` (>= 3), star `points` (>= 3), table `rows` / `cols` / cell `r` / `c`, `colspan` /
  `rowspan` (>= 1), `maxLines` (>= 1), grid `columns` (>= 1).
- All numbers are finite. Optional keys must hold a value of their type when present (`null` is not a value of any
  typed key; use `unset`). Unknown keys are allowed anywhere and preserved.
- `svg` needs `assetId` or `markup`. A page's `parent` is `"root"`; the root's is `null`.
- Discriminants (`type` of nodes, fills and effects) and string enums must be strings; an integer is never read
  as a variant index.
- `"__proto__"` is an ordinary JSON key: as an unknown key it is preserved like any other, and as an entry of a
  typed map (style maps, `variables`, `variations`, `recolor`, …) it is validated like any other entry.

## nodes fixture format

```jsonc
{ "name": "node-rect", "schema": "RectNode", "valid": true, "description": "…", "value": { … } }
```

`schema` names an exported zod schema (`<schema>Schema` in `@desyn/schema`) and a JSON Schema file
(`packages/schema/json-schema/<schema>.json`). Implementations must accept every `valid: true` value, reject every
`valid: false` one, and round-trip each value through their own model unchanged (canonically).

## Canonical JSON

```jsonc
{ "name": "…", "description": "…", "input": <the same JSON value>, "inputText": "<raw JSON text>", "canonical": "<expected output>" }
```

`inputText` is the authoritative raw text (so `-0`, exponents and spacing survive as written); `input` embeds the same
value as plain JSON for convenience (the file is formatted, so its number spelling may differ, its values do not).
Parse either as JSON (numbers as IEEE-754 doubles), then
write canonical JSON:

1. **Objects**: keys sorted by Unicode code point (equivalently, by their UTF-8 bytes — *not* UTF-16 code units),
   written as `{"k":v,…}`. Members whose value is `undefined` (JS only) are omitted.
2. **Arrays**: order preserved, `[a,b]`.
3. **No whitespace** outside strings.
4. **Strings**: JSON with minimal escaping — `\"`, `\\`, `\b`, `\f`, `\n`, `\r`, `\t`, other code points below
   U+0020 as `\u00xx` (lowercase hex); everything else (including `/`, U+007F, U+2028, non-ASCII) raw UTF-8.
   (This is what `JSON.stringify` and `serde_json` produce.)
5. **Numbers**: non-finite values are an error. Integers (as doubles) are written as is. Otherwise
   `r = sign(x) * round_half_away_from_zero(|x| * 1e6) / 1e6`, computed in IEEE-754 double arithmetic exactly in
   that order. A result of `-0` is written `0`. The value is written as the shortest decimal string that round-trips
   to the same double, **never in exponent notation** (e.g. `1e21` → `1000000000000000000000`, `1e-6` → `0.000001`),
   without trailing zeros or a trailing decimal point.
6. `hashCanonical(v)` = lowercase hex sha256 of the UTF-8 bytes of the canonical text.

## Index of ops fixtures

Cases are grouped by name prefix: `create-*` (index clamping, subtrees, every node type, every structural rejection),
`update-*`, `patch-*` (arrays, append, invalid paths, unknown keys), `delete-*`, `move-*` (index-after-removal
semantics, reparenting, cycles, pages), `asset-*`, `styles-*`, `doc-*`, mixed cases (`mixed-with-drops`,
`order-dependence`, `unknown-design-keys-preserved`, `unicode-text-and-keys`, `ai-restyle-batch`, …) and edge cases
added in review (`*-proto-*`, `*-not-string`, `doc-unset-*`, `*-unsorted`, `create-many-decimals`, …). All start from
the base design in `packages/doc-ops/scripts/fixture-base.ts` (two pages; page 1 holds a background rect, a frame with
two children, an ellipse, a headline, an image and a two-child group) unless the case provides its own `before`.
