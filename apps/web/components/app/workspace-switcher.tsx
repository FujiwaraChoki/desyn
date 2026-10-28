"use client";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  nameColor,
  ProBadge,
  toast,
} from "@desyn/ui";
import { useMutation } from "convex/react";
import { Check, ChevronsUpDown, Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api } from "@/lib/convex-api";
import { useT } from "@/lib/i18n";
import { routes } from "@/lib/routes";
import { useApp, type WorkspaceItem } from "./app-context";
import { PromptDialog } from "./prompt-dialog";

export function WorkspaceGlyph({
  workspace,
  size = 28,
}: {
  workspace: Pick<WorkspaceItem, "name" | "color" | "icon">;
  size?: number;
}) {
  const letter = workspace.icon ?? (workspace.name.trim().charAt(0).toUpperCase() || "?");
  return (
    <span
      aria-hidden
      className="grid shrink-0 place-items-center rounded-[8px] font-serif text-[15px] text-[#1a1205] shadow-[inset_0_1px_0_rgb(255_255_255/0.35)]"
      style={{
        width: size,
        height: size,
        background: workspace.color ?? nameColor(workspace.name),
      }}
    >
      {letter}
    </span>
  );
}

export function WorkspaceSwitcher() {
  const t = useT();
  const { workspaces, workspace, setWorkspaceId, me, billing } = useApp();
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const teamsEnabled = me.features.teams;

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={t("app.workspace.switch")}
            className="group flex w-full cursor-pointer items-center gap-2.5 rounded-[10px] p-1.5 text-left transition-colors hover:bg-fg/6 focus-visible:outline-2 focus-visible:outline-ring data-[state=open]:bg-fg/6"
          >
            <WorkspaceGlyph workspace={workspace} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium text-fg">{workspace.name}</span>
              <span className="block truncate text-2xs text-fg-muted">
                {workspace.kind === "personal"
                  ? t("app.workspace.personal")
                  : t("app.workspace.team")}{" "}
                · {me.planName}
              </span>
            </span>
            <ChevronsUpDown className="size-4 shrink-0 text-fg-muted group-hover:text-fg" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-64">
          <DropdownMenuLabel>{t("app.workspace.label")}</DropdownMenuLabel>
          {workspaces.map((w) => (
            <DropdownMenuItem
              key={w.id}
              onSelect={() => setWorkspaceId(w.id)}
              icon={<WorkspaceGlyph workspace={w} size={20} />}
            >
              <span className="flex items-center gap-2">
                <span className="truncate">{w.name}</span>
                {w.id === workspace.id ? <Check className="ml-auto size-4 text-accent!" /> : null}
              </span>
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            icon={<Plus />}
            onSelect={() =>
              // Team workspaces are a Pro feature: offer the upgrade instead of a dialog that fails.
              !teamsEnabled && billing
                ? router.push(`${routes.settings("billing")}?upgrade=1`)
                : setCreating(true)
            }
          >
            <span className="flex items-center gap-2">
              {t("app.workspace.create")}
              {!teamsEnabled ? <ProBadge /> : null}
            </span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <CreateWorkspaceDialog open={creating} onOpenChange={setCreating} />
    </>
  );
}

/** Names and creates a team workspace, then switches to it (workspace menu, members settings). */
export function CreateWorkspaceDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useT();
  const { setWorkspaceId } = useApp();
  const create = useMutation(api.accounts.workspaces.create);
  return (
    <PromptDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("app.workspace.createTitle")}
      description={t("app.workspace.createBody")}
      label={t("app.workspace.name")}
      placeholder={t("app.workspace.namePlaceholder")}
      submitLabel={t("common.create")}
      maxLength={64}
      onSubmit={async (name) => {
        const id = await create({ name });
        setWorkspaceId(id);
        toast.success(t("app.workspace.created"));
      }}
    />
  );
}
