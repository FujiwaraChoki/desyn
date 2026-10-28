"use client";

import {
  Avatar,
  Badge,
  Button,
  Callout,
  cn,
  Dialog,
  DialogBody,
  DialogContent,
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
  IconButton,
  Input,
  NumberField,
  Select,
  Skeleton,
  Switch,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  toast,
  useConfirm,
} from "@desyn/ui";
import { useMutation, usePaginatedQuery, useQuery } from "convex/react";
import {
  CheckCircle2,
  CircleSlash,
  Coins,
  MoreHorizontal,
  Plus,
  Search,
  ShieldCheck,
  Trash2,
  XCircle,
} from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { useApp } from "@/components/app/app-context";
import { Page, PageHeader } from "@/components/app/app-shell";
import { Rich } from "@/components/rich";
import { api } from "@/lib/convex-api";
import { errorMessage } from "@/lib/errors";
import { formatBytes, formatNumber, relativeTime } from "@/lib/format";
import { useLocale, useT } from "@/lib/i18n";

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-card border border-line-subtle bg-surface-1 p-4">
      <p className="text-xs text-fg-muted">{label}</p>
      <p className="mt-2 font-serif text-[32px] leading-none text-fg tabular-nums">{value}</p>
      {hint ? <p className="mt-2 text-2xs text-fg-muted">{hint}</p> : null}
    </div>
  );
}

function Overview() {
  const t = useT();
  const locale = useLocale();
  const usage = useQuery(api.admin.system.usageOverview, {});
  const health = useQuery(api.admin.system.health, {});
  const n = (v: number) => formatNumber(v, locale);
  if (!usage || !health) return <Skeleton className="h-80 rounded-panel" />;
  const groups: { key: keyof typeof health.integrations; label: string }[] = [
    { key: "auth", label: t("admin.overview.groups.auth") },
    { key: "mail", label: t("admin.overview.groups.mail") },
    { key: "billing", label: t("admin.overview.groups.billing") },
    { key: "ai", label: t("admin.overview.groups.ai") },
    { key: "storage", label: t("admin.overview.groups.storage") },
    { key: "stock", label: t("admin.overview.groups.other") },
    { key: "telemetry", label: t("admin.overview.groups.other") },
  ];
  const truncated = usage.credits.truncated || usage.exports.truncated || usage.designs.truncated;
  return (
    <div className="flex flex-col gap-8">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label={t("admin.overview.users")} value={n(usage.users)} />
        <Stat label={t("admin.overview.pro")} value={n(usage.proUsers)} />
        <Stat label={t("admin.overview.designs")} value={n(usage.designs.total)} />
        <Stat
          label={t("admin.overview.storage")}
          value={formatBytes(usage.storageBytes.total, locale)}
        />
        <Stat label={t("admin.overview.exports")} value={n(usage.exports.total)} />
        <Stat label={t("admin.overview.aiRequests")} value={n(usage.aiRequests.total)} />
        <Stat
          label={t("admin.overview.credits")}
          value={n(usage.credits.used)}
          hint={t("admin.overview.activeAi", { count: usage.credits.activeUsers })}
        />
      </div>
      {truncated ? <p className="text-xs text-fg-muted">{t("admin.overview.truncated")}</p> : null}
      <section>
        <h2 className="mb-3 font-serif text-2xl text-fg">{t("admin.overview.health")}</h2>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Stat label={t("admin.overview.mailQueued")} value={n(health.mail.queued)} />
          <Stat label={t("admin.overview.mailFailed")} value={n(health.mail.failed)} />
          <Stat label={t("admin.overview.staleReservations")} value={n(health.staleReservations)} />
          <Stat label={t("admin.overview.logBacklog")} value={n(health.logBacklog)} />
        </div>
      </section>
      <section>
        <h2 className="mb-3 font-serif text-2xl text-fg">{t("admin.overview.integrations")}</h2>
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {groups.map((g) => {
            const value = health.integrations[g.key];
            const entries =
              typeof value === "object" && value !== null
                ? Object.entries(value).filter(([, v]) => typeof v === "boolean")
                : [];
            if (entries.length === 0) return null;
            return (
              <div key={g.key} className="rounded-card border border-line-subtle bg-surface-1 p-4">
                <p className="mb-2 text-2xs font-medium text-fg-muted">{g.label}</p>
                <ul className="flex flex-col gap-1.5">
                  {entries.map(([name, on]) => (
                    <li key={name} className="flex items-center justify-between text-sm">
                      <span className="text-fg-secondary">
                        {t(`admin.overview.names.${name}` as "admin.overview.names.secret")}
                      </span>
                      {on ? (
                        <CheckCircle2
                          aria-label={t("admin.overview.ok")}
                          className="size-4 text-success"
                        />
                      ) : (
                        <XCircle
                          aria-label={t("admin.overview.missing")}
                          className="size-4 text-fg-muted"
                        />
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
          <div className="rounded-card border border-line-subtle bg-surface-1 p-4">
            <p className="mb-2 text-2xs font-medium text-fg-muted">
              {t("admin.overview.groups.other")}
            </p>
            <p className="flex items-center justify-between text-sm">
              <span className="text-fg-secondary">{t("admin.overview.names.renderWorker")}</span>
              {health.integrations.renderWorker ? (
                <CheckCircle2 className="size-4 text-success" />
              ) : (
                <XCircle className="size-4 text-fg-muted" />
              )}
            </p>
            <p className="mt-1.5 flex items-center justify-between text-sm">
              <span className="text-fg-secondary">{t("admin.overview.groups.mail")}</span>
              <Badge size="sm">{health.integrations.mail.transport}</Badge>
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}

function CreditsDialog({
  userId,
  email,
  open,
  onOpenChange,
}: {
  userId: string;
  email: string;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const t = useT();
  const adjust = useMutation(api.admin.users.adjustUserCredits);
  const [delta, setDelta] = useState<number>(100);
  const [note, setNote] = useState("");
  const [pending, setPending] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setPending(true);
    try {
      await adjust({ userId, delta, note: note.trim() || `Admin adjustment for ${email}` });
      toast.success(t("admin.users.saved"));
      onOpenChange(false);
    } catch (err) {
      toast.error(errorMessage(err));
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
              <Rich text={t("admin.users.creditsTitle")} />
            </DialogTitle>
          </DialogHeader>
          <DialogBody className="flex flex-col gap-4 pb-5">
            <Field label={t("admin.users.creditsDelta")}>
              <NumberField
                value={delta}
                onChange={setDelta}
                step={10}
                min={-100000}
                max={100000}
                aria-label={t("admin.users.creditsDelta")}
              />
            </Field>
            <Field label={t("admin.users.creditsNote")}>
              <Input value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} />
            </Field>
          </DialogBody>
          <DialogFooter>
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" variant="primary" loading={pending} disabled={delta === 0}>
              {t("common.save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Users() {
  const t = useT();
  const locale = useLocale();
  const confirm = useConfirm();
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  useEffect(() => {
    const id = setTimeout(() => setQuery(search.trim()), 250);
    return () => clearTimeout(id);
  }, [search]);
  const { results, status, loadMore } = usePaginatedQuery(
    api.admin.users.list,
    query ? { search: query } : {},
    { initialNumItems: 25 },
  );
  const setPlan = useMutation(api.admin.users.setPlanOverride);
  const setRole = useMutation(api.admin.users.setRole);
  const setDisabled = useMutation(api.admin.users.setDisabled);
  const [credits, setCredits] = useState<{ userId: string; email: string } | null>(null);
  const run = (p: Promise<unknown>) =>
    void p
      .then(() => toast.success(t("admin.users.saved")))
      .catch((e: unknown) => toast.error(errorMessage(e)));

  return (
    <div className="flex flex-col gap-4">
      <Input
        leading={<Search />}
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder={t("admin.users.search")}
        aria-label={t("admin.users.search")}
        className="max-w-sm"
      />
      <div className="overflow-hidden rounded-panel border border-line-subtle bg-surface-1">
        <div className="hidden grid-cols-[minmax(0,2fr)_120px_100px_120px_40px] gap-4 border-b border-line-subtle px-4 py-2.5 text-2xs font-medium text-fg-muted md:grid">
          <span>{t("admin.users.user")}</span>
          <span>{t("admin.users.plan")}</span>
          <span>{t("admin.users.role")}</span>
          <span>{t("admin.users.lastSeen")}</span>
          <span />
        </div>
        {status === "LoadingFirstPage" ? (
          <div className="p-4">
            <Skeleton className="h-40" />
          </div>
        ) : results.length === 0 ? (
          <p className="p-6 text-center text-sm text-fg-muted">{t("admin.users.empty")}</p>
        ) : (
          <ul className="divide-y divide-line-subtle">
            {results.map((u) => (
              <li
                key={u.userId}
                className={cn(
                  "grid grid-cols-[minmax(0,1fr)_40px] items-center gap-4 px-4 py-3 md:grid-cols-[minmax(0,2fr)_120px_100px_120px_40px]",
                  u.disabled && "opacity-60",
                )}
              >
                <div className="flex min-w-0 items-center gap-3">
                  <Avatar name={u.name || u.email} src={u.image} size="sm" />
                  <div className="min-w-0">
                    <p className="flex items-center gap-1.5 truncate text-sm text-fg">
                      {u.name || u.email}
                      {u.disabled ? (
                        <Badge tone="danger" size="sm">
                          {t("admin.users.disabled")}
                        </Badge>
                      ) : null}
                    </p>
                    <p className="truncate text-2xs text-fg-muted">{u.email}</p>
                  </div>
                </div>
                <span className="hidden md:block">
                  <Badge tone={u.plan === "pro" ? "accent" : "neutral"}>
                    {u.planName}
                    {u.planOverride ? " *" : ""}
                  </Badge>
                </span>
                <span className="hidden text-sm text-fg-secondary md:block">
                  {u.isAdmin ? t("admin.users.admin") : "—"}
                </span>
                <span className="hidden text-xs text-fg-muted md:block">
                  {u.lastSeenAt ? relativeTime(u.lastSeenAt, Date.now(), locale) : "—"}
                </span>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <IconButton label={t("admin.users.actions", { email: u.email })} size="sm">
                      <MoreHorizontal />
                    </IconButton>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-60">
                    <DropdownMenuLabel>{t("admin.users.setPlan")}</DropdownMenuLabel>
                    <DropdownMenuRadioGroup
                      value={u.planOverride ?? "none"}
                      onValueChange={(v) =>
                        run(
                          setPlan({
                            userId: u.userId,
                            plan: v === "none" ? null : (v as "free" | "pro" | "selfhost"),
                          }),
                        )
                      }
                    >
                      <DropdownMenuRadioItem value="none">
                        {t("admin.users.planNone")}
                      </DropdownMenuRadioItem>
                      <DropdownMenuRadioItem value="free">Free</DropdownMenuRadioItem>
                      <DropdownMenuRadioItem value="pro">Pro</DropdownMenuRadioItem>
                      <DropdownMenuRadioItem value="selfhost">Self-hosted</DropdownMenuRadioItem>
                    </DropdownMenuRadioGroup>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      icon={<ShieldCheck />}
                      onSelect={() =>
                        run(
                          setRole({
                            userId: u.userId,
                            role: u.role === "admin" ? "user" : "admin",
                          }),
                        )
                      }
                    >
                      {u.role === "admin"
                        ? t("admin.users.removeAdmin")
                        : t("admin.users.makeAdmin")}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      icon={<Coins />}
                      onSelect={() => setCredits({ userId: u.userId, email: u.email })}
                    >
                      {t("admin.users.credits")}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      icon={<CircleSlash />}
                      destructive={!u.disabled}
                      onSelect={async () => {
                        if (!u.disabled) {
                          const ok = await confirm({
                            title: t("admin.users.disableConfirm", { email: u.email }),
                            description: t("admin.users.disableBody"),
                            confirmLabel: t("admin.users.disable"),
                            tone: "danger",
                          });
                          if (!ok) return;
                        }
                        run(setDisabled({ userId: u.userId, disabled: !u.disabled }));
                      }}
                    >
                      {u.disabled ? t("admin.users.enable") : t("admin.users.disable")}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </li>
            ))}
          </ul>
        )}
      </div>
      {status === "CanLoadMore" ? (
        <Button variant="ghost" className="self-center" onClick={() => loadMore(25)}>
          {t("dashboard.filters.loadMore")}
        </Button>
      ) : null}
      {credits ? (
        <CreditsDialog
          userId={credits.userId}
          email={credits.email}
          open
          onOpenChange={(o) => !o && setCredits(null)}
        />
      ) : null}
    </div>
  );
}

interface FlagDraft {
  key: string;
  enabled: boolean;
  plans: string;
  rollout: number | null;
  description: string;
}

function Flags() {
  const t = useT();
  const data = useQuery(api.admin.flags.list, {});
  const set = useMutation(api.admin.flags.set);
  const remove = useMutation(api.admin.flags.remove);
  const [draft, setDraft] = useState<FlagDraft | null>(null);
  const [pending, setPending] = useState(false);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!draft) return;
    setPending(true);
    try {
      await set({
        key: draft.key.trim(),
        enabled: draft.enabled,
        ...(draft.plans !== "all" ? { plans: [draft.plans] } : {}),
        ...(draft.rollout !== null ? { rollout: draft.rollout } : {}),
        ...(draft.description.trim() ? { description: draft.description.trim() } : {}),
      });
      toast.success(t("admin.flags.saved"));
      setDraft(null);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setPending(false);
    }
  };
  if (!data) return <Skeleton className="h-60 rounded-panel" />;
  return (
    <div className="flex flex-col gap-4">
      <Button
        variant="primary"
        leadingIcon={<Plus />}
        className="self-start"
        onClick={() =>
          setDraft({ key: "feature.", enabled: true, plans: "all", rollout: null, description: "" })
        }
      >
        {t("admin.flags.new")}
      </Button>
      {data.flags.length === 0 ? (
        <Callout tone="info">{t("admin.flags.empty")}</Callout>
      ) : (
        <ul className="divide-y divide-line-subtle overflow-hidden rounded-panel border border-line-subtle bg-surface-1">
          {data.flags.map((f) => (
            <li key={f.key} className="flex items-center gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <p className="truncate font-mono text-sm text-fg">{f.key}</p>
                <p className="truncate text-2xs text-fg-muted">
                  {[
                    f.plans?.join(", ") ?? t("admin.flags.plansAll"),
                    f.rollout !== null ? `${f.rollout}%` : null,
                    f.description,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
              </div>
              <Switch
                checked={f.enabled}
                aria-label={f.key}
                onCheckedChange={(on) =>
                  void set({
                    key: f.key,
                    enabled: on,
                    ...(f.plans ? { plans: f.plans } : {}),
                    ...(f.rollout !== null ? { rollout: f.rollout } : {}),
                    ...(f.description ? { description: f.description } : {}),
                  }).catch((e: unknown) => toast.error(errorMessage(e)))
                }
              />
              <IconButton
                label={t("admin.flags.remove")}
                size="sm"
                variant="danger"
                onClick={() =>
                  void remove({ key: f.key })
                    .then(() => toast.success(t("admin.flags.removed")))
                    .catch((e: unknown) => toast.error(errorMessage(e)))
                }
              >
                <Trash2 />
              </IconButton>
            </li>
          ))}
        </ul>
      )}
      <Dialog open={draft !== null} onOpenChange={(o) => !o && setDraft(null)}>
        <DialogContent>
          {draft ? (
            <form onSubmit={save}>
              <DialogHeader>
                <DialogTitle className="rich-title">
                  <Rich text={t("admin.flags.editTitle")} />
                </DialogTitle>
              </DialogHeader>
              <DialogBody className="flex flex-col gap-4 pb-5">
                <Field label={t("admin.flags.key")} help={t("admin.flags.keyHelp")}>
                  <Input
                    value={draft.key}
                    list="feature-keys"
                    className="font-mono"
                    inputClassName="font-mono"
                    onChange={(e) => setDraft({ ...draft, key: e.target.value })}
                  />
                  <datalist id="feature-keys">
                    {data.featureKeys.map((k) => (
                      <option key={k} value={`feature.${k}`} />
                    ))}
                  </datalist>
                </Field>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label={t("admin.flags.plans")}>
                    <Select
                      options={[
                        { value: "all", label: t("admin.flags.plansAll") },
                        { value: "free", label: "Free" },
                        { value: "pro", label: "Pro" },
                        { value: "selfhost", label: "Self-hosted" },
                      ]}
                      value={draft.plans}
                      onValueChange={(plans) => setDraft({ ...draft, plans })}
                    />
                  </Field>
                  <Field label={t("admin.flags.rollout")}>
                    <NumberField
                      value={draft.rollout}
                      min={0}
                      max={100}
                      step={5}
                      unit="%"
                      onChange={(rollout) => setDraft({ ...draft, rollout })}
                      aria-label={t("admin.flags.rollout")}
                    />
                  </Field>
                </div>
                <Field label={t("admin.flags.description")}>
                  <Input
                    value={draft.description}
                    maxLength={200}
                    onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                  />
                </Field>
                <Switch
                  label={t("admin.flags.enabled")}
                  checked={draft.enabled}
                  onCheckedChange={(enabled) => setDraft({ ...draft, enabled })}
                />
              </DialogBody>
              <DialogFooter>
                <Button variant="ghost" onClick={() => setDraft(null)}>
                  {t("common.cancel")}
                </Button>
                <Button type="submit" variant="primary" loading={pending}>
                  {t("admin.flags.save")}
                </Button>
              </DialogFooter>
            </form>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}

export function AdminConsole() {
  const t = useT();
  const { me } = useApp();
  if (!me.isAdmin) {
    return (
      <Page>
        <Callout tone="danger">{t("admin.forbidden")}</Callout>
      </Page>
    );
  }
  return (
    <Page wide>
      <PageHeader
        title={<Rich text={t("admin.title")} />}
        description={t("admin.subtitle")}
        eyebrow={
          <Badge tone="accent">
            {me.edition === "selfhost" ? t("admin.selfhost") : t("admin.hosted")}
          </Badge>
        }
      />
      <Tabs defaultValue="overview">
        <TabsList>
          <TabsTrigger value="overview">{t("admin.tabs.overview")}</TabsTrigger>
          <TabsTrigger value="users">{t("admin.tabs.users")}</TabsTrigger>
          <TabsTrigger value="flags">{t("admin.tabs.flags")}</TabsTrigger>
        </TabsList>
        <TabsContent value="overview" className="pt-4">
          <Overview />
        </TabsContent>
        <TabsContent value="users" className="pt-4">
          <Users />
        </TabsContent>
        <TabsContent value="flags" className="pt-4">
          <Flags />
        </TabsContent>
      </Tabs>
    </Page>
  );
}
