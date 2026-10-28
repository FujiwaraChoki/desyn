# Desyn — Master Specification

Desyn is a complete, AI-native design suite (a Canva alternative): web app, Rust desktop app (GPUI), native SwiftUI iOS app, a
Convex backend, a Rust render worker, a landing page and docs. The AI can create, understand and edit entire designs as real
layers. Source-available (custom non-commercial license, commercial rights reserved by the owner), hosted at **desyn.app**
($8/month Pro with fair use, very basic Free tier), self-hosters get every feature for non-commercial use.

Read in this order: this file, `docs/DOCUMENT_MODEL.md` (frozen contract), `docs/DESIGN_SYSTEM.md`, then your package's brief.
This repository is built by many agents in parallel. The rules in section 0 are mandatory.

## 0. Rules for every contributor (human or agent)

1. **Secrets.** NEVER read, print, cat, grep, copy or log `.env`, `.env.*` (except `.env.example`), key files or any value of
   `OPENROUTER_API_KEY`, `FAL_AI_API_KEY`, `AWS_*`, `STRIPE_*`, `BETTER_AUTH_SECRET`, `AXIOM_TOKEN`, `POSTHOG_*` keys. Use env var *names*
   only. Code reads secrets from `process.env` / environment at runtime. Tests must not need real secrets (use fakes/mocks at the
   edges: HTTP interceptors, local MinIO, in-memory providers). Never commit secrets. Never embed a key in docs, fixtures or logs.
2. **Ownership.** Edit only the paths your brief says you own. If you need a change elsewhere, make the smallest additive change
   and note it in your package README (what, why, files). Never reformat or rewrite files you do not own.
3. **Git.** Do not run `git commit`, `git push`, `git stash`, `git checkout` or `git reset`. Version control is handled by the orchestrator/user. Do not delete
   other packages' files.
4. **Installs.** Concurrent `pnpm add/install` corrupts the lockfile. Always wrap any pnpm command that changes dependencies as
   `flock /tmp/desyn-pnpm.lock pnpm ...`. Pin exact versions of new dependencies (`pnpm add --save-exact`). Check the current
   version with `npm view <pkg> version` and read the package's own docs in `node_modules` before using an API (AI SDK 7, Next 16,
   Convex, Better Auth, Tailwind 4 changed a lot — do not code from memory).
5. **Cargo.** Use your own target dir: `export CARGO_TARGET_DIR="$(git rev-parse --show-toplevel)/target/<your-package>"` and
   `CARGO_BUILD_JOBS=6`. Rust edition 2024, stable 1.98. `cargo fmt`, `cargo clippy -- -D warnings` and tests must pass for your crate.
   Add workspace members by creating the crate under `crates/` or `apps/` (root `Cargo.toml` uses globs); do not edit the root file.
6. **Quality bar.** No stubs, no `TODO`, no mock implementations on production paths, no `unimplemented!()`, no fake data in
   shipped UI. Implement the feature fully. If something truly cannot be done in this environment (e.g. compiling SwiftUI on Linux),
   write the complete code anyway, keep it compile-correct by careful review, and list it in your package README under "Unverified".
7. **Verification.** Every package ships tests that run offline and pass (`pnpm test`, `cargo test`). UI work is verified in a real
   browser (Chrome tools / Playwright) with screenshots reviewed. Report exact commands you ran and their results. Never claim
   something works that you did not run.
8. **Style.** Write code that reads like the surrounding code. TypeScript strict, no `any` without a comment, ESM, no default exports
   except where a framework requires. Small files, clear names. Comments explain *why*. No dead code. Accessible, responsive UI.
9. **License header.** No per-file headers. The repo license is in `LICENSE` (Desyn Non-Commercial Source License).
10. **Scope.** "Everything, not MVP." Prefer complete, polished, edge-case-handled implementations over breadth-without-depth.
    Do not cut features listed in your brief. Do not add large features outside your brief; list ideas in your package README.

## 1. Product requirements (summary)

* **Editor**: infinite canvas, frames/pages, text (rich, variable fonts, curved), shapes, vector pen, boolean ops, auto-layout, masks,
  gradients/effects/blend modes, image adjustments, charts, tables, QR, icons, stickers, stock photos, videos/animation, presenter mode,
  multi-page, rulers/guides/snapping, alignment/distribution, grid, comments, version history, real-time collaboration, shortcuts, cmd-K.
* **Design kinds**: social posts, stories, posters, flyers, thumbnails, banners, ads, presentations, infographics, business cards,
  resumes, invitations, menus, logos, newsletters, documents, whiteboards, one-page websites, videos, book covers, certificates.
* **Templates**: 300+ at launch across 20+ categories, all stored as real `Design` JSON with slots; premium vs basic flag; searchable by
  prompt; "remix with AI"; generated and curated via a pipeline in `templates/`.
* **Assets**: Google Fonts (self-hosted OFL set + on-demand), custom fonts, icons (Lucide/Phosphor/Tabler via Iconify data), stock photos
  (Unsplash/Pexels APIs, attribution), illustrations/stickers/shapes, mockup scenes, uploads (S3), brand logos.
* **AI-native**: (a) generate complete designs as editable layers, (b) edit conversationally preserving untouched elements, (c)
  understand the whole canvas (structure, typography, spacing, hierarchy, selection, semantic groups), (d) generate/modify assets
  (image gen, SVG gen, background removal, inpaint, outpaint, upscale, mockups, trace), multi-provider + BYOK + local, (e) brand
  consistency (brand kits, "make this match my brand"), (f) multi-step workflows (campaigns, variants, resize, localize, bulk, export).
* **Agent API**: public REST + MCP server so external agents can control projects with the same tools.
* **Tiers**: `config/plans.json` is the single source of truth for limits/features/credit costs (Free very basic, Pro $8, Self-hosted
  unlimited, no license keys in the code). All clients and the server read it through `packages/schema` (`plans`) and `crates/desyn-core::plans`.
* **Fair use**: monthly credit pool (Pro 600), soft throttle (never surprise overage), BYOK bypasses credits, per-minute/day AI request
  caps, concurrent run caps, abuse signals. Usage dashboard in settings.

## 2. Brand / UX

`docs/DESIGN_SYSTEM.md` (sun edition of "Atmospheric Minimalism"). Dark-first. Instrument Serif headings, Instrument Sans UI,
JetBrains Mono for code. Accent = sun (`#FFB02E` dark / `#D27400` light). Beauty is a hard requirement everywhere.

## 3. Repository layout and ownership

```
apps/
  web/        Next.js 16 app (app.desyn.app): auth, dashboard, editor, settings, billing, share/present pages      -> web agents
  landing/    Next.js 16 marketing site (desyn.app) + /docs + /blog + /templates gallery + legal pages             -> landing agent
  desktop/    Rust GPUI desktop app (cargo member `desyn-desktop`)                                                  -> desktop agent
  ios/        SwiftUI iOS app (Xcode project, SwiftPM local packages)                                               -> ios agent
packages/
  schema/     TS types, zod, JSON Schema, canonical JSON, plans config loader, id generation                       -> schema agent
  doc-ops/    TS applyTransaction/invert/validate/query helpers (used by Convex + clients), fixtures runner        -> schema agent
  tokens/     design tokens (CSS vars, Tailwind preset, TS consts), fonts css                                      -> ui agent
  ui/         React component library (Radix + Tailwind 4), themed, Storybook-free demo page                       -> ui agent
  ai/         Vercel AI SDK providers/registry/routing, agent loop, tools, workflows, prompts, evals               -> ai agent
  engine/     TS bindings around the wasm engine (worker, canvas bridge, text input bridge, asset loader)          -> engine agent
  sdk/        Public TS SDK + MCP server for the agent API                                                         -> api agent
crates/
  desyn-core/    Rust: model (serde), ops/transactions, layout, geometry, hit-test, snapping, paths/booleans, plans, canonical JSON -> core agent
  desyn-text/    Rust: font db, shaping, line breaking, bidi, measure, glyph outlines (implements core's TextMeasurer trait)        -> text agent
  desyn-describe/ Rust: describe/lint/semantic grouping/hierarchy (depends on core + text)                                  -> describe agent
  desyn-raster/  Rust: display list -> pixels (tiny-skia), SVG/PDF/PPTX/GIF/MP4 export                             -> raster agent
  desyn-wasm/    wasm-bindgen engine API                                                                           -> engine agent
  desyn-ffi/     UniFFI bindings for Swift (iOS)                                                                   -> ios agent
  desyn-worker/  Axum render/describe/layout worker                                                                -> worker agent
convex/        Convex backend (schema, functions, http actions, crons, components config)                          -> convex agents
templates/     Template pipeline + generated template designs + thumbnails                                          -> templates agent
deploy/        Dockerfiles, compose, nginx, scripts, backups, runbooks for Hetzner                                  -> deploy agent
config/        plans.json (shared)                                                                                  -> read-only for all
spec/fixtures/ Conformance fixtures shared by Rust and TS                                                           -> schema + core agents
docs/          Specs, handoff, runbooks                                                                              -> shared (append only)
assets/        fonts, brand marks                                                                                    -> shared (append only)
```

Package names: `@desyn/schema`, `@desyn/doc-ops`, `@desyn/tokens`, `@desyn/ui`, `@desyn/ai`, `@desyn/engine`, `@desyn/sdk`,
`@desyn/web`, `@desyn/landing`. Crate names: `desyn-core`, `desyn-raster`, `desyn-wasm`, `desyn-ffi`, `desyn-worker`, `desyn-desktop`.

## 4. Stack (verify versions with `npm view` / crates.io before use)

* Node 26, pnpm 12 workspaces + Turborepo, TypeScript 5.9+ strict, ESM.
* Web: Next.js 16 (App Router; the editor route is client-only), React 19, Tailwind CSS 4, Radix primitives, Zustand (editor state),
  `motion` (animation), Lucide icons, TanStack Virtual for long lists, `@dnd-kit` where needed. Fonts self-hosted.
* Backend: **Convex** (database, realtime, functions, http actions, crons, file metadata) + **Better Auth** via `@convex-dev/better-auth`.
  S3 for file bytes (presigned URLs; `S3_ENDPOINT` override for MinIO/R2 self-host). SES for email via adapter (SES default; SMTP via
  nodemailer for self-hosters). Stripe for billing (Checkout + Customer Portal + webhooks). Rate limiting via `@convex-dev/rate-limiter`
  (or an equivalent maintained component) and a credits ledger of our own. Presence via a table + cron (or `@convex-dev/presence`).
* AI: **Vercel AI SDK 7** (`ai`), providers `@openrouter/ai-sdk-provider`, `@ai-sdk/fal`, `ollama-ai-provider-v2` (community Ollama),
  `@ai-sdk/openai-compatible` (LM Studio, vLLM, llama.cpp, LocalAI, any OpenAI-compatible), plus direct `@ai-sdk/anthropic`,
  `@ai-sdk/openai`, `@ai-sdk/google`, `@ai-sdk/mistral`, `@ai-sdk/groq`, `@ai-sdk/replicate` as BYOK options. Default text model:
  Sonnet 5.5 through OpenRouter (verify the exact slug via OpenRouter's public models endpoint, never guess). Media via Fal.
* Rust: edition 2024, `serde`, `kurbo`/`peniko`-style path math (or `lyon`), `tiny-skia`, `cosmic-text` (+ `swash`, `rustybuzz` as it
  uses) for shaping, `resvg`/`usvg` for SVG assets, `image`, `pdf-writer`/`krilla` for PDF, `zip` + hand-written OOXML for PPTX,
  `gif`, ffmpeg (worker only) for MP4, `wasm-bindgen`, `uniffi`, `axum` + `tokio`, GPUI (check crates.io for the published `gpui`
  crate, otherwise the Zed git dependency pinned to a commit).
* Swift: iOS 18+, SwiftUI, Swift Concurrency, `convex-swift`, Observation framework, no other third-party UI deps.
* Telemetry (all optional by env, off when unset): PostHog **EU** (`https://eu.i.posthog.com`), Axiom logs (dataset `desyn`), DataFast.

## 5. Engine architecture

One Rust core owns truth for geometry, text layout, layout (auto-layout), hit-testing, describe and rendering so every client
renders identically.

```
desyn-core   Design/Node/Op types (serde)  ─ applyTransaction/invert ─ layout (auto-layout, constraints, groups)
             text shaping/measure (cosmic-text) ─ hit-test/bounds/snap helpers ─ describe/lint ─ plans
desyn-raster DisplayList builder from Design (+ viewport, scale, region) ─ tiny-skia rasterizer ─ effects/blends/masks/filters
             exporters: PNG/JPEG/WebP, SVG (own writer), PDF (vector, bleed, crop marks, optional CMYK-ish profile), PPTX, GIF, frame sequences
desyn-wasm   wasm-bindgen façade: Engine { load(design) | applyTransaction | render(viewport) -> ImageData | hitTest | measure |
             describe | export(...) | setFont(bytes) | setAsset(id, bytes) | snapshot() }
desyn-ffi    UniFFI façade for Swift with the same Engine surface (render returns RGBA buffer; Swift draws it with CGImage/Metal)
desyn-worker Axum HTTP service exposing render/describe/layout/measure/apply/thumbnail (section 8 of the document model)
```

Web: `@desyn/engine` runs the wasm engine inside a dedicated Web Worker with an OffscreenCanvas; the main thread handles pointer
events, a DOM overlay for text editing (IME, selection, spellcheck, accessibility) and selection handles. Rendering uses damage
rectangles and layer caching so dragging stays at refresh rate; large designs render progressively. Desktop: GPUI app links
`desyn-core` + `desyn-raster` natively, uploads the rendered viewport as a texture, GPUI draws chrome. iOS: Swift draws the RGBA
viewport from `desyn-ffi` (Metal-backed `CALayer`), handles gestures/Pencil, SwiftUI chrome. Server: worker renders for export,
thumbnails, previews for the AI, and campaign workflows.

## 6. Backend (Convex) — tables and functions

Directory `convex/`. Use the Better Auth component for users/sessions/accounts/orgs (Convex component tables are namespaced).
Convex dev for agents: run an **anonymous local deployment** (`CONVEX_AGENT_MODE=anonymous npx convex dev --once`, see Convex docs
for agent mode) so no login or secrets are needed. **Hosted production runs on Convex Cloud**: the prod and dev deployments and their URLs are in
`deploy/env/public.env`. Functions deploy with
`npx convex deploy` from the repo; Convex env vars hold the backend secrets. Self-hosted Convex (docker) remains the path for self-hosters
only (`deploy/SELFHOST.md`).

Tables (indexes as needed; every table scoped by `workspaceId` or `ownerId` and enforced in functions):
`profiles` (userId, plan, stripeCustomerId, locale, onboarding, aiSettings (provider prefs, encrypted BYOK blobs), flags)
`workspaces`, `memberships` (role: owner|admin|editor|commenter|viewer), `invites`, `folders`,
`designs` (workspaceId, ownerId, name, kind, seq, thumbnailKey, snapshot {key, seq}, archived, templateId?, public share settings,
pageCount, size stats, updatedAt), `nodes` (designId, nodeId, parentId, data (JSON of one Node), pageId) — materialized state,
`designOps` (designId, seq, tx, actor, ts) — canonical transaction log, `designAssets` (designId, assetId, ref),
`assets` (ownerId/workspaceId, kind, storageKey, mime, bytes, width, height, hash, source, ai metadata, status),
`brandKits` (workspaceId, name, logos[], colors[], fonts[], voice, rules, guidelines doc, extractedFrom),
`templates` (slug, title, kind, category[], tags[], premium, designKey, thumbs, popularity, searchText, embedding? optional),
`templateCollections`, `favorites`, `comments` (designId, nodeId?, pageId?, x,y, thread/parent, resolved, mentions), `versions`
(named versions/snapshots), `shares` (designId, token, permission, password?, expiresAt), `presence`, `aiRuns` (designId, userId,
kind: agent|workflow|asset, status, steps[], tokens, costCredits, error, plan, result), `aiRunEvents` (streamed events),
`workflows` (definition + runs + outputs), `credits` (ledger entries: userId/workspace, period, delta, reason, refId, balanceAfter),
`usage` (counters per period), `exports` (jobs, format, status, storageKey), `webhooks`, `apiKeys` (hashed, scopes, lastUsed),
`audit` (security-relevant events), `featureFlags` (optional runtime overrides), `mailLog` (sent mail metadata).

Functions (public API surface the clients depend on — implement all, names exact):
* `designs.create|get|list|rename|duplicate|archive|restore|delete|moveToFolder|setShare|listShares|getSharedByToken`
* `designs.load` (paginated nodes), `designs.commit` (apply tx), `designOps.since` (reactive), `designs.snapshot` (action), `designs.restoreVersion`
* `assets.requestUpload` (presigned PUT, validates mime/size by plan) → `assets.finalize` → `assets.getUrl` (signed GET, cached) | `assets.list|delete|rename`
* `templates.search|list|get|instantiate|collections|favorite`, `brandKits.*`, `folders.*`, `workspaces.*`, `memberships.*`, `invites.*`
* `comments.*`, `presence.heartbeat|list`, `versions.*`, `exports.request|status`
* `billing.createCheckout|createPortal|status` + Stripe webhook http action (`/stripe/webhook`), `credits.balance|history`, `usage.summary`
* `ai.runAgent` (starts a server-run agent job; streams events into `aiRunEvents`; applies transactions via `designs.commit` with
  `source:"ai"`), `ai.cancelRun`, `ai.generateAsset` (image/svg/bg-remove/inpaint/outpaint/upscale/mockup/trace), `ai.listModels`,
  `ai.testProvider`, `ai.saveSettings` (BYOK encrypted with `AI_KEY_ENCRYPTION_SECRET`), `workflows.*` (campaign/variants/resize/localize/bulk)
* `profiles.me|update`, `admin.*` (self-host admin console: users, plans override, usage, provider status, health), `apiKeys.*`
* HTTP actions (`convex/http.ts`): Better Auth routes, `/stripe/webhook`, `/api/v1/*` Agent API (REST), `/mcp` (MCP over HTTP), `/healthz`, `/og/:id` metadata.
* Crons: presence cleanup, credit period rollover, snapshot compaction, orphan asset cleanup, export cleanup, stale-run reaper.
Email (Node actions): verification, magic link, password reset, invites, receipts; SES adapter + SMTP adapter selected by `MAIL_TRANSPORT`.
Security: every function checks auth + membership + plan; validate all args with `v` validators; sanitize SVG; limit sizes; log to Axiom
(structured) from a shared `logger`; never trust client-provided plan/credits; idempotency on Stripe events.

## 7. AI architecture (`packages/ai`)

Isomorphic TypeScript package used by Convex actions (server-run), the web app (browser-run for BYOK/local models) and the Agent API.

* **Provider registry**: id -> `{ kind: "text"|"image"|"video"|"speech"|"embedding", create(config) }`. Built in: `openrouter` (default,
  server key `OPENROUTER_API_KEY`), `fal` (server key `FAL_AI_API_KEY`; pass the key explicitly to `createFal({ apiKey })`),
  `ollama` (base URL env/user), `openai-compatible` (user URL+key), `anthropic`, `openai`, `google`, `mistral`, `groq`, `replicate`. Users choose
  provider+model **per task** in settings; BYOK keys are stored encrypted server-side (or kept only in the browser in "local keys" mode).
* **Model routing table** (defaults; overridable per user/workspace/self-host env): agent loop / edit / chat = Sonnet 5.5 (OpenRouter);
  campaign planning + layout critique = Opus 5.5; vision review = Sonnet 5.5; SVG generation = Sonnet 5.5; copy/translate = Haiku 5.5;
  image generation = Fal (current best general model chosen from the live Fal catalog + a text-in-image capable model + a vector model);
  background removal = Fal segmentation (BiRefNet class) or in-browser ONNX; inpaint/outpaint = Fal fill model; upscale = Fal upscaler;
  video = Fal video model. Resolve exact model ids at runtime from catalogs (`ai.listModels`), cache them, never hardcode guesses;
  keep a pinned fallback list in `packages/ai/src/models.ts` verified against the live catalogs when written.
* **Agent loop**: `runAgent({ host, goal, selection, mode, history, signal, onEvent })` with `ToolLoopAgent`-style tool loop (AI SDK 7
  agent primitives — read its docs in `node_modules/ai/docs`). `DocHost` abstraction: `describe()`, `render(region?)`,
  `measure()`, `apply(tx)`, `assets`, `brand`, `selection`. Implementations: `WasmHost` (browser), `WorkerHost` (Convex action + worker),
  `MemoryHost` (tests).
* **Tools** (names exact; JSON-schema inputs derive from zod in `packages/ai/src/tools/*`): `read_design`, `read_selection`, `render_preview`,
  `query_elements`, `create_elements` (batch, supports nested subtrees), `update_elements` (batch patches), `delete_elements`,
  `duplicate_elements`, `group_elements`, `ungroup`, `set_roles`, `arrange` (align/distribute/stack/grid/auto-layout/match-size),
  `set_text` / `rewrite_text` / `translate_text`, `set_style`, `apply_brand`, `add_page` / `delete_page` / `reorder_pages` / `resize_page`,
  `generate_image`, `generate_svg`, `remove_background`, `inpaint`, `outpaint`, `upscale`, `mockup`, `trace_to_vector`, `search_stock`,
  `search_icons`, `search_templates`, `apply_template`, `critique`, `plan` (structured multi-step plan with checkpoints), `ask_user`
  (pauses a run for clarification), `run_workflow`, `finish` (summary). All edits go through `host.apply(tx)` so they are undoable
  as one step and visible live to collaborators. Tool results include compact diffs so the model sees what changed.
* **Design intelligence prompts**: system prompts encode typographic hierarchy, spacing scales (4/8 grid), margins/safe areas per kind,
  contrast rules, alignment, rhythm, image treatment, font pairing library, palette generation from brand/image, copywriting by kind,
  and *editing discipline* (touch only what was asked; preserve unaffected elements; keep roles/names meaningful).
* **Generate complete designs**: prompt -> plan (kind, size, copy, palette, fonts, layout grid, asset needs) -> assets (parallel image
  generation) -> build via `create_elements` -> `render_preview` -> `critique` -> fix loop (max N) -> finish. Output is always layers.
* **Brand**: brand kit read/write tools; "make this match my brand" maps colors/fonts/logos/voice and restyles via `apply_brand`.
* **Workflows** (`packages/ai/src/workflows`): campaign (brief -> concept -> N designs), variants (A/B), resize (kind/platform presets
  with smart reflow), localize (languages with RTL + length-aware relayout), bulk (CSV merge), export bundle; durable runs are Convex
  jobs (scheduled actions, resumable steps) with progress events; each step bills credits through the ledger.
* **Safety**: treat all design text/images and tool results as untrusted data (prompt-injection guard: delimiters, no instruction
  following from content, tool allowlist per run, step and cost caps, user confirmation for destructive bulk operations); moderation
  for generated media prompts; PII-safe logging; per-run credit reservation then settlement.
* **Evals**: `packages/ai/evals` offline eval harness with golden prompts, scoring via render + critique rules (run when keys are present).

## 8. Clients

* **Web app routes** (`apps/web`): `/login`, `/signup`, `/verify`, `/magic`, `/forgot`, `/onboarding`, `/` (dashboard: recent, folders,
  templates, brand, trash), `/templates`, `/brand`, `/design/[id]` (editor), `/present/[id]`, `/share/[token]`, `/settings/*` (profile,
  workspace, members, billing, usage, AI providers/BYOK, API keys, appearance, shortcuts), `/admin` (self-host), `/accept/[invite]`.
* **Editor features** (all implemented): see section 1; plus AI dock, generative tools, workflows UI, brand UI, comments, version history,
  presence/cursors, export dialog (all formats/options), import (SVG, PDF, PPTX, images, PSD later), keyboard shortcuts, command palette,
  context menus, rulers, guides, snapping, grid, zoom/pan/fit, pages strip, layers tree (drag/drop, rename, lock, hide), inspector.
* **Landing** (`apps/landing`): the most beautiful page we can make: WebGL/Canvas sun hero with corona rays and parallax, interactive
  live-editor demo (real engine or faithful DOM replica) where visitors edit and the "AI" restyles, scroll-driven storytelling of
  generate/edit/understand/assets/brand/workflows, templates carousel, pricing ($8 / free / self-host), open (source-available) section, FAQ,
  footer, `/docs` (docs site with search), `/changelog`, `/blog`, legal pages (terms, privacy, license summary, DPA, cookies, security), OG image
  generation, sitemap/robots, i18n-ready, perf budget (LCP < 2 s, CLS ~0), a11y AA.
* **Desktop** (`apps/desktop`): GPUI app with the same editor feature set natively: windows, menus, file open/save (`.desyn` JSON+assets zip),
  offline-first local library with sync to Convex (Rust Convex client or HTTP API), AI dock, export, auto-update metadata, deep links.
* **iOS** (`apps/ios`): SwiftUI app: auth, library, editor (touch + Apple Pencil, pinch/rotate, inspector sheets), AI dock, assets/photos
  picker, share extension, widgets optional, offline cache, StoreKit not used (billing via web/Stripe; follow App Store rules by gating
  purchase UI appropriately).

## 9. Environment variables (names only)

Server/Convex: `OPENROUTER_API_KEY`, `FAL_AI_API_KEY`, `AI_KEY_ENCRYPTION_SECRET`, `BETTER_AUTH_SECRET`, `SITE_URL`, `APP_URL`,
`CONVEX_URL` / `NEXT_PUBLIC_CONVEX_URL`, `CONVEX_SITE_URL`, `CONVEX_SELF_HOSTED_URL`, `CONVEX_SELF_HOSTED_ADMIN_KEY`, `AWS_REGION`,
`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `S3_BUCKET`, `S3_ENDPOINT`, `S3_PUBLIC_BASE_URL`, `S3_FORCE_PATH_STYLE`, `MAIL_TRANSPORT`
(`ses`|`smtp`|`log`), `SES_FROM`, `SMTP_URL`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_PRO_MONTHLY`,
`STRIPE_PRICE_PRO_YEARLY`, `RENDER_WORKER_URL`, `RENDER_WORKER_SECRET`, `UNSPLASH_ACCESS_KEY`, `PEXELS_API_KEY`, `OLLAMA_BASE_URL`,
`DESYN_EDITION` (`hosted`|`selfhost`), `GOOGLE_CLIENT_ID/SECRET`, `GITHUB_CLIENT_ID/SECRET`, `APPLE_*`.
Telemetry (public, all optional): `NEXT_PUBLIC_POSTHOG_KEY`, `NEXT_PUBLIC_POSTHOG_HOST` (default EU), `POSTHOG_PROJECT_API_KEY`,
`NEXT_PUBLIC_DATAFAST_WEBSITE_ID`, `NEXT_PUBLIC_DATAFAST_DOMAIN`, `DATAFAST_API_KEY`, `AXIOM_TOKEN`, `AXIOM_DATASET`, `AXIOM_ORG_ID`.
Hosted-only gating uses `DESYN_EDITION=hosted`; `selfhost` unlocks everything and defaults telemetry off.

## 10. Deployment (Hetzner, `ssh hetzner`)

Domains: `desyn.app` (landing), `docs.desyn.app` (docs), `app.desyn.app` (web app; proxies `/api/auth/*` and `/api/v1/*` to the Convex
Cloud site URL so cookies stay first-party), `render.internal` (worker, not public). The database/backend is **Convex Cloud** (not on
Hetzner); Hetzner runs the Next apps, the render worker, nginx and backups (Convex export to S3). Everything behind
**HTTP basic auth** until launch (nginx `auth_basic`, htpasswd generated on the server, never in git). The server is shared: it already
runs nginx and Docker workloads — never modify existing sites/containers; use dedicated compose project `desyn`, an isolated docker
network, dedicated nginx server blocks under `sites-available/desyn-*`, unique host ports in a documented range, `restart: unless-stopped`,
resource limits, nightly backups (Convex DB export + S3 sync), log shipping to Axiom, healthchecks, runbooks. TLS via certbot/ACME
on the host's nginx. `deploy/` contains scripts that are idempotent and safe to re-run.

## 11. Definition of done (per package)

Builds clean, lints clean, tests pass offline, documented in the package README, brief's features all implemented, README notes
written, screenshots/verification noted for UI. Cross-package contracts unchanged or changelogged.

## 12. Convex file ownership (parallel work)

`convex/schema.ts`, `convex/http.ts` only compose; do not edit them except to add an import line for a new tables/routes file.
Tables: `tables/accounts|billing|misc` -> accounts agent; `tables/designs|assets|templates|brand|collab` -> designs agent; `tables/ai` -> ai-backend agent.
Routes: `routes/auth|stripe|health` -> accounts agent; `routes/og` -> designs agent; `routes/api|mcp` -> api agent.
Each owner puts functions in their own subfolder: `convex/accounts/*`, `convex/designs/*`, `convex/ai/*`, `convex/api/*`, `convex/lib/<owner>-*.ts`
for helpers. Shared helpers every owner needs (auth guard, plan/feature checks, logger, rate limiting, credits) are owned by the accounts agent
in `convex/lib/` and exported from `convex/lib/index.ts`; others import and may add small additive helpers with distinct file names.
To type-check against a deployment: `flock /tmp/desyn-convex.lock env CONVEX_AGENT_MODE=anonymous npx convex dev --once` from the repo root.
Unit-test functions offline with `convex-test` + vitest (no deployment required).
