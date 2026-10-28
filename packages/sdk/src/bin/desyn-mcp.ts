import { readFile } from "node:fs/promises";
import { DEFAULT_BASE_URL, DesynClient } from "../client";
import { createMcpServer, SERVER_VERSION } from "../mcp/server";
import { runStdio } from "../mcp/stdio";

// desyn-mcp: a stdio MCP server for local MCP clients (Claude Desktop, Claude Code, Cursor…) that proxies to
// the Desyn Agent API over HTTPS with the key in DESYN_API_KEY.

const HELP = `desyn-mcp ${SERVER_VERSION} - Desyn MCP server (stdio)

Usage: desyn-mcp [--base-url <url>]

Environment:
  DESYN_API_KEY   API key (dsk_…) with the mcp scope plus the scopes the agent may use. Required.
  DESYN_API_URL   Agent API base URL (default ${DEFAULT_BASE_URL};
                  self-hosted: <CONVEX_SITE_URL>/api/v1).

Claude Code:     claude mcp add desyn --env DESYN_API_KEY=dsk_… -- desyn-mcp
Claude Desktop:  { "mcpServers": { "desyn": { "command": "desyn-mcp", "env": { "DESYN_API_KEY": "dsk_…" } } } }
`;

function main(argv: string[]): number | Promise<number> {
  let baseUrl = process.env.DESYN_API_URL;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      process.stdout.write(HELP);
      return 0;
    }
    if (arg === "--version" || arg === "-v") {
      process.stdout.write(`${SERVER_VERSION}\n`);
      return 0;
    }
    if (arg === "--base-url") {
      baseUrl = argv[++i];
      continue;
    }
    if (arg?.startsWith("--base-url=")) {
      baseUrl = arg.slice("--base-url=".length);
      continue;
    }
    process.stderr.write(`desyn-mcp: unknown argument ${arg}\n\n${HELP}`);
    return 2;
  }
  const apiKey = process.env.DESYN_API_KEY;
  if (!apiKey) {
    process.stderr.write("desyn-mcp: set DESYN_API_KEY to a Desyn API key (dsk_…).\n");
    return 2;
  }
  const client = new DesynClient({ apiKey, ...(baseUrl ? { baseUrl } : {}) });
  const server = createMcpServer({
    client,
    readFile: async (path) => new Uint8Array(await readFile(path)),
  });
  return runStdio(server, {
    input: process.stdin,
    write: (line) => process.stdout.write(`${line}\n`),
    log: (message) => process.stderr.write(`${message}\n`),
  }).then(() => 0);
}

Promise.resolve(main(process.argv.slice(2))).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    process.stderr.write(`desyn-mcp: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  },
);
