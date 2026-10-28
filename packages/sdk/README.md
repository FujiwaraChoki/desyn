# @desyn/sdk

Typed client for the **Desyn Agent API v1** (REST), the API contract it is built from (zod → OpenAPI 3.1),
transaction helpers on top of `@desyn/schema`, and the **Desyn MCP server** (remote over Streamable HTTP at
`/mcp`, local over stdio with the `desyn-mcp` binary).

- Isomorphic: Node.js 18+, Deno, Bun, workers and browsers (in browsers, proxy through your own backend so the
  API key stays secret). Only dependency at runtime: `zod`.
- One contract: `src/contract/*` defines every route (path, scopes, query/body/response schemas). The Convex
  HTTP handlers validate with it, `GET /api/v1/openapi.json` is generated from it, and the client is typed by it.

## Client

```ts
import { DesynClient, TransactionBuilder } from "@desyn/sdk";

const desyn = new DesynClient({
  apiKey: process.env.DESYN_API_KEY, // default: DESYN_API_KEY
  baseUrl: "https://api.desyn.app/api/v1", // self-hosted: <CONVEX_SITE_URL>/api/v1
});

const me = await desyn.me(); // member, workspace, role, plan, effective scopes
const design = await desyn.designs.create({ name: "Autumn menu", presetId: "poster-a4" });

const tx = new TransactionBuilder();
const card = tx.create(design.firstPageId!, {
  type: "frame",
  name: "Card",
  fill: "#1d1a16",
  children: [{ type: "text", text: "Autumn", fontFamily: "Instrument Serif", fontSize: 64, color: "#ffb02e" }],
});
tx.update(card, { x: 64, y: 96 });
const result = await desyn.designs.commit(design.id, { baseSeq: design.seq, tx: tx.build("Add title") });

const { design: doc, seq } = await desyn.designs.load(design.id);
const description = await desyn.designs.describe(design.id); // DOCUMENT_MODEL §7 Description
const png = await desyn.designs.preview(design.id, { maxSize: 1024 }); // { bytes, contentType, seq }
```

| Namespace | Methods |
| --- | --- |
| account | `me()`, `workspaces()`, `credits()`, `usage()` |
| `designs` | `list`, `all` (async iterator), `create`, `get`, `update`, `archive`, `restore`, `delete({ permanent })`, `load`, `commit`, `transactions`, `describe`, `preview`, `applyBrand` |
| `folders` | `list` |
| `exports` | `request`, `get`, `wait` |
| `assets` | `list`, `all`, `get`, `rename`, `delete`, `requestUpload`, `finalize`, `upload(bytes, { name, mime })` (request → presigned PUT → finalize, deduplicated by sha256) |
| `templates` | `search`, `get` (with slots), `instantiate({ slots, brandKitId })` |
| `brandKits` | `list`, `get`, `create`, `update`, `delete` |
| `agent` | `start`, `get`, `events` (SSE with automatic resume, or long-poll with `{ stream: false }`), `eventsPage`, `answer`, `cancel`, `wait` |
| `ai` | `generateAsset`, `models` |
| `workflows` | `start`, `get`, `wait` |

**Errors** are `DesynApiError` (`status`, `code`, `message`, `details`, `requestId`, `retryAfterMs`,
`retryable`). Codes: the API's (`UNAUTHENTICATED`, `INSUFFICIENT_SCOPE`, `NOT_FOUND`, `INVALID_ARGUMENT`,
`LIMIT_REACHED`, `RATE_LIMITED`, `NOT_CONFIGURED`, …) plus `NETWORK_ERROR`, `TIMEOUT`, `INVALID_RESPONSE`.

**Retries and idempotency.** GETs and idempotent POSTs (create design, commit, export, upload request,
instantiate, agent runs, …) are retried on 429 / 502 / 503 / 504 / network errors (`maxRetries`, default 2,
honoring `Retry-After`). The client sends a generated `Idempotency-Key` for those POSTs, so a retry never
applies a change twice; commits are additionally idempotent on `tx.id` (derived from the key when omitted).
Other POSTs (archive, cancel, finalize) are not retried automatically.

### Transactions

`TransactionBuilder` emits document-model ops (`docs/DOCUMENT_MODEL.md` §5). `create` accepts a full `Node`
or a friendly **NodeInput**: `type` plus any node fields; missing fields come from the `@desyn/schema`
factories, nested `children` become one subtree, and a few shorthands are expanded:

- text: `text`, `fontFamily`, `fontSize`, `fontWeight`, `italic`, `color`, `letterSpacing`, `align`, `lineHeight` (≤ 4 = multiple, else px)
- shapes / frames: `fill: "#rrggbb"`

`expandNode`, `createOp`, `normalizeOps` (expands `{ op: "create", parent, node }`) and `toTransaction` (for
local checks with `@desyn/doc-ops` `applyTransaction`) are exported as well, plus the `@desyn/schema`
factories (`createText`, `createRect`, …, `newId`, `solid`).

### Agent runs

```ts
const run = await desyn.agent.start(design.id, { goal: "Make it feel more premium" });
for await (const event of desyn.agent.events(run.id)) {
  if (event.type === "question") await desyn.agent.answer(run.id, "Yes");
}
const finished = await desyn.agent.get(run.id);
```

Without the SDK, `GET /api/v1/agent-runs/{runId}/events` with `Accept: text/event-stream` streams one SSE
message per AgentEvent (`id` = event index, `event` = the AgentEvent `type`, including the run's own `error`
events, `data` = the event JSON). Two control events have reserved names: `stream-end` (the run finished)
and `stream-error` (`{ code, message }`). A stream that closes without `stream-end` (after about a minute)
is resumed by reconnecting with `Last-Event-ID`.

## MCP server

The same tool set is served remotely by the backend and locally by `desyn-mcp`:

| Group | Tools |
| --- | --- |
| Account / designs | `get_account`, `list_designs`, `create_design`, `update_design`, `delete_design` |
| Understand | `describe_design`, `get_document`, `list_changes`, `render_preview` (image content) |
| Edit | `apply_operations` (ops with friendly nodes, one undoable transaction), `apply_brand` |
| Output / assets | `export_design` (waits, returns URLs), `list_assets`, `upload_asset` (base64), `upload_file` (stdio only) |
| Templates / brand | `search_templates`, `get_template`, `instantiate_template`, `list_brand_kits` |
| AI | `start_ai_run`, `get_ai_run`, `answer_ai_run`, `cancel_ai_run`, `generate_image`, `run_workflow`, `get_workflow` |

Resources: `desyn://designs/{designId}` (document), `…/description`, `…/preview.png` (each with
`?pageId=`), and the JSON Schemas `desyn://schema/op|node|design`. Protocol revisions 2025-11-25 (latest),
2025-06-18, 2025-03-26 and 2024-11-05 are negotiated; the server is stateless (no sessions, no server-initiated
stream). Tool failures come back as `isError: true` results the model can read.

**Remote** (`https://api.desyn.app/mcp`, self-hosted `<CONVEX_SITE_URL>/mcp`): key with the `mcp` scope plus
the scopes the agent may use.

```bash
claude mcp add --transport http desyn https://api.desyn.app/mcp --header "Authorization: Bearer $DESYN_API_KEY"
```

**Local stdio** (`desyn-mcp`, proxies to the HTTP API; adds `upload_file` for local paths):

```bash
pnpm --filter @desyn/sdk build                 # dist/desyn-mcp.js
claude mcp add desyn --env DESYN_API_KEY=dsk_… -- node /path/to/desyn/packages/sdk/dist/desyn-mcp.js
# self-hosted: --env DESYN_API_URL=https://<convex-site>/api/v1
```

Claude Desktop: see `examples/claude-desktop.json`. The handler is also usable directly:
`createMcpServer({ client })` + `handleStreamableHttp(server, request)` or `runStdio(server, io)`.

## OpenAPI

`buildOpenApi()` returns the OpenAPI 3.1 document (85 shared component schemas, document-model types from
`@desyn/schema`). `pnpm gen:openapi` writes `openapi.json` here and `apps/docs/public/openapi.json`; a test
fails when either is stale. The backend serves the same document at `GET /api/v1/openapi.json`.

## Development

```bash
pnpm --filter @desyn/sdk typecheck
pnpm --filter @desyn/sdk lint
pnpm --filter @desyn/sdk test        # client (mocked fetch), transactions, SSE, OpenAPI validation,
                                     # MCP conformance with the official @modelcontextprotocol/sdk client
                                     # over Streamable HTTP and over stdio (spawns dist/desyn-mcp.js)
pnpm --filter @desyn/sdk build       # dist/index.js, dist/mcp.js, dist/desyn-mcp.js (esbuild)
pnpm --filter @desyn/sdk gen:openapi
```

Examples (`examples/`): `quickstart.ts` (create, edit, preview, export), `agent-run.ts` (follow an agent run
over SSE), `upload-and-place.ts` (upload a file and place it), `claude-desktop.json`.

The package is private in this monorepo. `dist/` bundles `@desyn/schema` (workspace TypeScript sources) and
keeps `zod` external; publishing to npm additionally needs emitted type declarations.
