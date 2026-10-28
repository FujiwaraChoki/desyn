// Workflow registry. Convex stores `WorkflowState` (JSON) and schedules `runNextStep` until the workflow finishes.
import type { CreditEstimate } from "../credits";
import type { WorkflowName } from "../tools/types";
import { bulkWorkflow } from "./bulk";
import { campaignWorkflow } from "./campaign";
import {
  cancelWorkflow,
  createWorkflowState,
  isFinished,
  progress,
  runNextStep,
  runWorkflow,
} from "./engine";
import { exportBundleWorkflow } from "./export";
import { localizeWorkflow } from "./localize";
import { resizeWorkflow } from "./resize";
import type { WorkflowDefinition, WorkflowEnv, WorkflowState } from "./types";
import { variantsWorkflow } from "./variants";

// Definitions differ in input/data types; the registry erases them behind the shared state contract.
type AnyDefinition = WorkflowDefinition<unknown, unknown>;

export const WORKFLOWS: Readonly<Record<WorkflowName, AnyDefinition>> = {
  campaign: campaignWorkflow as unknown as AnyDefinition,
  variants: variantsWorkflow as unknown as AnyDefinition,
  resize: resizeWorkflow as unknown as AnyDefinition,
  localize: localizeWorkflow as unknown as AnyDefinition,
  bulk: bulkWorkflow as unknown as AnyDefinition,
  exportBundle: exportBundleWorkflow as unknown as AnyDefinition,
};

export function getWorkflow(name: WorkflowName): AnyDefinition {
  const def = WORKFLOWS[name];
  if (!def) throw new Error(`unknown workflow "${name}"`);
  return def;
}

/** Validates input and returns the initial state (status "pending"). */
export function startWorkflow(
  name: WorkflowName,
  input: unknown,
  options: { id?: string; now?: number } = {},
): WorkflowState {
  return createWorkflowState(getWorkflow(name), input, options);
}

/** Credit estimate for a workflow input (validates the input). */
export function estimateWorkflow(name: WorkflowName, input: unknown): CreditEstimate {
  const def = getWorkflow(name);
  return def.estimate(def.inputSchema.parse(input));
}

/** Runs one step of a persisted workflow. */
export function stepWorkflow(state: WorkflowState, env: WorkflowEnv): Promise<WorkflowState> {
  return runNextStep(getWorkflow(state.kind), state, env);
}

/** Runs a workflow to the end in-process. */
export function completeWorkflow(state: WorkflowState, env: WorkflowEnv): Promise<WorkflowState> {
  return runWorkflow(getWorkflow(state.kind), state, env);
}

export { type BulkWorkflowInput, bulkWorkflow, designSlots } from "./bulk";
export { type CampaignConcept, type CampaignWorkflowInput, campaignWorkflow } from "./campaign";
export { type CsvTable, parseCsv, parseCsvRecords } from "./csv";
export { cloneState, createWorkflowState, runNextStep, runWorkflow } from "./engine";
export { type ExportBundleInput, exportBundleWorkflow, exportJobs } from "./export";
export { type LocalizeWorkflowInput, localizeWorkflow } from "./localize";
export { type ResizeWorkflowInput, resizeWorkflow } from "./resize";
export * from "./types";
export { type VariantsWorkflowInput, variantsWorkflow } from "./variants";
export { cancelWorkflow, isFinished, progress };
