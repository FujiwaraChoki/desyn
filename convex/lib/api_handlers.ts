import type { Design, Node, PageNode, Transaction } from "@desyn/schema";
import type {
  ApiScope,
  CommitBody,
  CreateDesignBody,
  ExportBody,
  InstantiateBody,
  PreviewBody,
  RouteId,
  UploadRequestBody,
} from "@desyn/sdk/contract";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import { aiApi, isMissingFunction } from "./api_ai";
import { type ApiCaller, ApiError, toErrorPayload } from "./api_http";
import { MAX_RENDER_NODES } from "./api_limits";
import type { Principal } from "./api_principal";
import { randomAlphanumeric, sha256Hex } from "./crypto";
import { assembleDesign, type LoadPage } from "./designs_wire";
import { callWorker, WorkerError, withAssetUrls, withPages } from "./designs_worker";

// REST v1 handlers: one function per route id of the @desyn/sdk contract. Inputs are already validated
// against the contract schemas by the dispatcher (routes/api.ts); every Convex call goes through an
// internal function in convex/api/* with the verified principal.

export interface HandlerInput {
  ctx: ActionCtx;
  caller: ApiCaller;
  params: Record<string, string>;
  // biome-ignore lint/suspicious/noExplicitAny: validated by the route's zod schema before the call
  query: any;
  // biome-ignore lint/suspicious/noExplicitAny: validated by the route's zod schema before the call
  body: any;
  idempotencyKey: string | null;
  requestId: string;
  req: Request;
}

export type HandlerOutput =
  | { status?: number; body: unknown; headers?: Record<string, string> }
  | Response;

type Handler = (input: HandlerInput) => Promise<HandlerOutput>;

const DEFAULT_PAGE = 25;

/** Transaction ids are 12 lowercase alphanumerics; an Idempotency-Key maps to a stable one per key + design. */
export async function txIdFor(
  keyId: string,
  designId: string,
  idempotencyKey: string | null,
): Promise<string> {
  if (!idempotencyKey) return randomAlphanumeric(12);
  return (await sha256Hex(`tx:${keyId}:${designId}:${idempotencyKey}`)).slice(0, 12);
}

// --- documents -------------------------------------------------------------------------------------------------

export interface LoadedDocument {
  design: Design;
  seq: number;
  consistent: boolean;
  assetUrls: Record<string, string>;
  designId: Id<"designs">;
}

/** Load a whole design in 500-node chunks (designs.load semantics) and assemble it. */
export async function loadDocument(
  ctx: ActionCtx,
  principal: Principal,
  designId: string,
): Promise<LoadedDocument> {
  const pages: LoadPage[] = [];
  let assetUrls: Record<string, string> = {};
  let id: Id<"designs"> | null = null;
  let cursor: string | null = null;
  for (;;) {
    const page: LoadPage & { assetUrls: Record<string, string> | null; designId: Id<"designs"> } =
      await ctx.runQuery(internal.api.designs.loadPage, { principal, designId, cursor });
    pages.push(page);
    if (page.assetUrls) assetUrls = page.assetUrls;
    id = page.designId;
    if (page.isDone) break;
    cursor = page.cursor;
  }
  const { design, seq, consistent } = assembleDesign(pages);
  return { design, seq, consistent, assetUrls, designId: id as Id<"designs"> };
}

function pageIdsOf(design: Design): string[] {
  return (design.nodes.root as (Node & { children?: string[] }) | undefined)?.children ?? [];
}

function pageOf(design: Design, pageId: string | undefined): PageNode {
  const ids = pageIdsOf(design);
  const id = pageId ?? ids[0];
  const node = id ? design.nodes[id] : undefined;
  if (node?.type !== "page" || !ids.includes(node.id)) {
    throw new ApiError(
      "NOT_FOUND",
      pageId ? `Page ${pageId} not found.` : "The design has no pages.",
      {
        field: "pageId",
      },
    );
  }
  return node;
}

function workerFailure(err: unknown): never {
  if (err instanceof WorkerError) {
    if (err.status === 0 && !err.retryable) {
      throw new ApiError(
        "NOT_CONFIGURED",
        "The render worker is not configured on this installation.",
      );
    }
    if (err.status >= 400 && err.status < 500 && err.status !== 429) {
      throw new ApiError(
        "INVALID_ARGUMENT",
        `The render worker rejected the request: ${err.message}`,
      );
    }
    throw new ApiError(
      "UPSTREAM_UNAVAILABLE",
      "The render worker is unavailable. Retry shortly.",
      { retryAfterMs: 5_000 },
      { "retry-after": "5" },
    );
  }
  throw err;
}

async function renderableDocument(input: HandlerInput): Promise<LoadedDocument> {
  const doc = await loadDocument(
    input.ctx,
    input.caller.principal,
    input.params.designId as string,
  );
  if (Object.keys(doc.design.nodes).length > MAX_RENDER_NODES) {
    throw new ApiError("LIMIT_REACHED", "The design is too large to render through the API.", {
      limit: "renderNodes",
      max: MAX_RENDER_NODES,
      current: Object.keys(doc.design.nodes).length,
    });
  }
  return doc;
}

// --- handlers ---------------------------------------------------------------------------------------------------

const handlers: Record<Exclude<RouteId, never>, Handler> = {
  // account
  getMe: async ({ ctx, caller }) => ({
    body: await ctx.runQuery(internal.api.account.me, {
      principal: caller.principal,
      keyId: caller.keyId,
      scopes: caller.scopes,
    }),
  }),
  listWorkspaces: async ({ ctx, caller }) => ({
    body: await ctx.runQuery(internal.api.account.workspaces, { principal: caller.principal }),
  }),
  getCredits: async ({ ctx, caller }) => ({
    body: await ctx.runQuery(internal.api.account.credits, { principal: caller.principal }),
  }),
  getUsage: async ({ ctx, caller }) => ({
    body: await ctx.runQuery(internal.api.account.usage, { principal: caller.principal }),
  }),

  // designs
  listDesigns: async ({ ctx, caller, query }) => ({
    body: await ctx.runQuery(internal.api.designs.list, {
      principal: caller.principal,
      ...(query.state ? { state: query.state } : {}),
      ...(query.kind ? { kind: query.kind } : {}),
      ...(query.folderId ? { folderId: query.folderId } : {}),
      ...(query.mine !== undefined ? { mine: query.mine } : {}),
      ...(query.search ? { search: query.search } : {}),
      numItems: query.limit ?? DEFAULT_PAGE,
      cursor: query.cursor ?? null,
    }),
  }),
  createDesign: async ({ ctx, caller, body }) => {
    const b = body as CreateDesignBody;
    return {
      status: 201,
      body: await ctx.runMutation(internal.api.designs.create, {
        principal: caller.principal,
        ...(b.name !== undefined ? { name: b.name } : {}),
        ...(b.kind !== undefined ? { kind: b.kind } : {}),
        ...(b.presetId !== undefined ? { presetId: b.presetId } : {}),
        ...(b.width !== undefined && b.height !== undefined
          ? { size: { width: b.width, height: b.height, ...(b.unit ? { unit: b.unit } : {}) } }
          : {}),
        ...(b.folderId !== undefined ? { folderId: b.folderId } : {}),
        ...(b.templateId !== undefined ? { templateId: b.templateId } : {}),
      }),
    };
  },
  getDesign: async ({ ctx, caller, params }) => ({
    body: await ctx.runQuery(internal.api.designs.get, {
      principal: caller.principal,
      designId: params.designId as string,
    }),
  }),
  updateDesign: async ({ ctx, caller, params, body }) => ({
    body: await ctx.runMutation(internal.api.designs.update, {
      principal: caller.principal,
      designId: params.designId as string,
      ...(body?.name !== undefined ? { name: body.name } : {}),
      ...(body?.folderId !== undefined ? { folderId: body.folderId } : {}),
    }),
  }),
  archiveDesign: async ({ ctx, caller, params }) => ({
    body: await ctx.runMutation(internal.api.designs.archive, {
      principal: caller.principal,
      designId: params.designId as string,
    }),
  }),
  restoreDesign: async ({ ctx, caller, params }) => ({
    body: await ctx.runMutation(internal.api.designs.restore, {
      principal: caller.principal,
      designId: params.designId as string,
    }),
  }),
  deleteDesign: async ({ ctx, caller, params, query }) => ({
    body: await ctx.runMutation(internal.api.designs.remove, {
      principal: caller.principal,
      designId: params.designId as string,
      permanent: query.permanent === true,
    }),
  }),
  listFolders: async ({ ctx, caller }) => ({
    body: await ctx.runQuery(internal.api.designs.folders, { principal: caller.principal }),
  }),

  // document
  getDocument: async ({ ctx, caller, params, query }) => {
    const doc = await loadDocument(ctx, caller.principal, params.designId as string);
    let design = withAssetUrls(doc.design, doc.assetUrls);
    if (query.pageId) design = withPages(design, [pageOf(design, query.pageId).id]);
    return {
      body: { seq: doc.seq, consistent: doc.consistent, design },
      headers: { "x-desyn-seq": String(doc.seq) },
    };
  },
  commitTransaction: async ({ ctx, caller, params, body, idempotencyKey }) => {
    const b = body as CommitBody;
    const designId = params.designId as string;
    const tx: Transaction = {
      id: b.tx.id ?? (await txIdFor(caller.keyId, designId, idempotencyKey)),
      label: b.tx.label?.trim() || "API edit",
      ops: b.tx.ops,
      source: b.tx.source ?? "ai",
      actor: {
        ...(b.tx.actor ?? {}),
        userId: caller.principal.userId,
        agent: b.tx.actor?.agent ?? "api",
      },
      ts: b.tx.ts ?? Date.now(),
    };
    const result = await ctx.runMutation(internal.api.designs.commit, {
      principal: caller.principal,
      designId,
      ...(b.baseSeq !== undefined ? { baseSeq: b.baseSeq } : {}),
      tx: JSON.stringify(tx),
    });
    return {
      body: {
        seq: result.seq,
        txId: result.txId,
        applied: JSON.parse(result.applied),
        dropped: result.dropped,
        duplicate: result.duplicate,
      },
      headers: { "x-desyn-seq": String(result.seq) },
    };
  },
  listTransactions: async ({ ctx, caller, params, query }) => {
    const result = await ctx.runQuery(internal.api.designs.since, {
      principal: caller.principal,
      designId: params.designId as string,
      since: query.since,
      limit: query.limit ?? 100,
    });
    return {
      body: {
        ...result,
        items: result.items.map((e) => ({ ...e, tx: JSON.parse(e.tx) as Transaction })),
      },
    };
  },
  describeDesign: async (input) => {
    const doc = await renderableDocument(input);
    const page = pageOf(doc.design, input.query.pageId);
    const selection = input.query.selection
      ? String(input.query.selection)
          .split(",")
          .map((s: string) => s.trim())
          .filter(Boolean)
      : [];
    try {
      const out = await callWorker(
        "/v1/describe",
        {
          design: withAssetUrls(doc.design, doc.assetUrls),
          pageId: page.id,
          ...(selection.length > 0 ? { selection } : {}),
          ...(input.query.maxDepth ? { maxDepth: input.query.maxDepth } : {}),
        },
        { timeoutMs: 60_000 },
      );
      return {
        body: JSON.parse(new TextDecoder().decode(out.bytes)),
        headers: { "x-desyn-seq": String(doc.seq) },
      };
    } catch (err) {
      workerFailure(err);
    }
  },
  renderPreview: async (input) => {
    const b = (input.body ?? {}) as PreviewBody;
    const doc = await renderableDocument(input);
    const page = pageOf(doc.design, b.pageId);
    const box = b.region ?? { w: page.width, h: page.height };
    const maxSize = b.maxSize ?? 2048;
    const longest = Math.max(box.w, box.h, 1);
    const scale =
      Math.round(Math.max(0.01, Math.min(b.scale ?? 1, maxSize / longest)) * 10_000) / 10_000;
    const format = b.format ?? "png";
    try {
      const out = await callWorker(
        "/v1/render",
        {
          design: withAssetUrls(doc.design, doc.assetUrls),
          pageId: page.id,
          ...(b.region ? { region: b.region } : {}),
          scale,
          format,
          ...(b.background ? { background: b.background } : {}),
          assetUrls: doc.assetUrls,
        },
        { timeoutMs: 60_000 },
      );
      return new Response(out.bytes as BodyInit, {
        status: 200,
        headers: {
          "content-type": out.contentType.startsWith("image/")
            ? out.contentType
            : `image/${format}`,
          "cache-control": "no-store",
          "x-desyn-seq": String(doc.seq),
          "x-desyn-page": page.id,
          "x-desyn-scale": String(scale),
        },
      });
    } catch (err) {
      workerFailure(err);
    }
  },
  applyBrand: async ({ ctx, caller, params, body, idempotencyKey }) => {
    const designId = params.designId as string;
    const result = await ctx.runAction(internal.api.brandNode.applyBrand, {
      principal: caller.principal,
      designId,
      txId: await txIdFor(caller.keyId, `${designId}:brand`, idempotencyKey),
      ...(body?.brandKitId ? { brandKitId: body.brandKitId } : {}),
      ...(body?.pageIds ? { pageIds: body.pageIds } : {}),
      ...(body?.ids ? { ids: body.ids } : {}),
      ...(body?.colors !== undefined ? { colors: body.colors } : {}),
      ...(body?.fonts !== undefined ? { fonts: body.fonts } : {}),
      ...(body?.logo ? { logo: body.logo } : {}),
    });
    return {
      body: {
        ...result,
        commit: result.commit
          ? {
              seq: result.commit.seq,
              txId: result.commit.txId,
              applied: JSON.parse(result.commit.applied),
              dropped: result.commit.dropped,
              duplicate: result.commit.duplicate,
            }
          : null,
      },
    };
  },

  // exports
  requestExport: async ({ ctx, caller, params, body }) => {
    const b = body as ExportBody;
    return {
      status: 202,
      body: await ctx.runMutation(internal.api.exports.request, {
        principal: caller.principal,
        designId: params.designId as string,
        format: b.format,
        ...(b.pages !== undefined ? { pages: b.pages } : {}),
        ...(b.scale !== undefined ? { scale: b.scale } : {}),
        ...(b.quality !== undefined ? { quality: b.quality } : {}),
        ...(b.background !== undefined ? { background: b.background } : {}),
        ...(b.pdf !== undefined ? { pdf: b.pdf } : {}),
        ...(b.notify !== undefined ? { notify: b.notify } : {}),
      }),
    };
  },
  getExport: async ({ ctx, caller, params }) => ({
    body: await ctx.runQuery(internal.api.exports.get, {
      principal: caller.principal,
      exportId: params.exportId as string,
    }),
  }),

  // assets
  listAssets: async ({ ctx, caller, query }) => ({
    body: await ctx.runQuery(internal.api.assets.list, {
      principal: caller.principal,
      ...(query.kind ? { kind: query.kind } : {}),
      ...(query.search ? { search: query.search } : {}),
      numItems: query.limit ?? 50,
      cursor: query.cursor ?? null,
    }),
  }),
  requestUpload: async ({ ctx, caller, body }) => {
    const b = body as UploadRequestBody;
    return {
      status: 201,
      body: await ctx.runMutation(internal.api.assets.requestUpload, {
        principal: caller.principal,
        name: b.name,
        mime: b.mime,
        bytes: b.bytes,
        ...(b.sha256 ? { sha256: b.sha256.toLowerCase() } : {}),
        ...(b.declaredKind ? { declaredKind: b.declaredKind } : {}),
        ...(b.source ? { source: b.source } : {}),
        ...(b.family ? { family: b.family } : {}),
        ...(b.weight ? { weight: b.weight } : {}),
        ...(b.style ? { style: b.style } : {}),
      }),
    };
  },
  finalizeUpload: async ({ ctx, caller, params, body }) => {
    const assetId = await ctx.runQuery(internal.api.assets.ownAssetId, {
      principal: caller.principal,
      assetId: params.assetId as string,
    });
    const done = await ctx.runAction(internal.api.assets.finalize, {
      principal: caller.principal,
      assetId,
      ...(body?.media ? { media: body.media } : {}),
    });
    return {
      body: await ctx.runQuery(internal.api.assets.byId, {
        principal: caller.principal,
        assetId: done.assetId,
      }),
    };
  },
  getAsset: async ({ ctx, caller, params }) => ({
    body: await ctx.runQuery(internal.api.assets.get, {
      principal: caller.principal,
      assetId: params.assetId as string,
    }),
  }),
  renameAsset: async ({ ctx, caller, params, body }) => ({
    body: await ctx.runMutation(internal.api.assets.rename, {
      principal: caller.principal,
      assetId: params.assetId as string,
      name: body.name,
    }),
  }),
  deleteAsset: async ({ ctx, caller, params }) => ({
    body: await ctx.runMutation(internal.api.assets.remove, {
      principal: caller.principal,
      assetId: params.assetId as string,
    }),
  }),

  // templates
  searchTemplates: async ({ ctx, caller, query }) => ({
    body: await ctx.runQuery(internal.api.templates.search, {
      principal: caller.principal,
      ...(query.q ? { q: query.q } : {}),
      ...(query.kind ? { kind: query.kind } : {}),
      ...(query.category ? { category: query.category } : {}),
      ...(query.premium !== undefined ? { premium: query.premium } : {}),
      ...(query.sort ? { sort: query.sort } : {}),
      numItems: query.limit ?? 24,
      cursor: query.cursor ?? null,
    }),
  }),
  getTemplate: async ({ ctx, caller, params }) => ({
    body: await ctx.runQuery(internal.api.templates.get, {
      principal: caller.principal,
      template: params.template as string,
    }),
  }),
  instantiateTemplate: async ({ ctx, caller, params, body, idempotencyKey }) => {
    const b = (body ?? {}) as InstantiateBody;
    if (b.brandKitId) {
      requireScope(caller, "brand:read");
      // Resolve the kit first: an unknown or foreign kit must fail before a design is created, or the
      // error response would leave an orphan design behind (and be replayed for the Idempotency-Key).
      await ctx.runQuery(internal.api.brand.get, {
        principal: caller.principal,
        brandKitId: b.brandKitId,
      });
    }
    const created = await ctx.runMutation(internal.api.templates.instantiate, {
      principal: caller.principal,
      template: params.template as string,
      ...(b.name !== undefined ? { name: b.name } : {}),
      ...(b.folderId !== undefined ? { folderId: b.folderId } : {}),
      ...(b.slots ? { slots: b.slots } : {}),
    });
    let brandApplied = false;
    if (b.brandKitId) {
      await ctx.runAction(internal.api.brandNode.applyBrand, {
        principal: caller.principal,
        designId: created.id,
        brandKitId: b.brandKitId,
        txId: await txIdFor(caller.keyId, `${created.id}:brand`, idempotencyKey),
      });
      brandApplied = true;
    }
    const design = brandApplied
      ? await ctx.runQuery(internal.api.designs.get, {
          principal: caller.principal,
          designId: created.id,
        })
      : created;
    return {
      status: 201,
      body: {
        ...design,
        firstPageId: created.firstPageId,
        filledSlots: created.filledSlots,
        unknownSlots: created.unknownSlots,
        brandApplied,
      },
    };
  },

  // brand kits
  listBrandKits: async ({ ctx, caller }) => ({
    body: await ctx.runQuery(internal.api.brand.list, { principal: caller.principal }),
  }),
  getBrandKit: async ({ ctx, caller, params }) => ({
    body: await ctx.runQuery(internal.api.brand.get, {
      principal: caller.principal,
      brandKitId: params.brandKitId as string,
    }),
  }),
  createBrandKit: async ({ ctx, caller, body }) => ({
    status: 201,
    body: await ctx.runMutation(internal.api.brand.create, {
      principal: caller.principal,
      ...body,
    }),
  }),
  updateBrandKit: async ({ ctx, caller, params, body }) => ({
    body: await ctx.runMutation(internal.api.brand.update, {
      principal: caller.principal,
      brandKitId: params.brandKitId as string,
      ...body,
    }),
  }),
  deleteBrandKit: async ({ ctx, caller, params }) => ({
    body: await ctx.runMutation(internal.api.brand.remove, {
      principal: caller.principal,
      brandKitId: params.brandKitId as string,
    }),
  }),

  // AI (convex/ai/api.ts, see lib/api_ai.ts)
  startAgentRun: async ({ ctx, caller, params, body, idempotencyKey }) => ({
    status: 202,
    body: await ai(() =>
      ctx.runMutation(aiApi.startRun, {
        principal: caller.principal,
        designId: params.designId as string,
        goal: body.goal,
        ...(body.mode ? { mode: body.mode } : {}),
        ...(body.pageId ? { pageId: body.pageId } : {}),
        ...(body.selection ? { selection: body.selection } : {}),
        ...(body.model ? { model: body.model } : {}),
        ...(body.maxSteps !== undefined ? { maxSteps: body.maxSteps } : {}),
        ...(body.maxCredits !== undefined ? { maxCredits: body.maxCredits } : {}),
        ...(idempotencyKey ? { requestKey: `${caller.keyId}:${idempotencyKey}` } : {}),
      }),
    ),
  }),
  getAgentRun: async ({ ctx, caller, params }) => ({
    body: await ai(() =>
      ctx.runQuery(aiApi.getRun, { principal: caller.principal, runId: params.runId as string }),
    ),
  }),
  listAgentRunEvents: async (input) => await runEvents(input),
  answerAgentRun: async ({ ctx, caller, params, body }) => ({
    body: await ai(() =>
      ctx.runMutation(aiApi.answerRun, {
        principal: caller.principal,
        runId: params.runId as string,
        answer: body.answer,
      }),
    ),
  }),
  cancelAgentRun: async ({ ctx, caller, params }) => ({
    body: await ai(() =>
      ctx.runMutation(aiApi.cancelRun, {
        principal: caller.principal,
        runId: params.runId as string,
      }),
    ),
  }),
  generateAsset: async ({ ctx, caller, body, idempotencyKey }) => ({
    status: 202,
    body: await ai(() =>
      ctx.runMutation(aiApi.generateAsset, {
        principal: caller.principal,
        ...body,
        ...(idempotencyKey ? { requestKey: `${caller.keyId}:${idempotencyKey}` } : {}),
      }),
    ),
  }),
  startWorkflow: async ({ ctx, caller, body, idempotencyKey }) => ({
    status: 202,
    body: await ai(() =>
      ctx.runMutation(aiApi.startWorkflow, {
        principal: caller.principal,
        type: body.type,
        ...(body.designId ? { designId: body.designId } : {}),
        input: JSON.stringify(body.input),
        ...(idempotencyKey ? { requestKey: `${caller.keyId}:${idempotencyKey}` } : {}),
      }),
    ),
  }),
  getWorkflow: async ({ ctx, caller, params }) => ({
    body: await ai(() =>
      ctx.runQuery(aiApi.getWorkflow, {
        principal: caller.principal,
        workflowId: params.workflowId as string,
      }),
    ),
  }),
  listModels: async ({ ctx, caller, query }) => ({
    body: await ai(() =>
      ctx.runAction(aiApi.listModels, {
        principal: caller.principal,
        ...(query.task ? { task: query.task } : {}),
      }),
    ),
  }),
};

/** Call the AI backend; a deployment without it answers 501 instead of a generic 500. */
async function ai<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (isMissingFunction(err)) {
      throw new ApiError("NOT_CONFIGURED", "AI runs are not available on this installation yet.");
    }
    throw err;
  }
}

const EVENTS_PAGE = 200;
const SSE_POLL_MS = 400;
const SSE_MAX_MS = 55_000;
const SSE_KEEPALIVE_MS = 15_000;
/**
 * Stream-control event names. They cannot collide with AgentEvent types (`error`, `done`, … from
 * @desyn/ai), so a run's own `error` event is delivered as data instead of ending the stream.
 */
const SSE_END = "stream-end";
const SSE_ERROR = "stream-error";

/** An AgentEvent type as an SSE `event:` field (one line of name characters, never a control name). */
function sseEventName(type: string): string {
  const name = type.replace(/[^\w.-]/g, "_").slice(0, 64) || "message";
  return name === SSE_END || name === SSE_ERROR ? `run-${name}` : name;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * GET /agent-runs/{runId}/events: Server-Sent Events when the client accepts text/event-stream (resumable
 * with Last-Event-ID; the stream ends at the end of the run or after ~55 s with a retry hint), otherwise a
 * JSON page that can long-poll with `wait` seconds.
 */
async function runEvents(input: HandlerInput): Promise<HandlerOutput> {
  const { ctx, caller, params, query, req } = input;
  const runId = params.runId as string;
  const lastEventId = req.headers.get("last-event-id");
  let after: number = query.after ?? -1;
  if (lastEventId && /^\d+$/.test(lastEventId)) after = Math.max(after, Number(lastEventId));
  const limit: number = query.limit ?? EVENTS_PAGE;
  const page = (cursor: number) =>
    ai(() =>
      ctx.runQuery(aiApi.listEvents, { principal: caller.principal, runId, after: cursor, limit }),
    );

  // The first page also validates access before any stream starts.
  const first = await page(after);
  const wantsStream = (req.headers.get("accept") ?? "").includes("text/event-stream");
  if (!wantsStream) {
    let current = first;
    const deadline = Date.now() + (query.wait ?? 0) * 1000;
    while (current.items.length === 0 && !current.done && Date.now() < deadline) {
      await sleep(Math.min(SSE_POLL_MS * 2, Math.max(0, deadline - Date.now())));
      current = await page(after);
    }
    return { body: current };
  }

  const encoder = new TextEncoder();
  const started = Date.now();
  // The client may disconnect at any time: stop polling and never enqueue into a cancelled stream.
  let closed = false;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (text: string) => {
        if (!closed) controller.enqueue(encoder.encode(text));
      };
      send(": desyn run events\nretry: 1000\n\n");
      let current = first;
      let cursor = after;
      let lastWrite = Date.now();
      try {
        while (!closed) {
          for (const event of current.items) {
            send(
              `id: ${event.index}\nevent: ${sseEventName(event.type)}\ndata: ${JSON.stringify(event)}\n\n`,
            );
            cursor = event.index;
            lastWrite = Date.now();
          }
          if (current.done) {
            send(`event: ${SSE_END}\ndata: ${JSON.stringify({ runId, next: cursor })}\n\n`);
            break;
          }
          if (Date.now() - started > SSE_MAX_MS) break;
          if (Date.now() - lastWrite > SSE_KEEPALIVE_MS) {
            send(": keep-alive\n\n");
            lastWrite = Date.now();
          }
          if (current.items.length < limit) await sleep(SSE_POLL_MS);
          if (closed) break;
          current = await page(cursor);
        }
      } catch (err) {
        // Same sanitized { code, message } as the JSON error format; internal details stay in the logs.
        const { code, message } = toErrorPayload(err);
        send(`event: ${SSE_ERROR}\ndata: ${JSON.stringify({ code, message })}\n\n`);
      } finally {
        if (!closed) {
          closed = true;
          controller.close();
        }
      }
    },
    cancel() {
      closed = true;
    },
  });
  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store, no-transform",
      "x-accel-buffering": "no",
    },
  });
}

function requireScope(caller: ApiCaller, scope: ApiScope): void {
  if (!caller.scopes.includes(scope)) {
    throw new ApiError("INSUFFICIENT_SCOPE", `This API key lacks the ${scope} scope.`, {
      required: [scope],
    });
  }
}

export function handlerFor(id: RouteId): Handler {
  return handlers[id];
}
