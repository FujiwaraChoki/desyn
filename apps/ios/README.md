# Desyn for iOS

Native SwiftUI app (iOS 18+, iPhone and iPad) for Desyn: sign in, a library of designs that works offline, and a
Metal canvas driven by the same Rust engine as the web and desktop apps (`crates/desyn-ffi` through
`DesynEngine`). Observation, Swift Concurrency and `convex-swift` for Convex; no other third-party dependency.

## Layout

| path | what |
|---|---|
| `project.yml` | XcodeGen spec: app target `Desyn`, test bundle `DesynTests`, shared scheme `Desyn` |
| `App/` | `@main` entry, Info.plist (URL scheme `desyn`, endpoint keys), entitlements (associated domains), asset catalog (icon, accent, launch color) |
| `Config/` | `Desyn.xcconfig` (includes the generated `Endpoints.xcconfig` and an optional, git-ignored `Local.xcconfig`), `apple-app-site-association.json` |
| `Packages/DesignSystem` | the sun theme of `docs/DESIGN_SYSTEM.md`: colors (dark + light), bundled Instrument Serif / Instrument Sans / JetBrains Mono, spacing, radii, motion, buttons, fields, cards, sheets, sun spinner, orbs background, glass bars, toasts, segmented controls, haptics |
| `Packages/DesynKit` | Foundation-only: models mirroring `docs/DOCUMENT_MODEL.md` (lossless JSON objects + typed accessors, `Op`, `DesignTransaction`), a strict JSON parser / deterministic writer, node factories with the schema defaults, text-run editing in UTF-16, pressure ink outlines, page presets generated from `@desyn/schema`, the Convex API facade, the sync client (`SyncSession`, DOCUMENT_MODEL section 6), the offline store and offline-edit flush, asset download / upload, the Better Auth client, PKCE, Keychain storage and the convex-swift `AuthProvider` |
| `Packages/Features` | `FeatureCore` (session, deep links, routes), `AuthFeature`, `LibraryFeature`, `EditorFeature`, `AppFeature` (root view and routing) |
| `Features/<Name>` | editor feature packages: `InspectorFeature`, `AssetsFeature` (insert, photos, stock, uploads, brand), `AIFeature` (AI dock, generative tools), `ExportFeature`, `ShareFeature`, `CommentsFeature` (comments, version history), `SettingsFeature`; tests in each `Tests/` run in `DesynTests` |
| `Extensions/SharedKit` | `AppGroupKit` (App Group snapshot for the widget), `SharedKit` (Foundation-only: typed Convex calls of the features, AI run timeline, op builders, element / brand / import factories, Iconify and Google Fonts, generated font catalog), `PanelKit` (per-editor context, panel components, font service, previews rendered by the engine) |
| `Extensions/App` | compiled into the app: registers the features in the editor / library extension points, `desyn://new` and `desyn://create` links, App Intents (Shortcuts), the widget snapshot publisher |
| `Extensions/ShareExtension`, `Extensions/Widget` | the `DesynShare` share extension (photos / PDFs -> new design) and the `DesynWidgets` WidgetKit extension (recent designs) |
| `DesynEngine/` | the engine package (owned by the engine agent; built by `scripts/build-ios-engine.sh`) |
| `Tests/DesynTests` | app-level tests (deep links, geometry, the Swift model layer against the real engine); the DesynKit package tests run in the same bundle |
| `scripts/gen-presets.mts` | regenerates `DesynKit/Generated/PagePresets.swift` from `packages/schema` |
| `scripts/sync-config.sh` | regenerates `Config/Endpoints.xcconfig` from `deploy/env/public.env` |
| `scripts/linux-check.sh` | compiles and tests the platform-neutral Swift on Linux in Docker |

## Build and test on a Mac

Requirements: macOS with Xcode 26+ (CI uses the newest Xcode on `macos-15`; the orchestrator's host is macOS 27
with Xcode 27), the iOS 18 simulator runtime or newer, `rustup` with the Apple targets, and XcodeGen.

```sh
# once
brew install xcodegen
rustup target add aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios

# from the repository root
scripts/build-ios-engine.sh                      # Rust engine XCFramework + Swift bindings (release; --debug is faster)
apps/ios/scripts/sync-config.sh --check          # endpoints match deploy/env/public.env (drop --check to rewrite)
cd apps/ios
xcodegen generate --spec project.yml             # writes Desyn.xcodeproj (git-ignored)
open Desyn.xcodeproj                             # run the "Desyn" scheme on a simulator or device

# command line (what .github/workflows/ios.yml runs)
xcodebuild test -project Desyn.xcodeproj -scheme Desyn \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO

# package tests on macOS without Xcode projects
swift test --package-path DesynEngine
swift test --package-path Packages/DesynKit
```

Signing: the project uses automatic signing with team `HL34V4TRZ5` and bundle id `app.desyn.ios`; change
`DEVELOPMENT_TEAM` / `PRODUCT_BUNDLE_IDENTIFIER` in `project.yml` for another account. Simulator builds and
tests need no signing.

### Against a local backend

Copy `Config/Local.xcconfig.example` to `Config/Local.xcconfig` and run the local anonymous Convex deployment
and the web app (see `apps/web/README.md`). App Transport Security allows local networking.

### Universal links (magic sign-in links)

The app asks Better Auth to send magic links with `callbackURL=desyn://auth/magic`. The emailed link points at
`https://app.desyn.app/api/auth/magic-link/verify?...`; with associated domains (`applinks:app.desyn.app`, from
`DESYN_APP_HOST`) iOS opens it in the app, which verifies the token itself and stores the session. The web app
domain must serve `Config/apple-app-site-association.json` at `/.well-known/apple-app-site-association`
(`application/json`, no redirect). If the link opens in a browser instead, the browser signs in and bounces to
`desyn://auth/magic`; the app then finishes with the browser sign-in, which reuses that fresh session.

## How it works

- **Auth**: email + password and magic links call Better Auth on the Convex site URL with the session as a bearer
  token (no cookies). "Continue with Google / GitHub / browser" runs the PKCE flow of `convex/accounts/nativeAuth.ts`
  (`/native/authorize` in `ASWebAuthenticationSession`, then `/auth/native/token`). The session lives in the
  Keychain (`AfterFirstUnlockThisDeviceOnly`); `DesynAuthProvider` turns it into 15-minute Convex JWTs and
  refreshes them a minute before expiry.
- **Library**: recent (live first page), folders, shared with me, templates and brand kits; search; create from
  any preset or a custom size; pull to refresh. Lists, thumbnails, designs and asset bytes are cached per account
  for offline use; edits made offline in closed designs are flushed when the library appears.
- **Sync**: `SyncSession` keeps `confirmed + pending (+ preview)` in the engine. Local transactions apply at once
  and commit one at a time (idempotent, retried while offline); remote transactions rewind pending work, apply,
  and re-apply on top; the server's applied ops replace local ones when they differ; gaps reload. Gestures and
  typing use the engine's preview layer (never committed, kept on top while remote edits land underneath) and
  commit one transaction at the end (text after 400 ms idle). Relayouts after fonts arrive go through the same
  queue as one `system` transaction. Offline edits of closed designs are flushed from the library; when the
  server refuses or rewrites one, the cached copy is replaced by the server copy on the next open.
- **Canvas**: a `CAMetalLayer` shows engine frames rendered into an aligned `FrameBuffer`; `MetalFrameTexture`
  uploads only the damaged rectangles, and the shader draws the canvas color, dot grid and page shadow and
  re-projects the last frame during pan / zoom so navigation stays at display rate.
- **Gestures**: tap select, double tap edits text or drills into groups, drag moves (with snapping guides and a
  haptic tick), 44 pt transform handles for resize (corners keep the aspect ratio) and rotation (15 degree
  detents), marquee on empty canvas, two-finger pan / pinch zoom / twist to rotate the selection, long-press
  context menu with a lifted preview of the layer, hardware keyboard shortcuts (delete, cmd-D, arrows, escape).
- **Apple Pencil**: pressure-sensitive pen tool (strokes become filled path layers), hover preview of the pen
  tip and layer outlines, double tap switches between the pen and the previous tool (honors the system setting).
- **Text**: a `UITextInput` view bridges the keyboard, IME, dictation and the system selection UI
  (`UITextInteraction`) to the engine's caret, selection and hit-test geometry (UTF-16 offsets).
- **Undo**: the editor's `UndoManager` mirrors its history, so shake to undo, three-finger gestures, the toolbar
  and cmd-Z all work; each step is one transaction.

## Editor features and extensions

- **Inspector** (sheet with resizable detents; the canvas stays live up to the medium height): fill layers with solid
  colors and linear / radial gradients (sun color picker: HSV field, hue and alpha tracks, hex, document / recent /
  palette swatches, the system picker for its eyedropper), strokes (position, dashes, line ends), corners and
  smoothing, opacity and blend modes, effects (shadows, blurs, glow, grain), photo filters and adjustments; text
  styles (presets, font picker with every catalog family previewed in itself, Google Fonts downloaded and cached
  on demand and registered with the engine), size, weight, italics, alignment, spacing, case, lists, sizing, curve;
  content of charts (type, data grid), tables (cells, size) and QR codes; arrange (align / distribute, order, group /
  ungroup, flip, lock, hide); position (X / Y / W / H / rotation through the engine's transform, aspect lock,
  constraints); animate (entrance / emphasis / exit presets, timing, easing, page transitions, engine-rendered
  preview). Every change previews while a control moves and commits one undoable transaction.
- **Insert** ("+" in the tool dock): shapes and lines, text presets, photos (library, camera, Files; downsampled with
  ImageIO and uploaded through presigned S3), stock photos (`stock/photos:search`, credited, download tracked),
  Iconify icons (Lucide / Tabler / Phosphor, previews rendered by the engine in one pass), charts, tables, QR codes,
  the workspace library (rename / delete). **Brand**: browse kits, apply colors / fonts / logos, restyle the page
  with the kit (`BrandApplier`) or ask the AI to match it.
- **AI**: a prompt bar above the dock and the AI dock sheet: modes (edit / generate / critique), selection as context,
  suggestions, the run's timeline streaming live from `ai/agent:runEvents` (messages, tool steps, applied changes,
  previews, plan, questions with answers, outcome and credits), stop, history; layers the agent touches pulse on the
  canvas and get a sunrise sweep when it finishes. A run started here is one undo step (its server transactions
  are grouped by `actor.runId`, DOCUMENT_MODEL section 6); the dock offers "Undo these changes" while it is the
  latest step. **Create with AI**: image and vector generation, background removal, expand, upscale and mockups
  (`ai/media:*`); edited photos swap in place.
- **Export**: PNG / JPG / WebP / SVG / PDF (bleed, crop marks, CMYK, flatten) / PowerPoint / GIF rendered on the device
  by the engine (missing images and fonts are fetched first), MP4 and fallbacks on the server; share sheet, Save to
  Photos, Save to Files. **Share**: view / comment / edit links with password and expiry. **Comments**: pins on the
  canvas, threads, replies, @mentions, resolve. **Version history**: save, preview (engine-rendered), restore.
- **Plan gates**: work the device does on its own follows the plan features of `config/plans.json` (generated into
  `SharedKit/Generated/PlanFeaturesData.swift`, overridden live by `profiles:me`): export formats and PDF print
  options, charts, tables, QR codes, advanced effects and animations show a PRO pill and say they are part of Pro
  (no purchase links). The server enforces its own checks for everything it does.
- **Settings** (avatar in the library): account, appearance, plan and credits / usage (no purchase UI), AI providers
  (read-only; keys are added on the web), signed-in devices, sign out, and in-app account deletion (App Store
  guideline 5.1.1(v); Better Auth `delete-user`, password unless the session is fresh).
- **Extensions**: the share extension imports photos and PDFs (one page each) into a new design with the app's
  session (shared keychain group); the widget shows recent designs (small / medium / large) from an App Group
  snapshot the app writes; Shortcuts offers "Create Design from Prompt" (the AI builds it) and "Open Recent Design".

Signing: the share extension (`app.desyn.ios.share`) and the widget (`app.desyn.ios.widgets`) need the App Group
`group.app.desyn.ios` (all three targets) and the keychain group `$(AppIdentifierPrefix)app.desyn.ios` (app and
share extension) enabled for the team.

```sh
# Foundation-only code of the features (SharedKit + AppGroupKit) on Linux, in Docker:
apps/ios/Extensions/SharedKit/scripts/linux-test.sh
# the font catalog and the plan features mirror packages/schema:
packages/schema/node_modules/.bin/tsx apps/ios/Extensions/SharedKit/scripts/gen-fonts.mts --check
packages/schema/node_modules/.bin/tsx apps/ios/Extensions/SharedKit/scripts/gen-plans.mts --check
```

## Verification without a Mac

`scripts/linux-check.sh` builds and runs the DesynKit and FeatureCore (Foundation-only) suites with Swift 6.2
in Docker, using small shims for convex-swift and CryptoKit. With `--engine` it also links the real Rust
engine (the Linux build of `crates/desyn-ffi`) and runs the engine-backed suites of the Xcode bundle
(`EngineContractTests`, `EngineSyncTests`: Swift models against the engine, the canvas gesture flow through
`SyncSession` + `EngineDocument`, remote edits mid-gesture, relayouts):

```sh
scripts/build-ios-engine.sh --swift-linux      # once (and after Rust API changes): static library + C header
apps/ios/scripts/linux-check.sh --engine
```

UIKit / SwiftUI / Metal code compiles only with Xcode (CI `ios.yml`).
