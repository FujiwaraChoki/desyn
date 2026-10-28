"use node";

import {
  type AgentEvent,
  CreditMeter,
  compactMessages,
  createRuleModeration,
  type RunAgentResult,
  runAgent,
  type WorkflowLauncher,
} from "@desyn/ai";
import { newId } from "@desyn/schema";
import type { ModelMessage } from "ai";
import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { type ActionCtx, internalAction } from "../_generated/server";
import { modelPrefs, parseOverride } from "../lib/ai_access";
import {
  askUserCallId,
  closeOpenToolCalls,
  convexHostBackend,
  EventSink,
  loadHistory,
  saveHistory,
  searchProviders,
} from "../lib/ai_backend";
import { WorkerHost } from "../lib/ai_host";
import { guardedFetch } from "../lib/ai_net";
import { createRunProviders } from "../lib/ai_providers";
import { CHUNK_MS, clip, preview } from "../lib/ai_runs";
import { isHosted } from "../lib/env";
import { isAppError } from "../lib/errors";
import { createLogger } from "../lib/logger";

// The agent loop of a server run (SPEC §7), one chunk per scheduled action. A chunk claims the run
// (beginChunk), rebuilds provider access (BYOK keys decrypted here only), opens a WorkerHost on the design,
// replays the stored conversation and runs @desyn/ai `runAgent` until it finishes, asks the user, or yields
// before Convex's action time limit; endChunk then schedules the next chunk or settles the run. Events stream
// into aiRunEvents in batches; cancellation is polled through the same mutation.

const CONTINUE_PROMPT =
  "Continue the task from where you stopped. Do not repeat finished work; call finish when done.";
const POLL_MS = 2_000;

function attachmentNote(
  refs: { id: string; kind: string; width?: number; height?: number; name?: string }[],
) {
  if (refs.length === 0) return "";
  const lines = refs.map(
    (r) =>
      `- ${r.kind} asset id "${r.id}"${r.name ? ` (${r.name})` : ""}${r.width && r.height ? `, ${r.width}×${r.height}` : ""}`,
  );
  return `\n\nAttached files (already added to the design's assets; reference them by asset id):\n${lines.join("\n")}`;
}

export const runChunk = internalAction({
  args: { runId: v.id("aiRuns"), chunk: v.number() },
  handler: async (ctx, args) => {
    const begin = await ctx.runMutation(internal.ai.internal.beginChunk, args);
    if (!begin) return null;
    const { run } = begin;
    const log = createLogger(ctx, { fn: "ai.runChunk", runId: args.runId, chunk: args.chunk });
    const started = Date.now();
    const deadline = started + CHUNK_MS;
    const controller = new AbortController();
    const fetchImpl = guardedFetch({ enabled: isHosted() });
    const sink = new EventSink({
      push: (events) => ctx.runMutation(internal.ai.internal.pushEvents, { ...args, events }),
      storePreview: async (bytes, mime) =>
        await ctx.storage.store(new Blob([bytes as BlobPart], { type: mime })),
      onStop: () => controller.abort(),
      // The run's `start` event was emitted by its first chunk, and a question is a pause, not the end:
      // the run's single `done` event comes when it really ends.
      skip: (e) =>
        (e.type === "start" && !run.first) || (e.type === "done" && e.status === "needs-input"),
    });
    const poller = setInterval(() => sink.poll(), POLL_MS);
    let outcome: RunAgentResult | null = null;
    let history: ModelMessage[] = [];
    let goal = run.goal;
    try {
      const { providers, failedKeys } = await createRunProviders({
        userId: run.userId,
        settings: begin.settings,
        byokAllowed: begin.byokAllowed,
        localAllowed: begin.localAllowed,
        fetch: fetchImpl,
      });
      if (failedKeys.length > 0) {
        sink.push({
          type: "error",
          runId: run.id,
          message: `Your saved key for ${failedKeys.join(", ")} could not be read; using the server's models instead. Re-enter it in Settings › AI providers.`,
          code: "byok-unreadable",
          recoverable: true,
        });
      }
      const host = await WorkerHost.open(
        convexHostBackend(ctx, {
          designId: run.designId,
          userId: run.userId,
          workspaceId: run.workspaceId,
          runId: run.id,
        }),
        {
          selection: run.selection,
          ...(run.pageId ? { page: run.pageId } : {}),
          ...(begin.brand ? { brand: begin.brand.kit } : {}),
        },
      );
      // Attachments and brand logos must be in the design's assets before tools can reference them. Critique
      // runs never edit (viewers may run them), so they only read what the design already has.
      const missing = [...begin.attachments, ...(begin.brand?.logoRefs ?? [])].filter(
        (ref) => !host.getDesign().assets[ref.id],
      );
      if (run.first && run.mode !== "critique" && missing.length > 0) {
        await host.apply({
          id: newId(),
          label: "AI: add attachments",
          ops: [{ op: "asset", set: Object.fromEntries(missing.map((r) => [r.id, r])) }],
          source: "ai",
          actor: { userId: run.userId, runId: run.id, agent: "desyn" },
          ts: Date.now(),
        });
      }

      history = closeOpenToolCalls(await loadHistory(ctx, begin.historyId), run.answer);
      if (run.first) {
        goal = `${run.goal}${run.mode === "critique" ? "" : attachmentNote(begin.attachments)}`;
      } else if (run.answer !== null) {
        goal = run.question?.callId
          ? `My answer: ${run.answer}`
          : `My answer to your question: ${run.answer}`;
      } else {
        goal = CONTINUE_PROMPT;
      }
      const prefs = modelPrefs(
        begin.settings,
        run.modelOverride ? { task: "agent", ref: parseOverride(run.modelOverride) } : undefined,
      );
      const budget = run.maxCredits === null ? null : Math.max(0, run.maxCredits - run.creditsUsed);
      const workflows: WorkflowLauncher = {
        start: async (name, input) =>
          await ctx.runMutation(internal.ai.workflows.startFromAgent, {
            runId: run.id,
            type: name,
            input: JSON.stringify(input),
          }),
      };
      outcome = await runAgent({
        host,
        goal,
        mode: run.mode,
        history,
        providers,
        prefs,
        signal: controller.signal,
        onEvent: (event: AgentEvent) => sink.push(event),
        maxSteps: Math.max(2, run.maxSteps - run.steps),
        meter: new CreditMeter(budget),
        runId: run.id,
        search: searchProviders(ctx, run.userId, fetchImpl),
        workflows,
        moderation: createRuleModeration(),
        fetch: fetchImpl,
        yieldWhen: () => Date.now() > deadline,
        // Destructive bulk edits are confirmed through ask_user; the user's answer approves them.
        allowDestructive: run.answer !== null,
        agentName: "desyn",
      });
    } catch (err) {
      clearInterval(poller);
      await sink.flush().catch(() => undefined);
      const message = isAppError(err)
        ? (err.data as { message: string }).message
        : err instanceof Error
          ? err.message
          : String(err);
      log.error("agent chunk crashed", { error: clip(message, 500) });
      await log.flush();
      await ctx.runMutation(internal.ai.internal.endChunk, {
        ...args,
        status: "failed",
        summary: "The AI run failed.",
        changes: [],
        followUps: [],
        error: clip(message, 1000),
        ...(isAppError(err) ? { errorCode: (err.data as { code: string }).code } : {}),
        steps: 0,
        credits: 0,
        inputTokens: 0,
        outputTokens: 0,
        transactions: 0,
        emitDone: true,
      });
      return null;
    }
    clearInterval(poller);
    await sink.flush();

    const result = outcome;
    let historyId: Id<"_storage"> | undefined;
    // Keep the conversation for continuation chunks, answers and follow-up runs (old previews compacted).
    if (result.status !== "cancelled" || result.responseMessages.length > 0) {
      const next = compactMessages([
        ...history,
        { role: "user", content: goal },
        ...result.responseMessages,
      ]);
      historyId = await saveHistory(ctx, next);
    }
    const question =
      result.status === "needs-input" && result.question
        ? {
            question: result.question.question,
            options: result.question.options,
            ...(askUserCallId(result.responseMessages)
              ? { callId: askUserCallId(result.responseMessages) as string }
              : {}),
          }
        : undefined;
    await ctx.runMutation(internal.ai.internal.endChunk, {
      ...args,
      status: result.status,
      summary: clip(result.summary, 4000),
      changes: result.changes.slice(0, 20).map((c) => clip(c, 500)),
      followUps: result.followUps.slice(0, 3).map((c) => clip(c, 300)),
      ...(question ? { question } : {}),
      ...(result.error ? { error: clip(result.error.message, 1000) } : {}),
      ...(result.error?.code ? { errorCode: result.error.code } : {}),
      steps: result.steps,
      credits: result.credits,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      ...(result.costUsd !== undefined ? { costUsd: result.costUsd } : {}),
      transactions: result.transactions.length,
      ...(historyId ? { historyId } : {}),
      emitDone: false,
    });
    log.info("agent chunk finished", {
      status: result.status,
      steps: result.steps,
      credits: result.credits,
      transactions: result.transactions.length,
      ms: Date.now() - started,
      goal: preview(goal),
    });
    await log.flush();
    return null;
  },
});

export type { ActionCtx };
