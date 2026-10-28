import { createRect } from "@desyn/schema";
import { describe, expect, test, vi } from "vitest";
import { DesynApiError, DesynClient, TransactionBuilder } from "../src";
import { MockApi, TEST_KEY } from "./mock-api";

function setup(opts: { maxRetries?: number; timeoutMs?: number } = {}) {
  const api = new MockApi();
  const client = new DesynClient({
    apiKey: TEST_KEY,
    baseUrl: api.base,
    fetch: api.fetch,
    maxRetryDelayMs: 5,
    ...opts,
  });
  return { api, client };
}

describe("DesynClient transport", () => {
  test("sends the bearer key, JSON bodies and query strings", async () => {
    const { api, client } = setup();
    await client.designs.create({ name: "Hello", kind: "poster" });
    await client.designs.list({ limit: 5, kind: "poster", mine: true });
    const [create, list] = api.requests;
    expect(create?.headers.get("authorization")).toBe(`Bearer ${TEST_KEY}`);
    expect(create?.headers.get("content-type")).toBe("application/json");
    expect(JSON.parse(create?.body ?? "{}")).toEqual({ name: "Hello", kind: "poster" });
    expect(create?.headers.get("idempotency-key")).toMatch(/^[0-9a-f]{32}$/);
    expect(list?.path).toBe("/api/v1/designs?limit=5&kind=poster&mine=true");
  });

  test("errors become DesynApiError with code, status, details and request id", async () => {
    const api = new MockApi();
    const client = new DesynClient({
      apiKey: `dsk_${"x".repeat(43)}`,
      baseUrl: api.base,
      fetch: api.fetch,
    });
    const err = await client.me().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DesynApiError);
    expect(err).toMatchObject({ status: 401, code: "UNAUTHENTICATED", requestId: "req_mock" });
    const { client: ok } = setup();
    const missing = await ok.designs.get("nope").catch((e: unknown) => e as DesynApiError);
    expect(missing).toMatchObject({ status: 404, code: "NOT_FOUND", retryable: false });
    vi.stubEnv("DESYN_API_KEY", "");
    await expect(
      new DesynClient({ baseUrl: "http://x", fetch: api.fetch }).me(),
    ).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
    });
    vi.unstubAllEnvs();
  });

  test("retries GETs and idempotent POSTs on 429/503 honoring Retry-After; never plain POSTs", async () => {
    const { api, client } = setup({ maxRetries: 2 });
    api.failures = { status: 429, count: 2, retryAfter: "0" };
    expect((await client.me()).userId).toBe("user1");
    expect(api.requests).toHaveLength(3);

    api.failures = { status: 503, count: 1 };
    const created = await client.designs.create({ name: "Once" });
    const keys = api.requests.slice(-2).map((r) => r.headers.get("idempotency-key"));
    expect(keys[0]).toBe(keys[1]);
    expect(created.name).toBe("Once");

    api.failures = { status: 503, count: 1 };
    const err = await client.exports.get("e1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DesynApiError);
    api.failures = { status: 503, count: 1 };
    const cancel = await client.agent.cancel("run1").catch((e: unknown) => e as DesynApiError);
    expect(cancel.status).toBe(503);

    api.failures = { status: 429, count: 5, retryAfter: "0" };
    const exhausted = await client.me().catch((e: unknown) => e as DesynApiError);
    expect(exhausted).toMatchObject({ code: "RATE_LIMITED", retryable: true, retryAfterMs: 0 });
  });

  test("network failures and timeouts", async () => {
    const failing = new DesynClient({
      apiKey: TEST_KEY,
      baseUrl: "http://down.test/api/v1",
      fetch: async () => {
        throw new TypeError("connection refused");
      },
      maxRetries: 1,
      maxRetryDelayMs: 1,
    });
    expect(await failing.me().catch((e: unknown) => (e as DesynApiError).code)).toBe(
      "NETWORK_ERROR",
    );
    const slow = new DesynClient({
      apiKey: TEST_KEY,
      baseUrl: "http://slow.test/api/v1",
      timeoutMs: 20,
      maxRetries: 0,
      fetch: (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    });
    expect(await slow.me().catch((e: unknown) => (e as DesynApiError).code)).toBe("TIMEOUT");
  });
});

describe("designs, documents and transactions", () => {
  test("create, commit with the builder, load, list changes, paginate", async () => {
    const { client } = setup();
    const created = await client.designs.create({ name: "Menu", kind: "menu" });
    const page = created.firstPageId as string;
    const b = new TransactionBuilder();
    const cardId = b.create(page, {
      type: "frame",
      name: "Card",
      fill: "#1d1a16",
      children: [{ type: "text", text: "Autumn", fontSize: 64, color: "#ffb02e" }],
    });
    b.update(cardId, { x: 40, y: 40 });
    const result = await client.designs.commit(created.id, {
      baseSeq: created.seq,
      tx: b.build("Add card"),
    });
    expect(result).toMatchObject({ seq: 2, duplicate: false, dropped: [] });
    const doc = await client.designs.load(created.id);
    expect(doc.design.nodes[cardId]).toMatchObject({ name: "Card", x: 40, y: 40 });
    const changes = await client.designs.transactions(created.id, { since: 1 });
    expect(changes.items[0]?.tx.label).toBe("Add card");

    // Retrying the same transaction (same id) is reported as a duplicate, never applied twice.
    const again = await client.designs.commit(created.id, { tx: { id: result.txId, ops: [] } });
    expect(again.duplicate).toBe(true);

    await client.designs.create({ name: "Two" });
    await client.designs.create({ name: "Three" });
    const names: string[] = [];
    for await (const d of client.designs.all({ limit: 2 })) names.push(d.name);
    expect(names).toEqual(["Menu", "Two", "Three"]);
  });

  test("describe sends selection as a list, preview returns bytes and headers", async () => {
    const { api, client } = setup();
    const created = await client.designs.create({ name: "x" });
    const d = await client.designs.describe(created.id, { selection: ["a1", "b2"], maxDepth: 2 });
    expect(d.selection).toEqual(["a1", "b2"]);
    expect(api.requests.at(-1)?.path).toContain("selection=a1%2Cb2&maxDepth=2");
    const img = await client.designs.preview(created.id, { scale: 0.5 });
    expect(img.contentType).toBe("image/png");
    expect(img.bytes.slice(0, 4)).toEqual(new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
    expect(img.seq).toBe(1);
    expect(api.requests.at(-1)?.headers.get("accept")).toBe("image/*");
  });

  test("raw rect nodes are passed through untouched by the builder", () => {
    const rect = createRect({ x: 1 });
    const b = new TransactionBuilder();
    b.create("page00000001", rect);
    expect(b.ops[0]).toEqual({ op: "create", parent: "page00000001", nodes: [rect] });
  });
});

describe("assets", () => {
  test("upload: request (with sha256), PUT with the signed headers, finalize", async () => {
    const { api, client } = setup();
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const asset = await client.assets.upload(bytes, { name: "x.png", mime: "image/png" });
    expect(asset.status).toBe("ready");
    expect(asset.assetRef.id).toBe(asset.refId);
    expect(api.uploads.get(asset.id)).toEqual(bytes);
    const request = JSON.parse(
      api.requests.find((r) => r.path.endsWith("/assets/uploads"))?.body ?? "{}",
    );
    expect(request.sha256).toBe("74f81fe167d99b4cb41d6d0ccda82278caee9f3e2f25d5e5a3936ff3dcec60d0");
    expect(request.bytes).toBe(5);
  });
});

describe("AI runs", () => {
  test("events() streams over SSE, reconnecting until stream-end; a run error event is data", async () => {
    const { api, client } = setup();
    const created = await client.designs.create({ name: "x" });
    const run = await client.agent.start(created.id, { goal: "warmer" });
    const types: string[] = [];
    for await (const e of client.agent.events(run.id)) types.push(e.type);
    expect(types).toEqual(["start", "tool-call", "text", "error", "done"]);
    const streams = api.requests.filter((r) => r.path.includes("/events"));
    expect(streams).toHaveLength(3);
    expect(streams[1]?.path).toContain("after=1");
    expect(streams[2]?.path).toContain("after=3");
  });

  test("a stream-error control event becomes a DesynApiError with the server's code", async () => {
    const sse =
      'id: 0\nevent: error\ndata: {"index":0,"type":"error","ts":1,"message":"busy","recoverable":true}\n\n' +
      'event: stream-error\ndata: {"code":"NOT_FOUND","message":"Run not found."}\n\n';
    const client = new DesynClient({
      apiKey: TEST_KEY,
      baseUrl: "https://example.test/api/v1",
      fetch: async () =>
        new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }),
    });
    const seen: string[] = [];
    const err = await (async () => {
      for await (const e of client.agent.events("run1")) seen.push(e.type);
    })().catch((e: unknown) => e);
    expect(seen).toEqual(["error"]);
    expect(err).toBeInstanceOf(DesynApiError);
    expect(err).toMatchObject({ code: "NOT_FOUND", message: "Run not found." });
  });

  test("events({ stream: false }) long-polls and wait() returns the finished run", async () => {
    const { client } = setup();
    const created = await client.designs.create({ name: "x" });
    const run = await client.agent.start(created.id, { goal: "warmer" });
    const types: string[] = [];
    for await (const e of client.agent.events(run.id, { stream: false })) types.push(e.type);
    expect(types).toEqual(["start", "tool-call", "text", "error", "done"]);
    const second = await client.agent.start(created.id, { goal: "again" });
    const finished = await client.agent.wait(second.id, { timeoutMs: 5_000 });
    expect(finished).toMatchObject({ status: "completed", result: { summary: "Made it warmer." } });
  });
});
