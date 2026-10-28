"use client";

import {
  Badge,
  Button,
  Callout,
  Checkbox,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState,
  Field,
  IconButton,
  Input,
  Select,
  toast,
  useConfirm,
} from "@desyn/ui";
import { useMutation, useQuery } from "convex/react";
import { Check, Copy, KeyRound, Plus } from "lucide-react";
import Link from "next/link";
import { type FormEvent, useState } from "react";
import { useApp } from "@/components/app/app-context";
import { Rich } from "@/components/rich";
import { api } from "@/lib/convex-api";
import { publicEnv } from "@/lib/env";
import { errorMessage } from "@/lib/errors";
import { formatDate, relativeTime } from "@/lib/format";
import { useLocale, useT } from "@/lib/i18n";
import { routes } from "@/lib/routes";
import { SettingsCard, SettingsPage } from "./settings-ui";

const EXPIRY = ["never", "30", "90", "365"] as const;

function CopyField({ value }: { value: string }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-2">
      <Input
        readOnly
        value={value}
        className="font-mono"
        inputClassName="font-mono text-xs"
        onFocus={(e) => e.currentTarget.select()}
        aria-label="API key"
      />
      <IconButton
        variant="secondary"
        label={copied ? t("common.copied") : t("common.copy")}
        onClick={() => {
          void navigator.clipboard.writeText(value).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1600);
          });
        }}
      >
        {copied ? <Check /> : <Copy />}
      </IconButton>
    </div>
  );
}

function CreateKeyDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const t = useT();
  const { workspaces, workspaceId, me } = useApp();
  const scopes = useQuery(api.accounts.apiKeys.availableScopes, {});
  const create = useMutation(api.accounts.apiKeys.create);
  const [name, setName] = useState("");
  const [ws, setWs] = useState<string>(workspaceId);
  const [chosen, setChosen] = useState<string[]>(["designs:read", "designs:write", "ai:run"]);
  const [expiry, setExpiry] = useState<(typeof EXPIRY)[number]>("90");
  const [secret, setSecret] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const close = (o: boolean) => {
    if (!o) {
      setSecret(null);
      setName("");
      setError(null);
    }
    onOpenChange(o);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setPending(true);
    try {
      const result = await create({
        workspaceId: ws as typeof workspaceId,
        name: name.trim(),
        scopes: chosen as NonNullable<typeof scopes>,
        ...(expiry !== "never" ? { expiresInDays: Number(expiry) } : {}),
      });
      setSecret(result.secret);
      toast.success(t("settings.apiKeys.created"));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent>
        {secret ? (
          <>
            <DialogHeader>
              <DialogTitle className="rich-title">
                <Rich text={t("settings.apiKeys.secretTitle")} />
              </DialogTitle>
              <DialogDescription>{t("settings.apiKeys.secretBody")}</DialogDescription>
            </DialogHeader>
            <DialogBody className="pb-5">
              <CopyField value={secret} />
            </DialogBody>
            <DialogFooter>
              <Button variant="primary" onClick={() => close(false)}>
                {t("settings.apiKeys.done")}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <form onSubmit={submit}>
            <DialogHeader>
              <DialogTitle className="rich-title">
                <Rich text={t("settings.apiKeys.createTitle")} />
              </DialogTitle>
            </DialogHeader>
            <DialogBody className="flex flex-col gap-4 pb-5">
              <Field label={t("settings.apiKeys.name")}>
                <Input
                  autoFocus
                  value={name}
                  maxLength={80}
                  placeholder={t("settings.apiKeys.namePlaceholder")}
                  onChange={(e) => setName(e.target.value)}
                  required
                />
              </Field>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label={t("settings.apiKeys.workspace")}>
                  <Select
                    options={workspaces.map((w) => ({ value: w.id, label: w.name }))}
                    value={ws}
                    onValueChange={setWs}
                  />
                </Field>
                <Field label={t("settings.apiKeys.expiry")}>
                  <Select
                    options={EXPIRY.map((e) => ({
                      value: e,
                      label:
                        e === "never"
                          ? t("settings.apiKeys.expiryNever")
                          : t("settings.apiKeys.expiryDays", { count: Number(e) }),
                    }))}
                    value={expiry}
                    onValueChange={setExpiry}
                  />
                </Field>
              </div>
              <fieldset className="flex flex-col gap-2.5">
                <legend className="mb-2 text-xs font-medium text-fg-secondary">
                  {t("settings.apiKeys.scopes")}
                </legend>
                <div className="grid gap-2.5 sm:grid-cols-2">
                  {(scopes ?? []).map((s) => (
                    <Checkbox
                      key={s}
                      label={t(
                        `settings.apiKeys.scopeLabels.${s}` as "settings.apiKeys.scopeLabels.mcp",
                      )}
                      checked={chosen.includes(s)}
                      disabled={s === "mcp" && !me.features.mcp}
                      onCheckedChange={(on) =>
                        setChosen((c) => (on === true ? [...c, s] : c.filter((x) => x !== s)))
                      }
                    />
                  ))}
                </div>
              </fieldset>
              {error ? <Callout tone="danger">{error}</Callout> : null}
            </DialogBody>
            <DialogFooter>
              <Button variant="ghost" onClick={() => close(false)}>
                {t("common.cancel")}
              </Button>
              <Button
                type="submit"
                variant="primary"
                loading={pending}
                disabled={!name.trim() || chosen.length === 0}
              >
                {t("settings.apiKeys.create")}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function ApiKeysSettings() {
  const t = useT();
  const locale = useLocale();
  const confirm = useConfirm();
  const { me, billing, workspaces } = useApp();
  const locked = !me.features.agentApi;
  const keys = useQuery(api.accounts.apiKeys.list, locked ? "skip" : {});
  const revoke = useMutation(api.accounts.apiKeys.revoke);
  const [open, setOpen] = useState(false);
  const wsName = (id: string) => workspaces.find((w) => w.id === id)?.name ?? "";

  if (locked) {
    return (
      <SettingsPage
        title={t("settings.apiKeys.title")}
        description={t("settings.apiKeys.subtitle")}
      >
        <Callout
          tone="accent"
          action={
            billing ? (
              <Button asChild size="sm" variant="primary">
                <Link href={`${routes.settings("billing")}?upgrade=1`}>{t("common.upgrade")}</Link>
              </Button>
            ) : undefined
          }
        >
          {t("settings.apiKeys.locked")}
        </Callout>
      </SettingsPage>
    );
  }

  return (
    <SettingsPage
      title={t("settings.apiKeys.title")}
      description={t("settings.apiKeys.subtitle")}
      actions={
        <Button variant="primary" leadingIcon={<Plus />} onClick={() => setOpen(true)}>
          {t("settings.apiKeys.create")}
        </Button>
      }
    >
      <SettingsCard>
        <div className="grid gap-1 text-sm">
          <span className="text-xs text-fg-muted">{t("settings.apiKeys.endpoint")}</span>
          <code className="font-mono text-xs text-fg">
            {publicEnv.appUrl}/api/v1 · {publicEnv.appUrl}/mcp
          </code>
          <a
            className="mt-1 text-xs text-accent-text hover:underline"
            href={`${publicEnv.docsUrl}/developers/api`}
            target="_blank"
            rel="noreferrer"
          >
            {t("settings.apiKeys.docs")}
          </a>
        </div>
      </SettingsCard>
      {keys && keys.length === 0 ? (
        <EmptyState
          icon={<KeyRound />}
          title={<Rich text={t("settings.apiKeys.empty")} />}
          description={t("settings.apiKeys.emptyBody")}
        />
      ) : (
        <SettingsCard>
          <ul className="divide-y divide-line-subtle">
            {(keys ?? []).map((k) => {
              const expired = k.expiresAt !== null && k.expiresAt <= Date.now();
              return (
                <li key={k.id} className="flex flex-wrap items-center gap-3 py-3">
                  <span className="grid size-9 shrink-0 place-items-center rounded-[9px] bg-fg/6 text-fg-muted">
                    <KeyRound className="size-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-2 text-sm text-fg">
                      <span className="truncate">{k.name}</span>
                      <code className="font-mono text-2xs text-fg-muted">{k.prefix}…</code>
                      {k.revokedAt ? (
                        <Badge tone="danger" size="sm">
                          {t("settings.apiKeys.revokedBadge")}
                        </Badge>
                      ) : expired ? (
                        <Badge tone="warning" size="sm">
                          {t("settings.apiKeys.expired")}
                        </Badge>
                      ) : null}
                    </p>
                    <p className="truncate text-2xs text-fg-muted">
                      {[
                        wsName(k.workspaceId),
                        k.lastUsedAt
                          ? t("settings.apiKeys.lastUsed", {
                              time: relativeTime(k.lastUsedAt, Date.now(), locale),
                            })
                          : t("settings.apiKeys.neverUsed"),
                        k.expiresAt && !expired
                          ? t("settings.apiKeys.expires", { date: formatDate(k.expiresAt, locale) })
                          : null,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </p>
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {k.scopes.map((s) => (
                        <Badge key={s} size="sm" tone="outline">
                          {s}
                        </Badge>
                      ))}
                    </div>
                  </div>
                  {!k.revokedAt ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={async () => {
                        const ok = await confirm({
                          title: t("settings.apiKeys.revokeConfirm", { name: k.name }),
                          description: t("settings.apiKeys.revokeBody"),
                          confirmLabel: t("settings.apiKeys.revoke"),
                          tone: "danger",
                        });
                        if (!ok) return;
                        try {
                          await revoke({ keyId: k.id });
                          toast.success(t("settings.apiKeys.revoked"));
                        } catch (e) {
                          toast.error(errorMessage(e));
                        }
                      }}
                    >
                      {t("settings.apiKeys.revoke")}
                    </Button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </SettingsCard>
      )}
      <CreateKeyDialog open={open} onOpenChange={setOpen} />
    </SettingsPage>
  );
}
