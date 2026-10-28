// @vitest-environment node
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { applyTransaction } from "@desyn/doc-ops";
import {
  createDesign,
  createRect,
  createText,
  type Design,
  defaultTextStyle,
  newId,
  type Op,
  type TextNode,
  type Transaction,
} from "@desyn/schema";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import { type HostBackend, type HostCommitResult, WorkerHost } from "../lib/ai_host";
import { callWorker, WorkerError } from "../lib/designs_worker";
import { env } from "../lib/env";
import { designWithHeadline, providerHook, resetProviderHook, scriptedModel } from "./ai.helpers";
import { createUser, setupTest } from "./harness.helpers";

// WorkerHost against the real render worker (crates/desyn-worker, DOCUMENT_MODEL §8): describe, render,
// measure and layout normalization, plus an agent run on convex-test whose render_preview goes to the worker.
// Uses the debug binary of the worker crate (DESYN_WORKER_BIN overrides); skipped with a note when it has not
// been built (`CARGO_TARGET_DIR=target/desyn-worker cargo build -p desyn-worker`).

vi.mock("../lib/ai_providers", async (orig) =>
  (await import("./ai.helpers")).mockProvidersModule(await orig()),
);

const BIN =
  env.get("DESYN_WORKER_BIN") ?? resolve(__dirname, "../../target/desyn-worker/debug/desyn-worker");
const SECRET = "integration-test-secret-0123456789";
const available = existsSync(BIN);
let worker: ChildProcess | null = null;
let url = "";

async function freePort(preferred: number): Promise<number> {
  const tryPort = (port: number) =>
    new Promise<number>((ok, fail) => {
      const srv = createServer();
      srv.once("error", fail);
      srv.listen(port, "127.0.0.1", () => {
        const address = srv.address();
        const chosen = typeof address === "object" && address ? address.port : port;
        srv.close(() => ok(chosen));
      });
    });
  try {
    return await tryPort(preferred);
  } catch {
    return await tryPort(0);
  }
}

beforeAll(async () => {
  if (!available) return;
  const port = await freePort(4110);
  url = `http://127.0.0.1:${port}`;
  worker = spawn(BIN, [], {
    env: {
      PATH: process.env.PATH ?? "",
      RENDER_WORKER_SECRET: SECRET,
      PORT: String(port),
      HOST: "127.0.0.1",
      LOG_FORMAT: "json",
      RUST_LOG: "warn",
      FONT_CACHE_DIR: resolve(__dirname, "../../target/ai-backend-font-cache"),
    },
    stdio: "ignore",
  });
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      const res = await fetch(`${url}/readyz`);
      if (res.ok) break;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) throw new Error("the render worker did not become ready");
    await new Promise((r) => setTimeout(r, 200));
  }
}, 90_000);

afterAll(() => {
  worker?.kill("SIGTERM");
});

function sampleDesign(): { design: Design; headlineId: string; pageId: string } {
  const base = createDesign("social-post", "instagram-post", { name: "Integration" });
  const pageId = (base.nodes.root as { children: string[] }).children[0] as string;
  const bg = createRect({
    id: newId(),
    name: "Background",
    role: "background",
    x: 0,
    y: 0,
    width: 1080,
    height: 1080,
    fills: [{ type: "solid", color: "#0b0b0f" }],
  });
  const headline = createText({
    id: newId(),
    name: "Headline",
    role: "headline",
    text: "Atmospheric minimalism, rising sun",
    x: 80,
    y: 400,
    width: 600,
    // Deliberately wrong: the real layout engine derives the height from the shaped text.
    height: 10,
    style: defaultTextStyle({
      fontFamily: "Inter",
      fontSize: 72,
      fontWeight: 700,
      fills: [{ type: "solid", color: "#ffb02e" }],
    }),
  });
  const design = applyTransaction(base, {
    id: newId(),
    label: "seed",
    ops: [
      { op: "create", nodes: [bg], parent: pageId },
      { op: "create", nodes: [headline], parent: pageId },
    ],
    source: "system",
    ts: 0,
  }).design;
  return { design, headlineId: headline.id, pageId };
}

function memoryBackend(initial: Design) {
  let design = initial;
  let seq = 1;
  const commits: Transaction[] = [];
  const backend: HostBackend = {
    load: async () => ({ design, seq }),
    opsAfter: async () => ({ txs: [], gap: false }),
    commit: async (tx): Promise<HostCommitResult> => {
      commits.push(tx);
      const r = applyTransaction(design, tx);
      design = r.design;
      seq++;
      return { seq, applied: JSON.stringify(r.applied), dropped: r.dropped, duplicate: false };
    },
    assetUrls: async () => ({}),
    ingest: async () => {
      throw new Error("not used");
    },
    fetchBytes: async () => {
      throw new Error("not used");
    },
    worker: { call: (path, body) => callWorker(path, body) },
  };
  return { backend, commits };
}

describe.skipIf(!available)("WorkerHost with the real render worker", () => {
  beforeAll(() => {
    process.env.RENDER_WORKER_URL = url;
    process.env.RENDER_WORKER_SECRET = SECRET;
  });

  test("describe, render and measure come from the Rust engine", async () => {
    const { design, headlineId, pageId } = sampleDesign();
    const host = await WorkerHost.open(memoryBackend(design).backend, { selection: [headlineId] });
    const d = await host.describe();
    expect(d.page).toMatchObject({ id: pageId, width: 1080, height: 1080 });
    expect(d.selection).toEqual([headlineId]);
    const flat = JSON.stringify(d.tree);
    expect(flat).toContain(headlineId);
    expect(d.palette.length).toBeGreaterThan(0);

    const png = await host.render({ maxSize: 256 });
    expect(png).toMatchObject({ mime: "image/png", width: 256, height: 256 });
    expect([...png.bytes.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);

    const node = design.nodes[headlineId] as TextNode;
    const [size] = await host.measure([
      { text: node.runs, style: node.style, paragraph: node.paragraph, width: 600 },
    ]);
    expect(size?.lines).toBeGreaterThanOrEqual(1);
    expect(size?.h).toBeGreaterThan(60);
  });

  test("edits are normalized by the real layout before they are committed", async () => {
    const { design, headlineId } = sampleDesign();
    const { backend, commits } = memoryBackend(design);
    const host = await WorkerHost.open(backend);
    const node = design.nodes[headlineId] as TextNode;
    const ops: Op[] = [
      { op: "update", id: headlineId, set: { style: { ...node.style, fontSize: 96 } } },
    ];
    await host.apply({ id: newId(), label: "bigger", ops, source: "ai", ts: Date.now() });
    const committed = commits[0];
    expect(committed?.ops.length).toBeGreaterThan(1);
    const heightFix = committed?.ops.find(
      (o) => o.op === "update" && o.id === headlineId && typeof o.set?.height === "number",
    );
    expect(heightFix).toBeDefined();
    expect((host.getDesign().nodes[headlineId] as TextNode).height).toBeGreaterThan(90);
  });

  test("the shared secret is enforced", async () => {
    process.env.RENDER_WORKER_SECRET = "wrong-secret-0123456789";
    try {
      const err = await callWorker("/v1/describe", { design: sampleDesign().design }).catch(
        (e) => e,
      );
      expect(err).toBeInstanceOf(WorkerError);
      expect((err as WorkerError).status).toBe(403);
    } finally {
      process.env.RENDER_WORKER_SECRET = SECRET;
    }
  });

  test("an agent run renders previews through the worker", async () => {
    resetProviderHook();
    vi.stubEnv("DESYN_EDITION", "selfhost");
    vi.stubEnv("MAIL_TRANSPORT", "log");
    vi.stubEnv("OPENROUTER_API_KEY", "test-openrouter-key");
    vi.stubEnv("RENDER_WORKER_URL", url);
    vi.stubEnv("RENDER_WORKER_SECRET", SECRET);
    try {
      const t = setupTest();
      const user = await createUser(t);
      const { designId } = await designWithHeadline(user);
      providerHook.model = scriptedModel([
        { calls: [{ name: "render_preview", input: {} }] },
        { calls: [{ name: "finish", input: { summary: "Previewed." } }] },
      ]);
      const { runId } = await user.as.mutation(api.ai.agent.startRun, {
        designId,
        goal: "Show me",
      });
      // Real timers: the scheduled chunk runs on its own; wait for it to finish.
      for (let i = 0; i < 200; i++) {
        const run = await user.as.query(api.ai.agent.getRun, { runId });
        if (run.finishedAt !== null) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      await t.finishInProgressScheduledFunctions();
      const page = await user.as.query(api.ai.agent.runEvents, { runId, limit: 500 });
      expect(page.run.status).toBe("completed");
      const preview = page.events.find((e) => e.type === "preview") as
        | { previewId?: string; width?: number; mime?: string }
        | undefined;
      expect(preview).toMatchObject({ mime: "image/png" });
      expect(preview?.previewId).toBeTruthy();
      const result = page.events.find(
        (e) => e.type === "tool-result" && e.tool === "render_preview",
      );
      expect(result).toMatchObject({ ok: true });
    } finally {
      vi.unstubAllEnvs();
    }
  }, 60_000);
});

test.skipIf(available)("render worker binary not built: integration tests skipped", () => {
  expect(available).toBe(false);
});
