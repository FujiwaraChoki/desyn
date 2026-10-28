import { v } from "convex/values";
import { internalMutation, internalQuery } from "../_generated/server";
import { exportView, requestExportFor } from "../exports/exports";
import { designOf, idOf, principalValidator } from "../lib/api_principal";
import { requireDesignPermission } from "../lib/designs_access";
import { errors } from "../lib/errors";
import { exportFormatValidator } from "../tables/designs";

// Agent API: export jobs (rendered by the worker, DOCUMENT_MODEL §8).

export const request = internalMutation({
  args: {
    principal: principalValidator,
    designId: v.string(),
    format: exportFormatValidator,
    pages: v.optional(v.union(v.literal("all"), v.array(v.string()))),
    scale: v.optional(v.number()),
    quality: v.optional(v.number()),
    background: v.optional(v.string()),
    pdf: v.optional(v.object({ bleed: v.boolean(), cropMarks: v.boolean(), cmyk: v.boolean() })),
    notify: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const { principal, designId, ...rest } = args;
    const design = await designOf(ctx, principal, designId);
    const exportId = await requestExportFor(
      ctx,
      { ...rest, designId: design._id },
      { userId: principal.userId },
    );
    const row = await ctx.db.get("exports", exportId);
    if (!row) throw errors.notFound("Export");
    return await exportView(ctx, row);
  },
});

/** Status of a job the key's member requested (or any job of a design the member manages). */
export const get = internalQuery({
  args: { principal: principalValidator, exportId: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db.get("exports", idOf(ctx, "exports", args.exportId, "Export"));
    if (!row || row.workspaceId !== args.principal.workspaceId) throw errors.notFound("Export");
    if (row.userId !== args.principal.userId) {
      const design = await designOf(ctx, args.principal, row.designId);
      await requireDesignPermission(ctx, design, "manage", { userId: args.principal.userId });
    }
    return await exportView(ctx, row);
  },
});
