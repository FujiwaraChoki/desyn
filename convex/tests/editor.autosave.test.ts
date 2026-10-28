import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { AUTOSAVE_KEEP, AUTOSAVE_MIN_INTERVAL_MS, AUTOSAVE_NAME } from "../editor/autosave";
import { firstPageId, loadAll, makeTx, memberWithRole, rect, workspaceOf } from "./designs.helpers";
import { createUser, errorData, setupTest } from "./harness.helpers";

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
  const loaded = await loadAll(owner.as, designId);
  const pageId = firstPageId(loaded.design);
  const edit = () =>
    owner.as.mutation(api.designs.designs.commit, {
      designId,
      tx: JSON.stringify(makeTx([{ op: "create", nodes: [rect(pageId)], parent: pageId }])),
    });
  return { t, owner, workspaceId, designId, edit };
}

describe("editor/autosave", () => {
  test("plans without version history skip autosaves", async () => {
    vi.stubEnv("DESYN_EDITION", "hosted");
    const { owner, designId, edit } = await fixture();
    await edit();
    expect(await owner.as.mutation(api.editor.autosave.autosave, { designId })).toEqual({
      versionId: null,
      skipped: "unavailable",
    });
  });

  test("creates an automatic version when the design changed, at most every 10 minutes", async () => {
    vi.stubEnv("DESYN_EDITION", "selfhost");
    vi.useFakeTimers();
    const { owner, designId, edit } = await fixture();
    await edit();
    const first = await owner.as.mutation(api.editor.autosave.autosave, { designId });
    expect(first.skipped).toBeNull();
    expect(first.versionId).not.toBeNull();

    const list = await owner.as.query(api.designs.versions.list, { designId });
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ name: AUTOSAVE_NAME, auto: true });

    // Nothing changed since.
    expect((await owner.as.mutation(api.editor.autosave.autosave, { designId })).skipped).toBe(
      "unchanged",
    );
    // Changed, but too soon.
    await edit();
    expect((await owner.as.mutation(api.editor.autosave.autosave, { designId })).skipped).toBe(
      "recent",
    );
    // Later: a second autosave.
    vi.setSystemTime(Date.now() + AUTOSAVE_MIN_INTERVAL_MS + 1_000);
    const later = await owner.as.mutation(api.editor.autosave.autosave, { designId });
    expect(later.skipped).toBeNull();
    expect(await owner.as.query(api.designs.versions.list, { designId })).toHaveLength(2);
  });

  test("needs edit access", async () => {
    vi.stubEnv("DESYN_EDITION", "selfhost");
    const { t, workspaceId, designId, edit } = await fixture();
    await edit();
    const commenter = await memberWithRole(t, workspaceId, "commenter");
    const err = await errorData(commenter.as.mutation(api.editor.autosave.autosave, { designId }));
    expect(err.code).toBe("FORBIDDEN");
  });

  test("keeps the newest autosaves and never prunes named versions", async () => {
    vi.stubEnv("DESYN_EDITION", "selfhost");
    vi.useFakeTimers();
    const { t, owner, designId, edit } = await fixture();
    await edit();
    const base = Date.now() - 1_000_000_000;
    await t.run(async (ctx) => {
      const design = await ctx.db.get("designs", designId as Id<"designs">);
      if (!design) throw new Error("missing design");
      for (let i = 0; i < AUTOSAVE_KEEP + 3; i++) {
        await ctx.db.insert("versions", {
          designId,
          name: AUTOSAVE_NAME,
          seq: 0,
          status: "ready",
          pageCount: 1,
          createdBy: owner.userId,
          auto: true,
          createdAt: base + i * 1000,
        });
      }
      await ctx.db.insert("versions", {
        designId,
        name: "Client review",
        seq: 0,
        status: "ready",
        pageCount: 1,
        createdBy: owner.userId,
        auto: false,
        createdAt: base - 5000,
      });
    });
    const res = await owner.as.mutation(api.editor.autosave.autosave, { designId });
    expect(res.skipped).toBeNull();
    const rows = await t.run(async (ctx) =>
      ctx.db
        .query("versions")
        .withIndex("by_design_created", (q) => q.eq("designId", designId))
        .collect(),
    );
    expect(rows.filter((r) => r.auto && r.name === AUTOSAVE_NAME)).toHaveLength(AUTOSAVE_KEEP);
    expect(rows.some((r) => r.name === "Client review")).toBe(true);
  });
});
