// Color math for the editor, AI and lint: hex parsing/formatting, sRGB <-> HSL/HSV/OKLab/OKLCH, WCAG contrast,
// perceptual mixing and OKLCH-based palettes. Colors in the document are "#rrggbb" / "#rrggbbaa" lowercase.
import { COLOR_PATTERN } from "./constants";
import type { Color } from "./types";

/** sRGB channels 0..255 (floats allowed), alpha 0..1. */
export interface Rgb {
  r: number;
  g: number;
  b: number;
  a?: number;
}
/** h degrees [0,360), s/l 0..1. */
export interface Hsl {
  h: number;
  s: number;
  l: number;
  a?: number;
}
/** h degrees [0,360), s/v 0..1. */
export interface Hsv {
  h: number;
  s: number;
  v: number;
  a?: number;
}
export interface Oklab {
  l: number;
  a: number;
  b: number;
  alpha?: number;
}
/** l 0..1, c >= 0 (sRGB gamut tops out near 0.37), h degrees [0,360). */
export interface Oklch {
  l: number;
  c: number;
  h: number;
  alpha?: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const normHue = (h: number) => ((h % 360) + 360) % 360;

// Hex ------------------------------------------------------------------------------------------------------------

const HEX_RE = /^#?([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/** Parses #rgb, #rgba, #rrggbb or #rrggbbaa (case-insensitive, "#" optional). Returns null when malformed. */
export function parseHex(input: string): Rgb | null {
  const m = HEX_RE.exec(input.trim());
  if (!m?.[1]) return null;
  let hex = m[1];
  if (hex.length <= 4) hex = [...hex].map((c) => c + c).join("");
  const n = (i: number) => Number.parseInt(hex.slice(i, i + 2), 16);
  const rgb: Rgb = { r: n(0), g: n(2), b: n(4) };
  if (hex.length === 8) rgb.a = n(6) / 255;
  return rgb;
}

const hex2 = (v: number) =>
  Math.round(clamp(v, 0, 255))
    .toString(16)
    .padStart(2, "0");

/** Formats as lowercase "#rrggbb", or "#rrggbbaa" when alpha < 1. */
export function formatHex(rgb: Rgb): Color {
  const base = `#${hex2(rgb.r)}${hex2(rgb.g)}${hex2(rgb.b)}`;
  const a = rgb.a ?? 1;
  return a >= 1 ? base : `${base}${hex2(a * 255)}`;
}

/** Normalizes any accepted hex form to the document format, or null when malformed. */
export function normalizeHex(input: string): Color | null {
  const rgb = parseHex(input);
  return rgb ? formatHex(rgb) : null;
}

/** True for the strict document color format ("#rrggbb" / "#rrggbbaa", lowercase). */
export function isColor(value: unknown): value is Color {
  return typeof value === "string" && COLOR_PATTERN.test(value);
}

function mustParse(color: Color | Rgb): Rgb {
  if (typeof color !== "string") return color;
  const rgb = parseHex(color);
  if (!rgb) throw new Error(`invalid color "${color}"`);
  return rgb;
}

export function alphaOf(color: Color): number {
  return mustParse(color).a ?? 1;
}

export function withAlpha(color: Color, alpha: number): Color {
  return formatHex({ ...mustParse(color), a: clamp(alpha, 0, 1) });
}

// HSL / HSV -----------------------------------------------------------------------------------------------------

export function rgbToHsl({ r, g, b, a }: Rgb): Hsl {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;
  let h = 0;
  let s = 0;
  if (d !== 0) {
    s = d / (1 - Math.abs(2 * l - 1));
    if (max === rn) h = 60 * (((gn - bn) / d) % 6);
    else if (max === gn) h = 60 * ((bn - rn) / d + 2);
    else h = 60 * ((rn - gn) / d + 4);
  }
  const out: Hsl = { h: normHue(h), s: clamp(s, 0, 1), l };
  if (a !== undefined) out.a = a;
  return out;
}

export function hslToRgb({ h, s, l, a }: Hsl): Rgb {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = normHue(h) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const [r1, g1, b1] =
    hp < 1
      ? [c, x, 0]
      : hp < 2
        ? [x, c, 0]
        : hp < 3
          ? [0, c, x]
          : hp < 4
            ? [0, x, c]
            : hp < 5
              ? [x, 0, c]
              : [c, 0, x];
  const m = l - c / 2;
  const out: Rgb = { r: (r1 + m) * 255, g: (g1 + m) * 255, b: (b1 + m) * 255 };
  if (a !== undefined) out.a = a;
  return out;
}

export function rgbToHsv({ r, g, b, a }: Rgb): Hsv {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === rn) h = 60 * (((gn - bn) / d) % 6);
    else if (max === gn) h = 60 * ((bn - rn) / d + 2);
    else h = 60 * ((rn - gn) / d + 4);
  }
  const out: Hsv = { h: normHue(h), s: max === 0 ? 0 : d / max, v: max };
  if (a !== undefined) out.a = a;
  return out;
}

export function hsvToRgb({ h, s, v, a }: Hsv): Rgb {
  const l = v * (1 - s / 2);
  const sl = l === 0 || l === 1 ? 0 : (v - l) / Math.min(l, 1 - l);
  const hsl: Hsl = { h, s: sl, l };
  if (a !== undefined) hsl.a = a;
  return hslToRgb(hsl);
}

// Linear sRGB / OKLab / OKLCH ------------------------------------------------------------------------------------

/** sRGB transfer function: 0..1 gamma-encoded -> linear. */
export function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}
/** Linear -> 0..1 gamma-encoded. */
export function linearToSrgb(c: number): number {
  return c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055;
}

// Matrices from Björn Ottosson, "A perceptual color space for image processing" (2020).
export function rgbToOklab({ r, g, b, a }: Rgb): Oklab {
  const lr = srgbToLinear(r / 255);
  const lg = srgbToLinear(g / 255);
  const lb = srgbToLinear(b / 255);
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  const out: Oklab = {
    l: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  };
  if (a !== undefined) out.alpha = a;
  return out;
}

/** OKLab -> linear sRGB (unclamped; values outside 0..1 are out of gamut). */
function oklabToLinear({ l, a, b }: Oklab): [number, number, number] {
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  ];
}

export function oklabToRgb(lab: Oklab): Rgb {
  const [r, g, b] = oklabToLinear(lab);
  const out: Rgb = {
    r: clamp(linearToSrgb(r), 0, 1) * 255,
    g: clamp(linearToSrgb(g), 0, 1) * 255,
    b: clamp(linearToSrgb(b), 0, 1) * 255,
  };
  if (lab.alpha !== undefined) out.a = lab.alpha;
  return out;
}

export function oklabToOklch({ l, a, b, alpha }: Oklab): Oklch {
  const c = Math.hypot(a, b);
  const out: Oklch = { l, c, h: c < 1e-7 ? 0 : normHue((Math.atan2(b, a) * 180) / Math.PI) };
  if (alpha !== undefined) out.alpha = alpha;
  return out;
}

export function oklchToOklab({ l, c, h, alpha }: Oklch): Oklab {
  const rad = (h * Math.PI) / 180;
  const out: Oklab = { l, a: c * Math.cos(rad), b: c * Math.sin(rad) };
  if (alpha !== undefined) out.alpha = alpha;
  return out;
}

export function rgbToOklch(rgb: Rgb): Oklch {
  return oklabToOklch(rgbToOklab(rgb));
}

const EPS = 1e-6;
function inGamut(lch: Oklch): boolean {
  return oklabToLinear(oklchToOklab(lch)).every((v) => v >= -EPS && v <= 1 + EPS);
}

/** Converts OKLCH to sRGB, reducing chroma (keeping lightness and hue) until the color fits the sRGB gamut. */
export function oklchToRgb(lch: Oklch): Rgb {
  const l = clamp(lch.l, 0, 1);
  let c = Math.max(0, lch.c);
  if (!inGamut({ l, c, h: lch.h })) {
    let lo = 0;
    let hi = c;
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (inGamut({ l, c: mid, h: lch.h })) lo = mid;
      else hi = mid;
    }
    c = lo;
  }
  const lab = oklchToOklab({ l, c, h: lch.h });
  if (lch.alpha !== undefined) lab.alpha = lch.alpha;
  return oklabToRgb(lab);
}

export const toOklch = (color: Color): Oklch => rgbToOklch(mustParse(color));
export const fromOklch = (lch: Oklch): Color => formatHex(oklchToRgb(lch));
export const toHsl = (color: Color): Hsl => rgbToHsl(mustParse(color));
export const fromHsl = (hsl: Hsl): Color => formatHex(hslToRgb(hsl));
export const toHsv = (color: Color): Hsv => rgbToHsv(mustParse(color));
export const fromHsv = (hsv: Hsv): Color => formatHex(hsvToRgb(hsv));

// Contrast (WCAG 2.x) ---------------------------------------------------------------------------------------------

/** Composites a translucent color over an opaque backdrop (alpha blending in gamma space, as browsers do). */
export function compositeOver(fg: Color | Rgb, bg: Color | Rgb): Rgb {
  const f = mustParse(fg);
  const b = mustParse(bg);
  const a = f.a ?? 1;
  return {
    r: f.r * a + b.r * (1 - a),
    g: f.g * a + b.g * (1 - a),
    b: f.b * a + b.b * (1 - a),
  };
}

/** WCAG relative luminance 0..1 (alpha ignored). */
export function relativeLuminance(color: Color | Rgb): number {
  const { r, g, b } = mustParse(color);
  return (
    0.2126 * srgbToLinear(r / 255) + 0.7152 * srgbToLinear(g / 255) + 0.0722 * srgbToLinear(b / 255)
  );
}

/** WCAG contrast ratio 1..21. A translucent foreground is composited over the background first. */
export function contrastRatio(fg: Color, bg: Color): number {
  const back = mustParse(bg);
  const front = (mustParse(fg).a ?? 1) < 1 ? compositeOver(fg, { ...back, a: 1 }) : mustParse(fg);
  const l1 = relativeLuminance(front);
  const l2 = relativeLuminance(back);
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

export type WcagLevel = "AAA" | "AA" | "fail";

/**
 * WCAG 2.x level for text. Large text (>= 24 px regular or >= 18.66 px bold) needs 3:1 for AA and 4.5:1 for AAA;
 * normal text needs 4.5:1 and 7:1.
 */
export function wcagLevel(ratio: number, largeText = false): WcagLevel {
  const [aa, aaa] = largeText ? [3, 4.5] : [4.5, 7];
  if (ratio >= aaa) return "AAA";
  if (ratio >= aa) return "AA";
  return "fail";
}

/** WCAG "large text" test for a font size in px and weight. */
export function isLargeText(fontSizePx: number, fontWeight = 400): boolean {
  return fontSizePx >= 24 || (fontWeight >= 700 && fontSizePx >= 18.66);
}

/** Black or white, whichever reads better on `bg`. */
export function readableTextColor(bg: Color): Color {
  return contrastRatio("#000000", bg) >= contrastRatio("#ffffff", bg) ? "#000000" : "#ffffff";
}

/**
 * Adjusts the OKLCH lightness of `fg` (keeping hue and chroma) until it reaches `target` contrast against `bg`.
 * Returns the closest color to the original that passes, or black/white when no shade of the hue does.
 */
export function ensureContrast(fg: Color, bg: Color, target = 4.5): Color {
  if (contrastRatio(fg, bg) >= target) return fg;
  const lch = toOklch(fg);
  const search = (towardLight: boolean): Color | null => {
    const end = towardLight ? 1 : 0;
    const endColor = fromOklch({ ...lch, l: end });
    if (contrastRatio(endColor, bg) < target) return null;
    let lo = lch.l;
    let hi = end;
    for (let i = 0; i < 30; i++) {
      const mid = (lo + hi) / 2;
      if (contrastRatio(fromOklch({ ...lch, l: mid }), bg) >= target) hi = mid;
      else lo = mid;
    }
    return fromOklch({ ...lch, l: hi });
  };
  const lighter = search(true);
  const darker = search(false);
  const candidates = [lighter, darker].filter((c): c is Color => c !== null);
  if (candidates.length === 0) return readableTextColor(bg);
  const dist = (c: Color) => Math.abs(toOklch(c).l - lch.l);
  return candidates.reduce((best, c) => (dist(c) < dist(best) ? c : best));
}

// Mixing & adjustments -------------------------------------------------------------------------------------------

export type MixSpace = "oklab" | "srgb" | "linear";

/** Interpolates from `a` (t=0) to `b` (t=1). OKLab by default for perceptually even blends. */
export function mix(a: Color, b: Color, t = 0.5, space: MixSpace = "oklab"): Color {
  const ra = mustParse(a);
  const rb = mustParse(b);
  const alpha = (ra.a ?? 1) + ((rb.a ?? 1) - (ra.a ?? 1)) * t;
  const lerp = (x: number, y: number) => x + (y - x) * t;
  let out: Rgb;
  if (space === "srgb") {
    out = { r: lerp(ra.r, rb.r), g: lerp(ra.g, rb.g), b: lerp(ra.b, rb.b) };
  } else if (space === "linear") {
    const ch = (x: number, y: number) =>
      linearToSrgb(lerp(srgbToLinear(x / 255), srgbToLinear(y / 255))) * 255;
    out = { r: ch(ra.r, rb.r), g: ch(ra.g, rb.g), b: ch(ra.b, rb.b) };
  } else {
    const la = rgbToOklab(ra);
    const lb = rgbToOklab(rb);
    out = oklabToRgb({ l: lerp(la.l, lb.l), a: lerp(la.a, lb.a), b: lerp(la.b, lb.b) });
  }
  out.a = alpha;
  return formatHex(out);
}

/** Raises OKLCH lightness by `amount` (0..1 absolute). */
export function lighten(color: Color, amount = 0.1): Color {
  const lch = toOklch(color);
  return fromOklch({ ...lch, l: clamp(lch.l + amount, 0, 1), alpha: mustParse(color).a ?? 1 });
}

/** Lowers OKLCH lightness by `amount` (0..1 absolute). */
export function darken(color: Color, amount = 0.1): Color {
  return lighten(color, -amount);
}

/** Scales OKLCH chroma by `factor` (0 = gray, >1 = more vivid, gamut-mapped). */
export function saturate(color: Color, factor = 1.2): Color {
  const lch = toOklch(color);
  return fromOklch({ ...lch, c: lch.c * factor, alpha: mustParse(color).a ?? 1 });
}

/** Rotates the OKLCH hue by `degrees`. */
export function rotateHue(color: Color, degrees: number): Color {
  const lch = toOklch(color);
  return fromOklch({ ...lch, h: normHue(lch.h + degrees), alpha: mustParse(color).a ?? 1 });
}

export function grayscale(color: Color): Color {
  return saturate(color, 0);
}

/** Perceptual distance (Euclidean ΔE in OKLab; ~0.02 is a just-noticeable difference). */
export function deltaE(a: Color, b: Color): number {
  const la = rgbToOklab(mustParse(a));
  const lb = rgbToOklab(mustParse(b));
  return Math.hypot(la.l - lb.l, la.a - lb.a, la.b - lb.b);
}

// Palettes -------------------------------------------------------------------------------------------------------

export type HarmonyMode =
  | "monochromatic"
  | "analogous"
  | "complementary"
  | "split-complementary"
  | "triadic"
  | "tetradic"
  | "square";

export type PaletteMode = HarmonyMode | "shades" | "tints" | "tones";

export const HARMONY_MODES: readonly HarmonyMode[] = [
  "monochromatic",
  "analogous",
  "complementary",
  "split-complementary",
  "triadic",
  "tetradic",
  "square",
];

const HARMONY_OFFSETS: Record<Exclude<HarmonyMode, "monochromatic">, number[]> = {
  analogous: [0, -30, 30, -60, 60],
  complementary: [0, 180],
  "split-complementary": [0, 150, 210],
  triadic: [0, 120, 240],
  tetradic: [0, 60, 180, 240],
  square: [0, 90, 180, 270],
};

/** Hue-rotated companions of `seed` for a harmony (OKLCH hue, same lightness and chroma). */
export function harmony(seed: Color, mode: HarmonyMode): Color[] {
  if (mode !== "monochromatic" && !Object.hasOwn(HARMONY_OFFSETS, mode)) {
    throw new Error(`unknown harmony mode "${String(mode)}"`);
  }
  const lch = toOklch(seed);
  if (mode === "monochromatic") {
    return [0, -0.24, -0.12, 0.12, 0.24].map((d, i) =>
      i === 0 ? formatHex(mustParse(seed)) : fromOklch({ ...lch, l: clamp(lch.l + d, 0.08, 0.97) }),
    );
  }
  return HARMONY_OFFSETS[mode].map((off, i) =>
    i === 0 ? formatHex(mustParse(seed)) : fromOklch({ ...lch, h: normHue(lch.h + off) }),
  );
}

/** All harmonies of a seed color. */
export function harmonies(seed: Color): Record<HarmonyMode, Color[]> {
  return Object.fromEntries(HARMONY_MODES.map((m) => [m, harmony(seed, m)])) as Record<
    HarmonyMode,
    Color[]
  >;
}

/**
 * A palette of `count` colors derived from `seed`. Harmony modes fill missing slots with lightness variations of
 * the harmony hues; "shades"/"tints"/"tones" step toward black, white or gray in OKLab. The seed is always first.
 */
export function generatePalette(seed: Color, mode: PaletteMode = "analogous", count = 5): Color[] {
  const n = Math.max(1, Math.floor(count));
  const base = formatHex({ ...mustParse(seed), a: 1 });
  if (mode === "shades" || mode === "tints" || mode === "tones") {
    const target = mode === "shades" ? "#000000" : mode === "tints" ? "#ffffff" : "#808080";
    return Array.from({ length: n }, (_, i) => (i === 0 ? base : mix(base, target, (i / n) * 0.9)));
  }
  const hues = harmony(base, mode);
  const out: Color[] = [];
  const steps = [0, 0.18, -0.18, 0.32, -0.32];
  for (let round = 0; out.length < n; round++) {
    const dl = steps[round % steps.length] ?? 0;
    for (const hue of hues) {
      if (out.length >= n) break;
      const lch = toOklch(hue);
      const c = round === 0 ? hue : fromOklch({ ...lch, l: clamp(lch.l + dl, 0.1, 0.96) });
      if (!out.includes(c)) out.push(c);
    }
    if (round > 20) break;
  }
  while (out.length < n) out.push(mix(base, "#ffffff", out.length / (n + 1)));
  return out;
}

/** A 50..950 tonal scale (Tailwind-style keys) built in OKLCH around the seed's hue and chroma. */
export function tonalScale(seed: Color): Record<number, Color> {
  const lch = toOklch(seed);
  const stops: [number, number][] = [
    [50, 0.97],
    [100, 0.93],
    [200, 0.87],
    [300, 0.8],
    [400, 0.72],
    [500, 0.64],
    [600, 0.55],
    [700, 0.47],
    [800, 0.39],
    [900, 0.31],
    [950, 0.23],
  ];
  const out: Record<number, Color> = {};
  for (const [key, l] of stops) {
    // Taper chroma toward the extremes where sRGB cannot hold it.
    const taper = 1 - Math.abs(l - 0.6) * 0.9;
    out[key] = fromOklch({ l, c: lch.c * Math.max(0.15, taper), h: lch.h });
  }
  return out;
}
