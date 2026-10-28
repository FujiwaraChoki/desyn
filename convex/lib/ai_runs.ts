import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { AiRunEventView, AiRunView, WorkflowView } from "./api_ai";
import { commitCredits, refundCredits, reserveCredits } from "./credits";
import { errors } from "./errors";

// Shared helpers for AI runs (agent, asset, workflow): limits, views, event log, credit segments.
// Runtime-neutral (no Node APIs, no @desyn/ai): used by queries, mutations and Node actions alike.

type DbCtx = QueryCtx | MutationCtx;

export type RunStatus = Doc<"aiRuns">["status"];
export type AgentMode = "edit" | "generate" | "critique";

/** Statuses after which a run produces no more events. */
export const TERMINAL_STATUSES: ReadonlySet<RunStatus> = new Set([
  "completed",
  "cancelled",
  "budget-exceeded",
  "step-limit",
  "failed",
]);
export function isTerminal(status: RunStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

/** A chunk of the agent loop yields after this long so it always fits Convex's 10 minute action limit. */
export const CHUNK_MS = 6 * 60_000;
/** A running chunk older than this is considered dead (action crashed or timed out). */
export const LEASE_MS = 10 * 60_000 + 30_000;
/** Crash restarts before a run or workflow is failed. */
export const MAX_RESTARTS = 3;
export const MAX_GOAL_CHARS = 8_000;
export const MAX_ANSWER_CHARS = 4_000;
export const MAX_STEPS = 100;
export const DEFAULT_STEPS: Record<AgentMode, number> = { edit: 24, generate: 48, critique: 8 };
/** Media allowance (credits) on top of one credit per step when no explicit cap is given. */
export const MEDIA_ALLOWANCE: Record<AgentMode, number> = { edit: 15, generate: 36, critique: 0 };
/** Runs waiting for an answer longer than this are closed (their conversation stays for follow-ups). */
export const WAITING_TTL_MS = 24 * 60 * 60_000;
/** Conversation blobs of finished runs are kept this long for follow-up runs. */
export const HISTORY_RETENTION_MS = 7 * 24 * 60 * 60_000;
/** Event logs of finished runs are kept this long. */
export const EVENTS_RETENTION_MS = 30 * 24 * 60 * 60_000;

const STRING_MAX = 4_000;
const PAYLOAD_MAX = 24_000;

export function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Prompt preview for logs and provenance (never the full prompt in logs). */
export function preview(text: string, max = 120): string {
  return clip(text.replace(/\s+/g, " ").trim(), max);
}

export function isAgentMode(mode: string): mode is AgentMode {
  return mode === "edit" || mode === "generate" || mode === "critique";
}

/** Steps for a run: explicit (clamped to 1..100) or the mode default. */
export function stepsFor(mode: AgentMode, requested?: number): number {
  if (requested === undefined) return DEFAULT_STEPS[mode];
  if (!Number.isFinite(requested)) throw errors.invalid("maxSteps must be a number.", "maxSteps");
  return Math.max(1, Math.min(MAX_STEPS, Math.round(requested)));
}

// --- views ------------------------------------------------------------------------------------------------

export function runView(run: Doc<"aiRuns">): AiRunView {
  const result =
    run.result && typeof run.result === "object" ? (run.result as Record<string, unknown>) : null;
  return {
    id: run._id,
    kind: run.kind,
    designId: run.designId ?? null,
    status: run.status,
    mode: run.mode,
    goal: run.goal,
    question:
      run.status === "needs-input" && run.question
        ? { question: run.question.question, options: run.question.options }
        : null,
    result,
    error: run.error ?? null,
    costCredits: run.creditsUsed,
    steps: run.steps,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    finishedAt: run.finishedAt ?? null,
  };
}

/** The app view: the API view plus model, billing and charged credits. */
export function runAppView(run: Doc<"aiRuns">) {
  return {
    ...runView(run),
    model: run.model ?? null,
    billing: run.billing ?? null,
    creditsCharged: run.creditsCharged,
    transactions: run.transactions,
    workflowId: run.workflowId ?? null,
    cancelRequested: run.cancelRequested === true,
  };
}

export function workflowView(wf: Doc<"aiWorkflows">): WorkflowView {
  return {
    id: wf._id,
    type: wf.type,
    status: wf.status,
    designId: wf.designId ?? null,
    progress: wf.progress,
    outputs: wf.outputs as Record<string, unknown>[],
    error: wf.error ?? null,
    costCredits: wf.creditsUsed,
    createdAt: wf.createdAt,
    updatedAt: wf.updatedAt,
    finishedAt: wf.finishedAt ?? null,
  };
}

export function workflowAppView(wf: Doc<"aiWorkflows">) {
  return {
    ...workflowView(wf),
    runId: wf.runId,
    creditsEstimated: wf.creditsEstimated,
    creditsCharged: wf.creditsCharged,
    cancelRequested: wf.cancelRequested === true,
  };
}

// --- event log --------------------------------------------------------------------------------------------

export interface StoredEvent {
  type: string;
  ts: number;
  /** JSON of the event without `type` / `runId`. */
  payload: string;
}

function truncateStrings(value: unknown, max: number): unknown {
  if (typeof value === "string") return clip(value, max);
  if (Array.isArray(value)) return value.map((v) => truncateStrings(v, max));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = truncateStrings(v, max);
    return out;
  }
  return value;
}

/**
 * Compact storage form of an AgentEvent / WorkflowEvent: drops `runId` (implied by the row), truncates long
 * strings and, when the JSON is still too large, keeps only the scalar top-level fields with a marker.
 */
export function storedEvent(
  event: { type: string; [k: string]: unknown },
  ts = Date.now(),
): StoredEvent {
  const { type, runId: _runId, ...rest } = event;
  let payload = JSON.stringify(truncateStrings(rest, STRING_MAX));
  if (payload.length > PAYLOAD_MAX) {
    const scalars: Record<string, unknown> = { truncated: true };
    for (const [k, v] of Object.entries(rest)) {
      if (v === null || ["string", "number", "boolean"].includes(typeof v)) {
        scalars[k] = typeof v === "string" ? clip(v, 500) : v;
      }
    }
    payload = JSON.stringify(scalars);
  }
  return { type: clip(String(type), 64), ts, payload };
}

/** Appends events to a run's log (contiguous seq) and returns the new event count. */
export async function appendRunEvents(
  ctx: MutationCtx,
  run: Doc<"aiRuns">,
  events: StoredEvent[],
): Promise<number> {
  let seq = run.eventCount;
  for (const e of events) {
    await ctx.db.insert("aiRunEvents", {
      runId: run._id,
      seq,
      type: e.type,
      payload: e.payload,
      ts: e.ts,
    });
    seq++;
  }
  return seq;
}

export async function eventViews(
  ctx: QueryCtx,
  runId: Id<"aiRuns">,
  after: number,
  limit: number,
): Promise<AiRunEventView[]> {
  const rows = await ctx.db
    .query("aiRunEvents")
    .withIndex("by_run_seq", (q) => q.eq("runId", runId).gt("seq", after))
    .take(limit);
  const out: AiRunEventView[] = [];
  for (const row of rows) {
    const payload = JSON.parse(row.payload) as Record<string, unknown>;
    // Previews are stored by reference; resolve a fresh URL for readers.
    if (typeof payload.previewId === "string") {
      const storageId = ctx.db.system.normalizeId("_storage", payload.previewId);
      payload.url = storageId ? await ctx.storage.getUrl(storageId) : null;
    }
    out.push({ ...payload, index: row.seq, type: row.type, ts: row.ts, runId });
  }
  return out;
}

// --- loading ----------------------------------------------------------------------------------------------

export async function getRun(ctx: DbCtx, raw: string): Promise<Doc<"aiRuns"> | null> {
  const id = ctx.db.normalizeId("aiRuns", raw);
  return id ? await ctx.db.get("aiRuns", id) : null;
}

/** A run the user may see: their own runs, or runs on designs of a workspace they belong to (API keys). */
export async function requireOwnRun(
  ctx: DbCtx,
  raw: string,
  userId: string,
  workspaceId?: Id<"workspaces">,
): Promise<Doc<"aiRuns">> {
  const run = await getRun(ctx, raw);
  if (!run || run.userId !== userId) throw errors.notFound("Run");
  if (workspaceId !== undefined && run.workspaceId !== workspaceId) throw errors.notFound("Run");
  return run;
}

// --- credit segments --------------------------------------------------------------------------------------

/** Ledger refId of a run's n-th reservation segment (a run settles before it waits for input). */
export function segmentRefId(kind: "run" | "wf", id: string, segment: number | string): string {
  return `ai:${kind}:${id}:${segment}`;
}

export type ReserveOutcome =
  | { ok: true; refId: string; amount: number; delayMs: number; throttled: boolean }
  | { ok: false; error: ReturnType<typeof errors.rateLimited> };

/** Reserves credits for one segment; maps fair-use refusals to the client errors. */
export async function reserveSegment(
  ctx: MutationCtx,
  args: { userId: string; refId: string; cost: number; byok: boolean; kind?: string },
): Promise<ReserveOutcome> {
  const r = await reserveCredits(ctx, {
    userId: args.userId,
    kind: args.kind ?? "agent.turn",
    refId: args.refId,
    cost: Math.max(0, Math.ceil(args.cost)),
    byok: args.byok,
  });
  if (r.status === "rate_limited") {
    return { ok: false, error: errors.rateLimited(r.retryAfterMs, r.scope) };
  }
  if (r.status === "no_credits") {
    throw errors.feature("ai.agent");
  }
  if (r.state === "refunded") {
    // A replayed refId that was already released (e.g. the stale-reservation cron): treat as "do not run".
    throw errors.conflict("This AI request was already closed.");
  }
  return { ok: true, refId: r.refId, amount: r.amount, delayMs: r.delayMs, throttled: r.throttled };
}

/** Longest fair-use wait a run in progress sits out; past it (e.g. the daily cap) the run stops instead. */
export const MAX_RESUME_WAIT_MS = 5 * 60_000;

/**
 * What a run that continues (next chunk, next workflow step) does when fair use refuses its reservation: wait
 * and retry for short limits (per minute, concurrency), stop with the reason for long ones (per day).
 */
export function resumeAfterRefusal(
  error: ReturnType<typeof errors.rateLimited>,
): { retryInMs: number } | { stop: string } {
  const data = error.data as { retryAfterMs?: number; scope?: string };
  const retry = Math.max(1_000, Number(data.retryAfterMs ?? 5_000));
  if (data.scope === "day" || retry > MAX_RESUME_WAIT_MS) {
    return {
      stop: "Stopped: the daily AI request limit was reached. Changes so far are kept; continue tomorrow with a follow-up run.",
    };
  }
  return { retryInMs: retry };
}

/**
 * Settles a reservation with the credits metered since it was taken: commits the actual use (the ledger
 * charges what fits in the pool; the rest is fair-use overage) or refunds it when nothing was used.
 * Idempotent by refId; returns the credits charged now.
 */
export async function settleSegment(
  ctx: MutationCtx,
  reservation: { refId: string; usedAtStart: number },
  creditsUsed: number,
): Promise<number> {
  const used = Math.max(0, creditsUsed - reservation.usedAtStart);
  if (used === 0) {
    await refundCredits(ctx, { refId: reservation.refId, reason: "unused" });
    return 0;
  }
  try {
    const res = await commitCredits(ctx, { refId: reservation.refId, cost: used });
    return res.replay ? 0 : res.charged;
  } catch (err) {
    // Already refunded by the stale-reservation cron (run outlived the reservation): nothing to charge.
    if (err instanceof Error && /already refunded/.test(err.message)) return 0;
    const data = (err as { data?: { code?: string } }).data;
    if (data?.code === "CONFLICT") return 0;
    throw err;
  }
}
