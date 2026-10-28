import type { AgentEvent } from "@desyn/ai";
import { describe, expect, test } from "vitest";
import { EventSink } from "../lib/ai_backend";
import type { StoredEvent } from "../lib/ai_runs";

// The batched event writer of server runs: stream order is kept even while a preview uploads, long text
// streams are split instead of being clipped, and a stop answer from the log aborts the run.

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function collect(opts: { storePreview?: () => Promise<string>; stopAfter?: number } = {}) {
  const batches: StoredEvent[][] = [];
  let stops = 0;
  const sink = new EventSink({
    push: async (events) => {
      batches.push(events);
      return { stop: opts.stopAfter !== undefined && batches.length >= opts.stopAfter };
    },
    storePreview: opts.storePreview ?? (async () => "kg2preview"),
    onStop: () => {
      stops++;
    },
    flushMs: 5,
  });
  const all = () => batches.flat();
  return { sink, batches, all, stops: () => stops };
}

const ev = (e: Record<string, unknown>) => e as unknown as AgentEvent;

describe("EventSink", () => {
  test("a preview keeps its place in the log while its bytes upload", async () => {
    const upload = deferred<string>();
    const { sink, all } = collect({ storePreview: () => upload.promise });
    sink.push(ev({ type: "tool-call", runId: "r", callId: "c1", tool: "render_preview" }));
    sink.push(
      ev({
        type: "preview",
        runId: "r",
        bytes: new Uint8Array([1, 2, 3]),
        mime: "image/png",
        width: 1,
        height: 1,
      }),
    );
    sink.push(ev({ type: "tool-result", runId: "r", callId: "c1", ok: true }));
    sink.push(ev({ type: "step", runId: "r", step: 2 }));
    await new Promise((r) => setTimeout(r, 20));
    // Nothing after the pending preview was written ahead of it.
    expect(all().map((e) => e.type)).not.toContain("tool-result");
    upload.resolve("kg2preview");
    await sink.flush();
    expect(all().map((e) => e.type)).toEqual(["tool-call", "preview", "tool-result", "step"]);
    const preview = JSON.parse(all()[1]?.payload ?? "{}") as Record<string, unknown>;
    expect(preview).toMatchObject({ previewId: "kg2preview", mime: "image/png" });
    expect(preview.bytes).toBeUndefined();
  });

  test("text deltas merge, but long streams are split instead of clipped", async () => {
    const { sink, all } = collect();
    const chunk = "x".repeat(1_000);
    for (let i = 0; i < 9; i++) sink.push(ev({ type: "text", runId: "r", text: chunk }));
    sink.push(ev({ type: "thinking", runId: "r", text: "hmm" }));
    await sink.flush();
    const texts = all().filter((e) => e.type === "text");
    const joined = texts.map((e) => (JSON.parse(e.payload) as { text: string }).text).join("");
    expect(joined).toBe(chunk.repeat(9));
    expect(texts.length).toBeGreaterThan(1);
    expect(joined.includes("…")).toBe(false);
    expect(all().at(-1)?.type).toBe("thinking");
  });

  test("a stop answer from the log aborts once", async () => {
    const { sink, stops } = collect({ stopAfter: 1 });
    sink.push(ev({ type: "step", runId: "r", step: 1 }));
    sink.push(ev({ type: "step", runId: "r", step: 2 }));
    sink.poll();
    await sink.flush();
    expect(stops()).toBe(1);
  });

  test("a preview that cannot be stored does not block the log", async () => {
    const { sink, all } = collect({
      storePreview: async () => {
        throw new Error("storage down");
      },
    });
    sink.push(ev({ type: "preview", runId: "r", bytes: new Uint8Array([1]), mime: "image/png" }));
    sink.push(ev({ type: "done", runId: "r", status: "completed", summary: "ok" }));
    await sink.flush();
    expect(all().map((e) => e.type)).toEqual(["progress", "done"]);
    expect(sink.error).toBeInstanceOf(Error);
  });
});
