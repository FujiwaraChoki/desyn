// Durable workflow model: a workflow is a list of steps over JSON-serializable state. Convex persists the state
// between scheduled actions and calls `runNextStep` once per action, so a workflow survives restarts, can be
// cancelled between steps and reports progress after every step.
import type { AssetRef, Design, DesignKind } from "@desyn/schema";
import type { LanguageModel } from "ai";
import type { z } from "zod";
import type { AgentEvent } from "../agent/events";
import type { CreditEstimate, CreditMeter } from "../credits";
import type { AssetUploadMeta, BrandKit, DocHost } from "../host";
import type { ModerationHook } from "../media/moderation";
import type { Media } from "../media/types";
import type { ModelPrefs } from "../models";
import type { AiProviders } from "../providers/config";
import type { SearchProviders, WorkflowName } from "../tools/types";
import type { FetchLike } from "../util/async";

export type WorkflowStatus = "pending" | "running" | "completed" | "failed" | "cancelled";
export type StepStatus = "pending" | "running" | "done" | "failed" | "skipped";

export interface WorkflowStep {
  id: string;
  type: string;
  label: string;
  status: StepStatus;
  attempts: number;
  params: Record<string, unknown>;
  /** A failed step with this flag does not fail the workflow (e.g. one preset of many). */
  optional?: boolean;
  result?: unknown;
  error?: string;
  credits?: number;
  startedAt?: number;
  finishedAt?: number;
}

export interface WorkflowOutput {
  /** Design created or updated by the workflow (Convex id). */
  designId?: string;
  label: string;
  kind?: DesignKind;
  preset?: string;
  locale?: string;
  /** Export result (exportBundle). */
  export?: { format: string; url?: string; storageKey?: string; status: "done" | "queued" };
  stepId: string;
}

export interface WorkflowState<I = unknown, D = unknown> {
  id: string;
  kind: WorkflowName;
  version: 1;
  status: WorkflowStatus;
  input: I;
  data: D;
  steps: WorkflowStep[];
  outputs: WorkflowOutput[];
  creditsEstimated: number;
  creditsUsed: number;
  createdAt: number;
  updatedAt: number;
  error?: string;
}

export interface StepSpec {
  id: string;
  type: string;
  label: string;
  params?: Record<string, unknown>;
  optional?: boolean;
}

export interface StepOutcome<D> {
  result?: unknown;
  credits?: number;
  outputs?: Omit<WorkflowOutput, "stepId">[];
  /** Steps to insert right after this one (e.g. a campaign concept expands into per-deliverable steps). */
  appendSteps?: StepSpec[];
  data?: D;
}

export interface CreateDesignInput {
  name: string;
  kind: DesignKind;
  /** Page preset id (or explicit size) for a fresh design. */
  preset?: string;
  width?: number;
  height?: number;
  /** Copy this design (all pages, assets, styles) instead of starting empty. */
  from?: Design;
  brandKitId?: string;
  locale?: string;
}

export type WorkflowEvent =
  | {
      type: "workflow-step";
      workflowId: string;
      stepId: string;
      label: string;
      status: StepStatus;
      done: number;
      total: number;
      credits: number;
    }
  | { type: "workflow-output"; workflowId: string; output: WorkflowOutput }
  | {
      type: "workflow-done";
      workflowId: string;
      status: WorkflowStatus;
      credits: number;
      error?: string;
    }
  | { type: "workflow-agent"; workflowId: string; stepId: string; event: AgentEvent };

export interface ExportJob {
  designId: string;
  format: "png" | "jpeg" | "webp" | "svg" | "pdf" | "pptx" | "gif" | "mp4";
  scale?: number;
  quality?: number;
  pages: "all" | number[];
  pdf?: { bleed: boolean; cropMarks: boolean; cmyk: boolean };
  background?: string;
  name: string;
}

export interface WorkflowEnv {
  /** Loads a design by id. */
  loadDesign(designId: string): Promise<Design>;
  /** Creates a design (fresh or copied) and returns its id and a host bound to it. */
  createDesign(input: CreateDesignInput): Promise<{ designId: string; host: DocHost }>;
  /** Host for an existing design. */
  openHost(designId: string): Promise<DocHost>;
  /** Workspace-level asset upload (shared assets such as a campaign key visual). */
  uploadAsset?(bytes: Uint8Array, mime: string, meta?: AssetUploadMeta): Promise<AssetRef>;
  providers?: AiProviders;
  prefs?: ModelPrefs;
  /** Explicit models (tests, local runs); otherwise routed through `providers`. */
  models?: {
    agent?: LanguageModel;
    plan?: LanguageModel;
    copy?: LanguageModel;
    translate?: LanguageModel;
  };
  media?: Media;
  search?: SearchProviders;
  brand?: BrandKit;
  moderation?: ModerationHook;
  /** Runs an export job (Convex `exports.request` + worker); absent = jobs are returned as queued. */
  exporter?: {
    export(job: ExportJob, signal?: AbortSignal): Promise<{ url?: string; storageKey?: string }>;
  };
  meter?: CreditMeter;
  fetch?: FetchLike;
  signal?: AbortSignal;
  onEvent?(event: WorkflowEvent): void;
  /** Max agent steps per design built by a workflow (default 30). */
  maxAgentSteps?: number;
}

export interface WorkflowDefinition<I, D> {
  kind: WorkflowName;
  label: string;
  inputSchema: z.ZodType<I>;
  init(input: I): { steps: StepSpec[]; data: D };
  estimate(input: I): CreditEstimate;
  runStep(
    step: WorkflowStep,
    state: WorkflowState<I, D>,
    env: WorkflowEnv,
  ): Promise<StepOutcome<D>>;
}
