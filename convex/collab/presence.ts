import { v } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import { internalMutation, mutation, query } from "../_generated/server";
import { getDesignOrThrow, requireDesignPermission, shareArg } from "../lib/designs_access";
import { utf8Length } from "../lib/designs_doc";
import {
  MAX_DRAG_BYTES,
  MAX_SELECTION,
  PRESENCE_HEARTBEAT_MS,
  PRESENCE_TTL_MS,
} from "../lib/designs_limits";
import { hasFeature } from "../lib/entitlements";
import { errors } from "../lib/errors";
import { getProfile } from "../lib/guards";

// presence.* : cursors, selections, viewports, live drag previews and "editing" markers. Clients heartbeat
// every 5 s; a row lives 15 s past its last heartbeat and a cron removes expired rows. Never enters history.

/** Collaborator colors, readable on dark and light canvases. */
export const PRESENCE_COLORS = [
  "#ff6b6b",
  "#ffa94d",
  "#fcc419",
  "#51cf66",
  "#20c997",
  "#22b8cf",
  "#4dabf7",
  "#748ffc",
  "#9775fa",
  "#da77f2",
  "#f783ac",
  "#e8590c",
] as const;

function hashString(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Stable color per user, skipping colors already taken by other active collaborators when possible. */
export function pickColor(userId: string, taken: ReadonlySet<string>): string {
  const start = hashString(userId) % PRESENCE_COLORS.length;
  for (let i = 0; i < PRESENCE_COLORS.length; i++) {
    const color = PRESENCE_COLORS[(start + i) % PRESENCE_COLORS.length] as string;
    if (!taken.has(color)) return color;
  }
  return PRESENCE_COLORS[start] as string;
}

const cursorValidator = v.object({ x: v.number(), y: v.number(), pageId: v.optional(v.string()) });
const viewportValidator = v.object({
  x: v.number(),
  y: v.number(),
  zoom: v.number(),
  width: v.optional(v.number()),
  height: v.optional(v.number()),
  pageId: v.optional(v.string()),
});
const editingValidator = v.object({
  nodeIds: v.array(v.string()),
  kind: v.union(v.literal("text"), v.literal("ai"), v.literal("transform")),
  label: v.optional(v.string()),
});

const SESSION_ID = /^[A-Za-z0-9_-]{8,64}$/;

export const heartbeat = mutation({
  args: {
    designId: v.id("designs"),
    sessionId: v.string(),
    cursor: v.optional(v.union(cursorValidator, v.null())),
    selection: v.optional(v.array(v.string())),
    viewport: v.optional(v.union(viewportValidator, v.null())),
    /** JSON of a live drag preview; null clears it. */
    drag: v.optional(v.union(v.string(), v.null())),
    editing: v.optional(v.union(editingValidator, v.null())),
    share: shareArg,
  },
  handler: async (ctx, args) => {
    if (!SESSION_ID.test(args.sessionId)) throw errors.invalid("Invalid session id.", "sessionId");
    const design = await getDesignOrThrow(ctx, args.designId);
    const access = await requireDesignPermission(ctx, design, "view", { share: args.share });
    const userId = access.userId ?? `guest:${args.sessionId}`;
    if (args.selection && args.selection.length > MAX_SELECTION) {
      throw errors.invalid(`At most ${MAX_SELECTION} selected layers.`, "selection");
    }
    if (typeof args.drag === "string" && utf8Length(args.drag) > MAX_DRAG_BYTES) {
      throw errors.invalid("The drag preview is too large.", "drag");
    }
    if (args.editing && args.editing.nodeIds.length > MAX_SELECTION) {
      throw errors.invalid(`At most ${MAX_SELECTION} layers per marker.`, "editing");
    }
    const now = Date.now();
    const expiresAt = now + PRESENCE_TTL_MS;
    // Live cursors, selections and drag previews are a plan feature of the design's workspace owner. Without
    // it nothing is broadcast and the client edits on its own (sync still merges everyone's changes).
    const workspace = await ctx.db.get("workspaces", design.workspaceId);
    if (!workspace || !(await hasFeature(ctx, workspace.ownerId, "collab.live"))) {
      return {
        color: pickColor(userId, new Set()),
        expiresAt,
        intervalMs: PRESENCE_HEARTBEAT_MS,
        live: false,
      };
    }
    const existing = await ctx.db
      .query("presence")
      .withIndex("by_design_session", (q) =>
        q.eq("designId", design._id).eq("sessionId", args.sessionId),
      )
      .unique();
    if (existing && existing.userId !== userId)
      throw errors.forbidden("This session belongs to someone else.");

    const fields: Partial<Doc<"presence">> = { expiresAt, updatedAt: now };
    if (args.cursor !== undefined) fields.cursor = args.cursor ?? undefined;
    if (args.selection !== undefined) fields.selection = args.selection;
    if (args.viewport !== undefined) fields.viewport = args.viewport ?? undefined;
    if (args.drag !== undefined) fields.drag = args.drag ?? undefined;
    if (args.editing !== undefined) {
      fields.editing = args.editing
        ? {
            ...args.editing,
            ...(args.editing.label ? { label: args.editing.label.slice(0, 80) } : {}),
          }
        : undefined;
    }

    if (existing) {
      await ctx.db.patch("presence", existing._id, fields);
      return { color: existing.color, expiresAt, intervalMs: PRESENCE_HEARTBEAT_MS, live: true };
    }
    const active = await ctx.db
      .query("presence")
      .withIndex("by_design_expires", (q) => q.eq("designId", design._id).gt("expiresAt", now))
      .take(100);
    const sameUser = active.find((p) => p.userId === userId);
    const color = sameUser?.color ?? pickColor(userId, new Set(active.map((p) => p.color)));
    const profile = access.userId ? await getProfile(ctx, access.userId) : null;
    await ctx.db.insert("presence", {
      designId: design._id,
      userId,
      sessionId: args.sessionId,
      name: profile?.name || "Guest",
      ...(profile?.image ? { image: profile.image } : {}),
      color,
      selection: args.selection ?? [],
      ...(args.cursor ? { cursor: args.cursor } : {}),
      ...(args.viewport ? { viewport: args.viewport } : {}),
      ...(typeof args.drag === "string" ? { drag: args.drag } : {}),
      ...(args.editing ? { editing: args.editing } : {}),
      expiresAt,
      updatedAt: now,
    });
    return { color, expiresAt, intervalMs: PRESENCE_HEARTBEAT_MS, live: true };
  },
});

export const leave = mutation({
  args: { designId: v.id("designs"), sessionId: v.string(), share: shareArg },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("presence")
      .withIndex("by_design_session", (q) =>
        q.eq("designId", args.designId).eq("sessionId", args.sessionId),
      )
      .unique();
    if (!row) return null;
    const design = await getDesignOrThrow(ctx, args.designId);
    const access = await requireDesignPermission(ctx, design, "view", { share: args.share });
    if (row.userId !== (access.userId ?? `guest:${args.sessionId}`)) {
      throw errors.forbidden("This session belongs to someone else.");
    }
    await ctx.db.delete("presence", row._id);
    return null;
  },
});

/** Active collaborators on a design (expired rows are filtered even before the cleanup cron runs). */
export const list = query({
  args: { designId: v.id("designs"), share: shareArg },
  handler: async (ctx, args) => {
    const design = await getDesignOrThrow(ctx, args.designId);
    await requireDesignPermission(ctx, design, "view", { share: args.share });
    const now = Date.now();
    const rows = await ctx.db
      .query("presence")
      .withIndex("by_design_expires", (q) => q.eq("designId", design._id).gt("expiresAt", now))
      .take(200);
    return rows.map((p) => ({
      sessionId: p.sessionId,
      userId: p.userId,
      name: p.name,
      image: p.image ?? null,
      color: p.color,
      cursor: p.cursor ?? null,
      selection: p.selection,
      viewport: p.viewport ?? null,
      drag: p.drag ?? null,
      editing: p.editing ?? null,
      expiresAt: p.expiresAt,
      updatedAt: p.updatedAt,
    }));
  },
});

/** Cron: delete expired presence rows. */
export const cleanup = internalMutation({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db
      .query("presence")
      .withIndex("by_expires", (q) => q.lt("expiresAt", Date.now()))
      .take(500);
    for (const row of rows) await ctx.db.delete("presence", row._id);
    return { deleted: rows.length };
  },
});
