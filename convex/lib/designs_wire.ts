import type {
  AssetRef,
  Design,
  DesignStyles,
  DroppedOp,
  Node,
  Op,
  Transaction,
} from "@desyn/schema";

// Wire format of design content between Convex and clients (DOCUMENT_MODEL §6).
//
// Convex values cannot carry object keys that start with "$" (ColorRef `{ "$var": … }`) or contain non-ASCII
// characters, both legal inside a Design. Transactions, ops and node data therefore cross the Convex boundary
// as JSON strings. This module has no server imports so web / desktop / AI code can use it directly.

/** Serialize a transaction for `designs.commit({ tx })`. */
export function encodeTx(tx: Transaction): string {
  return JSON.stringify(tx);
}

/** Parse a transaction received from `designOps.since` (`entry.tx`). */
export function decodeTx(json: string): Transaction {
  return JSON.parse(json) as Transaction;
}

/** Parse the `applied` ops returned by `designs.commit`. */
export function decodeOps(json: string): Op[] {
  return JSON.parse(json) as Op[];
}

/** Header returned with the first `designs.load` page. */
export interface LoadHeader {
  designId: string;
  key: string;
  name: string;
  kind: string;
  workspaceId: string;
  pageCount: number;
  /** JSON of `Design.assets` (AssetRef.url is never persisted; resolve with `assets.assets.designUrls`). */
  assets: string;
  /** JSON of `Design.styles`. */
  styles: string;
  /** JSON of `Design.meta`. */
  meta: string;
  brandKitId: string | null;
  permission: "view" | "comment" | "edit" | "manage";
  snapshot: { key: string; seq: number } | null;
}

export interface LoadPage {
  header: LoadHeader | null;
  /** Server seq at the time this page was read. */
  seq: number;
  /** JSON of each Node on this page. */
  nodes: string[];
  cursor: string;
  isDone: boolean;
}

export interface OpEntry {
  seq: number;
  txId: string;
  /** JSON of the accepted Transaction; `ops` are the ops the server applied. */
  tx: string;
  actor: string | null;
  source: string;
  ts: number;
}

export interface CommitResult {
  seq: number;
  /** JSON of the applied ops (normalized, see spec/fixtures/README.md). */
  applied: string;
  dropped: DroppedOp[];
  /** True when this tx id had already been committed (the stored result is returned). */
  duplicate: boolean;
}

/**
 * Assemble a Design from `designs.load` pages. Returns the design and the seq to subscribe from: the lowest
 * page seq (pages read later can only be newer; replaying ops after that seq converges because ops are
 * applied with last-writer-wins semantics and dropped when they no longer apply). `consistent` is false when
 * the pages were read at different seqs; clients may then reload to avoid transient drops.
 */
export function assembleDesign(pages: LoadPage[]): {
  design: Design;
  seq: number;
  consistent: boolean;
} {
  const header = pages[0]?.header;
  if (!header) throw new Error("assembleDesign: the first page must carry the header");
  const nodes: Record<string, Node> = {};
  let seq = Number.POSITIVE_INFINITY;
  let maxSeq = 0;
  for (const page of pages) {
    seq = Math.min(seq, page.seq);
    maxSeq = Math.max(maxSeq, page.seq);
    for (const json of page.nodes) {
      const node = JSON.parse(json) as Node;
      nodes[node.id] = node;
    }
  }
  const design: Design = {
    schema: 1,
    id: header.key,
    name: header.name,
    kind: header.kind as Design["kind"],
    nodes,
    assets: JSON.parse(header.assets) as Record<string, AssetRef>,
    styles: JSON.parse(header.styles) as DesignStyles,
    meta: JSON.parse(header.meta) as Design["meta"],
  };
  if (header.brandKitId !== null) design.brandKitId = header.brandKitId;
  return { design, seq: Number.isFinite(seq) ? seq : 0, consistent: seq === maxSeq };
}
