import { describe, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import { assertFeature, assertLimit, assertUploadAllowed, getPlan } from "../lib/entitlements";
import { requireDesignAccess, requireMember } from "../lib/guards";
import { createUser, errorData, setupTest } from "./harness.helpers";

describe("auth guards", () => {
  test("signed-out callers get UNAUTHENTICATED and me() returns null", async () => {
    const t = setupTest();
    expect(await t.query(api.accounts.profiles.me, {})).toBeNull();
    expect((await errorData(t.query(api.accounts.workspaces.list, {}))).code).toBe(
      "UNAUTHENTICATED",
    );
  });

  test("an identity without a live session is rejected", async () => {
    const t = setupTest();
    const user = await createUser(t);
    const stale = t.withIdentity({ subject: user.userId, sessionId: "not-a-session" });
    expect((await errorData(stale.query(api.accounts.workspaces.list, {}))).code).toBe(
      "UNAUTHENTICATED",
    );
  });

  test("sign-up provisions profile, personal workspace and owner membership", async () => {
    vi.stubEnv("DESYN_EDITION", "hosted");
    const t = setupTest();
    const user = await createUser(t, { name: "Ada Lovelace" });
    const me = await user.as.query(api.accounts.profiles.me, {});
    expect(me?.email).toBe(user.email);
    expect(me?.plan).toBe("free");
    expect(me?.provisioned).toBe(true);
    expect(me?.features["ai.agent"]).toBe(false);
    const workspaces = await user.as.query(api.accounts.workspaces.list, {});
    expect(workspaces).toHaveLength(1);
    expect(workspaces[0]).toMatchObject({
      kind: "personal",
      role: "owner",
      name: "Ada's workspace",
      isDefault: true,
    });
    vi.unstubAllEnvs();
  });
});

describe("membership, design access and plan guards", () => {
  test("requireMember / requireDesignAccess map roles onto design levels", async () => {
    vi.stubEnv("DESYN_EDITION", "selfhost");
    const t = setupTest();
    const owner = await createUser(t);
    const editor = await createUser(t);
    const viewer = await createUser(t);
    const outsider = await createUser(t);
    const ws = await owner.as.mutation(api.accounts.workspaces.create, { name: "Team" });
    await t.run(async (ctx) => {
      const now = Date.now();
      await ctx.db.insert("memberships", {
        workspaceId: ws,
        userId: editor.userId,
        role: "editor",
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert("memberships", {
        workspaceId: ws,
        userId: viewer.userId,
        role: "viewer",
        createdAt: now,
        updatedAt: now,
      });
    });
    const byEditor = { workspaceId: ws, ownerId: editor.userId };
    const byOwner = { workspaceId: ws, ownerId: owner.userId };
    const check = (
      userId: string,
      design: typeof byOwner,
      level: "view" | "comment" | "edit" | "manage",
    ) => t.run(async (ctx) => (await requireDesignAccess(ctx, design, level, { userId })).role);

    expect(await check(editor.userId, byEditor, "manage")).toBe("admin");
    expect((await errorData(check(editor.userId, byOwner, "manage"))).code).toBe("FORBIDDEN");
    expect(await check(editor.userId, byOwner, "edit")).toBe("editor");
    expect(await check(viewer.userId, byOwner, "view")).toBe("viewer");
    expect((await errorData(check(viewer.userId, byOwner, "comment"))).code).toBe("FORBIDDEN");
    expect((await errorData(check(outsider.userId, byOwner, "view"))).code).toBe("NOT_FOUND");
    const member = await t.run(
      async (ctx) => (await requireMember(ctx, ws, "editor", { userId: editor.userId })).role,
    );
    expect(member).toBe("editor");
    vi.unstubAllEnvs();
  });

  test("assertFeature / assertLimit / getPlan honor edition and plan", async () => {
    vi.stubEnv("DESYN_EDITION", "hosted");
    const t = setupTest();
    const u = await createUser(t);
    await t.run(async (ctx) => {
      expect(await getPlan(ctx, u.userId)).toBe("free");
      expect((await errorData(assertFeature(ctx, u.userId, "brandKit"))).code).toBe(
        "FEATURE_UNAVAILABLE",
      );
      await assertLimit(ctx, u.userId, "designs", { current: 19 });
      expect(await errorData(assertLimit(ctx, u.userId, "designs", { current: 20 }))).toMatchObject(
        {
          code: "LIMIT_REACHED",
          limit: "designs",
          max: 20,
        },
      );
      // Tracked counter: one personal workspace already counts against the Free limit of 1.
      expect((await errorData(assertLimit(ctx, u.userId, "workspaces"))).code).toBe(
        "LIMIT_REACHED",
      );
      expect((await errorData(assertUploadAllowed(ctx, u.userId, 16 * 1024 * 1024))).code).toBe(
        "LIMIT_REACHED",
      );
      await assertUploadAllowed(ctx, u.userId, 10 * 1024 * 1024);
      await expect(assertLimit(ctx, u.userId, "pagesPerDesign")).rejects.toThrow(
        /explicit current/,
      );
    });
    vi.stubEnv("DESYN_EDITION", "selfhost");
    await t.run(async (ctx) => {
      expect(await getPlan(ctx, u.userId)).toBe("selfhost");
      await assertFeature(ctx, u.userId, "brandKit");
      await assertLimit(ctx, u.userId, "designs", { current: 1_000_000 });
    });
    vi.unstubAllEnvs();
  });
});
