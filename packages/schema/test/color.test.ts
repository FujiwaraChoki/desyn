import { describe, expect, test } from "vitest";
import * as C from "../src/color";

describe("hex", () => {
  test("parse all forms", () => {
    expect(C.parseHex("#fff")).toEqual({ r: 255, g: 255, b: 255 });
    expect(C.parseHex("#0008")).toEqual({ r: 0, g: 0, b: 0, a: 136 / 255 });
    expect(C.parseHex("FFB02E")).toEqual({ r: 255, g: 176, b: 46 });
    expect(C.parseHex("#ffb02e80")?.a).toBeCloseTo(128 / 255, 6);
    expect(C.parseHex("#ggg")).toBeNull();
    expect(C.parseHex("#12345")).toBeNull();
    expect(C.parseHex("rgb(0,0,0)")).toBeNull();
  });

  test("format / normalize / isColor", () => {
    expect(C.formatHex({ r: 255, g: 176, b: 46 })).toBe("#ffb02e");
    expect(C.formatHex({ r: 255.4, g: -3, b: 300, a: 0.5 })).toBe("#ff00ff80");
    expect(C.formatHex({ r: 0, g: 0, b: 0, a: 1 })).toBe("#000000");
    expect(C.normalizeHex("#ABC")).toBe("#aabbcc");
    expect(C.normalizeHex("nope")).toBeNull();
    expect(C.isColor("#aabbcc")).toBe(true);
    expect(C.isColor("#AABBCC")).toBe(false);
    expect(C.isColor("#abc")).toBe(false);
    expect(C.withAlpha("#ffb02e", 0.25)).toBe("#ffb02e40");
    expect(C.alphaOf("#ffb02e40")).toBeCloseTo(0.25, 2);
  });
});

describe("conversions", () => {
  test("hsl round trips", () => {
    expect(C.toHsl("#ff0000")).toEqual({ h: 0, s: 1, l: 0.5 });
    expect(C.toHsl("#808080").s).toBe(0);
    for (const c of ["#ffb02e", "#0a0a0a", "#7ab8ff", "#c4451c", "#ffffff", "#123456"]) {
      expect(C.fromHsl(C.toHsl(c))).toBe(c);
      expect(C.fromHsv(C.toHsv(c))).toBe(c);
      expect(C.fromOklch(C.toOklch(c))).toBe(c);
    }
  });

  test("hsv", () => {
    expect(C.toHsv("#00ff00")).toEqual({ h: 120, s: 1, v: 1 });
    expect(C.fromHsv({ h: 240, s: 1, v: 1 })).toBe("#0000ff");
    expect(C.fromHsv({ h: 0, s: 0, v: 0 })).toBe("#000000");
  });

  test("oklab / oklch reference values", () => {
    const white = C.toOklch("#ffffff");
    expect(white.l).toBeCloseTo(1, 4);
    expect(white.c).toBeCloseTo(0, 4);
    const red = C.toOklch("#ff0000");
    expect(red.l).toBeCloseTo(0.628, 3);
    expect(red.c).toBeCloseTo(0.2577, 3);
    expect(red.h).toBeCloseTo(29.23, 1);
    const blue = C.rgbToOklab({ r: 0, g: 0, b: 255 });
    expect(blue.l).toBeCloseTo(0.452, 3);
    expect(blue.b).toBeCloseTo(-0.3115, 3);
  });

  test("out-of-gamut OKLCH is chroma-reduced, keeping lightness", () => {
    const vivid = C.fromOklch({ l: 0.7, c: 0.5, h: 150 });
    expect(C.isColor(vivid)).toBe(true);
    expect(C.toOklch(vivid).l).toBeCloseTo(0.7, 2);
  });
});

describe("contrast", () => {
  test("luminance and ratios", () => {
    expect(C.relativeLuminance("#ffffff")).toBeCloseTo(1, 6);
    expect(C.relativeLuminance("#000000")).toBe(0);
    expect(C.contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 6);
    expect(C.contrastRatio("#ffffff", "#000000")).toBeCloseTo(21, 6);
    expect(C.contrastRatio("#777777", "#ffffff")).toBeCloseTo(4.48, 2);
    expect(C.contrastRatio("#ffb02e", "#0a0a0a")).toBeGreaterThan(10);
    // design-system claim: light-mode sun on white is >= 3:1 (large text)
    expect(C.contrastRatio("#d27400", "#ffffff")).toBeGreaterThanOrEqual(3);
  });

  test("translucent foregrounds are composited first", () => {
    expect(C.contrastRatio("#00000000", "#ffffff")).toBeCloseTo(1, 6);
    expect(C.contrastRatio("#00000080", "#ffffff")).toBeLessThan(
      C.contrastRatio("#000000", "#ffffff"),
    );
  });

  test("WCAG levels", () => {
    expect(C.wcagLevel(7.1)).toBe("AAA");
    expect(C.wcagLevel(4.6)).toBe("AA");
    expect(C.wcagLevel(4.4)).toBe("fail");
    expect(C.wcagLevel(3.2, true)).toBe("AA");
    expect(C.wcagLevel(4.6, true)).toBe("AAA");
    expect(C.isLargeText(24)).toBe(true);
    expect(C.isLargeText(19, 700)).toBe(true);
    expect(C.isLargeText(19, 400)).toBe(false);
  });

  test("readable text color and ensureContrast", () => {
    expect(C.readableTextColor("#ffb02e")).toBe("#000000");
    expect(C.readableTextColor("#0a0a0a")).toBe("#ffffff");
    for (const [fg, bg] of [
      ["#ffd66b", "#ffffff"],
      ["#333333", "#111111"],
      ["#ff6a1f", "#ff8a3f"],
    ]) {
      const fixed = C.ensureContrast(fg as string, bg as string, 4.5);
      expect(C.contrastRatio(fixed, bg as string)).toBeGreaterThanOrEqual(4.5);
    }
    expect(C.ensureContrast("#000000", "#ffffff")).toBe("#000000");
  });
});

describe("mixing and palettes", () => {
  test("mix endpoints and spaces", () => {
    expect(C.mix("#000000", "#ffffff", 0)).toBe("#000000");
    expect(C.mix("#000000", "#ffffff", 1)).toBe("#ffffff");
    expect(C.mix("#000000", "#ffffff", 0.5, "srgb")).toBe("#808080");
    expect(C.mix("#000000", "#ffffff", 0.5, "linear")).toBe("#bcbcbc");
    expect(C.mix("#00000000", "#000000", 0.5)).toBe("#00000080");
  });

  test("lighten / darken / saturate / rotate in OKLCH", () => {
    const base = "#ffb02e";
    expect(C.toOklch(C.lighten(base, 0.1)).l).toBeGreaterThan(C.toOklch(base).l);
    expect(C.toOklch(C.darken(base, 0.1)).l).toBeLessThan(C.toOklch(base).l);
    expect(C.toOklch(C.grayscale(base)).c).toBeLessThan(0.002);
    expect(C.deltaE(C.rotateHue(base, 360), base)).toBeLessThan(0.005);
    expect(C.deltaE(base, base)).toBe(0);
    expect(C.lighten("#ffb02e80", 0.1).length).toBe(9);
  });

  test("harmonies", () => {
    const h = C.harmonies("#ffb02e");
    expect(Object.keys(h).sort()).toEqual([...C.HARMONY_MODES].sort());
    expect(h.complementary).toHaveLength(2);
    expect(h.triadic).toHaveLength(3);
    expect(h.square).toHaveLength(4);
    expect(h.analogous[0]).toBe("#ffb02e");
    const comp = C.toOklch(h.complementary[1] as string).h;
    expect(Math.abs(((comp - C.toOklch("#ffb02e").h + 360) % 360) - 180)).toBeLessThan(6);
  });

  test("generatePalette", () => {
    for (const mode of [...C.HARMONY_MODES, "shades", "tints", "tones"] as C.PaletteMode[]) {
      for (const n of [1, 3, 5, 8]) {
        const p = C.generatePalette("#ff6a1f", mode, n);
        expect(p).toHaveLength(n);
        expect(p[0]).toBe("#ff6a1f");
        for (const c of p) expect(C.isColor(c)).toBe(true);
        if (n > 1) expect(new Set(p).size).toBeGreaterThan(1);
      }
    }
    expect(() => C.generatePalette("#ff6a1f", "monochrome" as C.PaletteMode)).toThrow(
      /unknown harmony mode "monochrome"/,
    );
  });

  test("tonal scale gets darker", () => {
    const s = C.tonalScale("#ffb02e");
    const keys = Object.keys(s).map(Number);
    expect(keys).toEqual([50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950]);
    for (let i = 1; i < keys.length; i++) {
      expect(C.toOklch(s[keys[i] as number] as string).l).toBeLessThan(
        C.toOklch(s[keys[i - 1] as number] as string).l,
      );
    }
  });

  test("invalid input throws", () => {
    expect(() => C.mix("red", "#000000")).toThrow(/invalid color/);
  });
});
