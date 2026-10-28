"use client";

import {
  AI_TASKS,
  type AiTask,
  type CatalogModel,
  type ModelCatalog,
  modelsForTask,
  PROVIDERS,
  type ProviderDefinition,
  type ProviderId,
  TASKS,
  testProvider,
} from "@desyn/ai";
import {
  Badge,
  Button,
  Callout,
  cn,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  Input,
  RadioGroup,
  RadioGroupItem,
  Select,
  Switch,
  toast,
  useConfirm,
} from "@desyn/ui";
import { useConvex, useMutation, useQuery } from "convex/react";
import { CheckCircle2, ExternalLink, KeyRound, PlugZap, XCircle } from "lucide-react";
import Link from "next/link";
import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { useApp } from "@/components/app/app-context";
import { aiBackend, isMissingFunction } from "@/lib/ai-backend";
import { api } from "@/lib/convex-api";
import { publicEnv } from "@/lib/env";
import { errorMessage } from "@/lib/errors";
import { useT } from "@/lib/i18n";
import {
  getLocalProviderConfigs,
  keyTail,
  LOCAL_KEYS_EVENT,
  type LocalProviderConfig,
  setLocalProviderConfig,
} from "@/lib/local-keys";
import { routes } from "@/lib/routes";
import { SettingsCard, SettingsPage, SettingsRow } from "./settings-ui";

type TestState = { ok: boolean; message: string; latencyMs: number } | null;

const BYOK_PROVIDERS = (Object.values(PROVIDERS) as ProviderDefinition[]).filter(
  (p) => p.byok && p.id !== "ollama",
);

function useLocalConfigs() {
  const [configs, setConfigs] = useState<Record<string, LocalProviderConfig>>({});
  useEffect(() => {
    const load = () => void getLocalProviderConfigs().then(setConfigs);
    load();
    window.addEventListener(LOCAL_KEYS_EVENT, load);
    return () => window.removeEventListener(LOCAL_KEYS_EVENT, load);
  }, []);
  return configs;
}

function TestBadge({ state }: { state: TestState }) {
  const t = useT();
  if (!state) return null;
  return (
    <p
      className={cn("flex items-start gap-1.5 text-xs", state.ok ? "text-success" : "text-danger")}
      role="status"
    >
      {state.ok ? (
        <CheckCircle2 className="mt-px size-3.5 shrink-0" />
      ) : (
        <XCircle className="mt-px size-3.5 shrink-0" />
      )}
      {state.ok
        ? `${t("settings.ai.testOk", { ms: state.latencyMs })} · ${state.message}`
        : state.message || t("settings.ai.testFailed")}
    </p>
  );
}

function KeyDialog({
  provider,
  mode,
  open,
  onOpenChange,
  onSaved,
}: {
  provider: ProviderDefinition;
  mode: "server" | "local";
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onSaved: () => void;
}) {
  const t = useT();
  const convex = useConvex();
  const [values, setValues] = useState<Record<string, string>>({});
  const [test, setTest] = useState<TestState>(null);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setValues({});
      setTest(null);
      setError(null);
    }
  }, [open]);

  const config = () => {
    const c: LocalProviderConfig = {};
    if (values.apiKey?.trim()) c.apiKey = values.apiKey.trim();
    if (values.baseURL?.trim()) c.baseURL = values.baseURL.trim().replace(/\/+$/, "");
    if (values.name?.trim()) c.name = values.name.trim();
    return c;
  };

  const runTest = async () => {
    setTesting(true);
    try {
      const result = await testProvider(provider.id, config(), {
        signal: AbortSignal.timeout(15000),
      });
      setTest({ ok: result.ok, message: result.message, latencyMs: result.latencyMs });
    } catch (err) {
      setTest({ ok: false, message: errorMessage(err), latencyMs: 0 });
    } finally {
      setTesting(false);
    }
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    const c = config();
    setSaving(true);
    try {
      if (mode === "local") {
        await setLocalProviderConfig(provider.id, c);
      } else {
        await convex.action(aiBackend.saveKey, {
          provider: provider.id,
          apiKey: c.apiKey ?? "",
          ...(c.baseURL ? { baseUrl: c.baseURL } : {}),
          ...(c.name ? { label: c.name } : {}),
        });
      }
      toast.success(t("settings.ai.keySaved"));
      onSaved();
      onOpenChange(false);
    } catch (err) {
      setError(isMissingFunction(err) ? t("settings.ai.serverUnavailable") : errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={save}>
          <DialogHeader>
            <DialogTitle>{t("settings.ai.keyFor", { provider: provider.label })}</DialogTitle>
            <DialogDescription>
              {mode === "local"
                ? t("settings.ai.keyModeLocalBody")
                : t("settings.ai.keyModeServerBody")}
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="flex flex-col gap-4 pb-5">
            {provider.fields.map((f) => (
              <Field key={f.key} label={f.label} help={f.help} required={f.required}>
                <Input
                  type={f.type === "secret" ? "password" : f.type === "url" ? "url" : "text"}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={f.placeholder}
                  value={values[f.key] ?? ""}
                  onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                  required={f.required}
                />
              </Field>
            ))}
            <div className="flex flex-col gap-2">
              <Button
                variant="secondary"
                leadingIcon={<PlugZap />}
                loading={testing}
                onClick={runTest}
                className="self-start"
              >
                {testing ? t("settings.ai.testing") : t("settings.ai.test")}
              </Button>
              <TestBadge state={test} />
            </div>
            {error ? <Callout tone="danger">{error}</Callout> : null}
          </DialogBody>
          <DialogFooter>
            <Button asChild variant="link" size="sm" className="mr-auto">
              <a href={provider.docsUrl} target="_blank" rel="noreferrer">
                {t("settings.ai.docs")}
              </a>
            </Button>
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" variant="primary" loading={saving}>
              {t("common.save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ProvidersCard() {
  const t = useT();
  const convex = useConvex();
  const { me } = useApp();
  const removeServerKey = useMutation(api.accounts.profiles.removeByokKey);
  const local = useLocalConfigs();
  const mode = me.aiSettings?.keyMode ?? "server";
  const server = me.aiSettings?.byok ?? {};
  const [editing, setEditing] = useState<ProviderDefinition | null>(null);
  const [tests, setTests] = useState<Record<string, TestState>>({});
  const [testing, setTesting] = useState<string | null>(null);

  const testSaved = async (p: ProviderDefinition) => {
    setTesting(p.id);
    try {
      if (mode === "local") {
        const result = await testProvider(p.id, local[p.id] ?? {}, {
          signal: AbortSignal.timeout(15000),
        });
        setTests((s) => ({
          ...s,
          [p.id]: { ok: result.ok, message: result.message, latencyMs: result.latencyMs },
        }));
      } else {
        const result = await convex.action(aiBackend.testProvider, { provider: p.id });
        setTests((s) => ({
          ...s,
          [p.id]: { ok: result.ok, message: result.message, latencyMs: result.latencyMs },
        }));
      }
    } catch (err) {
      setTests((s) => ({
        ...s,
        [p.id]: {
          ok: false,
          message: isMissingFunction(err) ? t("settings.ai.serverUnavailable") : errorMessage(err),
          latencyMs: 0,
        },
      }));
    } finally {
      setTesting(null);
    }
  };

  const remove = async (p: ProviderDefinition) => {
    try {
      if (mode === "local") await setLocalProviderConfig(p.id, null);
      else await removeServerKey({ provider: p.id });
      toast.success(t("settings.ai.keyRemoved"));
      setTests((s) => ({ ...s, [p.id]: null }));
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  return (
    <SettingsCard title={t("settings.ai.providers")}>
      <ul className="divide-y divide-line-subtle">
        {BYOK_PROVIDERS.map((p) => {
          const configured = mode === "local" ? Boolean(local[p.id]) : Boolean(server[p.id]);
          const tail =
            mode === "local" ? keyTail(local[p.id]?.apiKey) : (server[p.id]?.last4 ?? null);
          return (
            <li key={p.id} className="flex flex-col gap-2 py-3.5">
              <div className="flex flex-wrap items-center gap-3">
                <span className="grid size-9 shrink-0 place-items-center rounded-[9px] bg-fg/6 text-fg-muted">
                  <KeyRound className="size-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-2 text-sm font-medium text-fg">
                    {p.label}
                    {configured ? (
                      <Badge tone="success" size="sm">
                        {mode === "local"
                          ? t("settings.ai.configuredLocal")
                          : t("settings.ai.configured")}
                        {tail ? ` ·••${tail}` : ""}
                      </Badge>
                    ) : (
                      <Badge size="sm">{t("settings.ai.notConfigured")}</Badge>
                    )}
                    {p.local ? (
                      <Badge tone="info" size="sm">
                        {t("settings.ai.local")}
                      </Badge>
                    ) : null}
                  </p>
                  <p className="text-xs text-fg-muted">{p.description}</p>
                </div>
                <div className="flex gap-1">
                  {configured ? (
                    <>
                      <Button
                        size="sm"
                        variant="ghost"
                        loading={testing === p.id}
                        onClick={() => testSaved(p)}
                      >
                        {t("settings.ai.test")}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => remove(p)}>
                        {t("settings.ai.removeKey")}
                      </Button>
                    </>
                  ) : null}
                  <Button size="sm" variant="secondary" onClick={() => setEditing(p)}>
                    {configured ? t("settings.ai.replaceKey") : t("settings.ai.addKey")}
                  </Button>
                </div>
              </div>
              <div className="pl-12">
                <TestBadge state={tests[p.id] ?? null} />
              </div>
            </li>
          );
        })}
      </ul>
      {editing ? (
        <KeyDialog
          provider={editing}
          mode={mode}
          open={editing !== null}
          onOpenChange={(o) => !o && setEditing(null)}
          onSaved={() => setTests((s) => ({ ...s, [editing.id]: null }))}
        />
      ) : null}
    </SettingsCard>
  );
}

function KeyModeCard() {
  const t = useT();
  const { me } = useApp();
  const update = useMutation(api.accounts.profiles.updateAiPreferences);
  const confirm = useConfirm();
  const mode = me.aiSettings?.keyMode ?? "server";
  const serverKeys = Object.keys(me.aiSettings?.byok ?? {}).length;
  // Switching to browser-only keys deletes every key stored on the server: confirm first.
  const changeMode = async (next: "server" | "local") => {
    if (next === mode) return;
    if (next === "local" && serverKeys > 0) {
      const ok = await confirm({
        title: t("settings.ai.toLocalTitle"),
        description: t("settings.ai.toLocalBody", { count: serverKeys }),
        confirmLabel: t("settings.ai.toLocalConfirm"),
        tone: "danger",
      });
      if (!ok) return;
    }
    save({ keyMode: next });
  };
  const save = (patch: { keyMode?: "server" | "local"; preferByok?: boolean }) =>
    void update(patch)
      .then(() => toast.success(t("settings.ai.keyModeSaved")))
      .catch((e: unknown) => toast.error(errorMessage(e)));
  return (
    <SettingsCard title={t("settings.ai.keyMode")}>
      <RadioGroup
        value={mode}
        onValueChange={(v) => void changeMode(v as "server" | "local")}
        className="gap-4"
      >
        <RadioGroupItem
          value="server"
          label={t("settings.ai.keyModeServer")}
          description={t("settings.ai.keyModeServerBody")}
        />
        <RadioGroupItem
          value="local"
          label={t("settings.ai.keyModeLocal")}
          description={t("settings.ai.keyModeLocalBody")}
        />
      </RadioGroup>
      <SettingsRow
        label={t("settings.ai.preferByok")}
        description={t("settings.ai.preferByokBody")}
      >
        <Switch
          checked={me.aiSettings?.preferByok ?? false}
          aria-label={t("settings.ai.preferByok")}
          onCheckedChange={(on) => save({ preferByok: on })}
        />
      </SettingsRow>
    </SettingsCard>
  );
}

function OllamaCard() {
  const t = useT();
  const { me } = useApp();
  const update = useMutation(api.accounts.profiles.updateAiPreferences);
  const [url, setUrl] = useState(me.aiSettings?.ollamaBaseUrl ?? "");
  const [test, setTest] = useState<TestState>(null);
  const [testing, setTesting] = useState(false);
  const placeholder = PROVIDERS.ollama.defaultBaseURL;
  return (
    <SettingsCard
      title={t("settings.ai.ollama")}
      description={t("settings.ai.ollamaBody")}
      footer={
        <>
          <Button
            variant="ghost"
            loading={testing}
            leadingIcon={<PlugZap />}
            onClick={async () => {
              setTesting(true);
              try {
                const result = await testProvider(
                  "ollama",
                  url.trim() ? { baseURL: url.trim() } : {},
                  { signal: AbortSignal.timeout(10000) },
                );
                setTest({ ok: result.ok, message: result.message, latencyMs: result.latencyMs });
              } catch (err) {
                setTest({ ok: false, message: errorMessage(err), latencyMs: 0 });
              } finally {
                setTesting(false);
              }
            }}
          >
            {t("settings.ai.test")}
          </Button>
          <Button
            variant="primary"
            disabled={(url.trim() || null) === (me.aiSettings?.ollamaBaseUrl ?? null)}
            onClick={() =>
              void update({ ollamaBaseUrl: url.trim() || null })
                .then(() => toast.success(t("settings.ai.ollamaSaved")))
                .catch((e: unknown) => toast.error(errorMessage(e)))
            }
          >
            {t("common.save")}
          </Button>
        </>
      }
    >
      <Field label={t("settings.ai.ollamaUrl")}>
        <Input
          value={url}
          placeholder={placeholder}
          spellCheck={false}
          onChange={(e) => setUrl(e.target.value)}
        />
      </Field>
      <TestBadge state={test} />
    </SettingsCard>
  );
}

const CUSTOM = "__custom__";
const DEFAULT = "__default__";

function TaskRow({
  task,
  catalog,
  value,
  onChange,
}: {
  task: AiTask;
  catalog: ModelCatalog | null;
  value: { provider: string; model: string } | undefined;
  onChange: (value: { provider: string; model: string } | null) => void;
}) {
  const t = useT();
  const info = TASKS[task];
  const options = useMemo(() => {
    const refs = new Map<string, string>();
    const add = (provider: string, model: string, label?: string) => {
      const key = `${provider}:${model}`;
      if (!refs.has(key))
        refs.set(key, label ? `${label} · ${provider}` : `${model} · ${provider}`);
    };
    for (const r of info.fallbacks) add(r.provider, r.model);
    if (catalog)
      for (const m of modelsForTask(catalog, task).slice(0, 60) as CatalogModel[])
        add(m.provider, m.id, m.label);
    if (value) add(value.provider, value.model);
    refs.delete(`${info.default.provider}:${info.default.model}`);
    return [...refs.entries()].map(([key, label]) => ({ value: key, label }));
  }, [catalog, info, task, value]);
  const current = value ? `${value.provider}:${value.model}` : DEFAULT;
  const [custom, setCustom] = useState(false);
  const [draft, setDraft] = useState(value?.model ?? "");
  return (
    <div className="grid gap-2 py-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)] sm:items-center sm:gap-6">
      <div className="min-w-0">
        <p className="text-sm font-medium text-fg">{info.label}</p>
        <p className="truncate text-xs text-fg-muted">{info.description}</p>
      </div>
      {custom ? (
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const [provider, ...rest] = draft.trim().split(":");
            const model = rest.join(":");
            if (provider && model && provider in PROVIDERS) onChange({ provider, model });
            else if (draft.trim())
              onChange({ provider: info.default.provider, model: draft.trim() });
            setCustom(false);
          }}
        >
          <Input
            autoFocus
            value={draft}
            placeholder={`${info.default.provider}:${t("settings.ai.customModelPlaceholder")}`}
            onChange={(e) => setDraft(e.target.value)}
            aria-label={t("settings.ai.customModel")}
          />
          <Button type="submit" size="md" variant="secondary">
            {t("common.save")}
          </Button>
        </form>
      ) : (
        <Select
          aria-label={info.label}
          value={current}
          onValueChange={(v) => {
            if (v === DEFAULT) onChange(null);
            else if (v === CUSTOM) setCustom(true);
            else {
              const [provider, ...rest] = v.split(":");
              onChange({ provider: provider ?? info.default.provider, model: rest.join(":") });
            }
          }}
          options={[
            { value: DEFAULT, label: t("settings.ai.taskDefault", { model: info.default.model }) },
            ...options,
            { value: CUSTOM, label: `${t("settings.ai.customModel")}…` },
          ]}
        />
      )}
    </div>
  );
}

let catalogRequest: Promise<ModelCatalog | null> | null = null;

/** The live model catalog (one request per page load, shared by the cards that need it). */
function useCatalog(): ModelCatalog | null {
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null);
  useEffect(() => {
    let alive = true;
    catalogRequest ??= fetch("/api/ai/models")
      .then((r) => (r.ok ? (r.json() as Promise<ModelCatalog>) : null))
      .catch(() => null);
    void catalogRequest.then((c) => alive && c && setCatalog(c));
    return () => {
      alive = false;
    };
  }, []);
  return catalog;
}

const TEXT_TASKS = AI_TASKS.filter((task) => TASKS[task].kind === "text");
/** Providers whose route to Claude is pinned in the task defaults: Anthropic (default) and OpenRouter (fallback). */
const CLAUDE_ROUTES = new Set(["anthropic", "openrouter"]);

/** Which provider every text task is pinned to: "auto" (no overrides), one provider, or "mixed". */
function textProviderState(
  taskModels: Partial<Record<AiTask, { provider: string; model: string }>>,
): string {
  const refs = TEXT_TASKS.map((task) => taskModels[task]);
  if (refs.every((r) => !r)) return "auto";
  const first = refs[0]?.provider;
  return first && refs.every((r) => r?.provider === first) ? first : "mixed";
}

function TextProviderCard() {
  const t = useT();
  const { me } = useApp();
  const update = useMutation(api.accounts.profiles.updateAiPreferences);
  const platform = useQuery(api.ai.platform.providers, {});
  const catalog = useCatalog();
  const taskModels = me.aiSettings?.taskModels ?? {};
  const state = textProviderState(taskModels);
  const textProviders = (platform ?? []).filter((p) => p.kinds.includes("text"));
  const [picking, setPicking] = useState<string | null>(null);
  const shown = picking ?? state;

  const save = (next: typeof taskModels, message: string) =>
    void update({ taskModels: next })
      .then(() => toast.success(message))
      .catch((e: unknown) => toast.error(errorMessage(e)));

  const choose = (provider: string) => {
    const next = { ...taskModels };
    if (provider === "auto") {
      for (const task of TEXT_TASKS) delete next[task];
      setPicking(null);
      save(next, t("settings.ai.textProviderReset"));
      return;
    }
    if (CLAUDE_ROUTES.has(provider)) {
      for (const task of TEXT_TASKS) {
        const info = TASKS[task];
        const ref = [info.default, ...info.fallbacks].find((r) => r.provider === provider);
        if (ref) next[task] = { provider: ref.provider, model: ref.model };
      }
      setPicking(null);
      save(
        next,
        t("settings.ai.textProviderSaved", { provider: PROVIDERS[provider as ProviderId].label }),
      );
      return;
    }
    // Other providers: the member picks the model below.
    setPicking(provider);
  };

  const providerModels = (provider: string): CatalogModel[] =>
    (catalog?.models ?? [])
      .filter((m) => m.provider === provider && m.tasks.includes("agent"))
      .sort((a, b) => a.label.localeCompare(b.label));

  const applyModel = (provider: string, modelId: string) => {
    const model = providerModels(provider).find((m) => m.id === modelId);
    if (!model) return;
    const next = { ...taskModels };
    for (const task of TEXT_TASKS) {
      // Vision tasks need image input: keep their current model when this one cannot see.
      if (TASKS[task].vision && !model.tasks.includes("vision")) continue;
      next[task] = { provider, model: model.id };
    }
    setPicking(null);
    save(
      next,
      t("settings.ai.textProviderSaved", { provider: PROVIDERS[provider as ProviderId].label }),
    );
  };

  if (platform === undefined) return null;
  return (
    <SettingsCard
      title={t("settings.ai.textProvider")}
      description={t("settings.ai.textProviderBody")}
    >
      <RadioGroup value={shown} onValueChange={choose} className="gap-4">
        <RadioGroupItem
          value="auto"
          label={t("settings.ai.textProviderAuto")}
          description={t("settings.ai.textProviderAutoBody")}
        />
        {textProviders.map((p) => (
          <RadioGroupItem
            key={p.id}
            value={p.id}
            label={p.label}
            description={
              shown === p.id && state === p.id
                ? t("settings.ai.textProviderPinned", { provider: p.label })
                : PROVIDERS[p.id as ProviderId].description
            }
          />
        ))}
      </RadioGroup>
      {state === "mixed" && picking === null ? (
        <p className="text-xs text-fg-muted">{t("settings.ai.textProviderMixed")}</p>
      ) : null}
      {picking && !CLAUDE_ROUTES.has(picking) ? (
        <Field
          label={t("settings.ai.textProviderModel", {
            provider: PROVIDERS[picking as ProviderId].label,
          })}
        >
          <Select
            aria-label={t("settings.ai.textProviderModel", {
              provider: PROVIDERS[picking as ProviderId].label,
            })}
            value=""
            placeholder={t("settings.ai.textProviderPickModel")}
            onValueChange={(v) => applyModel(picking, v)}
            options={providerModels(picking).map((m) => ({ value: m.id, label: m.label }))}
          />
        </Field>
      ) : null}
    </SettingsCard>
  );
}

function TasksCard() {
  const t = useT();
  const { me } = useApp();
  const update = useMutation(api.accounts.profiles.updateAiPreferences);
  const catalog = useCatalog();
  const taskModels = me.aiSettings?.taskModels ?? {};
  const change = useCallback(
    (task: AiTask, value: { provider: string; model: string } | null) => {
      const next = { ...taskModels };
      if (value) next[task] = value;
      else delete next[task];
      void update({ taskModels: next })
        .then(() => toast.success(t("settings.ai.taskSaved", { task: TASKS[task].label })))
        .catch((e: unknown) => toast.error(errorMessage(e)));
    },
    [taskModels, update, t],
  );
  return (
    <SettingsCard title={t("settings.ai.tasks")} description={t("settings.ai.tasksBody")}>
      <div className="divide-y divide-line-subtle">
        {AI_TASKS.map((task) => (
          <TaskRow
            key={task}
            task={task}
            catalog={catalog}
            value={taskModels[task]}
            onChange={(v) => change(task, v)}
          />
        ))}
      </div>
    </SettingsCard>
  );
}

export function AiSettings() {
  const t = useT();
  const { me, billing } = useApp();
  if (!me.features["ai.agent"]) {
    return (
      <SettingsPage title={t("settings.ai.title")} description={t("settings.ai.subtitle")}>
        <Callout
          tone="accent"
          action={
            billing ? (
              <Button asChild variant="primary" size="sm">
                <Link href={`${routes.settings("billing")}?upgrade=1`}>{t("common.upgrade")}</Link>
              </Button>
            ) : undefined
          }
        >
          {t("settings.ai.locked")}
        </Callout>
      </SettingsPage>
    );
  }
  return (
    <SettingsPage title={t("settings.ai.title")} description={t("settings.ai.subtitle")}>
      {me.features["ai.byok"] ? (
        <>
          <KeyModeCard />
          <ProvidersCard />
        </>
      ) : null}
      {me.features["ai.local"] ? <OllamaCard /> : null}
      <TextProviderCard />
      <TasksCard />
      <p className="flex items-center gap-1.5 text-xs text-fg-muted">
        <ExternalLink className="size-3.5" />
        <a
          className="hover:text-fg"
          href={`${publicEnv.docsUrl}/ai/providers-and-byok`}
          target="_blank"
          rel="noreferrer"
        >
          {t("settings.ai.docs")}
        </a>
      </p>
    </SettingsPage>
  );
}

export type { ProviderId };
