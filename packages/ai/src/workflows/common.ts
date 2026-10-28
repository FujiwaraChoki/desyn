// Helpers shared by workflow definitions: transactions with source "workflow", agent sub-runs, model routing.
import { type Design, newId, type Op, type Transaction } from "@desyn/schema";
import type { LanguageModel } from "ai";
import { type RunAgentOptions, type RunAgentResult, runAgent } from "../agent/run";
import { routeText } from "../agent/setup";
import { CreditMeter } from "../credits";
import { AiError } from "../errors";
import type { DocHost } from "../host";
import type { AiTask } from "../models";
import type { Billing } from "../providers/types";
import type { WorkflowEnv, WorkflowState, WorkflowStep } from "./types";

export async function applyWorkflowOps(
  host: DocHost,
  ops: Op[],
  label: string,
  workflowId: string,
): Promise<void> {
  if (ops.length === 0) return;
  const tx: Transaction = {
    id: newId(),
    label,
    ops,
    source: "workflow",
    actor: { runId: workflowId, agent: "desyn-workflow" },
    ts: Date.now(),
  };
  const result = await host.apply(tx);
  if (result.applied.length === 0) {
    throw new Error(
      `${label}: no changes could be applied (${result.dropped.map((d) => d.reason).join(", ")})`,
    );
  }
}

export function meterOf(env: WorkflowEnv): CreditMeter {
  return env.meter ?? new CreditMeter(null);
}

/** Routed text model for a task: explicit env.models first, then providers. */
export function textModel(
  env: WorkflowEnv,
  task: AiTask,
  explicit?: LanguageModel,
): { model: LanguageModel; billing: Billing } {
  if (explicit) return { model: explicit, billing: "platform" };
  if (env.providers) {
    const routed = routeText(task, {
      providers: env.providers,
      ...(env.prefs ? { prefs: env.prefs } : {}),
    });
    if (routed) return { model: routed.model, billing: routed.billing };
  }
  throw new AiError("provider-not-configured", `No model is configured for ${task}.`);
}

/** Runs the design agent on a workflow-created design, forwarding its events. */
export async function runSubAgent(
  env: WorkflowEnv,
  state: WorkflowState,
  step: WorkflowStep,
  host: DocHost,
  options: Pick<RunAgentOptions, "goal" | "mode"> & Partial<RunAgentOptions>,
): Promise<RunAgentResult> {
  const result = await runAgent({
    host,
    ...(env.providers ? { providers: env.providers } : {}),
    ...(env.prefs ? { prefs: env.prefs } : {}),
    ...(env.models?.agent ? { model: env.models.agent } : {}),
    media: env.media ?? (env.providers ? undefined : false),
    ...(env.search ? { search: env.search } : {}),
    ...(env.moderation ? { moderation: env.moderation } : {}),
    ...(env.fetch ? { fetch: env.fetch } : {}),
    ...(env.signal ? { signal: env.signal } : {}),
    maxSteps: env.maxAgentSteps ?? 30,
    meter: meterOf(env),
    runId: `${state.id}-${step.id}`.replace(/[^a-z0-9-]/gi, "").slice(0, 40),
    onEvent: (event) =>
      env.onEvent?.({ type: "workflow-agent", workflowId: state.id, stepId: step.id, event }),
    agentName: `desyn-workflow:${state.kind}`,
    ...options,
  });
  if (result.status === "failed" || result.status === "cancelled") {
    throw new Error(result.error?.message ?? `agent ${result.status}`);
  }
  return result;
}

export function designLabel(design: Design, suffix: string): string {
  return `${design.name} · ${suffix}`;
}

export const VARIANT_LETTERS = "ABCDEFGHIJKL";
