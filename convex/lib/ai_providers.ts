import {
  type AiProviders,
  createProviders,
  envProviderConfigs,
  isProviderId,
  PROVIDERS,
  type ProviderConfig,
  type ProviderConfigs,
} from "@desyn/ai";
import { decryptSecret } from "./crypto";
import { isHosted } from "./env";
import type { AiSettings } from "./validators";

/** fetch as @desyn/ai providers call it. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

// Provider access for one server-side AI run: server keys from the environment (platform billing) plus the
// user's BYOK keys, decrypted here inside the action and never returned, logged or persisted in plain text.
// Tests replace `createRunProviders` (vi.mock) to inject AI SDK mock models and a fake fal transport.

export interface RunProviderInput {
  userId: string;
  settings: AiSettings;
  byokAllowed: boolean;
  localAllowed: boolean;
  /** Network access for providers (the SSRF-guarded fetch on hosted). */
  fetch?: FetchLike;
}

/** AAD binding a stored key to its user and provider (matches profiles.setByokKey callers). */
export function byokAad(userId: string, provider: string): string {
  return `${userId}:${provider}`;
}

/**
 * Decrypts the user's stored keys. Keys that fail to decrypt (rotated secret, tampered blob) are skipped:
 * the run then falls back to server keys, and the settings page shows the key as needing re-entry.
 */
export async function decryptUserConfigs(input: RunProviderInput): Promise<{
  configs: ProviderConfigs;
  failed: string[];
}> {
  const configs: ProviderConfigs = {};
  const failed: string[] = [];
  if (!input.byokAllowed || input.settings.keyMode === "local") return { configs, failed };
  const preferByok = input.settings.preferByok !== false;
  const env = envProviderConfigs();
  for (const [provider, entry] of Object.entries(input.settings.byok ?? {})) {
    if (!isProviderId(provider)) continue;
    // With "prefer my keys" off, the server key wins for providers the platform already offers.
    if (!preferByok && env[provider]) continue;
    try {
      const apiKey = await decryptSecret(entry.ciphertext, {
        aad: byokAad(input.userId, provider),
      });
      const config: ProviderConfig = {};
      if (apiKey) config.apiKey = apiKey;
      if (entry.baseUrl) config.baseURL = entry.baseUrl;
      configs[provider] = config;
    } catch {
      failed.push(provider);
    }
  }
  if (!isHosted() && input.localAllowed && input.settings.ollamaBaseUrl && !env.ollama) {
    configs.ollama = { baseURL: input.settings.ollamaBaseUrl };
  }
  return { configs, failed };
}

export async function createRunProviders(input: RunProviderInput): Promise<{
  providers: AiProviders;
  failedKeys: string[];
}> {
  const { configs, failed } = await decryptUserConfigs(input);
  const providers = createProviders(
    { env: envProviderConfigs(), user: configs },
    input.fetch ? { fetch: input.fetch } : {},
  );
  return { providers, failedKeys: failed };
}

/** Providers a user may store a key for, with their form fields (for the settings page). */
export function byokProviders() {
  return Object.values(PROVIDERS)
    .filter((p) => p.byok)
    .map((p) => ({
      id: p.id,
      label: p.label,
      kinds: [...p.kinds],
      fields: p.fields.map((f) => ({ ...f })),
      docsUrl: p.docsUrl,
    }));
}
