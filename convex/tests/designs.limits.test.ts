import { createDesign, createPage, type Design } from "@desyn/schema";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import { firstPageId, loadAll, makeTx, page, rect, workspaceOf } from "./designs.helpers";
import { createUser, errorData, setupTest } from "./harness.helpers";

beforeEach(() => vi.stubEnv("DESYN_EDITION", "hosted"));
afterEach(() => vi.unstubAllEnvs());

function multiPage(pages: number): Design {
  const design = createDesign("presentation");
  const root = design.nodes.root as { children: string[] };
  while (root.children.length < pages) {
    const p = createPage({ name: `Slide ${root.children.length + 1}` });
    design.nodes[p.id] = p;
    root.children.push(p.id);
  }
  return design;
}

describe("plan limits (hosted, free plan)", () => {
  test("design count limit applies to create, counts trash restores, and frees up on delete", async () => {
    const t = setupTest();
    const user = await createUser(t);
    const workspaceId = await workspaceOf(user);
    await t.run(async (ctx) => {
      await ctx.db.insert("usage", {
        userId: user.userId,
        metric: "designs",
        period: "total",
        value: 19,
        updatedAt: Date.now(),
      });
    });
    const { designId } = await user.as.mutation(api.designs.designs.create, { workspaceId });
    expect(
      await errorData(user.as.mutation(api.designs.designs.create, { workspaceId })),
    ).toMatchObject({
      code: "LIMIT_REACHED",
      limit: "designs",
      max: 20,
    });
    await user.as.mutation(api.designs.designs.delete, { designId });
    const other = await user.as.mutation(api.designs.designs.create, { workspaceId });
    expect(
      await errorData(user.as.mutation(api.designs.designs.restore, { designId })),
    ).toMatchObject({
      code: "LIMIT_REACHED",
    });
    await user.as.mutation(api.designs.designs.delete, { designId: other.designId });
    await user.as.mutation(api.designs.designs.restore, { designId });
  });

  test("pagesPerDesign is enforced on commit and import", async () => {
    const t = setupTest();
    const user = await createUser(t);
    const workspaceId = await workspaceOf(user);
    const { designId } = await user.as.mutation(api.designs.designs.create, {
      workspaceId,
      kind: "presentation",
    });
    const { seq } = await loadAll(user.as, designId);
    const nine = Array.from({ length: 9 }, () => ({
      op: "create" as const,
      nodes: [page()],
      parent: "root",
    }));
    const res = await user.as.mutation(api.designs.designs.commit, {
      designId,
      baseSeq: seq,
      tx: JSON.stringify(makeTx(nine)),
    });
    expect(res.dropped).toEqual([]);
    expect((await user.as.query(api.designs.designs.get, { designId })).pageCount).toBe(10);
    expect(
      await errorData(
        user.as.mutation(api.designs.designs.commit, {
          designId,
          tx: JSON.stringify(makeTx([{ op: "create", nodes: [page()], parent: "root" }])),
        }),
      ),
    ).toMatchObject({ code: "LIMIT_REACHED", limit: "pagesPerDesign", max: 10 });
    // Removing pages is always allowed.
    const loaded = await loadAll(user.as, designId);
    const res2 = await user.as.mutation(api.designs.designs.commit, {
      designId,
      tx: JSON.stringify(makeTx([{ op: "delete", id: firstPageId(loaded.design) }])),
    });
    expect(res2.dropped).toEqual([]);

    expect(
      await errorData(
        user.as.mutation(api.designs.designs.importDesign, {
          workspaceId,
          design: JSON.stringify(multiPage(11)),
        }),
      ),
    ).toMatchObject({ code: "LIMIT_REACHED", limit: "pagesPerDesign" });
  });
});

describe("importDesign", () => {
  test("validates, assigns a fresh key, strips foreign storage keys and sanitizes SVG", async () => {
    vi.stubEnv("DESYN_EDITION", "selfhost");
    const t = setupTest();
    const user = await createUser(t);
    const workspaceId = await workspaceOf(user);
    const design = multiPage(2);
    const pageId = (design.nodes.root as { children: string[] }).children[0] as string;
    design.assets.zzzzzzzzzzzz = {
      id: "zzzzzzzzzzzz",
      kind: "image",
      mime: "image/png",
      storageKey: "uploads/someone-else/zzzzzzzzzzzz/x.png",
      url: "https://signed.example/x.png",
    };
    const svgId = "svgsvgsvgsvg";
    design.nodes[svgId] = {
      id: svgId,
      type: "svg",
      name: "Icon",
      parent: pageId,
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      rotation: 0,
      opacity: 1,
      blend: "normal",
      visible: true,
      locked: false,
      effects: [],
      markup: '<svg xmlns="http://www.w3.org/2000/svg"><script>x()</script><circle r="4"/></svg>',
    };
    (design.nodes[pageId] as { children: string[] }).children.push(svgId);
    const res = await user.as.mutation(api.designs.designs.importDesign, {
      workspaceId,
      design: JSON.stringify(design),
      name: "Imported deck",
    });
    expect(res.key).not.toBe(design.id);
    const loaded = await loadAll(user.as, res.designId);
    expect(loaded.design.name).toBe("Imported deck");
    expect(loaded.design.assets.zzzzzzzzzzzz).toEqual({
      id: "zzzzzzzzzzzz",
      kind: "image",
      mime: "image/png",
    });
    expect((loaded.design.nodes[svgId] as { markup: string }).markup).not.toContain("script");
    expect(
      (await user.as.query(api.designs.designs.get, { designId: res.designId })).pageCount,
    ).toBe(2);

    expect(
      (
        await errorData(
          user.as.mutation(api.designs.designs.importDesign, { workspaceId, design: "{" }),
        )
      ).code,
    ).toBe("INVALID_ARGUMENT");
    const broken = createDesign("poster");
    (broken.nodes.root as { children: string[] }).children.push("doesnotexist");
    expect(
      (
        await errorData(
          user.as.mutation(api.designs.designs.importDesign, {
            workspaceId,
            design: JSON.stringify(broken),
          }),
        )
      ).code,
    ).toBe("INVALID_ARGUMENT");
  });
});

describe("importDesign (large documents)", () => {
  test("documents above the inline limit are inserted in chunks by an action", async () => {
    vi.stubEnv("DESYN_EDITION", "selfhost");
    const t = setupTest();
    const user = await createUser(t);
    const workspaceId = await workspaceOf(user);
    const design = createDesign("poster");
    const pageId = firstPageId(design);
    const pageNode = design.nodes[pageId] as { children: string[] };
    for (let i = 0; i < 8_100; i++) {
      const node = rect(pageId, { name: `Dot ${i}` });
      design.nodes[node.id] = node;
      pageNode.children.push(node.id);
    }
    const res = await user.as.mutation(api.designs.designs.importDesign, {
      workspaceId,
      design: JSON.stringify(design),
      name: "Big import",
    });
    expect(res.pending).toBe(true);
    // Not visible while it is being created.
    expect(
      (await errorData(user.as.query(api.designs.designs.get, { designId: res.designId }))).code,
    ).toBe("NOT_FOUND");
    await t.finishAllScheduledFunctions(() => {});
    const summary = await user.as.query(api.designs.designs.get, { designId: res.designId });
    expect(summary).toMatchObject({ name: "Big import", state: "active", pageCount: 1 });
    const loaded = await loadAll(user.as, res.designId);
    expect(Object.keys(loaded.design.nodes)).toHaveLength(Object.keys(design.nodes).length);
    expect((loaded.design.nodes[pageId] as { children: string[] }).children).toEqual(
      pageNode.children,
    );
  }, 60_000);
});

describe("routes and cleanup hooks", () => {
  test("GET /og/:token returns share metadata", async () => {
    vi.stubEnv("DESYN_EDITION", "selfhost");
    vi.stubEnv("APP_URL", "https://app.desyn.test");
    const t = setupTest();
    const user = await createUser(t);
    const workspaceId = await workspaceOf(user);
    const { designId } = await user.as.mutation(api.designs.designs.create, {
      workspaceId,
      kind: "poster",
      name: "Summer Fest",
    });
    const link = await user.as.mutation(api.designs.designs.setShare, {
      designId,
      permission: "view",
    });
    const res = await t.fetch(`/og/${link.token}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      title: "Summer Fest",
      url: `https://app.desyn.test/share/${link.token}`,
      protected: false,
      kind: "poster",
    });
    const locked = await user.as.mutation(api.designs.designs.setShare, {
      designId,
      permission: "view",
      password: "secret1",
    });
    expect(await (await t.fetch(`/og/${locked.token}`)).json()).toMatchObject({
      protected: true,
      image: null,
    });
    expect((await t.fetch("/og/not-a-real-token-123456")).status).toBe(404);
  });

  test("workspace deletion purges designs, retires assets and deletes brand kits", async () => {
    vi.stubEnv("DESYN_EDITION", "selfhost");
    const t = setupTest();
    const user = await createUser(t);
    const workspaceId = await user.as.mutation(api.accounts.workspaces.create, { name: "Agency" });
    const { designId } = await user.as.mutation(api.designs.designs.create, { workspaceId });
    await user.as.mutation(api.brand.brandKits.create, { workspaceId, name: "Agency brand" });
    let done = false;
    for (let i = 0; i < 20 && !done; i++) {
      done = (await t.mutation(internal.designs.maintenance.workspaceCleanup, { workspaceId }))
        .done;
    }
    expect(done).toBe(true);
    await t.finishAllScheduledFunctions(() => {});
    const left = await t.run(async (ctx) => ({
      design: await ctx.db.get("designs", designId),
      nodes: (
        await ctx.db
          .query("nodes")
          .withIndex("by_design_node", (q) => q.eq("designId", designId))
          .collect()
      ).length,
      kits: (
        await ctx.db
          .query("brandKits")
          .withIndex("by_workspace_updated", (q) => q.eq("workspaceId", workspaceId))
          .collect()
      ).length,
    }));
    expect(left).toEqual({ design: null, nodes: 0, kits: 0 });
  });
});
