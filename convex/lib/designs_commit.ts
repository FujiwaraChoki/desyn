import { applyOps } from "@desyn/doc-ops";
import {
  type AssetRef,
  type Design,
  type DesignStyles,
  type DroppedOp,
  emptyStyles,
  isId,
  type Node,
  type Op,
  ROOT_ID,
  TRANSACTION_SOURCES,
  type Transaction,
  type TransactionSource,
} from "@desyn/schema";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { jsonBytes, utf8Length } from "./designs_doc";
import {
  MAX_INLINE_SVG_BYTES,
  MAX_LABEL_LENGTH,
  MAX_NODE_BYTES,
  MAX_NODES_PER_DESIGN,
  MAX_OPS_PER_TX,
  MAX_STATE_BYTES,
  MAX_TX_BYTES,
  SCHEDULE_STALE_MS,
  SNAPSHOT_EVERY_TX,
  SNAPSHOT_IDLE_MS,
  THUMBNAIL_DEBOUNCE_MS,
} from "./designs_limits";
import { SvgSanitizeError, sanitizeSvg } from "./designs_svg";
import type { CommitResult } from "./designs_wire";
import { getWorkspacePlan } from "./entitlements";
import { env } from "./env";
import { appError, errors } from "./errors";
import { PLANS } from "./plans";

// designs.commit (DOCUMENT_MODEL §6): apply a transaction to the materialized node documents with the
// @desyn/doc-ops applier. Only the nodes the transaction can touch are loaded (targets, parents, ancestor
// chains of new parents for the cycle check, subtrees of deleted nodes), assembled into a partial Design,
// and the result is diffed back into node documents. Ops apply to the current server state (not to
// baseSeq), so concurrent commits resolve with last-writer-wins per property and server order for structure.

const SOURCES: ReadonlySet<string> = new Set(TRANSACTION_SOURCES);
const STATE_OPS: ReadonlySet<unknown> = new Set(["asset", "styles", "doc"]);

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string";

/** Validate the transaction envelope (ops are validated one by one by the applier). */
export function parseTransaction(input: unknown): Transaction {
  let raw: unknown = input;
  if (typeof input === "string") {
    if (utf8Length(input) > MAX_TX_BYTES) {
      throw errors.invalid(`The transaction is larger than ${MAX_TX_BYTES} bytes; split it.`, "tx");
    }
    try {
      raw = JSON.parse(input);
    } catch {
      throw errors.invalid("The transaction is not valid JSON.", "tx");
    }
  } else if (jsonBytes(input) > MAX_TX_BYTES) {
    throw errors.invalid(`The transaction is larger than ${MAX_TX_BYTES} bytes; split it.`, "tx");
  }
  if (!isObj(raw)) throw errors.invalid("The transaction must be an object.", "tx");
  if (!isId(raw.id)) throw errors.invalid("tx.id must be a 12 character [a-z0-9] id.", "tx.id");
  if (!isStr(raw.label) || raw.label.length > MAX_LABEL_LENGTH) {
    throw errors.invalid(
      `tx.label must be a string of at most ${MAX_LABEL_LENGTH} characters.`,
      "tx.label",
    );
  }
  if (!Array.isArray(raw.ops)) throw errors.invalid("tx.ops must be an array.", "tx.ops");
  if (raw.ops.length > MAX_OPS_PER_TX) {
    throw errors.invalid(`A transaction may contain at most ${MAX_OPS_PER_TX} ops.`, "tx.ops");
  }
  if (!isStr(raw.source) || !SOURCES.has(raw.source)) {
    throw errors.invalid("tx.source is not a known source.", "tx.source");
  }
  if (typeof raw.ts !== "number" || !Number.isFinite(raw.ts)) {
    throw errors.invalid("tx.ts must be a number.", "tx.ts");
  }
  if (raw.actor !== undefined && !isObj(raw.actor))
    throw errors.invalid("tx.actor must be an object.", "tx.actor");
  const actor = isObj(raw.actor) ? raw.actor : undefined;
  const tx: Transaction = {
    id: raw.id,
    label: raw.label,
    ops: raw.ops as Op[],
    source: raw.source as TransactionSource,
    ts: raw.ts,
  };
  if (actor) {
    tx.actor = {};
    if (isStr(actor.runId)) tx.actor.runId = actor.runId.slice(0, 64);
    if (isStr(actor.agent)) tx.actor.agent = actor.agent.slice(0, 64);
  }
  return tx;
}

/**
 * Sanitize inline SVG markup carried by ops (create nodes, update.set.markup, patch ["markup"]). Ops whose
 * markup cannot be sanitized are replaced by null so the applier drops them; their indices are returned so
 * the drop reason can be reported as "invalid-value".
 */
export function sanitizeOpsSvg(ops: unknown[]): { ops: unknown[]; invalid: Set<number> } {
  const invalid = new Set<number>();
  const clean = (markup: unknown): string | null => {
    if (!isStr(markup)) return null;
    if (utf8Length(markup) > MAX_INLINE_SVG_BYTES) return null;
    try {
      return sanitizeSvg(markup).svg;
    } catch (err) {
      if (err instanceof SvgSanitizeError) return null;
      throw err;
    }
  };
  const out = ops.map((op, index) => {
    if (!isObj(op)) return op;
    if (op.op === "create" && Array.isArray(op.nodes)) {
      let touched = false;
      const nodes = op.nodes.map((n) => {
        if (!isObj(n) || n.type !== "svg" || !("markup" in n)) return n;
        const safe = clean(n.markup);
        touched = true;
        return safe === null ? null : { ...n, markup: safe };
      });
      if (!touched) return op;
      if (nodes.includes(null)) {
        invalid.add(index);
        return null;
      }
      return { ...op, nodes };
    }
    if (op.op === "update" && isObj(op.set) && "markup" in op.set) {
      const safe = clean(op.set.markup);
      if (safe === null) {
        invalid.add(index);
        return null;
      }
      return { ...op, set: { ...op.set, markup: safe } };
    }
    if (op.op === "patch" && Array.isArray(op.path) && op.path[0] === "markup") {
      const safe = op.path.length === 1 ? clean(op.value) : null;
      if (safe === null) {
        invalid.add(index);
        return null;
      }
      return { ...op, value: safe };
    }
    return op;
  });
  return { ops: out, invalid };
}

/** Lazily loads node documents of one design, caching documents and parsed nodes. */
export class NodeLoader {
  readonly docs = new Map<string, Doc<"nodes"> | null>();
  /** Parsed nodes keyed by id; this object is the `nodes` map of the partial design. */
  readonly nodes: Record<string, Node> = {};
  private readonly expanded = new Set<string>();

  constructor(
    private readonly ctx: MutationCtx,
    private readonly designId: Id<"designs">,
  ) {}

  private remember(doc: Doc<"nodes">): void {
    if (this.docs.get(doc.nodeId)) return;
    this.docs.set(doc.nodeId, doc);
    this.nodes[doc.nodeId] = JSON.parse(doc.data) as Node;
  }

  async get(id: string): Promise<Doc<"nodes"> | null> {
    const cached = this.docs.get(id);
    if (cached !== undefined) return cached;
    const doc = await this.ctx.db
      .query("nodes")
      .withIndex("by_design_node", (q) => q.eq("designId", this.designId).eq("nodeId", id))
      .unique();
    if (doc) this.remember(doc);
    else this.docs.set(id, null);
    return doc;
  }

  /** Load a node and every descendant (one indexed query per container). */
  async subtree(id: string): Promise<void> {
    if (!(await this.get(id))) return;
    const stack = [id];
    while (stack.length > 0) {
      const cur = stack.pop() as string;
      if (this.expanded.has(cur)) continue;
      this.expanded.add(cur);
      const node = this.nodes[cur] as { children?: string[] } | undefined;
      if (!node?.children || node.children.length === 0) continue;
      const kids = await this.ctx.db
        .query("nodes")
        .withIndex("by_design_parent", (q) => q.eq("designId", this.designId).eq("parentId", cur))
        .collect();
      for (const kid of kids) {
        this.remember(kid);
        stack.push(kid.nodeId);
      }
    }
  }

  /** Load the ancestor chain of a node (up to the root). */
  async ancestors(id: string): Promise<void> {
    let cur = await this.get(id);
    let guard = 0;
    while (cur?.parentId && guard++ < 1_000) cur = await this.get(cur.parentId);
  }

  /** Children of a node as of the database (for nodes the transaction did not change). */
  childrenOf(id: string): string[] {
    return (this.nodes[id] as { children?: string[] } | undefined)?.children ?? [];
  }
}

/** Load everything the applier can read for these ops (see the closure argument in the module comment). */
export async function prefetchForOps(loader: NodeLoader, ops: unknown[]): Promise<void> {
  const hasDelete = ops.some((op) => isObj(op) && op.op === "delete");
  const hasMove = ops.some((op) => isObj(op) && op.op === "move");
  for (const op of ops) {
    if (!isObj(op)) continue;
    switch (op.op) {
      case "create":
        if (isStr(op.parent)) {
          await loader.get(op.parent);
          if (hasMove) await loader.ancestors(op.parent);
        }
        if (Array.isArray(op.nodes)) {
          for (const n of op.nodes) if (isObj(n) && isStr(n.id)) await loader.get(n.id);
        }
        break;
      case "update":
      case "patch":
        if (isStr(op.id)) await loader.get(op.id);
        break;
      case "delete":
        if (isStr(op.id)) {
          const doc = await loader.get(op.id);
          if (doc) {
            await loader.subtree(op.id);
            if (doc.parentId) await loader.get(doc.parentId);
          }
        }
        break;
      case "move":
        if (isStr(op.id)) {
          const doc = await loader.get(op.id);
          if (doc?.parentId) await loader.get(doc.parentId);
          if (doc && hasDelete) await loader.subtree(op.id);
        }
        if (isStr(op.parent)) await loader.ancestors(op.parent);
        break;
      default:
        break;
    }
  }
}

export async function getSeqDoc(
  ctx: MutationCtx,
  designId: Id<"designs">,
): Promise<Doc<"designSeq">> {
  const doc = await ctx.db
    .query("designSeq")
    .withIndex("by_design", (q) => q.eq("designId", designId))
    .unique();
  if (!doc) throw appError("INTERNAL", "Design sequence document is missing.");
  return doc;
}

export async function getStateDoc(
  ctx: MutationCtx,
  designId: Id<"designs">,
): Promise<Doc<"designState">> {
  const doc = await ctx.db
    .query("designState")
    .withIndex("by_design", (q) => q.eq("designId", designId))
    .unique();
  if (!doc) throw appError("INTERNAL", "Design state document is missing.");
  return doc;
}

export interface CommitInput {
  design: Doc<"designs">;
  tx: unknown;
  actorId: string;
  baseSeq?: number;
}

/** Apply a transaction. Idempotent on tx.id. Throws ConvexError for envelope / limit violations. */
export async function commitTransaction(
  ctx: MutationCtx,
  input: CommitInput,
): Promise<CommitResult> {
  const design = input.design;
  if (design.state === "trashed")
    throw errors.conflict("Restore the design from the trash to edit it.");
  if (design.state === "creating") throw errors.notFound("Design");
  const tx = parseTransaction(input.tx);

  const existing = await ctx.db
    .query("designOps")
    .withIndex("by_design_txId", (q) => q.eq("designId", design._id).eq("txId", tx.id))
    .first();
  if (existing) {
    const stored = JSON.parse(existing.tx) as Transaction;
    return {
      seq: existing.seq,
      applied: JSON.stringify(stored.ops),
      dropped: JSON.parse(existing.dropped) as DroppedOp[],
      duplicate: true,
    };
  }

  const seqDoc = await getSeqDoc(ctx, design._id);
  if (input.baseSeq !== undefined && input.baseSeq > seqDoc.seq) {
    throw errors.invalid("baseSeq is ahead of the server; reload the design.", "baseSeq");
  }

  const { ops, invalid } = sanitizeOpsSvg(tx.ops as unknown[]);
  const loader = new NodeLoader(ctx, design._id);
  await prefetchForOps(loader, ops);

  const needsState = ops.some((op) => isObj(op) && STATE_OPS.has(op.op));
  const stateDoc = needsState ? await getStateDoc(ctx, design._id) : null;
  const partial: Design = {
    schema: 1,
    id: design.key,
    name: design.name,
    kind: design.kind as Design["kind"],
    nodes: loader.nodes,
    assets: stateDoc ? (JSON.parse(stateDoc.assets) as Record<string, AssetRef>) : {},
    styles: stateDoc ? (JSON.parse(stateDoc.styles) as DesignStyles) : emptyStyles(),
    meta: stateDoc ? (JSON.parse(stateDoc.meta) as Design["meta"]) : {},
  };
  const brandKitId = stateDoc ? stateDoc.brandKitId : design.brandKitId;
  if (brandKitId !== undefined) partial.brandKitId = brandKitId;

  const result = applyOps(partial, ops);
  const dropped: DroppedOp[] = result.dropped.map((d) =>
    invalid.has(d.index) ? { index: d.index, reason: "invalid-value" } : d,
  );
  const now = Date.now();
  if (result.applied.length === 0) {
    // Every accepted transaction gets a seq, even when all of its ops were dropped: clients receive the
    // echo through designOps.since (and retire the pending transaction) and retries stay idempotent.
    const seq = seqDoc.seq + 1;
    await insertLogEntry(ctx, design._id, seq, tx, [], dropped, input.actorId, now);
    await ctx.db.patch("designSeq", seqDoc._id, {
      seq,
      lastCommitAt: now,
      lastActor: input.actorId,
    });
    return { seq, applied: "[]", dropped, duplicate: false };
  }
  const after = result.design;

  // --- node writes ----------------------------------------------------------------------------------------
  const before = partial.nodes;
  const upserts: Node[] = [];
  const deletes: string[] = [];
  for (const id of Object.keys(after.nodes)) {
    if (before[id] !== after.nodes[id]) upserts.push(after.nodes[id] as Node);
  }
  for (const id of Object.keys(before)) if (!Object.hasOwn(after.nodes, id)) deletes.push(id);

  const pageOf = await resolvePages(loader, after, result.applied);

  let nodeDelta = 0;
  let bytesDelta = 0;
  const serialized = upserts.map((node) => {
    const data = JSON.stringify(node);
    const bytes = utf8Length(data);
    if (bytes > MAX_NODE_BYTES) {
      throw errors.invalid(`Node ${node.id} is larger than ${MAX_NODE_BYTES} bytes.`, "tx.ops");
    }
    return { node, data, bytes };
  });
  const inserts = serialized.filter((s) => !loader.docs.get(s.node.id)).length;
  nodeDelta = inserts - deletes.length;
  if (seqDoc.nodeCount + nodeDelta > MAX_NODES_PER_DESIGN) {
    throw appError("LIMIT_REACHED", `A design can have at most ${MAX_NODES_PER_DESIGN} layers.`, {
      limit: "nodesPerDesign",
      max: MAX_NODES_PER_DESIGN,
      current: seqDoc.nodeCount,
    });
  }

  // Page count (root children) and the plan's pagesPerDesign limit.
  const rootChanged = before[ROOT_ID] !== undefined && before[ROOT_ID] !== after.nodes[ROOT_ID];
  const pageCount = rootChanged
    ? ((after.nodes[ROOT_ID] as { children?: string[] }).children ?? []).length
    : design.pageCount;
  if (pageCount > design.pageCount) {
    const max = PLANS[await getWorkspacePlan(ctx, design.workspaceId)].limits.pagesPerDesign;
    if (max !== null && pageCount > max)
      throw errors.limit("pagesPerDesign", max, design.pageCount);
  }

  for (const s of serialized) {
    const doc = loader.docs.get(s.node.id);
    const pageId = pageOf.get(s.node.id) ?? null;
    if (doc) {
      bytesDelta += s.bytes - doc.bytes;
      await ctx.db.patch("nodes", doc._id, {
        data: s.data,
        bytes: s.bytes,
        parentId: s.node.parent,
        pageId,
      });
    } else {
      bytesDelta += s.bytes;
      await ctx.db.insert("nodes", {
        designId: design._id,
        nodeId: s.node.id,
        pageId,
        parentId: s.node.parent,
        data: s.data,
        bytes: s.bytes,
      });
    }
  }
  for (const id of deletes) {
    const doc = loader.docs.get(id);
    if (doc) {
      bytesDelta -= doc.bytes;
      await ctx.db.delete("nodes", doc._id);
    }
  }
  // Descendants of nodes moved to another page keep their data but change pageId.
  const upserted = new Set(upserts.map((n) => n.id));
  for (const [id, pageId] of pageOf) {
    if (upserted.has(id)) continue;
    const doc = loader.docs.get(id);
    if (doc && doc.pageId !== pageId) await ctx.db.patch("nodes", doc._id, { pageId });
  }

  // --- design-level state ---------------------------------------------------------------------------------
  if (stateDoc) {
    const statePatch: Partial<Doc<"designState">> = {};
    if (after.assets !== partial.assets) statePatch.assets = boundedJson(after.assets, "assets");
    if (after.styles !== partial.styles) statePatch.styles = boundedJson(after.styles, "styles");
    if (after.meta !== partial.meta) statePatch.meta = boundedJson(after.meta, "meta");
    if (after.brandKitId !== partial.brandKitId) statePatch.brandKitId = after.brandKitId;
    if (Object.keys(statePatch).length > 0)
      await ctx.db.patch("designState", stateDoc._id, statePatch);
    await syncDesignAssets(ctx, design, result.applied);
  }

  const designPatch: Partial<Doc<"designs">> = {};
  if (after.name !== design.name) designPatch.name = after.name.slice(0, 200);
  if (after.kind !== design.kind) designPatch.kind = after.kind;
  if (after.brandKitId !== design.brandKitId) designPatch.brandKitId = after.brandKitId;
  if (pageCount !== design.pageCount) designPatch.pageCount = pageCount;
  const size = await firstPageSizeAfter(loader, after);
  if (size && (size.width !== design.width || size.height !== design.height)) {
    designPatch.width = size.width;
    designPatch.height = size.height;
  }
  // updatedAt drives "recent" lists; refresh it at most every 30 s so list queries are not invalidated
  // on every keystroke-level commit.
  if (Object.keys(designPatch).length > 0 || now - design.updatedAt > 30_000)
    designPatch.updatedAt = now;
  if (Object.keys(designPatch).length > 0) await ctx.db.patch("designs", design._id, designPatch);

  // --- log ------------------------------------------------------------------------------------------------
  const seq = seqDoc.seq + 1;
  await insertLogEntry(ctx, design._id, seq, tx, result.applied, dropped, input.actorId, now);

  const seqPatch: Partial<Doc<"designSeq">> = {
    seq,
    nodeCount: seqDoc.nodeCount + nodeDelta,
    bytes: Math.max(0, seqDoc.bytes + bytesDelta),
    lastCommitAt: now,
    lastActor: input.actorId,
  };
  const snapshotSeq = design.snapshot?.seq ?? 0;
  const due = seq - snapshotSeq >= SNAPSHOT_EVERY_TX;
  // A schedule marker far in the past means the scheduled action died without clearing it (timeout,
  // crash); treat it as absent so auto snapshots / thumbnails never stop for the design.
  const snapshotStale =
    seqDoc.snapshotAt !== undefined && seqDoc.snapshotAt < now - SCHEDULE_STALE_MS;
  if (
    seqDoc.snapshotAt === undefined ||
    snapshotStale ||
    (due && seqDoc.snapshotAt > now + 1_000)
  ) {
    const delay = due ? 0 : SNAPSHOT_IDLE_MS;
    await ctx.scheduler.runAfter(delay, internal.designs.snapshotNode.run, {
      designId: design._id,
      reason: "auto",
    });
    seqPatch.snapshotAt = now + delay;
  }
  const thumbnailStale =
    seqDoc.thumbnailAt !== undefined && seqDoc.thumbnailAt < now - SCHEDULE_STALE_MS;
  if ((seqDoc.thumbnailAt === undefined || thumbnailStale) && env.has("RENDER_WORKER_URL")) {
    await ctx.scheduler.runAfter(THUMBNAIL_DEBOUNCE_MS, internal.designs.renderNode.thumbnail, {
      designId: design._id,
    });
    seqPatch.thumbnailAt = now + THUMBNAIL_DEBOUNCE_MS;
  }
  await ctx.db.patch("designSeq", seqDoc._id, seqPatch);

  return { seq, applied: JSON.stringify(result.applied), dropped, duplicate: false };
}

async function insertLogEntry(
  ctx: MutationCtx,
  designId: Id<"designs">,
  seq: number,
  tx: Transaction,
  applied: Op[],
  dropped: DroppedOp[],
  actorId: string,
  now: number,
): Promise<void> {
  const stored: Transaction = {
    id: tx.id,
    label: tx.label,
    ops: applied,
    source: tx.source,
    actor: { ...(tx.actor ?? {}), userId: actorId },
    ts: tx.ts,
  };
  const txJson = JSON.stringify(stored);
  await ctx.db.insert("designOps", {
    designId,
    seq,
    txId: tx.id,
    tx: txJson,
    dropped: JSON.stringify(dropped),
    actor: actorId,
    source: tx.source,
    label: tx.label,
    ts: now,
    bytes: utf8Length(txJson),
  });
}

function boundedJson(value: unknown, field: string): string {
  const json = JSON.stringify(value);
  if (utf8Length(json) > MAX_STATE_BYTES) {
    throw errors.invalid(`Design ${field} would exceed ${MAX_STATE_BYTES} bytes.`, "tx.ops");
  }
  return json;
}

/**
 * Page id for every node whose page may have changed: created and moved nodes, plus every descendant of a
 * node that moved to a different page. Returns ids -> page id (null for the root).
 */
async function resolvePages(
  loader: NodeLoader,
  after: Design,
  applied: Op[],
): Promise<Map<string, string | null>> {
  const memo = new Map<string, string | null>();
  const nodeAfter = async (id: string): Promise<Node | undefined> => {
    if (Object.hasOwn(after.nodes, id)) return after.nodes[id];
    await loader.get(id);
    return loader.nodes[id];
  };
  const pageOf = async (id: string, depth = 0): Promise<string | null> => {
    const known = memo.get(id);
    if (known !== undefined) return known;
    const node = await nodeAfter(id);
    let page: string | null;
    if (!node || node.type === "root" || depth > 1_000) page = null;
    else if (node.type === "page") page = id;
    else {
      const doc = loader.docs.get(id);
      // Unchanged parent: the stored page is right unless an ancestor moved (handled below).
      page =
        doc && doc.parentId === node.parent
          ? doc.pageId
          : await pageOf(node.parent as string, depth + 1);
    }
    memo.set(id, page);
    return page;
  };

  const out = new Map<string, string | null>();
  for (const id of Object.keys(after.nodes)) {
    if (loader.nodes[id] !== after.nodes[id]) out.set(id, await pageOf(id));
  }
  // Moved subtrees that changed page: every descendant takes the new page.
  for (const op of applied) {
    if (op.op !== "move") continue;
    const doc = loader.docs.get(op.id);
    const moved = after.nodes[op.id];
    if (!moved || moved.type === "page") continue;
    const target = await pageOf(moved.parent as string);
    out.set(op.id, target);
    if (doc && doc.pageId === target) continue;
    const stack = [...childIdsAfter(after, loader, op.id)];
    while (stack.length > 0) {
      const id = stack.pop() as string;
      if (!Object.hasOwn(after.nodes, id)) await loader.get(id);
      out.set(id, target);
      memo.set(id, target);
      stack.push(...childIdsAfter(after, loader, id));
    }
  }
  return out;
}

function childIdsAfter(after: Design, loader: NodeLoader, id: string): string[] {
  const node = Object.hasOwn(after.nodes, id) ? after.nodes[id] : loader.nodes[id];
  return (node as { children?: string[] } | undefined)?.children ?? [];
}

async function firstPageSizeAfter(
  loader: NodeLoader,
  after: Design,
): Promise<{ width: number; height: number } | null> {
  const root = after.nodes[ROOT_ID] as { children?: string[] } | undefined;
  const changedPage = Object.values(after.nodes).some(
    (n) => n.type === "page" && loader.nodes[n.id] !== n,
  );
  if (!root && !changedPage) return null;
  let firstId = root?.children?.[0];
  if (!firstId) {
    if (root) return { width: 0, height: 0 };
    await loader.get(ROOT_ID);
    firstId = (loader.nodes[ROOT_ID] as { children?: string[] } | undefined)?.children?.[0];
  }
  if (!firstId) return { width: 0, height: 0 };
  if (!Object.hasOwn(after.nodes, firstId)) await loader.get(firstId);
  const page = Object.hasOwn(after.nodes, firstId) ? after.nodes[firstId] : loader.nodes[firstId];
  return page ? { width: page.width, height: page.height } : null;
}

/** Keep designAssets in sync with `asset` ops (references to uploaded assets by refId). */
async function syncDesignAssets(
  ctx: MutationCtx,
  design: Doc<"designs">,
  applied: Op[],
): Promise<void> {
  for (const op of applied) {
    if (op.op !== "asset") continue;
    for (const ref of Object.keys(op.set ?? {})) await linkDesignAsset(ctx, design, ref);
    for (const ref of op.remove ?? []) {
      const rows = await ctx.db
        .query("designAssets")
        .withIndex("by_design_ref", (q) => q.eq("designId", design._id).eq("ref", ref))
        .collect();
      for (const row of rows) await ctx.db.delete("designAssets", row._id);
    }
  }
}

/** Record that a design references an uploaded asset (same workspace or system library only). */
export async function linkDesignAsset(
  ctx: MutationCtx,
  design: Pick<Doc<"designs">, "_id" | "workspaceId">,
  ref: string,
): Promise<void> {
  const existing = await ctx.db
    .query("designAssets")
    .withIndex("by_design_ref", (q) => q.eq("designId", design._id).eq("ref", ref))
    .first();
  if (existing) return;
  const asset = await findAssetForWorkspace(ctx, design.workspaceId, ref);
  if (!asset) return;
  await ctx.db.insert("designAssets", { designId: design._id, assetId: asset._id, ref });
}

/** The asset a workspace's designs mean by `ref`: the workspace's own row, else a system library asset. */
export async function findAssetForWorkspace(
  ctx: QueryCtx | MutationCtx,
  workspaceId: Id<"workspaces">,
  ref: string,
): Promise<Doc<"assets"> | null> {
  const own = await ctx.db
    .query("assets")
    .withIndex("by_workspace_refId", (q) => q.eq("workspaceId", workspaceId).eq("refId", ref))
    .first();
  if (own) return own.status === "deleted" && own.purgedAt ? null : own;
  return await ctx.db
    .query("assets")
    .withIndex("by_workspace_refId", (q) => q.eq("workspaceId", undefined).eq("refId", ref))
    .first();
}
