import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import { firstPageId, loadAll, workspaceOf } from "./designs.helpers";
import { createUser, errorData, setupTest } from "./harness.helpers";

// Export options the editor's export dialog sends next to the DOCUMENT_MODEL §8 basics: the frame rate of
// GIF / MP4 exports and the PDF image resolution reach the render worker (packages/editor src/export).

interface RenderBody {
  pageId: string;
  format: string;
  fps?: number;
  pdf?: { bleed: boolean; cropMarks: boolean; cmyk: boolean; dpi?: number };
}

function fakeWorker() {
  const calls: RenderBody[] = [];
  const fetchImpl = async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    if (url.host !== "worker.test") throw new Error(`unexpected fetch ${url.href}`);
    const body = JSON.parse(new TextDecoder().decode(init.body as Uint8Array)) as RenderBody;
    if (url.pathname === "/v1/render") calls.push(body);
    return new Response(new TextEncoder().encode(`${body.format}:${body.pageId}`) as BodyInit, {
      status: 200,
      headers: { "content-type": "application/octet-stream" },
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
    name: "Deck",
  });
  const { design } = await loadAll(owner.as, designId);
  return { t, owner, designId, pageId: firstPageId(design) };
}

describe("export options from the editor", () => {
  test("fps reaches the worker for video, dpi for PDF (next to the print options)", async () => {
    const worker = fakeWorker();
    vi.stubGlobal("fetch", worker.fetchImpl);
    const { t, owner, designId } = await fixture();
    vi.useFakeTimers();
    await owner.as.mutation(api.exports.exports.request, { designId, format: "mp4", fps: 24 });
    await owner.as.mutation(api.exports.exports.request, {
      designId,
      format: "pdf",
      dpi: 96,
      pdf: { bleed: true, cropMarks: false, cmyk: false },
    });
    await owner.as.mutation(api.exports.exports.request, { designId, format: "pdf", dpi: 150 });
    await owner.as.mutation(api.exports.exports.request, { designId, format: "gif" });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const byFormat = (f: string) => worker.calls.filter((c) => c.format === f);
    expect(byFormat("mp4")[0]?.fps).toBe(24);
    expect(byFormat("gif")[0]?.fps).toBeUndefined();
    expect(byFormat("pdf").map((c) => c.pdf)).toEqual([
      { bleed: true, cropMarks: false, cmyk: false, dpi: 96 },
      { bleed: false, cropMarks: false, cmyk: false, dpi: 150 },
    ]);
  });

  test("fps and dpi are validated per format", async () => {
    const { owner, designId } = await fixture();
    for (const args of [
      { format: "png" as const, fps: 30 },
      { format: "mp4" as const, fps: 0 },
      { format: "gif" as const, fps: 240 },
      { format: "png" as const, dpi: 150 },
      { format: "pdf" as const, dpi: 10 },
    ]) {
      const data = await errorData(
        owner.as.mutation(api.exports.exports.request, { designId, ...args }),
      );
      expect(data.code).toBe("INVALID_ARGUMENT");
    }
  });
});
