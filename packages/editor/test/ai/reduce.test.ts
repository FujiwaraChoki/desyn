import { describe, expect, test } from "vitest";
import { fromAgentEvent, normalizeEvent, type RunEvent } from "../../src/ai/core/events.ts";
import {
  initialRun,
  isActive,
  isFinal,
  phaseLabel,
  reduceEvents,
  reduceRun,
  replyText,
  thinkingSummary,
} from "../../src/ai/core/reduce.ts";
import { describeStep, finishedLabel } from "../../src/ai/core/steps.ts";

const run0 = () =>
  initialRun({ id: "r1", source: "server", mode: "edit", goal: "Warmer", now: 1000 });
let i = 0;
const ev = (e: Record<string, unknown>): RunEvent => {
  const n = normalizeEvent({ index: i++, ts: 1000 + i * 100, ...e });
  if (!n) throw new Error(`bad event ${JSON.stringify(e)}`);
  return n;
};

describe("normalizeEvent", () => {
  test("accepts server rows and rejects malformed ones", () => {
    expect(normalizeEvent({ type: "text", text: "hi" })).toBeNull(); // no index
    expect(normalizeEvent({ index: 0, type: "nope" })).toBeNull();
    const done = normalizeEvent({ index: 3, ts: 5, type: "done", status: "weird", summary: 4 });
    expect(done).toMatchObject({ type: "done", status: "failed", summary: "" });
    const applied = normalizeEvent({
      index: 1,
      type: "applied-tx",
      tx: { id: "tx1", label: "AI: warmer" },
      applied: 2,
      dropped: [{ index: 0, reason: "missing-node" }],
      touched: ["a", 5, "b"],
    });
    expect(applied).toMatchObject({
      txId: "tx1",
      label: "AI: warmer",
      dropped: 1,
      touched: ["a", "b"],
    });
  });

  test("truncated server payloads (scalars only) still normalize", () => {
    const e = normalizeEvent({
      index: 2,
      type: "tool-call",
      truncated: true,
      tool: "create_elements",
    });
    expect(e).toMatchObject({
      type: "tool-call",
      tool: "create_elements",
      callId: "call-2",
      input: null,
    });
  });

  test("browser AgentEvents: previews become object URLs, yielded is not an end", () => {
    const urls: string[] = [];
    const e = fromAgentEvent(
      {
        type: "preview",
        runId: "r",
        mime: "image/png",
        width: 4,
        height: 3,
        bytes: new Uint8Array([1]),
      },
      0,
      () => {
        urls.push("blob:x");
        return "blob:x";
      },
    );
    expect(e).toMatchObject({ type: "preview", url: "blob:x", width: 4, height: 3 });
    expect(
      fromAgentEvent(
        { type: "done", runId: "r", status: "yielded", summary: "", steps: 1, credits: 0, at: 1 },
        1,
        () => null,
      ),
    ).toBeNull();
  });
});

describe("reduceRun", () => {
  test("a full edit run: start, thinking, steps, applied transactions, reply, done", () => {
    i = 0;
    const events = [
      ev({ type: "progress", label: "Queued" }),
      ev({ type: "start", mode: "edit", model: "openrouter:anthropic/claude-sonnet-5.5" }),
      ev({ type: "step", step: 1 }),
      ev({ type: "thinking", text: "The headline is cold. " }),
      ev({ type: "thinking", text: "I will warm the palette." }),
      ev({ type: "tool-call", callId: "c1", tool: "read_design", input: {} }),
      ev({
        type: "tool-result",
        callId: "c1",
        tool: "read_design",
        ok: true,
        summary: "",
        output: {},
        ms: 120,
      }),
      ev({
        type: "tool-call",
        callId: "c2",
        tool: "update_elements",
        input: { updates: [{}, {}] },
      }),
      ev({ type: "applied-tx", tx: { id: "t1" }, applied: 2, touched: ["a", "b"], dropped: [] }),
      ev({
        type: "tool-result",
        callId: "c2",
        tool: "update_elements",
        ok: true,
        summary: "Updated 2 element(s).",
        output: {},
      }),
      ev({ type: "credits", used: 2, remaining: 598 }),
      ev({ type: "text", text: "Warmed the " }),
      ev({ type: "text", text: "**headline** and background." }),
      ev({ type: "done", status: "completed", summary: "Warmer now.", steps: 2, credits: 2 }),
    ];
    const run = reduceEvents(run0(), events);
    expect(run.phase).toBe("completed");
    expect(isFinal(run)).toBe(true);
    expect(run.model).toContain("sonnet");
    expect(run.touched).toEqual(["a", "b"]);
    expect(run.appliedTx).toBe(1);
    expect(run.credits).toEqual({ used: 2, remaining: 598 });
    expect(run.items.map((x) => x.kind)).toEqual(["thinking", "tool", "tool", "text"]);
    const thinking = run.items[0];
    expect(thinking?.kind === "thinking" && thinking.text).toBe(
      "The headline is cold. I will warm the palette.",
    );
    expect(thinking?.kind === "thinking" && thinking.endedAt).not.toBeNull();
    expect(replyText(run)).toBe("Warmed the **headline** and background.");
    const step = run.items[2];
    expect(step?.kind === "tool" && step.status).toBe("ok");
  });

  test("events apply once and in order, even when redelivered", () => {
    i = 0;
    const a = ev({ type: "text", text: "a" });
    const b = ev({ type: "text", text: "b" });
    const once = reduceEvents(run0(), [b, a]);
    expect(replyText(once)).toBe("ab");
    expect(reduceRun(once, a)).toBe(once);
    expect(reduceEvents(once, [a, b])).toBe(once);
  });

  test("ask_user: question pauses, answer resumes", () => {
    i = 0;
    let run = reduceEvents(run0(), [
      ev({ type: "start", mode: "edit", model: "m" }),
      ev({ type: "tool-call", callId: "q", tool: "ask_user", input: { question: "Which?" } }),
      ev({ type: "question", question: "Keep the logo?", options: ["Yes", "No"] }),
      ev({ type: "done", status: "needs-input", summary: "Keep the logo?", steps: 1, credits: 1 }),
    ]);
    expect(run.phase).toBe("needs-input");
    expect(isActive(run)).toBe(false);
    expect(isFinal(run)).toBe(false);
    expect(run.question).toEqual({ question: "Keep the logo?", options: ["Yes", "No"] });
    expect(run.items.filter((x) => x.kind === "tool")).toHaveLength(0);
    expect(phaseLabel(run)).toBe("Waiting for your answer");
    run = reduceRun(run, ev({ type: "answer", answer: "Yes" }));
    expect(run.phase).toBe("running");
    expect(run.question).toBeNull();
    const q = run.items.find((x) => x.kind === "question");
    expect(q?.kind === "question" && q.answer).toBe("Yes");
  });

  test("failure keeps the error; running steps close as failed", () => {
    i = 0;
    const run = reduceEvents(run0(), [
      ev({ type: "tool-call", callId: "x", tool: "generate_image", input: { prompt: "a vase" } }),
      ev({ type: "error", message: "Provider down", recoverable: false }),
      ev({ type: "done", status: "failed", summary: "Provider down", steps: 1, credits: 0 }),
    ]);
    expect(run.error).toBe("Provider down");
    const tool = run.items.find((x) => x.kind === "tool");
    expect(tool?.kind === "tool" && tool.status).toBe("failed");
    expect(phaseLabel(run)).toBe("Failed");
  });

  test("fair use progress marks the run as throttled", () => {
    i = 0;
    const run = reduceEvents(run0(), [
      ev({ type: "progress", label: "Fair use", detail: "Starting in 6 s" }),
    ]);
    expect(run.throttled).toBe(true);
    expect(phaseLabel(run)).toBe("Waiting for fair use");
  });

  test("workflow events build progress rows and outputs", () => {
    i = 0;
    const run = reduceEvents(run0(), [
      ev({
        type: "workflow-step",
        stepId: "s1",
        label: "Resize to Story",
        status: "running",
        done: 0,
        total: 2,
      }),
      ev({
        type: "workflow-step",
        stepId: "s1",
        label: "Resize to Story",
        status: "done",
        done: 1,
        total: 2,
      }),
      ev({ type: "workflow-output", output: { label: "Story", designId: "d2", stepId: "s1" } }),
    ]);
    expect(run.items.filter((x) => x.kind === "workflow")).toHaveLength(1);
    expect(run.items.at(-1)).toMatchObject({ kind: "output", designId: "d2" });
  });

  test("plan tool results stay out of the step list; the plan is shown instead", () => {
    i = 0;
    const run = reduceEvents(run0(), [
      ev({ type: "tool-call", callId: "p", tool: "plan", input: {} }),
      ev({
        type: "plan",
        steps: [{ id: "1", title: "Layout", status: "done" }, { title: "Copy" }, 3],
      }),
      ev({ type: "tool-result", callId: "p", tool: "plan", ok: true, summary: "", output: {} }),
    ]);
    expect(run.plan.map((s) => s.title)).toEqual(["Layout", "Copy"]);
    expect(run.items).toHaveLength(0);
  });
});

describe("step descriptions", () => {
  test("labels come from tool inputs and summaries", () => {
    expect(describeStep("create_elements", { elements: [1, 2, 3] }).running).toBe(
      "Adding 3 elements",
    );
    expect(describeStep("set_text", { items: [{ id: "a", text: "Golden hour" }] }).done).toBe(
      "Wrote “Golden hour”",
    );
    expect(describeStep("translate_text", { locale: "de" }).running).toBe("Translating to de");
    expect(describeStep("generate_image", { prompt: "a vase" }).slow).toBe(true);
    expect(describeStep("mystery_tool", {}).running).toBe("Running mystery tool");
    expect(finishedLabel("update_elements", { updates: [1] }, "ok", "Updated the headline.")).toBe(
      "Updated the headline",
    );
    expect(finishedLabel("remove_background", {}, "failed", "no image")).toBe(
      "Removing the background failed: no image",
    );
  });

  test("thinking summary picks the latest sentence and trims it", () => {
    expect(thinkingSummary("First idea. Second, better idea! ")).toBe("Second, better idea!");
    expect(thinkingSummary("x".repeat(200), 20)).toHaveLength(20);
  });
});
