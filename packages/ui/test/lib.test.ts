import { describe, expect, it } from "vitest";
import { compareSortValues } from "../src/components/data-table.tsx";
import { fontStack } from "../src/components/font-picker.tsx";
import { paginationRange } from "../src/components/navigation.tsx";
import { largestGapMidpoint } from "../src/components/paint-picker.tsx";
import {
  cssColor,
  formatColor,
  hslToRgb,
  hsvToRgb,
  isOklchInGamut,
  oklchToRgb,
  parseColor,
  rgbToHsl,
  rgbToHsv,
  rgbToOklch,
  sameColor,
  toHex,
} from "../src/lib/color.ts";
import { constrain, evaluateExpression, roundTo } from "../src/lib/expression.ts";
import {
  colorAt,
  convertPaint,
  normalizeAngle,
  type Paint,
  paintToCss,
  sortStops,
} from "../src/lib/gradient.ts";
import {
  formatShortcut,
  matchesShortcut,
  parseShortcut,
  shortcutKeys,
} from "../src/lib/platform.ts";

describe("color conversions", () => {
  const samples = [
    "#000000",
    "#ffffff",
    "#ffb02e",
    "#d27400",
    "#1d5fbf",
    "#4ade80",
    "#7f7f7f",
    "#ff0000",
  ];

  it("round-trips hex through HSV and HSL", () => {
    for (const hex of samples) {
      const rgb = parseColor(hex);
      expect(rgb).not.toBeNull();
      if (!rgb) continue;
      expect(toHex(hsvToRgb(rgbToHsv(rgb)))).toBe(hex);
      expect(toHex(hslToRgb(rgbToHsl(rgb)))).toBe(hex);
    }
  });

  it("round-trips hex through OKLCH", () => {
    for (const hex of samples) {
      const rgb = parseColor(hex);
      if (!rgb) throw new Error(hex);
      expect(toHex(oklchToRgb(rgbToOklch(rgb)))).toBe(hex);
    }
  });

  it("matches reference OKLCH values", () => {
    const red = rgbToOklch({ r: 255, g: 0, b: 0, a: 1 });
    expect(red.l).toBeCloseTo(0.628, 3);
    expect(red.c).toBeCloseTo(0.2577, 3);
    expect(red.h).toBeCloseTo(29.23, 1);
    const white = rgbToOklch({ r: 255, g: 255, b: 255, a: 1 });
    expect(white.l).toBeCloseTo(1, 4);
    expect(white.c).toBe(0);
  });

  it("gamut-maps out-of-range OKLCH by reducing chroma", () => {
    const wild = { l: 0.7, c: 0.4, h: 150, a: 1 };
    expect(isOklchInGamut(wild)).toBe(false);
    const rgb = oklchToRgb(wild);
    for (const ch of [rgb.r, rgb.g, rgb.b]) {
      expect(ch).toBeGreaterThanOrEqual(0);
      expect(ch).toBeLessThanOrEqual(255);
    }
    // Lightness is preserved closely.
    expect(rgbToOklch(rgb).l).toBeCloseTo(0.7, 1);
  });

  it("parses every supported syntax", () => {
    expect(toHex(parseColor("#FB2") ?? { r: 0, g: 0, b: 0, a: 1 })).toBe("#ffbb22");
    expect(parseColor("#ffb02e80")?.a).toBeCloseTo(0.502, 2);
    expect(toHex(parseColor("rgb(255, 176, 46)") ?? { r: 0, g: 0, b: 0, a: 1 })).toBe("#ffb02e");
    expect(parseColor("rgba(255 176 46 / 50%)")).toEqual({ r: 255, g: 176, b: 46, a: 0.5 });
    expect(toHex(parseColor("hsl(37.3 100% 59%)") ?? { r: 0, g: 0, b: 0, a: 1 })).toBe("#ffb02e");
    expect(toHex(parseColor("hsl(120, 100, 25)") ?? { r: 0, g: 0, b: 0, a: 1 })).toBe("#008000");
    expect(toHex(parseColor("hsl(0.5turn, 100%, 50%)") ?? { r: 0, g: 0, b: 0, a: 1 })).toBe(
      "#00ffff",
    );
    expect(toHex(parseColor("oklch(62.8% 0.2577 29.23)") ?? { r: 0, g: 0, b: 0, a: 1 })).toBe(
      "#ff0000",
    );
    expect(parseColor("not a color")).toBeNull();
    expect(parseColor("rgb(1,2)")).toBeNull();
    expect(parseColor("")).toBeNull();
  });

  it("formats in every format", () => {
    const c = { r: 255, g: 176, b: 46, a: 0.5 };
    expect(formatColor(c, "hex")).toBe("#ffb02e80");
    expect(formatColor(c, "rgb")).toBe("rgb(255 176 46 / 50%)");
    expect(formatColor({ ...c, a: 1 }, "hsl")).toBe("hsl(37 100% 59%)");
    expect(formatColor({ ...c, a: 1 }, "oklch")).toMatch(
      /^oklch\(\d+(\.\d)?% 0\.\d+ \d+(\.\d)?\)$/,
    );
  });

  it("emits canonical lowercase document colors", () => {
    expect(toHex({ r: 255, g: 176, b: 46, a: 1 })).toBe("#ffb02e");
    expect(toHex({ r: 255, g: 176, b: 46, a: 0 })).toBe("#ffb02e00");
    expect(toHex({ r: 300, g: -4, b: 46.6, a: 1 })).toBe("#ff002f");
    expect(sameColor("#FFF", "#ffffff")).toBe(true);
  });
});

describe("gradients", () => {
  const stops = [
    { pos: 1, color: "#ffffff" },
    { pos: 0, color: "#000000" },
  ];

  it("sorts stops and interpolates colors", () => {
    expect(sortStops(stops).map((s) => s.pos)).toEqual([0, 1]);
    expect(colorAt(stops, 0.5)).toBe("#808080");
    expect(colorAt(stops, -1)).toBe("#000000");
    expect(colorAt(stops, 2)).toBe("#ffffff");
  });

  it("renders CSS for each paint type", () => {
    expect(paintToCss({ type: "solid", color: "#ffb02e" })).toBe("#ffb02e");
    expect(paintToCss({ type: "linear", angle: 90, stops })).toBe(
      "linear-gradient(90deg, #000000 0%, #ffffff 100%)",
    );
    expect(paintToCss({ type: "radial", cx: 0.5, cy: 0.5, rx: 0.5, ry: 0.5, stops })).toBe(
      "radial-gradient(50% 50% at 50% 50%, #000000 0%, #ffffff 100%)",
    );
    expect(paintToCss({ type: "conic", cx: 0.5, cy: 0.5, angle: 45, stops })).toBe(
      "conic-gradient(from 45deg at 50% 50%, #000000 0%, #ffffff 100%)",
    );
  });

  it("never lets untrusted paint values inject CSS", () => {
    expect(cssColor("#FFB02E")).toBe("#ffb02e");
    expect(cssColor("url(https://evil.example/x.png)")).toBe("transparent");
    expect(cssColor("red; background-image: url(x)")).toBe("transparent");
    expect(paintToCss({ type: "solid", color: "var(--x), url(https://evil.example)" })).toBe(
      "transparent",
    );
    const hostile: Paint = {
      type: "linear",
      angle: "0deg, url(https://evil.example)" as unknown as number,
      stops: [
        { pos: Number.NaN, color: "url(https://evil.example)" },
        { pos: 1, color: "#000" },
      ],
    };
    const css = paintToCss(hostile);
    expect(css).not.toContain("url(");
    expect(css).toBe("linear-gradient(0deg, transparent 0%, #000000 100%)");
    // A single stop still yields valid CSS.
    expect(paintToCss({ type: "linear", angle: 90, stops: [{ pos: 0.5, color: "#fff" }] })).toBe(
      "linear-gradient(90deg, #ffffff 50%, #ffffff 50%)",
    );
  });

  it("converts between paint types keeping the user's colors", () => {
    const linear = convertPaint({ type: "solid", color: "#ffb02e" }, "linear");
    expect(linear).toEqual({
      type: "linear",
      angle: 90,
      stops: [
        { pos: 0, color: "#ffb02e" },
        { pos: 1, color: "#ffb02e00" },
      ],
    });
    expect(convertPaint(linear, "solid")).toEqual({ type: "solid", color: "#ffb02e" });
    const radial = convertPaint(linear, "radial");
    expect(radial.type === "radial" && radial.stops).toEqual(
      linear.type === "linear" && linear.stops,
    );
  });

  it("finds the widest gap for new stops and normalizes angles", () => {
    expect(
      largestGapMidpoint([
        { pos: 0, color: "#000" },
        { pos: 0.2, color: "#000" },
        { pos: 1, color: "#000" },
      ]),
    ).toBe(0.6);
    expect(normalizeAngle(-90)).toBe(270);
    expect(normalizeAngle(725)).toBe(5);
  });
});

describe("expressions", () => {
  it("evaluates arithmetic with precedence", () => {
    expect(evaluateExpression("100/2")).toBe(50);
    expect(evaluateExpression("2 + 3 * 4")).toBe(14);
    expect(evaluateExpression("(2 + 3) * 4")).toBe(20);
    expect(evaluateExpression("2^3^2")).toBe(512);
    expect(evaluateExpression("-3 + 10")).toBe(7);
    expect(evaluateExpression("10 % 4")).toBe(2);
    expect(evaluateExpression("1,5 * 2")).toBe(3);
    expect(evaluateExpression("12 × 2 ÷ 3")).toBe(8);
  });

  it("accepts units after numbers", () => {
    expect(evaluateExpression("12px * 2", ["px"])).toBe(24);
    expect(evaluateExpression("50%", ["%"])).toBe(50);
    expect(evaluateExpression("45° + 45°", ["°"])).toBe(90);
  });

  it("rejects malformed input and division by zero", () => {
    expect(evaluateExpression("")).toBeNull();
    expect(evaluateExpression("2 +")).toBeNull();
    expect(evaluateExpression("(2")).toBeNull();
    expect(evaluateExpression("1/0")).toBeNull();
    expect(evaluateExpression("alert(1)")).toBeNull();
    expect(evaluateExpression("12px", [])).toBeNull();
  });

  it("clamps, snaps and rounds", () => {
    expect(constrain(150, { min: 0, max: 100 })).toBe(100);
    expect(constrain(7, { min: 0, step: 5 })).toBe(5);
    expect(constrain(0.1 + 0.2, {})).toBe(0.3);
    expect(roundTo(1.005, 2)).toBe(1.01);
  });
});

describe("shortcuts", () => {
  it("formats per platform", () => {
    expect(formatShortcut("mod+shift+k", "mac")).toBe("⇧⌘K");
    expect(formatShortcut("mod+shift+k", "windows")).toBe("Ctrl+Shift+K");
    expect(formatShortcut("alt+enter", "linux")).toBe("Alt+Enter");
    expect(shortcutKeys("ctrl+alt+delete", "mac")).toEqual(["⌃", "⌥", "⌦"]);
    expect(formatShortcut("f2", "windows")).toBe("F2");
  });

  it("parses aliases", () => {
    expect(parseShortcut("cmd+opt+up")).toMatchObject({ meta: true, alt: true, key: "arrowup" });
    expect(parseShortcut("mod+plus")).toMatchObject({ mod: true, key: "+" });
  });

  it("matches keyboard events with mod resolved per platform", () => {
    const ev = (init: Partial<KeyboardEvent>) =>
      ({
        key: "k",
        code: "KeyK",
        metaKey: false,
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        ...init,
      }) as KeyboardEvent;
    expect(matchesShortcut(ev({ metaKey: true }), "mod+k", "mac")).toBe(true);
    expect(matchesShortcut(ev({ ctrlKey: true }), "mod+k", "mac")).toBe(false);
    expect(matchesShortcut(ev({ ctrlKey: true }), "mod+k", "windows")).toBe(true);
    expect(matchesShortcut(ev({ ctrlKey: true, shiftKey: true }), "mod+k", "linux")).toBe(false);
    // Option changes event.key on macOS; the physical key still matches.
    expect(matchesShortcut(ev({ key: "˚", altKey: true }), "alt+k", "mac")).toBe(true);
    // Non-Latin layouts fall back to the physical key...
    expect(matchesShortcut(ev({ key: "л", ctrlKey: true }), "mod+k", "linux")).toBe(true);
    expect(matchesShortcut(ev({ key: "Dead", code: "KeyE", altKey: true }), "alt+e", "mac")).toBe(
      true,
    );
    // ...but on Latin layouts (Dvorak: T sits on the QWERTY K key) the typed key wins.
    expect(matchesShortcut(ev({ key: "t", metaKey: true }), "mod+k", "mac")).toBe(false);
    expect(matchesShortcut(ev({ key: "t", metaKey: true }), "mod+t", "mac")).toBe(true);
    // Shift is implied for symbols.
    expect(matchesShortcut(ev({ key: "?", code: "Slash", shiftKey: true }), "?", "linux")).toBe(
      true,
    );
  });
});

describe("fontStack", () => {
  it("quotes family names safely", () => {
    expect(fontStack({ family: "Instrument Serif", category: "serif" })).toBe(
      '"Instrument Serif", ui-serif, Georgia, serif',
    );
    // A trailing backslash must not escape the closing quote; quotes and control chars are neutralized.
    expect(fontStack({ family: 'Evil\\", url(x)\n' })).toBe(
      '"Evil\\\\\\", url(x)", ui-sans-serif, system-ui, sans-serif',
    );
  });
});

describe("pagination and sorting helpers", () => {
  it("computes compact page ranges", () => {
    expect(paginationRange(1, 5)).toEqual([1, 2, 3, 4, 5]);
    expect(paginationRange(1, 20)).toEqual([1, 2, 3, 4, 5, "ellipsis", 20]);
    expect(paginationRange(10, 20)).toEqual([1, "ellipsis", 9, 10, 11, "ellipsis", 20]);
    expect(paginationRange(20, 20)).toEqual([1, "ellipsis", 16, 17, 18, 19, 20]);
    expect(paginationRange(1, 0)).toEqual([]);
  });

  it("sorts naturally with empty values last", () => {
    expect(["file10", "file2", "file1"].sort(compareSortValues)).toEqual([
      "file1",
      "file2",
      "file10",
    ]);
    expect([3, null, 1].sort(compareSortValues)).toEqual([1, 3, null]);
    expect(compareSortValues(new Date(2), new Date(1))).toBeGreaterThan(0);
  });
});
