import { v } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import { internalMutation, mutation, query } from "../_generated/server";
import { generateApiKey, hashApiKey, looksLikeApiKey } from "../lib/apiKeys";
import { writeAudit } from "../lib/audit";
import { assertFeature } from "../lib/entitlements";
import { errors } from "../lib/errors";
import { getMembership, getProfile, requireMember, requireUser } from "../lib/guards";
import { rateLimiter } from "../lib/rateLimits";
import { roleAtLeast } from "../lib/roles";
import { ALL_API_KEY_SCOPES, apiKeyScopeValidator } from "../lib/validators";

const MAX_KEYS_PER_USER = 25;
const LAST_USED_WRITE_INTERVAL_MS = 60 * 1000;

function view(key: Doc<"apiKeys">) {
  return {
    id: key._id,
    name: key.name,
    prefix: key.prefix,
    workspaceId: key.workspaceId,
    scopes: key.scopes,
    expiresAt: key.expiresAt ?? null,
    lastUsedAt: key.lastUsedAt ?? null,
    revokedAt: key.revokedAt ?? null,
    createdAt: key.createdAt,
  };
}

/** The signed-in user's API keys (secrets are never returned). */
export const list = query({
  args: { workspaceId: v.optional(v.id("workspaces")) },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const keys = await ctx.db
      .query("apiKeys")
      .withIndex("by_user", (q) => q.eq("userId", user.userId))
      .collect();
    return keys
      .filter((k) => !args.workspaceId || k.workspaceId === args.workspaceId)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(view);
  },
});

/** Create a key for the Agent API / MCP. The secret is returned exactly once. */
export const create = mutation({
  args: {
    workspaceId: v.id("workspaces"),
    name: v.string(),
    scopes: v.array(apiKeyScopeValidator),
    expiresInDays: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx, { verified: true });
    await requireMember(ctx, args.workspaceId, "editor");
    await assertFeature(ctx, user, "agentApi");
    const name = args.name.trim();
    if (name.length < 1 || name.length > 60)
      throw errors.invalid("Name must be 1-60 characters.", "name");
    const scopes = [...new Set(args.scopes)];
    if (scopes.length === 0) throw errors.invalid("Choose at least one scope.", "scopes");
    if (scopes.includes("mcp")) await assertFeature(ctx, user, "mcp");
    if (
      args.expiresInDays !== undefined &&
      (!Number.isInteger(args.expiresInDays) || args.expiresInDays < 1 || args.expiresInDays > 730)
    ) {
      throw errors.invalid("Expiry must be 1-730 days.", "expiresInDays");
    }
    const active = (
      await ctx.db
        .query("apiKeys")
        .withIndex("by_user", (q) => q.eq("userId", user.userId))
        .collect()
    ).filter((k) => !k.revokedAt);
    if (active.length >= MAX_KEYS_PER_USER) {
      throw errors.limit("apiKeys", MAX_KEYS_PER_USER, active.length);
    }
    const limited = await rateLimiter.limit(ctx, "apiKeyCreate", { key: user.userId });
    if (!limited.ok) throw errors.rateLimited(limited.retryAfter, "apiKeyCreate");
    const { secret, prefix } = generateApiKey();
    const now = Date.now();
    const id = await ctx.db.insert("apiKeys", {
      userId: user.userId,
      workspaceId: args.workspaceId,
      name,
      prefix,
      hash: await hashApiKey(secret),
      scopes,
      ...(args.expiresInDays ? { expiresAt: now + args.expiresInDays * 86_400_000 } : {}),
      createdAt: now,
    });
    await writeAudit(ctx, {
      action: "apiKey.created",
      actorId: user.userId,
      workspaceId: args.workspaceId,
      targetType: "apiKey",
      targetId: id,
      data: { name, scopes },
    });
    return { id, secret, prefix };
  },
});

export const revoke = mutation({
  args: { keyId: v.id("apiKeys") },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const key = await ctx.db.get("apiKeys", args.keyId);
    if (!key || key.userId !== user.userId) throw errors.notFound("API key");
    if (key.revokedAt) return null;
    await ctx.db.patch("apiKeys", key._id, { revokedAt: Date.now() });
    await writeAudit(ctx, {
      action: "apiKey.revoked",
      actorId: user.userId,
      workspaceId: key.workspaceId,
      targetType: "apiKey",
      targetId: key._id,
    });
    return null;
  },
});

export const availableScopes = query({
  args: {},
  handler: async () => ALL_API_KEY_SCOPES,
});

/**
 * Verify an API key for the Agent API / MCP (internal; call from HTTP actions with runMutation).
 * Returns null for unknown, revoked or expired keys, disabled users and users who lost access to
 * the key's workspace. Write scopes require the editor role at verification time.
 */
export const verify = internalMutation({
  args: { secret: v.string(), ip: v.optional(v.string()) },
  handler: async (ctx, args) => {
    if (!looksLikeApiKey(args.secret)) return null;
    const hash = await hashApiKey(args.secret);
    const key = await ctx.db
      .query("apiKeys")
      .withIndex("by_hash", (q) => q.eq("hash", hash))
      .unique();
    const now = Date.now();
    if (!key || key.revokedAt || (key.expiresAt !== undefined && key.expiresAt <= now)) return null;
    const profile = await getProfile(ctx, key.userId);
    if (!profile || profile.disabled) return null;
    const membership = await getMembership(ctx, key.workspaceId, key.userId);
    if (!membership) return null;
    const canWrite = roleAtLeast(membership.role, "editor");
    const scopes = canWrite ? key.scopes : key.scopes.filter((s) => s.endsWith(":read"));
    if (!key.lastUsedAt || now - key.lastUsedAt > LAST_USED_WRITE_INTERVAL_MS) {
      await ctx.db.patch("apiKeys", key._id, {
        lastUsedAt: now,
        ...(args.ip ? { lastUsedIp: args.ip.slice(0, 64) } : {}),
      });
    }
    return {
      keyId: key._id,
      userId: key.userId,
      workspaceId: key.workspaceId,
      role: membership.role,
      scopes,
    };
  },
});
