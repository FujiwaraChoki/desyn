// Run control tools: plan (with checkpoints), ask_user (pauses the run), run_workflow (durable jobs), finish.
import { tool } from "ai";
import { z } from "zod";
import { designTool } from "./define";
import { ColorInput } from "./schemas";
import { type PlanStep, type ToolContext, ToolInputError } from "./types";

const BriefInput = z.object({
  kind: z.string().optional(),
  size: z.object({ width: z.number(), height: z.number() }).optional(),
  audience: z.string().optional(),
  message: z.string().optional().describe("the one thing the design must communicate"),
  mood: z.string().optional(),
  palette: z.array(ColorInput).max(8).optional(),
  fonts: z.object({ heading: z.string(), body: z.string() }).optional(),
  layout: z
    .string()
    .optional()
    .describe(
      "chosen archetype and grid, e.g. 'hero image top 60%, headline bottom-left, 6-col grid, 72px margins'",
    ),
  copy: z
    .object({
      eyebrow: z.string().optional(),
      headline: z.string().optional(),
      subhead: z.string().optional(),
      body: z.string().optional(),
      cta: z.string().optional(),
      details: z.array(z.string()).optional(),
    })
    .optional(),
  assets: z
    .array(
      z.object({
        id: z.string(),
        kind: z.enum(["photo", "illustration", "vector", "icon", "svg", "stock"]),
        prompt: z.string(),
        role: z.string().optional(),
      }),
    )
    .max(8)
    .optional(),
});

export type DesignBrief = z.output<typeof BriefInput>;

export function controlTools(ctx: ToolContext) {
  return {
    plan: designTool(ctx, {
      description:
        "Write or update the plan for this run: ordered steps (mark checkpoints where the result should be rendered and critiqued) and, for new designs, the brief (kind, size, message, palette, fonts, layout archetype, copy, asset list). Update step statuses as you go.",
      inputSchema: z.object({
        steps: z
          .array(
            z.object({
              id: z.string(),
              title: z.string(),
              detail: z.string().optional(),
              checkpoint: z.boolean().optional(),
            }),
          )
          .max(20)
          .optional(),
        updates: z
          .array(
            z.object({
              id: z.string(),
              status: z.enum(["pending", "in-progress", "done", "skipped"]),
            }),
          )
          .optional(),
        brief: BriefInput.optional(),
      }),
      async execute(input) {
        if (input.steps) {
          ctx.run.plan = input.steps.map((s): PlanStep => {
            const prev = ctx.run.plan.find((p) => p.id === s.id);
            return { ...s, status: prev?.status ?? "pending" };
          });
        }
        for (const u of input.updates ?? []) {
          const step = ctx.run.plan.find((p) => p.id === u.id);
          if (step) step.status = u.status;
        }
        if (input.brief) ctx.run.brief = { ...(ctx.run.brief ?? {}), ...input.brief };
        ctx.emit({
          type: "plan",
          runId: ctx.run.runId,
          steps: ctx.run.plan.map((s) => ({
            id: s.id,
            title: s.title,
            status: s.status,
            ...(s.checkpoint ? { checkpoint: true } : {}),
          })),
        });
        const done = ctx.run.plan.filter((s) => s.status === "done").length;
        const next = ctx.run.plan.find((s) => s.status === "pending" || s.status === "in-progress");
        return {
          ok: true,
          summary: `Plan: ${done}/${ctx.run.plan.length} done${next ? `; next: ${next.title}` : ""}.`,
          plan: ctx.run.plan,
          ...(ctx.run.brief ? { brief: ctx.run.brief } : {}),
        };
      },
    }),

    // No execute: calling it ends the step loop so the run pauses until the user answers.
    ask_user: tool({
      description:
        "Ask the user a question and pause the run. Use only when the request is ambiguous in a way that changes the result substantially, when required facts are missing (dates, prices, names you must not invent), or to confirm destructive bulk changes. Offer 2–4 short options when possible.",
      inputSchema: z.object({
        question: z.string().min(3),
        options: z.array(z.string()).max(6).default([]),
        reason: z.string().optional(),
      }),
    }),

    run_workflow: designTool(ctx, {
      description:
        "Start a durable multi-step workflow that runs in the background: campaign (brief → N designs across kinds/sizes), variants (A/B alternatives), resize (to many presets with smart reflow), localize (languages with RTL + relayout), bulk (CSV merge into template slots), exportBundle. Returns a workflow id and the credit estimate.",
      inputSchema: z.object({
        workflow: z.enum(["campaign", "variants", "resize", "localize", "bulk", "exportBundle"]),
        input: z
          .record(z.string(), z.unknown())
          .describe("workflow input; see the workflow's description in the system prompt"),
      }),
      async execute(input) {
        if (!ctx.workflows)
          throw new ToolInputError(
            "Workflows cannot be started from this context.",
            "Do the work directly with the editing tools, or tell the user to start it from the Workflows panel.",
          );
        const started = await ctx.workflows.start(input.workflow, {
          ...input.input,
          designId: ctx.host.getDesign().id,
        });
        return {
          ok: true,
          summary: `Started ${input.workflow} workflow ${started.workflowId} (≈${started.estimatedCredits} credits).${started.message ? ` ${started.message}` : ""}`,
          workflowId: started.workflowId,
          estimatedCredits: started.estimatedCredits,
        };
      },
    }),

    finish: designTool(ctx, {
      description:
        "Finish the run with a short summary for the user: what you changed (and why), anything you could not do, and up to 3 useful follow-ups.",
      inputSchema: z.object({
        summary: z.string().min(3).max(1200),
        changes: z.array(z.string()).max(20).default([]),
        followUps: z.array(z.string()).max(3).default([]),
      }),
      async execute(input) {
        ctx.run.finished = {
          summary: input.summary,
          changes: input.changes,
          followUps: input.followUps,
        };
        return { ok: true, summary: "Run finished." };
      },
    }),
  };
}
