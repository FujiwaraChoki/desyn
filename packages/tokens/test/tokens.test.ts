import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildThemeCss,
  buildVariablesCss,
  colors,
  contrastRatio,
  foregroundAlpha,
  hexToRgb,
  mixOver,
  palettes,
  relativeLuminance,
  rgbTriplet,
  THEMES,
} from "../src/index.ts";
import { dialogIn, fadeUp, slideIn, springPanel } from "../src/motion.ts";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

describe("color helpers", () => {
  it("parses short, long and alpha hex", () => {
    expect(hexToRgb("#fff")).toEqual({ r: 255, g: 255, b: 255 });
    expect(hexToRgb("#FFB02E")).toEqual({ r: 255, g: 176, b: 46 });
    expect(hexToRgb("ffb02e80")).toEqual({ r: 255, g: 176, b: 46 });
    expect(() => hexToRgb("#ggg")).toThrow(/Invalid hex/);
  });

  it("formats rgb triplets", () => {
    expect(rgbTriplet("#D27400")).toBe("210 116 0");
  });

  it("computes WCAG luminance and contrast", () => {
    expect(relativeLuminance("#000000")).toBe(0);
    expect(relativeLuminance("#ffffff")).toBe(1);
    expect(contrastRatio("#000", "#fff")).toBeCloseTo(21, 5);
    expect(contrastRatio("#777", "#777")).toBe(1);
  });

  it("composites alpha over a background", () => {
    expect(mixOver("#ffffff", 0.5, "#000000")).toBe("#808080");
  });
});

describe("palettes", () => {
  it("exposes rgb triplets for every color", () => {
    expect(colors.dark.accent).toEqual({ hex: "#FFB02E", rgb: "255 176 46" });
    expect(colors.light.accent).toEqual({ hex: "#C27C00", rgb: "194 124 0" });
    for (const theme of THEMES) {
      expect(Object.keys(colors[theme])).toEqual(Object.keys(palettes.dark));
    }
  });

  for (const theme of THEMES) {
    const p = palettes[theme];
    const surfaces = [p.background, p["surface-1"], p["surface-2"]];

    it(`${theme}: body text meets AA on every surface`, () => {
      for (const s of surfaces) expect(contrastRatio(p.foreground, s)).toBeGreaterThanOrEqual(7);
      for (const s of surfaces) {
        const secondary = mixOver(p.foreground, foregroundAlpha.secondary, s);
        const muted = mixOver(p.foreground, foregroundAlpha.muted, s);
        expect(contrastRatio(secondary, s)).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(muted, s)).toBeGreaterThanOrEqual(4.5);
      }
    });

    it(`${theme}: accent text, status colors and inks meet AA`, () => {
      for (const s of surfaces) {
        expect(contrastRatio(p["accent-text"], s)).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(p.danger, s)).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(p.success, s)).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(p.info, s)).toBeGreaterThanOrEqual(4.5);
      }
      // The accent itself is for large text and icons on the page and panels (WCAG 3:1).
      for (const s of [p.background, p["surface-1"]]) {
        expect(contrastRatio(p.accent, s)).toBeGreaterThanOrEqual(3);
      }
      expect(contrastRatio(p["accent-ink"], p["accent-solid"])).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(p["danger-ink"], p.danger)).toBeGreaterThanOrEqual(4.5);
    });
  }

  it("keeps the sun brighter on dark and darker on light", () => {
    expect(relativeLuminance(palettes.dark.accent)).toBeGreaterThan(
      relativeLuminance(palettes.light.accent),
    );
  });
});

describe("generated CSS", () => {
  it("variables.css is up to date (run `pnpm generate`)", () => {
    expect(read("../src/variables.css")).toBe(buildVariablesCss());
  });

  it("theme.css is up to date (run `pnpm generate`)", () => {
    expect(read("../src/theme.css")).toBe(buildThemeCss());
  });

  it("declares dark on :root, light on [data-theme=light], and system via media query", () => {
    const css = buildVariablesCss();
    expect(css).toMatch(
      /:root,\n\[data-theme="dark"\],\n\[data-theme="system"\] \{\n {2}color-scheme: dark;/,
    );
    expect(css).toMatch(/\[data-theme="light"\] \{\n {2}color-scheme: light;/);
    expect(css).toMatch(
      /@media \(prefers-color-scheme: light\) \{\n {2}\[data-theme="system"\] \{\n {4}color-scheme: light;/,
    );
    expect(css).toContain("--accent-rgb: 255 176 46;");
    expect(css).toContain("--accent-rgb: 194 124 0;");
  });

  it("re-derives alpha tokens on every theme scope", () => {
    expect(buildVariablesCss()).toMatch(
      /:root,\n\[data-theme\] \{[^}]*--line: rgb\(var\(--foreground-rgb\) \/ 0\.2\);/,
    );
  });

  it("tokens.css maps every palette color into the Tailwind theme", () => {
    const tokens = read("../src/tokens.css");
    for (const key of Object.keys(palettes.dark)) {
      expect(tokens).toContain(`--color-${key}: var(--${key});`);
    }
  });

  it("fonts.css references font files that exist", () => {
    const css = read("../src/fonts.css");
    const urls = [...css.matchAll(/url\("([^"]+)"\)/g)].map((m) => m[1] ?? "");
    expect(urls.length).toBe(4);
    for (const url of urls) {
      expect(() =>
        readFileSync(fileURLToPath(new URL(`../src/${url}`, import.meta.url))),
      ).not.toThrow();
    }
  });
});

describe("motion presets", () => {
  it("uses the panel spring from the design system", () => {
    expect(springPanel).toMatchObject({ type: "spring", stiffness: 300, damping: 30 });
    expect(dialogIn.visible).toMatchObject({ opacity: 1, scale: 1 });
  });

  it("fades up 20px", () => {
    expect(fadeUp.hidden).toEqual({ opacity: 0, y: 20 });
  });

  it("slides sheets from the requested edge", () => {
    expect(slideIn("left").hidden).toEqual({ x: "-100%" });
    expect(slideIn("bottom").hidden).toEqual({ y: "100%" });
  });
});
