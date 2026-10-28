import { query } from "../_generated/server";
import { enabledAuthMethods } from "../auth";
import { appUrl, edition, env, isHosted } from "../lib/env";
import { PLANS } from "../lib/plans";

/** Public, unauthenticated instance configuration for sign-in screens and pricing UI. */
export const get = query({
  args: {},
  handler: async () => {
    return {
      edition: edition(),
      appUrl: appUrl(),
      authMethods: enabledAuthMethods(),
      billingEnabled: isHosted() && env.has("STRIPE_SECRET_KEY"),
      plans: isHosted()
        ? {
            free: { name: PLANS.free.name, priceMonthly: PLANS.free.priceMonthly },
            pro: {
              name: PLANS.pro.name,
              priceMonthly: PLANS.pro.priceMonthly,
              priceYearly: PLANS.pro.priceYearly ?? null,
              creditsPerMonth: PLANS.pro.limits.creditsPerMonth,
            },
          }
        : null,
    };
  },
});
