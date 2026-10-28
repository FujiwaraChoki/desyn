import { deepEqual } from "@desyn/doc-ops";
import type { Design, Id, Node, Op } from "@desyn/schema";

/**
 * Small op builders for the inspector: per-node shallow updates that skip unchanged values, so a gesture that
 * ends where it started records nothing.
 */

/** `update` ops setting `patch(node)` on every node (keys whose value does not change are left out). */
export function updateEach(
  design: Design,
  ids: readonly Id[],
  patch: (node: Node) => Record<string, unknown> | null,
): Op[] {
  const ops: Op[] = [];
  for (const id of ids) {
    const node = design.nodes[id];
    if (!node) continue;
    const next = patch(node);
    if (!next) continue;
    const set: Record<string, unknown> = {};
    const current = node as unknown as Record<string, unknown>;
    for (const [k, v] of Object.entries(next)) {
      if (v === undefined) continue;
      if (!deepEqual(current[k], v)) set[k] = v;
    }
    const unset = Object.entries(next)
      .filter(([k, v]) => v === undefined && k in current)
      .map(([k]) => k);
    if (Object.keys(set).length === 0 && unset.length === 0) continue;
    const op: Op = { op: "update", id };
    if (Object.keys(set).length > 0) op.set = set;
    if (unset.length > 0) op.unset = unset;
    ops.push(op);
  }
  return ops;
}

/** The value every node shares, or `null` when they differ ("Mixed"), `undefined` when there are none. */
export function common<T>(nodes: readonly Node[], get: (n: Node) => T): T | null | undefined {
  if (nodes.length === 0) return undefined;
  const first = get(nodes[0] as Node);
  for (let i = 1; i < nodes.length; i++) {
    if (!deepEqual(get(nodes[i] as Node), first)) return null;
  }
  return first;
}

/** Rounds geometry for display / storage (1/100 px). */
export const round2 = (n: number) => Math.round(n * 100) / 100;
