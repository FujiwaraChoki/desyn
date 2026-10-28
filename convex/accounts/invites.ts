import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { type MutationCtx, mutation, type QueryCtx, query } from "../_generated/server";
import { enqueueEmail } from "../emails/queue";
import { writeAudit } from "../lib/audit";
import { randomToken, sha256Hex } from "../lib/crypto";
import { assertWorkspaceFeature } from "../lib/entitlements";
import { appUrl } from "../lib/env";
import { errors } from "../lib/errors";
import { getMembership, getProfile, getUser, requireMember, requireUser } from "../lib/guards";
import { rateLimiter } from "../lib/rateLimits";
import { canManageRole, roleRank } from "../lib/roles";
import { assignableRoleValidator, type Role } from "../lib/validators";

export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const RESEND_COOLDOWN_MS = 60 * 1000;
const MAX_EMAILS_PER_CALL = 20;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function inviteUrl(token: string): string {
  return `${appUrl()}/accept/${encodeURIComponent(token)}`;
}

async function sendInviteEmail(
  ctx: MutationCtx,
  invite: { email: string; role: Role; expiresAt: number },
  token: string,
  workspace: Doc<"workspaces">,
  inviterName: string,
) {
  await enqueueEmail(ctx, {
    to: invite.email,
    template: "invite",
    data: {
      inviterName,
      workspaceName: workspace.name,
      role: invite.role,
      url: inviteUrl(token),
      expiresAt: invite.expiresAt,
    },
  });
}

async function issueToken(): Promise<{ token: string; tokenHash: string }> {
  const token = randomToken(32);
  return { token, tokenHash: await sha256Hex(token) };
}

async function inviteForToken(ctx: QueryCtx | MutationCtx, token: string) {
  if (!token || token.length > 200) return null;
  const tokenHash = await sha256Hex(token);
  return await ctx.db
    .query("invites")
    .withIndex("by_tokenHash", (q) => q.eq("tokenHash", tokenHash))
    .unique();
}

function effectiveStatus(invite: Doc<"invites">, now = Date.now()) {
  if (invite.status === "pending" && invite.expiresAt <= now) return "expired" as const;
  return invite.status;
}

/** Pending invites of a workspace (admins). */
export const list = query({
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, args) => {
    await requireMember(ctx, args.workspaceId, "admin");
    const rows = await ctx.db
      .query("invites")
      .withIndex("by_workspace_status", (q) =>
        q.eq("workspaceId", args.workspaceId).eq("status", "pending"),
      )
      .collect();
    const now = Date.now();
    const out = [];
    for (const invite of rows) {
      const inviter = await getProfile(ctx, invite.invitedBy);
      out.push({
        id: invite._id,
        email: invite.email,
        role: invite.role,
        expiresAt: invite.expiresAt,
        expired: invite.expiresAt <= now,
        invitedBy: inviter?.name ?? null,
        lastSentAt: invite.lastSentAt,
        sendCount: invite.sendCount,
        createdAt: invite.createdAt,
      });
    }
    out.sort((a, b) => b.createdAt - a.createdAt);
    return out;
  },
});

/**
 * Invite people by email to a team workspace. Existing members are skipped; an existing pending
 * invite is refreshed (new token, new expiry, role updated) and re-sent.
 */
export const create = mutation({
  args: {
    workspaceId: v.id("workspaces"),
    emails: v.array(v.string()),
    role: assignableRoleValidator,
  },
  handler: async (ctx, args) => {
    const access = await requireMember(ctx, args.workspaceId, "admin");
    if (access.workspace.kind === "personal") {
      throw errors.forbidden("Create a team workspace to invite people.");
    }
    await assertWorkspaceFeature(ctx, args.workspaceId, "teams");
    if (!canManageRole(access.role, args.role))
      throw errors.forbidden("You cannot invite with that role.");
    const emails = [...new Set(args.emails.map(normalizeEmail))].filter((e) => e.length > 0);
    if (emails.length === 0) throw errors.invalid("Add at least one email address.", "emails");
    if (emails.length > MAX_EMAILS_PER_CALL) {
      throw errors.invalid(`Invite at most ${MAX_EMAILS_PER_CALL} people at a time.`, "emails");
    }
    const invalid = emails.filter((e) => !EMAIL.test(e) || e.length > 254);
    if (invalid.length > 0) throw errors.invalid(`Invalid email: ${invalid[0]}`, "emails");
    const limited = await rateLimiter.limit(ctx, "invitesPerHour", {
      key: access.userId,
      count: emails.length,
    });
    if (!limited.ok) throw errors.rateLimited(limited.retryAfter, "invites");

    const inviter = await getProfile(ctx, access.userId);
    const inviterName = inviter?.name ?? "A teammate";
    const now = Date.now();
    const invited: string[] = [];
    const skipped: { email: string; reason: "already_member" }[] = [];

    for (const email of emails) {
      const profile = await ctx.db
        .query("profiles")
        .withIndex("by_email", (q) => q.eq("email", email))
        .first();
      if (profile && (await getMembership(ctx, args.workspaceId, profile.userId))) {
        skipped.push({ email, reason: "already_member" });
        continue;
      }
      const { token, tokenHash } = await issueToken();
      const expiresAt = now + INVITE_TTL_MS;
      const pending = (
        await ctx.db
          .query("invites")
          .withIndex("by_email_status", (q) => q.eq("email", email).eq("status", "pending"))
          .collect()
      ).find((i) => i.workspaceId === args.workspaceId);
      let inviteId: Id<"invites">;
      if (pending) {
        inviteId = pending._id;
        await ctx.db.patch("invites", pending._id, {
          role: args.role,
          tokenHash,
          expiresAt,
          invitedBy: access.userId,
          lastSentAt: now,
          sendCount: pending.sendCount + 1,
        });
      } else {
        inviteId = await ctx.db.insert("invites", {
          workspaceId: args.workspaceId,
          email,
          role: args.role,
          tokenHash,
          invitedBy: access.userId,
          status: "pending",
          expiresAt,
          lastSentAt: now,
          sendCount: 1,
          createdAt: now,
        });
      }
      await sendInviteEmail(
        ctx,
        { email, role: args.role, expiresAt },
        token,
        access.workspace,
        inviterName,
      );
      await writeAudit(ctx, {
        action: "invite.created",
        actorId: access.userId,
        workspaceId: args.workspaceId,
        targetType: "invite",
        targetId: inviteId,
        data: { email, role: args.role },
      });
      invited.push(email);
    }
    return { invited, skipped };
  },
});

async function loadInviteForAdmin(ctx: MutationCtx, inviteId: Id<"invites">) {
  const invite = await ctx.db.get("invites", inviteId);
  if (!invite) throw errors.notFound("Invite");
  const access = await requireMember(ctx, invite.workspaceId, "admin");
  return { invite, access };
}

export const resend = mutation({
  args: { inviteId: v.id("invites") },
  handler: async (ctx, args) => {
    const { invite, access } = await loadInviteForAdmin(ctx, args.inviteId);
    if (invite.status !== "pending") throw errors.conflict("This invite is no longer pending.");
    const now = Date.now();
    if (now - invite.lastSentAt < RESEND_COOLDOWN_MS) {
      throw errors.rateLimited(RESEND_COOLDOWN_MS - (now - invite.lastSentAt), "inviteResend");
    }
    const limited = await rateLimiter.limit(ctx, "invitesPerHour", { key: access.userId });
    if (!limited.ok) throw errors.rateLimited(limited.retryAfter, "invites");
    const { token, tokenHash } = await issueToken();
    const expiresAt = now + INVITE_TTL_MS;
    await ctx.db.patch("invites", invite._id, {
      tokenHash,
      expiresAt,
      lastSentAt: now,
      sendCount: invite.sendCount + 1,
    });
    const inviter = await getProfile(ctx, access.userId);
    await sendInviteEmail(
      ctx,
      { email: invite.email, role: invite.role, expiresAt },
      token,
      access.workspace,
      inviter?.name ?? "A teammate",
    );
    await writeAudit(ctx, {
      action: "invite.resent",
      actorId: access.userId,
      workspaceId: invite.workspaceId,
      targetType: "invite",
      targetId: invite._id,
    });
    return null;
  },
});

export const revoke = mutation({
  args: { inviteId: v.id("invites") },
  handler: async (ctx, args) => {
    const { invite, access } = await loadInviteForAdmin(ctx, args.inviteId);
    if (invite.status !== "pending") return null;
    await ctx.db.patch("invites", invite._id, { status: "revoked", respondedAt: Date.now() });
    await writeAudit(ctx, {
      action: "invite.revoked",
      actorId: access.userId,
      workspaceId: invite.workspaceId,
      targetType: "invite",
      targetId: invite._id,
    });
    return null;
  },
});

/** Public preview for the /accept/[token] page (works signed out). */
export const getByToken = query({
  args: { token: v.string() },
  handler: async (ctx, args) => {
    const invite = await inviteForToken(ctx, args.token);
    if (!invite) return { status: "invalid" as const };
    const workspace = await ctx.db.get("workspaces", invite.workspaceId);
    if (!workspace) return { status: "invalid" as const };
    const inviter = await getProfile(ctx, invite.invitedBy);
    const user = await getUser(ctx);
    return {
      status: effectiveStatus(invite),
      workspaceName: workspace.name,
      inviterName: inviter?.name ?? null,
      role: invite.role,
      email: invite.email,
      expiresAt: invite.expiresAt,
      signedInAs: user?.email ?? null,
      emailMatches: user ? normalizeEmail(user.email) === invite.email : null,
    };
  },
});

async function acceptInvite(ctx: MutationCtx, invite: Doc<"invites">) {
  const user = await requireUser(ctx, { verified: true });
  const status = effectiveStatus(invite);
  if (status === "expired") throw errors.expired("This invite has expired. Ask for a new one.");
  if (status !== "pending") throw errors.conflict("This invite is no longer valid.");
  if (normalizeEmail(user.email) !== invite.email) {
    throw errors.forbidden(
      `This invite was sent to ${invite.email}. Sign in with that address to accept it.`,
    );
  }
  const workspace = await ctx.db.get("workspaces", invite.workspaceId);
  if (!workspace) throw errors.notFound("Workspace");
  const now = Date.now();
  const existing = await getMembership(ctx, invite.workspaceId, user.userId);
  if (existing) {
    if (roleRank(invite.role) > roleRank(existing.role)) {
      await ctx.db.patch("memberships", existing._id, { role: invite.role, updatedAt: now });
    }
  } else {
    await ctx.db.insert("memberships", {
      workspaceId: invite.workspaceId,
      userId: user.userId,
      role: invite.role,
      invitedBy: invite.invitedBy,
      createdAt: now,
      updatedAt: now,
    });
  }
  await ctx.db.patch("invites", invite._id, {
    status: "accepted",
    acceptedBy: user.userId,
    respondedAt: now,
  });
  await writeAudit(ctx, {
    action: "invite.accepted",
    actorId: user.userId,
    workspaceId: invite.workspaceId,
    targetType: "invite",
    targetId: invite._id,
    data: { role: invite.role },
  });
  return { workspaceId: invite.workspaceId };
}

export const accept = mutation({
  args: { token: v.string() },
  handler: async (ctx, args) => {
    const invite = await inviteForToken(ctx, args.token);
    if (!invite) throw errors.notFound("Invite");
    return await acceptInvite(ctx, invite);
  },
});

/** Accept a pending invite addressed to the signed-in user's email (from the dashboard list). */
export const acceptById = mutation({
  args: { inviteId: v.id("invites") },
  handler: async (ctx, args) => {
    const invite = await ctx.db.get("invites", args.inviteId);
    if (!invite) throw errors.notFound("Invite");
    return await acceptInvite(ctx, invite);
  },
});

export const decline = mutation({
  args: { inviteId: v.optional(v.id("invites")), token: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const invite = args.inviteId
      ? await ctx.db.get("invites", args.inviteId)
      : args.token
        ? await inviteForToken(ctx, args.token)
        : null;
    if (!invite) throw errors.notFound("Invite");
    if (normalizeEmail(user.email) !== invite.email) throw errors.notFound("Invite");
    if (invite.status !== "pending") return null;
    await ctx.db.patch("invites", invite._id, { status: "declined", respondedAt: Date.now() });
    await writeAudit(ctx, {
      action: "invite.declined",
      actorId: user.userId,
      workspaceId: invite.workspaceId,
      targetType: "invite",
      targetId: invite._id,
    });
    return null;
  },
});

/** Pending, unexpired invites addressed to the signed-in user's email. */
export const mine = query({
  args: {},
  handler: async (ctx) => {
    const user = await requireUser(ctx);
    const email = normalizeEmail(user.email);
    const rows = await ctx.db
      .query("invites")
      .withIndex("by_email_status", (q) => q.eq("email", email).eq("status", "pending"))
      .collect();
    const now = Date.now();
    const out = [];
    for (const invite of rows) {
      if (invite.expiresAt <= now) continue;
      const workspace = await ctx.db.get("workspaces", invite.workspaceId);
      if (!workspace) continue;
      const inviter = await getProfile(ctx, invite.invitedBy);
      out.push({
        id: invite._id,
        workspaceId: invite.workspaceId,
        workspaceName: workspace.name,
        inviterName: inviter?.name ?? null,
        role: invite.role,
        expiresAt: invite.expiresAt,
      });
    }
    return out;
  },
});
