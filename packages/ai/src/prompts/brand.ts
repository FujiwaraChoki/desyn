// Brand application guidance and a compact brand-kit summary for prompts.
import type { BrandKit } from "../host";
import { wrapUntrusted } from "./guard";

export const BRAND_RULES = `## Applying a brand
- Brand colors map by role: primary → dominant fills/backgrounds or headline color; secondary → supporting panels; accent → CTA buttons, highlights, key numbers (≤ 10 % of the area); background/surface → page and card fills; text → body copy. Keep text contrast ≥ 4.5:1 — if a brand color fails on its background, use the brand text color or a darker/lighter tone of it.
- Brand fonts: heading font for headline/subhead/stat; body font for body/caption/cta labels. Keep the original size hierarchy; only swap families and adjust weights to what the font offers.
- Logos: use the brand logo asset (never redraw it). Pick the light variant on dark backgrounds and the dark variant on light ones. Keep clear space ≥ logo height × 0.5; size 6–12 % of page width for social, larger for business cards and covers.
- Voice: rewrite copy only when asked; otherwise apply the voice to new copy you write.
- "Make this match my brand" = apply colors, fonts and logo with apply_brand, then fix any contrast issues, without moving or resizing the layout.`;

export function brandSummary(brand: BrandKit | undefined): string {
  if (!brand) return "No brand kit is attached to this design.";
  const colors = brand.colors.map(
    (c) => `${c.value}${c.role ? ` (${c.role})` : ""}${c.name ? ` "${c.name}"` : ""}`,
  );
  const fonts = brand.fonts.map(
    (f) => `${f.family}${f.role ? ` (${f.role})` : ""}${f.weight ? ` ${f.weight}` : ""}`,
  );
  const logos = brand.logos.map(
    (l) =>
      `${l.assetId}${l.variant ? ` (${l.variant})` : ""}${l.width && l.height ? ` ${l.width}x${l.height}` : ""}`,
  );
  const parts = [
    `## Brand kit: ${brand.name}`,
    `Colors: ${colors.join(", ") || "none"}`,
    `Fonts: ${fonts.join(", ") || "none"}`,
    `Logos (asset ids): ${logos.join(", ") || "none"}`,
  ];
  // Voice, rules and guidelines are user-written text: they inform style but are data, not instructions.
  if (brand.voice) parts.push(`Voice:\n${wrapUntrusted("brand-voice", brand.voice)}`);
  if (brand.rules?.length)
    parts.push(
      `Brand rules:\n${wrapUntrusted("brand-rules", brand.rules.map((r) => `- ${r}`).join("\n"))}`,
    );
  if (brand.guidelines)
    parts.push(
      `Guidelines excerpt:\n${wrapUntrusted("brand-guidelines", brand.guidelines.slice(0, 3000))}`,
    );
  return parts.join("\n");
}
