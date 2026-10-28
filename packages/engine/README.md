# @desyn/engine

The Rust Desyn engine (`crates/desyn-wasm`) for the browser: it runs in a dedicated Web Worker and draws into an
OffscreenCanvas; the main thread keeps a synchronous mirror of the design, handles input, and draws selection
chrome and the text-editing overlay. Same pixels as the desktop app, the iOS app and the render worker.

```ts
import { EngineClient, TextEditBridge, WasmHost } from "@desyn/engine";

const client = await EngineClient.create({
  canvas,                                        // sized with CSS; the engine owns the backing store
  render: { background: "#0e0e0e", pageShadow: true, budgetMs: 10 },
  resolveAsset: (asset) => signedUrlFor(asset),  // URL | bytes | Blob; default: AssetRef.url
});
await client.load(design);                       // fonts of the design load before the first frame
client.fit();
const r = await client.apply(tx);                // normalized; client.design is updated
await client.preview(dragTx);                    // per pointermove (coalesced), then:
const committed = await client.commitPreview({ label: "Move" });   // commit committed.applied, undo = inverse
const hit = await client.hitTestScreen({ x, y });
```

## What is in the box

| module | |
|---|---|
| `EngineClient` (`client.ts`) | starts the worker (`new Worker(new URL("./worker.ts", import.meta.url), { type: "module" })`) and transfers the canvas (`transferControlToOffscreen`); **main-thread fallback** when OffscreenCanvas / workers are unavailable (`mode: "main"` forces it). Design mirror via `@desyn/doc-ops` replaying the engine's `applied` ops (verified canonically equal to the engine state). Previews coalesce (one in flight, newest queued). View state with device-pixel snapping, `ResizeObserver` (`device-pixel-content-box`) and DPR-change tracking. Parsed, typed wrappers for every engine call. Asset resolution (`resolveAsset`) when frames report missing assets; font assets resolved at load. Events: `frame`, `font`, `asset`, `assetError`, `relayout`, `recovered`, `fatal`, `warning`, `change`, `view`. |
| `EngineHost` (`host.ts`) | the worker side: rAF-paced frames, presents damage rectangles with `putImageData` from a view into wasm memory, scrolls the canvas with a self `drawImage` when the engine reports a whole-pixel scroll, progressive tiles under a per-frame budget (previous image shown transformed meanwhile), zoom gestures shown as a scaled last frame until the zoom rests 110 ms, font gating on load, debounced `relayout` after font loads, exports (PDF / PPTX / GIF through the lazily loaded exporters module), crash recovery (a trapped engine is re-created from the load + transaction log, fonts and assets). |
| `rpc.ts` | small typed RPC over `postMessage`: request / response ids, remote errors with names, transferables both ways, fire-and-forget casts, events, close semantics; the worker serves only `ENGINE_WORKER_METHODS` (an allowlist, so host internals are not callable). |
| `fonts.ts` | `FontLoader`: custom sources, the bundled OFL set (Inter, Instrument Sans / Serif, JetBrains Mono, Noto Sans Arabic / Hebrew, Noto Emoji; one `new URL()` per file), Google Fonts CSS2 with `unicode-range` subsets (sliced CJK / color-emoji families fetch only slices covering the document's characters, more as text is typed), Cache API persistence, failure memory. `designFontNeeds(design)` computes the load hints. |
| `assets.ts` | `AssetLoader`: bounded concurrency, timeouts, retries on transient errors, size limit. Decode errors come from the engine (`assetError`). |
| `text-bridge.ts` + `text-ops.ts` | `TextEditBridge`: transparent `<textarea>` for keyboard, IME composition, clipboard and screen readers; the engine renders the text and answers caret / selection / hit / movement (bidi, wrapped lines, goal column) queries; edits are live previews committed after 400 ms idle (`onCommit`); bold / italic / underline shortcuts, Tab, Shift+Enter (line break), in-session undo / redo, double / triple click, IME underline, caret placed for candidate windows, built-in overlay (or `onGeometry` for custom drawing). `text-ops` are the pure run edits. |
| `WasmHost` (`wasm-host.ts`) | `DocHost` of `@desyn/ai` on top of the client, so the agent runs in the browser: `describe` (Rust describe + lint, image sampling from decoded assets), `render` (PNG preview after assets and fonts settle), `measure`, `apply` (one undo step, `onApply` to commit), `assets`, `brand`, `selection`, `page`. Uploaded bytes are handed to the engine after the `apply` that adds their `AssetRef` (the engine decodes by asset kind, so an SVG or font registered earlier would be misread as a raster image); `assets.read` serves them meanwhile. `render` reports the PNG's real size. |
| `viewport.ts` | screen <-> page math, `zoomAt`, `fitRect`, `panBy`, `snapToDevice`, `wheelZoomFactor`. |

## Build

`pnpm --filter @desyn/engine build:wasm` (also `build`) compiles `crates/desyn-wasm` twice and writes
`wasm/desyn_engine*.{js,d.ts,wasm}`, `wasm/desyn_export*` and `wasm/manifest.json`, and copies the bundled fonts to
`fonts/`. Needs cargo + the `wasm32-unknown-unknown` target + the `wasm-bindgen` CLI at the version `Cargo.lock` pins
(0.2.129); `wasm-opt -Oz` from PATH (binaryen, as in CI / Docker) or the `binaryen` dev dependency. Options:
`--dev` (debug, no wasm-opt), `--if-missing` (used by `typecheck` / `test`), `--no-opt`; env `DESYN_WASM_OPT`
(default `-Oz`), `DESYN_WASM_SIMD=0` (disable wasm SIMD), `DESYN_WASM_HOT` (crates compiled at opt-level 3 inside
the size-optimized build; default tiny-skia, tiny-skia-path, desyn-raster). Release sizes: engine 6.5 MiB, exporters
8.0 MiB (before HTTP compression).

## Next.js (apps/web)

No special configuration beyond transpiling the package (apps/web already lists `@desyn/engine` in
`transpilePackages`). The worker and the wasm / font files are referenced with `new URL(..., import.meta.url)`,
which Turbopack (and webpack / Vite) turn into emitted static assets; no `asyncWebAssembly` / `asset/webassembly`
rules are involved because the wasm-bindgen glue fetches and instantiates the module itself. Requirements:

* the editor component is client-only (`"use client"`, created in an effect);
* a `<canvas>` can be transferred to a worker only once: create a fresh element per `EngineClient` (React StrictMode
  mounts effects twice);
* CSP: `script-src 'wasm-unsafe-eval'`, `worker-src 'self'` (default-src self is enough), `connect-src` for
  `https://fonts.googleapis.com` / `https://fonts.gstatic.com` and the asset hosts (apps/web allows `https:`);
* `@desyn/engine` must be built before `next build` (turbo `build` dependency, as the Docker image does).

`demo/next-smoke` is a minimal Next 16 app doing exactly that (`pnpm --filter @desyn/engine demo:next`, port 4105).

## Demo and verification

```sh
pnpm --filter @desyn/engine build:wasm
pnpm --filter @desyn/engine test          # vitest: rpc, text ops, fonts, viewport, assets, wasm engine in Node,
                                          # EngineClient + EngineHost + WasmHost end to end (main-thread mode)
pnpm --filter @desyn/engine demo          # Vite demo on http://127.0.0.1:4105 (?design=<fixture>&mode=main&theme=light|dark; follows the OS theme)
pnpm --filter @desyn/engine demo:verify   # Playwright: fixtures, pan / zoom, 60 fps drag timing, live text
                                          # editing, exports, incremental == full redraw, main-thread fallback
```
