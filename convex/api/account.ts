import { v } from "convex/values";
import { internalQuery } from "../_generated/server";
import { usageSummaryFor } from "../billing/usage";
import { API_RATE } from "../lib/api_limits";
import { principalValidator } from "../lib/api_principal";
import { getBalance } from "../lib/credits";
import { getPlan } from "../lib/entitlements";
import { edition } from "../lib/env";
import { errors } from "../lib/errors";
import { getProfile, requireMember } from "../lib/guards";
import { PLANS } from "../lib/plans";

// Agent API: who the key acts as, its workspaces, credits and usage.

export const me = internalQuery({
  args: { principal: principalValidator, keyId: v.id("apiKeys"), scopes: v.array(v.string()) },
  handler: async (ctx, args) => {
    const { principal } = args;
    const member = await requireMember(ctx, principal.workspaceId, "viewer", {
      userId: principal.userId,
    });
    const profile = await getProfile(ctx, principal.userId);
    if (!profile) throw errors.notFound("User");
    const plan = await getPlan(ctx, { userId: principal.userId, profile });
    return {
      userId: principal.userId,
      name: profile.name,
      email: profile.email,
      plan,
      planName: PLANS[plan].name,
      edition: edition(),
      workspaceId: principal.workspaceId,
      workspaceName: member.workspace.name,
      role: member.role,
      keyId: args.keyId,
      scopes: args.scopes,
    };
  },
});

export const workspaces = internalQuery({
  args: { principal: principalValidator },
  handler: async (ctx, args) => {
    const memberships = await ctx.db
      .query("memberships")
      .withIndex("by_user", (q) => q.eq("userId", args.principal.userId))
      .collect();
    const items = [];
    for (const m of memberships) {
      const ws = await ctx.db.get("workspaces", m.workspaceId);
      if (!ws) continue;
      items.push({
        id: ws._id,
        name: ws.name,
        kind: ws.kind,
        role: m.role,
        current: ws._id === args.principal.workspaceId,
      });
    }
    items.sort((a, b) => Number(b.current) - Number(a.current) || a.name.localeCompare(b.name));
    return { items };
  },
});

export const credits = internalQuery({
  args: { principal: principalValidator },
  handler: async (ctx, args) => await getBalance(ctx, args.principal.userId),
});

export const usage = internalQuery({
  args: { principal: principalValidator },
  handler: async (ctx, args) => {
    const profile = await getProfile(ctx, args.principal.userId);
    const summary = await usageSummaryFor(ctx, { userId: args.principal.userId, profile });
    return {
      ...summary,
      api: { requestsPerMinute: API_RATE.requestsPerMinute, burst: API_RATE.burst },
    };
  },
});
