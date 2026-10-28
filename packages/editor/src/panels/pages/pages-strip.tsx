"use client";

import { pages as listPages } from "@desyn/doc-ops";
import { cn, IconButton, Tooltip } from "@desyn/ui";
import { ChevronDown, LayoutGrid, Plus, Scaling } from "lucide-react";
import { type KeyboardEvent, useEffect, useMemo, useRef } from "react";
import { useCommand, useEditor, useEditorStore } from "../../context.tsx";
import { PageThumb, usePageDrag } from "./page-item.tsx";

/**
 * Bottom pages strip: thumbnails of every page in order (engine-rendered), the current one lit in sun,
 * click to switch, drag to reorder, double-click to rename, right-click for page actions, + to add a page.
 * Arrow keys move between pages while the strip has focus.
 */
export function PagesStrip() {
  const editor = useEditor();
  const design = useEditorStore((s) => s.doc.design);
  const pageId = useEditorStore((s) => s.pageId);
  const canEdit = useEditorStore((s) => s.mode === "edit");
  // Phones: a slimmer strip (thumbnails only) so the canvas keeps its room.
  const compact = useEditorStore((s) => s.compact);
  const pages = useMemo(() => (design ? listPages(design) : []), [design]);
  const add = useCommand("page.add");
  const drag = usePageDrag("x");
  const scroller = useRef<HTMLUListElement>(null);
  const index = pages.findIndex((p) => p.id === pageId);

  // Keep the current page in view (page changes from the canvas, the palette, PageUp / PageDown).
  useEffect(() => {
    if (!pageId) return;
    const el = scroller.current?.querySelector(`[data-page-id="${pageId}"]`);
    el?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
  }, [pageId]);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.target instanceof HTMLInputElement) return;
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      const next = pages[index + (e.key === "ArrowRight" ? 1 : -1)];
      if (!next) return;
      e.preventDefault();
      editor.setPage(next.id);
      requestAnimationFrame(() =>
        (
          scroller.current?.querySelector(
            `[data-page-id="${next.id}"] button`,
          ) as HTMLElement | null
        )?.focus(),
      );
    }
  };

  return (
    <div className={cn("flex items-stretch gap-2 pr-2 pl-3", compact ? "h-[84px]" : "h-[118px]")}>
      <div
        className={cn(
          "flex shrink-0 flex-col justify-center gap-1 border-r border-line-subtle pr-2",
          compact && "hidden",
        )}
      >
        <Tooltip content="All pages">
          <IconButton
            label="Show all pages"
            size="sm"
            variant="ghost"
            onClick={() => editor.toggleLeftPanel("pages", true)}
          >
            <LayoutGrid />
          </IconButton>
        </Tooltip>
        {canEdit ? (
          <IconButton
            label="Resize page"
            size="sm"
            variant="ghost"
            onClick={() => pageId && editor.openModal("page-resize", { pageId })}
          >
            <Scaling />
          </IconButton>
        ) : null}
        <IconButton
          label="Hide pages"
          size="sm"
          variant="ghost"
          onClick={() => editor.setPanels({ pagesOpen: false })}
        >
          <ChevronDown />
        </IconButton>
      </div>
      <ul
        ref={scroller}
        aria-label="Pages"
        onKeyDown={onKeyDown}
        className="flex min-w-0 flex-1 items-center gap-3.5 overflow-x-auto overflow-y-hidden px-1 py-2 [scrollbar-width:thin]"
      >
        {pages.map((p, i) => (
          <li key={p.id} className={cn(drag.dragging === p.id && "opacity-40")}>
            <PageThumb
              page={p}
              index={i}
              count={pages.length}
              height={compact ? 56 : 68}
              maxWidth={compact ? 100 : 128}
              showName={!compact}
              dropSide={drag.target?.pageId === p.id ? drag.target.side : null}
              onDragStart={drag.onDragStart}
              onDragOver={drag.onDragOver}
              onDrop={drag.onDrop}
              onDragEnd={drag.onDragEnd}
            />
          </li>
        ))}
        {canEdit && add.exists ? (
          <li className="shrink-0">
            <Tooltip content="Add page" {...(add.shortcut ? { shortcut: add.shortcut } : {})}>
              <button
                type="button"
                aria-label="Add page"
                onClick={() => void add.run()}
                className={cn(
                  "grid w-12 shrink-0 cursor-pointer place-items-center rounded-[6px] bg-fg/[0.04] text-fg-muted transition-colors hover:bg-fg/[0.08] hover:text-fg focus-visible:outline-2 focus-visible:outline-ring",
                  compact ? "h-[56px]" : "mb-5 h-[68px]",
                )}
              >
                <Plus className="size-4" />
              </button>
            </Tooltip>
          </li>
        ) : null}
      </ul>
      <div className="flex shrink-0 items-center pl-1 text-2xs text-fg-muted tabular-nums">
        {index >= 0 ? `${index + 1} / ${pages.length}` : null}
      </div>
    </div>
  );
}
