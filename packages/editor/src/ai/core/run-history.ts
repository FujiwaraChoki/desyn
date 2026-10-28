import { applyTransaction, compose } from "@desyn/doc-ops";
import type { Design, Id, Op, Transaction } from "@desyn/schema";
import type { EditorController } from "../../controller.ts";
import { footprint, pruneOps } from "../../store/history.ts";

/**
 * Per-run undo (DOCUMENT_MODEL §6: "the client groups consecutive transactions with the same actor.runId into
 * one undo step").
 *
 * The undo stack itself is History's: browser runs edit through `editor.apply` and server runs reach the
 * controller as remote transactions of this user with an `actor.runId`, which it records as own steps merged
 * per run. This tracker adds what History cannot do: it keeps each run's complete inverse (pruned by other
 * people's later edits), so "Undo all changes" on an older run still works after newer steps, and it reports
 * which layers each run touched for the canvas glow.
 */

interface Step {
  forward: Transaction[];
  inverse: Transaction[];
}

const prune = (tx: Transaction, touched: Set<string>): Transaction => ({
  ...tx,
  ops: pruneOps(tx.ops, touched),
});

/** Node ids an op list touches (created, updated, moved); used for the canvas glow. */
export function touchedIds(ops: readonly Op[]): Id[] {
  const out = new Set<Id>();
  for (const op of ops) {
    if (op.op === "create") for (const n of op.nodes) out.add(n.id);
    else if (op.op === "update" || op.op === "patch" || op.op === "move") out.add(op.id);
  }
  return [...out];
}

export class RunHistory {
  private readonly tracked = new Set<string>();
  /** Everything each run did, oldest first. */
  private readonly all = new Map<string, Step>();

  constructor(private readonly editor: EditorController) {}

  /** Starts following a server run's remote transactions (glow and full inverse). */
  track(runId: string): void {
    this.tracked.add(runId);
  }

  isTracked(runId: string): boolean {
    return this.tracked.has(runId);
  }

  /** A browser run's applied transaction (History records it; this keeps the run's full inverse). */
  addLocal(runId: string, forward: Transaction, inverse: Transaction): void {
    this.add(runId, forward, inverse);
  }

  /** Transactions applied by a run so far. */
  count(runId: string): number {
    return this.all.get(runId)?.forward.length ?? 0;
  }

  /**
   * Remote transactions folded into the view (oldest first) on top of `before`. Returns, per tracked run, the
   * nodes its transactions touched.
   */
  onRemote(before: Design | null, remote: readonly Transaction[]): Map<string, Id[]> {
    const touched = new Map<string, Id[]>();
    if (!before || remote.length === 0) return touched;
    const me = this.editor.getState().user?.id;
    let state = before;
    for (const tx of remote) {
      const result = applyTransaction(state, tx, { validateNodes: false });
      state = result.design;
      const runId = tx.actor?.runId;
      if (runId && this.tracked.has(runId)) {
        if (result.applied.length === 0) continue;
        this.add(runId, { ...tx, ops: result.applied }, result.inverse);
        touched.set(runId, [...(touched.get(runId) ?? []), ...touchedIds(result.applied)]);
      } else if (!(runId && me && tx.actor?.userId === me)) {
        // Someone else's edit: an older run's undo must not revert it.
        this.pruneFor(tx.ops);
      }
    }
    return touched;
  }

  private add(runId: string, forward: Transaction, inverse: Transaction): void {
    const all = this.all.get(runId) ?? { forward: [], inverse: [] };
    all.forward.push(forward);
    all.inverse.push(inverse);
    this.all.set(runId, all);
  }

  private pruneFor(ops: readonly Op[]): void {
    const fp = footprint(ops);
    if (fp.size === 0) return;
    for (const [runId, step] of this.all) {
      this.all.set(runId, {
        forward: step.forward.map((t) => prune(t, fp)),
        inverse: step.inverse.map((t) => prune(t, fp)),
      });
    }
  }

  /**
   * Undoes a run as one step: through History when the run's step is the latest one (exact, redoable),
   * otherwise by applying the run's complete inverse as a new step.
   */
  async undo(runId: string, label: string): Promise<boolean> {
    if (this.editor.history.peekUndo()?.runId === runId) return this.editor.undo();
    const all = this.all.get(runId);
    if (!all || all.inverse.length === 0) return false;
    const { actor: _run, ...composed } = compose([...all.inverse].reverse(), {
      label: `Undo ${label}`,
    });
    if (composed.ops.length === 0) return false;
    // A plain user step: it must not merge into (or be mistaken for) the run's own history entry.
    const result = await this.editor.apply(
      { ...composed, source: "user" },
      { label: `Undo ${label}`, normalize: false },
    );
    return !!result && result.applied.length > 0;
  }

  /** Redoes a run undone through History (its step is the latest redo entry). */
  canRedo(runId: string): boolean {
    return this.editor.history.peekRedo()?.runId === runId;
  }

  async redo(runId: string): Promise<boolean> {
    return this.canRedo(runId) ? this.editor.redo() : false;
  }

  forget(runId: string): void {
    this.tracked.delete(runId);
    this.all.delete(runId);
  }
}
