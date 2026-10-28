import { getPlan } from "@desyn/schema";
import type {
  AiBackend,
  BrandKitSummary,
  CreditBalance,
  DesignCard,
  MediaArgs,
  MediaResult,
  MediaTask,
  RunEventsPage,
  RunInfo,
  StartRunArgs,
  WorkflowStatusView,
  WorkflowTarget,
  WorkflowType,
} from "../../src/ai/backend/types.ts";
import type { AccountView } from "../../src/ai/core/gating.ts";

/**
 * In-memory AI backend for tests and the AI playground: it behaves like the Convex AI backend's public API
 * (reactive account / credits / run events / workflow status, idempotent cancel and answer) and lets a test
 * script what a run streams.
 */

export function account(
  plan: "free" | "pro" | "selfhost",
  extra: Partial<AccountView> = {},
): AccountView {
  return {
    userId: "user1",
    emailVerified: true,
    edition: plan === "selfhost" ? "selfhost" : "hosted",
    plan,
    planName: getPlan(plan).name,
    features: { ...getPlan(plan).features },
    aiSettings: null,
    defaultWorkspaceId: "ws1",
    ...extra,
  };
}

type Listener<T> = (value: T) => void;

interface FakeRun {
  info: RunInfo;
  events: Record<string, unknown>[];
  watchers: Set<{ after: number; cb: Listener<RunEventsPage> }>;
}

export class FakeAiBackend implements AiBackend {
  private accountValue: AccountView | null;
  private creditsValue: CreditBalance | null;
  private readonly accountListeners = new Set<Listener<AccountView | null>>();
  private readonly creditListeners = new Set<Listener<CreditBalance | null>>();
  readonly runs = new Map<string, FakeRun>();
  readonly started: StartRunArgs[] = [];
  readonly cancelled: string[] = [];
  readonly answers: { runId: string; answer: string }[] = [];
  readonly mediaCalls: { task: MediaTask; args: Record<string, unknown> }[] = [];
  readonly workflowsStarted: {
    type: WorkflowType;
    designId: string | null;
    workspaceId: string | null;
    input: Record<string, unknown>;
  }[] = [];
  readonly workflowWatchers = new Map<string, Set<Listener<WorkflowStatusView>>>();
  kits: BrandKitSummary[] = [];
  designs = new Map<string, DesignCard>();
  /** Called when a run starts (script its events here). */
  onStart: ((runId: string, args: StartRunArgs) => void) | null = null;
  /** Called when a run is answered. */
  onAnswer: ((runId: string, answer: string) => void) | null = null;
  /** Media results by task (throw to simulate failures). */
  mediaHandler:
    | ((task: MediaTask, args: Record<string, unknown>) => MediaResult | Promise<MediaResult>)
    | null = null;
  startError: unknown = null;
  private seq = 0;

  constructor(accountValue: AccountView | null, credits: CreditBalance | null = null) {
    this.accountValue = accountValue;
    this.creditsValue = credits;
  }

  setAccount(value: AccountView | null): void {
    this.accountValue = value;
    for (const l of this.accountListeners) l(value);
  }

  setCredits(value: CreditBalance | null): void {
    this.creditsValue = value;
    for (const l of this.creditListeners) l(value);
  }

  watchAccount(cb: Listener<AccountView | null>) {
    this.accountListeners.add(cb);
    queueMicrotask(() => this.accountListeners.has(cb) && cb(this.accountValue));
    return () => this.accountListeners.delete(cb);
  }

  watchCredits(cb: Listener<CreditBalance | null>) {
    this.creditListeners.add(cb);
    queueMicrotask(() => this.creditListeners.has(cb) && cb(this.creditsValue));
    return () => this.creditListeners.delete(cb);
  }

  async estimate(mode: "edit" | "generate" | "critique") {
    const steps = mode === "generate" ? 48 : mode === "critique" ? 8 : 24;
    return { maxSteps: steps, credits: steps + (mode === "generate" ? 5 : 0) };
  }

  /** Creates a run as the server would (status queued, `progress` first event). */
  createRun(id: string, info: Partial<RunInfo> = {}): FakeRun {
    const run: FakeRun = {
      info: {
        id,
        kind: "agent",
        status: "queued",
        mode: "edit",
        goal: null,
        question: null,
        error: null,
        costCredits: 0,
        steps: 0,
        createdAt: Date.now(),
        finishedAt: null,
        workflowId: null,
        cancelRequested: false,
        ...info,
      },
      events: [],
      watchers: new Set(),
    };
    this.runs.set(id, run);
    return run;
  }

  async startRun(args: StartRunArgs) {
    if (this.startError) throw this.startError;
    this.started.push(args);
    const runId = `run${++this.seq}`;
    this.createRun(runId, { goal: args.goal, mode: args.mode });
    this.push(runId, { type: "progress", label: "Queued" });
    queueMicrotask(() => this.onStart?.(runId, args));
    return { runId };
  }

  /** Appends an event (AgentEvent JSON without runId) to a run's log and notifies subscribers. */
  push(runId: string, event: Record<string, unknown>): void {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`no run ${runId}`);
    run.events.push({ ...event, index: run.events.length, ts: Date.now(), runId });
    if (event.type === "start") run.info.status = "running";
    if (event.type === "question") {
      run.info.question = {
        question: String(event.question),
        options: (event.options as string[]) ?? [],
      };
    }
    if (event.type === "done") {
      run.info.status = String(event.status);
      run.info.finishedAt = event.status === "needs-input" ? null : Date.now();
      run.info.costCredits = Number(event.credits ?? 0);
    }
    this.notify(runId);
  }

  private notify(runId: string): void {
    const run = this.runs.get(runId);
    if (!run) return;
    for (const w of [...run.watchers]) w.cb(this.page(run, w.after));
  }

  private page(run: FakeRun, after: number): RunEventsPage {
    const events = run.events.filter((e) => (e.index as number) > after).slice(0, 200);
    const next = (events.at(-1)?.index as number | undefined) ?? after;
    const terminal = ["completed", "cancelled", "failed", "budget-exceeded", "step-limit"].includes(
      run.info.status,
    );
    return { run: { ...run.info }, events, next, done: terminal && next >= run.events.length - 1 };
  }

  watchRunEvents(
    runId: string,
    afterSeq: number,
    cb: Listener<RunEventsPage>,
    onError: (e: unknown) => void,
  ) {
    const run = this.runs.get(runId);
    if (!run) {
      queueMicrotask(() => onError(new Error("Run not found")));
      return () => {};
    }
    const w = { after: afterSeq, cb };
    run.watchers.add(w);
    queueMicrotask(() => run.watchers.has(w) && cb(this.page(run, afterSeq)));
    return () => run.watchers.delete(w);
  }

  watcherCount(runId: string): number {
    return this.runs.get(runId)?.watchers.size ?? 0;
  }

  async cancelRun(runId: string) {
    this.cancelled.push(runId);
    const run = this.runs.get(runId);
    if (run && !["completed", "cancelled", "failed"].includes(run.info.status)) {
      run.info.cancelRequested = true;
      this.push(runId, {
        type: "done",
        status: "cancelled",
        summary: "Stopped.",
        steps: run.info.steps,
        credits: 0,
      });
    }
  }

  async answer(runId: string, answer: string) {
    this.answers.push({ runId, answer });
    const run = this.runs.get(runId);
    if (run) {
      run.info.status = "running";
      run.info.question = null;
      this.push(runId, { type: "answer", answer });
    }
    queueMicrotask(() => this.onAnswer?.(runId, answer));
  }

  async listRuns(_designId: string, limit: number) {
    return [...this.runs.values()]
      .map((r) => ({ ...r.info }))
      .reverse()
      .slice(0, limit);
  }

  async media<T extends MediaTask>(
    task: T,
    args: MediaArgs[T] & { designId?: string },
  ): Promise<MediaResult> {
    this.mediaCalls.push({ task, args: { ...args } });
    if (!this.mediaHandler) throw new Error("No media handler scripted.");
    return await this.mediaHandler(task, { ...args });
  }

  async startWorkflow(type: WorkflowType, target: WorkflowTarget, input: Record<string, unknown>) {
    const designId = "designId" in target ? target.designId : null;
    const workspaceId = "workspaceId" in target ? target.workspaceId : null;
    // Same rule as convex/ai/workflows.ts startWorkflowFor.
    if (!designId && !workspaceId) throw new Error("Choose a workspace or a source design.");
    this.workflowsStarted.push({ type, designId, workspaceId, input });
    const workflowId = `wf${++this.seq}`;
    const runId = `wfrun${this.seq}`;
    this.createRun(runId, { kind: "workflow", status: "running", workflowId });
    return { workflowId, runId, estimatedCredits: 12 };
  }

  emitWorkflow(workflowId: string, status: WorkflowStatusView): void {
    for (const cb of this.workflowWatchers.get(workflowId) ?? []) cb(status);
  }

  watchWorkflow(workflowId: string, cb: Listener<WorkflowStatusView>) {
    const set = this.workflowWatchers.get(workflowId) ?? new Set();
    set.add(cb);
    this.workflowWatchers.set(workflowId, set);
    return () => set.delete(cb);
  }

  async cancelWorkflow(workflowId: string) {
    this.cancelled.push(workflowId);
  }

  async brandKits() {
    return this.kits;
  }

  async design(designId: string) {
    return this.designs.get(designId) ?? null;
  }
}
