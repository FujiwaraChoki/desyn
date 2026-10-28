import { type AssetRef, type Design, type Node, newId, type Op } from "@desyn/schema";
import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
} from "../_generated/server";
import { createDesignFor } from "../designs/designs";
import { apiDesignView, idOf, type Principal, principalValidator } from "../lib/api_principal";
import { commitTransaction } from "../lib/designs_commit";
import { loadTemplateJson } from "../lib/designs_templates";
import { hasFeature } from "../lib/entitlements";
import { errors } from "../lib/errors";
import { listQuery, templateView } from "../templates/templates";
import { findWorkspaceAsset } from "./assets";

// Agent API: template search, details (with slots) and instantiation with slot filling.

type DbCtx = QueryCtx | MutationCtx;

async function view(ctx: DbCtx, t: Doc<"templates">) {
  const { favorite: _favorite, ...rest } = await templateView(ctx, t, false);
  return rest;
}

/** A published template by id or slug. */
async function resolveTemplate(ctx: DbCtx, ref: string): Promise<Doc<"templates">> {
  const id = ctx.db.normalizeId("templates", ref);
  const t = id
    ? await ctx.db.get("templates", id)
    : await ctx.db
        .query("templates")
        .withIndex("by_slug", (q) => q.eq("slug", ref))
        .unique();
  if (t?.status !== "published") throw errors.notFound("Template");
  return t;
}

function textOf(node: Node): string {
  return node.type === "text" ? node.runs.map((r) => r.text).join("") : "";
}

function slotOf(node: Node): string | null {
  const slot = (node.meta as { slot?: unknown } | undefined)?.slot;
  return typeof slot === "string" && slot.length > 0 ? slot : null;
}

export const search = internalQuery({
  args: {
    principal: principalValidator,
    q: v.optional(v.string()),
    kind: v.optional(v.string()),
    category: v.optional(v.string()),
    premium: v.optional(v.boolean()),
    sort: v.optional(v.union(v.literal("popular"), v.literal("new"))),
    numItems: v.number(),
    cursor: v.union(v.string(), v.null()),
  },
  handler: async (ctx, args) => {
    const opts = { numItems: args.numItems, cursor: args.cursor };
    const text = args.q?.trim().toLowerCase().slice(0, 200);
    const page = text
      ? await ctx.db
          .query("templates")
          .withSearchIndex("search_text", (q) => {
            let s = q.search("searchText", text).eq("status", "published");
            if (args.kind) s = s.eq("kind", args.kind);
            if (args.category) s = s.eq("category", args.category);
            if (args.premium !== undefined) s = s.eq("premium", args.premium);
            return s;
          })
          .paginate(opts)
      : await listQuery(ctx, {
          ...(args.kind ? { kind: args.kind } : {}),
          ...(args.category ? { category: args.category } : {}),
          ...(args.sort ? { sort: args.sort } : {}),
        }).paginate(opts);
    const items = [];
    for (const t of page.page) {
      if (args.premium !== undefined && t.premium !== args.premium) continue;
      items.push(await view(ctx, t));
    }
    return { items, nextCursor: page.isDone ? null : page.continueCursor };
  },
});

export const get = internalQuery({
  args: { principal: principalValidator, template: v.string() },
  handler: async (ctx, args) => {
    const t = await resolveTemplate(ctx, args.template);
    const canUse =
      !t.premium || (await hasFeature(ctx, args.principal.userId, "templates.premium"));
    const design = JSON.parse(await loadTemplateJson(ctx, t)) as Design;
    const slots = [];
    for (const node of Object.values(design.nodes)) {
      const slot = slotOf(node);
      if (!slot) continue;
      const type =
        node.type === "text"
          ? "text"
          : node.type === "image" || node.type === "svg"
            ? "image"
            : null;
      if (!type) continue;
      // Premium copy stays hidden from plans that cannot use the template (thumbnails preview it).
      slots.push({
        slot,
        type,
        nodeId: node.id,
        text: type === "text" && canUse ? textOf(node) : null,
      });
    }
    slots.sort((a, b) => a.slot.localeCompare(b.slot));
    return { ...(await view(ctx, t)), canUse, slots };
  },
});

/** Ops that fill slots of a freshly instantiated design. */
async function slotOps(
  ctx: MutationCtx,
  principal: Principal,
  designId: Id<"designs">,
  slots: Record<string, string>,
): Promise<{ ops: Op[]; filled: string[]; unknown: string[] }> {
  const rows = await ctx.db
    .query("nodes")
    .withIndex("by_design_node", (q) => q.eq("designId", designId))
    .collect();
  const ops: Op[] = [];
  const assets: Record<string, AssetRef> = {};
  const filled = new Set<string>();
  for (const row of rows) {
    const node = JSON.parse(row.data) as Node;
    const slot = slotOf(node);
    if (!slot || !Object.hasOwn(slots, slot)) continue;
    const value = slots[slot] as string;
    if (node.type === "text") {
      const style = node.runs[0]?.style;
      ops.push({
        op: "update",
        id: node.id,
        set: { runs: [style ? { text: value, style } : { text: value }] },
      });
      filled.add(slot);
    } else if (node.type === "image" || node.type === "svg") {
      const asset = await findWorkspaceAsset(ctx, principal.workspaceId, value);
      if (!asset) throw errors.invalid(`Slot "${slot}" needs an asset of this workspace.`, "slots");
      const wanted = node.type === "image" ? ["image"] : ["svg"];
      if (!wanted.includes(asset.kind)) {
        throw errors.invalid(
          `Slot "${slot}" needs ${node.type === "image" ? "an image" : "an SVG"} asset.`,
          "slots",
        );
      }
      assets[asset.refId] = {
        id: asset.refId,
        kind: asset.kind,
        storageKey: asset.storageKey,
        mime: asset.mime,
        bytes: asset.bytes,
        ...(asset.width !== undefined ? { width: asset.width } : {}),
        ...(asset.height !== undefined ? { height: asset.height } : {}),
        ...(asset.hash !== undefined ? { hash: asset.hash } : {}),
        name: asset.name,
        source: asset.source,
      };
      ops.push(
        node.type === "image"
          ? { op: "update", id: node.id, set: { assetId: asset.refId }, unset: ["crop"] }
          : { op: "update", id: node.id, set: { assetId: asset.refId }, unset: ["markup"] },
      );
      filled.add(slot);
    }
  }
  if (Object.keys(assets).length > 0) ops.unshift({ op: "asset", set: assets });
  const unknown = Object.keys(slots).filter((s) => !filled.has(s));
  return { ops, filled: [...filled].sort(), unknown: unknown.sort() };
}

export const instantiate = internalMutation({
  args: {
    principal: principalValidator,
    template: v.string(),
    name: v.optional(v.string()),
    folderId: v.optional(v.string()),
    slots: v.optional(v.record(v.string(), v.string())),
  },
  handler: async (ctx, args) => {
    const { principal } = args;
    const t = await resolveTemplate(ctx, args.template);
    let folderId: Id<"folders"> | undefined;
    if (args.folderId) {
      folderId = idOf(ctx, "folders", args.folderId, "Folder");
      const folder = await ctx.db.get("folders", folderId);
      if (!folder || folder.workspaceId !== principal.workspaceId) throw errors.notFound("Folder");
    }
    const { designId } = await createDesignFor(
      ctx,
      {
        workspaceId: principal.workspaceId,
        templateId: t._id,
        ...(folderId ? { folderId } : {}),
        ...(args.name !== undefined ? { name: args.name } : {}),
      },
      { userId: principal.userId },
    );
    let filled: string[] = [];
    let unknown: string[] = [];
    if (args.slots && Object.keys(args.slots).length > 0) {
      const result = await slotOps(ctx, principal, designId, args.slots);
      filled = result.filled;
      unknown = result.unknown;
      const design = await ctx.db.get("designs", designId);
      if (design && result.ops.length > 0) {
        await commitTransaction(ctx, {
          design,
          actorId: principal.userId,
          tx: {
            id: newId(),
            label: "Fill template slots",
            ops: result.ops,
            source: "template",
            actor: { userId: principal.userId, agent: "api" },
            ts: Date.now(),
          },
        });
      }
    }
    const design = await ctx.db.get("designs", designId);
    if (!design) throw errors.notFound("Design");
    const root = await ctx.db
      .query("nodes")
      .withIndex("by_design_node", (q) => q.eq("designId", designId).eq("nodeId", "root"))
      .unique();
    const firstPageId = root
      ? ((JSON.parse(root.data) as { children?: string[] }).children?.[0] ?? null)
      : null;
    return {
      ...(await apiDesignView(ctx, principal, design)),
      firstPageId,
      filledSlots: filled,
      unknownSlots: unknown,
    };
  },
});
