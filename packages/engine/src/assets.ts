// Asset byte loading: presigned / public URLs fetched with bounded concurrency, timeouts and retries on
// transient failures. Decoding happens in the engine (`setAsset`), which reports undecodable bytes.

export interface AssetLoaderOptions {
  /** Parallel downloads (default 6). */
  concurrency?: number;
  /** Per-request timeout (ms, default 30 s). */
  timeoutMs?: number;
  /** Retries after network errors / 408 / 429 / 5xx (default 2). */
  retries?: number;
  /** Largest accepted body (bytes, default 256 MiB). */
  maxBytes?: number;
  fetch?: typeof fetch;
}

export class AssetFetchError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "AssetFetchError";
  }
}

const RETRY_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

export class AssetLoader {
  private readonly opts: Required<AssetLoaderOptions>;
  private active = 0;
  private readonly queue: (() => void)[] = [];

  constructor(options: AssetLoaderOptions = {}) {
    this.opts = {
      concurrency: options.concurrency ?? 6,
      timeoutMs: options.timeoutMs ?? 30000,
      retries: options.retries ?? 2,
      maxBytes: options.maxBytes ?? 256 * 1024 * 1024,
      fetch: options.fetch ?? ((input, init) => fetch(input, init)),
    };
  }

  /** Downloads a URL (`data:` and `blob:` URLs too). */
  async load(url: string, signal?: AbortSignal): Promise<Uint8Array> {
    await this.acquire();
    try {
      let attempt = 0;
      for (;;) {
        try {
          return await this.once(url, signal);
        } catch (e) {
          const status = e instanceof AssetFetchError ? e.status : undefined;
          const transient =
            status === undefined ? !(signal?.aborted ?? false) : RETRY_STATUS.has(status);
          if (!transient || attempt >= this.opts.retries) throw e;
          attempt += 1;
          await new Promise((r) => setTimeout(r, 250 * 2 ** attempt));
        }
      }
    } finally {
      this.release();
    }
  }

  private async once(url: string, signal?: AbortSignal): Promise<Uint8Array> {
    const ctrl = new AbortController();
    const abort = () => ctrl.abort();
    signal?.addEventListener("abort", abort);
    const timer = setTimeout(abort, this.opts.timeoutMs);
    try {
      let res: Response;
      try {
        res = await this.opts.fetch(url, { signal: ctrl.signal, credentials: "omit" });
      } catch (e) {
        throw new AssetFetchError(`fetch failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      if (!res.ok) throw new AssetFetchError(`HTTP ${res.status}`, res.status);
      const length = Number(res.headers.get("content-length") ?? "0");
      if (length > this.opts.maxBytes)
        throw new AssetFetchError(`asset is ${length} bytes (limit ${this.opts.maxBytes})`, 413);
      const buf = await res.arrayBuffer();
      if (buf.byteLength > this.opts.maxBytes) {
        throw new AssetFetchError(
          `asset is ${buf.byteLength} bytes (limit ${this.opts.maxBytes})`,
          413,
        );
      }
      return new Uint8Array(buf);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.opts.concurrency) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.queue.push(() => {
        this.active += 1;
        resolve();
      });
    });
  }

  private release(): void {
    this.active -= 1;
    this.queue.shift()?.();
  }
}
