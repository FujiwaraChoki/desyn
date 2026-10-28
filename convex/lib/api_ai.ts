import { type FunctionReference, makeFunctionReference } from "convex/server";
import type { Principal } from "./api_principal";

// Seam between the Agent API and the AI backend (convex/ai/*, owned by the ai-backend agent; SPEC §6/§7).
// The API calls these internal functions by name, so it builds and deploys before the AI backend exists;
// until convex/ai/api.ts provides them, the AI endpoints answer 501 NOT_CONFIGURED.
//
// Contract for the ai-backend owner — implement in convex/ai/api.ts, all `internal*`, every one receiving
// the API principal ({ userId, workspaceId } verified from the API key) and enforcing the same rules as the
// app (design permission, plan features ai.*, credits reserve/commit, fair-use caps, concurrency):
//   startRun        internalMutation  StartRunArgs        -> AiRunView      (status "queued" or "running")
//   getRun          internalQuery     { principal, runId } -> AiRunView
//   listEvents      internalQuery     ListEventsArgs      -> { items: AiRunEventView[], next, done }
//   answerRun       internalMutation  { principal, runId, answer } -> AiRunView
//   cancelRun       internalMutation  { principal, runId } -> AiRunView
//   generateAsset   internalMutation  GenerateAssetArgs   -> AiRunView      (kind "asset")
//   startWorkflow   internalMutation  StartWorkflowArgs   -> WorkflowView
//   getWorkflow     internalQuery     { principal, workflowId } -> WorkflowView
//   listModels      internalAction    { principal, task? } -> { tasks: Record<task, ModelOption[]> }
// Ids are strings (normalize them; unknown or foreign ids throw NOT_FOUND). Errors are ConvexError
// `{ code, message, … }` from convex/lib/errors.ts and map to HTTP statuses unchanged.

export interface AiRunView {
  id: string;
  kind: "agent" | "asset" | "workflow";
  designId: string | null;
  status: string;
  mode: string | null;
  goal: string | null;
  question: { question: string; options: string[] } | null;
  result: Record<string, unknown> | null;
  error: string | null;
  costCredits: number;
  steps: number;
  createdAt: number;
  updatedAt: number;
  finishedAt: number | null;
}

/** One stored AgentEvent (packages/ai/src/agent/events.ts) with its log index; binary previews are references. */
export interface AiRunEventView {
  index: number;
  type: string;
  ts: number;
  [key: string]: unknown;
}

export interface WorkflowView {
  id: string;
  type: string;
  status: string;
  designId: string | null;
  progress: { done: number; total: number };
  outputs: Record<string, unknown>[];
  error: string | null;
  costCredits: number;
  createdAt: number;
  updatedAt: number;
  finishedAt: number | null;
}

export interface StartRunArgs {
  principal: Principal;
  designId: string;
  goal: string;
  mode?: "edit" | "generate" | "critique";
  pageId?: string;
  selection?: string[];
  model?: string;
  maxSteps?: number;
  maxCredits?: number;
  /** Stable per Idempotency-Key: a retry returns the run it already started. */
  requestKey?: string;
}

export interface ListEventsArgs {
  principal: Principal;
  runId: string;
  after: number;
  limit: number;
}

export interface GenerateAssetArgs {
  principal: Principal;
  task: string;
  prompt?: string;
  assetId?: string;
  maskAssetId?: string;
  width?: number;
  height?: number;
  scale?: number;
  style?: string;
  designId?: string;
  requestKey?: string;
}

export interface StartWorkflowArgs {
  principal: Principal;
  type: string;
  designId?: string;
  /** JSON of the workflow input (arbitrary keys cannot cross the Convex value boundary as an object). */
  input: string;
  requestKey?: string;
}

type Ref<Kind extends "query" | "mutation" | "action", Args, Out> = FunctionReference<
  Kind,
  "internal",
  Args & Record<string, unknown>,
  Out
>;

const MODULE = "ai/api";

export const aiApi = {
  startRun: makeFunctionReference<"mutation">(`${MODULE}:startRun`) as unknown as Ref<
    "mutation",
    StartRunArgs,
    AiRunView
  >,
  getRun: makeFunctionReference<"query">(`${MODULE}:getRun`) as unknown as Ref<
    "query",
    { principal: Principal; runId: string },
    AiRunView
  >,
  listEvents: makeFunctionReference<"query">(`${MODULE}:listEvents`) as unknown as Ref<
    "query",
    ListEventsArgs,
    { items: AiRunEventView[]; next: number; done: boolean }
  >,
  answerRun: makeFunctionReference<"mutation">(`${MODULE}:answerRun`) as unknown as Ref<
    "mutation",
    { principal: Principal; runId: string; answer: string },
    AiRunView
  >,
  cancelRun: makeFunctionReference<"mutation">(`${MODULE}:cancelRun`) as unknown as Ref<
    "mutation",
    { principal: Principal; runId: string },
    AiRunView
  >,
  generateAsset: makeFunctionReference<"mutation">(`${MODULE}:generateAsset`) as unknown as Ref<
    "mutation",
    GenerateAssetArgs,
    AiRunView
  >,
  startWorkflow: makeFunctionReference<"mutation">(`${MODULE}:startWorkflow`) as unknown as Ref<
    "mutation",
    StartWorkflowArgs,
    WorkflowView
  >,
  getWorkflow: makeFunctionReference<"query">(`${MODULE}:getWorkflow`) as unknown as Ref<
    "query",
    { principal: Principal; workflowId: string },
    WorkflowView
  >,
  listModels: makeFunctionReference<"action">(`${MODULE}:listModels`) as unknown as Ref<
    "action",
    { principal: Principal; task?: string },
    { tasks: Record<string, Record<string, unknown>[]> }
  >,
};

/** Whether an error means the AI backend module / function is not deployed. */
export function isMissingFunction(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  // Convex: "Couldn't resolve api.ai.api.startRun"; convex-test: "Could not find module for: ai/api".
  return /Couldn't resolve|Could(?: not|n't) find/i.test(message) && /\bai[./]api\b/.test(message);
}
