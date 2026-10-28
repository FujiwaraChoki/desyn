import { applyTransaction } from "@desyn/doc-ops";
import {
  type AssetRef,
  createDesign,
  createText,
  type Design,
  defaultTextStyle,
  newId,
  type Op,
  type TextNode,
  type Transaction,
} from "@desyn/schema";
import { describe, expect, test } from "vitest";
import {
  derivedGeometryOps,
  type HostBackend,
  type HostCommitResult,
  type HostWorker,
  imageDimensions,
  WorkerHost,
} from "../lib/ai_host";
import { tinyPng } from "./ai.helpers";

// WorkerHost against a fake backend (an in-memory "server" with a transaction log) and a fake render worker.

function tx(ops: Op[], source: Transaction["source"] = "ai"): Transaction {
  return { id: newId(), label: "edit", ops, source, ts: 0, actor: { runId: "run1" } };
}

function pageOf(design: Design): string {
  return (design.nodes.root as { children: string[] }).children[0] as string;
}

class FakeServer {
  design: Design;
  log: { seq: number; tx: Transaction }[] = [];
  compactedThrough = 0;
  commits: Transaction[] = [];
  urls: Record<string, string> = {};
  stored: { bytes: Uint8Array; mime: string }[] = [];

  constructor() {
    const base = createDesign("social-post", "instagram-post", { name: "Test" });
    const headline = createText({
      id: newId(),
      name: "Headline",
      text: "Hello",
      x: 10,
      y: 10,
      width: 400,
      height: 50,
      style: defaultTextStyle({ fontSize: 40 }),
    });
    this.design = applyTransaction(
      base,
      tx([{ op: "create", nodes: [headline], parent: pageOf(base) }]),
    ).design;
  }

  get seq(): number {
    return this.log.at(-1)?.seq ?? 0;
  }

  headlineId(): string {
    return Object.values(this.design.nodes).find((n) => n.type === "text")?.id as string;
  }

  /** A collaborator's edit committed directly on the server. */
  remote(ops: Op[]): void {
    const r = applyTransaction(this.design, tx(ops, "user"));
    this.design = r.design;
    this.log.push({ seq: this.seq + 1, tx: { ...tx(ops, "user"), ops: r.applied } });
  }

  backend(worker: HostWorker | null = null): HostBackend {
    return {
      load: async () => ({ design: this.design, seq: this.seq }),
      opsAfter: async (seq) => ({
        txs: this.log.filter((e) => e.seq > seq),
        gap: seq < this.compactedThrough,
      }),
      commit: async (t): Promise<HostCommitResult> => {
        this.commits.push(t);
        const r = applyTransaction(this.design, t);
        this.design = r.design;
        this.log.push({ seq: this.seq + 1, tx: { ...t, ops: r.applied } });
        return {
          seq: this.seq,
          applied: JSON.stringify(r.applied),
          dropped: r.dropped,
          duplicate: false,
        };
      },
      assetUrls: async () => this.urls,
      ingest: async (bytes, mime, meta) => {
        this.stored.push({ bytes, mime });
        return {
          id: newId(),
          kind: "image",
          mime,
          storageKey: `k/${this.stored.length}`,
          ...(meta.name ? { name: meta.name } : {}),
        } satisfies AssetRef;
      },
      fetchBytes: async (url) => ({ bytes: new TextEncoder().encode(url), mime: "image/png" }),
      worker,
    };
  }
}

function fakeWorker(handlers: Record<string, (body: Record<string, unknown>) => unknown>) {
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  const worker: HostWorker = {
    async call(path, body) {
      calls.push({ path, body: body as Record<string, unknown> });
      const handler = handlers[path];
      if (!handler) throw new Error(`worker ${path} failed`);
      const out = handler(body as Record<string, unknown>);
      if (out instanceof Uint8Array) return { bytes: out, contentType: "image/png" };
      return {
        bytes: new TextEncoder().encode(JSON.stringify(out)),
        contentType: "application/json",
      };
    },
  };
  return { worker, calls };
}

describe("WorkerHost", () => {
  test("applies through the commit path and keeps local state in sync with the server", async () => {
    const server = new FakeServer();
    const host = await WorkerHost.open(server.backend());
    const id = server.headlineId();
    const result = await host.apply(
      tx([
        { op: "update", id, set: { name: "Title" } },
        { op: "delete", id: "missing00000" },
      ]),
    );
    expect(result.applied).toHaveLength(1);
    expect(result.dropped).toEqual([{ index: 1, reason: "missing-node" }]);
    expect(host.getDesign().nodes[id]?.name).toBe("Title");
    expect(host.seq).toBe(server.seq);
    // The inverse undoes exactly this change.
    const undone = applyTransaction(host.getDesign(), result.inverse).design;
    expect(undone.nodes[id]?.name).toBe("Headline");
  });

  test("catches up with collaborators before reading and before applying", async () => {
    const server = new FakeServer();
    const host = await WorkerHost.open(server.backend());
    const id = server.headlineId();
    server.remote([{ op: "update", id, set: { x: 99 } }]);
    await host.describe();
    expect(host.getDesign().nodes[id]?.x).toBe(99);
    server.remote([{ op: "update", id, set: { y: 77 } }]);
    await host.apply(tx([{ op: "update", id, set: { name: "Both" } }]));
    expect(host.getDesign().nodes[id]).toMatchObject({ x: 99, y: 77, name: "Both" });
    // After log compaction the host reloads the whole design.
    server.remote([{ op: "update", id, set: { x: 5 } }]);
    server.compactedThrough = server.seq;
    server.log = [];
    await host.sync();
    expect(host.getDesign().nodes[id]?.x).toBe(5);
  });

  test("normalizes derived geometry with the worker's layout before committing", async () => {
    const server = new FakeServer();
    const id = server.headlineId();
    const { worker, calls } = fakeWorker({
      "/v1/apply": (body) => {
        const applied = applyTransaction(body.design as Design, body.tx as Transaction).design;
        const node = applied.nodes[id] as TextNode;
        return {
          design: { ...applied, nodes: { ...applied.nodes, [id]: { ...node, height: 96 } } },
        };
      },
    });
    const host = await WorkerHost.open(server.backend(worker));
    const res = await host.apply(
      tx([
        {
          op: "update",
          id,
          set: { style: { ...(server.design.nodes[id] as TextNode).style, fontSize: 80 } },
        },
      ]),
    );
    expect(calls[0]?.path).toBe("/v1/apply");
    expect(server.commits[0]?.ops).toHaveLength(2);
    expect(server.commits[0]?.ops[1]).toEqual({ op: "update", id, set: { height: 96 } });
    expect(host.getDesign().nodes[id]?.height).toBe(96);
    expect(res.dropped).toEqual([]);

    // A worker failure never blocks the edit.
    const broken = await WorkerHost.open(server.backend(fakeWorker({}).worker));
    await broken.apply(tx([{ op: "update", id, set: { name: "Still works" } }]));
    expect(server.commits.at(-1)?.ops).toHaveLength(1);
  });

  test("describe / render / measure use the worker, with resolvable asset URLs", async () => {
    const server = new FakeServer();
    const ref = newId();
    server.design = {
      ...server.design,
      assets: { [ref]: { id: ref, kind: "image", mime: "image/png", storageKey: "k/a" } },
    };
    server.urls = { [ref]: "https://s3.example/k/a?sig" };
    const description = { design: { id: "d" }, issues: [] };
    const { worker, calls } = fakeWorker({
      "/v1/describe": () => description,
      "/v1/render": () => tinyPng(512, 512),
      "/v1/measure": () => ({ sizes: [{ w: 120, h: 48, lines: 2, baseline: 30 }] }),
    });
    const host = await WorkerHost.open(server.backend(worker), {
      selection: [server.headlineId(), "gone00000000"],
    });
    expect(host.selection).toEqual([server.headlineId()]);
    expect(await host.describe()).toEqual(description);
    const describeBody = calls[0]?.body as {
      design: Design;
      selection: string[];
      assetUrls: Record<string, string>;
    };
    expect(describeBody.design.assets[ref]?.url).toBe("https://s3.example/k/a?sig");
    expect(describeBody.selection).toEqual([server.headlineId()]);
    const png = await host.render({ maxSize: 512 });
    expect(png).toMatchObject({ mime: "image/png", width: 512, height: 512 });
    const renderBody = calls[1]?.body as { scale: number; format: string; pageId: string };
    expect(renderBody).toMatchObject({ format: "png", pageId: host.page });
    expect(renderBody.scale).toBeCloseTo(512 / 1080, 5);
    const sizes = await host.measure([
      {
        text: [{ text: "Hi" }],
        style: defaultTextStyle(),
        paragraph: (server.design.nodes[server.headlineId()] as TextNode).paragraph,
      },
    ]);
    expect(sizes).toEqual([{ w: 120, h: 48, lines: 2 }]);
    // Committed designs never carry the URLs.
    expect(host.getDesign().assets[ref]?.url).toBeUndefined();
  });

  test("falls back to the TypeScript describe / render / measure without a worker", async () => {
    const server = new FakeServer();
    const host = await WorkerHost.open(server.backend());
    const d = await host.describe();
    expect(d.page.width).toBe(1080);
    expect(d.tree.some((n) => n.type === "text")).toBe(true);
    const png = await host.render({ maxSize: 256 });
    expect(png).toMatchObject({ mime: "image/png", width: 256, height: 256 });
    const [m] = await host.measure([
      {
        text: [{ text: "Hello world" }],
        style: defaultTextStyle({ fontSize: 20 }),
        paragraph: (server.design.nodes[server.headlineId()] as TextNode).paragraph,
      },
    ]);
    expect(m?.w).toBeGreaterThan(0);
  });

  test("assets: uploads go to the backend; reads need a stored file", async () => {
    const server = new FakeServer();
    server.urls = { abc: "https://s3.example/abc" };
    const host = await WorkerHost.open(server.backend());
    const ref = await host.assets.upload(tinyPng(), "image/png", { name: "gen" });
    expect(ref).toMatchObject({ kind: "image", name: "gen" });
    expect(server.stored).toHaveLength(1);
    const read = await host.assets.read("abc");
    expect(new TextDecoder().decode(read.bytes)).toBe("https://s3.example/abc");
    await expect(host.assets.read("nope")).rejects.toThrow(/no stored file/);
  });
});

describe("helpers", () => {
  test("derivedGeometryOps only takes x / y / width / height", () => {
    const server = new FakeServer();
    const id = server.headlineId();
    const node = server.design.nodes[id] as TextNode;
    const normalized: Design = {
      ...server.design,
      nodes: {
        ...server.design.nodes,
        [id]: { ...node, height: 61.5, name: "ignored", x: 10.004 },
      },
    };
    expect(derivedGeometryOps(server.design, normalized)).toEqual([
      { op: "update", id, set: { height: 61.5 } },
    ]);
  });

  test("imageDimensions reads PNG, JPEG and WebP headers", () => {
    expect(imageDimensions(tinyPng(320, 200))).toEqual({ width: 320, height: 200 });
    const jpeg = new Uint8Array([
      0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x64, 0x00, 0xc8, 0x03, 0, 0, 0, 0,
    ]);
    expect(imageDimensions(jpeg)).toEqual({ width: 200, height: 100 });
    const webp = new Uint8Array(30);
    webp.set([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x58]);
    webp.set([0x3f, 0x01, 0x00, 0xc7, 0x00, 0x00], 24); // 320 x 200 (minus one, little endian)
    expect(imageDimensions(webp)).toEqual({ width: 320, height: 200 });
    expect(imageDimensions(new Uint8Array([1, 2, 3]))).toBeNull();
  });
});
