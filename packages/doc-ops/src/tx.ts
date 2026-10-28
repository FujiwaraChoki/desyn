import {
  type Id,
  newId,
  type Op,
  type Transaction,
  type TransactionActor,
  type TransactionSource,
} from "@desyn/schema";

export interface TxOptions {
  /** Transaction id; default a fresh `newId()`. */
  id?: Id;
  /** History label; each builder has a sensible default. */
  label?: string;
  source?: TransactionSource;
  actor?: TransactionActor;
  /** ms epoch; default `Date.now()`. */
  ts?: number;
}

export function makeTransaction(ops: Op[], label: string, options: TxOptions = {}): Transaction {
  const tx: Transaction = {
    id: options.id ?? newId(),
    label: options.label ?? label,
    ops,
    source: options.source ?? "user",
    ts: options.ts ?? Date.now(),
  };
  if (options.actor) tx.actor = { ...options.actor };
  return tx;
}

/** Ids of the subtree roots created by a transaction, in op order. */
export function createdIds(tx: Pick<Transaction, "ops">): Id[] {
  return tx.ops.flatMap((op) => (op.op === "create" && op.nodes[0] ? [op.nodes[0].id] : []));
}
