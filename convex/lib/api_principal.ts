import { type Infer, v } from "convex/values";
import type { Doc, Id, TableNames } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { getDesignOrThrow, permissionForRole } from "./designs_access";
import { designSummary } from "./designs_summary";
import { errors } from "./errors";
import { requireMember } from "./guards";

// The caller of an Agent API function: the member an API key acts as, in the workspace the key belongs to.
// The HTTP layer verifies the key (internal.accounts.apiKeys.verify) and the scopes before calling any
// internal function with a principal; functions still check workspace membership and roles.

export const principalValidator = v.object({
  userId: v.string(),
  workspaceId: v.id("workspaces"),
});
export type Principal = Infer<typeof principalValidator>;

type DbCtx = QueryCtx | MutationCtx;

/** Resolve an id from a URL path; malformed or foreign-table ids are NOT_FOUND (never a validator error). */
export function idOf<T extends TableNames>(ctx: DbCtx, table: T, raw: string, what: string): Id<T> {
  const id = ctx.db.normalizeId(table, raw);
  if (!id) throw errors.notFound(what);
  return id;
}

/** A design of the principal's workspace (designs of other workspaces are NOT_FOUND for this key). */
export async function designOf(
  ctx: DbCtx,
  principal: Principal,
  rawId: string,
): Promise<Doc<"designs">> {
  const design = await getDesignOrThrow(ctx, idOf(ctx, "designs", rawId, "Design"));
  if (design.workspaceId !== principal.workspaceId) throw errors.notFound("Design");
  return design;
}

export async function seqOf(ctx: DbCtx, designId: Id<"designs">): Promise<number> {
  const row = await ctx.db
    .query("designSeq")
    .withIndex("by_design", (q) => q.eq("designId", designId))
    .unique();
  return row?.seq ?? 0;
}

/** The API view of a design (DesignSummary + seq) for a member. */
export async function apiDesignView(ctx: DbCtx, principal: Principal, design: Doc<"designs">) {
  const member = await requireMember(ctx, design.workspaceId, "viewer", {
    userId: principal.userId,
  });
  const permission = permissionForRole(member.role, design.ownerId === principal.userId);
  const summary = await designSummary(ctx, design, permission);
  const state = summary.state === "creating" ? "active" : summary.state;
  return { ...summary, state, seq: await seqOf(ctx, design._id) };
}
