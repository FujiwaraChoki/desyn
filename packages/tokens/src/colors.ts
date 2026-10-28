import { rgbTriplet } from "./color.ts";

/** The two fully designed themes. `system` is resolved to one of these at runtime. */
export type ThemeName = "dark" | "light";
/** A user-facing theme preference. */
export type ThemePreference = ThemeName | "system";

export const THEMES: readonly ThemeName[] = ["dark", "light"];
export const THEME_PREFERENCES: readonly ThemePreference[] = ["system", "dark", "light"];

/**
 * Every semantic color that changes between themes. Keys become CSS custom properties
 * (`--surface-1`) with an rgb companion (`--surface-1-rgb`) and Tailwind colors (`bg-surface-1`).
 */
export interface ThemePalette {
  /** App background behind everything. */
  background: string;
  /** Primary text and icon color. Derived text tones use its rgb at 80/60/40%. */
  foreground: string;
  /** Panels (inspector, sidebars). */
  "surface-1": string;
  /** Raised elements and input fills. */
  "surface-2": string;
  /** Hover fill on raised elements. */
  "surface-3": string;
  /** Editor canvas behind the design page. */
  canvas: string;
  /** The sun. Icons, focus, selection, large accent text. */
  accent: string;
  /** Accent for small text (links, labels) that must meet WCAG AA 4.5:1 on the background. */
  "accent-text": string;
  /** Fill for primary buttons and other solid sun surfaces. */
  "accent-solid": string;
  /** Text/icon color placed on `accent-solid`. */
  "accent-ink": string;
  /** Gradient highlight (warm gold). */
  "accent-hi": string;
  /** Gradient shadow (ember). */
  "accent-lo": string;
  success: string;
  warning: string;
  danger: string;
  /** Text/icon color placed on a solid `danger` fill. */
  "danger-ink": string;
  info: string;
  /** Selection outline and handle border on the canvas. */
  selection: string;
}

export const SUN = {
  dark: "#FFB02E",
  // Same hue as the bright sun so outlines and fills read as one color on paper.
  light: "#C27C00",
  hi: "#FFD66B",
  lo: "#FF6A1F",
} as const;

export const palettes: Record<ThemeName, ThemePalette> = {
  dark: {
    background: "#0A0A0A",
    foreground: "#EDEDED",
    "surface-1": "#111111",
    "surface-2": "#171717",
    "surface-3": "#1F1F1F",
    canvas: "#0E0E0E",
    accent: SUN.dark,
    "accent-text": SUN.dark,
    "accent-solid": SUN.dark,
    "accent-ink": "#1A1205",
    "accent-hi": SUN.hi,
    "accent-lo": SUN.lo,
    success: "#4ADE80",
    warning: SUN.dark,
    danger: "#FF5C5C",
    "danger-ink": "#1A0505",
    info: "#7AB8FF",
    selection: SUN.dark,
  },
  light: {
    background: "#FFFFFF",
    foreground: "#171717",
    "surface-1": "#FAFAFA",
    "surface-2": "#F4F4F4",
    "surface-3": "#EBEBEB",
    canvas: "#EFEFEF",
    accent: SUN.light,
    "accent-text": "#935A00",
    // The bright sun reads as "the sun" on paper too; ink text keeps it AA, a hairline gives it an edge.
    "accent-solid": "#FFB02E",
    "accent-ink": "#1A1205",
    "accent-hi": SUN.hi,
    "accent-lo": SUN.lo,
    // Spec #15803D nudged darker so success text stays AA on light input fills (surface-2).
    success: "#147A3A",
    warning: SUN.light,
    danger: "#C62828",
    "danger-ink": "#FFFFFF",
    info: "#1D5FBF",
    selection: SUN.light,
  },
};

/** A color token with its hex value and space-separated rgb channels. */
export interface ColorToken {
  hex: string;
  rgb: string;
}

function withRgb(palette: ThemePalette): Record<keyof ThemePalette, ColorToken> {
  const out = {} as Record<keyof ThemePalette, ColorToken>;
  for (const key of Object.keys(palette) as (keyof ThemePalette)[]) {
    out[key] = { hex: palette[key], rgb: rgbTriplet(palette[key]) };
  }
  return out;
}

/** Theme colors with rgb triplets, e.g. `colors.dark.accent.rgb === "255 176 46"`. */
export const colors: Record<ThemeName, Record<keyof ThemePalette, ColorToken>> = {
  dark: withRgb(palettes.dark),
  light: withRgb(palettes.light),
};

/**
 * Opacity steps applied to `--foreground-rgb` (Akatsuki scale) for secondary text and borders.
 * `placeholder` is only used for placeholder/disabled text.
 */
export const foregroundAlpha = {
  secondary: 0.8,
  // 62% rather than Akatsuki's 60% so muted text stays AA on light input fills.
  muted: 0.62,
  placeholder: 0.45,
  borderStrong: 0.4,
  border: 0.2,
  borderSubtle: 0.1,
  hover: 0.06,
  pressed: 0.1,
} as const;

/** Opacity steps applied to `--accent-rgb`. */
export const accentAlpha = {
  core: 0.7,
  mid: 0.55,
  glow: 0.4,
  ring: 0.6,
  tint: 0.15,
  wash: 0.08,
} as const;

/**
 * Warm-first categorical palette for charts and tags. `cool` is the counter-color, used only
 * when the data needs a contrasting series.
 */
export const chartPalette = {
  warm: ["#FFB02E", "#FF6A1F", "#FFD66B", "#C4451C", "#8A5A00", "#E8E1D3", "#7A7468"],
  cool: "#5AA9FF",
} as const;

/** Swatches offered by the color picker by default: neutrals, the sun family and a calm spectrum. */
export const defaultSwatches: readonly string[] = [
  "#000000",
  "#2B2B2B",
  "#7A7468",
  "#E8E1D3",
  "#FFFFFF",
  "#FFB02E",
  "#FFD66B",
  "#FF6A1F",
  "#C4451C",
  "#8A5A00",
  "#FF5C5C",
  "#4ADE80",
  "#2DD4BF",
  "#5AA9FF",
  "#A78BFA",
  "#F472B6",
];
