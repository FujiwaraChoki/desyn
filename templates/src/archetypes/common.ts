// Shared vocabulary for archetypes: the build context, a type scale, and the recurring pieces of a layout
// (brand mark, eyebrow, accented headline, call-to-action row, decorative art) so every template speaks the same
// design language.
import { type DesignKind, getFont } from "@desyn/schema";
import type { Niche } from "../copy/niches";
import * as art from "../lib/art";
import { Doc, ems, type PageBuilder, type Paint } from "../lib/doc";
import { alpha, contrast, mix, type Palette } from "../lib/palettes";
import { pick, type Rng } from "../lib/rand";
import type { TypePair } from "../lib/type";

export interface Ctx {
  slug: string;
  title: string;
  kind: DesignKind;
  preset: string;
  niche: Niche;
  palette: Palette;
  type: TypePair;
  r: Rng;
  /** copy variant index (rotates headlines, ctas, images) */
  v: number;
}

export interface Archetype {
  id: string;
  kind: DesignKind;
  presets: string[];
  /** human label used in template titles ("Photo split", "Bold type") */
  label: string;
  /** palettes this layout needs (dark/light) */
  wants?: "dark" | "light" | "any";
  /** the niche has the content this layout needs */
  fits?: (n: Niche) => boolean;
  /** headline font constraint */
  typeFilter?: (t: TypePair) => boolean;
  build: (c: Ctx) => Doc;
}

export function newDoc(c: Ctx): Doc {
  const d = new Doc({
    slug: c.slug,
    name: c.title,
    kind: c.kind,
    preset: c.preset,
    palette: c.palette,
    type: c.type,
  });
  d.tag(c.niche.id, c.niche.category.toLowerCase(), c.palette.id, ...c.niche.moods.slice(0, 2));
  return d;
}

export const at = <T>(list: readonly T[], v: number): T => {
  const item = list[v % list.length];
  if (item === undefined) throw new Error("empty list");
  return item;
};

/** Modular type scale from a base size. */
export function scale(base: number, ratio = 1.333) {
  return (step: number) => Math.round(base * ratio ** step);
}

export function hasItalic(family: string): boolean {
  return getFont(family)?.italic ?? false;
}

/** Text that sits on `bg`: picks ink or onAccent-like contrast automatically. */
export function onColor(c: Ctx, bg: string): Paint {
  const lum = (hex: string) => {
    const n = Number.parseInt(hex.slice(1, 7), 16);
    return (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  };
  return lum(bg) > 0.55 ? (c.palette.dark ? "bg" : "ink") : c.palette.dark ? "ink" : "bg";
}

/**
 * `paint` if it reaches `min` contrast on `bg` (a palette key or hex), otherwise the paint mixed toward the palette's
 * ink (or ground, for light-on-dark) until it does. Keeps accent-colored small text legible on every palette.
 */
export function readable(c: Ctx, paint: Paint, bg: Paint, min = 4.5): Paint {
  const col = (x: Paint) => (x.startsWith("#") ? x : (c.palette[x as keyof Palette] as string));
  const fg = col(paint);
  const back = col(bg);
  if (contrast(fg, back) >= min) return paint;
  const toward =
    contrast(c.palette.ink, back) >= contrast(c.palette.bg, back) ? c.palette.ink : c.palette.bg;
  for (let t = 0.15; t <= 1; t += 0.1) {
    const m = mix(fg, toward, t);
    if (contrast(m, back) >= min) return m;
  }
  return toward;
}

/**
 * Headline with an emphasized phrase ([before, accent, after] from the niche's accent lines): the accent is set in
 * italic (when the face has one) and the accent color, the signature move of the library.
 */
export function accentHeadline(
  p: PageBuilder,
  c: Ctx,
  o: {
    x: number;
    y: number;
    w: number;
    size: number;
    lines?: number;
    maxH?: number;
    align?: "left" | "center" | "right";
    color?: Paint;
    accent?: Paint;
    leading?: number;
    role?: string;
    caps?: boolean;
  },
): string {
  const [before, mid, after] = at(c.niche.accents, c.v);
  const italic = hasItalic(c.type.heading) && !c.type.caps;
  const caps = o.caps ?? (c.type.caps && !c.type.script);
  const size = fitSize(`${before}${mid}${after}`, o.w, o.size, {
    lines: o.lines ?? 4,
    upper: caps,
    family: c.type.heading,
    ...(o.maxH ? { height: o.maxH, leading: o.leading ?? (caps ? 92 : 102) } : {}),
  });
  return p.text({
    x: o.x,
    y: o.y,
    w: o.w,
    font: "heading",
    size,
    leading: o.leading ?? (caps ? 92 : 102),
    tracking: caps ? 0.01 : -0.015,
    textCase: caps ? "upper" : "none",
    align: o.align ?? "left",
    color: o.color ?? "ink",
    role: o.role ?? "headline",
    runs: [
      ...(before ? [{ text: before }] : []),
      { text: mid, italic, color: o.accent ?? "accent" },
      ...(after ? [{ text: after }] : []),
    ],
  });
}

/** A heading-font text block sized to fit its column (never splitting words). */
export function title(
  p: PageBuilder,
  c: Ctx,
  text: string,
  o: {
    x: number;
    y: number;
    w: number;
    size: number;
    lines?: number;
    maxH?: number;
    align?: "left" | "center" | "right";
    color?: Paint;
    role?: string;
    leading?: number;
    caps?: boolean;
    opacity?: number;
  },
): string {
  const caps = o.caps ?? (c.type.caps && !c.type.script);
  const leading = o.leading ?? (caps ? 92 : 102);
  const size = fitSize(text, o.w, o.size, {
    lines: o.lines ?? 4,
    upper: caps,
    family: c.type.heading,
    ...(o.maxH ? { height: o.maxH, leading } : {}),
  });
  return p.text({
    x: o.x,
    y: o.y,
    w: o.w,
    text,
    font: "heading",
    size,
    color: o.color ?? "ink",
    role: o.role ?? "headline",
    align: o.align ?? "left",
    leading,
    tracking: caps ? 0.01 : -0.015,
    textCase: caps ? "upper" : "none",
    ...(o.opacity !== undefined ? { opacity: o.opacity } : {}),
  });
}

/** Plain headline text from the niche (rotating). */
export function headline(c: Ctx, offset = 0): string {
  return at(c.niche.headlines, c.v + offset);
}

export function eyebrow(
  p: PageBuilder,
  c: Ctx,
  o: {
    x: number;
    y: number;
    w: number;
    size: number;
    text?: string;
    color?: Paint;
    align?: "left" | "center" | "right";
    on?: Paint;
  },
): string {
  return p.text({
    x: o.x,
    y: o.y,
    w: o.w,
    text: o.text ?? c.niche.brand.name,
    size: o.size,
    weight: 600,
    tracking: 0.18,
    textCase: "upper",
    color: readable(c, o.color ?? "accent", o.on ?? "bg"),
    align: o.align ?? "left",
    role: "eyebrow",
    leading: 120,
  });
}

/** A small brand mark: a filled circle with the brand's initial plus the brand name. */
export function brandMark(
  p: PageBuilder,
  c: Ctx,
  o: { x: number; y: number; size: number; color?: Paint; dot?: Paint; name?: boolean },
): string {
  const s = o.size;
  return p.group({ name: "Brand", role: "logo" }, (g) => {
    g.ellipse({
      x: o.x,
      y: o.y,
      w: s,
      h: s,
      fill: o.dot ?? "accent",
      name: "Brand mark",
      role: "brand-mark",
    });
    g.text({
      x: o.x,
      y: o.y + s * 0.12,
      w: s,
      h: s * 0.76,
      text: c.niche.brand.short.replace(/^The /, "").slice(0, 1).toUpperCase(),
      size: s * 0.56,
      font: "heading",
      align: "center",
      valign: "middle",
      color: "onAccent",
      leading: 100,
      name: "Monogram",
    });
    if (o.name !== false) {
      g.text({
        x: o.x + s * 1.35,
        y: o.y + s * 0.18,
        w: s * 12,
        hug: true,
        text: c.niche.brand.short,
        size: s * 0.5,
        weight: 600,
        color: o.color ?? "ink",
        leading: 120,
        name: "Brand name",
      });
    }
  });
}

/** Decorative art layer chosen from the context's randomness; drawn from palette colors. */
export function decoration(
  p: PageBuilder,
  c: Ctx,
  o: {
    x: number;
    y: number;
    w: number;
    h: number;
    style?:
      | "blobs"
      | "sunrise"
      | "bauhaus"
      | "waves"
      | "rings"
      | "dots"
      | "arches"
      | "sprig"
      | "confetti"
      | "ridges";
    opacity?: number;
  },
): string {
  const pal = c.palette;
  const style =
    o.style ??
    pick(
      c.r,
      c.niche.moods.includes("natural") || c.niche.moods.includes("wellness")
        ? ["blobs", "sprig", "waves", "arches"]
        : c.niche.moods.includes("playful")
          ? ["blobs", "confetti", "bauhaus", "dots"]
          : ["blobs", "rings", "arches", "bauhaus", "waves"],
    );
  const soft = (hex: string, t = 0.35) => mix(hex, pal.bg, t);
  let markup: string;
  switch (style) {
    case "sunrise":
      markup = art.sunrise(o.w, o.h, pal.accent2, pal.accent);
      break;
    case "bauhaus":
      markup = art.bauhaus(
        c.r,
        o.w,
        o.h,
        [pal.accent, pal.accent2, soft(pal.accent, 0.5), pal.surface],
        4,
      );
      break;
    case "waves":
      markup = art.waves(c.r, o.w, o.h, [
        soft(pal.accent2, 0.55),
        soft(pal.accent, 0.35),
        pal.accent,
      ]);
      break;
    case "rings":
      markup = art.rings(o.w, o.h, alpha(pal.accent, 0.55), 6, Math.max(1.5, o.w / 260));
      break;
    case "dots":
      markup = art.dots(
        o.w,
        o.h,
        alpha(pal.accent, 0.5),
        Math.max(18, o.w / 14),
        Math.max(2, o.w / 160),
      );
      break;
    case "arches":
      markup = art.arches(o.w, o.h, [
        pal.accent,
        soft(pal.accent2, 0.2),
        soft(pal.accent, 0.55),
        pal.surface,
      ]);
      break;
    case "sprig":
      markup = art.sprig(c.r, o.w, o.h, pal.accent);
      break;
    case "confetti":
      markup = art.confetti(
        c.r,
        o.w,
        o.h,
        [pal.accent, pal.accent2, soft(pal.accent, 0.4)],
        Math.round((o.w * o.h) / 9000) + 18,
      );
      break;
    case "ridges":
      markup = art.ridges(c.r, o.w, o.h, [
        soft(pal.accent, 0.6),
        soft(pal.accent2, 0.35),
        pal.accent,
      ]);
      break;
    default:
      markup = art.blobs(c.r, o.w, o.h, [pal.accent, pal.accent2, soft(pal.accent, 0.5)], 3);
  }
  return p.svg({
    x: o.x,
    y: o.y,
    w: o.w,
    h: o.h,
    markup,
    role: "decoration",
    name: `Decoration (${style})`,
    opacity: o.opacity ?? 1,
  });
}

/** Line icon (from the art set) colored with a palette paint. */
export function icon(
  p: PageBuilder,
  _c: Ctx,
  name: string,
  o: { x: number; y: number; size: number; color?: Paint },
): string {
  const d = p.doc;
  return p.svg({
    x: o.x,
    y: o.y,
    w: o.size,
    h: o.size,
    markup: art.icon(name, d.color(o.color ?? "accent"), o.size),
    role: "icon",
    name: `Icon (${name})`,
  });
}

/** Contact line: url · handle · phone, skipping empty fields. */
export function contactLine(
  c: Ctx,
  parts: ("url" | "handle" | "phone" | "email" | "address")[] = ["url", "handle"],
): string {
  const b = c.niche.brand;
  const values = parts
    .map((k) => (k === "address" ? [b.address, b.city].filter(Boolean).join(", ") : b[k]))
    .filter(Boolean);
  return values.join("  ·  ");
}

/** Gradient scrim for text over photos. */
export function scrim(
  p: PageBuilder,
  c: Ctx,
  o: { x: number; y: number; w: number; h: number; from?: "top" | "bottom"; strength?: number },
): string {
  const d = p.doc;
  const base = c.palette.dark ? c.palette.bg : "#0b0b0c";
  const s = o.strength ?? 0.82;
  const stops: [number, string][] =
    o.from === "top"
      ? [
          [0, alpha(base, s)],
          [1, alpha(base, 0)],
        ]
      : [
          [0, alpha(base, 0)],
          [0.55, alpha(base, s * 0.6)],
          [1, alpha(base, s)],
        ];
  return p.rect({ ...o, fill: d.linear(180, stops), name: "Scrim", role: "decoration" });
}

/**
 * Largest font size (<= max) at which the longest word fits the column and the text needs at most `lines` lines,
 * estimated from glyph widths (the engine relayout gives exact boxes afterwards). Never splits words.
 */
export function fitSize(
  text: string,
  width: number,
  max: number,
  o: {
    lines?: number;
    upper?: boolean;
    min?: number;
    family?: string;
    height?: number;
    leading?: number;
  } = {},
): number {
  const upper = o.upper ?? false;
  const k = widthFactor(o.family);
  // 12% safety: display faces vary more than the generic advance table captures
  const longest = text.split(/\s+/).reduce((m, w) => Math.max(m, ems(w, upper) * k * 1.12), 0);
  let size = Math.min(max, (width * 0.94) / Math.max(1, longest));
  if (o.lines) {
    const total = ems(text, upper) * k;
    // words do not pack perfectly; allow ~15% slack per line
    size = Math.min(size, (width * o.lines * 0.85) / Math.max(1, total));
  }
  if (o.height) {
    const leading = (o.leading ?? 105) / 100;
    while (size > (o.min ?? 8) && linesAt(text, size, width, upper, k) * size * leading > o.height)
      size *= 0.95;
  }
  return Math.max(o.min ?? 8, Math.floor(size));
}

/** Greedy word wrap estimate: lines needed for `text` at `size` in `width`. */
function linesAt(text: string, size: number, width: number, upper: boolean, k: number): number {
  let lines = 0;
  for (const para of text.split("\n")) {
    let line = 0;
    lines++;
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const w = (ems(word, upper) * k * 1.06 + 0.28) * size;
      if (line > 0 && line + w > width) {
        lines++;
        line = w;
      } else line += w;
    }
  }
  return lines;
}

/** "Saturday, March 14" / "June 19–21" / "October 14–15" -> badge parts. */
export function dateParts(date: string): { weekday?: string; month: string; day: string } {
  const [a = "", b] = date.split(", ");
  const rest = b ?? a;
  const m = /^([A-Za-z]+)\s+(.+)$/.exec(rest.trim());
  const month = (m?.[1] ?? rest).slice(0, 3).toUpperCase();
  const day = m?.[2] ?? "";
  return b ? { weekday: a.slice(0, 3).toUpperCase(), month, day } : { month, day };
}

const CONDENSED = new Set([
  "Bebas Neue",
  "Oswald",
  "Anton",
  "Big Shoulders Display",
  "Staatliches",
  "Amatic SC",
  "Barlow",
]);
const WIDE = new Set([
  "Unbounded",
  "Archivo Black",
  "Abril Fatface",
  "Alfa Slab One",
  "Bungee",
  "Righteous",
  "Syne",
  "Press Start 2P",
  "Orbitron",
  "Shrikhand",
  "Lobster",
  "Chakra Petch",
  "Fredoka",
]);

/** Relative advance width of a face compared to an average sans. */
export function widthFactor(family?: string): number {
  if (!family) return 1;
  if (CONDENSED.has(family)) return 0.74;
  if (WIDE.has(family)) return family === "Press Start 2P" ? 1.6 : 1.18;
  return 1;
}

/** "9.50" -> "$9.50"; prices that already carry a unit or currency stay as written. */
export function fmtPrice(price: string): string {
  return /^\d+(\.\d+)?$/.test(price) ? `$${price}` : price;
}

export { alpha, mix };
