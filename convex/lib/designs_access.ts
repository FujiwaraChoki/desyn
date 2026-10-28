import { pbkdf2 } from "@noble/hashes/pbkdf2.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { type Infer, v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { randomBytes, timingSafeEqual, toHex } from "./crypto";
import { appError, errors } from "./errors";
import { getMembership, getUser } from "./guards";
import type { Role } from "./validators";

// Design access: workspace membership (roles) combined with share links. A share token grants its
// permission to anyone holding it (view works signed out; comment and edit need a signed-in user so every
// change has an author). Non-members without a valid token get NOT_FOUND so design ids cannot be probed.

type DbCtx = QueryCtx | MutationCtx;

export type DesignPermission = "view" | "comment" | "edit" | "manage";
const RANK: Record<DesignPermission, number> = { view: 0, comment: 1, edit: 2, manage: 3 };

export function permissionAtLeast(have: DesignPermission, need: DesignPermission): boolean {
  return RANK[have] >= RANK[need];
}

function maxPermission(
  a: DesignPermission | null,
  b: DesignPermission | null,
): DesignPermission | null {
  if (a === null) return b;
  if (b === null) return a;
  return RANK[a] >= RANK[b] ? a : b;
}

/** Optional share-link credentials accepted by design functions. */
export const shareArg = v.optional(
  v.object({ token: v.string(), password: v.optional(v.string()) }),
);
export type ShareArg = Infer<typeof shareArg>;

/** Workspace role -> design permission. A design's creator with the editor role manages it. */
export function permissionForRole(role: Role, isCreator: boolean): DesignPermission {
  switch (role) {
    case "owner":
    case "admin":
      return "manage";
    case "editor":
      return isCreator ? "manage" : "edit";
    case "commenter":
      return "comment";
    default:
      return "view";
  }
}

const PBKDF2_ITERATIONS = 20_000;

export function hashSharePassword(password: string, salt?: string): { hash: string; salt: string } {
  const s = salt ?? toHex(randomBytes(16));
  const derived = pbkdf2(sha256, utf8ToBytes(password), utf8ToBytes(s), {
    c: PBKDF2_ITERATIONS,
    dkLen: 32,
  });
  return { hash: bytesToHex(derived), salt: s };
}

export function verifySharePassword(share: Doc<"shares">, password: string | undefined): boolean {
  if (!share.passwordHash || !share.passwordSalt) return true;
  if (!password) return false;
  return timingSafeEqual(hashSharePassword(password, share.passwordSalt).hash, share.passwordHash);
}

export type ShareStatus =
  | "ok"
  | "invalid"
  | "revoked"
  | "expired"
  | "password_required"
  | "wrong_password";

/** Validate a share token for a design (or any design when `designId` is omitted). */
export async function checkShare(
  ctx: DbCtx,
  share: ShareArg,
  opts: { designId?: Id<"designs">; now?: number } = {},
): Promise<{ status: ShareStatus; share: Doc<"shares"> | null }> {
  if (!share) return { status: "invalid", share: null };
  const row = await ctx.db
    .query("shares")
    .withIndex("by_token", (q) => q.eq("token", share.token))
    .unique();
  if (!row || (opts.designId && row.designId !== opts.designId))
    return { status: "invalid", share: null };
  if (row.revokedAt) return { status: "revoked", share: row };
  if (row.expiresAt !== undefined && row.expiresAt <= (opts.now ?? Date.now())) {
    return { status: "expired", share: row };
  }
  if (row.passwordHash) {
    // Only a grant from designs.unlockShare opens a protected link; raw passwords are checked there alone
    // (rate limited), never here, so queries cannot be used to guess them.
    if (!share.password?.startsWith(SHARE_GRANT_PREFIX)) return { status: "password_required", share: row };
    const grant = await ctx.db
      .query("shareGrants")
      .withIndex("by_hash", (q) => q.eq("grantHash", hashShareGrant(share.password as string)))
      .unique();
    if (!grant || grant.shareId !== row._id || grant.expiresAt <= (opts.now ?? Date.now())) {
      return { status: "password_required", share: row };
    }
  }
  return { status: "ok", share: row };
}

export const SHARE_GRANT_PREFIX = "sg_";
/** How long an unlocked share link stays open in a browser session. */
export const SHARE_GRANT_TTL_MS = 12 * 60 * 60 * 1000;

export function hashShareGrant(grant: string): string {
  return bytesToHex(sha256(utf8ToBytes(grant)));
}

export interface ResolvedAccess {
  /** Signed-in user (or trusted caller-provided user), null for anonymous share viewers. */
  userId: string | null;
  permission: DesignPermission;
  via: "member" | "share";
  role: Role | null;
  isCreator: boolean;
  shareId: Id<"shares"> | null;
}

export interface AccessOptions {
  share?: ShareArg;
  /** Trusted user id (internal callers after API-key / agent verification). Skips session lookup. */
  userId?: string;
}

/** Load a design that is visible to API callers (not mid-creation). */
export async function getDesignOrThrow(
  ctx: DbCtx,
  designId: Id<"designs">,
): Promise<Doc<"designs">> {
  const design = await ctx.db.get("designs", designId);
  if (!design || design.state === "creating") throw errors.notFound("Design");
  return design;
}

/**
 * Resolve the caller's permission on a design and require at least `need`. Trashed designs are only
 * reachable by members (share links stop working while a design is in the trash).
 */
export async function requireDesignPermission(
  ctx: DbCtx,
  design: Doc<"designs">,
  need: DesignPermission,
  opts: AccessOptions = {},
): Promise<ResolvedAccess> {
  let userId: string | null = opts.userId ?? null;
  if (!userId) {
    const user = await getUser(ctx);
    if (user?.profile?.disabled) throw errors.forbidden("This account is disabled.");
    userId = user?.userId ?? null;
  }

  let memberPermission: DesignPermission | null = null;
  let role: Role | null = null;
  const isCreator = userId !== null && design.ownerId === userId;
  if (userId) {
    const membership = await getMembership(ctx, design.workspaceId, userId);
    if (membership) {
      role = membership.role;
      memberPermission = permissionForRole(membership.role, isCreator);
    }
  }

  let sharePermission: DesignPermission | null = null;
  let shareId: Id<"shares"> | null = null;
  if (opts.share && design.state !== "trashed") {
    const checked = await checkShare(ctx, opts.share, { designId: design._id });
    if (checked.status === "password_required" && memberPermission === null) {
      throw appError("FORBIDDEN", "This link is protected with a password.", {
        reason: "password_required",
      });
    }
    if (checked.status === "wrong_password" && memberPermission === null) {
      throw appError("FORBIDDEN", "The password is not correct.", { reason: "wrong_password" });
    }
    if (checked.status === "expired" && memberPermission === null) {
      throw errors.expired("This share link has expired.");
    }
    if (checked.status === "ok" && checked.share) {
      shareId = checked.share._id;
      // Commenting and editing through a link need an identity to attribute changes to.
      sharePermission = userId ? checked.share.permission : "view";
    }
  }

  const permission = maxPermission(memberPermission, sharePermission);
  if (permission === null) throw errors.notFound("Design");
  if (!permissionAtLeast(permission, need)) {
    if (need !== "view" && userId === null) throw errors.unauthenticated();
    throw errors.forbidden("You do not have permission to do that with this design.");
  }
  const via = memberPermission !== null && memberPermission === permission ? "member" : "share";
  return { userId, permission, via, role, isCreator, shareId };
}

/** Like requireDesignPermission but also requires a user id (for writes). */
export async function requireDesignWriter(
  ctx: DbCtx,
  design: Doc<"designs">,
  need: DesignPermission,
  opts: AccessOptions = {},
): Promise<ResolvedAccess & { userId: string }> {
  const access = await requireDesignPermission(ctx, design, need, opts);
  if (!access.userId) throw errors.unauthenticated();
  return access as ResolvedAccess & { userId: string };
}
