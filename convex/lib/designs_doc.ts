import { applyOps, diffOps } from "@desyn/doc-ops";
import {
  type CreateOp,
  createRoot,
  type Design,
  type DroppedOp,
  emptyStyles,
  type Node,
  type Op,
  ROOT_ID,
  type Transaction,
} from "@desyn/schema";

// Pure helpers around whole Design documents: the empty base every design's history starts from, replay of
// the transaction log, splitting large creations into transactions that fit a Convex document, and derived
// per-node page ids.

/**
 * The state at seq 0 of every design. The first transactions of a design's log (written by create /
 * duplicate / import) turn this into the initial document, so any state can be rebuilt by replaying the log
 * from here or from a snapshot.
 */
export function emptyDesignBase(key: string): Design {
  return {
    schema: 1,
    id: key,
    name: "",
    kind: "custom",
    nodes: { [ROOT_ID]: createRoot() },
    assets: {},
    styles: emptyStyles(),
    meta: {},
  };
}

export function jsonBytes(value: unknown): number {
  return utf8Length(JSON.stringify(value));
}

export function utf8Length(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      bytes += 4;
      i++;
    } else bytes += 3;
  }
  return bytes;
}

function subtreeIds(byId: Map<string, Node>, rootId: string): Set<string> {
  const out = new Set<string>();
  const stack = [rootId];
  while (stack.length > 0) {
    const id = stack.pop() as string;
    if (out.has(id)) continue;
    out.add(id);
    const kids = (byId.get(id) as { children?: string[] } | undefined)?.children ?? [];
    for (const k of kids) stack.push(k);
  }
  return out;
}

/** Split a create op that serializes larger than `maxBytes` into a shell create plus one create per child. */
export function splitCreate(op: CreateOp, maxBytes: number): Op[] {
  if (jsonBytes(op) <= maxBytes) return [op];
  const [head, ...rest] = op.nodes;
  if (!head) return [op];
  const children = (head as { children?: string[] }).children ?? [];
  if (children.length === 0) {
    throw new Error(`node ${head.id} alone is larger than ${maxBytes} bytes`);
  }
  const byId = new Map<string, Node>(rest.map((n) => [n.id, n]));
  const shell = { ...head, children: [] } as unknown as Node;
  const out: Op[] = [
    {
      op: "create",
      nodes: [shell],
      parent: op.parent,
      ...(op.index !== undefined ? { index: op.index } : {}),
    },
  ];
  children.forEach((childId, index) => {
    const members = subtreeIds(byId, childId);
    const nodes = rest.filter((n) => members.has(n.id));
    out.push(...splitCreate({ op: "create", nodes, parent: head.id, index }, maxBytes));
  });
  return out;
}

/** Pack ops into groups whose JSON stays within `maxBytes` each (large creates are split first). */
export function chunkOps(ops: Op[], maxBytes: number): Op[][] {
  const flat = ops.flatMap((op) => (op.op === "create" ? splitCreate(op, maxBytes) : [op]));
  const chunks: Op[][] = [];
  let current: Op[] = [];
  let size = 2;
  for (const op of flat) {
    const bytes = jsonBytes(op) + 1;
    if (bytes > maxBytes) throw new Error(`an operation is larger than ${maxBytes} bytes`);
    if (current.length > 0 && size + bytes > maxBytes) {
      chunks.push(current);
      current = [];
      size = 2;
    }
    current.push(op);
    size += bytes;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

export interface HistoryChunk {
  ops: Op[];
  applied: Op[];
}

/**
 * Build the initial log for a design document: ops from the empty base to `design`, split to fit
 * `maxBytes`. Returns the applied ops per chunk and the resulting design (canonically equal to `design`).
 * Throws when the design cannot be reproduced (invalid structure).
 */
export function initialHistory(
  design: Design,
  maxBytes: number,
): { chunks: HistoryChunk[]; result: Design } {
  const base = emptyDesignBase(design.id);
  const ops = diffOps(base, design);
  const groups = chunkOps(ops, maxBytes);
  let state = base;
  const chunks: HistoryChunk[] = [];
  for (const group of groups) {
    const r = applyOps(state, group);
    if (r.dropped.length > 0) {
      const first = r.dropped[0] as DroppedOp;
      throw new Error(`invalid design: operation ${first.index} dropped (${first.reason})`);
    }
    chunks.push({ ops: group, applied: r.applied });
    state = r.design;
  }
  return { chunks, result: state };
}

/** Replay accepted transactions (their `ops` are the server-applied ops) onto a design. */
export function replay(design: Design, txs: Transaction[]): { design: Design; dropped: number } {
  let state = design;
  let dropped = 0;
  for (const tx of txs) {
    const r = applyOps(state, tx.ops, { validateNodes: false });
    dropped += r.dropped.length;
    state = r.design;
  }
  return { design: state, dropped };
}

/** Page id of every node (the page itself for pages, null for the root). */
export function pageIds(design: Design): Map<string, string | null> {
  const out = new Map<string, string | null>([[ROOT_ID, null]]);
  const root = design.nodes[ROOT_ID] as { children?: string[] } | undefined;
  for (const pageId of root?.children ?? []) {
    const stack = [pageId];
    while (stack.length > 0) {
      const id = stack.pop() as string;
      out.set(id, pageId);
      const kids = (design.nodes[id] as { children?: string[] } | undefined)?.children ?? [];
      for (const k of kids) stack.push(k);
    }
  }
  return out;
}

/** First page size of a design (dashboard cards); 0x0 when there is no page. */
export function firstPageSize(design: Design): { width: number; height: number } {
  const root = design.nodes[ROOT_ID] as { children?: string[] } | undefined;
  const first = root?.children?.[0];
  const page = first ? design.nodes[first] : undefined;
  return { width: page?.width ?? 0, height: page?.height ?? 0 };
}

export function pageCountOf(design: Design): number {
  return ((design.nodes[ROOT_ID] as { children?: string[] } | undefined)?.children ?? []).length;
}
