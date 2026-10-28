# @desyn/tokens

Design tokens for Desyn ("Atmospheric Minimalism", sun edition; see `docs/DESIGN_SYSTEM.md`).
One TypeScript source of truth generates the CSS.

| Export | What |
| --- | --- |
| `@desyn/tokens` | TS constants: `palettes`, `colors` (hex + rgb triplets per theme), `spacing`, `radii`, `fonts`, `appType`, `marketingType`, `zIndex`, `breakpoints`, `layout`, `shadows`, `scrim`, `orbOpacity`, `easings`, `durations`, `stagger`, `tooltipDelay`, `chartPalette`, `defaultSwatches`, color math (`hexToRgb`, `contrastRatio`, `mixOver`…) |
| `@desyn/tokens/motion` | Presets for `motion/react`: `springPanel`, `springSnappy`, `springGentle`, `tweenFast/Normal/Slow`, `staggerContainer`, `fadeUp`, `fadeIn`, `scaleIn`, `charReveal`, `popIn`, `dialogIn`, `slideIn(side)`, `sunrise` (needs `motion` installed) |
| `@desyn/tokens/variables.css` | Plain CSS custom properties (no Tailwind needed) |
| `@desyn/tokens/tokens.css` | Tailwind CSS 4 theme (imports `variables.css` + `theme.css`), `dark:`/`light:` variants, base layer |
| `@desyn/tokens/fonts.css` | `@font-face` for Instrument Serif (woff2 + ttf in `fonts/`), Instrument Sans Variable and JetBrains Mono Variable (fontsource) |

## Themes

- `:root` with no `data-theme` is **dark** (dark-first).
- `data-theme="dark" | "light"` forces a theme on any element; `data-theme="system"` follows `prefers-color-scheme`.
- Themes nest: derived tokens (`--line`, `--ring`, `--glass`…) are redeclared on every `[data-theme]` scope.

## Tailwind usage

```css
@import "tailwindcss";
@import "@desyn/tokens/fonts.css";
@import "@desyn/tokens/tokens.css"; /* or @desyn/ui/styles.css, which includes it */
```

Colors: `bg-background`, `bg-surface-1/2/3`, `bg-canvas`, `text-fg`, `text-fg-secondary`, `text-fg-muted`,
`text-fg-placeholder`, `border-line(-subtle|-strong)`, `bg-accent`, `text-accent-text` (AA small text), `bg-accent-solid` +
`text-accent-ink` (primary buttons), `bg-accent-tint|wash`, `ring-ring`, `text-success|warning|danger|info`, `bg-scrim`, `bg-glass`.
Tailwind's default color palette is removed on purpose. Radii: `rounded-control|card|panel|pill`. Shadows: `shadow-glow(-lg)|card|popover|dialog|page|inset`.
Type: app scale `text-2xs…xl` (11/12/13/14/16/20/28) plus `text-display(-lg)|title(-lg)|heading|subhead|body|label`.
Fonts: `font-serif|sans|mono`. Easing: `ease-out` / `ease-in-out` are the design curves. z-index: `z-(--z-popover)` etc.
Animations: `animate-spin-sun|shimmer|sun-pulse|float-1..3|morph-1..3|orb-pulse|fade-up|indeterminate`.

## Editing tokens

Change `src/*.ts`, then `pnpm generate` (rewrites `src/variables.css` and `src/theme.css`). Tests fail if the CSS is stale and
check WCAG contrast for every text/background pairing.

Deviations from the DESIGN_SYSTEM.md table (both for AA): light `success` is `#147A3A` (spec `#15803D` was 4.37:1 on surface-2) and
muted text is foreground at 62% (Akatsuki 60%). Light-mode small accent text uses `--accent-text` `#A35800`; `--accent` stays `#D27400`.

Fonts: Instrument Serif is OFL (from `assets/fonts`, converted to woff2 with `woff2_compress`, not subset).

```sh
pnpm --filter @desyn/tokens test | typecheck | lint
```
