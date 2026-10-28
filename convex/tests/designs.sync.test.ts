import { validateDesign } from "@desyn/schema";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import { decodeOps, decodeTx } from "../lib/designs_wire";
import {
  firstPageId,
  frame,
  group,
  loadAll,
  makeTx,
  memberWithRole,
  page,
  rect,
  workspaceOf,
} from "./designs.helpers";
import { createUser, errorData, setupTest } from "./harness.helpers";

beforeEach(() => vi.stubEnv("DESYN_EDITION", "selfhost"));
afterEach(() => vi.unstubAllEnvs());

async function newDesign() {
  const t = setupTest();
  const owner = await createUser(t);
  const workspaceId = await workspaceOf(owner);
  const { designId, key } = await owner.as.mutation(api.designs.designs.create, {
    workspaceId,
    kind: "social-post",
    presetId: "instagram-post",
  });
  return { t, owner, workspaceId, designId, key };
}

describe("designs.create / load", () => {
  test("a blank design loads as a valid document with its history", async () => {
    const { owner, designId, key } = await newDesign();
    const { design, seq, consistent } = await loadAll(owner.as, designId);
    expect(design.id).toBe(key);
    expect(design.kind).toBe("social-post");
    expect(validateDesign(design).ok).toBe(true);
    expect(consistent).toBe(true);
    expect(seq).toBeGreaterThan(0);
    const since = await owner.as.query(api.designs.designOps.since, { designId, seq: 0 });
    expect(since.ops.length).toBe(seq);
    expect(since.gap).toBe(false);
    const summary = await owner.as.query(api.designs.designs.get, { designId });
    expect(summary).toMatchObject({
      pageCount: 1,
      permission: "manage",
      state: "active",
      width: 1080,
    });
  });

  test("custom sizes and unknown presets", async () => {
    const t = setupTest();
    const owner = await createUser(t);
    const workspaceId = await workspaceOf(owner);
    const custom = await owner.as.mutation(api.designs.designs.create, {
      workspaceId,
      size: { width: 640, height: 360 },
      name: "Banner",
    });
    expect(
      await owner.as.query(api.designs.designs.get, { designId: custom.designId }),
    ).toMatchObject({
      name: "Banner",
      width: 640,
      height: 360,
      kind: "custom",
    });
    expect(
      (
        await errorData(
          owner.as.mutation(api.designs.designs.create, { workspaceId, presetId: "nope" }),
        )
      ).code,
    ).toBe("INVALID_ARGUMENT");
  });

  test("load paginates nodes in chunks of 500", async () => {
    const { owner, designId } = await newDesign();
    const first = await loadAll(owner.as, designId);
    const pageId = firstPageId(first.design);
    let seq = first.seq;
    for (let batch = 0; batch < 3; batch++) {
      const nodes = Array.from({ length: 250 }, () => rect(pageId));
      const res = await owner.as.mutation(api.designs.designs.commit, {
        designId,
        baseSeq: seq,
        tx: JSON.stringify(
          makeTx(nodes.map((n) => ({ op: "create", nodes: [n], parent: pageId }))),
        ),
      });
      expect(res.dropped).toEqual([]);
      seq = res.seq;
    }
    const loaded = await loadAll(owner.as, designId);
    expect(loaded.pages).toBe(2);
    expect(Object.keys(loaded.design.nodes)).toHaveLength(752);
    expect(validateDesign(loaded.design).ok).toBe(true);
    expect(loaded.seq).toBe(seq);
  });

  test("load pages also end early by size so large nodes stay within query limits", async () => {
    const { owner, designId } = await newDesign();
    const first = await loadAll(owner.as, designId);
    const pageId = firstPageId(first.design);
    const blob = "x".repeat(240_000);
    const ids: string[] = [];
    for (let batch = 0; batch < 10; batch++) {
      const nodes = Array.from({ length: 3 }, () => rect(pageId, { name: "Big", notes: blob }));
      ids.push(...nodes.map((n) => n.id));
      const res = await owner.as.mutation(api.designs.designs.commit, {
        designId,
        tx: JSON.stringify(
          makeTx(nodes.map((n) => ({ op: "create", nodes: [n], parent: pageId }))),
        ),
      });
      expect(res.dropped).toEqual([]);
    }
    const loaded = await loadAll(owner.as, designId);
    expect(loaded.pages).toBeGreaterThan(1);
    for (const id of ids) expect(loaded.design.nodes[id]).toBeDefined();
    expect(validateDesign(loaded.design).ok).toBe(true);
  });
});

describe("designs.commit", () => {
  test("applies ops, advances seq and is visible through since()", async () => {
    const { owner, designId } = await newDesign();
    const { design, seq } = await loadAll(owner.as, designId);
    const pageId = firstPageId(design);
    const node = rect(pageId, { name: "Hero" });
    const tx = makeTx([{ op: "create", nodes: [node], parent: pageId }]);
    const res = await owner.as.mutation(api.designs.designs.commit, {
      designId,
      baseSeq: seq,
      tx: JSON.stringify(tx),
    });
    expect(res).toMatchObject({ seq: seq + 1, dropped: [], duplicate: false });
    expect(decodeOps(res.applied)).toHaveLength(1);
    const since = await owner.as.query(api.designs.designOps.since, { designId, seq });
    expect(since.ops).toHaveLength(1);
    const entry = since.ops[0];
    expect(entry?.txId).toBe(tx.id);
    expect(entry?.actor).toBe(owner.userId);
    expect(decodeTx(entry?.tx ?? "{}").actor?.userId).toBe(owner.userId);
    const after = await loadAll(owner.as, designId);
    expect(after.design.nodes[node.id]?.name).toBe("Hero");
  });

  test("is idempotent on tx.id", async () => {
    const { t, owner, designId } = await newDesign();
    const { design, seq } = await loadAll(owner.as, designId);
    const pageId = firstPageId(design);
    const tx = JSON.stringify(makeTx([{ op: "create", nodes: [rect(pageId)], parent: pageId }]));
    const a = await owner.as.mutation(api.designs.designs.commit, { designId, baseSeq: seq, tx });
    const b = await owner.as.mutation(api.designs.designs.commit, { designId, baseSeq: seq, tx });
    expect(b).toEqual({ ...a, duplicate: true });
    const ops = await t.run(async (ctx) =>
      ctx.db
        .query("designOps")
        .withIndex("by_design_seq", (q) => q.eq("designId", designId).gt("seq", seq))
        .collect(),
    );
    expect(ops).toHaveLength(1);
    expect((await loadAll(owner.as, designId)).seq).toBe(seq + 1);
  });

  test("concurrent commits are serialized in server order with last-writer-wins per property", async () => {
    const { owner, designId } = await newDesign();
    const loaded = await loadAll(owner.as, designId);
    const pageId = firstPageId(loaded.design);
    const node = rect(pageId);
    const created = await owner.as.mutation(api.designs.designs.commit, {
      designId,
      baseSeq: loaded.seq,
      tx: JSON.stringify(makeTx([{ op: "create", nodes: [node], parent: pageId }])),
    });
    const base = created.seq;
    const txA = makeTx([{ op: "update", id: node.id, set: { x: 10, name: "A" } }]);
    const txB = makeTx([{ op: "update", id: node.id, set: { x: 20 } }]);
    const [ra, rb] = await Promise.all([
      owner.as.mutation(api.designs.designs.commit, {
        designId,
        baseSeq: base,
        tx: JSON.stringify(txA),
      }),
      owner.as.mutation(api.designs.designs.commit, {
        designId,
        baseSeq: base,
        tx: JSON.stringify(txB),
      }),
    ]);
    expect(new Set([ra.seq, rb.seq])).toEqual(new Set([base + 1, base + 2]));
    const final = (await loadAll(owner.as, designId)).design.nodes[node.id] as {
      x: number;
      name: string;
    };
    const lastX = ra.seq > rb.seq ? 10 : 20;
    expect(final.x).toBe(lastX);
    expect(final.name).toBe("A");
    const since = await owner.as.query(api.designs.designOps.since, { designId, seq: base });
    expect(since.ops.map((o) => o.seq)).toEqual([base + 1, base + 2]);
  });

  test("reports dropped ops; fully dropped transactions still get a seq and an empty echo", async () => {
    const { owner, designId } = await newDesign();
    const { design, seq } = await loadAll(owner.as, designId);
    const pageId = firstPageId(design);
    const node = rect(pageId);
    const res = await owner.as.mutation(api.designs.designs.commit, {
      designId,
      baseSeq: seq,
      tx: JSON.stringify(
        makeTx([
          { op: "update", id: "missingnode1", set: { x: 1 } },
          { op: "create", nodes: [node], parent: pageId },
          { op: "move", id: pageId, parent: node.id },
          { op: "update", id: node.id, set: { id: "zzzzzzzzzzzz" } },
        ]),
      ),
    });
    expect(res.dropped).toEqual([
      { index: 0, reason: "missing-node" },
      { index: 2, reason: "not-container" },
      { index: 3, reason: "immutable-field" },
    ]);
    expect(decodeOps(res.applied)).toHaveLength(1);
    const noopTx = JSON.stringify(makeTx([{ op: "delete", id: "missingnode1" }]));
    const none = await owner.as.mutation(api.designs.designs.commit, {
      designId,
      baseSeq: res.seq,
      tx: noopTx,
    });
    expect(none).toMatchObject({
      seq: res.seq + 1,
      applied: "[]",
      dropped: [{ index: 0, reason: "missing-node" }],
      duplicate: false,
    });
    const echo = await owner.as.query(api.designs.designOps.since, { designId, seq: res.seq });
    expect(decodeTx(echo.ops[0]?.tx ?? "{}").ops).toEqual([]);
    const retry = await owner.as.mutation(api.designs.designs.commit, { designId, tx: noopTx });
    expect(retry).toMatchObject({ seq: res.seq + 1, duplicate: true });
  });

  test("cycles are dropped even when the ancestor chain is not part of the transaction", async () => {
    const { owner, designId } = await newDesign();
    const { design, seq } = await loadAll(owner.as, designId);
    const pageId = firstPageId(design);
    const outer = frame(pageId);
    const outerId = outer.id;
    const created = await owner.as.mutation(api.designs.designs.commit, {
      designId,
      baseSeq: seq,
      tx: JSON.stringify(makeTx([{ op: "create", nodes: [outer], parent: pageId }])),
    });
    expect(created.dropped).toEqual([]);
    const inner = group(outerId);
    const r2 = await owner.as.mutation(api.designs.designs.commit, {
      designId,
      baseSeq: created.seq,
      tx: JSON.stringify(makeTx([{ op: "create", nodes: [inner], parent: outerId }])),
    });
    expect(r2.dropped).toEqual([]);
    const cyc = await owner.as.mutation(api.designs.designs.commit, {
      designId,
      baseSeq: r2.seq,
      tx: JSON.stringify(makeTx([{ op: "move", id: outerId, parent: inner.id }])),
    });
    expect(cyc.dropped).toEqual([{ index: 0, reason: "cycle" }]);
  });

  test("moves across pages update page ids of the whole subtree; deletes remove subtrees", async () => {
    const { t, owner, designId } = await newDesign();
    const { design, seq } = await loadAll(owner.as, designId);
    const pageA = firstPageId(design);
    const pageB = page({ name: "Page 2" });
    const g = group(pageA);
    const child = rect(g.id);
    g.children = [child.id];
    const r1 = await owner.as.mutation(api.designs.designs.commit, {
      designId,
      baseSeq: seq,
      tx: JSON.stringify(
        makeTx([
          { op: "create", nodes: [pageB], parent: "root" },
          { op: "create", nodes: [g, child], parent: pageA },
        ]),
      ),
    });
    expect(r1.dropped).toEqual([]);
    expect((await owner.as.query(api.designs.designs.get, { designId })).pageCount).toBe(2);
    const r2 = await owner.as.mutation(api.designs.designs.commit, {
      designId,
      baseSeq: r1.seq,
      tx: JSON.stringify(makeTx([{ op: "move", id: g.id, parent: pageB.id }])),
    });
    expect(r2.dropped).toEqual([]);
    const pageIds = await t.run(async (ctx) => {
      const rows = await ctx.db
        .query("nodes")
        .withIndex("by_design_page", (q) => q.eq("designId", designId).eq("pageId", pageB.id))
        .collect();
      return rows.map((r) => r.nodeId).sort();
    });
    expect(pageIds).toEqual([pageB.id, g.id, child.id].sort());
    const r3 = await owner.as.mutation(api.designs.designs.commit, {
      designId,
      baseSeq: r2.seq,
      tx: JSON.stringify(makeTx([{ op: "delete", id: pageB.id }])),
    });
    expect(r3.dropped).toEqual([]);
    const loaded = await loadAll(owner.as, designId);
    expect(loaded.design.nodes[child.id]).toBeUndefined();
    expect(loaded.design.nodes[g.id]).toBeUndefined();
    expect(validateDesign(loaded.design).ok).toBe(true);
    expect((await owner.as.query(api.designs.designs.get, { designId })).pageCount).toBe(1);
    const seqDoc = await t.run(async (ctx) =>
      ctx.db
        .query("designSeq")
        .withIndex("by_design", (q) => q.eq("designId", designId))
        .unique(),
    );
    expect(seqDoc?.nodeCount).toBe(Object.keys(loaded.design.nodes).length);
  });

  test("page ids stay right when one transaction moves a subtree several times", async () => {
    const { t, owner, designId } = await newDesign();
    const { design, seq } = await loadAll(owner.as, designId);
    const pageA = firstPageId(design);
    const pageB = page({ name: "Page 2" });
    // pageA > outer > inner > leaf, plus a frame on pageA to move `inner` into.
    const outer = group(pageA);
    const inner = group(outer.id);
    const leaf = rect(inner.id);
    inner.children = [leaf.id];
    outer.children = [inner.id];
    const holder = frame(pageA);
    const r1 = await owner.as.mutation(api.designs.designs.commit, {
      designId,
      baseSeq: seq,
      tx: JSON.stringify(
        makeTx([
          { op: "create", nodes: [pageB], parent: "root" },
          { op: "create", nodes: [outer, inner, leaf], parent: pageA },
          { op: "create", nodes: [holder], parent: pageA },
        ]),
      ),
    });
    expect(r1.dropped).toEqual([]);
    const pagesOf = async () =>
      await t.run(async (ctx) => {
        const rows = await ctx.db
          .query("nodes")
          .withIndex("by_design_node", (q) => q.eq("designId", designId))
          .collect();
        return Object.fromEntries(rows.map((r) => [r.nodeId, r.pageId]));
      });

    // There and back again in one transaction: everything ends on page A.
    const r2 = await owner.as.mutation(api.designs.designs.commit, {
      designId,
      baseSeq: r1.seq,
      tx: JSON.stringify(
        makeTx([
          { op: "move", id: outer.id, parent: pageB.id },
          { op: "move", id: outer.id, parent: pageA },
        ]),
      ),
    });
    expect(r2.dropped).toEqual([]);
    let pages = await pagesOf();
    expect([pages[outer.id], pages[inner.id], pages[leaf.id]]).toEqual([pageA, pageA, pageA]);

    // Move the subtree to page B, then pull its child back into a frame on page A.
    const r3 = await owner.as.mutation(api.designs.designs.commit, {
      designId,
      baseSeq: r2.seq,
      tx: JSON.stringify(
        makeTx([
          { op: "move", id: outer.id, parent: pageB.id },
          { op: "move", id: inner.id, parent: holder.id },
        ]),
      ),
    });
    expect(r3.dropped).toEqual([]);
    pages = await pagesOf();
    expect(pages[outer.id]).toBe(pageB.id);
    expect([pages[inner.id], pages[leaf.id]]).toEqual([pageA, pageA]);

    // Move a node into a subtree, then move that subtree to the other page.
    const r4 = await owner.as.mutation(api.designs.designs.commit, {
      designId,
      baseSeq: r3.seq,
      tx: JSON.stringify(
        makeTx([
          { op: "move", id: inner.id, parent: outer.id },
          { op: "move", id: outer.id, parent: holder.id },
        ]),
      ),
    });
    expect(r4.dropped).toEqual([]);
    pages = await pagesOf();
    expect([pages[outer.id], pages[inner.id], pages[leaf.id]]).toEqual([pageA, pageA, pageA]);
  });

  test("asset, styles and doc ops update design-level state", async () => {
    const { owner, designId } = await newDesign();
    const { seq } = await loadAll(owner.as, designId);
    const res = await owner.as.mutation(api.designs.designs.commit, {
      designId,
      baseSeq: seq,
      tx: JSON.stringify(
        makeTx([
          { op: "styles", path: ["variables", "brand.primary"], value: "#ffb02e" },
          { op: "doc", set: { name: "Launch post", meta: { tags: ["launch"] } } },
          {
            op: "asset",
            set: { aaaaaaaaaaaa: { id: "aaaaaaaaaaaa", kind: "image", mime: "image/png" } },
          },
        ]),
      ),
    });
    expect(res.dropped).toEqual([]);
    const loaded = await loadAll(owner.as, designId);
    expect(loaded.design.name).toBe("Launch post");
    expect(loaded.design.styles.variables["brand.primary"]).toBe("#ffb02e");
    expect(loaded.design.assets.aaaaaaaaaaaa?.mime).toBe("image/png");
    expect((await owner.as.query(api.designs.designs.get, { designId })).name).toBe("Launch post");
  });

  test("color refs with $-keys survive the JSON wire format", async () => {
    const { owner, designId } = await newDesign();
    const { design, seq } = await loadAll(owner.as, designId);
    const pageId = firstPageId(design);
    const node = rect(pageId, {
      fills: [{ type: "solid", color: { $var: "brand.primary" } }],
    } as never);
    const res = await owner.as.mutation(api.designs.designs.commit, {
      designId,
      baseSeq: seq,
      tx: JSON.stringify(makeTx([{ op: "create", nodes: [node], parent: pageId }])),
    });
    expect(res.dropped).toEqual([]);
    const loaded = await loadAll(owner.as, designId);
    expect((loaded.design.nodes[node.id] as { fills: unknown[] }).fills[0]).toEqual({
      type: "solid",
      color: { $var: "brand.primary" },
    });
  });

  test("inline SVG markup is sanitized; unusable markup is dropped as invalid-value", async () => {
    const { owner, designId } = await newDesign();
    const { design, seq } = await loadAll(owner.as, designId);
    const pageId = firstPageId(design);
    const base = { ...rect(pageId), type: "svg" } as Record<string, unknown>;
    delete base.fills;
    delete base.strokes;
    delete base.cornerRadius;
    const svg: Record<string, unknown> = {
      ...base,
      markup:
        '<svg viewBox="0 0 10 10" onload="alert(1)"><script>alert(1)</script><rect width="10" height="10"/></svg>',
    };
    const bad = { ...base, id: "badsvgnode01", markup: "<html><body>not svg</body></html>" };
    const res = await owner.as.mutation(api.designs.designs.commit, {
      designId,
      baseSeq: seq,
      tx: JSON.stringify(
        makeTx([
          { op: "create", nodes: [svg as never], parent: pageId },
          { op: "create", nodes: [bad as never], parent: pageId },
        ]),
      ),
    });
    expect(res.dropped).toEqual([{ index: 1, reason: "invalid-value" }]);
    const stored = (await loadAll(owner.as, designId)).design.nodes[
      svg.id as string
    ] as unknown as { markup: string };
    expect(stored.markup).not.toContain("script");
    expect(stored.markup).not.toContain("onload");
    expect(stored.markup).toContain("<rect");
  });

  test("rejects malformed envelopes and oversized nodes", async () => {
    const { owner, designId } = await newDesign();
    const { design, seq } = await loadAll(owner.as, designId);
    const pageId = firstPageId(design);
    expect(
      (
        await errorData(
          owner.as.mutation(api.designs.designs.commit, { designId, tx: "{not json" }),
        )
      ).code,
    ).toBe("INVALID_ARGUMENT");
    expect(
      (
        await errorData(
          owner.as.mutation(api.designs.designs.commit, {
            designId,
            tx: JSON.stringify({ ...makeTx([]), id: "x" }),
          }),
        )
      ).code,
    ).toBe("INVALID_ARGUMENT");
    expect(
      (
        await errorData(
          owner.as.mutation(api.designs.designs.commit, {
            designId,
            baseSeq: seq + 5,
            tx: JSON.stringify(makeTx([])),
          }),
        )
      ).code,
    ).toBe("INVALID_ARGUMENT");
    const huge = rect(pageId, { name: "x".repeat(300_000) });
    expect(
      (
        await errorData(
          owner.as.mutation(api.designs.designs.commit, {
            designId,
            tx: JSON.stringify(makeTx([{ op: "create", nodes: [huge], parent: pageId }])),
          }),
        )
      ).code,
    ).toBe("INVALID_ARGUMENT");
  });

  test("rename goes through the log", async () => {
    const { owner, designId } = await newDesign();
    const { seq } = await loadAll(owner.as, designId);
    await owner.as.mutation(api.designs.designs.rename, { designId, name: "  Spring   sale " });
    const since = await owner.as.query(api.designs.designOps.since, { designId, seq });
    expect(decodeTx(since.ops[0]?.tx ?? "{}").ops).toEqual([
      { op: "doc", set: { name: "Spring sale" } },
    ]);
    expect((await owner.as.query(api.designs.designs.get, { designId })).name).toBe("Spring sale");
  });

  test("commitAs lets trusted backends commit for a verified editor", async () => {
    const { t, owner, workspaceId, designId } = await newDesign();
    const { design, seq } = await loadAll(owner.as, designId);
    const pageId = firstPageId(design);
    const viewer = await memberWithRole(t, workspaceId, "viewer");
    const tx = JSON.stringify(
      makeTx([{ op: "create", nodes: [rect(pageId)], parent: pageId }], {
        source: "ai",
        actor: { runId: "run1" },
      }),
    );
    const res = await t.mutation(internal.designs.designs.commitAs, {
      designId,
      userId: owner.userId,
      baseSeq: seq,
      tx,
    });
    expect(res.dropped).toEqual([]);
    expect(
      (
        await errorData(
          t.mutation(internal.designs.designs.commitAs, {
            designId,
            userId: viewer.userId,
            tx: JSON.stringify(makeTx([])),
          }),
        )
      ).code,
    ).toBe("FORBIDDEN");
    const entry = (await owner.as.query(api.designs.designOps.since, { designId, seq })).ops[0];
    expect(decodeTx(entry?.tx ?? "{}")).toMatchObject({
      source: "ai",
      actor: { runId: "run1", userId: owner.userId },
    });
  });
});

describe("designOps.since", () => {
  test("pages at 200 entries and reports compaction gaps", async () => {
    const { t, owner, designId } = await newDesign();
    const { design, seq } = await loadAll(owner.as, designId);
    const pageId = firstPageId(design);
    let current = seq;
    for (let i = 0; i < 205; i++) {
      const res = await owner.as.mutation(api.designs.designs.commit, {
        designId,
        baseSeq: current,
        tx: JSON.stringify(
          makeTx([{ op: "patch", id: pageId, path: ["name"], value: `Page ${i}` }]),
        ),
      });
      current = res.seq;
    }
    const first = await owner.as.query(api.designs.designOps.since, { designId, seq });
    expect(first.ops).toHaveLength(200);
    expect(first.hasMore).toBe(true);
    expect(first.latestSeq).toBe(seq + 200);
    const rest = await owner.as.query(api.designs.designOps.since, {
      designId,
      seq: first.latestSeq,
    });
    expect(rest.ops).toHaveLength(5);
    expect(rest.hasMore).toBe(false);
    // Simulate compaction of old entries.
    await t.run(async (ctx) => {
      const rows = await ctx.db
        .query("designOps")
        .withIndex("by_design_seq", (q) => q.eq("designId", designId).lte("seq", seq + 10))
        .collect();
      for (const row of rows) await ctx.db.delete("designOps", row._id);
    });
    const gap = await owner.as.query(api.designs.designOps.since, { designId, seq });
    expect(gap.gap).toBe(true);

    // An idle design's whole log can be compacted behind its snapshot: a client still at an old seq
    // finds no entries at all and must still be told to reload.
    await t.run(async (ctx) => {
      const rows = await ctx.db
        .query("designOps")
        .withIndex("by_design_seq", (q) => q.eq("designId", designId))
        .collect();
      for (const row of rows) await ctx.db.delete("designOps", row._id);
    });
    const empty = await owner.as.query(api.designs.designOps.since, { designId, seq });
    expect(empty).toMatchObject({ ops: [], gap: true, latestSeq: current });
    const upToDate = await owner.as.query(api.designs.designOps.since, { designId, seq: current });
    expect(upToDate).toMatchObject({ ops: [], gap: false, latestSeq: current });
  });
});
