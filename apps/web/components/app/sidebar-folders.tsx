"use client";

import { cn, toast } from "@desyn/ui";
import { useMutation, useQuery } from "convex/react";
import { ChevronRight, Folder, FolderOpen, Plus } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useMemo, useState } from "react";
import { api, type Id } from "@/lib/convex-api";
import { buildFolderTree, type FolderNode, wouldCycle } from "@/lib/folders";
import { useT } from "@/lib/i18n";
import { routes } from "@/lib/routes";
import { useApp } from "./app-context";
import { folderDragProps, useFolderDrop } from "./dnd";
import { PromptDialog } from "./prompt-dialog";

type FolderRow = {
  id: Id<"folders">;
  name: string;
  parentId: Id<"folders"> | null;
  color: string | null;
};

function FolderItem({
  node,
  folders,
  expanded,
  toggle,
  onNavigate,
}: {
  node: FolderNode<FolderRow>;
  folders: FolderRow[];
  expanded: Set<string>;
  toggle: (id: string) => void;
  onNavigate?: (() => void) | undefined;
}) {
  const t = useT();
  const pathname = usePathname();
  const href = routes.folder(node.folder.id);
  const active = pathname === href;
  const open = expanded.has(node.folder.id);
  const { isOver, dropProps } = useFolderDrop(node.folder.id, {
    folderName: node.folder.name,
    canAcceptFolder: (dragged) => !wouldCycle(folders, dragged, node.folder.id),
    messages: {
      movedDesign: (name) => t("dashboard.moved", { name, folder: node.folder.name }),
      movedFolder: (name) => t("dashboard.moved", { name, folder: node.folder.name }),
    },
  });
  return (
    <li>
      <div
        {...dropProps}
        {...folderDragProps({ id: node.folder.id, name: node.folder.name })}
        className={cn(
          "group flex h-8 items-center rounded-[8px] pr-1.5 text-[13px] transition-colors",
          active ? "bg-fg/[0.07] text-fg" : "text-fg-secondary hover:bg-fg/[0.045] hover:text-fg",
          isOver && "bg-accent-tint text-fg ring-1 ring-accent/50",
        )}
        style={{ paddingLeft: 10 + node.depth * 14 }}
      >
        <button
          type="button"
          aria-label={open ? t("dashboard.collapseFolder") : t("dashboard.expandFolder")}
          aria-expanded={open}
          onClick={() => toggle(node.folder.id)}
          className={cn(
            "grid size-5 shrink-0 cursor-pointer place-items-center rounded text-fg-muted hover:text-fg",
            node.children.length === 0 && "invisible",
          )}
        >
          <ChevronRight
            className={cn("size-3.5 transition-transform duration-200", open && "rotate-90")}
          />
        </button>
        <Link
          href={href}
          onClick={onNavigate}
          aria-current={active ? "page" : undefined}
          className="flex min-w-0 flex-1 items-center gap-2 py-1.5 outline-none focus-visible:underline"
        >
          {active || isOver ? (
            <FolderOpen className="size-4 shrink-0 text-accent" />
          ) : (
            <Folder
              className="size-4 shrink-0 text-fg-muted"
              style={node.folder.color ? { color: node.folder.color } : undefined}
            />
          )}
          <span className="truncate">{node.folder.name}</span>
        </Link>
      </div>
      {open && node.children.length > 0 ? (
        <ul>
          {node.children.map((child) => (
            <FolderItem
              key={child.folder.id}
              node={child}
              folders={folders}
              expanded={expanded}
              toggle={toggle}
              onNavigate={onNavigate}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

/** The folder tree under "Projects" in the sidebar. Folders accept dragged designs and folders. */
export function SidebarFolders({ onNavigate }: { onNavigate?: (() => void) | undefined }) {
  const t = useT();
  const { workspaceId, canEdit } = useApp();
  const folders = useQuery(api.accounts.folders.list, { workspaceId });
  const create = useMutation(api.accounts.folders.create);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [creating, setCreating] = useState(false);
  const tree = useMemo(() => buildFolderTree<FolderRow>(folders ?? []), [folders]);

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="mb-1">
      {tree.length > 0 ? (
        <ul aria-label={t("app.nav.folders")} className="flex flex-col gap-px">
          {tree.map((node) => (
            <FolderItem
              key={node.folder.id}
              node={node}
              folders={folders ?? []}
              expanded={expanded}
              toggle={toggle}
              onNavigate={onNavigate}
            />
          ))}
        </ul>
      ) : null}
      {canEdit ? (
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="flex h-8 w-full cursor-pointer items-center gap-2 rounded-[8px] pl-[34px] text-[13px] text-fg-muted transition-colors hover:bg-fg/[0.045] hover:text-fg"
        >
          <Plus className="size-3.5" />
          {t("app.nav.newFolder")}
        </button>
      ) : null}
      <PromptDialog
        open={creating}
        onOpenChange={setCreating}
        title={t("dashboard.newFolderTitle")}
        label={t("dashboard.folderName")}
        placeholder={t("dashboard.folderPlaceholder")}
        submitLabel={t("common.create")}
        maxLength={80}
        onSubmit={async (name) => {
          await create({ workspaceId, name });
          toast.success(t("dashboard.folderCreated", { name }));
        }}
      />
    </div>
  );
}
