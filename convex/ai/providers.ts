"use node";

import type { ProviderTestResult } from "@desyn/ai";
import { v } from "convex/values";
import { action } from "../_generated/server";
import { testStoredProvider } from "./settings";

// `ai.providers.test` (SPEC §6 `ai.testProvider`): connectivity check of one provider from the server with the
// user's stored key, else the server key. Same as `ai/settings:testProvider`, which the web app calls.

export const test = action({
  args: { provider: v.string() },
  handler: async (ctx, args): Promise<ProviderTestResult> =>
    await testStoredProvider(ctx, args.provider),
});
