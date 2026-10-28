import { cloneSubtree, pages } from "@desyn/doc-ops";
import { type AssetRef, type Design, type Id, newId, type Op, ROOT_ID } from "@desyn/schema";

/**
 * Appends pages of another design (an imported `.desyn` / JSON file) to the open design: fresh node ids,
 * page links between the imported pages remapped, asset references pointed at the re-uploaded assets, and
 * named styles / variables the open design lacks copied over. Pure: unit tested.
 */

export interface MergeOptions {
  /** Pages of `source` to import (default: all, in order). */
  pageIds?: Id[];
  /** Imported asset id -> AssetRef in the open design (re-uploaded bytes). */
  assets?: ReadonlyMap<Id, AssetRef>;
  /** Insert after this many pages of the target (default: at the end). */
  index?: number;
  /** Id generator (tests). */
  newIds?: (oldId: Id) => Id;
}

export interface MergeResult {
  ops: Op[];
  /** New page ids in order. */
  pageIds: Id[];
  /** Imported asset ids that could not be carried over (no bytes, foreign storage). */
  missingAssets: Id[];
}

const ASSET_KEYS = new Set(["assetId", "maskAssetId", "posterAssetId"]);

/** Replaces asset id references anywhere in a node (image / svg / video nodes, image fills, masks, posters). */
export function remapAssetRefs(value: unknown, map: ReadonlyMap<Id, Id>): unknown {
  if (Array.isArray(value)) return value.map((v) => remapAssetRefs(v, map));
  if (typeof value !== "object" || value === null) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] =
      ASSET_KEYS.has(k) && typeof v === "string" ? (map.get(v) ?? v) : remapAssetRefs(v, map);
  }
  return out;
}

export function mergeDesignPages(
  source: Design,
  target: Design,
  options: MergeOptions = {},
): MergeResult {
  const sourcePages = pages(source);
  const wanted = options.pageIds ? new Set(options.pageIds) : null;
  const chosen = sourcePages.filter((p) => !wanted || wanted.has(p.id));
  const gen = options.newIds ?? (() => newId());

  // One id map for every imported node so links between imported pages survive.
  const idMap = new Map<Id, Id>();
  for (const p of chosen) {
    const stack: Id[] = [p.id];
    while (stack.length > 0) {
      const id = stack.pop() as Id;
      if (idMap.has(id)) continue;
      idMap.set(id, gen(id));
      const n = source.nodes[id] as { children?: Id[] } | undefined;
      if (n?.children) stack.push(...n.children);
    }
  }

  // Assets: carry over the ones re-uploaded (new ids) or still valid as they are.
  const assetIdMap = new Map<Id, Id>();
  const assetSet: Record<Id, AssetRef> = {};
  const missingAssets: Id[] = [];
  const used = usedAssetIds(source, idMap);
  for (const id of used) {
    const mapped = options.assets?.get(id);
    if (mapped) {
      assetIdMap.set(id, mapped.id);
      assetSet[mapped.id] = mapped;
      continue;
    }
    const ref = source.assets[id];
    if (ref && target.assets[id]) {
      assetIdMap.set(id, id); // already in the open design (re-import of the same file)
    } else {
      missingAssets.push(id);
    }
  }

  // Custom fonts are not referenced by id from nodes (text names the family): carry over the re-uploaded ones.
  for (const [id, mapped] of options.assets ?? []) {
    if (assetIdMap.has(id) || source.assets[id]?.kind !== "font") continue;
    assetIdMap.set(id, mapped.id);
    assetSet[mapped.id] = mapped;
  }

  const ops: Op[] = [];
  if (Object.keys(assetSet).length > 0) ops.push({ op: "asset", set: assetSet });

  // Named styles and variables the open design does not have yet.
  for (const kind of ["colors", "text", "effects"] as const) {
    const from = source.styles?.[kind] ?? {};
    const into = target.styles?.[kind] ?? {};
    for (const [id, style] of Object.entries(from)) {
      if (!(id in into)) ops.push({ op: "styles", path: [kind, id], value: style });
    }
  }
  for (const [key, value] of Object.entries(source.styles?.variables ?? {})) {
    if (!(key in (target.styles?.variables ?? {}))) {
      ops.push({ op: "styles", path: ["variables", key], value });
    }
  }

  const targetPageCount = pages(target).length;
  const start = Math.min(Math.max(0, options.index ?? targetPageCount), targetPageCount);
  const pageIds: Id[] = [];
  chosen.forEach((p, i) => {
    const { op } = cloneSubtree(source, p.id, {
      newIds: idMap,
      parent: ROOT_ID,
      index: start + i,
    });
    const nodes = op.nodes.map((n) => {
      const copy = remapAssetRefs(n, assetIdMap) as typeof n & { link?: string };
      // Links to other imported pages (cloneSubtree only remaps links inside one subtree).
      if (typeof copy.link === "string" && copy.link.startsWith("page:")) {
        const to = idMap.get(copy.link.slice(5));
        if (to) copy.link = `page:${to}`;
      }
      return copy;
    });
    ops.push({ ...op, nodes });
    pageIds.push(idMap.get(p.id) as Id);
  });
  return { ops, pageIds, missingAssets };
}

/** Asset ids referenced by the nodes in `ids` (keys of the map). */
export function usedAssetIds(design: Design, ids: ReadonlyMap<Id, Id> | Iterable<Id>): Id[] {
  const out = new Set<Id>();
  const walk = (v: unknown) => {
    if (Array.isArray(v)) {
      for (const x of v) walk(x);
      return;
    }
    if (typeof v !== "object" || v === null) return;
    for (const [k, x] of Object.entries(v)) {
      if (ASSET_KEYS.has(k) && typeof x === "string") out.add(x);
      else walk(x);
    }
  };
  const keys = ids instanceof Map ? ids.keys() : ids;
  for (const id of keys) walk(design.nodes[id]);
  return [...out].sort();
}
