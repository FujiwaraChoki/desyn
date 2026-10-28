import type { TextNode } from "@desyn/schema";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { designWithHeadline, providerHook, resetProviderHook, scriptedModel } from "./ai.helpers";
import { loadAll, memberWithRole } from "./designs.helpers";
import {
  createUser,
  errorData,
  setupTest,
  type TestConvex,
  type TestUser,
} from "./harness.helpers";

// Agent runs end to end on convex-test: start (gating, routing, fair use, reservation), the chunked agent
// loop in the Node action with an AI SDK mock model, commits through the designs commit path, streamed
// events, cancellation, ask_user pause/resume, yielding across chunks, credit settlement and the reaper.

vi.mock("../lib/ai_providers", async (orig) =>
  (await import("./ai.helpers")).mockProvidersModule(await orig()),
);

const drain = (t: TestConvex) => t.finishAllScheduledFunctions(vi.runOnlyPendingTimers);

async function makePro(t: TestConvex, userId: string) {
  await t.run(async (ctx) => {
    const profile = await ctx.db
      .query("profiles")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .unique();
    if (!profile) throw new Error("no profile");
    await ctx.db.patch("profiles", profile._id, { plan: "pro" });
  });
}

async function runDoc(t: TestConvex, runId: string) {
  return await t.run(async (ctx) => await ctx.db.get("aiRuns", runId as Id<"aiRuns">));
}

async function events(user: TestUser, runId: string) {
  const page = await user.as.query(api.ai.agent.runEvents, { runId, limit: 500 });
  return page.events;
}

beforeEach(() => {
  vi.stubEnv("DESYN_EDITION", "selfhost");
  vi.stubEnv("MAIL_TRANSPORT", "log");
  vi.stubEnv("OPENROUTER_API_KEY", "test-openrouter-key");
  resetProviderHook();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("agent runs", () => {
  test("lifecycle: queued → running → completed, edits committed as the run, events streamed", async () => {
    const t = setupTest();
    const user = await createUser(t);
    const { designId, headlineId } = await designWithHeadline(user);
    providerHook.model = scriptedModel([
      { calls: [{ name: "read_design", input: {} }] },
      {
        text: "Making the headline bigger.",
        calls: [
          { name: "update_elements", input: { updates: [{ id: headlineId, fontSize: 96 }] } },
        ],
      },
      {
        calls: [
          {
            name: "finish",
            input: { summary: "Headline is 96 px now.", changes: ["Headline 64 → 96 px"] },
          },
        ],
      },
    ]);
    vi.useFakeTimers();
    const { runId } = await user.as.mutation(api.ai.agent.startRun, {
      designId,
      goal: "Make the headline bigger",
      selection: [headlineId],
    });
    const queued = await user.as.query(api.ai.agent.getRun, { runId });
    expect(queued).toMatchObject({ status: "queued", kind: "agent", mode: "edit" });
    await drain(t);

    const run = await user.as.query(api.ai.agent.getRun, { runId });
    expect(run).toMatchObject({
      status: "completed",
      steps: 3,
      costCredits: 3,
      transactions: 1,
      result: { summary: "Headline is 96 px now.", changes: ["Headline 64 → 96 px"] },
    });
    expect(run.finishedAt).not.toBeNull();

    // The edit went through designs.commit as the run (actor + source "ai").
    const { design } = await loadAll(user.as, designId);
    expect((design.nodes[headlineId] as TextNode).style.fontSize).toBe(96);
    const ops = await user.as.query(api.designs.designOps.since, { designId, seq: 0 });
    const aiTx = ops.ops.map((o) => JSON.parse(o.tx)).find((tx) => tx.source === "ai");
    expect(aiTx?.actor).toMatchObject({ runId, agent: "desyn" });

    const log = await events(user, runId);
    const types = log.map((e) => e.type);
    expect(types[0]).toBe("progress"); // queued
    expect(types).toEqual(
      expect.arrayContaining([
        "start",
        "step",
        "tool-call",
        "tool-result",
        "applied-tx",
        "text",
        "done",
      ]),
    );
    expect(types.filter((x) => x === "start")).toHaveLength(1);
    expect(log.at(-1)).toMatchObject({ type: "done", status: "completed" });
    expect(log.map((e) => e.index)).toEqual(log.map((_, i) => i));
    const page = await user.as.query(api.ai.agent.runEvents, { runId, afterSeq: log.length - 1 });
    expect(page).toMatchObject({ events: [], done: true });
    // The conversation is kept for follow-up runs.
    expect((await runDoc(t, runId))?.historyId).toBeDefined();
  });

  test("follow-up runs continue the conversation; the web hand-off alias starts a run", async () => {
    const t = setupTest();
    const user = await createUser(t);
    const { designId } = await designWithHeadline(user);
    providerHook.model = scriptedModel([
      { calls: [{ name: "finish", input: { summary: "Warmer now." } }] },
    ]);
    vi.useFakeTimers();
    const first = await user.as.mutation(api.ai.agent.runAgent, {
      designId,
      goal: "Make it warmer",
      mode: "edit",
    });
    await drain(t);
    const followUp = scriptedModel([
      { calls: [{ name: "finish", input: { summary: "Even warmer." } }] },
    ]);
    providerHook.model = followUp;
    const second = await user.as.mutation(api.ai.agent.startRun, {
      designId,
      goal: "A bit more",
      previousRunId: first.runId as Id<"aiRuns">,
    });
    await drain(t);
    expect(await user.as.query(api.ai.agent.getRun, { runId: second.runId })).toMatchObject({
      status: "completed",
      result: { summary: "Even warmer." },
    });
    const prompt = JSON.stringify(followUp.doStreamCalls[0]?.prompt);
    expect(prompt).toContain("Make it warmer");
    expect(prompt).toContain("A bit more");
    const estimate = await user.as.query(api.ai.agent.estimate, { mode: "generate" });
    expect(estimate).toEqual({ maxSteps: 48, credits: 54 });
  });

  test("collaborators can follow a run; outsiders cannot", async () => {
    const t = setupTest();
    const owner = await createUser(t);
    const outsider = await createUser(t);
    const { designId } = await designWithHeadline(owner);
    providerHook.model = scriptedModel([
      { calls: [{ name: "finish", input: { summary: "Done." } }] },
    ]);
    vi.useFakeTimers();
    const { runId } = await owner.as.mutation(api.ai.agent.startRun, {
      designId,
      goal: "Check it",
    });
    await drain(t);
    expect((await errorData(outsider.as.query(api.ai.agent.getRun, { runId }))).code).toBe(
      "NOT_FOUND",
    );
    const list = await owner.as.query(api.ai.agent.listRuns, { designId });
    expect(list.map((r) => r.id)).toEqual([runId]);
  });

  test("validation, routing and one agent per design", async () => {
    const t = setupTest();
    const user = await createUser(t);
    const { designId } = await designWithHeadline(user);
    expect(
      (await errorData(user.as.mutation(api.ai.agent.startRun, { designId, goal: "   " }))).code,
    ).toBe("INVALID_ARGUMENT");
    expect(
      (
        await errorData(
          user.as.mutation(api.ai.agent.startRun, {
            designId,
            goal: "x",
            prefs: { model: "anthropic:claude-x" },
          }),
        )
      ).code,
    ).toBe("NOT_CONFIGURED"); // no Anthropic key anywhere
    await user.as.mutation(api.ai.agent.startRun, { designId, goal: "First" });
    const second = await errorData(
      user.as.mutation(api.ai.agent.startRun, { designId, goal: "Second" }),
    );
    expect(second.code).toBe("CONFLICT");

    vi.stubEnv("OPENROUTER_API_KEY", "");
    const other = await designWithHeadline(user, { name: "Other" });
    const noProvider = await errorData(
      user.as.mutation(api.ai.agent.startRun, { designId: other.designId, goal: "Go" }),
    );
    expect(noProvider.code).toBe("NOT_CONFIGURED");
  });

  test("cancel before the run starts settles without charging", async () => {
    const t = setupTest();
    vi.stubEnv("DESYN_EDITION", "hosted");
    const user = await createUser(t);
    await makePro(t, user.userId);
    const { designId } = await designWithHeadline(user);
    vi.useFakeTimers();
    const { runId } = await user.as.mutation(api.ai.agent.startRun, { designId, goal: "Go" });
    let balance = await user.as.query(api.billing.credits.balance, {});
    expect(balance.reserved).toBeGreaterThan(0);
    const cancelled = await user.as.mutation(api.ai.agent.cancelRun, { runId });
    expect(cancelled.status).toBe("cancelled");
    await drain(t); // the scheduled chunk must not run
    balance = await user.as.query(api.billing.credits.balance, {});
    expect(balance).toMatchObject({ reserved: 0, used: 0 });
    const log = await events(user, runId);
    expect(log.at(-1)).toMatchObject({ type: "done", status: "cancelled" });
  });

  test("cancel while running stops the loop between steps", async () => {
    const t = setupTest();
    const user = await createUser(t);
    const { designId, headlineId } = await designWithHeadline(user);
    let runId = "";
    providerHook.model = scriptedModel([
      {
        calls: [
          { name: "update_elements", input: { updates: [{ id: headlineId, fontSize: 70 }] } },
        ],
      },
      {
        // The user presses stop while the model is thinking about step 2.
        before: async () => {
          await user.as.mutation(api.ai.agent.cancelRun, { runId });
        },
        calls: [
          { name: "update_elements", input: { updates: [{ id: headlineId, fontSize: 200 }] } },
        ],
      },
      {
        calls: [
          { name: "update_elements", input: { updates: [{ id: headlineId, fontSize: 300 }] } },
        ],
      },
    ]);
    vi.useFakeTimers();
    ({ runId } = await user.as.mutation(api.ai.agent.startRun, { designId, goal: "Go" }));
    await drain(t);
    const run = await user.as.query(api.ai.agent.getRun, { runId });
    expect(run.status).toBe("cancelled");
    const { design } = await loadAll(user.as, designId);
    const size = (design.nodes[headlineId] as TextNode).style.fontSize;
    expect(size).not.toBe(300);
    expect(run.transactions).toBeLessThan(3);
  });

  test("ask_user pauses the run; the answer resumes it with the conversation", async () => {
    const t = setupTest();
    const user = await createUser(t);
    const { designId, headlineId } = await designWithHeadline(user);
    providerHook.model = scriptedModel([
      {
        calls: [
          { name: "ask_user", input: { question: "Which color?", options: ["Sun", "Night"] } },
        ],
      },
    ]);
    vi.useFakeTimers();
    const { runId } = await user.as.mutation(api.ai.agent.startRun, { designId, goal: "Recolor" });
    await drain(t);
    let run = await user.as.query(api.ai.agent.getRun, { runId });
    expect(run).toMatchObject({
      status: "needs-input",
      question: { question: "Which color?", options: ["Sun", "Night"] },
    });
    expect(run.finishedAt).toBeNull();
    expect(
      (await errorData(user.as.mutation(api.ai.agent.answer, { runId, answer: "  " }))).code,
    ).toBe("INVALID_ARGUMENT");

    const resumed = scriptedModel([
      {
        calls: [
          { name: "update_elements", input: { updates: [{ id: headlineId, fontSize: 80 }] } },
        ],
      },
      { calls: [{ name: "finish", input: { summary: "Used the sun palette." } }] },
    ]);
    providerHook.model = resumed;
    run = await user.as.mutation(api.ai.agent.answer, { runId, answer: "Sun" });
    expect(run.status).toBe("queued");
    await drain(t);
    run = await user.as.query(api.ai.agent.getRun, { runId });
    expect(run).toMatchObject({
      status: "completed",
      result: { summary: "Used the sun palette." },
    });
    // The resumed call saw the question's tool call answered with the user's reply.
    const prompt = JSON.stringify(resumed.doStreamCalls[0]?.prompt);
    expect(prompt).toContain("ask_user");
    expect(prompt).toContain('"answer":"Sun"');
    const log = await events(user, runId);
    expect(log.map((e) => e.type)).toEqual(expect.arrayContaining(["question", "answer", "done"]));
    expect(log.filter((e) => e.type === "done")).toHaveLength(1);
    await expect(
      user.as.mutation(api.ai.agent.answer, { runId, answer: "again" }),
    ).rejects.toThrow();
  });

  test("long runs yield before the action limit and continue in a new chunk", async () => {
    const t = setupTest();
    const user = await createUser(t);
    const { designId, headlineId } = await designWithHeadline(user);
    const model = scriptedModel([
      {
        // Seven minutes pass during the first step: past the chunk budget.
        before: () => {
          vi.setSystemTime(Date.now() + 7 * 60_000);
        },
        calls: [
          { name: "update_elements", input: { updates: [{ id: headlineId, fontSize: 72 }] } },
        ],
      },
      { calls: [{ name: "finish", input: { summary: "Done in two chunks." } }] },
    ]);
    providerHook.model = model;
    vi.useFakeTimers();
    const { runId } = await user.as.mutation(api.ai.agent.startRun, { designId, goal: "Go" });
    await drain(t);
    const run = await runDoc(t, runId);
    expect(run).toMatchObject({ status: "completed", chunk: 1, steps: 2, transactions: 1 });
    expect(providerHook.inputs).toHaveLength(2);
    const prompt = JSON.stringify(model.doStreamCalls[1]?.prompt);
    expect(prompt).toContain("Continue the task");
    expect(prompt).toContain("update_elements");
    const log = await events(user, runId);
    expect(log.filter((e) => e.type === "start")).toHaveLength(1);
    expect(log.filter((e) => e.type === "done")).toHaveLength(1);
  });

  test("credits: reserve on start, commit actual use, refund the rest (hosted Pro)", async () => {
    const t = setupTest();
    vi.stubEnv("DESYN_EDITION", "hosted");
    const user = await createUser(t);
    await makePro(t, user.userId);
    const { designId } = await designWithHeadline(user);
    providerHook.model = scriptedModel([
      { calls: [{ name: "read_design", input: {} }] },
      { calls: [{ name: "finish", input: { summary: "Looks good." } }] },
    ]);
    vi.useFakeTimers();
    const { runId } = await user.as.mutation(api.ai.agent.startRun, { designId, goal: "Review" });
    const before = await user.as.query(api.billing.credits.balance, {});
    expect(before.reserved).toBe(24); // edit mode: 24 steps reserved
    await drain(t);
    const after = await user.as.query(api.billing.credits.balance, {});
    expect(after).toMatchObject({ reserved: 0, used: 2, granted: 600 });
    const run = await user.as.query(api.ai.agent.getRun, { runId });
    expect(run).toMatchObject({ costCredits: 2, creditsCharged: 2 });
    // Settlement is idempotent: settling again charges nothing.
    await t.run(async (ctx) => {
      const { settleSegment } = await import("../lib/ai_runs");
      const charged = await settleSegment(ctx, { refId: `ai:run:${runId}:0`, usedAtStart: 0 }, 2);
      expect(charged).toBe(0);
    });
  });

  test("fair use: plan gating and the concurrent-run cap", async () => {
    const t = setupTest();
    vi.stubEnv("DESYN_EDITION", "hosted");
    const free = await createUser(t);
    const freeDesign = await designWithHeadline(free);
    const gated = await errorData(
      free.as.mutation(api.ai.agent.startRun, { designId: freeDesign.designId, goal: "Go" }),
    );
    expect(gated).toMatchObject({ code: "FEATURE_UNAVAILABLE", feature: "ai.agent" });

    const pro = await createUser(t);
    await makePro(t, pro.userId);
    for (let i = 0; i < 3; i++) {
      const d = await designWithHeadline(pro, { name: `D${i}` });
      await pro.as.mutation(api.ai.agent.startRun, { designId: d.designId, goal: "Go" });
    }
    const fourth = await designWithHeadline(pro, { name: "D4" });
    const capped = await errorData(
      pro.as.mutation(api.ai.agent.startRun, { designId: fourth.designId, goal: "Go" }),
    );
    expect(capped).toMatchObject({ code: "RATE_LIMITED", scope: "concurrency" });
    // Nothing was left behind by the refused start.
    const runs = await t.run(async (ctx) => await ctx.db.query("aiRuns").collect());
    expect(runs.filter((r) => r.designId === fourth.designId)).toHaveLength(0);
  });

  test("a crashed chunk is resumed by the reaper, then failed after repeated crashes", async () => {
    const t = setupTest();
    const user = await createUser(t);
    const { designId } = await designWithHeadline(user);
    providerHook.model = scriptedModel([
      { calls: [{ name: "finish", input: { summary: "Recovered." } }] },
    ]);
    vi.useFakeTimers();
    const { runId } = await user.as.mutation(api.ai.agent.startRun, { designId, goal: "Go" });
    // Simulate an action that died after claiming the run (lease set, never finished).
    await t.mutation(internal.ai.internal.beginChunk, { runId: runId as Id<"aiRuns">, chunk: 0 });
    vi.setSystemTime(Date.now() + 11 * 60_000);
    const reaped = await t.mutation(internal.ai.maintenance.reapStale, {});
    expect(reaped.restarted).toBe(1);
    await drain(t);
    expect(await runDoc(t, runId)).toMatchObject({ status: "completed", restarts: 1, chunk: 1 });
    const log = await events(user, runId);
    expect(log.some((e) => e.type === "error" && e.code === "restarted")).toBe(true);

    // A run that keeps dying is failed (and settled) instead of looping forever.
    const other = await designWithHeadline(user, { name: "Other" });
    const { runId: doomed } = await user.as.mutation(api.ai.agent.startRun, {
      designId: other.designId,
      goal: "Go",
    });
    await t.run(async (ctx) => {
      await ctx.db.patch("aiRuns", doomed as Id<"aiRuns">, {
        status: "running",
        restarts: 3,
        leaseUntil: Date.now() - 1,
        updatedAt: Date.now() - 20 * 60_000,
      });
    });
    await t.mutation(internal.ai.maintenance.reapStale, {});
    expect(await runDoc(t, doomed)).toMatchObject({ status: "failed" });
  });

  test("runs waiting a day for an answer are closed; retention drops old conversations", async () => {
    const t = setupTest();
    const user = await createUser(t);
    const { designId } = await designWithHeadline(user);
    providerHook.model = scriptedModel([
      { calls: [{ name: "ask_user", input: { question: "Which?", options: [] } }] },
    ]);
    vi.useFakeTimers();
    const { runId } = await user.as.mutation(api.ai.agent.startRun, { designId, goal: "Go" });
    await drain(t);
    expect((await runDoc(t, runId))?.status).toBe("needs-input");
    vi.setSystemTime(Date.now() + 25 * 60 * 60_000);
    await t.mutation(internal.ai.maintenance.reapStale, {});
    const closed = await runDoc(t, runId);
    expect(closed?.status).toBe("cancelled");
    expect(closed?.historyId).toBeDefined();
    vi.setSystemTime(Date.now() + 8 * 24 * 60 * 60_000);
    await t.mutation(internal.ai.maintenance.purgeOld, {});
    expect((await runDoc(t, runId))?.historyId).toBeUndefined();
    vi.setSystemTime(Date.now() + 31 * 24 * 60 * 60_000);
    await t.mutation(internal.ai.maintenance.purgeOld, {});
    const left = await t.run(async (ctx) =>
      ctx.db
        .query("aiRunEvents")
        .withIndex("by_run_seq", (q) => q.eq("runId", runId as Id<"aiRuns">))
        .collect(),
    );
    expect(left).toHaveLength(0);
  });
});

describe("agent runs: review fixes", () => {
  test("answering a waiting run is refused while another agent works on the design", async () => {
    const t = setupTest();
    const user = await createUser(t);
    const { designId } = await designWithHeadline(user);
    providerHook.model = scriptedModel([
      { calls: [{ name: "ask_user", input: { question: "Which color?", options: ["Sun"] } }] },
    ]);
    vi.useFakeTimers();
    const first = await user.as.mutation(api.ai.agent.startRun, { designId, goal: "Recolor" });
    await drain(t);
    expect((await runDoc(t, first.runId))?.status).toBe("needs-input");
    // A waiting run is not active: a second run may start on the design...
    const second = await user.as.mutation(api.ai.agent.startRun, { designId, goal: "Tidy up" });
    // ...but resuming the first one now would put two loops on the same layers.
    const refused = await errorData(
      user.as.mutation(api.ai.agent.answer, { runId: first.runId, answer: "Sun" }),
    );
    expect(refused.code).toBe("CONFLICT");
    expect((await runDoc(t, first.runId))?.status).toBe("needs-input");
    await user.as.mutation(api.ai.agent.cancelRun, { runId: second.runId });
    const resumed = await user.as.mutation(api.ai.agent.answer, {
      runId: first.runId,
      answer: "Sun",
    });
    expect(resumed.status).toBe("queued");
  });

  test("a viewer's critique run with attachments reads the design and never commits", async () => {
    const t = setupTest();
    const owner = await createUser(t);
    const { designId, workspaceId } = await designWithHeadline(owner);
    const viewer = await memberWithRole(t, workspaceId, "viewer");
    const assetId = await t.run(async (ctx) => {
      const now = Date.now();
      return await ctx.db.insert("assets", {
        workspaceId,
        ownerId: owner.userId,
        refId: "photo0000001",
        kind: "image",
        name: "photo.png",
        mime: "image/png",
        bytes: 33,
        width: 4,
        height: 4,
        storageKey: `ws/${workspaceId}/photo0000001.png`,
        status: "ready",
        source: "upload",
        createdAt: now,
        updatedAt: now,
        readyAt: now,
      });
    });
    providerHook.model = scriptedModel([
      { calls: [{ name: "read_design", input: {} }] },
      { calls: [{ name: "finish", input: { summary: "Strong hierarchy; tighten the margins." } }] },
    ]);
    vi.useFakeTimers();
    const before = await t.run(
      async (ctx) =>
        await ctx.db
          .query("designOps")
          .withIndex("by_design_seq", (q) => q.eq("designId", designId))
          .collect(),
    );
    const { runId } = await viewer.as.mutation(api.ai.agent.startRun, {
      designId,
      goal: "How does this look?",
      mode: "critique",
      attachments: [assetId],
    });
    await drain(t);
    const run = await viewer.as.query(api.ai.agent.getRun, { runId });
    expect(run).toMatchObject({ status: "completed", transactions: 0 });
    const after = await t.run(
      async (ctx) =>
        await ctx.db
          .query("designOps")
          .withIndex("by_design_seq", (q) => q.eq("designId", designId))
          .collect(),
    );
    expect(after).toHaveLength(before.length);
    // Edit runs stay members-with-edit-rights only.
    const denied = await errorData(
      viewer.as.mutation(api.ai.agent.startRun, { designId, goal: "Edit", mode: "edit" }),
    );
    expect(denied.code).toBe("FORBIDDEN");
  });

  test("a continuing run stops with the reason when the daily cap is reached", async () => {
    const t = setupTest();
    vi.stubEnv("DESYN_EDITION", "hosted");
    const user = await createUser(t);
    await makePro(t, user.userId);
    const { designId } = await designWithHeadline(user);
    vi.useFakeTimers();
    const { runId } = await user.as.mutation(api.ai.agent.startRun, { designId, goal: "Go" });
    // As after a yielded chunk: the segment was settled and the next chunk must reserve again, but the user
    // used up the day's AI requests meanwhile.
    await t.run(async (ctx) => {
      const run = await ctx.db.get("aiRuns", runId as Id<"aiRuns">);
      const { settleSegment } = await import("../lib/ai_runs");
      const { rateLimiter } = await import("../lib/rateLimits");
      if (run?.reservation) await settleSegment(ctx, run.reservation, 0);
      await ctx.db.patch("aiRuns", runId as Id<"aiRuns">, { reservation: undefined, segments: 1 });
      // The start used one request of the day's 600.
      const used = await rateLimiter.limit(ctx, "aiPerDay", { key: user.userId, count: 599 });
      expect(used.ok).toBe(true);
    });
    const claimed = await t.mutation(internal.ai.internal.beginChunk, {
      runId: runId as Id<"aiRuns">,
      chunk: 0,
    });
    expect(claimed).toBeNull();
    const run = await user.as.query(api.ai.agent.getRun, { runId });
    expect(run.status).toBe("failed");
    expect(run.error).toMatch(/daily AI request limit/);
    const balance = await user.as.query(api.billing.credits.balance, {});
    expect(balance.reserved).toBe(0);
    const log = await events(user, runId);
    expect(log.filter((e) => e.type === "done")).toHaveLength(1);
  });

  test("a BYOK reservation is only taken when nothing the run may call bills the platform", async () => {
    const { agentRunIsByok } = await import("../lib/ai_start");
    const route = (billing: Record<string, string>) => ({
      providers: [],
      has: () => true,
      billingOf: () => null,
      route: (task: string) => ({
        ref: task === "trace" ? "builtin:posterize" : `x:${task}`,
        available: task !== "video",
        billing: billing[task] ?? "byok",
      }),
    });
    expect(agentRunIsByok(route({}), {})).toBe(true);
    // The server's fal key would pay for images: credits must be held.
    expect(agentRunIsByok(route({ image: "platform" }), {})).toBe(false);
    // Built-in tracing and unconfigured video cannot bill.
    expect(agentRunIsByok(route({ trace: "platform", video: "platform" }), {})).toBe(true);
  });
});
