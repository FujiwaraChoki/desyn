import { canonicalize, validateDesign } from "@desyn/schema";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import { firstPageId, loadAll, makeTx, memberWithRole, rect, workspaceOf } from "./designs.helpers";
import { createUser, errorData, setupTest } from "./harness.helpers";

beforeEach(() => vi.stubEnv("DESYN_EDITION", "selfhost"));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

async function fixture() {
  const t = setupTest();
  const owner = await createUser(t);
  const workspaceId = await workspaceOf(owner);
  const { designId } = await owner.as.mutation(api.designs.designs.create, {
    workspaceId,
    kind: "flyer",
  });
  return { t, owner, workspaceId, designId };
}

describe("snapshots", () => {
  test("an on-demand snapshot captures the current state and later states replay from it", async () => {
    const { t, owner, designId } = await fixture();
    const loaded = await loadAll(owner.as, designId);
    const pageId = firstPageId(loaded.design);
    const res = await owner.as.mutation(api.designs.designs.commit, {
      designId,
      tx: JSON.stringify(
        makeTx([{ op: "create", nodes: [rect(pageId, { name: "A" })], parent: pageId }]),
      ),
    });
    const snap = await owner.as.action(api.designs.designs.snapshot, { designId });
    expect(snap?.seq).toBe(res.seq);
    expect(snap?.key).toMatch(/^cs:/); // no S3 in tests: Convex file storage
    expect(await owner.as.action(api.designs.designs.snapshot, { designId })).toBeNull(); // nothing new
    const design = await t.run(async (ctx) => ctx.db.get("designs", designId));
    expect(design?.snapshot).toEqual({ key: snap?.key, seq: res.seq });

    // A version created after more edits is rebuilt from the snapshot + the log after it.
    await owner.as.mutation(api.designs.designs.commit, {
      designId,
      tx: JSON.stringify(
        makeTx([{ op: "create", nodes: [rect(pageId, { name: "B" })], parent: pageId }]),
      ),
    });
    vi.useFakeTimers();
    const versionId = await owner.as.mutation(api.designs.versions.create, {
      designId,
      name: "Two shapes",
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    vi.useRealTimers();
    const preview = await owner.as.action(api.designs.versions.get, { versionId });
    const current = await loadAll(owner.as, designId);
    expect(canonicalize(JSON.parse(preview.design))).toBe(canonicalize(current.design));
  });

  test("commits schedule an auto snapshot (idle timer) once", async () => {
    const { t, owner, designId } = await fixture();
    const loaded = await loadAll(owner.as, designId);
    const pageId = firstPageId(loaded.design);
    for (let i = 0; i < 3; i++) {
      await owner.as.mutation(api.designs.designs.commit, {
        designId,
        tx: JSON.stringify(makeTx([{ op: "create", nodes: [rect(pageId)], parent: pageId }])),
      });
    }
    const scheduled = await t.run(async (ctx) =>
      (await ctx.db.system.query("_scheduled_functions").collect()).filter((f) =>
        f.name.includes("snapshotNode"),
      ),
    );
    expect(scheduled).toHaveLength(1);
  });

  test("a schedule marker left behind by a dead action does not block auto snapshots", async () => {
    const { t, owner, designId } = await fixture();
    const loaded = await loadAll(owner.as, designId);
    const pageId = firstPageId(loaded.design);
    const commit = async () =>
      await owner.as.mutation(api.designs.designs.commit, {
        designId,
        tx: JSON.stringify(makeTx([{ op: "create", nodes: [rect(pageId)], parent: pageId }])),
      });
    await commit();
    // Simulate the scheduled snapshot action dying (timeout) without clearing its marker an hour ago.
    const stale = Date.now() - 60 * 60_000;
    await t.run(async (ctx) => {
      for (const job of await ctx.db.system.query("_scheduled_functions").collect()) {
        await ctx.scheduler.cancel(job._id);
      }
      const seqDoc = await ctx.db
        .query("designSeq")
        .withIndex("by_design", (q) => q.eq("designId", designId))
        .unique();
      if (seqDoc) await ctx.db.patch("designSeq", seqDoc._id, { snapshotAt: stale });
    });
    await commit();
    const { seqDoc, pending } = await t.run(async (ctx) => ({
      seqDoc: await ctx.db
        .query("designSeq")
        .withIndex("by_design", (q) => q.eq("designId", designId))
        .unique(),
      pending: (await ctx.db.system.query("_scheduled_functions").collect()).filter(
        (f) => f.name.includes("snapshotNode") && f.state.kind === "pending",
      ),
    }));
    expect(seqDoc?.snapshotAt).toBeGreaterThan(Date.now());
    expect(pending).toHaveLength(1);
  });

  test("compaction trims covered log entries older than the retention window", async () => {
    const { t, owner, designId } = await fixture();
    const loaded = await loadAll(owner.as, designId);
    const pageId = firstPageId(loaded.design);
    await owner.as.mutation(api.designs.designs.commit, {
      designId,
      tx: JSON.stringify(makeTx([{ op: "create", nodes: [rect(pageId)], parent: pageId }])),
    });
    const snap = await owner.as.action(api.designs.designs.snapshot, { designId });
    // Age every entry beyond 30 days.
    await t.run(async (ctx) => {
      for (const row of await ctx.db
        .query("designOps")
        .withIndex("by_design_seq", (q) => q.eq("designId", designId))
        .collect()) {
        await ctx.db.patch("designOps", row._id, { ts: Date.now() - 31 * 24 * 60 * 60_000 });
      }
    });
    await owner.as.mutation(api.designs.designs.commit, {
      designId,
      tx: JSON.stringify(makeTx([{ op: "create", nodes: [rect(pageId)], parent: pageId }])),
    });
    const result = await t.mutation(internal.designs.maintenance.compactOps, {});
    expect(result.trimmed).toBe(snap?.seq);
    const since = await owner.as.query(api.designs.designOps.since, { designId, seq: 0 });
    expect(since.gap).toBe(true);
    // The design is still fully rebuildable (snapshot + remaining log) and loadable.
    const json = await t.action(internal.designs.snapshotNode.run, { designId, reason: "manual" });
    expect(json?.seq).toBe((snap?.seq ?? 0) + 1);
    expect(validateDesign((await loadAll(owner.as, designId)).design).ok).toBe(true);
  });
});

describe("versions", () => {
  test("restore commits the diff back to the version and saves a restore point", async () => {
    const { t, owner, designId } = await fixture();
    const loaded = await loadAll(owner.as, designId);
    const pageId = firstPageId(loaded.design);
    const keep = rect(pageId, { name: "Keep" });
    await owner.as.mutation(api.designs.designs.commit, {
      designId,
      tx: JSON.stringify(makeTx([{ op: "create", nodes: [keep], parent: pageId }])),
    });
    vi.useFakeTimers();
    const versionId = await owner.as.mutation(api.designs.versions.create, {
      designId,
      name: "Before changes",
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    vi.useRealTimers();
    const atVersion = await loadAll(owner.as, designId);
    const versions = await owner.as.query(api.designs.versions.list, { designId });
    expect(versions[0]).toMatchObject({
      id: versionId,
      status: "ready",
      name: "Before changes",
      auto: false,
    });

    const extra = rect(pageId, { name: "Extra" });
    await owner.as.mutation(api.designs.designs.commit, {
      designId,
      tx: JSON.stringify(
        makeTx([
          { op: "create", nodes: [extra], parent: pageId },
          { op: "update", id: keep.id, set: { x: 400, name: "Moved" } },
          { op: "doc", set: { name: "Renamed" } },
        ]),
      ),
    });
    const before = await loadAll(owner.as, designId);
    const restored = await owner.as.action(api.designs.designs.restoreVersion, { versionId });
    expect(restored.seq).toBeGreaterThan(before.seq);
    const after = await loadAll(owner.as, designId);
    expect(canonicalize(after.design)).toBe(canonicalize(atVersion.design));
    expect(after.design.nodes[extra.id]).toBeUndefined();
    expect(after.design.name).toBe(atVersion.design.name);
    const list = await owner.as.query(api.designs.versions.list, { designId });
    expect(list.find((v) => v.auto)?.name).toBe('Before restoring "Before changes"');
    // The restore is one undoable group for clients (shared runId).
    const entries = await owner.as.query(api.designs.designOps.since, {
      designId,
      seq: before.seq,
    });
    expect(entries.ops.length).toBeGreaterThan(0);
  });

  test("version history is a plan feature and viewers cannot restore", async () => {
    const { t, owner, workspaceId, designId } = await fixture();
    const viewer = await memberWithRole(t, workspaceId, "viewer");
    vi.useFakeTimers();
    const versionId = await owner.as.mutation(api.designs.versions.create, {
      designId,
      name: "v1",
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    vi.useRealTimers();
    expect(
      (await errorData(viewer.as.action(api.designs.versions.restore, { versionId }))).code,
    ).toBe("FORBIDDEN");
    expect((await viewer.as.query(api.designs.versions.list, { designId })).length).toBe(1);
    await owner.as.mutation(api.designs.versions.rename, { versionId, name: "Final" });
    expect((await owner.as.query(api.designs.versions.list, { designId }))[0]?.name).toBe("Final");
    await owner.as.mutation(api.designs.versions.remove, { versionId });
    expect(await owner.as.query(api.designs.versions.list, { designId })).toEqual([]);

    vi.stubEnv("DESYN_EDITION", "hosted");
    expect(
      await errorData(owner.as.mutation(api.designs.versions.create, { designId, name: "Nope" })),
    ).toMatchObject({ code: "FEATURE_UNAVAILABLE", feature: "versionHistory" });
  });

  test("versions older than the plan's versionHistoryDays are hidden and cannot be restored", async () => {
    const { t, owner, designId } = await fixture();
    vi.useFakeTimers();
    // One at a time: convex-test cannot run two storage-writing actions concurrently.
    const oldId = await owner.as.mutation(api.designs.versions.create, { designId, name: "Old" });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const newId = await owner.as.mutation(api.designs.versions.create, { designId, name: "New" });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    vi.useRealTimers();
    await t.run(async (ctx) => {
      await ctx.db.patch("versions", oldId, { createdAt: Date.now() - 100 * 24 * 60 * 60_000 });
    });
    // Self-host: unlimited history.
    expect((await owner.as.query(api.designs.versions.list, { designId })).length).toBe(2);

    // Hosted Pro keeps 90 days.
    vi.stubEnv("DESYN_EDITION", "hosted");
    await t.run(async (ctx) => {
      const profile = await ctx.db
        .query("profiles")
        .withIndex("by_userId", (q) => q.eq("userId", owner.userId))
        .unique();
      if (profile) await ctx.db.patch("profiles", profile._id, { plan: "pro" });
    });
    const visible = await owner.as.query(api.designs.versions.list, { designId });
    expect(visible.map((x) => x.id)).toEqual([newId]);
    expect(
      await errorData(owner.as.action(api.designs.versions.restore, { versionId: oldId })),
    ).toMatchObject({ code: "LIMIT_REACHED", limit: "versionHistoryDays", max: 90 });
    expect(
      (await errorData(owner.as.action(api.designs.versions.get, { versionId: oldId }))).code,
    ).toBe("LIMIT_REACHED");
    expect((await owner.as.action(api.designs.versions.get, { versionId: newId })).name).toBe(
      "New",
    );
  });
});

describe("duplicate and purge", () => {
  test("duplicate copies content into a new design; purge removes everything", async () => {
    const { t, owner, designId } = await fixture();
    const loaded = await loadAll(owner.as, designId);
    const pageId = firstPageId(loaded.design);
    await owner.as.mutation(api.designs.designs.commit, {
      designId,
      tx: JSON.stringify(
        makeTx([{ op: "create", nodes: [rect(pageId, { name: "Logo" })], parent: pageId }]),
      ),
    });
    const source = await loadAll(owner.as, designId);
    const copy = await owner.as.mutation(api.designs.designs.duplicate, { designId });
    expect(copy.pending).toBe(false);
    const dup = await loadAll(owner.as, copy.designId);
    expect(dup.design.id).toBe(copy.key);
    expect(dup.design.name).toBe(`${source.design.name} (copy)`);
    expect(canonicalize(dup.design.nodes)).toBe(canonicalize(source.design.nodes));

    await owner.as.mutation(api.designs.designs.setShare, { designId, permission: "view" });
    await owner.as.mutation(api.collab.comments.create, { designId, body: "note" });
    await owner.as.mutation(api.designs.designs.delete, { designId });
    await owner.as.mutation(api.designs.designs.purge, { designId });
    await t.finishAllScheduledFunctions(() => {});
    const leftovers = await t.run(async (ctx) => ({
      design: await ctx.db.get("designs", designId),
      nodes: await ctx.db
        .query("nodes")
        .withIndex("by_design_node", (q) => q.eq("designId", designId))
        .collect(),
      ops: await ctx.db
        .query("designOps")
        .withIndex("by_design_seq", (q) => q.eq("designId", designId))
        .collect(),
      shares: await ctx.db
        .query("shares")
        .withIndex("by_design", (q) => q.eq("designId", designId))
        .collect(),
      seq: await ctx.db
        .query("designSeq")
        .withIndex("by_design", (q) => q.eq("designId", designId))
        .collect(),
    }));
    expect(leftovers).toEqual({ design: null, nodes: [], ops: [], shares: [], seq: [] });
    // The duplicate is untouched.
    expect(validateDesign((await loadAll(owner.as, copy.designId)).design).ok).toBe(true);
  });

  test("the chunked (large design) duplicate path rebuilds from snapshot + log", async () => {
    const { t, owner, workspaceId, designId } = await fixture();
    const loaded = await loadAll(owner.as, designId);
    const pageId = firstPageId(loaded.design);
    await owner.as.mutation(api.designs.designs.commit, {
      designId,
      tx: JSON.stringify(
        makeTx([{ op: "create", nodes: [rect(pageId, { name: "A" })], parent: pageId }]),
      ),
    });
    await owner.as.action(api.designs.designs.snapshot, { designId });
    await owner.as.mutation(api.designs.designs.commit, {
      designId,
      tx: JSON.stringify(
        makeTx([{ op: "create", nodes: [rect(pageId, { name: "B" })], parent: pageId }]),
      ),
    });
    const source = await loadAll(owner.as, designId);
    const targetId = await t.mutation(internal.designs.internal.beginShell, {
      workspaceId,
      ownerId: owner.userId,
      key: "copycopycopy",
      name: "Big copy",
      kind: "flyer",
    });
    // Hidden while it is being built.
    expect(
      (await errorData(owner.as.query(api.designs.designs.get, { designId: targetId }))).code,
    ).toBe("NOT_FOUND");
    await t.action(internal.designs.snapshotNode.duplicateLarge, {
      sourceId: designId,
      targetId,
      targetKey: "copycopycopy",
      targetName: "Big copy",
      sourceWorkspaceId: workspaceId,
      userId: owner.userId,
    });
    const copy = await loadAll(owner.as, targetId);
    expect(copy.design.id).toBe("copycopycopy");
    expect(copy.design.name).toBe("Big copy");
    expect(canonicalize(copy.design.nodes)).toBe(canonicalize(source.design.nodes));
    expect(await owner.as.query(api.designs.designs.get, { designId: targetId })).toMatchObject({
      state: "active",
      pageCount: 1,
    });
    // Its own log replays to the same state.
    const rebuilt = await t.action(internal.designs.snapshotNode.run, {
      designId: targetId,
      reason: "manual",
    });
    expect(rebuilt?.seq).toBe(copy.seq);
  });

  test("the trash purge cron removes designs trashed more than 30 days ago", async () => {
    const { t, owner, designId } = await fixture();
    await owner.as.mutation(api.designs.designs.delete, { designId });
    await t.run(async (ctx) =>
      ctx.db.patch("designs", designId, { deletedAt: Date.now() - 31 * 24 * 60 * 60_000 }),
    );
    const res = await t.mutation(internal.designs.maintenance.purgeTrash, {});
    expect(res.purged).toBe(1);
    await t.finishAllScheduledFunctions(() => {});
    expect(await t.run(async (ctx) => ctx.db.get("designs", designId))).toBeNull();
  });
});
