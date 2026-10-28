import type { Doc } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

type DbCtx = QueryCtx | MutationCtx;

// Runtime feature flags (`featureFlags` table). Keys are free-form; plan features are overridden with
// the key `feature.<featureKey>` (e.g. "feature.ai.images"). Resolution for a user:
//   1. flag missing                         -> undefined (caller falls back to its default)
//   2. `userIds` set and contains the user  -> flag.enabled
//   3. `userIds` set, user not listed       -> undefined, unless `plans`/`rollout` also match
//   4. `plans` set and plan not listed      -> undefined
//   5. `rollout` set                        -> enabled only for users in the rollout bucket
//   6. otherwise                            -> flag.enabled

export function featureFlagKey(feature: string): string {
  return `feature.${feature}`;
}

/** Deterministic bucket 0..99 for a user + key (FNV-1a), so rollouts are stable per user. */
export function rolloutBucket(userId: string, key: string): number {
  let hash = 0x811c9dc5;
  const input = `${key}:${userId}`;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % 100;
}

export function resolveFlag(
  flag: Pick<Doc<"featureFlags">, "key" | "enabled" | "plans" | "userIds" | "rollout"> | null,
  subject: { userId?: string; plan?: string },
): boolean | undefined {
  if (!flag) return undefined;
  if (flag.userIds && flag.userIds.length > 0) {
    if (subject.userId && flag.userIds.includes(subject.userId)) return flag.enabled;
    if (!flag.plans && flag.rollout === undefined) return undefined;
  }
  if (flag.plans && flag.plans.length > 0) {
    if (!subject.plan || !flag.plans.includes(subject.plan)) return undefined;
  }
  if (flag.rollout !== undefined) {
    if (!subject.userId) return undefined;
    return rolloutBucket(subject.userId, flag.key) < flag.rollout ? flag.enabled : undefined;
  }
  return flag.enabled;
}

export async function getFlagDoc(ctx: DbCtx, key: string): Promise<Doc<"featureFlags"> | null> {
  return await ctx.db
    .query("featureFlags")
    .withIndex("by_key", (q) => q.eq("key", key))
    .unique();
}

/** Resolve a flag for a subject; `fallback` when the flag does not apply. */
export async function isFlagEnabled(
  ctx: DbCtx,
  key: string,
  subject: { userId?: string; plan?: string } = {},
  fallback = false,
): Promise<boolean> {
  return resolveFlag(await getFlagDoc(ctx, key), subject) ?? fallback;
}
