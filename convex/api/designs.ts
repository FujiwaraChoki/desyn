import { newId, type Transaction } from "@desyn/schema";
import type { PaginationResult } from "convex/server";
import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
} from "../_generated/server";
import { createDesignFor } from "../designs/designs";
import { startPurge } from "../designs/maintenance";
import {
  apiDesignView,
  designOf,
  idOf,
  type Principal,
  principalValidator,
} from "../lib/api_principal";
import { requireDesignPermission, requireDesignWriter } from "../lib/designs_access";
import { resolveDesignAssetUrls } from "../lib/designs_assets";
import { commitTransaction } from "../lib/designs_commit";
import { LOAD_PAGE_MAX_BYTES, LOAD_PAGE_SIZE, MAX_NAME_LENGTH } from "../lib/designs_limits";
import type { CommitResult, LoadPage } from "../lib/designs_wire";
import { assertLimit } from "../lib/entitlements";
import { errors } from "../lib/errors";
import { requireMember } from "../lib/guards";
import { incrementUsage } from "../lib/usage";

// Agent API: designs, documents and transactions for a verified principal (see lib/api_principal.ts).
// Semantics follow convex/designs/* exactly; every design must belong to the key's workspace.

type DbCtx = QueryCtx | MutationCtx;

const stateArg = v.union(v.literal("active"), v.literal("archived"), v.literal("trashed"));

function cleanName(name: string): string {
  const trimmed = name.trim().replace(/\s+/g, " ");
  if (trimmed.length === 0) throw errors.invalid("The name cannot be empty.", "name");
  if (trimmed.length > MAX_NAME_LENGTH) {
    throw errors.invalid(`The name can be at most ${MAX_NAME_LENGTH} characters.`, "name");
  }
  return trimmed;
}

async function folderOf(ctx: DbCtx, principal: Principal, raw: string): Promise<Id<"folders">> {
  const id = idOf(ctx, "folders", raw, "Folder");
  const folder = await ctx.db.get("folders", id);
  if (!folder || folder.workspaceId !== principal.workspaceId) throw errors.notFound("Folder");
  return id;
}

async function firstPageId(ctx: DbCtx, designId: Id<"designs">): Promise<string | null> {
  const root = await ctx.db
    .query("nodes")
    .withIndex("by_design_node", (q) => q.eq("designId", designId).eq("nodeId", "root"))
    .unique();
  if (!root) return null;
  return (JSON.parse(root.data) as { children?: string[] }).children?.[0] ?? null;
}

export const list = internalQuery({
  args: {
    principal: principalValidator,
    state: v.optional(stateArg),
    kind: v.optional(v.string()),
    folderId: v.optional(v.string()),
    mine: v.optional(v.boolean()),
    search: v.optional(v.string()),
    numItems: v.number(),
    cursor: v.union(v.string(), v.null()),
  },
  handler: async (ctx, args) => {
    const { principal } = args;
    const workspaceId = principal.workspaceId;
    await requireMember(ctx, workspaceId, "viewer", { userId: principal.userId });
    const state = args.state ?? "active";
    const opts = { numItems: args.numItems, cursor: args.cursor };
    const search = args.search?.trim();
    let page: PaginationResult<Doc<"designs">>;
    if (search) {
      page = await ctx.db
        .query("designs")
        .withSearchIndex("search_name", (q) =>
          q.search("name", search).eq("workspaceId", workspaceId).eq("state", state),
        )
        .paginate(opts);
    } else if (args.folderId !== undefined) {
      const folderId =
        args.folderId === "root" ? undefined : await folderOf(ctx, principal, args.folderId);
      page = await ctx.db
        .query("designs")
        .withIndex("by_workspace_folder_state_updated", (q) =>
          q.eq("workspaceId", workspaceId).eq("folderId", folderId).eq("state", state),
        )
        .order("desc")
        .paginate(opts);
    } else if (args.mine) {
      page = await ctx.db
        .query("designs")
        .withIndex("by_workspace_owner_state_updated", (q) =>
          q.eq("workspaceId", workspaceId).eq("ownerId", principal.userId).eq("state", state),
        )
        .order("desc")
        .paginate(opts);
    } else {
      const base = ctx.db
        .query("designs")
        .withIndex("by_workspace_state_updated", (q) =>
          q.eq("workspaceId", workspaceId).eq("state", state),
        );
      page = await (args.kind
        ? base.filter((q) => q.eq(q.field("kind"), args.kind as string))
        : base
      )
        .order("desc")
        .paginate(opts);
    }
    // The search index only filters by workspace and state: apply the other filters to the page.
    const folderFilter =
      search && args.folderId !== undefined
        ? args.folderId === "root"
          ? null
          : await folderOf(ctx, principal, args.folderId)
        : undefined;
    const items = [];
    for (const design of page.page) {
      if (folderFilter !== undefined && (design.folderId ?? null) !== folderFilter) continue;
      if (args.kind && design.kind !== args.kind) continue;
      if (args.mine && design.ownerId !== principal.userId) continue;
      items.push(await apiDesignView(ctx, principal, design));
    }
    return { items, nextCursor: page.isDone ? null : page.continueCursor };
  },
});

export const get = internalQuery({
  args: { principal: principalValidator, designId: v.string() },
  handler: async (ctx, args) => {
    const design = await designOf(ctx, args.principal, args.designId);
    await requireDesignPermission(ctx, design, "view", { userId: args.principal.userId });
    return await apiDesignView(ctx, args.principal, design);
  },
});

export const create = internalMutation({
  args: {
    principal: principalValidator,
    name: v.optional(v.string()),
    kind: v.optional(v.string()),
    presetId: v.optional(v.string()),
    size: v.optional(
      v.object({
        width: v.number(),
        height: v.number(),
        unit: v.optional(
          v.union(v.literal("px"), v.literal("mm"), v.literal("in"), v.literal("pt")),
        ),
      }),
    ),
    folderId: v.optional(v.string()),
    templateId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { principal } = args;
    const folderId = args.folderId ? await folderOf(ctx, principal, args.folderId) : undefined;
    const templateId = args.templateId
      ? idOf(ctx, "templates", args.templateId, "Template")
      : undefined;
    const { designId } = await createDesignFor(
      ctx,
      {
        workspaceId: principal.workspaceId,
        ...(args.name !== undefined ? { name: args.name } : {}),
        ...(args.kind !== undefined ? { kind: args.kind } : {}),
        ...(args.presetId !== undefined ? { presetId: args.presetId } : {}),
        ...(args.size ? { size: args.size } : {}),
        ...(folderId ? { folderId } : {}),
        ...(templateId ? { templateId } : {}),
      },
      { userId: principal.userId },
    );
    const design = await ctx.db.get("designs", designId);
    if (!design) throw errors.notFound("Design");
    return {
      ...(await apiDesignView(ctx, principal, design)),
      firstPageId: await firstPageId(ctx, designId),
    };
  },
});

export const update = internalMutation({
  args: {
    principal: principalValidator,
    designId: v.string(),
    name: v.optional(v.string()),
    folderId: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, args) => {
    const { principal } = args;
    const design = await designOf(ctx, principal, args.designId);
    const access = await requireDesignWriter(ctx, design, "edit", { userId: principal.userId });
    if (args.folderId !== undefined) {
      const folderId =
        args.folderId === null ? undefined : await folderOf(ctx, principal, args.folderId);
      await ctx.db.patch("designs", design._id, { folderId, updatedAt: Date.now() });
    }
    if (args.name !== undefined) {
      const name = cleanName(args.name);
      if (name !== design.name) {
        // Renames go through the log (a `doc` op) so open editors receive them like any other edit.
        await commitTransaction(ctx, {
          design,
          actorId: access.userId,
          tx: {
            id: newId(),
            label: "Rename design",
            ops: [{ op: "doc", set: { name } }],
            source: "user",
            actor: { userId: access.userId, agent: "api" },
            ts: Date.now(),
          },
        });
      }
    }
    const updated = await ctx.db.get("designs", design._id);
    if (!updated) throw errors.notFound("Design");
    return await apiDesignView(ctx, principal, updated);
  },
});

export const archive = internalMutation({
  args: { principal: principalValidator, designId: v.string() },
  handler: async (ctx, args) => {
    const design = await designOf(ctx, args.principal, args.designId);
    await requireDesignWriter(ctx, design, "manage", { userId: args.principal.userId });
    if (design.state === "trashed")
      throw errors.conflict("Restore the design from the trash first.");
    if (design.state === "active") {
      const now = Date.now();
      await ctx.db.patch("designs", design._id, {
        state: "archived",
        archivedAt: now,
        updatedAt: now,
      });
    }
    const updated = await ctx.db.get("designs", design._id);
    if (!updated) throw errors.notFound("Design");
    return await apiDesignView(ctx, args.principal, updated);
  },
});

export const restore = internalMutation({
  args: { principal: principalValidator, designId: v.string() },
  handler: async (ctx, args) => {
    const design = await designOf(ctx, args.principal, args.designId);
    await requireDesignWriter(ctx, design, "manage", { userId: args.principal.userId });
    if (design.state !== "active") {
      if (design.state === "trashed") {
        await assertLimit(ctx, design.ownerId, "designs");
        await incrementUsage(ctx, design.ownerId, "designs", 1);
      }
      await ctx.db.patch("designs", design._id, {
        state: "active",
        archivedAt: undefined,
        deletedAt: undefined,
        updatedAt: Date.now(),
      });
    }
    const updated = await ctx.db.get("designs", design._id);
    if (!updated) throw errors.notFound("Design");
    return await apiDesignView(ctx, args.principal, updated);
  },
});

/** Move to the trash, or (permanent, already trashed) delete with history now. */
export const remove = internalMutation({
  args: { principal: principalValidator, designId: v.string(), permanent: v.boolean() },
  handler: async (ctx, args): Promise<{ deleted: true; state: "trashed" | "purged" }> => {
    const design = await designOf(ctx, args.principal, args.designId);
    await requireDesignWriter(ctx, design, "manage", { userId: args.principal.userId });
    if (args.permanent) {
      if (design.state !== "trashed") {
        throw errors.conflict("Move the design to the trash first (DELETE without permanent).");
      }
      await startPurge(ctx, design);
      return { deleted: true, state: "purged" };
    }
    if (design.state !== "trashed") {
      const now = Date.now();
      await ctx.db.patch("designs", design._id, {
        state: "trashed",
        deletedAt: now,
        updatedAt: now,
      });
      await incrementUsage(ctx, design.ownerId, "designs", -1);
    }
    return { deleted: true, state: "trashed" };
  },
});

/** One chunk of the materialized design (as designs.load), plus signed asset URLs on the first chunk. */
export const loadPage = internalQuery({
  args: {
    principal: principalValidator,
    designId: v.string(),
    cursor: v.union(v.string(), v.null()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<LoadPage & { assetUrls: Record<string, string> | null; designId: Id<"designs"> }> => {
    const design = await designOf(ctx, args.principal, args.designId);
    const access = await requireDesignPermission(ctx, design, "view", {
      userId: args.principal.userId,
    });
    const seqDoc = await ctx.db
      .query("designSeq")
      .withIndex("by_design", (q) => q.eq("designId", design._id))
      .unique();
    const page = await ctx.db
      .query("nodes")
      .withIndex("by_design_node", (q) => q.eq("designId", design._id))
      .paginate({
        numItems: LOAD_PAGE_SIZE,
        cursor: args.cursor,
        maximumBytesRead: LOAD_PAGE_MAX_BYTES,
      });
    let header: LoadPage["header"] = null;
    let assetUrls: Record<string, string> | null = null;
    if (!args.cursor) {
      const state = await ctx.db
        .query("designState")
        .withIndex("by_design", (q) => q.eq("designId", design._id))
        .unique();
      header = {
        designId: design._id,
        key: design.key,
        name: design.name,
        kind: design.kind,
        workspaceId: design.workspaceId,
        pageCount: design.pageCount,
        assets: state?.assets ?? "{}",
        styles: state?.styles ?? '{"colors":{},"text":{},"effects":{},"variables":{}}',
        meta: state?.meta ?? "{}",
        brandKitId: state?.brandKitId ?? null,
        permission: access.permission,
        snapshot: design.snapshot ?? null,
      };
      assetUrls = await resolveDesignAssetUrls(ctx, design);
    }
    return {
      designId: design._id,
      header,
      seq: seqDoc?.seq ?? 0,
      nodes: page.page.map((n) => n.data),
      cursor: page.continueCursor,
      isDone: page.isDone,
      assetUrls,
    };
  },
});

/**
 * Commit a transaction as the principal (same rules as designs.commit). `tx` is the JSON of a complete
 * Transaction; the HTTP layer fills id, label, source, actor and ts.
 */
export const commit = internalMutation({
  args: {
    principal: principalValidator,
    designId: v.string(),
    baseSeq: v.optional(v.number()),
    tx: v.string(),
  },
  handler: async (ctx, args): Promise<CommitResult & { txId: string }> => {
    const design = await designOf(ctx, args.principal, args.designId);
    const access = await requireDesignWriter(ctx, design, "edit", {
      userId: args.principal.userId,
    });
    const tx = JSON.parse(args.tx) as Transaction;
    const result = await commitTransaction(ctx, {
      design,
      tx,
      actorId: access.userId,
      ...(args.baseSeq !== undefined ? { baseSeq: args.baseSeq } : {}),
    });
    return { ...result, txId: tx.id };
  },
});

/** Accepted transactions after `since` (designOps.since with a caller-chosen page size). */
export const since = internalQuery({
  args: {
    principal: principalValidator,
    designId: v.string(),
    since: v.number(),
    limit: v.number(),
  },
  handler: async (ctx, args) => {
    const design = await designOf(ctx, args.principal, args.designId);
    await requireDesignPermission(ctx, design, "view", { userId: args.principal.userId });
    const limit = Math.max(1, Math.min(200, Math.floor(args.limit)));
    const rows = await ctx.db
      .query("designOps")
      .withIndex("by_design_seq", (q) => q.eq("designId", design._id).gt("seq", args.since))
      .take(limit + 1);
    const page = rows.slice(0, limit);
    const seqDoc = await ctx.db
      .query("designSeq")
      .withIndex("by_design", (q) => q.eq("designId", design._id))
      .unique();
    const latest = seqDoc?.seq ?? args.since;
    const first = page[0];
    return {
      items: page.map((row) => ({
        seq: row.seq,
        txId: row.txId,
        tx: row.tx,
        actor: row.actor ?? null,
        source: row.source,
        ts: row.ts,
      })),
      hasMore: rows.length > limit,
      // Entries the caller still needs were compacted away (or never reachable): reload the document.
      reload: first ? first.seq !== args.since + 1 : latest > args.since,
      latestSeq: Math.max(latest, args.since),
    };
  },
});

/** Signed URLs of a design's assets (keyed by AssetRef.id), for rendering. */
export const assetUrls = internalQuery({
  args: { principal: principalValidator, designId: v.string() },
  handler: async (ctx, args) => {
    const design = await designOf(ctx, args.principal, args.designId);
    await requireDesignPermission(ctx, design, "view", { userId: args.principal.userId });
    return await resolveDesignAssetUrls(ctx, design);
  },
});

export const folders = internalQuery({
  args: { principal: principalValidator },
  handler: async (ctx, args) => {
    await requireMember(ctx, args.principal.workspaceId, "viewer", {
      userId: args.principal.userId,
    });
    const rows = await ctx.db
      .query("folders")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", args.principal.workspaceId))
      .collect();
    return {
      items: rows
        .sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0) || a.name.localeCompare(b.name))
        .map((f) => ({
          id: f._id,
          name: f.name,
          parentId: f.parentId ?? null,
          color: f.color ?? null,
          createdAt: f.createdAt,
          updatedAt: f.updatedAt,
        })),
    };
  },
});
