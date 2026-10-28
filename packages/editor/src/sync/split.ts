import { type Op, sha256Hex, type Transaction } from "@desyn/schema";

/**
 * `designs.commit` accepts at most 2000 ops and 800 KB per transaction. Larger local transactions (big pastes,
 * imports, AI builds) are split into consecutive chunks that the server applies in order. Chunk 0 keeps the
 * transaction id; later chunks get ids derived from it, so a retried split produces the same ids and stays
 * idempotent. Undo history keeps the original transaction as one step.
 */
export const MAX_OPS_PER_COMMIT = 1500;
export const MAX_BYTES_PER_COMMIT = 600_000;

const encoder = new TextEncoder();

function opBytes(op: Op): number {
  return encoder.encode(JSON.stringify(op)).length;
}

/** Deterministic id of chunk `index` of transaction `txId`. */
export function chunkTxId(txId: string, index: number): string {
  return index === 0 ? txId : sha256Hex(`chunk:${txId}:${index}`).slice(0, 12);
}

export function splitTransaction(
  tx: Transaction,
  limits: { maxOps?: number; maxBytes?: number } = {},
): Transaction[] {
  const maxOps = limits.maxOps ?? MAX_OPS_PER_COMMIT;
  const maxBytes = limits.maxBytes ?? MAX_BYTES_PER_COMMIT;
  // Cheap check first: JSON length in UTF-16 units is at most 3 bytes each in UTF-8.
  if (tx.ops.length <= maxOps && JSON.stringify(tx.ops).length * 3 <= maxBytes) return [tx];
  const chunks: Op[][] = [];
  let current: Op[] = [];
  let bytes = 0;
  for (const op of tx.ops) {
    const size = opBytes(op);
    if (current.length > 0 && (current.length >= maxOps || bytes + size > maxBytes)) {
      chunks.push(current);
      current = [];
      bytes = 0;
    }
    current.push(op);
    bytes += size;
  }
  if (current.length > 0) chunks.push(current);
  if (chunks.length <= 1) return [tx];
  return chunks.map((ops, i) => ({ ...tx, id: chunkTxId(tx.id, i), ops }));
}
