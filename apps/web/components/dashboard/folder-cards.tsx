"use client";

import {
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  toast,
  useConfirm,
} from "@desyn/ui";
import { useMutation } from "convex/react";
import { Folder, FolderOpen, MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { useApp } from "@/components/app/app-context";
import { folderDragProps, useFolderDrop } from "@/components/app/dnd";
import { PromptDialog } from "@/components/app/prompt-dialog";
import { api, type Id } from "@/lib/convex-api";
import { errorMessage } from "@/lib/errors";
import { type FolderLike, wouldCycle } from "@/lib/folders";
import { useT } from "@/lib/i18n";
import { routes } from "@/lib/routes";

export type FolderView = FolderLike & {
  id: Id<"folders">;
  parentId: Id<"folders"> | null;
  color: string | null;
};

/** A folder tile: opens the folder, accepts dropped designs and folders, renames and deletes. */
export function FolderCard({
  folder,
  all,
  index = 0,
}: {
  folder: FolderView;
  all: FolderView[];
  index?: number;
}) {
  const t = useT();
  const confirm = useConfirm();
  const { canEdit } = useApp();
  const update = useMutation(api.accounts.folders.update);
  const remove = useMutation(api.accounts.folders.remove);
  const [renaming, setRenaming] = useState(false);
  const { isOver, dropProps } = useFolderDrop(folder.id, {
    folderName: folder.name,
    canAcceptFolder: (dragged) => !wouldCycle(all, dragged, folder.id),
    messages: {
      movedDesign: (name) => t("dashboard.moved", { name, folder: folder.name }),
      movedFolder: (name) => t("dashboard.moved", { name, folder: folder.name }),
    },
  });
  const children = all.filter((f) => f.parentId === folder.id).length;

  const del = async () => {
    const ok = await confirm({
      title: t("dashboard.deleteFolderConfirm", { name: folder.name }),
      description: t("dashboard.deleteFolderBody"),
      confirmLabel: t("common.delete"),
      tone: "danger",
    });
    if (!ok) return;
    try {
      await remove({ folderId: folder.id });
      toast.success(t("dashboard.folderDeleted", { name: folder.name }));
    } catch (error) {
      toast.error(errorMessage(error));
    }
  };

  return (
    <div
      {...dropProps}
      {...(canEdit ? folderDragProps({ id: folder.id, name: folder.name }) : {})}
      className={cn(
        "rise group relative flex items-center gap-3 rounded-[10px] bg-fg/[0.03] py-2 pr-2 pl-2.5 transition-colors duration-200",
        "hover:bg-fg/[0.06]",
        isOver && "bg-accent-wash ring-1 ring-accent/50",
      )}
      style={{ ["--i" as string]: Math.min(index, 10) }}
    >
      <span
        className={cn(
          "grid size-7 shrink-0 place-items-center transition-colors",
          isOver ? "text-accent" : "text-fg-muted group-hover:text-fg-secondary",
        )}
        style={folder.color && !isOver ? { color: folder.color } : undefined}
      >
        {isOver ? <FolderOpen className="size-[18px]" /> : <Folder className="size-[18px]" />}
      </span>
      <Link
        href={routes.folder(folder.id)}
        className="min-w-0 flex-1 outline-none after:absolute after:inset-0 after:rounded-[10px] focus-visible:after:outline-2 focus-visible:after:outline-ring"
        draggable={false}
      >
        <span className="block truncate text-sm font-medium text-fg">{folder.name}</span>
        {isOver || children > 0 ? (
          <span className="block text-2xs text-fg-muted">
            {isOver
              ? t("dashboard.projects.dropHint")
              : `${t("dashboard.projects.subfolders")} · ${children}`}
          </span>
        ) : null}
      </Link>
      {canEdit ? (
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={t("dashboard.card.menu", { name: folder.name })}
              className="relative z-[1] grid size-7 cursor-pointer place-items-center rounded-control text-fg-muted transition-[opacity,background-color] hover:bg-fg/8 hover:text-fg data-[state=open]:bg-fg/8 sm:opacity-0 sm:group-hover:opacity-100 sm:data-[state=open]:opacity-100 focus-visible:opacity-100"
            >
              <MoreHorizontal className="size-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem icon={<Pencil />} onSelect={() => setRenaming(true)}>
              {t("dashboard.projects.rename")}
            </DropdownMenuItem>
            <DropdownMenuItem icon={<Trash2 />} destructive onSelect={del}>
              {t("dashboard.projects.delete")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
      <PromptDialog
        open={renaming}
        onOpenChange={setRenaming}
        title={t("dashboard.renameFolderTitle")}
        label={t("dashboard.folderName")}
        initialValue={folder.name}
        submitLabel={t("common.save")}
        maxLength={80}
        onSubmit={async (name) => {
          await update({ folderId: folder.id, name });
        }}
      />
    </div>
  );
}

export const FOLDER_GRID = "grid grid-cols-[repeat(auto-fill,minmax(min(100%,220px),1fr))] gap-3";
