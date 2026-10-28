import type { AgentMode, BrandKit } from "@desyn/ai";
import type { AccountView } from "../core/gating.ts";

/**
 * What the AI features need from the backend. The Convex implementation (`convex.ts`) calls the ai-backend
 * functions by name (convex/ai); tests and the playground pass their own.
 * Reactive reads are `watch*` methods: they call back with every new value and return an unsubscribe.
 */

export type Unsubscribe = () => void;

export interface CreditBalance {
  plan: string;
  /** Monthly pool (null = unlimited, e.g. self-host). */
  granted: number | null;
  used: number;
  reserved: number;
  remaining: number | null;
  /** Past the pool: requests are slowed down (soft throttle), never billed extra. */
  throttled: boolean;
}

export interface RunInfo {
  id: string;
  kind: "agent" | "asset" | "workflow";
  status: string;
  mode: string | null;
  goal: string | null;
  question: { question: string; options: string[] } | null;
  error: string | null;
  costCredits: number;
  steps: number;
  createdAt: number;
  finishedAt: number | null;
  workflowId: string | null;
  cancelRequested: boolean;
}

export interface RunEventsPage {
  run: RunInfo;
  events: Record<string, unknown>[];
  next: number;
  done: boolean;
}

export interface StartRunArgs {
  designId: string;
  goal: string;
  mode: AgentMode;
  pageId?: string;
  selection?: string[];
  /** Convex `assets` ids. */
  attachments?: string[];
  previousRunId?: string;
}

export interface GeneratedAssetView {
  /** Convex `assets` id. */
  assetId: string;
  /** AssetRef id (what nodes reference). */
  refId: string;
  mime: string;
  width?: number;
  height?: number;
  provider: string;
  model: string;
  costCredits: number;
  url: string | null;
}

export interface MediaResult {
  runId: string;
  assets: GeneratedAssetView[];
}

/** Media actions (all accept `designId` to attach the result and follow its brand palette). */
export interface MediaArgs {
  generateImage: {
    prompt: string;
    width?: number;
    height?: number;
    style?: string;
    withText?: boolean;
    useBrand?: boolean;
    n?: number;
  };
  generateSvg: {
    prompt: string;
    kind?: string;
    width?: number;
    height?: number;
    useBrand?: boolean;
    strokeOnly?: boolean;
  };
  removeBackground: { assetId: string };
  inpaint: { assetId: string; maskAssetId: string; prompt: string };
  outpaint: { assetId: string; width: number; height: number; direction?: string; prompt?: string };
  upscale: { assetId: string; factor?: number };
  mockup: { scene: string; assetId?: string; pageId?: string; aspectRatio?: string };
  trace: { assetId: string; colors?: number; detail?: "low" | "medium" | "high" };
}

export type MediaTask = keyof MediaArgs;

export type WorkflowType = "campaign" | "variants" | "resize" | "localize" | "bulk";

export type WorkflowTarget = { designId: string } | { workspaceId: string };

export interface WorkflowStatusView {
  id: string;
  type: string;
  status: string;
  progress: { done: number; total: number };
  outputs: { designId?: string; label: string; kind?: string; preset?: string; locale?: string }[];
  error: string | null;
  costCredits: number;
  creditsEstimated: number;
  runId: string;
}

export interface BrandKitSummary {
  id: string;
  name: string;
  isDefault: boolean;
  colors: string[];
  fonts: string[];
  logoUrl: string | null;
  /** The kit as the agent sees it (browser runs pass it to their host). */
  kit: BrandKit;
}

export interface DesignCard {
  id: string;
  name: string;
  kind: string;
  width: number;
  height: number;
  thumbnailUrl: string | null;
}

export interface AiBackend {
  watchAccount(cb: (account: AccountView | null) => void): Unsubscribe;
  watchCredits(cb: (balance: CreditBalance | null) => void): Unsubscribe;
  /** Credits an agent run of `mode` is expected to use. */
  estimate(mode: AgentMode): Promise<{ maxSteps: number; credits: number }>;
  startRun(args: StartRunArgs): Promise<{ runId: string }>;
  /** Events after `afterSeq` as they arrive (re-subscribe with the last index to page). */
  watchRunEvents(
    runId: string,
    afterSeq: number,
    cb: (page: RunEventsPage) => void,
    onError: (error: unknown) => void,
  ): Unsubscribe;
  cancelRun(runId: string): Promise<void>;
  answer(runId: string, answer: string): Promise<void>;
  /** Runs on this design, newest first (history list). */
  listRuns(designId: string, limit: number): Promise<RunInfo[]>;
  media<T extends MediaTask>(
    task: T,
    args: MediaArgs[T] & { designId?: string },
  ): Promise<MediaResult>;
  /** `target`: the source design, or the workspace for workflows that only create designs (campaign). */
  startWorkflow(
    type: WorkflowType,
    target: WorkflowTarget,
    input: Record<string, unknown>,
  ): Promise<{ workflowId: string; runId: string; estimatedCredits: number }>;
  watchWorkflow(workflowId: string, cb: (status: WorkflowStatusView) => void): Unsubscribe;
  cancelWorkflow(workflowId: string): Promise<void>;
  brandKits(workspaceId: string): Promise<BrandKitSummary[]>;
  design(designId: string): Promise<DesignCard | null>;
}
