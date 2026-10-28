import { createRect, createText, type Design, type TextNode } from "@desyn/schema";
import {
  ApplyBrandResultSchema,
  AssetListSchema,
  AssetSchema,
  BrandKitListSchema,
  BrandKitSchema,
  DescriptionSchema,
  ExportSchema,
  InstantiatedSchema,
  type Schema,
  TemplateDetailSchema,
  TemplateListSchema,
  UploadTicketSchema,
  validate,
} from "@desyn/sdk/contract";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  apiUser,
  call,
  FakeS3,
  fakeWorker,
  NETWORK_ENV,
  png,
  publishTemplate,
  stubNetwork,
} from "./api.helpers";
import { setupTest } from "./harness.helpers";

function expectSchema(schema: Schema, value: unknown) {
  const result = validate(schema, value);
  if (!result.success)
    throw new Error(`response does not match the contract: ${JSON.stringify(result.issues)}`);
}

let net: ReturnType<typeof stubNetwork>;

beforeEach(() => {
  vi.stubEnv("DESYN_EDITION", "selfhost");
  vi.stubEnv("MAIL_TRANSPORT", "log");
  for (const [k, v] of Object.entries(NETWORK_ENV)) vi.stubEnv(k, v);
  net = stubNetwork(fakeWorker(), new FakeS3());
  vi.stubGlobal("fetch", net.fetch);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function newDesign(t: ReturnType<typeof setupTest>, key: string) {
  const res = await call(t, "POST", "designs", {
    key,
    body: { name: "Launch", width: 1000, height: 500 },
  });
  expect(res.status).toBe(201);
  return res.json as { id: string; firstPageId: string; seq: number };
}

describe("describe and preview (render worker)", () => {
  test("describe sends the assembled design and returns the Description", async () => {
    const t = setupTest();
    const u = await apiUser(t);
    const d = await newDesign(t, u.key);
    const rect = createRect({ parent: d.firstPageId });
    await call(t, "POST", `designs/${d.id}/transactions`, {
      key: u.key,
      body: { tx: { ops: [{ op: "create", parent: d.firstPageId, nodes: [rect] }] } },
    });
    const res = await call(
      t,
      "GET",
      `designs/${d.id}/describe?selection=${rect.id},${d.firstPageId}&maxDepth=3`,
      { key: u.key },
    );
    expect(res.status).toBe(200);
    expectSchema(DescriptionSchema, res.json);
    expect(res.headers.get("x-desyn-seq")).toBe(String(d.seq + 1));
    const sent = net.worker.calls.at(-1);
    expect(sent?.path).toBe("/v1/describe");
    expect(sent?.secret).toBe("worker-secret");
    expect(sent?.body.pageId).toBe(d.firstPageId);
    expect(sent?.body.selection).toEqual([rect.id, d.firstPageId]);
    expect(sent?.body.maxDepth).toBe(3);
    expect(sent?.body.design.nodes[rect.id]).toBeDefined();
  });

  test("preview returns image bytes, caps the size and validates the page", async () => {
    const t = setupTest();
    const u = await apiUser(t);
    const d = await newDesign(t, u.key);
    const res = await call(t, "POST", `designs/${d.id}/preview`, {
      key: u.key,
      body: { format: "webp", maxSize: 500 },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/webp");
    expect(res.headers.get("x-desyn-page")).toBe(d.firstPageId);
    // 1000 px wide page capped to 500 px: scale 0.5.
    expect(await res.res.text()).toBe(`webp:${d.firstPageId}:0.5`);
    const region = await call(t, "POST", `designs/${d.id}/preview`, {
      key: u.key,
      body: { region: { x: 0, y: 0, w: 100, h: 100 }, scale: 2 },
    });
    expect(await region.res.text()).toBe(`png:${d.firstPageId}:2`);
    expect(net.worker.calls.at(-1)?.body.region).toEqual({ x: 0, y: 0, w: 100, h: 100 });

    const missing = await call(t, "POST", `designs/${d.id}/preview`, {
      key: u.key,
      body: { pageId: "zzzzzzzzzzzz" },
    });
    expect(missing.status).toBe(404);
    const badScale = await call(t, "POST", `designs/${d.id}/preview`, {
      key: u.key,
      body: { scale: 50 },
    });
    expect(badScale.status).toBe(400);
  });

  test("worker failures map to 503 and a missing worker to 501", async () => {
    const t = setupTest();
    const u = await apiUser(t);
    const d = await newDesign(t, u.key);
    vi.stubGlobal("fetch", stubNetwork(fakeWorker({ status: 502 })).fetch);
    const down = await call(t, "POST", `designs/${d.id}/preview`, { key: u.key, body: {} });
    expect(down.status).toBe(503);
    expect(down.json.error.code).toBe("UPSTREAM_UNAVAILABLE");
    expect(down.headers.get("retry-after")).toBe("5");
    vi.stubEnv("RENDER_WORKER_URL", "");
    const missing = await call(t, "GET", `designs/${d.id}/describe`, { key: u.key });
    expect(missing.status).toBe(501);
    expect(missing.json.error.code).toBe("NOT_CONFIGURED");
  });
});

describe("exports", () => {
  test("request (202), status, and isolation", async () => {
    const t = setupTest();
    const u = await apiUser(t);
    const other = await apiUser(t);
    const d = await newDesign(t, u.key);
    const res = await call(t, "POST", `designs/${d.id}/exports`, {
      key: u.key,
      body: { format: "png", scale: 2 },
    });
    expect(res.status).toBe(202);
    expectSchema(ExportSchema, res.json);
    expect(res.json).toMatchObject({ designId: d.id, format: "png", scale: 2, pages: "all" });
    const status = await call(t, "GET", `exports/${res.json.id}`, { key: u.key });
    expectSchema(ExportSchema, status.json);
    expect((await call(t, "GET", `exports/${res.json.id}`, { key: other.key })).status).toBe(404);
    const bad = await call(t, "POST", `designs/${d.id}/exports`, {
      key: u.key,
      body: { format: "bmp" },
    });
    expect(bad.status).toBe(400);
    const pages = await call(t, "POST", `designs/${d.id}/exports`, {
      key: u.key,
      body: { format: "pdf", pages: ["nope"] },
    });
    expect(pages.status).toBe(400);
  });
});

describe("assets", () => {
  test("presigned upload, finalize, list, get, rename, dedupe and delete", async () => {
    const t = setupTest();
    const u = await apiUser(t);
    const bytes = png(64, 32);
    const ticket = await call(t, "POST", "assets/uploads", {
      key: u.key,
      body: { name: "hero.png", mime: "image/png", bytes: bytes.length },
    });
    expect(ticket.status).toBe(201);
    expectSchema(UploadTicketSchema, ticket.json);
    const put = await net.fetch(ticket.json.upload.url, {
      method: "PUT",
      headers: ticket.json.upload.headers,
      body: bytes as BodyInit,
    });
    expect(put.status).toBe(200);
    const done = await call(t, "POST", `assets/${ticket.json.assetId}/finalize`, {
      key: u.key,
      body: {},
    });
    expect(done.status).toBe(200);
    expectSchema(AssetSchema, done.json);
    expect(done.json).toMatchObject({ status: "ready", width: 64, height: 32, kind: "image" });
    expect(done.json.assetRef).toMatchObject({
      id: done.json.refId,
      kind: "image",
      mime: "image/png",
      width: 64,
    });
    expect(done.json.url).toContain("X-Amz-Signature");

    const list = await call(t, "GET", "assets?kind=image", { key: u.key });
    expectSchema(AssetListSchema, list.json);
    expect(list.json.items.map((a: { id: string }) => a.id)).toEqual([done.json.id]);

    const renamed = await call(t, "PATCH", `assets/${done.json.id}`, {
      key: u.key,
      body: { name: "Hero" },
    });
    expect(renamed.json.name).toBe("Hero");

    const digest = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource)),
    )
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    const again = await call(t, "POST", "assets/uploads", {
      key: u.key,
      body: { name: "copy.png", mime: "image/png", bytes: bytes.length, sha256: digest },
    });
    expect(again.json).toMatchObject({ deduplicated: true, assetId: done.json.id, upload: null });

    const other = await apiUser(t);
    expect((await call(t, "GET", `assets/${done.json.id}`, { key: other.key })).status).toBe(404);
    expect((await call(t, "DELETE", `assets/${done.json.id}`, { key: u.key })).json).toEqual({
      deleted: true,
    });
    expect((await call(t, "GET", `assets/${done.json.id}`, { key: u.key })).status).toBe(404);
  });

  test("finalize rejects mismatching uploads", async () => {
    const t = setupTest();
    const u = await apiUser(t);
    const ticket = await call(t, "POST", "assets/uploads", {
      key: u.key,
      body: { name: "fake.png", mime: "image/png", bytes: 33 },
    });
    await net.fetch(ticket.json.upload.url, {
      method: "PUT",
      headers: ticket.json.upload.headers,
      body: new Uint8Array(33).fill(7) as BodyInit,
    });
    const res = await call(t, "POST", `assets/${ticket.json.assetId}/finalize`, {
      key: u.key,
      body: {},
    });
    expect(res.status).toBe(400);
    expect(res.json.error.code).toBe("INVALID_ARGUMENT");
  });
});

describe("templates", () => {
  test("search, get with slots, instantiate with text + image slots", async () => {
    const t = setupTest();
    const u = await apiUser(t);
    await publishTemplate(t, "bakery-menu");
    const search = await call(t, "GET", "templates?q=croissants", { key: u.key });
    expectSchema(TemplateListSchema, search.json);
    expect(search.json.items.map((x: { slug: string }) => x.slug)).toEqual(["bakery-menu"]);
    const browse = await call(t, "GET", "templates?kind=menu&limit=5", { key: u.key });
    expect(browse.json.items).toHaveLength(1);

    const detail = await call(t, "GET", "templates/bakery-menu", { key: u.key });
    expectSchema(TemplateDetailSchema, detail.json);
    expect(detail.json.slots.map((s: { slot: string; type: string }) => [s.slot, s.type])).toEqual([
      ["headline", "text"],
      ["photo", "image"],
    ]);
    expect((await call(t, "GET", `templates/${detail.json.id}`, { key: u.key })).json.slug).toBe(
      "bakery-menu",
    );
    expect((await call(t, "GET", "templates/missing", { key: u.key })).status).toBe(404);

    // Upload an image for the photo slot.
    const bytes = png(10, 10);
    const ticket = await call(t, "POST", "assets/uploads", {
      key: u.key,
      body: { name: "photo.png", mime: "image/png", bytes: bytes.length },
    });
    await net.fetch(ticket.json.upload.url, {
      method: "PUT",
      headers: ticket.json.upload.headers,
      body: bytes as BodyInit,
    });
    const asset = await call(t, "POST", `assets/${ticket.json.assetId}/finalize`, {
      key: u.key,
      body: {},
    });

    const made = await call(t, "POST", "templates/bakery-menu/instantiate", {
      key: u.key,
      body: {
        name: "Autumn menu",
        slots: { headline: "Autumn menu", photo: asset.json.refId, nope: "x" },
      },
    });
    expect(made.status).toBe(201);
    expectSchema(InstantiatedSchema, made.json);
    expect(made.json).toMatchObject({
      name: "Autumn menu",
      filledSlots: ["headline", "photo"],
      unknownSlots: ["nope"],
      brandApplied: false,
    });
    const doc = await call(t, "GET", `designs/${made.json.id}/document`, { key: u.key });
    const design = doc.json.design as Design;
    const nodes = Object.values(design.nodes);
    const headline = nodes.find((n) => n.meta?.slot === "headline") as TextNode;
    expect(headline.runs.map((r) => r.text).join("")).toBe("Autumn menu");
    const photo = nodes.find((n) => n.meta?.slot === "photo") as { assetId: string };
    expect(photo.assetId).toBe(asset.json.refId);
    expect(design.assets[asset.json.refId]?.storageKey).toBeTruthy();

    const badSlot = await call(t, "POST", "templates/bakery-menu/instantiate", {
      key: u.key,
      body: { slots: { photo: "zzzzzzzzzzzz" } },
    });
    expect(badSlot.status).toBe(400);

    // An unknown brand kit fails before anything is created (no orphan design behind the error).
    const before = (await call(t, "GET", "designs?limit=100", { key: u.key })).json.items.length;
    const badKit = await call(t, "POST", "templates/bakery-menu/instantiate", {
      key: u.key,
      body: { name: "Kitless", brandKitId: "missingkit123" },
    });
    expect(badKit.status).toBe(404);
    expect(badKit.json.error.code).toBe("NOT_FOUND");
    expect((await call(t, "GET", "designs?limit=100", { key: u.key })).json.items.length).toBe(
      before,
    );
  });
});

describe("brand kits", () => {
  test("create, list, get, update, apply to a design, delete", async () => {
    const t = setupTest();
    const u = await apiUser(t);
    const created = await call(t, "POST", "brand-kits", {
      key: u.key,
      body: {
        name: "Sunline",
        colors: [
          { name: "Ember", value: "#ff6a1f", role: "primary" },
          { name: "Cream", value: "#f6efe3", role: "background" },
          { name: "Ink", value: "#1d1a16", role: "text" },
        ],
        fonts: {
          heading: { family: "Instrument Serif", weight: 400, style: "normal" },
          body: { family: "Instrument Sans", weight: 400, style: "normal" },
        },
        voice: { tone: "Warm", description: "Unhurried", keywords: ["slow"], avoid: ["hype"] },
        rules: ["Never shout"],
      },
    });
    expect(created.status).toBe(201);
    expectSchema(BrandKitSchema, created.json);
    expect(created.json).toMatchObject({ name: "Sunline", isDefault: true });
    const list = await call(t, "GET", "brand-kits", { key: u.key });
    expectSchema(BrandKitListSchema, list.json);
    const updated = await call(t, "PATCH", `brand-kits/${created.json.id}`, {
      key: u.key,
      body: { name: "Sunline Coffee", guidelines: "Use lots of space." },
    });
    expect(updated.json).toMatchObject({
      name: "Sunline Coffee",
      guidelines: "Use lots of space.",
    });
    const badColor = await call(t, "POST", "brand-kits", {
      key: u.key,
      body: { name: "Bad", colors: [{ name: "x", value: "red" }] },
    });
    expect(badColor.status).toBe(400);

    const d = await newDesign(t, u.key);
    const bg = createRect({
      parent: d.firstPageId,
      width: 1000,
      height: 500,
      role: "background",
      fills: [{ type: "solid", color: "#ffffff" }],
    });
    const title = createText({ parent: d.firstPageId, text: "Hello", role: "headline" });
    await call(t, "POST", `designs/${d.id}/transactions`, {
      key: u.key,
      body: {
        tx: {
          ops: [
            { op: "create", parent: d.firstPageId, nodes: [bg] },
            { op: "create", parent: d.firstPageId, nodes: [title] },
          ],
        },
      },
    });
    const applied = await call(t, "POST", `designs/${d.id}/apply-brand`, { key: u.key, body: {} });
    expect(applied.status).toBe(200);
    expectSchema(ApplyBrandResultSchema, applied.json);
    expect(applied.json.brandKitId).toBe(created.json.id);
    expect(applied.json.commit?.seq).toBeGreaterThan(d.seq);
    const doc = await call(t, "GET", `designs/${d.id}/document`, { key: u.key });
    const design = doc.json.design as Design;
    expect(design.brandKitId).toBe(created.json.id);
    expect((design.nodes[title.id] as TextNode).style.fontFamily).toBe("Instrument Serif");

    expect((await call(t, "DELETE", `brand-kits/${created.json.id}`, { key: u.key })).json).toEqual(
      { deleted: true },
    );
    expect((await call(t, "GET", `brand-kits/${created.json.id}`, { key: u.key })).status).toBe(
      404,
    );
    const none = await call(t, "POST", `designs/${d.id}/apply-brand`, { key: u.key, body: {} });
    expect(none.status).toBe(404);
  });
});
