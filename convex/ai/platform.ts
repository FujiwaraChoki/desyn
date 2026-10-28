import { envProviderConfigs, getProviderDefinition, isProviderId } from "@desyn/ai";
import { query } from "../_generated/server";
import { requireUser } from "../lib/guards";

/**
 * Providers the platform pays for (a server key is set), so settings can offer them as choices. Names and
 * kinds only; keys never leave the server.
 */
export const providers = query({
  args: {},
  handler: async (ctx) => {
    await requireUser(ctx);
    return Object.keys(envProviderConfigs())
      .filter(isProviderId)
      .map((id) => ({
        id,
        label: getProviderDefinition(id).label,
        kinds: [...getProviderDefinition(id).kinds],
      }));
  },
});
