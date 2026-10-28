// Transaction composition and the client sync model of DOCUMENT_MODEL §6.
import {
  type Design,
  type DroppedOp,
  type Id,
  newId,
  type Op,
  type Transaction,
} from "@desyn/schema";
import { applyTransaction } from "./apply";
import { deepEqual, hasOwn, setOwn } from "./util";

export interface ComposeOptions {
  id?: Id;
  label?: string;
  /**
   * Merge adjacent ops that target the same thing (default true): consecutive `update`s of one node, consecutive
   * `patch`es of one path, and an `update`/`patch` immediately followed by a `delete` of the same node. The merged
   * list reaches the same state as the original whenever every original op applies.
   */
  coalesce?: boolean;
}

function mergeUpdates(
  a: Extract<Op, { op: "update" }>,
  b: Extract<Op, { op: "update" }>,
): Extract<Op, { op: "update" }> {
  const bSet = b.set ?? {};
  const bUnset = new Set(b.unset ?? []);
  const set: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(a.set ?? {})) if (!bUnset.has(k)) setOwn(set, k, v);
  for (const [k, v] of Object.entries(bSet)) setOwn(set, k, v);
  const unset = [...new Set([...(a.unset ?? []).filter((k) => !hasOwn(bSet, k)), ...bUnset])];
  const out: Extract<Op, { op: "update" }> = { op: "update", id: a.id };
  if (Object.keys(set).length > 0) out.set = set;
  if (unset.length > 0) out.unset = unset;
  return out;
}

/** Merges adjacent redundant ops (see ComposeOptions.coalesce). */
export function coalesceOps(ops: readonly Op[]): Op[] {
  const out: Op[] = [];
  for (const op of ops) {
    const prev = out[out.length - 1];
    if (prev && prev.op === "update" && op.op === "update" && prev.id === op.id) {
      out[out.length - 1] = mergeUpdates(prev, op);
      continue;
    }
    if (
      prev &&
      prev.op === "patch" &&
      op.op === "patch" &&
      prev.id === op.id &&
      deepEqual(prev.path, op.path)
    ) {
      out[out.length - 1] = op;
      continue;
    }
    if (op.op === "delete") {
      while (true) {
        const last = out[out.length - 1];
        if (last && (last.op === "update" || last.op === "patch") && last.id === op.id) out.pop();
        else break;
      }
    }
    out.push(op);
  }
  return out;
}

/** One transaction equivalent to applying `txs` in order (metadata from the first, `ts` from the last). */
export function compose(txs: readonly Transaction[], options: ComposeOptions = {}): Transaction {
  const first = txs[0];
  if (!first) throw new Error("compose: no transactions");
  const last = txs[txs.length - 1] as Transaction;
  const ops = txs.flatMap((t) => t.ops);
  const tx: Transaction = {
    id: options.id ?? newId(),
    label: options.label ?? first.label,
    ops: options.coalesce === false ? ops : coalesceOps(ops),
    source: first.source,
    ts: last.ts,
  };
  if (first.actor) tx.actor = { ...first.actor };
  return tx;
}

export interface RebaseResult {
  /** `confirmed` with the remote transaction applied. */
  confirmed: Design;
  /** Pending transactions with the ops that no longer apply removed (original op forms are kept). */
  pending: Transaction[];
  /** What to render: confirmed + pending. */
  view: Design;
  /** Ops of pending transactions that stopped applying. */
  dropped: { txId: Id; dropped: DroppedOp[] }[];
}

/** Re-applies own pending transactions over `confirmed` (optionally after applying a remote transaction). */
export function replayPending(
  confirmed: Design,
  pending: readonly Transaction[],
): Omit<RebaseResult, "confirmed"> {
  let view = confirmed;
  const kept: Transaction[] = [];
  const dropped: RebaseResult["dropped"] = [];
  for (const p of pending) {
    const r = applyTransaction(view, p);
    view = r.design;
    if (r.dropped.length > 0) {
      const gone = new Set(r.dropped.map((d) => d.index));
      kept.push({ ...p, ops: p.ops.filter((_, i) => !gone.has(i)) });
      dropped.push({ txId: p.id, dropped: r.dropped });
    } else {
      kept.push(p);
    }
  }
  return { pending: kept, view, dropped };
}

/** §6 client model: apply `remote` to `confirmed`, then re-apply `pending` over it. */
export function rebase(
  confirmed: Design,
  pending: readonly Transaction[],
  remote: Transaction,
): RebaseResult {
  const next = applyTransaction(confirmed, remote).design;
  return { confirmed: next, ...replayPending(next, pending) };
}

/** Client-side sync state: server-confirmed design + own uncommitted transactions. */
export interface SyncState {
  confirmed: Design;
  /** Last server sequence number folded into `confirmed`. */
  seq: number;
  pending: Transaction[];
  /** confirmed + pending, ready to render. */
  view: Design;
}

export function createSyncState(design: Design, seq: number): SyncState {
  return { confirmed: design, seq, pending: [], view: design };
}

/** Records a local transaction (optimistic): it joins `pending` and the view. */
export function commitLocal(state: SyncState, tx: Transaction): SyncState {
  const r = applyTransaction(state.view, tx);
  return { ...state, pending: [...state.pending, tx], view: r.design };
}

/**
 * The server accepted one of our transactions as `seq`, reporting the ops that took effect. The transaction leaves
 * `pending` and its server-applied ops join `confirmed`.
 *
 * Only an ack for `state.seq + 1` is folded in. A larger `seq` means the server ordered other transactions before
 * ours that have not reached this client yet; folding ours first would skip them for good (`receiveRemote` ignores
 * folded sequence numbers), so such an ack changes nothing and the transaction is confirmed when its echo arrives
 * through the `designOps.since` stream in order.
 */
export function acknowledge(state: SyncState, txId: Id, applied: Op[], seq: number): SyncState {
  const tx = state.pending.find((p) => p.id === txId);
  if (!tx || seq !== state.seq + 1) return state;
  const confirmed = applyTransaction(state.confirmed, { ...tx, ops: applied }).design;
  const rest = state.pending.filter((p) => p.id !== txId);
  const replay = replayPending(confirmed, rest);
  return { confirmed, seq, pending: replay.pending, view: replay.view };
}

/**
 * A transaction arrived from the server stream (`designOps.since`). Our own transactions echo back through the
 * stream; those are treated as acknowledgements. Already-folded sequence numbers are ignored.
 */
export function receiveRemote(state: SyncState, tx: Transaction, seq: number): SyncState {
  if (seq <= state.seq) return state;
  if (state.pending.some((p) => p.id === tx.id)) return acknowledge(state, tx.id, tx.ops, seq);
  const r = rebase(state.confirmed, state.pending, tx);
  return { confirmed: r.confirmed, seq, pending: r.pending, view: r.view };
}
