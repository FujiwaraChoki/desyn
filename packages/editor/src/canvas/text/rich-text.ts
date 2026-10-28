import {
  PartialTextStyleSchema,
  type TextRun,
  type TextStyle,
  TextStyleSchema,
} from "@desyn/schema";

/**
 * Rich text on the clipboard while editing text on the canvas. Copies carry three flavours: Desyn runs
 * (`application/x-desyn-runs+json`, full styles, used between Desyn text layers), HTML (styled spans for other
 * apps) and plain text. Pasting Desyn runs keeps every style; pasting HTML from other apps keeps emphasis only
 * (bold, italic, underline, strikethrough) so foreign fonts, sizes and colors do not leak into the design.
 */

export const RUNS_MIME = "application/x-desyn-runs+json";

/** Runs covering `[start, end)` (UTF-16 offsets). */
export function sliceRuns(runs: readonly TextRun[], start: number, end: number): TextRun[] {
  const out: TextRun[] = [];
  let pos = 0;
  for (const r of runs) {
    const rs = pos;
    const re = pos + r.text.length;
    pos = re;
    const a = Math.max(start, rs);
    const b = Math.min(end, re);
    if (b > a)
      out.push(
        r.style
          ? { text: r.text.slice(a - rs, b - rs), style: { ...r.style } }
          : { text: r.text.slice(a - rs, b - rs) },
      );
  }
  return out;
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

function cssColor(style: Partial<TextStyle>): string | null {
  const fill = style.fills?.find((f) => f.type === "solid" && f.visible !== false);
  return fill && fill.type === "solid" && typeof fill.color === "string"
    ? fill.color.slice(0, 7)
    : null;
}

/** HTML with inline styles for the slice (runs over the node's base style). */
export function runsToHtml(runs: readonly TextRun[], base: TextStyle): string {
  const spans = runs.map((r) => {
    const s: Partial<TextStyle> = { ...base, ...r.style };
    const css: string[] = [];
    if (s.fontFamily) css.push(`font-family:'${s.fontFamily.replace(/'/g, "")}'`);
    if (s.fontWeight) css.push(`font-weight:${s.fontWeight}`);
    if (s.fontStyle === "italic") css.push("font-style:italic");
    if (s.fontSize) css.push(`font-size:${s.fontSize}px`);
    const color = cssColor(s);
    if (color) css.push(`color:${color}`);
    if (s.decoration === "underline") css.push("text-decoration:underline");
    if (s.decoration === "strikethrough") css.push("text-decoration:line-through");
    if (s.letterSpacing) css.push(`letter-spacing:${s.letterSpacing}em`);
    if (s.textCase === "upper") css.push("text-transform:uppercase");
    if (s.textCase === "lower") css.push("text-transform:lowercase");
    if (s.textCase === "title") css.push("text-transform:capitalize");
    const text = escapeHtml(r.text)
      .replace(/\n/g, "<br>")
      .replace(/\u2028/g, "<br>");
    return `<span style="${css.join(";")}">${text}</span>`;
  });
  return `<meta charset="utf-8"><div>${spans.join("")}</div>`;
}

export interface PastedRun {
  text: string;
  style: Partial<TextStyle>;
}

const BLOCK = new Set([
  "P",
  "DIV",
  "LI",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "BLOCKQUOTE",
  "PRE",
  "TR",
]);

/** Emphasis runs from foreign HTML (bold / italic / underline / strikethrough), paragraphs as "\n". */
export function htmlToRuns(html: string): PastedRun[] {
  if (typeof DOMParser === "undefined") return [];
  const doc = new DOMParser().parseFromString(html, "text/html");
  const out: PastedRun[] = [];
  const push = (text: string, style: Partial<TextStyle>) => {
    if (!text) return;
    const last = out[out.length - 1];
    if (last && JSON.stringify(last.style) === JSON.stringify(style)) last.text += text;
    else out.push({ text, style: { ...style } });
  };
  const newline = () => {
    const last = out[out.length - 1];
    if (last && !last.text.endsWith("\n")) push("\n", {});
  };
  const walk = (node: Node, style: Partial<TextStyle>) => {
    if (node.nodeType === 3) {
      push((node.textContent ?? "").replace(/\s+/g, " "), style);
      return;
    }
    if (node.nodeType !== 1) return;
    const el = node as HTMLElement;
    const tag = el.tagName;
    if (tag === "STYLE" || tag === "SCRIPT" || tag === "META" || tag === "TITLE") return;
    if (tag === "BR") {
      push("\n", style);
      return;
    }
    const next: Partial<TextStyle> = { ...style };
    if (tag === "B" || tag === "STRONG") next.fontWeight = 700;
    if (tag === "I" || tag === "EM") next.fontStyle = "italic";
    if (tag === "U" || tag === "INS") next.decoration = "underline";
    if (tag === "S" || tag === "STRIKE" || tag === "DEL") next.decoration = "strikethrough";
    const css = el.style;
    if (css) {
      const w = css.fontWeight;
      if (w === "bold" || w === "bolder" || Number(w) >= 600) next.fontWeight = 700;
      else if (w === "normal" || (w && Number(w) > 0 && Number(w) < 600)) delete next.fontWeight;
      if (css.fontStyle === "italic" || css.fontStyle === "oblique") next.fontStyle = "italic";
      else if (css.fontStyle === "normal") delete next.fontStyle;
      const deco = css.textDecorationLine || css.textDecoration;
      if (deco?.includes("underline")) next.decoration = "underline";
      else if (deco?.includes("line-through")) next.decoration = "strikethrough";
    }
    const block = BLOCK.has(tag);
    if (block) newline();
    for (const child of [...el.childNodes]) walk(child, next);
    if (block) newline();
  };
  walk(doc.body, {});
  // Trim the paragraph break the last block added.
  const last = out[out.length - 1];
  if (last) last.text = last.text.replace(/\n+$/, "");
  const first = out[0];
  if (first) first.text = first.text.replace(/^\s+/, "");
  return out.filter((r) => r.text.length > 0);
}

const STYLE_KEYS = new Set(Object.keys(TextStyleSchema.shape));

/**
 * A pasted run style, validated: the runs flavour can come from any page, so only known `TextStyle` keys with
 * valid values reach the document (an invalid style is dropped, the text is kept).
 */
function cleanStyle(style: unknown): Partial<TextStyle> {
  if (!style || typeof style !== "object" || Array.isArray(style)) return {};
  const known = Object.fromEntries(
    Object.entries(style as Record<string, unknown>).filter(([k]) => STYLE_KEYS.has(k)),
  );
  const parsed = PartialTextStyleSchema.safeParse(known);
  return parsed.success ? (parsed.data as Partial<TextStyle>) : {};
}

/** Parses the Desyn runs flavour. */
export function parseRunsPayload(json: string): PastedRun[] | null {
  try {
    const v = JSON.parse(json) as unknown;
    if (!Array.isArray(v)) return null;
    const runs: PastedRun[] = [];
    for (const r of v) {
      if (!r || typeof r !== "object" || typeof (r as { text?: unknown }).text !== "string")
        return null;
      const style = (r as { style?: unknown }).style;
      runs.push({ text: (r as { text: string }).text, style: cleanStyle(style) });
    }
    return runs;
  } catch {
    return null;
  }
}
