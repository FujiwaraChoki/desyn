import type { Design, TextNode } from "@desyn/schema";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { apiUser, call, fakeWorker, NETWORK_ENV, stubNetwork } from "./api.helpers";
import { setupTest } from "./harness.helpers";

// The MCP endpoint (/mcp, Streamable HTTP, stateless) end to end through the Convex HTTP router.

let net: ReturnType<typeof stubNetwork>;

beforeEach(() => {
  vi.stubEnv("DESYN_EDITION", "selfhost");
  vi.stubEnv("MAIL_TRANSPORT", "log");
  vi.stubEnv("APP_URL", "https://app.desyn.test");
  for (const [k, v] of Object.entries(NETWORK_ENV)) vi.stubEnv(k, v);
  net = stubNetwork(fakeWorker());
  vi.stubGlobal("fetch", net.fetch);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

let nextId = 1;
async function rpc(
  t: ReturnType<typeof setupTest>,
  key: string | null,
  method: string,
  params?: Record<string, unknown>,
  headers: Record<string, string> = {},
) {
  return await call(t, "POST", "/mcp", {
    key,
    body: { jsonrpc: "2.0", id: nextId++, method, ...(params ? { params } : {}) },
    headers: { accept: "application/json, text/event-stream", ...headers },
  });
}

async function tool(
  t: ReturnType<typeof setupTest>,
  key: string,
  name: string,
  args: Record<string, unknown>,
) {
  const res = await rpc(t, key, "tools/call", { name, arguments: args });
  expect(res.status).toBe(200);
  return res.json.result as {
    content: { type: string; text?: string; data?: string; mimeType?: string }[];
    structuredContent?: Record<string, unknown>;
    isError?: boolean;
  };
}

describe("MCP over Streamable HTTP", () => {
  test("lifecycle: initialize negotiates the version, initialized is accepted, ping answers", async () => {
    const t = setupTest();
    const u = await apiUser(t);
    const init = await rpc(t, u.key, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    });
    expect(init.status).toBe(200);
    expect(init.json.result).toMatchObject({
      protocolVersion: "2025-06-18",
      serverInfo: { name: "desyn" },
      capabilities: { tools: {}, resources: {} },
    });
    expect(init.json.result.instructions).toContain("describe_design");
    const future = await rpc(t, u.key, "initialize", {
      protocolVersion: "2099-01-01",
      capabilities: {},
    });
    expect(future.json.result.protocolVersion).toBe("2025-11-25");

    const note = await call(t, "POST", "/mcp", {
      key: u.key,
      body: { jsonrpc: "2.0", method: "notifications/initialized" },
    });
    expect(note.status).toBe(202);
    expect((await rpc(t, u.key, "ping")).json.result).toEqual({});
    const unknown = await rpc(t, u.key, "prompts/list");
    expect(unknown.json.error.code).toBe(-32601);
    const badVersion = await rpc(t, u.key, "ping", undefined, {
      "mcp-protocol-version": "1999-01-01",
    });
    expect(badVersion.status).toBe(400);
  });

  test("transport: auth, scope, plan, GET/DELETE, origin, parse errors and batches", async () => {
    const t = setupTest();
    const u = await apiUser(t);
    const noKey = await rpc(t, null, "ping");
    expect(noKey.status).toBe(401);
    expect(noKey.headers.get("www-authenticate")).toContain("Bearer");
    const restOnly = await apiUser(t, { scopes: ["designs:read"] });
    const scoped = await rpc(t, restOnly.key, "ping");
    expect(scoped.status).toBe(403);
    expect(scoped.json.error.code).toBe("INSUFFICIENT_SCOPE");

    expect((await call(t, "GET", "/mcp", { key: u.key })).status).toBe(405);
    expect((await call(t, "DELETE", "/mcp", { key: u.key })).status).toBe(405);
    const evil = await rpc(t, u.key, "ping", undefined, { origin: "https://evil.example" });
    expect(evil.status).toBe(403);
    // The Origin is checked before the key: a foreign page cannot probe keys or drain a key's bucket.
    const evilNoKey = await rpc(t, null, "ping", undefined, { origin: "https://evil.example" });
    expect(evilNoKey.status).toBe(403);
    expect(evilNoKey.json.error.code).toBe("FORBIDDEN");
    const app = await rpc(t, u.key, "ping", undefined, { origin: "https://app.desyn.test" });
    expect(app.status).toBe(200);

    const parse = await call(t, "POST", "/mcp", { key: u.key, body: "{not json" });
    expect(parse.json.error.code).toBe(-32700);
    const batch = await call(t, "POST", "/mcp", {
      key: u.key,
      body: [
        { jsonrpc: "2.0", id: "a", method: "ping" },
        { jsonrpc: "2.0", method: "notifications/initialized" },
        { jsonrpc: "2.0", id: "b", method: "tools/list" },
      ],
    });
    expect(batch.json.map((r: { id: string }) => r.id)).toEqual(["a", "b"]);
    const invalid = await call(t, "POST", "/mcp", { key: u.key, body: { jsonrpc: "2.0", id: 1 } });
    expect(invalid.json.error.code).toBe(-32600);

    vi.stubEnv("DESYN_EDITION", "hosted");
    const hosted = await rpc(t, u.key, "ping");
    expect(hosted.status).toBe(403);
    expect(hosted.json.error.feature).toBe("agentApi");
  });

  test("tools/list publishes object input schemas and annotations; local tools stay hidden", async () => {
    const t = setupTest();
    const u = await apiUser(t);
    const res = await rpc(t, u.key, "tools/list");
    const tools = res.json.result.tools as {
      name: string;
      inputSchema: { type: string };
      annotations: object;
    }[];
    const names = tools.map((x) => x.name);
    for (const name of [
      "list_designs",
      "create_design",
      "describe_design",
      "apply_operations",
      "render_preview",
      "export_design",
      "search_templates",
      "apply_brand",
    ]) {
      expect(names).toContain(name);
    }
    expect(names).not.toContain("upload_file");
    for (const x of tools) expect(x.inputSchema.type).toBe("object");
    expect(tools.find((x) => x.name === "list_designs")?.annotations).toMatchObject({
      readOnlyHint: true,
    });
  });

  test("tools: create, edit with friendly nodes, describe, preview image, list, errors", async () => {
    const t = setupTest();
    const u = await apiUser(t);
    const created = await tool(t, u.key, "create_design", {
      name: "Poster",
      width: 800,
      height: 1200,
    });
    expect(created.isError).toBeFalsy();
    const design = created.structuredContent as { id: string; firstPageId: string };

    const edit = await tool(t, u.key, "apply_operations", {
      designId: design.id,
      label: "Add a card",
      ops: [
        {
          op: "create",
          parent: design.firstPageId,
          node: {
            type: "frame",
            name: "Card",
            x: 40,
            y: 40,
            width: 400,
            height: 300,
            fill: "#1d1a16",
            children: [
              { type: "text", text: "Hello", fontSize: 48, color: "#ffb02e", role: "headline" },
            ],
          },
        },
      ],
    });
    expect(edit.isError).toBeFalsy();
    expect(edit.content[0]?.text).toContain("Committed seq");
    const createdIds = (edit.structuredContent as { createdIds: string[] }).createdIds;
    expect(createdIds).toHaveLength(1);

    const doc = await call(t, "GET", `designs/${design.id}/document`, { key: u.key });
    const d = doc.json.design as Design;
    const card = d.nodes[createdIds[0] as string] as { children: string[]; fills: unknown[] };
    expect(card.fills).toEqual([{ type: "solid", color: "#1d1a16" }]);
    const text = d.nodes[card.children[0] as string] as TextNode;
    expect(text.runs[0]?.text).toBe("Hello");
    expect(text.style).toMatchObject({
      fontSize: 48,
      fills: [{ type: "solid", color: "#ffb02e" }],
    });
    const history = await call(t, "GET", `designs/${design.id}/transactions?since=0`, {
      key: u.key,
    });
    expect(history.json.items.at(-1).tx).toMatchObject({
      label: "Add a card",
      source: "ai",
      actor: { agent: "mcp" },
    });

    const described = await tool(t, u.key, "describe_design", { designId: design.id });
    expect(described.structuredContent).toMatchObject({ page: { id: design.firstPageId } });

    const preview = await tool(t, u.key, "render_preview", { designId: design.id });
    expect(preview.content[0]).toMatchObject({ type: "image", mimeType: "image/png" });
    expect(atob(preview.content[0]?.data ?? "")).toBe(`png:${design.firstPageId}:0.8533`);

    const listed = await tool(t, u.key, "list_designs", { search: "Poster" });
    expect((listed.structuredContent as { items: { id: string }[] }).items[0]?.id).toBe(design.id);

    const badArgs = await tool(t, u.key, "apply_operations", { designId: design.id, ops: [] });
    expect(badArgs.isError).toBe(true);
    const badNode = await tool(t, u.key, "apply_operations", {
      designId: design.id,
      ops: [{ op: "create", parent: design.firstPageId, node: { type: "image" } }],
    });
    expect(badNode.isError).toBe(true);
    expect(badNode.content[0]?.text).toContain("assetId");
    const missing = await tool(t, u.key, "get_document", { designId: "nope" });
    expect(missing.isError).toBe(true);
    expect(missing.content[0]?.text).toContain("NOT_FOUND");
    const unknownTool = await rpc(t, u.key, "tools/call", { name: "fly", arguments: {} });
    expect(unknownTool.json.error.code).toBe(-32602);

    // Tool calls are bound by the key's REST scopes.
    const reader = await apiUser(t, { scopes: ["mcp", "designs:read"] });
    const denied = await tool(t, reader.key, "create_design", { name: "x" });
    expect(denied.isError).toBe(true);
    expect(denied.content[0]?.text).toContain("INSUFFICIENT_SCOPE");
  });

  test("resources: list, templates, read document / description / preview / schemas", async () => {
    const t = setupTest();
    const u = await apiUser(t);
    const created = await tool(t, u.key, "create_design", { name: "Card" });
    const id = (created.structuredContent as { id: string }).id;
    const list = await rpc(t, u.key, "resources/list");
    const uris = list.json.result.resources.map((r: { uri: string }) => r.uri);
    expect(uris).toContain(`desyn://designs/${id}`);
    expect(uris).toContain("desyn://schema/op");
    const templates = await rpc(t, u.key, "resources/templates/list");
    expect(templates.json.result.resourceTemplates).toHaveLength(3);

    const doc = await rpc(t, u.key, "resources/read", { uri: `desyn://designs/${id}` });
    expect(JSON.parse(doc.json.result.contents[0].text).design.name).toBe("Card");
    const desc = await rpc(t, u.key, "resources/read", {
      uri: `desyn://designs/${id}/description`,
    });
    expect(JSON.parse(desc.json.result.contents[0].text).palette).toBeDefined();
    const img = await rpc(t, u.key, "resources/read", { uri: `desyn://designs/${id}/preview.png` });
    expect(img.json.result.contents[0]).toMatchObject({ mimeType: "image/png" });
    expect(img.json.result.contents[0].blob).toBeTypeOf("string");
    const schema = await rpc(t, u.key, "resources/read", { uri: "desyn://schema/op" });
    expect(JSON.parse(schema.json.result.contents[0].text)).toHaveProperty("$schema");
    const nope = await rpc(t, u.key, "resources/read", { uri: "desyn://designs/missing" });
    expect(nope.json.error.code).toBe(-32002);
    const bad = await rpc(t, u.key, "resources/read", { uri: "https://example.com" });
    expect(bad.json.error.code).toBe(-32002);
  });
});
