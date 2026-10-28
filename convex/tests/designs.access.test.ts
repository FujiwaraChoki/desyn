import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
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
    kind: "poster",
  });
  const { design, seq } = await loadAll(owner.as, designId);
  const pageId = firstPageId(design);
  const addRect = () =>
    JSON.stringify(makeTx([{ op: "create", nodes: [rect(pageId)], parent: pageId }]));
  return { t, owner, workspaceId, designId, seq, pageId, addRect };
}

describe("permissions per workspace role", () => {
  test("viewer reads, commenter comments, editor edits, admin manages, outsiders see nothing", async () => {
    const { t, workspaceId, designId, addRect } = await fixture();
    const viewer = await memberWithRole(t, workspaceId, "viewer");
    const commenter = await memberWithRole(t, workspaceId, "commenter");
    const editor = await memberWithRole(t, workspaceId, "editor");
    const admin = await memberWithRole(t, workspaceId, "admin");
    const outsider = await createUser(t);

    // read
    for (const user of [viewer, commenter, editor, admin]) {
      expect((await loadAll(user.as, designId)).design.kind).toBe("poster");
    }
    expect((await errorData(outsider.as.query(api.designs.designs.load, { designId }))).code).toBe(
      "NOT_FOUND",
    );
    expect((await errorData(t.query(api.designs.designs.load, { designId }))).code).toBe(
      "NOT_FOUND",
    );

    // edit
    for (const user of [viewer, commenter]) {
      expect(
        (await errorData(user.as.mutation(api.designs.designs.commit, { designId, tx: addRect() })))
          .code,
      ).toBe("FORBIDDEN");
    }
    expect(
      (await editor.as.mutation(api.designs.designs.commit, { designId, tx: addRect() })).dropped,
    ).toEqual([]);
    expect(
      (
        await errorData(
          outsider.as.mutation(api.designs.designs.commit, { designId, tx: addRect() }),
        )
      ).code,
    ).toBe("NOT_FOUND");

    // comment
    expect(
      (await errorData(viewer.as.mutation(api.collab.comments.create, { designId, body: "hi" })))
        .code,
    ).toBe("FORBIDDEN");
    await commenter.as.mutation(api.collab.comments.create, { designId, body: "Looks great" });

    // manage: trash, share links
    expect(
      (await errorData(editor.as.mutation(api.designs.designs.delete, { designId }))).code,
    ).toBe("FORBIDDEN");
    expect(
      (
        await errorData(
          editor.as.mutation(api.designs.designs.setShare, { designId, permission: "view" }),
        )
      ).code,
    ).toBe("FORBIDDEN");
    await admin.as.mutation(api.designs.designs.setShare, { designId, permission: "view" });

    // permission reported to clients
    expect((await viewer.as.query(api.designs.designs.get, { designId })).permission).toBe("view");
    expect((await editor.as.query(api.designs.designs.get, { designId })).permission).toBe("edit");
    expect((await admin.as.query(api.designs.designs.get, { designId })).permission).toBe("manage");
  });

  test("an editor manages the designs they created", async () => {
    const { t, workspaceId } = await fixture();
    const editor = await memberWithRole(t, workspaceId, "editor");
    const { designId } = await editor.as.mutation(api.designs.designs.create, { workspaceId });
    expect((await editor.as.query(api.designs.designs.get, { designId })).permission).toBe(
      "manage",
    );
    await editor.as.mutation(api.designs.designs.archive, { designId });
    await editor.as.mutation(api.designs.designs.restore, { designId });
    await editor.as.mutation(api.designs.designs.delete, { designId });
    expect((await editor.as.query(api.designs.designs.get, { designId })).state).toBe("trashed");
  });
});

describe("share links", () => {
  test("view links work signed out; comment/edit links need a signed-in user", async () => {
    const { t, owner, designId, addRect } = await fixture();
    const view = await owner.as.mutation(api.designs.designs.setShare, {
      designId,
      permission: "view",
    });
    const edit = await owner.as.mutation(api.designs.designs.setShare, {
      designId,
      permission: "edit",
    });
    expect(view.url).toContain(`/share/${view.token}`);

    const anon = await loadAll(t, designId, { token: view.token });
    expect(anon.design.kind).toBe("poster");
    expect(
      (
        await errorData(
          t.mutation(api.designs.designs.commit, {
            designId,
            tx: addRect(),
            share: { token: edit.token },
          }),
        )
      ).code,
    ).toBe("UNAUTHENTICATED");

    const guest = await createUser(t);
    expect(
      (
        await errorData(
          guest.as.mutation(api.designs.designs.commit, {
            designId,
            tx: addRect(),
            share: { token: view.token },
          }),
        )
      ).code,
    ).toBe("FORBIDDEN");
    const res = await guest.as.mutation(api.designs.designs.commit, {
      designId,
      tx: addRect(),
      share: { token: edit.token },
    });
    expect(res.dropped).toEqual([]);
    expect(
      (await guest.as.query(api.designs.designs.get, { designId, share: { token: edit.token } }))
        .permission,
    ).toBe("edit");
    // A token for another design grants nothing.
    const other = await owner.as.mutation(api.designs.designs.create, {
      workspaceId: await workspaceOf(owner),
    });
    expect(
      (
        await errorData(
          guest.as.query(api.designs.designs.load, {
            designId: other.designId,
            share: { token: edit.token },
          }),
        )
      ).code,
    ).toBe("NOT_FOUND");
  });

  test("revoked, expired and password-protected links", async () => {
    const { t, owner, designId } = await fixture();
    const now = Date.now();
    const protectedLink = await owner.as.mutation(api.designs.designs.setShare, {
      designId,
      permission: "view",
      password: "sesame-42",
    });
    expect(
      (
        await errorData(
          t.query(api.designs.designs.load, { designId, share: { token: protectedLink.token } }),
        )
      ).reason,
    ).toBe("password_required");
    // Raw passwords never open a link outside unlockShare (queries cannot be used to guess them).
    expect(
      (
        await errorData(
          t.query(api.designs.designs.load, {
            designId,
            share: { token: protectedLink.token, password: "sesame-42" },
          }),
        )
      ).reason,
    ).toBe("password_required");
    expect(
      await t.mutation(api.designs.designs.unlockShare, {
        token: protectedLink.token,
        password: "nope",
      }),
    ).toEqual({ status: "wrong_password", grant: null });
    const unlocked = await t.mutation(api.designs.designs.unlockShare, {
      token: protectedLink.token,
      password: "sesame-42",
    });
    expect(unlocked.status).toBe("ok");
    const grant = unlocked.grant as string;
    expect(grant.startsWith("sg_")).toBe(true);
    expect(
      (await loadAll(t, designId, { token: protectedLink.token, password: grant })).design.kind,
    ).toBe("poster");
    expect(
      await t.query(api.designs.designs.getSharedByToken, { token: protectedLink.token }),
    ).toEqual({
      status: "password_required",
      requiresPassword: true,
    });
    const meta = await t.query(api.designs.designs.getSharedByToken, {
      token: protectedLink.token,
      password: grant,
    });
    expect(meta).toMatchObject({
      status: "ok",
      permission: "view",
      effectivePermission: "view",
      signedIn: false,
    });

    const expiring = await owner.as.mutation(api.designs.designs.setShare, {
      designId,
      permission: "view",
      expiresAt: now + 60_000,
    });
    vi.useFakeTimers();
    vi.setSystemTime(now + 120_000);
    expect(
      (
        await errorData(
          t.query(api.designs.designs.load, { designId, share: { token: expiring.token } }),
        )
      ).code,
    ).toBe("EXPIRED");
    expect(await t.query(api.designs.designs.getSharedByToken, { token: expiring.token })).toEqual({
      status: "expired",
    });
    vi.useRealTimers();

    const link = await owner.as.mutation(api.designs.designs.setShare, {
      designId,
      permission: "view",
    });
    expect((await owner.as.query(api.designs.designs.listShares, { designId })).length).toBe(3);
    await owner.as.mutation(api.designs.designs.revokeShare, { shareId: link.shareId });
    expect(
      (
        await errorData(
          t.query(api.designs.designs.load, { designId, share: { token: link.token } }),
        )
      ).code,
    ).toBe("NOT_FOUND");
    expect(await t.query(api.designs.designs.getSharedByToken, { token: link.token })).toEqual({
      status: "invalid",
    });
    expect((await owner.as.query(api.designs.designs.listShares, { designId })).length).toBe(2);
  });

  test("share passwords are rate limited and grants die with a password change", async () => {
    const { t, owner, designId } = await fixture();
    const link = await owner.as.mutation(api.designs.designs.setShare, {
      designId,
      permission: "view",
      password: "sesame-42",
    });
    for (let i = 0; i < 10; i++) {
      expect(
        (
          await t.mutation(api.designs.designs.unlockShare, {
            token: link.token,
            password: `guess-${i}`,
          })
        ).status,
      ).toBe("wrong_password");
    }
    // The bucket is empty: even the right password waits now.
    expect(
      (
        await errorData(
          t.mutation(api.designs.designs.unlockShare, { token: link.token, password: "sesame-42" }),
        )
      ).code,
    ).toBe("RATE_LIMITED");

    const other = await owner.as.mutation(api.designs.designs.setShare, {
      designId,
      permission: "view",
      password: "open-sesame",
    });
    const { grant } = await t.mutation(api.designs.designs.unlockShare, {
      token: other.token,
      password: "open-sesame",
    });
    expect(
      (await loadAll(t, designId, { token: other.token, password: grant as string })).design.kind,
    ).toBe("poster");
    await owner.as.mutation(api.designs.designs.setShare, {
      designId,
      shareId: other.shareId,
      permission: "view",
      password: "new-password",
    });
    expect(
      (
        await errorData(
          t.query(api.designs.designs.load, {
            designId,
            share: { token: other.token, password: grant as string },
          }),
        )
      ).reason,
    ).toBe("password_required");
  });
  test("links stop working while the design is in the trash", async () => {
    const { t, owner, designId } = await fixture();
    const link = await owner.as.mutation(api.designs.designs.setShare, {
      designId,
      permission: "view",
    });
    await owner.as.mutation(api.designs.designs.delete, { designId });
    expect(
      (
        await errorData(
          t.query(api.designs.designs.load, { designId, share: { token: link.token } }),
        )
      ).code,
    ).toBe("NOT_FOUND");
    await owner.as.mutation(api.designs.designs.restore, { designId });
    expect((await loadAll(t, designId, { token: link.token })).design.kind).toBe("poster");
  });

  test("joinShare records 'shared with me'", async () => {
    const { t, owner, designId } = await fixture();
    const link = await owner.as.mutation(api.designs.designs.setShare, {
      designId,
      permission: "comment",
    });
    const guest = await createUser(t);
    expect(await guest.as.mutation(api.designs.designs.joinShare, { token: link.token })).toEqual({
      designId,
      permission: "comment",
    });
    const shared = await guest.as.query(api.designs.designs.list, {
      filter: "shared",
      paginationOpts: { numItems: 10, cursor: null },
    });
    expect(shared.page).toHaveLength(1);
    expect(shared.page[0]).toMatchObject({ id: designId, permission: "comment" });
    await guest.as.mutation(api.collab.comments.create, {
      designId,
      body: "From a link",
      share: { token: link.token },
    });
    await owner.as.mutation(api.designs.designs.revokeShare, { shareId: link.shareId });
    const after = await guest.as.query(api.designs.designs.list, {
      filter: "shared",
      paginationOpts: { numItems: 10, cursor: null },
    });
    expect(after.page).toHaveLength(0);
  });

  test("link types are plan features on hosted", async () => {
    vi.stubEnv("DESYN_EDITION", "hosted");
    const { owner, designId } = await fixture();
    await owner.as.mutation(api.designs.designs.setShare, { designId, permission: "view" });
    expect(
      await errorData(
        owner.as.mutation(api.designs.designs.setShare, { designId, permission: "edit" }),
      ),
    ).toMatchObject({ code: "FEATURE_UNAVAILABLE", feature: "share.editLink" });
  });
});

describe("lists and organization", () => {
  test("filters: all, mine, folder, archived, trash, search", async () => {
    const { t, owner, workspaceId, designId } = await fixture();
    const editor = await memberWithRole(t, workspaceId, "editor");
    const theirs = await editor.as.mutation(api.designs.designs.create, {
      workspaceId,
      name: "Menu board",
    });
    const folderId = await owner.as.mutation(api.accounts.folders.create, {
      workspaceId,
      name: "Campaign",
    });
    await owner.as.mutation(api.designs.designs.moveToFolder, { designId, folderId });
    const list = async (filter: "all" | "mine" | "folder" | "archived" | "trash", extra = {}) =>
      (
        await owner.as.query(api.designs.designs.list, {
          workspaceId,
          filter,
          paginationOpts: { numItems: 20, cursor: null },
          ...extra,
        })
      ).page.map((d) => d.id);
    expect(new Set(await list("all"))).toEqual(new Set([designId, theirs.designId]));
    expect(await list("mine")).toEqual([designId]);
    expect(await list("folder", { folderId })).toEqual([designId]);
    expect(await list("folder", { folderId: null })).toEqual([theirs.designId]);
    await owner.as.mutation(api.designs.designs.archive, { designId });
    expect(await list("archived")).toEqual([designId]);
    await owner.as.mutation(api.designs.designs.delete, { designId: theirs.designId });
    expect(await list("trash")).toEqual([theirs.designId]);
    expect(await list("all")).toEqual([]);
    const found = await owner.as.query(api.designs.designs.list, {
      workspaceId,
      filter: "trash",
      search: "menu",
      paginationOpts: { numItems: 20, cursor: null },
    });
    expect(found.page.map((d) => d.id)).toEqual([theirs.designId]);
    // Deleting the folder moves its designs to the root (cleanup hook).
    await owner.as.mutation(api.designs.designs.restore, { designId });
    await owner.as.mutation(api.accounts.folders.remove, { folderId });
    await t.finishAllScheduledFunctions(() => {});
    expect((await owner.as.query(api.designs.designs.get, { designId })).folderId).toBeNull();
  });
});
