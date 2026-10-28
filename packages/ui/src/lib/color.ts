/**
 * Color math for the color picker. Everything converts through sRGB (0-255 channels, alpha 0-1).
 * The document model stores colors as lowercase `#rrggbb` / `#rrggbbaa`, so `toHex` is the canonical
 * output; the other formats exist for editing.
 */

/** sRGB with 0-255 channels and 0-1 alpha. */
export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}
/** Hue 0-360, saturation/value 0-1, alpha 0-1. The picker's internal model. */
export interface Hsva {
  h: number;
  s: number;
  v: number;
  a: number;
}
/** Hue 0-360, saturation/lightness 0-1, alpha 0-1. */
export interface Hsla {
  h: number;
  s: number;
  l: number;
  a: number;
}
/** OKLCH: lightness 0-1, chroma 0-~0.4, hue 0-360, alpha 0-1. */
export interface Oklcha {
  l: number;
  c: number;
  h: number;
  a: number;
}

export type ColorFormat = "hex" | "rgb" | "hsl" | "oklch";

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));
const round = (n: number, digits = 0) => {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
};
const normHue = (h: number) => ((h % 360) + 360) % 360;

/** Clamps channels into range and rounds rgb to integers. */
export function normalizeRgba(c: Rgba): Rgba {
  return {
    r: Math.round(clamp(c.r, 0, 255)),
    g: Math.round(clamp(c.g, 0, 255)),
    b: Math.round(clamp(c.b, 0, 255)),
    a: round(clamp(c.a, 0, 1), 4),
  };
}

// ---------------------------------------------------------------------------------------------
// HSV / HSL
// ---------------------------------------------------------------------------------------------

export function rgbToHsv({ r, g, b, a }: Rgba): Hsva {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === rn) h = ((gn - bn) / d) % 6;
    else if (max === gn) h = (bn - rn) / d + 2;
    else h = (rn - gn) / d + 4;
    h *= 60;
  }
  return { h: normHue(h), s: max === 0 ? 0 : d / max, v: max, a };
}

export function hsvToRgb({ h, s, v, a }: Hsva): Rgba {
  const hh = normHue(h) / 60;
  const c = v * s;
  const x = c * (1 - Math.abs((hh % 2) - 1));
  const m = v - c;
  const [r1, g1, b1] =
    hh < 1
      ? [c, x, 0]
      : hh < 2
        ? [x, c, 0]
        : hh < 3
          ? [0, c, x]
          : hh < 4
            ? [0, x, c]
            : hh < 5
              ? [x, 0, c]
              : [c, 0, x];
  return normalizeRgba({ r: (r1 + m) * 255, g: (g1 + m) * 255, b: (b1 + m) * 255, a });
}

export function rgbToHsl({ r, g, b, a }: Rgba): Hsla {
  const { h, s: sv, v } = rgbToHsv({ r, g, b, a });
  const l = v * (1 - sv / 2);
  const s = l === 0 || l === 1 ? 0 : (v - l) / Math.min(l, 1 - l);
  return { h, s, l, a };
}

export function hslToRgb({ h, s, l, a }: Hsla): Rgba {
  const v = l + s * Math.min(l, 1 - l);
  const sv = v === 0 ? 0 : 2 * (1 - l / v);
  return hsvToRgb({ h, s: sv, v, a });
}

// ---------------------------------------------------------------------------------------------
// OKLab / OKLCH (Björn Ottosson's reference matrices)
// ---------------------------------------------------------------------------------------------

const toLinear = (c: number) => {
  const n = c / 255;
  return n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4;
};
const fromLinear = (c: number) => {
  const n = c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
  return n * 255;
};

export function rgbToOklch({ r, g, b, a }: Rgba): Oklcha {
  const lr = toLinear(r);
  const lg = toLinear(g);
  const lb = toLinear(b);
  const l_ = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m_ = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s_ = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  const L = 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_;
  const A = 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_;
  const B = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_;
  const c = Math.sqrt(A * A + B * B);
  // Achromatic colors have no meaningful hue; report 0 so round-trips stay stable.
  const h = c < 1e-4 ? 0 : normHue((Math.atan2(B, A) * 180) / Math.PI);
  return { l: L, c: c < 1e-4 ? 0 : c, h, a };
}

function oklchToLinear({ l, c, h }: Oklcha): [number, number, number] {
  const hr = (h * Math.PI) / 180;
  const A = c * Math.cos(hr);
  const B = c * Math.sin(hr);
  const l_ = (l + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m_ = (l - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s_ = (l - 0.0894841775 * A - 1.291485548 * B) ** 3;
  return [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  ];
}

const inGamut = (rgb: [number, number, number]) => rgb.every((v) => v >= -1e-4 && v <= 1 + 1e-4);

/** Whether an OKLCH color is representable in sRGB without clipping. */
export function isOklchInGamut(color: Oklcha): boolean {
  return inGamut(oklchToLinear(color));
}

/**
 * Converts OKLCH to sRGB. Out-of-gamut colors are brought in by reducing chroma (binary search),
 * which preserves lightness and hue the way CSS Color 4 gamut mapping intends.
 */
export function oklchToRgb(color: Oklcha): Rgba {
  let target = { ...color, l: clamp(color.l, 0, 1), c: Math.max(0, color.c) };
  if (!isOklchInGamut(target)) {
    let lo = 0;
    let hi = target.c;
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (isOklchInGamut({ ...target, c: mid })) lo = mid;
      else hi = mid;
    }
    target = { ...target, c: lo };
  }
  const [r, g, b] = oklchToLinear(target);
  return normalizeRgba({
    r: fromLinear(clamp(r, 0, 1)),
    g: fromLinear(clamp(g, 0, 1)),
    b: fromLinear(clamp(b, 0, 1)),
    a: color.a,
  });
}

// ---------------------------------------------------------------------------------------------
// Parsing and formatting
// ---------------------------------------------------------------------------------------------

const hex2 = (n: number) =>
  Math.round(clamp(n, 0, 255))
    .toString(16)
    .padStart(2, "0");

/**
 * Canonical document color: lowercase `#rrggbb`, or `#rrggbbaa` when alpha < 1
 * (or always with `forceAlpha`).
 */
export function toHex(c: Rgba, forceAlpha = false): string {
  const n = normalizeRgba(c);
  const base = `#${hex2(n.r)}${hex2(n.g)}${hex2(n.b)}`;
  return n.a < 1 || forceAlpha ? `${base}${hex2(n.a * 255)}` : base;
}

function parseHex(input: string): Rgba | null {
  const m = /^#?([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(input);
  if (!m?.[1]) return null;
  let body = m[1];
  if (body.length <= 4) {
    body = body
      .split("")
      .map((ch) => ch + ch)
      .join("");
  }
  const n = (i: number) => Number.parseInt(body.slice(i, i + 2), 16);
  return { r: n(0), g: n(2), b: n(4), a: body.length === 8 ? round(n(6) / 255, 4) : 1 };
}

/** Splits `fn(a b c / d)` or `fn(a, b, c, d)` into raw argument tokens. */
function functionArgs(input: string, names: string[]): string[] | null {
  const m = /^([a-z]+)\(\s*([^)]*)\)$/i.exec(input);
  if (!m?.[1] || m[2] === undefined || !names.includes(m[1].toLowerCase())) return null;
  const body = m[2].trim();
  const parts = body.includes(",")
    ? body.split(",").map((p) => p.trim())
    : body
        .replace("/", " / ")
        .split(/\s+/)
        .filter((p) => p && p !== "/");
  return parts.length === 3 || parts.length === 4 ? parts : null;
}

function parseNumber(token: string, percentScale: number): number | null {
  const t = token.trim();
  if (t === "none") return 0;
  const isPercent = t.endsWith("%");
  const n = Number.parseFloat(isPercent ? t.slice(0, -1) : t);
  if (!Number.isFinite(n)) return null;
  return isPercent ? (n / 100) * percentScale : n;
}

function parseAngle(token: string): number | null {
  const t = token.trim().toLowerCase();
  const n = Number.parseFloat(t);
  if (!Number.isFinite(n)) return null;
  if (t.endsWith("rad")) return (n * 180) / Math.PI;
  if (t.endsWith("turn")) return n * 360;
  if (t.endsWith("grad")) return n * 0.9;
  return n;
}

function parseAlpha(token: string | undefined): number | null {
  if (token === undefined) return 1;
  return parseNumber(token, 1);
}

/**
 * Parses hex, `rgb()/rgba()`, `hsl()/hsla()` and `oklch()` (comma or space syntax, optional
 * `/ alpha`, percentages). Returns `null` for anything else.
 */
export function parseColor(input: string): Rgba | null {
  const s = input.trim().toLowerCase();
  if (!s) return null;
  const hex = parseHex(s);
  if (hex) return hex;

  const rgb = functionArgs(s, ["rgb", "rgba"]);
  if (rgb) {
    const [r, g, b] = rgb.slice(0, 3).map((t) => parseNumber(t, 255));
    const a = parseAlpha(rgb[3]);
    if (r == null || g == null || b == null || a == null) return null;
    return normalizeRgba({ r, g, b, a });
  }

  const hsl = functionArgs(s, ["hsl", "hsla"]);
  if (hsl) {
    const h = parseAngle(hsl[0] ?? "");
    const sat = parseNumber(hsl[1] ?? "", 1);
    const light = parseNumber(hsl[2] ?? "", 1);
    const a = parseAlpha(hsl[3]);
    if (h == null || sat == null || light == null || a == null) return null;
    // Plain numbers in hsl() are percentages too (legacy syntax allows `hsl(30 100 50)`).
    const toUnit = (n: number, token: string) => (token.trim().endsWith("%") ? n : n / 100);
    return hslToRgb({
      h,
      s: clamp(toUnit(sat, hsl[1] ?? ""), 0, 1),
      l: clamp(toUnit(light, hsl[2] ?? ""), 0, 1),
      a: clamp(a, 0, 1),
    });
  }

  const ok = functionArgs(s, ["oklch"]);
  if (ok) {
    const l = parseNumber(ok[0] ?? "", 1);
    const c = parseNumber(ok[1] ?? "", 0.4);
    const h = parseAngle(ok[2] ?? "");
    const a = parseAlpha(ok[3]);
    if (l == null || c == null || h == null || a == null) return null;
    return oklchToRgb({ l, c, h, a: clamp(a, 0, 1) });
  }
  return null;
}

const alphaSuffix = (a: number) => (a < 1 ? ` / ${round(a * 100)}%` : "");

export function formatRgb(c: Rgba): string {
  const n = normalizeRgba(c);
  return `rgb(${n.r} ${n.g} ${n.b}${alphaSuffix(n.a)})`;
}

export function formatHsl(c: Rgba): string {
  const { h, s, l, a } = rgbToHsl(normalizeRgba(c));
  return `hsl(${round(h)} ${round(s * 100)}% ${round(l * 100)}%${alphaSuffix(a)})`;
}

export function formatOklch(c: Rgba): string {
  const { l, c: chroma, h, a } = rgbToOklch(normalizeRgba(c));
  return `oklch(${round(l * 100, 1)}% ${round(chroma, 3)} ${round(h, 1)}${alphaSuffix(a)})`;
}

/** Formats a color in the given format (hex includes alpha only when < 1). */
export function formatColor(c: Rgba, format: ColorFormat): string {
  switch (format) {
    case "hex":
      return toHex(c);
    case "rgb":
      return formatRgb(c);
    case "hsl":
      return formatHsl(c);
    case "oklch":
      return formatOklch(c);
  }
}

/** CSS color usable in `style` (hex with alpha is valid CSS). */
export function toCss(c: Rgba): string {
  return toHex(c);
}

/**
 * Normalizes any color string to canonical hex before it reaches CSS, so values from documents,
 * brand kits or other users (untrusted) can never smuggle `url(...)`, `var(...)` or other CSS
 * into a `style` attribute. Unparseable input renders as `transparent`.
 */
export function cssColor(input: string): string {
  const parsed = typeof input === "string" ? parseColor(input) : null;
  return parsed ? toHex(parsed) : "transparent";
}

/** Linear interpolation between two colors in sRGB (alpha included). */
export function mixRgba(a: Rgba, b: Rgba, t: number): Rgba {
  return normalizeRgba({
    r: a.r + (b.r - a.r) * t,
    g: a.g + (b.g - a.g) * t,
    b: a.b + (b.b - a.b) * t,
    a: a.a + (b.a - a.a) * t,
  });
}

/** Perceived lightness check used to pick readable overlays (checkmarks on swatches). */
export function isLight(c: Rgba): boolean {
  return rgbToOklch(c).l > 0.7;
}

/** Equality on canonical hex, so `#FFF` and `#ffffff` match. */
export function sameColor(a: string, b: string): boolean {
  const pa = parseColor(a);
  const pb = parseColor(b);
  return pa !== null && pb !== null && toHex(pa) === toHex(pb);
}
