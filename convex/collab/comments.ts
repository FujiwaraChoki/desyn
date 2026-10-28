import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { type MutationCtx, mutation, type QueryCtx, query } from "../_generated/server";
import { enqueueEmail } from "../emails/queue";
import {
  getDesignOrThrow,
  permissionAtLeast,
  requireDesignPermission,
  requireDesignWriter,
  shareArg,
} from "../lib/designs_access";
import { MAX_COMMENT_LENGTH, MAX_MENTIONS } from "../lib/designs_limits";
import { assertWorkspaceFeature } from "../lib/entitlements";
import { appUrl } from "../lib/env";
import { errors } from "../lib/errors";
import { getMembership, getProfile } from "../lib/guards";
import { createLogger } from "../lib/logger";

// comments.* : threads anchored to a page position or a node, replies, @mentions (emailed), resolve.
// Commenting needs the comment permission (commenter+ members or a comment/edit share link while signed in)
// and the workspace plan feature `collab.comments`.

type DbCtx = QueryCtx | MutationCtx;

function cleanBody(body: string): string {
  const trimmed = body.trim();
  if (trimmed.length === 0) throw errors.invalid("The comment is empty.", "body");
  if (trimmed.length > MAX_COMMENT_LENGTH) {
    throw errors.invalid(`Comments can be at most ${MAX_COMMENT_LENGTH} characters.`, "body");
  }
  return trimmed;
}

/** Mentioned users must be members of the design's workspace; others are ignored. */
async function validMentions(
  ctx: DbCtx,
  design: Doc<"designs">,
  mentions: string[] | undefined,
): Promise<string[]> {
  const unique = [...new Set(mentions ?? [])];
  if (unique.length > MAX_MENTIONS)
    throw errors.invalid(`At most ${MAX_MENTIONS} mentions per comment.`, "mentions");
  const out: string[] = [];
  for (const userId of unique) {
    if (await getMembership(ctx, design.workspaceId, userId)) out.push(userId);
  }
  return out;
}

async function notifyMentions(
  ctx: MutationCtx,
  args: {
    design: Doc<"designs">;
    authorId: string;
    mentions: string[];
    body: string;
    threadId: Id<"comments">;
    commentId: Id<"comments">;
  },
): Promise<void> {
  const recipients = args.mentions.filter((id) => id !== args.authorId);
  if (recipients.length === 0) return;
  const author = await getProfile(ctx, args.authorId);
  const log = createLogger(ctx, { fn: "comments.notify", designId: args.design._id });
  for (const userId of recipients) {
    const profile = await getProfile(ctx, userId);
    if (!profile?.email || profile.disabled) continue;
    try {
      await enqueueEmail(ctx, {
        to: profile.email,
        template: "commentMention",
        userId,
        idempotencyKey: `mention:${args.commentId}:${userId}`,
        data: {
          authorName: author?.name || "A collaborator",
          designName: args.design.name,
          excerpt: args.body.length > 280 ? `${args.body.slice(0, 277)}...` : args.body,
          url: `${appUrl()}/design/${args.design._id}?comment=${args.threadId}`,
        },
      });
    } catch (err) {
      log.warn("mention email not queued", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  await log.flush();
}

async function people(ctx: DbCtx, ids: Iterable<string>) {
  const out = new Map<string, { id: string; name: string; image: string | null }>();
  for (const id of ids) {
    if (out.has(id)) continue;
    const p = await getProfile(ctx, id);
    out.set(id, { id, name: p?.name ?? "Deleted user", image: p?.image ?? null });
  }
  return out;
}

function commentView(
  c: Doc<"comments">,
  authors: Map<string, { id: string; name: string; image: string | null }>,
) {
  const deleted = c.deletedAt !== undefined;
  return {
    id: c._id,
    threadId: c.threadId ?? null,
    body: deleted ? "" : c.body,
    deleted,
    author: authors.get(c.authorId) ?? { id: c.authorId, name: "Deleted user", image: null },
    mentions: deleted ? [] : c.mentions,
    createdAt: c.createdAt,
    editedAt: c.editedAt ?? null,
  };
}

export const list = query({
  args: {
    designId: v.id("designs"),
    includeResolved: v.optional(v.boolean()),
    nodeId: v.optional(v.string()),
    share: shareArg,
  },
  handler: async (ctx, args) => {
    const design = await getDesignOrThrow(ctx, args.designId);
    await requireDesignPermission(ctx, design, "view", { share: args.share });
    const roots = (
      await ctx.db
        .query("comments")
        .withIndex("by_design_root_activity", (q) =>
          q.eq("designId", design._id).eq("threadId", undefined),
        )
        .order("desc")
        .take(300)
    ).filter(
      (c) =>
        (args.includeResolved || !c.resolved) &&
        (!args.nodeId || c.nodeId === args.nodeId) &&
        (c.deletedAt === undefined || c.replyCount > 0),
    );
    const threads = [];
    for (const root of roots) {
      const replies = await ctx.db
        .query("comments")
        .withIndex("by_thread_created", (q) => q.eq("threadId", root._id))
        .take(500);
      const authors = await people(ctx, [
        root.authorId,
        ...replies.map((r) => r.authorId),
        ...(root.resolvedBy ? [root.resolvedBy] : []),
      ]);
      threads.push({
        ...commentView(root, authors),
        nodeId: root.nodeId ?? null,
        pageId: root.pageId ?? null,
        x: root.x ?? null,
        y: root.y ?? null,
        resolved: root.resolved,
        resolvedBy: root.resolvedBy ? (authors.get(root.resolvedBy) ?? null) : null,
        resolvedAt: root.resolvedAt ?? null,
        lastActivityAt: root.lastActivityAt,
        replies: replies
          .filter((r) => r.deletedAt === undefined)
          .map((r) => commentView(r, authors)),
      });
    }
    return threads;
  },
});

/** Members that can be @mentioned on this design. */
export const mentionable = query({
  args: { designId: v.id("designs") },
  handler: async (ctx, args) => {
    const design = await getDesignOrThrow(ctx, args.designId);
    const access = await requireDesignPermission(ctx, design, "comment");
    if (access.via !== "member") return [];
    const members = await ctx.db
      .query("memberships")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", design.workspaceId))
      .take(500);
    const out = [];
    for (const m of members) {
      const p = await getProfile(ctx, m.userId);
      if (p && !p.disabled)
        out.push({ id: m.userId, name: p.name, image: p.image ?? null, role: m.role });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  },
});

export const create = mutation({
  args: {
    designId: v.id("designs"),
    body: v.string(),
    nodeId: v.optional(v.string()),
    pageId: v.optional(v.string()),
    x: v.optional(v.number()),
    y: v.optional(v.number()),
    mentions: v.optional(v.array(v.string())),
    share: shareArg,
  },
  handler: async (ctx, args): Promise<Id<"comments">> => {
    const design = await getDesignOrThrow(ctx, args.designId);
    const access = await requireDesignWriter(ctx, design, "comment", { share: args.share });
    await assertWorkspaceFeature(ctx, design.workspaceId, "collab.comments");
    for (const [field, value] of [
      ["x", args.x],
      ["y", args.y],
    ] as const) {
      if (value !== undefined && !Number.isFinite(value))
        throw errors.invalid(`${field} must be a number.`, field);
    }
    const body = cleanBody(args.body);
    const mentions = await validMentions(ctx, design, args.mentions);
    const now = Date.now();
    const id = await ctx.db.insert("comments", {
      designId: design._id,
      authorId: access.userId,
      body,
      mentions,
      ...(args.nodeId ? { nodeId: args.nodeId.slice(0, 32) } : {}),
      ...(args.pageId ? { pageId: args.pageId.slice(0, 32) } : {}),
      ...(args.x !== undefined ? { x: args.x } : {}),
      ...(args.y !== undefined ? { y: args.y } : {}),
      resolved: false,
      replyCount: 0,
      lastActivityAt: now,
      createdAt: now,
    });
    await notifyMentions(ctx, {
      design,
      authorId: access.userId,
      mentions,
      body,
      threadId: id,
      commentId: id,
    });
    return id;
  },
});

async function loadThread(ctx: DbCtx, threadId: Id<"comments">): Promise<Doc<"comments">> {
  const root = await ctx.db.get("comments", threadId);
  if (!root || root.threadId !== undefined) throw errors.notFound("Comment thread");
  return root;
}

export const reply = mutation({
  args: {
    threadId: v.id("comments"),
    body: v.string(),
    mentions: v.optional(v.array(v.string())),
    share: shareArg,
  },
  handler: async (ctx, args): Promise<Id<"comments">> => {
    const root = await loadThread(ctx, args.threadId);
    const design = await getDesignOrThrow(ctx, root.designId);
    const access = await requireDesignWriter(ctx, design, "comment", { share: args.share });
    await assertWorkspaceFeature(ctx, design.workspaceId, "collab.comments");
    const body = cleanBody(args.body);
    const mentions = await validMentions(ctx, design, args.mentions);
    const now = Date.now();
    const id = await ctx.db.insert("comments", {
      designId: design._id,
      threadId: root._id,
      authorId: access.userId,
      body,
      mentions,
      resolved: false,
      replyCount: 0,
      lastActivityAt: now,
      createdAt: now,
    });
    // A reply reopens a resolved thread.
    await ctx.db.patch("comments", root._id, {
      replyCount: root.replyCount + 1,
      lastActivityAt: now,
      ...(root.resolved ? { resolved: false, resolvedBy: undefined, resolvedAt: undefined } : {}),
    });
    await notifyMentions(ctx, {
      design,
      authorId: access.userId,
      mentions,
      body,
      threadId: root._id,
      commentId: id,
    });
    return id;
  },
});

export const edit = mutation({
  args: {
    commentId: v.id("comments"),
    body: v.string(),
    mentions: v.optional(v.array(v.string())),
    share: shareArg,
  },
  handler: async (ctx, args) => {
    const comment = await ctx.db.get("comments", args.commentId);
    if (!comment || comment.deletedAt !== undefined) throw errors.notFound("Comment");
    const design = await getDesignOrThrow(ctx, comment.designId);
    // Authors who lost the comment permission (role change, link revoked) can no longer edit.
    const access = await requireDesignWriter(ctx, design, "comment", { share: args.share });
    if (comment.authorId !== access.userId)
      throw errors.forbidden("Only the author can edit a comment.");
    const body = cleanBody(args.body);
    const mentions =
      args.mentions !== undefined
        ? await validMentions(ctx, design, args.mentions)
        : comment.mentions;
    await ctx.db.patch("comments", comment._id, { body, mentions, editedAt: Date.now() });
    const added = mentions.filter((m) => !comment.mentions.includes(m));
    await notifyMentions(ctx, {
      design,
      authorId: access.userId,
      mentions: added,
      body,
      threadId: comment.threadId ?? comment._id,
      commentId: comment._id,
    });
    return null;
  },
});

const remove = mutation({
  args: { commentId: v.id("comments"), share: shareArg },
  handler: async (ctx, args) => {
    const comment = await ctx.db.get("comments", args.commentId);
    if (!comment || comment.deletedAt !== undefined) return null;
    const design = await getDesignOrThrow(ctx, comment.designId);
    // Authors may always take their own words back (view is enough); others need manage.
    const access = await requireDesignWriter(ctx, design, "view", { share: args.share });
    if (comment.authorId !== access.userId && !permissionAtLeast(access.permission, "manage")) {
      throw errors.forbidden("Only the author or a design manager can delete this comment.");
    }
    if (comment.threadId === undefined) {
      if (comment.replyCount > 0) {
        await ctx.db.patch("comments", comment._id, {
          deletedAt: Date.now(),
          body: "",
          mentions: [],
        });
      } else await ctx.db.delete("comments", comment._id);
      return null;
    }
    await ctx.db.delete("comments", comment._id);
    const root = await ctx.db.get("comments", comment.threadId);
    if (root) {
      const replyCount = Math.max(0, root.replyCount - 1);
      if (replyCount === 0 && root.deletedAt !== undefined)
        await ctx.db.delete("comments", root._id);
      else await ctx.db.patch("comments", root._id, { replyCount });
    }
    return null;
  },
});

export { remove as delete };

export const resolve = mutation({
  args: { threadId: v.id("comments"), resolved: v.boolean(), share: shareArg },
  handler: async (ctx, args) => {
    const root = await loadThread(ctx, args.threadId);
    const design = await getDesignOrThrow(ctx, root.designId);
    const access = await requireDesignWriter(ctx, design, "comment", { share: args.share });
    const now = Date.now();
    await ctx.db.patch(
      "comments",
      root._id,
      args.resolved
        ? { resolved: true, resolvedBy: access.userId, resolvedAt: now, lastActivityAt: now }
        : { resolved: false, resolvedBy: undefined, resolvedAt: undefined, lastActivityAt: now },
    );
    return null;
  },
});
