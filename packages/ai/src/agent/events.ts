// Streaming events emitted by an agent run. Convex stores them in `aiRunEvents`; the web app renders them live in
// the AI dock. Every event is JSON-serializable except `preview.bytes` (Uint8Array), which servers upload and
// replace with an asset reference before persisting.
import type { Id, Op, Transaction } from "@desyn/schema";

export type AgentEvent =
  | { type: "start"; runId: string; mode: string; model: string; at: number }
  | { type: "step"; runId: string; step: number; at: number }
  | { type: "thinking"; runId: string; text: string }
  | { type: "text"; runId: string; text: string }
  | { type: "tool-call"; runId: string; callId: string; tool: string; input: unknown; at: number }
  | {
      type: "tool-result";
      runId: string;
      callId: string;
      tool: string;
      ok: boolean;
      summary: string;
      output: unknown;
      ms?: number;
    }
  | {
      type: "applied-tx";
      runId: string;
      tx: Transaction;
      applied: number;
      dropped: { index: number; reason: string }[];
      /** Ops that took effect (as returned by the host). */
      ops: Op[];
      touched: Id[];
    }
  | {
      type: "preview";
      runId: string;
      mime: string;
      width: number;
      height: number;
      bytes: Uint8Array;
      pageId?: Id;
    }
  | {
      type: "plan";
      runId: string;
      steps: { id: string; title: string; status: string; checkpoint?: boolean }[];
    }
  | { type: "progress"; runId: string; label: string; detail?: string }
  | { type: "credits"; runId: string; used: number; remaining: number | null }
  | { type: "question"; runId: string; question: string; options: string[] }
  | { type: "error"; runId: string; message: string; code?: string; recoverable: boolean }
  | {
      type: "done";
      runId: string;
      status: RunStatus;
      summary: string;
      steps: number;
      credits: number;
      at: number;
    };

export type RunStatus =
  | "completed"
  | "needs-input"
  | "cancelled"
  | "budget-exceeded"
  | "step-limit"
  | "failed"
  /**
   * The host paused the loop between steps (`RunAgentOptions.yieldWhen`) to continue it later, e.g. in a new
   * Convex action. Never sent in a `done` event: the run is not over.
   */
  | "yielded";

export type AgentEventHandler = (event: AgentEvent) => void;
