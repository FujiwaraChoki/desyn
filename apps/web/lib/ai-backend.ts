import { type FunctionReference, makeFunctionReference } from "convex/server";

/*
 * Server-side AI functions owned by the AI backend (convex/ai). They are referenced by name rather
 * than through the generated `api` object so the web app builds against deployments that do not ship
 * them (older self-hosted backends); calls fail with a "Could not find public function" error there,
 * which `isMissingFunction` recognises so the UI can offer the browser-only alternative.
 */

export type SaveKeyArgs = {
  provider: string;
  apiKey: string;
  baseUrl?: string;
  label?: string;
};

export interface TestResult {
  ok: boolean;
  status?: number;
  latencyMs: number;
  message: string;
  models?: string[];
}

export type StartAgentArgs = {
  designId: string;
  goal: string;
  mode?: "generate" | "edit";
};

export const aiBackend = {
  /** Validates and stores an encrypted BYOK key (AES-GCM with AI_KEY_ENCRYPTION_SECRET). */
  saveKey: makeFunctionReference<"action", SaveKeyArgs, { provider: string; last4: string | null }>(
    "ai/settings:saveByokKey",
  ) as FunctionReference<
    "action",
    "public",
    SaveKeyArgs,
    { provider: string; last4: string | null }
  >,
  /** Tests a provider with the user's stored key (or the server key) from the server. */
  testProvider: makeFunctionReference<"action", { provider: string }, TestResult>(
    "ai/settings:testProvider",
  ) as FunctionReference<"action", "public", { provider: string }, TestResult>,
  /** Starts a server-run agent on a design; returns the run id the editor's AI dock follows. */
  runAgent: makeFunctionReference<"mutation", StartAgentArgs, { runId: string }>(
    "ai/agent:runAgent",
  ) as FunctionReference<"mutation", "public", StartAgentArgs, { runId: string }>,
};

export function isMissingFunction(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /Could not find public function|Could not find function/i.test(message);
}
