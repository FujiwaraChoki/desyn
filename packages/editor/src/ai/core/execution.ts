import type { AccountView } from "./gating.ts";

/**
 * Where an agent run executes. Server runs (Convex AI backend) use the platform keys or BYOK keys stored on
 * the server and bill credits. Browser runs use @desyn/ai in this tab: keys kept only in this browser
 * ("Local keys only" mode) or local model servers (Ollama, LM Studio and other OpenAI-compatible servers on
 * the user's machine, which a hosted server cannot reach). Browser runs never touch the credit ledger.
 */

export type Execution =
  | { where: "server" }
  | {
      where: "browser";
      reason: "local-keys" | "local-model";
      /** Provider that will run the agent. */
      provider: string;
      model: string | null;
    };

/** Providers that serve text models (the agent needs one). */
export const TEXT_PROVIDERS: readonly string[] = [
  "openrouter",
  "anthropic",
  "openai",
  "google",
  "mistral",
  "groq",
  "ollama",
  "openai-compatible",
];

/** Providers that run on the user's machine. */
export const LOCAL_PROVIDERS: readonly string[] = ["ollama", "openai-compatible"];

export interface LocalConfigs {
  [provider: string]: { apiKey?: string; baseURL?: string } | undefined;
}

/** Providers the browser can reach for this user: local-mode keys plus the local model servers. */
export function browserProviders(account: AccountView, local: LocalConfigs): string[] {
  const out = new Set<string>();
  const byok = account.features["ai.byok"] === true && account.aiSettings?.keyMode === "local";
  const localModels = account.features["ai.local"] === true;
  for (const [id, config] of Object.entries(local)) {
    if (!config || !TEXT_PROVIDERS.includes(id)) continue;
    if (LOCAL_PROVIDERS.includes(id) ? localModels : byok) out.add(id);
  }
  if (localModels && account.aiSettings?.ollamaBaseUrl) out.add("ollama");
  return [...out];
}

/**
 * The default execution for an agent run, or both options when the user can choose (`choices`). `prefer`
 * is the user's pick in the dock ("browser" | "server"), honoured when it is available.
 */
export function pickExecution(
  account: AccountView | null | undefined,
  local: LocalConfigs,
  prefer: "browser" | "server" | null = null,
): { execution: Execution; choices: Execution[] } {
  const server: Execution = { where: "server" };
  if (!account) return { execution: server, choices: [server] };
  const reachable = browserProviders(account, local);
  const agent = account.aiSettings?.taskModels?.agent ?? null;
  let browser: Execution | null = null;
  if (agent && reachable.includes(agent.provider)) {
    browser = {
      where: "browser",
      reason: LOCAL_PROVIDERS.includes(agent.provider) ? "local-model" : "local-keys",
      provider: agent.provider,
      model: agent.model,
    };
  } else if (!agent && reachable.includes("openrouter")) {
    // No agent model chosen: the routing defaults are OpenRouter models, so an OpenRouter key kept in this
    // browser can run them. Other providers need a model picked in Settings › AI.
    browser = { where: "browser", reason: "local-keys", provider: "openrouter", model: null };
  }
  // A local model the hosted server cannot reach must run here even without an explicit preference.
  const mustBeLocal =
    !!agent && LOCAL_PROVIDERS.includes(agent.provider) && account.edition === "hosted";
  const choices = browser ? (mustBeLocal ? [browser] : [browser, server]) : [server];
  if (!browser) return { execution: server, choices };
  if (prefer === "server" && !mustBeLocal) return { execution: server, choices };
  return { execution: browser, choices };
}

export function executionLabel(e: Execution): string {
  if (e.where === "server") return "Desyn cloud";
  const who = e.reason === "local-model" ? "Local model" : "Your keys";
  return `${who} · ${e.model ?? e.provider}`;
}
