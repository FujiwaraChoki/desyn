import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { makeTx, workspaceOf } from "./designs.helpers";
import { createUser, errorData, setupTest } from "./harness.helpers";

// An in-memory S3 behind a stubbed fetch: path-style requests to http://s3.test/<bucket>/<key>.
class FakeS3 {
  objects = new Map<string, { body: Uint8Array; type: string }>();
  requests: { method: string; key: string; signed: boolean }[] = [];

  fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    if (url.host !== "s3.test") throw new Error(`unexpected fetch to ${url.host}`);
    const key = decodeURIComponent(url.pathname.replace(/^\/desyn\//, ""));
    const method = (init.method ?? "GET").toUpperCase();
    const headers = new Headers(init.headers);
    const signed =
      url.searchParams.has("X-Amz-Signature") ||
      (headers.get("authorization") ?? "").startsWith("AWS4-HMAC-SHA256");
    this.requests.push({ method, key, signed });
    if (!signed) return new Response("AccessDenied", { status: 403 });
    const obj = this.objects.get(key);
    switch (method) {
      case "PUT": {
        const body = new Uint8Array(await new Response(init.body as BodyInit).arrayBuffer());
        this.objects.set(key, {
          body,
          type: headers.get("content-type") ?? "application/octet-stream",
        });
        return new Response(null, { status: 200 });
      }
      case "HEAD":
        return obj
          ? new Response(null, {
              status: 200,
              headers: { "content-length": String(obj.body.length), "content-type": obj.type },
            })
          : new Response(null, { status: 404 });
      case "GET":
        return obj
          ? new Response(obj.body as BodyInit, {
              status: 200,
              headers: { "content-type": obj.type },
            })
          : new Response("NoSuchKey", { status: 404 });
      case "DELETE":
        this.objects.delete(key);
        return new Response(null, { status: 204 });
      default:
        return new Response(null, { status: 405 });
    }
  };
}

function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  bytes.set([8, 6, 0, 0, 0], 24);
  return bytes;
}

let s3: FakeS3;

beforeEach(() => {
  vi.stubEnv("DESYN_EDITION", "selfhost");
  vi.stubEnv("S3_BUCKET", "desyn");
  vi.stubEnv("S3_ENDPOINT", "http://s3.test");
  vi.stubEnv("S3_FORCE_PATH_STYLE", "true");
  vi.stubEnv("AWS_ACCESS_KEY_ID", "test-access-key");
  vi.stubEnv("AWS_SECRET_ACCESS_KEY", "test-secret-key");
  s3 = new FakeS3();
  vi.stubGlobal("fetch", s3.fetch);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function upload(
  as: Awaited<ReturnType<typeof createUser>>["as"],
  workspaceId: Id<"workspaces">,
  name: string,
  mime: string,
  body: Uint8Array,
  opts: { sha256?: string; putMime?: string } = {},
) {
  const req = await as.mutation(api.assets.assets.requestUpload, {
    workspaceId,
    name,
    mime,
    bytes: body.length,
    ...(opts.sha256 ? { sha256: opts.sha256 } : {}),
  });
  if (req.upload) {
    const res = await fetch(req.upload.url, {
      method: "PUT",
      headers: {
        ...req.upload.headers,
        "content-type": opts.putMime ?? req.upload.headers["content-type"],
      },
      body: body as BodyInit,
    });
    expect(res.ok).toBe(true);
  }
  return req;
}

describe("assets", () => {
  test("upload -> finalize verifies the object, reads dimensions and counts storage", async () => {
    const t = setupTest();
    const user = await createUser(t);
    const workspaceId = await workspaceOf(user);
    const bytes = png(3, 2);
    const req = await upload(user.as, workspaceId, "Logo Final.png", "image/png", bytes);
    expect(req.deduplicated).toBe(false);
    expect(req.upload?.headers).toEqual({
      "content-type": "image/png",
      "content-length": String(bytes.length),
    });
    const url = new URL(req.upload?.url ?? "");
    expect(url.host).toBe("s3.test");
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe("content-length;content-type;host");

    const done = await user.as.action(api.assets.assets.finalize, { assetId: req.assetId });
    expect(done).toEqual({ assetId: req.assetId, refId: req.refId, deduplicated: false });
    const asset = await user.as.query(api.assets.assets.get, { assetId: req.assetId });
    expect(asset).toMatchObject({
      status: "ready",
      kind: "image",
      width: 3,
      height: 2,
      hash: bytesToHex(sha256(bytes)),
      name: "Logo Final.png",
    });
    expect(asset.url).toContain("X-Amz-Signature=");
    const usage = await user.as.query(api.billing.usage.summary, {});
    expect(usage.meters.storageBytes.used).toBe(bytes.length);
    expect(usage.meters.uploads.used).toBe(1);
    const urls = await user.as.query(api.assets.assets.getUrl, { assetId: req.assetId });
    expect(urls.expiresAt).toBeGreaterThan(Date.now());
    const outsider = await createUser(t);
    expect(
      (await errorData(outsider.as.query(api.assets.assets.getUrl, { assetId: req.assetId }))).code,
    ).toBe("NOT_FOUND");
    const listed = await user.as.query(api.assets.assets.list, {
      workspaceId,
      paginationOpts: { numItems: 10, cursor: null },
    });
    expect(listed.page.map((a) => a.id)).toEqual([req.assetId]);
  });

  test("mismatched content is rejected and removed", async () => {
    const t = setupTest();
    const user = await createUser(t);
    const workspaceId = await workspaceOf(user);
    const fake = new TextEncoder().encode("definitely not a png file at all");
    const req = await upload(user.as, workspaceId, "x.png", "image/png", fake);
    expect(
      (await errorData(user.as.action(api.assets.assets.finalize, { assetId: req.assetId }))).code,
    ).toBe("INVALID_ARGUMENT");
    expect(s3.objects.size).toBe(0);
    const row = await t.run(async (ctx) => ctx.db.get("assets", req.assetId));
    expect(row?.status).toBe("failed");
  });

  test("SVG uploads are sanitized before they become ready", async () => {
    const t = setupTest();
    const user = await createUser(t);
    const workspaceId = await workspaceOf(user);
    const svg = new TextEncoder().encode(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 20"><script>alert(1)</script><rect width="40" height="20" onclick="x()"/></svg>',
    );
    const req = await upload(user.as, workspaceId, "icon.svg", "image/svg+xml", svg);
    await user.as.action(api.assets.assets.finalize, { assetId: req.assetId });
    const stored = s3.objects.get(
      (await t.run(async (ctx) => ctx.db.get("assets", req.assetId)))?.storageKey ?? "",
    );
    const text = new TextDecoder().decode(stored?.body);
    expect(text).not.toContain("script");
    expect(text).not.toContain("onclick");
    const asset = await user.as.query(api.assets.assets.get, { assetId: req.assetId });
    expect(asset).toMatchObject({
      kind: "svg",
      width: 40,
      height: 20,
      status: "ready",
      bytes: stored?.body.length,
    });
    // The sanitized file lives outside the key the presigned PUT covers, so replaying the (still valid)
    // upload URL with same-length malicious markup cannot replace what is served.
    const uploadKey = `uploads/${workspaceId}/${req.refId}/icon.svg`;
    expect(asset.storageKey).toBe(`uploads/${workspaceId}/${req.refId}/clean/icon.svg`);
    expect(s3.objects.has(uploadKey)).toBe(false);
    const head = '<svg xmlns="http://www.w3.org/2000/svg"><script>steal()</script>';
    const evil = new TextEncoder().encode(
      `${head}${" ".repeat(svg.length - head.length - 6)}</svg>`,
    );
    expect(evil.length).toBe(svg.length);
    const replay = await fetch(req.upload?.url ?? "", {
      method: "PUT",
      headers: req.upload?.headers,
      body: evil as BodyInit,
    });
    expect(replay.ok).toBe(true);
    const served = new TextDecoder().decode(s3.objects.get(asset.storageKey)?.body);
    expect(served).toBe(text);
  });

  test("dedupe by hash at request time and at finalize", async () => {
    const t = setupTest();
    const user = await createUser(t);
    const workspaceId = await workspaceOf(user);
    const bytes = png(10, 10);
    const first = await upload(user.as, workspaceId, "a.png", "image/png", bytes);
    await user.as.action(api.assets.assets.finalize, { assetId: first.assetId });
    const again = await upload(user.as, workspaceId, "b.png", "image/png", bytes, {
      sha256: bytesToHex(sha256(bytes)),
    });
    expect(again).toMatchObject({ assetId: first.assetId, deduplicated: true, upload: null });
    const blind = await upload(user.as, workspaceId, "c.png", "image/png", bytes);
    const res = await user.as.action(api.assets.assets.finalize, { assetId: blind.assetId });
    expect(res).toEqual({ assetId: first.assetId, refId: first.refId, deduplicated: true });
    expect(s3.objects.size).toBe(1);
    const usage = await user.as.query(api.billing.usage.summary, {});
    expect(usage.meters.storageBytes.used).toBe(bytes.length);
  });

  test("design asset URLs only resolve keys the workspace owns; deleted files survive while referenced", async () => {
    const t = setupTest();
    const user = await createUser(t);
    const other = await createUser(t);
    const workspaceId = await workspaceOf(user);
    const otherWs = await workspaceOf(other);
    const mine = await upload(user.as, workspaceId, "mine.png", "image/png", png(4, 4));
    await user.as.action(api.assets.assets.finalize, { assetId: mine.assetId });
    const theirs = await upload(other.as, otherWs, "theirs.png", "image/png", png(5, 5));
    await other.as.action(api.assets.assets.finalize, { assetId: theirs.assetId });
    const mineRow = await t.run(async (ctx) => ctx.db.get("assets", mine.assetId));
    const theirsRow = await t.run(async (ctx) => ctx.db.get("assets", theirs.assetId));

    const { designId } = await user.as.mutation(api.designs.designs.create, { workspaceId });
    await user.as.mutation(api.designs.designs.commit, {
      designId,
      tx: JSON.stringify(
        makeTx([
          {
            op: "asset",
            set: {
              [mine.refId]: {
                id: mine.refId,
                kind: "image",
                mime: "image/png",
                storageKey: mineRow?.storageKey,
              },
              [theirs.refId]: {
                id: theirs.refId,
                kind: "image",
                mime: "image/png",
                storageKey: theirsRow?.storageKey,
              },
              libraryaaaaa: {
                id: "libraryaaaaa",
                kind: "image",
                mime: "image/png",
                storageKey: "templates/menu/hero.png",
              },
              traversalaaa: {
                id: "traversalaaa",
                kind: "image",
                mime: "image/png",
                storageKey: `templates/../${theirsRow?.storageKey}`,
              },
            },
          },
        ]),
      ),
    });
    const { urls } = await user.as.query(api.assets.assets.designUrls, { designId });
    expect(Object.keys(urls).sort()).toEqual(["libraryaaaaa", mine.refId].sort());
    await user.as.mutation(api.designs.designs.commit, {
      designId,
      tx: JSON.stringify(makeTx([{ op: "asset", remove: ["libraryaaaaa", "traversalaaa"] }])),
    });

    await user.as.mutation(api.assets.assets.delete, { assetId: mine.assetId });
    expect((await user.as.query(api.billing.usage.summary, {})).meters.storageBytes.used).toBe(0);
    await t.run(async (ctx) =>
      ctx.db.patch("assets", mine.assetId, { updatedAt: Date.now() - 2 * 60 * 60_000 }),
    );
    await t.mutation(internal.assets.assets.cleanup, {});
    await t.finishAllScheduledFunctions(() => {});
    expect(s3.objects.has(mineRow?.storageKey ?? "")).toBe(true); // still used by the design
    expect(
      Object.keys((await user.as.query(api.assets.assets.designUrls, { designId })).urls),
    ).toEqual([mine.refId]);

    await user.as.mutation(api.designs.designs.commit, {
      designId,
      tx: JSON.stringify(makeTx([{ op: "asset", remove: [mine.refId] }])),
    });
    await t.run(async (ctx) =>
      ctx.db.patch("assets", mine.assetId, { updatedAt: Date.now() - 2 * 60 * 60_000 }),
    );
    await t.mutation(internal.assets.assets.cleanup, {});
    await t.finishAllScheduledFunctions(() => {});
    expect(s3.objects.has(mineRow?.storageKey ?? "")).toBe(false);
  });

  test("cleanup drops purged and old failed rows so newer deletions are not starved", async () => {
    const t = setupTest();
    const user = await createUser(t);
    const workspaceId = await workspaceOf(user);
    const old = Date.now() - 30 * 24 * 60 * 60_000;
    const row = (
      refId: string,
      extra: Pick<Doc<"assets">, "status" | "updatedAt"> &
        Partial<Pick<Doc<"assets">, "purgedAt" | "deletedAt">>,
    ) => ({
      workspaceId,
      ownerId: user.userId,
      refId,
      kind: "image" as const,
      name: refId,
      mime: "image/png",
      bytes: 10,
      storageKey: `uploads/${workspaceId}/${refId}/x.png`,
      source: "upload" as const,
      createdAt: old,
      ...extra,
    });
    const fresh = await t.run(async (ctx) => {
      // 150 purged rows older than everything else, plus old failed uploads.
      for (let i = 0; i < 150; i++) {
        await ctx.db.insert(
          "assets",
          row(`purged${String(i).padStart(6, "0")}`, {
            status: "deleted",
            purgedAt: old,
            deletedAt: old,
            updatedAt: old - 1_000 + i,
          }),
        );
      }
      await ctx.db.insert(
        "assets",
        row("failed000001", { status: "failed", purgedAt: old, updatedAt: old }),
      );
      // A newer deletion whose bytes should be removed.
      return await ctx.db.insert(
        "assets",
        row("deleted00001", {
          status: "deleted",
          deletedAt: Date.now() - 2 * 60 * 60_000,
          updatedAt: Date.now() - 2 * 60 * 60_000,
        }),
      );
    });
    s3.objects.set(`uploads/${workspaceId}/deleted00001/x.png`, {
      body: png(1, 1),
      type: "image/png",
    });
    const first = await t.mutation(internal.assets.assets.cleanup, {});
    expect(first.removed).toBe(101); // 100 purged + 1 failed
    const second = await t.mutation(internal.assets.assets.cleanup, {});
    expect(second.removed).toBe(50);
    expect(second.purged).toBe(1);
    await t.finishAllScheduledFunctions(() => {});
    expect(s3.objects.has(`uploads/${workspaceId}/deleted00001/x.png`)).toBe(false);
    expect((await t.run(async (ctx) => ctx.db.get("assets", fresh)))?.purgedAt).toBeDefined();
  });

  test("ingest stores server-produced bytes; not configured without S3; fonts are a plan feature", async () => {
    const t = setupTest();
    const user = await createUser(t);
    const workspaceId = await workspaceOf(user);
    const res = await t.action(internal.assets.assets.ingest, {
      workspaceId,
      userId: user.userId,
      name: "generated.png",
      mime: "image/png",
      data: png(64, 32).buffer as ArrayBuffer,
      source: "ai",
      ai: { provider: "fal", model: "test-model", prompt: "a sun" },
    });
    expect(res).toMatchObject({ width: 64, height: 32, deduplicated: false });
    expect(res.storageKey.startsWith(`generated/${workspaceId}/`)).toBe(true);

    vi.stubEnv("DESYN_EDITION", "hosted");
    expect(
      await errorData(
        user.as.mutation(api.assets.assets.requestUpload, {
          workspaceId,
          name: "f.woff2",
          mime: "font/woff2",
          bytes: 100,
        }),
      ),
    ).toMatchObject({ code: "FEATURE_UNAVAILABLE", feature: "fonts.custom" });
    expect(
      await errorData(
        user.as.mutation(api.assets.assets.requestUpload, {
          workspaceId,
          name: "big.png",
          mime: "image/png",
          bytes: 50 * 1024 * 1024,
        }),
      ),
    ).toMatchObject({ code: "LIMIT_REACHED", limit: "uploadMbPerFile" });
    expect(
      (
        await errorData(
          user.as.mutation(api.assets.assets.requestUpload, {
            workspaceId,
            name: "x.exe",
            mime: "application/x-msdownload",
            bytes: 1,
          }),
        )
      ).code,
    ).toBe("INVALID_ARGUMENT");
    vi.stubEnv("S3_BUCKET", "");
    expect(
      (
        await errorData(
          user.as.mutation(api.assets.assets.requestUpload, {
            workspaceId,
            name: "a.png",
            mime: "image/png",
            bytes: 1,
          }),
        )
      ).code,
    ).toBe("NOT_CONFIGURED");
  });
});
