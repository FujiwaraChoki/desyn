# Render fixtures

Golden images for `crates/desyn-raster` (`tests/golden.rs`). Each `<name>.json` is a complete `Design`; the first
page is rendered with the settings in `meta.render` (`scale`, default 1; `timeMs` for animated pages) using the
desyn-text bundled fonts and the assets in `assets/` (files named by asset id), and compared with `<name>.png`
(per-channel tolerance 3, at most 0.3 % of pixels may differ).

| fixture | covers |
|---|---|
| `shapes` | rect radii / smoothing / rotation, ellipse arcs / donut / ring, polygon, star, even-odd path, curves, the four booleans, line caps |
| `paints` | linear (0 / 45 / 180°), radial, off-center radial, conic, image fill fill / fit / tile / stretch + adjust, paint stacks with blend modes, fill opacity |
| `strokes` | inside / center / outside on rect, ellipse, star; dashes; per-side widths; joins; gradient strokes |
| `effects` | drop shadow (offset, spread), inner shadow, layer blur, glow, noise, background blur over a busy backdrop |
| `blend` | all 16 blend modes over a gradient |
| `masks` | alpha mask, luminance mask, rotated clipping frame, group opacity, flip |
| `text` | serif headline, rich runs (bold, italic, underline, strike, highlight), centered wrap, nested lists, gradient fill, outline stroke, curved text, monospace + emoji |
| `images` | fill / fit / crop, ellipse shape + outside stroke, adjustments + vignette, duotone, blur, preset + flip, alpha matte |
| `svg` | gradients, clip, mask, dashed strokes, recolor, SVG asset, sticker outline + shadow, filter fallback |
| `charts` | column, bar, stacked column, line, area, scatter, pie, donut, radar, funnel, progress |
| `table_qr` | table (header, stripes, merged cells, cell fill / style, alignment), square and rounded QR codes |
| `social` | a realistic 1080x1080 post (also the performance fixture), rendered at 0.5x |
| `anim` | entrance / loop animations evaluated at 520 ms |

Regenerate the inputs (never edit them by hand): `python3 crates/desyn-raster/scripts/gen_render_fixtures.py
spec/fixtures/render`. After a deliberate rendering change, inspect the new renders
(`DESYN_GOLDEN_OUT=<dir> cargo test --test golden`) and rewrite the expected images with
`DESYN_UPDATE_GOLDENS=1 cargo test --test golden`.
