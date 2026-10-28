import {
  type AiProviders,
  createProviders,
  type FalRunOptions,
  type FalTransport,
} from "@desyn/ai";
import { createText, defaultTextStyle, type Node, newId } from "@desyn/schema";
import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { RunProviderInput } from "../lib/ai_providers";
import { firstPageId, loadAll, makeTx, workspaceOf } from "./designs.helpers";
import type { TestUser } from "./harness.helpers";

// Helpers for the AI backend suites: scripted AI SDK mock models, a fake fal transport, and a hook that
// replaces `createRunProviders` (lib/ai_providers.ts) so server runs use them instead of real providers.
// Test files install it with:
//   vi.mock("../lib/ai_providers", async (orig) => (await import("./ai.helpers")).mockProvidersModule(await orig()));
// and must not import lib/ai_providers statically themselves (use vi.importActual for its real helpers).

export const usage = {
  inputTokens: { total: 100, noCache: 100, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 50, text: 50, reasoning: undefined },
};

export interface Turn {
  text?: string;
  calls?: { name: string; input: unknown }[];
  /** Runs before the turn is streamed (e.g. a user cancelling mid-run). */
  before?: () => Promise<void> | void;
}

let callCounter = 0;

function turnChunks(turn: Turn) {
  const chunks: unknown[] = [{ type: "stream-start", warnings: [] }];
  if (turn.text) {
    chunks.push(
      { type: "text-start", id: "t" },
      { type: "text-delta", id: "t", delta: turn.text },
      { type: "text-end", id: "t" },
    );
  }
  for (const call of turn.calls ?? []) {
    chunks.push({
      type: "tool-call",
      toolCallId: `call-${++callCounter}`,
      toolName: call.name,
      input: JSON.stringify(call.input),
    });
  }
  chunks.push({
    type: "finish",
    finishReason: { unified: turn.calls?.length ? "tool-calls" : "stop", raw: undefined },
    usage,
  });
  return chunks;
}

/** A streaming model that plays one turn per step (the last turn repeats). */
export function scriptedModel(turns: Turn[]): MockLanguageModelV4 {
  let step = 0;
  return new MockLanguageModelV4({
    modelId: "anthropic/claude-sonnet-5.5",
    doStream: async () => {
      const turn = turns[Math.min(step++, turns.length - 1)] ?? {};
      await turn.before?.();
      return { stream: convertArrayToReadableStream(turnChunks(turn) as never[]) };
    },
  });
}

/** A model answering generateText calls with the given JSON values in order. */
export function scriptedTextModel(outputs: unknown[]): MockLanguageModelV4 {
  let i = 0;
  return new MockLanguageModelV4({
    modelId: "anthropic/claude-haiku-5.5",
    doGenerate: async () => {
      const o = outputs[Math.min(i++, outputs.length - 1)];
      return {
        content: [{ type: "text" as const, text: typeof o === "string" ? o : JSON.stringify(o) }],
        finishReason: { unified: "stop" as const, raw: undefined },
        usage,
        warnings: [],
      };
    },
  });
}

/** In-memory fal transport answering per endpoint. */
export function fakeFal(
  handlers: Record<string, (input: Record<string, unknown>) => unknown | Promise<unknown>>,
) {
  const calls: { endpoint: string; input: Record<string, unknown> }[] = [];
  const transport: FalTransport = {
    async run<T>(endpoint: string, input: Record<string, unknown>, options?: FalRunOptions) {
      calls.push({ endpoint, input });
      options?.onQueueUpdate?.({ status: "IN_QUEUE", position: 1 });
      options?.onQueueUpdate?.({ status: "IN_PROGRESS", logs: ["working"] });
      const handler = handlers[endpoint];
      if (!handler) throw new Error(`no fake for ${endpoint}`);
      return { data: (await handler(input)) as T, requestId: `req-${calls.length}` };
    },
  };
  return { transport, calls };
}

/** What the next server runs get instead of real providers. */
export const providerHook: {
  model: MockLanguageModelV4 | null;
  textModel: MockLanguageModelV4 | null;
  fal: FalTransport | null;
  /** Inputs `createRunProviders` was called with (BYOK assertions). */
  inputs: RunProviderInput[];
  /** Throw from the next `createRunProviders` calls (simulates a crashing action). */
  failNext: number;
  /** Configure the text provider as the user's own key (BYOK billing) instead of the server key. */
  byok: boolean;
} = { model: null, textModel: null, fal: null, inputs: [], failNext: 0, byok: false };

export function resetProviderHook(): void {
  providerHook.model = null;
  providerHook.textModel = null;
  providerHook.fal = null;
  providerHook.inputs = [];
  providerHook.failNext = 0;
  providerHook.byok = false;
}

/** Providers configured like a server with OpenRouter + fal keys, models replaced by the hook's mocks. */
export function mockedProviders(): AiProviders {
  const openrouter = { apiKey: "test-openrouter-key" };
  const providers = createProviders(
    {
      env: {
        ...(providerHook.byok ? {} : { openrouter }),
        fal: { apiKey: "test-fal-key-0000" },
      },
      ...(providerHook.byok ? { user: { openrouter } } : {}),
    },
    providerHook.fal ? { falTransport: providerHook.fal } : {},
  );
  providers.languageModel = (ref) => {
    if (ref.model.includes("haiku") || ref.model.includes("opus")) {
      if (providerHook.textModel) return providerHook.textModel;
    }
    if (providerHook.model) return providerHook.model;
    // Never fall through to a real provider (no network in tests).
    throw new Error(`no mock model for ${ref.provider}:${ref.model}`);
  };
  return providers;
}

type ProvidersModule = typeof import("../lib/ai_providers");

/** The vi.mock factory body for lib/ai_providers. */
export function mockProvidersModule(real: ProvidersModule): ProvidersModule {
  return {
    ...real,
    createRunProviders: async (input: RunProviderInput) => {
      providerHook.inputs.push(input);
      if (providerHook.failNext > 0) {
        providerHook.failNext--;
        throw new Error("simulated provider outage");
      }
      return { providers: mockedProviders(), failedKeys: [] };
    },
  };
}

/** A design with one headline text node; returns ids. */
export async function designWithHeadline(
  user: TestUser,
  opts: { kind?: string; name?: string } = {},
): Promise<{
  designId: Id<"designs">;
  workspaceId: Id<"workspaces">;
  pageId: string;
  headlineId: string;
}> {
  const workspaceId = await workspaceOf(user);
  const { designId } = await user.as.mutation(api.designs.designs.create, {
    workspaceId,
    kind: opts.kind ?? "social-post",
    name: opts.name ?? "Spring launch",
  });
  const { design } = await loadAll(user.as, designId);
  const pageId = firstPageId(design);
  const headline = createText({
    id: newId(),
    name: "Headline",
    role: "headline",
    text: "Spring collection",
    x: 80,
    y: 120,
    width: 800,
    height: 80,
    style: defaultTextStyle({ fontFamily: "Inter", fontSize: 64, fontWeight: 700 }),
  }) as Node;
  await user.as.mutation(api.designs.designs.commit, {
    designId,
    tx: JSON.stringify(makeTx([{ op: "create", nodes: [headline], parent: pageId }])),
  });
  return { designId, workspaceId, pageId, headlineId: headline.id };
}

/** 1×1 PNG (valid header for size sniffing). */
export function tinyPng(width = 4, height = 4): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  bytes.set([8, 6, 0, 0, 0], 24);
  return bytes;
}

export function pngDataUri(width = 4, height = 4): string {
  let binary = "";
  for (const b of tinyPng(width, height)) binary += String.fromCharCode(b);
  return `data:image/png;base64,${btoa(binary)}`;
}
