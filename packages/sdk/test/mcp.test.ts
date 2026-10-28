import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { DesynClient } from "../src";
import { createMcpServer, handleStreamableHttp, runStdio, TOOLS } from "../src/mcp";
import { MockApi, TEST_KEY } from "./mock-api";

// Protocol conformance: the official MCP TypeScript SDK client talks to our server over Streamable HTTP
// (handleStreamableHttp) and over stdio (the built desyn-mcp binary), backed by an in-memory Agent API.

function backend() {
  const api = new MockApi();
  const client = new DesynClient({
    apiKey: TEST_KEY,
    baseUrl: api.base,
    fetch: api.fetch,
    maxRetries: 0,
  });
  return { api, client };
}

async function httpClient() {
  const { api, client } = backend();
  const server = createMcpServer({ client });
  const transport = new StreamableHTTPClientTransport(new URL("http://mcp.test/mcp"), {
    fetch: async (input, init) => await handleStreamableHttp(server, new Request(input, init)),
  });
  const mcp = new Client({ name: "conformance", version: "1.0.0" });
  await mcp.connect(transport);
  return { api, mcp };
}

describe("Streamable HTTP with the official MCP client", () => {
  test("initialize, server info, instructions and tool list", async () => {
    const { mcp } = await httpClient();
    expect(mcp.getServerVersion()).toMatchObject({ name: "desyn", title: "Desyn" });
    expect(mcp.getInstructions()).toContain("apply_operations");
    expect(mcp.getServerCapabilities()).toMatchObject({ tools: {}, resources: {} });
    const { tools } = await mcp.listTools();
    expect(tools.map((t) => t.name)).toEqual(TOOLS.filter((t) => !t.local).map((t) => t.name));
    const apply = tools.find((t) => t.name === "apply_operations");
    expect(apply?.inputSchema.required).toEqual(["designId", "ops"]);
    expect(apply?.annotations).toMatchObject({ destructiveHint: true, title: "Edit a design" });
    await mcp.ping();
    await mcp.close();
  });

  test("tool calls edit a design and return images and structured content", async () => {
    const { api, mcp } = await httpClient();
    const created = await mcp.callTool({
      name: "create_design",
      arguments: { name: "Poster", kind: "poster" },
    });
    const { id, firstPageId } = created.structuredContent as { id: string; firstPageId: string };
    const edit = await mcp.callTool({
      name: "apply_operations",
      arguments: {
        designId: id,
        label: "Headline",
        ops: [
          {
            op: "create",
            parent: firstPageId,
            node: { type: "text", text: "Hello", fontSize: 72 },
          },
        ],
      },
    });
    expect(edit.isError).toBeFalsy();
    const stored = api.designs.get(id);
    const textNode = Object.values(stored?.design.nodes ?? {}).find((n) => n.type === "text");
    expect(textNode).toMatchObject({ runs: [{ text: "Hello" }], style: { fontSize: 72 } });
    expect(stored?.log[0]?.tx).toMatchObject({
      label: "Headline",
      source: "ai",
      actor: { agent: "mcp" },
    });

    const preview = await mcp.callTool({ name: "render_preview", arguments: { designId: id } });
    expect(preview.content).toContainEqual(
      expect.objectContaining({ type: "image", mimeType: "image/png" }),
    );
    const missing = await mcp.callTool({
      name: "describe_design",
      arguments: { designId: "nope" },
    });
    expect(missing.isError).toBe(true);
    const badArgs = await mcp.callTool({ name: "create_design", arguments: { width: "wide" } });
    expect(badArgs.isError).toBe(true);
    await expect(mcp.callTool({ name: "teleport", arguments: {} })).rejects.toThrow(/Unknown tool/);
    await mcp.close();
  });

  test("resources: list, templates and read", async () => {
    const { mcp } = await httpClient();
    await mcp.callTool({ name: "create_design", arguments: { name: "Flyer" } });
    const { resources } = await mcp.listResources();
    expect(resources.map((r) => r.uri)).toContain("desyn://designs/d1");
    const { resourceTemplates } = await mcp.listResourceTemplates();
    expect(resourceTemplates.map((r) => r.uriTemplate)).toContain(
      "desyn://designs/{designId}/preview.png",
    );
    const doc = await mcp.readResource({ uri: "desyn://designs/d1" });
    expect(JSON.parse((doc.contents[0] as { text: string }).text).design.name).toBe("Flyer");
    const preview = await mcp.readResource({ uri: "desyn://designs/d1/preview.png?pageId=p1" });
    expect(preview.contents[0]).toMatchObject({ mimeType: "image/png" });
    await expect(mcp.readResource({ uri: "desyn://designs/zzz" })).rejects.toThrow();
    await mcp.close();
  });
});

describe("stdio transport", () => {
  test("runStdio answers line-delimited messages, skips notifications and honors cancellation", async () => {
    const { client } = backend();
    const server = createMcpServer({ client });
    const lines: string[] = [];
    const input = (async function* () {
      yield '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{}}}\n{"jsonrpc":"2.0","method":"notifications/initialized"}\n';
      yield '{"jsonrpc":"2.0","id":2,"method":"ping"}\nnot json\n{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"get_account","arguments":{}}}';
    })();
    await runStdio(server, { input, write: (line) => lines.push(line) });
    const out = lines.map((l) => JSON.parse(l));
    expect(out.find((m) => m.id === 1)?.result.protocolVersion).toBe("2025-11-25");
    expect(out.find((m) => m.id === 2)?.result).toEqual({});
    expect(out.find((m) => m.id === null)?.error.code).toBe(-32700);
    expect(out.find((m) => m.id === 3)?.result.structuredContent).toMatchObject({
      userId: "user1",
      credits: { remaining: 590 },
    });
    expect(out).toHaveLength(4);
  });

  const bin = fileURLToPath(new URL("../dist/desyn-mcp.js", import.meta.url));
  let http: Server;
  let url = "";
  const api = new MockApi();

  beforeAll(async () => {
    // Always test the current sources: rebuild the binary (esbuild, well under a second).
    execFileSync(process.execPath, ["scripts/build.mjs"], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
    });
    expect(existsSync(bin)).toBe(true);
    http = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = Buffer.concat(chunks);
      const target = req.url?.startsWith("/storage/")
        ? `http://storage.test${req.url.slice("/storage".length)}`
        : `http://api.test${req.url}`;
      const response = await api.fetch(target, {
        method: req.method ?? "GET",
        headers: req.headers as Record<string, string>,
        ...(body.length > 0 ? { body } : {}),
      });
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    });
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
    url = `${origin}/api/v1`;
    api.storageBase = `${origin}/storage`;
  });
  afterAll(() => new Promise<void>((resolve) => http.close(() => resolve())));

  test("the desyn-mcp binary works with the official client over stdio", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [bin],
      env: { DESYN_API_KEY: TEST_KEY, DESYN_API_URL: url, PATH: process.env.PATH ?? "" },
      stderr: "pipe",
    });
    const mcp = new Client({ name: "stdio-conformance", version: "1.0.0" });
    await mcp.connect(transport);
    const { tools } = await mcp.listTools();
    expect(tools.map((t) => t.name)).toContain("upload_file");
    const created = await mcp.callTool({
      name: "create_design",
      arguments: { name: "From stdio" },
    });
    expect((created.structuredContent as { name: string }).name).toBe("From stdio");
    const upload = await mcp.callTool({
      name: "upload_file",
      arguments: {
        path: fileURLToPath(new URL("../package.json", import.meta.url)),
        mime: "application/json",
      },
    });
    expect(upload.isError).toBeFalsy();
    expect((upload.structuredContent as { status: string }).status).toBe("ready");
    await mcp.close();
  }, 30_000);
});
