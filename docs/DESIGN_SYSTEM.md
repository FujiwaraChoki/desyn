# Desyn Design System — "Atmospheric Minimalism", Sun edition

This is the Akatsuki "Atmospheric Minimalism" design system re-keyed from crimson to **sun**. Every surface (landing, web app, desktop, iOS) uses this system so the products feel
like one thing. The goal is "unimaginably beautiful": restraint, huge calm type, one glowing accent, motion that feels alive.

## 1. Color (single accent: the sun)

```
SUN (accent, dark mode)   #FFB02E   rgb 255 176 46      // glows on near-black
SUN (accent, light mode)  #D27400   rgb 210 116 0       // >= 3:1 on white for large text
SUN-HI   (gradient hi)    #FFD66B   rgb 255 214 107
SUN-LO   (gradient lo)    #FF6A1F   rgb 255 106 31      // ember
Background  dark #0A0A0A   light #FFFFFF
Foreground  dark #EDEDED   light #171717
Surface-1   dark #111111   light #FAF8F4     // panels
Surface-2   dark #171717   light #F3EFE7     // raised / inputs
Surface-3   dark #1F1F1F   light #EAE4D8     // hover
Border      foreground @ 10% (subtle) / 20% (default) / 40% (hover)
Success #4ADE80 / #15803D   Warning = SUN   Danger #FF5C5C / #C62828   Info #7AB8FF / #1D5FBF
```

Deviation from Akatsuki: crimson is darkened in dark mode; the sun is **brightened** in dark mode (it is a light source on a
dark sky) and darkened in light mode for contrast. The product is **dark-first**: marketing and the editor default to dark;
light mode must be fully designed (not an inversion) and `system` is an option. All derived opacities follow the Akatsuki scales
(`rgb(var(--accent-rgb) / .15)` etc.).

Gradients: sun gradient = `linear-gradient(135deg, SUN-HI, SUN, SUN-LO)`. Orbs (blurred radial blobs) use SUN at 22-30% opacity
on dark. Never use purple/blue gradients. Charts and category colors use a warm-first palette derived from the sun:
`#FFB02E #FF6A1F #FFD66B #C4451C #8A5A00 #E8E1D3 #7A7468` plus neutrals; add a cool counter-color `#5AA9FF` only when data demands.

## 2. Typography

* **Display / headings: Instrument Serif** (Regular + Italic only; files in `assets/fonts/`). Single weight 400. Hierarchy comes
  from size, color and italics, never bold. Display text uses the accent color or foreground; italics for emphasis words.
* **UI / body: Instrument Sans** (variable 400-600, Google Fonts / `@fontsource-variable/instrument-sans`). Editor chrome is dense, so UI
  text is 12-14 px in sans; serif is reserved for headings, empty states, dialog titles, big numbers and marketing.
* **Mono: JetBrains Mono** for ids, code, numeric fields where alignment matters.
* Type scale (marketing): display 80/120, title 48/64, heading 28, subhead 20, body 16/1.75, small 14, label 14 (sentence
  case, normal tracking, muted; no uppercase + wide tracking anywhere). App UI scale: 11 / 12 / 13 / 14 / 16 / 20 / 28 serif.
* Fonts are self-hosted (no runtime Google calls): copy the TTFs, add woff2 subsets where possible. `font-display: swap`.

## 3. Space, shape, elevation

* 8 px base grid (4 px half-step inside dense editor panels). Radii: 6 (controls), 10 (cards), 14 (panels/dialogs), 999 (pills).
* Elevation is light, not shadow: 1 px borders at 10% foreground, soft accent glow only on primary actions and active selection
  (`--shadow-glow`), `--shadow-card: 0 20px 60px -40px rgb(var(--accent-rgb)/.4)`.
* Glass: `backdrop-filter: blur(20px) saturate(1.2)` on floating toolbars, menus and popovers over the canvas, with surface at 72%.
* Canvas background in the editor: a deep neutral (#0E0E0E dark / #ECE8DF light) with a faint dot grid; the design page itself sits
  on it with a soft shadow. Selection color = SUN, handles are 8 px white squares with a SUN border and 1 px dark outline.

## 4. Motion

* Easing: `--ease-out: cubic-bezier(.16,1,.3,1)`, `--ease-in-out: cubic-bezier(.65,0,.35,1)`. Springs for panels (stiffness 300, damping 30).
* Entrance: fade-up 0.5-0.8 s staggered 80 ms. Hover 0.2 s. Background orbs float 15-30 s. Always honor `prefers-reduced-motion`.
* The sun motif: a luminous disc with slow-rotating rays and corona shaders on the landing page; a small rotating sun-spinner for
  loading states; AI activity is a soft pulsing sun glow on the affected layers ("sunrise" sweep when the agent finishes).
* Never animate layout properties at 60 fps on the canvas path; canvas interaction must stay at the display refresh rate.

## 5. Components (shared vocabulary)

Buttons: primary (SUN fill, near-black text, glow on hover), secondary (surface-2, 1 px border), ghost, danger, icon-only 28/32/36 px.
Inputs: surface-2 fill, 1 px border, focus ring 2 px SUN at 60%. Numeric scrubbers (drag the label to change values). Sliders with SUN fill.
Tabs/segmented controls, toggle, checkbox, radio, select, combobox, popover, menu, context menu, tooltip (delay 400 ms), toast (bottom center),
dialog, sheet, command palette (cmd/ctrl+K), color picker (HSV area + hue + alpha + eyedropper + swatches + gradient stops editor),
font picker (virtualized, preview in font), avatar, badge/pill ("PRO" pill = sun gradient), skeletons shimmer in surface tones, empty states
with a serif headline and one clear action.
Iconography: Lucide (1.5 px stroke) in the app; custom sun mark for brand. Logo: lowercase "desyn" in Instrument Serif with a small sun
dot replacing the tittle of the "y"? Keep it simple: wordmark + a filled sun circle glyph.

## 6. Layout of the editor (web + desktop; iOS adapts)

Top bar (logo menu, doc name, undo/redo, zoom, share, export, collaborators, AI button) / left rail (Design, Elements, Text, Brand,
Uploads, Photos, AI, Layers, Pages) with a 320 px flyout / center canvas with floating context toolbar and bottom page strip /
right inspector (Design, Arrange, Effects, Animate, Position) / bottom-center floating tool dock (select, frame, shapes, pen, text,
image, hand) / AI agent dock: a prompt bar anchored bottom-center that expands into a chat + run log panel. Everything collapses
cleanly to small windows; the panels are resizable and remember state.

## 7. Content voice

Calm, precise, warm. Short sentences. No hype words. Headlines are lowercase-leaning, serif, with one italic word. Example:
"design at the speed of *light*." Buttons say exactly what happens. Errors say what to do next.

## 8. Accessibility

WCAG AA contrast for all text (verify SUN-on-dark and ink-on-SUN), visible focus, full keyboard operation including the canvas
(arrow-nudge, tab through layers, shortcuts), screen-reader labels for tools, reduced motion, 44 px min touch targets on iOS,
dynamic type on iOS, RTL-ready layout in the app chrome.
