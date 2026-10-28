import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { authComponent } from "../auth";
import { adminEmails, isHosted } from "./env";
import { errors } from "./errors";
import { DESIGN_LEVEL_MIN_ROLE, type DesignAccessLevel, roleAtLeast } from "./roles";
import type { Role } from "./validators";

type DbCtx = QueryCtx | MutationCtx;

/** The signed-in user as seen by Desyn functions. `userId` is the Better Auth user id. */
export interface AuthedUser {
  userId: string;
  email: string;
  name: string;
  emailVerified: boolean;
  image: string | null;
  /** May be null for a brand-new user whose profile has not been created yet (created on first write). */
  profile: Doc<"profiles"> | null;
}

export async function getProfile(ctx: DbCtx, userId: string): Promise<Doc<"profiles"> | null> {
  return await ctx.db
    .query("profiles")
    .withIndex("by_userId", (q) => q.eq("userId", userId))
    .unique();
}

/** Current user or null. Validates that the Better Auth session behind the JWT is still alive. */
export async function getUser(ctx: DbCtx): Promise<AuthedUser | null> {
  const authUser = await authComponent.safeGetAuthUser(ctx);
  if (!authUser) return null;
  const userId = authUser._id;
  const profile = await getProfile(ctx, userId);
  return {
    userId,
    email: authUser.email,
    name: authUser.name,
    emailVerified: authUser.emailVerified,
    image: authUser.image ?? null,
    profile,
  };
}

/**
 * Require a signed-in, enabled user. With `verified: true` the email must be verified too
 * (email+password accounts must verify before signing in anyway; this guards OAuth edge cases).
 */
export async function requireUser(
  ctx: DbCtx,
  opts: { verified?: boolean } = {},
): Promise<AuthedUser> {
  const user = await getUser(ctx);
  if (!user) throw errors.unauthenticated();
  if (user.profile?.disabled) throw errors.forbidden("This account is disabled.");
  if (opts.verified && !user.emailVerified) {
    throw errors.forbidden("Verify your email address to continue.");
  }
  return user;
}

/**
 * Whether a profile has admin rights: role "admin" (self-host) or, on hosted, an ADMIN_EMAILS match
 * on a verified email address. `emailVerified: false` (e.g. an OAuth account whose provider did not
 * verify the address) never matches ADMIN_EMAILS.
 */
export function isAdminProfile(
  profile: Pick<Doc<"profiles">, "role" | "email"> | null,
  opts: { emailVerified?: boolean } = {},
): boolean {
  if (!profile) return false;
  if (profile.role === "admin") return true;
  if (opts.emailVerified === false) return false;
  return isHosted() && adminEmails().includes(profile.email.toLowerCase());
}

export async function requireAdmin(ctx: DbCtx): Promise<AuthedUser & { profile: Doc<"profiles"> }> {
  const user = await requireUser(ctx);
  if (
    !user.profile ||
    !isAdminProfile(
      { role: user.profile.role, email: user.email },
      { emailVerified: user.emailVerified },
    )
  ) {
    throw errors.forbidden("Admin access required.");
  }
  return user as AuthedUser & { profile: Doc<"profiles"> };
}

export interface MemberAccess {
  userId: string;
  role: Role;
  membership: Doc<"memberships">;
  workspace: Doc<"workspaces">;
}

export async function getMembership(
  ctx: DbCtx,
  workspaceId: Id<"workspaces">,
  userId: string,
): Promise<Doc<"memberships"> | null> {
  return await ctx.db
    .query("memberships")
    .withIndex("by_workspace_user", (q) => q.eq("workspaceId", workspaceId).eq("userId", userId))
    .unique();
}

/**
 * Require that the current user (or `opts.userId`, for trusted internal callers such as the Agent API
 * after API-key verification) is a member of the workspace with at least `minRole`.
 * Non-members get NOT_FOUND so workspace ids cannot be probed.
 */
export async function requireMember(
  ctx: DbCtx,
  workspaceId: Id<"workspaces">,
  minRole: Role = "viewer",
  opts: { userId?: string } = {},
): Promise<MemberAccess> {
  const userId = opts.userId ?? (await requireUser(ctx)).userId;
  const workspace = await ctx.db.get("workspaces", workspaceId);
  if (!workspace) throw errors.notFound("Workspace");
  const membership = await getMembership(ctx, workspaceId, userId);
  if (!membership) throw errors.notFound("Workspace");
  if (!roleAtLeast(membership.role, minRole)) {
    throw errors.forbidden(`This needs the ${minRole} role or higher in this workspace.`);
  }
  return { userId, role: membership.role, membership, workspace };
}

/** Minimal design shape needed for access checks (the designs owner passes its document). */
export interface DesignAccessTarget {
  workspaceId: Id<"workspaces">;
  ownerId: string;
}

export interface DesignAccess {
  userId: string;
  /** Effective role; a design's creator with the editor role is treated as "admin" for that design. */
  role: Role;
  workspace: Doc<"workspaces">;
  membership: Doc<"memberships">;
  isOwner: boolean;
}

/**
 * Membership-based design access. The designs owner looks up the design, then calls this with the
 * document. Public share tokens are handled by the designs owner before falling back to this.
 *   view -> viewer, comment -> commenter, edit -> editor, manage -> admin (or the design's creator
 *   while they hold the editor role).
 */
export async function requireDesignAccess(
  ctx: DbCtx,
  design: DesignAccessTarget,
  level: DesignAccessLevel,
  opts: { userId?: string } = {},
): Promise<DesignAccess> {
  const access = await requireMember(ctx, design.workspaceId, "viewer", opts);
  const isOwner = design.ownerId === access.userId;
  // A design's creator manages it while they can still edit in the workspace; a creator later
  // demoted below editor keeps only what their workspace role allows.
  const effective: Role = isOwner && access.role === "editor" ? "admin" : access.role;
  if (!roleAtLeast(effective, DESIGN_LEVEL_MIN_ROLE[level])) {
    throw errors.forbidden("You do not have permission to do that with this design.");
  }
  return {
    userId: access.userId,
    role: effective,
    workspace: access.workspace,
    membership: access.membership,
    isOwner,
  };
}
