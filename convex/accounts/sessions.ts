import { v } from "convex/values";
import { components } from "../_generated/api";
import { type MutationCtx, mutation, type QueryCtx, query } from "../_generated/server";
import { writeAudit } from "../lib/audit";
import { errors } from "../lib/errors";
import { requireUser } from "../lib/guards";

// Session management on top of the Better Auth component tables. Browser clients can also use the
// Better Auth client (`authClient.listSessions()` / `revokeSession()`); native clients use these.

interface SessionDoc {
  _id: string;
  userId: string;
  expiresAt: number;
  createdAt: number;
  updatedAt: number;
  ipAddress?: string | null;
  userAgent?: string | null;
}

async function currentSessionId(ctx: QueryCtx | MutationCtx): Promise<string | null> {
  const identity = await ctx.auth.getUserIdentity();
  const sessionId = identity?.sessionId;
  return typeof sessionId === "string" ? sessionId : null;
}

/** Active sessions of the signed-in user (tokens are never returned). */
export const list = query({
  args: {},
  handler: async (ctx) => {
    const user = await requireUser(ctx);
    const current = await currentSessionId(ctx);
    const result = (await ctx.runQuery(components.betterAuth.adapter.findMany, {
      model: "session",
      where: [{ field: "userId", value: user.userId }],
      paginationOpts: { cursor: null, numItems: 100 },
    })) as { page: SessionDoc[] };
    const now = Date.now();
    return result.page
      .filter((s) => s.expiresAt > now)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((s) => ({
        id: s._id,
        current: s._id === current,
        createdAt: s.createdAt,
        lastActiveAt: s.updatedAt,
        expiresAt: s.expiresAt,
        ipAddress: s.ipAddress ?? null,
        userAgent: s.userAgent ?? null,
      }));
  },
});

export const revoke = mutation({
  args: { sessionId: v.string() },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const deleted = await ctx.runMutation(components.betterAuth.adapter.deleteOne, {
      input: {
        model: "session",
        where: [
          { field: "_id", value: args.sessionId },
          { field: "userId", value: user.userId },
        ],
      },
    });
    if (!deleted) throw errors.notFound("Session");
    await writeAudit(ctx, {
      action: "session.revoked",
      actorId: user.userId,
      targetType: "session",
      targetId: args.sessionId,
    });
    return null;
  },
});

/** Sign out everywhere except the current session. */
export const revokeOthers = mutation({
  args: {},
  handler: async (ctx) => {
    const user = await requireUser(ctx);
    const current = await currentSessionId(ctx);
    const result = (await ctx.runQuery(components.betterAuth.adapter.findMany, {
      model: "session",
      where: [{ field: "userId", value: user.userId }],
      paginationOpts: { cursor: null, numItems: 200 },
    })) as { page: SessionDoc[] };
    let revoked = 0;
    for (const s of result.page) {
      if (s._id === current) continue;
      await ctx.runMutation(components.betterAuth.adapter.deleteOne, {
        input: { model: "session", where: [{ field: "_id", value: s._id }] },
      });
      revoked++;
    }
    if (revoked > 0) {
      await writeAudit(ctx, {
        action: "session.revoked",
        actorId: user.userId,
        data: { count: revoked },
      });
    }
    return { revoked };
  },
});
