import type { Infer } from "convex/values";
import { v } from "convex/values";

// Shared argument / document validators. Other owners import these so the same shapes are validated everywhere.

export const roleValidator = v.union(
  v.literal("owner"),
  v.literal("admin"),
  v.literal("editor"),
  v.literal("commenter"),
  v.literal("viewer"),
);
export type Role = Infer<typeof roleValidator>;

/** Roles that can be granted through an invite or a role change (ownership moves only via transfer). */
export const assignableRoleValidator = v.union(
  v.literal("admin"),
  v.literal("editor"),
  v.literal("commenter"),
  v.literal("viewer"),
);
export type AssignableRole = Infer<typeof assignableRoleValidator>;

export const planIdValidator = v.union(v.literal("free"), v.literal("pro"), v.literal("selfhost"));
export type PlanIdValue = Infer<typeof planIdValidator>;

export const systemRoleValidator = v.union(v.literal("user"), v.literal("admin"));

export const themeValidator = v.union(v.literal("dark"), v.literal("light"), v.literal("system"));

export const appearanceValidator = v.object({
  theme: v.optional(themeValidator),
  reducedMotion: v.optional(v.boolean()),
  density: v.optional(v.union(v.literal("comfortable"), v.literal("compact"))),
  canvasGrid: v.optional(v.boolean()),
  snapping: v.optional(v.boolean()),
  rulers: v.optional(v.boolean()),
  uiScale: v.optional(v.number()),
});

export const onboardingValidator = v.object({
  completed: v.boolean(),
  step: v.optional(v.string()),
  role: v.optional(v.string()),
  useCases: v.optional(v.array(v.string())),
  teamSize: v.optional(v.string()),
  source: v.optional(v.string()),
  completedAt: v.optional(v.number()),
});

export const taskModelValidator = v.object({ provider: v.string(), model: v.string() });

/** An encrypted BYOK credential. `ciphertext` is opaque (see lib/crypto.ts `encryptSecret`). */
export const byokEntryValidator = v.object({
  ciphertext: v.string(),
  last4: v.optional(v.string()),
  label: v.optional(v.string()),
  baseUrl: v.optional(v.string()),
  updatedAt: v.number(),
});

export const aiSettingsValidator = v.object({
  /** Per-task provider/model choice, keyed by task id (e.g. "agent", "image", "copy"). */
  taskModels: v.optional(v.record(v.string(), taskModelValidator)),
  /** Encrypted provider keys, keyed by provider id. */
  byok: v.optional(v.record(v.string(), byokEntryValidator)),
  /** "server": keys stored encrypted here; "local": keys never leave the browser/device. */
  keyMode: v.optional(v.union(v.literal("server"), v.literal("local"))),
  /** Prefer the user's own keys over hosted credits when a key exists for the provider. */
  preferByok: v.optional(v.boolean()),
  ollamaBaseUrl: v.optional(v.string()),
  /** Forward-compatible bag for AI settings added by the ai-backend owner. */
  prefs: v.optional(v.record(v.string(), v.any())),
});
export type AiSettings = Infer<typeof aiSettingsValidator>;

export const subscriptionStatusValidator = v.union(
  v.literal("incomplete"),
  v.literal("incomplete_expired"),
  v.literal("trialing"),
  v.literal("active"),
  v.literal("past_due"),
  v.literal("canceled"),
  v.literal("unpaid"),
  v.literal("paused"),
);
export type SubscriptionStatus = Infer<typeof subscriptionStatusValidator>;

export const billingIntervalValidator = v.union(v.literal("month"), v.literal("year"));

/** Ledger reasons. Reservations are tracked in `creditReservations`; the ledger records settled changes only. */
export const creditReasonValidator = v.union(
  v.literal("grant"),
  v.literal("commit"),
  v.literal("refund"),
  v.literal("adjust"),
);

export const usageMetricValidator = v.union(
  v.literal("exports"),
  v.literal("aiRequests"),
  v.literal("storageBytes"),
  v.literal("designs"),
  v.literal("brandKits"),
  v.literal("uploads"),
);
export type UsageMetric = Infer<typeof usageMetricValidator>;

export const mailTemplateValidator = v.union(
  v.literal("verifyEmail"),
  v.literal("magicLink"),
  v.literal("resetPassword"),
  v.literal("invite"),
  v.literal("welcome"),
  v.literal("receipt"),
  v.literal("planChanged"),
  v.literal("exportReady"),
  v.literal("paymentFailed"),
  v.literal("commentMention"),
);
export type MailTemplateId = Infer<typeof mailTemplateValidator>;

export const mailStatusValidator = v.union(
  v.literal("queued"),
  v.literal("sending"),
  v.literal("sent"),
  v.literal("failed"),
  v.literal("suppressed"),
);

export const apiKeyScopeValidator = v.union(
  v.literal("designs:read"),
  v.literal("designs:write"),
  v.literal("assets:read"),
  v.literal("assets:write"),
  v.literal("templates:read"),
  v.literal("brand:read"),
  v.literal("brand:write"),
  v.literal("ai:run"),
  v.literal("exports:write"),
  v.literal("mcp"),
);
export type ApiKeyScope = Infer<typeof apiKeyScopeValidator>;
export const ALL_API_KEY_SCOPES: ApiKeyScope[] = [
  "designs:read",
  "designs:write",
  "assets:read",
  "assets:write",
  "templates:read",
  "brand:read",
  "brand:write",
  "ai:run",
  "exports:write",
  "mcp",
];

export const nativeClientValidator = v.union(
  v.literal("desktop"),
  v.literal("ios"),
  v.literal("cli"),
);
