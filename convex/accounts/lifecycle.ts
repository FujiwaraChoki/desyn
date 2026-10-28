import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { enqueueEmail } from "../emails/queue";
import { writeAudit } from "../lib/audit";
import { appUrl, isHosted } from "../lib/env";
import { getProfile } from "../lib/guards";
import { capture } from "../lib/posthog";
import { bumpCounter } from "./counters";

// User lifecycle, driven by Better Auth component triggers (convex/auth.ts). These run inside the
// same transaction as the Better Auth write.

export interface AuthUserDoc {
  _id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  image?: string | null;
}

export function personalWorkspaceName(name: string): string {
  const first = name.trim().split(/\s+/)[0];
  return first ? `${first}'s workspace` : "My workspace";
}

/** Create the profile, personal workspace and owner membership for a user. Idempotent. */
export async function provisionUser(
  ctx: MutationCtx,
  user: AuthUserDoc,
): Promise<{ profileId: Id<"profiles">; workspaceId: Id<"workspaces">; created: boolean }> {
  const existing = await getProfile(ctx, user._id);
  if (existing?.defaultWorkspaceId) {
    return { profileId: existing._id, workspaceId: existing.defaultWorkspaceId, created: false };
  }
  const now = Date.now();
  // Self-host: the first account becomes the instance admin. Hosted admins come from ADMIN_EMAILS.
  const hasAdmin = isHosted()
    ? true
    : (await ctx.db
        .query("profiles")
        .withIndex("by_role", (q) => q.eq("role", "admin"))
        .first()) !== null;

  const workspaceId = await ctx.db.insert("workspaces", {
    name: personalWorkspaceName(user.name),
    kind: "personal",
    ownerId: user._id,
    createdAt: now,
    updatedAt: now,
  });
  await ctx.db.insert("memberships", {
    workspaceId,
    userId: user._id,
    role: "owner",
    createdAt: now,
    updatedAt: now,
  });

  let profileId: Id<"profiles">;
  if (existing) {
    profileId = existing._id;
    await ctx.db.patch("profiles", existing._id, {
      defaultWorkspaceId: workspaceId,
      updatedAt: now,
    });
  } else {
    profileId = await ctx.db.insert("profiles", {
      userId: user._id,
      email: user.email.toLowerCase(),
      name: user.name,
      ...(user.image ? { image: user.image } : {}),
      plan: "free",
      role: hasAdmin ? "user" : "admin",
      onboarding: { completed: false, step: "welcome" },
      appearance: { theme: "system" },
      defaultWorkspaceId: workspaceId,
      createdAt: now,
      updatedAt: now,
    });
    await bumpCounter(ctx, "users", 1);
  }
  return { profileId, workspaceId, created: !existing };
}

async function sendWelcome(ctx: MutationCtx, user: AuthUserDoc): Promise<void> {
  const profile = await getProfile(ctx, user._id);
  if (!profile || profile.welcomedAt) return;
  await ctx.db.patch("profiles", profile._id, { welcomedAt: Date.now() });
  await enqueueEmail(ctx, {
    to: user.email,
    template: "welcome",
    data: { name: user.name, url: `${appUrl()}/` },
    userId: user._id,
    idempotencyKey: `welcome:${user._id}`,
  });
}

export async function onUserCreated(ctx: MutationCtx, user: AuthUserDoc): Promise<void> {
  const result = await provisionUser(ctx, user);
  if (!result.created) return;
  await writeAudit(ctx, {
    action: "user.created",
    actorId: user._id,
    targetType: "user",
    targetId: user._id,
    workspaceId: result.workspaceId,
  });
  // OAuth sign-ups arrive verified; email+password users get the welcome after verifying.
  if (user.emailVerified) await sendWelcome(ctx, user);
  await capture(ctx, { distinctId: user._id, event: "user signed up" });
}

export async function onUserUpdated(
  ctx: MutationCtx,
  next: AuthUserDoc,
  prev: AuthUserDoc,
): Promise<void> {
  const profile = await getProfile(ctx, next._id);
  if (!profile) {
    await provisionUser(ctx, next);
  } else {
    const patch: { email?: string; name?: string; image?: string; updatedAt?: number } = {};
    if (next.email.toLowerCase() !== profile.email) patch.email = next.email.toLowerCase();
    if (next.name !== profile.name) patch.name = next.name;
    if ((next.image ?? undefined) !== profile.image && next.image) patch.image = next.image;
    if (Object.keys(patch).length > 0) {
      patch.updatedAt = Date.now();
      await ctx.db.patch("profiles", profile._id, patch);
    }
  }
  if (next.email.toLowerCase() !== prev.email.toLowerCase()) {
    await writeAudit(ctx, {
      action: "user.emailChanged",
      actorId: next._id,
      targetType: "user",
      targetId: next._id,
    });
  }
  if (next.emailVerified && !prev.emailVerified) {
    await writeAudit(ctx, {
      action: "user.emailVerified",
      actorId: next._id,
      targetType: "user",
      targetId: next._id,
    });
    await sendWelcome(ctx, next);
  }
}

export async function onUserDeleted(ctx: MutationCtx, user: AuthUserDoc): Promise<void> {
  await writeAudit(ctx, {
    action: "user.deleted",
    actorId: user._id,
    targetType: "user",
    targetId: user._id,
  });
  await ctx.scheduler.runAfter(0, internal.accounts.cleanup.purgeUser, { userId: user._id });
  await capture(ctx, { distinctId: user._id, event: "user deleted account" });
}
