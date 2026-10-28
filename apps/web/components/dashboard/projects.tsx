"use client";

import { Breadcrumbs, Button, cn, EmptyState, Eyebrow, Input, toast } from "@desyn/ui";
import { useMutation, usePaginatedQuery, useQuery } from "convex/react";
import { FolderPlus, Search } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { useApp } from "@/components/app/app-context";
import { Page, PageHeader } from "@/components/app/app-shell";
import { useFolderDrop } from "@/components/app/dnd";
import { PromptDialog } from "@/components/app/prompt-dialog";
import { DesignGrid } from "@/components/designs/design-grid";
import { Rich } from "@/components/rich";
import { api, type Id } from "@/lib/convex-api";
import { folderPath, wouldCycle } from "@/lib/folders";
import { useT } from "@/lib/i18n";
import { routes } from "@/lib/routes";
import { CreateBar } from "./create-bar";
import { FOLDER_GRID, FolderCard } from "./folder-cards";

/** /projects (workspace root) and /projects/[folderId]: subfolders, then designs, all drop targets. */
export function Projects({ folderId }: { folderId: Id<"folders"> | null }) {
  const t = useT();
  const { workspaceId, workspace, canEdit } = useApp();
  const folders = useQuery(api.accounts.folders.list, { workspaceId });
  const createFolder = useMutation(api.accounts.folders.create);
  const [search, setSearch] = useState("");
  const [creating, setCreating] = useState(false);
  const folder = folderId ? folders?.find((f) => f.id === folderId) : null;
  const path = folders && folderId ? folderPath(folders, folderId) : [];
  const subfolders = (folders ?? []).filter((f) => f.parentId === folderId);
  const query = search.trim();
  const { results, status, loadMore } = usePaginatedQuery(
    api.designs.designs.list,
    query
      ? { workspaceId, filter: "all", search: query }
      : { workspaceId, filter: "folder", folderId },
    { initialNumItems: 24 },
  );
  const { isOver, dropProps } = useFolderDrop(folderId, {
    folderName: folder?.name ?? t("app.nav.projects"),
    canAcceptFolder: (dragged) => !folders || !wouldCycle(folders, dragged, folderId),
    messages: {
      movedDesign: (name) =>
        folder
          ? t("dashboard.moved", { name, folder: folder.name })
          : t("dashboard.movedRoot", { name }),
      movedFolder: (name) =>
        t("dashboard.moved", { name, folder: folder?.name ?? t("app.nav.projects") }),
    },
  });

  if (folderId && folders && !folder) {
    return (
      <Page>
        <EmptyState
          title={<Rich text={t("common.errors.notFoundTitle")} />}
          description={t("dashboard.projects.notFound")}
        />
      </Page>
    );
  }

  const crumbs = [
    { label: t("app.nav.projects"), href: routes.projects },
    ...path.map((f) => ({ label: f.name, href: routes.folder(f.id) })),
  ];

  return (
    <Page>
      <div
        {...dropProps}
        className={cn(
          "rounded-[20px] transition-[box-shadow] duration-200",
          isOver && "shadow-[0_0_0_2px_rgb(var(--accent-rgb)/0.45)]",
        )}
      >
        {folderId ? (
          <Breadcrumbs
            items={crumbs}
            className="mb-4"
            renderLink={(item, inner) => (
              <Link
                href={item.href ?? routes.projects}
                className="flex items-center gap-1.5 rounded-[5px] px-1 text-fg-muted transition-colors hover:text-fg"
              >
                {inner}
              </Link>
            )}
          />
        ) : null}
        <PageHeader
          title={folder ? folder.name : t("dashboard.projects.title")}
          description={
            folder ? undefined : t("dashboard.projects.subtitle", { workspace: workspace.name })
          }
          actions={
            <>
              <Input
                className="w-56"
                leading={<Search />}
                placeholder={t("dashboard.filters.search")}
                aria-label={t("dashboard.filters.search")}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              {canEdit ? (
                <Button leadingIcon={<FolderPlus />} onClick={() => setCreating(true)}>
                  {t("dashboard.folders.new")}
                </Button>
              ) : null}
            </>
          }
        />
        {folderId && canEdit && !query ? (
          <section className="mb-10">
            <Eyebrow>{t("dashboard.projects.newHere")}</Eyebrow>
            <div className="mt-3">
              <CreateBar folderId={folderId} />
            </div>
          </section>
        ) : null}
        {!query && subfolders.length > 0 ? (
          <section className="mb-10">
            <Eyebrow>{t("dashboard.projects.subfolders")}</Eyebrow>
            <div className={cn(FOLDER_GRID, "mt-3")}>
              {subfolders.map((f, i) => (
                <FolderCard key={f.id} folder={f} all={folders ?? []} index={i} />
              ))}
            </div>
          </section>
        ) : null}
        <section>
          {!query && (subfolders.length > 0 || folderId) ? (
            <div className="mb-3">
              <Eyebrow>
                {folderId ? t("dashboard.projects.designs") : t("dashboard.projects.loose")}
              </Eyebrow>
            </div>
          ) : null}
          <DesignGrid
            designs={results}
            status={status}
            loadMore={loadMore}
            empty={
              <EmptyState
                icon={<FolderPlus />}
                title={
                  <Rich
                    text={
                      folderId ? t("dashboard.projects.folderEmpty") : t("dashboard.projects.empty")
                    }
                  />
                }
                description={
                  folderId
                    ? t("dashboard.projects.folderEmptyBody")
                    : t("dashboard.projects.emptyBody")
                }
              />
            }
          />
        </section>
      </div>
      <PromptDialog
        open={creating}
        onOpenChange={setCreating}
        title={t("dashboard.newFolderTitle")}
        label={t("dashboard.folderName")}
        placeholder={t("dashboard.folderPlaceholder")}
        submitLabel={t("common.create")}
        maxLength={80}
        onSubmit={async (name) => {
          await createFolder({ workspaceId, name, ...(folderId ? { parentId: folderId } : {}) });
          toast.success(t("dashboard.folderCreated", { name }));
        }}
      />
    </Page>
  );
}
