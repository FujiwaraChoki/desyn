import type { Design, Id as DocId } from "@desyn/schema";
import { env } from "./env";

// Client for the render worker (crates/desyn-worker, DOCUMENT_MODEL §8). Internal service authenticated with
// the shared secret header `x-desyn-secret`. Large designs are sent gzip-compressed when a compressor is given.

/** Export formats rendered as one file for all selected pages (`pageId: "all"`). */
export const MULTI_PAGE_FORMATS: ReadonlySet<string> = new Set(["pdf", "pptx", "gif", "mp4"]);

export class WorkerError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

export interface WorkerConfig {
  url: string;
  secret?: string;
}

export function workerConfig(): WorkerConfig | null {
  const url = env.get("RENDER_WORKER_URL");
  if (!url) return null;
  const secret = env.get("RENDER_WORKER_SECRET");
  return { url: url.replace(/\/+$/, ""), ...(secret ? { secret } : {}) };
}

export interface WorkerCallOptions {
  /** Compressor used for bodies above `gzipAbove` bytes (Node actions pass zlib gzip). */
  gzip?: (bytes: Uint8Array) => Uint8Array;
  gzipAbove?: number;
  timeoutMs?: number;
}

export async function callWorker(
  path: string,
  body: unknown,
  opts: WorkerCallOptions = {},
): Promise<{ bytes: Uint8Array; contentType: string }> {
  const cfg = workerConfig();
  if (!cfg) throw new WorkerError("The render worker is not configured.", 0, false);
  const json = new TextEncoder().encode(JSON.stringify(body));
  const headers: Record<string, string> = { "content-type": "application/json", accept: "*/*" };
  if (cfg.secret) headers["x-desyn-secret"] = cfg.secret;
  let payload: Uint8Array = json;
  if (opts.gzip && json.length > (opts.gzipAbove ?? 1_000_000)) {
    payload = opts.gzip(json);
    headers["content-encoding"] = "gzip";
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 120_000);
  let res: Response;
  try {
    res = await fetch(`${cfg.url}${path}`, {
      method: "POST",
      headers,
      body: payload as BodyInit,
      signal: controller.signal,
    });
  } catch (err) {
    throw new WorkerError(
      `The render worker is unreachable: ${err instanceof Error ? err.message : String(err)}`,
      0,
      true,
    );
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const text = (await res.text().catch(() => "")).slice(0, 300);
    throw new WorkerError(
      `The render worker returned ${res.status}${text ? `: ${text}` : ""}`,
      res.status,
      res.status >= 500 || res.status === 429,
    );
  }
  return {
    bytes: new Uint8Array(await res.arrayBuffer()),
    contentType: res.headers.get("content-type") ?? "application/octet-stream",
  };
}

/** Copy of the design with resolvable `AssetRef.url`s filled in (never persisted). */
export function withAssetUrls(design: Design, urls: Record<DocId, string>): Design {
  const assets: Design["assets"] = {};
  for (const [id, asset] of Object.entries(design.assets)) {
    const url = urls[id];
    assets[id] = url ? { ...asset, url } : asset;
  }
  return { ...design, assets };
}

/** Copy of the design that keeps only the given pages (in the given order), for multi-page exports. */
export function withPages(design: Design, pageIds: DocId[]): Design {
  const root = design.nodes.root as Design["nodes"][string] & { children: DocId[] };
  const keep = new Set(pageIds.filter((id) => root.children.includes(id)));
  const nodes: Design["nodes"] = {};
  const stack = [...keep];
  while (stack.length > 0) {
    const id = stack.pop() as DocId;
    const node = design.nodes[id];
    if (!node) continue;
    nodes[id] = node;
    for (const kid of (node as { children?: DocId[] }).children ?? []) stack.push(kid);
  }
  nodes.root = {
    ...root,
    children: pageIds.filter((id) => keep.has(id)),
  } as Design["nodes"][string];
  return { ...design, nodes };
}
