import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { canManageRole, roleAtLeast } from "../lib/roles";
import {
  createUser,
  errorData,
  setupTest,
  type TestConvex,
  type TestUser,
} from "./harness.helpers";

/** Invite tokens only travel by email; tests read them from the rendered outbox body. */
async function lastInviteToken(t: TestConvex): Promise<string> {
  const bodies = await t.run(async (ctx) => ctx.db.query("mailOutbox").collect());
  const text = bodies.at(-1)?.text ?? "";
  const match = text.match(/\/accept\/([A-Za-z0-9_-]+)/);
  if (!match?.[1]) throw new Error("no invite link found");
  return match[1];
}

async function teamWorkspace(owner: TestUser): Promise<Id<"workspaces">> {
  return await owner.as.mutation(api.accounts.workspaces.create, { name: "Studio" });
}

async function join(
  t: TestConvex,
  owner: TestUser,
  ws: Id<"workspaces">,
  member: TestUser,
  role: "admin" | "editor" | "commenter" | "viewer",
) {
  await owner.as.mutation(api.accounts.invites.create, {
    workspaceId: ws,
    emails: [member.email],
    role,
  });
  const token = await lastInviteToken(t);
  await member.as.mutation(api.accounts.invites.accept, { token });
}

describe("roles", () => {
  test("rank and management rules", () => {
    expect(roleAtLeast("editor", "commenter")).toBe(true);
    expect(roleAtLeast("viewer", "commenter")).toBe(false);
    expect(canManageRole("owner", "admin", "editor")).toBe(true);
    expect(canManageRole("owner", "owner", "admin")).toBe(false);
    expect(canManageRole("admin", "editor", "viewer")).toBe(true);
    expect(canManageRole("admin", "editor", "admin")).toBe(false);
    expect(canManageRole("admin", "viewer", "owner")).toBe(false);
    expect(canManageRole("editor", "viewer", "viewer")).toBe(false);
  });
});

describe("workspaces, memberships and invites", () => {
  beforeEach(() => vi.stubEnv("DESYN_EDITION", "selfhost"));
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  test("hosted Free users cannot create team workspaces", async () => {
    vi.stubEnv("DESYN_EDITION", "hosted");
    const t = setupTest();
    const u = await createUser(t);
    const err = await errorData(u.as.mutation(api.accounts.workspaces.create, { name: "Team" }));
    expect(err).toMatchObject({ code: "FEATURE_UNAVAILABLE", feature: "teams" });
  });

  test("invite by email, accept, and role-gated access", async () => {
    const t = setupTest();
    const owner = await createUser(t, { name: "Olivia Owner" });
    const ed = await createUser(t, { email: "ed@example.com" });
    const outsider = await createUser(t);
    const ws = await teamWorkspace(owner);

    const res = await owner.as.mutation(api.accounts.invites.create, {
      workspaceId: ws,
      emails: ["ED@example.com", "new@example.com", owner.email],
      role: "editor",
    });
    expect(res.invited.sort()).toEqual(["ed@example.com", "new@example.com"]);
    expect(res.skipped).toEqual([{ email: owner.email, reason: "already_member" }]);

    const mail = await t.run(async (ctx) => ctx.db.query("mailLog").collect());
    expect(
      mail
        .filter((m) => m.template === "invite")
        .map((m) => m.to)
        .sort(),
    ).toEqual(["ed@example.com", "new@example.com"]);

    // The second outbox body belongs to new@example.com, the first to ed@.
    const bodies = await t.run(async (ctx) => ctx.db.query("mailOutbox").collect());
    const edBody = bodies.find((b) => b.text.includes("Olivia"));
    expect(edBody).toBeTruthy();
    const edLog = mail.find((m) => m.to === "ed@example.com" && m.template === "invite");
    const edOutbox = bodies.find((b) => b.mailLogId === edLog?._id);
    const token = edOutbox?.text.match(/\/accept\/([A-Za-z0-9_-]+)/)?.[1];
    if (!token) throw new Error("token missing");

    const preview = await t.query(api.accounts.invites.getByToken, { token });
    expect(preview).toMatchObject({
      status: "pending",
      workspaceName: "Studio",
      role: "editor",
      email: "ed@example.com",
    });
    expect(await t.query(api.accounts.invites.getByToken, { token: "nope" })).toEqual({
      status: "invalid",
    });

    // Wrong account cannot accept.
    expect(
      (await errorData(outsider.as.mutation(api.accounts.invites.accept, { token }))).code,
    ).toBe("FORBIDDEN");
    const accepted = await ed.as.mutation(api.accounts.invites.accept, { token });
    expect(accepted.workspaceId).toBe(ws);
    expect((await errorData(ed.as.mutation(api.accounts.invites.accept, { token }))).code).toBe(
      "CONFLICT",
    );

    const members = await owner.as.query(api.accounts.memberships.list, { workspaceId: ws });
    expect(members.map((m) => [m.role, m.email])).toEqual([
      ["owner", owner.email],
      ["editor", "ed@example.com"],
    ]);

    // Editors can create folders but not manage members; outsiders see NOT_FOUND.
    await ed.as.mutation(api.accounts.folders.create, { workspaceId: ws, name: "Campaigns" });
    expect(
      (await errorData(ed.as.query(api.accounts.invites.list, { workspaceId: ws }))).code,
    ).toBe("FORBIDDEN");
    expect(
      (await errorData(outsider.as.query(api.accounts.folders.list, { workspaceId: ws }))).code,
    ).toBe("NOT_FOUND");
  });

  test("expired invites cannot be accepted", async () => {
    vi.useFakeTimers();
    const t = setupTest();
    const owner = await createUser(t);
    const guest = await createUser(t);
    const ws = await teamWorkspace(owner);
    await owner.as.mutation(api.accounts.invites.create, {
      workspaceId: ws,
      emails: [guest.email],
      role: "viewer",
    });
    const token = await lastInviteToken(t);
    vi.setSystemTime(Date.now() + 8 * 24 * 60 * 60 * 1000);
    expect((await t.query(api.accounts.invites.getByToken, { token })).status).toBe("expired");
    expect((await errorData(guest.as.mutation(api.accounts.invites.accept, { token }))).code).toBe(
      "EXPIRED",
    );
  });

  test("resend rotates the token; revoke invalidates it", async () => {
    vi.useFakeTimers();
    const t = setupTest();
    const owner = await createUser(t);
    const guest = await createUser(t);
    const ws = await teamWorkspace(owner);
    await owner.as.mutation(api.accounts.invites.create, {
      workspaceId: ws,
      emails: [guest.email],
      role: "commenter",
    });
    const first = await lastInviteToken(t);
    const [invite] = await owner.as.query(api.accounts.invites.list, { workspaceId: ws });
    if (!invite) throw new Error("invite missing");
    expect(
      (await errorData(owner.as.mutation(api.accounts.invites.resend, { inviteId: invite.id })))
        .code,
    ).toBe("RATE_LIMITED");
    vi.setSystemTime(Date.now() + 61_000);
    await owner.as.mutation(api.accounts.invites.resend, { inviteId: invite.id });
    const second = await lastInviteToken(t);
    expect(second).not.toBe(first);
    expect((await t.query(api.accounts.invites.getByToken, { token: first })).status).toBe(
      "invalid",
    );
    await owner.as.mutation(api.accounts.invites.revoke, { inviteId: invite.id });
    expect((await t.query(api.accounts.invites.getByToken, { token: second })).status).toBe(
      "revoked",
    );
  });

  test("pending invites show up for the invitee and can be accepted or declined by id", async () => {
    const t = setupTest();
    const owner = await createUser(t);
    const guest = await createUser(t);
    const ws = await teamWorkspace(owner);
    const ws2 = await owner.as.mutation(api.accounts.workspaces.create, { name: "Second" });
    await owner.as.mutation(api.accounts.invites.create, {
      workspaceId: ws,
      emails: [guest.email],
      role: "viewer",
    });
    await owner.as.mutation(api.accounts.invites.create, {
      workspaceId: ws2,
      emails: [guest.email],
      role: "editor",
    });
    const mine = await guest.as.query(api.accounts.invites.mine, {});
    expect(mine).toHaveLength(2);
    const first = mine.find((i) => i.workspaceId === ws);
    const second = mine.find((i) => i.workspaceId === ws2);
    if (!first || !second) throw new Error("missing");
    await guest.as.mutation(api.accounts.invites.acceptById, { inviteId: first.id });
    await guest.as.mutation(api.accounts.invites.decline, { inviteId: second.id });
    expect(await guest.as.query(api.accounts.invites.mine, {})).toHaveLength(0);
    const list = await guest.as.query(api.accounts.workspaces.list, {});
    expect(list.map((w) => [w.kind, w.role])).toEqual([
      ["personal", "owner"],
      ["team", "viewer"],
    ]);
  });

  test("role changes, removal and leaving follow the role hierarchy", async () => {
    const t = setupTest();
    const owner = await createUser(t);
    const admin = await createUser(t);
    const admin2 = await createUser(t);
    const editor = await createUser(t);
    const ws = await teamWorkspace(owner);
    await join(t, owner, ws, admin, "admin");
    await join(t, owner, ws, admin2, "admin");
    await join(t, owner, ws, editor, "editor");

    // Admin can demote an editor to viewer, but not touch another admin or the owner.
    await admin.as.mutation(api.accounts.memberships.setRole, {
      workspaceId: ws,
      userId: editor.userId,
      role: "viewer",
    });
    expect(
      (
        await errorData(
          admin.as.mutation(api.accounts.memberships.setRole, {
            workspaceId: ws,
            userId: admin2.userId,
            role: "editor",
          }),
        )
      ).code,
    ).toBe("FORBIDDEN");
    expect(
      (
        await errorData(
          admin.as.mutation(api.accounts.memberships.remove, {
            workspaceId: ws,
            userId: owner.userId,
          }),
        )
      ).code,
    ).toBe("FORBIDDEN");
    // Viewer can no longer create folders.
    expect(
      (
        await errorData(
          editor.as.mutation(api.accounts.folders.create, { workspaceId: ws, name: "x" }),
        )
      ).code,
    ).toBe("FORBIDDEN");
    // Owner removes admin2; editor leaves; owner cannot leave.
    await owner.as.mutation(api.accounts.memberships.remove, {
      workspaceId: ws,
      userId: admin2.userId,
    });
    await editor.as.mutation(api.accounts.memberships.leave, { workspaceId: ws });
    expect(
      (await errorData(owner.as.mutation(api.accounts.memberships.leave, { workspaceId: ws })))
        .code,
    ).toBe("FORBIDDEN");
    const members = await owner.as.query(api.accounts.memberships.list, { workspaceId: ws });
    expect(members.map((m) => m.role)).toEqual(["owner", "admin"]);

    // Ownership transfer makes the old owner an admin.
    await owner.as.mutation(api.accounts.workspaces.transferOwnership, {
      workspaceId: ws,
      userId: admin.userId,
    });
    const after = await admin.as.query(api.accounts.workspaces.get, { workspaceId: ws });
    expect(after).toMatchObject({ role: "owner", ownerId: admin.userId });
    await owner.as.mutation(api.accounts.memberships.leave, { workspaceId: ws });
  });

  test("deleting a team workspace revokes access immediately and purges it", async () => {
    const t = setupTest();
    const owner = await createUser(t);
    const ed = await createUser(t);
    const ws = await teamWorkspace(owner);
    await join(t, owner, ws, ed, "editor");
    await owner.as.mutation(api.accounts.workspaces.setDefault, { workspaceId: ws });
    expect(
      (
        await errorData(
          owner.as.mutation(api.accounts.workspaces.remove, {
            workspaceId: ws,
            confirmName: "wrong",
          }),
        )
      ).code,
    ).toBe("INVALID_ARGUMENT");
    await owner.as.mutation(api.accounts.workspaces.remove, {
      workspaceId: ws,
      confirmName: "Studio",
    });
    expect(
      (await errorData(ed.as.query(api.accounts.workspaces.get, { workspaceId: ws }))).code,
    ).toBe("NOT_FOUND");
    const me = await owner.as.query(api.accounts.profiles.me, {});
    const personal = (await owner.as.query(api.accounts.workspaces.list, {}))[0];
    expect(me?.defaultWorkspaceId).toBe(personal?.id);
    expect(personal?.kind).toBe("personal");
    const personalErr = await errorData(
      owner.as.mutation(api.accounts.workspaces.remove, {
        workspaceId: personal?.id as Id<"workspaces">,
        confirmName: personal?.name ?? "",
      }),
    );
    expect(personalErr.code).toBe("FORBIDDEN");
  });
});

describe("folders", () => {
  beforeEach(() => vi.stubEnv("DESYN_EDITION", "selfhost"));
  afterEach(() => vi.unstubAllEnvs());

  test("nesting, cycle prevention, depth limit and recursive delete", async () => {
    const t = setupTest();
    const u = await createUser(t);
    const [ws] = await u.as.query(api.accounts.workspaces.list, {});
    if (!ws) throw new Error("no workspace");
    const a = await u.as.mutation(api.accounts.folders.create, { workspaceId: ws.id, name: "A" });
    const b = await u.as.mutation(api.accounts.folders.create, {
      workspaceId: ws.id,
      name: "B",
      parentId: a,
    });
    const c = await u.as.mutation(api.accounts.folders.create, {
      workspaceId: ws.id,
      name: "C",
      parentId: b,
    });
    expect(
      (await errorData(u.as.mutation(api.accounts.folders.move, { folderId: a, parentId: c })))
        .code,
    ).toBe("INVALID_ARGUMENT");
    expect(
      (
        await errorData(
          u.as.mutation(api.accounts.folders.create, { workspaceId: ws.id, name: "  " }),
        )
      ).code,
    ).toBe("INVALID_ARGUMENT");
    let parent = c;
    for (let depth = 4; depth <= 8; depth++) {
      parent = await u.as.mutation(api.accounts.folders.create, {
        workspaceId: ws.id,
        name: `D${depth}`,
        parentId: parent,
      });
    }
    expect(
      (
        await errorData(
          u.as.mutation(api.accounts.folders.create, {
            workspaceId: ws.id,
            name: "too deep",
            parentId: parent,
          }),
        )
      ).code,
    ).toBe("INVALID_ARGUMENT");
    await u.as.mutation(api.accounts.folders.move, { folderId: c, parentId: null });
    await u.as.mutation(api.accounts.folders.update, {
      folderId: c,
      name: "Renamed",
      color: "#FFB02E",
    });
    const listed = await u.as.query(api.accounts.folders.list, { workspaceId: ws.id });
    expect(listed.find((f) => f.id === c)).toMatchObject({
      parentId: null,
      name: "Renamed",
      color: "#ffb02e",
    });
    const removed = await u.as.mutation(api.accounts.folders.remove, { folderId: a });
    expect(removed.deleted).toBe(2);
    const rest = await u.as.query(api.accounts.folders.list, { workspaceId: ws.id });
    expect(rest.map((f) => f.name)).not.toContain("A");
    expect(rest.map((f) => f.name)).toContain("Renamed");
  });
});
