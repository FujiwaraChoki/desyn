import {
  type ApplyOptions,
  acknowledge,
  applyTransaction,
  createSyncState,
  rebase,
  replayPending,
  type SyncState,
} from "@desyn/doc-ops";
import type { ApplyResult, Design, DroppedOp, Id, Transaction } from "@desyn/schema";
import { Emitter } from "./emitter.ts";
import { type ClassifiedError, classifyError } from "./errors.ts";
import { MemoryPendingStore, type PendingStore } from "./pending-store.ts";
import { splitTransaction } from "./split.ts";
import type { SyncTransport } from "./transport.ts";
import {
  assembleDesign,
  type CommitResult,
  decodeOps,
  decodeTx,
  type LoadHeader,
  type LoadPage,
  type SinceResult,
} from "./wire.ts";

/**
 * Client side of the sync protocol (DOCUMENT_MODEL §6) for one design.
 *
 * - Load: `designs.load` pages are fetched until `isDone` and assembled; the seq to follow from is the lowest
 *   page seq. Pages read at different seqs are re-read (a few attempts) so the start state is consistent.
 * - Model: `confirmed` (server state at `seq`) + `pending` (own transactions not yet folded in). The view is
 *   confirmed + pending. Remote transactions are applied to `confirmed` and pending is replayed over them
 *   (rebase via @desyn/doc-ops); own transactions echo back through the stream and act as acks.
 * - Commits: one transaction in flight at a time, oldest first, with `baseSeq`. Retries reuse the same `tx.id`
 *   (the server is idempotent on it). An ack for `seq + 1` is folded at once; any other ack waits for its
 *   echo so no foreign transaction is skipped. Rejected transactions are rolled back and reported.
 * - Offline: pending transactions are persisted (IndexedDB) on every change and replayed after a reload.
 * - Gaps: `since` reporting `gap` (log compacted) or a seq jump triggers a reload that keeps pending work.
 * - Telemetry: conflicts (ops of own transactions dropped by a rebase or by the server), reloads, retries
 *   and rejections are reported through `telemetry`.
 */

export type SyncStatus =
  /** First load in progress. */
  | "loading"
  /** Up to date, nothing pending. */
  | "live"
  /** Own transactions waiting for the server. */
  | "syncing"
  /** No connection; edits are queued on this device. */
  | "offline"
  /** Re-reading the design after a gap. */
  | "reloading"
  /** The design cannot be opened (see `error`). */
  | "error"
  | "stopped";

export interface SyncSnapshot {
  status: SyncStatus;
  seq: number;
  pending: number;
  online: boolean;
  header: LoadHeader | null;
  /** Why the design cannot be opened / followed (NOT_FOUND, FORBIDDEN, ...). */
  error: { code: string; message: string; reason?: string } | null;
  /** Last commit problem that is being retried (shown as a hint, not an error). */
  retrying: { code: string; message: string; attempt: number } | null;
  lastSyncedAt: number | null;
}

export type ChangeCause = "load" | "local" | "remote" | "ack" | "rollback" | "reload";

export interface SyncChange {
  cause: ChangeCause;
  view: Design;
  prevView: Design | null;
  /** Foreign transactions folded in by this change (server-applied ops), oldest first. */
  remote: Transaction[];
  /**
   * Inverse of each `remote` transaction (same order), computed against the confirmed state it was applied
   * to. The history uses it to make the user's own server-run AI / workflow transactions undoable.
   */
  remoteInverses: Transaction[];
  /**
   * True when `view` is exactly `prevView` with `remote` applied in order (no pending work was replayed and no
   * own transaction was acknowledged), so a mirror of `prevView` can apply `remote` directly.
   */
  linear: boolean;
}

export interface ConflictEvent {
  /** `rebase`: a remote transaction made ops of a pending one stop applying; `server`: the server dropped ops. */
  kind: "rebase" | "server";
  txId: Id;
  label: string;
  dropped: DroppedOp[];
}

export interface RejectedEvent {
  tx: Transaction;
  code: string;
  message: string;
}

export interface SyncEvents {
  change: SyncChange;
  status: SyncSnapshot;
  conflict: ConflictEvent;
  rejected: RejectedEvent;
}

export type Telemetry = (event: string, props: Record<string, unknown>) => void;

export interface SyncClientOptions {
  designId: string;
  transport: SyncTransport;
  pendingStore?: PendingStore;
  telemetry?: Telemetry;
  /** Re-subscribe once a `since` result holds this many entries, keeping results small (default 100). */
  resubscribeAt?: number;
  /** Commit retry backoff (default 400 ms doubling to 30 s, with jitter). */
  retry?: { baseMs: number; maxMs: number };
  /** Attempts to read a consistent set of load pages (default 3). */
  loadAttempts?: number;
  /** Jitter source (tests pin it). */
  random?: () => number;
  /** Node validation on local applies (default true; see doc-ops ApplyOptions). */
  apply?: ApplyOptions;
}

interface Loaded {
  design: Design;
  seq: number;
  header: LoadHeader;
}

export class SyncClient {
  readonly designId: string;
  private readonly transport: SyncTransport;
  private readonly store: PendingStore;
  private readonly telemetry: Telemetry;
  private readonly events = new Emitter<SyncEvents>();
  private readonly resubscribeAt: number;
  private readonly retryCfg: { baseMs: number; maxMs: number };
  private readonly loadAttempts: number;
  private readonly random: () => number;
  private readonly applyOptions: ApplyOptions;

  private state: SyncState | null = null;
  private header: LoadHeader | null = null;
  private status: SyncStatus = "loading";
  private error: SyncSnapshot["error"] = null;
  private retrying: SyncSnapshot["retrying"] = null;
  private online = true;
  private lastSyncedAt: number | null = null;
  /** Pending transactions the server accepted out of order: their echo confirms them. */
  private readonly sent = new Set<Id>();
  private inflight: Id | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  /** What the retry timer runs (a commit, a re-subscription, a reload): one timer, every waiting action. */
  private readonly retryActions = new Set<() => void>();
  private retryAttempt = 0;
  private unsubscribeSince: (() => void) | null = null;
  private subscribedSeq = -1;
  private subscription = 0;
  private reloading: Promise<void> | null = null;
  private stopped = false;
  private persistChain: Promise<void> = Promise.resolve();
  private readonly cleanup: (() => void)[] = [];

  constructor(options: SyncClientOptions) {
    this.designId = options.designId;
    this.transport = options.transport;
    this.store = options.pendingStore ?? new MemoryPendingStore();
    this.telemetry = options.telemetry ?? (() => {});
    this.resubscribeAt = options.resubscribeAt ?? 100;
    this.retryCfg = options.retry ?? { baseMs: 400, maxMs: 30_000 };
    this.loadAttempts = Math.max(1, options.loadAttempts ?? 3);
    this.random = options.random ?? Math.random;
    this.applyOptions = options.apply ?? {};
  }

  // ---------------------------------------------------------------------------------------------------------
  // Reading

  on<K extends keyof SyncEvents>(event: K, listener: (value: SyncEvents[K]) => void): () => void {
    return this.events.on(event, listener);
  }

  /** confirmed + pending (what to render); null before the first load. */
  get view(): Design | null {
    return this.state?.view ?? null;
  }

  get confirmed(): Design | null {
    return this.state?.confirmed ?? null;
  }

  get seq(): number {
    return this.state?.seq ?? 0;
  }

  get pending(): readonly Transaction[] {
    return this.state?.pending ?? [];
  }

  get loadHeader(): LoadHeader | null {
    return this.header;
  }

  snapshot(): SyncSnapshot {
    return {
      status: this.status,
      seq: this.seq,
      pending: this.pending.length,
      online: this.online,
      header: this.header,
      error: this.error,
      retrying: this.retrying,
      lastSyncedAt: this.lastSyncedAt,
    };
  }

  // ---------------------------------------------------------------------------------------------------------
  // Lifecycle

  /** Loads the design, restores the offline queue, subscribes to the log and starts committing. */
  async start(): Promise<void> {
    this.setStatus("loading");
    if (this.transport.onConnectionChange) {
      this.cleanup.push(this.transport.onConnectionChange((online) => this.setOnline(online)));
    }
    let loaded: Loaded;
    let queued: Transaction[];
    try {
      [loaded, queued] = await Promise.all([this.loadDesign(), this.restoreQueue()]);
    } catch (e) {
      if (!this.stopped) this.fail(e);
      return;
    }
    if (this.stopped) return;
    let state = createSyncState(loaded.design, loaded.seq);
    if (queued.length > 0) {
      const replay = replayPending(state.confirmed, queued);
      state = { ...state, pending: replay.pending, view: replay.view };
      this.telemetry("sync_queue_restored", { designId: this.designId, count: queued.length });
    }
    this.state = state;
    this.header = loaded.header;
    this.emitChange("load", null, [], false);
    this.subscribe();
    this.updateStatus();
    this.pump();
  }

  /** Stops following the design. Resolves when the offline queue is written. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.unsubscribeSince?.();
    this.unsubscribeSince = null;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.retryActions.clear();
    for (const fn of this.cleanup.splice(0)) fn();
    this.setStatus("stopped");
    await this.persistChain;
  }

  /** Connection changed (Convex websocket, browser online/offline). Reconnecting retries at once. */
  setOnline(online: boolean): void {
    if (this.online === online) return;
    this.online = online;
    if (online && this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
      this.runRetryActions();
    }
    this.updateStatus();
  }

  // ---------------------------------------------------------------------------------------------------------
  // Local edits

  /**
   * Applies an own transaction optimistically and queues it for the server. Returns the doc-ops result
   * against the current view (`applied` is what gets committed, `inverse` undoes it). Nothing is queued when
   * every op was dropped.
   */
  applyLocal(tx: Transaction): ApplyResult {
    const state = this.requireState();
    const result = applyTransaction(state.view, tx, this.applyOptions);
    if (result.applied.length === 0) return result;
    const committed: Transaction = { ...tx, ops: result.applied };
    const prev = state.view;
    this.state = {
      ...state,
      pending: [...state.pending, ...splitTransaction(committed)],
      view: result.design,
    };
    this.emitChange("local", prev, [], false);
    this.persist();
    this.updateStatus();
    this.pump();
    return result;
  }

  /**
   * Applies a transaction to the local state without sending it (read-only sessions: derived geometry the
   * engine recomputed after fonts loaded). It is folded under pending work like a remote transaction.
   */
  applyLocalOnly(tx: Transaction): void {
    const state = this.requireState();
    const r = rebase(state.confirmed, state.pending, tx);
    const prev = state.view;
    this.state = { ...state, confirmed: r.confirmed, pending: r.pending, view: r.view };
    this.emitChange("local", prev, [], false);
  }

  /** Forces a reload from the server (keeps pending work). */
  reload(reason = "manual"): Promise<void> {
    return this.reloadDesign(reason);
  }

  // ---------------------------------------------------------------------------------------------------------
  // Internals: load

  private async loadDesign(): Promise<Loaded> {
    let last: ReturnType<typeof assembleDesign> | null = null;
    let header: LoadHeader | null = null;
    for (let attempt = 1; attempt <= this.loadAttempts; attempt++) {
      const pages: LoadPage[] = [];
      let cursor: string | null = null;
      for (;;) {
        const page = await this.transport.load(cursor);
        pages.push(page);
        if (page.isDone) break;
        cursor = page.cursor;
      }
      last = assembleDesign(pages);
      header = pages[0]?.header ?? null;
      if (last.consistent) break;
      this.telemetry("sync_load_inconsistent", { designId: this.designId, attempt });
    }
    if (!last || !header) throw new Error("designs.load returned no header");
    return { design: last.design, seq: last.seq, header };
  }

  private async restoreQueue(): Promise<Transaction[]> {
    try {
      const q = await this.store.load(this.designId);
      return q?.txs ?? [];
    } catch (e) {
      this.telemetry("sync_queue_unavailable", { message: String(e) });
      return [];
    }
  }

  private reloadDesign(reason: string): Promise<void> {
    if (this.reloading) return this.reloading;
    if (!this.state) return Promise.resolve();
    this.telemetry("sync_reload", {
      designId: this.designId,
      reason,
      seq: this.seq,
      pending: this.pending.length,
    });
    this.setStatus("reloading");
    this.unsubscribeSince?.();
    this.unsubscribeSince = null;
    this.subscribedSeq = -1;
    const run = (async () => {
      let loaded: Loaded;
      try {
        loaded = await this.loadDesign();
      } catch (e) {
        const c = classifyError(e);
        if (c.kind === "fatal") this.fail(e);
        else this.scheduleRetry(c, () => void this.reloadDesign(reason));
        return;
      }
      if (this.stopped) return;
      const prev = this.state;
      const pending = prev?.pending ?? [];
      const replay = replayPending(loaded.design, pending);
      this.state = {
        confirmed: loaded.design,
        seq: loaded.seq,
        pending: replay.pending,
        view: replay.view,
      };
      this.header = loaded.header;
      this.sent.clear();
      this.emitChange("reload", prev?.view ?? null, [], false);
    })();
    this.reloading = run.finally(() => {
      this.reloading = null;
      if (this.stopped || this.error) return;
      this.subscribe();
      this.updateStatus();
      this.pump();
    });
    return this.reloading;
  }

  private fail(e: unknown): void {
    const c = classifyError(e);
    const data = (e as { data?: { reason?: unknown } } | null)?.data;
    this.error = {
      code: c.code,
      message: c.message,
      ...(typeof data?.reason === "string" ? { reason: data.reason } : {}),
    };
    this.telemetry("sync_error", { designId: this.designId, code: c.code });
    this.setStatus("error");
  }

  // ---------------------------------------------------------------------------------------------------------
  // Internals: the log stream

  private subscribe(): void {
    if (this.stopped || !this.state) return;
    const seq = this.state.seq;
    if (this.unsubscribeSince && this.subscribedSeq === seq) return;
    this.unsubscribeSince?.();
    const id = ++this.subscription;
    this.subscribedSeq = seq;
    this.unsubscribeSince = this.transport.watchSince(
      seq,
      (result) => {
        if (id === this.subscription) this.onSince(result);
      },
      (error) => {
        if (id === this.subscription) this.onSinceError(error);
      },
    );
  }

  private onSinceError(error: unknown): void {
    const c = classifyError(error);
    this.unsubscribeSince?.();
    this.unsubscribeSince = null;
    this.subscribedSeq = -1;
    if (c.kind === "fatal") {
      this.fail(error);
      return;
    }
    this.scheduleRetry(c, () => this.subscribe());
  }

  private onSince(result: SinceResult): void {
    const start = this.state;
    if (!start || this.reloading || this.stopped) return;
    if (result.gap) {
      void this.reloadDesign("gap");
      return;
    }
    const entries = result.ops.filter((e) => e.seq > start.seq).sort((a, b) => a.seq - b.seq);
    if (entries.length === 0) {
      if (result.hasMore || result.ops.length >= this.resubscribeAt) this.subscribe();
      return;
    }
    const prevView = start.view;
    const remote: Transaction[] = [];
    const remoteInverses: Transaction[] = [];
    let linear = start.pending.length === 0;
    let pendingChanged = false;
    let jumped = false;
    for (const entry of entries) {
      const state = this.state as SyncState;
      if (entry.seq !== state.seq + 1) {
        jumped = true;
        break;
      }
      const tx = decodeTx(entry.tx);
      if (state.pending.some((p) => p.id === tx.id)) {
        // Our own transaction echoed: it is the ack (the stream carries the server-applied ops).
        this.state = acknowledge(state, tx.id, tx.ops, entry.seq);
        this.sent.delete(tx.id);
        linear = false;
        pendingChanged = true;
        this.lastSyncedAt = Date.now();
        continue;
      }
      // §6: apply to confirmed, then re-apply pending over it (doc-ops `rebase`, keeping the inverse).
      const folded = applyTransaction(state.confirmed, tx);
      const r = replayPending(folded.design, state.pending);
      this.state = { confirmed: folded.design, seq: entry.seq, pending: r.pending, view: r.view };
      remote.push(tx);
      remoteInverses.push(folded.inverse);
      for (const d of r.dropped) {
        pendingChanged = true;
        const label = state.pending.find((p) => p.id === d.txId)?.label ?? "";
        this.reportConflict({ kind: "rebase", txId: d.txId, label, dropped: d.dropped });
      }
    }
    this.pruneEmptyPending();
    const after = this.state as SyncState;
    if (after.view !== prevView || remote.length > 0) {
      this.emitChange(
        remote.length > 0 ? "remote" : "ack",
        prevView,
        remote,
        linear,
        remoteInverses,
      );
    }
    if (pendingChanged) this.persist();
    if (jumped) {
      void this.reloadDesign("seq-jump");
      return;
    }
    if (result.hasMore || result.ops.length >= this.resubscribeAt) this.subscribe();
    this.updateStatus();
    this.pump();
  }

  /** Pending transactions whose every op stopped applying (and that were never sent) are dropped. */
  private pruneEmptyPending(): void {
    const state = this.state;
    if (!state) return;
    const keep = state.pending.filter(
      (p) => p.ops.length > 0 || p.id === this.inflight || this.sent.has(p.id),
    );
    if (keep.length !== state.pending.length) this.state = { ...state, pending: keep };
  }

  // ---------------------------------------------------------------------------------------------------------
  // Internals: commits

  private pump(): void {
    if (this.stopped || this.reloading || this.inflight || this.retryTimer || this.error) return;
    const state = this.state;
    if (!state) return;
    const tx = state.pending.find((p) => !this.sent.has(p.id));
    if (!tx) {
      this.updateStatus();
      return;
    }
    this.inflight = tx.id;
    this.updateStatus();
    this.transport.commit({ baseSeq: state.seq, tx }).then(
      (res) => {
        this.inflight = null;
        this.retryAttempt = 0;
        this.retrying = null;
        if (this.stopped) return;
        this.onCommitted(tx, res);
        this.updateStatus();
        this.pump();
      },
      (error: unknown) => {
        this.inflight = null;
        if (this.stopped) return;
        this.onCommitError(tx, error);
      },
    );
  }

  private onCommitted(tx: Transaction, res: CommitResult): void {
    this.lastSyncedAt = Date.now();
    if (res.dropped.length > 0) {
      this.reportConflict({ kind: "server", txId: tx.id, label: tx.label, dropped: res.dropped });
    }
    const state = this.state;
    if (!state?.pending.some((p) => p.id === tx.id)) return; // the echo already confirmed it
    const applied = decodeOps(res.applied);
    const prev = state.view;
    if (res.seq === state.seq + 1) {
      this.state = acknowledge(state, tx.id, applied, res.seq);
    } else if (res.seq <= state.seq) {
      // Accepted earlier (a retry after a reload): the loaded state already contains it.
      const rest = state.pending.filter((p) => p.id !== tx.id);
      const replay = replayPending(state.confirmed, rest);
      this.state = { ...state, pending: replay.pending, view: replay.view };
    } else {
      // The server ordered transactions we have not seen yet before ours: wait for the echo.
      this.sent.add(tx.id);
      return;
    }
    if (this.state.view !== prev) this.emitChange("ack", prev, [], false);
    this.persist();
  }

  private onCommitError(tx: Transaction, error: unknown): void {
    const c = classifyError(error);
    switch (c.kind) {
      case "fatal":
        this.reject(tx, c);
        this.pump();
        return;
      case "reload":
        void this.reloadDesign("base-seq");
        return;
      default:
        this.retryAttempt++;
        this.retrying = { code: c.code, message: c.message, attempt: this.retryAttempt };
        this.telemetry("sync_retry", {
          designId: this.designId,
          code: c.code,
          attempt: this.retryAttempt,
        });
        this.scheduleRetry(c, () => this.pump());
    }
  }

  private reject(tx: Transaction, c: ClassifiedError): void {
    const state = this.state;
    if (!state) return;
    const rest = state.pending.filter((p) => p.id !== tx.id);
    const replay = replayPending(state.confirmed, rest);
    const prev = state.view;
    this.state = { ...state, pending: replay.pending, view: replay.view };
    this.sent.delete(tx.id);
    this.telemetry("sync_rejected", { designId: this.designId, code: c.code, txId: tx.id });
    this.emitChange("rollback", prev, [], false);
    this.events.emit("rejected", { tx, code: c.code, message: c.message });
    for (const d of replay.dropped) {
      const label = rest.find((p) => p.id === d.txId)?.label ?? "";
      this.reportConflict({ kind: "rebase", txId: d.txId, label, dropped: d.dropped });
    }
    this.persist();
    this.updateStatus();
  }

  private scheduleRetry(c: ClassifiedError, run: () => void): void {
    if (this.stopped) return;
    this.retryActions.add(run);
    // A timer is already waiting (e.g. a commit retry): it runs this action too.
    if (this.retryTimer) return;
    const attempt = Math.max(1, this.retryAttempt);
    const exp = Math.min(this.retryCfg.maxMs, this.retryCfg.baseMs * 2 ** (attempt - 1));
    let delay = exp * (0.5 + this.random() * 0.5);
    if (c.retryAfterMs !== undefined) delay = Math.max(delay, c.retryAfterMs);
    if (c.kind === "auth") delay = Math.max(delay, 2_000);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.runRetryActions();
    }, delay);
    this.updateStatus();
  }

  private runRetryActions(): void {
    if (this.stopped) return;
    const actions = [...this.retryActions];
    this.retryActions.clear();
    for (const action of actions) action();
    // Commits wait while a timer is set; make sure the queue moves once it is gone.
    this.pump();
  }

  // ---------------------------------------------------------------------------------------------------------
  // Internals: bookkeeping

  private reportConflict(event: ConflictEvent): void {
    this.telemetry("sync_conflict", {
      designId: this.designId,
      kind: event.kind,
      txId: event.txId,
      count: event.dropped.length,
      reasons: [...new Set(event.dropped.map((d) => d.reason))],
    });
    this.events.emit("conflict", event);
  }

  private persist(): void {
    const state = this.state;
    if (!state) return;
    const txs = state.pending;
    const seq = state.seq;
    this.persistChain = this.persistChain
      .then(() =>
        txs.length > 0
          ? this.store.save({ designId: this.designId, baseSeq: seq, txs, savedAt: Date.now() })
          : this.store.clear(this.designId),
      )
      .catch((e: unknown) => {
        this.telemetry("sync_queue_write_failed", { message: String(e) });
      });
  }

  private requireState(): SyncState {
    if (!this.state) throw new Error("The design is not loaded yet.");
    return this.state;
  }

  private emitChange(
    cause: ChangeCause,
    prevView: Design | null,
    remote: Transaction[],
    linear: boolean,
    remoteInverses: Transaction[] = [],
  ): void {
    const view = this.state?.view;
    if (!view) return;
    this.events.emit("change", { cause, view, prevView, remote, remoteInverses, linear });
  }

  private updateStatus(): void {
    if (this.stopped || !this.state || this.reloading) return;
    if (this.error) {
      this.setStatus("error");
      return;
    }
    let next: SyncStatus = "live";
    if (!this.online) next = "offline";
    else if (this.pending.length > 0) next = "syncing";
    this.setStatus(next, true);
  }

  private setStatus(status: SyncStatus, force = false): void {
    if (this.status === status && !force) return;
    this.status = status;
    this.events.emit("status", this.snapshot());
  }
}
