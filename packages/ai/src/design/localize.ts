// Translation and length-aware relayout shared by translate_text and the localize workflow: collect text with
// length budgets, translate with a structured model call, then rewrite text with font fitting, script-aware font
// substitution and right-to-left mirroring.

import { childIds, descendants, getNode } from "@desyn/doc-ops";
import {
  type Design,
  getFont,
  type Id,
  type Node,
  type Op,
  type PageNode,
  type TextNode,
} from "@desyn/schema";
import { generateText, type LanguageModel, Output } from "ai";
import { z } from "zod";
import type { DocHost } from "../host";
import { wrapUntrusted } from "../prompts/guard";
import { isRtlLocale, scriptFonts, translateSystemPrompt } from "../prompts/language";
import { textOf } from "./paint";

export interface TextItem {
  id: Id;
  text: string;
  role?: string;
  maxChars: number;
}

const TIGHT_ROLES = new Set([
  "headline",
  "subhead",
  "cta",
  "button",
  "eyebrow",
  "badge",
  "price",
  "stat",
  "slide-title",
  "nav",
]);

/** Visible, non-empty text nodes under `rootId` (a page or container) or exactly `ids`. */
export function collectTexts(design: Design, scope: { rootId?: Id; ids?: Id[] }): TextItem[] {
  const nodes: Node[] = scope.ids
    ? scope.ids.map((id) => getNode(design, id)).filter((n): n is Node => n !== undefined)
    : descendants(design, scope.rootId ?? "root");
  return nodes
    .filter((n): n is TextNode => n.type === "text" && n.visible && textOf(n).trim().length > 0)
    .map((n) => {
      const text = textOf(n);
      const allowance = TIGHT_ROLES.has(n.role ?? "") ? 1.15 : 1.35;
      return {
        id: n.id,
        text,
        ...(n.role ? { role: n.role } : {}),
        maxChars: Math.max(4, Math.ceil(text.length * allowance)),
      };
    });
}

const translationSchema = z.object({
  items: z.array(z.object({ id: z.string(), text: z.string() })),
});

/** Translates items in batches of 60 with one structured call each. */
export async function translateTexts(
  model: LanguageModel,
  items: TextItem[],
  locale: string,
  options: { signal?: AbortSignal; glossary?: Record<string, string> } = {},
): Promise<Map<Id, string>> {
  const out = new Map<Id, string>();
  for (let i = 0; i < items.length; i += 60) {
    const batch = items.slice(i, i + 60);
    const glossary =
      options.glossary && Object.keys(options.glossary).length
        ? `\nGlossary (always use these renderings):\n${Object.entries(options.glossary)
            .map(([a, b]) => `- ${a} → ${b}`)
            .join("\n")}`
        : "";
    const { output } = await generateText({
      model,
      instructions: translateSystemPrompt(locale),
      output: Output.object({ schema: translationSchema }),
      prompt: `Translate every item into ${locale}. Return all ids.${glossary}\n${wrapUntrusted(
        "design-text",
        JSON.stringify(
          batch.map((b) => ({
            id: b.id,
            role: b.role ?? "text",
            maxChars: b.maxChars,
            text: b.text,
          })),
        ),
      )}`,
      temperature: 0.2,
      ...(options.signal ? { abortSignal: options.signal } : {}),
    });
    const wanted = new Set(batch.map((b) => b.id));
    for (const item of output.items) if (wanted.has(item.id)) out.set(item.id, item.text);
  }
  return out;
}

function needsScriptFont(family: string, locale: string): boolean {
  if (scriptFonts(locale).length === 0) return false;
  // Catalog fonts are Latin(-extended) unless their tags mention the script.
  const info = getFont(family);
  const lang = locale.toLowerCase().split(/[-_]/)[0] ?? "";
  return !info?.tags.some((t) => t.toLowerCase().includes(lang));
}

export interface RelayoutOptions {
  locale: string;
  /** Mirror layout horizontally for RTL locales (default true). */
  mirror?: boolean;
  /** Smallest allowed font scale when fitting (default 0.85). */
  minScale?: number;
}

export interface RelayoutReport {
  ops: Op[];
  shrunk: Id[];
  grown: Id[];
  fontSwaps: Id[];
  mirrored: Id[];
}

/**
 * Ops that put translations into the design: replaces text (keeping run styles), swaps in a script font when
 * needed, fits text into its original box (shrinking down to `minScale`, then growing height) and mirrors RTL.
 */
export async function relayoutTranslations(
  host: DocHost,
  design: Design,
  page: PageNode,
  translations: Map<Id, string>,
  options: RelayoutOptions,
): Promise<RelayoutReport> {
  const report: RelayoutReport = { ops: [], shrunk: [], grown: [], fontSwaps: [], mirrored: [] };
  const rtl = isRtlLocale(options.locale);
  const minScale = options.minScale ?? 0.85;
  const scriptFont = scriptFonts(options.locale)[0];
  for (const [id, text] of translations) {
    const node = getNode(design, id);
    if (node?.type !== "text") continue;
    const set: Record<string, unknown> = {};
    const firstStyle = node.runs[0]?.style;
    set.runs = [firstStyle ? { text, style: firstStyle } : { text }];
    let style = node.style;
    if (scriptFont && needsScriptFont(node.style.fontFamily, options.locale)) {
      style = { ...style, fontFamily: scriptFont };
      report.fontSwaps.push(id);
    }
    let paragraph = node.paragraph;
    if (rtl) {
      paragraph = {
        ...paragraph,
        direction: "rtl",
        align:
          paragraph.align === "left"
            ? "right"
            : paragraph.align === "right"
              ? "left"
              : paragraph.align,
      };
    } else if (paragraph.direction === "rtl") {
      paragraph = { ...paragraph, direction: "auto" };
    }
    // Fit: measure at the current size; shrink if the text no longer fits its original box.
    const runs = set.runs as TextNode["runs"];
    const measureAt = async (size: number) =>
      (
        await host.measure([
          {
            text: runs,
            style: { ...style, fontSize: size },
            paragraph,
            ...(node.autoResize === "width" ? {} : { width: node.width }),
          },
        ])
      )[0];
    let size = style.fontSize;
    let m = await measureAt(size);
    const limitW = node.autoResize === "width" ? Math.max(node.width * 1.08, 1) : node.width;
    const limitH = node.height * 1.05;
    const fits = (r: typeof m) => !!r && r.w <= limitW + 0.5 && r.h <= limitH + 0.5;
    if (!fits(m)) {
      let lo = size * minScale;
      let hi = size;
      if (fits(await measureAt(lo))) {
        for (let i = 0; i < 12 && hi - lo > 0.25; i++) {
          const mid = (lo + hi) / 2;
          if (fits(await measureAt(mid))) lo = mid;
          else hi = mid;
        }
        size = Math.floor(lo * 4) / 4;
      } else {
        size = Math.round(lo * 4) / 4;
      }
      m = await measureAt(size);
      if (size < style.fontSize) report.shrunk.push(id);
      style = { ...style, fontSize: size };
    }
    if (style !== node.style) set.style = style;
    if (paragraph !== node.paragraph) set.paragraph = paragraph;
    if (m) {
      if (node.autoResize === "width") {
        set.width = Math.ceil(m.w);
        set.height = Math.ceil(m.h);
      } else if (node.autoResize === "height" || m.h > node.height) {
        set.height = Math.ceil(m.h);
        if (m.h > node.height + 0.5) report.grown.push(id);
      }
    }
    report.ops.push({ op: "update", id, set });
  }
  if (rtl && options.mirror !== false) {
    // Mirror top-level blocks around the page's vertical axis (full-bleed backdrops stay put).
    for (const childId of childIds(design, page.id)) {
      const n = getNode(design, childId) as Node;
      if (n.width >= page.width * 0.9 || n.role === "background" || n.locked) continue;
      const x = Math.round((page.width - n.x - n.width) * 100) / 100;
      if (Math.abs(x - n.x) < 0.5) continue;
      report.ops.push({ op: "update", id: childId, set: { x } });
      report.mirrored.push(childId);
    }
  }
  return report;
}
