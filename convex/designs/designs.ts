import {
  createDesign,
  type Design,
  getPreset,
  isDesignKind,
  newId,
  type PagePreset,
  validateDesign,
} from "@desyn/schema";
import { type PaginationResult, paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import {
  action,
  internalMutation,
  type MutationCtx,
  mutation,
  type QueryCtx,
  query,
} from "../_generated/server";
import { randomToken } from "../lib/crypto";
import {
  checkShare,
  getDesignOrThrow,
  hashShareGrant,
  hashSharePassword,
  permissionForRole,
  requireDesignPermission,
  requireDesignWriter,
  SHARE_GRANT_PREFIX,
  SHARE_GRANT_TTL_MS,
  shareArg,
  verifySharePassword,
} from "../lib/designs_access";
import { commitTransaction, findAssetForWorkspace, getSeqDoc } from "../lib/designs_commit";
import { insertDesignDocument } from "../lib/designs_create";
import { pageCountOf, utf8Length } from "../lib/designs_doc";
import {
  INLINE_COPY_MAX_BYTES,
  INLINE_COPY_MAX_NODES,
  LOAD_PAGE_MAX_BYTES,
  LOAD_PAGE_SIZE,
  MAX_IMPORT_BYTES,
  MAX_NAME_LENGTH,
  MAX_NODES_PER_DESIGN,
} from "../lib/designs_limits";
import { designSummary } from "../lib/designs_summary";
import { SvgSanitizeError, sanitizeNodesMarkup } from "../lib/designs_svg";
import { copyWithFreshIds, loadTemplateDesign } from "../lib/designs_templates";
import type { CommitResult, LoadPage } from "../lib/designs_wire";
import {
  assertFeature,
  assertLimit,
  assertWorkspaceFeature,
  getWorkspacePlan,
} from "../lib/entitlements";
import { appUrl } from "../lib/env";
import { errors } from "../lib/errors";
import { getMembership, requireMember, requireUser } from "../lib/guards";
import { PLANS } from "../lib/plans";
import { rateLimiter } from "../lib/rateLimits";
import { incrementUsage } from "../lib/usage";
import { copyAssetRowsToWorkspace, readFullDesign } from "./internal";
import { startPurge } from "./maintenance";
import { restoreVersionHandler } from "./versions";

// Public design API (SPEC §6): designs.create|get|list|rename|duplicate|archive|restore|delete|purge|
// moveToFolder|setShare|listShares|revokeShare|getSharedByToken|joinShare|importDesign|load|commit|snapshot|
// restoreVersion. Content crosses the wire as JSON strings (see lib/designs_wire.ts).

const unitValidator = v.union(v.literal("px"), v.literal("mm"), v.literal("in"), v.literal("pt"));
const sharePermission = v.union(v.literal("view"), v.literal("comment"), v.literal("edit"));

function cleanName(name: string): string {
  const trimmed = name.trim().replace(/\s+/g, " ");
  if (trimmed.length === 0) throw errors.invalid("The name cannot be empty.", "name");
  if (trimmed.length > MAX_NAME_LENGTH) {
    throw errors.invalid(`The name can be at most ${MAX_NAME_LENGTH} characters.`, "name");
  }
  return trimmed;
}

async function assertFolder(
  ctx: QueryCtx | MutationCtx,
  workspaceId: Id<"workspaces">,
  folderId: Id<"folders"> | undefined | null,
): Promise<void> {
  if (!folderId) return;
  const folder = await ctx.db.get("folders", folderId);
  if (!folder || folder.workspaceId !== workspaceId) throw errors.notFound("Folder");
}

/** Pages limit of the workspace plan (null = unlimited). */
async function pagesLimit(
  ctx: QueryCtx | MutationCtx,
  workspaceId: Id<"workspaces">,
): Promise<number | null> {
  return PLANS[await getWorkspacePlan(ctx, workspaceId)].limits.pagesPerDesign;
}

async function assertPagesWithinPlan(
  ctx: MutationCtx,
  workspaceId: Id<"workspaces">,
  design: Design,
): Promise<void> {
  const max = await pagesLimit(ctx, workspaceId);
  const count = pageCountOf(design);
  if (max !== null && count > max) throw errors.limit("pagesPerDesign", max, count);
}

// --- create ---------------------------------------------------------------------------------------------

const createArgs = {
  workspaceId: v.id("workspaces"),
  /** DesignKind; defaults to "custom" (or the template's kind). */
  kind: v.optional(v.string()),
  /** Page preset id from @desyn/schema PAGE_PRESETS. */
  presetId: v.optional(v.string()),
  /** Custom page size in design px (wins over presetId). */
  size: v.optional(
    v.object({ width: v.number(), height: v.number(), unit: v.optional(unitValidator) }),
  ),
  templateId: v.optional(v.id("templates")),
  name: v.optional(v.string()),
  folderId: v.optional(v.id("folders")),
};

export interface CreateDesignArgs {
  workspaceId: Id<"workspaces">;
  kind?: string;
  presetId?: string;
  size?: { width: number; height: number; unit?: "px" | "mm" | "in" | "pt" };
  templateId?: Id<"templates">;
  name?: string;
  folderId?: Id<"folders">;
}

/** Create a design from a blank preset / custom size, or from a template (premium templates need the plan). */
export async function createDesignFor(
  ctx: MutationCtx,
  args: CreateDesignArgs,
  /** `userId`: trusted caller-verified user (Agent API after API-key verification). */
  opts: { userId?: string } = {},
): Promise<{ designId: Id<"designs">; key: string }> {
  const member = await requireMember(ctx, args.workspaceId, "editor", opts);
  await assertFolder(ctx, args.workspaceId, args.folderId);
  await assertLimit(ctx, member.userId, "designs");
  const name = args.name !== undefined ? cleanName(args.name) : undefined;

  let design: Design;
  let templateId: Id<"templates"> | undefined;
  if (args.templateId) {
    const loaded = await loadTemplateDesign(ctx, args.templateId);
    if (loaded.template.premium) await assertFeature(ctx, member.userId, "templates.premium");
    design = copyWithFreshIds(loaded.design, {
      name: name ?? loaded.template.title,
      templateId: loaded.template._id,
    });
    templateId = loaded.template._id;
    await ctx.db.patch("templates", loaded.template._id, {
      popularity: loaded.template.popularity + 1,
    });
  } else {
    const kind = args.kind ?? "custom";
    if (!isDesignKind(kind)) throw errors.invalid(`Unknown design kind "${kind}".`, "kind");
    let preset: PagePreset | string | undefined;
    if (args.size) {
      const { width, height } = args.size;
      if (!(width >= 1 && width <= 100_000 && height >= 1 && height <= 100_000)) {
        throw errors.invalid("Page size must be between 1 and 100000 px.", "size");
      }
      preset = {
        id: "custom",
        label: "Custom",
        kind,
        category: "other",
        width: Math.round(width * 100) / 100,
        height: Math.round(height * 100) / 100,
        unit: args.size.unit ?? "px",
      };
    } else if (args.presetId) {
      if (!getPreset(args.presetId))
        throw errors.invalid(`Unknown preset "${args.presetId}".`, "presetId");
      preset = args.presetId;
    }
    design = createDesign(kind, preset, name ? { name } : {});
  }
  await assertPagesWithinPlan(ctx, args.workspaceId, design);
  const designId = await insertDesignDocument(ctx, {
    workspaceId: args.workspaceId,
    ownerId: member.userId,
    ...(args.folderId ? { folderId: args.folderId } : {}),
    design,
    source: templateId ? "template" : "system",
    label: templateId ? "Create from template" : "Create design",
    ...(templateId ? { templateId } : {}),
  });
  await incrementUsage(ctx, member.userId, "designs", 1);
  return { designId, key: design.id };
}

export const create = mutation({
  args: createArgs,
  handler: async (ctx, args): Promise<{ designId: Id<"designs">; key: string }> =>
    await createDesignFor(ctx, args),
});

// --- read -----------------------------------------------------------------------------------------------

export const get = query({
  args: { designId: v.id("designs"), share: shareArg },
  handler: async (ctx, args) => {
    const design = await getDesignOrThrow(ctx, args.designId);
    const access = await requireDesignPermission(ctx, design, "view", { share: args.share });
    return { ...(await designSummary(ctx, design, access.permission)), via: access.via };
  },
});

const listFilter = v.union(
  v.literal("all"),
  v.literal("recent"),
  v.literal("mine"),
  v.literal("folder"),
  v.literal("shared"),
  v.literal("archived"),
  v.literal("trash"),
);

export const list = query({
  args: {
    /** Required for every filter except "shared" (shared with me spans workspaces). */
    workspaceId: v.optional(v.id("workspaces")),
    filter: listFilter,
    /** For filter "folder": the folder (omit / null for the workspace root). */
    folderId: v.optional(v.union(v.id("folders"), v.null())),
    kind: v.optional(v.string()),
    search: v.optional(v.string()),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    if (args.filter === "shared") {
      const user = (await requireUser(ctx)).userId;
      const page = await ctx.db
        .query("shareAccess")
        .withIndex("by_user_lastOpened", (q) => q.eq("userId", user))
        .order("desc")
        .paginate(args.paginationOpts);
      const out = [];
      for (const row of page.page) {
        const design = await ctx.db.get("designs", row.designId);
        const share = await ctx.db.get("shares", row.shareId);
        if (!design || design.state === "trashed" || design.state === "creating") continue;
        if (
          !share ||
          share.revokedAt ||
          (share.expiresAt !== undefined && share.expiresAt <= Date.now())
        )
          continue;
        if (args.kind && design.kind !== args.kind) continue;
        out.push({
          ...(await designSummary(ctx, design, row.permission)),
          shareToken: share.token,
        });
      }
      return { ...page, page: out };
    }
    if (!args.workspaceId)
      throw errors.invalid("workspaceId is required for this filter.", "workspaceId");
    const workspaceId = args.workspaceId;
    const member = await requireMember(ctx, workspaceId, "viewer");
    const state =
      args.filter === "archived" ? "archived" : args.filter === "trash" ? "trashed" : "active";

    let page: PaginationResult<Doc<"designs">>;
    const search = args.search?.trim();
    if (search) {
      page = await ctx.db
        .query("designs")
        .withSearchIndex("search_name", (q) =>
          q.search("name", search).eq("workspaceId", workspaceId).eq("state", state),
        )
        .paginate(args.paginationOpts);
    } else {
      const base =
        args.filter === "folder"
          ? ctx.db.query("designs").withIndex("by_workspace_folder_state_updated", (q) =>
              q
                .eq("workspaceId", workspaceId)
                .eq("folderId", args.folderId ?? undefined)
                .eq("state", "active"),
            )
          : args.filter === "mine"
            ? ctx.db
                .query("designs")
                .withIndex("by_workspace_owner_state_updated", (q) =>
                  q
                    .eq("workspaceId", workspaceId)
                    .eq("ownerId", member.userId)
                    .eq("state", "active"),
                )
            : ctx.db
                .query("designs")
                .withIndex("by_workspace_state_updated", (q) =>
                  q.eq("workspaceId", workspaceId).eq("state", state),
                );
      const filtered = args.kind
        ? base.filter((q) => q.eq(q.field("kind"), args.kind as string))
        : base;
      page = await filtered.order("desc").paginate(args.paginationOpts);
    }
    const out = [];
    for (const design of page.page) {
      if (args.kind && design.kind !== args.kind) continue;
      const permission = permissionForRole(member.role, design.ownerId === member.userId);
      out.push(await designSummary(ctx, design, permission));
    }
    return { ...page, page: out };
  },
});

// --- load / commit ----------------------------------------------------------------------------------------

/**
 * One page of the materialized design (nodes in chunks of 500, in node-id order). The first page (no cursor)
 * carries the header. Call repeatedly with `cursor` until `isDone`, then subscribe to
 * `designOps.since({ designId, seq })` with the lowest page seq (see `assembleDesign` in lib/designs_wire.ts).
 */
export const load = query({
  args: {
    designId: v.id("designs"),
    cursor: v.optional(v.union(v.string(), v.null())),
    share: shareArg,
  },
  handler: async (ctx, args): Promise<LoadPage> => {
    const design = await getDesignOrThrow(ctx, args.designId);
    const access = await requireDesignPermission(ctx, design, "view", { share: args.share });
    const seqDoc = await ctx.db
      .query("designSeq")
      .withIndex("by_design", (q) => q.eq("designId", design._id))
      .unique();
    const page = await ctx.db
      .query("nodes")
      .withIndex("by_design_node", (q) => q.eq("designId", design._id))
      .paginate({
        numItems: LOAD_PAGE_SIZE,
        cursor: args.cursor ?? null,
        // Pages of large nodes end early (isDone stays false) instead of exceeding the query read limit.
        maximumBytesRead: LOAD_PAGE_MAX_BYTES,
      });
    let header: LoadPage["header"] = null;
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
    }
    return {
      header,
      seq: seqDoc?.seq ?? 0,
      nodes: page.page.map((n) => n.data),
      cursor: page.continueCursor,
      isDone: page.isDone,
    };
  },
});

/**
 * Apply a transaction (`tx`: JSON string, or a plain object when it has no "$" / non-ASCII keys). Editor+
 * (members) or an edit share link with a signed-in user. Returns `{ seq, applied (JSON), dropped, duplicate }`.
 */
export const commit = mutation({
  args: {
    designId: v.id("designs"),
    baseSeq: v.optional(v.number()),
    tx: v.union(v.string(), v.any()),
    share: shareArg,
  },
  handler: async (ctx, args): Promise<CommitResult> => {
    const design = await getDesignOrThrow(ctx, args.designId);
    const access = await requireDesignWriter(ctx, design, "edit", { share: args.share });
    return await commitTransaction(ctx, {
      design,
      tx: args.tx,
      actorId: access.userId,
      ...(args.baseSeq !== undefined ? { baseSeq: args.baseSeq } : {}),
    });
  },
});

/** Commit on behalf of a verified user (AI backend, Agent API). Same permission rules as `commit`. */
export const commitAs = internalMutation({
  args: {
    designId: v.id("designs"),
    userId: v.string(),
    baseSeq: v.optional(v.number()),
    tx: v.union(v.string(), v.any()),
  },
  handler: async (ctx, args): Promise<CommitResult> => {
    const design = await getDesignOrThrow(ctx, args.designId);
    const access = await requireDesignWriter(ctx, design, "edit", { userId: args.userId });
    return await commitTransaction(ctx, {
      design,
      tx: args.tx,
      actorId: access.userId,
      ...(args.baseSeq !== undefined ? { baseSeq: args.baseSeq } : {}),
    });
  },
});

// --- rename / organize ------------------------------------------------------------------------------------

/** Rename through the transaction log so open editors receive the change like any other edit. */
export const rename = mutation({
  args: { designId: v.id("designs"), name: v.string() },
  handler: async (ctx, args): Promise<{ seq: number }> => {
    const design = await getDesignOrThrow(ctx, args.designId);
    const access = await requireDesignWriter(ctx, design, "edit");
    const name = cleanName(args.name);
    if (name === design.name) return { seq: (await getSeqDoc(ctx, design._id)).seq };
    const result = await commitTransaction(ctx, {
      design,
      actorId: access.userId,
      tx: {
        id: newId(),
        label: "Rename design",
        ops: [{ op: "doc", set: { name } }],
        source: "user",
        ts: Date.now(),
      },
    });
    return { seq: result.seq };
  },
});

export const moveToFolder = mutation({
  args: { designId: v.id("designs"), folderId: v.union(v.id("folders"), v.null()) },
  handler: async (ctx, args) => {
    const design = await getDesignOrThrow(ctx, args.designId);
    const access = await requireDesignWriter(ctx, design, "edit");
    if (access.via !== "member")
      throw errors.forbidden("Only workspace members can organize designs.");
    await assertFolder(ctx, design.workspaceId, args.folderId);
    await ctx.db.patch("designs", design._id, {
      folderId: args.folderId ?? undefined,
      updatedAt: Date.now(),
    });
    return null;
  },
});

export const archive = mutation({
  args: { designId: v.id("designs") },
  handler: async (ctx, args) => {
    const design = await getDesignOrThrow(ctx, args.designId);
    await requireDesignWriter(ctx, design, "manage");
    if (design.state !== "active") throw errors.conflict("Only active designs can be archived.");
    const now = Date.now();
    await ctx.db.patch("designs", design._id, {
      state: "archived",
      archivedAt: now,
      updatedAt: now,
    });
    return null;
  },
});

/** Restore from the archive or the trash. Restoring from the trash counts against the designs limit again. */
export const restore = mutation({
  args: { designId: v.id("designs") },
  handler: async (ctx, args) => {
    const design = await getDesignOrThrow(ctx, args.designId);
    await requireDesignWriter(ctx, design, "manage");
    if (design.state === "active") return null;
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
    return null;
  },
});

/** Move to the trash (purged automatically after 30 days, or with `purge`). */
const trash = mutation({
  args: { designId: v.id("designs") },
  handler: async (ctx, args) => {
    const design = await getDesignOrThrow(ctx, args.designId);
    await requireDesignWriter(ctx, design, "manage");
    if (design.state === "trashed") return null;
    const now = Date.now();
    await ctx.db.patch("designs", design._id, { state: "trashed", deletedAt: now, updatedAt: now });
    await incrementUsage(ctx, design.ownerId, "designs", -1);
    return null;
  },
});

export { trash as delete };

/** Permanently delete a design that is in the trash. */
export const purge = mutation({
  args: { designId: v.id("designs") },
  handler: async (ctx, args) => {
    const design = await getDesignOrThrow(ctx, args.designId);
    await requireDesignWriter(ctx, design, "manage");
    if (design.state !== "trashed") throw errors.conflict("Move the design to the trash first.");
    await startPurge(ctx, design);
    return null;
  },
});

// --- duplicate / import -----------------------------------------------------------------------------------

export const duplicate = mutation({
  args: {
    designId: v.id("designs"),
    name: v.optional(v.string()),
    /** Target workspace (default: the source design's). */
    workspaceId: v.optional(v.id("workspaces")),
    folderId: v.optional(v.id("folders")),
    share: shareArg,
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ designId: Id<"designs">; key: string; pending: boolean }> => {
    const source = await getDesignOrThrow(ctx, args.designId);
    await requireDesignPermission(ctx, source, "view", { share: args.share });
    const workspaceId = args.workspaceId ?? source.workspaceId;
    const member = await requireMember(ctx, workspaceId, "editor");
    await assertFolder(ctx, workspaceId, args.folderId);
    await assertLimit(ctx, member.userId, "designs");
    const name =
      args.name !== undefined
        ? cleanName(args.name)
        : `${source.name} (copy)`.slice(0, MAX_NAME_LENGTH);
    const seqDoc = await getSeqDoc(ctx, source._id);
    const key = newId();

    if (seqDoc.nodeCount <= INLINE_COPY_MAX_NODES && seqDoc.bytes <= INLINE_COPY_MAX_BYTES) {
      const full = await readFullDesign(ctx, source);
      const design: Design = {
        ...full,
        id: key,
        name,
        meta: { ...full.meta, updatedAt: Date.now() },
      };
      await assertPagesWithinPlan(ctx, workspaceId, design);
      if (workspaceId !== source.workspaceId) {
        await copyAssetRowsToWorkspace(
          ctx,
          Object.keys(design.assets),
          source.workspaceId,
          workspaceId,
          member.userId,
        );
      }
      const designId = await insertDesignDocument(ctx, {
        workspaceId,
        ownerId: member.userId,
        ...(args.folderId ? { folderId: args.folderId } : {}),
        design,
        source: "system",
        label: "Duplicate design",
        ...(source.templateId ? { templateId: source.templateId } : {}),
      });
      await incrementUsage(ctx, member.userId, "designs", 1);
      return { designId, key, pending: false };
    }

    // Large designs are rebuilt from the latest snapshot + log in an action and inserted in chunks.
    const max = await pagesLimit(ctx, workspaceId);
    if (max !== null && source.pageCount > max)
      throw errors.limit("pagesPerDesign", max, source.pageCount);
    const designId: Id<"designs"> = await ctx.runMutation(internal.designs.internal.beginShell, {
      workspaceId,
      ownerId: member.userId,
      ...(args.folderId ? { folderId: args.folderId } : {}),
      key,
      name,
      kind: source.kind,
      ...(source.templateId ? { templateId: source.templateId } : {}),
    });
    await ctx.scheduler.runAfter(0, internal.designs.snapshotNode.duplicateLarge, {
      sourceId: source._id,
      targetId: designId,
      targetKey: key,
      targetName: name,
      sourceWorkspaceId: source.workspaceId,
      userId: member.userId,
    });
    return { designId, key, pending: true };
  },
});

/** Import a Design JSON document (validated with @desyn/schema validateDesign; plan limits enforced). */
export const importDesign = mutation({
  args: {
    workspaceId: v.id("workspaces"),
    design: v.string(),
    name: v.optional(v.string()),
    folderId: v.optional(v.id("folders")),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ designId: Id<"designs">; key: string; warnings: number; pending: boolean }> => {
    const member = await requireMember(ctx, args.workspaceId, "editor");
    await assertFolder(ctx, args.workspaceId, args.folderId);
    if (utf8Length(args.design) > MAX_IMPORT_BYTES) {
      throw errors.invalid(
        `Designs larger than ${MAX_IMPORT_BYTES} bytes cannot be imported.`,
        "design",
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(args.design);
    } catch {
      throw errors.invalid("The file is not valid JSON.", "design");
    }
    const result = validateDesign(parsed);
    if (!result.ok) {
      const summary = result.errors
        .slice(0, 5)
        .map((e) => `${e.path.join(".")}: ${e.message}`)
        .join("; ");
      throw errors.invalid(
        `The design is not valid (${result.errors.length} errors): ${summary}`,
        "design",
      );
    }
    const design = parsed as Design;
    await assertLimit(ctx, member.userId, "designs");
    await assertPagesWithinPlan(ctx, args.workspaceId, design);

    const key = newId();
    const clean: Design = {
      ...design,
      id: key,
      ...(args.name ? { name: cleanName(args.name) } : {}),
    };
    // Asset refs: never persist resolvable URLs; only keep storage keys this workspace owns.
    const assets: Design["assets"] = {};
    for (const [ref, asset] of Object.entries(design.assets)) {
      const { url: _url, ...rest } = asset;
      if (rest.storageKey) {
        const owned = await findAssetForWorkspace(ctx, args.workspaceId, ref);
        if (!owned || owned.storageKey !== rest.storageKey) delete rest.storageKey;
      }
      assets[ref] = rest;
    }
    clean.assets = assets;
    // Inline SVG markup is sanitized like any committed markup.
    try {
      clean.nodes = sanitizeNodesMarkup(design.nodes);
    } catch (err) {
      if (err instanceof SvgSanitizeError) throw errors.invalid(err.message, "design");
      throw err;
    }

    const nodeCount = Object.keys(clean.nodes).length;
    if (nodeCount > MAX_NODES_PER_DESIGN) {
      throw errors.limit("nodesPerDesign", MAX_NODES_PER_DESIGN, nodeCount);
    }
    if (nodeCount > INLINE_COPY_MAX_NODES) {
      // Too many documents for one mutation: insert in chunks from an action (the design appears when done).
      const designId: Id<"designs"> = await ctx.runMutation(internal.designs.internal.beginShell, {
        workspaceId: args.workspaceId,
        ownerId: member.userId,
        ...(args.folderId ? { folderId: args.folderId } : {}),
        key,
        name: (clean.name.trim() || "Untitled design").slice(0, MAX_NAME_LENGTH),
        kind: clean.kind,
      });
      await ctx.scheduler.runAfter(0, internal.designs.snapshotNode.importLarge, {
        targetId: designId,
        workspaceId: args.workspaceId,
        userId: member.userId,
        design: JSON.stringify(clean),
      });
      return { designId, key, warnings: result.warnings.length, pending: true };
    }

    const designId = await insertDesignDocument(ctx, {
      workspaceId: args.workspaceId,
      ownerId: member.userId,
      ...(args.folderId ? { folderId: args.folderId } : {}),
      design: clean,
      source: "import",
      label: "Import design",
    });
    await incrementUsage(ctx, member.userId, "designs", 1);
    return { designId, key, warnings: result.warnings.length, pending: false };
  },
});

// --- sharing ------------------------------------------------------------------------------------------------

const SHARE_FEATURE = {
  view: "share.viewLink",
  comment: "collab.comments",
  edit: "share.editLink",
} as const;

function shareUrl(token: string): string {
  return `${appUrl()}/share/${token}`;
}

async function refreshShareCount(ctx: MutationCtx, designId: Id<"designs">): Promise<void> {
  const shares = await ctx.db
    .query("shares")
    .withIndex("by_design", (q) => q.eq("designId", designId))
    .collect();
  const now = Date.now();
  const active = shares.filter(
    (s) => !s.revokedAt && (s.expiresAt === undefined || s.expiresAt > now),
  );
  await ctx.db.patch("designs", designId, { shareCount: active.length });
}

/** Create a share link, or update one (`shareId`). Managers only; link types are plan features. */
export const setShare = mutation({
  args: {
    designId: v.id("designs"),
    shareId: v.optional(v.id("shares")),
    permission: sharePermission,
    /** New password; null removes it; omit to keep. */
    password: v.optional(v.union(v.string(), v.null())),
    /** Expiry (ms epoch); null removes it; omit to keep. */
    expiresAt: v.optional(v.union(v.number(), v.null())),
    label: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ shareId: Id<"shares">; token: string; url: string }> => {
    const design = await getDesignOrThrow(ctx, args.designId);
    const access = await requireDesignWriter(ctx, design, "manage");
    if (access.via !== "member")
      throw errors.forbidden("Only workspace members can manage share links.");
    if (design.state === "trashed") throw errors.conflict("Restore the design to share it.");
    await assertWorkspaceFeature(ctx, design.workspaceId, SHARE_FEATURE[args.permission]);
    const now = Date.now();
    if (typeof args.expiresAt === "number" && args.expiresAt <= now) {
      throw errors.invalid("The expiry must be in the future.", "expiresAt");
    }
    if (
      typeof args.password === "string" &&
      (args.password.length < 4 || args.password.length > 200)
    ) {
      throw errors.invalid("Passwords must be 4 to 200 characters.", "password");
    }
    const label = args.label?.trim().slice(0, 100);
    const passwordFields =
      typeof args.password === "string"
        ? (() => {
            const h = hashSharePassword(args.password);
            return { passwordHash: h.hash, passwordSalt: h.salt };
          })()
        : args.password === null
          ? { passwordHash: undefined, passwordSalt: undefined }
          : {};
    const expiry =
      args.expiresAt === null
        ? { expiresAt: undefined }
        : args.expiresAt !== undefined
          ? { expiresAt: args.expiresAt }
          : {};

    let shareId: Id<"shares">;
    let token: string;
    if (args.shareId) {
      const share = await ctx.db.get("shares", args.shareId);
      if (!share || share.designId !== design._id || share.revokedAt)
        throw errors.notFound("Share link");
      await ctx.db.patch("shares", share._id, {
        permission: args.permission,
        ...passwordFields,
        ...expiry,
        ...(label !== undefined ? { label } : {}),
      });
      if (args.password !== undefined) {
        // A new or removed password closes every browser that unlocked the link with the old one.
        for (const grant of await ctx.db
          .query("shareGrants")
          .withIndex("by_share", (q) => q.eq("shareId", share._id))
          .take(1000)) {
          await ctx.db.delete("shareGrants", grant._id);
        }
      }
      shareId = share._id;
      token = share.token;
    } else {
      token = randomToken(24);
      shareId = await ctx.db.insert("shares", {
        designId: design._id,
        workspaceId: design.workspaceId,
        token,
        permission: args.permission,
        ...(passwordFields.passwordHash ? passwordFields : {}),
        ...(typeof args.expiresAt === "number" ? { expiresAt: args.expiresAt } : {}),
        ...(label ? { label } : {}),
        createdBy: access.userId,
        createdAt: now,
      });
    }
    await refreshShareCount(ctx, design._id);
    return { shareId, token, url: shareUrl(token) };
  },
});

export const listShares = query({
  args: { designId: v.id("designs") },
  handler: async (ctx, args) => {
    const design = await getDesignOrThrow(ctx, args.designId);
    const access = await requireDesignPermission(ctx, design, "manage");
    if (access.via !== "member")
      throw errors.forbidden("Only workspace members can manage share links.");
    const shares = await ctx.db
      .query("shares")
      .withIndex("by_design", (q) => q.eq("designId", design._id))
      .collect();
    const now = Date.now();
    return shares
      .filter((s) => !s.revokedAt)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((s) => ({
        id: s._id,
        token: s.token,
        url: shareUrl(s.token),
        permission: s.permission,
        hasPassword: Boolean(s.passwordHash),
        expiresAt: s.expiresAt ?? null,
        expired: s.expiresAt !== undefined && s.expiresAt <= now,
        label: s.label ?? null,
        createdBy: s.createdBy,
        createdAt: s.createdAt,
        lastUsedAt: s.lastUsedAt ?? null,
      }));
  },
});

export const revokeShare = mutation({
  args: { shareId: v.id("shares") },
  handler: async (ctx, args) => {
    const share = await ctx.db.get("shares", args.shareId);
    if (!share) throw errors.notFound("Share link");
    const design = await getDesignOrThrow(ctx, share.designId);
    const access = await requireDesignWriter(ctx, design, "manage");
    if (access.via !== "member")
      throw errors.forbidden("Only workspace members can manage share links.");
    if (!share.revokedAt) await ctx.db.patch("shares", share._id, { revokedAt: Date.now() });
    await refreshShareCount(ctx, design._id);
    return null;
  },
});

/**
 * Unlocks a password-protected share link. The password is checked only here, under a per-link rate limit
 * (lib/rateLimits.ts `shareUnlock`), and a correct one returns a 12-hour grant (`sg_...`) that clients pass as
 * `share.password` to every other function. Links without a password return `grant: null`.
 */
export const unlockShare = mutation({
  args: { token: v.string(), password: v.string() },
  handler: async (ctx, args) => {
    const share = await ctx.db
      .query("shares")
      .withIndex("by_token", (q) => q.eq("token", args.token))
      .unique();
    const now = Date.now();
    if (!share || share.revokedAt) return { status: "invalid" as const, grant: null };
    if (share.expiresAt !== undefined && share.expiresAt <= now)
      return { status: "expired" as const, grant: null };
    if (!share.passwordHash) return { status: "ok" as const, grant: null };
    const limited = await rateLimiter.limit(ctx, "shareUnlock", { key: share.token });
    if (!limited.ok) throw errors.rateLimited(limited.retryAfter ?? 60_000, "shareUnlock");
    if (args.password.length > 200 || !verifySharePassword(share, args.password)) {
      return { status: "wrong_password" as const, grant: null };
    }
    // One live grant per browser is plenty; drop this link's expired grants while we are here.
    for (const old of await ctx.db
      .query("shareGrants")
      .withIndex("by_share", (q) => q.eq("shareId", share._id))
      .take(200)) {
      if (old.expiresAt <= now) await ctx.db.delete("shareGrants", old._id);
    }
    const grant = `${SHARE_GRANT_PREFIX}${randomToken(32)}`;
    await ctx.db.insert("shareGrants", {
      shareId: share._id,
      grantHash: hashShareGrant(grant),
      expiresAt: now + SHARE_GRANT_TTL_MS,
      createdAt: now,
    });
    return { status: "ok" as const, grant };
  },
});

/** Public metadata for a share link (no sign-in needed). Never reveals the design id behind a password. */
export const getSharedByToken = query({
  args: { token: v.string(), password: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const checked = await checkShare(ctx, {
      token: args.token,
      ...(args.password ? { password: args.password } : {}),
    });
    if (checked.status === "invalid" || checked.status === "revoked")
      return { status: "invalid" as const };
    if (checked.status === "expired") return { status: "expired" as const };
    if (checked.status === "password_required" || checked.status === "wrong_password") {
      return { status: checked.status, requiresPassword: true };
    }
    const share = checked.share as Doc<"shares">;
    const design = await ctx.db.get("designs", share.designId);
    if (!design || design.state === "trashed" || design.state === "creating") {
      return { status: "invalid" as const };
    }
    const identity = await ctx.auth.getUserIdentity();
    const workspace = await ctx.db.get("workspaces", design.workspaceId);
    const summary = await designSummary(ctx, design, null);
    return {
      status: "ok" as const,
      permission: share.permission,
      /** What the caller can do right now (comment / edit need a signed-in user). */
      effectivePermission: identity ? share.permission : ("view" as const),
      signedIn: identity !== null,
      requiresPassword: Boolean(share.passwordHash),
      expiresAt: share.expiresAt ?? null,
      workspaceName: workspace?.name ?? null,
      design: {
        id: summary.id,
        key: summary.key,
        name: summary.name,
        kind: summary.kind,
        pageCount: summary.pageCount,
        width: summary.width,
        height: summary.height,
        thumbnailUrl: summary.thumbnailUrl,
        updatedAt: summary.updatedAt,
      },
    };
  },
});

/** Record that the signed-in user opened a share link ("Shared with me"). */
export const joinShare = mutation({
  args: { token: v.string(), password: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw errors.unauthenticated();
    const checked = await checkShare(ctx, {
      token: args.token,
      ...(args.password ? { password: args.password } : {}),
    });
    if (checked.status !== "ok" || !checked.share) {
      if (checked.status === "expired") throw errors.expired("This share link has expired.");
      if (checked.status === "password_required" || checked.status === "wrong_password") {
        throw errors.forbidden("The password is not correct.");
      }
      throw errors.notFound("Share link");
    }
    const share = checked.share;
    const design = await getDesignOrThrow(ctx, share.designId);
    if (design.state === "trashed") throw errors.notFound("Design");
    const now = Date.now();
    const existing = await ctx.db
      .query("shareAccess")
      .withIndex("by_user_design", (q) =>
        q.eq("userId", identity.subject).eq("designId", design._id),
      )
      .unique();
    // Comment and edit links count toward the owner's collaborators-per-design limit (view links do not).
    if (share.permission !== "view" && (!existing || existing.permission === "view")) {
      const workspace = await ctx.db.get("workspaces", design.workspaceId);
      const isMember = workspace
        ? Boolean(await getMembership(ctx, workspace._id, identity.subject))
        : false;
      if (workspace && !isMember && workspace.ownerId !== identity.subject) {
        const collaborators = await ctx.db
          .query("shareAccess")
          .withIndex("by_design", (q) => q.eq("designId", design._id))
          .take(1000);
        await assertLimit(ctx, workspace.ownerId, "collaboratorsPerDesign", {
          current: collaborators.filter(
            (c) => c.permission !== "view" && c.userId !== identity.subject,
          ).length,
        });
      }
    }
    if (existing) {
      await ctx.db.patch("shareAccess", existing._id, {
        shareId: share._id,
        permission: share.permission,
        lastOpenedAt: now,
      });
    } else {
      await ctx.db.insert("shareAccess", {
        userId: identity.subject,
        designId: design._id,
        shareId: share._id,
        permission: share.permission,
        lastOpenedAt: now,
      });
    }
    if (!share.lastUsedAt || now - share.lastUsedAt > 60_000) {
      await ctx.db.patch("shares", share._id, { lastUsedAt: now });
    }
    return { designId: design._id, permission: share.permission };
  },
});

// --- snapshots / versions ---------------------------------------------------------------------------------

/** Write a snapshot of the current state now (editors). Returns the snapshot seq and blob ref. */
export const snapshot = action({
  args: { designId: v.id("designs") },
  handler: async (ctx, args): Promise<{ seq: number; key: string } | null> => {
    await ctx.runQuery(internal.designs.internal.checkAccess, {
      designId: args.designId,
      need: "edit",
    });
    return await ctx.runAction(internal.designs.snapshotNode.run, {
      designId: args.designId,
      reason: "manual",
    });
  },
});

/** Restore a version: commits one transaction that turns the current design into the version. */
export const restoreVersion = action({
  args: { versionId: v.id("versions") },
  handler: async (ctx, args): Promise<{ seq: number }> =>
    await restoreVersionHandler(ctx, args.versionId),
});
