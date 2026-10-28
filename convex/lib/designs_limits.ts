// Size limits and tuning constants for designs, sync and assets (designs agent).
// Convex documents are limited to 1 MiB and a mutation may read/write ~16 MiB, so every stored JSON
// string stays well below that and transactions that would exceed it are rejected with INVALID_ARGUMENT.

/** Nodes returned per `designs.load` page. */
export const LOAD_PAGE_SIZE = 500;
/** Bytes read per `designs.load` page (500 nodes of up to MAX_NODE_BYTES each would exceed query limits). */
export const LOAD_PAGE_MAX_BYTES = 6_000_000;
/** Transactions returned per `designOps.since` call; clients reload when they fall further behind. */
export const SINCE_LIMIT = 200;
/** Max serialized size of one transaction (it is stored as one designOps document). */
export const MAX_TX_BYTES = 800_000;
export const MAX_OPS_PER_TX = 2_000;
/** Max serialized size of a single node. */
export const MAX_NODE_BYTES = 256_000;
/** Max nodes per design (keeps load, duplicate and delete within mutation limits). */
export const MAX_NODES_PER_DESIGN = 50_000;
/** Max serialized size of each of `assets`, `styles`, `meta`. */
export const MAX_STATE_BYTES = 800_000;
export const MAX_NAME_LENGTH = 200;
export const MAX_LABEL_LENGTH = 200;

/** A snapshot is written after this many transactions… */
export const SNAPSHOT_EVERY_TX = 200;
/** …or after this much activity since the last snapshot. */
export const SNAPSHOT_IDLE_MS = 5 * 60_000;
/** Thumbnails are regenerated this long after the first commit of a burst. */
export const THUMBNAIL_DEBOUNCE_MS = 20_000;
export const THUMBNAIL_WIDTH = 640;
/**
 * A snapshot / thumbnail schedule marker older than this belongs to an action that died without clearing it
 * (actions time out after 10 minutes), so the next commit schedules a fresh run.
 */
export const SCHEDULE_STALE_MS = 15 * 60_000;
/** designOps covered by a snapshot are kept this long (fine-grained history / late clients). */
export const OPS_RETENTION_MS = 30 * 24 * 60 * 60_000;
/** Trashed designs are purged after this long. */
export const TRASH_RETENTION_MS = 30 * 24 * 60 * 60_000;

/** Designs up to this size are duplicated / imported inside a single mutation. */
export const INLINE_COPY_MAX_NODES = 8_000;
export const INLINE_COPY_MAX_BYTES = 5_000_000;
/** Max JSON size accepted by `designs.importDesign`. */
export const MAX_IMPORT_BYTES = 5_000_000;

/** Presence heartbeat interval expected from clients, and the expiry granted per heartbeat. */
export const PRESENCE_HEARTBEAT_MS = 5_000;
export const PRESENCE_TTL_MS = 15_000;
export const MAX_SELECTION = 500;
export const MAX_DRAG_BYTES = 32_000;

export const MAX_COMMENT_LENGTH = 5_000;
export const MAX_MENTIONS = 20;

/** Uploads must be PUT within this window; pending rows older than this are cleaned up. */
export const UPLOAD_URL_TTL_S = 15 * 60;
export const PENDING_UPLOAD_TTL_MS = 24 * 60 * 60_000;
/** Signed GET URLs are computed per window so they are stable (cacheable) for the whole window. */
export const SIGNED_URL_WINDOW_S = 60 * 60;
/** SVG uploads larger than this are rejected (they must be parsed and sanitized in memory). */
export const MAX_SVG_BYTES = 5 * 1024 * 1024;
/** Inline `SvgNode.markup` larger than this is rejected. */
export const MAX_INLINE_SVG_BYTES = 200_000;

/** Exports: max scale, how long results stay downloadable, when to email instead of waiting. */
export const MAX_EXPORT_SCALE = 8;
export const EXPORT_TTL_MS = 7 * 24 * 60 * 60_000;
export const EXPORT_DOWNLOAD_URL_TTL_S = 24 * 60 * 60;
export const EXPORT_LARGE_PAGES = 5;
export const EXPORT_MAX_ATTEMPTS = 3;
/** Export jobs a user may have queued or rendering at once. */
export const MAX_ACTIVE_EXPORTS = 10;
/** Jobs still queued / rendering this long after creation are failed by the cleanup cron. */
export const EXPORT_STUCK_MS = 60 * 60_000;
