// Generate a complete design as editable layers: plan (structured brief from the planning model) -> assets in
// parallel (outside the tool loop, so they overlap) -> build with the agent (create_elements) -> render ->
// critique -> fix rounds -> finish.
import { pages } from "@desyn/doc-ops";
import {
  type AssetRef,
  DESIGN_KINDS,
  type DesignKind,
  FONT_PAIRINGS,
  getPreset,
  type Id,
  newId,
} from "@desyn/schema";
import { generateText, type LanguageModel, Output } from "ai";
import { z } from "zod";
import { CreditMeter } from "../credits";
import { errorMessage } from "../errors";
import type { DocHost } from "../host";
import type { Media } from "../media/types";
import { brandSummary } from "../prompts/brand";
import { ALL_PRINCIPLES } from "../prompts/design";
import { fontPairingText } from "../prompts/fonts";
import { kindGuideText } from "../prompts/kinds";
import { COPYWRITING } from "../prompts/language";
import { createIconify } from "../search/icons";
import { uploadResult } from "../tools/assets";
import { commit } from "../tools/commit";
import { createRunState, type SearchProviders, type ToolContext } from "../tools/types";
import { mapLimit } from "../util/async";
import type { AgentEvent } from "./events";
import { type RunAgentOptions, type RunAgentResult, runAgent } from "./run";
import { routeText, setupMedia } from "./setup";

export const DesignPlanSchema = z.object({
  title: z.string(),
  kind: z.enum(DESIGN_KINDS),
  preset: z.string().optional().describe("page preset id when one fits"),
  width: z.number().positive(),
  height: z.number().positive(),
  message: z.string().describe("the one thing the design must communicate"),
  audience: z.string(),
  mood: z.string(),
  palette: z
    .array(
      z.object({
        color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
        role: z.enum([
          "background",
          "surface",
          "primary",
          "secondary",
          "accent",
          "text",
          "neutral",
        ]),
      }),
    )
    .min(3)
    .max(7),
  fonts: z.object({
    heading: z.string(),
    body: z.string(),
    headingWeight: z.number(),
    bodyWeight: z.number(),
  }),
  grid: z.object({
    columns: z.number().int().min(1).max(24),
    margin: z.number().min(0),
    gutter: z.number().min(0),
  }),
  typeScale: z.object({
    headline: z.number(),
    subhead: z.number(),
    body: z.number(),
    caption: z.number(),
  }),
  layout: z
    .string()
    .describe("archetype and placement of every block with approximate coordinates"),
  copy: z.object({
    eyebrow: z.string().optional(),
    headline: z.string(),
    subhead: z.string().optional(),
    body: z.string().optional(),
    cta: z.string().optional(),
    details: z.array(z.string()).optional(),
  }),
  assets: z
    .array(
      z.object({
        id: z.string(),
        kind: z.enum(["photo", "illustration", "vector", "icon", "stock"]),
        prompt: z.string().describe("generation prompt, or search query for stock/icon"),
        role: z.string(),
        aspect: z
          .string()
          .regex(/^\d+:\d+$/)
          .describe("e.g. 4:5"),
        withText: z.boolean().optional(),
      }),
    )
    .max(6),
});
export type DesignPlan = z.output<typeof DesignPlanSchema>;

export interface GenerateDesignOptions extends Omit<RunAgentOptions, "goal" | "mode"> {
  prompt: string;
  /** Planning model override (tests); default the "plan" route. */
  planModel?: LanguageModel;
  /** Preferred kind when the prompt does not imply one (default: the design's kind). */
  kind?: DesignKind;
  /** Max parallel asset generations (default 3). */
  assetConcurrency?: number;
}

export interface GeneratedAsset {
  planId: string;
  role: string;
  assetId?: Id;
  kind: string;
  error?: string;
}

export interface GenerateDesignResult extends RunAgentResult {
  brief?: DesignPlan;
  assets: GeneratedAsset[];
}

function planInstructions(kind: DesignKind, host: DocHost): string {
  return [
    "You are the creative director planning a single design. Produce a complete, specific brief that a designer can build without further questions.",
    "Rules: real, concise copy (no lorem ipsum, no invented facts — use clear placeholders like 'Venue, City' when facts are missing); a palette with clear value contrast that passes WCAG for text; fonts from the pairing list (or the brand fonts); exact type sizes in px for the page size; margins on the 8-px grid; at most 4 assets and only those that add real value (often 1 hero visual).",
    ALL_PRINCIPLES,
    COPYWRITING,
    kindGuideText(kind),
    fontPairingText(kind, 14),
    brandSummary(host.brand),
    `Available kinds: ${DESIGN_KINDS.join(", ")}. Pairings: ${FONT_PAIRINGS.length} curated options listed above.`,
  ].join("\n\n");
}

function aspectSize(aspect: string, long = 1536) {
  const [a, b] = aspect.split(":").map(Number) as [number, number];
  const r = a / b;
  return r >= 1
    ? { width: long, height: Math.round(long / r) }
    : { width: Math.round(long * r), height: long };
}

async function produceAsset(
  asset: DesignPlan["assets"][number],
  plan: DesignPlan,
  ctx: ToolContext,
  media: Media | undefined,
  search: SearchProviders | undefined,
): Promise<AssetRef> {
  const palette = plan.palette.map((p) => p.color.toLowerCase());
  if (asset.kind === "stock") {
    if (!search?.stock) throw new Error("stock search is not configured");
    const results = await search.stock.search({
      query: asset.prompt,
      count: 6,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
    const pick = results[0];
    if (!pick) throw new Error(`no stock photo for "${asset.prompt}"`);
    const file = await search.stock.download(pick, ctx.signal);
    return ctx.host.assets.upload(file.bytes, file.mime, {
      name: pick.description.slice(0, 60) || "Stock photo",
      source: "stock",
      width: pick.width,
      height: pick.height,
      attribution: { author: pick.author, license: pick.license, url: pick.sourceUrl },
    });
  }
  if (asset.kind === "icon") {
    const icons = search?.icons ?? createIconify(ctx.fetch ? { fetch: ctx.fetch } : {});
    const found = await icons.search(asset.prompt, {
      limit: 1,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
    if (!found[0]) throw new Error(`no icon for "${asset.prompt}"`);
    const markup = await icons.svg(found[0].id, {
      color:
        plan.palette.find((p) => p.role === "accent")?.color.toLowerCase() ??
        palette[0] ??
        "#111111",
    });
    return ctx.host.assets.upload(new TextEncoder().encode(markup), "image/svg+xml", {
      name: found[0].id,
      kind: "svg",
      source: "stock",
      width: 24,
      height: 24,
    });
  }
  if (!media) throw new Error("media generation is not configured");
  if (asset.kind === "vector" && asset.role === "icon") {
    const svg = await media.generateSvg({
      prompt: asset.prompt,
      kind: "icon",
      palette,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
    return uploadResult(ctx, svg, { name: asset.prompt.slice(0, 40), kind: "svg" });
  }
  const [result] = await media.generateImage({
    prompt: asset.prompt,
    ...aspectSize(asset.aspect),
    style: asset.kind === "photo" ? "photo" : asset.kind === "vector" ? "flat" : "illustration",
    ...(asset.kind === "vector" ? { vector: true } : {}),
    ...(asset.withText ? { withText: true } : {}),
    palette,
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  });
  if (!result) throw new Error("no image returned");
  return uploadResult(ctx, result, { name: asset.prompt.slice(0, 40) });
}

function buildGoal(
  prompt: string,
  plan: DesignPlan,
  assets: GeneratedAsset[],
  design: { width: number; height: number },
): string {
  const ready = assets
    .filter((a) => a.assetId)
    .map((a) => `- ${a.assetId}: ${a.kind} for role "${a.role}" (plan asset ${a.planId})`);
  const failed = assets.filter((a) => a.error).map((a) => `- ${a.planId} (${a.role}): ${a.error}`);
  return [
    `Create this design: ${prompt}`,
    "",
    `The page is ${design.width}x${design.height} px. Build exactly this brief as editable layers (it is already recorded as your plan):`,
    JSON.stringify({ ...plan, assets: undefined }, null, 1),
    "",
    ready.length
      ? `Assets are uploaded and ready (use these asset ids in image/svg elements):\n${ready.join("\n")}`
      : "No image assets were produced; compose with shapes, type and color.",
    failed.length
      ? `Assets that failed (work around them, do not retry more than once):\n${failed.join("\n")}`
      : "",
    "",
    "Steps: build background → visuals → text hierarchy → details/CTA in as few create_elements calls as possible; then render_preview; then critique; fix the important findings; then finish.",
  ]
    .filter((l) => l !== undefined)
    .join("\n");
}

export async function generateDesign(
  options: GenerateDesignOptions,
): Promise<GenerateDesignResult> {
  const runId = options.runId ?? newId();
  const meter = options.meter ?? new CreditMeter(options.budget?.credits ?? null);
  const emit = (event: AgentEvent) => {
    try {
      options.onEvent?.(event);
    } catch {
      // listeners never break the run
    }
  };
  const host = options.host;
  const design = host.getDesign();
  const kind = options.kind ?? design.kind;
  const assets: GeneratedAsset[] = [];

  // 1. Plan.
  emit({ type: "progress", runId, label: "Planning the design" });
  const routedPlan =
    !options.planModel && options.providers
      ? routeText("plan", {
          providers: options.providers,
          ...(options.prefs ? { prefs: options.prefs } : {}),
        })
      : undefined;
  const planModel = options.planModel ?? routedPlan?.model ?? options.model;
  if (!planModel) throw new Error("generateDesign needs providers or a planModel/model.");
  const page = pages(design).find((p) => p.id === host.page) ?? pages(design)[0];
  let plan: DesignPlan | undefined;
  let planCharged = false;
  try {
    const { output } = await generateText({
      model: planModel,
      instructions: planInstructions(kind, host),
      output: Output.object({ schema: DesignPlanSchema }),
      prompt: `Design request: ${options.prompt}\nPage: ${page?.width}x${page?.height} px (${kind}). Plan for this page size unless the request clearly needs a different format.`,
      temperature: 0.7,
      ...(options.signal ? { abortSignal: options.signal } : {}),
    });
    plan = output;
    meter.charge("generateDesign", routedPlan?.billing ?? "platform", { ref: runId });
    planCharged = true;
  } catch (error) {
    emit({
      type: "error",
      runId,
      message: `Planning failed: ${errorMessage(error)}`,
      recoverable: true,
    });
  }

  const ctx: ToolContext = {
    host,
    run: createRunState(runId, "generate"),
    meter,
    emit,
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
  };

  if (plan && page) {
    emit({
      type: "plan",
      runId,
      steps: [
        { id: "plan", title: `Brief: ${plan.title}`, status: "done" },
        { id: "assets", title: `Assets (${plan.assets.length})`, status: "in-progress" },
        { id: "build", title: "Build layers", status: "pending" },
        { id: "review", title: "Render, critique and refine", status: "pending" },
      ],
    });
    // Resize an empty page to the planned format; otherwise keep the user's page.
    const preset = plan.preset ? getPreset(plan.preset) : undefined;
    const target = preset
      ? { width: preset.width, height: preset.height }
      : { width: Math.round(plan.width), height: Math.round(plan.height) };
    if (
      page.children.length === 0 &&
      (Math.abs(target.width - page.width) > 1 || Math.abs(target.height - page.height) > 1) &&
      plan.kind === kind
    ) {
      await commit(
        ctx,
        [
          {
            op: "update",
            id: page.id,
            set: {
              width: target.width,
              height: target.height,
              ...(preset ? { unit: preset.unit, bleed: preset.bleed ?? 0 } : {}),
            },
          },
        ],
        "Set page size",
      );
    }
    // 2. Assets in parallel.
    const media =
      options.media === false
        ? undefined
        : (options.media ??
          (options.providers
            ? setupMedia({
                providers: options.providers,
                ...(options.prefs ? { prefs: options.prefs } : {}),
                ...(options.moderation ? { moderation: options.moderation } : {}),
                meter,
                ...(options.fetch ? { fetch: options.fetch } : {}),
                runId,
                emit,
              })
            : undefined));
    const produced = await mapLimit(plan.assets, options.assetConcurrency ?? 3, async (asset) => {
      try {
        const ref = await produceAsset(asset, plan as DesignPlan, ctx, media, options.search);
        return { planId: asset.id, role: asset.role, kind: asset.kind, ref } as const;
      } catch (error) {
        return {
          planId: asset.id,
          role: asset.role,
          kind: asset.kind,
          error: errorMessage(error),
        } as const;
      }
    });
    const refs = produced.flatMap((p) => ("ref" in p && p.ref ? [p.ref] : []));
    if (refs.length > 0)
      await commit(
        ctx,
        [{ op: "asset", set: Object.fromEntries(refs.map((r) => [r.id, r])) }],
        "Add generated assets",
      );
    for (const p of produced)
      assets.push({
        planId: p.planId,
        role: p.role,
        kind: p.kind,
        ...("ref" in p && p.ref ? { assetId: p.ref.id } : {}),
        ...("error" in p && p.error ? { error: p.error } : {}),
      });
  }

  // 3–6. Build, render, critique, fix and finish with the agent.
  const current =
    pages(host.getDesign()).find((p) => p.id === host.page) ?? pages(host.getDesign())[0];
  const goal =
    plan && current
      ? buildGoal(options.prompt, plan, assets, current)
      : `Create this design: ${options.prompt}`;
  // Turns are covered by the single generateDesign charge (when planning succeeded); media is billed per asset.
  const result = await runAgent({
    ...options,
    runId,
    mode: "generate",
    goal,
    meter,
    // When planning failed nothing was billed yet, so the agent's turns are charged instead.
    chargeTurns: !planCharged,
  });
  // Earlier commits (page size, assets) are part of the same run.
  result.transactions.unshift(...ctx.run.transactions);
  return { ...result, ...(plan ? { brief: plan } : {}), assets };
}
