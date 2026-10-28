// Applies tool edits as one AI transaction and summarises what changed in a compact, model-friendly diff.

import { getNode, subtree } from "@desyn/doc-ops";
import { type Design, type Id, type Node, newId, type Op, type Transaction } from "@desyn/schema";
import { describeFills, textOf } from "../design/paint";
import { guardName, wrapUntrusted } from "../prompts/guard";
import type { ToolContext } from "./types";
import { ToolInputError } from "./types";

export interface NodeChange {
  id: Id;
  name: string;
  changes: string[];
}

export interface CompactDiff {
  created: { id: Id; type: string; name: string; role?: string }[];
  updated: NodeChange[];
  deleted: { id: Id; name: string }[];
  dropped: { index: number; reason: string }[];
}

const short = (s: string, n = 40) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function fmt(key: string, value: unknown, design: Design): string {
  if (value === undefined) return "∅";
  if (typeof value === "number") return String(Math.round(value * 100) / 100);
  if (typeof value === "string") return JSON.stringify(short(value));
  if (typeof value === "boolean") return String(value);
  if (key === "fills" || key === "background") return describeFills(value as never, design);
  if (key === "runs" && Array.isArray(value))
    return JSON.stringify(short((value as { text: string }[]).map((r) => r.text).join("")));
  if (key === "style" && value && typeof value === "object") {
    const s = value as {
      fontFamily?: string;
      fontSize?: number;
      fontWeight?: number;
      fills?: unknown;
    };
    return `${s.fontFamily ?? "?"} ${s.fontWeight ?? ""} ${s.fontSize ?? "?"}px ${describeFills(s.fills as never, design)}`.replace(
      /\s+/g,
      " ",
    );
  }
  const json = JSON.stringify(value);
  return short(json ?? "", 60);
}

function nodeChanges(before: Node, after: Node, design: Design): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const out: string[] = [];
  for (const k of keys) {
    if (k === "children" || k === "id" || k === "type") continue;
    const a = (before as unknown as Record<string, unknown>)[k];
    const b = (after as unknown as Record<string, unknown>)[k];
    if (JSON.stringify(a) === JSON.stringify(b)) continue;
    if (k === "parent") {
      out.push(`moved into ${String(b)}`);
      continue;
    }
    out.push(`${k}: ${fmt(k, a, design)} → ${fmt(k, b, design)}`);
  }
  return out;
}

function touchedIds(ops: Op[]): Id[] {
  const ids = new Set<Id>();
  for (const op of ops) {
    if (op.op === "create") for (const n of op.nodes) ids.add(n.id);
    else if (op.op === "update" || op.op === "patch" || op.op === "delete" || op.op === "move")
      ids.add(op.id);
  }
  return [...ids];
}

export function diffFor(
  before: Design,
  after: Design,
  ops: Op[],
  dropped: CompactDiff["dropped"],
): CompactDiff {
  const diff: CompactDiff = { created: [], updated: [], deleted: [], dropped };
  const createdIds = new Set(
    ops.flatMap((op) => (op.op === "create" ? op.nodes.map((n) => n.id) : [])),
  );
  for (const id of touchedIds(ops)) {
    const a = getNode(before, id);
    const b = getNode(after, id);
    if (!a && b) {
      diff.created.push({
        id,
        type: b.type,
        name: guardName(b.name),
        ...(b.role ? { role: b.role } : {}),
      });
    } else if (a && !b) {
      diff.deleted.push({ id, name: guardName(a.name) });
    } else if (a && b && !createdIds.has(id)) {
      const changes = nodeChanges(a, b, after);
      if (changes.length > 0)
        diff.updated.push({ id, name: guardName(b.name), changes: changes.slice(0, 8) });
    }
  }
  return diff;
}

export interface CommitResult {
  tx: Transaction;
  diff: CompactDiff;
  /** True when at least one op took effect. */
  changed: boolean;
}

/** Applies ops as one undoable AI transaction; throws ToolInputError when every op was dropped. */
export async function commit(ctx: ToolContext, ops: Op[], label: string): Promise<CommitResult> {
  if (ops.length === 0) throw new ToolInputError("Nothing to change.");
  const before = ctx.host.getDesign();
  const tx: Transaction = {
    id: newId(),
    label: label.startsWith("AI:") ? label : `AI: ${label}`,
    ops,
    source: "ai",
    actor: { runId: ctx.run.runId, agent: ctx.agentName ?? "desyn" },
    ts: Date.now(),
  };
  const result = await ctx.host.apply(tx);
  const after = ctx.host.getDesign();
  const dropped = result.dropped.map((d) => ({ index: d.index, reason: d.reason }));
  if (result.applied.length === 0) {
    throw new ToolInputError(
      `None of the changes could be applied (${dropped.map((d) => d.reason).join(", ") || "no-op"}).`,
      "Check the ids with query_elements or read_design and try again.",
    );
  }
  ctx.run.transactions.push(tx);
  for (const op of result.applied)
    if (op.op === "create") for (const n of op.nodes) ctx.run.created.add(n.id);
  const diff = diffFor(before, after, result.applied, dropped);
  ctx.emit({
    type: "applied-tx",
    runId: ctx.run.runId,
    tx,
    applied: result.applied.length,
    dropped,
    ops: result.applied,
    touched: touchedIds(result.applied),
  });
  return { tx, diff, changed: true };
}

/** One-line description of a node for tool results. */
export function nodeLabel(node: Node): string {
  const text =
    node.type === "text" ? ` ${wrapUntrusted("design-text", short(textOf(node), 30))}` : "";
  return `${node.type} ${node.id} "${guardName(node.name)}"${node.role ? ` (${node.role})` : ""}${text}`;
}

/** Ids of every node in a subtree (root first). */
export function subtreeIds(design: Design, id: Id): Id[] {
  return subtree(design, id).map((n) => n.id);
}
