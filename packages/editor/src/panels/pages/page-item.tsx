"use client";

import type { Id, PageNode } from "@desyn/schema";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
  cn,
} from "@desyn/ui";
import { ArrowLeft, ArrowRight, Copy, FilePlus2, PenLine, Scaling, Trash2 } from "lucide-react";
import { type DragEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { useEditor, useEditorStore } from "../../context.tsx";
import { updateEach } from "../lib/ops.ts";
import { resolveColor } from "../lib/paint.ts";
import { usePageThumbnail } from "../lib/thumbnails.ts";

/** Drag payload type for page reordering (strip and panel). */
export const PAGE_DRAG_TYPE = "application/x-desyn-page";

/** Context menu of a page (strip and panel): page commands with `{ pageId }`. */
export function PageMenu({
  pageId,
  index,
  count,
  onRename,
  children,
}: {
  pageId: Id;
  index: number;
  count: number;
  onRename: () => void;
  children: ReactNode;
}) {
  const editor = useEditor();
  const canEdit = useEditorStore((s) => s.mode === "edit");
  const run = (id: string) => void editor.commands.run(id, { pageId }, "menu");
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="w-56">
        <ContextMenuItem icon={<PenLine />} disabled={!canEdit} onSelect={onRename}>
          Rename page
        </ContextMenuItem>
        <ContextMenuItem
          icon={<FilePlus2 />}
          disabled={!canEdit}
          onSelect={() => {
            editor.setPage(pageId);
            run("page.add");
          }}
        >
          Add page after
        </ContextMenuItem>
        <ContextMenuItem icon={<Copy />} disabled={!canEdit} onSelect={() => run("page.duplicate")}>
          Duplicate page
        </ContextMenuItem>
        <ContextMenuItem
          icon={<Scaling />}
          disabled={!canEdit}
          onSelect={() => editor.openModal("page-resize", { pageId })}
        >
          Resize page…
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          icon={<ArrowLeft />}
          disabled={!canEdit || index === 0}
          onSelect={() => {
            editor.setPage(pageId);
            run("page.moveUp");
          }}
        >
          Move earlier
        </ContextMenuItem>
        <ContextMenuItem
          icon={<ArrowRight />}
          disabled={!canEdit || index >= count - 1}
          onSelect={() => {
            editor.setPage(pageId);
            run("page.moveDown");
          }}
        >
          Move later
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          icon={<Trash2 />}
          destructive
          disabled={!canEdit || count <= 1}
          onSelect={() => run("page.delete")}
        >
          Delete page
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** Page background as CSS, the placeholder until the engine thumbnail arrives. */
function pageBackground(page: PageNode, design: Parameters<typeof resolveColor>[0]): string {
  const solid = page.background.find((f) => f.type === "solid");
  return solid?.type === "solid" ? resolveColor(design, solid.color, "#ffffff") : "#ffffff";
}

/**
 * One page thumbnail: engine-rendered image (placeholder in the page color meanwhile), number, name, inline
 * rename, drag handle for reordering. `size` is the thumbnail's longer side.
 */
export function PageThumb({
  page,
  index,
  count,
  height,
  maxWidth,
  showName,
  dropSide,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
}: {
  page: PageNode;
  index: number;
  count: number;
  height: number;
  maxWidth: number;
  showName: boolean;
  dropSide: "before" | "after" | null;
  onDragStart: (e: DragEvent, pageId: Id) => void;
  onDragOver: (e: DragEvent, pageId: Id) => void;
  onDrop: (e: DragEvent, pageId: Id) => void;
  onDragEnd: () => void;
}) {
  const editor = useEditor();
  const current = useEditorStore((s) => s.pageId === page.id);
  const canEdit = useEditorStore((s) => s.mode === "edit");
  const design = useEditorStore((s) => s.doc.design);
  const thumb = usePageThumbnail(page.id, 160);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(page.name);
  const input = useRef<HTMLInputElement>(null);
  const ratio = page.width / Math.max(page.height, 1);
  const width = Math.min(maxWidth, Math.round(height * ratio));
  const h = Math.round(width / ratio);

  useEffect(() => {
    if (renaming) input.current?.select();
  }, [renaming]);

  const commitRename = () => {
    setRenaming(false);
    const next = name.trim().slice(0, 120);
    if (!next || next === page.name) return;
    void editor.apply((d) => updateEach(d, [page.id], () => ({ name: next })), {
      label: "Rename page",
    });
  };

  return (
    <PageMenu
      pageId={page.id}
      index={index}
      count={count}
      onRename={() => {
        setName(page.name);
        setRenaming(true);
      }}
    >
      <div
        className="group/page relative flex shrink-0 flex-col items-center gap-1"
        style={{ width: Math.max(width, 44) }}
        data-page-id={page.id}
      >
        {dropSide ? (
          <span
            aria-hidden
            className={cn(
              "absolute top-1 bottom-6 w-0.5 rounded-full bg-accent",
              dropSide === "before" ? "-left-[7px]" : "-right-[7px]",
            )}
          />
        ) : null}
        <button
          type="button"
          draggable={canEdit && !renaming}
          aria-label={`Page ${index + 1}${page.name ? `: ${page.name}` : ""}`}
          aria-current={current ? "page" : undefined}
          onClick={() => editor.setPage(page.id)}
          onDoubleClick={() => {
            if (!canEdit) return;
            setName(page.name);
            setRenaming(true);
          }}
          onDragStart={(e) => onDragStart(e, page.id)}
          onDragOver={(e) => onDragOver(e, page.id)}
          onDrop={(e) => onDrop(e, page.id)}
          onDragEnd={onDragEnd}
          className={cn(
            "relative cursor-pointer overflow-hidden rounded-[6px] outline-none transition-[box-shadow,transform] duration-200 ease-out",
            "shadow-[0_0_0_1px_var(--line-subtle),0_6px_16px_-10px_rgb(0_0_0/0.5)]",
            "hover:shadow-[0_0_0_1px_var(--line),0_10px_22px_-12px_rgb(0_0_0/0.6)] focus-visible:ring-2 focus-visible:ring-ring",
            current && "shadow-[0_0_0_2px_var(--accent)] hover:shadow-[0_0_0_2px_var(--accent)]",
          )}
          style={{ width, height: h, background: pageBackground(page, design) }}
        >
          {thumb ? (
            <img src={thumb} alt="" draggable={false} className="size-full object-cover" />
          ) : null}
          <span
            className={cn(
              "absolute bottom-1 left-1 min-w-4 rounded-[4px] px-1 text-center text-[10px] leading-4 font-medium tabular-nums",
              current
                ? "bg-accent-solid text-accent-ink"
                : "bg-black/55 text-white backdrop-blur-sm",
            )}
          >
            {index + 1}
          </span>
        </button>
        {renaming ? (
          <input
            ref={input}
            value={name}
            aria-label="Page name"
            maxLength={120}
            onChange={(e) => setName(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") commitRename();
              if (e.key === "Escape") setRenaming(false);
            }}
            className="h-5 w-full min-w-16 rounded-[4px] border border-accent/60 bg-background px-1 text-center text-2xs text-fg outline-none"
          />
        ) : showName ? (
          <span
            className={cn(
              "w-full truncate text-center text-2xs",
              current ? "text-fg" : "text-fg-muted group-hover/page:text-fg-secondary",
            )}
          >
            {page.name || `Page ${index + 1}`}
          </span>
        ) : null}
      </div>
    </PageMenu>
  );
}

/** Pointer-free page reordering with HTML drag and drop (shared by the strip and the panel). */
export function usePageDrag(axis: "x" | "y") {
  const editor = useEditor();
  const [dragging, setDragging] = useState<Id | null>(null);
  const [target, setTarget] = useState<{ pageId: Id; side: "before" | "after" } | null>(null);
  return {
    dragging,
    target,
    onDragStart: (e: DragEvent, pageId: Id) => {
      setDragging(pageId);
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData(PAGE_DRAG_TYPE, pageId);
    },
    onDragOver: (e: DragEvent, pageId: Id) => {
      if (!dragging || ![...e.dataTransfer.types].includes(PAGE_DRAG_TYPE)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const side =
        axis === "x"
          ? e.clientX < rect.left + rect.width / 2
            ? "before"
            : "after"
          : e.clientY < rect.top + rect.height / 2
            ? "before"
            : "after";
      if (target?.pageId !== pageId || target.side !== side) setTarget({ pageId, side });
    },
    onDrop: (e: DragEvent, pageId: Id) => {
      e.preventDefault();
      const moving = dragging;
      const side = target?.side ?? "after";
      setDragging(null);
      setTarget(null);
      if (!moving || moving === pageId) return;
      void editor.commands.run("page.moveTo", { pageId: moving, targetId: pageId, side }, "api");
    },
    onDragEnd: () => {
      setDragging(null);
      setTarget(null);
    },
  };
}
