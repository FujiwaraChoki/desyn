"use client";

import {
  Badge,
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  Input,
  Select,
  Swatch,
  toast,
  useConfirm,
} from "@desyn/ui";
import { useMutation, useQuery } from "convex/react";
import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useState } from "react";
import { useApp } from "@/components/app/app-context";
import { PromptDialog } from "@/components/app/prompt-dialog";
import { WorkspaceGlyph } from "@/components/app/workspace-switcher";
import { WARM } from "@/components/dashboard/featured-presets";
import { Rich } from "@/components/rich";
import { api, type Id } from "@/lib/convex-api";
import { errorMessage } from "@/lib/errors";
import { useT } from "@/lib/i18n";
import { SettingsCard, SettingsPage, SettingsRow } from "./settings-ui";

const COLORS = [...WARM.map((c) => c.toLowerCase()), "#5aa9ff", "#4ade80"];

export function WorkspaceSettings() {
  const t = useT();
  const router = useRouter();
  const confirm = useConfirm();
  const { workspace, workspaces, setWorkspaceId, me } = useApp();
  const details = useQuery(api.accounts.workspaces.get, { workspaceId: workspace.id });
  const members = useQuery(
    api.accounts.memberships.list,
    workspace.role === "owner" ? { workspaceId: workspace.id } : "skip",
  );
  const update = useMutation(api.accounts.workspaces.update);
  const setDefault = useMutation(api.accounts.workspaces.setDefault);
  const leave = useMutation(api.accounts.memberships.leave);
  const transfer = useMutation(api.accounts.workspaces.transferOwnership);
  const remove = useMutation(api.accounts.workspaces.remove);
  const create = useMutation(api.accounts.workspaces.create);
  const [name, setName] = useState(workspace.name);
  const [icon, setIcon] = useState(workspace.icon ?? "");
  const [color, setColor] = useState<string | null>(workspace.color);
  const [saving, setSaving] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newOwner, setNewOwner] = useState<string>("");

  useEffect(() => {
    setName(workspace.name);
    setIcon(workspace.icon ?? "");
    setColor(workspace.color);
  }, [workspace.name, workspace.icon, workspace.color]);

  const isAdmin = workspace.role === "owner" || workspace.role === "admin";
  const isOwner = workspace.role === "owner";
  const team = workspace.kind === "team";
  const dirty =
    name.trim() !== workspace.name ||
    (icon.trim() || null) !== workspace.icon ||
    color !== workspace.color;

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    try {
      await update({
        workspaceId: workspace.id,
        name: name.trim(),
        icon: icon.trim() || null,
        color,
      });
      toast.success(t("settings.workspace.saved"));
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setSaving(false);
    }
  };

  const doLeave = async () => {
    const ok = await confirm({
      title: t("settings.workspace.leaveConfirm", { name: workspace.name }),
      description: t("settings.workspace.leaveBody"),
      confirmLabel: t("settings.workspace.leave"),
      tone: "danger",
    });
    if (!ok) return;
    try {
      await leave({ workspaceId: workspace.id });
      toast.success(t("settings.workspace.left", { name: workspace.name }));
      const next = workspaces.find((w) => w.id !== workspace.id);
      if (next) setWorkspaceId(next.id);
      router.replace("/");
    } catch (error) {
      toast.error(errorMessage(error));
    }
  };

  const transferable = (members ?? []).filter((m) => !m.isYou && m.role === "admin");

  return (
    <SettingsPage
      title={t("settings.workspace.title")}
      description={t("settings.workspace.subtitle", { name: workspace.name })}
    >
      <form onSubmit={save}>
        <SettingsCard
          footer={
            isAdmin ? (
              <Button
                type="submit"
                variant="primary"
                loading={saving}
                disabled={!dirty || !name.trim()}
              >
                {t("common.save")}
              </Button>
            ) : undefined
          }
        >
          <div className="flex items-center gap-4">
            <WorkspaceGlyph
              workspace={{ name: name || workspace.name, icon: icon.trim() || null, color }}
              size={56}
            />
            <div className="min-w-0">
              <p className="truncate font-serif text-2xl text-fg">{name || workspace.name}</p>
              <p className="text-xs text-fg-muted">
                {details
                  ? `${details.planName} · ${t("settings.workspace.members", { count: details.memberCount })}`
                  : " "}
              </p>
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-[1fr_140px]">
            <Field label={t("settings.workspace.name")}>
              <Input
                value={name}
                maxLength={64}
                disabled={!isAdmin}
                onChange={(e) => setName(e.target.value)}
              />
            </Field>
            <Field label={t("settings.workspace.icon")} help={t("settings.workspace.iconHelp")}>
              <Input
                value={icon}
                maxLength={2}
                disabled={!isAdmin}
                onChange={(e) => setIcon(e.target.value)}
              />
            </Field>
          </div>
          <Field label={t("settings.workspace.color")}>
            <div className="flex flex-wrap gap-2">
              {COLORS.map((c) => (
                <Swatch
                  key={c}
                  color={c}
                  selected={color === c}
                  onSelect={() => isAdmin && setColor(c)}
                  label={c}
                />
              ))}
            </div>
          </Field>
        </SettingsCard>
      </form>

      <SettingsCard>
        <SettingsRow
          label={t("settings.workspace.default")}
          description={
            workspace.isDefault
              ? t("settings.workspace.isDefault")
              : t("settings.workspace.defaultBody")
          }
        >
          {workspace.isDefault ? (
            <Badge tone="accent">{t("app.workspace.label")}</Badge>
          ) : (
            <Button
              variant="secondary"
              onClick={() =>
                void setDefault({ workspaceId: workspace.id }).catch((e: unknown) =>
                  toast.error(errorMessage(e)),
                )
              }
            >
              {t("settings.workspace.makeDefault")}
            </Button>
          )}
        </SettingsRow>
        {!team ? (
          <SettingsRow
            label={t("app.workspace.create")}
            description={t("settings.workspace.personal")}
          >
            <Button
              variant="secondary"
              onClick={() => setCreating(true)}
              disabled={!me.features.teams}
            >
              {t("settings.workspace.createTeam")}
            </Button>
          </SettingsRow>
        ) : null}
        {team && isOwner && transferable.length > 0 ? (
          <SettingsRow
            label={t("settings.workspace.transfer")}
            description={t("settings.workspace.transferBody")}
          >
            <div className="flex gap-2">
              <Select
                className="w-48"
                aria-label={t("settings.workspace.transferTo")}
                placeholder={t("settings.workspace.transferTo")}
                options={transferable.map((m) => ({ value: m.userId, label: m.name || m.email }))}
                value={newOwner || undefined}
                onValueChange={setNewOwner}
              />
              <Button
                variant="secondary"
                disabled={!newOwner}
                onClick={async () => {
                  const person = transferable.find((m) => m.userId === newOwner);
                  const ok = await confirm({
                    title: t("settings.workspace.transferConfirm", {
                      name: workspace.name,
                      person: person?.name ?? "",
                    }),
                    confirmLabel: t("settings.workspace.transfer"),
                  });
                  if (!ok) return;
                  try {
                    await transfer({ workspaceId: workspace.id, userId: newOwner });
                    toast.success(t("settings.workspace.transferred"));
                  } catch (e) {
                    toast.error(errorMessage(e));
                  }
                }}
              >
                {t("settings.workspace.transfer")}
              </Button>
            </div>
          </SettingsRow>
        ) : null}
        {team && !isOwner ? (
          <SettingsRow
            label={t("settings.workspace.leave")}
            description={t("settings.workspace.leaveBody")}
          >
            <Button variant="secondary" onClick={doLeave}>
              {t("settings.workspace.leave")}
            </Button>
          </SettingsRow>
        ) : null}
      </SettingsCard>

      {team && isOwner ? (
        <SettingsCard
          tone="danger"
          title={t("settings.workspace.delete")}
          description={t("settings.workspace.deleteBody")}
          footer={
            <Button variant="danger" onClick={() => setDeleteOpen(true)}>
              {t("settings.workspace.delete")}
            </Button>
          }
        />
      ) : null}

      <DeleteWorkspaceDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        name={workspace.name}
        onConfirm={async (confirmName) => {
          await remove({ workspaceId: workspace.id, confirmName });
          toast.success(t("settings.workspace.deleted"));
          const next = workspaces.find((w) => w.id !== workspace.id);
          if (next) setWorkspaceId(next.id);
          router.replace("/");
        }}
      />
      <PromptDialog
        open={creating}
        onOpenChange={setCreating}
        title={t("app.workspace.createTitle")}
        description={t("app.workspace.createBody")}
        label={t("app.workspace.name")}
        placeholder={t("app.workspace.namePlaceholder")}
        submitLabel={t("common.create")}
        maxLength={64}
        onSubmit={async (value) => {
          const id: Id<"workspaces"> = await create({ name: value });
          setWorkspaceId(id);
          toast.success(t("app.workspace.created"));
        }}
      />
    </SettingsPage>
  );
}

function DeleteWorkspaceDialog({
  open,
  onOpenChange,
  name,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  name: string;
  onConfirm: (confirmName: string) => Promise<void>;
}) {
  const t = useT();
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setPending(true);
    try {
      await onConfirm(value);
      onOpenChange(false);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle className="rich-title">
              <Rich text={t("settings.workspace.deleteTitle", { name })} />
            </DialogTitle>
            <DialogDescription>{t("settings.workspace.deleteBody")}</DialogDescription>
          </DialogHeader>
          <DialogBody className="pb-5">
            <Field label={t("settings.workspace.deleteConfirmLabel")} error={error ?? undefined}>
              <Input
                value={value}
                placeholder={name}
                onChange={(e) => setValue(e.target.value)}
                autoComplete="off"
              />
            </Field>
          </DialogBody>
          <DialogFooter>
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" variant="danger" loading={pending} disabled={value !== name}>
              {t("settings.workspace.delete")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
