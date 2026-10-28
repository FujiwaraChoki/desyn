import betterAuthTest from "@convex-dev/better-auth/test";
import rateLimiterTest from "@convex-dev/rate-limiter/test";
import { createDesign, createImage, createText, type Design } from "@desyn/schema";
import { convexTest } from "convex-test";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import { workspaceOf } from "./designs.helpers";
import { createUser, modules, type TestConvex, type TestUser } from "./harness.helpers";

// Helpers for the Agent API suites (api.*.test.ts): API keys, HTTP calls through t.fetch, a fake render
// worker and an in-memory S3, both behind a stubbed global fetch.

/** convex-test with a scripted AI backend registered as module "ai/api" (see api.aiFake.helpers.ts). */
export function setupWithAi(): TestConvex {
  const t = convexTest(schema, {
    ...modules,
    "../ai/api.ts": () => import("./api.aiFake.helpers"),
  });
  betterAuthTest.register(t, "betterAuth");
  rateLimiterTest.register(t, "rateLimiter");
  return t;
}

export const ALL_SCOPES = [
  "designs:read",
  "designs:write",
  "assets:read",
  "assets:write",
  "templates:read",
  "brand:read",
  "brand:write",
  "ai:run",
  "exports:write",
  "mcp",
] as const;
type Scope = (typeof ALL_SCOPES)[number];

export interface ApiUser extends TestUser {
  workspaceId: Id<"workspaces">;
  key: string;
  keyId: Id<"apiKeys">;
}

export async function apiUser(
  t: TestConvex,
  opts: { scopes?: readonly Scope[]; email?: string } = {},
): Promise<ApiUser> {
  const user = await createUser(t, opts.email ? { email: opts.email } : {});
  const workspaceId = await workspaceOf(user);
  const created = await user.as.mutation(api.accounts.apiKeys.create, {
    workspaceId,
    name: "agent",
    scopes: [...(opts.scopes ?? ALL_SCOPES)],
  });
  return { ...user, workspaceId, key: created.secret, keyId: created.id };
}

export async function keyFor(
  user: TestUser,
  workspaceId: Id<"workspaces">,
  scopes: readonly Scope[] = ALL_SCOPES,
): Promise<string> {
  const created = await user.as.mutation(api.accounts.apiKeys.create, {
    workspaceId,
    name: "agent",
    scopes: [...scopes],
  });
  return created.secret;
}

export interface CallOptions {
  key?: string | null;
  body?: unknown;
  headers?: Record<string, string>;
}

export async function call(
  t: TestConvex,
  method: string,
  path: string,
  opts: CallOptions = {},
  // biome-ignore lint/suspicious/noExplicitAny: test responses are checked against contract schemas
): Promise<{ status: number; headers: Headers; json: any; res: Response }> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.key) headers.authorization = `Bearer ${opts.key}`;
  let body: string | undefined;
  if (opts.body !== undefined) {
    headers["content-type"] = headers["content-type"] ?? "application/json";
    body = typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body);
  }
  const res = await t.fetch(path.startsWith("/") ? path : `/api/v1/${path}`, {
    method,
    headers,
    ...(body !== undefined ? { body } : {}),
  });
  const type = res.headers.get("content-type") ?? "";
  // biome-ignore lint/suspicious/noExplicitAny: test responses are checked against contract schemas
  let json: any = null;
  if (type.includes("json")) json = await res.clone().json();
  return { status: res.status, headers: res.headers, json, res };
}

/** Grant a user a membership in a workspace with a role. */
export async function addMember(
  t: TestConvex,
  workspaceId: Id<"workspaces">,
  userId: string,
  role: "admin" | "editor" | "commenter" | "viewer",
): Promise<void> {
  await t.run(async (ctx) => {
    const now = Date.now();
    await ctx.db.insert("memberships", {
      workspaceId,
      userId,
      role,
      createdAt: now,
      updatedAt: now,
    });
  });
}

// --- fake render worker ---------------------------------------------------------------------------------------

export interface WorkerCall {
  path: string;
  secret: string | null;
  body: Record<string, unknown> & { design: Design; pageId?: string; scale?: number };
}

export function fakeWorker(opts: { status?: number } = {}) {
  const calls: WorkerCall[] = [];
  const handle = async (url: URL, init: RequestInit): Promise<Response> => {
    const headers = new Headers(init.headers);
    const raw =
      typeof init.body === "string" ? init.body : new TextDecoder().decode(init.body as Uint8Array);
    const body = JSON.parse(raw) as WorkerCall["body"];
    calls.push({ path: url.pathname, secret: headers.get("x-desyn-secret"), body });
    if (opts.status) return new Response("worker failure", { status: opts.status });
    if (url.pathname === "/v1/describe") {
      const page = body.design.nodes[body.pageId as string] as { width: number; height: number };
      return Response.json({
        design: {
          id: body.design.id,
          name: body.design.name,
          kind: body.design.kind,
          pageCount: 1,
        },
        page: {
          id: body.pageId,
          index: 0,
          width: page.width,
          height: page.height,
          unit: "px",
          background: "solid #ffffff",
        },
        selection: (body.selection as string[] | undefined) ?? [],
        tree: [],
        palette: [{ color: "#ffffff", share: 1 }],
        fonts: [],
        typography: { scale: [] },
        grid: { margins: { t: 0, r: 0, b: 0, l: 0 }, alignments: [] },
        hierarchy: [],
        issues: [],
      });
    }
    const format = (body.format as string | undefined) ?? "png";
    return new Response(
      new TextEncoder().encode(`${format}:${body.pageId}:${body.scale}`) as BodyInit,
      {
        status: 200,
        headers: { "content-type": `image/${format}` },
      },
    );
  };
  return { calls, handle };
}

// --- in-memory S3 ---------------------------------------------------------------------------------------------

export class FakeS3 {
  objects = new Map<string, { body: Uint8Array; type: string }>();

  async handle(url: URL, init: RequestInit): Promise<Response> {
    const key = decodeURIComponent(url.pathname.replace(/^\/desyn\//, ""));
    const method = (init.method ?? "GET").toUpperCase();
    const headers = new Headers(init.headers);
    const signed =
      url.searchParams.has("X-Amz-Signature") ||
      (headers.get("authorization") ?? "").startsWith("AWS4-HMAC-SHA256");
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
  }
}

/** A global fetch that serves the fake worker (worker.test) and S3 (s3.test). */
export function stubNetwork(worker = fakeWorker(), s3 = new FakeS3()) {
  const fetchImpl = async (input: string | URL | Request, init: RequestInit = {}) => {
    const req = input instanceof Request ? input : null;
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    const merged: RequestInit = req
      ? {
          method: req.method,
          headers: req.headers,
          body: req.body ? await req.arrayBuffer() : undefined,
          ...init,
        }
      : init;
    if (url.host === "worker.test") return await worker.handle(url, merged);
    if (url.host === "s3.test") return await s3.handle(url, merged);
    throw new Error(`unexpected fetch to ${url.href}`);
  };
  return { worker, s3, fetch: fetchImpl };
}

export const NETWORK_ENV = {
  RENDER_WORKER_URL: "http://worker.test",
  RENDER_WORKER_SECRET: "worker-secret",
  S3_BUCKET: "desyn",
  S3_ENDPOINT: "http://s3.test",
  S3_FORCE_PATH_STYLE: "true",
  AWS_ACCESS_KEY_ID: "test-access-key",
  AWS_SECRET_ACCESS_KEY: "test-secret-key",
};

export function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  bytes.set([8, 6, 0, 0, 0], 24);
  return bytes;
}

/** Publish a template with a text slot "headline" and an image slot "photo". */
export async function publishTemplate(
  t: TestConvex,
  slug: string,
  opts: { premium?: boolean } = {},
) {
  const design = createDesign("menu", undefined, { name: "Bakery menu" });
  const pageId = (design.nodes.root as { children: string[] }).children[0] as string;
  const text = createText({
    parent: pageId,
    text: "Fresh croissants daily",
    role: "headline",
    meta: { slot: "headline" },
  });
  const image = createImage({
    parent: pageId,
    assetId: "photo0000000",
    role: "photo",
    meta: { slot: "photo" },
  });
  design.nodes[text.id] = text;
  design.nodes[image.id] = image;
  (design.nodes[pageId] as { children: string[] }).children.push(text.id, image.id);
  design.assets.photo0000000 = {
    id: "photo0000000",
    kind: "image",
    mime: "image/png",
    source: "template",
  };
  return await t.mutation(internal.templates.admin.upsert, {
    slug,
    title: slug.replace(/-/g, " "),
    description: "Warm and minimal",
    kind: "menu",
    category: "food",
    categories: ["restaurant"],
    tags: ["bakery", "pastry"],
    premium: opts.premium ?? false,
    collections: [],
    design: JSON.stringify(design),
    thumbnails: [],
  });
}
