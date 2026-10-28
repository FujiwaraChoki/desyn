"use client";

import {
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@desyn/ui";
import { useQuery } from "convex/react";
import {
  Copy,
  ExternalLink,
  Folder,
  FolderInput,
  Link2,
  MoreHorizontal,
  Pencil,
  Play,
  RotateCcw,
  Trash2,
  X,
} from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { useOptionalApp } from "@/components/app/app-context";
import { designDragProps } from "@/components/app/dnd";
import { PromptDialog } from "@/components/app/prompt-dialog";
import { api, type Id } from "@/lib/convex-api";
import { relativeTime } from "@/lib/format";
import { useLocale, useT } from "@/lib/i18n";
import { routes } from "@/lib/routes";
import { DesignThumb } from "./design-thumb";
import { kindLabel } from "./kind-icon";
import { type DesignSummary, useDesignActions } from "./use-design-actions";

export type CardMode = "active" | "trash" | "shared";

function MoveMenu({
  design,
  onMove,
}: {
  design: DesignSummary;
  onMove: (id: Id<"folders"> | null, name: string | null) => void;
}) {
  const t = useT();
  const folders = useQuery(api.accounts.folders.list, { workspaceId: design.workspaceId });
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger icon={<FolderInput />}>
        {t("dashboard.card.move")}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="max-h-80 w-56 overflow-y-auto">
        <DropdownMenuItem
          icon={<Folder />}
          disabled={design.folderId === null}
          onSelect={() => onMove(null, null)}
        >
          {t("dashboard.card.moveRoot")}
        </DropdownMenuItem>
        {(folders ?? []).map((f) => (
          <DropdownMenuItem
            key={f.id}
            icon={<Folder />}
            disabled={design.folderId === f.id}
            onSelect={() => onMove(f.id, f.name)}
          >
            {f.name}
          </DropdownMenuItem>
        ))}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

/** One design in a grid: thumbnail, name, format and time, a context menu, draggable onto folders. */
export function DesignCard({
  design,
  mode = "active",
  index = 0,
}: {
  design: DesignSummary;
  mode?: CardMode;
  index?: number;
}) {
  const t = useT();
  const locale = useLocale();
  const app = useOptionalApp();
  const actions = useDesignActions();
  const [renaming, setRenaming] = useState(false);
  const canEdit = design.permission === "edit" || design.permission === "manage";
  const canManage = design.permission === "manage";
  const href =
    mode === "shared" && "shareToken" in design && typeof design.shareToken === "string"
      ? `/share/${encodeURIComponent(design.shareToken)}`
      : routes.design(design.id);
  const draggable = mode === "active" && canEdit && app?.workspaceId === design.workspaceId;

  return (
    <article
      className="rise group relative flex flex-col gap-2"
      style={{ ["--i" as string]: Math.min(index, 12) }}
      {...(draggable ? designDragProps({ id: design.id, name: design.name }) : {})}
    >
      <Link
        href={mode === "trash" ? "#" : href}
        aria-disabled={mode === "trash" || undefined}
        onClick={(e) => mode === "trash" && e.preventDefault()}
        className={cn(
          "block rounded-[10px] outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
          mode === "trash" && "cursor-default opacity-80",
        )}
        draggable={false}
      >
        <DesignThumb
          width={design.width}
          height={design.height}
          thumbnailUrl={design.thumbnailUrl}
          kind={design.kind}
          name={design.name}
        />
        <span className="sr-only">{t("dashboard.card.open")}</span>
      </Link>
      <div className="flex items-start gap-2 px-1">
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-medium text-fg" title={design.name}>
            {design.name || t("common.untitled")}
          </h3>
          <p className="truncate text-2xs text-fg-muted">
            {kindLabel(design.kind)} ·{" "}
            {mode === "shared"
              ? t("dashboard.card.sharedBy")
              : t("dashboard.card.edited", {
                  time: relativeTime(design.updatedAt, Date.now(), locale),
                })}
          </p>
        </div>
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={t("dashboard.card.menu", { name: design.name })}
              className="-mr-1 grid size-7 shrink-0 cursor-pointer place-items-center rounded-control text-fg-muted opacity-100 transition-[opacity,background-color] hover:bg-fg/8 hover:text-fg focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-ring data-[state=open]:bg-fg/8 data-[state=open]:opacity-100 sm:opacity-0 sm:group-hover:opacity-100"
            >
              <MoreHorizontal className="size-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            {mode === "trash" ? (
              <>
                <DropdownMenuItem icon={<RotateCcw />} onSelect={() => actions.restore(design)}>
                  {t("dashboard.card.restore")}
                </DropdownMenuItem>
                {canManage ? (
                  <DropdownMenuItem icon={<X />} destructive onSelect={() => actions.purge(design)}>
                    {t("dashboard.card.deleteForever")}
                  </DropdownMenuItem>
                ) : null}
              </>
            ) : (
              <>
                <DropdownMenuItem icon={<ExternalLink />} onSelect={() => actions.open(design)}>
                  {t("dashboard.card.open")}
                </DropdownMenuItem>
                <DropdownMenuItem icon={<Play />} onSelect={() => actions.present(design)}>
                  {t("dashboard.card.present")}
                </DropdownMenuItem>
                {mode === "active" && canEdit ? (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem icon={<Pencil />} onSelect={() => setRenaming(true)}>
                      {t("dashboard.card.rename")}
                    </DropdownMenuItem>
                    <DropdownMenuItem icon={<Copy />} onSelect={() => actions.duplicate(design)}>
                      {t("dashboard.card.duplicate")}
                    </DropdownMenuItem>
                    <MoveMenu
                      design={design}
                      onMove={(id, name) => actions.move(design, id, name)}
                    />
                  </>
                ) : null}
                {mode === "active" && canManage ? (
                  <>
                    <DropdownMenuItem icon={<Link2 />} onSelect={() => actions.copyLink(design)}>
                      {t("dashboard.card.copyLink")}
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      icon={<Trash2 />}
                      destructive
                      onSelect={() => actions.trash(design)}
                    >
                      {t("dashboard.card.trash")}
                    </DropdownMenuItem>
                  </>
                ) : null}
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <PromptDialog
        open={renaming}
        onOpenChange={setRenaming}
        title={t("dashboard.renameTitle")}
        label={t("dashboard.renameLabel")}
        initialValue={design.name}
        submitLabel={t("common.save")}
        maxLength={200}
        onSubmit={(name) => actions.rename(design, name)}
      />
    </article>
  );
}
