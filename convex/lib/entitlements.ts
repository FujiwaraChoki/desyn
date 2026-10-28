import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { edition } from "./env";
import { errors } from "./errors";
import { featureFlagKey, getFlagDoc, resolveFlag } from "./flags";
import { getProfile } from "./guards";
import { type FeatureKey, type LimitKey, PLANS, type Plan, type PlanId } from "./plans";
import { getUsage } from "./usage";

type DbCtx = QueryCtx | MutationCtx;
type UserRef = string | { userId: string; profile?: Doc<"profiles"> | null };

const MB = 1024 * 1024;

/** Effective plan for a profile. Self-host is always "selfhost"; hosted honors an admin override. */
export function planForProfile(
  profile: Pick<Doc<"profiles">, "plan" | "planOverride"> | null | undefined,
): PlanId {
  if (edition() === "selfhost") return "selfhost";
  if (!profile) return "free";
  return profile.planOverride ?? profile.plan;
}

async function resolveProfile(ctx: DbCtx, user: UserRef): Promise<Doc<"profiles"> | null> {
  if (typeof user === "string") return await getProfile(ctx, user);
  if (user.profile !== undefined) return user.profile;
  return await getProfile(ctx, user.userId);
}

function userIdOf(user: UserRef): string {
  return typeof user === "string" ? user : user.userId;
}

export async function getPlan(ctx: DbCtx, user: UserRef): Promise<PlanId> {
  if (edition() === "selfhost") return "selfhost";
  return planForProfile(await resolveProfile(ctx, user));
}

export async function getPlanDetails(ctx: DbCtx, user: UserRef): Promise<Plan> {
  return PLANS[await getPlan(ctx, user)];
}

/** Plan of the workspace owner; workspace-level limits and team features follow the owner's plan. */
export async function getWorkspacePlan(ctx: DbCtx, workspaceId: Id<"workspaces">): Promise<PlanId> {
  if (edition() === "selfhost") return "selfhost";
  const workspace = await ctx.db.get("workspaces", workspaceId);
  if (!workspace) throw errors.notFound("Workspace");
  return await getPlan(ctx, workspace.ownerId);
}

/** Whether `feature` is available to the user: plan feature, overridden by `feature.<key>` flags. */
export async function hasFeature(ctx: DbCtx, user: UserRef, feature: FeatureKey): Promise<boolean> {
  const plan = await getPlan(ctx, user);
  const base = PLANS[plan].features[feature];
  const flag = await getFlagDoc(ctx, featureFlagKey(feature));
  return resolveFlag(flag, { userId: userIdOf(user), plan }) ?? base;
}

export async function assertFeature(ctx: DbCtx, user: UserRef, feature: FeatureKey): Promise<void> {
  if (!(await hasFeature(ctx, user, feature))) throw errors.feature(feature);
}

export async function assertWorkspaceFeature(
  ctx: DbCtx,
  workspaceId: Id<"workspaces">,
  feature: FeatureKey,
): Promise<void> {
  const workspace = await ctx.db.get("workspaces", workspaceId);
  if (!workspace) throw errors.notFound("Workspace");
  await assertFeature(ctx, workspace.ownerId, feature);
}

export async function getLimit(ctx: DbCtx, user: UserRef, limit: LimitKey): Promise<number | null> {
  return PLANS[await getPlan(ctx, user)].limits[limit];
}

/** Current value for limits that Desyn tracks itself. Others must be passed as `current`. */
async function trackedCurrent(
  ctx: DbCtx,
  userId: string,
  limit: LimitKey,
): Promise<number | undefined> {
  switch (limit) {
    case "designs":
      return await getUsage(ctx, userId, "designs");
    case "brandKits":
      return await getUsage(ctx, userId, "brandKits");
    case "storageMb":
      return (await getUsage(ctx, userId, "storageBytes")) / MB;
    case "exportsPerMonth":
      return await getUsage(ctx, userId, "exports");
    case "workspaces": {
      const owned = await ctx.db
        .query("workspaces")
        .withIndex("by_owner", (q) => q.eq("ownerId", userId))
        .collect();
      return owned.length;
    }
    default:
      return undefined;
  }
}

/**
 * Throw LIMIT_REACHED if `current + adding` would exceed the plan limit. `current` defaults to the
 * tracked counter for designs, brandKits, storageMb (MB), exportsPerMonth and workspaces; per-object
 * limits (pagesPerDesign, uploadMbPerFile, collaboratorsPerDesign, versionHistoryDays) need `current`.
 * `adding` defaults to 1 and uses the limit's unit (MB for storageMb / uploadMbPerFile).
 */
export async function assertLimit(
  ctx: DbCtx,
  user: UserRef,
  limit: LimitKey,
  opts: { current?: number; adding?: number } = {},
): Promise<void> {
  const max = await getLimit(ctx, user, limit);
  if (max === null) return;
  const userId = userIdOf(user);
  const current = opts.current ?? (await trackedCurrent(ctx, userId, limit));
  if (current === undefined) {
    throw new Error(`assertLimit(${limit}) needs an explicit current value`);
  }
  const adding = opts.adding ?? 1;
  if (current + adding > max) throw errors.limit(limit, max, Math.round(current * 100) / 100);
}

/** Validate a single upload size and the remaining storage for it. */
export async function assertUploadAllowed(ctx: DbCtx, user: UserRef, bytes: number): Promise<void> {
  await assertLimit(ctx, user, "uploadMbPerFile", { current: 0, adding: bytes / MB });
  await assertLimit(ctx, user, "storageMb", { adding: bytes / MB });
}
