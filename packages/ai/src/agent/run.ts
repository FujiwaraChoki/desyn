// runAgent: the design agent loop on AI SDK 7's ToolLoopAgent. Streams events (thinking, text, tool calls and
// results, applied transactions, previews), enforces step / credit / token caps, supports cancellation, keeps
// untrusted design content delimited, and returns a run summary for the AI dock and the aiRuns table.
import { getNode } from "@desyn/doc-ops";
import { type Id, newId, type Transaction } from "@desyn/schema";
import {
  hasToolCall,
  isStepCount,
  type LanguageModel,
  type LanguageModelUsage,
  type ModelMessage,
  type StopCondition,
  ToolChoiceViolationError,
  ToolLoopAgent,
  type ToolSet,
} from "ai";
import { redactObject, redactSecrets } from "../byok";
import { CreditMeter } from "../credits";
import { errorMessage, isAiError } from "../errors";
import type { DocHost } from "../host";
import type { ModerationHook } from "../media/moderation";
import type { Media } from "../media/types";
import { type ModelPrefs, textPricing } from "../models";
import { buildSystemPrompt } from "../prompts/system";
import type { AiProviders } from "../providers/config";
import { createDesignTools, type ToolName } from "../tools";
import {
  type AgentMode,
  createRunState,
  type PlanStep,
  type SearchProviders,
  type TextModels,
  type ToolContext,
  type WorkflowLauncher,
} from "../tools/types";
import { type FetchLike, isAbortError } from "../util/async";
import type { AgentEvent, AgentEventHandler, RunStatus } from "./events";
import { routeAgentModel, routeTextModels, setupMedia } from "./setup";

export interface AgentBudget {
  /** Hard cap on credits for this run (agent turns + media). */
  credits?: number;
  /** Cap on total tokens across steps. */
  tokens?: number;
  /** Cap on estimated provider cost in USD (uses catalog / pinned prices). */
  usd?: number;
}

export interface RunAgentOptions {
  host: DocHost;
  goal: string;
  /** Overrides the host selection for this run. */
  selection?: Id[];
  mode?: AgentMode;
  /** Earlier conversation turns (user / assistant / tool messages from previous runs). */
  history?: ModelMessage[];
  /** Provider access; required unless `model` (and optional media/text models) are injected. */
  providers?: AiProviders;
  prefs?: ModelPrefs;
  /** Explicit agent model (tests, evals, local runs). */
  model?: LanguageModel;
  signal?: AbortSignal;
  onEvent?: AgentEventHandler;
  maxSteps?: number;
  budget?: AgentBudget;
  runId?: string;
  search?: SearchProviders;
  workflows?: WorkflowLauncher;
  moderation?: ModerationHook;
  fetch?: FetchLike;
  /** Tool allowlist (defaults to the mode's tools). */
  allowTools?: readonly ToolName[];
  /** Called before destructive bulk edits; absent means "refuse and ask the user". */
  confirmDestructive?: ToolContext["confirmDestructive"];
  /** The user already approved destructive edits (e.g. answered a confirmation question). */
  allowDestructive?: boolean;
  /** Generate mode: maximum critique → fix rounds (default 2). */
  maxFixRounds?: number;
  /** Inject media (tests) or disable it with `false`. */
  media?: Media | false;
  /** Inject copy / translate / critique models (tests). */
  textModels?: TextModels;
  temperature?: number;
  /** Shared meter (workflows run several agents on one budget). */
  meter?: CreditMeter;
  /** Charge `agent.turn` per step (default true; generateDesign bills one generateDesign instead). */
  chargeTurns?: boolean;
  agentName?: string;
  /**
   * Checked after every step: returning true ends this call between steps without forcing `finish`, so a
   * host with a time limit (Convex actions) can continue the run later from `history` + `responseMessages`.
   * The result then has status "yielded" and no `done` event is emitted.
   */
  yieldWhen?: () => boolean;
}

export interface RunAgentResult {
  runId: string;
  status: RunStatus;
  summary: string;
  changes: string[];
  followUps: string[];
  question?: { question: string; options: string[] };
  steps: number;
  usage: { inputTokens: number; outputTokens: number; totalTokens: number };
  credits: number;
  costUsd?: number;
  transactions: Transaction[];
  createdIds: Id[];
  plan: PlanStep[];
  /** New messages of this run (assistant + tool) to append to the conversation history. */
  responseMessages: ModelMessage[];
  error?: { message: string; code?: string };
}

const DEFAULT_STEPS: Record<AgentMode, number> = { edit: 24, generate: 48, critique: 8 };
const MAX_CONTEXT_CHARS = 400_000;

function truncateForEvent(value: unknown): unknown {
  return redactObject(
    JSON.parse(
      JSON.stringify(value ?? null, (_k, v) =>
        typeof v === "string" && v.length > 2000 ? `${v.slice(0, 2000)}… (${v.length} chars)` : v,
      ),
    ),
  );
}

/** Replaces all but the latest preview images in tool results with a placeholder and prunes very long histories. */
export function compactMessages(messages: ModelMessage[]): ModelMessage[] {
  let lastImage = -1;
  messages.forEach((m, i) => {
    if (
      m.role === "tool" &&
      m.content.some(
        (p) =>
          p.type === "tool-result" &&
          p.output.type === "content" &&
          p.output.value.some((v) => v.type === "file"),
      )
    )
      lastImage = i;
  });
  const out = messages.map((m, i): ModelMessage => {
    if (m.role !== "tool" || i === lastImage) return m;
    return {
      ...m,
      content: m.content.map((p) => {
        if (p.type !== "tool-result" || p.output.type !== "content") return p;
        const value = p.output.value.map((v) =>
          v.type === "file" ? { type: "text" as const, text: "[earlier preview omitted]" } : v,
        );
        return { ...p, output: { ...p.output, value } };
      }),
    };
  });
  const size = JSON.stringify(out).length;
  if (size <= MAX_CONTEXT_CHARS) return out;
  // Drop old reasoning first, then old tool call/result pairs, keeping the latest 12 messages intact.
  const head = out
    .slice(0, -12)
    .filter((m) => m.role === "user" || m.role === "system" || m.role === "assistant")
    .map(
      (m): ModelMessage =>
        m.role === "assistant" && Array.isArray(m.content)
          ? { ...m, content: m.content.filter((p) => p.type === "text") }
          : m,
    )
    .filter((m) => !(m.role === "assistant" && Array.isArray(m.content) && m.content.length === 0));
  return [...head, ...out.slice(-12)];
}

function addUsage(
  total: { inputTokens: number; outputTokens: number; totalTokens: number },
  usage: LanguageModelUsage,
) {
  total.inputTokens += usage.inputTokens ?? 0;
  total.outputTokens += usage.outputTokens ?? 0;
  total.totalTokens += usage.totalTokens ?? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
}

function outputSummary(output: unknown): { ok: boolean; summary: string } {
  const o = output as { ok?: unknown; summary?: unknown; error?: unknown };
  if (o && typeof o === "object" && "ok" in o) {
    return {
      ok: o.ok === true,
      summary: String(o.ok === true ? (o.summary ?? "") : (o.error ?? "failed")),
    };
  }
  return { ok: true, summary: "" };
}

export async function runAgent(options: RunAgentOptions): Promise<RunAgentResult> {
  const runId = options.runId ?? newId();
  const mode = options.mode ?? "edit";
  const maxSteps = Math.max(2, options.maxSteps ?? DEFAULT_STEPS[mode]);
  const run = createRunState(runId, mode);
  run.allowDestructive = options.allowDestructive === true;
  const usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  const meter = options.meter ?? new CreditMeter(options.budget?.credits ?? null);
  const creditsAtStart = meter.used;
  let budgetHit = false;
  let yieldRequested = false;
  let lastFinishReason: string | undefined;
  // Why the last step forced `finish` (a model that ignores the forced tool choice must not turn a cap into a failure).
  let forcedFinish: "budget" | "steps" | null = null;
  let steps = 0;
  const emit = (event: AgentEvent) => {
    try {
      options.onEvent?.(event);
    } catch {
      // A failing listener must never break the run.
    }
  };
  const result: RunAgentResult = {
    runId,
    status: "failed",
    summary: "",
    changes: [],
    followUps: [],
    steps: 0,
    usage,
    credits: 0,
    transactions: run.transactions,
    createdIds: [],
    plan: run.plan,
    responseMessages: [],
  };

  let agentModel: ReturnType<typeof routeAgentModel>;
  try {
    if (!options.providers && !options.model)
      throw new Error("runAgent needs `providers` or an explicit `model`.");
    agentModel = routeAgentModel({
      ...(options.providers
        ? { providers: options.providers }
        : ({} as { providers: AiProviders })),
      ...(options.prefs ? { prefs: options.prefs } : {}),
      ...(options.model ? { model: options.model } : {}),
    });
  } catch (error) {
    result.error = {
      message: errorMessage(error),
      ...(isAiError(error) ? { code: error.code } : {}),
    };
    result.summary = result.error.message;
    emit({
      type: "error",
      runId,
      message: result.summary,
      ...(result.error.code ? { code: result.error.code } : {}),
      recoverable: false,
    });
    emit({
      type: "done",
      runId,
      status: "failed",
      summary: result.summary,
      steps: 0,
      credits: 0,
      at: Date.now(),
    });
    return result;
  }

  const media =
    options.media === false
      ? undefined
      : (options.media ??
        (options.providers
          ? setupMedia({
              providers: options.providers,
              ...(options.prefs ? { prefs: options.prefs } : {}),
              ...(options.moderation ? { moderation: options.moderation } : {}),
              meter,
              ...(options.fetch ? { fetch: options.fetch } : {}),
              runId,
              emit,
            })
          : undefined));
  const textModels =
    options.textModels ??
    (options.providers
      ? routeTextModels({
          providers: options.providers,
          ...(options.prefs ? { prefs: options.prefs } : {}),
        })
      : {});
  const host: DocHost = options.selection
    ? new Proxy(options.host, {
        get: (t, p, r) => (p === "selection" ? options.selection : Reflect.get(t, p, r)),
      })
    : options.host;
  const ctx: ToolContext = {
    host,
    run,
    meter,
    emit,
    ...(media ? { media } : {}),
    ...(options.search ? { search: options.search } : {}),
    models: textModels,
    ...(options.workflows ? { workflows: options.workflows } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.confirmDestructive ? { confirmDestructive: options.confirmDestructive } : {}),
    agentName: options.agentName ?? "desyn",
  };
  const tools: ToolSet = createDesignTools(
    ctx,
    options.allowTools ? { allow: options.allowTools } : {},
  );
  const design = host.getDesign();
  const pageId = host.page;
  const page = pageId ? getNode(design, pageId) : undefined;
  const maxFixRounds = options.maxFixRounds ?? 2;
  const instructions = buildSystemPrompt({
    mode,
    design,
    ...(page?.type === "page" ? { page } : {}),
    selection: host.selection,
    ...(host.brand ? { brand: host.brand } : {}),
    goal: options.goal,
    maxFixRounds,
  });
  const pricing = textPricing(agentModel.modelId);
  const costUsd = () =>
    pricing
      ? (usage.inputTokens * pricing.input + usage.outputTokens * pricing.output) / 1e6
      : undefined;

  const overBudget = (): boolean => {
    if (meter.limit !== null && meter.used >= meter.limit) return true;
    if (options.budget?.tokens !== undefined && usage.totalTokens >= options.budget.tokens)
      return true;
    const usd = costUsd();
    if (options.budget?.usd !== undefined && usd !== undefined && usd >= options.budget.usd)
      return true;
    return false;
  };
  const budgetStop: StopCondition<ToolSet> = () => {
    if (overBudget()) budgetHit = true;
    return budgetHit;
  };
  const yieldStop: StopCondition<ToolSet> = () => {
    if (!yieldRequested && options.yieldWhen?.()) yieldRequested = true;
    return yieldRequested;
  };
  const toolNames = Object.keys(tools);

  const agent = new ToolLoopAgent({
    model: agentModel.model,
    instructions,
    tools,
    stopWhen: [isStepCount(maxSteps), hasToolCall("finish"), budgetStop, yieldStop],
    temperature: options.temperature ?? (mode === "generate" ? 0.6 : 0.3),
    maxRetries: 2,
    prepareStep: ({ stepNumber, messages }) => {
      const nearStepLimit = stepNumber >= maxSteps - 1;
      const nearBudget =
        meter.limit !== null &&
        options.chargeTurns !== false &&
        meter.wouldExceed("agent.turn", agentModel.billing, 2);
      const active = toolNames.filter(
        (n) => !(n === "critique" && mode === "generate" && run.critiques > maxFixRounds),
      );
      const compacted = compactMessages(messages);
      if ((nearStepLimit || nearBudget) && toolNames.includes("finish")) {
        forcedFinish = nearBudget ? "budget" : "steps";
        return {
          // Claude 5.5 rejects forced tool choice; the Anthropic provider then sends only `finish` with "auto",
          // so the instruction below is what actually makes the model wrap up.
          toolChoice: { type: "tool", toolName: "finish" },
          activeTools: ["finish"],
          messages: [
            ...compacted,
            {
              role: "user",
              content: nearBudget
                ? "You are out of budget for this run. Call `finish` now with a short summary of what you changed and what is left."
                : "This is the last step of the run. Call `finish` now with a short summary of what you changed and what is left.",
            },
          ],
        };
      }
      return { activeTools: active, messages: compacted };
    },
  });

  emit({ type: "start", runId, mode, model: agentModel.label, at: Date.now() });
  const messages: ModelMessage[] = [
    ...(options.history ?? []),
    { role: "user", content: options.goal },
  ];
  const callStarted = new Map<string, number>();
  let finalText = "";
  try {
    const stream = await agent.stream({
      messages,
      ...(options.signal ? { abortSignal: options.signal } : {}),
    });
    for await (const part of stream.fullStream) {
      switch (part.type) {
        case "start-step":
          steps++;
          emit({ type: "step", runId, step: steps, at: Date.now() });
          break;
        case "reasoning-delta":
          if (part.text) emit({ type: "thinking", runId, text: part.text });
          break;
        case "text-delta":
          finalText += part.text;
          emit({ type: "text", runId, text: part.text });
          break;
        case "tool-call":
          callStarted.set(part.toolCallId, Date.now());
          emit({
            type: "tool-call",
            runId,
            callId: part.toolCallId,
            tool: part.toolName,
            input: truncateForEvent(part.input),
            at: Date.now(),
          });
          if (part.toolName === "ask_user") {
            const q = part.input as { question?: string; options?: string[] };
            run.question = {
              question: String(q.question ?? ""),
              options: Array.isArray(q.options) ? q.options.map(String) : [],
            };
            emit({
              type: "question",
              runId,
              question: run.question.question,
              options: run.question.options,
            });
          }
          break;
        case "tool-result": {
          const { ok, summary } = outputSummary(part.output);
          const started = callStarted.get(part.toolCallId);
          emit({
            type: "tool-result",
            runId,
            callId: part.toolCallId,
            tool: part.toolName,
            ok,
            summary,
            output: truncateForEvent(part.output),
            ...(started ? { ms: Date.now() - started } : {}),
          });
          break;
        }
        case "tool-error":
          emit({
            type: "tool-result",
            runId,
            callId: part.toolCallId,
            tool: part.toolName,
            ok: false,
            summary: redactSecrets(errorMessage(part.error)),
            output: null,
          });
          break;
        case "finish-step": {
          lastFinishReason = part.finishReason;
          addUsage(usage, part.usage);
          if (options.chargeTurns !== false)
            meter.charge("agent.turn", agentModel.billing, { ref: runId });
          emit({
            type: "credits",
            runId,
            used: meter.used - creditsAtStart,
            remaining: meter.remaining,
          });
          if (part.finishReason !== "tool-calls") finalText = finalText.trim();
          else finalText = "";
          break;
        }
        case "error":
          if (forcedFinish && ToolChoiceViolationError.isInstance(part.error)) {
            if (forcedFinish === "budget") budgetHit = true;
            break;
          }
          emit({
            type: "error",
            runId,
            message: redactSecrets(errorMessage(part.error)),
            recoverable: false,
          });
          result.error = { message: redactSecrets(errorMessage(part.error)) };
          break;
        default:
          break;
      }
    }
    try {
      result.responseMessages = (await stream.responseMessages) as ModelMessage[];
    } catch {
      result.responseMessages = [];
    }
  } catch (error) {
    if (isAbortError(error) || options.signal?.aborted) {
      result.status = "cancelled";
    } else if (forcedFinish && ToolChoiceViolationError.isInstance(error)) {
      // The model ignored the forced `finish`; report the cap that forced it instead of a failure.
      if (forcedFinish === "budget") budgetHit = true;
    } else {
      result.error = {
        message: redactSecrets(errorMessage(error)),
        ...(isAiError(error) ? { code: error.code } : {}),
      };
    }
  }

  result.steps = steps;
  result.credits = meter.used - creditsAtStart;
  const usd = costUsd();
  if (usd !== undefined) result.costUsd = Math.round(usd * 10000) / 10000;
  result.createdIds = [...run.created].filter((id) => getNode(host.getDesign(), id));

  if (options.signal?.aborted) {
    result.status = "cancelled";
    result.summary =
      run.transactions.length > 0
        ? `Stopped. ${run.transactions.length} change(s) were applied before stopping.`
        : "Stopped before making changes.";
  } else if (run.finished) {
    result.status = "completed";
    result.summary = run.finished.summary;
    result.changes = run.finished.changes;
    result.followUps = run.finished.followUps;
  } else if (run.question) {
    result.status = "needs-input";
    result.summary = run.question.question;
    result.question = { question: run.question.question, options: run.question.options };
  } else if (result.error) {
    result.status = "failed";
    result.summary = result.error.message;
  } else if (budgetHit) {
    result.status = "budget-exceeded";
    result.summary = `Stopped at the run's budget after ${steps} step(s)${run.transactions.length ? ` and ${run.transactions.length} change(s)` : ""}.`;
  } else if (yieldRequested && lastFinishReason === "tool-calls" && steps < maxSteps) {
    // Paused between steps by the host: the conversation continues from responseMessages.
    result.status = "yielded";
    result.summary = `Paused after ${steps} step(s); the run continues.`;
    return result;
  } else if (steps >= maxSteps || forcedFinish === "steps") {
    result.status = "step-limit";
    result.summary =
      finalText ||
      `Reached the step limit (${maxSteps}) after ${run.transactions.length} change(s).`;
  } else {
    result.status = "completed";
    result.summary =
      finalText ||
      (run.transactions.length
        ? `Applied ${run.transactions.length} change(s).`
        : "No changes were needed.");
  }
  emit({
    type: "done",
    runId,
    status: result.status,
    summary: result.summary,
    steps,
    credits: result.credits,
    at: Date.now(),
  });
  return result;
}
