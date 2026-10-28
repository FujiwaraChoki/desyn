// Approximate text measurement without a shaper: per-character advance estimates by font category, word wrapping
// and the document's line-height rules. Used by MemoryHost and as a pre-flight estimate before the host's real
// measure (the Rust shaper) is available. Errors are typically within ±8 % for Latin text.
import { getFont, type ParagraphStyle, type TextRun, type TextStyle } from "@desyn/schema";
import type { MeasureItem, MeasureResult } from "../host";
import { applyTextCase } from "./paint";

// Average advance in em for lowercase Latin text, by font category.
const CATEGORY_ADVANCE: Record<string, number> = {
  "sans-serif": 0.52,
  serif: 0.5,
  display: 0.54,
  handwriting: 0.46,
  monospace: 0.6,
};

const NARROW = new Set("iljtfr.,:;'!|()[] ");
const WIDE = new Set("mwMW@%");

function charAdvance(ch: string, base: number): number {
  if (NARROW.has(ch)) return base * 0.55;
  if (WIDE.has(ch)) return base * 1.55;
  if (ch >= "A" && ch <= "Z") return base * 1.28;
  if (ch >= "0" && ch <= "9") return base * 1.08;
  // CJK and other full-width scripts take a full em.
  if (/[　-鿿가-힯＀-￯]/.test(ch)) return 1;
  return base;
}

function familyAdvance(family: string): number {
  const category = getFont(family)?.category ?? "sans-serif";
  return CATEGORY_ADVANCE[category] ?? 0.52;
}

/** Width in px of a single line of text in a style. */
export function lineWidth(
  text: string,
  style: Pick<TextStyle, "fontFamily" | "fontSize" | "fontWeight" | "letterSpacing" | "textCase">,
): number {
  const display = applyTextCase(text, style.textCase);
  const base = familyAdvance(style.fontFamily);
  // Bolder weights widen glyphs slightly (≈ 4 % per 100 above 400).
  const weightFactor = 1 + Math.max(-0.12, ((style.fontWeight ?? 400) - 400) / 100) * 0.04;
  let em = 0;
  for (const ch of display) em += charAdvance(ch, base);
  const spacing = (style.letterSpacing ?? 0) * Math.max(0, [...display].length - 1);
  return (em * weightFactor + spacing) * style.fontSize;
}

export function lineHeightPx(
  style: Pick<TextStyle, "fontSize">,
  paragraph: Pick<ParagraphStyle, "lineHeight">,
): number {
  const lh = paragraph.lineHeight;
  if (lh.unit === "px") return lh.value;
  if (lh.unit === "percent") return (style.fontSize * lh.value) / 100;
  return style.fontSize * 1.2;
}

/** Largest font size among runs (runs may override the base size). */
function effectiveStyle(runs: readonly TextRun[], style: TextStyle): TextStyle {
  const sizes = runs
    .map((r) => r.style?.fontSize)
    .filter((s): s is number => typeof s === "number");
  return sizes.length > 0 ? { ...style, fontSize: Math.max(style.fontSize, ...sizes) } : style;
}

/** Wraps text into lines that fit `width` (greedy, breaking long words by characters). */
export function wrapLines(text: string, style: TextStyle, width?: number): string[] {
  const paragraphs = text.split("\n");
  if (width === undefined || width <= 0) return paragraphs;
  const lines: string[] = [];
  for (const para of paragraphs) {
    const words = para.split(/(\s+)/).filter((w) => w.length > 0);
    let current = "";
    for (const word of words) {
      const candidate = current + word;
      if (current === "" || lineWidth(candidate.trimEnd(), style) <= width) {
        current = candidate;
        continue;
      }
      lines.push(current.trimEnd());
      current = word.trimStart();
      // A single word wider than the box breaks by characters.
      while (current.length > 1 && lineWidth(current, style) > width) {
        let cut = current.length - 1;
        while (cut > 1 && lineWidth(current.slice(0, cut), style) > width) cut--;
        lines.push(current.slice(0, cut));
        current = current.slice(cut);
      }
    }
    lines.push(current.trimEnd());
  }
  return lines;
}

export function measureText(item: MeasureItem): MeasureResult & { lineWidths: number[] } {
  const style = effectiveStyle(item.text, item.style);
  const text = item.text.map((r) => r.text).join("");
  const lines = wrapLines(text, style, item.width);
  const lineWidths = lines.map((l) => lineWidth(l, style));
  const lh = lineHeightPx(style, item.paragraph);
  const paragraphs = text.split("\n").length;
  const h = lines.length * lh + Math.max(0, paragraphs - 1) * (item.paragraph.spacing ?? 0);
  const w = item.width ?? Math.max(0, ...lineWidths);
  return { w: Math.ceil(w), h: Math.ceil(h), lines: lines.length, lineWidths };
}

/** Font size that makes `text` fit a box (binary search between `min` and `max`). */
export function fitFontSize(
  text: string,
  style: TextStyle,
  paragraph: ParagraphStyle,
  box: { width: number; height: number; maxLines?: number },
  range: { min?: number; max?: number } = {},
): number {
  let lo = range.min ?? 8;
  let hi = range.max ?? Math.max(lo, style.fontSize);
  const fits = (size: number) => {
    const m = measureText({
      text: [{ text }],
      style: { ...style, fontSize: size },
      paragraph,
      width: box.width,
    });
    return m.h <= box.height && (box.maxLines === undefined || m.lines <= box.maxLines);
  };
  if (fits(hi)) return hi;
  for (let i = 0; i < 20 && hi - lo > 0.5; i++) {
    const mid = (lo + hi) / 2;
    if (fits(mid)) lo = mid;
    else hi = mid;
  }
  return Math.floor(lo);
}
