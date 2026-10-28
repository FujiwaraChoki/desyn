import { applyTransaction } from "@desyn/doc-ops";
import type { Design, Node, Transaction } from "@desyn/schema";
import { ROOT_ID } from "@desyn/schema";
import type { EditorBackend } from "../src/sync/convex-transport.ts";
import type { SyncTransport } from "../src/sync/transport.ts";
import type { CommitResult, LoadPage, OpEntry, SinceResult } from "../src/sync/wire.ts";

/**
 * In-memory stand-in for the Convex designs functions (DOCUMENT_MODEL §6 semantics, as implemented by
 * convex/lib/designs_commit.ts): ops apply to the current state with doc-ops, every accepted transaction
 * gets the next seq (also when everything was dropped), commits are idempotent on tx.id, `since` is
 * reactive and paginated, compaction produces gaps. Each client gets its own transport whose timing can be
 * scripted (hold commits, lose responses, fail, deliver acks before or after the echo).
 */

export class ConvexLikeError extends Error {
  constructor(readonly data: { code: string; message: string; [k: string]: unknown }) {
    super(data.message);
  }
}

interface Watcher {
  seq: number;
  onResult: (r: SinceResult) => void;
  last: string;
}

export class FakeServer {
  design: Design;
  seq = 0;
  private log: OpEntry[] = [];
  /** Entries at or below this seq were compacted away. */
  private floor = 0;
  private readonly results = new Map<string, CommitResult>();
  private readonly watchers = new Set<Watcher>();
  /** Every commit call that reached the server (retries included). */
  commitCalls: string[] = [];
  pageSize = 500;
  sinceLimit = 200;

  constructor(design: Design) {
    this.design = design;
  }

  /** Server-side commit (also used to simulate other users); `actor` is the committing user id. */
  commit(tx: Transaction, actor = "other"): CommitResult {
    this.commitCalls.push(tx.id);
    const prior = this.results.get(tx.id);
    if (prior) return { ...prior, duplicate: true };
    const r = applyTransaction(this.design, tx);
    this.design = r.design;
    this.seq++;
    // Like convex/lib/designs_commit.ts: the log carries the server-applied ops and the committing user.
    const applied = { ...tx, ops: r.applied, actor: { ...(tx.actor ?? {}), userId: actor } };
    this.log.push({
      seq: this.seq,
      txId: tx.id,
      tx: JSON.stringify(applied),
      actor,
      source: tx.source,
      ts: tx.ts,
    });
    const result: CommitResult = {
      seq: this.seq,
      applied: JSON.stringify(r.applied),
      dropped: r.dropped,
      duplicate: false,
    };
    this.results.set(tx.id, result);
    return result;
  }

  /** Pushes new results to every subscription (Convex re-runs reactive queries after a write). */
  notify(): void {
    for (const w of [...this.watchers]) this.emit(w);
  }

  private emit(w: Watcher): void {
    const r = this.since(w.seq);
    const key = JSON.stringify(r);
    if (key === w.last) return;
    w.last = key;
    w.onResult(r);
  }

  since(seq: number): SinceResult {
    if (seq < this.floor) return { ops: [], hasMore: false, gap: true, latestSeq: this.seq };
    const after = this.log.filter((e) => e.seq > seq);
    const page = after.slice(0, this.sinceLimit);
    return {
      ops: page,
      hasMore: after.length > this.sinceLimit,
      gap: page[0] !== undefined && page[0].seq !== seq + 1,
      latestSeq: page[page.length - 1]?.seq ?? seq,
    };
  }

  watch(seq: number, onResult: (r: SinceResult) => void): () => void {
    const w: Watcher = { seq, onResult, last: "" };
    this.watchers.add(w);
    queueMicrotask(() => {
      if (this.watchers.has(w)) this.emit(w);
    });
    return () => this.watchers.delete(w);
  }

  get watcherCount(): number {
    return this.watchers.size;
  }

  /** Drops log entries up to `seq` (as the snapshot compaction cron does). */
  compact(seq: number): void {
    this.log = this.log.filter((e) => e.seq > seq);
    this.floor = Math.max(this.floor, seq);
  }

  load(cursor: string | null): LoadPage {
    const ids = Object.keys(this.design.nodes).sort();
    const start = cursor ? Number(cursor) : 0;
    const slice = ids.slice(start, start + this.pageSize);
    const end = start + slice.length;
    return {
      header: cursor
        ? null
        : {
            designId: "d1",
            key: this.design.id,
            name: this.design.name,
            kind: this.design.kind,
            workspaceId: "ws1",
            pageCount: (this.design.nodes[ROOT_ID] as Node & { children: string[] }).children
              .length,
            assets: JSON.stringify(this.design.assets),
            styles: JSON.stringify(this.design.styles),
            meta: JSON.stringify(this.design.meta),
            brandKitId: this.design.brandKitId ?? null,
            permission: "edit",
            snapshot: null,
          },
      seq: this.seq,
      nodes: slice.map((id) => JSON.stringify(this.design.nodes[id])),
      cursor: String(end),
      isDone: end >= ids.length,
    };
  }
}

type Held = {
  tx: Transaction;
  resolve: (r: CommitResult) => void;
  reject: (e: unknown) => void;
};

/** One client's connection with scriptable timing. */
export class FakeTransport implements SyncTransport {
  /** Hold commits until `release()` / `loseResponse()` / `fail()`. */
  hold = false;
  /** Resolve the mutation before notifying subscriptions (Convex normally does the opposite). */
  ackBeforeEcho = false;
  permission: "view" | "comment" | "edit" | "manage" = "edit";
  readonly held: Held[] = [];
  private failures: unknown[] = [];
  private connection = new Set<(online: boolean) => void>();
  /** Runs between two load pages (simulate writes during a paginated load). */
  betweenPages: (() => void) | null = null;
  loads = 0;

  constructor(
    readonly server: FakeServer,
    readonly actor = "me",
  ) {}

  async load(cursor: string | null): Promise<LoadPage> {
    if (!cursor) this.loads++;
    else this.betweenPages?.();
    const page = this.server.load(cursor);
    if (page.header) page.header.permission = this.permission;
    return structuredClone(page);
  }

  /** The next commits throw these errors (in order). */
  failNext(...errors: unknown[]): void {
    this.failures.push(...errors);
  }

  commit({ tx }: { baseSeq: number; tx: Transaction }): Promise<CommitResult> {
    const wire = JSON.parse(JSON.stringify(tx)) as Transaction;
    const failure = this.failures.shift();
    if (failure !== undefined) return Promise.reject(failure);
    if (this.hold) {
      return new Promise((resolve, reject) => this.held.push({ tx: wire, resolve, reject }));
    }
    // Requests take a network hop: the caller always sees the commit as in flight first.
    return Promise.resolve().then(() => this.deliver(wire));
  }

  private deliver(tx: Transaction): Promise<CommitResult> {
    const result = this.server.commit(tx, this.actor);
    if (this.ackBeforeEcho) {
      queueMicrotask(() => this.server.notify());
      return Promise.resolve(result);
    }
    this.server.notify();
    return Promise.resolve(result);
  }

  /** Delivers the oldest held commit normally. */
  async release(): Promise<void> {
    const h = this.held.shift();
    if (!h) throw new Error("nothing held");
    const r = await this.deliver(h.tx);
    h.resolve(r);
  }

  /**
   * The server applies the oldest held commit but the response is lost (network drop). With `echo` false the
   * subscription update is lost too (the socket dropped), so only a retry can confirm the transaction.
   */
  loseResponse(echo = false): void {
    const h = this.held.shift();
    if (!h) throw new Error("nothing held");
    this.server.commit(h.tx, this.actor);
    if (echo) this.server.notify();
    h.reject(new Error("Connection lost while sending the request"));
  }

  /** The oldest held commit fails with `error` without reaching the server. */
  fail(error: unknown): void {
    const h = this.held.shift();
    if (!h) throw new Error("nothing held");
    h.reject(error);
  }

  /** The next `watchSince` subscriptions fail with these errors (in order). */
  readonly sinceFailures: unknown[] = [];
  /** Subscriptions opened so far. */
  watches = 0;
  private readonly live = new Set<{ stop: () => void; onError: (e: unknown) => void }>();

  watchSince(
    seq: number,
    onResult: (r: SinceResult) => void,
    onError: (error: unknown) => void = () => {},
  ): () => void {
    this.watches++;
    if (this.sinceFailures.length > 0) {
      const error = this.sinceFailures.shift();
      let open = true;
      queueMicrotask(() => {
        if (open) onError(error);
      });
      return () => {
        open = false;
      };
    }
    const entry = { stop: this.server.watch(seq, (r) => onResult(structuredClone(r))), onError };
    this.live.add(entry);
    return () => {
      this.live.delete(entry);
      entry.stop();
    };
  }

  /** Every open subscription fails with `error` (the socket dropped) and stops delivering results. */
  dropSubscriptions(error: unknown): void {
    for (const entry of [...this.live]) {
      this.live.delete(entry);
      entry.stop();
      entry.onError(error);
    }
  }

  onConnectionChange(listener: (online: boolean) => void): () => void {
    this.connection.add(listener);
    return () => this.connection.delete(listener);
  }

  setOnline(online: boolean): void {
    for (const l of this.connection) l(online);
  }
}

/** Backend with the fake transport and in-memory assets / prefs. */
export function fakeBackend(
  transport: FakeTransport,
  user: { userId: string; name: string } | null = {
    userId: "user1",
    name: "Ada",
  },
): EditorBackend & {
  prefsStore: { shortcuts: string | null; ui: string | null; updatedAt: number } | null;
} {
  const backend = {
    prefsStore: null as { shortcuts: string | null; ui: string | null; updatedAt: number } | null,
    sync: transport,
    assets: {
      designUrls: async () => ({ urls: {}, expiresAt: null }),
      requestUpload: async () => {
        throw new ConvexLikeError({
          code: "NOT_CONFIGURED",
          message: "Uploads are not configured.",
        });
      },
      finalize: async () => {
        throw new Error("unreachable");
      },
      getAsset: async () => {
        throw new Error("unreachable");
      },
    },
    prefs: {
      get: async () => backend.prefsStore,
      set: async (v: { shortcuts?: string; ui?: string }) => {
        backend.prefsStore = {
          shortcuts: v.shortcuts ?? backend.prefsStore?.shortcuts ?? null,
          ui: v.ui ?? backend.prefsStore?.ui ?? null,
          updatedAt: Date.now(),
        };
      },
    },
    me: async () =>
      user ? { userId: user.userId, name: user.name, email: "a@example.com", image: null } : null,
  };
  return backend;
}

/** Lets queued microtasks, timers and promise chains settle. */
export async function settle(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 0));
}

/** Polls until `fn` is true (real timers). */
export async function until(fn: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 2));
  }
}
