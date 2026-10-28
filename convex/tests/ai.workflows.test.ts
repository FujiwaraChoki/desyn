import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { designWithHeadline, providerHook, resetProviderHook } from "./ai.helpers";
import { NETWORK_ENV, stubNetwork } from "./api.helpers";
import { loadAll } from "./designs.helpers";
import { createUser, errorData, setupTest, type TestConvex } from "./harness.helpers";

// Durable workflows: one scheduled Node action per step over the persisted @desyn/ai WorkflowState,
// per-step credit reservation and settlement, progress events on the companion run, cancellation between
// steps and resumption after a crashed step.

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
    if (profile) await ctx.db.patch("profiles", profile._id, { plan: "pro" });
  });
}

beforeEach(() => {
  vi.stubEnv("DESYN_EDITION", "hosted");
  vi.stubEnv("MAIL_TRANSPORT", "log");
  vi.stubEnv("OPENROUTER_API_KEY", "test-openrouter-key");
  resetProviderHook();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function wfDoc(t: TestConvex, id: string) {
  return await t.run(async (ctx) => await ctx.db.get("aiWorkflows", id as Id<"aiWorkflows">));
}

describe("workflows", () => {
  test("resize: one design per preset, credits per step, progress events", async () => {
    const t = setupTest();
    const user = await createUser(t);
    await makePro(t, user.userId);
    const { designId } = await designWithHeadline(user);
    vi.useFakeTimers();
    const started = await user.as.mutation(api.ai.workflows.start, {
      type: "resize",
      designId,
      input: JSON.stringify({
        presets: ["instagram-story"],
        sizes: [{ width: 1200, height: 628, name: "Link" }],
      }),
    });
    expect(started.estimatedCredits).toBe(2);
    let status = await user.as.query(api.ai.workflows.status, { workflowId: started.workflowId });
    expect(status).toMatchObject({ status: "queued", progress: { done: 0, total: 2 } });
    await drain(t);
    status = await user.as.query(api.ai.workflows.status, { workflowId: started.workflowId });
    expect(status).toMatchObject({
      status: "completed",
      progress: { done: 2, total: 2 },
      costCredits: 2,
      creditsCharged: 2,
    });
    expect(status.outputs).toHaveLength(2);
    // Each output is a real design at the target size, owned by the user's workspace.
    const story = status.outputs.find(
      (o) => (o as { preset?: string }).preset === "instagram-story",
    ) as {
      designId: Id<"designs">;
    };
    const copy = await loadAll(user.as, story.designId);
    const page = Object.values(copy.design.nodes).find((n) => n.type === "page");
    expect(page).toMatchObject({ width: 1080, height: 1920 });
    expect(Object.values(copy.design.nodes).some((n) => n.name === "Headline")).toBe(true);
    const balance = await user.as.query(api.billing.credits.balance, {});
    expect(balance).toMatchObject({ used: 2, reserved: 0 });
    // Progress went to the companion run's event log.
    const page1 = await user.as.query(api.ai.agent.runEvents, { runId: started.runId, limit: 500 });
    const types = page1.events.map((e) => e.type);
    expect(types).toEqual(
      expect.arrayContaining(["workflow-step", "workflow-output", "workflow-done", "done"]),
    );
    expect(page1.run).toMatchObject({ kind: "workflow", status: "completed" });
    expect(page1.done).toBe(true);
  });

  test("a crashed step resumes from the saved state; repeated crashes fail the workflow", async () => {
    const t = setupTest();
    const user = await createUser(t);
    await makePro(t, user.userId);
    const { designId } = await designWithHeadline(user);
    providerHook.failNext = 1;
    vi.useFakeTimers();
    const started = await user.as.mutation(api.ai.workflows.start, {
      type: "resize",
      designId,
      input: JSON.stringify({ presets: ["instagram-story"] }),
    });
    await drain(t);
    const done = await wfDoc(t, started.workflowId);
    expect(done).toMatchObject({ status: "completed", restarts: 1 });
    expect(done?.outputs).toHaveLength(1);

    providerHook.failNext = 10;
    const doomed = await user.as.mutation(api.ai.workflows.start, {
      type: "resize",
      designId,
      input: JSON.stringify({ presets: ["instagram-story"] }),
    });
    await drain(t);
    const failed = await wfDoc(t, doomed.workflowId);
    expect(failed).toMatchObject({ status: "failed", error: "simulated provider outage" });
    const balance = await user.as.query(api.billing.credits.balance, {});
    expect(balance.reserved).toBe(0);
  });

  test("cancel between steps keeps finished outputs and stops the rest", async () => {
    const t = setupTest();
    const user = await createUser(t);
    await makePro(t, user.userId);
    const { designId } = await designWithHeadline(user);
    vi.useFakeTimers();
    const started = await user.as.mutation(api.ai.workflows.start, {
      type: "resize",
      designId,
      input: JSON.stringify({
        presets: ["instagram-story", "facebook-cover", "youtube-thumbnail"],
      }),
    });
    // Run exactly the first step, then cancel.
    await t.action(internal.ai.workflowsNode.advance, {
      workflowId: started.workflowId,
      tick: 0,
    });
    const view = await user.as.mutation(api.ai.workflows.cancel, {
      workflowId: started.workflowId,
    });
    expect(view.status).toBe("cancelled");
    await drain(t);
    const wf = await wfDoc(t, started.workflowId);
    expect(wf).toMatchObject({ status: "cancelled", progress: { done: 1, total: 3 } });
    expect(wf?.outputs).toHaveLength(1);
    const run = await user.as.query(api.ai.agent.getRun, { runId: started.runId });
    expect(run.status).toBe("cancelled");
  });

  test("exportBundle runs export jobs through the export queue", async () => {
    const t = setupTest();
    for (const [k, v] of Object.entries(NETWORK_ENV)) vi.stubEnv(k, v);
    const net = stubNetwork();
    vi.stubGlobal("fetch", net.fetch);
    const user = await createUser(t);
    await makePro(t, user.userId);
    const { designId } = await designWithHeadline(user);
    vi.useFakeTimers();
    const started = await user.as.mutation(api.ai.workflows.start, {
      type: "exportBundle",
      designId,
      input: JSON.stringify({ formats: [{ format: "png", scale: 2 }, { format: "pdf" }] }),
    });
    await drain(t);
    const wf = await wfDoc(t, started.workflowId);
    expect(wf?.status).toBe("completed");
    expect(wf?.outputs).toHaveLength(2);
    expect(wf?.outputs[0]).toMatchObject({ export: { format: "png", status: "done" } });
    expect(net.worker.calls.filter((c) => c.path === "/v1/render").length).toBeGreaterThanOrEqual(
      2,
    );
    const exportsRows = await t.run(async (ctx) => await ctx.db.query("exports").collect());
    expect(exportsRows.map((r) => r.status)).toEqual(["ready", "ready"]);
  });

  test("validation and gating", async () => {
    const t = setupTest();
    const free = await createUser(t);
    const freeDesign = await designWithHeadline(free);
    expect(
      (
        await errorData(
          free.as.mutation(api.ai.workflows.start, {
            type: "resize",
            designId: freeDesign.designId,
            input: JSON.stringify({ presets: ["instagram-story"] }),
          }),
        )
      ).code,
    ).toBe("FEATURE_UNAVAILABLE");
    const pro = await createUser(t);
    await makePro(t, pro.userId);
    const { designId } = await designWithHeadline(pro);
    const bad = await errorData(
      pro.as.mutation(api.ai.workflows.start, {
        type: "resize",
        designId,
        input: JSON.stringify({ presets: ["no-such-preset"] }),
      }),
    );
    expect(bad).toMatchObject({ code: "INVALID_ARGUMENT" });
    const notJson = await errorData(
      pro.as.mutation(api.ai.workflows.start, { type: "resize", designId, input: "[1,2]" }),
    );
    expect(notJson.code).toBe("INVALID_ARGUMENT");
    // A design of another workspace is invisible.
    expect(
      (
        await errorData(
          pro.as.mutation(api.ai.workflows.start, {
            type: "resize",
            designId: freeDesign.designId,
            input: JSON.stringify({ presets: ["instagram-story"] }),
          }),
        )
      ).code,
    ).toBe("NOT_FOUND");
  });
});
