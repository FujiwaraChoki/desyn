import type { Transaction } from "@desyn/schema";
import type { CommitResult, LoadPage, SinceResult } from "./wire.ts";

/**
 * What the sync client needs from a backend. `createConvexTransport` implements it over the Convex designs
 * functions; tests use scripted fakes. Every method is scoped to one design.
 */
export interface SyncTransport {
  /** One `designs.load` page (nodes in chunks of 500, header on the first page). */
  load(cursor: string | null): Promise<LoadPage>;
  /** `designs.commit`: applies `tx` on the server (idempotent on `tx.id`). */
  commit(args: { baseSeq: number; tx: Transaction }): Promise<CommitResult>;
  /**
   * Reactive `designOps.since({ seq })`. `onResult` runs on every new result (including the first); returns an
   * unsubscribe function.
   */
  watchSince(
    seq: number,
    onResult: (result: SinceResult) => void,
    onError: (error: unknown) => void,
  ): () => void;
  /** Connection state changes (websocket up / down). Optional. */
  onConnectionChange?(listener: (online: boolean) => void): () => void;
}
