import { createRect, createText, type Design } from "@desyn/schema";
import {
  CommitResultSchema,
  CreatedDesignSchema,
  CreditsSchema,
  DesignListSchema,
  DesignSummarySchema,
  DocumentSchema,
  MeSchema,
  type Schema,
  TransactionListSchema,
  UsageSchema,
  validate,
  WorkspaceListSchema,
} from "@desyn/sdk/contract";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import { addMember, apiUser, call, keyFor } from "./api.helpers";
import { createUser, setupTest } from "./harness.helpers";

function expectSchema(schema: Schema, value: unknown) {
  const result = validate(schema, value);
  if (!result.success)
    throw new Error(`response does not match the contract: ${JSON.stringify(result.issues)}`);
}

beforeEach(() => {
  vi.stubEnv("DESYN_EDITION", "selfhost");
  vi.stubEnv("MAIL_TRANSPORT", "log");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function createdDesign(t: ReturnType<typeof setupTest>, key: string, body: object = {}) {
  const res = await call(t, "POST", "designs", {
    key,
    body: { name: "Launch", presetId: "instagram-post", ...body },
  });
  expect(res.status).toBe(201);
  return res.json as { id: string; firstPageId: string; seq: number };
}

describe("authentication and routing", () => {
  test("index and OpenAPI are public; everything else needs a valid key", async () => {
    const t = setupTest();
    const index = await call(t, "GET", "/api/v1");
    expect(index.status).toBe(200);
    expect(index.json.openapi).toBe("/api/v1/openapi.json");
    const spec = await call(t, "GET", "openapi.json");
    expect(spec.status).toBe(200);
    expect(spec.json.openapi).toBe("3.1.0");
    expect(spec.json.paths["/designs/{designId}/transactions"].post.operationId).toBe(
      "commitTransaction",
    );

    const none = await call(t, "GET", "me");
    expect(none.status).toBe(401);
    expect(none.json.error.code).toBe("UNAUTHENTICATED");
    expect(none.headers.get("www-authenticate")).toContain("Bearer");
    expect(none.json.error.requestId).toMatch(/^req_/);

    const malformed = await call(t, "GET", "me", { headers: { authorization: "Bearer nope" } });
    expect(malformed.status).toBe(401);
    expect(malformed.json.error.message).toContain("malformed");

    const forged = await call(t, "GET", "me", { key: `dsk_${"a".repeat(43)}` });
    expect(forged.status).toBe(401);
  });

  test("x-api-key header, revoked keys, unknown endpoints and wrong methods", async () => {
    const t = setupTest();
    const u = await apiUser(t);
    const viaHeader = await call(t, "GET", "me", { headers: { "x-api-key": u.key } });
    expect(viaHeader.status).toBe(200);

    expect((await call(t, "GET", "nope", { key: u.key })).status).toBe(404);
    const wrong = await call(t, "PUT", "designs", { key: u.key });
    expect(wrong.status).toBe(404);
    const method = await call(t, "PATCH", "designs", { key: u.key, body: {} });
    expect(method.status).toBe(405);
    expect(method.headers.get("allow")).toContain("GET");
    expect(method.json.error.code).toBe("METHOD_NOT_ALLOWED");

    const preflight = await call(t, "OPTIONS", "designs");
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-headers")).toContain("idempotency-key");

    await u.as.mutation(api.accounts.apiKeys.revoke, { keyId: u.keyId });
    expect((await call(t, "GET", "me", { key: u.key })).status).toBe(401);
  });

  test("scopes are enforced per route and write scopes follow the member's role", async () => {
    const t = setupTest();
    const reader = await apiUser(t, { scopes: ["designs:read"] });
    const list = await call(t, "GET", "designs", { key: reader.key });
    expect(list.status).toBe(200);
    const denied = await call(t, "POST", "designs", { key: reader.key, body: {} });
    expect(denied.status).toBe(403);
    expect(denied.json.error.code).toBe("INSUFFICIENT_SCOPE");
    expect(denied.json.error.required).toEqual(["designs:write"]);

    // A viewer's key keeps only its read scopes even though it was created with write scopes.
    const owner = await apiUser(t);
    const viewer = await createUser(t);
    await addMember(t, owner.workspaceId, viewer.userId, "editor");
    const viewerKey = await keyFor(viewer, owner.workspaceId);
    await t.run(async (ctx) => {
      const m = await ctx.db
        .query("memberships")
        .withIndex("by_workspace_user", (q) =>
          q.eq("workspaceId", owner.workspaceId).eq("userId", viewer.userId),
        )
        .unique();
      if (m) await ctx.db.patch("memberships", m._id, { role: "viewer" });
    });
    const me = await call(t, "GET", "me", { key: viewerKey });
    expect(me.json.role).toBe("viewer");
    expect(me.json.scopes).toEqual(["designs:read", "assets:read", "templates:read", "brand:read"]);
    expect((await call(t, "POST", "designs", { key: viewerKey, body: {} })).json.error.code).toBe(
      "INSUFFICIENT_SCOPE",
    );
  });

  test("the Agent API is a plan feature on hosted", async () => {
    const t = setupTest();
    const u = await apiUser(t);
    vi.stubEnv("DESYN_EDITION", "hosted");
    const res = await call(t, "GET", "me", { key: u.key });
    expect(res.status).toBe(403);
    expect(res.json.error).toMatchObject({ code: "FEATURE_UNAVAILABLE", feature: "agentApi" });
  });

  test("rate limit: 429 with Retry-After once the key's bucket is empty", async () => {
    const t = setupTest();
    const u = await apiUser(t);
    let limited: Awaited<ReturnType<typeof call>> | null = null;
    // Burst capacity is 120 tokens; createDesign costs 2.
    for (let i = 0; i < 70 && !limited; i++) {
      const res = await call(t, "GET", "designs?limit=1", { key: u.key });
      const doc = await call(t, "GET", "designs/none/document", { key: u.key });
      if (res.status === 429) limited = res;
      else if (doc.status === 429) limited = doc;
    }
    expect(limited).not.toBeNull();
    expect(limited?.json.error.code).toBe("RATE_LIMITED");
    expect(Number(limited?.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    expect(limited?.json.error.retryAfterMs).toBeGreaterThan(0);
  });
});

describe("account", () => {
  test("me, workspaces, credits and usage match the contract", async () => {
    const t = setupTest();
    const u = await apiUser(t);
    const me = await call(t, "GET", "me", { key: u.key });
    expectSchema(MeSchema, me.json);
    expect(me.json).toMatchObject({
      userId: u.userId,
      workspaceId: u.workspaceId,
      plan: "selfhost",
      role: "owner",
    });
    const ws = await call(t, "GET", "workspaces", { key: u.key });
    expectSchema(WorkspaceListSchema, ws.json);
    expect(ws.json.items[0]).toMatchObject({ id: u.workspaceId, current: true });
    expectSchema(CreditsSchema, (await call(t, "GET", "credits", { key: u.key })).json);
    const usage = await call(t, "GET", "usage", { key: u.key });
    expectSchema(UsageSchema, usage.json);
    expect(usage.json.api.burst).toBe(120);
  });
});

describe("designs", () => {
  test("create, list with pagination, get, rename, move, archive, restore, trash and purge", async () => {
    const t = setupTest();
    const u = await apiUser(t);
    const a = await createdDesign(t, u.key);
    expectSchema(CreatedDesignSchema, a);
    expect(a.firstPageId).toMatch(/^[a-z0-9]{12}$/);
    const custom = await call(t, "POST", "designs", {
      key: u.key,
      body: { name: "Poster", kind: "poster", width: 1200, height: 1800, unit: "mm" },
    });
    expect(custom.json).toMatchObject({ kind: "poster", width: 1200, height: 1800 });
    const bad = await call(t, "POST", "designs", { key: u.key, body: { width: 100 } });
    expect(bad.status).toBe(400);
    expect(bad.json.error.field).toBe("body.width");

    const page1 = await call(t, "GET", "designs?limit=1", { key: u.key });
    expectSchema(DesignListSchema, page1.json);
    expect(page1.json.items).toHaveLength(1);
    expect(page1.json.nextCursor).toBeTypeOf("string");
    const page2 = await call(
      t,
      "GET",
      `designs?limit=1&cursor=${encodeURIComponent(page1.json.nextCursor)}`,
      {
        key: u.key,
      },
    );
    expect(page2.json.items).toHaveLength(1);
    expect(page2.json.items[0].id).not.toBe(page1.json.items[0].id);
    const posters = await call(t, "GET", "designs?kind=poster", { key: u.key });
    expect(posters.json.items.map((d: { name: string }) => d.name)).toEqual(["Poster"]);

    const renamed = await call(t, "PATCH", `designs/${a.id}`, {
      key: u.key,
      body: { name: "Launch v2" },
    });
    expect(renamed.status).toBe(200);
    expectSchema(DesignSummarySchema, renamed.json);
    expect(renamed.json).toMatchObject({ name: "Launch v2", seq: a.seq + 1 });

    const folderId = await u.as.mutation(api.accounts.folders.create, {
      workspaceId: u.workspaceId,
      name: "Q4",
    });
    const moved = await call(t, "PATCH", `designs/${a.id}`, { key: u.key, body: { folderId } });
    expect(moved.json.folderId).toBe(folderId);
    const inFolder = await call(t, "GET", `designs?folderId=${folderId}`, { key: u.key });
    expect(inFolder.json.items.map((d: { id: string }) => d.id)).toEqual([a.id]);
    // search + folderId: the search index cannot filter by folder, the page is filtered instead.
    const searchIn = await call(t, "GET", `designs?search=Launch&folderId=${folderId}`, {
      key: u.key,
    });
    expect(searchIn.json.items.map((d: { id: string }) => d.id)).toEqual([a.id]);
    const searchRoot = await call(t, "GET", "designs?search=Launch&folderId=root", {
      key: u.key,
    });
    expect(searchRoot.json.items).toEqual([]);
    const folders = await call(t, "GET", "folders", { key: u.key });
    expect(folders.json.items[0]).toMatchObject({ id: folderId, name: "Q4", parentId: null });

    expect((await call(t, "POST", `designs/${a.id}/archive`, { key: u.key })).json.state).toBe(
      "archived",
    );
    const archived = await call(t, "GET", "designs?state=archived", { key: u.key });
    expect(archived.json.items.map((d: { id: string }) => d.id)).toEqual([a.id]);
    expect((await call(t, "POST", `designs/${a.id}/restore`, { key: u.key })).json.state).toBe(
      "active",
    );

    const notTrashed = await call(t, "DELETE", `designs/${a.id}?permanent=true`, { key: u.key });
    expect(notTrashed.status).toBe(409);
    expect((await call(t, "DELETE", `designs/${a.id}`, { key: u.key })).json).toEqual({
      deleted: true,
      state: "trashed",
    });
    expect((await call(t, "GET", `designs/${a.id}`, { key: u.key })).json.state).toBe("trashed");
    expect(
      (await call(t, "DELETE", `designs/${a.id}?permanent=1`, { key: u.key })).json.state,
    ).toBe("purged");
    expect((await call(t, "GET", `designs/${a.id}`, { key: u.key })).status).toBe(404);
  });

  test("designs of other workspaces and malformed ids are not found", async () => {
    const t = setupTest();
    const a = await apiUser(t);
    const b = await apiUser(t);
    const design = await createdDesign(t, a.key);
    for (const path of [
      `designs/${design.id}`,
      `designs/${design.id}/document`,
      "designs/not-an-id",
      "designs/x%2Fy",
    ]) {
      const res = await call(t, "GET", path, { key: b.key });
      expect(res.status).toBe(404);
      expect(res.json.error.code).toBe("NOT_FOUND");
    }
    const commit = await call(t, "POST", `designs/${design.id}/transactions`, {
      key: b.key,
      body: { tx: { ops: [{ op: "delete", id: design.firstPageId }] } },
    });
    expect(commit.status).toBe(404);

    // Even a member of both workspaces only reaches the key's workspace.
    await addMember(t, b.workspaceId, a.userId, "editor");
    const otherWs = await call(t, "POST", "designs", { key: b.key, body: { name: "B's" } });
    const crossKey = await call(t, "GET", `designs/${otherWs.json.id}`, { key: a.key });
    expect(crossKey.status).toBe(404);
  });

  test("idempotent create: same key + body replays, different body is rejected", async () => {
    const t = setupTest();
    const u = await apiUser(t);
    const headers = { "idempotency-key": "create-1" };
    const first = await call(t, "POST", "designs", { key: u.key, body: { name: "Once" }, headers });
    const second = await call(t, "POST", "designs", {
      key: u.key,
      body: { name: "Once" },
      headers,
    });
    expect(second.status).toBe(201);
    expect(second.headers.get("idempotent-replayed")).toBe("true");
    expect(second.json.id).toBe(first.json.id);
    const listed = await call(t, "GET", "designs", { key: u.key });
    expect(listed.json.items).toHaveLength(1);
    const reused = await call(t, "POST", "designs", {
      key: u.key,
      body: { name: "Other" },
      headers,
    });
    expect(reused.status).toBe(422);
    expect(reused.json.error.code).toBe("IDEMPOTENCY_KEY_REUSED");
    const invalid = await call(t, "POST", "designs", {
      key: u.key,
      body: {},
      headers: { "idempotency-key": "bad key" },
    });
    expect(invalid.status).toBe(400);
  });
});

describe("document and transactions", () => {
  test("commit, idempotency on tx id and Idempotency-Key, dropped ops, history", async () => {
    const t = setupTest();
    const u = await apiUser(t);
    const d = await createdDesign(t, u.key);
    const rect = createRect({ parent: d.firstPageId, x: 10, y: 20, width: 100, height: 50 });
    const res = await call(t, "POST", `designs/${d.id}/transactions`, {
      key: u.key,
      body: {
        baseSeq: d.seq,
        tx: { label: "Add a box", ops: [{ op: "create", parent: d.firstPageId, nodes: [rect] }] },
      },
      headers: { "idempotency-key": "box-1" },
    });
    expect(res.status).toBe(200);
    expectSchema(CommitResultSchema, res.json);
    expect(res.json).toMatchObject({ seq: d.seq + 1, duplicate: false, dropped: [] });
    expect(res.json.txId).toMatch(/^[a-z0-9]{12}$/);
    expect(res.headers.get("x-desyn-seq")).toBe(String(d.seq + 1));

    // Same Idempotency-Key: the stored response is replayed, nothing is committed twice.
    const replay = await call(t, "POST", `designs/${d.id}/transactions`, {
      key: u.key,
      body: {
        baseSeq: d.seq,
        tx: { label: "Add a box", ops: [{ op: "create", parent: d.firstPageId, nodes: [rect] }] },
      },
      headers: { "idempotency-key": "box-1" },
    });
    expect(replay.json).toEqual(res.json);
    expect(replay.headers.get("idempotent-replayed")).toBe("true");

    // Explicit tx.id: a retry reports duplicate.
    const tx = { id: "abcdefabcdef", ops: [{ op: "update", id: rect.id, set: { name: "Box" } }] };
    const once = await call(t, "POST", `designs/${d.id}/transactions`, {
      key: u.key,
      body: { tx },
    });
    const twice = await call(t, "POST", `designs/${d.id}/transactions`, {
      key: u.key,
      body: { tx },
    });
    expect(once.json.duplicate).toBe(false);
    expect(twice.json).toMatchObject({ duplicate: true, seq: once.json.seq, txId: "abcdefabcdef" });

    // Ops that no longer apply are dropped and reported.
    const dropped = await call(t, "POST", `designs/${d.id}/transactions`, {
      key: u.key,
      body: {
        tx: {
          ops: [
            { op: "delete", id: "zzzzzzzzzzzz" },
            { op: "update", id: rect.id, set: { opacity: 0.5 } },
          ],
        },
      },
    });
    expect(dropped.json.dropped).toEqual([{ index: 0, reason: "missing-node" }]);
    expect(dropped.json.applied).toHaveLength(1);

    // Malformed ops are rejected up front with the exact path.
    const invalid = await call(t, "POST", `designs/${d.id}/transactions`, {
      key: u.key,
      body: {
        tx: {
          ops: [
            { op: "update", id: rect.id, set: { x: 1 } },
            { op: "teleport", id: rect.id },
          ],
        },
      },
    });
    expect(invalid.status).toBe(400);
    expect(invalid.json.error.field).toMatch(/^body\.tx\.ops\.1/);
    const ahead = await call(t, "POST", `designs/${d.id}/transactions`, {
      key: u.key,
      body: { baseSeq: 999, tx: { ops: [{ op: "update", id: rect.id, set: { x: 1 } }] } },
    });
    expect(ahead.status).toBe(400);

    const history = await call(t, "GET", `designs/${d.id}/transactions?since=${d.seq}`, {
      key: u.key,
    });
    expectSchema(TransactionListSchema, history.json);
    expect(history.json.items.map((e: { tx: { label: string } }) => e.tx.label)).toEqual([
      "Add a box",
      "API edit",
      "API edit",
    ]);
    expect(history.json.items[0].tx.actor).toMatchObject({ userId: u.userId, agent: "api" });
    expect(history.json.items[0].tx.source).toBe("ai");
    expect(history.json).toMatchObject({ reload: false, hasMore: false });
    const limited = await call(t, "GET", `designs/${d.id}/transactions?since=0&limit=1`, {
      key: u.key,
    });
    expect(limited.json.items).toHaveLength(1);
    expect(limited.json.hasMore).toBe(true);
  });

  test("load the document (whole and one page), with $var colors intact", async () => {
    const t = setupTest();
    const u = await apiUser(t);
    const d = await createdDesign(t, u.key);
    const text = createText({ parent: d.firstPageId, text: "Grüße" });
    text.style.fills = [{ type: "solid", color: { $var: "brand.primary" } }];
    await call(t, "POST", `designs/${d.id}/transactions`, {
      key: u.key,
      body: { tx: { ops: [{ op: "create", parent: d.firstPageId, nodes: [text] }] } },
    });
    const doc = await call(t, "GET", `designs/${d.id}/document`, { key: u.key });
    expectSchema(DocumentSchema, doc.json);
    const design = doc.json.design as Design;
    expect(design.nodes[text.id]).toMatchObject({ runs: [{ text: "Grüße" }] });
    expect((design.nodes[text.id] as typeof text).style.fills[0]).toEqual({
      type: "solid",
      color: { $var: "brand.primary" },
    });
    expect(doc.json.seq).toBe(d.seq + 1);
    const onePage = await call(t, "GET", `designs/${d.id}/document?pageId=${d.firstPageId}`, {
      key: u.key,
    });
    expect(Object.keys(onePage.json.design.nodes).sort()).toEqual(
      ["root", d.firstPageId, text.id].sort(),
    );
    expect(
      (await call(t, "GET", `designs/${d.id}/document?pageId=zzzzzzzzzzzz`, { key: u.key })).status,
    ).toBe(404);
  });

  test("editors can commit but not trash others' designs; commenters' keys cannot write", async () => {
    const t = setupTest();
    const owner = await apiUser(t);
    const d = await createdDesign(t, owner.key);
    const editor = await createUser(t);
    await addMember(t, owner.workspaceId, editor.userId, "editor");
    const editorKey = await keyFor(editor, owner.workspaceId);
    const ok = await call(t, "POST", `designs/${d.id}/transactions`, {
      key: editorKey,
      body: { tx: { ops: [{ op: "doc", set: { name: "By editor" } }] } },
    });
    expect(ok.status).toBe(200);
    // Editors cannot trash designs they did not create (manage permission).
    const trash = await call(t, "DELETE", `designs/${d.id}`, { key: editorKey });
    expect(trash.status).toBe(403);
    expect(trash.json.error.code).toBe("FORBIDDEN");

    // Keys need the editor role to be created; this member is demoted to commenter afterwards.
    const commenter = await createUser(t);
    await addMember(t, owner.workspaceId, commenter.userId, "editor");
    const commenterKey = await keyFor(commenter, owner.workspaceId, [
      "designs:read",
      "designs:write",
    ]);
    await t.run(async (ctx) => {
      const m = await ctx.db
        .query("memberships")
        .withIndex("by_workspace_user", (q) =>
          q.eq("workspaceId", owner.workspaceId).eq("userId", commenter.userId),
        )
        .unique();
      if (m) await ctx.db.patch("memberships", m._id, { role: "commenter" });
    });
    const denied = await call(t, "POST", `designs/${d.id}/transactions`, {
      key: commenterKey,
      body: { tx: { ops: [{ op: "doc", set: { name: "By commenter" } }] } },
    });
    expect(denied.status).toBe(403);
    expect(denied.json.error.code).toBe("INSUFFICIENT_SCOPE");
    expect((await call(t, "GET", `designs/${d.id}`, { key: commenterKey })).json.permission).toBe(
      "comment",
    );
  });
});
