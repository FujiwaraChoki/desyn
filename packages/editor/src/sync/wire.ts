// Wire format between Convex and the editor (DOCUMENT_MODEL §6 change log, "Convex wire format"): design content
// crosses the Convex boundary as JSON strings. The helpers live next to the Convex functions and have no server
// imports, so every client shares one implementation.
import type { OpEntry } from "../../../../convex/lib/designs_wire.ts";

export {
  assembleDesign,
  type CommitResult,
  decodeOps,
  decodeTx,
  encodeTx,
  type LoadHeader,
  type LoadPage,
  type OpEntry,
} from "../../../../convex/lib/designs_wire.ts";

/** Result of `designOps.since` (reactive). */
export interface SinceResult {
  ops: OpEntry[];
  hasMore: boolean;
  /** Entries after the subscribed seq were compacted away: reload the design. */
  gap: boolean;
  latestSeq: number;
}

/** `share` argument accepted by every design function for share-link holders. */
export interface ShareArg {
  token: string;
  password?: string;
}

export type Permission = "view" | "comment" | "edit" | "manage";
