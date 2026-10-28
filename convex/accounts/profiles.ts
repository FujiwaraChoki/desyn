import { v } from "convex/values";
import { components } from "../_generated/api";
import type { Doc } from "../_generated/dataModel";
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
  mutation,
  type QueryCtx,
  query,
} from "../_generated/server";
import { writeAudit } from "../lib/audit";
import { planForProfile } from "../lib/entitlements";
import { edition } from "../lib/env";
import { errors } from "../lib/errors";
import { resolveFlag } from "../lib/flags";
import { getProfile, getUser, isAdminProfile, requireUser } from "../lib/guards";
import { FEATURE_KEYS, type FeatureKey, PLANS, type PlanFeatures } from "../lib/plans";
import {
  type AiSettings,
  aiSettingsValidator,
  appearanceValidator,
  taskModelValidator,
} from "../lib/validators";
import { provisionUser } from "./lifecycle";

/** AI settings without ciphertexts: clients only learn which providers have a key. */
function publicAiSettings(settings: AiSettings | undefined) {
  if (!settings) return null;
  const { byok, ...rest } = settings;
  return {
    ...rest,
    byok: Object.fromEntries(
      Object.entries(byok ?? {}).map(([provider, entry]) => [
        provider,
        {
          configured: true,
          last4: entry.last4 ?? null,
          label: entry.label ?? null,
          baseUrl: entry.baseUrl ?? null,
          updatedAt: entry.updatedAt,
        },
      ]),
    ),
  };
}

async function resolvedFeatures(ctx: QueryCtx, userId: string, plan: keyof typeof PLANS) {
  const base = PLANS[plan].features;
  const flags = await ctx.db
    .query("featureFlags")
    .withIndex("by_key", (q) => q.gte("key", "feature.").lt("key", "feature/"))
    .collect();
  const out = { ...base } as PlanFeatures;
  for (const flag of flags) {
    const key = flag.key.slice("feature.".length) as FeatureKey;
    if (!FEATURE_KEYS.includes(key)) continue;
    const resolved = resolveFlag(flag, { userId, plan });
    if (resolved !== undefined) out[key] = resolved;
  }
  return out;
}

function toMe(
  user: {
    userId: string;
    email: string;
    name: string;
    image: string | null;
    emailVerified: boolean;
  },
  profile: Doc<"profiles"> | null,
  features: PlanFeatures,
) {
  const plan = planForProfile(profile);
  return {
    userId: user.userId,
    email: user.email,
    name: user.name,
    image: user.image ?? profile?.image ?? null,
    emailVerified: user.emailVerified,
    edition: edition(),
    plan,
    planName: PLANS[plan].name,
    limits: PLANS[plan].limits,
    features,
    role: profile?.role ?? "user",
    isAdmin: isAdminProfile(profile ? { role: profile.role, email: user.email } : null, {
      emailVerified: user.emailVerified,
    }),
    locale: profile?.locale ?? null,
    timezone: profile?.timezone ?? null,
    onboarding: profile?.onboarding ?? { completed: false, step: "welcome" },
    appearance: profile?.appearance ?? { theme: "system" as const },
    aiSettings: publicAiSettings(profile?.aiSettings),
    flags: profile?.flags ?? {},
    defaultWorkspaceId: profile?.defaultWorkspaceId ?? null,
    marketingOptIn: profile?.marketingOptIn ?? false,
    hasStripeCustomer: Boolean(profile?.stripeCustomerId),
    provisioned: Boolean(profile?.defaultWorkspaceId),
    createdAt: profile?.createdAt ?? null,
  };
}

/** The signed-in user's profile, plan, resolved features and preferences; null when signed out. */
export const me = query({
  args: {},
  handler: async (ctx) => {
    const user = await getUser(ctx);
    if (!user) return null;
    const plan = planForProfile(user.profile);
    return toMe(user, user.profile, await resolvedFeatures(ctx, user.userId, plan));
  },
});

/**
 * Make sure the profile + personal workspace exist (normally created by the sign-up trigger).
 * Clients call this once after sign-in when `me.provisioned` is false.
 */
export const ensure = mutation({
  args: {},
  handler: async (ctx) => {
    const user = await requireUser(ctx);
    const result = await provisionUser(ctx, {
      _id: user.userId,
      name: user.name,
      email: user.email,
      emailVerified: user.emailVerified,
      image: user.image,
    });
    return { workspaceId: result.workspaceId, created: result.created };
  },
});

const LOCALE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

export const update = mutation({
  args: {
    name: v.optional(v.string()),
    locale: v.optional(v.union(v.string(), v.null())),
    timezone: v.optional(v.union(v.string(), v.null())),
    appearance: v.optional(appearanceValidator),
    marketingOptIn: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const profile = user.profile ?? (await getProfileOrProvision(ctx, user));
    const patch: Partial<Doc<"profiles">> = { updatedAt: Date.now() };
    if (args.name !== undefined) {
      const name = args.name.trim();
      if (name.length < 1 || name.length > 80)
        throw errors.invalid("Name must be 1-80 characters.", "name");
      patch.name = name;
      await ctx.runMutation(components.betterAuth.adapter.updateOne, {
        input: {
          model: "user",
          where: [{ field: "_id", value: user.userId }],
          update: { name, updatedAt: Date.now() },
        },
      });
    }
    if (args.locale !== undefined) {
      if (args.locale !== null && !LOCALE.test(args.locale))
        throw errors.invalid("Invalid locale.", "locale");
      patch.locale = args.locale ?? undefined;
    }
    if (args.timezone !== undefined) {
      if (
        args.timezone !== null &&
        (args.timezone.length > 64 || !/^[A-Za-z_+\-/0-9]+$/.test(args.timezone))
      ) {
        throw errors.invalid("Invalid timezone.", "timezone");
      }
      patch.timezone = args.timezone ?? undefined;
    }
    if (args.appearance) {
      if (
        args.appearance.uiScale !== undefined &&
        (args.appearance.uiScale < 0.75 || args.appearance.uiScale > 1.5)
      ) {
        throw errors.invalid("UI scale must be between 0.75 and 1.5.", "uiScale");
      }
      patch.appearance = { ...(profile.appearance ?? {}), ...args.appearance };
    }
    if (args.marketingOptIn !== undefined) patch.marketingOptIn = args.marketingOptIn;
    await ctx.db.patch("profiles", profile._id, patch);
    if (args.name !== undefined) {
      await writeAudit(ctx, {
        action: "profile.updated",
        actorId: user.userId,
        data: { fields: ["name"] },
      });
    }
    return null;
  },
});

async function getProfileOrProvision(
  ctx: MutationCtx,
  user: {
    userId: string;
    name: string;
    email: string;
    emailVerified: boolean;
    image: string | null;
  },
): Promise<Doc<"profiles">> {
  await provisionUser(ctx, {
    _id: user.userId,
    name: user.name,
    email: user.email,
    emailVerified: user.emailVerified,
    image: user.image,
  });
  const profile = await getProfile(ctx, user.userId);
  if (!profile) throw new Error("profile provisioning failed");
  return profile;
}

export const setOnboarding = mutation({
  args: {
    step: v.optional(v.string()),
    completed: v.optional(v.boolean()),
    role: v.optional(v.string()),
    useCases: v.optional(v.array(v.string())),
    teamSize: v.optional(v.string()),
    source: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const profile = user.profile ?? (await getProfileOrProvision(ctx, user));
    for (const [key, value] of Object.entries(args)) {
      if (typeof value === "string" && value.length > 120)
        throw errors.invalid(`${key} is too long.`, key);
    }
    if (args.useCases && args.useCases.length > 20)
      throw errors.invalid("Too many use cases.", "useCases");
    const current = profile.onboarding;
    const completed = args.completed ?? current.completed;
    await ctx.db.patch("profiles", profile._id, {
      onboarding: {
        ...current,
        ...(args.step !== undefined ? { step: args.step } : {}),
        ...(args.role !== undefined ? { role: args.role } : {}),
        ...(args.useCases !== undefined ? { useCases: args.useCases } : {}),
        ...(args.teamSize !== undefined ? { teamSize: args.teamSize } : {}),
        ...(args.source !== undefined ? { source: args.source } : {}),
        completed,
        ...(completed && !current.completedAt ? { completedAt: Date.now() } : {}),
      },
      updatedAt: Date.now(),
    });
    return null;
  },
});

const MAX_TASK_MODELS = 50;
const MAX_PREFS_BYTES = 16 * 1024;

/** Keep client-written AI preferences small: they live on the profile document (1 MiB cap). */
function validateAiPreferenceSizes(args: {
  taskModels?: Record<string, { provider: string; model: string }>;
  ollamaBaseUrl?: string | null;
}): void {
  if (args.taskModels) {
    const entries = Object.entries(args.taskModels);
    if (entries.length > MAX_TASK_MODELS)
      throw errors.invalid("Too many task model entries.", "taskModels");
    for (const [task, choice] of entries) {
      if (task.length > 64 || choice.provider.length > 64 || choice.model.length > 200) {
        throw errors.invalid("Task model entries are too long.", "taskModels");
      }
    }
  }
  if (args.ollamaBaseUrl && args.ollamaBaseUrl.length > 500)
    throw errors.invalid("URL is too long.", "ollamaBaseUrl");
}

/** Non-secret AI preferences (task models, key mode). Keys themselves go through setByokKey. */
export const updateAiPreferences = mutation({
  args: {
    taskModels: v.optional(v.record(v.string(), taskModelValidator)),
    keyMode: v.optional(v.union(v.literal("server"), v.literal("local"))),
    preferByok: v.optional(v.boolean()),
    ollamaBaseUrl: v.optional(v.union(v.string(), v.null())),
    prefs: v.optional(v.record(v.string(), v.any())),
  },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const profile = user.profile ?? (await getProfileOrProvision(ctx, user));
    validateAiPreferenceSizes(args);
    if (args.ollamaBaseUrl) {
      try {
        const url = new URL(args.ollamaBaseUrl);
        if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("scheme");
      } catch {
        throw errors.invalid("Enter a valid http(s) URL.", "ollamaBaseUrl");
      }
    }
    const current = profile.aiSettings ?? {};
    const next: AiSettings = {
      ...current,
      ...(args.taskModels !== undefined ? { taskModels: args.taskModels } : {}),
      ...(args.keyMode !== undefined ? { keyMode: args.keyMode } : {}),
      ...(args.preferByok !== undefined ? { preferByok: args.preferByok } : {}),
      ...(args.prefs !== undefined ? { prefs: { ...(current.prefs ?? {}), ...args.prefs } } : {}),
    };
    if (args.ollamaBaseUrl !== undefined) {
      if (args.ollamaBaseUrl === null) delete next.ollamaBaseUrl;
      else next.ollamaBaseUrl = args.ollamaBaseUrl;
    }
    if (next.prefs && JSON.stringify(next.prefs).length > MAX_PREFS_BYTES)
      throw errors.invalid("AI preferences are too large.", "prefs");
    // Switching to local key mode removes server-stored keys: they must never outlive the choice.
    if (args.keyMode === "local") delete next.byok;
    await ctx.db.patch("profiles", profile._id, { aiSettings: next, updatedAt: Date.now() });
    return null;
  },
});

export const removeByokKey = mutation({
  args: { provider: v.string() },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const profile = user.profile;
    if (!profile?.aiSettings?.byok?.[args.provider]) return null;
    const byok = { ...profile.aiSettings.byok };
    delete byok[args.provider];
    await ctx.db.patch("profiles", profile._id, {
      aiSettings: { ...profile.aiSettings, byok },
      updatedAt: Date.now(),
    });
    await writeAudit(ctx, {
      action: "profile.updated",
      actorId: user.userId,
      data: { byokRemoved: args.provider },
    });
    return null;
  },
});

// --- internal API for the ai-backend owner ------------------------------------------------------

/**
 * Store an encrypted BYOK key (encrypt with lib/crypto `encryptSecret(key, { aad: `${userId}:${provider}` })`
 * in the calling action, after validating the key with the provider).
 */
export const setByokKey = internalMutation({
  args: {
    userId: v.string(),
    provider: v.string(),
    ciphertext: v.string(),
    last4: v.optional(v.string()),
    label: v.optional(v.string()),
    baseUrl: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const profile = await getProfile(ctx, args.userId);
    if (!profile) throw errors.notFound("Profile");
    if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(args.provider))
      throw errors.invalid("Invalid provider id.", "provider");
    const settings = profile.aiSettings ?? {};
    await ctx.db.patch("profiles", profile._id, {
      aiSettings: {
        ...settings,
        keyMode: "server",
        byok: {
          ...(settings.byok ?? {}),
          [args.provider]: {
            ciphertext: args.ciphertext,
            ...(args.last4 ? { last4: args.last4 } : {}),
            ...(args.label ? { label: args.label } : {}),
            ...(args.baseUrl ? { baseUrl: args.baseUrl } : {}),
            updatedAt: Date.now(),
          },
        },
      },
      updatedAt: Date.now(),
    });
    await writeAudit(ctx, {
      action: "profile.updated",
      actorId: args.userId,
      data: { byokSet: args.provider },
    });
    return null;
  },
});

/** Full AI settings including ciphertexts (internal only; decrypt inside an action). */
export const getAiSettings = internalQuery({
  args: { userId: v.string() },
  handler: async (ctx, args): Promise<AiSettings | null> => {
    const profile = await getProfile(ctx, args.userId);
    return profile?.aiSettings ?? null;
  },
});

/** Replace AI settings wholesale (internal; validated by the schema validator). */
export const setAiSettings = internalMutation({
  args: { userId: v.string(), aiSettings: aiSettingsValidator },
  handler: async (ctx, args) => {
    const profile = await getProfile(ctx, args.userId);
    if (!profile) throw errors.notFound("Profile");
    await ctx.db.patch("profiles", profile._id, {
      aiSettings: args.aiSettings,
      updatedAt: Date.now(),
    });
    return null;
  },
});

export const getByUserId = internalQuery({
  args: { userId: v.string() },
  handler: async (ctx, args) => await getProfile(ctx, args.userId),
});

/** Used by the Better Auth session hook to refuse new sessions for disabled accounts. */
export const isDisabled = internalQuery({
  args: { userId: v.string() },
  handler: async (ctx, args): Promise<boolean> =>
    (await getProfile(ctx, args.userId))?.disabled === true,
});

/** Touch lastSeenAt at most every 10 minutes (called by clients on focus). */
export const heartbeat = mutation({
  args: {},
  handler: async (ctx) => {
    const user = await requireUser(ctx);
    const profile = user.profile;
    if (!profile) return null;
    const now = Date.now();
    if (!profile.lastSeenAt || now - profile.lastSeenAt > 10 * 60 * 1000) {
      await ctx.db.patch("profiles", profile._id, { lastSeenAt: now });
    }
    return null;
  },
});
