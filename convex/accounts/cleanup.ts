import type { DefaultFunctionArgs, FunctionReference, OptionalRestArgs } from "convex/server";
import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id, TableNames } from "../_generated/dataModel";
import {
  type ActionCtx,
  internalAction,
  internalMutation,
  type MutationCtx,
} from "../_generated/server";
import { writeAudit } from "../lib/audit";
import { createLogger } from "../lib/logger";
import { roleRank } from "../lib/roles";

// Data cleanup for account and workspace deletion.
//
// Other owners register hooks here (additive edit: append a reference). Each hook is an
// internal mutation that deletes a bounded batch and returns `{ done: true }` when nothing is left;
// it is called repeatedly until done. Hooks must be idempotent.
//   userCleanupHooks       args { userId }                    data owned by a user (all workspaces)
//   workspaceCleanupHooks  args { workspaceId }               data scoped to a workspace (designs, assets…)
//   folderCleanupHooks     args { workspaceId, folderIds }    items inside deleted folders (move to root)

type Done = { done: boolean };
export type UserCleanupHook = FunctionReference<"mutation", "internal", { userId: string }, Done>;
export type WorkspaceCleanupHook = FunctionReference<
  "mutation",
  "internal",
  { workspaceId: Id<"workspaces"> },
  Done
>;
export type FolderCleanupHook = FunctionReference<
  "mutation",
  "internal",
  { workspaceId: Id<"workspaces">; folderIds: Id<"folders">[] },
  Done
>;

export const userCleanupHooks: UserCleanupHook[] = [
  internal.designs.maintenance.userCleanup,
  internal.editor.prefs.userCleanup,
];
export const workspaceCleanupHooks: WorkspaceCleanupHook[] = [
  internal.designs.maintenance.workspaceCleanup,
  internal.panels.assetFolders.workspaceCleanup,
];
export const folderCleanupHooks: FolderCleanupHook[] = [internal.designs.maintenance.folderCleanup];

const BATCH = 200;
const MAX_HOOK_ROUNDS = 10_000;

async function drain<A extends DefaultFunctionArgs>(
  ctx: ActionCtx,
  hook: FunctionReference<"mutation", "internal", A, Done>,
  args: A,
) {
  for (let round = 0; round < MAX_HOOK_ROUNDS; round++) {
    // Generic args cannot be narrowed to the optional-rest tuple Convex expects; the shape is A.
    const result: Done = await ctx.runMutation(hook, ...([args] as OptionalRestArgs<typeof hook>));
    if (result.done) return;
  }
  throw new Error("cleanup hook did not finish");
}

// --- workspace purge -------------------------------------------------------------------------

/** Remove every membership first so nobody can reach the workspace while it is being purged. */
export const revokeWorkspaceAccess = internalMutation({
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, args): Promise<Done> => {
    const rows = await ctx.db
      .query("memberships")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
      .take(BATCH);
    for (const row of rows) await ctx.db.delete("memberships", row._id);
    return { done: rows.length < BATCH };
  },
});

export const deleteWorkspaceRows = internalMutation({
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, args): Promise<Done> => {
    const invites = await ctx.db
      .query("invites")
      .withIndex("by_workspace_status", (q) => q.eq("workspaceId", args.workspaceId))
      .take(BATCH);
    for (const row of invites) await ctx.db.delete("invites", row._id);
    const folders = await ctx.db
      .query("folders")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
      .take(BATCH);
    for (const row of folders) await ctx.db.delete("folders", row._id);
    const keys = await ctx.db
      .query("apiKeys")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
      .take(BATCH);
    for (const row of keys) await ctx.db.delete("apiKeys", row._id);
    if (invites.length === BATCH || folders.length === BATCH || keys.length === BATCH) {
      return { done: false };
    }
    if (await ctx.db.get("workspaces", args.workspaceId)) {
      await ctx.db.delete("workspaces", args.workspaceId);
    }
    return { done: true };
  },
});

async function purgeWorkspaceSteps(ctx: ActionCtx, workspaceId: Id<"workspaces">) {
  await drain(ctx, internal.accounts.cleanup.revokeWorkspaceAccess, { workspaceId });
  for (const hook of workspaceCleanupHooks) await drain(ctx, hook, { workspaceId });
  await drain(ctx, internal.accounts.cleanup.deleteWorkspaceRows, { workspaceId });
}

export const purgeWorkspace = internalAction({
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, args): Promise<void> => {
    await purgeWorkspaceSteps(ctx, args.workspaceId);
    const log = createLogger(ctx, { fn: "accounts.purgeWorkspace" });
    log.info("workspace purged", { workspaceId: args.workspaceId });
    await log.flush();
  },
});

// --- folder cleanup --------------------------------------------------------------------------

export const runFolderHooks = internalAction({
  args: { workspaceId: v.id("workspaces"), folderIds: v.array(v.id("folders")) },
  handler: async (ctx, args): Promise<void> => {
    for (const hook of folderCleanupHooks) await drain(ctx, hook, args);
  },
});

// --- user purge ------------------------------------------------------------------------------

/**
 * Leave every workspace. Team workspaces the user owns pass to the most senior remaining member
 * (admin, then editor, …, oldest first); workspaces with nobody left are returned for purging.
 */
export const detachUserFromWorkspaces = internalMutation({
  args: { userId: v.string() },
  handler: async (ctx, args): Promise<{ purge: Id<"workspaces">[] }> => {
    const memberships = await ctx.db
      .query("memberships")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .collect();
    const purge: Id<"workspaces">[] = [];
    for (const membership of memberships) {
      const workspace = await ctx.db.get("workspaces", membership.workspaceId);
      await ctx.db.delete("memberships", membership._id);
      if (!workspace || workspace.ownerId !== args.userId) continue;
      if (workspace.kind === "personal") {
        purge.push(workspace._id);
        continue;
      }
      const successor = await pickSuccessor(ctx, workspace._id);
      if (!successor) {
        purge.push(workspace._id);
        continue;
      }
      await ctx.db.patch("memberships", successor._id, { role: "owner", updatedAt: Date.now() });
      await ctx.db.patch("workspaces", workspace._id, {
        ownerId: successor.userId,
        updatedAt: Date.now(),
      });
      await writeAudit(ctx, {
        action: "workspace.ownershipTransferred",
        workspaceId: workspace._id,
        targetType: "user",
        targetId: successor.userId,
        data: { reason: "previous owner deleted their account" },
      });
    }
    // Workspaces owned by the user without a membership row (should not happen) are purged too.
    const owned = await ctx.db
      .query("workspaces")
      .withIndex("by_owner", (q) => q.eq("ownerId", args.userId))
      .collect();
    for (const ws of owned) if (!purge.includes(ws._id)) purge.push(ws._id);
    return { purge };
  },
});

async function pickSuccessor(ctx: MutationCtx, workspaceId: Id<"workspaces">) {
  const members = await ctx.db
    .query("memberships")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .collect();
  members.sort((a, b) => roleRank(b.role) - roleRank(a.role) || a.createdAt - b.createdAt);
  return members[0] ?? null;
}

/** Delete the user's own rows in bounded batches. Returns Stripe ids to cancel once done. */
export const deleteUserRows = internalMutation({
  args: { userId: v.string() },
  handler: async (
    ctx,
    args,
  ): Promise<Done & { stripe: { customerId: string; subscriptionIds: string[] } | null }> => {
    const { userId } = args;
    let full = false;
    const wipe = async <T extends TableNames>(rows: Doc<T>[], _table: T) => {
      for (const row of rows) await ctx.db.delete(row._id);
      if (rows.length === BATCH) full = true;
    };
    await wipe(
      await ctx.db
        .query("apiKeys")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .take(BATCH),
      "apiKeys",
    );
    await wipe(
      await ctx.db
        .query("nativeAuthCodes")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .take(BATCH),
      "nativeAuthCodes",
    );
    const sentInvites = await ctx.db
      .query("invites")
      .withIndex("by_inviter", (q) => q.eq("invitedBy", userId))
      .take(BATCH);
    for (const invite of sentInvites) {
      if (invite.status === "pending")
        await ctx.db.patch("invites", invite._id, { status: "revoked" });
    }
    await wipe(
      await ctx.db
        .query("credits")
        .withIndex("by_user_createdAt", (q) => q.eq("userId", userId))
        .take(BATCH),
      "credits",
    );
    for (const status of ["reserved", "committed", "refunded"] as const) {
      await wipe(
        await ctx.db
          .query("creditReservations")
          .withIndex("by_user_status", (q) => q.eq("userId", userId).eq("status", status))
          .take(BATCH),
        "creditReservations",
      );
    }
    await wipe(
      await ctx.db
        .query("creditBalances")
        .withIndex("by_user_period", (q) => q.eq("userId", userId))
        .take(BATCH),
      "creditBalances",
    );
    await wipe(
      await ctx.db
        .query("usage")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .take(BATCH),
      "usage",
    );
    if (full) return { done: false, stripe: null };

    const subscriptions = await ctx.db
      .query("subscriptions")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    const profile = await ctx.db
      .query("profiles")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .unique();
    const customerId = profile?.stripeCustomerId ?? subscriptions[0]?.stripeCustomerId;
    const live = subscriptions
      .filter((s) => s.status !== "canceled" && s.status !== "incomplete_expired")
      .map((s) => s.stripeSubscriptionId);
    for (const sub of subscriptions) await ctx.db.delete("subscriptions", sub._id);
    if (profile) {
      await ctx.db.delete("profiles", profile._id);
      const counter = await ctx.db
        .query("systemCounters")
        .withIndex("by_key", (q) => q.eq("key", "users"))
        .unique();
      if (counter) {
        await ctx.db.patch("systemCounters", counter._id, {
          value: Math.max(0, counter.value - 1),
          updatedAt: Date.now(),
        });
      }
    }
    return { done: true, stripe: customerId ? { customerId, subscriptionIds: live } : null };
  },
});

export const purgeUser = internalAction({
  args: { userId: v.string() },
  handler: async (ctx, args): Promise<void> => {
    const log = createLogger(ctx, { fn: "accounts.purgeUser", userId: args.userId });
    const { purge } = await ctx.runMutation(
      internal.accounts.cleanup.detachUserFromWorkspaces,
      args,
    );
    for (const workspaceId of purge) await purgeWorkspaceSteps(ctx, workspaceId);
    for (const hook of userCleanupHooks) await drain(ctx, hook, { userId: args.userId });
    let stripe: { customerId: string; subscriptionIds: string[] } | null = null;
    for (let round = 0; round < MAX_HOOK_ROUNDS; round++) {
      const result = await ctx.runMutation(internal.accounts.cleanup.deleteUserRows, args);
      if (result.done) {
        stripe = result.stripe;
        break;
      }
    }
    if (stripe && stripe.subscriptionIds.length > 0) {
      await ctx.scheduler.runAfter(0, internal.billing.stripeActions.cancelSubscriptions, {
        subscriptionIds: stripe.subscriptionIds,
      });
    }
    log.info("user purged", { workspaces: purge.length });
    await log.flush();
  },
});
