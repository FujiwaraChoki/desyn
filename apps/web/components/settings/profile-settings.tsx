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
  Switch,
  toast,
} from "@desyn/ui";
import { useMutation, useQuery } from "convex/react";
import { Laptop, Smartphone } from "lucide-react";
import { type FormEvent, useEffect, useMemo, useState } from "react";
import { useApp } from "@/components/app/app-context";
import { PasswordField } from "@/components/auth/fields";
import { Rich } from "@/components/rich";
import { resetAnalytics } from "@/lib/analytics";
import { authClient } from "@/lib/auth-client";
import { api } from "@/lib/convex-api";
import { authErrorMessage, errorMessage } from "@/lib/errors";
import { displayIp, relativeTime } from "@/lib/format";
import { useLocale, useT } from "@/lib/i18n";
import { deleteLocalKeysForUser } from "@/lib/local-keys";
import { isEmail } from "@/lib/password";
import { describeUserAgent } from "@/lib/user-agent";
import { SettingsCard, SettingsPage, SettingsRow } from "./settings-ui";

const AUTO = "auto";

function timeZones(): string[] {
  const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] };
  return intl.supportedValuesOf?.("timeZone") ?? ["UTC"];
}

function ProfileCard() {
  const t = useT();
  const { me } = useApp();
  const update = useMutation(api.accounts.profiles.update);
  const [name, setName] = useState(me.name);
  const [timezone, setTimezone] = useState(me.timezone ?? AUTO);
  const [saving, setSaving] = useState(false);
  const [emailOpen, setEmailOpen] = useState(false);
  const zones = useMemo(timeZones, []);
  const [autoZone, setAutoZone] = useState("UTC");
  useEffect(() => setAutoZone(Intl.DateTimeFormat().resolvedOptions().timeZone), []);
  const dirty = name.trim() !== me.name || (timezone === AUTO ? null : timezone) !== me.timezone;

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    try {
      await update({ name: name.trim(), timezone: timezone === AUTO ? null : timezone });
      toast.success(t("settings.profile.saved"));
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={save}>
      <SettingsCard
        footer={
          <Button
            type="submit"
            variant="primary"
            loading={saving}
            disabled={!dirty || !name.trim()}
          >
            {t("common.save")}
          </Button>
        }
      >
        <Field label={t("settings.profile.name")}>
          <Input
            value={name}
            maxLength={80}
            autoComplete="name"
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Field label={t("settings.profile.email")}>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              value={me.email}
              readOnly
              className="max-w-sm flex-1"
              aria-label={t("settings.profile.email")}
            />
            <Badge tone={me.emailVerified ? "success" : "warning"}>
              {me.emailVerified
                ? t("settings.profile.emailVerified")
                : t("settings.profile.emailUnverified")}
            </Badge>
            <Button variant="ghost" onClick={() => setEmailOpen(true)}>
              {t("settings.profile.changeEmail")}
            </Button>
          </div>
        </Field>
        <Field label={t("settings.profile.timezone")}>
          <Select
            className="max-w-sm"
            options={[
              { value: AUTO, label: t("settings.profile.timezoneAuto", { zone: autoZone }) },
              ...zones.map((z) => ({ value: z, label: z.replace(/_/g, " ") })),
            ]}
            value={timezone}
            onValueChange={setTimezone}
          />
        </Field>
      </SettingsCard>
      <ChangeEmailDialog open={emailOpen} onOpenChange={setEmailOpen} />
    </form>
  );
}

function ChangeEmailDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const t = useT();
  const { me } = useApp();
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [pending, setPending] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!isEmail(email)) return setError(t("auth.invalidEmail"));
    setPending(true);
    const { error: err } = await authClient.changeEmail({
      newEmail: email.trim(),
      callbackURL: "/settings/profile",
    });
    setPending(false);
    if (err) return setError(authErrorMessage(err));
    toast.success(t("settings.profile.changeEmailSent", { email: me.email }));
    onOpenChange(false);
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle className="rich-title">
              <Rich text={t("settings.profile.changeEmailTitle")} />
            </DialogTitle>
            <DialogDescription>{t("settings.profile.changeEmailBody")}</DialogDescription>
          </DialogHeader>
          <DialogBody className="pb-5">
            <Field label={t("settings.profile.newEmail")} error={error}>
              <Input
                type="email"
                autoFocus
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </Field>
          </DialogBody>
          <DialogFooter>
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" variant="primary" loading={pending}>
              {t("settings.profile.changeEmail")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function PasswordCard() {
  const t = useT();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [pending, setPending] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (next.length < 8) return setError(t("auth.passwordTooShort"));
    setPending(true);
    const { error: err } = await authClient.changePassword({
      currentPassword: current,
      newPassword: next,
      revokeOtherSessions: true,
    });
    setPending(false);
    if (err) return setError(authErrorMessage(err));
    setError(undefined);
    setCurrent("");
    setNext("");
    toast.success(t("settings.profile.passwordChanged"));
  };
  return (
    <form onSubmit={submit}>
      <SettingsCard
        title={t("settings.profile.password")}
        description={t("settings.profile.passwordBody")}
        footer={
          <Button type="submit" variant="primary" loading={pending} disabled={!current || !next}>
            {t("settings.profile.changePassword")}
          </Button>
        }
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <PasswordField
            label={t("settings.profile.currentPassword")}
            name="current"
            value={current}
            onChange={setCurrent}
            autoComplete="current-password"
          />
          <PasswordField
            label={t("settings.profile.newPassword")}
            name="new"
            value={next}
            onChange={setNext}
            error={error}
            autoComplete="new-password"
            showStrength
          />
        </div>
      </SettingsCard>
    </form>
  );
}

function SessionsCard() {
  const t = useT();
  const locale = useLocale();
  const sessions = useQuery(api.accounts.sessions.list, {});
  const revoke = useMutation(api.accounts.sessions.revoke);
  const revokeOthers = useMutation(api.accounts.sessions.revokeOthers);
  const others = (sessions ?? []).filter((s) => !s.current).length;
  return (
    <SettingsCard
      title={t("settings.profile.sessions")}
      description={t("settings.profile.sessionsBody")}
      footer={
        others > 0 ? (
          <Button
            variant="secondary"
            onClick={() =>
              void revokeOthers({})
                .then((r) =>
                  toast.success(t("settings.profile.revokedOthers", { count: r.revoked })),
                )
                .catch((e: unknown) => toast.error(errorMessage(e)))
            }
          >
            {t("settings.profile.revokeOthers")}
          </Button>
        ) : undefined
      }
    >
      <ul className="divide-y divide-line-subtle">
        {(sessions ?? []).map((s) => {
          const ua = describeUserAgent(s.userAgent);
          return (
            <li key={s.id} className="flex items-center gap-3 py-3">
              <span className="grid size-9 shrink-0 place-items-center rounded-[9px] bg-fg/6 text-fg-muted">
                {ua?.mobile ? <Smartphone className="size-4" /> : <Laptop className="size-4" />}
              </span>
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-2 text-sm text-fg">
                  <span className="truncate">
                    {ua
                      ? [ua.browser, ua.os].filter(Boolean).join(" on ")
                      : t("settings.profile.unknownDevice")}
                  </span>
                  {s.current ? (
                    <Badge tone="accent" size="sm">
                      {t("settings.profile.thisDevice")}
                    </Badge>
                  ) : null}
                </p>
                <p className="truncate text-2xs text-fg-muted">
                  {[
                    displayIp(s.ipAddress),
                    t("settings.profile.lastActive", {
                      time: relativeTime(s.lastActiveAt ?? s.createdAt, Date.now(), locale),
                    }),
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
              </div>
              {!s.current ? (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    void revoke({ sessionId: s.id })
                      .then(() => toast.success(t("settings.profile.revoked")))
                      .catch((e: unknown) => toast.error(errorMessage(e)))
                  }
                >
                  {t("settings.profile.revoke")}
                </Button>
              ) : null}
            </li>
          );
        })}
      </ul>
    </SettingsCard>
  );
}

function PreferencesCard() {
  const t = useT();
  const { me } = useApp();
  const update = useMutation(api.accounts.profiles.update);
  return (
    <SettingsCard>
      <SettingsRow
        label={t("settings.profile.marketing")}
        description={t("settings.profile.marketingBody")}
      >
        <Switch
          checked={me.marketingOptIn}
          aria-label={t("settings.profile.marketing")}
          onCheckedChange={(on) =>
            void update({ marketingOptIn: on }).catch((e: unknown) => toast.error(errorMessage(e)))
          }
        />
      </SettingsRow>
    </SettingsCard>
  );
}

function DeleteAccountCard() {
  const t = useT();
  const { me } = useApp();
  const [open, setOpen] = useState(false);
  const [confirmEmail, setConfirmEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setPending(true);
    const { error: err } = await authClient.deleteUser(password ? { password } : {});
    setPending(false);
    if (err) return setError(authErrorMessage(err));
    resetAnalytics();
    await deleteLocalKeysForUser(me.userId);
    // Full navigation (see lib/sign-out.ts): the session is gone, so live queries must not re-run.
    window.location.replace("/login?notice=deleted");
  };
  return (
    <SettingsCard
      tone="danger"
      title={t("settings.profile.danger")}
      description={t("settings.profile.dangerBody")}
      footer={
        <Button variant="danger" onClick={() => setOpen(true)}>
          {t("settings.profile.deleteAccount")}
        </Button>
      }
    >
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent size="sm">
          <form onSubmit={submit}>
            <DialogHeader>
              <DialogTitle className="rich-title">
                <Rich text={t("settings.profile.deleteTitle")} />
              </DialogTitle>
              <DialogDescription>{t("settings.profile.deleteBody")}</DialogDescription>
            </DialogHeader>
            <DialogBody className="flex flex-col gap-4 pb-5">
              <Field label={t("settings.profile.deleteConfirmLabel")}>
                <Input
                  value={confirmEmail}
                  onChange={(e) => setConfirmEmail(e.target.value)}
                  placeholder={me.email}
                  autoComplete="off"
                />
              </Field>
              <PasswordField
                label={t("settings.profile.deletePassword")}
                value={password}
                onChange={setPassword}
                autoComplete="current-password"
              />
              {error ? <p className="text-xs text-danger">{error}</p> : null}
            </DialogBody>
            <DialogFooter>
              <Button variant="ghost" onClick={() => setOpen(false)}>
                {t("common.cancel")}
              </Button>
              <Button
                type="submit"
                variant="danger"
                loading={pending}
                disabled={confirmEmail.trim().toLowerCase() !== me.email.toLowerCase()}
              >
                {t("settings.profile.deleteAccount")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </SettingsCard>
  );
}

export function ProfileSettings() {
  const t = useT();
  return (
    <SettingsPage title={t("settings.profile.title")} description={t("settings.profile.subtitle")}>
      <ProfileCard />
      <PasswordCard />
      <SessionsCard />
      <PreferencesCard />
      <DeleteAccountCard />
    </SettingsPage>
  );
}
