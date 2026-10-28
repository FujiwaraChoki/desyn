// Deep path access with the exact `patch` / `styles` semantics of spec/fixtures/README.md ("Paths").
import type { PathSegment } from "@desyn/schema";
import { isInteger, isPlainObject, setOwn } from "./util";

export interface PathSetResult {
  /** New root with structural sharing; untouched branches are the original objects. */
  root: unknown;
  /** Whether the final key / index already held a value (false for a new key or an append). */
  existed: boolean;
  /** Previous value at the path (undefined when !existed). */
  oldValue: unknown;
  /** The container that held the final segment, before the change. */
  parentBefore: unknown;
}

/** Validates a path segment list: strings or integers. */
export function isPathShape(path: unknown): path is PathSegment[] {
  return Array.isArray(path) && path.every((s) => typeof s === "string" || isInteger(s));
}

/** Reads the value at `path`, or undefined when any step does not resolve. */
export function getAtPath(root: unknown, path: readonly PathSegment[]): unknown {
  let cur: unknown = root;
  for (const seg of path) {
    if (Array.isArray(cur)) {
      if (!isInteger(seg) || seg < 0 || seg >= cur.length) return undefined;
      cur = cur[seg];
    } else if (isPlainObject(cur)) {
      if (typeof seg !== "string" || !Object.hasOwn(cur, seg)) return undefined;
      cur = cur[seg];
    } else {
      return undefined;
    }
  }
  return cur;
}

/**
 * Sets `value` at `path` without mutating `root`. Every intermediate segment must resolve to an existing value
 * (string keys on plain objects, in-range integer indices on arrays). The final segment may name a new object key,
 * replace an array element, or append when it equals the array length. Returns null when the path is invalid.
 * An empty path replaces the root itself.
 */
export function setAtPath(
  root: unknown,
  path: readonly PathSegment[],
  value: unknown,
): PathSetResult | null {
  if (path.length === 0)
    return { root: value, existed: true, oldValue: root, parentBefore: undefined };
  const chain: unknown[] = [root];
  let cur: unknown = root;
  for (let i = 0; i < path.length - 1; i++) {
    const seg = path[i];
    if (Array.isArray(cur)) {
      if (!isInteger(seg) || seg < 0 || seg >= cur.length) return null;
      cur = cur[seg];
    } else if (isPlainObject(cur)) {
      if (typeof seg !== "string" || !Object.hasOwn(cur, seg)) return null;
      cur = cur[seg];
    } else {
      return null;
    }
    chain.push(cur);
  }
  const last = path[path.length - 1];
  const parent = chain[chain.length - 1];
  let existed: boolean;
  let oldValue: unknown;
  let replaced: unknown;
  if (Array.isArray(parent)) {
    if (!isInteger(last) || last < 0 || last > parent.length) return null;
    existed = last < parent.length;
    oldValue = existed ? parent[last] : undefined;
    const copy = parent.slice();
    copy[last] = value;
    replaced = copy;
  } else if (isPlainObject(parent)) {
    if (typeof last !== "string") return null;
    existed = Object.hasOwn(parent, last);
    oldValue = existed ? parent[last] : undefined;
    const copy = { ...parent };
    setOwn(copy, last, value);
    replaced = copy;
  } else {
    return null;
  }
  for (let i = path.length - 2; i >= 0; i--) {
    const container = chain[i];
    const seg = path[i] as PathSegment;
    if (Array.isArray(container)) {
      const copy = container.slice();
      copy[seg as number] = replaced;
      replaced = copy;
    } else {
      const copy = { ...(container as Record<string, unknown>) };
      setOwn(copy, seg as string, replaced);
      replaced = copy;
    }
  }
  return { root: replaced, existed, oldValue, parentBefore: parent };
}
