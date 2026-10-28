// A small typed RPC over postMessage (Worker, MessagePort, or an in-process pair for the main-thread fallback):
// request / response with ids, error propagation, transferables both ways, fire-and-forget calls and events.

/** Anything with postMessage + message events (Worker, DedicatedWorkerGlobalScope, MessagePort). */
export interface Endpoint {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  removeEventListener(type: "message", listener: (event: MessageEvent) => void): void;
}

type Wire =
  | { t: "req"; id: number; m: string; a: unknown[] }
  | { t: "cast"; m: string; a: unknown[] }
  | { t: "res"; id: number; ok: true; v: unknown }
  | { t: "res"; id: number; ok: false; e: SerializedError }
  | { t: "evt"; n: string; v: unknown };

interface SerializedError {
  name: string;
  message: string;
  stack?: string;
}

const TRANSFER = Symbol("desyn.transfer");

interface Transferring<T> {
  [TRANSFER]: Transferable[];
  value: T;
}

/** Marks a value to be sent with transferables (zero-copy ArrayBuffers, OffscreenCanvas). */
export function transfer<T>(value: T, transferables: Transferable[]): T {
  const wrapped: Transferring<T> = { [TRANSFER]: transferables, value };
  return wrapped as unknown as T;
}

function unwrap(value: unknown): { value: unknown; transfer: Transferable[] } {
  if (value !== null && typeof value === "object" && TRANSFER in value) {
    const w = value as Transferring<unknown>;
    return { value: w.value, transfer: w[TRANSFER] };
  }
  return { value, transfer: [] };
}

function unwrapArgs(args: unknown[]): { args: unknown[]; transfer: Transferable[] } {
  const out: unknown[] = [];
  const all: Transferable[] = [];
  for (const a of args) {
    const u = unwrap(a);
    out.push(u.value);
    all.push(...u.transfer);
  }
  return { args: out, transfer: all };
}

function serializeError(e: unknown): SerializedError {
  if (e instanceof Error) return { name: e.name, message: e.message, stack: e.stack };
  return { name: "Error", message: String(e) };
}

/** Error thrown on the caller's side for a failed remote call (keeps the remote name and stack). */
export class RemoteError extends Error {
  readonly remoteStack: string | undefined;
  constructor(e: SerializedError) {
    super(e.message);
    this.name = e.name === "Error" ? "RemoteError" : e.name;
    this.remoteStack = e.stack;
  }
}

/** Methods of `T` as async calls. */
export type Remote<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R
    ? (...args: A) => Promise<Awaited<R>>
    : never;
};

// Event name -> payload (an interface; no index signature needed).
export type EventMap = object;

export interface RpcClient<T, E extends EventMap> {
  /** Calls a remote method. */
  call<K extends keyof T & string>(
    method: K,
    ...args: T[K] extends (...a: infer A) => unknown ? A : never
  ): Promise<T[K] extends (...a: never[]) => infer R ? Awaited<R> : never>;
  /** Calls a remote method without waiting for (or receiving) a result. */
  cast<K extends keyof T & string>(
    method: K,
    ...args: T[K] extends (...a: infer A) => unknown ? A : never
  ): void;
  /** Typed proxy: `client.remote.load(json)`. */
  readonly remote: Remote<T>;
  on<K extends keyof E & string>(event: K, listener: (value: E[K]) => void): () => void;
  /** Rejects pending calls and detaches. */
  close(reason?: string): void;
  /** Number of calls awaiting a response. */
  readonly inFlight: number;
}

export function createRpcClient<T, E extends EventMap = EventMap>(
  endpoint: Endpoint,
): RpcClient<T, E> {
  let next = 1;
  let closed: string | null = null;
  const pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: unknown) => void }
  >();
  const listeners = new Map<string, Set<(v: unknown) => void>>();

  const onMessage = (event: MessageEvent) => {
    const msg = event.data as Wire;
    if (!msg || typeof msg !== "object") return;
    if (msg.t === "res") {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.v);
      else p.reject(new RemoteError(msg.e));
    } else if (msg.t === "evt") {
      for (const l of listeners.get(msg.n) ?? []) {
        try {
          l(msg.v);
        } catch (e) {
          // A failing listener must not break the channel; surface it asynchronously.
          queueMicrotask(() => {
            throw e;
          });
        }
      }
    }
  };
  endpoint.addEventListener("message", onMessage);

  const call = (method: string, ...rawArgs: unknown[]) => {
    if (closed) return Promise.reject(new Error(`engine channel closed: ${closed}`));
    const id = next++;
    const { args, transfer: t } = unwrapArgs(rawArgs);
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      try {
        endpoint.postMessage({ t: "req", id, m: method, a: args } satisfies Wire, t);
      } catch (e) {
        pending.delete(id);
        reject(e);
      }
    });
  };

  const cast = (method: string, ...rawArgs: unknown[]) => {
    if (closed) return;
    const { args, transfer: t } = unwrapArgs(rawArgs);
    endpoint.postMessage({ t: "cast", m: method, a: args } satisfies Wire, t);
  };

  const remote = new Proxy(
    {},
    {
      get(_target, prop) {
        if (typeof prop !== "string" || prop === "then") return undefined;
        return (...args: unknown[]) => call(prop, ...args);
      },
    },
  ) as Remote<T>;

  return {
    call: call as RpcClient<T, E>["call"],
    cast: cast as RpcClient<T, E>["cast"],
    remote,
    on(event, listener) {
      let set = listeners.get(event);
      if (!set) {
        set = new Set();
        listeners.set(event, set);
      }
      const l = listener as (v: unknown) => void;
      set.add(l);
      return () => set?.delete(l);
    },
    close(reason = "closed") {
      if (closed) return;
      closed = reason;
      endpoint.removeEventListener("message", onMessage);
      for (const p of pending.values()) p.reject(new Error(`engine channel closed: ${reason}`));
      pending.clear();
      listeners.clear();
    },
    get inFlight() {
      return pending.size;
    },
  };
}

export interface RpcServer<E extends EventMap> {
  /** Sends an event to the client. */
  emit<K extends keyof E & string>(event: K, value: E[K], transferables?: Transferable[]): void;
  close(): void;
}

/**
 * Serves `target`'s methods. Requests are handled in arrival order; async methods may interleave, which is fine
 * for the engine because every wasm call is synchronous inside the method.
 */
export function exposeRpc<E extends EventMap = EventMap>(
  target: object,
  endpoint: Endpoint,
  /** Methods callable from the other side (default: every public method; TS `private` is not enforced at runtime). */
  methods?: readonly string[],
): RpcServer<E> {
  const allowed = methods ? new Set(methods) : null;
  const onMessage = async (event: MessageEvent) => {
    const msg = event.data as Wire;
    if (!msg || typeof msg !== "object" || (msg.t !== "req" && msg.t !== "cast")) return;
    const fn = (target as Record<string, unknown>)[msg.m];
    if (
      typeof fn !== "function" ||
      msg.m.startsWith("_") ||
      msg.m === "constructor" ||
      (allowed !== null && !allowed.has(msg.m))
    ) {
      if (msg.t === "req") {
        endpoint.postMessage({
          t: "res",
          id: msg.id,
          ok: false,
          e: { name: "TypeError", message: `unknown method ${msg.m}` },
        } satisfies Wire);
      }
      return;
    }
    try {
      const result = await (fn as (...a: unknown[]) => unknown).apply(target, msg.a);
      if (msg.t === "req") {
        const { value, transfer: t } = unwrap(result);
        endpoint.postMessage({ t: "res", id: msg.id, ok: true, v: value } satisfies Wire, t);
      }
    } catch (e) {
      if (msg.t === "req") {
        endpoint.postMessage({
          t: "res",
          id: msg.id,
          ok: false,
          e: serializeError(e),
        } satisfies Wire);
      } else {
        endpoint.postMessage({
          t: "evt",
          n: "warning",
          v: { message: `${msg.m} failed: ${serializeError(e).message}` },
        } satisfies Wire);
      }
    }
  };
  endpoint.addEventListener("message", onMessage);
  return {
    emit(event, value, transferables = []) {
      endpoint.postMessage({ t: "evt", n: event, v: value } satisfies Wire, transferables);
    },
    close() {
      endpoint.removeEventListener("message", onMessage);
    },
  };
}

/**
 * Two connected in-process endpoints with postMessage semantics (asynchronous delivery, structured clone, no
 * transfer). The main-thread fallback runs the same server code over this pair.
 */
export function createLocalChannel(): [Endpoint, Endpoint] {
  const a = new MessageChannel();
  a.port1.start();
  a.port2.start();
  return [a.port1, a.port2];
}
