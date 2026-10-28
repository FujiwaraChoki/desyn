// Core design knowledge given to every design-capable model. Numbers are concrete on purpose: models follow
// explicit scales far better than adjectives.

export const TYPOGRAPHY = `## Typography
- Hierarchy comes from size first, then weight, color and case. Every design has ONE dominant element (usually the headline) that is at least 1.6x the next level; posters and thumbnails push 2.5–4x.
- Use a modular scale. Ratios: 1.25 (dense UI, documents), 1.333 (presentations, flyers), 1.5 (social, posters), 1.618+ (display-heavy posters, thumbnails). Example at base 16 and 1.333: 16 / 21 / 28 / 38 / 50 / 67.
- Sizes relative to the page's short side S: headline 7–14% of S (posters/social), body 2.2–3.2% of S, captions ≥ 1.6% of S. Never below 12 px on screens at 1080 px wide, never below 6 pt (8 px) in print.
- Line height: display/headlines 0.95–1.15 (percent 95–115), subheads 1.2, body 1.4–1.6. Tighter for uppercase.
- Letter spacing (em): large display -0.02 to -0.04; body 0; ALL-CAPS labels/eyebrows +0.08 to +0.2.
- Measure: body lines 45–75 characters; headlines 2–4 lines max, balanced (no single-word last line).
- Max two families (a third only for a single accent, e.g. a script word). Pair contrast: serif display + sans body, or one superfamily with weight contrast. Use 2–3 weights total.
- Alignment: left-aligned text reads best for anything over 3 lines; center only short headlines, invitations, certificates and symmetric layouts. Never justify short columns.
- Emphasis: change one property at a time (weight OR color OR italic), never all.`;

export const SPACING = `## Spacing, grid and margins
- Work on an 8-px grid (4-px half steps for small type and tight UI). Spacing scale: 4, 8, 12, 16, 24, 32, 48, 64, 96, 128.
- Margins scale with the page: outer margin ≈ 5–8% of the short side for social/screens (54–86 px at 1080), 8–10% for posters, ≥ 3 mm + bleed safety in print (business cards 4–5 mm). Respect platform safe areas (stories: top 250 px and bottom 340 px at 1920 px tall are covered by UI).
- Proximity: related items sit close (gap = 0.5–1x body size); separate groups get 2–3x that. Space between groups > space within groups, always.
- Pick a column grid: 12 columns for wide layouts, 6 for social squares, 4 for stories; gutters 16–32 px. Snap blocks to column edges.
- Keep consistent rhythm: reuse the same 2–3 gap values throughout a design.
- Optical adjustments: visually center blocks (slightly above mathematical center), hang punctuation, nudge round shapes 1–2 px past edges.`;

export const COLOR = `## Color
- Structure palettes 60/30/10: dominant neutral or brand background, secondary supporting color, accent for the call to action and key highlights.
- Build palettes in OKLCH: vary lightness for hierarchy, keep chroma consistent; accents are the most saturated color on the page.
- Contrast (WCAG): body text ≥ 4.5:1, large text (≥ 24 px or ≥ 18.66 px bold) ≥ 3:1, essential icons/UI ≥ 3:1. Check text over images — add a scrim (black 30–60 % or a gradient) or place text on a solid panel.
- Limit to 3–5 colors plus neutrals. Tint neutrals toward the brand hue (warm grays with warm brands).
- Dark backgrounds: avoid pure #000 / #fff pairs for long text; use #0a0a0a–#141414 with #ededed.
- Harmony: analogous for calm, complementary for energy (use the complement only as accent), monochrome + one accent for premium.
- Color carries meaning: red = urgency/sale, green = success/fresh, blue = trust, gold/black = luxury. Respect the brand first.`;

export const LAYOUT = `## Composition and alignment
- Every element aligns to something: a margin, a column edge, another element's edge or center. Prefer few strong alignment axes (one left edge for a text stack).
- Establish a reading path: Z-pattern for sparse layouts (logo top-left, CTA bottom-right), F-pattern for text-heavy, centered axis for symmetric/formal pieces.
- Visual weight: large, dark, saturated, high-contrast and isolated elements are heavy. Balance heavy elements with space, not with more elements.
- Whitespace is an element: 30–50 % empty area for premium/minimal looks; dense layouts still keep generous outer margins.
- Group with containers (cards, panels) only when proximity is not enough; give cards consistent radius (8/12/16/24) and padding (16–32).
- Repetition: same style for same-level items (all list items, all prices). Contrast for different levels.
- Depth: use at most one shadow style (soft, large blur, low opacity, e.g. y 12–24, blur 32–60, 12–20 % black).`;

export const IMAGERY = `## Images, icons and illustration
- Photos: one strong hero beats a collage. Crop with intent (rule of thirds, eyes on the upper third line, leave lead room in the gaze direction). Full-bleed hero images extend past the page edge or align exactly to it.
- Text over photos needs a quiet area or a scrim. Put the subject opposite the text block.
- Treatments for cohesion: same color grade/duotone on every photo, consistent corner radius, consistent frame style.
- Icons: one family, one stroke weight, sized to the cap height of adjacent text (or 1.25–1.5x for standalone feature icons).
- Illustrations and photos rarely mix well; choose one primary visual language per design.
- Logos keep clear space ≥ the logo's x-height on all sides, never stretched, never on busy backgrounds without a plate.`;

export const ACCESSIBILITY = `## Readability and accessibility
- Contrast rules above are mandatory, not optional. Don't encode meaning in color alone.
- Avoid light-weight fonts (≤ 300) below 24 px. Avoid long italic or all-caps passages.
- Give images alt text (set "alt"), layers meaningful names and semantic roles.`;

export const ALL_PRINCIPLES = [TYPOGRAPHY, SPACING, COLOR, LAYOUT, IMAGERY, ACCESSIBILITY].join(
  "\n\n",
);
