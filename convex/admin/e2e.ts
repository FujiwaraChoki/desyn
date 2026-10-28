import { v } from "convex/values";
import { components } from "../_generated/api";
import { internalMutation } from "../_generated/server";
import { ensureBalance } from "../lib/credits";
import { errors } from "../lib/errors";
import { getProfile } from "../lib/guards";
import { planIdValidator } from "../lib/validators";

// Operator helpers for end-to-end checks against a deployment (`npx convex run admin/e2e:...`). Internal only: no
// client can call these. Scoped to the SES mailbox simulator so a real person's address can never be verified
// without their inbox.

const SIMULATOR = /^success(\+[a-z0-9-]{1,40})?@simulator\.amazonses\.com$/;

/** Marks an SES-simulator test account's email as verified (the verification mail goes to the simulator). */
export const markEmailVerified = internalMutation({
  args: { email: v.string() },
  handler: async (ctx, args) => {
    const email = args.email.trim().toLowerCase();
    if (!SIMULATOR.test(email)) {
      throw errors.invalid(
        "Only success@simulator.amazonses.com test accounts can be verified here.",
        "email",
      );
    }
    await ctx.runMutation(components.betterAuth.adapter.updateOne, {
      input: {
        model: "user",
        where: [{ field: "email", value: email }],
        update: { emailVerified: true, updatedAt: Date.now() },
      },
    });
    return null;
  },
});

/** Puts an SES-simulator test account on a plan (e.g. "pro" to exercise the AI agent), or clears the override. */
export const setTestPlan = internalMutation({
  args: { email: v.string(), plan: v.union(planIdValidator, v.null()) },
  handler: async (ctx, args) => {
    const email = args.email.trim().toLowerCase();
    if (!SIMULATOR.test(email)) {
      throw errors.invalid(
        "Only success@simulator.amazonses.com test accounts can be changed here.",
        "email",
      );
    }
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
    return null;
  },
});
