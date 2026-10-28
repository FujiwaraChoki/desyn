import type { AgentMode } from "@desyn/ai";
import type { Id } from "@desyn/schema";
import type { PlanStepView, RunEvent, RunPhase } from "./events.ts";

/**
 * Pure reduction of a run's event stream into what the dock renders. Events are applied in index order and at
 * most once (subscriptions may redeliver), text and thinking deltas merge into the block they continue, tool
 * calls pair with their results, and the run's phase follows the stream (a `done` event is final).
 */

export type RunSource = "server" | "browser";

export type LogItem =
  | { kind: "thinking"; id: string; text: string; startedAt: number; endedAt: number | null }
  | { kind: "text"; id: string; text: string }
  | {
      kind: "tool";
      id: string;
      tool: string;
      input: unknown;
      status: "running" | "ok" | "failed";
      summary: string;
      output: unknown;
      ms: number | null;
    }
  | { kind: "preview"; id: string; url: string; width: number | null; height: number | null }
  | { kind: "question"; id: string; question: string; options: string[]; answer: string | null }
  | { kind: "error"; id: string; message: string; recoverable: boolean }
  | {
      kind: "workflow";
      id: string;
      label: string;
      status: string;
      done: number;
      total: number;
    }
  | { kind: "output"; id: string; label: string; designId: string | null };

export interface RunView {
  id: string;
  source: RunSource;
  mode: AgentMode;
  goal: string;
  model: string | null;
  phase: RunPhase;
  items: LogItem[];
  plan: PlanStepView[];
  steps: number;
  credits: { used: number; remaining: number | null };
  question: { question: string; options: string[] } | null;
  /** Every node the run touched (applied transactions), in first-touch order. */
  touched: Id[];
  /** Nodes of the latest applied transaction (the canvas glows on them). */
  lastTouched: Id[];
  appliedTx: number;
  progress: { label: string; detail: string | null } | null;
  /** Fair-use throttling was reported for this run. */
  throttled: boolean;
  summary: string | null;
  error: string | null;
  startedAt: number;
  finishedAt: number | null;
  /** Highest event index applied (-1 before the first). */
  lastIndex: number;
}

export function initialRun(init: {
  id: string;
  source: RunSource;
  mode: AgentMode;
  goal: string;
  now?: number;
}): RunView {
  return {
    id: init.id,
    source: init.source,
    mode: init.mode,
    goal: init.goal,
    model: null,
    phase: "queued",
    items: [],
    plan: [],
    steps: 0,
    credits: { used: 0, remaining: null },
    question: null,
    touched: [],
    lastTouched: [],
    appliedTx: 0,
    progress: null,
    throttled: false,
    summary: null,
    error: null,
    startedAt: init.now ?? Date.now(),
    finishedAt: null,
    lastIndex: -1,
  };
}

export const FINAL_PHASES: ReadonlySet<RunPhase> = new Set([
  "completed",
  "cancelled",
  "budget-exceeded",
  "step-limit",
  "failed",
]);

/** True once the run ended (waiting for an answer is not the end). */
export function isFinal(run: Pick<RunView, "phase">): boolean {
  return FINAL_PHASES.has(run.phase);
}

/** True while the run is executing or queued (the stop button applies). */
export function isActive(run: Pick<RunView, "phase">): boolean {
  return run.phase === "queued" || run.phase === "running";
}

const THROTTLE = /fair use|throttl|slow(ed)? down/i;

/** Closes an open thinking block (its duration is shown as "Thought for 4 s"). */
function closeThinking(items: LogItem[], at: number): LogItem[] {
  const last = items[items.length - 1];
  if (last?.kind === "thinking" && last.endedAt === null) {
    return [...items.slice(0, -1), { ...last, endedAt: at }];
  }
  return items;
}

function appendDelta(items: LogItem[], kind: "thinking" | "text", text: string, event: RunEvent) {
  const last = items[items.length - 1];
  if (
    last?.kind === kind &&
    (kind === "text" || (last as { endedAt: number | null }).endedAt === null)
  ) {
    return [...items.slice(0, -1), { ...last, text: last.text + text }];
  }
  const base = kind === "text" ? closeThinking(items, event.ts) : items;
  const item: LogItem =
    kind === "thinking"
      ? { kind, id: `thinking-${event.index}`, text, startedAt: event.ts, endedAt: null }
      : { kind, id: `text-${event.index}`, text };
  return [...base, item];
}

function addTouched(list: Id[], ids: Id[]): Id[] {
  const seen = new Set(list);
  const out = [...list];
  for (const id of ids) {
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/** Applies one event. Returns the same object when the event changes nothing (or was already applied). */
export function reduceRun(run: RunView, event: RunEvent): RunView {
  if (event.index <= run.lastIndex) return run;
  const next: RunView = { ...run, lastIndex: event.index };
  // A final run only accepts trailing bookkeeping; nothing reopens it.
  const final = isFinal(run);
  switch (event.type) {
    case "progress":
      next.progress = { label: event.label, detail: event.detail ?? null };
      if (THROTTLE.test(event.label) || THROTTLE.test(event.detail ?? "")) next.throttled = true;
      return next;
    case "start":
      if (!final) next.phase = "running";
      next.model = event.model || run.model;
      next.progress = null;
      return next;
    case "step":
      if (!final && run.phase !== "needs-input") next.phase = "running";
      next.steps = Math.max(run.steps, event.step);
      next.items = closeThinking(run.items, event.ts);
      return next;
    case "thinking":
      if (!event.text) return next;
      next.items = appendDelta(run.items, "thinking", event.text, event);
      return next;
    case "text":
      if (!event.text) return next;
      next.items = appendDelta(run.items, "text", event.text, event);
      return next;
    case "tool-call": {
      if (event.tool === "ask_user") return next; // shown by the `question` event
      const items = closeThinking(run.items, event.ts);
      if (items.some((i) => i.kind === "tool" && i.id === event.callId)) return next;
      next.items = [
        ...items,
        {
          kind: "tool",
          id: event.callId,
          tool: event.tool,
          input: event.input,
          status: "running",
          summary: "",
          output: null,
          ms: null,
        },
      ];
      return next;
    }
    case "tool-result": {
      if (event.tool === "ask_user") return next;
      const at = run.items.findIndex((i) => i.kind === "tool" && i.id === event.callId);
      const done: LogItem = {
        kind: "tool",
        id: event.callId,
        tool: event.tool,
        input: at >= 0 ? (run.items[at] as { input: unknown }).input : null,
        status: event.ok ? "ok" : "failed",
        summary: event.summary,
        output: event.output,
        ms: event.ms ?? null,
      };
      next.items = at >= 0 ? run.items.map((i, k) => (k === at ? done : i)) : [...run.items, done];
      if (event.tool === "plan" && event.ok) next.items = next.items.filter((i) => i !== done);
      return next;
    }
    case "applied-tx":
      next.appliedTx = run.appliedTx + 1;
      next.lastTouched = event.touched;
      next.touched = addTouched(run.touched, event.touched);
      return next;
    case "preview":
      if (!event.url) return next;
      next.items = [
        ...run.items,
        {
          kind: "preview",
          id: `preview-${event.index}`,
          url: event.url,
          width: event.width,
          height: event.height,
        },
      ];
      return next;
    case "plan":
      next.plan = event.steps;
      return next;
    case "credits":
      next.credits = { used: Math.max(run.credits.used, event.used), remaining: event.remaining };
      return next;
    case "question":
      next.question = { question: event.question, options: event.options };
      next.items = [
        ...closeThinking(run.items, event.ts),
        {
          kind: "question",
          id: `question-${event.index}`,
          question: event.question,
          options: event.options,
          answer: null,
        },
      ];
      return next;
    case "answer": {
      next.question = null;
      let answered = false;
      const items = [...run.items];
      for (let k = items.length - 1; k >= 0 && !answered; k--) {
        const item = items[k] as LogItem;
        if (item.kind === "question" && item.answer === null) {
          items[k] = { ...item, answer: event.answer };
          answered = true;
        }
      }
      next.items = items;
      if (!final) next.phase = "running";
      return next;
    }
    case "error":
      next.items = [
        ...closeThinking(run.items, event.ts),
        {
          kind: "error",
          id: `error-${event.index}`,
          message: event.message,
          recoverable: event.recoverable,
        },
      ];
      if (!event.recoverable) next.error = event.message;
      return next;
    case "done":
      next.phase = event.status;
      next.summary = event.summary || run.summary;
      next.steps = Math.max(run.steps, event.steps);
      next.credits = { ...run.credits, used: Math.max(run.credits.used, event.credits) };
      next.finishedAt = event.status === "needs-input" ? null : event.ts;
      next.progress = null;
      next.items = closeThinking(
        run.items.map((i) =>
          i.kind === "tool" && i.status === "running" && event.status !== "needs-input"
            ? { ...i, status: event.status === "completed" ? "ok" : "failed" }
            : i,
        ),
        event.ts,
      );
      if (event.status === "failed" && !run.error) next.error = event.summary || "The run failed.";
      if (event.status !== "needs-input") next.question = null;
      return next;
    case "workflow-step": {
      const id = `wf-${event.stepId}`;
      const item: LogItem = {
        kind: "workflow",
        id,
        label: event.label,
        status: event.status,
        done: event.done,
        total: event.total,
      };
      const at = run.items.findIndex((i) => i.id === id);
      next.items = at >= 0 ? run.items.map((i, k) => (k === at ? item : i)) : [...run.items, item];
      if (!final) next.phase = "running";
      return next;
    }
    case "workflow-output":
      next.items = [
        ...run.items,
        {
          kind: "output",
          id: `output-${event.index}`,
          label: event.label,
          designId: event.designId,
        },
      ];
      return next;
    case "workflow-done":
      next.credits = { ...run.credits, used: Math.max(run.credits.used, event.credits) };
      if (event.error) next.error = event.error;
      return next;
  }
}

/** Applies events in index order. */
export function reduceEvents(run: RunView, events: readonly RunEvent[]): RunView {
  return [...events].sort((a, b) => a.index - b.index).reduce(reduceRun, run);
}

/** Last assistant message of the run (the reply shown under the steps). */
export function replyText(run: RunView): string {
  for (let k = run.items.length - 1; k >= 0; k--) {
    const item = run.items[k] as LogItem;
    if (item.kind === "text" && item.text.trim()) return item.text.trim();
  }
  return "";
}

/** One-line thinking summary: the latest complete sentence of the latest thought. */
export function thinkingSummary(text: string, max = 140): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return "";
  const sentences = clean.match(/[^.!?]+[.!?]+/g);
  const pick = (sentences?.[sentences.length - 1] ?? clean).trim();
  return pick.length > max ? `${pick.slice(0, max - 1).trimEnd()}…` : pick;
}

/** Human status line for a phase. */
export function phaseLabel(run: Pick<RunView, "phase" | "throttled" | "progress">): string {
  switch (run.phase) {
    case "queued":
      return run.throttled ? "Waiting for fair use" : (run.progress?.label ?? "Queued");
    case "running":
      return run.progress?.label ?? "Working";
    case "needs-input":
      return "Waiting for your answer";
    case "completed":
      return "Done";
    case "cancelled":
      return "Stopped";
    case "budget-exceeded":
      return "Stopped at the credit budget";
    case "step-limit":
      return "Stopped at the step limit";
    case "failed":
      return "Failed";
  }
}
