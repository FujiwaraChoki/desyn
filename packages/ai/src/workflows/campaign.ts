// campaign: brief -> concept (one design system: message, palette, fonts, imagery, copy) -> shared key visual ->
// one design per deliverable (kind + size), each built by the agent from the same concept so the set is coherent.
import { type AssetRef, DESIGN_KINDS, type DesignKind, getPreset } from "@desyn/schema";
import { generateText, Output } from "ai";
import { z } from "zod";
import { creditsFor, estimateCredits } from "../credits";
import { brandSummary } from "../prompts/brand";
import { ALL_PRINCIPLES } from "../prompts/design";
import { fontPairingText } from "../prompts/fonts";
import { KIND_GUIDES } from "../prompts/kinds";
import { COPYWRITING } from "../prompts/language";
import { applyWorkflowOps, runSubAgent, textModel } from "./common";
import type { WorkflowDefinition } from "./types";

const Deliverable = z.object({
  kind: z.enum(DESIGN_KINDS),
  preset: z.string().optional(),
  width: z.number().positive().optional(),
  height: z.number().positive().optional(),
  name: z.string().optional(),
});

const CampaignInput = z.object({
  brief: z.string().min(5),
  deliverables: z.array(Deliverable).min(1).max(20),
  brandKitId: z.string().optional(),
  keyVisual: z
    .boolean()
    .default(true)
    .describe("generate one shared hero image for every deliverable"),
});
export type CampaignWorkflowInput = z.output<typeof CampaignInput>;

const ConceptSchema = z.object({
  name: z.string(),
  bigIdea: z.string(),
  message: z.string(),
  tagline: z.string(),
  audience: z.string(),
  tone: z.string(),
  palette: z
    .array(
      z.object({
        color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
        role: z.enum(["background", "surface", "primary", "secondary", "accent", "text"]),
      }),
    )
    .min(3)
    .max(6),
  fonts: z.object({ heading: z.string(), body: z.string() }),
  visualLanguage: z
    .string()
    .describe("shapes, image treatment, layout motifs repeated on every piece"),
  keyVisualPrompt: z
    .string()
    .describe("image generation prompt for the shared hero visual, leaving space for text"),
  copy: z.object({
    headline: z.string(),
    subhead: z.string(),
    cta: z.string(),
    details: z.array(z.string()),
  }),
  perDeliverable: z.array(
    z.object({ index: z.number().int(), headline: z.string(), notes: z.string() }),
  ),
});
export type CampaignConcept = z.output<typeof ConceptSchema>;

interface CampaignData {
  concept?: CampaignConcept;
  keyVisual?: AssetRef;
}

function deliverableLabel(d: z.output<typeof Deliverable>, i: number): string {
  if (d.name) return d.name;
  const preset = d.preset ? getPreset(d.preset) : undefined;
  return preset?.label ?? `${d.kind} ${i + 1}`;
}

export const campaignWorkflow: WorkflowDefinition<CampaignWorkflowInput, CampaignData> = {
  kind: "campaign",
  label: "Campaign",
  inputSchema: CampaignInput as unknown as z.ZodType<CampaignWorkflowInput>,
  init(input) {
    return {
      data: {},
      steps: [
        { id: "concept", type: "concept", label: "Concept and design system" },
        ...(input.keyVisual
          ? [{ id: "key-visual", type: "keyVisual", label: "Key visual", optional: true }]
          : []),
        ...input.deliverables.map((d, i) => ({
          id: `design:${i}`,
          type: "design",
          label: deliverableLabel(d, i),
          params: { index: i },
          optional: true,
        })),
      ],
    };
  },
  estimate(input) {
    return estimateCredits([
      { action: "campaignDesign", count: input.deliverables.length },
      ...(input.keyVisual ? [{ action: "image" as const }] : []),
    ]);
  },
  async runStep(step, state, env) {
    const input = state.input;
    if (step.type === "concept") {
      const { model } = textModel(env, "plan", env.models?.plan);
      const kinds = [...new Set(input.deliverables.map((d) => d.kind))] as DesignKind[];
      const { output } = await generateText({
        model,
        instructions: [
          "You are the creative director of a campaign. Define ONE coherent concept and design system that every deliverable shares, then adapt the headline per deliverable.",
          ALL_PRINCIPLES,
          COPYWRITING,
          fontPairingText(kinds[0] ?? "social-post", 14),
          brandSummary(env.brand),
          ...kinds.map((k) => `${k}: ${KIND_GUIDES[k].goal} Copy: ${KIND_GUIDES[k].copy}`),
          "Never invent facts (prices, dates, places); use explicit placeholders when the brief lacks them.",
        ].join("\n\n"),
        output: Output.object({ schema: ConceptSchema }),
        prompt: `Brief: ${input.brief}\nDeliverables:\n${input.deliverables.map((d, i) => `${i}. ${deliverableLabel(d, i)} (${d.kind}${d.preset ? `, ${d.preset}` : ""})`).join("\n")}`,
        temperature: 0.8,
        ...(env.signal ? { abortSignal: env.signal } : {}),
      });
      return {
        data: { ...state.data, concept: output },
        result: { name: output.name, bigIdea: output.bigIdea },
      };
    }
    const concept = state.data.concept;
    if (!concept) throw new Error("the concept step has not run");
    if (step.type === "keyVisual") {
      if (!env.media || !env.uploadAsset)
        return { result: { skipped: "media or asset storage not available" } };
      const [image] = await env.media.generateImage({
        prompt: concept.keyVisualPrompt,
        width: 1536,
        height: 1536,
        style: "photo",
        palette: concept.palette.map((p) => p.color.toLowerCase()),
        ...(env.signal ? { signal: env.signal } : {}),
      });
      if (!image?.bytes) throw new Error("no key visual returned");
      const asset = await env.uploadAsset(image.bytes, image.mime, {
        name: `${concept.name} key visual`,
        source: "ai",
        ai: { provider: image.provider, model: image.model, prompt: image.prompt.slice(0, 2000) },
        ...(image.width ? { width: image.width } : {}),
        ...(image.height ? { height: image.height } : {}),
      });
      return {
        data: { ...state.data, keyVisual: asset },
        credits: image.costCredits || creditsFor("image"),
        result: { assetId: asset.id },
      };
    }
    const index = Number(step.params.index);
    const d = input.deliverables[index];
    if (!d) throw new Error(`deliverable ${index} is missing`);
    const preset = d.preset ? getPreset(d.preset) : undefined;
    const label = deliverableLabel(d, index);
    const { designId, host } = await env.createDesign({
      name: `${concept.name} · ${label}`,
      kind: d.kind,
      ...(preset
        ? { preset: preset.id }
        : d.width && d.height
          ? { width: d.width, height: d.height }
          : {}),
      ...(input.brandKitId ? { brandKitId: input.brandKitId } : {}),
    });
    const kv = state.data.keyVisual;
    if (kv)
      await applyWorkflowOps(
        host,
        [{ op: "asset", set: { [kv.id]: kv } }],
        "Add key visual",
        state.id,
      );
    const adapt = concept.perDeliverable.find((p) => p.index === index);
    const goal = [
      `Design the "${label}" (${d.kind}) for the campaign "${concept.name}". It must look like part of one coherent set.`,
      `Big idea: ${concept.bigIdea}. Message: ${concept.message}. Tagline: ${concept.tagline}. Audience: ${concept.audience}. Tone: ${concept.tone}.`,
      `Design system (use exactly): palette ${concept.palette.map((p) => `${p.role} ${p.color.toLowerCase()}`).join(", ")}; fonts ${concept.fonts.heading} (headings) + ${concept.fonts.body} (body); visual language: ${concept.visualLanguage}.`,
      `Copy: headline "${adapt?.headline ?? concept.copy.headline}", subhead "${concept.copy.subhead}", CTA "${concept.copy.cta}"${concept.copy.details.length ? `, details: ${concept.copy.details.join(" | ")}` : ""}.`,
      adapt?.notes ? `Notes for this piece: ${adapt.notes}` : "",
      kv
        ? `Use the shared key visual (image asset ${kv.id}, ${kv.width}x${kv.height}) as the hero image with a crop that suits this format.`
        : "Compose with type, shapes and color (no shared image).",
      "Build it with create_elements, check it with render_preview and critique, fix important issues, then finish.",
    ]
      .filter(Boolean)
      .join("\n");
    const result = await runSubAgent(env, state, step, host, {
      mode: "generate",
      goal,
      chargeTurns: false,
      maxFixRounds: 1,
    });
    return {
      credits: creditsFor("campaignDesign") + result.credits,
      outputs: [{ designId, label, kind: d.kind, ...(d.preset ? { preset: d.preset } : {}) }],
      result: { designId, summary: result.summary },
    };
  },
};
