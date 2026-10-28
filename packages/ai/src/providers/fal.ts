// fal.ai transport for specialised endpoints (background removal, fill, expand, upscale, vectorize, video, speech)
// that do not map onto the AI SDK's generic image API. Uses the official queue client so long jobs survive slow
// models. The API key is always passed explicitly (never read from FAL_KEY by the client library).
import { ApiError, createFalClient, ValidationError } from "@fal-ai/client";
import { AiError } from "../errors";
import type { FetchLike } from "../util/async";

export interface FalQueueUpdate {
  status: "IN_QUEUE" | "IN_PROGRESS" | "COMPLETED";
  position?: number;
  logs?: string[];
}

export interface FalRunOptions {
  signal?: AbortSignal;
  onQueueUpdate?: (update: FalQueueUpdate) => void;
}

export interface FalRunResult<T> {
  data: T;
  requestId: string;
}

/** Minimal surface the media layer needs; tests inject an in-memory implementation. */
export interface FalTransport {
  run<T = unknown>(
    endpointId: string,
    input: Record<string, unknown>,
    options?: FalRunOptions,
  ): Promise<FalRunResult<T>>;
}

export interface FalTransportOptions {
  apiKey?: string;
  /** Proxy route (browser BYOK-less mode): requests go through the app server which adds the key. */
  proxyUrl?: string;
  fetch?: FetchLike;
  /** Poll interval for queue status in ms (default 1000; polling works everywhere, unlike SSE). */
  pollIntervalMs?: number;
}

export function createFalTransport(options: FalTransportOptions): FalTransport {
  if (!options.apiKey && !options.proxyUrl) {
    throw new AiError(
      "provider-not-configured",
      "fal needs an API key (FAL_AI_API_KEY) or a proxy URL",
    );
  }
  const config: Parameters<typeof createFalClient>[0] = {
    // Explicit resolver: never fall back to process.env.FAL_KEY inside the client library.
    credentials: () => options.apiKey,
    suppressLocalCredentialsWarning: true,
  };
  if (options.proxyUrl) config.proxyUrl = { url: options.proxyUrl, when: "always" };
  if (options.fetch) config.fetch = options.fetch as typeof fetch;
  const client = createFalClient(config);
  return {
    async run<T>(
      endpointId: string,
      input: Record<string, unknown>,
      runOptions: FalRunOptions = {},
    ) {
      try {
        const result = await client.subscribe(endpointId, {
          input,
          mode: "polling",
          pollInterval: options.pollIntervalMs ?? 1000,
          logs: runOptions.onQueueUpdate !== undefined,
          ...(runOptions.signal ? { abortSignal: runOptions.signal } : {}),
          onQueueUpdate: (status) => {
            runOptions.onQueueUpdate?.({
              status: status.status,
              ...(status.status === "IN_QUEUE" ? { position: status.queue_position } : {}),
              ...(status.status !== "IN_QUEUE"
                ? { logs: (status.logs ?? []).map((l) => l.message) }
                : {}),
            });
          },
        });
        return { data: result.data as T, requestId: result.requestId };
      } catch (error) {
        throw toAiError(endpointId, error);
      }
    },
  };
}

function toAiError(endpointId: string, error: unknown): unknown {
  if (error instanceof ValidationError) {
    const fields = error.fieldErrors.map((f) => `${f.loc.join(".")}: ${f.msg}`).join("; ");
    return new AiError("invalid-input", `fal ${endpointId} rejected the input: ${fields}`, {
      endpointId,
      status: error.status,
    });
  }
  if (error instanceof ApiError) {
    const code =
      error.status === 401 || error.status === 403 ? "provider-not-configured" : "provider-error";
    return new AiError(code, `fal ${endpointId} failed (${error.status}): ${error.message}`, {
      endpointId,
      status: error.status,
    });
  }
  return error;
}
