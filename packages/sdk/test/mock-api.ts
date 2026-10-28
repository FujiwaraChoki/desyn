import { applyTransaction } from "@desyn/doc-ops";
import { createDesign, type Design, newId, type Transaction } from "@desyn/schema";

// An in-memory Agent API v1 for SDK / MCP tests: real document semantics (@desyn/doc-ops applyTransaction),
// the documented error format and the endpoints the tests exercise. Not a reimplementation of the backend.

export const TEST_KEY = `dsk_${"k".repeat(43)}`;

interface Stored {
  id: string;
  design: Design;
  seq: number;
  log: { seq: number; tx: Transaction }[];
  createdAt: number;
}

export interface MockOptions {
  /** Fail the next N requests to this route id with the given status (retry tests). */
  failures?: { status: number; count: number; retryAfter?: string };
}

export class MockApi {
  readonly designs = new Map<string, Stored>();
  readonly assets = new Map<string, Record<string, unknown>>();
  readonly uploads = new Map<string, Uint8Array>();
  readonly runs = new Map<
    string,
    { events: Record<string, unknown>[]; status: string; revealed: number }
  >();
  readonly requests: { method: string; path: string; headers: Headers; body: string }[] = [];
  failures: MockOptions["failures"];
  base = "http://api.test/api/v1";
  /** Where presigned upload URLs point (tests serving over real HTTP override it). */
  storageBase = "http://storage.test";

  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    if (url.host === "storage.test") return await this.storage(req, url);
    const body = req.method === "GET" || req.method === "DELETE" ? "" : await req.text();
    this.requests.push({
      method: req.method,
      path: url.pathname + url.search,
      headers: req.headers,
      body,
    });
    if (this.failures && this.failures.count > 0) {
      this.failures.count--;
      return this.error(
        this.failures.status,
        this.failures.status === 429 ? "RATE_LIMITED" : "UPSTREAM_UNAVAILABLE",
        "try later",
        {
          ...(this.failures.retryAfter ? { "retry-after": this.failures.retryAfter } : {}),
        },
      );
    }
    if (req.headers.get("authorization") !== `Bearer ${TEST_KEY}`) {
      return this.error(401, "UNAUTHENTICATED", "The API key is invalid, expired or revoked.");
    }
    const path = url.pathname.replace(/^\/api\/v1/, "");
    const json = body ? (JSON.parse(body) as Record<string, unknown>) : {};
    return this.route(req.method, path, url, json, req.headers);
  };

  private error(
    status: number,
    code: string,
    message: string,
    headers: Record<string, string> = {},
    extra = {},
  ) {
    return Response.json(
      { error: { code, message, requestId: "req_mock", ...extra } },
      { status, headers },
    );
  }

  private summary(s: Stored) {
    const root = s.design.nodes.root as { children: string[] };
    const page = s.design.nodes[root.children[0] as string] as
      | { width: number; height: number }
      | undefined;
    return {
      id: s.id,
      key: s.design.id,
      name: s.design.name,
      kind: s.design.kind,
      workspaceId: "ws1",
      folderId: null,
      ownerId: "user1",
      state: "active",
      pageCount: root.children.length,
      width: page?.width ?? 0,
      height: page?.height ?? 0,
      thumbnailUrl: null,
      templateId: null,
      permission: "manage",
      seq: s.seq,
      createdAt: s.createdAt,
      updatedAt: s.createdAt,
      archivedAt: null,
      deletedAt: null,
    };
  }

  private async storage(req: Request, url: URL): Promise<Response> {
    const id = url.pathname.split("/").pop() as string;
    if (req.method !== "PUT") return new Response(null, { status: 405 });
    if (req.headers.get("content-type") !== this.assets.get(id)?.mime)
      return new Response("bad type", { status: 403 });
    this.uploads.set(id, new Uint8Array(await req.arrayBuffer()));
    return new Response(null, { status: 200 });
  }

  private asset(id: string) {
    const a = this.assets.get(id) as Record<string, unknown>;
    return {
      ...a,
      assetRef: {
        id: a.refId,
        kind: a.kind,
        mime: a.mime,
        storageKey: `uploads/${id}`,
        bytes: a.bytes,
      },
    };
  }

  private route(
    method: string,
    path: string,
    url: URL,
    body: Record<string, unknown>,
    headers: Headers,
  ): Response {
    const m = (re: RegExp) => re.exec(path);
    if (method === "GET" && path === "/me") {
      return Response.json({
        userId: "user1",
        name: "Ada",
        email: "ada@example.org",
        plan: "pro",
        planName: "Pro",
        edition: "hosted",
        workspaceId: "ws1",
        workspaceName: "Ada",
        role: "owner",
        keyId: "key1",
        scopes: ["designs:read", "designs:write", "mcp"],
      });
    }
    if (method === "GET" && path === "/credits") {
      return Response.json({
        period: "2026-10",
        plan: "pro",
        granted: 600,
        used: 10,
        reserved: 0,
        overage: 0,
        remaining: 590,
        throttled: false,
      });
    }
    if (method === "GET" && path === "/designs") {
      const all = [...this.designs.values()].map((s) => this.summary(s));
      const limit = Number(url.searchParams.get("limit") ?? "25");
      const start = Number(url.searchParams.get("cursor") ?? "0");
      const items = all.slice(start, start + limit);
      return Response.json({
        items,
        nextCursor: start + limit < all.length ? String(start + limit) : null,
      });
    }
    if (method === "POST" && path === "/designs") {
      const design = createDesign((body.kind as Design["kind"]) ?? "custom", undefined, {
        name: (body.name as string) ?? "Untitled",
      });
      const s: Stored = {
        id: `d${this.designs.size + 1}`,
        design,
        seq: 1,
        log: [],
        createdAt: Date.now(),
      };
      this.designs.set(s.id, s);
      const root = design.nodes.root as { children: string[] };
      return Response.json({ ...this.summary(s), firstPageId: root.children[0] }, { status: 201 });
    }
    let r = m(
      /^\/designs\/([^/]+)(?:\/(document|transactions|describe|preview|exports|agent-runs))?$/,
    );
    if (r) {
      const s = this.designs.get(r[1] as string);
      if (!s) return this.error(404, "NOT_FOUND", "Design not found.");
      const sub = r[2];
      if (!sub && method === "GET") return Response.json(this.summary(s));
      if (sub === "document")
        return Response.json({ seq: s.seq, consistent: true, design: s.design });
      if (sub === "transactions" && method === "POST") {
        const input = body.tx as Partial<Transaction>;
        const id = input.id ?? newId();
        const existing = s.log.find((e) => e.tx.id === id);
        if (existing)
          return Response.json({
            seq: existing.seq,
            txId: id,
            applied: existing.tx.ops,
            dropped: [],
            duplicate: true,
          });
        const tx: Transaction = {
          id,
          label: input.label ?? "API edit",
          ops: input.ops ?? [],
          source: input.source ?? "ai",
          ts: Date.now(),
          ...(input.actor ? { actor: input.actor } : {}),
        };
        const result = applyTransaction(s.design, tx);
        s.design = result.design;
        s.seq++;
        s.log.push({ seq: s.seq, tx: { ...tx, ops: result.applied } });
        return Response.json({
          seq: s.seq,
          txId: id,
          applied: result.applied,
          dropped: result.dropped,
          duplicate: false,
        });
      }
      if (sub === "transactions" && method === "GET") {
        const since = Number(url.searchParams.get("since") ?? "0");
        const items = s.log
          .filter((e) => e.seq > since)
          .map((e) => ({
            seq: e.seq,
            txId: e.tx.id,
            tx: e.tx,
            actor: "user1",
            source: e.tx.source,
            ts: e.tx.ts,
          }));
        return Response.json({ items, hasMore: false, reload: false, latestSeq: s.seq });
      }
      if (sub === "describe") {
        const root = s.design.nodes.root as { children: string[] };
        return Response.json({
          design: {
            id: s.design.id,
            name: s.design.name,
            kind: s.design.kind,
            pageCount: root.children.length,
          },
          page: {
            id: url.searchParams.get("pageId") ?? root.children[0],
            index: 0,
            width: 1080,
            height: 1080,
            unit: "px",
            background: "solid #ffffff",
          },
          selection: (url.searchParams.get("selection") ?? "").split(",").filter(Boolean),
          tree: [],
          palette: [],
          fonts: [],
          typography: { scale: [] },
          grid: { margins: { t: 0, r: 0, b: 0, l: 0 }, alignments: [] },
          hierarchy: [],
          issues: [],
        });
      }
      if (sub === "preview") {
        return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]) as BodyInit, {
          headers: {
            "content-type": "image/png",
            "x-desyn-seq": String(s.seq),
            "x-desyn-page": "p1",
          },
        });
      }
      if (sub === "exports") {
        return Response.json(
          {
            id: "e1",
            designId: s.id,
            format: body.format,
            pages: "all",
            scale: 1,
            status: "queued",
            files: [],
            error: null,
            attempts: 0,
            createdAt: 1,
            startedAt: null,
            finishedAt: null,
            expiresAt: null,
          },
          { status: 202 },
        );
      }
      if (sub === "agent-runs") {
        const id = `run${this.runs.size + 1}`;
        const events = [
          { index: 0, type: "start", ts: 1, mode: "edit" },
          { index: 1, type: "tool-call", ts: 2, tool: "read_design" },
          { index: 2, type: "text", ts: 3, text: "Warmer now." },
          // A recoverable run error is ordinary data, not the end of the stream.
          { index: 3, type: "error", ts: 4, message: "Image provider busy.", recoverable: true },
          { index: 4, type: "done", ts: 5, status: "completed", summary: "Made it warmer." },
        ];
        this.runs.set(id, { events, status: "running", revealed: 0 });
        return Response.json(this.run(id), { status: 202 });
      }
    }
    r = m(/^\/agent-runs\/([^/]+)(?:\/(events|answer|cancel))?$/);
    if (r) {
      const run = this.runs.get(r[1] as string);
      if (!run) return this.error(404, "NOT_FOUND", "Run not found.");
      if (!r[2]) return Response.json(this.run(r[1] as string));
      if (r[2] === "cancel") {
        run.status = "cancelled";
        return Response.json(this.run(r[1] as string));
      }
      if (r[2] === "events") {
        const lastEventId = headers.get("last-event-id");
        const after = Number(lastEventId ?? url.searchParams.get("after") ?? "-1");
        if ((headers.get("accept") ?? "").includes("text/event-stream")) {
          // Two events per connection, then the stream closes without "stream-end" (the client reconnects).
          const batch = run.events.filter((e) => (e.index as number) > after).slice(0, 2);
          const last = batch.at(-1)?.index as number | undefined;
          const finished = last === run.events.length - 1;
          if (finished) run.status = "completed";
          let text = ": hi\r\nretry: 1000\r\n\r\n";
          for (const e of batch)
            text += `id: ${e.index}\r\nevent: ${e.type}\r\ndata: ${JSON.stringify(e)}\r\n\r\n`;
          if (finished) text += `event: stream-end\ndata: {}\n\n`;
          const bytes = new TextEncoder().encode(text);
          // Deliver in awkward chunks to exercise the parser.
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7));
              controller.close();
            },
          });
          return new Response(stream, { headers: { "content-type": "text/event-stream" } });
        }
        run.revealed = Math.min(run.events.length, run.revealed + 2);
        const items = run.events.slice(0, run.revealed).filter((e) => (e.index as number) > after);
        const done = run.revealed === run.events.length;
        if (done) run.status = "completed";
        return Response.json({
          items,
          next: (items.at(-1)?.index as number | undefined) ?? after,
          done,
        });
      }
    }
    if (method === "POST" && path === "/assets/uploads") {
      const id = `a${this.assets.size + 1}`;
      this.assets.set(id, {
        id,
        refId: `ref${String(this.assets.size + 1).padStart(9, "0")}`,
        kind: "image",
        name: body.name,
        mime: body.mime,
        bytes: body.bytes,
        width: null,
        height: null,
        durationMs: null,
        hash: body.sha256 ?? null,
        status: "pending",
        source: "upload",
        url: null,
        urlExpiresAt: null,
        createdAt: 1,
        updatedAt: 1,
      });
      return Response.json(
        {
          assetId: id,
          refId: this.assets.get(id)?.refId,
          deduplicated: false,
          upload: {
            url: `${this.storageBase}/put/${id}`,
            method: "PUT",
            headers: { "content-type": body.mime as string, "content-length": String(body.bytes) },
            expiresAt: Date.now() + 60_000,
          },
        },
        { status: 201 },
      );
    }
    r = m(/^\/assets\/([^/]+)(\/finalize)?$/);
    if (r) {
      const a = this.assets.get(r[1] as string);
      if (!a) return this.error(404, "NOT_FOUND", "Asset not found.");
      if (r[2]) {
        const bytes = this.uploads.get(r[1] as string);
        if (!bytes || bytes.length !== a.bytes)
          return this.error(
            400,
            "INVALID_ARGUMENT",
            "The file has not been uploaded yet.",
            {},
            { field: "assetId" },
          );
        a.status = "ready";
      }
      return Response.json(this.asset(r[1] as string));
    }
    if (method === "GET" && path === "/templates") {
      return Response.json({
        items: [
          {
            id: "t1",
            slug: "bakery-menu",
            title: "Bakery menu",
            description: "",
            kind: "menu",
            category: "food",
            categories: [],
            tags: [],
            premium: false,
            pageCount: 1,
            width: 794,
            height: 1123,
            popularity: 3,
            thumbnails: [{ url: "https://cdn.test/t1.webp", width: 320, height: 452 }],
            updatedAt: 1,
          },
        ],
        nextCursor: null,
      });
    }
    return this.error(404, "NOT_FOUND", "No such endpoint.");
  }

  private run(id: string) {
    const run = this.runs.get(id) as { status: string; events: Record<string, unknown>[] };
    const done = run.status === "completed";
    return {
      id,
      kind: "agent",
      designId: "d1",
      status: run.status,
      mode: "edit",
      goal: "warmer",
      question: null,
      result: done ? { summary: "Made it warmer." } : null,
      error: null,
      costCredits: done ? 2 : 0,
      steps: 1,
      createdAt: 1,
      updatedAt: 1,
      finishedAt: done ? 2 : null,
    };
  }
}
