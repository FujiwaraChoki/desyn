import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import { memberWithRole, workspaceOf } from "./designs.helpers";
import { createUser, errorData, setupTest } from "./harness.helpers";

beforeEach(() => vi.stubEnv("DESYN_EDITION", "selfhost"));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

async function fixture() {
  const t = setupTest();
  const owner = await createUser(t, { name: "Olivia Owner" });
  const workspaceId = await workspaceOf(owner);
  const { designId } = await owner.as.mutation(api.designs.designs.create, {
    workspaceId,
    name: "Poster",
  });
  return { t, owner, workspaceId, designId };
}

describe("presence", () => {
  test("heartbeat, list, distinct colors and expiry", async () => {
    vi.useFakeTimers();
    const start = Date.now();
    const { t, owner, workspaceId, designId } = await fixture();
    const editor = await memberWithRole(t, workspaceId, "editor");
    const a = await owner.as.mutation(api.collab.presence.heartbeat, {
      designId,
      sessionId: "session-owner-1",
      cursor: { x: 10, y: 20 },
      selection: ["abcdefghijkl"],
      viewport: { x: 0, y: 0, zoom: 1 },
    });
    const b = await editor.as.mutation(api.collab.presence.heartbeat, {
      designId,
      sessionId: "session-editor-1",
      editing: { nodeIds: ["abcdefghijkl"], kind: "text" },
      drag: JSON.stringify({ ids: ["abcdefghijkl"], dx: 4, dy: 2 }),
    });
    expect(a.intervalMs).toBe(5_000);
    expect(a.color).not.toBe(b.color);
    let list = await owner.as.query(api.collab.presence.list, { designId });
    expect(list).toHaveLength(2);
    const ownerRow = list.find((p) => p.sessionId === "session-owner-1");
    expect(ownerRow).toMatchObject({
      name: "Olivia Owner",
      cursor: { x: 10, y: 20 },
      selection: ["abcdefghijkl"],
    });
    expect(list.find((p) => p.sessionId === "session-editor-1")?.editing?.kind).toBe("text");

    // Clearing fields with null.
    await editor.as.mutation(api.collab.presence.heartbeat, {
      designId,
      sessionId: "session-editor-1",
      drag: null,
      editing: null,
    });
    list = await owner.as.query(api.collab.presence.list, { designId });
    expect(list.find((p) => p.sessionId === "session-editor-1")).toMatchObject({
      drag: null,
      editing: null,
    });

    // Sessions cannot be hijacked.
    expect(
      (
        await errorData(
          editor.as.mutation(api.collab.presence.heartbeat, {
            designId,
            sessionId: "session-owner-1",
          }),
        )
      ).code,
    ).toBe("FORBIDDEN");

    // The editor stops heart-beating: after the TTL they disappear from the list, and the cron deletes the row.
    vi.setSystemTime(start + 10_000);
    await owner.as.mutation(api.collab.presence.heartbeat, {
      designId,
      sessionId: "session-owner-1",
    });
    vi.setSystemTime(start + 20_000);
    list = await owner.as.query(api.collab.presence.list, { designId });
    expect(list.map((p) => p.sessionId)).toEqual(["session-owner-1"]);
    expect((await t.mutation(internal.collab.presence.cleanup, {})).deleted).toBe(1);

    await owner.as.mutation(api.collab.presence.leave, { designId, sessionId: "session-owner-1" });
    expect(await owner.as.query(api.collab.presence.list, { designId })).toEqual([]);
  });

  test("anonymous share viewers appear as guests; outsiders are rejected", async () => {
    const { t, owner, designId } = await fixture();
    const link = await owner.as.mutation(api.designs.designs.setShare, {
      designId,
      permission: "view",
    });
    const res = await t.mutation(api.collab.presence.heartbeat, {
      designId,
      sessionId: "anon-session-1",
      share: { token: link.token },
    });
    expect(res.color).toMatch(/^#[0-9a-f]{6}$/);
    const list = await owner.as.query(api.collab.presence.list, { designId });
    expect(list[0]).toMatchObject({ name: "Guest", userId: "guest:anon-session-1" });
    const outsider = await createUser(t);
    expect(
      (
        await errorData(
          outsider.as.mutation(api.collab.presence.heartbeat, {
            designId,
            sessionId: "outsider-1",
          }),
        )
      ).code,
    ).toBe("NOT_FOUND");
    expect(
      (
        await errorData(
          owner.as.mutation(api.collab.presence.heartbeat, { designId, sessionId: "bad id!" }),
        )
      ).code,
    ).toBe("INVALID_ARGUMENT");
  });
});

describe("comments", () => {
  test("threads, replies, mentions (emailed), resolve and delete", async () => {
    vi.stubEnv("MAIL_TRANSPORT", "log");
    vi.stubEnv("APP_URL", "https://app.desyn.test");
    const { t, owner, workspaceId, designId } = await fixture();
    const commenter = await memberWithRole(t, workspaceId, "commenter");
    const outsider = await createUser(t);
    const threadId = await owner.as.mutation(api.collab.comments.create, {
      designId,
      body: "Can we make the headline bigger?",
      pageId: "pagepagepage",
      x: 120,
      y: 80,
      mentions: [commenter.userId, outsider.userId],
    });
    const mail = await t.run(async (ctx) => ctx.db.query("mailLog").collect());
    const mention = mail.filter((m) => m.template === "commentMention");
    expect(mention.map((m) => m.to)).toEqual([commenter.email]);
    expect(mention[0]?.subject).toBe("Olivia Owner mentioned you in Poster");

    const replyId = await commenter.as.mutation(api.collab.comments.reply, {
      threadId,
      body: "On it",
    });
    let threads = await owner.as.query(api.collab.comments.list, { designId });
    expect(threads).toHaveLength(1);
    expect(threads[0]).toMatchObject({
      body: "Can we make the headline bigger?",
      mentions: [commenter.userId],
      x: 120,
      y: 80,
      resolved: false,
    });
    expect(threads[0]?.replies.map((r) => r.body)).toEqual(["On it"]);

    await commenter.as.mutation(api.collab.comments.resolve, { threadId, resolved: true });
    expect(await owner.as.query(api.collab.comments.list, { designId })).toHaveLength(0);
    threads = await owner.as.query(api.collab.comments.list, { designId, includeResolved: true });
    expect(threads[0]?.resolvedBy?.id).toBe(commenter.userId);

    expect(
      (
        await errorData(
          owner.as.mutation(api.collab.comments.edit, { commentId: replyId, body: "x" }),
        )
      ).code,
    ).toBe("FORBIDDEN");
    await commenter.as.mutation(api.collab.comments.edit, { commentId: replyId, body: "Done" });
    // Deleting a root with replies keeps the thread as a tombstone.
    await owner.as.mutation(api.collab.comments.delete, { commentId: threadId });
    threads = await owner.as.query(api.collab.comments.list, { designId, includeResolved: true });
    expect(threads[0]).toMatchObject({ deleted: true, body: "" });
    expect(threads[0]?.replies[0]?.body).toBe("Done");
    await commenter.as.mutation(api.collab.comments.delete, { commentId: replyId });
    expect(
      await owner.as.query(api.collab.comments.list, { designId, includeResolved: true }),
    ).toEqual([]);

    const mentionable = await owner.as.query(api.collab.comments.mentionable, { designId });
    expect(mentionable.map((m) => m.id).sort()).toEqual([owner.userId, commenter.userId].sort());
  });

  test("share-link commenters edit and delete their own comments; demoted authors cannot edit", async () => {
    const { t, owner, workspaceId, designId } = await fixture();
    const { token } = await owner.as.mutation(api.designs.designs.setShare, {
      designId,
      permission: "comment",
    });
    const guest = await createUser(t);
    const share = { token };
    const id = await guest.as.mutation(api.collab.comments.create, {
      designId,
      body: "Typo in the footer",
      share,
    });
    await guest.as.mutation(api.collab.comments.edit, { commentId: id, body: "Fixed?", share });
    let threads = await owner.as.query(api.collab.comments.list, { designId });
    expect(threads[0]?.body).toBe("Fixed?");
    await guest.as.mutation(api.collab.comments.delete, { commentId: id, share });
    expect(await owner.as.query(api.collab.comments.list, { designId })).toEqual([]);

    // A member demoted to viewer can no longer edit what they wrote (but may still delete it).
    const member = await memberWithRole(t, workspaceId, "commenter");
    const mine = await member.as.mutation(api.collab.comments.create, { designId, body: "v1" });
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("memberships")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
        .filter((q) => q.eq(q.field("userId"), member.userId))
        .unique();
      if (row) await ctx.db.patch("memberships", row._id, { role: "viewer" });
    });
    expect(
      (
        await errorData(
          member.as.mutation(api.collab.comments.edit, { commentId: mine, body: "v2" }),
        )
      ).code,
    ).toBe("FORBIDDEN");
    await member.as.mutation(api.collab.comments.delete, { commentId: mine });
    threads = await owner.as.query(api.collab.comments.list, { designId });
    expect(threads).toEqual([]);
  });

  test("comments are a plan feature on hosted", async () => {
    vi.stubEnv("DESYN_EDITION", "hosted");
    const { owner, designId } = await fixture();
    expect(
      await errorData(owner.as.mutation(api.collab.comments.create, { designId, body: "hi" })),
    ).toMatchObject({
      code: "FEATURE_UNAVAILABLE",
      feature: "collab.comments",
    });
  });
});
