// Text tools: exact replacement, model-assisted rewriting within the box, and translation with relayout.

import { getNode, pageOf } from "@desyn/doc-ops";
import type { Id, Op, TextNode } from "@desyn/schema";
import { generateText, Output } from "ai";
import { z } from "zod";
import { collectTexts, relayoutTranslations, translateTexts } from "../design/localize";
import { measureText } from "../design/measure";
import { textOf } from "../design/paint";
import { wrapUntrusted } from "../prompts/guard";
import { copySystemPrompt, isRtlLocale } from "../prompts/language";
import { measureTextNodes } from "./build";
import { commit } from "./commit";
import { designTool } from "./define";
import { issuesFor } from "./edit";
import { IdInput } from "./schemas";
import { type ToolContext, ToolInputError } from "./types";

/** Approximate characters that fit a text box at its current size. */
function capacity(node: TextNode): number {
  const sample = "The quick brown fox jumps over the lazy dog ";
  const m = measureText({ text: [{ text: sample }], style: node.style, paragraph: node.paragraph });
  const perChar = m.w / sample.length || node.style.fontSize * 0.5;
  const lineH = m.h || node.style.fontSize * 1.2;
  const lines =
    node.autoResize === "none" || node.maxLines
      ? Math.max(1, Math.floor((node.maxLines ? node.maxLines * lineH : node.height) / lineH))
      : Math.max(1, Math.round(node.height / lineH));
  return Math.max(4, Math.floor((node.width / perChar) * lines));
}

async function setTexts(ctx: ToolContext, items: { id: Id; text: string }[], label: string) {
  const design = ctx.host.getDesign();
  const ops: Op[] = [];
  const skipped: string[] = [];
  for (const item of items) {
    const node = getNode(design, item.id);
    if (node?.type !== "text") {
      skipped.push(`${item.id}: not a text element`);
      continue;
    }
    if (node.locked) {
      skipped.push(`${item.id}: locked`);
      continue;
    }
    const style = node.runs[0]?.style;
    const runs = [style ? { text: item.text, style } : { text: item.text }];
    const next = { ...node, runs } as TextNode;
    await measureTextNodes(ctx.host, [next]);
    const set: Record<string, unknown> = { runs };
    if (next.width !== node.width) set.width = next.width;
    if (next.height !== node.height) set.height = next.height;
    ops.push({ op: "update", id: item.id, set });
  }
  if (ops.length === 0) throw new ToolInputError(`Nothing to change. ${skipped.join("; ")}`);
  const { diff } = await commit(ctx, ops, label);
  const warnings = await issuesFor(
    ctx,
    diff.updated.map((u) => u.id),
  );
  return { diff, skipped, warnings };
}

const rewriteSchema = z.object({ items: z.array(z.object({ id: z.string(), text: z.string() })) });

export function textTools(ctx: ToolContext) {
  return {
    set_text: designTool(ctx, {
      description:
        "Replace the text of text elements exactly (keeps their styling; boxes are re-measured). Use for copy you have written yourself.",
      inputSchema: z.object({
        items: z
          .array(z.object({ id: IdInput, text: z.string() }))
          .min(1)
          .max(100),
      }),
      async execute(input) {
        const { diff, skipped, warnings } = await setTexts(ctx, input.items, "Edit text");
        return {
          ok: true,
          summary: `Updated ${diff.updated.length} text element(s).`,
          ...(skipped.length ? { skipped } : {}),
          ...(warnings.length ? { warnings } : {}),
        };
      },
    }),

    rewrite_text: designTool(ctx, {
      description:
        "Rewrite existing text with the copywriting model following an instruction (shorter, punchier, more formal, add urgency…). Respects each box's capacity unless maxChars is given.",
      inputSchema: z.object({
        ids: z.array(IdInput).min(1).max(40),
        instruction: z.string().min(2),
        tone: z.string().optional(),
        maxChars: z.number().int().positive().optional(),
      }),
      async execute(input) {
        const routed = ctx.models?.copy;
        if (!routed)
          throw new ToolInputError(
            "No copywriting model is configured for this run.",
            "Write the copy yourself and use set_text.",
          );
        const design = ctx.host.getDesign();
        const nodes = input.ids
          .map((id) => getNode(design, id))
          .filter((n): n is TextNode => n?.type === "text");
        if (nodes.length === 0) throw new ToolInputError("None of these ids are text elements.");
        const items = nodes.map((n) => ({
          id: n.id,
          role: n.role ?? "text",
          maxChars: input.maxChars ?? capacity(n),
          text: textOf(n),
        }));
        const { output } = await generateText({
          model: routed.model,
          instructions: copySystemPrompt(design.kind),
          output: Output.object({ schema: rewriteSchema }),
          prompt: [
            `Instruction: ${input.instruction}`,
            input.tone ? `Tone: ${input.tone}` : "",
            ctx.host.brand?.voice
              ? `Brand voice:\n${wrapUntrusted("brand-voice", ctx.host.brand.voice)}`
              : "",
            "Rewrite each item; stay within maxChars; keep the same language unless told otherwise; return every id.",
            wrapUntrusted("design-text", JSON.stringify(items)),
          ]
            .filter(Boolean)
            .join("\n"),
          temperature: 0.7,
          ...(ctx.signal ? { abortSignal: ctx.signal } : {}),
        });
        const wanted = new Set(items.map((i) => i.id));
        const rewritten = output.items.filter((i) => wanted.has(i.id) && i.text.trim().length > 0);
        if (rewritten.length === 0)
          throw new ToolInputError("The copy model returned no usable text.");
        const { diff, warnings } = await setTexts(ctx, rewritten, "Rewrite text");
        ctx.meter?.charge("copy", routed.billing, { ref: ctx.run.runId });
        return {
          ok: true,
          summary: `Rewrote ${diff.updated.length} text element(s).`,
          before: items.map((i) => ({ id: i.id, text: wrapUntrusted("design-text", i.text) })),
          after: rewritten,
          ...(warnings.length ? { warnings } : {}),
        };
      },
    }),

    translate_text: designTool(ctx, {
      description:
        "Translate text into another language in place, with length-aware relayout: keeps names/URLs/numbers, fits text into its box (shrinks up to 15 %, then grows height), swaps in fonts for non-Latin scripts and mirrors the layout for RTL languages. For a separate copy per language use run_workflow('localize').",
      inputSchema: z.object({
        locale: z.string().min(2).describe("BCP 47 locale, e.g. de-DE, fr, ja, ar"),
        ids: z.array(IdInput).optional().describe("default: every text element on the page"),
        pageId: IdInput.optional(),
        mirror: z.boolean().optional().describe("mirror the layout for RTL (default true)"),
        glossary: z.array(z.object({ term: z.string(), translation: z.string() })).optional(),
      }),
      async execute(input) {
        const routed = ctx.models?.translate;
        if (!routed) throw new ToolInputError("No translation model is configured for this run.");
        const design = ctx.host.getDesign();
        const pageId = input.pageId ?? ctx.host.page;
        const items = collectTexts(
          design,
          input.ids ? { ids: input.ids } : { rootId: pageId ?? "root" },
        );
        if (items.length === 0) throw new ToolInputError("There is no text to translate.");
        const translations = await translateTexts(routed.model, items, input.locale, {
          ...(ctx.signal ? { signal: ctx.signal } : {}),
          ...(input.glossary
            ? { glossary: Object.fromEntries(input.glossary.map((g) => [g.term, g.translation])) }
            : {}),
        });
        const page = pageOf(design, items[0]?.id as Id);
        if (!page) throw new ToolInputError("Text must be on a page.");
        const report = await relayoutTranslations(ctx.host, design, page, translations, {
          locale: input.locale,
          ...(input.mirror !== undefined ? { mirror: input.mirror } : {}),
        });
        const ops: Op[] = [
          ...report.ops,
          { op: "doc", set: { meta: { ...design.meta, locale: input.locale } } },
        ];
        await commit(ctx, ops, `Translate to ${input.locale}`);
        ctx.meter?.charge("translate", routed.billing, { ref: ctx.run.runId });
        const warnings = await issuesFor(ctx, [...translations.keys()]);
        return {
          ok: true,
          summary: `Translated ${translations.size} text element(s) to ${input.locale}${isRtlLocale(input.locale) ? " (RTL, layout mirrored)" : ""}.`,
          shrunk: report.shrunk,
          grown: report.grown,
          fontSwaps: report.fontSwaps,
          mirrored: report.mirrored.length,
          ...(warnings.length ? { warnings } : {}),
        };
      },
    }),
  };
}
