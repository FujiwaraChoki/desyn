// exportBundle: expands designs × formats into export jobs and runs them through the injected exporter (Convex
// `exports.request` + render worker). Without an exporter the jobs are returned as queued for the caller.
import { z } from "zod";
import { estimateCredits } from "../credits";
import type { ExportJob, WorkflowDefinition } from "./types";

const FormatInput = z.object({
  format: z.enum(["png", "jpeg", "webp", "svg", "pdf", "pptx", "gif", "mp4"]),
  scale: z.number().min(0.1).max(8).optional(),
  quality: z.number().min(1).max(100).optional(),
  pages: z.union([z.literal("all"), z.array(z.number().int().min(0))]).default("all"),
  pdf: z.object({ bleed: z.boolean(), cropMarks: z.boolean(), cmyk: z.boolean() }).optional(),
  background: z.string().optional(),
});

const ExportInput = z.object({
  designId: z.string().optional(),
  designIds: z.array(z.string()).max(100).default([]),
  formats: z.array(FormatInput).min(1).max(12),
});
export type ExportBundleInput = z.output<typeof ExportInput>;

/** Every export job of a bundle (one per design × format). */
export function exportJobs(input: ExportBundleInput): ExportJob[] {
  const ids = [...new Set([...(input.designId ? [input.designId] : []), ...input.designIds])];
  return ids.flatMap((designId) =>
    input.formats.map(
      (f, i): ExportJob => ({
        designId,
        format: f.format,
        pages: f.pages,
        name: `${designId}-${i + 1}.${f.format === "jpeg" ? "jpg" : f.format}`,
        ...(f.scale !== undefined ? { scale: f.scale } : {}),
        ...(f.quality !== undefined ? { quality: f.quality } : {}),
        ...(f.pdf ? { pdf: f.pdf } : {}),
        ...(f.background ? { background: f.background } : {}),
      }),
    ),
  );
}

export const exportBundleWorkflow: WorkflowDefinition<ExportBundleInput, Record<string, never>> = {
  kind: "exportBundle",
  label: "Export bundle",
  inputSchema: ExportInput.refine((i) => i.designId || i.designIds.length > 0, {
    message: "give designId or designIds",
  }) as unknown as z.ZodType<ExportBundleInput>,
  init(input) {
    return {
      data: {},
      steps: exportJobs(input).map((job, i) => ({
        id: `export:${i + 1}`,
        type: "export",
        label: `Export ${job.name}`,
        params: { job },
        optional: true,
      })),
    };
  },
  estimate() {
    // Exports are metered by the plan's export limits, not AI credits.
    return estimateCredits([]);
  },
  async runStep(step, _state, env) {
    const job = step.params.job as ExportJob;
    if (!env.exporter) {
      return {
        outputs: [
          {
            designId: job.designId,
            label: job.name,
            export: { format: job.format, status: "queued" },
          },
        ],
        result: { queued: job },
      };
    }
    const done = await env.exporter.export(job, env.signal);
    return {
      outputs: [
        {
          designId: job.designId,
          label: job.name,
          export: {
            format: job.format,
            status: "done",
            ...(done.url ? { url: done.url } : {}),
            ...(done.storageKey ? { storageKey: done.storageKey } : {}),
          },
        },
      ],
      result: done,
    };
  },
};
