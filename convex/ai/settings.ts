"use node";

import {
  envProviderConfigs,
  getProviderDefinition,
  isProviderId,
  type ProviderConfig,
  type ProviderId,
  type ProviderTestResult,
  testProvider as probeProvider,
  validateProviderConfig,
} from "@desyn/ai";
import { v } from "convex/values";
import { internal } from "../_generated/api";
import { type ActionCtx, action } from "../_generated/server";
import { assertPublicHost, BlockedDestinationError, guardedFetch } from "../lib/ai_net";
import { byokAad } from "../lib/ai_providers";
import { clip } from "../lib/ai_runs";
import { decryptSecret, encryptSecret, secretHint } from "../lib/crypto";
import { isHosted } from "../lib/env";
import { appError, errors } from "../lib/errors";
import { createLogger } from "../lib/logger";

// BYOK key management and provider connectivity tests from the server (web app: Settings › AI providers).
// Keys are validated against the provider, encrypted with AI_KEY_ENCRYPTION_SECRET (AES-256-GCM, bound to
// the user and provider) and stored on the profile; they are only ever decrypted inside actions.

const MAX_KEY_LENGTH = 1_000;
const TEST_TIMEOUT_MS = 15_000;

async function currentUser(ctx: ActionCtx) {
  const access = await ctx.runQuery(internal.ai.catalog.accessFor, {});
  if (!access) throw errors.unauthenticated();
  return access;
}

/** User-supplied base URLs: https and a public host on the hosted edition. */
async function checkBaseUrl(raw: string | undefined): Promise<string | undefined> {
  if (!raw) return undefined;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw errors.invalid("Enter a valid URL.", "baseUrl");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:")
    throw errors.invalid("Use an http(s) URL.", "baseUrl");
  if (url.username || url.password)
    throw errors.invalid("Do not put credentials in the URL.", "baseUrl");
  if (isHosted()) {
    if (url.protocol !== "https:") throw errors.invalid("Use an https URL.", "baseUrl");
    try {
      await assertPublicHost(url.hostname);
    } catch (err) {
      if (err instanceof BlockedDestinationError)
        throw errors.invalid(
          "This address is not reachable from Desyn's servers. Use a public URL, or keep the key in your browser (local keys).",
          "baseUrl",
        );
      throw errors.invalid("The host could not be resolved.", "baseUrl");
    }
  }
  return url.toString().replace(/\/+$/, "");
}

async function runProbe(provider: ProviderId, config: ProviderConfig): Promise<ProviderTestResult> {
  const signal = AbortSignal.timeout(TEST_TIMEOUT_MS);
  const fetchImpl = guardedFetch({ enabled: isHosted() });
  try {
    return await probeProvider(provider, config, {
      fetch: (input, init) => fetchImpl(input, init),
      signal,
    });
  } catch (err) {
    return {
      ok: false,
      latencyMs: 0,
      message:
        err instanceof BlockedDestinationError
          ? "This address is not reachable from Desyn's servers."
          : clip(err instanceof Error ? err.message : String(err), 300),
    };
  }
}

/** Validates a key with the provider, encrypts it and stores it on the profile. */
export const saveByokKey = action({
  args: {
    provider: v.string(),
    apiKey: v.string(),
    baseUrl: v.optional(v.string()),
    label: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ provider: string; last4: string | null }> => {
    const user = await currentUser(ctx);
    if (!user.byokAllowed) throw errors.feature("ai.byok");
    if (!isProviderId(args.provider) || !getProviderDefinition(args.provider).byok)
      throw errors.invalid("This provider does not take your own key.", "provider");
    const apiKey = args.apiKey.trim();
    if (!apiKey || apiKey.length > MAX_KEY_LENGTH)
      throw errors.invalid("Enter the API key.", "apiKey");
    const baseUrl = await checkBaseUrl(args.baseUrl);
    const config: ProviderConfig = { apiKey, ...(baseUrl ? { baseURL: baseUrl } : {}) };
    const validation = validateProviderConfig(args.provider, config);
    if (!validation.ok) {
      const first = validation.errors[0];
      throw appError("INVALID_ARGUMENT", first?.message ?? "The key is not valid.", {
        field: first?.field === "baseURL" ? "baseUrl" : "apiKey",
      });
    }
    const probe = await runProbe(args.provider, config);
    if (!probe.ok) {
      throw appError(
        "INVALID_ARGUMENT",
        `The provider rejected this key: ${clip(probe.message, 200)}`,
        {
          field: "apiKey",
        },
      );
    }
    const ciphertext = await encryptSecret(apiKey, { aad: byokAad(user.userId, args.provider) });
    const last4 = secretHint(apiKey);
    await ctx.runMutation(internal.accounts.profiles.setByokKey, {
      userId: user.userId,
      provider: args.provider,
      ciphertext,
      ...(last4 ? { last4 } : {}),
      ...(args.label ? { label: clip(args.label.trim(), 60) } : {}),
      ...(baseUrl ? { baseUrl } : {}),
    });
    const log = createLogger(ctx, { fn: "ai.saveByokKey", userId: user.userId });
    log.info("byok key saved", { provider: args.provider, latencyMs: probe.latencyMs });
    await log.flush();
    return { provider: args.provider, last4: last4 || null };
  },
});

/** Tests a provider from the server with the user's stored key, else the server key. Generates nothing. */
export async function testStoredProvider(
  ctx: ActionCtx,
  provider: string,
): Promise<ProviderTestResult> {
  const user = await currentUser(ctx);
  if (!isProviderId(provider)) throw errors.invalid("Unknown provider.", "provider");
  const def = getProviderDefinition(provider);
  const settings = await ctx.runQuery(internal.accounts.profiles.getAiSettings, {
    userId: user.userId,
  });
  const stored =
    user.byokAllowed && settings?.keyMode !== "local" ? settings?.byok?.[provider] : undefined;
  let config: ProviderConfig | undefined;
  let source = "server";
  if (stored) {
    try {
      const apiKey = await decryptSecret(stored.ciphertext, {
        aad: byokAad(user.userId, provider),
      });
      config = { apiKey, ...(stored.baseUrl ? { baseURL: stored.baseUrl } : {}) };
      source = "your key";
    } catch {
      return {
        ok: false,
        latencyMs: 0,
        message: "Your saved key could not be read. Enter it again.",
      };
    }
  } else if (provider === "ollama" && !isHosted() && settings?.ollamaBaseUrl) {
    config = { baseURL: settings.ollamaBaseUrl };
    source = "your server";
  } else {
    config = envProviderConfigs()[provider];
  }
  if (!config) {
    return {
      ok: false,
      latencyMs: 0,
      message: `${def.label} is not configured. Add your key${def.env ? " or ask the administrator to set it up" : ""}.`,
    };
  }
  const result = await runProbe(provider, config);
  return { ...result, message: `${result.message} (${source})` };
}

export const testProvider = action({
  args: { provider: v.string() },
  handler: async (ctx, args): Promise<ProviderTestResult> =>
    await testStoredProvider(ctx, args.provider),
});
