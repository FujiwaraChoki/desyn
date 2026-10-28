import { addPage, createdIds, deletePage, duplicatePage, movePage, pages } from "@desyn/doc-ops";
import type { Id } from "@desyn/schema";
import {
  ArrowDown,
  ArrowUp,
  ChevronLeft,
  ChevronRight,
  Copy,
  FilePlus2,
  FileX2,
} from "lucide-react";
import type { EditorController } from "../controller.ts";
import type { AnyCommand } from "./registry.ts";

function pageIds(editor: EditorController): Id[] {
  const d = editor.design;
  return d ? pages(d).map((p) => p.id) : [];
}

function go(editor: EditorController, delta: number): void {
  const ids = pageIds(editor);
  const i = ids.indexOf(editor.getState().pageId ?? "");
  const next = ids[i + delta];
  if (next) editor.setPage(next);
}

/** Page commands take an optional `{ pageId }` (pages strip context menu); default: current page. */
type PageArgs = { pageId?: Id } | undefined;

const target = (editor: EditorController, args: PageArgs) =>
  args?.pageId ?? editor.getState().pageId;

export function pageCommands(): AnyCommand[] {
  return [
    {
      id: "page.add",
      label: "Add page",
      category: "page",
      icon: FilePlus2,
      when: "canEdit",
      run: async (_a: PageArgs, { editor }) => {
        let created: Id | undefined;
        await editor.apply((design, s) => {
          const ids = pages(design).map((p) => p.id);
          const at = s.pageId ? ids.indexOf(s.pageId) + 1 : ids.length;
          const tx = addPage(design, { index: at, ...(s.pageId ? { like: s.pageId } : {}) });
          created = createdIds(tx)[0];
          return tx;
        });
        if (created) editor.setPage(created);
      },
    },
    {
      id: "page.duplicate",
      label: "Duplicate page",
      category: "page",
      icon: Copy,
      when: "canEdit && pageCount > 0",
      run: async (args: PageArgs, { editor }) => {
        const pageId = target(editor, args);
        if (!pageId) return;
        let created: Id | undefined;
        await editor.apply((design) => {
          const tx = duplicatePage(design, pageId);
          created = createdIds(tx)[0];
          return tx;
        });
        if (created) editor.setPage(created);
      },
    },
    {
      id: "page.delete",
      label: "Delete page",
      category: "page",
      icon: FileX2,
      when: "canEdit && multiplePages",
      run: async (args: PageArgs, { editor }) => {
        const pageId = target(editor, args);
        if (!pageId) return;
        const ids = pageIds(editor);
        const i = ids.indexOf(pageId);
        const neighbour = ids[i + 1] ?? ids[i - 1];
        const r = await editor.apply((design) => deletePage(design, pageId));
        if (r && neighbour) editor.setPage(neighbour);
      },
    },
    {
      id: "page.moveUp",
      label: "Move page up",
      category: "page",
      icon: ArrowUp,
      when: "canEdit && hasPrevPage",
      run: (args: PageArgs, { editor }) => {
        const pageId = target(editor, args);
        const i = pageIds(editor).indexOf(pageId ?? "");
        if (pageId && i > 0) return editor.apply((design) => movePage(design, pageId, i - 1));
      },
    },
    {
      id: "page.moveDown",
      label: "Move page down",
      category: "page",
      icon: ArrowDown,
      when: "canEdit && hasNextPage",
      run: (args: PageArgs, { editor }) => {
        const pageId = target(editor, args);
        const ids = pageIds(editor);
        const i = ids.indexOf(pageId ?? "");
        if (pageId && i >= 0 && i < ids.length - 1)
          return editor.apply((design) => movePage(design, pageId, i + 1));
      },
    },
    {
      id: "page.next",
      label: "Next page",
      category: "page",
      icon: ChevronRight,
      when: "hasNextPage && !textEditing",
      run: (_a, { editor }) => go(editor, 1),
    },
    {
      id: "page.previous",
      label: "Previous page",
      category: "page",
      icon: ChevronLeft,
      when: "hasPrevPage && !textEditing",
      run: (_a, { editor }) => go(editor, -1),
    },
    {
      id: "page.goto",
      label: "Go to page",
      category: "page",
      hidden: true,
      when: "loaded",
      run: (args: { pageId: Id }, { editor }) => editor.setPage(args.pageId),
    },
  ];
}
