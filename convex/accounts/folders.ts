import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { type MutationCtx, mutation, query } from "../_generated/server";
import { errors } from "../lib/errors";
import { requireMember } from "../lib/guards";

export const MAX_FOLDER_DEPTH = 8;
const COLOR = /^#[0-9a-fA-F]{6}$/;

function validateName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length < 1 || trimmed.length > 80)
    throw errors.invalid("Folder name must be 1-80 characters.", "name");
  return trimmed;
}

function view(f: Doc<"folders">) {
  return {
    id: f._id,
    workspaceId: f.workspaceId,
    parentId: f.parentId ?? null,
    name: f.name,
    color: f.color ?? null,
    sort: f.sort ?? null,
    createdBy: f.createdBy,
    createdAt: f.createdAt,
    updatedAt: f.updatedAt,
  };
}

/** Depth of a folder (root-level folder = 1). */
async function depthOf(ctx: MutationCtx, folderId: Id<"folders">): Promise<number> {
  let depth = 0;
  let current: Id<"folders"> | undefined = folderId;
  while (current) {
    depth++;
    if (depth > MAX_FOLDER_DEPTH + 1) break;
    const folder: Doc<"folders"> | null = await ctx.db.get("folders", current);
    current = folder?.parentId;
  }
  return depth;
}

/** Height of the subtree rooted at a folder (leaf = 1). */
async function subtreeHeight(ctx: MutationCtx, folder: Doc<"folders">): Promise<number> {
  const children = await ctx.db
    .query("folders")
    .withIndex("by_workspace_parent", (q) =>
      q.eq("workspaceId", folder.workspaceId).eq("parentId", folder._id),
    )
    .collect();
  let max = 0;
  for (const child of children) max = Math.max(max, await subtreeHeight(ctx, child));
  return max + 1;
}

async function loadFolder(ctx: MutationCtx, folderId: Id<"folders">) {
  const folder = await ctx.db.get("folders", folderId);
  if (!folder) throw errors.notFound("Folder");
  const access = await requireMember(ctx, folder.workspaceId, "editor");
  return { folder, access };
}

/** All folders of a workspace, flat (clients build the tree from parentId). */
export const list = query({
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, args) => {
    await requireMember(ctx, args.workspaceId, "viewer");
    const rows = await ctx.db
      .query("folders")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
      .collect();
    return rows
      .map(view)
      .sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0) || a.name.localeCompare(b.name));
  },
});

export const create = mutation({
  args: {
    workspaceId: v.id("workspaces"),
    name: v.string(),
    parentId: v.optional(v.id("folders")),
    color: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const access = await requireMember(ctx, args.workspaceId, "editor");
    const name = validateName(args.name);
    if (args.color && !COLOR.test(args.color))
      throw errors.invalid("Color must be #RRGGBB.", "color");
    if (args.parentId) {
      const parent = await ctx.db.get("folders", args.parentId);
      if (!parent || parent.workspaceId !== args.workspaceId)
        throw errors.notFound("Parent folder");
      if ((await depthOf(ctx, args.parentId)) >= MAX_FOLDER_DEPTH) {
        throw errors.invalid(
          `Folders can be nested at most ${MAX_FOLDER_DEPTH} levels deep.`,
          "parentId",
        );
      }
    }
    const now = Date.now();
    return await ctx.db.insert("folders", {
      workspaceId: args.workspaceId,
      ...(args.parentId ? { parentId: args.parentId } : {}),
      name,
      ...(args.color ? { color: args.color.toLowerCase() } : {}),
      createdBy: access.userId,
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const update = mutation({
  args: {
    folderId: v.id("folders"),
    name: v.optional(v.string()),
    color: v.optional(v.union(v.string(), v.null())),
    sort: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const { folder } = await loadFolder(ctx, args.folderId);
    const patch: Partial<Doc<"folders">> = { updatedAt: Date.now() };
    if (args.name !== undefined) patch.name = validateName(args.name);
    if (args.color !== undefined) {
      if (args.color !== null && !COLOR.test(args.color))
        throw errors.invalid("Color must be #RRGGBB.", "color");
      patch.color = args.color?.toLowerCase() ?? undefined;
    }
    if (args.sort !== undefined) {
      if (!Number.isFinite(args.sort)) throw errors.invalid("Invalid sort value.", "sort");
      patch.sort = args.sort;
    }
    await ctx.db.patch("folders", folder._id, patch);
    return null;
  },
});

/** Move a folder under another folder (or to the root with parentId null). Prevents cycles. */
export const move = mutation({
  args: { folderId: v.id("folders"), parentId: v.union(v.id("folders"), v.null()) },
  handler: async (ctx, args) => {
    const { folder } = await loadFolder(ctx, args.folderId);
    if (args.parentId === (folder.parentId ?? null)) return null;
    if (args.parentId) {
      const parent = await ctx.db.get("folders", args.parentId);
      if (!parent || parent.workspaceId !== folder.workspaceId)
        throw errors.notFound("Parent folder");
      // Walk up from the new parent; reaching the folder itself means a cycle.
      let cursor: Doc<"folders"> | null = parent;
      while (cursor) {
        if (cursor._id === folder._id)
          throw errors.invalid("A folder cannot move into itself.", "parentId");
        cursor = cursor.parentId ? await ctx.db.get("folders", cursor.parentId) : null;
      }
      const depth = (await depthOf(ctx, args.parentId)) + (await subtreeHeight(ctx, folder));
      if (depth > MAX_FOLDER_DEPTH) {
        throw errors.invalid(
          `Folders can be nested at most ${MAX_FOLDER_DEPTH} levels deep.`,
          "parentId",
        );
      }
    }
    await ctx.db.patch("folders", folder._id, {
      parentId: args.parentId ?? undefined,
      updatedAt: Date.now(),
    });
    return null;
  },
});

/**
 * Delete a folder and its subfolders. Items inside are handled by the registered folder cleanup
 * hooks (the designs owner moves designs to the workspace root).
 */
export const remove = mutation({
  args: { folderId: v.id("folders") },
  handler: async (ctx, args) => {
    const { folder } = await loadFolder(ctx, args.folderId);
    const ids: Id<"folders">[] = [];
    const queue: Id<"folders">[] = [folder._id];
    while (queue.length > 0) {
      const id = queue.shift() as Id<"folders">;
      ids.push(id);
      const children = await ctx.db
        .query("folders")
        .withIndex("by_workspace_parent", (q) =>
          q.eq("workspaceId", folder.workspaceId).eq("parentId", id),
        )
        .collect();
      for (const child of children) queue.push(child._id);
    }
    for (const id of ids) await ctx.db.delete("folders", id);
    await ctx.scheduler.runAfter(0, internal.accounts.cleanup.runFolderHooks, {
      workspaceId: folder.workspaceId,
      folderIds: ids,
    });
    return { deleted: ids.length };
  },
});
