import { defineTable } from "convex/server";
import { v } from "convex/values";
import { mailStatusValidator, mailTemplateValidator } from "../lib/validators";

export const miscTables = {
  /** Security-relevant events. Retained for 365 days (see crons.ts). */
  audit: defineTable({
    action: v.string(),
    actorId: v.optional(v.string()),
    workspaceId: v.optional(v.id("workspaces")),
    targetType: v.optional(v.string()),
    targetId: v.optional(v.string()),
    data: v.optional(v.any()),
    createdAt: v.number(),
  })
    .index("by_actor_createdAt", ["actorId", "createdAt"])
    .index("by_workspace_createdAt", ["workspaceId", "createdAt"])
    .index("by_createdAt", ["createdAt"]),

  /** Runtime overrides for features / switches. See lib/flags.ts for resolution rules. */
  featureFlags: defineTable({
    key: v.string(),
    enabled: v.boolean(),
    /** When set, the flag only applies to these plans. */
    plans: v.optional(v.array(v.string())),
    /** When set, the flag only applies to these user ids (takes precedence over `plans`). */
    userIds: v.optional(v.array(v.string())),
    /** Optional rollout percentage 0..100 (deterministic per user). */
    rollout: v.optional(v.number()),
    value: v.optional(v.any()),
    description: v.optional(v.string()),
    updatedBy: v.optional(v.string()),
    updatedAt: v.number(),
  }).index("by_key", ["key"]),

  /** Sent mail metadata (no bodies, no links). Retained for 90 days. */
  mailLog: defineTable({
    to: v.string(),
    template: mailTemplateValidator,
    subject: v.string(),
    userId: v.optional(v.string()),
    status: mailStatusValidator,
    transport: v.optional(v.string()),
    providerMessageId: v.optional(v.string()),
    attempts: v.number(),
    /** When the latest delivery attempt started (used to recover sends whose action died). */
    lastAttemptAt: v.optional(v.number()),
    error: v.optional(v.string()),
    idempotencyKey: v.optional(v.string()),
    createdAt: v.number(),
    sentAt: v.optional(v.number()),
  })
    .index("by_to_createdAt", ["to", "createdAt"])
    .index("by_createdAt", ["createdAt"])
    .index("by_idempotencyKey", ["idempotencyKey"])
    .index("by_status", ["status"]),

  /** Rendered message bodies waiting for delivery. Deleted as soon as the message is sent or abandoned. */
  mailOutbox: defineTable({
    mailLogId: v.id("mailLog"),
    html: v.string(),
    text: v.string(),
    createdAt: v.number(),
  }).index("by_mailLogId", ["mailLogId"]),

  /** Structured log lines written from mutations, shipped to Axiom in batches by a cron. */
  logQueue: defineTable({
    line: v.string(),
    createdAt: v.number(),
  }).index("by_createdAt", ["createdAt"]),

  /** Small named counters for the admin console (e.g. "users"). */
  systemCounters: defineTable({
    key: v.string(),
    value: v.number(),
    updatedAt: v.number(),
  }).index("by_key", ["key"]),
};
