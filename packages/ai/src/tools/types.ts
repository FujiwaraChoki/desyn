import type { Design, DesignKind, Id, Transaction } from "@desyn/schema";
import type { LanguageModel } from "ai";
import type { AgentEvent } from "../agent/events";
import type { CreditMeter } from "../credits";
import type { DocHost } from "../host";
import type { Media } from "../media/types";
import type { Billing } from "../providers/types";
import type { FetchLike } from "../util/async";

export interface StockPhoto {
  /** "<provider>:<id>", e.g. "unsplash:Xy12". */
  id: string;
  provider: "unsplash" | "pexels";
  description: string;
  width: number;
  height: number;
  /** Small preview URL. */
  thumbUrl: string;
  /** Full-size download URL. */
  url: string;
  color?: string;
  author: string;
  authorUrl: string;
  sourceUrl: string;
  license: string;
  /** Unsplash requires a request to this endpoint when a photo is used. */
  downloadLocation?: string;
}

export interface StockSearchOptions {
  query: string;
  orientation?: "landscape" | "portrait" | "square";
  color?: string;
  count?: number;
  signal?: AbortSignal;
}

export interface StockProvider {
  search(options: StockSearchOptions): Promise<StockPhoto[]>;
  /** Downloads the image bytes (and performs any required download tracking). */
  download(photo: StockPhoto, signal?: AbortSignal): Promise<{ bytes: Uint8Array; mime: string }>;
}

export interface IconResult {
  /** "prefix:name", e.g. "lucide:sun". */
  id: string;
  collection: string;
  name: string;
}

export interface IconProvider {
  search(
    query: string,
    options?: { prefixes?: string[]; limit?: number; signal?: AbortSignal },
  ): Promise<IconResult[]>;
  /** Sanitizable SVG markup for an icon, colored with `color` (currentColor replaced). */
  svg(id: string, options?: { color?: string; signal?: AbortSignal }): Promise<string>;
}

export interface TemplateSummary {
  id: string;
  title: string;
  kind: DesignKind;
  tags?: string[];
  premium?: boolean;
  thumbnailUrl?: string;
  width?: number;
  height?: number;
}

export interface TemplateProvider {
  search(
    query: string,
    options?: { kind?: DesignKind; limit?: number; signal?: AbortSignal },
  ): Promise<TemplateSummary[]>;
  /** Full template design (asset refs must be resolvable by the host). */
  get(id: string, signal?: AbortSignal): Promise<Design>;
}

export type WorkflowName =
  | "campaign"
  | "variants"
  | "resize"
  | "localize"
  | "bulk"
  | "exportBundle";

export interface WorkflowLauncher {
  /** Starts a durable workflow (Convex schedules its steps) and returns its id and credit estimate. */
  start(
    name: WorkflowName,
    input: Record<string, unknown>,
  ): Promise<{ workflowId: string; estimatedCredits: number; message?: string }>;
}

export interface SearchProviders {
  stock?: StockProvider;
  icons?: IconProvider;
  templates?: TemplateProvider;
}

export interface RoutedModel {
  model: LanguageModel;
  billing: Billing;
  /** "provider:model" for summaries. */
  label: string;
}

export interface TextModels {
  /** Copywriting route (rewrite_text). */
  copy?: RoutedModel;
  /** Translation route (translate_text). */
  translate?: RoutedModel;
  /** Vision critique route (critique with vision). */
  critique?: RoutedModel;
}

export type AgentMode = "edit" | "generate" | "critique";

export interface PlanStep {
  id: string;
  title: string;
  detail?: string;
  checkpoint?: boolean;
  status: "pending" | "in-progress" | "done" | "skipped";
}

export interface RunState {
  runId: string;
  mode: AgentMode;
  plan: PlanStep[];
  /** Design brief from the plan tool (generate mode). */
  brief?: Record<string, unknown>;
  /** Transactions applied by this run, in order. */
  transactions: Transaction[];
  /** Node ids created by this run (for summaries and to allow deleting own work without confirmation). */
  created: Set<Id>;
  /** Stock photos seen in searches, by id. */
  stockResults: Map<string, unknown>;
  /** Rendered previews by id (bytes stay out of tool results and persisted events). */
  previews: Map<string, { base64: string; mime: string }>;
  finished?: { summary: string; changes: string[]; followUps: string[] };
  question?: { question: string; options: string[]; reason?: string };
  critiques: number;
  /** The user already approved destructive bulk edits for this run (e.g. resumed after a confirmation question). */
  allowDestructive: boolean;
}

export interface ToolContext {
  host: DocHost;
  run: RunState;
  media?: Media;
  search?: SearchProviders;
  models?: TextModels;
  workflows?: WorkflowLauncher;
  meter?: CreditMeter;
  fetch?: FetchLike;
  signal?: AbortSignal;
  emit: (event: AgentEvent) => void;
  /** Asked before destructive bulk operations (many deletions, page deletion). Absent = refuse and ask the user. */
  confirmDestructive?: (info: { action: string; count: number; ids: Id[] }) => Promise<boolean>;
  /** Agent label recorded in transaction actors. */
  agentName?: string;
}

export interface ToolSuccess {
  ok: true;
  summary: string;
  [key: string]: unknown;
}

export interface ToolFailure {
  ok: false;
  error: string;
  hint?: string;
  [key: string]: unknown;
}

export type ToolResult = ToolSuccess | ToolFailure;

export class ToolInputError extends Error {
  constructor(
    message: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = "ToolInputError";
  }
}

export function createRunState(runId: string, mode: AgentMode): RunState {
  return {
    runId,
    mode,
    plan: [],
    transactions: [],
    created: new Set(),
    stockResults: new Map(),
    previews: new Map(),
    critiques: 0,
    allowDestructive: false,
  };
}
