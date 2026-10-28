// resize: copies a design to other sizes with smart reflow (roles, constraints, restacking), then repairs the
// mechanical issues (text overflow, off-page) automatically; an optional agent polish pass fixes the rest.
import { pages } from "@desyn/doc-ops";
import { getPreset, type Op } from "@desyn/schema";
import { z } from "zod";
import { creditsFor, estimateCredits } from "../credits";
import { reflowPage } from "../design/reflow";
import { applyWorkflowOps, designLabel, runSubAgent } from "./common";
import type { WorkflowDefinition } from "./types";

const ResizeInput = z
  .object({
    designId: z.string(),
    presets: z.array(z.string()).max(40).default([]),
    sizes: z
      .array(
        z.object({
          width: z.number().positive(),
          height: z.number().positive(),
          name: z.string().optional(),
        }),
      )
      .max(40)
      .default([]),
    pages: z.enum(["first", "all"]).default("all"),
    polish: z
      .boolean()
      .default(false)
      .describe("run the agent to fix remaining layout issues (uses agent credits)"),
  })
  .refine((i) => i.presets.length + i.sizes.length > 0, {
    message: "give at least one preset or size",
  })
  .refine((i) => i.presets.every((p) => getPreset(p)), { message: "unknown preset id" });
export type ResizeWorkflowInput = z.output<typeof ResizeInput>;

interface Target {
  key: string;
  label: string;
  width: number;
  height: number;
  preset?: string;
}

function targets(input: ResizeWorkflowInput): Target[] {
  return [
    ...input.presets.map((id) => {
      const p = getPreset(id);
      return {
        key: id,
        label: p?.label ?? id,
        width: p?.width ?? 0,
        height: p?.height ?? 0,
        preset: id,
      };
    }),
    ...input.sizes.map((s) => ({
      key: `${s.width}x${s.height}`,
      label: s.name ?? `${s.width}×${s.height}`,
      width: s.width,
      height: s.height,
    })),
  ];
}

export const resizeWorkflow: WorkflowDefinition<ResizeWorkflowInput, Record<string, never>> = {
  kind: "resize",
  label: "Magic resize",
  inputSchema: ResizeInput as unknown as z.ZodType<ResizeWorkflowInput>,
  init(input) {
    return {
      data: {},
      steps: targets(input).map((t) => ({
        id: `resize:${t.key}`,
        type: "resize",
        label: `Resize to ${t.label}`,
        params: { ...t },
        optional: true,
      })),
    };
  },
  estimate(input) {
    return estimateCredits([
      { action: "resizeVariant", count: targets(input).length },
      ...(input.polish
        ? [{ action: "agent.turn" as const, count: 12 * targets(input).length }]
        : []),
    ]);
  },
  async runStep(step, state, env) {
    const t = step.params as unknown as Target;
    const source = await env.loadDesign(state.input.designId);
    const preset = t.preset ? getPreset(t.preset) : undefined;
    const { designId, host } = await env.createDesign({
      name: designLabel(source, t.label),
      kind: preset?.kind ?? source.kind,
      from: source,
      ...(source.brandKitId ? { brandKitId: source.brandKitId } : {}),
    });
    const targetPages =
      state.input.pages === "first" ? pages(host.getDesign()).slice(0, 1) : pages(host.getDesign());
    for (const page of targetPages) {
      const { ops, layout } = await reflowPage(
        host.getDesign(),
        page.id,
        { width: t.width, height: t.height },
        { measure: (items) => host.measure(items) },
      );
      if (preset)
        ops.push({
          op: "update",
          id: page.id,
          set: { unit: preset.unit, bleed: preset.bleed ?? 0 },
        });
      await applyWorkflowOps(host, ops, `Resize to ${t.label} (${layout})`, state.id);
      // Mechanical repairs suggested by describe (text heights, off-page elements).
      const desc = await host.describe({ pageId: page.id });
      const fixes: Op[] = desc.issues
        .filter((i) => (i.code === "text-overflow" || i.code === "off-page") && i.fix?.length)
        .flatMap((i) => i.fix ?? []);
      if (fixes.length) await applyWorkflowOps(host, fixes, "Fix overflow after resize", state.id);
    }
    if (preset && host.getDesign().kind !== preset.kind)
      await applyWorkflowOps(
        host,
        [{ op: "doc", set: { kind: preset.kind } }],
        "Set kind",
        state.id,
      );
    let credits = creditsFor("resizeVariant");
    if (state.input.polish) {
      const r = await runSubAgent(env, state, step, host, {
        mode: "edit",
        goal: `This design was just resized to ${t.width}x${t.height} px (${t.label}). Fix layout problems introduced by the resize — overlaps, text overflow, cramped margins, unbalanced spacing, weak hierarchy — without changing any copy, images or colors. Keep changes minimal.`,
        maxSteps: 14,
      });
      credits += r.credits;
    }
    return {
      credits,
      outputs: [
        {
          designId,
          label: t.label,
          kind: preset?.kind ?? source.kind,
          ...(t.preset ? { preset: t.preset } : {}),
        },
      ],
      result: { designId },
    };
  },
};
