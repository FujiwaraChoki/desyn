// critique: rule-based lints from describe() combined with an optional vision review of the rendered page.
import type { Description, Issue } from "@desyn/schema";
import { generateText, Output } from "ai";
import { z } from "zod";
import { critiqueSystemPrompt } from "../prompts/critique";
import { wrapUntrusted } from "../prompts/guard";
import { designTool } from "./define";
import { compactDescription } from "./read";
import { IdInput } from "./schemas";
import type { ToolContext } from "./types";

const WEIGHT: Record<Issue["severity"], number> = { error: 12, warn: 5, info: 1 };

/** 0–100 score from lint issues (diminishing penalty per code so one repeated issue cannot zero the score). */
export function ruleScore(desc: Description): { score: number; byCode: Record<string, number> } {
  const byCode: Record<string, number> = {};
  for (const i of desc.issues) byCode[i.code] = (byCode[i.code] ?? 0) + 1;
  let penalty = 0;
  const seen: Record<string, number> = {};
  for (const i of desc.issues) {
    const n = (seen[i.code] ?? 0) + 1;
    seen[i.code] = n;
    penalty += WEIGHT[i.severity] / Math.sqrt(n);
  }
  return { score: Math.max(0, Math.round(100 - penalty)), byCode };
}

export const visionCritiqueSchema = z.object({
  score: z.number().min(0).max(10),
  verdict: z.string().describe("one sentence overall judgement"),
  strengths: z.array(z.string()).max(3),
  findings: z
    .array(
      z.object({
        severity: z.enum(["high", "medium", "low"]),
        area: z.enum([
          "hierarchy",
          "typography",
          "spacing",
          "alignment",
          "color",
          "contrast",
          "imagery",
          "copy",
          "brand",
          "composition",
          "production",
        ]),
        problem: z.string(),
        fix: z.string(),
        ids: z.array(z.string()).optional(),
      }),
    )
    .max(8),
});
export type VisionCritique = z.output<typeof visionCritiqueSchema>;

export function critiqueTools(ctx: ToolContext) {
  return {
    critique: designTool(ctx, {
      description:
        "Review the page: rule-based lints (contrast, tiny text, overflow, off-page, overlaps, alignment, spacing, fonts, colors, hierarchy, margins, image resolution, alt text) plus — when available — an art-director vision review of the render with concrete fixes. Use after building and after major edits; fix high-impact findings, then re-check.",
      inputSchema: z.object({
        pageId: IdInput.optional(),
        vision: z
          .boolean()
          .default(true)
          .describe("include the vision review when a critique model is configured"),
        focus: z
          .array(z.string())
          .optional()
          .describe("areas to emphasise, e.g. ['typography','spacing']"),
      }),
      async execute(input) {
        const pageId = input.pageId ?? ctx.host.page;
        const desc = await ctx.host.describe(pageId ? { pageId } : {});
        const rules = ruleScore(desc);
        ctx.run.critiques++;
        const compact = compactDescription(desc, { issues: 30 });
        let vision: VisionCritique | undefined;
        let visionError: string | undefined;
        const routed = ctx.models?.critique;
        if (input.vision && routed) {
          try {
            const render = await ctx.host.render({ ...(pageId ? { pageId } : {}), maxSize: 1024 });
            ctx.emit({
              type: "preview",
              runId: ctx.run.runId,
              mime: render.mime,
              width: render.width,
              height: render.height,
              bytes: render.bytes,
              ...(pageId ? { pageId } : {}),
            });
            const design = ctx.host.getDesign();
            const { output } = await generateText({
              model: routed.model,
              instructions: critiqueSystemPrompt(design.kind),
              output: Output.object({ schema: visionCritiqueSchema }),
              messages: [
                {
                  role: "user",
                  content: [
                    { type: "file", data: render.bytes, mediaType: render.mime },
                    {
                      type: "text",
                      text: [
                        `Page ${desc.page.width}x${desc.page.height} ${desc.page.unit}.`,
                        input.focus?.length ? `Focus on: ${input.focus.join(", ")}.` : "",
                        ctx.host.brand
                          ? `Brand: ${ctx.host.brand.name} (colors ${ctx.host.brand.colors.map((c) => c.value).join(", ")}; fonts ${ctx.host.brand.fonts.map((f) => f.family).join(", ")}).`
                          : "",
                        "Layer list (ids, boxes, text):",
                        wrapUntrusted("layers", JSON.stringify(compact.tree)),
                        `Automatic lint results: ${compact.issues.join(" | ") || "none"}`,
                      ]
                        .filter(Boolean)
                        .join("\n"),
                    },
                  ],
                },
              ],
              temperature: 0.2,
              ...(ctx.signal ? { abortSignal: ctx.signal } : {}),
            });
            vision = output;
            ctx.meter?.charge("agent.turn", routed.billing, { ref: `${ctx.run.runId}:critique` });
          } catch (error) {
            visionError = error instanceof Error ? error.message : String(error);
          }
        }
        const blocking = desc.issues.filter((i) => i.severity !== "info").length;
        const summary = vision
          ? `Rule score ${rules.score}/100, vision ${vision.score}/10: ${vision.verdict}`
          : `Rule score ${rules.score}/100 with ${desc.issues.length} issue(s) (${blocking} warnings/errors).`;
        return {
          ok: true,
          summary,
          ruleScore: rules.score,
          issueCounts: rules.byCode,
          issues: compact.issues,
          fixable: desc.issues
            .filter((i) => i.fix?.length)
            .slice(0, 10)
            .map((i) => ({ code: i.code, ids: i.ids, fix: i.fix })),
          ...(vision ? { vision } : {}),
          ...(visionError ? { visionError } : {}),
          hierarchy: compact.hierarchy,
          typography: compact.typography,
          margins: compact.grid.margins,
        };
      },
    }),
  };
}
