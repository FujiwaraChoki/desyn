import { canonicalize, createRect, type Design, type Transaction } from "@desyn/schema";
import { describe, expect, test } from "vitest";
import {
  acknowledge,
  applyTransaction,
  coalesceOps,
  commitLocal,
  compose,
  createSyncState,
  rebase,
  receiveRemote,
  replayPending,
} from "../src";
import { randomDesign, randomOps } from "./helpers";

const tx = (id: string, ops: unknown[], extra: Partial<Transaction> = {}): Transaction =>
  ({ id, label: id, ops, source: "user", ts: 1, ...extra }) as Transaction;

function page(d: Design): string {
  return (d.nodes.root as { children: string[] }).children[0] as string;
}

describe("compose", () => {
  test("equals sequential application when every op applies", () => {
    for (let seed = 1; seed <= 100; seed++) {
      const d = randomDesign(seed);
      const t1 = applyTransaction(d, tx("aaaaaaaaaaaa", randomOps(d, seed, 8)));
      const s1 = tx("aaaaaaaaaaaa", t1.applied);
      const t2 = applyTransaction(
        t1.design,
        tx("bbbbbbbbbbbb", randomOps(t1.design, seed + 99, 8)),
      );
      const s2 = tx("bbbbbbbbbbbb", t2.applied, { ts: 9, label: "second" });
      const c = compose([s1, s2], { id: "cccccccccccc" });
      const r = applyTransaction(d, c);
      expect(r.dropped, `seed ${seed}`).toEqual([]);
      expect(canonicalize(r.design), `seed ${seed}`).toBe(canonicalize(t2.design));
      expect(c.ts).toBe(9);
      expect(c.label).toBe("aaaaaaaaaaaa");
      const raw = compose([s1, s2], { coalesce: false });
      expect(raw.ops).toHaveLength(s1.ops.length + s2.ops.length);
    }
  });

  test("coalesces adjacent updates, same-path patches and edits before a delete", () => {
    expect(
      coalesceOps([
        { op: "update", id: "a", set: { x: 1, y: 1 }, unset: ["alt"] },
        { op: "update", id: "a", set: { alt: "z" }, unset: ["y"] },
      ]),
    ).toEqual([{ op: "update", id: "a", set: { x: 1, alt: "z" }, unset: ["y"] }]);
    expect(
      coalesceOps([
        { op: "patch", id: "a", path: ["fills", 0], value: 1 },
        { op: "patch", id: "a", path: ["fills", 0], value: 2 },
        { op: "patch", id: "a", path: ["fills", 1], value: 3 },
      ]),
    ).toEqual([
      { op: "patch", id: "a", path: ["fills", 0], value: 2 },
      { op: "patch", id: "a", path: ["fills", 1], value: 3 },
    ]);
    expect(
      coalesceOps([
        { op: "update", id: "a", set: { x: 1 } },
        { op: "patch", id: "a", path: ["y"], value: 2 },
        { op: "delete", id: "a" },
      ]),
    ).toEqual([{ op: "delete", id: "a" }]);
    expect(() => compose([])).toThrow();
  });

  test("keeps actor and source of the first transaction", () => {
    const c = compose([
      tx("aaaaaaaaaaaa", [], { source: "ai", actor: { runId: "r" } }),
      tx("bbbbbbbbbbbb", []),
    ]);
    expect(c.source).toBe("ai");
    expect(c.actor).toEqual({ runId: "r" });
    expect(c.id).toMatch(/^[a-z0-9]{12}$/);
  });
});

describe("client sync model", () => {
  test("rebase applies remote first and drops pending ops that no longer apply", () => {
    const d = randomDesign(21);
    const p = page(d);
    const local = tx("localtxlocal", [
      { op: "create", nodes: [createRect({ id: "rectrectrect", parent: p })], parent: p },
      { op: "update", id: "rectrectrect", set: { name: "mine" } },
    ]);
    const remote = tx("remotetxremo", [{ op: "delete", id: p }]);
    const r = rebase(d, [local], remote);
    expect(r.confirmed.nodes[p]).toBeUndefined();
    expect(r.pending[0]?.ops).toEqual([]);
    expect(r.dropped[0]?.txId).toBe("localtxlocal");
    expect(r.dropped[0]?.dropped.map((x) => x.index)).toEqual([0, 1]);
    expect(r.view).toBe(r.confirmed);
  });

  test("pending ops keep their original form (no index rewriting)", () => {
    const d = randomDesign(22);
    const p = page(d);
    const local = tx("localtxlocal", [
      { op: "create", nodes: [createRect({ id: "rectrectrect", parent: p })], parent: p },
    ]);
    const remote = tx("remotetxremo", [
      { op: "create", nodes: [createRect({ id: "remoteremote", parent: p })], parent: p },
    ]);
    const r = rebase(d, [local], remote);
    expect(r.pending[0]).toBe(local);
    const kids = (r.view.nodes[p] as { children: string[] }).children;
    expect(kids.slice(-2)).toEqual(["remoteremote", "rectrectrect"]);
  });

  test("commit, echo-as-ack and remote interleaving converge with the server", () => {
    for (let seed = 1; seed <= 60; seed++) {
      const base = randomDesign(seed);
      let server = base;
      let seq = 0;
      let client = createSyncState(base, 0);
      // client makes two local edits
      const l1 = tx("local1local1", randomOps(client.view, seed, 5));
      client = commitLocal(client, l1);
      const l2 = tx("local2local2", randomOps(client.view, seed + 1, 5));
      client = commitLocal(client, l2);
      // another user commits first
      const remote = tx("remote1remot", randomOps(server, seed + 2, 5));
      const sr = applyTransaction(server, remote);
      server = sr.design;
      client = receiveRemote(client, { ...remote, ops: sr.applied }, ++seq);
      // server processes l1 then l2 (against current state), echoing them back
      for (const l of [l1, l2]) {
        const r = applyTransaction(server, l);
        server = r.design;
        client = receiveRemote(client, { ...l, ops: r.applied }, ++seq);
      }
      expect(client.pending).toEqual([]);
      expect(client.seq).toBe(3);
      expect(canonicalize(client.confirmed), `seed ${seed}`).toBe(canonicalize(server));
      expect(canonicalize(client.view)).toBe(canonicalize(server));
    }
  });

  test("acknowledge and duplicate sequence numbers", () => {
    const d = randomDesign(23);
    const p = page(d);
    const t = tx("localtxlocal", [{ op: "update", id: p, set: { name: "x" } }]);
    let s = commitLocal(createSyncState(d, 4), t);
    expect(s.view.nodes[p]?.name).toBe("x");
    expect(acknowledge(s, "unknownunkno", [], 5)).toBe(s);
    expect(acknowledge(s, t.id, t.ops, 4)).toBe(s);
    s = acknowledge(s, t.id, t.ops, 5);
    expect(s.pending).toEqual([]);
    expect(s.confirmed.nodes[p]?.name).toBe("x");
    expect(receiveRemote(s, tx("oldoldoldold", []), 5)).toBe(s);
  });

  test("an ack that skips unseen remote transactions waits for the stream (no lost remote tx)", () => {
    for (let seed = 1; seed <= 40; seed++) {
      const base = randomDesign(100 + seed);
      let server = base;
      let client = createSyncState(base, 0);
      const local = tx("local1local1", randomOps(client.view, seed, 4));
      client = commitLocal(client, local);
      // Another user's transaction becomes seq 1 on the server; ours becomes seq 2.
      const remote = tx("remote1remot", randomOps(server, seed + 7, 4));
      const sr = applyTransaction(server, remote);
      server = sr.design;
      const lr = applyTransaction(server, local);
      server = lr.design;
      // The commit mutation returns (seq 2) before the stream delivers seq 1.
      const acked = acknowledge(client, local.id, lr.applied, 2);
      expect(acked).toBe(client);
      // The stream then delivers seq 1 and our own echo as seq 2.
      client = receiveRemote(acked, { ...remote, ops: sr.applied }, 1);
      client = receiveRemote(client, { ...local, ops: lr.applied }, 2);
      expect(client.pending).toEqual([]);
      expect(client.seq).toBe(2);
      expect(canonicalize(client.confirmed), `seed ${seed}`).toBe(canonicalize(server));
      expect(canonicalize(client.view)).toBe(canonicalize(server));
    }
  });

  test("replayPending", () => {
    const d = randomDesign(24);
    const r = replayPending(d, []);
    expect(r.view).toBe(d);
    expect(r.pending).toEqual([]);
  });
});
