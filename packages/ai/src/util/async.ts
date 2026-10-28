// Cancellation, retry and small caching helpers shared by providers, media and the agent.

export class AbortError extends Error {
  constructor(message = "The operation was aborted") {
    super(message);
    this.name = "AbortError";
  }
}

export function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" || error.name === "TimeoutError" || error instanceof AbortError)
  );
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    const reason = signal.reason;
    throw reason instanceof Error ? reason : new AbortError();
  }
}

/** Resolves after `ms`, rejecting early with an AbortError when `signal` aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new AbortError());
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new AbortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Runs `tasks` with at most `limit` in flight, preserving result order. */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index] as T, index);
    }
  });
  await Promise.all(workers);
  return results;
}

interface Entry<V> {
  value: V;
  expiresAt: number;
}

/** In-memory TTL cache with in-flight de-duplication (concurrent `get`s for one key share one load). */
export class TtlCache<V> {
  private readonly entries = new Map<string, Entry<V>>();
  private readonly inflight = new Map<string, Promise<V>>();

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Fresh value or undefined; expired entries are kept as stale fallbacks. */
  peek(key: string): V | undefined {
    const entry = this.entries.get(key);
    if (!entry || entry.expiresAt <= this.now()) return undefined;
    return entry.value;
  }

  /** Last stored value even when expired (used as a stale fallback when a refresh fails). */
  stale(key: string): V | undefined {
    return this.entries.get(key)?.value;
  }

  set(key: string, value: V, ttlMs = this.ttlMs): void {
    this.entries.set(key, { value, expiresAt: this.now() + ttlMs });
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }

  async get(key: string, load: () => Promise<V>): Promise<V> {
    const hit = this.peek(key);
    if (hit !== undefined) return hit;
    return this.refresh(key, load);
  }

  /** Loads and stores a new value even when a fresh one exists (shares an in-flight load). */
  refresh(key: string, load: () => Promise<V>): Promise<V> {
    const pending = this.inflight.get(key);
    if (pending) return pending;
    const promise = load()
      .then((value) => {
        this.set(key, value);
        return value;
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, promise);
    return promise;
  }
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export function defaultFetch(): FetchLike {
  return (input, init) => globalThis.fetch(input, init);
}

/**
 * GET JSON with retries on 429 / 5xx honouring `Retry-After` (seconds) with capped exponential backoff.
 */
export async function fetchJson<T>(
  url: string,
  options: {
    fetch?: FetchLike;
    headers?: Record<string, string>;
    signal?: AbortSignal;
    retries?: number;
    maxDelayMs?: number;
  } = {},
): Promise<T> {
  const doFetch = options.fetch ?? defaultFetch();
  const retries = options.retries ?? 3;
  let attempt = 0;
  for (;;) {
    throwIfAborted(options.signal);
    const init: RequestInit = { headers: { accept: "application/json", ...options.headers } };
    if (options.signal) init.signal = options.signal;
    const res = await doFetch(url, init);
    if (res.ok) return (await res.json()) as T;
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt >= retries) {
      throw new HttpError(res.status, `GET ${redactUrl(url)} failed with ${res.status}`);
    }
    const retryAfter = Number.parseFloat(res.headers.get("retry-after") ?? "");
    const backoff = Number.isFinite(retryAfter) ? retryAfter * 1000 : 500 * 2 ** attempt;
    await sleep(Math.min(backoff, options.maxDelayMs ?? 30_000), options.signal);
    attempt++;
  }
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

/** Strips query strings (which may carry keys) from URLs before they reach logs or errors. */
export function redactUrl(url: string): string {
  const q = url.indexOf("?");
  return q < 0 ? url : `${url.slice(0, q)}?…`;
}
