// Test helpers: scripted AI SDK mock models, a sample design, fake fetch and fake fal transport. No network.
import { applyTransaction } from "@desyn/doc-ops";
import {
  type AssetRef,
  createDesign,
  createImage,
  createRect,
  createText,
  type Design,
  defaultTextStyle,
  newId,
  type Op,
} from "@desyn/schema";
import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test";
import { encodePng } from "../src/design/raster";
import type { FalRunOptions, FalTransport } from "../src/providers/fal";

export const usage = {
  inputTokens: { total: 100, noCache: 100, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 50, text: 50, reasoning: undefined },
};

export interface Turn {
  text?: string;
  reasoning?: string;
  calls?: { name: string; input: unknown }[];
}

let callCounter = 0;

function turnChunks(turn: Turn) {
  const chunks: unknown[] = [{ type: "stream-start", warnings: [] }];
  if (turn.reasoning) {
    chunks.push(
      { type: "reasoning-start", id: "r" },
      { type: "reasoning-delta", id: "r", delta: turn.reasoning },
      { type: "reasoning-end", id: "r" },
    );
  }
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

/** A streaming model that plays back one turn per step (the last turn repeats when exhausted). */
export function scriptedAgentModel(turns: Turn[]): MockLanguageModelV4 {
  let step = 0;
  return new MockLanguageModelV4({
    modelId: "anthropic/claude-sonnet-5.5",
    // A function (not an array) so every call gets a fresh stream and the last turn can repeat.
    doStream: async () => {
      const turn = turns[Math.min(step++, turns.length - 1)] ?? {};
      return { stream: convertArrayToReadableStream(turnChunks(turn) as never[]) };
    },
  });
}

/** A model for generateText calls (structured output): returns each JSON value in order. */
export function scriptedTextModel(outputs: unknown[]): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    modelId: "anthropic/claude-haiku-5.5",
    doGenerate: outputs.map((o) => ({
      content: [{ type: "text" as const, text: typeof o === "string" ? o : JSON.stringify(o) }],
      finishReason: { unified: "stop" as const, raw: undefined },
      usage,
      warnings: [],
    })),
  });
}

/** Solid-color PNG bytes. */
export function solidPng(
  width: number,
  height: number,
  rgba: [number, number, number, number] = [200, 80, 40, 255],
): Uint8Array {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) data.set(rgba, i * 4);
  return encodePng(width, height, data);
}

export interface SampleDesign {
  design: Design;
  pageId: string;
  ids: { bg: string; headline: string; body: string; photo: string; logo: string };
  assetId: string;
  logoAssetId: string;
}

/** A 1080x1080 social post with background, headline, body, a photo and a logo. */
export function sampleDesign(): SampleDesign {
  const base = createDesign("social-post", undefined, { name: "Spring sale", now: 0 });
  const pageId =
    base.nodes.root && "children" in base.nodes.root ? (base.nodes.root.children[0] as string) : "";
  const assetId = newId();
  const logoAssetId = newId();
  const assets: Record<string, AssetRef> = {
    [assetId]: {
      id: assetId,
      kind: "image",
      mime: "image/png",
      width: 1600,
      height: 1200,
      storageKey: "k/photo",
    },
    [logoAssetId]: {
      id: logoAssetId,
      kind: "image",
      mime: "image/png",
      width: 400,
      height: 120,
      storageKey: "k/logo",
    },
  };
  const bg = createRect({
    id: newId(),
    name: "Background",
    role: "background",
    x: 0,
    y: 0,
    width: 1080,
    height: 1080,
    fills: [{ type: "solid", color: "#f5efe6" }],
  });
  const photo = createImage({
    id: newId(),
    name: "Hero photo",
    role: "photo",
    assetId,
    x: 80,
    y: 80,
    width: 920,
    height: 560,
    fit: "crop",
  });
  const headline = createText({
    id: newId(),
    name: "Headline",
    role: "headline",
    text: "Spring collection is here",
    x: 80,
    y: 680,
    width: 920,
    height: 77,
    style: defaultTextStyle({
      fontFamily: "Inter",
      fontSize: 64,
      fontWeight: 700,
      fills: [{ type: "solid", color: "#1a1a1a" }],
    }),
  });
  const body = createText({
    id: newId(),
    name: "Body",
    role: "body",
    text: "Fresh styles, light fabrics and 20% off for the first week.",
    x: 80,
    y: 790,
    width: 920,
    height: 72,
    style: defaultTextStyle({
      fontFamily: "Inter",
      fontSize: 30,
      fills: [{ type: "solid", color: "#333333" }],
    }),
  });
  const logo = createImage({
    id: newId(),
    name: "Logo",
    role: "logo",
    assetId: logoAssetId,
    x: 80,
    y: 960,
    width: 160,
    height: 48,
    fit: "fit",
    alt: "Brand logo",
  });
  const ops: Op[] = [
    { op: "asset", set: assets },
    ...[bg, photo, headline, body, logo].map(
      (n): Op => ({ op: "create", nodes: [n], parent: pageId }),
    ),
  ];
  const design = applyTransaction(base, {
    id: newId(),
    label: "seed",
    ops,
    source: "system",
    ts: 0,
  }).design;
  return {
    design,
    pageId,
    ids: { bg: bg.id, headline: headline.id, body: body.id, photo: photo.id, logo: logo.id },
    assetId,
    logoAssetId,
  };
}

export interface FakeRequest {
  url: string;
  init?: RequestInit;
}

/** fetch replacement: routes by substring, records requests. */
export function fakeFetch(
  routes: Record<string, (url: string, init?: RequestInit) => Response | Promise<Response>>,
) {
  const requests: FakeRequest[] = [];
  const fn = async (url: string, init?: RequestInit) => {
    requests.push({ url, ...(init ? { init } : {}) });
    const key = Object.keys(routes).find((k) => url.includes(k));
    if (!key) return new Response("not found", { status: 404 });
    return (routes[key] as (url: string, init?: RequestInit) => Response | Promise<Response>)(
      url,
      init,
    );
  };
  return { fetch: fn, requests };
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** In-memory fal transport: answers per endpoint, records calls. */
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

export function pngDataUri(width = 4, height = 4): string {
  const bytes = solidPng(width, height);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return `data:image/png;base64,${btoa(binary)}`;
}
