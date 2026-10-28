import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import { firstPageId, loadAll, makeTx, page, rect, workspaceOf } from "./designs.helpers";
import { createUser, errorData, setupTest } from "./harness.helpers";

// A fake render worker behind a stubbed fetch (DOCUMENT_MODEL §8).
interface WorkerCall {
  path: string;
  secret: string | null;
  body: {
    design: { nodes: Record<string, unknown>; assets: Record<string, { url?: string }> };
    pageId: string;
    format?: string;
    width?: number;
  };
}

function fakeWorker(opts: { failTimes?: number; status?: number } = {}) {
  const calls: WorkerCall[] = [];
  let failures = opts.failTimes ?? 0;
  const fetchImpl = async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    if (url.host !== "worker.test") throw new Error(`unexpected fetch ${url.href}`);
    const headers = new Headers(init.headers);
    const body = JSON.parse(
      new TextDecoder().decode(init.body as Uint8Array),
    ) as WorkerCall["body"];
    calls.push({ path: url.pathname, secret: headers.get("x-desyn-secret"), body });
    if (failures > 0) {
      failures--;
      return new Response("worker busy", { status: opts.status ?? 503 });
    }
    const format = url.pathname === "/v1/thumbnail" ? "webp" : (body.format ?? "png");
    return new Response(new TextEncoder().encode(`${format}:${body.pageId}`) as BodyInit, {
      status: 200,
      headers: { "content-type": format === "pdf" ? "application/pdf" : `image/${format}` },
    });
  };
  return { calls, fetchImpl };
}

beforeEach(() => {
  vi.stubEnv("DESYN_EDITION", "selfhost");
  vi.stubEnv("RENDER_WORKER_URL", "http://worker.test");
  vi.stubEnv("RENDER_WORKER_SECRET", "worker-secret");
  vi.stubEnv("MAIL_TRANSPORT", "log");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function fixture() {
  const t = setupTest();
  const owner = await createUser(t);
  const workspaceId = await workspaceOf(owner);
  const { designId } = await owner.as.mutation(api.designs.designs.create, {
    workspaceId,
    kind: "presentation",
    name: "Pitch Deck!",
  });
  const { design } = await loadAll(owner.as, designId);
  const pageA = firstPageId(design);
  const pageB = page({ name: "Slide 2" });
  await owner.as.mutation(api.designs.designs.commit, {
    designId,
    tx: JSON.stringify(
      makeTx([
        { op: "create", nodes: [pageB], parent: "root" },
        { op: "create", nodes: [rect(pageA)], parent: pageA },
      ]),
    ),
  });
  return { t, owner, workspaceId, designId, pageA, pageB: pageB.id };
}

describe("exports", () => {
  test("PNG exports render one file per page and become downloadable", async () => {
    const worker = fakeWorker();
    vi.stubGlobal("fetch", worker.fetchImpl);
    const { t, owner, designId, pageA, pageB } = await fixture();
    vi.useFakeTimers();
    const exportId = await owner.as.mutation(api.exports.exports.request, {
      designId,
      format: "png",
      scale: 2,
    });
    expect((await owner.as.query(api.exports.exports.status, { exportId })).status).toBe("queued");
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const renders = worker.calls.filter((c) => c.path === "/v1/render");
    expect(renders.map((c) => c.body.pageId)).toEqual([pageA, pageB]);
    expect(renders.every((c) => c.secret === "worker-secret")).toBe(true);
    const status = await owner.as.query(api.exports.exports.status, { exportId });
    expect(status.status).toBe("ready");
    expect(status.files.map((f) => f.fileName)).toEqual(["Pitch-Deck-1.png", "Pitch-Deck-2.png"]);
    expect(status.files.every((f) => typeof f.url === "string")).toBe(true);
    expect((await owner.as.query(api.billing.usage.summary, {})).meters.exports.used).toBe(1);
    expect((await owner.as.query(api.exports.exports.list, { designId })).map((e) => e.id)).toEqual(
      [exportId],
    );
  });

  test("PDF of selected pages is one file; large jobs email when ready", async () => {
    const worker = fakeWorker();
    vi.stubGlobal("fetch", worker.fetchImpl);
    const { t, owner, designId, pageB } = await fixture();
    vi.useFakeTimers();
    const exportId = await owner.as.mutation(api.exports.exports.request, {
      designId,
      format: "pdf",
      pages: [pageB],
      notify: true,
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const call = worker.calls.find((c) => c.path === "/v1/render");
    if (!call) throw new Error("the worker was not called");
    expect(call.body.pageId).toBe("all");
    expect((call.body.design.nodes.root as { children: string[] }).children).toEqual([pageB]);
    const status = await owner.as.query(api.exports.exports.status, { exportId });
    expect(status.files).toHaveLength(1);
    expect(status.files[0]?.fileName).toBe("Pitch-Deck.pdf");
    const mail = await t.run(async (ctx) => ctx.db.query("mailLog").collect());
    expect(mail.some((m) => m.template === "exportReady" && m.to === owner.email)).toBe(true);
  });

  test("transient worker failures are retried; permanent ones fail the job", async () => {
    const flaky = fakeWorker({ failTimes: 1 });
    vi.stubGlobal("fetch", flaky.fetchImpl);
    const { t, owner, designId, pageA } = await fixture();
    vi.useFakeTimers();
    const ok = await owner.as.mutation(api.exports.exports.request, {
      designId,
      format: "jpeg",
      pages: [pageA],
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await owner.as.query(api.exports.exports.status, { exportId: ok })).toMatchObject({
      status: "ready",
      attempts: 2,
    });

    vi.stubGlobal("fetch", fakeWorker({ failTimes: 10, status: 400 }).fetchImpl);
    const bad = await owner.as.mutation(api.exports.exports.request, {
      designId,
      format: "jpeg",
      pages: [pageA],
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const status = await owner.as.query(api.exports.exports.status, { exportId: bad });
    expect(status.status).toBe("failed");
    expect(status.error).toContain("400");
  });

  test("validation and plan gating", async () => {
    vi.stubGlobal("fetch", fakeWorker().fetchImpl);
    const { owner, designId } = await fixture();
    expect(
      (
        await errorData(
          owner.as.mutation(api.exports.exports.request, {
            designId,
            format: "png",
            pages: ["nopenopenope"],
          }),
        )
      ).code,
    ).toBe("INVALID_ARGUMENT");
    expect(
      (
        await errorData(
          owner.as.mutation(api.exports.exports.request, { designId, format: "png", scale: 20 }),
        )
      ).code,
    ).toBe("INVALID_ARGUMENT");
    vi.stubEnv("DESYN_EDITION", "hosted");
    expect(
      await errorData(owner.as.mutation(api.exports.exports.request, { designId, format: "svg" })),
    ).toMatchObject({
      code: "FEATURE_UNAVAILABLE",
      feature: "export.svg",
    });
    expect(
      await errorData(
        owner.as.mutation(api.exports.exports.request, {
          designId,
          format: "pdf",
          pdf: { bleed: true, cropMarks: true, cmyk: false },
        }),
      ),
    ).toMatchObject({ code: "FEATURE_UNAVAILABLE", feature: "export.pdfPrint" });
    vi.stubEnv("RENDER_WORKER_URL", "");
    vi.stubEnv("DESYN_EDITION", "selfhost");
    expect(
      (await errorData(owner.as.mutation(api.exports.exports.request, { designId, format: "png" })))
        .code,
    ).toBe("NOT_CONFIGURED");
  });
});

describe("export flood protection", () => {
  test("jobs in flight are capped per user and count toward the monthly limit", async () => {
    const worker = fakeWorker();
    vi.stubGlobal("fetch", worker.fetchImpl);
    const { t, owner, designId } = await fixture();
    for (let i = 0; i < 10; i++) {
      await owner.as.mutation(api.exports.exports.request, { designId, format: "png" });
    }
    expect(
      await errorData(owner.as.mutation(api.exports.exports.request, { designId, format: "png" })),
    ).toMatchObject({ code: "RATE_LIMITED" });
    // Once the queue drains the user can export again.
    vi.useFakeTimers();
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    vi.useRealTimers();
    await owner.as.mutation(api.exports.exports.request, { designId, format: "png" });

    // Hosted free plan (300 / month): queued jobs are counted before they finish.
    vi.stubEnv("DESYN_EDITION", "hosted");
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("usage")
        .withIndex("by_user_metric_period", (q) =>
          q.eq("userId", owner.userId).eq("metric", "exports"),
        )
        .first();
      if (row) await ctx.db.patch("usage", row._id, { value: 299 });
    });
    expect(
      await errorData(owner.as.mutation(api.exports.exports.request, { designId, format: "png" })),
    ).toMatchObject({ code: "LIMIT_REACHED", limit: "exportsPerMonth" });
  });
});

describe("thumbnails", () => {
  test("a commit schedules a debounced thumbnail render stored on the design", async () => {
    const worker = fakeWorker();
    vi.stubGlobal("fetch", worker.fetchImpl);
    vi.useFakeTimers();
    const { t, owner, designId, pageA } = await fixture();
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const thumbCalls = worker.calls.filter((c) => c.path === "/v1/thumbnail");
    expect(thumbCalls).toHaveLength(1);
    expect(thumbCalls[0]?.body).toMatchObject({ pageId: pageA, width: 640 });
    const summary = await owner.as.query(api.designs.designs.get, { designId });
    expect(summary.thumbnailUrl).toBeTruthy();
  });
});
