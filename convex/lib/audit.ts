import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { redact } from "./logger";

/** Security-relevant event names. Other owners may log their own `<owner>.<event>` actions. */
export type AuditAction =
  | "user.created"
  | "user.deleted"
  | "user.emailChanged"
  | "user.emailVerified"
  | "profile.updated"
  | "workspace.created"
  | "workspace.updated"
  | "workspace.deleted"
  | "workspace.ownershipTransferred"
  | "member.roleChanged"
  | "member.removed"
  | "member.left"
  | "invite.created"
  | "invite.resent"
  | "invite.revoked"
  | "invite.accepted"
  | "invite.declined"
  | "apiKey.created"
  | "apiKey.revoked"
  | "session.revoked"
  | "native.codeIssued"
  | "native.sessionCreated"
  | "billing.checkoutStarted"
  | "billing.planChanged"
  | "admin.planOverride"
  | "admin.roleChanged"
  | "admin.userDisabled"
  | "admin.creditsAdjusted"
  | "admin.flagChanged"
  | (string & {});

export async function writeAudit(
  ctx: MutationCtx,
  event: {
    action: AuditAction;
    actorId?: string;
    workspaceId?: Id<"workspaces">;
    targetType?: string;
    targetId?: string;
    data?: Record<string, unknown>;
  },
): Promise<void> {
  await ctx.db.insert("audit", {
    action: event.action,
    ...(event.actorId ? { actorId: event.actorId } : {}),
    ...(event.workspaceId ? { workspaceId: event.workspaceId } : {}),
    ...(event.targetType ? { targetType: event.targetType } : {}),
    ...(event.targetId ? { targetId: event.targetId } : {}),
    ...(event.data ? { data: redact(event.data) } : {}),
    createdAt: Date.now(),
  });
}
