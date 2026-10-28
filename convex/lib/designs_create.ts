import { type Design, newId, type Transaction, type TransactionSource } from "@desyn/schema";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { linkDesignAsset } from "./designs_commit";
import { firstPageSize, initialHistory, pageCountOf, pageIds, utf8Length } from "./designs_doc";
import {
  MAX_NAME_LENGTH,
  MAX_NODE_BYTES,
  MAX_NODES_PER_DESIGN,
  MAX_STATE_BYTES,
  MAX_TX_BYTES,
} from "./designs_limits";
import { appError, errors } from "./errors";

// Insert a complete Design document as a new design: node documents, design-level state, and the initial
// transaction log (from the empty base, see designs_doc.ts) so snapshots can always be rebuilt by replay.

export interface InsertDesignInput {
  workspaceId: Id<"workspaces">;
  ownerId: string;
  folderId?: Id<"folders">;
  design: Design;
  source: TransactionSource;
  label: string;
  templateId?: Id<"templates">;
}

/** Leaves room for the transaction envelope around the ops. */
const HISTORY_CHUNK_BYTES = MAX_TX_BYTES - 4_000;

export async function insertDesignDocument(
  ctx: MutationCtx,
  input: InsertDesignInput,
): Promise<Id<"designs">> {
  const design = input.design;
  const nodeCount = Object.keys(design.nodes).length;
  if (nodeCount > MAX_NODES_PER_DESIGN) {
    throw appError("LIMIT_REACHED", `A design can have at most ${MAX_NODES_PER_DESIGN} layers.`, {
      limit: "nodesPerDesign",
      max: MAX_NODES_PER_DESIGN,
      current: nodeCount,
    });
  }
  const assetsJson = JSON.stringify(design.assets);
  const stylesJson = JSON.stringify(design.styles);
  const metaJson = JSON.stringify(design.meta ?? {});
  for (const [field, json] of [
    ["assets", assetsJson],
    ["styles", stylesJson],
    ["meta", metaJson],
  ] as const) {
    if (utf8Length(json) > MAX_STATE_BYTES)
      throw errors.invalid(`Design ${field} is too large.`, field);
  }

  let history: ReturnType<typeof initialHistory>;
  try {
    history = initialHistory(design, HISTORY_CHUNK_BYTES);
  } catch (err) {
    throw errors.invalid(err instanceof Error ? err.message : "The design is not valid.", "design");
  }
  const now = Date.now();
  const size = firstPageSize(history.result);
  const name = (design.name.trim() || "Untitled design").slice(0, MAX_NAME_LENGTH);
  const designId = await ctx.db.insert("designs", {
    workspaceId: input.workspaceId,
    ownerId: input.ownerId,
    ...(input.folderId ? { folderId: input.folderId } : {}),
    key: design.id,
    kind: design.kind,
    name,
    state: "active",
    pageCount: pageCountOf(history.result),
    width: size.width,
    height: size.height,
    ...(input.templateId ? { templateId: input.templateId } : {}),
    ...(design.brandKitId !== undefined ? { brandKitId: design.brandKitId } : {}),
    shareCount: 0,
    createdAt: now,
    updatedAt: now,
  });

  const pages = pageIds(history.result);
  let bytes = 0;
  for (const node of Object.values(history.result.nodes)) {
    const data = JSON.stringify(node);
    const size = utf8Length(data);
    if (size > MAX_NODE_BYTES) throw errors.invalid(`Node ${node.id} is too large.`, "design");
    bytes += size;
    await ctx.db.insert("nodes", {
      designId,
      nodeId: node.id,
      pageId: pages.get(node.id) ?? null,
      parentId: node.parent,
      data,
      bytes: size,
    });
  }

  let seq = 0;
  for (const chunk of history.chunks) {
    seq++;
    const tx: Transaction = {
      id: newId(),
      label: input.label,
      ops: chunk.applied,
      source: input.source,
      actor: { userId: input.ownerId },
      ts: now,
    };
    const txJson = JSON.stringify(tx);
    await ctx.db.insert("designOps", {
      designId,
      seq,
      txId: tx.id,
      tx: txJson,
      dropped: "[]",
      actor: input.ownerId,
      source: input.source,
      label: input.label,
      ts: now,
      bytes: utf8Length(txJson),
    });
  }

  await ctx.db.insert("designSeq", {
    designId,
    seq,
    nodeCount,
    bytes,
    lastCommitAt: now,
    lastActor: input.ownerId,
  });
  await ctx.db.insert("designState", {
    designId,
    assets: assetsJson,
    styles: stylesJson,
    meta: metaJson,
    ...(design.brandKitId !== undefined ? { brandKitId: design.brandKitId } : {}),
  });
  for (const ref of Object.keys(design.assets)) {
    await linkDesignAsset(ctx, { _id: designId, workspaceId: input.workspaceId }, ref);
  }
  return designId;
}
