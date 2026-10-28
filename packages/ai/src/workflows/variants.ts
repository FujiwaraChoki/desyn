// variants: A/B alternatives with controlled differences. A planning call proposes deliberately distinct
// directions along one axis (copy, color, layout or image); each variant is a copy edited by the agent that may
// change only that axis.
import { generateText, Output } from "ai";
import { z } from "zod";
import { creditsFor, estimateCredits } from "../credits";
import { describeDesign } from "../design/describe";
import { wrapUntrusted } from "../prompts/guard";
import { compactNode } from "../tools/read";
import { applyWorkflowOps, designLabel, runSubAgent, textModel, VARIANT_LETTERS } from "./common";
import type { WorkflowDefinition } from "./types";

const VariantsInput = z.object({
  designId: z.string(),
  count: z.number().int().min(1).max(8).default(2),
  axis: z.enum(["copy", "color", "layout", "image"]),
  keep: z
    .array(z.string())
    .default([])
    .describe("roles that must stay identical, e.g. ['logo','price']"),
  instructions: z.string().optional(),
});
export type VariantsWorkflowInput = z.output<typeof VariantsInput>;

interface VariantsData {
  directions: { name: string; direction: string }[];
}

const AXIS_RULES: Record<VariantsWorkflowInput["axis"], string> = {
  copy: "Change only text content (headline, subhead, CTA wording, tone). Keep layout, colors, fonts, images and sizes. Re-check that text still fits.",
  color:
    "Change only colors (backgrounds, fills, text colors, accents) while keeping contrast AA. Keep layout, copy, fonts and images.",
  layout:
    "Change only arrangement: positions, sizes, alignment, composition and hierarchy emphasis. Keep copy, colors, fonts and images.",
  image:
    "Change only imagery: replace or regenerate photos/illustrations (generate_image with placement.targetId) and their crops. Keep layout, copy, colors and fonts.",
};

const directionsSchema = z.object({
  directions: z.array(z.object({ name: z.string(), direction: z.string() })),
});

export const variantsWorkflow: WorkflowDefinition<VariantsWorkflowInput, VariantsData> = {
  kind: "variants",
  label: "A/B variants",
  inputSchema: VariantsInput as unknown as z.ZodType<VariantsWorkflowInput>,
  init(input) {
    return {
      data: { directions: [] },
      steps: [
        {
          id: "directions",
          type: "directions",
          label: `Plan ${input.count} ${input.axis} directions`,
        },
        ...Array.from({ length: input.count }, (_, i) => ({
          id: `variant:${VARIANT_LETTERS[i]}`,
          type: "variant",
          label: `Variant ${VARIANT_LETTERS[i]}`,
          params: { index: i },
          optional: true,
        })),
      ],
    };
  },
  estimate(input) {
    return estimateCredits([
      { action: "copy", count: 1 },
      { action: "agent.turn", count: input.count * 10 },
      ...(input.axis === "image" ? [{ action: "image" as const, count: input.count }] : []),
    ]);
  },
  async runStep(step, state, env) {
    const input = state.input;
    if (step.type === "directions") {
      const source = await env.loadDesign(input.designId);
      const desc = describeDesign(source);
      const { model, billing } = textModel(env, "copy", env.models?.copy);
      const { output } = await generateText({
        model,
        instructions:
          "You are an experienced growth designer planning A/B test variants. Propose clearly distinct, testable directions along one axis only; each is a concrete brief another designer can execute.",
        output: Output.object({ schema: directionsSchema }),
        prompt: [
          `Axis: ${input.axis}. ${AXIS_RULES[input.axis]}`,
          `Number of directions: ${input.count}.`,
          input.keep.length ? `Never change elements with roles: ${input.keep.join(", ")}.` : "",
          input.instructions ? `Extra guidance from the user: ${input.instructions}` : "",
          `Design (${source.kind}):`,
          wrapUntrusted("design", JSON.stringify(desc.tree.map(compactNode))),
        ]
          .filter(Boolean)
          .join("\n"),
        temperature: 0.9,
        ...(env.signal ? { abortSignal: env.signal } : {}),
      });
      return {
        data: { directions: output.directions.slice(0, input.count) },
        credits: billing === "platform" ? creditsFor("copy") : 0,
        result: output.directions,
      };
    }
    const index = Number(step.params.index);
    const letter = VARIANT_LETTERS[index] ?? String(index + 1);
    const direction = state.data.directions[index] ?? {
      name: `Variant ${letter}`,
      direction: `An alternative ${input.axis} treatment.`,
    };
    const source = await env.loadDesign(input.designId);
    const { designId, host } = await env.createDesign({
      name: designLabel(source, `Variant ${letter}`),
      kind: source.kind,
      from: source,
      ...(source.brandKitId ? { brandKitId: source.brandKitId } : {}),
    });
    const result = await runSubAgent(env, state, step, host, {
      mode: "edit",
      goal: [
        `Create A/B variant ${letter} — "${direction.name}": ${direction.direction}`,
        `Controlled difference: ${AXIS_RULES[input.axis]}`,
        input.keep.length ? `Do not touch elements with roles: ${input.keep.join(", ")}.` : "",
        "Everything else must stay exactly as it is. Finish with a one-line description of the variant.",
      ]
        .filter(Boolean)
        .join("\n"),
      allowDestructive: false,
      temperature: 0.7,
    });
    await applyWorkflowOps(
      host,
      [
        {
          op: "doc",
          set: {
            meta: {
              ...host.getDesign().meta,
              variant: { of: input.designId, letter, axis: input.axis, name: direction.name },
            },
          },
        },
      ],
      "Tag variant",
      state.id,
    );
    return {
      credits: result.credits,
      outputs: [{ designId, label: `Variant ${letter}: ${direction.name}`, kind: source.kind }],
      result: { designId, summary: result.summary },
    };
  },
};
