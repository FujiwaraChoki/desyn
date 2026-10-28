# @desyn/schema

TypeScript types, zod schemas, JSON Schema, factories, ids, canonical JSON, validation, plans, page presets, color
math, font catalog, roles and design kinds — everything that describes a Desyn design (`docs/DOCUMENT_MODEL.md`).

Internal package: `exports` point at TypeScript source; consumers transpile it (Next `transpilePackages`, Convex
esbuild, Vite). Runtime dependencies: `zod`, `@noble/hashes`.

```ts
import { createDesign, createRect, validateDesign, canonicalize, hashCanonical, newId, can, PAGE_PRESETS } from "@desyn/schema";
```

Subpath entry points avoid pulling zod where it is not needed: `@desyn/schema/types`, `/ids`, `/canonical`, `/plans`,
`/presets`, `/color`, `/fonts`, `/roles`, `/kinds`, `/links`, `/defaults`, `/validate`, `/zod`, `/json-schema` and the generated
files `@desyn/schema/json-schema/<Name>.json`.

## Modules

| module            | contents |
| ----------------- | -------- |
| `types.ts`        | Every contract type with exact names: `Design`, `Node` and the 19 node interfaces, `Fill`, `Stroke`, `Effect`, `Animation`, `TextStyle`, `ParagraphStyle`, `AssetRef`, `DesignStyles`, `Op` (+ `CreateOp` …), `Transaction`, `Description`, `DNode`, `Issue`, `IssueCode`, `Role`, `DropReason`, `ApplyResult`. |
| `constants.ts`    | `ROOT_ID`, `NODE_TYPES`, `CONTAINER_TYPES`, `SHAPED_TYPES`, `FILL_TYPES`, `EFFECT_TYPES`, `DESIGN_KINDS`, `BLEND_MODES`, `OP_KINDS`, `DROP_REASONS`, `IMMUTABLE_NODE_KEYS`, `ID_PATTERN`, `COLOR_PATTERN`, `isContainerType()` … |
| `zod.ts`          | `<Type>Schema` for every type (`DesignSchema`, `RectNodeSchema`, `NodeSchema`, `FillSchema`, `OpSchema`, `TransactionSchema`, `DescriptionSchema`, …), `NODE_SCHEMAS`, `nodeSchemaFor(type)`. Objects are loose: unknown keys are accepted and preserved. Records also validate an own `"__proto__"` entry (plain `z.record` skips that key). |
| `json-schema.ts`  | `jsonSchemaDocuments()` → the documents written to `json-schema/*.json` (draft 2020-12, shared `$defs`; the svg "assetId or markup" rule is added as `anyOf`). Regenerate with `pnpm gen:json-schema`; a test fails when the committed files are stale, and an ajv test checks that the files accept / reject exactly the spec/fixtures node samples, every ops-fixture design and every factory design. |
| `defaults.ts`     | `createRoot`, `createPage`, `createFrame`, `createGroup`, `createBoolean`, `createRect`, `createEllipse`, `createPolygon`, `createStar`, `createLine`, `createPath`, `createText`, `createImage`, `createSvg`, `createVideo`, `createAudio`, `createChart`, `createTable`, `createQr`; `defaultTextStyle`, `defaultParagraph`, `defaultStroke`, `defaultImageAdjust`, `solid`, `emptyStyles`, `pageFromPreset`, `createDesign(kind, preset?, options?)`. |
| `ids.ts`          | `newId()` (12 chars `[a-z0-9]`, Web Crypto, unbiased), `isId()`, `isNodeId()`. |
| `canonical.ts`    | `canonicalize(value)`, `hashCanonical(value)` (sync sha256 hex), `canonicalEqual`, `sha256Hex`, `canonicalNumber`, `compareCodePoints`. Algorithm: `spec/fixtures/README.md`. |
| `validate.ts`     | `validateDesign(design) -> { ok, errors, warnings }` (zod shape + every §4 invariant; dangling asset / style / variable refs are warnings), `validateNode(node)`, `isValidNode`, `assertValidDesign`. |
| `plans.ts`        | Typed `config/plans.json`: `PLANS`, `PlanId`, `FeatureKey` / `LimitKey` / `CreditAction` (unions derived from the JSON), `can(plan, feature)`, `limit(plan, key)` (`null` = unlimited), `withinLimit`, `creditCost(action)`, `planForEdition(edition, subscription, now?)`, `parseEdition(DESYN_EDITION)`. `"ALL_TRUE"` is expanded. |
| `presets.ts`      | `PAGE_PRESETS` (134 presets: social, video, ads/IAB, presentation, web, print with mm/in metadata, bleed and safe areas), `getPreset`, `presetsForKind`, `presetsForPlatform`, `findPresetsBySize`, `toPx` / `fromPx`. Sizes are design px (96/in). |
| `color.ts`        | hex parse/format, HSL/HSV/OKLab/OKLCH conversions with gamut mapping, `relativeLuminance`, `contrastRatio`, `wcagLevel`, `ensureContrast`, `readableTextColor`, `mix` (OKLab/sRGB/linear), `lighten` / `darken` / `saturate` / `rotateHue` in OKLCH, `harmony`, `harmonies`, `generatePalette(seed, mode, count)`, `tonalScale`. |
| `fonts.ts`        | `FONT_CATALOG` (158 Google Fonts families: category, weights, italics, variable axes, pairings, tags), `FONT_PAIRINGS` (55 heading/body pairings with moods and suited kinds), lookups. Metadata only. |
| `links.ts`        | `parseLink(link)` / `isSafeLink` for `BaseNode.link` and `TextStyle.link`: `page:<id>` targets and normalized http(s) / mailto / tel URLs only (WHATWG URL parser; `javascript:`, `data:`, obfuscated schemes and relative URLs return null). Every client that makes a link clickable must use it. |
| `roles.ts`        | `KNOWN_ROLES`, `ROLE_DESCRIPTIONS`, `isKnownRole`. |
| `kinds.ts`        | `DESIGN_KIND_INFO` (label, Lucide icon, description, default preset, multi-page), `DESIGN_KIND_LIST`, `isDesignKind`. |

## Scripts

```sh
pnpm typecheck        # tsc --noEmit (includes compile-time zod <-> contract type checks)
pnpm test             # vitest (spec/fixtures/canonical + spec/fixtures/nodes runners included)
pnpm lint             # biome check .
pnpm gen:json-schema  # regenerate json-schema/*.json
```
