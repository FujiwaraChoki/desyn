import type { Description, Design, Op, Transaction } from "@desyn/schema";
import type { z } from "zod";
import { API_BASE_PATH, type ApiErrorCode } from "./contract/common";
import { buildPath } from "./contract/paths";
import * as R from "./contract/resources";
import { DesynApiError } from "./errors";
import { parseSse } from "./sse";

// Typed, fetch-based client for the Agent API v1. Works in Node.js 18+, Deno, Bun, workers and browsers
// (in browsers, proxy through your own backend so the API key stays secret).

export const DEFAULT_BASE_URL = `https://api.desyn.app${API_BASE_PATH}`;

type Out<T extends z.ZodType> = z.output<T>;
type In<T extends z.ZodType> = z.input<T>;

export type Me = Out<typeof R.MeSchema>;
export type Workspace = Out<typeof R.WorkspaceSchema>;
export type Credits = Out<typeof R.CreditsSchema>;
export type Usage = Out<typeof R.UsageSchema>;
export type DesignSummary = Out<typeof R.DesignSummarySchema>;
export type CreatedDesign = Out<typeof R.CreatedDesignSchema>;
export type DeletedDesign = Out<typeof R.DeletedDesignSchema>;
export type DesignDocument = { seq: number; consistent: boolean; design: Design };
export type CommitResult = {
  seq: number;
  txId: string;
  applied: Op[];
  dropped: { index: number; reason: string }[];
  duplicate: boolean;
};
export type TransactionEntry = {
  seq: number;
  txId: string;
  tx: Transaction;
  actor: string | null;
  source: string;
  ts: number;
};
export type TransactionList = {
  items: TransactionEntry[];
  hasMore: boolean;
  reload: boolean;
  latestSeq: number;
};
export type ApplyBrandResult = Omit<Out<typeof R.ApplyBrandResultSchema>, "commit"> & {
  commit: CommitResult | null;
};
export type ExportJob = Out<typeof R.ExportSchema>;
export type Asset = Out<typeof R.AssetSchema>;
export type UploadTicket = Out<typeof R.UploadTicketSchema>;
export type Template = Out<typeof R.TemplateSchema>;
export type TemplateDetail = Out<typeof R.TemplateDetailSchema>;
export type InstantiatedDesign = Out<typeof R.InstantiatedSchema>;
export type BrandKit = Out<typeof R.BrandKitSchema>;
export type Folder = Out<typeof R.FolderSchema>;
export type Page<T> = { items: T[]; nextCursor: string | null };
export type AiRun = Out<typeof R.AiRunSchema>;
export type AiRunEvent = Out<typeof R.AiRunEventSchema>;
export type AiRunEventPage = Out<typeof R.AiRunEventListSchema>;
export type Workflow = Out<typeof R.WorkflowSchema>;
export type ModelList = Out<typeof R.ModelListSchema>;
export type StartRunInput = In<typeof R.StartRunBodySchema>;
export type GenerateAssetInput = In<typeof R.GenerateAssetBodySchema>;
export type StartWorkflowInput = In<typeof R.StartWorkflowBodySchema>;

const TERMINAL = new Set<string>(R.TERMINAL_RUN_STATUSES);

/** Whether a run status is final (no more events will follow). */
export function isTerminalRunStatus(status: string): boolean {
  return TERMINAL.has(status);
}

export type CreateDesignInput = In<typeof R.CreateDesignBodySchema>;
export type UpdateDesignInput = In<typeof R.UpdateDesignBodySchema>;
export type ListDesignsQuery = Omit<In<typeof R.DesignListQuerySchema>, "mine" | "limit"> & {
  mine?: boolean;
  limit?: number;
};
/** A transaction to commit: `ops` plus optional id / label / source / actor. */
export type TransactionInput = Omit<In<typeof R.TxInputSchema>, "ops"> & { ops: Op[] };
export type CommitInput = { baseSeq?: number; tx: TransactionInput | Transaction };
export type PreviewInput = In<typeof R.PreviewBodySchema>;
export type ApplyBrandInput = In<typeof R.ApplyBrandBodySchema>;
export type ExportInput = In<typeof R.ExportBodySchema>;
export type UploadRequestInput = In<typeof R.UploadRequestBodySchema>;
export type ListAssetsQuery = Omit<In<typeof R.AssetListQuerySchema>, "limit"> & { limit?: number };
export type TemplateSearchQuery = Omit<
  In<typeof R.TemplateSearchQuerySchema>,
  "limit" | "premium"
> & {
  limit?: number;
  premium?: boolean;
};
export type InstantiateInput = In<typeof R.InstantiateBodySchema>;
export type CreateBrandKitInput = In<typeof R.CreateBrandKitBodySchema>;
export type UpdateBrandKitInput = In<typeof R.UpdateBrandKitBodySchema>;
export type DescribeQuery = { pageId?: string; selection?: string[]; maxDepth?: number };

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface DesynClientOptions {
  /** API key (`dsk_…`). Defaults to the DESYN_API_KEY environment variable where one exists. */
  apiKey?: string;
  /** API base URL including /api/v1. Default https://api.desyn.app/api/v1; self-hosted: CONVEX_SITE_URL + /api/v1. */
  baseUrl?: string;
  fetch?: FetchLike;
  /** Per-request timeout. Default 60 s. */
  timeoutMs?: number;
  /** Retries for 429 / 503 / network errors on safe or idempotent requests. Default 2. */
  maxRetries?: number;
  /** Extra headers sent with every request. */
  headers?: Record<string, string>;
  /** Upper bound for a single retry wait. Default 30 s. */
  maxRetryDelayMs?: number;
}

export interface RequestOptions {
  /** Idempotency-Key for POSTs (generated automatically for idempotent endpoints when omitted). */
  idempotencyKey?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

interface RawRequest {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  /** POST endpoints that accept Idempotency-Key (retries are then safe). */
  idempotent?: boolean;
  options?: RequestOptions;
  accept?: string;
}

const RETRYABLE_STATUS = new Set([429, 503, 502, 504]);

function envApiKey(): string | undefined {
  const g = globalThis as { process?: { env?: Record<string, string | undefined> } };
  return g.process?.env?.DESYN_API_KEY || undefined;
}

function randomKey(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function txOf(input: TransactionInput | Transaction): TransactionInput {
  const { id, label, ops, source, actor, ts } = input;
  const out: TransactionInput = { ops };
  if (id !== undefined) out.id = id;
  if (label !== undefined) out.label = label;
  if (source !== undefined) out.source = source;
  if (actor !== undefined) {
    const { agent, runId } = actor as { agent?: string; runId?: string };
    out.actor = {
      ...(agent !== undefined ? { agent } : {}),
      ...(runId !== undefined ? { runId } : {}),
    };
  }
  if (ts !== undefined) out.ts = ts;
  return out;
}

export class DesynClient {
  readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly maxRetryDelayMs: number;
  private readonly extraHeaders: Record<string, string>;

  constructor(options: DesynClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.apiKey = options.apiKey ?? envApiKey();
    const f = options.fetch ?? (globalThis.fetch as FetchLike | undefined);
    if (!f) throw new Error("No fetch implementation available; pass options.fetch.");
    this.fetchImpl = options.fetch ? f : (input, init) => globalThis.fetch(input, init);
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.maxRetries = options.maxRetries ?? 2;
    this.maxRetryDelayMs = options.maxRetryDelayMs ?? 30_000;
    this.extraHeaders = options.headers ?? {};
  }

  // --- transport ---------------------------------------------------------------------------------------------

  /** Send a request and return the raw Response (errors are thrown as DesynApiError). */
  async raw(req: RawRequest): Promise<Response> {
    if (!this.apiKey) {
      throw new DesynApiError({
        status: 401,
        code: "UNAUTHENTICATED",
        message: "No API key: pass { apiKey } or set DESYN_API_KEY.",
      });
    }
    const url = new URL(`${this.baseUrl}${req.path}`);
    for (const [k, v] of Object.entries(req.query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.apiKey}`,
      accept: req.accept ?? "application/json",
      ...this.extraHeaders,
    };
    let body: string | undefined;
    if (req.body !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(req.body);
    }
    const idempotencyKey =
      req.options?.idempotencyKey ??
      (req.idempotent && req.method === "POST" ? randomKey() : undefined);
    if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
    const safe = req.method === "GET" || idempotencyKey !== undefined;
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await this.fetchOnce(
          url,
          { method: req.method, headers, ...(body !== undefined ? { body } : {}) },
          req.options,
        );
      } catch (err) {
        if (
          err instanceof DesynApiError &&
          safe &&
          attempt < this.maxRetries &&
          err.code !== "TIMEOUT"
        ) {
          await sleep(this.backoff(attempt), req.options?.signal);
          continue;
        }
        throw err;
      }
      if (res.ok) return res;
      const error = await this.errorOf(res);
      const retryable =
        RETRYABLE_STATUS.has(res.status) || error.code === "IDEMPOTENCY_IN_PROGRESS";
      if (retryable && safe && attempt < this.maxRetries) {
        await sleep(
          Math.min(this.maxRetryDelayMs, error.retryAfterMs ?? this.backoff(attempt)),
          req.options?.signal,
        );
        continue;
      }
      throw error;
    }
  }

  /** Send a request and parse the JSON response. */
  async request<T>(req: RawRequest): Promise<T> {
    const res = await this.raw(req);
    const text = await res.text();
    try {
      return JSON.parse(text) as T;
    } catch (cause) {
      throw new DesynApiError({
        status: res.status,
        code: "INVALID_RESPONSE",
        message: "The API returned a response that is not JSON.",
        requestId: res.headers.get("x-request-id") ?? undefined,
        cause,
      });
    }
  }

  private backoff(attempt: number): number {
    return Math.min(this.maxRetryDelayMs, 500 * 2 ** attempt + Math.floor(Math.random() * 250));
  }

  private async fetchOnce(
    url: URL,
    init: RequestInit,
    options?: RequestOptions,
  ): Promise<Response> {
    const controller = new AbortController();
    const timeout = options?.timeoutMs ?? this.timeoutMs;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeout);
    const outer = options?.signal;
    const onAbort = () => controller.abort(outer?.reason);
    if (outer) {
      if (outer.aborted) controller.abort(outer.reason);
      else outer.addEventListener("abort", onAbort, { once: true });
    }
    try {
      return await this.fetchImpl(url.toString(), { ...init, signal: controller.signal });
    } catch (cause) {
      if (outer?.aborted) throw cause;
      throw new DesynApiError({
        status: 0,
        code: timedOut ? "TIMEOUT" : "NETWORK_ERROR",
        message: timedOut
          ? `The request timed out after ${timeout} ms.`
          : "The API could not be reached.",
        cause,
      });
    } finally {
      clearTimeout(timer);
      outer?.removeEventListener("abort", onAbort);
    }
  }

  private async errorOf(res: Response): Promise<DesynApiError> {
    const requestId = res.headers.get("x-request-id") ?? undefined;
    let body: { error?: { code?: string; message?: string; [k: string]: unknown } } | undefined;
    try {
      body = (await res.json()) as typeof body;
    } catch {
      body = undefined;
    }
    const err = body?.error;
    const retryAfter = res.headers.get("retry-after");
    const details: Record<string, unknown> = {};
    if (err) {
      for (const [k, v] of Object.entries(err)) {
        if (k !== "code" && k !== "message" && k !== "requestId") details[k] = v;
      }
    }
    if (details.retryAfterMs === undefined && retryAfter && /^\d+$/.test(retryAfter)) {
      details.retryAfterMs = Number(retryAfter) * 1000;
    }
    return new DesynApiError({
      status: res.status,
      code:
        (err?.code as ApiErrorCode | undefined) ??
        (res.status >= 500 ? "INTERNAL" : "INVALID_RESPONSE"),
      message: err?.message ?? `The API answered ${res.status}.`,
      details,
      requestId: (err?.requestId as string | undefined) ?? requestId,
    });
  }

  private async *paginate<T>(
    fetchPage: (cursor: string | undefined) => Promise<Page<T>>,
  ): AsyncGenerator<T, void, undefined> {
    let cursor: string | undefined;
    for (;;) {
      const page = await fetchPage(cursor);
      for (const item of page.items) yield item;
      if (!page.nextCursor) return;
      cursor = page.nextCursor;
    }
  }

  // --- account -----------------------------------------------------------------------------------------------

  me(options?: RequestOptions): Promise<Me> {
    return this.request({ method: "GET", path: "/me", ...(options ? { options } : {}) });
  }

  async workspaces(options?: RequestOptions): Promise<Workspace[]> {
    const out = await this.request<{ items: Workspace[] }>({
      method: "GET",
      path: "/workspaces",
      ...(options ? { options } : {}),
    });
    return out.items;
  }

  credits(options?: RequestOptions): Promise<Credits> {
    return this.request({ method: "GET", path: "/credits", ...(options ? { options } : {}) });
  }

  usage(options?: RequestOptions): Promise<Usage> {
    return this.request({ method: "GET", path: "/usage", ...(options ? { options } : {}) });
  }

  // --- designs -----------------------------------------------------------------------------------------------

  readonly designs = {
    list: (query: ListDesignsQuery = {}, options?: RequestOptions): Promise<Page<DesignSummary>> =>
      this.request({
        method: "GET",
        path: "/designs",
        query: { ...query },
        ...(options ? { options } : {}),
      }),
    /** Every design matching the query, following `nextCursor`. */
    all: (query: Omit<ListDesignsQuery, "cursor"> = {}): AsyncGenerator<DesignSummary> =>
      this.paginate((cursor) => this.designs.list({ ...query, ...(cursor ? { cursor } : {}) })),
    create: (input: CreateDesignInput, options?: RequestOptions): Promise<CreatedDesign> =>
      this.request({
        method: "POST",
        path: "/designs",
        body: input,
        idempotent: true,
        ...(options ? { options } : {}),
      }),
    get: (designId: string, options?: RequestOptions): Promise<DesignSummary> =>
      this.request({
        method: "GET",
        path: buildPath("/designs/{designId}", { designId }),
        ...(options ? { options } : {}),
      }),
    update: (
      designId: string,
      input: UpdateDesignInput,
      options?: RequestOptions,
    ): Promise<DesignSummary> =>
      this.request({
        method: "PATCH",
        path: buildPath("/designs/{designId}", { designId }),
        body: input,
        ...(options ? { options } : {}),
      }),
    archive: (designId: string, options?: RequestOptions): Promise<DesignSummary> =>
      this.request({
        method: "POST",
        path: buildPath("/designs/{designId}/archive", { designId }),
        ...(options ? { options } : {}),
      }),
    restore: (designId: string, options?: RequestOptions): Promise<DesignSummary> =>
      this.request({
        method: "POST",
        path: buildPath("/designs/{designId}/restore", { designId }),
        ...(options ? { options } : {}),
      }),
    /** Move to the trash; `{ permanent: true }` on a trashed design deletes it now. */
    delete: (
      designId: string,
      opts: { permanent?: boolean } = {},
      options?: RequestOptions,
    ): Promise<DeletedDesign> =>
      this.request({
        method: "DELETE",
        path: buildPath("/designs/{designId}", { designId }),
        query: opts.permanent ? { permanent: true } : {},
        ...(options ? { options } : {}),
      }),
    /** The full Design document and the seq it reflects. */
    load: (
      designId: string,
      opts: { pageId?: string } = {},
      options?: RequestOptions,
    ): Promise<DesignDocument> =>
      this.request({
        method: "GET",
        path: buildPath("/designs/{designId}/document", { designId }),
        query: { pageId: opts.pageId },
        ...(options ? { options } : {}),
      }),
    /**
     * Commit a transaction. Idempotent on `tx.id`; without one, the request's Idempotency-Key (generated per
     * call) derives it, so automatic retries never apply the change twice.
     */
    commit: (
      designId: string,
      input: CommitInput,
      options?: RequestOptions,
    ): Promise<CommitResult> =>
      this.request({
        method: "POST",
        path: buildPath("/designs/{designId}/transactions", { designId }),
        body: {
          ...(input.baseSeq !== undefined ? { baseSeq: input.baseSeq } : {}),
          tx: txOf(input.tx),
        },
        idempotent: true,
        ...(options ? { options } : {}),
      }),
    transactions: (
      designId: string,
      query: { since: number; limit?: number },
      options?: RequestOptions,
    ): Promise<TransactionList> =>
      this.request({
        method: "GET",
        path: buildPath("/designs/{designId}/transactions", { designId }),
        query,
        ...(options ? { options } : {}),
      }),
    describe: (
      designId: string,
      query: DescribeQuery = {},
      options?: RequestOptions,
    ): Promise<Description> =>
      this.request({
        method: "GET",
        path: buildPath("/designs/{designId}/describe", { designId }),
        query: {
          pageId: query.pageId,
          selection:
            query.selection && query.selection.length > 0 ? query.selection.join(",") : undefined,
          maxDepth: query.maxDepth,
        },
        ...(options ? { options } : {}),
      }),
    /** Render a page (or region) and return the image bytes. */
    preview: async (
      designId: string,
      input: PreviewInput = {},
      options?: RequestOptions,
    ): Promise<{ bytes: Uint8Array; contentType: string; seq: number; pageId: string | null }> => {
      const res = await this.raw({
        method: "POST",
        path: buildPath("/designs/{designId}/preview", { designId }),
        body: input,
        accept: "image/*",
        ...(options ? { options } : {}),
      });
      return {
        bytes: new Uint8Array(await res.arrayBuffer()),
        contentType: res.headers.get("content-type") ?? "image/png",
        seq: Number(res.headers.get("x-desyn-seq") ?? "0"),
        pageId: res.headers.get("x-desyn-page"),
      };
    },
    applyBrand: (
      designId: string,
      input: ApplyBrandInput = {},
      options?: RequestOptions,
    ): Promise<ApplyBrandResult> =>
      this.request({
        method: "POST",
        path: buildPath("/designs/{designId}/apply-brand", { designId }),
        body: input,
        idempotent: true,
        ...(options ? { options } : {}),
      }),
  };

  readonly folders = {
    list: async (options?: RequestOptions): Promise<Folder[]> =>
      (
        await this.request<{ items: Folder[] }>({
          method: "GET",
          path: "/folders",
          ...(options ? { options } : {}),
        })
      ).items,
  };

  // --- exports -----------------------------------------------------------------------------------------------

  readonly exports = {
    request: (designId: string, input: ExportInput, options?: RequestOptions): Promise<ExportJob> =>
      this.request({
        method: "POST",
        path: buildPath("/designs/{designId}/exports", { designId }),
        body: input,
        idempotent: true,
        ...(options ? { options } : {}),
      }),
    get: (exportId: string, options?: RequestOptions): Promise<ExportJob> =>
      this.request({
        method: "GET",
        path: buildPath("/exports/{exportId}", { exportId }),
        ...(options ? { options } : {}),
      }),
    /** Poll until the job is ready; throws when it fails or expires. */
    wait: async (
      exportId: string,
      opts: { intervalMs?: number; timeoutMs?: number; signal?: AbortSignal } = {},
    ): Promise<ExportJob> => {
      const deadline = Date.now() + (opts.timeoutMs ?? 10 * 60_000);
      let interval = opts.intervalMs ?? 1_000;
      for (;;) {
        const job = await this.exports.get(
          exportId,
          opts.signal ? { signal: opts.signal } : undefined,
        );
        if (job.status === "ready") return job;
        if (job.status === "failed" || job.status === "expired") {
          throw new DesynApiError({
            status: 409,
            code: "CONFLICT",
            message: job.error ?? `The export ${job.status}.`,
            details: { exportId, status: job.status },
          });
        }
        if (Date.now() + interval > deadline) {
          throw new DesynApiError({
            status: 0,
            code: "TIMEOUT",
            message: "The export did not finish in time.",
          });
        }
        await sleep(interval, opts.signal);
        interval = Math.min(interval * 1.5, 10_000);
      }
    },
  };

  // --- assets ------------------------------------------------------------------------------------------------

  readonly assets = {
    list: (query: ListAssetsQuery = {}, options?: RequestOptions): Promise<Page<Asset>> =>
      this.request({
        method: "GET",
        path: "/assets",
        query: { ...query },
        ...(options ? { options } : {}),
      }),
    all: (query: Omit<ListAssetsQuery, "cursor"> = {}): AsyncGenerator<Asset> =>
      this.paginate((cursor) => this.assets.list({ ...query, ...(cursor ? { cursor } : {}) })),
    get: (assetId: string, options?: RequestOptions): Promise<Asset> =>
      this.request({
        method: "GET",
        path: buildPath("/assets/{assetId}", { assetId }),
        ...(options ? { options } : {}),
      }),
    rename: (assetId: string, name: string, options?: RequestOptions): Promise<Asset> =>
      this.request({
        method: "PATCH",
        path: buildPath("/assets/{assetId}", { assetId }),
        body: { name },
        ...(options ? { options } : {}),
      }),
    delete: (assetId: string, options?: RequestOptions): Promise<{ deleted: true }> =>
      this.request({
        method: "DELETE",
        path: buildPath("/assets/{assetId}", { assetId }),
        ...(options ? { options } : {}),
      }),
    requestUpload: (input: UploadRequestInput, options?: RequestOptions): Promise<UploadTicket> =>
      this.request({
        method: "POST",
        path: "/assets/uploads",
        body: input,
        idempotent: true,
        ...(options ? { options } : {}),
      }),
    finalize: (
      assetId: string,
      input: { media?: { width?: number; height?: number; durationMs?: number } } = {},
      options?: RequestOptions,
    ): Promise<Asset> =>
      this.request({
        method: "POST",
        path: buildPath("/assets/{assetId}/finalize", { assetId }),
        body: input,
        ...(options ? { options } : {}),
      }),
    /**
     * Upload bytes in one call: request a presigned PUT (identical files are deduplicated by sha256), PUT the
     * bytes to storage, finalize. Returns the ready asset with its `assetRef`.
     */
    upload: async (
      data: Uint8Array | ArrayBuffer | Blob,
      meta: Omit<UploadRequestInput, "bytes" | "sha256"> & {
        media?: { width?: number; height?: number; durationMs?: number };
      },
      options?: RequestOptions,
    ): Promise<Asset> => {
      const bytes =
        data instanceof Uint8Array
          ? data
          : data instanceof ArrayBuffer
            ? new Uint8Array(data)
            : new Uint8Array(await data.arrayBuffer());
      const digest = new Uint8Array(
        await globalThis.crypto.subtle.digest("SHA-256", bytes as BufferSource),
      );
      const sha256 = Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
      const { media, ...rest } = meta;
      const ticket = await this.assets.requestUpload(
        { ...rest, bytes: bytes.length, sha256 },
        options,
      );
      if (ticket.upload) {
        let res: Response;
        try {
          res = await this.fetchImpl(ticket.upload.url, {
            method: "PUT",
            headers: ticket.upload.headers,
            body: bytes as BodyInit,
            ...(options?.signal ? { signal: options.signal } : {}),
          });
        } catch (cause) {
          throw new DesynApiError({
            status: 0,
            code: "NETWORK_ERROR",
            message: "The upload to storage failed.",
            cause,
          });
        }
        if (!res.ok) {
          throw new DesynApiError({
            status: res.status,
            code: "UPSTREAM_UNAVAILABLE",
            message: `Storage rejected the upload (${res.status}).`,
          });
        }
        return await this.assets.finalize(ticket.assetId, media ? { media } : {}, options);
      }
      return await this.assets.get(ticket.assetId, options);
    },
  };

  // --- templates ---------------------------------------------------------------------------------------------

  readonly templates = {
    search: (query: TemplateSearchQuery = {}, options?: RequestOptions): Promise<Page<Template>> =>
      this.request({
        method: "GET",
        path: "/templates",
        query: { ...query },
        ...(options ? { options } : {}),
      }),
    get: (template: string, options?: RequestOptions): Promise<TemplateDetail> =>
      this.request({
        method: "GET",
        path: buildPath("/templates/{template}", { template }),
        ...(options ? { options } : {}),
      }),
    instantiate: (
      template: string,
      input: InstantiateInput = {},
      options?: RequestOptions,
    ): Promise<InstantiatedDesign> =>
      this.request({
        method: "POST",
        path: buildPath("/templates/{template}/instantiate", { template }),
        body: input,
        idempotent: true,
        ...(options ? { options } : {}),
      }),
  };

  // --- brand kits --------------------------------------------------------------------------------------------

  readonly brandKits = {
    list: async (options?: RequestOptions): Promise<BrandKit[]> =>
      (
        await this.request<{ items: BrandKit[] }>({
          method: "GET",
          path: "/brand-kits",
          ...(options ? { options } : {}),
        })
      ).items,
    get: (brandKitId: string, options?: RequestOptions): Promise<BrandKit> =>
      this.request({
        method: "GET",
        path: buildPath("/brand-kits/{brandKitId}", { brandKitId }),
        ...(options ? { options } : {}),
      }),
    create: (input: CreateBrandKitInput, options?: RequestOptions): Promise<BrandKit> =>
      this.request({
        method: "POST",
        path: "/brand-kits",
        body: input,
        idempotent: true,
        ...(options ? { options } : {}),
      }),
    update: (
      brandKitId: string,
      input: UpdateBrandKitInput,
      options?: RequestOptions,
    ): Promise<BrandKit> =>
      this.request({
        method: "PATCH",
        path: buildPath("/brand-kits/{brandKitId}", { brandKitId }),
        body: input,
        ...(options ? { options } : {}),
      }),
    delete: (brandKitId: string, options?: RequestOptions): Promise<{ deleted: true }> =>
      this.request({
        method: "DELETE",
        path: buildPath("/brand-kits/{brandKitId}", { brandKitId }),
        ...(options ? { options } : {}),
      }),
  };

  // --- AI ----------------------------------------------------------------------------------------------------

  readonly agent = {
    /** Start the server-side agent on a design. */
    start: (designId: string, input: StartRunInput, options?: RequestOptions): Promise<AiRun> =>
      this.request({
        method: "POST",
        path: buildPath("/designs/{designId}/agent-runs", { designId }),
        body: input,
        idempotent: true,
        ...(options ? { options } : {}),
      }),
    get: (runId: string, options?: RequestOptions): Promise<AiRun> =>
      this.request({
        method: "GET",
        path: buildPath("/agent-runs/{runId}", { runId }),
        ...(options ? { options } : {}),
      }),
    /** One page of events after `after` (long-polls up to `wait` seconds). */
    eventsPage: (
      runId: string,
      query: { after?: number; wait?: number; limit?: number } = {},
      options?: RequestOptions,
    ): Promise<AiRunEventPage> => {
      // Long-polls hold the request open; give them room beyond the wait.
      const timeoutMs = query.wait ? Math.max(this.timeoutMs, (query.wait + 15) * 1000) : undefined;
      return this.request({
        method: "GET",
        path: buildPath("/agent-runs/{runId}/events", { runId }),
        query,
        options: { ...options, ...(timeoutMs ? { timeoutMs } : {}) },
      });
    },
    /**
     * Every event of a run until it finishes, in order. Uses Server-Sent Events (`stream: true`, default)
     * and resumes after disconnects; `stream: false` long-polls JSON pages instead.
     */
    events: (
      runId: string,
      opts: { after?: number; stream?: boolean; signal?: AbortSignal } = {},
    ): AsyncGenerator<AiRunEvent> => this.runEvents(runId, opts),
    answer: (runId: string, answer: string, options?: RequestOptions): Promise<AiRun> =>
      this.request({
        method: "POST",
        path: buildPath("/agent-runs/{runId}/answer", { runId }),
        body: { answer },
        idempotent: true,
        ...(options ? { options } : {}),
      }),
    cancel: (runId: string, options?: RequestOptions): Promise<AiRun> =>
      this.request({
        method: "POST",
        path: buildPath("/agent-runs/{runId}/cancel", { runId }),
        ...(options ? { options } : {}),
      }),
    /**
     * Wait until the run finishes or asks a question (status needs-input). Polls with long-poll events so it
     * returns promptly; `timeoutMs` default 10 minutes.
     */
    wait: async (
      runId: string,
      opts: { timeoutMs?: number; signal?: AbortSignal } = {},
    ): Promise<AiRun> => {
      const deadline = Date.now() + (opts.timeoutMs ?? 10 * 60_000);
      let after = -1;
      for (;;) {
        const run = await this.agent.get(runId, opts.signal ? { signal: opts.signal } : undefined);
        if (isTerminalRunStatus(run.status) || run.status === "needs-input") return run;
        const left = deadline - Date.now();
        if (left <= 0)
          throw new DesynApiError({
            status: 0,
            code: "TIMEOUT",
            message: "The run did not finish in time.",
          });
        const page = await this.agent.eventsPage(
          runId,
          { after, wait: Math.max(1, Math.min(25, Math.floor(left / 1000))) },
          opts.signal ? { signal: opts.signal } : undefined,
        );
        after = page.next;
      }
    },
  };

  readonly ai = {
    /** Run one asset tool (image, svg, remove-background, …); poll the returned run with `agent.wait`. */
    generateAsset: (input: GenerateAssetInput, options?: RequestOptions): Promise<AiRun> =>
      this.request({
        method: "POST",
        path: "/assets/generate",
        body: input,
        idempotent: true,
        ...(options ? { options } : {}),
      }),
    models: (task?: string, options?: RequestOptions): Promise<ModelList> =>
      this.request({
        method: "GET",
        path: "/ai/models",
        query: { task },
        ...(options ? { options } : {}),
      }),
  };

  readonly workflows = {
    start: (input: StartWorkflowInput, options?: RequestOptions): Promise<Workflow> =>
      this.request({
        method: "POST",
        path: "/workflows",
        body: input,
        idempotent: true,
        ...(options ? { options } : {}),
      }),
    get: (workflowId: string, options?: RequestOptions): Promise<Workflow> =>
      this.request({
        method: "GET",
        path: buildPath("/workflows/{workflowId}", { workflowId }),
        ...(options ? { options } : {}),
      }),
    /** Poll until the workflow completes, fails or is cancelled. */
    wait: async (
      workflowId: string,
      opts: { intervalMs?: number; timeoutMs?: number; signal?: AbortSignal } = {},
    ): Promise<Workflow> => {
      const deadline = Date.now() + (opts.timeoutMs ?? 30 * 60_000);
      let interval = opts.intervalMs ?? 2_000;
      for (;;) {
        const wf = await this.workflows.get(
          workflowId,
          opts.signal ? { signal: opts.signal } : undefined,
        );
        if (wf.status === "completed" || wf.status === "failed" || wf.status === "cancelled")
          return wf;
        if (Date.now() + interval > deadline) {
          throw new DesynApiError({
            status: 0,
            code: "TIMEOUT",
            message: "The workflow did not finish in time.",
          });
        }
        await sleep(interval, opts.signal);
        interval = Math.min(interval * 1.5, 15_000);
      }
    },
  };

  private async *runEvents(
    runId: string,
    opts: { after?: number; stream?: boolean; signal?: AbortSignal },
  ): AsyncGenerator<AiRunEvent> {
    let after = opts.after ?? -1;
    const path = buildPath("/agent-runs/{runId}/events", { runId });
    for (;;) {
      if (opts.stream === false) {
        const page = await this.agent.eventsPage(
          runId,
          { after, wait: 25 },
          opts.signal ? { signal: opts.signal } : undefined,
        );
        for (const event of page.items) {
          after = event.index;
          yield event;
        }
        if (page.done) return;
        continue;
      }
      const res = await this.raw({
        method: "GET",
        path,
        query: { after },
        accept: "text/event-stream",
        options: { ...(opts.signal ? { signal: opts.signal } : {}), timeoutMs: 120_000 },
      });
      if (!res.body)
        throw new DesynApiError({
          status: res.status,
          code: "INVALID_RESPONSE",
          message: "The event stream has no body.",
        });
      let ended = false;
      for await (const message of parseSse(res.body)) {
        // Control events have their own names; a run's own `error` event is ordinary data.
        if (message.event === "stream-end") {
          ended = true;
          break;
        }
        if (message.event === "stream-error") {
          const data = JSON.parse(message.data) as { code?: string; message?: string };
          throw new DesynApiError({
            status: 502,
            code: (data.code as ApiErrorCode | undefined) ?? "UPSTREAM_UNAVAILABLE",
            message: data.message ?? "The event stream failed.",
          });
        }
        const event = JSON.parse(message.data) as AiRunEvent;
        after = event.index;
        yield event;
      }
      if (ended) return;
      // The server closes long streams after about a minute: reconnect after the last event.
    }
  }
}
