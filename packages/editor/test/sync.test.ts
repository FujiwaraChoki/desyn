import {
  canonicalEqual,
  createDesign,
  createRect,
  type Design,
  type Id,
  type Node,
  newId,
  type Op,
  type Transaction,
} from "@desyn/schema";
import { describe, expect, test } from "vitest";
import { IndexedDbPendingStore, MemoryPendingStore } from "../src/sync/pending-store.ts";
import { SyncClient, type SyncClientOptions } from "../src/sync/sync-client.ts";
import { ConvexLikeError, FakeServer, FakeTransport, settle, until } from "./fake-server.ts";

function pageOf(d: Design): Id {
  return (d.nodes.root as Node & { children: Id[] }).children[0] as Id;
}

function tx(ops: Op[], label = "Edit"): Transaction {
  return { id: newId(), label, ops, source: "user", ts: Date.now() };
}

function seeded(count = 3) {
  let design = createDesign("social-post");
  const page = pageOf(design);
  const ids: Id[] = [];
  for (let i = 0; i < count; i++) {
    const r = createRect({ parent: page, x: i * 10, y: 0, name: `R${i}` });
    ids.push(r.id);
    const p = design.nodes[page] as Node & { children: Id[] };
    design = {
      ...design,
      nodes: {
        ...design.nodes,
        [r.id]: r,
        [page]: { ...p, children: [...p.children, r.id] } as Node,
      },
    };
  }
  return { design, page, ids };
}

function makeClient(
  server: FakeServer,
  overrides: Partial<SyncClientOptions> & { transport?: FakeTransport } = {},
) {
  const transport = overrides.transport ?? new FakeTransport(server);
  const events: { event: string; props: Record<string, unknown> }[] = [];
  const client = new SyncClient({
    designId: "d1",
    transport,
    pendingStore: new MemoryPendingStore(),
    retry: { baseMs: 1, maxMs: 4 },
    random: () => 1,
    telemetry: (event, props) => events.push({ event, props }),
    ...overrides,
  });
  return { client, transport, events };
}

const update = (id: Id, set: Record<string, unknown>): Op => ({ op: "update", id, set });

function viewOf(client: SyncClient): Design {
  if (!client.view) throw new Error("not loaded");
  return client.view;
}

function converged(client: SyncClient, server: FakeServer): boolean {
  return client.pending.length === 0 && !!client.view && canonicalEqual(client.view, server.design);
}

describe("SyncClient: load", () => {
  test("loads the design in chunks and matches the server", async () => {
    const { design } = seeded(7);
    const server = new FakeServer(design);
    server.pageSize = 3;
    const { client, transport } = makeClient(server);
    await client.start();
    expect(transport.loads).toBe(1);
    expect(canonicalEqual(client.view as Design, server.design)).toBe(true);
    expect(client.snapshot().status).toBe("live");
    expect(client.loadHeader?.permission).toBe("edit");
  });

  test("re-reads pages that were read at different seqs", async () => {
    const { design, ids } = seeded(5);
    const server = new FakeServer(design);
    server.pageSize = 2;
    const { client, transport, events } = makeClient(server);
    let once = true;
    transport.betweenPages = () => {
      if (!once) return;
      once = false;
      server.commit(tx([update(ids[0] as Id, { x: 99 })]));
      server.notify();
    };
    await client.start();
    expect(transport.loads).toBe(2);
    expect(events.some((e) => e.event === "sync_load_inconsistent")).toBe(true);
    await settle();
    expect(converged(client, server)).toBe(true);
  });

  test("a load error is reported, not thrown", async () => {
    const server = new FakeServer(seeded(1).design);
    const transport = new FakeTransport(server);
    transport.load = async () => {
      throw new ConvexLikeError({ code: "NOT_FOUND", message: "Design not found." });
    };
    const { client } = makeClient(server, { transport });
    await client.start();
    expect(client.snapshot().status).toBe("error");
    expect(client.snapshot().error?.code).toBe("NOT_FOUND");
  });
});

describe("SyncClient: commits", () => {
  test("local edits are optimistic, sent with baseSeq and acknowledged", async () => {
    const { design, ids } = seeded();
    const server = new FakeServer(design);
    const { client, transport } = makeClient(server);
    const seen: number[] = [];
    const commit = transport.commit.bind(transport);
    transport.commit = (args) => {
      seen.push(args.baseSeq);
      return commit(args);
    };
    await client.start();
    const r = client.applyLocal(tx([update(ids[0] as Id, { x: 42 })]));
    expect(r.applied).toHaveLength(1);
    expect((viewOf(client).nodes[ids[0] as Id] as Node).x).toBe(42);
    expect(client.pending).toHaveLength(1);
    await until(() => converged(client, server));
    expect(seen).toEqual([0]);
    expect(client.snapshot().status).toBe("live");
    expect(client.seq).toBe(1);
  });

  test("a transaction whose ops all drop is not queued", async () => {
    const server = new FakeServer(seeded().design);
    const { client } = makeClient(server);
    await client.start();
    const r = client.applyLocal(tx([update("missing00000", { x: 1 })]));
    expect(r.dropped).toHaveLength(1);
    expect(client.pending).toHaveLength(0);
  });

  test("remote transactions rebase pending work (last writer wins per property)", async () => {
    const { design, ids } = seeded();
    const id = ids[0] as Id;
    const server = new FakeServer(design);
    const { client, transport } = makeClient(server);
    await client.start();
    transport.hold = true;
    client.applyLocal(tx([update(id, { x: 10 })]));
    await settle();
    server.commit(tx([update(id, { x: 5, y: 20 })]));
    server.notify();
    await settle();
    const node = client.view?.nodes[id] as Node;
    expect(node.x).toBe(10); // own pending value replays over the remote one
    expect(node.y).toBe(20);
    await transport.release();
    await until(() => converged(client, server));
    expect((server.design.nodes[id] as Node).x).toBe(10);
  });

  test("two clients converge under interleaved concurrent edits", async () => {
    const { design, ids, page } = seeded(4);
    const server = new FakeServer(design);
    const a = makeClient(server);
    const b = makeClient(server);
    await a.client.start();
    await b.client.start();
    a.transport.hold = true;
    b.transport.hold = true;
    const created = createRect({ parent: page, name: "New" });
    a.client.applyLocal(tx([{ op: "create", nodes: [created], parent: page }]));
    b.client.applyLocal(
      tx([update(ids[1] as Id, { opacity: 0.5 }), { op: "delete", id: ids[2] as Id }]),
    );
    a.client.applyLocal(tx([update(ids[1] as Id, { opacity: 0.25, name: "A" })]));
    b.client.applyLocal(tx([{ op: "move", id: ids[0] as Id, parent: page, index: 0 }]));
    a.client.applyLocal(tx([update(ids[2] as Id, { x: 1 })])); // deleted by B concurrently
    // Interleave deliveries.
    await b.transport.release();
    await settle();
    await a.transport.release();
    await settle();
    await a.transport.release();
    await settle();
    await b.transport.release();
    // A's last edit targeted the node B deleted: the rebase dropped it, so it is never sent.
    await until(() => converged(a.client, server) && converged(b.client, server));
    expect(a.transport.held).toHaveLength(0);
    expect(a.events.some((e) => e.event === "sync_conflict" && e.props.kind === "rebase")).toBe(
      true,
    );
    expect(server.design.nodes[created.id]).toBeDefined();
    expect(server.design.nodes[ids[2] as Id]).toBeUndefined();
    expect((server.design.nodes[ids[1] as Id] as Node).opacity).toBe(0.25);
  });

  test("an ack that arrives before its echo is folded once", async () => {
    const { design, page } = seeded();
    const server = new FakeServer(design);
    const { client, transport } = makeClient(server);
    transport.ackBeforeEcho = true;
    await client.start();
    const r = createRect({ parent: page });
    client.applyLocal(tx([{ op: "create", nodes: [r], parent: page }]));
    await until(() => converged(client, server));
    const p = client.view?.nodes[page] as Node & { children: Id[] };
    expect(p.children.filter((c) => c === r.id)).toHaveLength(1);
  });

  test("an ack for a later seq waits for the echo so no remote transaction is skipped", async () => {
    const { design, ids } = seeded();
    const server = new FakeServer(design);
    const { client, transport } = makeClient(server);
    await client.start();
    transport.hold = true;
    transport.ackBeforeEcho = true;
    client.applyLocal(tx([update(ids[0] as Id, { x: 7 })]));
    await settle();
    // Another user's commit lands first; its subscription update has not reached us yet.
    server.commit(tx([update(ids[1] as Id, { name: "Remote" })]));
    await transport.release(); // our ack says seq 2 while we are at 0
    await until(() => converged(client, server));
    expect((viewOf(client).nodes[ids[1] as Id] as Node).name).toBe("Remote");
    expect(client.seq).toBe(2);
  });

  test("retries after a lost response reuse the transaction id (applied once)", async () => {
    const { design, ids } = seeded();
    const server = new FakeServer(design);
    const { client, transport, events } = makeClient(server);
    await client.start();
    transport.hold = true;
    const t = tx([update(ids[0] as Id, { rotation: 15 })]);
    client.applyLocal(t);
    await settle();
    transport.hold = false;
    transport.loseResponse();
    await until(() => converged(client, server));
    expect(server.commitCalls.filter((id) => id === t.id)).toHaveLength(2);
    expect(server.seq).toBe(1);
    expect(events.some((e) => e.event === "sync_retry")).toBe(true);
  });

  test("transient failures retry with backoff (RATE_LIMITED waits as told)", async () => {
    const { design, ids } = seeded();
    const server = new FakeServer(design);
    const { client, transport, events } = makeClient(server);
    await client.start();
    transport.failNext(
      new Error("socket closed"),
      new ConvexLikeError({ code: "RATE_LIMITED", message: "Too many", retryAfterMs: 20 }),
    );
    const started = Date.now();
    client.applyLocal(tx([update(ids[0] as Id, { x: 1 })]));
    await until(() => converged(client, server));
    expect(Date.now() - started).toBeGreaterThanOrEqual(19);
    expect(events.filter((e) => e.event === "sync_retry")).toHaveLength(2);
  });

  test("rejected transactions are rolled back and reported", async () => {
    const { design, ids } = seeded();
    const server = new FakeServer(design);
    const { client, transport, events } = makeClient(server);
    await client.start();
    const rejected: string[] = [];
    client.on("rejected", (r) => rejected.push(r.code));
    transport.failNext(new ConvexLikeError({ code: "LIMIT_REACHED", message: "Too many pages" }));
    client.applyLocal(tx([update(ids[0] as Id, { x: 500 })]));
    await settle();
    expect(rejected).toEqual(["LIMIT_REACHED"]);
    expect(client.pending).toHaveLength(0);
    expect((viewOf(client).nodes[ids[0] as Id] as Node).x).toBe(0);
    expect(events.some((e) => e.event === "sync_rejected")).toBe(true);
  });

  test("ops that stop applying are reported as conflicts (rebase and server)", async () => {
    const { design, ids } = seeded();
    const server = new FakeServer(design);
    const { client, transport, events } = makeClient(server);
    await client.start();
    const conflicts: string[] = [];
    client.on("conflict", (c) => conflicts.push(c.kind));
    transport.hold = true;
    client.applyLocal(tx([update(ids[0] as Id, { x: 3 })]));
    await settle();
    server.commit(tx([{ op: "delete", id: ids[0] as Id }]));
    server.notify();
    await settle();
    expect(conflicts).toContain("rebase");
    await transport.release(); // the server drops the update of the deleted node
    await settle();
    expect(conflicts).toContain("server");
    expect(events.filter((e) => e.event === "sync_conflict").length).toBeGreaterThanOrEqual(2);
    await until(() => converged(client, server));
  });

  test("large transactions are split into idempotent chunks", async () => {
    const { design, page } = seeded(0);
    const server = new FakeServer(design);
    const { client, transport } = makeClient(server);
    await client.start();
    const ops: Op[] = Array.from({ length: 3200 }, () => ({
      op: "create",
      nodes: [createRect({ parent: page })],
      parent: page,
    }));
    const t = tx(ops, "Paste");
    transport.hold = true;
    client.applyLocal(t);
    expect(client.pending.map((p) => p.id)[0]).toBe(t.id);
    expect(client.pending).toHaveLength(3);
    transport.hold = false;
    await transport.release();
    await until(() => converged(client, server), 5000);
    expect(server.seq).toBe(3);
  });
});

describe("SyncClient: stream", () => {
  test("a compacted gap reloads the design and keeps pending work", async () => {
    const { design, ids } = seeded();
    const server = new FakeServer(design);
    const { client, transport, events } = makeClient(server);
    await client.start();
    transport.hold = true;
    client.applyLocal(tx([update(ids[0] as Id, { name: "Mine" })]));
    await settle();
    for (let i = 0; i < 3; i++) server.commit(tx([update(ids[1] as Id, { x: i + 1 })]));
    server.compact(server.seq);
    server.notify();
    await until(() => events.some((e) => e.event === "sync_reload" && e.props.reason === "gap"));
    await settle();
    expect(transport.loads).toBe(2);
    expect((viewOf(client).nodes[ids[0] as Id] as Node).name).toBe("Mine");
    expect((viewOf(client).nodes[ids[1] as Id] as Node).x).toBe(3);
    transport.hold = false;
    await transport.release();
    await until(() => converged(client, server));
  });

  test("re-subscribes from the current seq once results grow", async () => {
    const { design, ids } = seeded();
    const server = new FakeServer(design);
    const { client } = makeClient(server, { resubscribeAt: 3 });
    await client.start();
    for (let i = 0; i < 8; i++) {
      server.commit(tx([update(ids[0] as Id, { x: i })]));
      server.notify();
      await settle(2);
    }
    await until(() => converged(client, server));
    expect(server.watcherCount).toBe(1);
    expect(client.seq).toBe(8);
  });

  test("a failed subscription and a commit retry share one timer; both recover", async () => {
    const { design, ids } = seeded();
    const server = new FakeServer(design);
    const { client, transport } = makeClient(server, { retry: { baseMs: 5_000, maxMs: 5_000 } });
    await client.start();
    transport.setOnline(false);
    // A commit fails (retry scheduled), then the log subscription drops too.
    transport.failNext(new Error("socket closed"));
    client.applyLocal(tx([update(ids[0] as Id, { x: 3 })]));
    await settle();
    transport.dropSubscriptions(new Error("socket closed"));
    server.commit(tx([update(ids[1] as Id, { name: "Remote" })]));
    server.notify();
    await settle();
    expect(viewOf(client).nodes[ids[1] as Id]?.name).not.toBe("Remote");
    // A remote change arrived meanwhile: the re-subscription is what brings it in.
    const watchesBefore = transport.watches;
    transport.setOnline(true);
    await until(() => converged(client, server), 1000);
    expect(transport.watches).toBeGreaterThan(watchesBefore);
    expect(viewOf(client).nodes[ids[1] as Id]?.name).toBe("Remote");
  });

  test("connection changes drive the offline status and retry at once on reconnect", async () => {
    const { design, ids } = seeded();
    const server = new FakeServer(design);
    const { client, transport } = makeClient(server, { retry: { baseMs: 5_000, maxMs: 5_000 } });
    await client.start();
    transport.setOnline(false);
    expect(client.snapshot().status).toBe("offline");
    transport.failNext(new Error("offline"));
    client.applyLocal(tx([update(ids[0] as Id, { x: 9 })]));
    await settle();
    expect(client.pending).toHaveLength(1);
    transport.setOnline(true);
    await until(() => converged(client, server), 1000);
    expect(client.snapshot().status).toBe("live");
  });
});

describe("SyncClient: offline queue", () => {
  test("pending edits survive a restart (IndexedDB) and are committed once", async () => {
    const { design, ids } = seeded();
    const server = new FakeServer(design);
    const store = new IndexedDbPendingStore("user1");
    const first = makeClient(server, { pendingStore: store });
    await first.client.start();
    first.transport.hold = true;
    first.client.applyLocal(tx([update(ids[0] as Id, { x: 11 })]));
    first.client.applyLocal(tx([update(ids[1] as Id, { x: 22 })]));
    await settle();
    // The first request reached the server but its response was lost before the tab closed.
    first.transport.loseResponse();
    await first.client.stop();
    expect((await store.load("d1"))?.txs).toHaveLength(2);

    const second = makeClient(server, { pendingStore: store });
    await second.client.start();
    expect(second.events.some((e) => e.event === "sync_queue_restored")).toBe(true);
    await until(() => converged(second.client, server));
    expect((server.design.nodes[ids[0] as Id] as Node).x).toBe(11);
    expect((server.design.nodes[ids[1] as Id] as Node).x).toBe(22);
    expect(server.seq).toBe(2);
    await settle();
    expect(await store.load("d1")).toBeNull();
  });

  test("queues are scoped per user", async () => {
    const a = new IndexedDbPendingStore("alice");
    const b = new IndexedDbPendingStore("bob");
    await a.save({ designId: "dx", baseSeq: 0, txs: [tx([])], savedAt: 1 });
    expect(await b.load("dx")).toBeNull();
    expect((await a.load("dx"))?.txs).toHaveLength(1);
    await a.clear("dx");
    expect(await a.load("dx")).toBeNull();
  });
});
