import { describe, expect, test } from "vitest";
import * as F from "../src/fonts";

describe("font catalog", () => {
  test("at least 120 unique families across all categories", () => {
    expect(F.FONT_CATALOG.length).toBeGreaterThanOrEqual(120);
    const names = F.FONT_CATALOG.map((f) => f.family.toLowerCase());
    expect(new Set(names).size).toBe(names.length);
    for (const cat of ["sans-serif", "serif", "display", "handwriting", "monospace"] as const) {
      expect(F.fontsByCategory(cat).length).toBeGreaterThanOrEqual(10);
    }
  });

  test("metadata is consistent", () => {
    for (const f of F.FONT_CATALOG) {
      expect(f.weights.length).toBeGreaterThan(0);
      for (const w of f.weights) {
        expect(w).toBeGreaterThanOrEqual(100);
        expect(w).toBeLessThanOrEqual(1000);
      }
      expect([...f.weights].sort((a, b) => a - b)).toEqual(f.weights);
      const wght = f.axes?.find((a) => a.tag === "wght");
      if (wght) {
        expect(f.weights[0]).toBe(wght.min);
        expect(wght.max - (f.weights[f.weights.length - 1] as number)).toBeLessThan(100);
      }
      for (const a of f.axes ?? []) expect(a.max).toBeGreaterThan(a.min);
      expect(f.tags.length).toBeGreaterThan(0);
      for (const p of f.pairsWith) {
        expect(F.getFont(p), `${f.family} pairs with unknown ${p}`).toBeDefined();
        expect(p).not.toBe(f.family);
      }
    }
  });

  test("lookups", () => {
    expect(F.getFont("inter")?.family).toBe("Inter");
    expect(F.isVariableFont("Inter")).toBe(true);
    expect(F.isVariableFont("Lato")).toBe(false);
    expect(F.nearestWeight("Lato", 500)).toBe(400);
    expect(F.nearestWeight("Lato", 550)).toBe(700);
    expect(F.nearestWeight("Lato", 350)).toBe(400);
    expect(F.nearestWeight("Inter", 1200)).toBe(900);
    expect(F.nearestWeight("Unknown Family", 600)).toBe(700);
    expect(F.getFont("Instrument Serif")?.weights).toEqual([400]);
  });
});

describe("pairings", () => {
  test("at least 40 pairings of catalog families with available weights", () => {
    expect(F.FONT_PAIRINGS.length).toBeGreaterThanOrEqual(40);
    expect(new Set(F.FONT_PAIRINGS.map((p) => p.id)).size).toBe(F.FONT_PAIRINGS.length);
    for (const p of F.FONT_PAIRINGS) {
      const h = F.getFont(p.heading);
      const b = F.getFont(p.body);
      expect(h, p.heading).toBeDefined();
      expect(b, p.body).toBeDefined();
      expect(F.nearestWeight(p.heading, p.headingWeight)).toBe(p.headingWeight);
      expect(F.nearestWeight(p.body, p.bodyWeight)).toBe(p.bodyWeight);
      expect(p.moods.length).toBeGreaterThan(0);
      expect(p.goodFor.length).toBeGreaterThan(0);
    }
  });

  test("queries", () => {
    expect(F.pairingsForMood("elegant").length).toBeGreaterThan(2);
    expect(
      F.pairingsForMood("elegant", "editorial").every((p) => p.moods.includes("editorial")),
    ).toBe(true);
    expect(F.pairingsForKind("invitation").length).toBeGreaterThan(3);
  });
});
