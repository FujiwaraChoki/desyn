import { v } from "convex/values";
import { components } from "../_generated/api";
import { internalMutation } from "../_generated/server";
import { writeAudit } from "../lib/audit";
import { ensureBalance } from "../lib/credits";
import { errors } from "../lib/errors";
import { getProfile } from "../lib/guards";
import { planIdValidator } from "../lib/validators";

// Operator actions for the deployment owner, run from the CLI with deploy access:
//   npx convex run admin/operator:setPlanByEmail '{"email":"you@example.com","plan":"pro"}' --prod
// Internal only (no client can call them); every change is written to the audit log.

/** Overrides a user's plan by email (null returns them to the billing-derived plan). */
export const setPlanByEmail = internalMutation({
  args: { email: v.string(), plan: v.union(planIdValidator, v.null()) },
  handler: async (ctx, args) => {
    const email = args.email.trim().toLowerCase();
    const user = (await ctx.runQuery(components.betterAuth.adapter.findOne, {
      model: "user",
      where: [{ field: "email", value: email }],
    })) as { _id: string } | null;
    if (!user) throw errors.notFound("User");
    const profile = await getProfile(ctx, user._id);
    if (!profile) throw errors.notFound("Profile");
    await ctx.db.patch("profiles", profile._id, {
      planOverride: args.plan ?? undefined,
      updatedAt: Date.now(),
    });
    await ensureBalance(ctx, user._id);
    await writeAudit(ctx, {
      action: "admin.planOverride",
      actorId: "operator",
      targetType: "user",
      targetId: user._id,
      data: { from: profile.planOverride ?? null, to: args.plan, via: "cli" },
    });
    return { userId: user._id, plan: args.plan };
  },
});
