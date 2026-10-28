import type { Design, Transaction } from "@desyn/schema";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import { getBlob } from "./designs_blob";
import { emptyDesignBase, replay } from "./designs_doc";

// Rebuild a full Design at a given seq inside an action: the newest snapshot at or before that seq, plus the
// transaction log after it (DOCUMENT_MODEL §6). Reads are consistent no matter how many queries it takes,
// because snapshots and accepted transactions are immutable.

export interface Materialized {
  design: Design;
  seq: number;
  workspaceId: Id<"workspaces">;
  /** Seq of the latest snapshot recorded on the design (null when none). */
  latestSnapshotSeq: number | null;
  /** Ops the replay could not apply (0 unless the log and snapshots diverged). */
  dropped: number;
}

export async function materializeDesign(
  ctx: ActionCtx,
  designId: Id<"designs">,
  opts: { seq?: number; decode: (bytes: Uint8Array) => string },
): Promise<Materialized | null> {
  const base = await ctx.runQuery(internal.designs.internal.snapshotBase, {
    designId,
    ...(opts.seq !== undefined ? { maxSeq: opts.seq } : {}),
  });
  if (!base) return null;
  let design: Design;
  let seq: number;
  if (base.snapshot) {
    const bytes = await getBlob(ctx, base.snapshot.key);
    if (!bytes) throw new Error(`snapshot ${base.snapshot.seq} of design ${designId} is missing`);
    design = JSON.parse(opts.decode(bytes)) as Design;
    seq = base.snapshot.seq;
  } else {
    design = emptyDesignBase(base.key);
    seq = 0;
  }
  let dropped = 0;
  while (seq < base.target) {
    const rows = await ctx.runQuery(internal.designs.internal.opsRange, {
      designId,
      after: seq,
      upTo: base.target,
    });
    const first = rows[0];
    if (!first || first.seq !== seq + 1) {
      throw new Error(`transaction log of design ${designId} has a gap after seq ${seq}`);
    }
    const result = replay(
      design,
      rows.map((r: { tx: string }) => JSON.parse(r.tx) as Transaction),
    );
    design = result.design;
    dropped += result.dropped;
    seq = (rows[rows.length - 1] as { seq: number }).seq;
  }
  return {
    design,
    seq,
    workspaceId: base.workspaceId,
    latestSnapshotSeq: base.latestSnapshotSeq,
    dropped,
  };
}
