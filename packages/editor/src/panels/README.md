# Editor panels (`panelsExtension`)

The left rail flyouts, the inspector tabs, the pages strip and the page / chart dialogs of the editor. One
extension (`index.ts`) registers everything into the shell's slots (see `../../ARCHITECTURE.md`).

| registered | where | what |
|---|---|---|
| rail `design` (10) | `rail/design-panel.tsx` | template library: search, size + category filters, apply (replace page / add pages), favorites |
| rail `elements` (20) | `rail/elements-panel.tsx`, `rail/icon-results.tsx` | shapes, lines, photo frames, photo grids, Iconify icons + stickers, AI illustrations, charts (data sheet), tables, QR |
| rail `text` (30) | `rail/text-panel.tsx` | text box, presets, text effects, font combinations (`FONT_PAIRINGS`, lazy previews) |
| rail `brand` (40) | `rail/brand-panel.tsx` | brand kits: apply to page / design, colors, fonts, logos, voice, match with AI |
| rail `uploads` (50) | `rail/uploads-panel.tsx` | workspace library: drop / pick uploads with progress, folders, rename, move, delete, place |
| rail `photos` (60) | `rail/photos-panel.tsx` | Unsplash / Pexels via `stock/photos:search`, copied in with `panels/stock:use` |
| rail `layers` (80) | `layers/layers-panel.tsx` | virtualized tree: multi-select, drag to reorder / reparent, rename, lock, hide, role badges, search + filters, context menu |
| rail `pages` (90) | `pages/pages-panel.tsx` | page grid with the strip's actions |
| slot `pages` | `pages/pages-strip.tsx` | engine thumbnails, reorder, rename, page menu, add |
| inspector `design` / `effects` / `arrange` / `animate` | `inspector/*` | contextual design properties, effects, arrange commands, animations + preview |
| modals `page-resize`, `chart-data` | `dialogs/*` | resize with presets and content strategy; chart data spreadsheet |
| commands | `index.ts` | `panel.design|text|uploads|photos`, `insert.heading|subheading|body`, `page.resize`, `page.moveTo`, `edit.chartData` |

Edits follow the golden rules: discrete edits go through `editor.apply`, continuous input (scrubs, color
drags, sliders) previews with `editor.preview` and commits once with `editor.commitPreview`
(`lib/live.ts`). Pure logic lives in `lib/` and is unit tested in `test/panels/lib.test.ts`; the panels are
tested in jsdom in `test/panels/panels.test.tsx`; `test/panels/harness/` renders the real shell + engine for
Playwright screenshots (`node test/panels/harness/shots.mjs <outDir>` with `HARNESS_ASSETS` set to a folder
holding `sunset.jpg`, `abstract.jpg`, `portrait.jpg`).

Backend functions are referenced by name in `backend.ts`; without a Convex client (tests, other hosts) the
library panels show an explanatory empty state.

Image crop zoom / focus (`lib/image-crop.ts`) writes `ImageNode.crop` in the form the canvas crop mode and
crates/desyn-raster share: the visible source rect with the box's aspect and no `zoom` factor (the renderer
multiplies `crop.zoom` on top of the rect). Sliders around a neutral middle (adjustments, text curve) use
`CenteredSlider` (`ui/primitives.tsx`), whose fill grows from zero.
