import type { ThemeName } from "./colors.ts";

/**
 * Spacing in px. 8 px base grid with a 4 px half step for dense editor panels.
 * Matches Tailwind 4's default `--spacing: 0.25rem`, so `p-2` = 8 px.
 */
export const spacing = {
  0: 0,
  0.5: 2,
  1: 4,
  1.5: 6,
  2: 8,
  3: 12,
  4: 16,
  5: 20,
  6: 24,
  8: 32,
  10: 40,
  12: 48,
  16: 64,
  24: 96,
} as const;

/** Corner radii in px. */
export const radii = {
  /** Tiny elements inside controls (checkbox, tag). */
  xs: 4,
  /** Buttons, inputs, menu items. */
  control: 6,
  /** Cards, swatches, thumbnails. */
  card: 10,
  /** Panels, dialogs, popovers. */
  panel: 14,
  /** Pills, avatars, switches. */
  pill: 999,
} as const;

/** Font stacks. Family names match the @font-face rules in `fonts.css`. */
export const fonts = {
  serif: `"Instrument Serif", ui-serif, Georgia, "Times New Roman", serif`,
  sans: `"Instrument Sans Variable", "Instrument Sans", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif`,
  mono: `"JetBrains Mono Variable", "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`,
} as const;

/** A font size with its line height (px) and tracking (em). */
export interface TypeStep {
  size: number;
  lineHeight: number;
  tracking?: number;
}

/** App UI scale: 11 / 12 / 13 / 14 / 16 / 20 / 28 (28 is serif). */
export const appType = {
  "2xs": { size: 11, lineHeight: 16 },
  xs: { size: 12, lineHeight: 16 },
  sm: { size: 13, lineHeight: 18 },
  base: { size: 14, lineHeight: 20 },
  md: { size: 16, lineHeight: 24 },
  lg: { size: 20, lineHeight: 28 },
  xl: { size: 28, lineHeight: 34 },
} as const satisfies Record<string, TypeStep>;

/** Marketing scale (Akatsuki). Mobile values with desktop counterparts from 768 px. */
export const marketingType = {
  display: { size: 80, lineHeight: 80, tracking: -0.02 },
  "display-lg": { size: 120, lineHeight: 120, tracking: -0.02 },
  title: { size: 48, lineHeight: 64 },
  "title-lg": { size: 64, lineHeight: 88 },
  heading: { size: 28, lineHeight: 36 },
  subhead: { size: 20, lineHeight: 28 },
  body: { size: 16, lineHeight: 28 },
  label: { size: 14, lineHeight: 20 },
} as const satisfies Record<string, TypeStep>;

/** Layering conventions. Portalled layers sit above the app; tooltips above everything. */
export const zIndex = {
  base: 0,
  raised: 10,
  sticky: 100,
  dock: 200,
  dropdown: 1000,
  overlay: 1100,
  modal: 1200,
  popover: 1300,
  toast: 1400,
  tooltip: 1500,
} as const;

/** Single primary breakpoint (mobile-first) plus editor-specific widths. */
export const breakpoints = {
  sm: 480,
  md: 768,
  lg: 1024,
  xl: 1280,
  "2xl": 1536,
} as const;

export const layout = {
  maxWidthContent: 768,
  maxWidthWide: 1024,
  pagePadding: 24,
  sectionGap: 40,
  componentPadding: 32,
  /** Editor left-rail flyout width. */
  flyoutWidth: 320,
  /** Default inspector width. */
  inspectorWidth: 280,
} as const;

/** Box shadows per theme. Elevation is neutral; the accent never glows. */
export const shadows: Record<
  ThemeName,
  {
    glow: string;
    "glow-lg": string;
    card: string;
    popover: string;
    dialog: string;
    page: string;
    inset: string;
  }
> = {
  dark: {
    glow: "0 4px 16px -4px rgb(0 0 0 / 0.5)",
    "glow-lg": "0 12px 32px -8px rgb(0 0 0 / 0.6)",
    card: "0 12px 32px -16px rgb(0 0 0 / 0.6)",
    popover: "0 16px 48px -12px rgb(0 0 0 / 0.7), 0 2px 6px rgb(0 0 0 / 0.4)",
    dialog: "0 32px 96px -24px rgb(0 0 0 / 0.8)",
    page: "0 1px 2px rgb(0 0 0 / 0.5), 0 12px 40px -12px rgb(0 0 0 / 0.6)",
    inset: "inset 0 1px 0 rgb(255 255 255 / 0.04)",
  },
  light: {
    glow: "0 4px 16px -4px rgb(0 0 0 / 0.18)",
    "glow-lg": "0 12px 32px -8px rgb(0 0 0 / 0.22)",
    card: "0 12px 32px -16px rgb(0 0 0 / 0.25)",
    popover: "0 16px 40px -12px rgb(0 0 0 / 0.18), 0 2px 6px rgb(0 0 0 / 0.08)",
    dialog: "0 32px 80px -24px rgb(0 0 0 / 0.28)",
    page: "0 1px 2px rgb(0 0 0 / 0.12), 0 12px 40px -16px rgb(0 0 0 / 0.25)",
    inset: "inset 0 1px 0 rgb(255 255 255 / 0.6)",
  },
};

/** Opacity of atmospheric orbs (Akatsuki: 0.3 on light, 0.22 on dark). */
export const orbOpacity: Record<ThemeName, number> = { dark: 0.22, light: 0.3 };

/** Scrim behind modal surfaces. */
export const scrim: Record<ThemeName, string> = {
  dark: "rgb(0 0 0 / 0.6)",
  light: "rgb(0 0 0 / 0.3)",
};
