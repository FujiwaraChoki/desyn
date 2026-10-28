// Layout archetypes, copy rules and production notes per DesignKind. The agent gets the entry for the design it
// is working on; the planner gets them all when a campaign spans kinds.
import type { DesignKind } from "@desyn/schema";

export interface KindGuide {
  goal: string;
  archetypes: string[];
  copy: string;
  production: string;
}

export const KIND_GUIDES: Readonly<Record<DesignKind, KindGuide>> = {
  "social-post": {
    goal: "Stop the scroll in under a second and make one message obvious at phone size.",
    archetypes: [
      "Hero image full-bleed + headline on a scrim or solid band + small logo corner.",
      "Typographic: oversized headline (3–7 words) on a bold color field + supporting line + handle/logo.",
      "Split: image half / text half on a 2-column grid, CTA pill under the text.",
      "Carousel cover: big hook headline + 'swipe' cue; later slides keep the same grid and colors.",
    ],
    copy: "Headline 3–8 words, concrete benefit or hook. Optional subline ≤ 15 words. One CTA (2–4 words). No paragraphs.",
    production:
      "Text ≥ 32 px at 1080 px. Keep 54–86 px margins. Leave the bottom ~150 px calm on Instagram (UI overlays). Logo small (6–10 % width).",
  },
  story: {
    goal: "Vertical full-screen moment; the message must survive platform UI on top and bottom.",
    archetypes: [
      "Full-bleed photo/video + headline in the upper-middle third + sticker-style CTA mid-lower.",
      "Stacked typographic poster: eyebrow, huge headline, short body, CTA, all centered on a vertical axis.",
      "Product focus: cut-out product centered on a color field with a price badge.",
    ],
    copy: "Headline ≤ 6 words; body ≤ 20 words; CTA like 'Swipe up', 'Tap to shop', 'Link in bio'.",
    production:
      "1080x1920: keep text out of the top 250 px and bottom 340 px. Center axis layouts work best. Type ≥ 44 px.",
  },
  poster: {
    goal: "Readable from across a room; strong single focal point, then details for those who approach.",
    archetypes: [
      "Hero image + headline + details: image covers 60–100 %, headline huge, event details in a tight block at the bottom.",
      "Swiss typographic: grid-based, giant headline set flush-left, small info columns aligned to the grid.",
      "Central illustration/emblem with headline above and details below on a symmetric axis.",
    ],
    copy: "Headline 1–6 words. Details block: what, when, where, price/tickets, URL or QR. Group date/time/place tightly.",
    production:
      "Headline 10–20 % of page width in cap height. 8–10 % margins. Print: 3 mm bleed, keep text 5+ mm inside trim, images ≥ 300 dpi at size.",
  },
  flyer: {
    goal: "Inform at arm's length: clear headline, scannable benefits, obvious next step.",
    archetypes: [
      "Header band with headline + image, 3 benefit bullets with icons, footer with CTA, contact and QR.",
      "Offer flyer: big discount/price badge, product image, terms in small print at bottom.",
      "Event flyer: date block as a strong graphic element, lineup/agenda list, venue map/QR.",
    ],
    copy: "Headline ≤ 8 words, subhead ≤ 15, 3–5 bullets of ≤ 8 words, CTA + contact. Fine print ≤ 30 words.",
    production:
      "Print sizes need bleed and ≥ 5 mm safe margin. Body ≥ 9 pt (12 px). Use a 6- or 12-column grid.",
  },
  thumbnail: {
    goal: "Win the click at 168x94 px: a face or subject, 3–5 bold words, extreme contrast.",
    archetypes: [
      "Face/subject cut-out on one side (large, expressive), 3–5 word title on the other side in heavy type with stroke or shadow.",
      "Before/after split with arrow and short label.",
      "Object close-up + giant number or one-word title + small badge.",
    ],
    copy: "Title 2–5 words, complementing (not repeating) the video title. Numbers and contrasts work ('$0 vs $10k').",
    production:
      "1280x720. Title cap height ≥ 12 % of height. Avoid the bottom-right corner (timestamp). Max 3 elements. Saturated colors, outlines/glows on text over busy images.",
  },
  banner: {
    goal: "Wide strip that reads at a glance; content concentrated in the safe central area.",
    archetypes: [
      "Left-aligned headline + subline, image or pattern on the right, CTA at the end of the text column.",
      "Centered tagline over a subtle pattern/gradient, logo small.",
    ],
    copy: "Headline ≤ 7 words, optional subline ≤ 12 words.",
    production:
      "Profile headers crop on different devices and are covered by avatars (bottom-left on X/LinkedIn): keep text in the central 60 %.",
  },
  ad: {
    goal: "Sell one thing to one audience; the brand and offer must be recognizable instantly.",
    archetypes: [
      "Product hero + offer headline + CTA button + logo, stacked for tall units or side-by-side for wide units.",
      "Problem/solution: short pain point line, product image, benefit line, CTA.",
    ],
    copy: "Headline ≤ 6 words (offer or benefit), subline ≤ 10, CTA verb-first ('Shop now', 'Start free').",
    production:
      "IAB units: tiny sizes (300x250, 728x90, 320x50) need ≥ 14 px text and at most 3 elements. Button with clear contrast; logo always visible.",
  },
  presentation: {
    goal: "One idea per slide; the audience reads the slide in 3 seconds and listens to the speaker.",
    archetypes: [
      "Title slide: big title, subtitle, presenter/date small, brand mark.",
      "Section divider: number + section title on a color field.",
      "Content: slide title top-left, 3 bullets max or one chart/image + one takeaway line.",
      "Big number/quote slide: one statistic or quote with attribution.",
      "Image slide: full-bleed photo with a short caption on a scrim.",
    ],
    copy: "Slide titles are takeaways ('Revenue doubled in Q3'), ≤ 8 words. Bullets ≤ 6 words each, ≤ 3 per slide. Detail goes in speaker notes.",
    production:
      "1920x1080: titles 56–80 px, body 28–40 px, margins 96–120 px. Same title position on every slide. Consistent master layout via roles slide-title / slide-body.",
  },
  infographic: {
    goal: "Turn data into a story that flows top-to-bottom.",
    archetypes: [
      "Vertical sections: title + intro, 3–6 data sections (big stat + label + icon/chart), conclusion + source.",
      "Timeline down a central spine with alternating cards.",
      "Comparison: two columns with matching rows.",
    ],
    copy: "Title ≤ 10 words; each section: stat + ≤ 12-word explanation. Always cite sources at the bottom.",
    production:
      "Consistent icon family and chart styling; one accent color for highlights; align sections to a strict column grid.",
  },
  "business-card": {
    goal: "Identity in a small space: name, role, contact, brand — legible and printable.",
    archetypes: [
      "Front: logo centered (or logo + tagline) on brand color. Back: name, title, contact list left-aligned, small logo.",
      "Single-sided minimal: name large top-left, contact bottom-left, logo bottom-right.",
    ],
    copy: "Name, title, phone, email, website, optional address/social handle. No sentences.",
    production:
      "US 3.5x2 in / EU 85x55 mm. Bleed 3 mm, keep text ≥ 4–5 mm inside trim. Name 10–14 pt, details 7–9 pt (never below 6 pt). Two pages: front and back.",
  },
  resume: {
    goal: "Scan in 7 seconds: name, current role, strongest achievements, contact.",
    archetypes: [
      "Two-column: narrow left sidebar (contact, skills, education), wide right (experience).",
      "Single column with clear section headings and a strong name header.",
    ],
    copy: "Achievement bullets start with a verb and include numbers. Section titles: Experience, Education, Skills, Projects.",
    production:
      "A4/Letter, margins 15–20 mm, body 9.5–11 pt, headings 12–14 pt, name 22–32 pt. One accent color.",
  },
  invitation: {
    goal: "Set the tone of the event and give the essential details elegantly.",
    archetypes: [
      "Centered formal: ornament, hosts line, event name in display/script, date-time-place block, RSVP.",
      "Photo-led: couple/subject photo top, details below on a calm field.",
    ],
    copy: "Who invites, what, when (day, date, time), where (venue, address), RSVP by + contact. Warm, concise.",
    production:
      "5x7 in typical; centered symmetric layouts; script fonts only for names/titles, never for details.",
  },
  menu: {
    goal: "Make choosing easy and steer attention to signature/high-margin items.",
    archetypes: [
      "Sections (Starters, Mains, Desserts, Drinks) in columns; item name, short description, price aligned right without dot leaders.",
      "Single-page bistro: logo header, two columns, boxed specials.",
    ],
    copy: "Item names ≤ 5 words, descriptions ≤ 15 words with sensory words; prices without currency symbols for a premium feel.",
    production: "Body ≥ 10 pt; consistent price alignment; highlight 1–2 items with a box or icon.",
  },
  logo: {
    goal: "A simple, distinctive mark that works at 16 px and in one color.",
    archetypes: [
      "Wordmark: custom-tracked type, one modified glyph.",
      "Symbol + wordmark lockup (horizontal and stacked).",
      "Emblem/badge for heritage brands.",
    ],
    copy: "Brand name only (+ optional tagline in the lockup).",
    production:
      "Center on the artboard with generous padding; prefer vector shapes (svg/path) over images; provide one-color legibility.",
  },
  newsletter: {
    goal: "Skimmable updates with clear sections and links.",
    archetypes: [
      "Masthead + lead story with image + 2–3 secondary stories in a grid + footer.",
      "Single column email: header image, intro, sections with headings and buttons.",
    ],
    copy: "Lead headline ≤ 10 words; story teasers ≤ 30 words; clear 'Read more' CTAs.",
    production:
      "Consistent section spacing; body 14–16 px on screen; 600–700 px content width for email.",
  },
  document: {
    goal: "Long-form readability: structure, navigation, consistent styles.",
    archetypes: [
      "Cover page + contents + chapters with H1/H2/H3 hierarchy, running header/footer with page numbers.",
      "One-pager: title, summary box, sections, key figures callout.",
    ],
    copy: "Clear headings, short paragraphs, pull quotes for key points.",
    production:
      "Margins 20–25 mm, body 10–12 pt with 1.4–1.5 line height, consistent heading styles (use text styles).",
  },
  whiteboard: {
    goal: "Organize ideas visually: clusters, flows and annotations.",
    archetypes: [
      "Sticky-note clusters with headers",
      "Flowchart with connectors",
      "Matrix/quadrant canvas",
    ],
    copy: "Short labels; one idea per note.",
    production: "Generous spacing; color-code categories; align notes to a loose grid.",
  },
  website: {
    goal: "A hero section that states the value proposition and drives one action.",
    archetypes: [
      "Nav bar, hero with headline + subhead + primary/secondary buttons, product visual right.",
      "Centered hero with headline, subhead, CTA, logo cloud below.",
      "Feature grid of 3–6 cards with icons below the hero.",
    ],
    copy: "Headline ≤ 10 words (outcome), subhead ≤ 25 words (how), CTA verb-first.",
    production:
      "12-column grid, 1200–1440 px content width, headline 56–80 px, body 18–20 px, 96–160 px section spacing.",
  },
  video: {
    goal: "Motion-first scenes; each page is a shot with timing.",
    archetypes: [
      "Title card → 3–5 message scenes → CTA end card",
      "Kinetic typography sequence",
      "Product showcase with captions",
    ],
    copy: "≤ 7 words per scene on screen; captions for spoken content.",
    production:
      "Use page durationMs and element anim presets (rise, fade, pop) staggered 80–150 ms. Keep text in title-safe area (5 % margins).",
  },
  "book-cover": {
    goal: "Genre recognizable at thumbnail size; title and author legible.",
    archetypes: [
      "Full-bleed illustration/photo with title top third, author bottom.",
      "Typographic cover: title as the image, strong color, minimal motif.",
    ],
    copy: "Title, subtitle (optional), author name; series name if any.",
    production:
      "Title readable at 200 px wide thumbnail. Genre conventions: thriller = high contrast/condensed sans; romance = script/soft; non-fiction = clean bold sans.",
  },
  certificate: {
    goal: "Formal recognition: hierarchy of title, recipient, reason, signatures.",
    archetypes: [
      "Bordered formal: title, 'presented to', recipient name large, description, date + signatures + seal",
    ],
    copy: "Certificate title, recipient, achievement line ≤ 20 words, date, issuer, signatory names/titles.",
    production:
      "Landscape, centered symmetric layout, classic serif or script for the recipient, ornamental border inside the safe area.",
  },
  sticker: {
    goal: "A bold die-cut-able shape with a playful graphic.",
    archetypes: [
      "Badge circle with icon + short text",
      "Character/illustration with thick white outline",
    ],
    copy: "1–3 words max.",
    production:
      "Thick outline (≥ 2 mm print), high contrast, keep elements away from the cut line.",
  },
  mockup: {
    goal: "Show the design in context (device, print, packaging) realistically.",
    archetypes: [
      "Device frame with screen design",
      "Print on a surface with shadows",
      "Packaging/product shot",
    ],
    copy: "Usually no copy beyond the design itself.",
    production: "Use the mockup tool to generate scenes; keep perspective and lighting believable.",
  },
  custom: {
    goal: "Adapt to the stated purpose and size.",
    archetypes: [
      "Pick the closest archetype from the kinds above based on the aspect ratio and goal.",
    ],
    copy: "Match the stated purpose.",
    production: "Derive margins and type sizes from the short side of the page.",
  },
};

export function kindGuideText(kind: DesignKind): string {
  const g = KIND_GUIDES[kind];
  return [
    `## Design kind: ${kind}`,
    `Goal: ${g.goal}`,
    "Layout archetypes:",
    ...g.archetypes.map((a) => `- ${a}`),
    `Copy: ${g.copy}`,
    `Production: ${g.production}`,
  ].join("\n");
}
