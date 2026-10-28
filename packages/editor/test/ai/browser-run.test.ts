import type { AgentEvent } from "@desyn/ai";
import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test";
import { describe, expect, test } from "vitest";
import {
  browserSettings,
  type ConversationMessage,
  closeOpenToolCalls,
  runInBrowser,
} from "../../src/ai/local/runner.ts";
import { createTestEditor, fixture, node } from "../editor-helpers.ts";
import { account } from "./fake-ai-backend.ts";

const usage = {
  inputTokens: { total: 100, noCache: 100, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 50, text: 50, reasoning: undefined },
};

interface Turn {
  text?: string;
  calls?: { name: string; input: unknown }[];
}

let callCounter = 0;

/** A streaming mock model that plays one scripted turn per step (AI SDK test utilities, no network). */
function scripted(turns: Turn[]): MockLanguageModelV4 {
  let step = 0;
  return new MockLanguageModelV4({
    modelId: "local-test-model",
    doStream: async () => {
      const turn = turns[Math.min(step++, turns.length - 1)] ?? {};
      const chunks: unknown[] = [{ type: "stream-start", warnings: [] }];
      if (turn.text) {
        chunks.push(
          { type: "text-start", id: "t" },
          { type: "text-delta", id: "t", delta: turn.text },
          { type: "text-end", id: "t" },
        );
      }
      for (const call of turn.calls ?? []) {
        chunks.push({
          type: "tool-call",
          toolCallId: `call-${++callCounter}`,
          toolName: call.name,
          input: JSON.stringify(call.input),
        });
      }
      chunks.push({
        type: "finish",
        finishReason: { unified: turn.calls?.length ? "tool-calls" : "stop", raw: undefined },
        usage,
      });
      return { stream: convertArrayToReadableStream(chunks as never[]) };
    },
  });
}

describe("browser runs", () => {
  test("provider settings: local-mode keys are BYOK, local servers are local", () => {
    const a = account("pro", {
      aiSettings: { keyMode: "local", ollamaBaseUrl: "http://localhost:11434" },
    });
    const settings = browserSettings(a, {
      anthropic: { apiKey: "sk-test" },
      openrouter: { apiKey: "or-test" },
      "openai-compatible": { baseURL: "http://localhost:1234/v1", apiKey: "lm" },
    });
    // Anthropic answers browser requests only with its direct-browser-access opt-in header.
    expect(settings.user).toEqual({
      anthropic: {
        apiKey: "sk-test",
        headers: { "anthropic-dangerous-direct-browser-access": "true" },
      },
      openrouter: { apiKey: "or-test" },
    });
    expect(settings.local).toEqual({
      "openai-compatible": { baseURL: "http://localhost:1234/v1", apiKey: "lm" },
      ollama: { baseURL: "http://localhost:11434" },
    });
    // Server key mode: browser keys are ignored; the free plan gets neither.
    expect(browserSettings(account("pro"), { anthropic: { apiKey: "k" } }).user).toEqual({});
    const free = account("free", { aiSettings: { keyMode: "local", ollamaBaseUrl: "http://x" } });
    expect(browserSettings(free, { anthropic: { apiKey: "k" } })).toEqual({ user: {}, local: {} });
  });

  test("the agent edits through the editor: committed, normalized, one undo step per run", async () => {
    const f = fixture();
    const { editor, server } = await createTestEditor(f.design);
    const events: AgentEvent[] = [];
    const applied: string[] = [];
    const out = await runInBrowser({
      editor,
      account: account("pro"),
      local: {},
      runId: "browserrun01",
      goal: "Move A to the right and add a headline",
      mode: "edit",
      selection: [],
      history: [],
      signal: new AbortController().signal,
      onEvent: (e) => events.push(e),
      onApplied: (tx) => applied.push(tx.label),
      model: scripted([
        { calls: [{ name: "update_elements", input: { updates: [{ id: f.a, x: 300 }] } }] },
        {
          calls: [
            {
              name: "create_elements",
              input: {
                elements: [
                  {
                    type: "text",
                    role: "headline",
                    text: "Golden hour",
                    x: 40,
                    y: 40,
                    width: 600,
                    fontSize: 64,
                  },
                ],
              },
            },
          ],
        },
        { calls: [{ name: "finish", input: { summary: "Moved A and added a headline." } }] },
      ]),
    });
    expect(out.result.status).toBe("completed");
    expect(out.result.summary).toBe("Moved A and added a headline.");
    expect(node(editor, f.a).x).toBe(300);
    const headline = Object.values(editor.design?.nodes ?? {}).find((n) => n.type === "text");
    expect(headline?.role).toBe("headline");
    expect(applied).toHaveLength(2);
    // One undo step for the whole run, tagged with the run id.
    expect(editor.history.undoDepth).toBe(1);
    expect(editor.history.peekUndo()?.runId).toBe("browserrun01");
    // The edits reached the server as AI transactions.
    await new Promise((r) => setTimeout(r, 20));
    expect(server.design.nodes[f.a]?.x).toBe(300);
    expect(events.some((e) => e.type === "applied-tx")).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: "done", status: "completed" });
    expect(out.conversation[0]).toEqual({
      role: "user",
      content: "Move A to the right and add a headline",
    });
    await editor.undo();
    expect(node(editor, f.a).x).toBe(10);
    expect(Object.values(editor.design?.nodes ?? {}).some((n) => n.type === "text")).toBe(false);
  });

  test("ask_user pauses; answering continues the same conversation", async () => {
    const f = fixture();
    const { editor } = await createTestEditor(f.design);
    const model = scripted([
      {
        calls: [{ name: "ask_user", input: { question: "Which color?", options: ["Sun", "Ink"] } }],
      },
      { calls: [{ name: "update_elements", input: { updates: [{ id: f.b, fill: "#ffb02e" }] } }] },
      { calls: [{ name: "finish", input: { summary: "Made B sun-colored." } }] },
    ]);
    const base = {
      editor,
      account: account("pro"),
      local: {},
      runId: "askrun000001",
      mode: "edit" as const,
      selection: [],
      signal: new AbortController().signal,
      onEvent: () => {},
      model,
    };
    const first = await runInBrowser({ ...base, goal: "Recolor B", history: [] });
    expect(first.result.status).toBe("needs-input");
    expect(first.result.question).toEqual({ question: "Which color?", options: ["Sun", "Ink"] });
    const history = closeOpenToolCalls(first.conversation, "Sun");
    const closing = history.at(-1) as Extract<ConversationMessage, { role: "tool" }>;
    expect(closing.content[0]).toMatchObject({
      toolName: "ask_user",
      output: { type: "json", value: { answer: "Sun" } },
    });
    const second = await runInBrowser({
      ...base,
      goal: "My answer: Sun",
      history,
      allowDestructive: true,
    });
    expect(second.result.status).toBe("completed");
    const b = node(editor, f.b);
    expect(b.type === "rect" && b.fills[0]).toMatchObject({ type: "solid", color: "#ffb02e" });
  });

  test("closing open tool calls is a no-op when every call has a result", () => {
    const msgs: ConversationMessage[] = [{ role: "user", content: "hi" }];
    expect(closeOpenToolCalls(msgs, "x")).toBe(msgs);
  });

  test("stopping aborts the run", async () => {
    const f = fixture();
    const { editor } = await createTestEditor(f.design);
    const abort = new AbortController();
    abort.abort();
    const out = await runInBrowser({
      editor,
      account: account("pro"),
      local: {},
      runId: "stopped00001",
      goal: "Anything",
      mode: "edit",
      selection: [],
      history: [],
      signal: abort.signal,
      onEvent: () => {},
      model: scripted([{ calls: [{ name: "finish", input: { summary: "never" } }] }]),
    });
    expect(out.result.status).toBe("cancelled");
  });
});
