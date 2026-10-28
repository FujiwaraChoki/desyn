/*
 * Folder tree helpers. Folders arrive flat from `accounts.folders.list`; the UI nests them by
 * parentId. Pure functions so they can be unit-tested.
 */

export interface FolderLike {
  id: string;
  name: string;
  parentId: string | null;
  color?: string | null;
}

export interface FolderNode<F extends FolderLike = FolderLike> {
  folder: F;
  children: FolderNode<F>[];
  depth: number;
}

export function buildFolderTree<F extends FolderLike>(folders: F[]): FolderNode<F>[] {
  const byParent = new Map<string | null, F[]>();
  const ids = new Set(folders.map((f) => f.id));
  for (const f of folders) {
    // Orphans (parent deleted concurrently) are shown at the root instead of disappearing.
    const parent = f.parentId && ids.has(f.parentId) ? f.parentId : null;
    const list = byParent.get(parent) ?? [];
    list.push(f);
    byParent.set(parent, list);
  }
  const seen = new Set<string>();
  const build = (parent: string | null, depth: number): FolderNode<F>[] => {
    const nodes: FolderNode<F>[] = [];
    for (const folder of byParent.get(parent) ?? []) {
      // A cycle in stored data must not recurse forever: each folder appears once.
      if (seen.has(folder.id)) continue;
      seen.add(folder.id);
      nodes.push({ folder, depth, children: build(folder.id, depth + 1) });
    }
    return nodes;
  };
  return build(null, 0);
}

/** The chain of folders from the root to `id` (inclusive), for breadcrumbs. */
export function folderPath<F extends FolderLike>(folders: F[], id: string | null): F[] {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const path: F[] = [];
  let current = id ? byId.get(id) : undefined;
  const guard = new Set<string>();
  while (current && !guard.has(current.id)) {
    guard.add(current.id);
    path.unshift(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return path;
}

/** True when moving `folderId` under `targetParentId` would put it inside itself. */
export function wouldCycle<F extends FolderLike>(
  folders: F[],
  folderId: string,
  targetParentId: string | null,
): boolean {
  if (targetParentId === null) return false;
  if (targetParentId === folderId) return true;
  return folderPath(folders, targetParentId).some((f) => f.id === folderId);
}

/** Drag-and-drop payload types (HTML5 DataTransfer). */
export const DND_DESIGN = "application/x-desyn-design";
export const DND_FOLDER = "application/x-desyn-folder";
