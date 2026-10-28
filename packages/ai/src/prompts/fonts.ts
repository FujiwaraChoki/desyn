// Font pairing guidance built from the @desyn/schema catalog so the model only proposes fonts the editor can load.
import {
  type DesignKind,
  FONT_PAIRINGS,
  type FontPairing,
  getFont,
  pairingsForKind,
} from "@desyn/schema";

function line(p: FontPairing): string {
  return `- ${p.heading} ${p.headingWeight} + ${p.body} ${p.bodyWeight} (${p.moods.join(", ")})`;
}

/** Recommended pairings for a kind (falls back to versatile ones), formatted for a prompt. */
export function fontPairingText(kind: DesignKind, limit = 10): string {
  const forKind = pairingsForKind(kind);
  const list = (
    forKind.length >= 4
      ? forKind
      : [...forKind, ...FONT_PAIRINGS.filter((p) => !forKind.includes(p))]
  ).slice(0, limit);
  return [
    "## Font pairings (all available in the editor)",
    "Choose one pairing that matches the mood; use the heading font for headline/subhead and the body font for everything else.",
    ...list.map(line),
    "Prefer these catalog families (self-hosted, instant). Other Google Fonts families load on demand; never use fonts that are not on Google Fonts unless the brand kit provides them.",
  ].join("\n");
}

/** True when the family exists in the catalog (tools reject unknown fonts with a helpful message). */
export function isCatalogFont(family: string): boolean {
  return getFont(family) !== undefined;
}

/** Catalog families similar to an unknown name (for error messages). */
export function suggestFonts(family: string, limit = 5): string[] {
  const q = family.toLowerCase().replace(/[^a-z]/g, "");
  const scored = FONT_PAIRINGS.flatMap((p) => [p.heading, p.body])
    .filter((f, i, all) => all.indexOf(f) === i)
    .map((f) => {
      const name = f.toLowerCase().replace(/[^a-z]/g, "");
      let common = 0;
      for (let i = 0; i < Math.min(name.length, q.length); i++) if (name[i] === q[i]) common++;
      return { f, score: common + (name.includes(q.slice(0, 4)) ? 3 : 0) };
    })
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s) => s.f);
}
