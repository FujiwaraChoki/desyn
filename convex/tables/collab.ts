import { defineTable } from "convex/server";
import { v } from "convex/values";

// Comments and live presence. Owned by the designs agent.

export const collabTables = {
  /** Root comments (`threadId` absent) start threads; replies point at their root. */
  comments: defineTable({
    designId: v.id("designs"),
    threadId: v.optional(v.id("comments")),
    authorId: v.string(),
    body: v.string(),
    /** Mentioned user ids (workspace members). */
    mentions: v.array(v.string()),
    nodeId: v.optional(v.string()),
    pageId: v.optional(v.string()),
    /** Anchor in page coordinates (design px), or relative to `nodeId` when set. */
    x: v.optional(v.number()),
    y: v.optional(v.number()),
    resolved: v.boolean(),
    resolvedBy: v.optional(v.string()),
    resolvedAt: v.optional(v.number()),
    replyCount: v.number(),
    lastActivityAt: v.number(),
    editedAt: v.optional(v.number()),
    deletedAt: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_design_root_activity", ["designId", "threadId", "lastActivityAt"])
    .index("by_thread_created", ["threadId", "createdAt"])
    .index("by_design_node", ["designId", "nodeId"]),

  /** Ephemeral collaborator state; never enters history. Expired rows are removed by a cron. */
  presence: defineTable({
    designId: v.id("designs"),
    userId: v.string(),
    sessionId: v.string(),
    name: v.string(),
    image: v.optional(v.string()),
    color: v.string(),
    cursor: v.optional(v.object({ x: v.number(), y: v.number(), pageId: v.optional(v.string()) })),
    selection: v.array(v.string()),
    viewport: v.optional(
      v.object({
        x: v.number(),
        y: v.number(),
        zoom: v.number(),
        width: v.optional(v.number()),
        height: v.optional(v.number()),
        pageId: v.optional(v.string()),
      }),
    ),
    /** JSON of a live drag preview (e.g. `{ ids, dx, dy }` or partial node patches); opaque to the server. */
    drag: v.optional(v.string()),
    /** "AI is editing X" / "typing in X" markers. */
    editing: v.optional(
      v.object({
        nodeIds: v.array(v.string()),
        kind: v.union(v.literal("text"), v.literal("ai"), v.literal("transform")),
        label: v.optional(v.string()),
      }),
    ),
    expiresAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_design_session", ["designId", "sessionId"])
    .index("by_design_expires", ["designId", "expiresAt"])
    .index("by_expires", ["expiresAt"]),
};
