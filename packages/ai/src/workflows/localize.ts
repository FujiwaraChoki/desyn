// localize: one translated copy of a design per locale, with length-aware relayout, script fonts and RTL mirroring.
import { pages } from "@desyn/doc-ops";
import { z } from "zod";
import { creditsFor, estimateCredits } from "../credits";
import { collectTexts, relayoutTranslations, translateTexts } from "../design/localize";
import { isRtlLocale } from "../prompts/language";
import { applyWorkflowOps, designLabel, textModel } from "./common";
import type { WorkflowDefinition } from "./types";

const LocalizeInput = z.object({
  designId: z.string(),
  locales: z.array(z.string().min(2).max(20)).min(1).max(30),
  glossary: z
    .array(z.object({ term: z.string(), translation: z.string(), locale: z.string().optional() }))
    .default([]),
  mirrorRtl: z.boolean().default(true),
});
export type LocalizeWorkflowInput = z.output<typeof LocalizeInput>;

export const localizeWorkflow: WorkflowDefinition<LocalizeWorkflowInput, Record<string, never>> = {
  kind: "localize",
  label: "Localize",
  inputSchema: LocalizeInput as unknown as z.ZodType<LocalizeWorkflowInput>,
  init(input) {
    return {
      data: {},
      steps: input.locales.map((locale) => ({
        id: `localize:${locale}`,
        type: "localize",
        label: `Translate to ${locale}`,
        params: { locale },
        optional: true,
      })),
    };
  },
  estimate(input) {
    return estimateCredits([
      { action: "localizeVariant", count: input.locales.length },
      { action: "translate", count: input.locales.length },
    ]);
  },
  async runStep(step, state, env) {
    const locale = String(step.params.locale);
    const translator = textModel(env, "translate", env.models?.translate);
    const source = await env.loadDesign(state.input.designId);
    const { designId, host } = await env.createDesign({
      name: designLabel(source, locale),
      kind: source.kind,
      from: source,
      locale,
      ...(source.brandKitId ? { brandKitId: source.brandKitId } : {}),
    });
    const design = host.getDesign();
    // One translation pass over every page keeps terminology consistent across pages.
    const items = pages(design).flatMap((p) => collectTexts(design, { rootId: p.id }));
    const glossary = Object.fromEntries(
      state.input.glossary
        .filter((g) => !g.locale || g.locale === locale)
        .map((g) => [g.term, g.translation]),
    );
    const translations = items.length
      ? await translateTexts(translator.model, items, locale, {
          glossary,
          ...(env.signal ? { signal: env.signal } : {}),
        })
      : new Map();
    const report = { shrunk: 0, grown: 0, mirrored: 0 };
    for (const page of pages(host.getDesign())) {
      const pageIds = new Set(collectTexts(host.getDesign(), { rootId: page.id }).map((i) => i.id));
      const pageTranslations = new Map([...translations].filter(([id]) => pageIds.has(id)));
      const r = await relayoutTranslations(host, host.getDesign(), page, pageTranslations, {
        locale,
        mirror: state.input.mirrorRtl,
      });
      report.shrunk += r.shrunk.length;
      report.grown += r.grown.length;
      report.mirrored += r.mirrored.length;
      await applyWorkflowOps(host, r.ops, `Translate page to ${locale}`, state.id);
    }
    await applyWorkflowOps(
      host,
      [
        {
          op: "doc",
          set: { name: designLabel(source, locale), meta: { ...host.getDesign().meta, locale } },
        },
      ],
      "Set locale",
      state.id,
    );
    const translateCost = translator.billing === "platform" ? creditsFor("translate") : 0;
    return {
      credits: creditsFor("localizeVariant") + translateCost,
      outputs: [
        {
          designId,
          label: `${locale}${isRtlLocale(locale) ? " (RTL)" : ""}`,
          kind: source.kind,
          locale,
        },
      ],
      result: { designId, texts: translations.size, ...report },
    };
  },
};
