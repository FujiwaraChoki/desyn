import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import {
  internalMutation,
  type MutationCtx,
  mutation,
  type QueryCtx,
  query,
} from "../_generated/server";
import { assetView, urlFor } from "../assets/assets";
import { errors } from "../lib/errors";
import { requireMember } from "../lib/guards";

// Upload folders for the editor's Uploads panel: named groups of a workspace's library assets. Viewers can
// browse; editors create, rename, delete folders and move assets (an asset lives in at most one folder).
// Deleting a folder never deletes assets.

const MAX_FOLDERS = 200;
const MAX_MOVE = 100;
/** Folder counts stop here (the panel shows "99+"), keeping the list query's reads bounded. */
const COUNT_CAP = 100;
/**
 * Asset rows the list query may read to check that counted items are still ready. 200 folders x 100 items
 * would otherwise read up to 40k documents (above Convex's per-transaction read limit); past this budget the
 * remaining folders count their item rows without the status check.
 */
const STATUS_CHECK_BUDGET = 2_000;

function cleanName(name: string): string {
  const n = name
    .replace(/\p{Cc}+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (n.length < 1 || n.length > 60)
    throw errors.invalid("Folder names are 1 to 60 characters.", "name");
  return n;
}

async function folderFor(
  ctx: QueryCtx | MutationCtx,
  folderId: Id<"assetFolders">,
  role: "viewer" | "editor",
): Promise<Doc<"assetFolders">> {
  const folder = await ctx.db.get("assetFolders", folderId);
  if (!folder) throw errors.notFound("Folder");
  await requireMember(ctx, folder.workspaceId, role);
  return folder;
}

/** Folders of a workspace with their item counts, by name. */
export const list = query({
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, args) => {
    await requireMember(ctx, args.workspaceId, "viewer");
    const folders = await ctx.db
      .query("assetFolders")
      .withIndex("by_workspace_name", (q) => q.eq("workspaceId", args.workspaceId))
      .take(MAX_FOLDERS);
    const out = [];
    let budget = STATUS_CHECK_BUDGET;
    for (const f of folders) {
      const items = await ctx.db
        .query("assetFolderItems")
        .withIndex("by_folder_added", (q) => q.eq("folderId", f._id))
        .take(COUNT_CAP);
      let count = 0;
      for (const item of items) {
        if (budget <= 0) {
          count++;
          continue;
        }
        budget--;
        const asset = await ctx.db.get("assets", item.assetId);
        if (asset?.status === "ready") count++;
      }
      out.push({ id: f._id, name: f.name, count, createdAt: f.createdAt });
    }
    return out;
  },
});

export const create = mutation({
  args: { workspaceId: v.id("workspaces"), name: v.string() },
  handler: async (ctx, args): Promise<Id<"assetFolders">> => {
    const { userId } = await requireMember(ctx, args.workspaceId, "editor");
    const name = cleanName(args.name);
    const existing = await ctx.db
      .query("assetFolders")
      .withIndex("by_workspace_name", (q) => q.eq("workspaceId", args.workspaceId))
      .take(MAX_FOLDERS + 1);
    if (existing.length >= MAX_FOLDERS)
      throw errors.invalid(`A workspace can have at most ${MAX_FOLDERS} upload folders.`, "name");
    const same = existing.find((f) => f.name.toLowerCase() === name.toLowerCase());
    if (same) return same._id;
    const now = Date.now();
    return await ctx.db.insert("assetFolders", {
      workspaceId: args.workspaceId,
      name,
      createdBy: userId,
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const rename = mutation({
  args: { folderId: v.id("assetFolders"), name: v.string() },
  handler: async (ctx, args) => {
    await folderFor(ctx, args.folderId, "editor");
    await ctx.db.patch("assetFolders", args.folderId, {
      name: cleanName(args.name),
      updatedAt: Date.now(),
    });
    return null;
  },
});

/** Deletes a folder (its assets stay in the library). */
export const remove = mutation({
  args: { folderId: v.id("assetFolders") },
  handler: async (ctx, args) => {
    await folderFor(ctx, args.folderId, "editor");
    const items = await ctx.db
      .query("assetFolderItems")
      .withIndex("by_folder_added", (q) => q.eq("folderId", args.folderId))
      .take(5_000);
    for (const item of items) await ctx.db.delete("assetFolderItems", item._id);
    await ctx.db.delete("assetFolders", args.folderId);
    return null;
  },
});

/** Ready assets of a folder, newest first (same view as `assets.list`). */
export const assets = query({
  args: { folderId: v.id("assetFolders"), paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    await folderFor(ctx, args.folderId, "viewer");
    const page = await ctx.db
      .query("assetFolderItems")
      .withIndex("by_folder_added", (q) => q.eq("folderId", args.folderId))
      .order("desc")
      .paginate(args.paginationOpts);
    const now = Date.now();
    const out = [];
    for (const item of page.page) {
      const asset = await ctx.db.get("assets", item.assetId);
      if (asset?.status === "ready") out.push(assetView(asset, urlFor(asset, now)));
    }
    return { ...page, page: out };
  },
});

/** Moves assets into a folder (`folderId: null` takes them out of any folder). */
export const move = mutation({
  args: {
    workspaceId: v.id("workspaces"),
    assetIds: v.array(v.id("assets")),
    folderId: v.union(v.id("assetFolders"), v.null()),
  },
  handler: async (ctx, args) => {
    await requireMember(ctx, args.workspaceId, "editor");
    if (args.assetIds.length > MAX_MOVE)
      throw errors.invalid(`Move at most ${MAX_MOVE} files at once.`, "assetIds");
    if (args.folderId) {
      const folder = await ctx.db.get("assetFolders", args.folderId);
      if (!folder || folder.workspaceId !== args.workspaceId) throw errors.notFound("Folder");
    }
    const now = Date.now();
    for (const assetId of new Set(args.assetIds)) {
      const asset = await ctx.db.get("assets", assetId);
      if (!asset || asset.workspaceId !== args.workspaceId || asset.status === "deleted")
        throw errors.notFound("Asset");
      const current = await ctx.db
        .query("assetFolderItems")
        .withIndex("by_asset", (q) => q.eq("assetId", assetId))
        .take(10);
      for (const row of current) {
        if (row.folderId !== args.folderId) await ctx.db.delete("assetFolderItems", row._id);
      }
      if (args.folderId && !current.some((row) => row.folderId === args.folderId)) {
        await ctx.db.insert("assetFolderItems", {
          workspaceId: args.workspaceId,
          folderId: args.folderId,
          assetId,
          addedAt: now,
        });
      }
    }
    return null;
  },
});

const BATCH = 200;

/** Workspace deletion hook (convex/accounts/cleanup.ts): removes folders and their item rows. */
export const workspaceCleanup = internalMutation({
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, args) => {
    const items = await ctx.db
      .query("assetFolderItems")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
      .take(BATCH);
    for (const item of items) await ctx.db.delete("assetFolderItems", item._id);
    if (items.length === BATCH) return { done: false };
    const folders = await ctx.db
      .query("assetFolders")
      .withIndex("by_workspace_name", (q) => q.eq("workspaceId", args.workspaceId))
      .take(BATCH);
    for (const f of folders) await ctx.db.delete("assetFolders", f._id);
    return { done: folders.length < BATCH };
  },
});
