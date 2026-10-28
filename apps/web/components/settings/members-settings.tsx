"use client";

import {
  Avatar,
  Badge,
  Button,
  Callout,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Field,
  Select,
  Textarea,
  toast,
  useConfirm,
} from "@desyn/ui";
import { useMutation, useQuery } from "convex/react";
import { ChevronDown, Mail, RotateCw, UserMinus, UserPlus, X } from "lucide-react";
import Link from "next/link";
import { type FormEvent, useState } from "react";
import { useApp } from "@/components/app/app-context";
import { CreateWorkspaceDialog } from "@/components/app/workspace-switcher";
import { Rich } from "@/components/rich";
import { api } from "@/lib/convex-api";
import { errorMessage } from "@/lib/errors";
import { relativeTime } from "@/lib/format";
import { useLocale, useT } from "@/lib/i18n";
import { isEmail } from "@/lib/password";
import { routes } from "@/lib/routes";
import { SettingsCard, SettingsPage } from "./settings-ui";

const ASSIGNABLE = ["admin", "editor", "commenter", "viewer"] as const;
type Assignable = (typeof ASSIGNABLE)[number];
const RANK: Record<string, number> = { viewer: 0, commenter: 1, editor: 2, admin: 3, owner: 4 };
const rank = (role: string): number => RANK[role] ?? 0;

function InviteDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const t = useT();
  const { workspace } = useApp();
  const create = useMutation(api.accounts.invites.create);
  const [emails, setEmails] = useState("");
  const [role, setRole] = useState<Assignable>("editor");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const roles = ASSIGNABLE.filter(
    (r) => workspace.role === "owner" || rank(r) <= rank(workspace.role),
  );
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const list = [
      ...new Set(
        emails
          .split(/[\s,;]+/)
          .map((e) => e.trim().toLowerCase())
          .filter(Boolean),
      ),
    ];
    const bad = list.find((e) => !isEmail(e));
    if (bad) return setError(t("onboarding.team.invalidEmail", { email: bad }));
    if (list.length === 0) return setError(t("common.required"));
    setPending(true);
    try {
      const result = await create({ workspaceId: workspace.id, emails: list.slice(0, 20), role });
      if (result.invited.length > 0)
        toast.success(t("settings.members.sent", { count: result.invited.length }));
      for (const s of result.skipped) toast.info(t("settings.members.skipped", { email: s.email }));
      setEmails("");
      onOpenChange(false);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle className="rich-title">
              <Rich text={t("settings.members.inviteTitle", { name: workspace.name })} />
            </DialogTitle>
            <DialogDescription>{t("settings.members.inviteBody")}</DialogDescription>
          </DialogHeader>
          <DialogBody className="flex flex-col gap-4 pb-5">
            <Field
              label={t("settings.members.emails")}
              help={t("onboarding.team.emailsHelp")}
              error={error ?? undefined}
            >
              <Textarea
                autoFocus
                autoResize
                minRows={3}
                value={emails}
                placeholder={t("settings.members.emailsPlaceholder")}
                onChange={(e) => setEmails(e.target.value)}
              />
            </Field>
            <Field label={t("settings.members.role")}>
              <Select
                options={roles.map((r) => ({
                  value: r,
                  label: t(`settings.members.roles.${r}`),
                  description: t(`settings.members.roleHelp.${r}`),
                }))}
                value={role}
                onValueChange={setRole}
              />
            </Field>
          </DialogBody>
          <DialogFooter>
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" variant="primary" loading={pending} leadingIcon={<Mail />}>
              {t("settings.members.send")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function MembersSettings() {
  const t = useT();
  const locale = useLocale();
  const confirm = useConfirm();
  const { workspace, me, billing } = useApp();
  const team = workspace.kind === "team";
  const isAdmin = workspace.role === "owner" || workspace.role === "admin";
  const members = useQuery(api.accounts.memberships.list, { workspaceId: workspace.id });
  const invites = useQuery(
    api.accounts.invites.list,
    team && isAdmin ? { workspaceId: workspace.id } : "skip",
  );
  const setRole = useMutation(api.accounts.memberships.setRole);
  const removeMember = useMutation(api.accounts.memberships.remove);
  const resend = useMutation(api.accounts.invites.resend);
  const revoke = useMutation(api.accounts.invites.revoke);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [creatingTeam, setCreatingTeam] = useState(false);
  const canManage = (role: string) =>
    isAdmin &&
    role !== "owner" &&
    (workspace.role === "owner" || rank(role) < rank(workspace.role));

  return (
    <SettingsPage
      title={t("settings.members.title")}
      description={t("settings.members.subtitle", { name: workspace.name })}
      actions={
        team && isAdmin ? (
          <Button variant="primary" leadingIcon={<UserPlus />} onClick={() => setInviteOpen(true)}>
            {t("settings.members.invite")}
          </Button>
        ) : undefined
      }
    >
      {!team ? (
        <Callout
          tone="info"
          action={
            me.features.teams ? (
              <Button size="sm" variant="secondary" onClick={() => setCreatingTeam(true)}>
                {t("app.workspace.create")}
              </Button>
            ) : billing ? (
              <Button asChild size="sm" variant="primary">
                <Link href={`${routes.settings("billing")}?upgrade=1`}>{t("common.upgrade")}</Link>
              </Button>
            ) : undefined
          }
        >
          {me.features.teams ? t("settings.members.personal") : t("settings.members.proOnly")}
        </Callout>
      ) : null}
      <SettingsCard>
        <ul className="divide-y divide-line-subtle">
          {(members ?? []).map((m) => (
            <li key={m.userId} className="flex items-center gap-3 py-3">
              <Avatar name={m.name || m.email || "?"} src={m.image} size="md" />
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-2 text-sm text-fg">
                  <span className="truncate">{m.name || m.email || "?"}</span>
                  {m.isYou ? <Badge size="sm">{t("settings.members.you")}</Badge> : null}
                </p>
                <p className="truncate text-2xs text-fg-muted">
                  {m.email} ·{" "}
                  {t("settings.members.joined", {
                    time: relativeTime(m.joinedAt, Date.now(), locale),
                  })}
                </p>
              </div>
              {canManage(m.role) && !m.isYou ? (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="sm" trailingIcon={<ChevronDown />}>
                      {t(`settings.members.roles.${m.role}` as "settings.members.roles.editor")}
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-64">
                    <DropdownMenuLabel>{t("settings.members.role")}</DropdownMenuLabel>
                    <DropdownMenuRadioGroup
                      value={m.role}
                      onValueChange={(role) =>
                        void setRole({
                          workspaceId: workspace.id,
                          userId: m.userId,
                          role: role as Assignable,
                        })
                          .then(() =>
                            toast.success(
                              t("settings.members.roleChanged", {
                                name: m.name ?? m.email ?? "",
                                role: t(`settings.members.roles.${role as Assignable}`),
                              }),
                            ),
                          )
                          .catch((e: unknown) => toast.error(errorMessage(e)))
                      }
                    >
                      {ASSIGNABLE.filter(
                        (r) => workspace.role === "owner" || rank(r) < rank(workspace.role),
                      ).map((r) => (
                        <DropdownMenuRadioItem key={r} value={r}>
                          <span className="flex flex-col">
                            <span>{t(`settings.members.roles.${r}`)}</span>
                            <span className="text-2xs text-fg-muted">
                              {t(`settings.members.roleHelp.${r}`)}
                            </span>
                          </span>
                        </DropdownMenuRadioItem>
                      ))}
                    </DropdownMenuRadioGroup>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      icon={<UserMinus />}
                      destructive
                      onSelect={async () => {
                        const ok = await confirm({
                          title: t("settings.members.removeConfirm", {
                            name: m.name || m.email || "",
                          }),
                          description: t("settings.members.removeBody"),
                          confirmLabel: t("common.remove"),
                          tone: "danger",
                        });
                        if (!ok) return;
                        try {
                          await removeMember({ workspaceId: workspace.id, userId: m.userId });
                          toast.success(
                            t("settings.members.removed", { name: m.name || m.email || "" }),
                          );
                        } catch (e) {
                          toast.error(errorMessage(e));
                        }
                      }}
                    >
                      {t("settings.members.remove")}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : (
                <Badge tone={m.role === "owner" ? "accent" : "neutral"}>
                  {t(`settings.members.roles.${m.role}` as "settings.members.roles.editor")}
                </Badge>
              )}
            </li>
          ))}
        </ul>
      </SettingsCard>
      {invites && invites.length > 0 ? (
        <SettingsCard title={t("settings.members.pending")}>
          <ul className="divide-y divide-line-subtle">
            {invites.map((inv) => (
              <li key={inv.id} className="flex items-center gap-3 py-3">
                <span className="grid size-8 shrink-0 place-items-center rounded-full border border-dashed border-line-strong text-fg-muted">
                  <Mail className="size-3.5" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-fg">{inv.email}</p>
                  <p className="truncate text-2xs text-fg-muted">
                    {t(`settings.members.roles.${inv.role}` as "settings.members.roles.editor")} ·{" "}
                    {t("settings.members.expires", {
                      time: relativeTime(inv.expiresAt, Date.now(), locale),
                    })}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  leadingIcon={<RotateCw />}
                  onClick={() =>
                    void resend({ inviteId: inv.id })
                      .then(() => toast.success(t("settings.members.resent")))
                      .catch((e: unknown) => toast.error(errorMessage(e)))
                  }
                >
                  {t("settings.members.resend")}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  leadingIcon={<X />}
                  onClick={() =>
                    void revoke({ inviteId: inv.id })
                      .then(() => toast.success(t("settings.members.revoked")))
                      .catch((e: unknown) => toast.error(errorMessage(e)))
                  }
                >
                  {t("settings.members.revokeInvite")}
                </Button>
              </li>
            ))}
          </ul>
        </SettingsCard>
      ) : null}
      <InviteDialog open={inviteOpen} onOpenChange={setInviteOpen} />
      <CreateWorkspaceDialog open={creatingTeam} onOpenChange={setCreatingTeam} />
    </SettingsPage>
  );
}
