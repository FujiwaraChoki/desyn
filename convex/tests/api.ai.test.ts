import {
  AiRunEventListSchema,
  AiRunSchema,
  ModelListSchema,
  type Schema,
  validate,
  WorkflowSchema,
} from "@desyn/sdk/contract";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { apiUser, call, setupWithAi } from "./api.helpers";
import { setupTest } from "./harness.helpers";

// AI endpoints against a scripted stand-in for the AI backend (convex/ai/api.ts, see lib/api_ai.ts).

function expectSchema(schema: Schema, value: unknown) {
  const result = validate(schema, value);
  if (!result.success)
    throw new Error(`response does not match the contract: ${JSON.stringify(result.issues)}`);
}

beforeEach(() => {
  vi.stubEnv("DESYN_EDITION", "selfhost");
  vi.stubEnv("MAIL_TRANSPORT", "log");
});
afterEach(() => vi.unstubAllEnvs());

async function design(t: ReturnType<typeof setupTest>, key: string): Promise<string> {
  const res = await call(t, "POST", "designs", { key, body: { name: "AI target" } });
  return res.json.id as string;
}

function parseSse(text: string): { id?: string; event: string; data: string }[] {
  return text
    .split("\n\n")
    .filter((block) => block.split("\n").some((l) => l.startsWith("data:")))
    .map((block) => {
      const out: { id?: string; event: string; data: string } = { event: "message", data: "" };
      for (const line of block.split("\n")) {
        if (line.startsWith("id: ")) out.id = line.slice(4);
        if (line.startsWith("event: ")) out.event = line.slice(7);
        if (line.startsWith("data: ")) out.data = line.slice(6);
      }
      return out;
    });
}

describe("AI endpoints", () => {
  test("without the AI backend the endpoints answer 501", async () => {
    const t = setupTest();
    const u = await apiUser(t);
    const id = await design(t, u.key);
    const res = await call(t, "POST", `designs/${id}/agent-runs`, {
      key: u.key,
      body: { goal: "Warmer" },
    });
    expect(res.status).toBe(501);
    expect(res.json.error.code).toBe("NOT_CONFIGURED");
    expect((await call(t, "GET", "ai/models", { key: u.key })).status).toBe(501);
  });

  test("start, get, long-poll events, SSE stream with resume", async () => {
    const t = setupWithAi();
    const u = await apiUser(t);
    const id = await design(t, u.key);
    const started = await call(t, "POST", `designs/${id}/agent-runs`, {
      key: u.key,
      body: { goal: "Make it warmer", mode: "edit" },
    });
    expect(started.status).toBe(202);
    expectSchema(AiRunSchema, started.json);
    const runId = started.json.id as string;
    expect((await call(t, "GET", `agent-runs/${runId}`, { key: u.key })).json.status).toBe(
      "completed",
    );

    // JSON pages reveal events one by one (the fake reveals one more per read).
    const page = await call(t, "GET", `agent-runs/${runId}/events?after=-1&wait=2`, { key: u.key });
    expectSchema(AiRunEventListSchema, page.json);
    expect(page.json.items.map((e: { type: string }) => e.type)).toEqual(["start"]);
    expect(page.json.done).toBe(false);

    const stream = await call(t, "GET", `agent-runs/${runId}/events`, {
      key: u.key,
      headers: { accept: "text/event-stream" },
    });
    expect(stream.status).toBe(200);
    expect(stream.headers.get("content-type")).toContain("text/event-stream");
    const events = parseSse(await stream.res.text());
    expect(events.map((e) => e.event)).toEqual([
      "start",
      "tool-call",
      "tool-result",
      "text",
      "error",
      "done",
      "stream-end",
    ]);
    expect(events[0]?.id).toBe("0");
    expect(JSON.parse(events[4]?.data ?? "{}")).toMatchObject({ recoverable: true });
    expect(JSON.parse(events[5]?.data ?? "{}")).toMatchObject({
      status: "completed",
      summary: "Made it warmer.",
    });

    const resumed = await call(t, "GET", `agent-runs/${runId}/events`, {
      key: u.key,
      headers: { accept: "text/event-stream", "last-event-id": "3" },
    });
    expect(parseSse(await resumed.res.text()).map((e) => e.event)).toEqual([
      "error",
      "done",
      "stream-end",
    ]);
  });

  test("questions, answers, cancel, fair-use errors and isolation", async () => {
    const t = setupWithAi();
    const u = await apiUser(t);
    const other = await apiUser(t);
    const id = await design(t, u.key);
    const asking = await call(t, "POST", `designs/${id}/agent-runs`, {
      key: u.key,
      body: { goal: "ask me" },
    });
    expect(asking.json).toMatchObject({
      status: "needs-input",
      question: { question: "Keep the price?" },
    });
    const answered = await call(t, "POST", `agent-runs/${asking.json.id}/answer`, {
      key: u.key,
      body: { answer: "Yes" },
    });
    expect(answered.json).toMatchObject({
      status: "completed",
      result: { summary: "Done (Yes)." },
    });
    const again = await call(t, "POST", `agent-runs/${asking.json.id}/answer`, {
      key: u.key,
      body: { answer: "No" },
    });
    expect(again.status).toBe(409);

    const second = await call(t, "POST", `designs/${id}/agent-runs`, {
      key: u.key,
      body: { goal: "ask again" },
    });
    const cancelled = await call(t, "POST", `agent-runs/${second.json.id}/cancel`, { key: u.key });
    expect(cancelled.json.status).toBe("cancelled");

    const busy = await call(t, "POST", `designs/${id}/agent-runs`, {
      key: u.key,
      body: { goal: "busy" },
    });
    expect(busy.status).toBe(429);
    expect(busy.json.error).toMatchObject({
      code: "RATE_LIMITED",
      scope: "concurrency",
      retryAfterMs: 4000,
    });
    expect(busy.headers.get("retry-after")).toBe("4");

    expect((await call(t, "GET", `agent-runs/${second.json.id}`, { key: other.key })).status).toBe(
      404,
    );
    expect(
      (await call(t, "POST", `designs/${id}/agent-runs`, { key: other.key, body: { goal: "x" } }))
        .status,
    ).toBe(404);
    const noScope = await apiUser(t, { scopes: ["designs:read"] });
    expect((await call(t, "GET", "ai/models", { key: noScope.key })).json.error.code).toBe(
      "INSUFFICIENT_SCOPE",
    );
  });

  test("Idempotency-Key returns the same run", async () => {
    const t = setupWithAi();
    const u = await apiUser(t);
    const id = await design(t, u.key);
    const headers = { "idempotency-key": "run-1" };
    const a = await call(t, "POST", `designs/${id}/agent-runs`, {
      key: u.key,
      body: { goal: "Warmer" },
      headers,
    });
    const b = await call(t, "POST", `designs/${id}/agent-runs`, {
      key: u.key,
      body: { goal: "Warmer" },
      headers,
    });
    expect(b.json.id).toBe(a.json.id);
    expect(b.headers.get("idempotent-replayed")).toBe("true");
  });

  test("asset generation, workflows and models", async () => {
    const t = setupWithAi();
    const u = await apiUser(t);
    const gen = await call(t, "POST", "assets/generate", {
      key: u.key,
      body: { task: "image", prompt: "A sunrise" },
    });
    expect(gen.status).toBe(202);
    expectSchema(AiRunSchema, gen.json);
    expect(gen.json.result).toMatchObject({ refId: "gen000000001" });
    const invalid = await call(t, "POST", "assets/generate", {
      key: u.key,
      body: { task: "image" },
    });
    expect(invalid.status).toBe(400);
    expect(invalid.json.error.field).toBe("prompt");
    const badTask = await call(t, "POST", "assets/generate", {
      key: u.key,
      body: { task: "paint" },
    });
    expect(badTask.status).toBe(400);

    const wf = await call(t, "POST", "workflows", {
      key: u.key,
      body: { type: "localize", input: { languages: ["de", "ar"] } },
    });
    expect(wf.status).toBe(202);
    expectSchema(WorkflowSchema, wf.json);
    expect(wf.json.progress).toEqual({ done: 0, total: 2 });
    expect((await call(t, "GET", `workflows/${wf.json.id}`, { key: u.key })).json.id).toBe(
      wf.json.id,
    );
    const empty = await call(t, "POST", "workflows", {
      key: u.key,
      body: { type: "localize", input: {} },
    });
    expect(empty.status).toBe(400);

    const models = await call(t, "GET", "ai/models?task=agent", { key: u.key });
    expectSchema(ModelListSchema, models.json);
    expect(Object.keys(models.json.tasks)).toEqual(["agent"]);
  });

  test("MCP AI tools wait for the run and surface questions", async () => {
    const t = setupWithAi();
    const u = await apiUser(t);
    const id = await design(t, u.key);
    const callTool = async (name: string, args: object) =>
      (
        await call(t, "POST", "/mcp", {
          key: u.key,
          body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
        })
      ).json.result as {
        content: { text: string }[];
        structuredContent: Record<string, unknown>;
        isError?: boolean;
      };
    const done = await callTool("start_ai_run", { designId: id, goal: "Make it warmer" });
    expect(done.content[0]?.text).toContain("completed: Made it warmer.");
    const asking = await callTool("start_ai_run", { designId: id, goal: "ask me" });
    expect(asking.content[0]?.text).toContain("Keep the price?");
    const runId = asking.structuredContent.id as string;
    const answered = await callTool("answer_ai_run", { runId, answer: "Yes", waitSeconds: 5 });
    expect(answered.content[0]?.text).toContain("Done (Yes)");
    const busy = await callTool("start_ai_run", { designId: id, goal: "busy" });
    expect(busy.isError).toBe(true);
    expect(busy.content[0]?.text).toContain("RATE_LIMITED");
  });
});
