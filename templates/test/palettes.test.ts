import { describe, expect, it } from "vitest";
import { contrast, PALETTES } from "../src/lib/palettes";

// Minimum contrast for each pairing the archetypes rely on (WCAG 2.x: 4.5 body text, 3 large text / UI).
const RULES: [keyof (typeof PALETTES)[number], keyof (typeof PALETTES)[number], number][] = [
  ["ink", "bg", 7],
  ["muted", "bg", 4.5],
  ["ink", "surface", 4.5],
  ["muted", "surface", 3],
  ["onAccent", "accent", 4.5],
  ["accent", "bg", 3],
];

describe("palettes", () => {
  for (const p of PALETTES) {
    it(`${p.id} keeps text legible`, () => {
      for (const [fg, bg, min] of RULES) {
        expect(
          contrast(p[fg] as string, p[bg] as string),
          `${p.id}: ${String(fg)} on ${String(bg)}`,
        ).toBeGreaterThanOrEqual(min);
      }
    });
  }
  it("ids are unique", () => {
    expect(new Set(PALETTES.map((p) => p.id)).size).toBe(PALETTES.length);
  });
});
