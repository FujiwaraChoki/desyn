import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { attributionUrl, checkPhotoUrl, providerOf } from "../panels/stock";
import { memberWithRole, workspaceOf } from "./designs.helpers";
import { createUser, errorData, setupTest, type TestConvex } from "./harness.helpers";

// Editor panels backend: upload folders (convex/panels/assetFolders.ts) and "use this stock photo"
// (convex/panels/stock.ts) with an in-memory S3 and a fake image CDN behind a stubbed fetch.

async function insertAsset(
  t: TestConvex,
  workspaceId: Id<"workspaces">,
  ownerId: string,
  name: string,
  status: "ready" | "deleted" = "ready",
): Promise<Id<"assets">> {
  return await t.run(async (ctx) => {
    const now = Date.now();
    return await ctx.db.insert("assets", {
      workspaceId,
      ownerId,
      refId: `ref${Math.random().toString(36).slice(2, 11)}`.slice(0, 12).padEnd(12, "0"),
      kind: "image",
      name,
      mime: "image/png",
      bytes: 10,
      storageKey: `uploads/${workspaceId}/${name}`,
      status,
      source: "upload",
      createdAt: now,
      updatedAt: now,
    });
  });
}

describe("upload folders", () => {
  test("create, list with counts, move, rename and delete (assets stay)", async () => {
    const t = setupTest();
    const owner = await createUser(t);
    const ws = await workspaceOf(owner);
    const a1 = await insertAsset(t, ws, owner.userId, "a.png");
    const a2 = await insertAsset(t, ws, owner.userId, "b.png");
    const gone = await insertAsset(t, ws, owner.userId, "gone.png");

    const folder = await owner.as.mutation(api.panels.assetFolders.create, {
      workspaceId: ws,
      name: "  Spring   launch ",
    });
    // Same name (any case) returns the existing folder.
    expect(
      await owner.as.mutation(api.panels.assetFolders.create, {
        workspaceId: ws,
        name: "spring launch",
      }),
    ).toBe(folder);
    await owner.as.mutation(api.panels.assetFolders.move, {
      workspaceId: ws,
      assetIds: [a1, a2, gone],
      folderId: folder,
    });
    await t.run(async (ctx) => ctx.db.patch("assets", gone, { status: "deleted" }));

    const list = await owner.as.query(api.panels.assetFolders.list, { workspaceId: ws });
    expect(list).toEqual([
      { id: folder, name: "Spring launch", count: 2, createdAt: expect.any(Number) },
    ]);
    const inside = await owner.as.query(api.panels.assetFolders.assets, {
      folderId: folder,
      paginationOpts: { numItems: 10, cursor: null },
    });
    expect(inside.page.map((a) => a.name).sort()).toEqual(["a.png", "b.png"]);

    // Moving to another folder leaves the first; null takes it out of any folder.
    const other = await owner.as.mutation(api.panels.assetFolders.create, {
      workspaceId: ws,
      name: "Other",
    });
    await owner.as.mutation(api.panels.assetFolders.move, {
      workspaceId: ws,
      assetIds: [a1],
      folderId: other,
    });
    await owner.as.mutation(api.panels.assetFolders.move, {
      workspaceId: ws,
      assetIds: [a2],
      folderId: null,
    });
    const counts = await owner.as.query(api.panels.assetFolders.list, { workspaceId: ws });
    expect(Object.fromEntries(counts.map((f) => [f.name, f.count]))).toEqual({
      Other: 1,
      "Spring launch": 0,
    });

    await owner.as.mutation(api.panels.assetFolders.rename, { folderId: other, name: "Archive" });
    await owner.as.mutation(api.panels.assetFolders.remove, { folderId: other });
    expect(
      (await owner.as.query(api.panels.assetFolders.list, { workspaceId: ws })).map((f) => f.name),
    ).toEqual(["Spring launch"]);
    const stillThere = await owner.as.query(api.assets.assets.get, { assetId: a1 });
    expect(stillThere.status).toBe("ready");
  });

  test("roles, workspace isolation and validation", async () => {
    const t = setupTest();
    const owner = await createUser(t);
    const ws = await workspaceOf(owner);
    const viewer = await memberWithRole(t, ws, "viewer");
    const outsider = await createUser(t);
    const outsiderWs = await workspaceOf(outsider);
    const foreign = await insertAsset(t, outsiderWs, outsider.userId, "x.png");
    const folder = await owner.as.mutation(api.panels.assetFolders.create, {
      workspaceId: ws,
      name: "Brand",
    });

    expect(await viewer.as.query(api.panels.assetFolders.list, { workspaceId: ws })).toHaveLength(
      1,
    );
    expect(
      (
        await errorData(
          viewer.as.mutation(api.panels.assetFolders.create, { workspaceId: ws, name: "Nope" }),
        )
      ).code,
    ).toBe("FORBIDDEN");
    expect(
      (await errorData(outsider.as.query(api.panels.assetFolders.list, { workspaceId: ws }))).code,
    ).toBe("NOT_FOUND");
    expect(
      (await errorData(outsider.as.mutation(api.panels.assetFolders.remove, { folderId: folder })))
        .code,
    ).toBe("NOT_FOUND");
    // Assets of another workspace cannot be filed here.
    expect(
      (
        await errorData(
          owner.as.mutation(api.panels.assetFolders.move, {
            workspaceId: ws,
            assetIds: [foreign],
            folderId: folder,
          }),
        )
      ).code,
    ).toBe("NOT_FOUND");
    expect(
      (
        await errorData(
          owner.as.mutation(api.panels.assetFolders.create, { workspaceId: ws, name: "   " }),
        )
      ).code,
    ).toBe("INVALID_ARGUMENT");
    expect(
      (
        await errorData(
          owner.as.mutation(api.panels.assetFolders.create, {
            workspaceId: ws,
            name: "x".repeat(61),
          }),
        )
      ).code,
    ).toBe("INVALID_ARGUMENT");
  });

  test("workspace cleanup removes folders and items", async () => {
    const t = setupTest();
    const owner = await createUser(t);
    const ws = await workspaceOf(owner);
    const a = await insertAsset(t, ws, owner.userId, "a.png");
    const folder = await owner.as.mutation(api.panels.assetFolders.create, {
      workspaceId: ws,
      name: "F",
    });
    await owner.as.mutation(api.panels.assetFolders.move, {
      workspaceId: ws,
      assetIds: [a],
      folderId: folder,
    });
    expect(
      await t.mutation(internal.panels.assetFolders.workspaceCleanup, { workspaceId: ws }),
    ).toEqual({ done: true });
    const left = await t.run(async (ctx) => ({
      folders: (await ctx.db.query("assetFolders").collect()).length,
      items: (await ctx.db.query("assetFolderItems").collect()).length,
    }));
    expect(left).toEqual({ folders: 0, items: 0 });
  });
});

function jpeg(): Uint8Array {
  // SOI + APP0 JFIF + SOF0 (2 x 1) + EOI: enough for magic-byte and dimension sniffing.
  return new Uint8Array([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01,
    0x00, 0x01, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x01, 0x00, 0x02, 0x03, 0x01, 0x22,
    0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, 0xff, 0xd9,
  ]);
}

describe("stock photo use", () => {
  let fetched: string[];
  let stored: Map<string, Uint8Array>;
  beforeEach(() => {
    vi.stubEnv("DESYN_EDITION", "selfhost");
    vi.stubEnv("S3_BUCKET", "desyn");
    vi.stubEnv("S3_ENDPOINT", "http://s3.test");
    vi.stubEnv("S3_FORCE_PATH_STYLE", "true");
    vi.stubEnv("AWS_ACCESS_KEY_ID", "test-access-key");
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", "test-secret-key");
    vi.stubEnv("UNSPLASH_ACCESS_KEY", "test-unsplash-key");
    fetched = [];
    stored = new Map();
    vi.stubGlobal("fetch", async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      );
      fetched.push(`${(init.method ?? "GET").toUpperCase()} ${url.host}${url.pathname}`);
      if (url.host === "images.unsplash.com")
        return new Response(jpeg() as BodyInit, {
          status: 200,
          headers: { "content-type": "image/jpeg" },
        });
      if (url.host === "api.unsplash.com") return new Response("{}", { status: 200 });
      if (url.host === "s3.test") {
        const key = decodeURIComponent(url.pathname.replace(/^\/desyn\//, ""));
        if ((init.method ?? "GET").toUpperCase() === "PUT") {
          stored.set(key, new Uint8Array(await new Response(init.body as BodyInit).arrayBuffer()));
          return new Response(null, { status: 200 });
        }
        return new Response(null, { status: 404 });
      }
      throw new Error(`unexpected fetch to ${url.host}`);
    });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  const photo = {
    id: "unsplash:abc123",
    url: "https://images.unsplash.com/photo-abc?w=2400&q=85&fm=jpg&fit=max",
    description: "Golden hour over the sea",
    author: "Ada Lovelace",
    sourceUrl: "https://unsplash.com/photos/abc123",
    downloadLocation: "https://api.unsplash.com/photos/abc123/download",
  };

  test("copies the photo into the library with attribution and reports the download", async () => {
    const t = setupTest();
    const owner = await createUser(t);
    const ws = await workspaceOf(owner);
    const { asset } = await owner.as.action(api.panels.stock.use, { workspaceId: ws, photo });
    expect(asset).toMatchObject({
      status: "ready",
      kind: "image",
      mime: "image/jpeg",
      source: "stock",
    });
    expect(asset.attribution).toEqual({
      author: "Ada Lovelace",
      license: "Unsplash License",
      url: "https://unsplash.com/photos/abc123",
    });
    expect(asset.name).toContain("Golden hour over the sea");
    expect(stored.size).toBe(1);
    expect(fetched).toContain("GET api.unsplash.com/photos/abc123/download");
  });

  test("refuses other hosts, unknown ids, viewers and outsiders before fetching", async () => {
    const t = setupTest();
    const owner = await createUser(t);
    const ws = await workspaceOf(owner);
    const viewer = await memberWithRole(t, ws, "viewer");
    const outsider = await createUser(t);
    for (const url of [
      "https://evil.example/x.jpg",
      "http://images.unsplash.com/x",
      "https://images.unsplash.com:8443/x",
      "https://user:pw@images.unsplash.com/x",
      "https://images.pexels.com/x",
    ]) {
      expect(
        (
          await errorData(
            owner.as.action(api.panels.stock.use, { workspaceId: ws, photo: { ...photo, url } }),
          )
        ).code,
      ).toBe("INVALID_ARGUMENT");
    }
    expect(
      (
        await errorData(
          owner.as.action(api.panels.stock.use, {
            workspaceId: ws,
            photo: { ...photo, id: "flickr:1" },
          }),
        )
      ).code,
    ).toBe("INVALID_ARGUMENT");
    expect(
      (await errorData(viewer.as.action(api.panels.stock.use, { workspaceId: ws, photo }))).code,
    ).toBe("FORBIDDEN");
    expect(
      (await errorData(outsider.as.action(api.panels.stock.use, { workspaceId: ws, photo }))).code,
    ).toBe("NOT_FOUND");
    expect((await errorData(t.action(api.panels.stock.use, { workspaceId: ws, photo }))).code).toBe(
      "UNAUTHENTICATED",
    );
    expect(fetched.filter((f) => f.includes("unsplash.com"))).toEqual([]);
  });

  test("attribution links are kept only for the provider's own https pages", async () => {
    const t = setupTest();
    const owner = await createUser(t);
    const ws = await workspaceOf(owner);
    const { asset } = await owner.as.action(api.panels.stock.use, {
      workspaceId: ws,
      photo: { ...photo, sourceUrl: "javascript:alert(document.domain)" },
    });
    expect(asset.attribution).toEqual({ author: "Ada Lovelace", license: "Unsplash License" });
    expect(attributionUrl("unsplash", "https://unsplash.com/@ada?utm_source=desyn")).toBe(
      "https://unsplash.com/@ada?utm_source=desyn",
    );
    expect(attributionUrl("pexels", "https://www.pexels.com/photo/1/")).toBe(
      "https://www.pexels.com/photo/1/",
    );
    for (const bad of [
      "http://unsplash.com/photos/x",
      "https://unsplash.com.evil.example/x",
      "https://evil.example/?unsplash.com",
      "https://user:pw@unsplash.com/x",
      "data:text/html,hi",
      "not a url",
    ]) {
      expect(attributionUrl("unsplash", bad)).toBeUndefined();
    }
    expect(attributionUrl("pexels", "https://unsplash.com/photos/x")).toBeUndefined();
  });

  test("an oversized download is refused while streaming, even without a content-length", async () => {
    const t = setupTest();
    const owner = await createUser(t);
    const ws = await workspaceOf(owner);
    const chunk = new Uint8Array(1024 * 1024);
    chunk.set(jpeg());
    let sent = 0;
    vi.stubGlobal("fetch", async (input: string | URL | Request) => {
      const url = new URL(
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      );
      if (url.host !== "images.unsplash.com") throw new Error(`unexpected fetch to ${url.host}`);
      // 64 MB announced by nobody: the body just keeps coming.
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent >= 64) return controller.close();
          sent++;
          controller.enqueue(chunk);
        },
      });
      return new Response(body, { status: 200 });
    });
    expect(
      (await errorData(owner.as.action(api.panels.stock.use, { workspaceId: ws, photo }))).code,
    ).toBe("INVALID_ARGUMENT");
    // Reading stopped right after the 30 MB cap instead of buffering the whole body.
    expect(sent).toBeLessThanOrEqual(32);
    expect(stored.size).toBe(0);
  });

  test("provider ids and CDN URLs", () => {
    expect(providerOf("unsplash:Ab_9-x")).toBe("unsplash");
    expect(providerOf("pexels:123")).toBe("pexels");
    expect(providerOf("pexels:12a")).toBeNull();
    expect(
      checkPhotoUrl("pexels", "https://images.pexels.com/photos/1/a.jpeg?auto=compress").hostname,
    ).toBe("images.pexels.com");
  });
});
