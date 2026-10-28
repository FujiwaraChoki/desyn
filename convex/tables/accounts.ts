import { defineTable } from "convex/server";
import { v } from "convex/values";
import {
  aiSettingsValidator,
  apiKeyScopeValidator,
  appearanceValidator,
  nativeClientValidator,
  onboardingValidator,
  planIdValidator,
  roleValidator,
  systemRoleValidator,
} from "../lib/validators";

// `userId` everywhere is the Better Auth user id (the component's `user._id`, equal to `identity.subject`).
export const accountsTables = {
  profiles: defineTable({
    userId: v.string(),
    email: v.string(),
    name: v.string(),
    image: v.optional(v.string()),
    /** Plan derived from billing (Stripe). Never written from client input. */
    plan: planIdValidator,
    /** Admin override that wins over `plan` (self-host console / support). */
    planOverride: v.optional(planIdValidator),
    role: systemRoleValidator,
    stripeCustomerId: v.optional(v.string()),
    locale: v.optional(v.string()),
    timezone: v.optional(v.string()),
    onboarding: onboardingValidator,
    appearance: v.optional(appearanceValidator),
    aiSettings: v.optional(aiSettingsValidator),
    flags: v.optional(v.record(v.string(), v.boolean())),
    defaultWorkspaceId: v.optional(v.id("workspaces")),
    marketingOptIn: v.optional(v.boolean()),
    welcomedAt: v.optional(v.number()),
    disabled: v.optional(v.boolean()),
    lastSeenAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_userId", ["userId"])
    .index("by_email", ["email"])
    .index("by_stripeCustomerId", ["stripeCustomerId"])
    .index("by_role", ["role"])
    .index("by_createdAt", ["createdAt"]),

  workspaces: defineTable({
    name: v.string(),
    kind: v.union(v.literal("personal"), v.literal("team")),
    ownerId: v.string(),
    icon: v.optional(v.string()),
    color: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_owner", ["ownerId"]),

  memberships: defineTable({
    workspaceId: v.id("workspaces"),
    userId: v.string(),
    role: roleValidator,
    invitedBy: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_user", ["userId"])
    .index("by_workspace", ["workspaceId"])
    .index("by_workspace_user", ["workspaceId", "userId"]),

  invites: defineTable({
    workspaceId: v.id("workspaces"),
    email: v.string(),
    role: roleValidator,
    tokenHash: v.string(),
    invitedBy: v.string(),
    status: v.union(
      v.literal("pending"),
      v.literal("accepted"),
      v.literal("revoked"),
      v.literal("declined"),
    ),
    expiresAt: v.number(),
    acceptedBy: v.optional(v.string()),
    respondedAt: v.optional(v.number()),
    lastSentAt: v.number(),
    sendCount: v.number(),
    createdAt: v.number(),
  })
    .index("by_tokenHash", ["tokenHash"])
    .index("by_workspace_status", ["workspaceId", "status"])
    .index("by_email_status", ["email", "status"])
    .index("by_inviter", ["invitedBy"]),

  folders: defineTable({
    workspaceId: v.id("workspaces"),
    parentId: v.optional(v.id("folders")),
    name: v.string(),
    color: v.optional(v.string()),
    sort: v.optional(v.number()),
    createdBy: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_workspace", ["workspaceId"])
    .index("by_workspace_parent", ["workspaceId", "parentId"]),

  apiKeys: defineTable({
    userId: v.string(),
    workspaceId: v.id("workspaces"),
    name: v.string(),
    /** First characters of the secret, shown in the UI to identify the key (e.g. "dsk_live_ab12"). */
    prefix: v.string(),
    /** sha256 hex of the full secret. The secret itself is never stored. */
    hash: v.string(),
    scopes: v.array(apiKeyScopeValidator),
    expiresAt: v.optional(v.number()),
    lastUsedAt: v.optional(v.number()),
    lastUsedIp: v.optional(v.string()),
    revokedAt: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_hash", ["hash"])
    .index("by_user", ["userId"])
    .index("by_workspace", ["workspaceId"]),

  /** One-time PKCE codes for the native (desktop / iOS / CLI) sign-in exchange. */
  nativeAuthCodes: defineTable({
    codeHash: v.string(),
    userId: v.string(),
    client: nativeClientValidator,
    redirectUri: v.string(),
    codeChallenge: v.string(),
    expiresAt: v.number(),
    usedAt: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_codeHash", ["codeHash"])
    .index("by_user", ["userId"])
    .index("by_expiresAt", ["expiresAt"]),
};
