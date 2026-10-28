"use client";

import { pages as listPages } from "@desyn/doc-ops";
import { Button, cn } from "@desyn/ui";
import { FilePlus2, Scaling } from "lucide-react";
import { useMemo } from "react";
import { useCommand, useEditor, useEditorStore } from "../../context.tsx";
import { PanelBody } from "../ui/primitives.tsx";
import { PageThumb, usePageDrag } from "./page-item.tsx";

/** Pages flyout: a grid of every page (bigger thumbnails than the strip) with the same actions. */
export function PagesPanel() {
  const editor = useEditor();
  const design = useEditorStore((s) => s.doc.design);
  const pageId = useEditorStore((s) => s.pageId);
  const canEdit = useEditorStore((s) => s.mode === "edit");
  const pages = useMemo(() => (design ? listPages(design) : []), [design]);
  const add = useCommand("page.add");
  const drag = usePageDrag("x");
  const current = pages.find((p) => p.id === pageId);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {canEdit ? (
        <div className="grid shrink-0 grid-cols-2 gap-1.5 px-3 pb-2">
          <Button
            size="sm"
            variant="secondary"
            leadingIcon={<FilePlus2 />}
            onClick={() => void add.run()}
          >
            Add page
          </Button>
          <Button
            size="sm"
            variant="secondary"
            leadingIcon={<Scaling />}
            disabled={!current}
            onClick={() => current && editor.openModal("page-resize", { pageId: current.id })}
          >
            Resize
          </Button>
        </div>
      ) : null}
      {current ? (
        <p className="shrink-0 px-3 pb-2 text-2xs text-fg-muted tabular-nums">
          {Math.round(current.width)} × {Math.round(current.height)} px · {pages.length}{" "}
          {pages.length === 1 ? "page" : "pages"}
        </p>
      ) : null}
      <PanelBody>
        <div className="grid grid-cols-2 gap-x-3 gap-y-4 pt-1">
          {pages.map((p, i) => (
            <div
              key={p.id}
              className={cn("flex justify-center", drag.dragging === p.id && "opacity-40")}
            >
              <PageThumb
                page={p}
                index={i}
                count={pages.length}
                height={150}
                maxWidth={132}
                showName
                dropSide={drag.target?.pageId === p.id ? drag.target.side : null}
                onDragStart={drag.onDragStart}
                onDragOver={drag.onDragOver}
                onDrop={drag.onDrop}
                onDragEnd={drag.onDragEnd}
              />
            </div>
          ))}
        </div>
      </PanelBody>
    </div>
  );
}
