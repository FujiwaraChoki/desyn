import type {
  AgentEvent,
  AgentMode,
  BrandKit,
  ProviderConfigs,
  ProviderSettings,
  RunAgentOptions,
  RunAgentResult,
} from "@desyn/ai";
import type { ApplyResult, Id, Transaction } from "@desyn/schema";
import type { EditorController } from "../../controller.ts";
import type { LocalConfigs } from "../core/execution.ts";
import { LOCAL_PROVIDERS } from "../core/execution.ts";
import type { AccountView } from "../core/gating.ts";
import { EditorDocHost } from "./host.ts";

/**
 * Browser runs: @desyn/ai's agent loop in this tab with the user's browser-only keys or local model servers.
 * The agent code is loaded on first use (it carries the provider SDKs), never in the editor's first bundle.
 * A run that asks a question keeps its conversation; answering continues it with the open `ask_user` call
 * closed by the answer (the same shape the server uses, convex/lib/ai_backend.ts `closeOpenToolCalls`).
 */

export type ConversationMessage = NonNullable<RunAgentOptions["history"]>[number];

export interface BrowserRunInput {
  editor: EditorController;
  account: AccountView;
  local: LocalConfigs;
  runId: string;
  goal: string;
  mode: AgentMode;
  selection: Id[];
  brand?: BrandKit;
  /** Conversation so far (follow-ups, answers). */
  history: ConversationMessage[];
  /** The user approved destructive edits by answering the agent's question. */
  allowDestructive?: boolean;
  signal: AbortSignal;
  onEvent: (event: AgentEvent) => void;
  onApplied?: (tx: Transaction, result: ApplyResult) => void;
  /** Explicit agent model (tests and evals); normally routed from the user's settings. */
  model?: RunAgentOptions["model"];
}

export interface BrowserRunResult {
  result: RunAgentResult;
  /** Full conversation after this call (history + goal + the run's messages). */
  conversation: ConversationMessage[];
}

/**
 * Headers some providers require before they answer a request made from a web page (CORS). Anthropic refuses
 * browser requests unless the caller opts in; with "local keys only" the key belongs to this user and never
 * leaves their browser, which is exactly the case the opt-in exists for.
 */
const BROWSER_HEADERS: Readonly<Record<string, Record<string, string>>> = {
  anthropic: { "anthropic-dangerous-direct-browser-access": "true" },
};

/** Provider settings for a browser run: local servers as `local`, browser-only keys as `user` (BYOK). */
export function browserSettings(account: AccountView, local: LocalConfigs): ProviderSettings {
  const user: ProviderConfigs = {};
  const localServers: ProviderConfigs = {};
  const byokAllowed =
    account.features["ai.byok"] === true && account.aiSettings?.keyMode === "local";
  const localAllowed = account.features["ai.local"] === true;
  for (const [id, config] of Object.entries(local)) {
    if (!config) continue;
    const entry = {
      ...(config.apiKey ? { apiKey: config.apiKey } : {}),
      ...(config.baseURL ? { baseURL: config.baseURL } : {}),
    };
    if (LOCAL_PROVIDERS.includes(id)) {
      if (localAllowed) (localServers as Record<string, unknown>)[id] = entry;
    } else if (byokAllowed) {
      (user as Record<string, unknown>)[id] =
        id in BROWSER_HEADERS ? { ...entry, headers: BROWSER_HEADERS[id] } : entry;
    }
  }
  const ollama = account.aiSettings?.ollamaBaseUrl;
  if (localAllowed && ollama && !localServers.ollama) localServers.ollama = { baseURL: ollama };
  return { user, local: localServers };
}

/** Tool calls without results get one (the answer for ask_user) so every provider accepts the history. */
export function closeOpenToolCalls(
  messages: ConversationMessage[],
  answer: string | null,
): ConversationMessage[] {
  const answered = new Set<string>();
  for (const m of messages) {
    if (m.role !== "tool") continue;
    for (const part of m.content) if (part.type === "tool-result") answered.add(part.toolCallId);
  }
  const open: { toolCallId: string; toolName: string }[] = [];
  for (const m of messages) {
    if (m.role !== "assistant" || typeof m.content === "string") continue;
    for (const part of m.content) {
      if (part.type === "tool-call" && !answered.has(part.toolCallId)) {
        open.push({ toolCallId: part.toolCallId, toolName: part.toolName });
      }
    }
  }
  if (open.length === 0) return messages;
  return [
    ...messages,
    {
      role: "tool",
      content: open.map((call) => ({
        type: "tool-result" as const,
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        output:
          call.toolName === "ask_user" && answer !== null
            ? { type: "json" as const, value: { answer } }
            : { type: "text" as const, value: "Not run: the run was paused before this call." },
      })),
    },
  ];
}

/** Runs the agent in the browser. Resolves when the run ends, pauses for a question, or is stopped. */
export async function runInBrowser(input: BrowserRunInput): Promise<BrowserRunResult> {
  const ai = await import("@desyn/ai");
  const providers = ai.createProviders(browserSettings(input.account, input.local));
  const overrides: Record<string, { provider: string; model: string }> = {};
  for (const [task, ref] of Object.entries(input.account.aiSettings?.taskModels ?? {})) {
    if ((ai.AI_TASKS as readonly string[]).includes(task)) overrides[task] = ref;
  }
  const host = new EditorDocHost(input.editor, {
    runId: input.runId,
    userId: input.account.userId,
    selection: input.selection,
    ...(input.brand ? { brand: input.brand } : {}),
    ...(input.onApplied ? { onApplied: input.onApplied } : {}),
    fallbacks: {
      describeDesign: ai.describeDesign,
      renderDesign: ai.renderDesign,
      measureText: ai.measureText,
    },
  });
  const result = await ai.runAgent({
    host,
    goal: input.goal,
    mode: input.mode,
    selection: input.selection,
    history: input.history,
    providers,
    ...(input.model ? { model: input.model } : {}),
    prefs: { user: overrides as NonNullable<NonNullable<RunAgentOptions["prefs"]>["user"]> },
    signal: input.signal,
    onEvent: input.onEvent,
    runId: input.runId,
    search: { icons: ai.createIconify() },
    moderation: ai.createRuleModeration(),
    allowDestructive: input.allowDestructive === true,
    agentName: "desyn",
  });
  return {
    result,
    conversation: [
      ...input.history,
      { role: "user", content: input.goal },
      ...result.responseMessages,
    ],
  };
}
