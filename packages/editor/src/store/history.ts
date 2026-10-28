import { compose } from "@desyn/doc-ops";
import type { Id, Op, Transaction } from "@desyn/schema";
import type { HistoryState } from "./editor-store.ts";

/**
 * Per-user undo / redo as inverse transactions (DOCUMENT_MODEL §5: "undo groups map 1:1 to transactions").
 *
 * - Only own transactions are recorded. Remote transactions never enter the stacks; instead
 *   `rebaseRemote` removes from recorded inverses (and redo forwards) every property a collaborator changed
 *   since, so undo restores *your* previous values without clobbering their newer ones.
 * - Coalescing: consecutive entries with the same `coalesceKey` within `coalesceMs` merge into one step
 *   (inspector scrubbing, nudging with arrow keys, typing bursts); consecutive transactions of one AI / workflow
 *   run (`actor.runId`) always merge (§6). Drags are one transaction already (preview -> commitPreview).
 * - Undo applies the recorded inverse as a new transaction; the inverse of *that* application (computed
 *   against the then-current state) becomes the redo entry, and vice versa, so redo stays exact even after
 *   remote changes.
 */

export interface HistoryEntry {
  id: string;
  label: string;
  /** What the step did (server-applied form of the own transaction). */
  forward: Transaction;
  /** Applying this undoes the step. */
  inverse: Transaction;
  coalesceKey?: string;
  runId?: string;
  ts: number;
  selectionBefore: Id[];
  selectionAfter: Id[];
  pageBefore: Id | null;
  pageAfter: Id | null;
}

export interface RecordOptions {
  /** Merge into the previous entry when it has the same key (within `coalesceMs`). */
  coalesceKey?: string;
}

const DEFAULT_LIMIT = 200;
const DEFAULT_COALESCE_MS = 1200;

/** Property-level footprint of ops: "<target>\u0000<key>" strings. */
export function footprint(ops: readonly Op[]): Set<string> {
  const out = new Set<string>();
  const add = (target: string, key: string | number | undefined) =>
    out.add(`${target}\u0000${String(key ?? "*")}`);
  for (const op of ops) {
    switch (op.op) {
      case "update":
        for (const k of Object.keys(op.set ?? {})) add(op.id, k);
        for (const k of op.unset ?? []) add(op.id, k);
        break;
      case "patch":
        add(op.id, op.path[0]);
        break;
      case "move":
        add(op.id, "$position");
        break;
      case "styles":
        add("$styles", op.path[0]);
        break;
      case "doc":
        for (const k of Object.keys(op.set ?? {})) add("$doc", k);
        for (const k of op.unset ?? []) add("$doc", k);
        break;
      case "asset":
        for (const k of Object.keys(op.set ?? {})) add("$asset", k);
        for (const k of op.remove ?? []) add("$asset", k);
        break;
      case "create":
      case "delete":
        break;
    }
  }
  return out;
}

const has = (touched: Set<string>, target: string, key: string | number | undefined) =>
  touched.has(`${target}\u0000${String(key ?? "*")}`) || touched.has(`${target}\u0000*`);

/** Removes from `ops` every property write that `touched` (a remote footprint) covers. */
export function pruneOps(ops: readonly Op[], touched: Set<string>): Op[] {
  if (touched.size === 0) return [...ops];
  const out: Op[] = [];
  for (const op of ops) {
    switch (op.op) {
      case "update": {
        const set: Record<string, unknown> = {};
        let kept = 0;
        for (const [k, v] of Object.entries(op.set ?? {})) {
          if (!has(touched, op.id, k)) {
            set[k] = v;
            kept++;
          }
        }
        const unset = (op.unset ?? []).filter((k) => !has(touched, op.id, k));
        if (kept === 0 && unset.length === 0) break;
        const next: Extract<Op, { op: "update" }> = { op: "update", id: op.id };
        if (kept > 0) next.set = set;
        if (unset.length > 0) next.unset = unset;
        out.push(next);
        break;
      }
      case "patch":
        if (!has(touched, op.id, op.path[0])) out.push(op);
        break;
      case "move":
        if (!has(touched, op.id, "$position")) out.push(op);
        break;
      case "styles":
        if (!has(touched, "$styles", op.path[0])) out.push(op);
        break;
      case "doc": {
        const set: Record<string, unknown> = {};
        let kept = 0;
        for (const [k, v] of Object.entries(op.set ?? {})) {
          if (!has(touched, "$doc", k)) {
            set[k] = v;
            kept++;
          }
        }
        const unset = (op.unset ?? []).filter((k) => !has(touched, "$doc", k));
        if (kept === 0 && unset.length === 0) break;
        out.push({
          op: "doc",
          set: set as Extract<Op, { op: "doc" }>["set"],
          ...(unset.length > 0 ? { unset } : {}),
        });
        break;
      }
      case "asset": {
        const set = Object.fromEntries(
          Object.entries(op.set ?? {}).filter(([k]) => !has(touched, "$asset", k)),
        );
        const remove = (op.remove ?? []).filter((k) => !has(touched, "$asset", k));
        if (Object.keys(set).length === 0 && remove.length === 0) break;
        out.push({
          op: "asset",
          ...(Object.keys(set).length > 0 ? { set } : {}),
          ...(remove.length > 0 ? { remove } : {}),
        });
        break;
      }
      default:
        out.push(op);
    }
  }
  return out;
}

export class History {
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly limit = DEFAULT_LIMIT,
    private readonly coalesceMs = DEFAULT_COALESCE_MS,
  ) {}

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(): void {
    for (const l of this.listeners) l();
  }

  get undoDepth(): number {
    return this.undoStack.length;
  }

  get redoDepth(): number {
    return this.redoStack.length;
  }

  peekUndo(): HistoryEntry | undefined {
    return this.undoStack[this.undoStack.length - 1];
  }

  peekRedo(): HistoryEntry | undefined {
    return this.redoStack[this.redoStack.length - 1];
  }

  state(): HistoryState {
    const u = this.peekUndo();
    const r = this.peekRedo();
    return {
      canUndo: !!u,
      canRedo: !!r,
      undoLabel: u?.label ?? null,
      redoLabel: r?.label ?? null,
    };
  }

  /** Records a new own step (clears redo). */
  record(entry: HistoryEntry, options: RecordOptions = {}): void {
    const top = this.peekUndo();
    const key = options.coalesceKey ?? entry.coalesceKey;
    const sameRun = !!entry.runId && top?.runId === entry.runId;
    const sameKey = !!key && top?.coalesceKey === key && entry.ts - top.ts <= this.coalesceMs;
    if (top && (sameRun || sameKey)) {
      this.undoStack[this.undoStack.length - 1] = {
        ...top,
        forward: compose([top.forward, entry.forward], { id: top.forward.id, label: top.label }),
        inverse: compose([entry.inverse, top.inverse], { id: top.inverse.id, label: top.label }),
        ts: entry.ts,
        selectionAfter: entry.selectionAfter,
        pageAfter: entry.pageAfter,
      };
    } else {
      this.undoStack.push(key ? { ...entry, coalesceKey: key } : entry);
      if (this.undoStack.length > this.limit) this.undoStack.shift();
    }
    this.redoStack = [];
    this.changed();
  }

  /** Ends coalescing: the next record starts a new step even with the same key. */
  seal(): void {
    const top = this.peekUndo();
    if (top?.coalesceKey) {
      const { coalesceKey: _sealed, ...rest } = top;
      this.undoStack[this.undoStack.length - 1] = rest;
    }
  }

  takeUndo(): HistoryEntry | undefined {
    const e = this.undoStack.pop();
    if (e) this.changed();
    return e;
  }

  takeRedo(): HistoryEntry | undefined {
    const e = this.redoStack.pop();
    if (e) this.changed();
    return e;
  }

  /** After an undo: the step can be redone. */
  pushRedo(entry: HistoryEntry): void {
    this.redoStack.push(entry);
    this.changed();
  }

  /** After a redo: the step can be undone again (does not clear redo). */
  pushUndo(entry: HistoryEntry): void {
    this.undoStack.push(entry);
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.changed();
  }

  /** A collaborator's transaction arrived: forget what it overwrote. */
  rebaseRemote(remote: Transaction): void {
    const touched = footprint(remote.ops);
    if (touched.size === 0) return;
    const prune = (e: HistoryEntry): HistoryEntry => ({
      ...e,
      inverse: { ...e.inverse, ops: pruneOps(e.inverse.ops, touched) },
      forward: { ...e.forward, ops: pruneOps(e.forward.ops, touched) },
    });
    this.undoStack = this.undoStack.map(prune);
    this.redoStack = this.redoStack.map(prune);
    this.changed();
  }

  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
    this.changed();
  }
}
