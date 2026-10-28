import type { AgentEvent, AgentMode, RunStatus } from "@desyn/ai";
import type { Id } from "@desyn/schema";

/**
 * Run events as the AI dock consumes them. Server runs stream `ai/agent:runEvents` rows (an AgentEvent JSON
 * payload plus `index` / `ts`; previews by URL; long payloads may arrive truncated), browser runs emit
 * @desyn/ai `AgentEvent`s directly. Both are normalized here into one tolerant shape so the reducer never
 * trusts a field it has not checked.
 */

export type RunPhase = "queued" | "running" | Exclude<RunStatus, "yielded">;

export interface PlanStepView {
  id: string;
  title: string;
  status: string;
  checkpoint?: boolean;
}

export type RunEventBody =
  | { type: "progress"; label: string; detail?: string }
  | { type: "start"; mode: string; model: string }
  | { type: "step"; step: number }
  | { type: "thinking"; text: string }
  | { type: "text"; text: string }
  | { type: "tool-call"; callId: string; tool: string; input: unknown }
  | {
      type: "tool-result";
      callId: string;
      tool: string;
      ok: boolean;
      summary: string;
      output: unknown;
      ms?: number;
    }
  | {
      type: "applied-tx";
      txId: string | null;
      label: string | null;
      applied: number;
      dropped: number;
      touched: Id[];
    }
  | {
      type: "preview";
      url: string | null;
      width: number | null;
      height: number | null;
      pageId: Id | null;
    }
  | { type: "plan"; steps: PlanStepView[] }
  | { type: "credits"; used: number; remaining: number | null }
  | { type: "question"; question: string; options: string[] }
  | { type: "answer"; answer: string }
  | { type: "error"; message: string; code?: string; recoverable: boolean }
  | {
      type: "done";
      status: Exclude<RunStatus, "yielded">;
      summary: string;
      steps: number;
      credits: number;
    }
  | {
      type: "workflow-step";
      stepId: string;
      label: string;
      status: string;
      done: number;
      total: number;
      credits: number;
    }
  | { type: "workflow-output"; label: string; designId: string | null; stepId: string | null }
  | { type: "workflow-done"; status: string; credits: number; error?: string };

export type RunEvent = RunEventBody & { index: number; ts: number };

const DONE_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "needs-input",
  "cancelled",
  "budget-exceeded",
  "step-limit",
  "failed",
]);

export const AGENT_MODES: readonly AgentMode[] = ["edit", "generate", "critique"];

const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

function planSteps(v: unknown): PlanStepView[] {
  if (!Array.isArray(v)) return [];
  const out: PlanStepView[] = [];
  for (const raw of v) {
    if (!raw || typeof raw !== "object") continue;
    const s = raw as Record<string, unknown>;
    const title = str(s.title);
    if (!title) continue;
    out.push({
      id: str(s.id, title),
      title,
      status: str(s.status, "pending"),
      ...(s.checkpoint === true ? { checkpoint: true } : {}),
    });
  }
  return out;
}

/**
 * Normalizes one event (a server row or a browser AgentEvent with `index` / `ts` added). Unknown or malformed
 * events return null and are skipped.
 */
export function normalizeEvent(raw: Record<string, unknown>): RunEvent | null {
  const index = num(raw.index);
  if (index === null) return null;
  const ts = num(raw.ts) ?? num(raw.at) ?? Date.now();
  const base = { index, ts };
  const type = str(raw.type);
  switch (type) {
    case "progress":
      return {
        ...base,
        type,
        label: str(raw.label, "Working"),
        ...(typeof raw.detail === "string" ? { detail: raw.detail } : {}),
      };
    case "start":
      return { ...base, type, mode: str(raw.mode, "edit"), model: str(raw.model) };
    case "step":
      return { ...base, type, step: num(raw.step) ?? 0 };
    case "thinking":
    case "text":
      return { ...base, type, text: str(raw.text) };
    case "tool-call":
      return {
        ...base,
        type,
        callId: str(raw.callId, `call-${index}`),
        tool: str(raw.tool, "tool"),
        input: raw.input ?? null,
      };
    case "tool-result":
      return {
        ...base,
        type,
        callId: str(raw.callId, `call-${index}`),
        tool: str(raw.tool, "tool"),
        ok: raw.ok !== false,
        summary: str(raw.summary),
        output: raw.output ?? null,
        ...(num(raw.ms) !== null ? { ms: num(raw.ms) as number } : {}),
      };
    case "applied-tx": {
      const tx = (raw.tx && typeof raw.tx === "object" ? raw.tx : {}) as Record<string, unknown>;
      const dropped = Array.isArray(raw.dropped) ? raw.dropped.length : (num(raw.dropped) ?? 0);
      return {
        ...base,
        type,
        txId: typeof tx.id === "string" ? tx.id : null,
        label: typeof tx.label === "string" ? tx.label : null,
        applied: num(raw.applied) ?? 0,
        dropped,
        touched: strings(raw.touched),
      };
    }
    case "preview":
      return {
        ...base,
        type,
        url: typeof raw.url === "string" ? raw.url : null,
        width: num(raw.width),
        height: num(raw.height),
        pageId: typeof raw.pageId === "string" ? raw.pageId : null,
      };
    case "plan":
      return { ...base, type, steps: planSteps(raw.steps) };
    case "credits":
      return { ...base, type, used: num(raw.used) ?? 0, remaining: num(raw.remaining) };
    case "question":
      return { ...base, type, question: str(raw.question), options: strings(raw.options) };
    case "answer":
      return { ...base, type, answer: str(raw.answer) };
    case "error":
      return {
        ...base,
        type,
        message: str(raw.message, "Something went wrong."),
        ...(typeof raw.code === "string" ? { code: raw.code } : {}),
        recoverable: raw.recoverable === true,
      };
    case "done": {
      const status = str(raw.status, "completed");
      return {
        ...base,
        type,
        status: (DONE_STATUSES.has(status) ? status : "failed") as Exclude<RunStatus, "yielded">,
        summary: str(raw.summary),
        steps: num(raw.steps) ?? 0,
        credits: num(raw.credits) ?? 0,
      };
    }
    case "workflow-step":
      return {
        ...base,
        type,
        stepId: str(raw.stepId),
        label: str(raw.label, "Step"),
        status: str(raw.status, "running"),
        done: num(raw.done) ?? 0,
        total: num(raw.total) ?? 0,
        credits: num(raw.credits) ?? 0,
      };
    case "workflow-output": {
      const output = (raw.output && typeof raw.output === "object" ? raw.output : {}) as Record<
        string,
        unknown
      >;
      return {
        ...base,
        type,
        label: str(output.label, "Output"),
        designId: typeof output.designId === "string" ? output.designId : null,
        stepId: typeof output.stepId === "string" ? output.stepId : null,
      };
    }
    case "workflow-done":
      return {
        ...base,
        type,
        status: str(raw.status, "completed"),
        credits: num(raw.credits) ?? 0,
        ...(typeof raw.error === "string" ? { error: raw.error } : {}),
      };
    default:
      return null;
  }
}

/**
 * A browser-run AgentEvent as a RunEvent. Preview bytes become an object URL (`previewUrl` creates it so the
 * session can revoke it later).
 */
export function fromAgentEvent(
  event: AgentEvent,
  index: number,
  previewUrl: (bytes: Uint8Array, mime: string) => string | null,
): RunEvent | null {
  if (event.type === "preview") {
    return {
      index,
      ts: Date.now(),
      type: "preview",
      url: previewUrl(event.bytes, event.mime),
      width: event.width,
      height: event.height,
      pageId: event.pageId ?? null,
    };
  }
  if (event.type === "done" && event.status === "yielded") return null;
  return normalizeEvent({
    ...(event as unknown as Record<string, unknown>),
    index,
    ts: Date.now(),
  });
}
