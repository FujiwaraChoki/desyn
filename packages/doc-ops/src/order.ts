// Minimal `move` sequences that turn one child order into another.
import type { Id, MoveOp } from "@desyn/schema";

/** Indices (into `seq`) of one longest strictly increasing subsequence. */
function longestIncreasing(seq: number[]): Set<number> {
  const tails: number[] = [];
  const prev = new Array<number>(seq.length).fill(-1);
  for (let i = 0; i < seq.length; i++) {
    const v = seq[i] as number;
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((seq[tails[mid] as number] as number) < v) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) prev[i] = tails[lo - 1] as number;
    tails[lo] = i;
  }
  const keep = new Set<number>();
  for (
    let i = tails.length > 0 ? (tails[tails.length - 1] as number) : -1;
    i >= 0;
    i = prev[i] as number
  ) {
    keep.add(i);
  }
  return keep;
}

/**
 * Moves (all within `parent`) that reorder `current` into `target`. Both lists must hold the same ids. Elements
 * on a longest common subsequence stay put; every other element moves once, right after its target predecessor,
 * using the `move` index semantics (index into the list with the moved element removed).
 */
export function reorderMoves(parent: Id, current: readonly Id[], target: readonly Id[]): MoveOp[] {
  const targetPos = new Map(target.map((id, i) => [id, i]));
  const positions = current.map((id) => targetPos.get(id) ?? -1);
  if (positions.includes(-1) || current.length !== target.length) {
    throw new Error("reorderMoves: current and target must contain the same ids");
  }
  const stay = longestIncreasing(positions);
  const stable = new Set(current.filter((_, i) => stay.has(i)));
  const list = current.slice();
  const ops: MoveOp[] = [];
  target.forEach((id, i) => {
    if (stable.has(id)) return;
    const from = list.indexOf(id);
    list.splice(from, 1);
    const index = i === 0 ? 0 : list.indexOf(target[i - 1] as Id) + 1;
    list.splice(index, 0, id);
    if (index !== from) ops.push({ op: "move", id, parent, index });
  });
  return ops;
}
