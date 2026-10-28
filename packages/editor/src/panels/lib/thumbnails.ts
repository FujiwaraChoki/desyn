import { subtree } from "@desyn/doc-ops";
import type { Design, Id, Node } from "@desyn/schema";
import { useEffect, useSyncExternalStore } from "react";
import { useEditor, useEditorStore } from "../../context.tsx";
import type { EditorController } from "../../controller.ts";

/**
 * Page thumbnails rendered by the engine (PNG export of one page at a small scale), cached per editor.
 * A page re-renders only when one of its nodes changed (nodes are structurally shared, so unchanged pages
 * keep their node objects), debounced, one render at a time so thumbnails never compete with the canvas.
 */

const DEBOUNCE_MS = 450;

interface Entry {
  nodes: Node[] | null;
  /** Assets the page uses (a new signed asset can change pixels without a node change). */
  assets: string;
  url: string | null;
  width: number;
}

function sameNodes(a: Node[] | null, b: Node[]): boolean {
  if (!a || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export class ThumbnailCache {
  private readonly entries = new Map<Id, Entry>();
  private readonly listeners = new Set<() => void>();
  private readonly queue = new Set<Id>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private version = 0;

  constructor(private readonly editor: EditorController) {}

  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  getVersion = (): number => this.version;

  url(pageId: Id): string | null {
    return this.entries.get(pageId)?.url ?? null;
  }

  /** Marks a page as wanted at `width` px; schedules a render when it is stale. */
  request(pageId: Id, width: number): void {
    const design = this.editor.design;
    if (!design?.nodes[pageId]) return;
    const nodes = subtree(design, pageId);
    const entry = this.entries.get(pageId);
    const assets = Object.keys(design.assets).join(",");
    if (entry && entry.width >= width && sameNodes(entry.nodes, nodes) && entry.assets === assets)
      return;
    this.queue.add(pageId);
    this.schedule();
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.drain();
    }, DEBOUNCE_MS);
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.size > 0) {
        const [pageId] = this.queue;
        this.queue.delete(pageId as Id);
        await this.render(pageId as Id);
      }
    } finally {
      this.running = false;
    }
  }

  private async render(pageId: Id): Promise<void> {
    const design: Design | null = this.editor.design;
    const page = design?.nodes[pageId];
    if (!design || page?.type !== "page" || this.editor.getState().engine.status !== "ready")
      return;
    const nodes = subtree(design, pageId);
    const width = 320;
    const scale = Math.min(1, width / Math.max(page.width, page.height, 1));
    try {
      const { bytes } = await this.editor.engine.export({ format: "png", pageId, scale });
      const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "image/png" }));
      const prev = this.entries.get(pageId);
      if (prev?.url) URL.revokeObjectURL(prev.url);
      this.entries.set(pageId, {
        nodes,
        assets: Object.keys(design.assets).join(","),
        url,
        width,
      });
      this.version++;
      for (const l of this.listeners) l();
    } catch {
      // The engine may be restarting; the next change retries.
    }
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    for (const e of this.entries.values()) if (e.url) URL.revokeObjectURL(e.url);
    this.entries.clear();
  }
}

const caches = new WeakMap<EditorController, ThumbnailCache>();

export function thumbnailCache(editor: EditorController): ThumbnailCache {
  let c = caches.get(editor);
  if (!c) {
    c = new ThumbnailCache(editor);
    caches.set(editor, c);
  }
  return c;
}

/** Object URL of a page thumbnail (null until the first render; the caller draws a placeholder). */
export function usePageThumbnail(pageId: Id, width: number): string | null {
  const editor = useEditor();
  const cache = thumbnailCache(editor);
  useSyncExternalStore(cache.subscribe, cache.getVersion, cache.getVersion);
  const design = useEditorStore((s) => s.doc.design);
  const ready = useEditorStore((s) => s.engine.status === "ready");
  useEffect(() => {
    // Re-checked on every document change; only pages whose nodes changed render again.
    if (ready && design) cache.request(pageId, width);
  }, [cache, pageId, width, design, ready]);
  return cache.url(pageId);
}
