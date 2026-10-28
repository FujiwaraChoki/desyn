// Step-machine engine shared by every workflow. All functions are pure with respect to the state object (they
// return new state), so Convex can persist each version and resume from it.
import { newId } from "@desyn/schema";
import { errorMessage } from "../errors";
import type { WorkflowName } from "../tools/types";
import { isAbortError } from "../util/async";
import type {
  StepSpec,
  WorkflowDefinition,
  WorkflowEnv,
  WorkflowState,
  WorkflowStep,
} from "./types";

const MAX_ATTEMPTS = 2;

function toStep(spec: StepSpec): WorkflowStep {
  return {
    id: spec.id,
    type: spec.type,
    label: spec.label,
    status: "pending",
    attempts: 0,
    params: spec.params ?? {},
    ...(spec.optional ? { optional: true } : {}),
  };
}

/** Deep copy through JSON: also proves the state stays serializable. */
export function cloneState<S>(state: S): S {
  return JSON.parse(JSON.stringify(state)) as S;
}

export function createWorkflowState<I, D>(
  def: WorkflowDefinition<I, D>,
  rawInput: unknown,
  options: { id?: string; now?: number } = {},
): WorkflowState<I, D> {
  const input = def.inputSchema.parse(rawInput);
  const { steps, data } = def.init(input);
  const now = options.now ?? Date.now();
  return {
    id: options.id ?? newId(),
    kind: def.kind as WorkflowName,
    version: 1,
    status: "pending",
    input,
    data,
    steps: steps.map(toStep),
    outputs: [],
    creditsEstimated: def.estimate(input).total,
    creditsUsed: 0,
    createdAt: now,
    updatedAt: now,
  };
}

export function isFinished(state: WorkflowState): boolean {
  return state.status === "completed" || state.status === "failed" || state.status === "cancelled";
}

export function progress(state: WorkflowState): { done: number; total: number } {
  return {
    done: state.steps.filter(
      (s) => s.status === "done" || s.status === "skipped" || (s.status === "failed" && s.optional),
    ).length,
    total: state.steps.length,
  };
}

export function cancelWorkflow<I, D>(
  state: WorkflowState<I, D>,
  now = Date.now(),
): WorkflowState<I, D> {
  if (isFinished(state)) return state;
  const next = cloneState(state);
  next.status = "cancelled";
  for (const s of next.steps)
    if (s.status === "pending" || s.status === "running") s.status = "skipped";
  next.updatedAt = now;
  return next;
}

/** Executes the next pending step and returns the updated state. Safe to call on finished workflows (no-op). */
export async function runNextStep<I, D>(
  def: WorkflowDefinition<I, D>,
  state: WorkflowState<I, D>,
  env: WorkflowEnv,
): Promise<WorkflowState<I, D>> {
  if (isFinished(state)) return state;
  const next = cloneState(state);
  next.status = "running";
  const index = next.steps.findIndex((s) => s.status === "pending" || s.status === "running");
  if (index < 0) {
    next.status = "completed";
    next.updatedAt = Date.now();
    env.onEvent?.({
      type: "workflow-done",
      workflowId: next.id,
      status: "completed",
      credits: next.creditsUsed,
    });
    return next;
  }
  const step = next.steps[index] as WorkflowStep;
  step.status = "running";
  step.attempts += 1;
  step.startedAt = Date.now();
  const emitStep = () => {
    const p = progress(next);
    env.onEvent?.({
      type: "workflow-step",
      workflowId: next.id,
      stepId: step.id,
      label: step.label,
      status: step.status,
      done: p.done,
      total: p.total,
      credits: next.creditsUsed,
    });
  };
  emitStep();
  try {
    const outcome = await def.runStep(step, next, env);
    step.status = "done";
    step.finishedAt = Date.now();
    if (outcome.result !== undefined) step.result = JSON.parse(JSON.stringify(outcome.result));
    if (outcome.credits) {
      step.credits = outcome.credits;
      next.creditsUsed += outcome.credits;
    }
    if (outcome.data !== undefined) next.data = JSON.parse(JSON.stringify(outcome.data));
    for (const o of outcome.outputs ?? []) {
      const output = { ...o, stepId: step.id };
      next.outputs.push(output);
      env.onEvent?.({ type: "workflow-output", workflowId: next.id, output });
    }
    if (outcome.appendSteps?.length)
      next.steps.splice(index + 1, 0, ...outcome.appendSteps.map(toStep));
  } catch (error) {
    step.finishedAt = Date.now();
    if (isAbortError(error) || env.signal?.aborted) {
      step.status = "pending";
      step.attempts -= 1;
      next.updatedAt = Date.now();
      emitStep();
      return cancelWorkflow(next);
    }
    step.error = errorMessage(error);
    if (step.attempts < MAX_ATTEMPTS) {
      step.status = "pending"; // retried on the next call
    } else {
      step.status = "failed";
      if (!step.optional) {
        next.status = "failed";
        next.error = `${step.label}: ${step.error}`;
      }
    }
  }
  next.updatedAt = Date.now();
  emitStep();
  if (next.status !== "failed" && !next.steps.some((s) => s.status === "pending"))
    next.status = "completed";
  if (isFinished(next)) {
    env.onEvent?.({
      type: "workflow-done",
      workflowId: next.id,
      status: next.status,
      credits: next.creditsUsed,
      ...(next.error ? { error: next.error } : {}),
    });
  }
  return next;
}

/** Runs a workflow to completion in-process (local runs, tests, evals). Convex instead schedules runNextStep. */
export async function runWorkflow<I, D>(
  def: WorkflowDefinition<I, D>,
  state: WorkflowState<I, D>,
  env: WorkflowEnv,
  options: {
    maxSteps?: number;
    onState?: (state: WorkflowState<I, D>) => void | Promise<void>;
  } = {},
): Promise<WorkflowState<I, D>> {
  let current = state;
  for (let i = 0; i < (options.maxSteps ?? 500) && !isFinished(current); i++) {
    current = await runNextStep(def, current, env);
    await options.onState?.(current);
  }
  return current;
}
